// ================================================================
// 来源层：记值 + 解释（core/fieldValue.js）
//
// 职责：
//   1. `addSourceValue()`  —— 把一个"谁说的什么值"记进 `node.values[字段]`
//   2. `recordIncoming()`  —— 导入时批量记录（一个来源说了哪些字段）
//   3. `explainField()`    —— 给界面用：这个字段现在是谁给的、为什么、还有谁不服
//
// 依赖：core/trust.js（投影规则）。不碰 DOM、不读全局 state。
// 依据：三层与投影
//
// ⚠️ 分工（很重要，决定了"零行为变化"能不能成立）
// ----------------------------------------------------
//   * **来源层照记**：不管合并策略最后写没写这个值，都记下来
//     （"这个来源说过什么"是客观事实，不该被策略吃掉）。
//   * **缓存字段仍由合并策略写**：`node.name` 该是什么还是什么 —— 所以零行为变化。
//   * 投影（`projectField`）负责**解释**（面板与视图读值都走它）；**只有显式动作**
//     （设为首选 / 标不用 / 真删）才把投影结果**写回**缓存字段（`applyProjection`）。
//     ⚠️ **不做**全局开关 `trust.mode = 'projection'`（一次重算整棵树的缓存）：
//     视图不读缓存，那样的开关只会留下一条没人用的物化路径。
// ================================================================
import { projectField } from './trust.js';
import { importableElements, normalizeFieldValue, isEmptyFieldValue, fieldValueKey, shapeOf, formatFieldValue,
         pinValuesOf, isPinValue, ELEMENT_NAMES, natureOf, ELEMENT_NATURE,
         toCacheShape, isCanonicalTagList } from './model/elements.js';
// ⚠️ `isDraft` / `original`：写值前要读**原始**（未经代理）的那一份 —— 见下面 `baseValuesOf`。
//    这里**故意写相对路径**（不是裸名 `immer`）：本模块要能在**纯 Node 单测**里直接跑
//    （裸名只有浏览器 import map / smoke 的 loader 认识）。两边解析到的是**同一个文件**
//    （`src/vendor/immer.mjs`）⇒ 模块实例也是同一个，`isDraft/original` 认得出别的模块建的 draft。
import { isDraft, original } from '../vendor/immer.mjs';
// ★ 「哪四格是"比赛自己的属性、与账户无关"」的**唯一一份**名单（`stripNatureAccounts` 用它）
import { NATURE_FIELD_KEYS } from './natureFields.js';
// ★ `BACKFILL_SRC` 的定义搬到了零依赖的 `core/sourceLabel.js`（见下面那段的说明）。
//   ⚠️ **必须是 import + export**，不能只写 `export { X } from '...'`
//   —— 后者只**转发**、**不把名字引进本模块作用域**，而本文件自己要读它（`backfillNodeValues`）。
//   （2026-10-13 真踩：`export ... from` 让 `npm test` 里 3 个文件红 `BACKFILL_SRC is not defined`。）
import { BACKFILL_SRC } from './sourceLabel.js';

/** 来源层最多留几条值（防止每次抓取都堆一条同样的值） */
export const MAX_VALUES_PER_FIELD = 12;

/**
 * 取这个节点**当前基础版本**的 `values`（不经 Immer 代理）。
 *
 * ⚠️ **为什么必须这样读**（性能坑：直接读 `node.values[field]` 会踩）：
 *    `node` 是 Immer 的 **draft**，读它的数组属性会**为每个条目建一个子 draft**；
 *    这些子 draft 在本函数结束后成了"没 finalize 的残留"，Immer 提交事务时于是
 *    无法走"没有未完成 draft"的快路径，转而对**整棵树**做一次深度遍历 ——
 *    真包 27k 节点实测：改一个 `status1`（= `setDerivedOverride`）**420ms**，
 *    而只写一个新建数组只要 **29ms**。
 *    条目本来就是**数据**，读基础版本 + 浅拷一份即可，一行不多一行不少。
 */
function baseValuesOf(node) {
    const base = (node && isDraft(node)) ? original(node) : node;
    const v = base && base.values;
    return (v && typeof v === 'object') ? v : null;
}

/**
 * **本事务里已经写过的字段**：键 = 那个 `values` **draft 对象**（事务结束 draft 就没了，WeakMap 自动回收）。
 *
 * 为什么还要它：为了性能，`addSourceValue` 读的是**基础版本**（见 `baseValuesOf`）。
 * 但同一个事务里对**同一字段连写两次**时（例如"先记来源值、再记手改值"），
 * 第二次必须看得见第一次写进去的那条 —— 否则会把它悄悄丢掉。
 */
const pendingValues = new WeakMap();

/** 取"当前有效"的条目列表：本事务写过就用写的那份，否则读**基础版本**（不经代理 ⇒ 不建子 draft） */
function currentEntryList(node, map, field) {
    if (isDraft(node)) {
        const done = pendingValues.get(map);
        if (done && done.has(field)) return done.get(field);
        const base = baseValuesOf(node);
        return (base && Array.isArray(base[field])) ? base[field] : [];
    }
    return (map && Array.isArray(map[field])) ? map[field] : [];
}

/** 记下"本事务里这一格现在是什么"（只有 draft 才需要；普通对象本来就是当前值） */
function notePending(node, map, field, arr) {
    if (!isDraft(node)) return arr;
    let slot = pendingValues.get(map);
    if (!slot) { slot = new Map(); pendingValues.set(map, slot); }
    slot.set(field, arr);
    return arr;
}

/**
 * 可以进来源层的字段。
 *
 * ⚠️ **不手写**：它是 `core/model/elements.js` 属性表里
 * `importable: true` 的元素（两边各手抄一份清单的话，
 * "加字段时漏改一处"就会发生 —— 见 `identityKey`）。
 * `src/test/elements.test.js` 有一条断言钉住它等于属性表那份清单。
 */
export const WRITABLE_VALUE_FIELDS = Object.freeze(importableElements());

// ★ **定义搬到了 `core/sourceLabel.js`**（零依赖小模块：`trust.js` 的文件头声明"依赖：无"，
//   而本文件反过来 import 了 `./trust.js` ⇒ 定义放这里会让 `trust.js` 反向引用**成环**）。
//   这里**转出**，所以既有 `import { BACKFILL_SRC } from './fieldValue.js'` 的调用点一个字都不用改。
export { BACKFILL_SRC };

/** 手改的来源 id（它是**单数**的：同一个字段最多只留一条，见 addSourceValue） */
export const MANUAL_SRC = 'manual';

/**
 * 这条来源值属于哪个账户（缺省/空 = 客观那条）。
 *
 * 账户标签的归一化**只有这一处**（在 `addSourceValue` / `removeManualValue` /
 * `scopedDerived` 各写一遍的话，写法很快就不一致）。
 */
export const accountOfEntry = e => ((e && e.account !== undefined && e.account !== null)
    ? String(e.account) : '');

/**
 * 记一个来源值。
 *
 * 去重规则：
 *   - **同来源 + 同值**只留一条（更新时间取最新）；
 *   - 同来源不同值 → 两条都留（那是来源自己改了口，历史有用）；
 *   - ⚠️ **`manual` 例外：永远只留一条（替换）**。手改表达的是"我现在要什么"，
 *     不是"我历史上改过什么"；旧的手改值既没有保留价值，又很危险 ——
 *     `manual` 优先级最高，一条过时的手改值会一直压着所有来源。
 *     （实测：改几次就攒出几条 manual。）
 *
 * @param {Object} node - 节点（Immer draft 或普通对象）
 * @param {string} field - 字段名（内部名，如 'name' / 'ratio'）
 * @param {*} value - 值（空值直接忽略）
 * @param {string} src - 来源 id（如 'pta-icpc2026preliminary-2' / 'manual'）
 * @param {Object} [opts] - { at, account, clue }
 * @returns {boolean} 是否新增了一条（false = 合并/刷新了已有的一条）
 */
export function addSourceValue(node, field, value, src, opts = {}) {
    if (!node || !field || !src) return false;
    // 值的形状由属性表决定 —— 标量 trim 成字符串，列表规范成**字符串数组**
    // （标签列表的"内容"就是标签文字；tag 的 id/颜色是节点自己的展示信息）。
    const norm = normalizeFieldValue(field, value);
    if (isEmptyFieldValue(field, norm)) return false;   // 空值不记（否则全是噪声）
    const at = String(opts.at || '');
    // 账户层：`opts.account` = 这条值是**以谁的名义**记的。
    // 空/不传 = 与任何账户无关（客观）—— 这时**不写这个键**，老数据形状保持不变。
    const account = (opts.account === undefined || opts.account === null) ? '' : String(opts.account);
    // 把**线索**（源里"这条记录关于谁"）也记在值上。
    // 为什么必须留着它：没有线索就没法"补映射后重跑归认" —— 而那时重新导入
    // 又只会叠出第二条（同来源同值、账户不同）。存下来，重跑与增量导入都能认出
    // "这条值来自哪条记录"，从而**改账户**而不是加记录。
    const clue = normalizeClue(opts.clue);
    const entry = account ? { v: '', src, at, account } : { v: '', src, at };
    if (clue) entry.clue = clue;
    // 链接的**类别**（`board`/`problems`/`repo`/`unknown`）—— 与 `clue` 同一套路：
    // 它是这条值的**展示属性**（界面按类别分组显示链接），不是业务字段。
    // 空/不传 = 与链接分类无关（绝大多数字段），这时**不写这个键**，老数据形状不变。
    const linkKind = (opts.linkKind === undefined || opts.linkKind === null)
        ? '' : String(opts.linkKind);
    if (linkKind) entry.linkKind = linkKind;

    if (!node.values || typeof node.values !== 'object') node.values = {};
    // ⚠️ **只改这一个字段**，**别** `node.values = { ...node.values }` 整个换一个对象
    //    （性能坑）：整个换对象会把老的 `values` 变成一个**没 finalize 的残留 draft**，
    //    Immer 提交时于是要对**整棵树**做深度遍历 —— 真包 27k 节点 **≈ 460ms/次**；
    //    只写 `map[field]` 是 **30ms**（实测）。写时复制由 Immer 保证（写 draft 时它自己复制），
    //    `createNode` 那边也保证不共享默认值对象。
    const map = node.values;
    // ⚠️ **条目从"当前有效的那份"读**（见 `currentEntryList`：同一事务里写过就看写的那份，
    //    否则读基础版本）—— **别从 draft 数组读**：那会为每个条目建子 draft，
    //    这些残留 draft 会让 Immer 提交时对整棵树深度遍历（真包实测 394ms vs 24ms）。
    //    条目本来就是**数据**（`{v, src, at, account?, clue?, linkKind?}`），浅拷一份即可。
    const rawList = currentEntryList(node, map, field);
    const list = rawList.map((x) => ((x && typeof x === 'object') ? { ...x } : x));

    /** 写回这一格，并**记下"本事务里这格现在是什么"**（同一事务再写同一字段时要看得见） */
    const writeBack = (arr) => {
        map[field] = arr;
        return notePending(node, map, field, arr);
    };

    const v = norm;
    const vKey = fieldValueKey(field, v);

    // ---- 手改：**同一账户**只保留一条（替换掉该账户旧的手改值）----
    //
    // ⚠️ 按 `account` 配对，**不能**无条件 `list.filter(x => x.src !== MANUAL_SRC)` ——
    //    那样会把**所有账户**的手改值一并抹掉，
    //    于是"我改一下、队友改一下"，最后只剩一个人手改的那条（谁后改谁留下）。
    //    那与"各账户的手改互不干扰、各自增删改"的意图直接冲突：
    //      · 同一账户的旧手改值 → 被这次替换（这才是"手改只留一条"的本意）；
    //      · 别的账户的手改值 → **一个都不动**。
    if (src === MANUAL_SRC) {
        const prevManual = list.find(x => x && x.src === MANUAL_SRC && accountOfEntry(x) === account);
        if (prevManual && fieldValueKey(field, prevManual.v) === vKey) {
            prevManual.at = at || prevManual.at;        // 同值只刷新时间
            writeBack(list);
            return false;
        }
        const kept = list.filter(x => !(x && x.src === MANUAL_SRC && accountOfEntry(x) === account));
        kept.push({ ...entry, v: cloneValue(v) });
        writeBack(kept);
        return true;
    }

    // ---- ★ 同一条记录（同来源 + **同线索**）只留一条：**值变了就整组替换** ----
    //
    // 用户 2026-10-15（看着值级面板 "2 个来源、新值标着未采用"）："导入更新的逻辑应该是
    // **每组替换而非合并**" + "**每组还要按账户分组**"。这里就是那条规矩的落点：
    //   · **组** = 同来源 + 同线索 + **同账户**（一条记录说的一格，属于某一个账户）；
    //   · 组内**后来的值直接替换**前一个（不叠第二条）；
    //   · 账户不同 ⇒ **不同组**（各留各的，谁也不顶掉谁）。
    //
    // 为什么必须有：同一条记录**后来改了口**（QOJ 相对时间 `00:31:01` → 绝对时刻、
    // PD → AC…）时，老实现按"来源 + **值** + 线索"找同一条 ⇒ 找不到 ⇒ **叠出第二条**；
    // 而投影在"来源类别 / rank / 优先表"全相同时只能比 `at`，再平手就是**先到者胜**
    // （`core/trust.js:isBetter` 刻意稳定）⇒ 旧值永远留着。
    // 实测（QOJ 1873 那 12 条）：值其实**早就进了列表**，树上一路显示的还是旧的相对时间，
    // 而且重导会报"跳过"（新值已在列表里 ⇒ 没有字段要写）—— 三个症状同一个病根。
    //
    // ⚠️ **只在有线索时**整组替换：线索为空时"这两条是不是同一条记录"无从判断
    //    （老数据 / 源里没给线索），那种情况维持原样（键含值 ⇒ 可以并存）。
    // ⚠️ 线索**不同**的照旧各留各的（一次榜单里两个队报同一个值 —— `P3` 那条测试钉着它）。
    const clueKey = clueKeyOf(clue);
    if (clueKey) {
        // **一组** = 同来源 + 同线索 + 同账户；组内**只留一条**：
        //   · 值变了 ⇒ 就地换掉（整组替换）；
        //   · 组里已经有这个值 ⇒ 刷新时间；
        //   · 组里**多余的**那些（老实现叠出来的"第二条"）⇒ 一并收掉 —— 不收的话，
        //     已经卡住的那些行**重导也治不回来**（投影依旧按"先到者胜"显示旧的）。
        const inGroup = (x) => x && x.src === src && clueKeyOf(x.clue) === clueKey
            && accountOfEntry(x) === account;
        const group = list.filter(inGroup);
        if (group.length) {
            const keep = group.find(x => fieldValueKey(field, x.v) === vKey) || group[0];
            if (fieldValueKey(field, keep.v) !== vKey) keep.v = cloneValue(v);
            if (at) keep.at = at;
            if (linkKind) keep.linkKind = linkKind;
            writeBack(list.filter(x => x === keep || !inGroup(x)));
            return false;      // 刷新 / 整组替换都**不算"新增一条"**（返回值只回答"多没多一条"）
        }
    }

    // ---- 同值合并 ----
    // 键 = 来源 + 值 + **线索**。
    //   同来源可能给不同账户报同一个值（一次榜单含多队），所以不能只按"来源+值"合并；
    //   而**同一个线索**（= 同一条记录）无论归到谁名下，都只该有一条 ——
    //   这正是"补映射后重新导入/重跑归认"要的语义：**改账户，不叠条**。
    //   ⚠️ 带线索的那些情形已经在上面两段处理掉了；走到这里的只剩"没有线索"的。
    const same = list.find(x => x && x.src === src
        && fieldValueKey(field, x.v) === vKey
        && clueKeyOf(x.clue) === clueKey);
    if (same) {
        if (at && at !== same.at) same.at = at;          // 同值刷新时间即可
        // 线索相同 → 归认结果以**这一次**为准（这就是"重跑归认"的地基）
        if (account !== accountOfEntry(same)) {
            if (account) same.account = account;
            else delete same.account;
        }
        writeBack(list);
        return false;
    }

    // ---- 线索**后来才有**的那条：并进旧条目，别再叠一条 ----
    // 场景（实测踩到）：同一个来源、同一个值，**上一次抓的时候源里没有线索**
    // （`nk`/`hdu` 声明 handle 之前抓的那批）⇒ 那条值记成"客观"；
    // 这一次源里带上线索了 ⇒ 按上面的键（来源+值+线索）找不到旧的 ⇒ 会**叠出第二条**
    // （界面上同一格两条一模一样的值，一条"客观"、一条带账户）。
    // 它们其实是**同一份事实**（同一个节点、同一个来源、同一个值），只是后一次信息更全
    // ⇒ 就地升级那一条（补上线索/账户），旧的"客观"那条随之消失。
    // ⚠️ 只在"一边有线索、另一边没有"时合并：
    //    · 两条都**有**线索但不同 ⇒ 真的是两件事（一次榜单含多队）⇒ 各留各的（上面的键已保证）；
    //    · 新来的**没有**线索而旧的**有** ⇒ 不降级（保留信息更全的那条，也不叠）。
    if (clueKey) {
        const bare = list.find(x => x && x.src === src
            && fieldValueKey(field, x.v) === vKey && !clueKeyOf(x.clue));
        if (bare) {
            if (at) bare.at = at;
            bare.clue = clue;
            if (account) bare.account = account;
            else delete bare.account;
            if (linkKind) bare.linkKind = linkKind;
            writeBack(list);
            return false;
        }
    } else if (list.some(x => x && x.src === src
        && fieldValueKey(field, x.v) === vKey && clueKeyOf(x.clue))) {
        // 新来的这条没线索、而同一格已经有"带线索的同来源同值" ⇒ **什么都不做**
        // （别把带账户的那条挤掉、也别叠一条客观的）
        return false;
    }

    list.push({ ...entry, v: cloneValue(v) });
    // 超限时丢**最旧的**（按 at 升序；无时间的排最前，优先被丢）
    if (list.length > MAX_VALUES_PER_FIELD) {
        list.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
        list.splice(0, list.length - MAX_VALUES_PER_FIELD);
    }
    writeBack(list);
    return true;
}

/** 列表值要拷贝一份（否则两个节点/两条值会共享同一个数组 —— 又是"串味"那类坑） */
function cloneValue(v) {
    return Array.isArray(v) ? v.slice() : v;
}

/**
 * 规范化一条线索（只留 `{source, field, value}` 三个非空字段）。
 * @returns {{source:string, field:string, value:string}|null}
 */export function normalizeClue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const source = String(raw.source || '').trim();
    const field = String(raw.field || '').trim();
    const value = String(raw.value === undefined || raw.value === null ? '' : raw.value).trim();
    if (!value) return null;                       // 没值 = 没线索（区别于"有值但匹配不上"）
    return { source, field, value };
}

/** 线索的比较键（没有线索 → 空串） */
export function clueKeyOf(clue) {
    const c = normalizeClue(clue);
    return c ? `${c.source}\u0000${c.field}\u0000${c.value}` : '';
}

/**
 * 删掉一条"手动覆盖"（`src === 'manual'` 且账户相同的那条）。
 *
 * 用途：派生字段上的"**恢复自动计算**"（用户把"忽略"撤销掉）。
 * 只动 manual 那条，别的来源照旧。
 *
 * @param {Object} node
 * @param {string} field
 * @param {string} [account] - 缺省/空 = 客观那条
 * @returns {boolean} 有没有真的删掉
 */
export function removeManualValue(node, field, account = '') {
    if (!node || !node.values || typeof node.values !== 'object') return false;
    const map = node.values;
    // ⚠️ 与 `addSourceValue` **同一套读法**：读"当前有效的那份"（不带出子 draft），
    //    写回**只改这一格** —— 不 `{ ...node.values }` 整个换对象（真包实测 413ms/次）。
    const raw = currentEntryList(node, map, field);
    if (!raw.length) return false;
    const list = raw.map((e) => ((e && typeof e === 'object') ? { ...e } : e));
    const acc = (account === undefined || account === null) ? '' : String(account);
    const kept = list.filter(e => !(e && e.src === MANUAL_SRC && accountOfEntry(e) === acc));
    if (kept.length === list.length) return false;
    if (kept.length) map[field] = kept;
    else delete map[field];
    notePending(node, map, field, kept);
    return true;
}

/**
 * ★ **nature 四格的手填值不带账户** —— 把老数据里那种带着账户的那条**就地抹掉账户**
 * （值一个字不动，只去掉"哪个账户填的"这条记账）。
 *
 * 为什么（用户 2026-10-08："年份,赛季这种信息不用分帐户（应该本就没分?）"）：
 * 分类 / 年份 / 赛季 / 地区是**比赛自己的属性**，跟"哪个 OJ 账户"没关系。带账户会出两种别扭：
 *   · **投影按账户筛** ⇒ "在账户 A 下填的年份"切到"本机"就**看不见**（可它还在数据里）；
 *   · 而**导出不看账户** ⇒ 它照样被当成"人的结论"随 baseline 走 ⇒ 用户"清了几回还在"。
 * 以后新填的就不带账户了（见 `core/ops/node.js` 的 `recordManualValue`）。
 *
 * 幂等：没账户的那条一字不碰。@returns 抹了几条
 */
export function stripNatureAccounts(node) {
    if (!node || !node.values || typeof node.values !== 'object') return 0;
    const bag = node.values;
    let n = 0;
    for (const field of NATURE_FIELD_KEYS) {
        const list = bag[field];
        if (!Array.isArray(list) || !list.length) continue;
        let hit = 0;
        const next = list.map((one) => {
            if (!one || typeof one !== 'object') return one;
            if (one.src !== MANUAL_SRC || one.account === undefined) return one;
            hit++;
            const copy = { ...one };
            delete copy.account;
            return copy;
        });
        if (hit) { bag[field] = next; n += hit; }
    }
    return n;
}

/**
 * 撤掉**这一格的手填值**（不看账户）。
 *
 * 为什么不分账户（用户 2026-10-08）：分类 / 年份 / 赛季 / 地区是**比赛自己的属性**，
 * 一格里就**一条**手填值 —— "哪个账户填的"没有意义（账户维度是给提交记录那类字段用的，
 * 那种字段各账户各一条，所以 `removeManualValue(node, field, account)` 是按账户精确撤的）。
 *
 * ⚠️ 拿"按账户"的那条来清这几格会**清不掉**（实测：用户"这个重复怎么不停出现，我修了 3 回了"）：
 *    那条手填值是在**另一个账户**名下填的 ⇒ 在"本机"下清空动不到它，可**导出侧**
 *    （`core/natureAssignments.manualEntryOf`，它不看账户）照样把它当"人的结论"
 *    写进 baseline、回代进包 ⇒ 每轮又回来。
 */
export function removeManualFieldValue(node, field) {
    if (!node || !node.values || typeof node.values !== 'object') return false;
    const map = node.values;
    const raw = currentEntryList(node, map, field);
    if (!raw.length) return false;
    const list = raw.map((e) => ((e && typeof e === 'object') ? { ...e } : e));
    const kept = list.filter(e => !(e && e.src === MANUAL_SRC));
    if (kept.length === list.length) return false;
    if (kept.length) map[field] = kept;
    else delete map[field];
    notePending(node, map, field, kept);
    return true;
}

/**
 * 设置/清除派生字段上的**用户覆盖**（"忽略这题" / "赛时通过" / "待写"）。
 *
 * **哪些值算覆盖由属性表说了算**（`elements.js` 的 `pinValues`）—— 调用方只管把
 * 用户选的值原样传进来：是覆盖值就记进来源层（带账户、按范围生效），不是就把旧覆盖清掉。
 * 于是"编辑弹窗 / 批量改状态 / 粘表格 / 迁移老数据 / 按范围重算"全都走这一条，
 * **没有任何一处需要知道 `[1,4,5]`**。
 *
 * @param {Object} node
 * @param {string} field
 * @param {*} value - 用户选的值（`null`/`undefined`/`''` = 清除覆盖）
 * @param {Object} [opts] - `{ at, account }`
 * @returns {boolean} 有没有变化
 */
export function setDerivedOverride(node, field, value, opts = {}) {
    if (!pinValuesOf(field).length) return false;              // 该元素不可覆盖
    if (!isPinValue(field, value)) {
        return removeManualValue(node, field, opts.account);    // 不是覆盖值 → 撤掉旧覆盖
    }
    return addSourceValue(node, field, String(value).trim(), MANUAL_SRC, opts);
}

/**
 * 批量记录"这个来源说了哪些字段"（导入时用）。
 *
 * @param {Object} node
 * @param {Object} fields - `{ 字段: 值 }`（**这一条记录里出现的**字段）
 * @param {string} src
 * @param {Object} [opts] - { at, only, srcByField, account, accountByField, clue }
 * @returns {number} 记了几条
 */
export function recordIncoming(node, fields, src, opts = {}) {
    if (!node || !fields || typeof fields !== 'object' || !src) return 0;
    const only = Array.isArray(opts.only) ? new Set(opts.only) : null;
    // 逐字段来源（合成包会带 `字段来源`）——有就用它，没有就整个来源一个 id
    const byField = (opts.srcByField && typeof opts.srcByField === 'object') ? opts.srcByField : null;
    // 账户归属（`opts.account` 一个来源一个；`opts.accountByField` 逐字段覆盖）
    const accByField = (opts.accountByField && typeof opts.accountByField === 'object')
        ? opts.accountByField : null;
    // 链接类别（`opts.linkKindByField` 逐字段）—— C 的 `link` 是从
    // `链接分类` **派生**出来的，它的类别不像落选值那样每条自带。
    // 不在这里传下去的话，选中值在来源层里就没有 `linkKind`，
    // 界面按类别分组时它反而成了"没类别"的那个。
    const kindByField = (opts.linkKindByField && typeof opts.linkKindByField === 'object')
        ? opts.linkKindByField : null;
    let n = 0;
    for (const key of Object.keys(fields)) {
        if (only && !only.has(key)) continue;
        const fieldSrc = (byField && byField[key]) ? byField[key] : src;
        const account = (accByField && accByField[key] !== undefined)
            ? accByField[key] : opts.account;
        const linkKind = (kindByField && kindByField[key] !== undefined)
            ? kindByField[key] : opts.linkKind;
        if (addSourceValue(node, key, fields[key], fieldSrc, { ...opts, account, linkKind })) n++;
    }
    return n;
}

/**
 * 回填一个节点的来源层：**用现值造一条来源值**。
 *
 * 为什么需要：老节点只有值、没有出处，而 `applyPlans` 对 skip 的记录直接跳过 ——
 * 所以"重新导一遍"补不出老节点的来源。回填是唯一能让存量数据也有出处的办法。
 *
 * 来源怎么定：
 *   - 节点有 `importSource`（记过"是谁导进来的"）→ 就用它；
 *   - 否则 → `local:v7`。
 *
 * 幂等：字段已经有来源值就**跳过**（不会把回填值越堆越多）。
 *
 * @param {Object} node
 * @param {string[]} [fields] 要回填的字段（默认用 WRITABLE_VALUE_FIELDS）
 * @returns {number} 回填了几个字段
 */
export function backfillNodeValues(node, fields) {
    if (!node || typeof node !== 'object') return 0;
    const list = Array.isArray(fields) && fields.length ? fields : WRITABLE_VALUE_FIELDS;
    const src = node.importSource || BACKFILL_SRC;
    const at = node.lastModified || node.createdAt || '';
    let n = 0;

    for (const field of list) {
        const existing = node.values && Array.isArray(node.values[field]) ? node.values[field] : null;
        if (existing && existing.length) continue;      // 已经有出处 → 不动
        const value = node[field];
        // 列表字段（`tags`）也照原样交给 `addSourceValue` ——
        // 形状由属性表 `shape:'list'` 规范化成字符串数组（不能 `join` 成一个字符串，
        // 那会让"两份标签列表是不是同一份"永远比不出来）。
        if (isEmptyFieldValue(field, value)) {
            continue;                                    // 空值不值得记
        }
        if (addSourceValue(node, field, value, src, { at })) {
            n++;
        }
    }
    return n;
}

/**
 * 修**缓存字段的形状**（幂等；目前只有标签列表需要）。
 *
 * 背景：`node.tags` 的规范形状是 `[{id,text,color}]`，而来源层是字符串数组。
 * 若有一条路径（crate 导入）把字符串数组直接写进缓存 → 标签管理器空白行、
 * 删除/上移报"标签不存在"。写入侧靠 `toCacheShape` 堵住，
 * 这里负责**把已经坏掉的数据修回来** —— 老存档、已经导过的包都靠它。
 *
 * 只动"确实不是规范形状"的字段：规范的一字不碰（所以重复加载不产生差异）。
 *
 * @returns {number} 修了几个字段
 */
export function repairNodeCacheShapes(node) {
    if (!node || typeof node !== 'object') return 0;
    let n = 0;
    for (const field of ELEMENT_NAMES) {
        if (natureOf(field) !== ELEMENT_NATURE.TAG_LIST) continue;
        const value = node[field];
        if (value === undefined) continue;
        if (isCanonicalTagList(value)) continue;
        const fixed = toCacheShape(field, value);
        if (JSON.stringify(fixed) !== JSON.stringify(value)) {
            node[field] = fixed;
            n++;
        }
    }
    return n;
}

/**
 * 回填整棵树（加载时调用一次；幂等，重复调用不产生新值）。
 *
 * 顺带把回填用到的来源登记进 `state.sources`，否则界面上会显示不出"这是谁给的"。
 *
 * @param {Object} state
 * @param {string[]} [fields]
 * @returns {{ nodes:number, fields:number }}
 */
export function backfillStateValues(state, fields) {
    const out = { nodes: 0, fields: 0 };
    if (!state || !state.nodes) return out;
    if (!state.sources || typeof state.sources !== 'object') state.sources = {};
    // 投影要用同一套范围参数（与 `core/ops/trust.reprojectField` 一致）
    const opts = { viewingAccount: state.viewingAccountId, accounts: state.accounts, settings: state.settings };
    let healed = 0;
    for (const id of Object.keys(state.nodes)) {
        const node = state.nodes[id];
        if (!node) continue;
        repairNodeCacheShapes(node);
        // ★ nature 四格的手填值**不该带账户**（老数据里那几条就地抹平；值一个字不动）
        stripNatureAccounts(node);
        const n = backfillNodeValues(node, fields);
        if (n > 0) {
            out.nodes++;
            out.fields += n;
            const src = node.importSource || BACKFILL_SRC;
            if (!state.sources[src]) {
                state.sources[src] = src === BACKFILL_SRC
                    ? { kind: 'manual', rank: 90, note: '迁移带入（不知道原始出处）' }
                    : { kind: 'script', rank: 20, note: '回填：导入时记录的来源' };
            }
        }
        // ★ **缓存空了、来源层却有可用值** ⇒ 按投影补回来（**只补空、绝不覆盖有值的**）。
        //   为什么要这一趟：缓存与投影可能被写岔（实测 2026-10-08）：把手改值清空时，
        //   `removeManualValue` 撤掉了那条源值，但缓存那格**没人重投影** ⇒ 缓存留在空，
        //   而读法是两套：**③ 性质待补**读缓存（说"缺"）、字段表/编辑框/导入读投影（有值）
        //   ⇒ 同一格两个答案；而且**重新导入治不好**（那条记录被"指纹没变 ⇒ 跳过"挡掉）。
        //   `core/ops/trust.settleFieldAfterRemoval` 已经堵住了源头（清空时当场重投影）；
        //   这一趟负责把**以前就写岔的**存量修回来 —— 加载时跑一次，幂等。
        for (const field of (Array.isArray(fields) && fields.length ? fields : WRITABLE_VALUE_FIELDS)) {
            if (!isEmptyFieldValue(field, node[field])) continue;      // 缓存有值 ⇒ 一字不碰
            const list = node.values && node.values[field];
            if (!Array.isArray(list) || !list.some(x => x && !x.invalid)) continue;
            if (applyProjection(node, field, state.trust, opts).changed) healed++;
        }
    }
    if (healed) out.fields += healed;
    return out;
}

/**
 * **状态进入应用时的统一归一化**：补齐来源层所需的顶层字段 + 回填来源层。
 *
 * 为什么要有这个函数：状态有**多条进入路径**，每一条都用手写字段清单构造 state
 * （`persistence/loadData`、`shell/executor.importState`、`H1_jsonIO.buildExportData`），
 * 于是"新加的顶层字段"很容易在某一条路上漏掉 —— 比如从**文件**导入的数据不走
 * `loadData`，来源层就永远不补，界面上老节点全是"来源：未记录"。
 *
 * 规矩：**任何"整个 state 被换掉"的路径，都必须调它**（它在最后一步，幂等）。
 *
 * @param {Object} state
 * @param {string[]} [fields] 回填哪些字段（默认 WRITABLE_VALUE_FIELDS）
 * @returns {{ nodes:number, fields:number }}
 */
export function normalizeStateValues(state, fields) {
    if (!state || typeof state !== 'object') return { nodes: 0, fields: 0 };
    if (!state.sources || typeof state.sources !== 'object') state.sources = {};
    if (!state.sources.manual) {
        state.sources.manual = { kind: 'manual', rank: 100, note: '你自己改的' };
    }
    if (!state.trust || typeof state.trust !== 'object') {
        state.trust = {
            categoryRank: ['manual', 'board', 'script', 'derived'],
            sources: {}, fieldPrefer: {}, groupPrefer: {}
        };
    }
    // 投影查的是 `trust.sources`；把注册表里已知的来源同步过去（尤其是 manual，
    // 它必须被识别成 manual，否则"手改永远优先"在投影里会失效）
    if (!state.trust.sources || typeof state.trust.sources !== 'object') state.trust.sources = {};
    for (const srcId of Object.keys(state.sources)) {
        const info = state.sources[srcId] || {};
        if (!state.trust.sources[srcId]) {
            state.trust.sources[srcId] = { kind: info.kind || 'script', rank: info.rank || 0 };
        }
    }

    // ---- 账户维度：注册表与两个指针必须有有效值（老存档没有这些键）----
    if (!state.accounts || typeof state.accounts !== 'object') state.accounts = {};
    if (!state.accounts.local) {
        state.accounts.local = { id: 'local', name: '本机', nature: '默认',
                                 children: [], isLocal: true, mappings: [] };
    }
    // `active` 键**缺省即活跃**（老数据不打标记就是活跃，`local` 更是永远活跃），
    // 所以这里**不写**这个键 —— 不给用户数据添没有信息量的字段。
    const usableAccount = (id) => {
        const acc = id ? state.accounts[id] : null;
        if (!acc) return false;
        return id === 'local' || acc.active !== false;
    };
    // 指针只能指向**存在且活跃**的账户：停用过/删过的账户会让"谁在改数据"悬空
    if (!usableAccount(state.currentAccountId)) {
        state.currentAccountId = 'local';
    }
    if (!usableAccount(state.viewingAccountId)) {
        state.viewingAccountId = state.currentAccountId;   // 默认跟随登录账户
    }
    // ---- 清掉老载荷里可能残留的 `mappingElementValue`（「映射元素值」）----
    // 它不是节点的当前字段，也**从来没被填过**，所以这里没有"搬运值"这回事，
    // 只是把老载荷里可能残留的键**删掉** —— 留着就会变成一份谁也不读的僵尸数据。
    if (state.nodes && typeof state.nodes === 'object') {
        for (const nid in state.nodes) {
            const n = state.nodes[nid];
            if (n && typeof n === 'object' && 'mappingElementValue' in n) {
                delete n.mappingElementValue;
            }
        }
    }

    const r = backfillStateValues(state, fields);
    if (r.fields > 0) {
        // 只在真补了东西时出声：这是"界面为什么突然有来源了"的答案，
        // 也是模块缓存的判据（没这行 = 浏览器跑的这段代码是旧的）。
        console.log(`来源层回填：${r.nodes} 个节点 / ${r.fields} 个字段`
            + `（来源表 ${Object.keys(state.sources).length} 项）`);
    }
    return r;
}

/**
 * 解释一个字段：当前值、来源、理由、以及全部候选值。
 *
 * 给界面用：`name ⓘ2` → 点开就是这个函数的返回值。
 *
 * 没有来源值 = **没有出处**：这里**不**把"缓存里有值、来源层没有"当成遗留数据
 * 显示出来（**没有老数据**：读路径不留回退兜底）。
 *
 * @param {Object} node
 * @param {string} field
 * @param {Object} [trust]
 * @returns {{ value:string, src:string, reason:string, count:number, all:Array,
 *             stored:Array, invalidCount:number, hiddenInactive:number }}
 */
export function explainField(node, field, trust, opts = {}) {
    const values = (node && node.values && node.values[field]) || [];
    // 账户维度由调用方给（面板传 AppState 的账户表与"在查看"）
    // ⚠️ 这里必须把**范围参数原样透传**：漏了 `scopeAccounts` 的话，
    //    `explainField` / `readFieldInfo` 的过滤会静默失效。
    const projOpts = {
        viewingAccount: opts.viewingAccount,
        scopeAccounts: opts.scopeAccounts,
        accounts: opts.accounts
    };
    let projected = projectField(field, values, trust, projOpts);

    // 这个字段**存过来源值**吗？（与"投影结果为空"是两件事）
    const rawList = (node && node.values && Array.isArray(node.values[field]))
        ? node.values[field] : [];

    // ⚠️ **没有老数据**（读路径不留回退兜底）：**不**做"缓存里有值、来源层没有
    //    → 当成遗留数据显示出来"的兜底。"没有来源值"就是**没有出处**，
    //    面板如实说，不替它编一个。

    // ---- 投影为空、但这个字段**存过来源值** → 把理由说准 ----
    // `projectField` 此时只会说"没有来源值"，而真实原因往往是
    // "这些值都不属于当前在看的账户"或"都被标了不用" —— 面板直接显示那句话，
    // 用户会以为出处丢了（而树上那个字段其实有值，只是借来的）。
    if (projected.empty && values.length > 0) {
        const anyUsable = values.some(x => x && !x.invalid && !isEmptyFieldValue(field, x.v));
        projected = {
            ...projected,
            reason: anyUsable
                ? '这些值都不属于当前「在查看」的账户（或账户已停用）'
                : '这些值都被标了「不用」（可在来源面板恢复）'
        };
    }

    // ---- 把**全部存下来的值**也交出去（含已失效的）----
    // 为什么必须有：投影故意忽略 invalid 的值（那是对的），但如果界面也只看到"可用的"，
    // 那么点了「不用」之后那个值就从列表里消失 → 用户既看不到自己干了什么，
    // 也没法点回来（两个来源点掉一个，面板就会退回"单来源"且按钮消失）。
    // 所以：`all` 保持"可用值"（投影口径不变），另给一份 `stored`（全量，带 invalid 标记）。
    // 非活跃账户的值**不显示**。
    // 注意与"投影忽略"是两件事：这里是**列表里也不列**，从"可查"变成"看不见"。
    const accounts = (opts && opts.accounts && typeof opts.accounts === 'object') ? opts.accounts : null;
    const keepInactive = (account) => {
        if (!accounts || !account) return true;
        const acc = accounts[account];
        return !!acc && acc.active !== false;      // 停用 / 悬空 id → 不显示
    };
    const visible = accounts ? rawList.filter(x => keepInactive(String((x && x.account) || ''))) : rawList;
    const hiddenInactive = rawList.length - visible.length;

    const stored = visible.length
        ? visible.map(x => ({
            // 值的形状按属性表规范化（列表 → 字符串数组）
            v: normalizeFieldValue(field, x.v),
            src: String((x && x.src) || ''),
            at: String((x && x.at) || ''),
            // 这个值是**谁的**（空 = 客观）。界面靠它显示"账户"标签。
            account: String((x && x.account) || ''),
            clue: (x && x.clue) || null,
            // 链接的类别（`board`/`problems`/`repo`/`unknown`）—— 与 `clue` 一样
            // 是这条值的**展示属性**，读取时必须一起带出来，否则界面按类别分组就没依据
            // （不加这三行，`view/linkChips.js` 拿到的 `stored` 里没有 linkKind，
            //  于是标签永远退回旧文案、仓库/其它那些链接一个都不显示）。
            linkKind: (x && x.linkKind) || null,
            invalid: !!(x && x.invalid),
            // 是否"当前选中的那个"：按形状比较（数组要深比，不能用 ===）
            selected: !(x && x.invalid)
                && fieldValueKey(field, x.v) === fieldValueKey(field, projected.value)
                && String((x && x.src) || '') === projected.src
        }))
        : projected.all.map(x => ({
            ...x,
            v: normalizeFieldValue(field, x.v),
            account: accountOfEntry(x),
            invalid: false
        }));

    return {
        value: projected.value,
        src: projected.src,
        reason: projected.reason,
        count: projected.all.length,
        all: projected.all,
        stored,
        invalidCount: stored.filter(s => s.invalid).length,
        // 因为账户停用（或账户已删）而被隐藏的条数 —— 面板可以说明一句
        hiddenInactive
    };
}

/**
 * **视图层读取器**
 *
 * 界面**不直接读缓存字段**（`node.ratio`），而是走这里：
 *   - 有来源值 → 按**本次查看范围**投影出来的那个值；
 *   - 没有任何来源值（老数据还没回填）→ 退回缓存字段（保证老数据照样显示）。
 *
 * 为什么必须这样：
 *   缓存字段是**一份**物化结果，只能表达"一个范围"。而我们要在同一屏上同时看多个账户
 *   （例：一队 3 人各自的补题情况）—— 那需要按范围各算一份，缓存表达不了。
 *
 * ⚠️ 与 `applyProjection` 的区别：那个会**写回**缓存（用于显式动作）；
 *    这个只读，绝不改数据。视图可以随便换 scope，数据不动。
 *
 * @param {Object} node
 * @param {string} field
 * @param {Object} [opts] - `{ trust, viewingAccount | scopeAccounts, accounts }`
 * @returns {string|string[]} 该范围内的值（空 → `''` / `[]`）
 */
export function readField(node, field, opts = {}) {
    if (!node) return emptyOfShape(field);
    const values = (node.values && node.values[field]) || [];
    const r = projectField(field, values, opts.trust, opts);
    if (!r.empty) return r.value;
    // 有没有"来源值"？注意区分两件事：
    //   - **一条来源值都没有** → 老数据还没回填 → 退回缓存字段（老数据照样显示）；
    //   - **有来源值，但都不在本次范围内** → 范围内确实没有这个值 → 返回空，
    //     **不能**退回缓存 —— 缓存里可能是别人的值，那就把"只看我的"变成了空话。
    const hasAny = Array.isArray(values) && values.some(x => x && !isEmptyFieldValue(field, x.v));
    if (hasAny) return emptyOfShape(field);
    const raw = node[field];
    return raw === undefined || raw === null ? emptyOfShape(field) : raw;
}

/** 该形状的"空"（标量 `''` / 列表 `[]`） */
function emptyOfShape(field) {
    return shapeOf(field) === 'list' ? [] : '';
}

/**
 * 视图层读取 + 解释（要显示"为什么是这个值"时用）。
 *
 * @returns {{ value:string|string[], src:string, reason:string, empty:boolean,
 *             fromCache:boolean, outOfScope:boolean, cacheValue:*, all:Array, stored:Array }}
 *   - `fromCache`  = 值是退回缓存拿到的（老数据，一条来源值都没有）
 *   - `outOfScope` = 有来源值、但**都不在本次范围里**（显示层可以据此提示"这是别人的值"）
 */
export function readFieldInfo(node, field, opts = {}) {
    const values = (node && node.values && node.values[field]) || [];
    const hasAny = Array.isArray(values) && values.some(x => x && !isEmptyFieldValue(field, x.v));
    const cacheValue = node ? node[field] : undefined;
    const info = explainField(node, field, opts.trust, opts);

    // ① 范围内有值 → 正常投影结果
    if (info.count > 0) {
        return {
            value: info.value, src: info.src, reason: info.reason,
            empty: false, fromCache: false, outOfScope: false,
            cacheValue, all: info.all, stored: info.stored
        };
    }
    // ② 有来源值但都不在范围内 → 严格为空；把缓存值一起交出去，供显示层决定怎么标
    if (hasAny) {
        return {
            value: emptyOfShape(field), src: '', reason: info.reason || '这个值不属于当前查看的账户',
            empty: true, fromCache: false, outOfScope: true,
            cacheValue, all: [], stored: info.stored || []
        };
    }
    // ③ 一条来源值都没有 → 老数据，退回缓存
    const raw = cacheValue;
    const empty = raw === undefined || raw === null || isEmptyFieldValue(field, raw);
    return {
        value: empty ? emptyOfShape(field) : raw,
        src: info.src || '', reason: info.reason,
        empty, fromCache: !empty, outOfScope: false,
        cacheValue, all: [], stored: info.stored || []
    };
}

/**
 * 按投影结果更新缓存字段（**默认不调用**，只有值级 UI 的显式动作才用）
 *
 * ⚠️ 它的定位是"把某个范围的结果物化下来"（例如导出、或给还没迁移的旧代码看）：
 * 视图**不依赖**缓存，视图读值请用 `readField`。
 *
 * @param {{viewingAccount?: string, scopeAccounts?: string[]}} [opts]
 * @returns {{ changed:boolean, value:string, reason:string }}
 */
export function applyProjection(node, field, trust, opts = {}) {
    const r = projectField(field, (node && node.values && node.values[field]) || [], trust, opts);
    if (r.empty) return { changed: false, value: node ? node[field] : '', reason: r.reason };
    // **列表型字段暂时不写回缓存**。
    // 原因：值的形状是"标签文字数组"，而缓存 `node.tags` 是 `{id,text,color}` 对象数组
    // （tag 以后会变成节点，那时这个字段的值会改成引用那些节点 —— 一次单独的迁移）。
    // 现在硬写会把 `node.tags` 写成字符串数组，把界面和标签管理一起搞坏。
    // `tags` 也还没有值级界面（P 弹窗字段里没有它），所以这条分支实际走不到；
    // 写在这里是为了"将来有人给它加了界面"时不会静默写坏数据。
    if (shapeOf(field) === 'list') {
        return { changed: false, value: node ? node[field] : '', reason: r.reason, skipped: 'list-shape' };
    }
    const before = node[field];
    if (String(before === undefined || before === null ? '' : before) !== r.value) {
        node[field] = r.value;
        return { changed: true, value: r.value, reason: r.reason };
    }
    return { changed: false, value: r.value, reason: r.reason };
}
