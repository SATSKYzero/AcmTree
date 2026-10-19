// ================================================================
// 复制：复制节点、复制到副页（ui/G_modal/G4_copy.js）
// 职责：主树内复制 + 复制到副页
// 依赖：shell/state.js, shell/executor.js, core/ops/page.js,
//       core/model/constants.js, view/dataAdapter.js,
//       utils/A_helpers.js, A_constants.js,
//       G1_core.js, G1_toast.js, G2_selector.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { copyRealNodeToPage } from '../../core/ops/page.js';
import { TYPE_CHILDREN_MAP } from '../../core/model/constants.js';
import { buildVirtualTreeRoot } from '../../view/dataAdapter.js';
import { escapeHtml } from '../../utils/html.js';
import { EVENTS } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showTreeSelector } from './G2_selector.js';
// ★「选一个副页」的列表 / 选项文本 / 读回 / 校验**只有一份**（用户 2026-10-14："收成一份共用件"）
import { pageChoicesOf, pageSelectHtml, readPagePicker } from '../kit/pagePicker.js';

/** 本弹窗那个副页下拉的 id（新建框的 id 由它推，见 `kit/pagePicker.js`） */
const COPY_PAGE_SELECT_ID = 'copy-to-page-select';

// ================================================================
// 复制节点（主树）—— 派发事件，由入口层处理
// ================================================================
export function promptCopyNode(sourceId) {
    return new Promise((resolve) => {
        document.dispatchEvent(new CustomEvent(EVENTS.COPY_NODE, {
            detail: { sourceId, resolve }
        }));
    });
}

// ================================================================
// 复制到副页
// ================================================================
export function promptCopyToPage(sourceId) {
    const sourceNode = AppState.nodes[sourceId];
    if (!sourceNode) {
        showToast('节点不存在', 'error');
        return;
    }
    if (!['W', 'S', 'C', 'P'].includes(sourceNode.type)) {
        showToast('该类型节点不适合复制到副页', 'error');
        return;
    }

    const pages = pageChoicesOf(AppState);
    if (pages.length === 0) {
        showToast('请先创建副页', 'error');
        return;
    }

    const selectHtml = `
        <p style="margin:8px 0;">将节点「${escapeHtml(sourceNode.name || sourceNode.problemId || '未命名')}」复制到副页</p>
        ${pageSelectHtml(AppState, { selectId: COPY_PAGE_SELECT_ID, label: '选择目标副页：' })}
        <label style="margin-top:10px;">
            <input type="checkbox" id="copy-recursive-checkbox" checked> 递归复制子节点
        </label>
    `;
    const { panel: panel1, close: close1 } = createModal({
        title: '复制到副页',
        content: selectHtml,
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close1(); } },
            { label: '下一步', className: 'btn btn-primary', callback: async () => {
                // 「选哪个副页」的读回与校验只有一份（`ui/kit/pagePicker.js`）
                const picked = readPagePicker(panel1, { selectId: COPY_PAGE_SELECT_ID });
                if (picked.error) { showToast(picked.error, 'error'); return false; }
                const pageId = picked.pageId;
                const recursive = panel1.querySelector('#copy-recursive-checkbox')?.checked || false;
                close1();

                const pageData = AppState.pages[pageId];
                if (!pageData) { showToast('副页不存在', 'error'); return; }

                const rootData = buildVirtualTreeRoot(AppState, pageId);
                if (!rootData) {
                    // 副页无根 —— 直接复制到根
                    await commitCopyToPage(sourceId, pageId, null, recursive);
                    return false;
                }

                // ---- 检查是否有可进入的父节点（非 R、非空） ----
                let hasValidParent = false;
                function checkNode(node) {
                    if (node.type !== 'R' && node.type !== 'O') {
                        hasValidParent = true;
                        return;
                    }
                    if (node.children) {
                        for (const child of node.children) {
                            checkNode(child);
                            if (hasValidParent) break;
                        }
                    }
                }
                checkNode(rootData);

                if (!hasValidParent) {
                    await commitCopyToPage(sourceId, pageId, null, recursive);
                    return false;
                }

                // ---- 弹出树选择器 ----
                showTreeSelector(AppState, {
                    title: '选择目标父节点（选中的节点将成为父节点）',
                    rootNode: rootData,
                    filter: (node) => node.type !== 'R',
                    isDisabled: (node) => {
                        if (node.type === 'O') return false;
                        const realNode = AppState.nodes[node._refId];
                        if (!realNode) return true;
                        const allowed = TYPE_CHILDREN_MAP[realNode.type] || [];
                        return !allowed.includes(sourceNode.type);
                    },
                    showRoot: true,
                    rootLabel: `📁 ${pageData.name} (根)`,
                    onConfirm: async (parentVirtualId) => {
                        await commitCopyToPage(sourceId, pageId, parentVirtualId, recursive);
                    },
                    onCancel: () => {}
                });
                return false;
            }}
        ]
    });
}

// ================================================================
// 提交复制
// ================================================================
async function commitCopyToPage(sourceId, pageId, parentVirtualId, recursive) {
    try {
        await execute(
            (draft) => {
                copyRealNodeToPage(draft, sourceId, pageId, parentVirtualId, recursive);
            },
            {
                refreshParentId: null,
                onSuccess: () => {
                    showToast('节点已复制到副页', 'success');
                    document.dispatchEvent(new CustomEvent(EVENTS.PAGE_DATA_CHANGED, {
                        detail: { pageId }
                    }));
                },
                onError: (err) => {
                    showToast('复制失败: ' + err.message, 'error');
                }
            }
        );
    } catch (_) {
        // onError 已处理
    }
}

// ================================================================
// 内部辅助
// ================================================================
// ⚠️ 原来这里有一份 `getPagesList`（"页列表"的第三份实现）—— 已收进 `ui/kit/pagePicker.js:pageChoicesOf`
//    （连计数口径一起：三处曾各写一遍，其中一处还少了 `max(0, …)`）。**别再加回来。**