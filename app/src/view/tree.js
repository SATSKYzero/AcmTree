// ================================================================
// 树渲染与增量更新（view/tree.js）
// 职责：增量插入/更新
// 依赖：view/renderers.js
// ================================================================
import { renderNode } from './renderers.js';
import { isExpanded } from '../core/model/viewState.js';

// ----- 增量插入节点（内部） -----
export function insertNodeAt(state, id, parentId = null) {
    const node = state.nodes[id];
    if (!node) return;

    const actualParentId = parentId !== null ? parentId : (state.parentOf[id] ?? null);
    const parentArray = actualParentId === null
        ? [state.nodes[state.rootId]].filter(Boolean)
        : collectChildrenObjects(state, actualParentId);
    const index = parentArray.indexOf(node);
    if (index === -1) return;

    const nextNode = index < parentArray.length - 1 ? parentArray[index + 1] : null;
    const container = actualParentId === null
        ? document.getElementById('tree-container')
        : document.getElementById(`node-${actualParentId}`)?.querySelector('.node-children');
    if (!container) return;

    const shallow = !isExpanded(state, node.id);
    const newHtml = renderNode(state, node, index, parentArray, actualParentId, shallow);

    if (nextNode) {
        const refEl = document.getElementById(`node-${nextNode.id}`);
        if (refEl) {
            refEl.insertAdjacentHTML('beforebegin', newHtml);
            return;
        }
    }
    container.insertAdjacentHTML('beforeend', newHtml);
}

// ----- 更新单个节点 -----
export function updateNode(state, id) {
    const node = state.nodes[id];
    if (!node) return;

    const parentId = state.parentOf[id] ?? null;
    const parentArray = parentId === null
        ? [state.nodes[state.rootId]].filter(Boolean)
        : collectChildrenObjects(state, parentId);
    const index = parentArray.indexOf(node);
    if (index === -1) return;

    const shallow = !isExpanded(state, node.id);
    const newHtml = renderNode(state, node, index, parentArray, parentId, shallow);
    const oldEl = document.getElementById(`node-${id}`);

    if (oldEl) {
        if (shallow) {
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = newHtml;
            const newBox = tempDiv.firstElementChild?.querySelector('.node-box');
            const oldBox = oldEl.querySelector('.node-box');
            if (oldBox && newBox) {
                oldBox.innerHTML = newBox.innerHTML;
                oldBox.className = newBox.className;
            }
        } else {
            oldEl.outerHTML = newHtml;
        }
    } else {
        insertNodeAt(state, id, parentId);
    }
}

// ================================================================
// 内部辅助
// ================================================================

function collectChildrenObjects(state, parentId) {
    const childIds = state.childOrder[parentId];
    if (!childIds) return [];
    const out = [];
    for (const cid of childIds) {
        const c = state.nodes[cid];
        if (c) out.push(c);
    }
    return out;
}