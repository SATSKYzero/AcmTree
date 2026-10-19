// ================================================================
// 类型选择器 + 树形选择器（ui/G_modal/G2_selector.js）
// 职责：选择节点类型 / 从树（含虚拟树）中选节点
// 依赖：G1_core.js, G1_toast.js, view/renderers.js,
//       utils/A_helpers.js, A_constants.js
// ================================================================
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { renderNode } from '../../view/renderers.js';
import { escapeHtml } from '../../utils/html.js';
import { TYPE_LABEL_MAP } from '../../A_constants.js';
import { isExpanded } from '../../core/model/viewState.js';

// ================================================================
// 类型选择器（纯 UI，无状态依赖）
// ================================================================
export function showTypeSelector(allowedTypes, callback) {
    if (!allowedTypes || !allowedTypes.length) {
        showToast('无可用类型', 'error');
        return;
    }

    document.querySelectorAll('.modal-overlay').forEach(el => el.remove());

    const types = [...new Set(allowedTypes)];
    const colors = { 'W': '#3b82f6', 'S': '#aa00aa', 'C': '#10b981', 'P': '#f59e0b', 'R': '#ef4444' };

    let btnHtml = `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">`;
    types.forEach(type => {
        const bg = colors[type] || '#6b7280';
        btnHtml += `<button class="type-btn" data-type="${type}" style="padding:10px 24px;border:none;border-radius:8px;font-size:18px;font-weight:bold;cursor:pointer;background:${bg};color:#fff;transition:transform 0.1s;box-shadow:0 2px 6px rgba(0,0,0,0.1);">${TYPE_LABEL_MAP[type] || type}</button>`;
    });
    btnHtml += `</div>`;

    const { panel, close } = createModal({
        title: '选择节点类型',
        content: btnHtml,
        maxWidth: '400px',
        buttons: [
            // ★ 取消也要回调一次（`null`）—— 不回调会让 `promptAddRoot` 那个 `await` 永远悬着：
            //   用户点了取消，界面既不提示也不再反应。约定见 `G2_common.js` 文件头那段。
            { label: '取消', className: 'btn', callback: () => { close(); callback(null); } }
        ],
        closeOnOverlay: true,
        closeOnEscape: true,
    });

    panel.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            btn.style.transform = 'scale(1.05)';
            btn.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.transform = 'scale(1)';
            btn.style.boxShadow = '0 2px 6px rgba(0,0,0,0.1)';
        });
        btn.addEventListener('click', () => {
            close();
            callback(btn.dataset.type);
        });
    });

    setTimeout(() => {
        const first = panel.querySelector('.type-btn');
        if (first) first.focus();
    }, 50);
}

// ================================================================
// 树形节点选择器（主树 + 副页虚拟树）
// ================================================================
export function showTreeSelector(state, options) {
    const {
        title = '选择目标节点',
        rootId = null,
        rootNode = null,
        filter = null,
        isDisabled = null,
        selectedId = null,
        onConfirm,
        onCancel = null,
        showSearch = true,
        showRoot = false,
        rootLabel = '',
    } = options;

    let startNode;
    if (rootNode) {
        startNode = rootNode;
    } else if (rootId) {
        startNode = state.nodes[rootId];
        if (!startNode) {
            showToast('起始节点不存在', 'error');
            return;
        }
    } else {
        startNode = state.nodes[state.rootId];
        if (!startNode) {
            showToast('树未初始化', 'error');
            return;
        }
    }

    const pathCache = new Map();
    const localNodeMap = new Map();

    function buildPath(node, currentPath = '') {
        const display = node.name || node.time || '未命名';
        const typeLabel = TYPE_LABEL_MAP[node.type] || node.type;
        const fullPath = currentPath ? `${currentPath} → ${display} (${typeLabel})` : `${display} (${typeLabel})`;
        pathCache.set(node.id, fullPath);
        localNodeMap.set(node.id, node);
        const children = getChildNodes(state, node);
        for (const child of children) {
            buildPath(child, fullPath);
        }
    }
    buildPath(startNode);

    const effectiveFilter = filter || (() => true);

    function getSelectedNodeId() {
        const checked = container.querySelector('input[type="radio"]:checked');
        return checked ? checked.value : null;
    }

    function getNodeById(nodeId) {
        return localNodeMap.get(nodeId) || null;
    }

    let searchTerm = '';

    function renderTreeNodes(parentNode, depth = 0) {
        const children = getChildNodes(state, parentNode);
        if (children.length === 0) return '';

        let html = '';
        const sortedChildren = [...children];

        for (const child of sortedChildren) {
            if (!effectiveFilter(child)) continue;

            let matchesSearch = true;
            if (searchTerm.trim() !== '') {
                const term = searchTerm.trim().toLowerCase();
                const nameMatch = (child.name || '').toLowerCase().includes(term);
                const idMatch = child.id.toLowerCase().includes(term);
                const pathMatch = (pathCache.get(child.id) || '').toLowerCase().includes(term);
                matchesSearch = nameMatch || idMatch || pathMatch;
            }

            const hasMatchingDescendant = (() => {
                if (matchesSearch) return true;
                let found = false;
                function check(n) {
                    if (found) return;
                    if (effectiveFilter(n)) {
                        const term = searchTerm.trim().toLowerCase();
                        if (term === '') { found = true; return; }
                        const nameMatch = (n.name || '').toLowerCase().includes(term);
                        const idMatch = n.id.toLowerCase().includes(term);
                        const pathMatch = (pathCache.get(n.id) || '').toLowerCase().includes(term);
                        if (nameMatch || idMatch || pathMatch) { found = true; return; }
                    }
                    const subs = getChildNodes(state, n);
                    for (const c of subs) check(c);
                }
                check(child);
                return found;
            })();

            if (!matchesSearch && !hasMatchingDescendant) continue;

            const shouldExpand = isExpanded(state, child.id) || (searchTerm.trim() !== '' && hasMatchingDescendant);
            const hasVisibleChildren = getChildNodes(state, child).length > 0;
            const disabled = isDisabled ? isDisabled(child) : false;

            const childHtml = renderNode(state, child, 0, sortedChildren, parentNode.id, !shouldExpand, 'selector', disabled);

            let toggleBtnHtml = '';
            if (hasVisibleChildren) {
                toggleBtnHtml = `<button class="tree-toggle-btn" data-id="${child.id}" style="width:26px;height:26px;border:none;background:transparent;border-radius:6px;font-size:14px;color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:0;">${shouldExpand ? '▼' : '▶'}</button>`;
            } else {
                toggleBtnHtml = `<span style="width:26px;flex-shrink:0;"></span>`;
            }

            html += `
                <div class="tree-node-wrapper" data-id="${child.id}" data-expanded="${shouldExpand ? 'true' : 'false'}">
                    <div style="display:flex; align-items:center; gap:4px;">
                        ${toggleBtnHtml}
                        ${childHtml}
                    </div>
                    <div class="tree-children-${child.id}" style="display:${shouldExpand ? 'block' : 'none'}; padding-left:20px;">
                        ${renderTreeNodes(child, depth + 1)}
                    </div>
                </div>
            `;
        }
        return html;
    }

    function renderContent() {
        let html = '';

        if (showRoot) {
            const rootDisplayLabel = rootLabel || startNode.name || '根';
            const disabled = isDisabled ? isDisabled(startNode) : false;
            html += `
                <div class="tree-node-wrapper" data-id="${startNode.id}" data-expanded="false">
                    <div style="display:flex; align-items:center; gap:4px; padding:4px 0;">
                        <span style="width:26px;flex-shrink:0;"></span>
                        <div style="flex:1; display:flex; align-items:center; justify-content:space-between; padding:4px 8px; border:1px solid #e2e8f0; border-radius:6px; background:#f8fafc;">
                            <span style="font-weight:500;">${escapeHtml(rootDisplayLabel)}</span>
                            <input type="radio" name="tree-selector-radio" value="${startNode.id}" ${disabled ? 'disabled' : ''} style="margin:0; width:18px; height:18px; flex-shrink:0; cursor:pointer;">
                        </div>
                    </div>
                    <div class="tree-children-${startNode.id}" style="display:none; padding-left:20px;"></div>
                </div>
            `;
        }

        html += renderTreeNodes(startNode, 0);
        return html || '<div style="padding:20px;text-align:center;color:#94a3b8;">没有可用的节点</div>';
    }

    const searchHtml = showSearch ? `
        <div style="margin-bottom:12px;">
            <input type="text" id="tree-search-input" placeholder="🔍 搜索节点名称、ID或路径..." style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">
        </div>
    ` : '';

    const { panel, close } = createModal({
        title,
        content: searchHtml + `<div id="tree-container-inner">${renderContent()}</div>`,
        maxWidth: '1500px',
        maxHeight: '750px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); if (onCancel) onCancel(); } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const nodeId = getSelectedNodeId();
                if (!nodeId) {
                    showToast('请选择一个节点', 'error');
                    return false;
                }
                const node = getNodeById(nodeId);
                if (!node) {
                    showToast('节点不存在', 'error');
                    return false;
                }
                if (isDisabled && isDisabled(node)) {
                    showToast('该节点不可选', 'error');
                    return false;
                }
                close();
                onConfirm(nodeId);
            }}
        ],
        closeOnOverlay: true,
        closeOnEscape: true,
    });

    const searchInput = panel.querySelector('#tree-search-input');
    const container = panel.querySelector('#tree-container-inner');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            searchTerm = this.value;
            container.innerHTML = renderContent();
            container.querySelectorAll('.tree-toggle-btn').forEach(btn => {
                btn.removeEventListener('click', handleToggle);
                btn.addEventListener('click', handleToggle);
            });
            container.querySelectorAll('.tree-node-wrapper').forEach(wrapper => {
                wrapper.removeEventListener('click', handleSelect);
                wrapper.addEventListener('click', handleSelect);
            });
        });
    }

    function handleToggle(e) {
        e.stopPropagation();
        const btn = this;
        const wrapper = btn.closest('.tree-node-wrapper');
        if (!wrapper) return;
        const id = wrapper.dataset.id;
        const childrenDiv = wrapper.querySelector(`.tree-children-${id}`);
        if (childrenDiv) {
            const isHidden = childrenDiv.style.display === 'none';
            childrenDiv.style.display = isHidden ? 'block' : 'none';
            btn.textContent = isHidden ? '▼' : '▶';
            wrapper.dataset.expanded = isHidden ? 'true' : 'false';
        }
    }

    function handleSelect(e) {
        e.stopPropagation();
        const wrapper = this.closest('.tree-node-wrapper');
        if (!wrapper) return;
        const radio = wrapper.querySelector('input[type="radio"]');
        if (radio && !radio.disabled) {
            radio.checked = true;
        }
    }

    container.querySelectorAll('.tree-toggle-btn').forEach(btn => {
        btn.addEventListener('click', handleToggle);
    });
    container.querySelectorAll('.tree-node-wrapper').forEach(wrapper => {
        wrapper.addEventListener('click', handleSelect);
    });

    panel.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const confirmBtn = panel.querySelector('.btn-row .btn-primary');
            if (confirmBtn) confirmBtn.click();
        }
    });
}

// ================================================================
// 内部辅助：取子节点对象列表（支持真实节点与虚拟合成节点）
// 真实节点：childOrder[id] 是 id 数组 → 转成对象数组
// 虚拟合成节点：node.children 是对象数组（由 view/dataAdapter 构建）
// ================================================================
function getChildNodes(state, node) {
    if (node._virtual) {
        return node.children || [];
    }
    const childIds = state.childOrder[node.id];
    if (!childIds) return [];
    const out = [];
    for (const cid of childIds) {
        const c = state.nodes[cid];
        if (c) out.push(c);
    }
    return out;
}