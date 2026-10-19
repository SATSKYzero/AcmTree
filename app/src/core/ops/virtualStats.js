// ================================================================
// 副页虚拟节点统计（core/ops/virtualStats.js）
// 职责：计算副页中 W/S/C 虚拟节点的 statusComplete1/2，
//       以及插件注册的 vNode 派生字段
// 依赖：core/pluginRegistry.js、core/model/status.js（分档口径）
// 说明：
//   - statusComplete1/2 结果写入 page.vNodeStats[vId]
//   - 插件规则结果写入 vNode[key]（如 vNode.testNumSum）
//   - 插件规则按后序遍历（先子后父）
//
// 副页（按查看范围取值）
// --------------------
// 写进 `page.vNodeStats` 的那份是**登录账户口径**（物化结果，持久化，语义不变）。
// 显示时不该用它 —— 副页里引用的真实 P 节点的"过没过"是**带账户**的
// （`status2` 现在按查看范围算）。所以另给一个**只算不写**的入口：
//
//     virtualContainerStats(page, vId, { nodes, derived, settings })
//
// `derived` 缺省读缓存；view 层传按范围取值的版本（`settings` 一并传，计数模式从它读）。
// ⚠️ 两条路都过 `problemUnitsOf`（计数模式：`dedup` 每组只算一次）—— 见下面那段注释。
// ================================================================
import { getVNodeComputeRules } from '../pluginRegistry.js';
import { newProblemBuckets, addProblem, statusComplete2Of } from '../model/status.js';
import { problemUnitsOf } from '../query/stats.js';

/** 默认取值器：直接读缓存字段 */
const cacheDerived = (node, field) => node[field];

/**
 * 刷新单个副页
 * @param {Object} draft
 * @param {string} pageId
 * @returns {number} 变化的节点数
 */
export function refreshVirtualStatsForPage(draft, pageId) {
    const page = draft.pages[pageId];
    if (!page) return 0;

    const vIndex = page.virtualIndex;
    if (!vIndex) return 0;

    let changed = 0;

    // ---- 第一部分：statusComplete1/2（硬编码，任意顺序） ----
    const oldStats = page.vNodeStats || {};
    const newStats = {};
    for (const vId in vIndex) {
        const vNode = vIndex[vId];
        if (!vNode) continue;
        if (vNode.type !== 'W' && vNode.type !== 'S' && vNode.type !== 'C') continue;
        newStats[vId] = computeVirtualContainerStats(draft, page, vId);
    }
    if (!statsEqual(oldStats, newStats)) {
        page.vNodeStats = newStats;
        changed += Object.keys(newStats).length;
    }

    // ---- 第二部分：插件 vNode compute 规则（后序） ----
    const visited = new Set();

    function postOrder(vId) {
        if (visited.has(vId)) return;
        visited.add(vId);
        const vNode = vIndex[vId];
        if (!vNode) return;
        // 先子
        if (vNode.children && Array.isArray(vNode.children)) {
            for (const cid of vNode.children) {
                postOrder(cid);
            }
        }
        // 后父
        const rules = getVNodeComputeRules(vNode.type);
        for (const rule of rules) {
            const newVal = rule.compute(draft, page, vNode);
            if (vNode[rule.key] !== newVal) {
                vNode[rule.key] = newVal;
                changed++;
            }
        }
    }

    for (const vId in vIndex) {
        postOrder(vId);
    }

    return changed;
}

/**
 * 刷新所有副页
 */
export function refreshAllVirtualStats(draft) {
    let total = 0;
    for (const pageId in draft.pages) {
        total += refreshVirtualStatsForPage(draft, pageId);
    }
    return total;
}

// ================================================================
// 内部：计算单个虚拟容器的 statusComplete 聚合
//
// ★ **计数模式**（`settings.stats.countMode`）在这里也生效（与主树同一份口径）：
//   `plain` = 每个引用的 P 各算一次（老行为，逐字不变）；
//   `dedup` = **每组只算一次**，档位取那一组的「组那份」——
//     判重模式开着的时候，副页里同一道题的多个来源副本不该各占一格。
//   实现**不在这里另写**：走 `core/query/stats.js` 的 `problemUnitsOf()`
//   （它复用主树那套组索引 + `groupProblemValue`）。
// ================================================================
function computeVirtualContainerStats(draft, page, vId, derived = cacheDerived) {
    const b = newProblemBuckets();
    let hasP = false;

    const visited = new Set();
    const refs = [];                 // 走到的 P（引不到真实节点的给 null）

    function walk(id) {
        if (visited.has(id)) return;
        visited.add(id);

        const vNode = page.virtualIndex[id];
        if (!vNode) return;

        if (vNode.type === 'P') {
            hasP = true;
            const realNode = vNode.refId ? draft.nodes[vNode.refId] : null;
            refs.push(realNode || null);        // 引不到 ⇒ null：只计入总数、不判状态
            return;
        }

        if (vNode.children && Array.isArray(vNode.children)) {
            for (const cid of vNode.children) {
                walk(cid);
            }
        }
    }

    walk(vId);

    // ⚠️ 这两个值**按范围**取（view 层传进来）；缺省 = 读缓存。
    //     `dedup` 下 units 已经是"每组一条 + 组那份"，所以下面逐条加就是对的。
    let allProcessed = true;
    for (const u of problemUnitsOf(draft, refs, derived)) {
        addProblem(b, u.status1, u.status2);
        if (u.status1 !== 1) allProcessed = false;      // null（引不到）⇒ undefined ≠ 1 ✓
    }

    const sc1 = (hasP && allProcessed) ? 1 : 0;

    return { statusComplete1: sc1, statusComplete2: statusComplete2Of(b) };
}

/**
 * **只算不写**：某个虚拟容器在给定取值口径下的完成状态（显示入口）。
 *
 * @param {Object} page
 * @param {string} vId
 * @param {Object} [opts]
 * @param {Object} [opts.nodes] - `state.nodes`（引用真实节点）
 * @param {(node:Object, field:string) => *} [opts.derived] - 派生取值器（缺省读缓存）
 * @param {Object} [opts.settings] - `state.settings`（计数模式从它读；不给 = 缺省 plain）
 * @returns {{statusComplete1:number, statusComplete2:number}}
 */
export function virtualContainerStats(page, vId, opts = {}) {
    const nodes = opts.nodes || {};
    const derived = typeof opts.derived === 'function' ? opts.derived : cacheDerived;
    return computeVirtualContainerStats({ nodes, settings: opts.settings }, page, vId, derived);
}

// ================================================================
// 内部：比较两份 stats 是否相等
// ================================================================
function statsEqual(a, b) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
        const av = a[k];
        const bv = b[k];
        if (!bv) return false;
        if (av.statusComplete1 !== bv.statusComplete1) return false;
        if (av.statusComplete2 !== bv.statusComplete2) return false;
    }
    return true;
}