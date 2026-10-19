// ================================================================
// 展开节点数校验（core/validate/expanded.js）
// 职责：计算当前展开渲染的节点数
// 依赖：core/model/viewState.js（展开态的唯一读入口）
// ================================================================
import { isExpanded, pageOf } from '../model/viewState.js';

/**
 * 计算以 nodes 为根、parentExpanded 状态下的展开渲染节点数
 * @param {Object} state
 * @param {Array} nodes - 待遍历的节点数组
 * @param {boolean} parentExpanded
 * @param {number} nodePerPage
 * @returns {number}
 */
export function countRenderedNodesOnTree(state, nodes, parentExpanded = true, nodePerPage = 20) {
    if (!nodes || nodes.length === 0) return 0;
    if (!parentExpanded) return 0;
    let total = 0;
    for (const node of nodes) {
        total += 1;
        const childIds = state.childOrder[node.id];
        if (isExpanded(state, node.id) && childIds.length > 0) {
            const totalChildren = childIds.length;
            const pageCount = Math.ceil(totalChildren / nodePerPage) || 1;
            const currentPage = Math.min(pageOf(state, node.id), pageCount);
            const start = (currentPage - 1) * nodePerPage;
            const end = Math.min(currentPage * nodePerPage, totalChildren);
            const visibleIds = childIds.slice(start, end);
            const visible = [];
            for (const cid of visibleIds) {
                const c = state.nodes[cid];
                if (c) visible.push(c);
            }
            total += countRenderedNodesOnTree(state, visible, true, nodePerPage);
        }
    }
    return total;
}

/**
 * 全树展开节点数（从根的直接子节点开始）
 */
export function getCurrentRenderedCount(state, nodePerPage = 20) {
    if (!state.rootId) return 0;
    const root = state.nodes[state.rootId];
    if (!root) return 0;
    const children = [];
    for (const cid of state.childOrder[root.id]) {
        const c = state.nodes[cid];
        if (c) children.push(c);
    }
    return countRenderedNodesOnTree(state, children, true, nodePerPage);
}

/**
 * 展开节点数是否合法（≤ blockLimit）
 */
export function validateExpandedLimit(state, blockLimit, nodePerPage = 20) {
    const count = getCurrentRenderedCount(state, nodePerPage);
    return count <= blockLimit;
}