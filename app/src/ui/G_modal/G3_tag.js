// ================================================================
// 标签管理（ui/G_modal/G3_tag.js）
// 职责：管理 P 节点标签
// 依赖：shell/state.js, shell/executor.js, core/ops/tag.js,
//       utils/A_helpers.js, A_constants.js,
//       G1_core.js, G1_toast.js, G2_common.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { addTag, deleteTag, moveTagUp, moveTagDown } from '../../core/ops/tag.js';
import { escapeHtml } from '../../utils/html.js';
import { TAG_COLORS, TAG_COLOR_NAMES, EVENTS } from '../../A_constants.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showDeleteConfirm } from './G2_common.js';

// ================================================================
// 标签管理对话框
// ================================================================
export function showTagManager(pId) {
    const node = AppState.nodes[pId];
    if (!node || node.type !== 'P') {
        showToast('不是题目节点', 'error');
        return;
    }

    const { panel, close } = createModal({
        title: '管理标签',
        content: '<div id="tag-list-container"></div>',
        maxWidth: '550px',
        buttons: [
            { label: '关闭', className: 'btn', callback: () => {
                close();
                document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, {
                    detail: { parentId: pId }
                }));
            }}
        ]
    });

    const listContainer = panel.querySelector('#tag-list-container');

    // ---- 事件委托 ----
    listContainer.addEventListener('click', async (e) => {
        const target = e.target;

        // 上移
        const upBtn = target.closest('.tag-up');
        if (upBtn) {
            const tagId = upBtn.dataset.id;
            await runTagOp(pId, (draft) => {
                moveTagUp(draft, pId, tagId);
            }, () => {
                renderTags();
                showToast('标签上移成功', 'success');
            });
            return;
        }

        // 下移
        const downBtn = target.closest('.tag-down');
        if (downBtn) {
            const tagId = downBtn.dataset.id;
            await runTagOp(pId, (draft) => {
                moveTagDown(draft, pId, tagId);
            }, () => {
                renderTags();
                showToast('标签下移成功', 'success');
            });
            return;
        }

        // 删除
        const delBtn = target.closest('.tag-del');
        if (delBtn) {
            const tagId = delBtn.dataset.id;
            showDeleteConfirm('删除标签', '确定要删除此标签吗？', async (confirmed) => {
                if (!confirmed) return;
                await runTagOp(pId, (draft) => {
                    deleteTag(draft, pId, tagId);
                }, () => {
                    renderTags();
                    showToast('标签已删除', 'success');
                });
            });
            return;
        }

        // 添加
        const addBtn = target.closest('#add-tag-btn');
        if (addBtn) {
            const textInput = listContainer.querySelector('#new-tag-text');
            const colorSelect = listContainer.querySelector('#new-tag-color');
            const text = textInput ? textInput.value.trim() : '';
            if (!text) { showToast('请输入标签文字', 'error'); return; }
            const color = colorSelect ? colorSelect.value : '无色';
            await runTagOp(pId, (draft) => {
                addTag(draft, pId, text, color);
            }, () => {
                if (textInput) textInput.value = '';
                renderTags();
                showToast('标签已添加', 'success');
            });
            return;
        }
    });

    // ---- 渲染标签列表 ----
    function renderTags() {
        const current = AppState.nodes[pId];
        if (!current) {
            listContainer.innerHTML = '<div style="padding:8px;color:#94a3b8;">节点已不存在</div>';
            return;
        }
        const currentTags = current.tags || [];
        let html = '<div class="tag-list">';
        if (currentTags.length === 0) {
            html += '<div style="padding:8px;color:#94a3b8;">暂无标签</div>';
        } else {
            currentTags.forEach((tag, idx) => {
                const bg = TAG_COLORS[tag.color] || '#ffffff';
                html += `
                    <div class="tag-item">
                        <span class="tag-color-sample" style="background-color:${bg};"></span>
                        <span class="tag-text">${escapeHtml(tag.text)}</span>
                        <button class="btn-icon tag-up" data-id="${tag.id}" ${idx === 0 ? 'disabled' : ''}>⬆</button>
                        <button class="btn-icon tag-down" data-id="${tag.id}" ${idx === currentTags.length - 1 ? 'disabled' : ''}>⬇</button>
                        <button class="btn-icon btn-danger tag-del" data-id="${tag.id}">✖</button>
                    </div>
                `;
            });
        }
        html += '</div>';
        html += `
            <div style="display:flex;gap:8px;margin-top:12px;align-items:center;">
                <input type="text" id="new-tag-text" placeholder="标签文字" style="flex:2;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">
                <select id="new-tag-color" style="flex:1;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;">
                    ${TAG_COLOR_NAMES.map(c => `<option value="${c}">${c}</option>`).join('')}
                </select>
                <button class="btn btn-primary" id="add-tag-btn">添加</button>
            </div>
        `;
        listContainer.innerHTML = html;
    }

    renderTags();
}

// ================================================================
// 内部辅助：标签事务包装
// ================================================================
async function runTagOp(pId, operation, onSuccess) {
    try {
        await execute(
            (draft) => {
                operation(draft);
            },
            {
                refreshParentId: pId,
                onSuccess: () => {
                    if (onSuccess) onSuccess();
                },
                onError: (err) => {
                    showToast('操作失败: ' + err.message, 'error');
                }
            }
        );
    } catch (_) {
        // onError 已处理
    }
}