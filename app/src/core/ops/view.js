// ================================================================
// 视图状态操作（core/ops/view.js）
// 职责：展开/折叠、当前页、选中状态
// 依赖：_helpers.js, core/model/viewState.js（展开态的读写唯一入口）, immer（只为"不经代理读基础状态"）
// ================================================================
import { isDraft, original } from 'immer';
import { getNowStr } from '../../utils/time.js';
import { setExpanded, setNodePage } from '../model/viewState.js';

/**
 * **不经代理**读基础状态的 `nodes`。
 *
 * ⚠️ 为什么必须有它：`draft.nodes[id]` 一读就把**整张 27k 的字典**拖进 draft，
 *    提交时 Immer 于是要整张浅拷一份 —— 真包实测 **~30ms/次**（折叠这类只改
 *    视图态的操作本该是零点几毫秒）。这条与 `shell/executor.js` 里
 *    "别读 `draft.pages`"是同一类坑（见那段注释：读 draft 的属性就建子 draft）。
 *    这里只需回答"节点在不在"，读基础对象就够。
 */
function baseNodes(draft) {
    const base = (typeof isDraft === 'function' && isDraft(draft)) ? (original(draft) || draft) : draft;
    return (base && base.nodes) || {};
}

// ================================================================
// 真实节点
// ================================================================
// ⚠️ 「展开」住在 `state.view.expanded`（**不在节点上**），读写一律过
//    `core/model/viewState.js` 的 `setExpanded` / `isExpanded`。

export function setNodeExpanded(draft, id, expanded) {
    const node = baseNodes(draft)[id];
    if (!node) throw new Error('节点不存在');
    setExpanded(draft, id, expanded);
    return node;
}

export function toggleNodeExpanded(draft, id) {
    const node = baseNodes(draft)[id];
    if (!node) throw new Error('节点不存在');
    const next = !(draft.view && draft.view.expanded && draft.view.expanded[id]);
    setExpanded(draft, id, next);
    return next;
}

export function setNodeCurrentPage(draft, id, page) {
    const node = baseNodes(draft)[id];
    if (!node) throw new Error('节点不存在');
    return setNodePage(draft, id, page);
}

export function setNodeSelected(draft, id, selected) {
    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    node.selected = !!selected;
    node.lastModified = getNowStr();
    return node;
}

export function toggleNodeSelected(draft, id) {
    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    node.selected = !node.selected;
    node.lastModified = getNowStr();
    return node.selected;
}

// ---- 翻转直接子节点的选中状态 ----
export function flipChildrenSelection(draft, id) {
    const node = draft.nodes[id];
    if (!node) throw new Error('节点不存在');
    const childIds = draft.childOrder[id];
    if (childIds.length === 0) {
        throw new Error('该节点没有直接子节点');
    }
    for (const cid of childIds) {
        const child = draft.nodes[cid];
        if (child) {
            child.selected = !child.selected;
            child.lastModified = getNowStr();
        }
    }
    return childIds.length;
}

// ---- 清空指定范围的所有选中状态 ----
// scope: 'main' 表示主树所有节点；其他值视为副页 id
export function clearSelectionInScope(draft, scope) {
    if (scope === 'main') {
        for (const id in draft.nodes) {
            const node = draft.nodes[id];
            if (node.type === 'O') continue;
            if (node.selected) {
                node.selected = false;
                node.lastModified = getNowStr();
            }
        }
        return;
    }
    const page = draft.pages[scope];
    if (!page) throw new Error(`副页 ${scope} 不存在`);
    for (const vId in page.virtualIndex) {
        const vNode = page.virtualIndex[vId];
        if (vNode.type === 'O') continue;
        if (vNode.selected) {
            vNode.selected = false;
        }
    }
}

// ================================================================
// 虚拟节点
// ================================================================

export function setVirtualNodeExpanded(draft, vId, pageId, expanded) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    vNode.expanded = !!expanded;
    return vNode;
}

export function toggleVirtualNodeExpanded(draft, vId, pageId) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    vNode.expanded = !vNode.expanded;
    return vNode.expanded;
}

export function setVirtualNodeCurrentPage(draft, vId, pageId, page) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    vNode.currentPage = Math.max(1, parseInt(page) || 1);
    return vNode;
}

export function setVirtualNodeSelected(draft, vId, pageId, selected) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    vNode.selected = !!selected;
    return vNode;
}

export function toggleVirtualNodeSelected(draft, vId, pageId) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    vNode.selected = !vNode.selected;
    return vNode.selected;
}

export function flipVirtualChildrenSelection(draft, vId, pageId) {
    const vNode = findVNode(draft, pageId, vId);
    if (!vNode) throw new Error('虚拟节点不存在');
    if (!vNode.children || vNode.children.length === 0) {
        throw new Error('该节点没有直接子节点');
    }
    const page = draft.pages[pageId];
    let count = 0;
    for (const cid of vNode.children) {
        const child = page.virtualIndex[cid];
        if (child) {
            child.selected = !child.selected;
            count++;
        }
    }
    return count;
}

// ================================================================
// 内部辅助
// ================================================================

function findVNode(draft, pageId, vId) {
    const page = draft.pages[pageId];
    if (!page) return null;
    return page.virtualIndex[vId] || null;
}