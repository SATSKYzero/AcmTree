// ================================================================
// 视图范围（view/scope.js）
//
// **渲染时全走投影**（方案 B）。界面不直接读缓存字段
// （`node.ratio`），而是走这里 —— 按"本次查看范围"现算，**数据一个字节都不动**。
//
// 为什么必须这样（理由是决定性的）：
//   缓存字段是**一份**物化结果，只能表达"一个范围"。而我们要在同一屏上同时看
//   多个账户（例：一队 3 人各自的补题情况）—— 那需要按范围各算一份。
//
// 范围（`scopeAccounts`）是**集合**：单账户 = 一个元素的集合，一队 3 人 = 三个元素。
//
// 显示策略（与"严格口径"分开，这是刻意的）
// ----------------------------------------
//   - **聚合/统计/筛选**用 `core/fieldValue.js` 的 `readField`（严格）：
//     不属于本次范围的值**不算数** —— "只看我的"的数字才是真的我的；
//   - **树上的显示**用这里的 `viewValue`（不丢信息）：范围内没有值、但范围外有值时，
//     显示缓存里那个值，并用 `viewBorrowed` 告诉渲染层"这不是你在查看的账户的值"，
//     由它加个悬停说明。树是浏览视图，名字/标题突然消失比"标注一下"糟得多。
//
// 派生字段（status2 / status1 / acTime / lastSubmitTime / xcpcDifficulty /
// statusComplete1 / statusComplete2）**全部**按范围算（`viewDerived` → `core/derive.js` 的表）。
//
// 依赖：core/fieldValue.js（读取器）、core/model/elements.js（形状）、core/derive.js（派生表）。
// 说明：纯函数（除了一个按 state 记忆化的小缓存），不碰 DOM。
// ================================================================

import { readField, readFieldInfo } from '../core/fieldValue.js';
// ★ 查看范围 = 本账户（+ 开关开着时的直接子账户）；规则与开关的唯一一份都在这里
import { scopeAccountsFor, mergeChildrenOf } from '../core/trust.js';
import { derivedOf } from '../core/derive.js';
// 「自己那份」怎么读（**按列的种类分流**，组值的取值器用它）
import { ELEMENT_NATURE, isElement, natureOf } from '../core/model/elements.js';
// 两列值的「组那份」（记忆化在 `core/groupCompute.js` 里，它只读 state）
import { groupValueOf, groupValueOnDemand, groupComputed } from '../core/groupCompute.js';
// 「这一格有没有聚合器」的判据也只有一份（`core/groupValue.js` 的 `AGG_BUILDERS`）
import { hasGroupAgg } from '../core/groupValue.js';
// 「合并显示」：显示该用哪一列，由**计数模式**决定（唯一一份口径）。
// ⚠️ 模式常量从**它真正的家**取（`groupCount.js`）；`countMode.js` 只导出解析函数 —— 别记混。
import { resolveCountMode } from '../core/query/countMode.js';
import { MODE_DEDUP } from '../core/query/groupCount.js';
import { virtualContainerStats } from '../core/ops/virtualStats.js';
// ★ 结构签名（折叠不该让"容器状态"这份缓存失效 —— 见 `virtualMemo` 那段注释）
import { structureSignatureOf } from '../core/model/page.js';

/** 按 state 记忆化（一次渲染里会被成千上万次调用，`resolveScope` 每次都要建 Set） */
const memo = new WeakMap();

/**
 * 「自己那份」怎么读 —— **按列的种类分流，只有这一处**。
 *
 * 组值（`GROUP_FIELDS` 物化那份 + `groupValueOnDemand` 按需那份）都要一个"自己那份"的取值器，
 * 而不同种类的列住在不同地方，读错了就是"组值永远是空"（实测踩到：`contestTime` 走了
 * `viewDerived` ⇒ 它不在派生表里 ⇒ 恒 `undefined` ⇒ 组值算出来是 `null`）：
 *   · **派生列**（`status1`/`status2`/`statusComplete1/2`…）⇒ `derivedOf`（按范围算）；
 *   · **元列**（`链接分类`）⇒ 直接读节点上那一格：它不是来源层里的字段
 *     （它的展示是 🔗 链接块，没有"来源层投影"这回事）；
 *   · **普通字段**（`contestTime` / `ratio`…）⇒ `viewValue`（来源层投影）。
 */
function ownColumnReader(state, field, scoped) {
    if (!isElement(field)) return (n) => (n ? n[field] : undefined);
    if (natureOf(field) === ELEMENT_NATURE.DERIVED) return (n) => derivedOf(state, n, field, scoped);
    return (n) => viewValue(state, n, field);
}

/**
 * **父节点的初值 ← 子树节点的终值**：判重模式下，把"每层三趟"的**倒推覆盖表**
 * 交给派生表（`opts.group`）。
 *
 * 为什么必须在这里给：容器（C/W/S）汇总子树里的 P 时，取的是那些节点的值 ——
 * 判重下那道题的**终值**是它所属组的组值，而组值不在节点上、只在覆盖表里
 * （`core/derive.js` 的 `status1Of` / `status2Of` 早就写成"组那份优先"，
 * 没有这张表就没处生效）。不给 ⇒ 容器按各副本的**初值**算：pta 侧的副本 0、
 * qoj 侧的副本 3 —— 看起来就是"题亮了、比赛不亮"。
 *
 * `plain` ⇒ `undefined`：不给 `opts.group`，派生表**逐字不变**（回归锚）。
 */
function groupTableFor(state) {
    if (displayColumnOf(state) !== 'group') return undefined;
    const c = groupComputed(state, { viewingAccountId: state.viewingAccountId });
    return c.hasSynthesis ? c.working : undefined;
}

/**
 * 本次查看的范围（转成 `core` 读取器要的 opts）。
 *
 * 范围 = `{ viewingAccountId }`（单元素集合）。
 * 将来接上"多账户并排"时**调用方一行都不用改** —— 它们只认这个函数。
 *
 * @param {Object} state
 * @returns {{trust:Object, accounts:Object, scopeAccounts:string[], group?:Map}}
 */
export function scopeOpts(state) {
    if (!state || typeof state !== 'object') return { scopeAccounts: [] };
    const view = state.viewingAccountId || '';
    const hit = memo.get(state);
    // ⚠️ 计数模式（`settings`）与 `nodes` 也要比：切模式、改数据都不换 `state.viewingAccountId`
    //    —— 只比 view/trust/accounts 会把上一模式的 opts（含旧 `group` 表）发出去。
    if (hit && hit.view === view && hit.trust === state.trust && hit.accounts === state.accounts
        && hit.settings === state.settings && hit.nodes === state.nodes
        && hit.childOrder === state.childOrder) {
        return hit.opts;
    }
    const group = groupTableFor(state);
    const opts = {
        trust: state.trust,
        accounts: state.accounts,
        // 空字符串（还没配置账户的老状态）→ 空集合 = 只看客观值。
        // ★ `v9.1.23`：开关开着时范围 = **本账户 + 它的直接子账户**（规则唯一一份在
        //   `core/trust.js:scopeAccountsFor`，`resolveScope` 那一支也调它）——
        //   用户 2026-10-13："把子账户机制用起来，status2 的 own 值取本账号与所有子账户的合并结果"，
        //   并明确"**不用递归**"。**默认关 = 原逻辑**（只在本账户里看）。
        //   ⚠️ 这一格是**显示路径唯一的范围构造口**（树上 / 统计 / 详页的值级面板都走它），
        //      在这里展开就等于全应用一致；别在别的调用点再各加一次。
        scopeAccounts: scopeAccountsFor(view, state.accounts, mergeChildrenOf(state.settings)),
        // 让下游（`resolveScope`）读到同一个开关 —— 少了它，"带不带子账户"会在两处各判一次
        settings: state.settings,
        ...(group ? { group } : {})
    };
    memo.set(state, {
        view, trust: state.trust, accounts: state.accounts, settings: state.settings,
        nodes: state.nodes, childOrder: state.childOrder, opts
    });
    return opts;
}

/**
 * 显示用读值（**不丢信息**的显示策略）。
 *
 * ⚠️ **底层口**：它给的只是「**靠前那份**」（这个节点自己那份）。
 *   要用"**屏幕上那一列**"⇒ `viewDerivedDisplay(...) ?? viewValue(...)`（来源层字段
 *   `viewDerivedDisplay` 会给 `undefined`）——"该用哪一份"的判据**只有 `displayColumnOf` 一处**。
 *   直接调本函数的场合在仓里是**例外**（编辑表单默认值 / 导出 / 喂聚合的读取器），
 *   名单守卫在 `src/test/dedupDisplay.test.js`（名单外的新文件读底层口就红）。
 *
 * @param {Object} state
 * @param {Object} node
 * @param {string} field
 * @returns {string|string[]}
 */
export function viewValue(state, node, field) {
    const info = readFieldInfo(node, field, scopeOpts(state));
    if (info.outOfScope) {
        // 范围内没有这个值 → 显示缓存里那个（可能是别人的），由 viewBorrowed 负责标注
        return info.cacheValue === undefined || info.cacheValue === null
            ? info.value : info.cacheValue;
    }
    return info.value;
}

/** 严格口径读值（聚合/统计/筛选用）：不属于本次范围的值**不算数** */
export function viewValueStrict(state, node, field) {
    return readField(node, field, scopeOpts(state));
}

/**
 * 现在显示的这个值，是不是"别人的"（不在查看范围内）？
 * 渲染层拿它决定要不要加悬停说明。
 */
export function viewBorrowed(state, node, field) {
    return !!readFieldInfo(node, field, scopeOpts(state)).outOfScope;
}

// ================================================================
// 「合并显示」—— 显示该读哪一列，由**计数模式**决定
//
// 口径：`ui/dedup/summary.js` 写着「同组的 P/C 计数、状态与信息**在去重计数模式下才
// 合并显示**」。**统计**侧由 `core/query/stats.js` 的 `countModeOf` 接了口径；**显示**侧
// 必须同样按 `countMode` 取，否则开了去重模式，状态栏的「我全 AC 数」变了，树上/检索
// 却还是各显示各的（一道题在 A 平台 AC 了、B 平台的副本仍显示"未做"）。
//
// 判据只有一条：`settings.stats.countMode === 'dedup'` ⇒ 读**组那份**：
//   · `GROUP_FIELDS` 的两个字段（`status1` / `status2`）走**物化**那份
//     （`core/groupCompute.js` 的 `groupValueOf`）；
//   · C 的容器字段（`statusComplete1` / `statusComplete2`）**没进那三趟物化**
//     ⇒ 走 `groupValueOnDemand` **按需聚合**（规则仍是 `AGG_BUILDERS` 那一份）
//     —— 判重下"一场比赛"也跟"一道题"一样合并显示（一处 AC ⇒ 整组亮）；
//   · 其余字段（难度 / `acTime` …）没有聚合器 ⇒ 两列同值，读了也一样。
//
// ★ **父节点的初值 ← 子树节点的终值**（`groupTableFor`）
//   上面两条只管"这一列读什么"。还有一处更靠里的口径：容器**算自己那份**时汇总的是
//   子树里 P 的值 —— 判重下那必须是它们的**终值**（所属组的组值），所以
//   `scopeOpts` 在 dedup 下把倒推覆盖表一并交给派生表（`opts.group`）。
//   否则同一个 C 的 pta 副本按"自己那份"算成 0、qoj 副本算成 3（各算各的初值）。
//   合成节点（组头）的成员不在 `childOrder` 里 ⇒ 由 `core/derive.js` 的第二趟处理。
//
// ⚠️ **只给"显示"用**。三种地方**必须**继续读自己那份（读错了会污染数据或震荡）：
//   ① 编辑表单的默认值（`ui/G_modal/editForm.js`）—— 把组那份填进表单、一保存就写进**自己那份**；
//   ② 导出（`handlers/H4_exportFormats.js`）—— 导出的是数据，不该随显示模式变；
//   ③ 喂给聚合的读取器（`view/stats.js` 的 `derivedReader`、`core/derive.js`）——
//      组那份写回去会被当输入重新喂进聚合（`core/derive.js` 文件头那条警告）。
// ================================================================

/**
 * 显示该读哪一列：`dedup` ⇒ `'group'`，否则 `'own'`（纯函数，老存档缺键 ⇒ own）。
 *
 * ★ **逐字段覆盖**（设置里的 `settings.display.fieldColumn = { 字段: 'own'|'group' }`，
 *   只存**偏离默认**的项）—— 但**收法甲**：覆盖**只在判重模式下生效**。
 *   为什么：不判重却按组读 = 每次都要算一整趟组值（真包 ~750ms），
 *   而"`plain` 下不许触发任何聚合"是一条硬规矩（`src/core/AGENTS.md`、`perfGuards.test.js` ⑦）。
 *   ⇒ 不判重时一律本份，设置里那一节也这么写。
 *
 * @param {Object} state
 * @param {string} [field] 给了才查覆盖；不给 = 只看模式（组表/整屏口径那种调用点）
 */
export function displayColumnOf(state, field) {
    const mode = resolveCountMode(state && state.settings) === MODE_DEDUP ? 'group' : 'own';
    if (mode !== 'group' || !field) return mode;
    const over = state.settings.display ? state.settings.display.fieldColumn : null;
    const pick = over ? over[field] : undefined;
    return (pick === 'own' || pick === 'group') ? pick : mode;
}

/**
 * **显示用**派生值（树上颜色、检索表、卡片都走它）。
 *
 * `plain` 模式下与 `viewDerived(state, node, field)` **逐字相同**。
 */
export function viewDerivedDisplay(state, node, field) {
    return viewDerived(state, node, field, { column: displayColumnOf(state, field) });
}

/** **显示用**读取器（`(node, field) => value`）—— 给 `collect.js` 那种"收数据"的口子 */
export function displayDerivedReader(state) {
    return (node, field) => viewDerivedDisplay(state, node, field);
}

/** 悬停用的说明（不属于范围时给一句人话，否则空串） */
export function viewBorrowedTitle(state, node, field) {
    return viewBorrowed(state, node, field)
        ? '这个值不属于当前「在查看」的账户（显示的是登录账户口径的缓存值）'
        : '';
}

/**
 * 树上那句"口径提示"。
 *
 * 说清"现在在看谁"。
 *
 * @returns {string} 空串 = 没什么可说的（不占版面）
 */
export function viewNote(state) {
    if (!state) return '';
    const viewing = state.viewingAccountId || '';
    const current = state.currentAccountId || '';
    if (!viewing) return '';
    const nameOf = (id) => {
        const acc = state.accounts && state.accounts[id];
        return acc && acc.name ? acc.name : id;
    };
    if (viewing === current) {
        return `👁 口径：${nameOf(viewing)}（全部按这个账户算）`;
    }
    return `👁 只看「${nameOf(viewing)}」的值；别人的值不参与统计（显示时会在悬停里说明）`;
}

/**
 * 读**派生字段**（按本次范围现算）。
 *
 * 走 `core/derive.js` 的表：`status2` / `status1` / `acTime` / `lastSubmitTime` /
 * `xcpcDifficulty` / `statusComplete1` / `statusComplete2` **全部**按范围算。
 * 不在表里的节点（虚拟节点）自动退回缓存。
 *
 * **两列值**
 * --------------------
 * `opts.column === 'group'` ⇒ 返回「**组那份**」（合成节点自己的那份 + 它的成员各自
 * 那份，按 `status1` 取或 / `status2` `preferReal` **再聚合**，规则与特例见
 * `core/groupValue.js` 的文件头：**合并**，不是组头压过成员）；
 * 不给 ⇒ 返回「节点自己那份」（既有调用点一个都不用改）。
 *
 * ⚠️ **底层口**：不给 `opts` 时它给的是「**靠前那份**」，**不是**"屏幕上那一列"。
 *   显示口径 = `viewDerivedDisplay(state, node, field)`（内部就是
 *   `viewDerived(..., { column: displayColumnOf(state) })`）——判据只有那一处。
 *   直接调本函数的场合是**例外**，名单守卫在 `src/test/dedupDisplay.test.js`。
 *
 * ⚠️ 两列都是**派生**：不落库、不写来源层、不新增缓存字段
 *   （写回去就会被当输入重新喂进聚合 ⇒ 震荡）。
 *
 * **副页虚拟节点**：
 *   - 虚拟 P → 转发到它引用的**真实 P**（"这题过没过"是真实节点的事）；
 *   - 虚拟 W/S/C → 用 `virtualContainerStats` **现算**聚合（副页里引用的题目可能来自
 *     多处，聚合值当然也跟着范围走）；结果按 (pageId, vId, 范围) 记忆化。
 *
 * @param {Object} state
 * @param {Object} node
 * @param {'status2'|'acTime'|'lastSubmitTime'|'xcpcDifficulty'|'statusComplete2'|'status1'|'statusComplete1'|'contestTime'|'链接分类'} field
 *        （`contestTime` / `链接分类` 这类**信息字段**也有组值，按需聚合；字段名单以
 *          `core/groupValue.js` 的 `AGG_BUILDERS` 为准 —— 这里只是常走的那几个）
 * @param {Object} [opts] - `{ column: 'own'|'group' }`；省 / `'own'` = 自己那份
 */
export function viewDerived(state, node, field, opts = {}) {
    const column = opts.column === 'group' ? 'group' : 'own';
    if (node && node._virtual) {
        // ★ **副页节点在"组列"下转发给它所映射的真实节点**（用户 2026-10-08：
        //   "让副页节点从主页节点复制更多信息：P 节点的难度、C 节点的链接 / 比赛时间、
        //    题目概览难度方框的完整版"）。
        //   为什么必须转发：这几格（**有聚合器**、又不是状态那几格 —— 难度 / 通过率 / 等级 /
        //   `acTime` / `lastSubmitTime` / `contestTime` / `链接分类`）的值**不在主节点身上**，
        //   它们是**组那份**（组头自己不落）。而虚拟节点走不到组列那条路
        //   （`virtualDerived` 只给"自己那份"或页内 `virtualContainerStats`）⇒
        //   副页的卡片/方框上这几格一律是空的。转给真实节点、并带上组列，与主页**同值**。
        //   ⚠️ 只管这几格：状态那四格照旧（虚拟 P 转发自己那份、虚拟 W/S/C 的两格是
        //   **页内现算**的，见 `virtualDerived` —— 别把它们拉进这一支）。
        if (column === 'group' && node._refId
            && hasGroupAgg(field)
            && field !== 'status1' && field !== 'status2'
            && field !== 'statusComplete1' && field !== 'statusComplete2') {
            const real = state.nodes ? state.nodes[node._refId] : null;
            if (real) return viewDerived(state, real, field, { column: 'group' });
        }
        const v = virtualDerived(state, node, field);
        // 虚拟节点没有"组"这回事（它不在 `state.nodes` 里）：两列同值。
        return v;
    }
    if (column === 'group') {
        const g = groupValueOf(state, node, field, scopeOpts(state));
        if (g !== undefined) return g;
        // ★ **有聚合器、但没进那三趟物化**的字段（C 的 `statusComplete1` / `statusComplete2`，
        //   见 `core/groupValue.js` 的 `GROUP_FIELDS` 注释）—— 显示列也得给出「组那份」：
        //   否则判重模式下同一个 C 组的各来源副本**各显示各的**（一处 AC ⇒ 整场比赛不亮）。
        //   规则不另写：`groupValueOnDemand` → `groupAggregateOf`（`AGG_BUILDERS` 那一份），
        //   取值器用**本范围投影过的"自己那份"**（`ownColumnReader`：派生列 / 元列 / 普通字段
        //   三种列各读各的地方），与统计侧同口径。
        const onDemand = groupValueOnDemand(state, node, field,
            (n, f) => ownColumnReader(state, f, scopeOpts(state))(n));
        return onDemand === undefined ? derivedOf(state, node, field, scopeOpts(state)) : onDemand;
    }
    return derivedOf(state, node, field, scopeOpts(state));
}

/** 副页虚拟节点统计的记忆化（键：pageId|vId|范围） */
const virtualMemo = new Map();

function virtualDerived(state, vNode, field) {
    // 虚拟 P：转发给真实节点（值级字段本来就直接读合成节点上的 values）
    if (vNode._refId && !(vNode.type === 'W' || vNode.type === 'S' || vNode.type === 'C')) {
        const real = state.nodes ? state.nodes[vNode._refId] : null;
        if (real) return derivedOf(state, real, field, scopeOpts(state));
    }
    const pageId = vNode._pageId;
    const page = state.pages ? state.pages[pageId] : null;
    if (!page || !page.virtualIndex) return vNode[field];

    const key = `${pageId}|${vNode._virtualId}|${state.viewingAccountId || ''}`;
    const sig = structureSignatureOf(page);
    let hit = virtualMemo.get(key);
    // ⚠️ 命中判断要比 `nodes` / `accounts` / `trust` / `settings`：停用启用账户、改来源等级、
    //    **切计数模式**都**不会**换 `state.nodes` / `page` 的引用，只比那几个会给出陈旧数字
    //    （与 `view/stats.js`、`core/derive.js` 的缓存键保持一致）。
    // ★ 比的是**结构签名**、不是页对象本身：`expanded` 存在 vNode 上，折一下就换新页对象，
    //   比页对象会让这份缓存**每折一次全作废**（用户 2026-10-18："副页折叠现在慢啊"）。
    if (hit && hit.nodes === state.nodes && hit.sig === sig
        && hit.accounts === state.accounts && hit.trust === state.trust
        && hit.settings === state.settings) return hit.stats[field];
    const stats = virtualContainerStats(page, vNode._virtualId, {
        nodes: state.nodes,
        derived: (n, f) => derivedOf(state, n, f, scopeOpts(state)),
        settings: state.settings
    });
    // 简单上限：副页/范围都不多，但不做无界增长
    if (virtualMemo.size > 500) virtualMemo.clear();
    virtualMemo.set(key, {
        nodes: state.nodes, sig, accounts: state.accounts, trust: state.trust,
        settings: state.settings, stats
    });
    return stats[field];
}
