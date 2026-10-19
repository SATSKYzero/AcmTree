// ================================================================
// 编辑：备注、节点（ui/G_modal/G4_edit.js）
// 职责：编辑节点属性、备注
//
// ⚠️ 字段清单、校验、提交（冲突确认 + 走 ops 写库）**不在本文件** ——
//    它们与节点信息大界面的「✏️ 编辑」页共用 `ui/G_modal/editForm.js`
//    （同一个描述、同一套规则；本文件只负责"以弹窗形式呈现"）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { updateRemark } from '../../core/ops/node.js';
import { escapeHtml } from '../../utils/html.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showFormDialog, renderEditFieldsHtml, readEditValues } from './G2_common.js';
import { showTagManager } from './G3_tag.js';
import { buildEditForm, validateEdit, confirmEditAnomalies, applyEdit } from './editForm.js';
// 手改的判据是"用户在输入框里**敲过字**"（input 事件 = 不可能被程序伪造
// 的信号）。弹窗打开时清空会话，点「确定」时取这份清单 —— 见 manualInput.js。
import { beginInputSession } from './manualInput.js';
// 值级来源的三个动作（优先/不用/取消偏好）：**import 即注册**委托监听，
// 这样 P 弹窗与 W/S/C 弹窗（走 showFormDialog 的 field.hint）都能用同一套按钮。
import './sourceActions.js';

// ================================================================
// 内部辅助
// ================================================================

function findVNodeAnywhere(vId) {
    for (const pid in AppState.pages) {
        const page = AppState.pages[pid];
        const v = page.virtualIndex[vId];
        if (v) return { pageId: pid, vNode: v };
    }
    return null;
}

// ================================================================
// 备注编辑
// ================================================================
export function editRemark(nodeId) {
    const node = AppState.nodes[nodeId];
    if (!node) { showToast('节点不存在', 'error'); return; }
    const currentRemark = node.remark || '';

    // ⚠️ 提醒文案：
    //    remark 是**节点字段**，节点表整张进撤销快照（`transaction/history.js` 的
    //    `nodes`），所以备注越长，每一条撤销快照就越大、越占内存。
    //    **只提示，不限制输入长度** —— 想写长文章仍然写得下。
    const html = `
        <label>备注内容（支持多行）：</label>
        <div style="margin:2px 0 6px; padding:6px 8px; border-radius:6px;
                    background:#fffbeb; border:1px solid #fde68a; color:#92400e; font-size:12px; line-height:1.5;">
            ⚠️ 别在这里放「大量文本」：备注会随节点一起进「撤销快照」，写得越长，
            每一步撤销占的内存越多（建议只记要点；长文档请放在外部文件里）。
        </div>
        <textarea id="remark-textarea" rows="8" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;font-family:monospace;resize:vertical;">${escapeHtml(currentRemark)}</textarea>
    `;

    const { panel, close } = createModal({
        title: '编辑备注',
        content: html,
        maxWidth: '500px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            {
                label: '保存',
                className: 'btn btn-primary',
                callback: async () => {
                    const textarea = panel.querySelector('#remark-textarea');
                    const newRemark = textarea ? textarea.value : '';
                    if (newRemark === currentRemark) {
                        close();
                        return false;
                    }
                    try {
                        await execute(
                            (draft) => {
                                // 走统一入口 —— 只读守卫 + 手改留痕（remark 是 note 元素）
                                updateRemark(draft, nodeId, newRemark);
                            },
                            {
                                refreshParentId: nodeId,
                                onSuccess: () => {
                                    showToast('备注已更新', 'success');
                                    close();
                                },
                                onError: (err) => {
                                    showToast('保存失败: ' + err.message, 'error');
                                }
                            }
                        );
                    } catch (_) {}
                    return false;
                }
            }
        ]
    });
}

// ================================================================
// 编辑节点
// @param {string} id - 节点 id（真实或虚拟）
// @returns {Promise<{ success: boolean, error?: string }>}
// ================================================================
export function editNode(id) {
    return new Promise((resolve) => {
        // ---- 虚拟节点重定向 ----
        const vInfo = findVNodeAnywhere(id);
        if (vInfo) {
            const { vNode } = vInfo;
            if (vNode && vNode.refId && AppState.nodes[vNode.refId]) {
                showToast('正在编辑对应的真实节点...', 'info');
                editNode(vNode.refId).then(resolve);
                return;
            }
            resolve({ success: false, error: '无法找到对应的真实节点' });
            return;
        }

        const node = AppState.nodes[id];
        if (!node) {
            resolve({ success: false, error: '节点不存在' });
            return;
        }

        const type = node.type;

        // ============================================================
        // R 节点
        // ============================================================
        if (type === 'R') {
            // 字段清单 + 来源面板 + 只读「运行信息」块都在共享描述里（editForm.js）
            const { fields, extFields } = buildEditForm(node);
            // 第 4 个参数 = **关框前**的校验：不过就别关（值一个字不改）。
            // 合成节点的「合成标识」被占用 / 用了保留前缀时，用户要能就地改。
            showFormDialog('编辑提交记录', [...fields, ...extFields], async (res) => {
                if (!res) { resolve({ success: false, error: '用户取消' }); return; }   // ★ 取消 ⇒ 中止
                resolve(await applyEdit(id, res));
            }, (res) => validateEdit(id, res));
            return;
        }

        // ============================================================
        // P 节点
        // ============================================================
        if (type === 'P') {
            // 字段清单（含每个字段的来源面板 hint）来自共享描述 —— 与「✏️ 编辑」页同一份
            const { fields, extFields } = buildEditForm(node);
            const allFields = [...fields, ...extFields];
            let formHtml = renderEditFieldsHtml(allFields);
            // 「管理标签」是 P 弹窗特有的入口：showFormDialog 不支持自定义按钮，
            // 所以这个弹窗的壳子仍由 createModal 建（渲染与读值照样走共享件）
            formHtml += `<div style="margin-top:12px;"><button class="btn btn-warning" id="tag-manager-btn">🏷️ 管理标签</button></div>`;

            // ★ 新的一次弹窗会话：清空"用户敲过字的字段"集合。
            //   必须在这里（弹窗打开时）清，而不是 createModal 里 —— 点「确定」
            //   时可能弹出二级确认框（confirmAnomalies），那也会走 createModal，
            //   若在那里清空会把本次会话的证据冲掉。
            beginInputSession();

            const { panel, close } = createModal({
                title: '编辑题目',
                content: formHtml,
                maxWidth: '550px',
                buttons: [
                    { label: '取消', className: 'btn', callback: () => { close(); resolve({ success: false, error: '用户取消' }); } },
                    { label: '确定', className: 'btn btn-primary', callback: async () => {
                        const read = readEditValues(panel, allFields);
                        if (!read.ok) { showToast(read.error, 'error'); return false; }
                        const check = validateEdit(id, read.values);
                        if (!check.ok) { showToast(check.error, 'error'); return false; }
                        // P 弹窗的顺序：**先确认冲突、再关框**（用户取消时框还留着）
                        const confirm = await confirmEditAnomalies(id, read.values);
                        if (!confirm.ok) {
                            if (confirm.error !== '用户取消') showToast(confirm.error || '无法保存', 'error');
                            return false;
                        }
                        close();
                        resolve(await applyEdit(id, read.values));
                        return false;
                    }}
                ]
            });

            const tagBtn = panel.querySelector('#tag-manager-btn');
            if (tagBtn) {
                tagBtn.addEventListener('click', () => {
                    close();
                    showTagManager(id);
                });
            }
            return;
        }

        // ============================================================
        // W / S / C 节点
        // ============================================================
        if (['W', 'S', 'C'].includes(type)) {
            // 字段清单（W/S/C 各自差一个字段）来自共享描述
            const { fields, extFields } = buildEditForm(node);
            // 同上：`validateEdit` 在校验不过时**不让框关**（合成标识被占用 / 保留前缀）
            showFormDialog('编辑节点', [...fields, ...extFields], async (res) => {
                if (!res) { resolve({ success: false, error: '用户取消' }); return; }   // ★ 取消 ⇒ 中止
                const confirm = await confirmEditAnomalies(id, res);
                if (!confirm.ok) { resolve({ success: false, error: confirm.error || '用户取消' }); return; }
                resolve(await applyEdit(id, res));
            }, (res) => validateEdit(id, res));
            return;
        }

        resolve({ success: false, error: '不支持的节点类型' });
    });
}