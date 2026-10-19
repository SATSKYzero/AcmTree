// ================================================================
// 自动计算规则（core/autoComputeRules.js）
// 职责：单个节点的派生字段计算（纯函数）
// 依赖：utils/color.js（XCPC 难度分档）、core/model/status.js（状态聚合口径）
// 说明：
//   - 与 core/autoCompute.js 的区别：
//     autoCompute.js 负责"遍历 + 批量应用"
//     autoComputeRules.js 负责"单个节点的计算规则"
//   - 拆分目的：让 core/ops/node.js 能直接用规则函数做校验，
//     而不依赖 autoCompute.js，消除潜在的循环风险
//   - utils/color.js 只依赖 A_constants.js（叶子模块），不会成环
// ================================================================
import { getXcpcDifficulty } from '../utils/color.js';
import { newProblemBuckets, addProblem, statusComplete2Of, pStatus2, SUBMIT_KIND_DURING } from './model/status.js';
import { effectivePin, pinScopeOf } from './pin.js';
// ★ AC 时间"怎么挑"的**唯一一份**（与 `core/derive.js` 那两处同义）
import { pickAcTime, acTimeRuleOf, isSubmissionIgnored } from './acTimeRule.js';
// 合成节点的成员（指针关系）+ 组值的合并规则（**唯一一份**：`AGG_BUILDERS` + `mergeField`）
import { isSynthesis, synthKeyOf, synthMembersTable } from './ops/synth.js';
import { groupAggregateOf } from './groupValue.js';

// ================================================================
// 合成节点（组头）的**子树 = 它的成员**
//
// 成员是**指针**关系（`ownerSynth` → `synthKey`），**不在 `childOrder` 里** —— 组头在树里
// 是独立一枝，成员散在别的树下（真包实测：`synth:xcpc:2026ec_pre2` 的成员是 qoj / pta /
// rankland / srk 各自的 C）。所以：
//   · 组头的值 = **自己那份（A）⊗ 成员各自那份（B）**，规则与"组那份"同一份
//     （`core/groupValue.js` 的 `AGG_BUILDERS` + `mergeField`）——这里只是把 A 换成
//     **刚算出来的**那一份，而不是节点上的缓存；
//   · "子树里节点的值要用**终值**" ⇒ 成员必须**先算完**。`autoCompute.js` 的
//     `collectNodesForUpdate` 把合成节点排在名单**最后**（见那里的说明）。
// ================================================================

/**
 * 组头的成员 id 名单（**树序**，且不含它自己）。
 *
 * ⚠️ **一次更新只建一遍**：`synthMembersTable` 是 O(N) 的一趟，而规则函数是**逐节点**
 *    调的（真包 27k 节点）—— 每节点各建一遍就是 O(N²)。只在真遇到合成节点时才建
 *    （`isSynthesis` 判据），普通节点一分钱不付。键里带 `childOrder` 引用：
 *    结构一改就重建（与 `core/derive.js` / `core/groupCompute.js` 的缓存同一套路）。
 */
let membersMemo = null;
function memberIdsOf(draft, node) {
    if (!isSynthesis(node)) return [];
    if (!membersMemo || membersMemo.draft !== draft || membersMemo.childOrder !== draft.childOrder) {
        membersMemo = { draft, childOrder: draft.childOrder, table: synthMembersTable(draft) };
    }
    return (membersMemo.table.get(synthKeyOf(node)) || []).filter(id => id !== node.id);
}

/**
 * 组头的值：自己那份（`own`，**刚算出来的**）与成员各自那份按该字段的聚合器合并。
 * 不是组头 / 没有成员 ⇒ 原样返回 `own`（普通节点的行为逐字不变）。
 */
function withMembers(draft, node, field, own) {
    const memberIds = memberIdsOf(draft, node);
    if (!memberIds.length) return own;
    const v = groupAggregateOf(draft, {
        headId: node.id,
        memberIds,
        field,
        readOf: (n, f) => (n.id === node.id ? own : n[f])
    });
    return (v === undefined || v === null) ? own : v;
}

// ---- P.acTime ----
/**
 * 写**缓存字段**那条路。
 * ⚠️ 挑法与 `core/derive.js` 的 `derivePacTime` / `derivePtriple` **必须同义** ——
 *    所以三处都调 `core/acTimeRule.js` 的 `pickAcTime`（规则从 `settings` 取），别再各写一遍。
 */
export function computePacTime(draft, node) {
    const rule = acTimeRuleOf(draft && draft.settings);
    const acTimes = [];
    for (const cid of draft.childOrder[node.id]) {
        const child = draft.nodes[cid];
        if (!child || child.type !== 'R' || child.status !== 'AC') continue;
        if (!child.time || child.time === '----.--.-- --:--') continue;
        // ★ 第 4 种规则（`cutoffIgnore`）：截断前的提交**不算**
        if (isSubmissionIgnored(child.time, rule)) continue;
        acTimes.push(child.time);
    }
    return pickAcTime(acTimes, rule);
}

// ---- P.lastSubmitTime ----
export function computePlastSubmitTime(draft, node) {
    const rule = acTimeRuleOf(draft && draft.settings);
    let latest = '';
    for (const cid of draft.childOrder[node.id]) {
        const child = draft.nodes[cid];
        if (!child || child.type !== 'R') continue;
        if (!child.time || child.time === '----.--.-- --:--') continue;
        // ★ 被忽略的提交**不进"最新提交"**（与 `acTime` / `status2` 同一口径）
        if (isSubmissionIgnored(child.time, rule)) continue;
        if (latest === '' || child.time > latest) {
            latest = child.time;
        }
    }
    return latest || '----.--.-- --:--';
}

// ---- P.status2 ----
export function computePstatus2(draft, node) {
    const rule = acTimeRuleOf(draft && draft.settings);
    let hasSub = false;
    let hasAC = false;
    let hasDuringAC = false;
    for (const cid of draft.childOrder[node.id]) {
        const child = draft.nodes[cid];
        if (!child || child.type !== 'R') continue;
        // ★ 第 4 种规则：**被忽略的提交不算提交** ⇒ 它不参与 status2
        //   （用户原话："题目的 Ac时间/最新提交/stat2 要按条件判断（提交是否忽略）每个提交是否取"）
        if (isSubmissionIgnored(child.time, rule)) continue;
        hasSub = true;
        if (child.status === 'AC') {
            hasAC = true;
            // 赛时的 AC ⇒ 这题是「赛时通过」。用缓存字段（与 pin 同源）。
            if (child.submitKind === SUBMIT_KIND_DURING) hasDuringAC = true;
        }
    }
    // ⚠️ 覆盖**只从来源层来**（`core/pin.js`，范围 = "当前账户"这一份，与写回缓存的语义一致）。
    //    不能拿 `node.status2`（**缓存字段**）当覆盖：缓存只有一份，
    //    多账户下会把**别人**的覆盖当成我的（"手改值为忽略时，
    //    自动计算不能抛开手改值"）。
    //    归一成数字再交给共用规则：来源层里存的是**字符串**（`'5'`），而 `pStatus2`
    //    是严格相等比较（`pin === S2_IGNORE`）—— 与视图侧 `derivePstatus2` 的 `Number(p)` 同一口径。
    const pinned = effectivePin(node, 'status2', pinScopeOf(draft.currentAccountId));
    const pin = pinned === null ? undefined : Number(pinned);
    // ★ 合成节点：子树 = 它的**成员**（组头自己没有 R 子节点 ⇒ 否则恒"未使用"）
    return withMembers(draft, node, 'status2', pStatus2(hasSub, hasAC, pin, hasDuringAC));
}

// ---- P.xcpcDifficulty ----
/**
 * XCPC 难度等级 —— **完全由 ratio 派生**（纯函数，与子节点无关）
 *
 * 为什么必须做成自动计算规则：
 *   等级本来就只是 ratio 的一档查表结果。如果只在"手动编辑题目"
 *   （core/ops/node.js 的 updateP）里算，那么**导入进来的题目**
 *   永远停在默认值 `'-'`，于是树上会显示 `28.19%(-)` ——
 *   明明有通过率却报"未填写难度"。派生字段必须由派生引擎维护，
 *   否则 core/ops/upsert.js 里"AUTO_NODE_KEYS 由 autoCompute 推导"
 *   这个前提就是假的。
 *
 * 与 updateP 的口径**必须一致**：空 / '-' → '-'，否则去掉 % 后 parseFloat。
 */
export function computePxcpcDifficulty(draft, node) {
    const raw = (node.ratio === undefined || node.ratio === null) ? '' : String(node.ratio).trim();
    if (raw === '' || raw === '-') return '-';
    return getXcpcDifficulty(parseFloat(raw.replace('%', '')));
}

// ---- 容器 statusComplete1 ----
export function computeContainerStatusComplete1(draft, node) {
    let allProcessed = true;
    let hasP = false;
    (function walk(nid) {
        const n = draft.nodes[nid];
        if (n.type === 'P') {
            hasP = true;
            if (n.status1 !== 1) allProcessed = false;
        }
        for (const cid of draft.childOrder[nid]) {
            walk(cid);
        }
    })(node.id);
    const own = hasP ? (allProcessed ? 1 : 0) : 0;
    // ★ 合成节点：子树 = 它的**成员**（组头自己没有子树 ⇒ 否则恒 0）
    return withMembers(draft, node, 'statusComplete1', own);
}

// ---- 容器 statusComplete2 ----
export function computeContainerStatusComplete2(draft, node) {
    // 用户手动标记忽略：无条件保留
    if (node.statusComplete2 === 4) return 4;

    const b = newProblemBuckets();
    (function walk(nid) {
        const n = draft.nodes[nid];
        if (n.type === 'P') addProblem(b, n.status1, n.status2);
        for (const cid of draft.childOrder[nid]) {
            walk(cid);
        }
    })(node.id);

    // ★ 合成节点：子树 = 它的**成员**（组头自己没有子树 ⇒ 否则恒 0）
    return withMembers(draft, node, 'statusComplete2', statusComplete2Of(b));
}