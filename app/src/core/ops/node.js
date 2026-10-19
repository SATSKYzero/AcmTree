// ================================================================
// 节点属性更新（core/ops/node.js）
// 职责：updateP / updateR / updateWS / updateRemark
// 依赖：utils/A_helpers.js, _helpers.js, core/autoCompute.js, core/ops/synth.js
// ================================================================
import { getXcpcDifficulty } from '../../utils/A_helpers.js';
import { normalizeTime, getNowStr } from '../../utils/time.js';
import { addSourceValue, removeManualValue, removeManualFieldValue, accountOfEntry, MANUAL_SRC, setDerivedOverride } from '../fieldValue.js';
import { isManuallyEditable, natureOf, fieldValueKey, isPinValue, isEmptyFieldValue, ELEMENT_NATURE, toCacheShape } from '../model/elements.js';
import { containerAggregates, derivePstatus2 } from '../derive.js';
import { readField } from '../fieldValue.js';
import { resolveScope } from '../trust.js';
import { effectivePin } from '../pin.js';
import { groupAggregateOf } from '../groupValue.js';
import { SUBMIT_KINDS } from '../model/status.js';
import { assertManualEditAllowed } from './account.js';
// 「撤掉一条来源值之后的收尾」（重投影 / 回默认）—— 与值级面板的「真删」共用同一份
import { settleFieldAfterRemoval } from './trust.js';
import { applyOwnerSynth, bindOwner, syncGroupNature, isSynthesis, synthKeyOf, synthMembersTable } from './synth.js';
import { NATURE_FIELD_KEYS, normalizeNatureValue, classPathProblem } from '../natureFields.js';
import { clearClassRule, setClassRule, MANUAL_RULE } from '../natureConfidence.js';
import { STATUS2_MAX } from '../../A_constants.js';

/**
 * 按**当前登录账户**的口径算一个派生值（校验用）。
 * 为什么要这个：派生值现在按范围算，缓存字段可能属于别的口径 ——
 * 拿缓存校验会把"我的 AC"当成"没有 AC"而拒掉合法输入（实测踩到）。
 *
 * ⚠️ **不再建派生表**。以前是"整表建一遍（真包 27k 约 150ms）；要自动值就把本节点那条覆盖
 *    **就地**摘掉、整表再建一遍（`fresh: true`，再约 150ms）"—— 校验一次 `status2` 就是两趟全表。
 *    现在按规则**直接算这一个字段**：
 *      · `status1` / P 的 `status2`：`core/derive.js` 里**同一份**规则，取值用"按范围投影"的读；
 *      · 容器两格：`core/derive.js` 的 `containerAggregates` 走**这棵子树**，子树里每个 P 都按
 *        同一份规则算（组头换成"组那份"，与 `derive.js` 第二趟**逐字同一份** `groupAggregateOf`）。
 *
 * "不带覆盖"（`withPin = false`）**只对本节点自己生效**：等价于老代码"把本节点那一条覆盖就地
 * 摘掉"——别的节点该有的覆盖照旧（老代码也只摘本节点那一条）。
 *
 * @param {boolean} [withPin] - 是否把**已有的覆盖**算进去（默认算）
 */
function scopedDerived(draft, node, field, withPin = true) {
    const full = {
        viewingAccount: draft.currentAccountId,
        accounts: draft.accounts,
        trust: draft.trust
    };
    const scope = resolveScope(full);
    const read = (n, f) => readField(n, f, full);
    const pinOf = (n, f) => ((n === node && !withPin) ? null : effectivePin(n, f, scope));
    const isOn = (n, f) => String(pinOf(n, f)) === '1';
    const isIgnore = (f) => String(pinOf(node, f)) === '4';
    // 组头的成员表**一次调用只建一趟**（整表扫一遍）—— 容器那两格会把子树里每个 P 都问一遍，
    // 而子树里有几千个组头，逐个建表就是 O(#组头 × N)（真包 2257 个组头 ⇒ 几十秒）。
    let membersTable = null;
    const membersOf = (key) => {
        if (membersTable === null) membersTable = synthMembersTable(draft);
        return membersTable.get(key) || [];
    };

    if (field === 'status1') {
        if (node.type !== 'P') return undefined;                 // 规则表里只有 P 有 status1
        return isOn(node, 'status1') ? 1 : 0;
    }
    if (field === 'status2') {
        if (node.type !== 'P') return undefined;                 // 只有 P 有 status2
        return scopedStatus2Of(draft, node, read, pinOf, membersOf);
    }
    if (field === 'statusComplete1' || field === 'statusComplete2') {
        if (node.type !== 'C' && node.type !== 'W' && node.type !== 'S') return undefined;
        const agg = containerAggregates(
            draft, node,
            (p) => (isOn(p, 'status1') ? 1 : 0),
            (p) => scopedStatus2Of(draft, p, read, pinOf, membersOf),
            isIgnore('statusComplete2') ? '4' : null
        );
        return field === 'statusComplete1' ? agg.complete1 : agg.complete2;
    }
    return undefined;
}

/**
 * 一个 P"按范围算出来的那一份 `status2`" —— 组头换成**组那份**。
 *
 * 与 `core/derive.js` 第二趟同一条规则（`groupAggregateOf`）：成员是**指针**关系、
 * 不在 `childOrder` 里，组头的值只能在全树算完之后再算；头没有成员 ⇒ 组值 ≡ 自己那份。
 *
 * @param {Function} membersOf - `(synthKey) => string[]`，**一次调用只建一趟**的成员表取值器
 */
function scopedStatus2Of(draft, p, read, pinOf, membersOf) {
    const own = derivePstatus2(draft, p, read, () => pinOf(p, 'status2'));
    if (!isSynthesis(p)) return own;
    const memberIds = membersOf(synthKeyOf(p));
    if (!memberIds.length) return own;
    const merged = groupAggregateOf(draft, {
        headId: p.id,
        memberIds,
        field: 'status2',
        readOf: (n) => (n.id === p.id ? own : derivePstatus2(draft, n, read, () => pinOf(n, 'status2')))
    });
    return (merged === undefined || merged === null) ? own : merged;
}

/**
 * 不带覆盖的"自动值"（快捷方式）= `scopedDerived(..., withPin = false)`。
 *
 * ⚠️ 以前这里对容器还留着"摘了覆盖再整份重建"的兜底 —— 那换不动 `nodes` 引用，而派生表
 *    会复用"计数那一趟"的结果（一代一次）⇒ 缓存看不出"就地摘" ⇒ 会把**带覆盖的值**当成
 *    自动值（实测：撤 pin 时校验判"自动计算为 5"、事务直接失败）。现在整条路都不建表了。
 */
function scopedDerivedAuto(draft, node, field) {
    return scopedDerived(draft, node, field, false);
}

/**
 * ★ **这次编辑的归属**（`'objective'` = 所有人共用 / `'account'` = 当前账户私有）—— **唯一一处**判据。
 *
 * 优先序（用户 2026-10-13 拍板，见 `docs/manual-values.md`）：
 *   ① `opts.scope`（编辑框里那一次的显式选择）；
 *   ② `settings.manualScope`（设置里的全局默认 ＝ **编辑框上次的选择**，一件事别设两处）；
 *   ③ **按字段回落**（都没设时）：nature 四格客观、其余账户 —— 老行为一字不变。
 *
 * ⚠️ 编辑时 `viewing === current`（只读态禁止手改，见 `ops/account.js`）⇒ "我的那条"
 *    就是 `draft.currentAccountId`，**不需要**去猜投影范围。
 *
 * @returns {'objective'|'account'}
 */
export function manualScopeOf(draft, field, opts = {}) {
    const asked = String((opts && opts.scope)
        || (draft && draft.settings && draft.settings.manualScope) || '');
    if (asked === 'objective' || asked === 'account') return asked;
    return NATURE_FIELD_KEYS.includes(field) ? 'objective' : 'account';
}

/**
 * 建一个"手改记录器" —— **所有元素都走这一条规则**。
 *
 * 判据：**"我敲过它" ∧ "它确实变了"**，两条都成立才记一条 `manual` 来源值。
 *   - "我敲过它" = 该元素在弹窗里产生过 `input`/`change` 事件（见 ui/G_modal/manualInput.js）。
 *     程序写 `el.value = x` **不触发事件**，所以"来源动作把值同步进输入框"天然不算；
 *   - "它确实变了" = 新值与改动前不同。只看"敲过"会把"敲了个一模一样的值"记成手改；
 *     只看"变了"会把程序同步的值记成手改（manual 优先级最高，会让偏好永久失效）。
 *   - 不给 `opts.manualFields` 时，退回"值变了就记"的保守判断。
 *
 * **特判一律来自属性表**（`core/model/elements.js`），不在这里写 if：
 *   - 性质为 `derived` 的元素（status1 / status2 / statusComplete2 …）不记 ——
 *     它们的值由 `core/autoCompute.js` 算出来，记了也会被下一轮重算冲掉；
 *   - 未登记的元素也不记（宁可漏记，也不要凭字段名猜性质）；
 *   - `remark`（nature: note）**记**（它是你写的值），但导入永不写它；
 *   - `tags`（nature: tagList）**记**，值的形状由 `shape: 'list'` 声明。
 *
 * @returns {(field:string, before:*, after:*) => boolean} 是否记下了一条
 */
export function manualRecorder(draft, node, opts) {
    return (field, before, after) => recordManualValue(draft, node, field, before, after, opts);
}

/**
 * 单点版的手改记录（批量流程用：一个 mutator 里要依次改很多个节点，
 * 每个节点的 `before/after` 都不同，所以不能共用一个绑定了 node 的闭包）。
 *
 * 判据与 `manualRecorder` **完全同一套** —— 规则只有这一处。
 *
 * @returns {boolean} 是否记下了一条
 */
export function recordManualValue(draft, node, field, before, after, opts = {}) {
    const manualSet = Array.isArray(opts && opts.manualFields) ? new Set(opts.manualFields) : null;
    if (!isManuallyEditable(field)) return false;
    if (natureOf(field) === ELEMENT_NATURE.DERIVED) return false;
    // 列表型元素（tags）也能记 —— 形状由属性表的 `shape:'list'` 决定，
    // `addSourceValue` 会把它规范成**字符串数组**（按内容深比较去重）。
    // "变了没有"也必须按形状比：数组不能 `String()` 比（会总是"变了"）。
    const bKey = fieldValueKey(field, before);
    const aKey = fieldValueKey(field, after);
    if (bKey === aKey) return false;                              // 它确实变了？
    if (manualSet ? !manualSet.has(field) : false) return false;   // 我敲过它？（批量流程没有"敲过"信号，退回"变了就记"）
    // ⚠️ 手改值没有类别 —— 界面上它落在「🔗 链接」那一组，如实呈现。
    // 而"按节点类型/字段名分别处理"那种写法本身就是**特判**（口径："数据处理的逻辑中
    // 一个特判都没有"）。
    // **清空 = 删掉那条手改**（不是塞一个空值进去）。
    //   ⚠️ 这是一个实测逮到的**静默失效**：`addSourceValue` 对空值是"不记"（`fieldValue.js:77`），
    //   所以"把值改回空"若不显式撤掉那条 `manual` 源值，它就留在 `values` 里，
    //   而 `manual` 在投影里优先级最高 ⇒ `viewValue()` 仍旧吐出旧值：保存后编辑框又显示旧值，
    //   用户视角就是"清不掉"。（所有手改字段共有，不是某一类的毛病。）
    //   空的 `after` ⇒ 撤掉**这次编辑归属的那条** manual，投影自然回落到其它来源 / "没有出处"。
    const scope = manualScopeOf(draft, field, opts);
    if (isEmptyFieldValue(field, after)) {
        // ★ **按"这次编辑的归属"清**（用户 2026-10-13 拍板；口径见 `docs/manual-values.md`）——
        //   不再按字段名单分流：**客观那条（`account === ''`）与本账户那条是两条**，
        //   按名单清会把另一条一起带走。老数据里 nature 四格带账户的那条在加载时
        //   已被 `stripNatureAccounts` 抹平（`core/fieldValue.js`），所以这里按账户清
        //   不会重现"清了几回还在"。
        const wantAccount = scope === 'objective' ? '' : draft.currentAccountId;
        let removed = removeManualValue(node, field, wantAccount);
        // ★ **兜底：精确那条没命中时，退回"这一格的手改（不分归属）"**（`v9.1.20`，补残余 1）。
        //   为什么必须有：老数据里 nature 四格可能带着账户（真实应用走不到 —— 加载时
        //   `normalizeStateValues → stripNatureAccounts` 会抹平；但**手工构造 state 的脚本/测试**会撞上），
        //   而 nature 的归属回落到客观 ⇒ 按 `''` 清**找不到那条** ⇒ 值原样留着，
        //   用户视角就是"清不掉"（`core/fieldValue.js:removeManualFieldValue` 的注释里
        //   记着这个症状的真事：用户"这个重复怎么不停出现，我修了 3 回了"）。
        //   ⚠️ 只在**精确那条没命中**时才退 —— 正常"客观 + 本账户两条并存"的场合，
        //      精确那条一定命中，另一条**不许**被顺手带走（那正是 v9.1.10 改成按归属清的原因）。
        if (!removed) removed = removeManualFieldValue(node, field);
        // ★ 撤掉那条手改之后**必须收尾**：缓存要回落到别的来源（或回默认）——
        //   不收尾的话，同一格会出现两个答案：**③ 性质待补**读缓存（`natureStatusOf`）说"缺"、
        //   而字段表 / 编辑框 / 导入读投影说"有值"。
        //   实测（用户 2026-10-08）：把手改的赛季清掉、想让脚本那份说话 ⇒ ③ 里从此写着
        //   "缺：赛季"、字段表里却是 2023，重新导入也治不好（那条记录被指纹判成"没变化 ⇒ 跳过"）。
        //   收尾那一份与值级面板的「真删」**同一处**（`core/ops/trust.js`）。
        if (removed) settleFieldAfterRemoval(draft, node, field);
        return removed;
    }
    // ★ **nature 四格默认不记账户**（用户 2026-10-08："年份,赛季这种信息不用分帐户"）——
    //   它们是比赛自己的属性；记了账户会让它在别的账户下看不见、却照样被导出带走。
    //   现在归属由 `manualScopeOf` 一处判：显式 `opts.scope` / 设置默认 / 按字段回落。
    const account = scope === 'objective' ? '' : draft.currentAccountId;
    return addSourceValue(node, field, after, MANUAL_SRC, {
        at: node.lastModified || getNowStr(),
        account
    });
}

/**
 * 「转成所有人共用」**只对这些字段开放**（用户 2026-10-13："现状只需要操作比赛时间" → 随后"各难度也操作吧"）。
 *
 * ⚠️ 这是"哪些字段允许这个动作"的**唯一一处名单**；要扩就往这里加。
 * ⚠️ 为什么没有 `ratio`（通过率）与 `xcpcDifficulty`：前者是"通过率"不是"难度"，后者是**派生字段**
 *    （由 `ratio` 算出来、手改本来就不记）⇒ 都不该出现在这个动作里。
 */
export const OBJECTIVE_PROMOTABLE_FIELDS = Object.freeze([
    'contestTime',          // 比赛时间
    'cfDifficulty',         // CF 难度
    'atcoderDifficulty',    // AtCoder 难度
    'clistDifficulty'       // clist 难度
]);

/**
 * ★ **一键"转成所有人共用"**（用户 2026-10-13 拍板）：把一个字段的"按账户手改"变成**客观手改**。
 *
 * 规则（用户 2026-10-13 明确，**第二版** —— 与首版不同的两处已按此改）：
 *   · 只对 `OBJECTIVE_PROMOTABLE_FIELDS` 里的字段开放（比赛时间 + 各难度）；
 *   · 取**第一个取到的账户条目**（**不是**"本账户那条"，也不按时间挑）；
 *   · **客观那条已经存在 ⇒ 不动它**；否则客观取**第一个账户条目的值**；
 *   · 之后**所有账户条目消失**（留着会同为合法候选，按"最近写的那条赢"把结果顶回去）；
 *   · **没有可转的** ⇒ **一个字节都不动**，如实回 `converted: false`。
 * ⚠️ **这个动作是破坏性的**（用户认可："破坏是难免的"）—— 它按定义要删掉那些账户条目。
 * ⚠️ 只认 `manual`：别的来源的账户归属是**抓取时认出来的事实**，不是"这是谁填的"，
 * 不该被这个动作改写（要改的是"我填的这条算谁的"）。
 *
 * @param {Object} draft
 * @param {string} id - 节点 id
 * @param {string} field
 * @returns {{converted:boolean, value?:*, from?:string, keptObjective?:boolean, reason?:string}}
 */
export function promoteManualToObjective(draft, id, field) {
    assertManualEditAllowed(draft, '转成所有人共用');
    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    // ★ **只对某些字段开放**（用户 2026-10-13："现状只需要操作比赛时间" + "各难度也操作吧"）。
    //   要扩名单就往这一行加 —— 这是"哪些字段允许这个动作"的**唯一一处**。
    if (!OBJECTIVE_PROMOTABLE_FIELDS.includes(field)) {
        return { converted: false, reason: `「${field}」不做这个动作（只开放：${OBJECTIVE_PROMOTABLE_FIELDS.join('、')}）` };
    }
    const list = (node.values && node.values[field]) || [];
    const usable = (x) => x && x.src === MANUAL_SRC && !isEmptyFieldValue(field, x.v);
    const mine = list.filter((x) => usable(x) && accountOfEntry(x) !== '');
    const objective = list.find((x) => usable(x) && accountOfEntry(x) === '');
    if (mine.length === 0) return { converted: false, reason: '该字段没有按账户的手改值可转' };
    // ★ **第一个取到的账户条目**（用户 2026-10-13 明确：**不是**"本账户那条"）
    const pick = mine[0];
    // ★ 规则（用户 2026-10-13）：
    //   · 客观那条**已经存在** ⇒ **不动它**；
    //   · 否则 ⇒ 客观取**第一个账户条目的值**；
    //   · 之后 ⇒ **所有账户条目消失**（留着会按"最近写的赢"把结果顶回去）。
    //   ⚠️ 这个动作**是破坏性的**（用户认可："破坏是难免的"）——它按定义要删掉那些账户条目。
    for (const acc of [...new Set(mine.map(accountOfEntry))]) {
        removeManualValue(node, field, acc);
    }
    if (!objective) {
        addSourceValue(node, field, pick.v, MANUAL_SRC, {
            at: pick.at || node.lastModified || getNowStr(),
            account: ''
        });
    }
    // 收尾与"清空手改"同一份：把缓存 `node[field]` 落回重投影的结果
    // （否则 ③ 性质待补读缓存、字段表读投影 ⇒ 同一格两个答案）。
    settleFieldAfterRemoval(draft, node, field);
    return {
        converted: true,
        value: objective ? objective.v : pick.v,
        from: accountOfEntry(pick),
        keptObjective: !!objective
    };
}

// ---- 「性质」三字段的写入（分类 / 年份 / 地区） ----
/**
 * 三个 nature 字段（分类 / 年份 / 地区）的写入 —— **唯一一处**。
 *
 * 为什么补这一支：字段（`core/model/elements.js`）、注册表（`core/natureFields.js`）、
 * 编辑控件（`ui/G_modal/editForm.js` 的 `natureFieldDescriptors`）都齐了，
 * 但 `updateP / updateR / updateWS` 一直**没有处理它们** —— 界面上填/选的性质会被
 * **静默丢掉**（保存"成功"、数据一个字节没变）。判重页的「性质待补」批量填写与
 * 编辑弹窗走的是**同一条路**（口径："写操作必须走 execute 事务，字段写入沿用既有的
 * 写路径，与编辑面板同源"）。
 *
 * 口径（逐条与 `normalizeNatureValue` 对齐，**不在这里另加加工**）：
 *   · 只 trim：**不补全年份**（`26` 不会变成 `2026`）、不做大小写折叠（`CF` 不会变成 `cf`）、
 *     不做别名替换 —— 与"给了秒就保留、没给就不补"同一条铁律（见 natureFields.js）；
 *   · 空串 = **没标**，是合法值（写空 = 把这个标注撤掉，与"清空指针即解绑"同一姿态）；
 *   · **分类要过 Trie**（"每个实际合法的列表被写死为 Trie 树"）——
 *     这是**唯一**在这里拦的校验，因为"不在 Trie 里"的值一旦写进去，筛选/建组/容器
 *     全都对不上，而且没法自动修。校验不过 ⇒ **一个字段都不落库**（见下）。
 *     其余字段（年份/地区）仍不在这里强校验格式（读回来的旧数据要能原样保存）。
 *   · 留痕与别的字段同源：`rec` = `manualRecorder(...)`（三个字段在属性表里都是
 *     `manual: true`），所以"这个性质是谁什么时候填的"在来源面板里看得见。
 *
 * @param {Object} node - **draft 里**的节点
 * @param {Object} fields - 只处理 `!== undefined` 的项（没传的字段不动）
 * @param {(field:string, before:*, after:*) => boolean} rec - 手改记录器
 */
function applyNatureFields(node, fields, rec) {
    // ⚠️ **先算出结果值、校验通过、再写**：校验不过时**一个字段都不落库** ——
    //    半写状态（分类改了、年份没跟上）比直接拒绝更糟。所以这里分两趟。
    const next = {};
    for (const key of NATURE_FIELD_KEYS) {
        if (fields[key] === undefined) continue;
        next[key] = normalizeNatureValue(key, fields[key]);
    }
    const cls = next.natureClass !== undefined ? next.natureClass : normalizeNatureValue('natureClass', node.natureClass);
    const problem = classPathProblem(cls);
    if (problem) throw new Error(`性质·分类不合法：${problem}（注册表见 acm-data/nature-registry.json）`);
    /** 这次**真的改了值**的字段（调用方据此决定要不要连带跟随组头 —— 见 `syncGroupNature`） */
    const changed = [];
    for (const key of Object.keys(next)) {
        const before = node[key];
        node[key] = next[key];
        // ★ **人改过的性质标成 `M`**。
        //   `分类依据` 记的是"这个值凭什么" —— 值一改，原先那条规则描述的就不是它了；
        //   而新的答案是**人**（`manual:set` ⇒ 级别 `M`：比任何规则都硬，见 `core/natureConfidence.js`）。
        //   ⚠️ 只有**真的变了**才动（与 `manualRecorder` 的"敲过 ∧ 变了"同一口径）；
        //   ⚠️ 值被**清空**时改成"没有依据"（没有值就没有"凭什么"）。
        //   ⚠️ 四个 nature 字段都标（不止分类）：`M` 的徽标画在分类那一格，
        //      但另外三个也得知道"这是人填的" —— 回代 baseline（scripts/nature-baseline.py）
        //      就是按这个标记把人的结论回写进包里。
        if (NATURE_FIELD_KEYS.includes(key)
            && String(before === undefined || before === null ? '' : before) !== next[key]) {
            if (next[key]) setClassRule(node, key, MANUAL_RULE);
            else clearClassRule(node, key);
            changed.push(key);
        }
        rec(key, before, next[key]);
    }
    return changed;
}

// ---- 「所属合成节点」的写入 ----
/**
 * 单独改「所属合成节点」（整理页的一键绑定走这条）。
 *
 * 它现在是**合成节点 + 指针**（docs/manual-workflow.md（合成节点））：
 *   · 值是某个合成节点的 `synthKey`；
 *   · 只能指同类型的合成节点、不能指自己、不能嵌套（合成节点没有这个字段）；
 *   · 校验全在 `core/ops/synth.js`，这里只做转发 —— 手改与整理页共用一条路。
 */
export function bindOwnerSynth(draft, id, value) {
    return bindOwner(draft, id, value);
}

// ---- 更新 P 节点 ----
/**
 * @param {Object} draft
 * @param {string} id
 * @param {Object} fields
 * @param {Object} [opts]
 * @param {string[]} [opts.manualFields] **哪些字段是"用户手动输入"的**（来源层用；
 *        判据见 `manualRecorder` 的注释）
 */
export function updateP(draft, id, fields, opts = {}) {
    // 只读边界：在查看别人的账户时**手改一律拒绝**（抛 → 事务回滚）。
    // 拦在这里而不是各个弹窗里：手改只有这一条写路径。
    assertManualEditAllowed(draft, '修改题目字段');

    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    if (node.type !== 'P') throw new Error('不是题目节点');

    const rec = manualRecorder(draft, node, opts);
    // 时间戳先定稿：来源值的时间取的就是它（"改于何时"对节点与来源值该是同一时刻）
    node.lastModified = getNowStr();

    if (fields.name !== undefined) {
        if (!fields.name.trim()) throw new Error('名称不能为空');
        const before = node.name;
        node.name = fields.name.trim();
        rec('name', before, node.name);
    }
    if (fields.status1 !== undefined) {
        const s1 = parseInt(fields.status1);
        if (isNaN(s1) || s1 < 0 || s1 > 1) throw new Error('状态1必须为0或1');
        node.status1 = s1;
        // 记/清覆盖：`1` 是"用户按下的已处理"，记进来源层（**带账户**、按范围生效）；
        // 不是覆盖值（`0`）就撤掉旧覆盖。与 status2 走同一个 `setDerivedOverride`。
        setDerivedOverride(node, 'status1', s1, {
            at: node.lastModified || getNowStr(),
            account: draft.currentAccountId
        });
    }
    if (fields.status2 !== undefined) {
        const s2 = parseInt(fields.status2);
        if (isNaN(s2) || s2 < 0 || s2 > STATUS2_MAX) {
            throw new Error(`状态2必须为0-${STATUS2_MAX}`);
        }

        // 校验用**与显示同一套口径**：范围内的提交 + 范围内的覆盖。
        // 允许三种：① 与"带当前覆盖"的派生值一致 ② 与"不带覆盖的自动值"一致（= 撤销覆盖）
        //          ③ 是"用户按下的覆盖值"—— 哪些值算覆盖由**属性表**决定，这里不写死。
        const allowed = isPinValue('status2', s2)
            || s2 === scopedDerived(draft, node, 'status2')
            || s2 === scopedDerivedAuto(draft, node, 'status2');
        if (!allowed) {
            throw new Error(`状态2 不合法，按当前查看范围的自动计算为 ${scopedDerivedAuto(draft, node, 'status2')}`);
        }
        node.status2 = s2;
        // 记/清覆盖：是覆盖值就记进来源层（带账户、按范围生效），不是就撤掉旧覆盖
        setDerivedOverride(node, 'status2', s2, {
            at: node.lastModified || getNowStr(),
            account: draft.currentAccountId
        });
    }
    if (fields.problemId !== undefined) {
        const before = node.problemId;
        node.problemId = fields.problemId.trim() || '';
        rec('problemId', before, node.problemId);
    }
    if (fields.cfDifficulty !== undefined) {
        const before = node.cfDifficulty;
        const diff = parseInt(fields.cfDifficulty);
        node.cfDifficulty = isNaN(diff) ? 0 : diff;
        rec('cfDifficulty', before, node.cfDifficulty);
    }
    if (fields.clistDifficulty !== undefined) {
        const before = node.clistDifficulty;
        const diff = parseInt(fields.clistDifficulty, 10);
        node.clistDifficulty = isNaN(diff) ? 0 : diff;
        rec('clistDifficulty', before, node.clistDifficulty);
    }
    if (fields.atcoderDifficulty !== undefined) {
        // 数值难度字段组的另一员。⚠️ AtCoder 的难度**可以是负数**（kenkoooo 的 `difficulty`，
        //   如 `abc138_a: -848`）⇒ `parseInt` 认负号，别写成 `Number(...) || 0` 那种（负号会被当假值）。
        const before = node.atcoderDifficulty;
        const diff = parseInt(fields.atcoderDifficulty, 10);
        node.atcoderDifficulty = isNaN(diff) ? 0 : diff;
        rec('atcoderDifficulty', before, node.atcoderDifficulty);
    }
    if (fields.link !== undefined) {
        const before = node.link;
        node.link = fields.link || '';
        rec('link', before, node.link);
    }
    if (fields.tags !== undefined) {
        const before = node.tags;
        // 缓存字段的形状（`[{id,text,color}]`）与来源层（字符串数组）不同 —— 转换规则在属性表
        node.tags = toCacheShape('tags', fields.tags);
        // `tags` 是列表型元素（`manual: true`）—— 与别的字段一样留痕。
        // 漏了这一支，标签的手改就不进来源层。
        rec('tags', before, node.tags);
    }
    if (fields.ownerSynth !== undefined) {
        applyOwnerSynth(draft, node, fields.ownerSynth);
    }
    // 记下"改动前"的 ratio，供下面判断这次到底有没有真的手改
    const ratioBefore = fields.ratio !== undefined ? node.ratio : null;
    if (fields.ratio !== undefined) {
        const ratioVal = String(fields.ratio).trim();
        if (ratioVal === '' || ratioVal === '-') {
            node.ratio = '';
            node.xcpcDifficulty = '-';
        } else if (ratioVal.includes('/')) {
            const parts = ratioVal.split('/');
            if (parts.length !== 2) throw new Error('过题比例格式错误');
            const pass = parseFloat(parts[0]);
            const total = parseFloat(parts[1]);
            if (isNaN(pass) || isNaN(total) || total <= 0) {
                throw new Error('过题比例分数无效');
            }
            const percent = (pass / total) * 100;
            node.ratio = String(percent);
            node.xcpcDifficulty = getXcpcDifficulty(percent);
        } else {
            const num = parseFloat(ratioVal.replace('%', ''));
            if (isNaN(num)) throw new Error('过题比例格式错误');
            node.ratio = String(num);
            node.xcpcDifficulty = getXcpcDifficulty(num);
        }
        // ratio 的三种写法（空 / 分数 / 百分比）最后都落到 node.ratio 上，
        // 所以"变了没有"要用**归一化后**的值比（`ratioBefore` 是改动前的缓存值）。
        //
        // ⚠️ 只在 `fields.ratio !== undefined` 时记：这一行若放到 if 外面，
        //    调用方没传 ratio 时 `ratioBefore` 是 null、`node.ratio` 是现值 →
        //    `manualRecorder` 会认定"变了"，把用户**没编辑过**的 ratio 记成手改
        //    （手改类别序最高 → 以后「优先来源」永久失效）。
        //    这条判据不该依赖调用方传 `manualFields` 的自觉。
        rec('ratio', ratioBefore, node.ratio);
    }
    // 「性质」四字段（可空；字段没传就不动）
    // ★ **改了性质就顺带跟一次组头**：组头的性质/键/名都是**成员派生**的
    //   （`core/ops/synth.js` 的 `syncGroupNature`，口径与 `scripts/synth-bind.mjs` 同一份）。
    //   不跟的话，人填完成员、组头还停在 `年份未知`、继续挂在「性质待补」里。
    if (applyNatureFields(node, fields, rec).length) syncGroupNature(draft, node);
    return node;
}

// ---- 更新 R 节点 ----
/**
 * @param {Object} draft
 * @param {string} id
 * @param {Object} fields
 * @param {Object} [opts] - 同 updateP：`{ manualFields }`
 *
 * 手改判据与 P/W/S/C 完全一致（**"我敲过它" ∧ "它确实变了"**）——
 * 不记的话，"手改提交结果"在来源面板上看起来还是导入的那个值，
 * 等于把手改痕迹丢了。
 */
export function updateR(draft, id, fields, opts = {}) {
    // 只读边界同样适用于提交记录（改提交也是手改）
    assertManualEditAllowed(draft, '修改提交记录');

    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    if (node.type !== 'R') throw new Error('不是提交记录节点');
    const rec = manualRecorder(draft, node, opts);
    node.lastModified = getNowStr();
    if (fields.time !== undefined) {
        const before = node.time;
        node.time = fields.time || '----.--.-- --:--';
        rec('time', before, node.time);
    }
    if (fields.status !== undefined) {
        const before = node.status;
        node.status = fields.status || '-';
        rec('status', before, node.status);
    }
    if (fields.link !== undefined) {
        const before = node.link;
        node.link = fields.link || '';
        rec('link', before, node.link);
    }
    // 提交性质（赛时 / VP / 补题）。允许为空 —— 空 = 判不出/标不出来。
    if (fields.submitKind !== undefined) {
        const k = String(fields.submitKind || '').trim();
        if (k && !SUBMIT_KINDS.includes(k)) {
            throw new Error(`提交性质只能是 ${SUBMIT_KINDS.join(' / ')}（或留空）`);
        }
        const before = node.submitKind;
        node.submitKind = k;
        rec('submitKind', before, node.submitKind);
    }
    // 提交记录也能被合成（同一场在两个榜单上各抓一份提交）—— C/P/R 都走同一条校验
    if (fields.ownerSynth !== undefined) {
        applyOwnerSynth(draft, node, fields.ownerSynth);
    }
    // 「性质」四字段（可空；字段没传就不动）
    // ★ **改了性质就顺带跟一次组头**：组头的性质/键/名都是**成员派生**的
    //   （`core/ops/synth.js` 的 `syncGroupNature`，口径与 `scripts/synth-bind.mjs` 同一份）。
    //   不跟的话，人填完成员、组头还停在 `年份未知`、继续挂在「性质待补」里。
    if (applyNatureFields(node, fields, rec).length) syncGroupNature(draft, node);
    return node;
}

// ---- 更新 W/S/C 节点 ----
/**
 * @param {Object} draft
 * @param {string} id
 * @param {Object} fields
 * @param {Object} [opts] - 同 updateP：`{ manualFields }`
 */
export function updateWS(draft, id, fields, opts = {}) {
    // 只读边界（同 updateP）
    assertManualEditAllowed(draft, '修改比赛/系列/平台字段');

    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    if (!['W', 'S', 'C'].includes(node.type)) {
        throw new Error('不是 W/S/C 节点');
    }
    const rec = manualRecorder(draft, node, opts);
    // 时间戳先定稿：来源值的时间取的就是它（见 updateP 的同一处说明）
    node.lastModified = getNowStr();
    if (fields.name !== undefined) {
        if (!fields.name.trim()) throw new Error('名称不能为空');
        const before = node.name;
        node.name = fields.name.trim();
        rec('name', before, node.name);
    }
    // 跨渠道绑定（清空 = 解绑；这个字段没有类型限制，判据只有"非空且相等"）
    if (fields.ownerSynth !== undefined) {
        applyOwnerSynth(draft, node, fields.ownerSynth);
    }
    if (fields.link !== undefined) {
        const before = node.link;
        node.link = fields.link || '';
        rec('link', before, node.link);
    }
    // C 的种类（contest=真实比赛 / practice=练习容器）
    if (fields.kind !== undefined && node.type === 'C') {
        const k = String(fields.kind).trim();
        if (k !== 'contest' && k !== 'practice') {
            throw new Error('比赛种类只能是 contest 或 practice');
        }
        const before = node.kind;
        node.kind = k;
        rec('kind', before, node.kind);
    }
    if (fields.statusComplete2 !== undefined) {
        const sc = parseInt(fields.statusComplete2);
        if (isNaN(sc) || sc < 0 || sc > 4) throw new Error('完成状态必须为 0-4');

        // 同 status2：校验走"按当前范围的派生值"（4 = 忽略，是允许的覆盖）
        const autoVal = scopedDerivedAuto(draft, node, 'statusComplete2');
        if (sc !== 4 && sc !== autoVal) {
            throw new Error(`完成状态 不合法，按当前查看范围的自动计算为 ${autoVal}`);
        }
        node.statusComplete2 = sc;
        // 4 = "忽略"（属性表里声明的覆盖值）→ 记来源层；其它值 = 撤掉覆盖
        setDerivedOverride(node, 'statusComplete2', sc, {
            at: node.lastModified || getNowStr(),
            account: draft.currentAccountId
        });
    }
    if (node.type === 'C' && fields.contestTime !== undefined) {
        const raw = String(fields.contestTime).trim();
        const r = normalizeTime(raw);
        if (!r.valid) throw new Error(r.reason || '比赛时间格式无效');
        const before = node.contestTime;
        node.contestTime = r.isEmpty ? '' : r.value;
        rec('contestTime', before, node.contestTime);
    }
    // 「性质」四字段（可空；字段没传就不动）
    // ★ **改了性质就顺带跟一次组头**：组头的性质/键/名都是**成员派生**的
    //   （`core/ops/synth.js` 的 `syncGroupNature`，口径与 `scripts/synth-bind.mjs` 同一份）。
    //   不跟的话，人填完成员、组头还停在 `年份未知`、继续挂在「性质待补」里。
    if (applyNatureFields(node, fields, rec).length) syncGroupNature(draft, node);
    return node;
}

// ---- 更新通用字段（remark） ----
/**
 * 备注也是一个**元素**（属性表里 nature: note）。
 *
 * 两条规矩由属性决定、这里不特判：
 *   - `manual: true` → 手改留痕（进来源层，带当前登录账户）；
 *   - `importable: false` → 导入**永不写**它（题解是不可再生数据）。
 *
 * ⚠️ 直接 `target.remark = ...` 既不过只读守卫、也不留痕 ——
 * 备注的写入必须走这里。
 */
export function updateRemark(draft, id, remark, opts = {}) {
    assertManualEditAllowed(draft, '修改备注');

    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    const before = node.remark;
    node.remark = remark === undefined || remark === null ? '' : String(remark);
    recordManualValue(draft, node, 'remark', before, node.remark, opts);
    node.lastModified = getNowStr();
    return node;
}