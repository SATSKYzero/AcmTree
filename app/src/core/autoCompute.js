// ================================================================
// 自动计算引擎（core/autoCompute.js）
// 职责：对 P/C/W/S 节点批量计算派生字段
// 依赖：utils/time.js, core/autoComputeRules.js, core/pluginRegistry.js
//       + core/groupCompute.js（每层三趟 · 两列值的「组那份」）
// 说明：
//   - 规则函数全部在 autoComputeRules.js
//   - 本文件负责"收集节点 + 应用规则"
//   - 硬编码规则（status 系列）与插件规则（registerComputeRule）并存
//   - 依赖 draft.parentOf 与 draft.childOrder 一致
//
// 每层三趟在这里的落点**刻意很小**
// ----------------------------------------------------------------
//   `fullAutoUpdate` / `autoUpdateSubtree` / `propagateUp` **保持原样** ——
//   它们仍然是"后序遍历 + 写缓存字段"（R → P → C 的层间顺序本来就由后序保证）。
//   三趟编排（`computeGroupValues`）是**独立的一次调用**，而且**只读、不写**：
//     · 它返回「倒推覆盖表」（`nodeId → { 字段: 值 }`）与组那份值，供视图/统计读；
//     · 组那份值**绝不**写回 `node` / 来源层 —— 写回去就会被当输入重新喂进聚合 ⇒ 震荡。
//   为什么不做成"把组值写进缓存字段"：
//     "两列值" = **扩 `viewDerived(..., { group: true })`**：
//     两列都**不落库、不写来源层、不新增缓存字段**。所以这里只做编排，不做物化。
// ================================================================
import { getNowStr } from '../utils/time.js';
import {
    computePacTime,
    computePlastSubmitTime,
    computePstatus2,
    computePxcpcDifficulty,
    computeContainerStatusComplete1,
    computeContainerStatusComplete2
} from './autoComputeRules.js';
import { getComputeRules } from './pluginRegistry.js';
// 三趟编排（纯函数 + 一槽记忆化；只读 state）
import { groupComputed, clearGroupMemo } from './groupCompute.js';
// 合成节点（组头）—— 它的"子树"是成员，要排到最后（见 `synthLast`）
import { isSynthesis } from './ops/synth.js';
// ★ 事务内的父指针（**别直接读 `draft.parentOf`**：结构操作已不再写它，见 `ops/_helpers.js` 文件头）
import { parentOfInDraft } from './ops/_helpers.js';

// ---- 对外 re-export 规则（保持向后兼容） ----
export {
    computePacTime,
    computePlastSubmitTime,
    computePstatus2,
    computePxcpcDifficulty,
    computeContainerStatusComplete1,
    computeContainerStatusComplete2
} from './autoComputeRules.js';

// ================================================================
// 类型到自动计算属性的映射（硬编码部分）
// ================================================================
const TYPE_AUTO_PROPS = {
    'P': [
        { key: 'acTime', compute: computePacTime },
        { key: 'lastSubmitTime', compute: computePlastSubmitTime },
        { key: 'status2', compute: computePstatus2 },
        // ratio → XCPC 等级。放在这里而不是"写 import 时顺手算"，
        // 是为了让手动改、导入、批量导入三条路径得到同一个结果。
        { key: 'xcpcDifficulty', compute: computePxcpcDifficulty }
    ],
    'C': [
        { key: 'statusComplete1', compute: computeContainerStatusComplete1 },
        { key: 'statusComplete2', compute: computeContainerStatusComplete2 }
    ],
    'W': [
        { key: 'statusComplete1', compute: computeContainerStatusComplete1 },
        { key: 'statusComplete2', compute: computeContainerStatusComplete2 }
    ],
    'S': [
        { key: 'statusComplete1', compute: computeContainerStatusComplete1 },
        { key: 'statusComplete2', compute: computeContainerStatusComplete2 }
    ]
};

// ================================================================
// 单节点自动更新
// ================================================================
export function autoUpdateNode(draft, id) {
    const node = draft.nodes[id];
    if (!node) return false;
    let changed = false;

    // ---- 硬编码规则 ----
    const props = TYPE_AUTO_PROPS[node.type] || [];
    for (const prop of props) {
        const newVal = prop.compute(draft, node);
        if (node[prop.key] !== newVal) {
            node[prop.key] = newVal;
            changed = true;
        }
    }

    // ---- 插件规则 ----
    const pluginRules = getComputeRules(node.type);
    for (const rule of pluginRules) {
        const newVal = rule.compute(draft, node);
        if (node[rule.key] !== newVal) {
            node[rule.key] = newVal;
            changed = true;
        }
    }

    if (changed) {
        node.lastModified = getNowStr();
    }
    return changed;
}

// ================================================================
// 收集需要更新的节点列表
// ================================================================
/**
 * 合成节点（组头）**排在名单最后**。
 *
 * 理由（一句话）：组头的"子树"是它的**成员**（指针关系，不在 `childOrder` 里），
 * 而成员要**先算完**——组头算自己那份时要读成员的值，读到的必须是**终值**。
 * 后序只保证**树内**子树先算完，成员散在别的树下（真包实测：`synth:xcpc:2026ec_pre2`
 * 的成员是 qoj / pta / rankland / srk 各自的 C）⇒ 不排到最后，组头读到的就是成员的
 * **初值**（旧值 / 空）。
 *
 * 成员**永远不是**合成节点（`core/groupValue.js` 的硬约束 ⑤），所以一趟搬完就够。
 */
function synthLast(draft, list) {
    let hasHead = false;
    for (const id of list) {
        const n = draft.nodes[id];
        if (n && isSynthesis(n)) { hasHead = true; break; }
    }
    if (!hasHead) return list;                 // 没有合成节点 ⇒ 名单逐字不变（回归锚）
    const rest = [];
    const heads = [];
    for (const id of list) {
        const n = draft.nodes[id];
        if (n && isSynthesis(n)) heads.push(id);
        else rest.push(id);
    }
    return rest.concat(heads);
}

export function collectNodesForUpdate(draft, source, mode) {
    const list = [];

    if (mode === 'self') {
        const id = typeof source === 'object' ? source.id : source;
        if (draft.nodes[id]) list.push(id);
        return list;
    }

    if (mode === 'ancestors') {
        const id = typeof source === 'object' ? source.id : source;
        let pid = parentOfInDraft(draft, id);
        while (pid) {
            list.push(pid);
            pid = parentOfInDraft(draft, pid);
        }
        return list;
    }

    if (mode === 'subtree') {
        const rootId = typeof source === 'object' ? source.id : source;
        if (!draft.nodes[rootId]) return list;
        (function walk(id) {
            for (const cid of draft.childOrder[id]) {
                walk(cid);
            }
            list.push(id);
        })(rootId);
        return synthLast(draft, list);
    }

    if (mode === 'full') {
        if (!draft.rootId) return list;
        (function walk(id) {
            for (const cid of draft.childOrder[id]) {
                walk(cid);
            }
            list.push(id);
        })(draft.rootId);
        return synthLast(draft, list);
    }

    return list;
}

// ================================================================
// 批量应用
// ================================================================
export function applyUpdateList(draft, nodeIds) {
    let changedCount = 0;
    for (const id of nodeIds) {
        if (autoUpdateNode(draft, id)) {
            changedCount++;
        }
    }
    return changedCount;
}

// ================================================================
// 对外便捷函数
// ================================================================
export function propagateUp(draft, startNodeId) {
    const list = collectNodesForUpdate(draft, startNodeId, 'ancestors');
    return applyUpdateList(draft, list);
}

/**
 * **只重算"这一条链"**：`id` 自己 + 它的全部祖先（自底向上）。
 *
 * 用途：结构改动（增/删/移动一个节点）时，**不必整棵树重算** ——
 * 详见 `core/ops/tree.js` 里那段"为什么可以只算一部分"的说明。
 */
export function autoUpdateChain(draft, id) {
    const list = [id, ...collectNodesForUpdate(draft, id, 'ancestors')];
    return applyUpdateList(draft, list);
}

export function autoUpdateSubtree(draft, nodeId) {
    const list = collectNodesForUpdate(draft, nodeId, 'subtree');
    return applyUpdateList(draft, list);
}

export function fullAutoUpdate(draft) {
    const list = collectNodesForUpdate(draft, null, 'full');
    return applyUpdateList(draft, list);
}

/**
 * **只重算 P 的那三格缓存**（`status2` / `acTime` / `lastSubmitTime`）——
 * 题目 AC 时间的**规则 / 截断值**变了之后用。
 *
 * 为什么不用 `fullAutoUpdate`：那条会把**每个**节点的**每个**派生字段都重算一遍
 * （真包是一次主线程上的整树重算），而这次改的只影响这三格。
 * 为什么必须重算：它们是 `autoCompute` 写下来的**物化缓存**，
 * 不重算就会与派生表**两个答案**（仓里反复踩过这类坑：缓存 / 投影 / 显示三份不同源）。
 *
 * ⚠️ **第 4 种规则（`cutoffIgnore`，"忽略截断前的提交"）起，受影响的**不止 `acTime`** ——
 *    `status2` 与 `lastSubmitTime` 也按同一条条件过滤（用户 2026-10-13 的原话：
 *    "题目的 Ac时间/最新提交/stat2 要按条件判断（提交是否忽略）"）
 *    ⇒ 所以这里三格一起重算，别只算 `acTime`（那只算规则 1~3 的那一版就够了）。
 *
 * ⚠️ 只扫 P 一层；判定用 `type`（与 `TYPE_AUTO_PROPS` 同一套）。
 * 名字沿用 `recomputeAcTime`（既有调用点/文档不用改），语义按上面这条。
 */
export function recomputeAcTime(draft) {
    if (!draft || !draft.nodes) return 0;
    let n = 0;
    for (const id of Object.keys(draft.nodes)) {
        const node = draft.nodes[id];
        if (!node || node.type !== 'P') continue;
        node.acTime = computePacTime(draft, node);
        node.lastSubmitTime = computePlastSubmitTime(draft, node);
        node.status2 = computePstatus2(draft, node);
        n++;
    }
    return n;
}

// ================================================================
// 每层三趟（原料 → 合成 → 原料·倒推覆盖）
// ================================================================
/**
 * 对整棵树跑一次"每层三趟"，返回**只读的**倒推覆盖表与组那份值。
 *
 * 层间顺序 `R → P → C`；每层三趟 `原料 → 合成 → 原料（倒推覆盖）`
 * —— 编排在 `core/groupValue.js` 的 `runGroupPasses`，这里只是入口。
 *
 * ⚠️ **不写任何东西**：
 *   · 不写 `node[字段]`（缓存字段由上面的 `fullAutoUpdate` 负责，口径没变）；
 *   · 不写 `node.values`（来源层）；
 *   · 不进历史、不进撤销栈（它连事务都没开）。
 * 之所以刻意不在这里"顺手写回缓存"：写回去 ⇒ 下一轮把它当输入再聚合一次 ⇒ 震荡。
 *
 * 没有合成节点时 `hasSynthesis === false`、`working` 为空表 —— 此时"组那份"恒等于
 * "自己那份"，中间态保持一致（回归锚）。
 *
 * @param {Object} draft - `{ nodes, parentOf, childOrder, rootId, settings, accounts, trust, viewingAccountId }`
 * @param {Object} [opts] - `{ viewingAccountId }`
 * @returns {{ working:Map<string,Object>, hasSynthesis:boolean, layers:Array, groupsTotal:number }}
 */
export function computeGroupValues(draft, opts = {}) {
    return groupComputed(draft, opts);
}

/**
 * 一次做完"批量重算 + 三趟编排"，并返回三趟的结果。
 *
 * 保留 `fullAutoUpdate` 的**返回语义**（改了几个节点）不变 —— 既有调用点（导入、树操作、
 * 界面动作）`fullAutoUpdate(draft)` 的返回值是"变更计数"，不能改样。
 *
 * @returns {{ changed:number, group:Object }} `group` 见 `computeGroupValues`
 */
export function fullAutoUpdateWithGroups(draft, opts = {}) {
    const changed = fullAutoUpdate(draft);
    return { changed, group: computeGroupValues(draft, opts) };
}

// 记忆化的失效**不需要**手动触发：组表的缓存键第一项就是 `nodes` 引用，
// 而 Immer 下任何改动都换引用（非 Immer 的调用方改了 draft 之后自己换引用即可）。
// 这里只把"清缓存"转出去给测试/诊断用。
export { clearGroupMemo };