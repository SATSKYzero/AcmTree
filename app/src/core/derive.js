// ================================================================
// 派生字段的"按范围计算"（core/derive.js）
//
// 背景（一句话）：**派生字段本身就是"按账户"的** ——
// `status2`（这题过没过）由子 R 节点的 `status` 推出，而 R 的 `status` 是带账户的
// （你导入的 QOJ 提交归在主号名下）。所以"我的补题情况"和"队友的补题情况"
// 本来就是两套 status2，而缓存字段只有**一份**。
//
// 本模块给出"按范围现算"的那一份：一张 `Map<节点id, {派生字段}>`，自底向上一次算完。
//
// `opts.group` —— **每层三趟**的"倒推覆盖"表
// ----------------------------------------------------------
//   - `opts.group` 是 `nodeId → { 字段: 值 }` 的**只读旁路表**（`core/groupCompute.js`
//     的 `working`）：不是节点字段、**绝不进来源层**（进去就会被当输入重新喂进聚合 ⇒ 震荡）；
//   - 它**只在两个地方生效**：
//       ① 容器把子 P 汇总成 `statusComplete1` / `statusComplete2` 时的取值
//          （= "倒推覆盖：成员原料能看到它所属组的组值"）；
//       ② `viewDerived(..., { column:'group' })` 读的**第二列**（组那份）。
//   - ⚠️ 它**不**改写任何节点"自己那份"派生值：若在 `read` 里让组值优先，
//     P 的 `status2` 就会被它所属组的组值覆盖 ⇒ "两列值"两列恒等、功能作废。
//     两列的前提就是"自己那份 ≠ 组那份"。
//   - 不给 `opts.group` ⇒ 行为一行都不变。
//
// **父节点的初值 ← 子树节点的终值**（第二趟，见 `buildDerivedTable` 末尾）
// ----------------------------------------------------------------------
//   容器（C/W/S）与 P 汇总的都是"子树里节点的值"，而那些值**必须是终值**：
//     · 树内子树：后序保证先算完 ⇒ 表里那一行就是终值；若给了 `opts.group`，
//       子 P 读的是它所属组的组值（判重下的终值）；
//     · **合成节点（组头）的"子树"是它的成员**（`ownerSynth` 指针，**不在 `childOrder` 里**）
//       —— 成员散在别的树下，后序保证不了它们先算完，所以组头一律**等全树算完再算**
//       （第二趟），读成员在表里的行（= 终值）。没有这一趟，组头恒为 0
//       （题亮了、比赛不亮）。
//
// 范围里的"值"怎么来
// ------------------
// 子节点的 `status` / `time` / P 的 `ratio` 一律走 `core/fieldValue.js` 的 `readField`
// （= 该范围内的投影值；一条来源值都没有的老数据自动退回缓存）。
// 于是"队友的提交不算我的"是自然结果，不需要在每个规则里写 if。
//
// 手动覆盖（"忽略这题" / "赛时通过"）
// ----------------------------------
// `status2 = 5`（忽略）、`statusComplete2 = 4`（忽略）这类是**用户按下的覆盖**，
// 不是算出来的（规则只会返回 0..4 / 0..3）。它们同样有归属：
//   来源层里 `src === 'manual'` 且账户在范围内的那条 = 本次范围的覆盖。
// **没有老数据**：不留"覆盖躺在缓存里"的回退路径（读路径不留回退兜底）。
//
// **所有派生字段都按范围算**，没有例外名单 —— `status1` 是"用户按下的覆盖"
// （走 `pinValues`），`statusComplete1` 由子树里**按范围算出来的** status1 聚合。
//
// 依赖：core/fieldValue.js（投影读取）、core/trust.js（范围）、utils/color.js（难度分档）。
// 说明：`buildDerivedTable` 是纯函数（只读 state + 返回表），可在 Node 单测里直接跑。
// ================================================================

import { readField, readFieldInfo } from './fieldValue.js';
import { resolveScope } from './trust.js';
// 覆盖（pin）的判据在 `core/pin.js`（**唯一一份**）—— 自动计算那条路也要用同一份
import { pinnedValue, effectivePin } from './pin.js';
import { computePxcpcDifficulty } from './autoComputeRules.js';
import { natureOf, ELEMENT_NATURE } from './model/elements.js';
import { TIME_PLACEHOLDER } from './model/constants.js';
// ★ AC 时间"怎么挑"的**唯一一份**（`earliest` / `latest` / `cutoff`）：本文件两处 + 写缓存那条路
//   + 组那份的聚合器都调它 —— 别再各写一遍"排序取 [0]"（设计稿 `docs/ac-time-rule.md`）。
import { pickAcTime, acTimeRuleOf, isSubmissionIgnored } from './acTimeRule.js';
// 合成节点的成员（指针关系）+ 组值的合并规则（**唯一一份**：`AGG_BUILDERS` + `mergeField`）
import { isSynthesis, synthKeyOf, ownerSynthOf, synthMembersTable, synthIndexOf } from './ops/synth.js';
import { groupAggregateOf } from './groupValue.js';
import { pStatus2, newProblemBuckets, addProblem, statusComplete2Of, SUBMIT_KIND_DURING } from './model/status.js';
// ⚠️ 本文件与 `query/countPass.js` 是**函数级循环依赖**：那边要用本文件的 `deriveP*`
//    （P 的本身值规则），本文件要用那边的"那一趟"结果建全量表。两边导出的都是**函数声明**
//    （会提升），且只在运行期互相调用 ⇒ ESM 下成立（模块求值期不碰对方的值）。
import { cache_countPassOf, clearCountCache } from './query/countCache.js';
import { runCountPass } from './query/countPass.js';

// ================================================================
// 单个节点的规则（都在"范围内"算）
// ================================================================

// 覆盖（pin）的取值在 `core/pin.js` —— 这里只做"本次范围"这一层：
// `pinnedValue` / `effectivePin` 是**唯一实现**，自动计算（`computePstatus2`）也调它。

/**
 * P.acTime：按**设置里那条规则**（`settings.acTimeRule`）从范围内 R 子节点的 AC 时间里挑一条。
 *
 * ⚠️ 规则与挑选**只有一份**：`core/acTimeRule.js` 的 `pickAcTime` / `acTimeRuleOf` ——
 *    本函数、同文件的 `derivePtriple`、以及 `core/autoComputeRules.js:computePacTime`
 *    与组那份的 `AGG_BUILDERS.acTime` 都调它（以前四家各写一遍"排序取 [0]"）。
 *    默认 `'earliest'` ⇒ `sort()[0]` 的**逐字等价物**（老行为一字不变）。
 */
export function derivePacTime(state, node, read) {
    const rule = acTimeRuleOf(state.settings);
    const acTimes = [];
    for (const cid of state.childOrder[node.id] || []) {
        const child = state.nodes[cid];
        if (!child || child.type !== 'R') continue;
        if (read(child, 'status') !== 'AC') continue;
        const time = read(child, 'time');
        if (!time || time === TIME_PLACEHOLDER) continue;
        // ★ 第 4 种规则：**截断前的提交整体不算**（`cutoffIgnore`；别的规则下这一句是常数开销）
        if (isSubmissionIgnored(time, rule)) continue;
        acTimes.push(String(time));
    }
    return pickAcTime(acTimes, rule, TIME_PLACEHOLDER);
}

/** P.lastSubmitTime：范围内 R 子节点里最晚的提交时间 */
export function derivePlastSubmitTime(state, node, read) {
    let latest = '';
    for (const cid of state.childOrder[node.id] || []) {
        const child = state.nodes[cid];
        if (!child || child.type !== 'R') continue;
        const time = read(child, 'time');
        if (time && time !== TIME_PLACEHOLDER && (latest === '' || String(time) > latest)) {
            latest = String(time);
        }
    }
    return latest || TIME_PLACEHOLDER;
}

/**
 * **一趟算齐 P 的三格**（`status2` / `acTime` / `lastSubmitTime`）。
 *
 * 为什么：上面那三个规则各自都要把**同一个子 R 列表**走一遍（`derivePacTime` 还额外建了个数组）。
 * 真包 P 有 15390 个 ⇒ 三趟变一趟（那一趟的 `own` 相实测能省 ~20~40ms）。
 *
 * ⚠️ 判据**逐字照抄**上面三个函数，只合并循环、不改任何一条：
 *   · `status2`：`status` 读得到才算提交；`AC` 才算通过；`submitKind` **只在 AC 时**读；
 *   · `acTime`：AC 子节点里**最早**的 `time`（不是占位符才算），没有 ⇒ `TIME_PLACEHOLDER`；
 *   · `lastSubmitTime`：**所有** R 子节点里最晚的 `time`（不看 status），没有 ⇒ `TIME_PLACEHOLDER`。
 */
export function derivePtriple(state, node, read, pin) {
    const p = typeof pin === 'function' ? pin() : pin;
    const rule = acTimeRuleOf(state.settings);
    let hasSub = false;
    let hasAC = false;
    let hasDuringAC = false;
    const acTimes = [];               // AC 时间候选（挑法交给 `pickAcTime`，别在这儿又写一套）
    let latest = '';                  // 最晚的提交时间
    for (const cid of state.childOrder[node.id] || []) {
        const child = state.nodes[cid];
        if (!child || child.type !== 'R') continue;
        const status = read(child, 'status');
        const time = read(child, 'time');
        // ★ 第 4 种规则（`cutoffIgnore`）：**被忽略的提交整个不算** ——
        //   不算提交（`hasSub`）、不算 AC（`hasAC`）、不进 `lastSubmitTime`。
        //   用户原话："题目的 Ac时间/最新提交/stat2 要按条件判断（提交是否忽略）每个提交是否取"。
        if (isSubmissionIgnored(time, rule)) continue;
        if (status !== undefined && status !== null && status !== '') {
            hasSub = true;
            if (status === 'AC') {
                hasAC = true;
                if (read(child, 'submitKind') === SUBMIT_KIND_DURING) hasDuringAC = true;
                if (time && time !== TIME_PLACEHOLDER) acTimes.push(String(time));
            }
        }
        if (time && time !== TIME_PLACEHOLDER) {
            const t = String(time);
            if (latest === '' || t > latest) latest = t;
        }
    }
    return {
        status2: pStatus2(hasSub, hasAC, Number(p), hasDuringAC),
        acTime: pickAcTime(acTimes, rule, TIME_PLACEHOLDER),
        lastSubmitTime: latest || TIME_PLACEHOLDER
    };
}

/**
 * P.status2：**范围内**有没有 AC / 有没有提交，外加本次范围的"忽略"覆盖。
 *
 * ⚠️ "有提交"必须以**这个范围内的值**为准（做多账户对比时抓到的真问题）：
 *    R 子节点可能是别人提交的 —— 在队友的口径下，他那条 status 读出来是空。
 *    只按"存在一个 R 子节点"判 `hasSub = true` 的话，"只有你提交过"的题
 *    在队友那一列会显示成「已提交未通过」—— 明明他碰都没碰。
 *    判据：**读得到的 status 才算这个人的提交**（`'-'` 仍算提交，
 *    它表示"提交了但没判/没结果"，是合法值）。
 */
export function derivePstatus2(state, node, read, pin) {
    const p = typeof pin === 'function' ? pin() : pin;

    let hasSub = false;
    let hasAC = false;
    let hasDuringAC = false;
    for (const cid of state.childOrder[node.id] || []) {
        const child = state.nodes[cid];
        if (!child || child.type !== 'R') continue;
        const status = read(child, 'status');
        if (status === undefined || status === null || status === '') continue;  // 不是这个范围内的提交
        hasSub = true;
        if (status === 'AC') {
            hasAC = true;
            // `submitKind` 也走 read()（与 status 同口径 —— 别的账户的那条读出来是空）
            if (read(child, 'submitKind') === SUBMIT_KIND_DURING) hasDuringAC = true;
        }
    }
    // 覆盖值来自来源层投影（字符串），先归一成数字再交给共用规则
    return pStatus2(hasSub, hasAC, Number(p), hasDuringAC);
}

/**
 * P.xcpcDifficulty：完全由**范围内**的 ratio 派生。
 *
 * **算法本体只有一份**（`autoComputeRules.computePxcpcDifficulty`）——
 * 不要在两边各抄一遍，改一处忘一处就会"树上显示 3、统计按 4 算"。
 * 这里只负责"取值口径"（拿范围内投影出来的 ratio）。
 */
export function derivePxcpcDifficulty(ratio) {
    return computePxcpcDifficulty(null, { ratio });
}

/**
 * P.status1（"我处理了吗"）：本次范围里用户按下的那条覆盖。
 *
 * 它**没有计算规则** —— 值不是算出来的，是用户输入的（`0` 未处理 / `1` 已处理）。
 * 所以这里只做一件事：把范围内的覆盖取出来（来源层 `manual` + 账户过滤），
 * 取不到就是"没有覆盖"（**没有"退回缓存"的兜底** —— 读路径不留回退兜底）。
 * **与 `status2` 的覆盖共用同一套机器。**
 *
 * @param {Object} scope - `resolveScope` 的结果（`Set<string>` 或 null）
 */
export function derivePstatus1(node, scope) {
    return String(effectivePin(node, 'status1', scope)) === '1' ? 1 : 0;
}

/**
 * 容器 statusComplete1：范围内子树里 P 的 status1 **全为 1** 时才是 1。
 *
 * 口径与 `autoComputeRules.computeContainerStatusComplete1`（写进缓存的那份）逐字相同，
 * 区别只有一个：取值用**按范围算出来的** `status1Of`，而不是缓存。
 *
 * @param {Function} status1Of - `(pNode) => number`
 */

/**
 * 容器 statusComplete2：范围内子树里 P 的 status2 / status1 聚合。
 *
 * @param {Function} status2Of - `(pNode) => number`（取**按范围算出来**的那个 status2）
 * @param {number|null} pin - 本次范围的"忽略"覆盖（4）
 */
/**
 * 两格**一趟走完**（`statusComplete1` + `statusComplete2`）—— 给整表构建用。
 *
 * 为什么要合并：上面那两个函数各自都要把**同一棵子树**走一遍，而 `computeOwnRow`
 * 对**每个容器**都要这两格 ⇒ 同一棵树被走两遍。真包 27k 实测：46.6ms + 59.8ms
 * （1990 个容器 ⇒ 约 12.5 万次节点访问）——**不是遍历慢，是走重了**。
 *
 * ⚠️ 口径与那两个函数**逐字相同**：只数 `type === 'P'`、取值一律走 `status1Of`/`status2Of`、
 *    `pin === '4'` 时第二格短路成 4（但第一格照样要数）。那两个函数**保留**，
 *    单点调用（测试、别处）继续用它们。
 */
export function containerAggregates(state, node, status1Of, status2Of, pin2) {
    const skip2 = String(pin2) === '4';
    const b = newProblemBuckets();
    let allProcessed = true;
    let hasP = false;
    (function walk(nid) {
        const n = state.nodes[nid];
        if (!n) return;
        if (n.type === 'P') {
            hasP = true;
            const s1 = status1Of(n);
            if (Number(s1) !== 1) allProcessed = false;
            if (!skip2) addProblem(b, s1, status2Of(n));
        }
        for (const cid of state.childOrder[nid] || []) walk(cid);
    })(node.id);
    return {
        complete1: hasP ? (allProcessed ? 1 : 0) : 0,
        complete2: skip2 ? 4 : statusComplete2Of(b)
    };
}

export function deriveContainerStatusComplete2(state, node, status1Of, status2Of, pin) {
    if (String(pin) === '4') return 4;

    const b = newProblemBuckets();
    (function walk(nid) {
        const n = state.nodes[nid];
        if (!n) return;
        if (n.type === 'P') addProblem(b, status1Of(n), status2Of(n));
        for (const cid of state.childOrder[nid] || []) walk(cid);
    })(node.id);

    return statusComplete2Of(b);
}

// ================================================================
// 整棵树的表
// ================================================================

/**
 * 自底向上算出一棵树上所有节点的派生字段（**只读 state**）。
 *
 * @param {Object} state - `{ rootId, nodes, childOrder, accounts, trust }`
 * @param {Object} [opts] - 范围：`{ viewingAccount | scopeAccounts, accounts }`
 *        + `{ group }` = **每层三趟的倒推覆盖表**（`nodeId → {字段:值}`，只读旁路；
 *          来源层投影为空时组值胜出 —— 详见文件头。不给它 ⇒ 行为不变）。
 * @returns {Map<string, Object>} 节点 id → 派生字段
 */
export function buildDerivedTable(state, opts = {}) {
    const table = new Map();
    if (!state || !state.nodes || !state.rootId) return table;
    // `trust` / `accounts` 缺省从 state 取 —— 调用方只想说"范围"时不必重复传这两样。
    // （不这么做的话，漏传 trust 会让投影按默认可信度算：榜单/脚本变成同级，
    //   难度档会悄悄算错 —— 单测逮到过。）
    const full = {
        viewingAccount: opts.viewingAccount,
        scopeAccounts: opts.scopeAccounts,
        accounts: opts.accounts !== undefined ? opts.accounts : state.accounts,
        trust: opts.trust !== undefined ? opts.trust : state.trust
    };
    const scope = resolveScope(full);
    // 倒推覆盖（组那份）。没有它 ⇒ 本函数行为不变。
    const group = (opts.group && typeof opts.group.get === 'function') ? opts.group : null;
    // ★ 增量：`{ prev, recompute }` —— `recompute` 之外的行走"复用上一次的表"那条路
    //   （只有 `derivedTable` 会传它；直接调本函数 = 整份重算，语义不变）
    const inc = (opts.incremental && opts.incremental.prev instanceof Map
        && opts.incremental.recompute instanceof Set) ? opts.incremental : null;

    /** 这个类型有没有"组头那一格"（P 是 `status2`，容器是那两格）；没成员时不动它 */
    const headFields = (type) => (type === 'P'
        ? ['status2']
        : ((type === 'C' || type === 'W' || type === 'S')
            ? ['statusComplete1', 'statusComplete2'] : null));

    // ================================================================
    // ★ 增量：**要折的组头，先在"这一代"把它"自己那份"重算出来**（加进 `recompute`）。
    //
    //   为什么必须：上一代那一行里躺的是**已经折过组值**的结果（`computeHeadRow` 就地在行上
    //   改写；全量那条路也一样 —— 计数那一趟会把组值**回代**到组头那一格）。增量复用这一行
    //   再拿它当 A ⇒ 组值**只涨不落**：成员从 AC 退回 WA，组头还是 AC（实测：
    //   真值 `status2=2`，增量给 `3`；改动前的老代码同一条路也一样错）。
    //   加进 `recompute` ⇒ 下面那趟后序会像别的节点一样把它算一遍，A 回到"自己那份"。
    //   ⚠️ 必须在**那趟后序之前**加（后序按 `recompute` 决定谁重算、谁复用）。
    //   ⚠️ 组头的祖先不用在这里加：它折完若真的变了，下面那段 `dirty` 会上推（原有机制）。
    // ================================================================
    if (inc) {
        for (const id of (inc.heads || Object.keys(state.nodes))) {
            const node = state.nodes[id];
            if (node && isSynthesis(node) && headFields(node.type)) inc.recompute.add(id);
        }
    }

    // ================================================================
    // ★ **全量那条路**（没有覆盖表、也不走增量）⇒ 直接拿**计数那一趟**的整行。
    //
    //   为什么：那一趟（`core/query/countPass.js`）本来就一次算出"本身值 + P 桶 + C 桶 +
    //   📊分布"，而且是一代只算一次（缓存在 `countCache.js`，与计数那边**共用同一个实例**）
    //   ⇒ 全量建表不必再自己后序走一遍、也不必再做"组头第二趟 + 祖先重算"。
    //   ⚠️ 走 `cache_countPassOf` 而不是直接调 `runCountPass`：否则同一代里
    //      "建表"与"取计数"会各跑一趟（实测每趟 ~119ms，白白翻倍）。
    //   ⚠️ 只接**全量**这一条：带 `opts.group`（dedup 的倒推覆盖）与 `opts.incremental`
    //      （单点增量，第二阶段的东西）仍旧走下面原来的实现，行为一个字不变。
    // ================================================================
    if (!group && !inc) {
        // ⚠️ `opts.fresh` = **必须现算**那一趟，别用共享的那份。
        //    谁会这么调：`core/ops/node.js` 的 `scopedDerived` —— 它先把本节点的覆盖
        //    （`node.values[field]` + 缓存字段）**就地**摘掉，再建一次表拿"不带覆盖的自动值"。
        //    那种"就地摘"换不动 `nodes` 引用 ⇒ 缓存的代看不出来 ⇒ 复用缓存会把"带覆盖的值"
        //    当成自动值（实测：撤 pin 时校验判"自动计算为 5"，事务直接失败）。
        const pass = opts.fresh ? runCountPass(state, full) : cache_countPassOf(state, full);
        for (const id in state.nodes) {
            if (!state.nodes[id]) continue;
            table.set(id, pass.rowOf(id));
        }
        return table;
    }

    // ================================================================
    // ★ **带倒推覆盖那张表**（`opts.group`）也从那一趟来 —— 它要的就是 **dedup 口径**的整行。
    //
    //   为什么成立：覆盖表的全部作用就是"容器汇总子 P 时取**组那份**"，而那一趟的
    //   `cntAll` 本来就是"每个 P 用它所属组的值" ⇒ 容器两格算出来就是同一份东西
    //   （`status1Of`/`status2Of` 组优先那条路，一字不差）。真包对拍：**80930 格 0 不一致**。
    //
    //   ⚠️ 口径**显式写 `dedup`**，不看当前计数模式：`opts.group` 的语义就是"每个 P 用组那份"。
    //   ⚠️ 与上面那条一样走 `cache_countPassOf`：同一代里 plain 那份**各留各的**
    //      （`countCache` 按口径各一个槽）。`groupCompute.js` 那边要的也是这一份
    //      ⇒ 显示侧"组表 + 组值"共用**同一趟**（这才是接它的意义）。
    // ================================================================
    if (group && !inc) {
        const pass = cache_countPassOf(state, { ...full, mode: 'dedup' });
        for (const id in state.nodes) {
            if (!state.nodes[id]) continue;
            table.set(id, pass.rowOf(id));
        }
        return table;
    }

    /**
     * 本范围内的值 —— **读别人的字段**走这里（子 R 的 status/time、自己的 ratio…）。
     *
     * ⚠️ 这里**不能**插"组值优先"：倒推覆盖表里的
     * `status1` / `status2` 是"这一组的组值"，如果让它们在这里胜出，那么
     *   ① P 的**自己那份** `status2` 就会被它所属组的组值改写 ——
     *      而"两列值"的整个前提就是"自己那份 ≠ 组那份"；改完两列恒等，功能作废；
     *   ② 属性表里 `status2` 的覆盖语义（手改"忽略"）会被绕过。
     * 所以组值**既不进 `read`、也不写进表里的自己那份**，只在两个地方生效：
     *   · `viewDerived(..., { column:'group' })` 读的那一列（`core/groupCompute.js`）；
     *   · 容器把子 P 汇总成 `statusComplete1/2` 时的**取值**（下面的 `status1Of`/`status2Of`）
     *     —— 那正是"倒推覆盖：成员原料能看到它所属组的组值"要的东西。
     */
    const read = (node, field) => readField(node, field, full);

    // ⚠️ 必须读**表里已经算好的**（自底向上遍历保证子树先算完）。
    //    不能直接取缓存（`n.status1`）—— 那会漏掉"按范围算"这一层，
    //    容器 statusComplete1 也跟着错。
    //
    // 容器汇总子 P 时，**组那份优先**（倒推覆盖）—— "成员原料能看到它所属组的
    // 组值"就落在这一处。不给 `opts.group` ⇒ 行为不变。
    const groupField = (n, field) => {
        if (!group) return undefined;
        const row = group.get(n.id);
        return row ? row[field] : undefined;
    };
    const status1Of = (n) => {
        const g = groupField(n, 'status1');
        if (g !== undefined) return g;
        const d = table.get(n.id);
        return (d && d.status1 !== undefined) ? d.status1 : n.status1;
    };
    const status2Of = (n) => {
        const g = groupField(n, 'status2');
        if (g !== undefined) return g;
        return (table.get(n.id) || {}).status2; // 表里已算好的（自底向上）
    };

    /**
     * 算一个节点**自己那份**（只看它自己的树内子树；后序保证子树先算完）。
     *
     * 容器汇总子 P 时的取值走 `status1Of` / `status2Of` —— 它们**组那份优先**
     * （有 `opts.group` 时）＝"成员原料能看到它所属组的组值"。
     */
    const computeOwnRow = (node) => {
        const pinned = (field) => effectivePin(node, field, scope);
        const d = {};
        if (node.type === 'P') {
            d.acTime = derivePacTime(state, node, read);
            d.lastSubmitTime = derivePlastSubmitTime(state, node, read);
            d.status2 = derivePstatus2(state, node, read, () => pinned('status2'));
            d.xcpcDifficulty = derivePxcpcDifficulty(read(node, 'ratio'));
            // "我处理了吗"（用户输入，不是算出来的）—— 和 status2 的覆盖同一套取值
            d.status1 = derivePstatus1(node, scope);
        }
        if (node.type === 'C' || node.type === 'W' || node.type === 'S') {
            // ⚠️ 只给容器算 statusComplete2 —— 与规则表一致
            //    （`TYPE_AUTO_PROPS` 里 P 没有这一项；给 P 也算会凭空多出一个
            //     "值"，读的人从 undefined 变成数字，属于行为变化）
            // ★ 两格**一趟走完**（见 `containerAggregates`：这两个数各自都要遍历整棵子树）
            const agg = containerAggregates(state, node, status1Of, status2Of, pinned('statusComplete2'));
            d.statusComplete2 = agg.complete2;
            d.statusComplete1 = agg.complete1;
        }
        return d;
    };

    (function walk(id) {
        const node = state.nodes[id];
        if (!node) return;
        for (const cid of state.childOrder[id] || []) walk(cid);

        // ★ 增量：这一行不用重算 ⇒ 直接复用上一次的表（见 `derivedTable` 的说明）
        if (inc && !inc.recompute.has(id)) {
            const row = inc.prev.get(id);
            if (row !== undefined) { table.set(id, row); return; }
        }

        table.set(id, computeOwnRow(node));
    })(state.rootId);

    // ================================================================
    // 第二趟：合成节点（组头）的**子树 = 它的成员**
    //
    // 成员是**指针**关系（`ownerSynth` → `synthKey`），**不在 `childOrder` 里**：
    //   · 组头在树里是独立一枝（真包实测：`synth:xcpc:2026ec_pre2` 的成员是 qoj / pta /
    //     rankland / srk 各自的 C），后序**保证不了**成员先算完 ⇒ 组头的值只能在
    //     **全树算完之后**再算；
    //   · 这就是"计算父节点的初值时，子树中节点的值要用**终值**"——终值 = 这张表里
    //     已经算好的那一行（不是成员的初值、更不是缓存）。
    //   · 没有这一步，组头恒为"没有子树 ⇒ 0"（题亮了、比赛不亮）。
    //
    // 规则**不另写**：A（组头树内子树那份）⊗ B（成员各自那份）走 `core/groupValue.js`
    // 的 `groupAggregateOf` —— 与"组那份"同一份 `AGG_BUILDERS` + `mergeField`。
    // 头动了 ⇒ 它树内的祖先也要跟着重算（容器汇总子树时会读到它）。
    // ================================================================
    // ⚠️ `headFields` 在上面（增量那段之前）声明 —— 见"要折的组头先重算自己那份"。
    let membersTable = null;
    /** 组头那一行 = A（自己那份，表里那一行）⊗ B（成员各自那份，也从表里读 ⇒ 终值） */
    const computeHeadRow = (node) => {
        const d = table.get(node.id);
        if (!d) return;
        if (membersTable === null) membersTable = synthMembersTable(state);
        const memberIds = membersTable.get(synthKeyOf(node)) || [];
        if (!memberIds.length) return;                      // 没成员 ⇒ 组值 ≡ 自己那份，不动
        for (const field of headFields(node.type)) {
            const v = groupAggregateOf(state, {
                headId: node.id,
                memberIds,
                field,
                readOf: (n, f) => {
                    const row = table.get(n.id);
                    return (row && row[f] !== undefined) ? row[f] : n[f];
                }
            });
            if (v === undefined || v === null) continue;
            d[field] = v;
        }
    };

    // ⚠️ 祖先重算**必须去重**：同一个父容器可能是几百个组头的祖先，逐个重算就是
    //    O(#组头 × 子树)（实测 28k 节点 / 5000 组会从 272ms 涨到 15s）。这里先收集成
    //    集合，再按**深度降序**（= 子先父后）各重算一遍 ⇒ 每个节点最多算一次。
    const dirty = new Set();
    const parentOf = state.parentOf || {};
    // ★ **增量那条路只折"成员动过的"那些组头**（`inc.heads`，由 `derivedTable` 按写路径交来的
    //   名单算好）：不变的那些组头，它的行原样复用上一代那张表，里面的组值本来就是对的。
    //   ⚠️ 认不出来（没有名单 / 组划分动过 / 直接调本函数）⇒ `heads` 为 `null` ⇒ 照旧**全部走一遍**
    //      （那是变更前的行为，一个字没改）。
    const headIds = (inc && inc.heads) ? inc.heads : null;
    for (const id of (headIds || Object.keys(state.nodes))) {
        const node = state.nodes[id];
        if (!node || !isSynthesis(node) || !headFields(node.type) || !table.has(id)) continue;
        const row = table.get(id);
        const snapshot = { ...row };
        computeHeadRow(node);
        // 值没动 ⇒ 不用往上传播
        if (headFields(node.type).every(f => snapshot[f] === row[f])) continue;
        let pid = parentOf[id];
        let guard = 0;
        while (pid && !dirty.has(pid) && guard++ < 5000) {
            dirty.add(pid);
            pid = parentOf[pid];
        }
    }
    if (dirty.size) {
        const depthOf = (id) => {
            let d = 0; let pid = parentOf[id]; let guard = 0;
            while (pid && guard++ < 5000) { d++; pid = parentOf[pid]; }
            return d;
        };
        const order = [...dirty].map(id => [id, depthOf(id)]).sort((a, b) => b[1] - a[1]);
        for (const [id] of order) {
            const node = state.nodes[id];
            if (!node || !table.has(id)) continue;
            // 祖先自己也是合成节点（坏数据/嵌套）⇒ 仍走组头那条路（别把它打回自己那份）
            if (isSynthesis(node) && headFields(node.type)) computeHeadRow(node);
            else table.set(id, computeOwnRow(node));
        }
    }

    return table;
}

// ================================================================
// 记忆化（渲染里会被调上万次）
//
// **一个槽**（与 110 一致）：键里含范围与 `opts.group`，换了就重算/走增量。
// ⚠️ 折叠/翻页**不会**换 `nodes`（视图态在 `state.view`）⇒ 那些操作一格都不重算。
// ================================================================

// ================================================================
// ★ **写路径把"这次碰过哪些 id"交过来**（`noteValueDelta`）
//
// 为什么：`nodes` 引用一换，这里就得知道"哪些行的值可能变了"。原来只有一条路 ——
//   **扫全表按引用比**（真包 27k 实测 ~11ms/次），而写路径**本来就算过这份名单**
//   （`transaction/executor.js` 补冻节点用的就是它；那份名单在 `dirtyFlags.changedNodeIdsOf`，
//   唯一判据）⇒ 白扫第二遍。
//
// ⚠️ **只认"两代都对得上"的那一份**（交过来的 `prevNodes` / `nextNodes` 正好是记忆化里
//    在用的那两代）。对不上（撤回、整包导入、测试里直接换 state、连着两次改动中间没读过）
//    ⇒ 老老实实扫一遍 —— 行为与以前**逐字相同**。所以这一手省的是"恰好对得上"那种最常见的路。
// ⚠️ `groupingChanged`（组划分动过没动过）也得一起交过来：动过就**不敢**只折受影响的那些组头
//    （旧组头少了成员这件事，从"新 state 的指针"里读不出来）。
// ================================================================
let notedDelta = null;

/**
 * 记下"这次碰过哪些节点"（写路径调用；读路径在 `derivedTable` 里取用）。
 *
 * @param {Object} prevNodes - 改动前的 `state.nodes`
 * @param {Object} nextNodes - 改动后的 `state.nodes`
 * @param {string[]} ids - 引用变了的节点 id（由 `changedNodeIdsOf` 给出）
 * @param {boolean} groupingChanged - 这次有没有动过 `ownerSynth` / `synthKey`
 */
export function noteValueDelta(prevNodes, nextNodes, ids, groupingChanged = false) {
    notedDelta = (Array.isArray(ids) && prevNodes && nextNodes)
        ? { prevNodes, nextNodes, ids, groupingChanged: !!groupingChanged }
        : null;
}

/** 交过来的名单与这两代对得上吗（对不上 ⇒ 返回 null，调用方自己扫） */
function notedDeltaOf(prevNodes, nextNodes) {
    if (!notedDelta) return null;
    return (notedDelta.prevNodes === prevNodes && notedDelta.nextNodes === nextNodes)
        ? notedDelta : null;
}

let memo = null;

/** 范围键（用于判断"同一份表能不能复用"） */
function scopeKey(state, opts) {
    const scope = resolveScope({
        viewingAccount: opts.viewingAccount,
        scopeAccounts: opts.scopeAccounts,
        // ★ `accounts` + `settings` 也要给：`viewingAccount` 那一支的展开（要不要带直接子账户）
        //   要靠它们算出来（`v9.1.23`）—— 少给一项，键与实际读用的范围就会**不是同一个**，
        //   两张不同口径的表会互相顶掉（症状：改了设置没反应 / 数值对不上）。
        accounts: opts.accounts === undefined ? state.accounts : opts.accounts,
        settings: state.settings
    });
    const trustKey = (opts.trust === undefined ? state.trust : opts.trust) ? 'T' : '-';
    // ★ **AC 时间规则也是这张表的口径**（`v9.1.21`）：它决定 P 的 `acTime` 算成哪条，
    //   所以必须进键 —— 不然改了设置还复用旧表（症状：改了没反应）。
    //   ⚠️ 它**只影响 `acTime` 那一格**，但它进了键 ⇒ 改一次整份重算；
    //      这里换来的是"改了就一定对"（这张表本来也是按引用/范围整体失效的）。
    const ac = acTimeRuleOf(state.settings);
    return (scope === null ? '*' : [...scope].sort().join(',')) + '|' + trustKey + '|A' + ac.rule + ':' + ac.cutoff;
}

/**
 * 取整棵树的派生表（按 `nodes` 引用 + 范围记忆化）。
 *
 * 失效条件（任一变化就重算/走增量）：
 *   - `state.nodes` 引用变了（Immer 结构共享：**数据**改动才会换它；折叠/翻页不会 ——
 *     视图态住在 `state.view`，见 `core/model/viewState.js`）
 *   - `state.childOrder` 引用变了（结构改动）
 *   - 范围变了 / 账户表引用变了 / trust 变了
 *   - `opts.group`（倒推覆盖表）换了 —— 它是**旁路输入**，不比它就会拿上一层算的表
 *
 * 代价：一次 O(N) 后序遍历；换来"同一屏可以并存多套口径"（同一时刻一个槽）。
 */
export function derivedTable(state, opts = {}) {
    if (!state || !state.nodes) return new Map();
    const key = scopeKey(state, opts);
    const group = opts.group || null;
    const trust = opts.trust === undefined ? state.trust : opts.trust;
    const hit = memo;
    if (hit && hit.nodes === state.nodes && hit.childOrder === state.childOrder
        && hit.key === key && hit.accounts === state.accounts
        && hit.group === group && hit.trust === trust) {
        return hit.table;
    }
    // ★「把开销挪到初始化」：别的什么都没变、**只有 `nodes` 换了引用**时，
    //   走**增量**（复用上一次的表，只重算"变了的节点 + 它们的祖先"）。
    //   为什么贵：整份重算是 O(N) 后序遍历（真包 27k 节点实测 **~107ms**），而一次操作
    //   通常只动一两个节点 ⇒ 那 100ms 是白付的。
    //   ⚠️ **结构一变就整份重算**（2026-10-18 实测过一次"改成 append-only 走增量"：
    //      真包 27k 上「新建一道题」**346ms → 407ms**，反而更慢 ⇒ 按"没量出结果的优化一律不留"回滚）。
    //      原因没查透（多出来的是增量路径自己的开销），下次想动请先打点。
    if (hit && hit.childOrder === state.childOrder && hit.key === key
        && hit.accounts === state.accounts && hit.group === group && hit.trust === trust
        && hit.nodes !== state.nodes) {
        // ★ 名单优先用写路径交过来的那一份（`noteValueDelta`，两代对得上才认）；
        //   没有 / 对不上 ⇒ 自己扫全表（`affectedIds`）——**两条路挑组头的判据是同一份**
        //   （下面 `affectedHeads`）：所以单测跑到的就是应用跑的那条。
        const noted = notedDeltaOf(hit.nodes, state.nodes);
        const recompute = noted
            ? expandAffected(state, new Set(noted.ids))
            : affectedIds(state, hit.nodes);
        if (recompute) {
            // 组划分动没动过：写路径交过来就用它的；没有名单（自己扫那条路）就**现比**这一趟
            // 认出来的改动节点（`ownerSynth` / `synthKey`），判据与写路径那份同形。
            const groupingChanged = noted
                ? noted.groupingChanged
                : groupingChangedOf(state, hit.nodes, recompute);
            const table = buildDerivedTable(state, {
                ...opts,
                incremental: {
                    prev: hit.table,
                    recompute,
                    // ★ 只折受影响的那些组头（组划分动过 ⇒ `null` = 全部）
                    heads: affectedHeads(state, recompute, groupingChanged)
                }
            });
            memo = { nodes: state.nodes, childOrder: state.childOrder, key, accounts: state.accounts,
                trust, group, table };
            return table;
        }
    }
    const table = buildDerivedTable(state, opts);
    memo = {
        nodes: state.nodes, childOrder: state.childOrder, key,
        accounts: state.accounts,
        trust,
        group,
        table
    };
    return table;
}

//: 增量重算的规模上限（超过就整份重算 —— 别为了省而把复杂度留在原地）
const INCREMENTAL_MAX = 4000;

/**
 * 这次 `nodes` 里"要重算哪些节点"：**引用变了的**那些 + 它们的**全部祖先**
 * （容器要把子 P 汇总成 `statusComplete1/2` ⇒ 子变了，父也得重算）。
 *
 * ⚠️ 写路径交过来名单时走 `expandAffected`（跳过上面那趟扫描），语义**逐字相同**。
 *
 * @returns {Set<string>|null} `null` = 变化太大 / 认不出来 ⇒ 调用方整份重算
 */
function affectedIds(state, prevNodes) {
    const nodes = state.nodes;
    const out = new Set();
    // ⚠️ 只比**引用**（Immer 结构共享：没动的节点引用不变）—— 一趟 27k 次比较 ≈ 几毫秒
    for (const id in nodes) {
        if (prevNodes[id] !== nodes[id]) {
            out.add(id);
            if (out.size > INCREMENTAL_MAX) return null;
        }
    }
    for (const id in prevNodes) {
        if (!(id in nodes)) { out.add(id); if (out.size > INCREMENTAL_MAX) return null; }
    }
    return expandAffected(state, out);
}

/**
 * "变了的那些" + **全部祖先**（上面那一趟扫描的共用后半段）。
 *
 * @param {Set<string>} out - 改动的节点 id（**会被就地扩充**）
 * @returns {Set<string>|null} `null` = 变化面太大 ⇒ 调用方整份重算
 */
function expandAffected(state, out) {
    if (out.size > INCREMENTAL_MAX) return null;
    if (!out.size) return out;
    // 祖先：用 `parentOf` 往上走（深度通常是 5 上下）
    const parentOf = state.parentOf || {};
    for (const id of [...out]) {
        let p = parentOf[id];
        let guard = 0;
        while (p && guard++ < 5000) {
            if (out.has(p)) break;                 // 已经在里面 ⇒ 它的祖先也早加过了
            out.add(p);
            if (out.size > INCREMENTAL_MAX) return null;
            p = parentOf[p];
        }
    }
    return out;
}

/**
 * 这次改动**动过组划分没有**（`ownerSynth` / `synthKey` 变了）。
 *
 * 写路径（`transaction/executor.js`）本来就判过一次并交过来（`noteValueDelta` 的第 4 个参数）；
 * 这条是**没有名单**（自己扫全表）那条路的等价判据 —— 判据同形，只是从两代 `nodes` 现比。
 *
 * ⚠️ 保守：认不出来（某个 id 在这一代或上一代里没有）也算"动过" ⇒ 组头全折一遍。
 *
 * @param {Object} state
 * @param {Object} prevNodes - 上一代的 `nodes`
 * @param {Set<string>} ids - 改动名单
 * @returns {boolean}
 */
function groupingChangedOf(state, prevNodes, ids) {
    const nodes = state.nodes || {};
    const prev = prevNodes || {};
    for (const id of ids) {
        const b = prev[id];
        const a = nodes[id];
        if (!b || !a) return true;
        if ((b.ownerSynth || '') !== (a.ownerSynth || '')
            || (b.synthKey || '') !== (a.synthKey || '')) return true;
    }
    return false;
}

/**
 * 增量那条路：**哪些组头需要重折**（`heads` 名单）。
 *
 * 判据：组头的行只可能因为两件事变 —— ① 它**自己**在改动名单里；② 它的**成员**在改动名单里。
 *   · 成员关系是**指针**（成员身上的 `ownerSynth` → 组头的 `synthKey`），所以从名单里的每个
 *     节点出发：**它自己是组头**（被直接改了）或**它的 `ownerSynth` 指着的那个组头**（成员动了）；
 *   · 组头自己又可能是别人的成员（嵌套，坏数据）⇒ 闭包往上再走一层。
 *
 * ⚠️ `groupingChanged`（这次动过 `ownerSynth` / `synthKey`）⇒ **返回 `null`（= 全部走一遍）**：
 *    "某个组头**少了**一个成员"这件事，从新的指针里读不出来（成员现在指别处了 / 什么都不指了）
 *    ⇒ 挑名单就可能漏掉那个组头，**静默错数**。宁可整趟重折。
 * ⚠️ 名单里的组头若**没有成员** ⇒ `computeHeadRow` 自己就早退（组值 ≡ 自己那份），多列一个无害。
 *
 * @returns {Set<string>|null} `null` = 认不出来 ⇒ 全部组头
 */
function affectedHeads(state, recompute, groupingChanged) {
    if (groupingChanged) return null;
    // ★ **先看名单里有没有"跟组合有关"的节点**（每个节点常数时间）：一个都没有 ⇒
    //   **一个组头都不用折**，也不必去建"标识 → 组头"那张索引。
    //   ⚠️ 这一句是必须的：真包 27k 建一次 `synthIndexOf` 要 ~21ms。没有任何合成节点的数据
    //      （新树 / 纯平台数据）以前**根本不会建它**（组头那趟一个都没轮到）——
    //      少了这句，那种数据反而要多付一趟，"优化"变成退步。
    let any = false;
    for (const id of recompute) {
        const node = state.nodes[id];
        if (node && (synthKeyOf(node) || ownerSynthOf(node))) { any = true; break; }
    }
    if (!any) return new Set();
    const byKey = synthIndexOf(state).byKey;
    const out = new Set();
    const queue = [];
    const push = (headId) => {
        if (!headId || out.has(headId)) return;
        out.add(headId);
        queue.push(headId);
    };
    for (const id of recompute) {
        const node = state.nodes[id];
        if (!node) continue;
        const own = synthKeyOf(node);
        if (own) push(byKey.get(own));              // 自己就是组头
        const owner = ownerSynthOf(node);
        if (owner) push(byKey.get(owner));          // 它是某个组的成员 ⇒ 那个组头要重折
    }
    // 嵌套：重折完的组头若自己也是别人的成员，那个组头也得跟着重折
    while (queue.length) {
        const head = state.nodes[queue.pop()];
        const owner = head ? ownerSynthOf(head) : '';
        if (owner) push(byKey.get(owner));
    }
    return out;
}

/** 读一个节点的派生字段（不在表里 → 退回缓存，例如虚拟节点） */
export function derivedOf(state, node, field, opts = {}) {
    if (!node) return undefined;
    // ⚠️ 派生表**只管派生元素**：普通/结构字段要读请走 `viewValue` / `readField`。
    //    若对任意字段都 `return node[field]`（缓存），
    //    `derivedOf(state, p, 'name')` 就会拿到一个**绕过范围投影**的缓存值。
    if (natureOf(field) !== ELEMENT_NATURE.DERIVED) return undefined;
    const d = derivedTable(state, opts).get(node.id);
    if (d && d[field] !== undefined) return d[field];
    return node[field];          // 派生字段不在表里（虚拟节点）或没算出来 → 退回缓存
}

/**
 * 测试/诊断用：清掉记忆化 —— **派生表那份 + 计数那一趟那份都要清**。
 *
 * ⚠️ 为什么两样一起：`buildDerivedTable` 的全量那条路是**拿那一趟的行**建的表
 *    （`cache_countPassOf`）⇒ 只清这里，那一趟还会把改动前的行喂回来
 *    （它的失效判据是 `nodes`/`childOrder` 的**引用**，而"就地改一个字段"换不动引用）。
 *    凡是要"改完就地重读"的地方（测试里常见），必须是**两样一起清**才算真的重算。
 */
export function clearDerivedMemo() {
    memo = null;
    notedDelta = null;          // 写路径交来的名单跟着一起作废（它对的是"被清掉的那两代"）
    clearCountCache();
}

/**
 * **把已有的那张派生表接到新一代上**（不清、不重算）。
 * 用途与边界见 `countCache.js` 的 `rekeyCountCache`：只给"纯顺序改动"（上移/下移）用。
 */
export function rekeyDerivedMemo(state) {
    if (!memo) return;
    memo.nodes = (state || {}).nodes || null;
    memo.childOrder = (state || {}).childOrder || null;
}
