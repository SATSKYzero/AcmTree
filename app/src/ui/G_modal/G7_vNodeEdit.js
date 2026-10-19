// ================================================================
// 副页节点编辑对话框（ui/G_modal/G7_vNodeEdit.js）
// 职责：编辑副页 vNode 自身的字段（由插件注册）
// 依赖：shell/state.js, shell/executor.js,
//       core/pluginRegistry.js, core/ops/account.js（只读守卫）,
//       utils/A_helpers.js,
//       G1_core.js, G1_toast.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { getVNodeEditorExtensions } from '../../core/pluginRegistry.js';
import { assertManualEditAllowed } from '../../core/ops/account.js';
import { escapeHtml } from '../../utils/html.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';

export function editVNode(pageId, vId) {
    return new Promise((resolve) => {
        const page = AppState.pages[pageId];
        if (!page) {
            showToast('副页不存在', 'error');
            resolve({ success: false, error: '副页不存在' });
            return;
        }
        const vNode = page.virtualIndex[vId];
        if (!vNode) {
            showToast('虚拟节点不存在', 'error');
            resolve({ success: false, error: '虚拟节点不存在' });
            return;
        }

        const exts = getVNodeEditorExtensions(vNode);
        const realNode = vNode.refId ? AppState.nodes[vNode.refId] : null;

        // ---- 只读信息（灰显） ----
        let readonlyHtml = '';
        if (realNode) {
            readonlyHtml = `
                <div style="background:#f8fafc; padding:12px; border-radius:8px; margin-bottom:12px; font-size:13px; color:#64748b;">
                    <div>映射主树节点：<span style="color:#94a3b8;">${escapeHtml(realNode.name || realNode.problemId || realNode.id)}</span></div>
                    <div>类型：<span style="color:#94a3b8;">${escapeHtml(vNode.type)}</span></div>
                </div>
            `;
        } else if (vNode.type === 'O') {
            readonlyHtml = `
                <div style="background:#f8fafc; padding:12px; border-radius:8px; margin-bottom:12px; font-size:13px; color:#64748b;">
                    <div>副页根节点</div>
                </div>
            `;
        }

        if (exts.length === 0) {
            const { close } = createModal({
                title: '编辑副页节点',
                content: readonlyHtml + '<p style="color:#94a3b8; font-size:14px;">该节点暂无可编辑字段。</p>',
                maxWidth: '500px',
                buttons: [
                    { label: '关闭', className: 'btn', callback: () => {
                        close();
                        resolve({ success: false, error: '无字段' });
                    }}
                ]
            });
            return;
        }

        // ---- 扩展字段 HTML ----
        let formHtml = readonlyHtml;
        exts.forEach((ext, extIdx) => {
            ext.fields.forEach(f => {
                const curVal = String(vNode[f.key] ?? f.default ?? '');
                formHtml += `<label>${escapeHtml(f.label)}`;
                if (f.type === 'select') {
                    // ⚠️ 当前值不在选项里就补进去 —— `<select>` 里没有的选项赋值会落成**空串**，
                    // 于是"状态是自造缩写"（`HACK`/`PC`/`JG`…）的副页节点一保存就被抹掉。
                    const opts = [...(f.options || [])];
                    if (curVal && !opts.includes(curVal)) opts.push(curVal);
                    formHtml += `<select id="vnode-field-${extIdx}__${f.key}" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">`;
                    for (const opt of opts) {
                        const selected = (String(opt) === curVal) ? 'selected' : '';
                        formHtml += `<option value="${escapeHtml(String(opt))}" ${selected}>${escapeHtml(String(opt))}</option>`;
                    }
                    formHtml += `</select>`;
                } else {
                    const minAttr = f.min !== undefined ? ` min="${f.min}"` : '';
                    const maxAttr = f.max !== undefined ? ` max="${f.max}"` : '';
                    formHtml += `<input type="${f.type || 'text'}" id="vnode-field-${extIdx}__${f.key}" value="${escapeHtml(curVal)}"${minAttr}${maxAttr} style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-top:4px;">`;
                }
                formHtml += `</label>`;
            });
        });

        const { panel, close } = createModal({
            title: '编辑副页节点',
            content: formHtml,
            maxWidth: '500px',
            buttons: [
                { label: '取消', className: 'btn', callback: () => {
                    close();
                    resolve({ success: false, error: '用户取消' });
                }},
                { label: '确定', className: 'btn btn-primary', callback: async () => {
                    // 收集扩展字段数据
                    const formData = {};
                    exts.forEach((ext, extIdx) => {
                        ext.fields.forEach(f => {
                            const el = panel.querySelector(`#vnode-field-${extIdx}__${f.key}`);
                            if (el) formData[f.key] = el.value;
                        });
                    });

                    close();
                    try {
                        await execute(
                            (draft) => {
                                // 只读边界：真实节点的"编辑本身"靠 `updateP`
                                // 先抛间接拦住；副页这条链**没有任何被守卫的 ops 调用**，
                                // 于是插件的扩展字段在只读时能直接写进 vNode。
                                // 这里按同一条规则补上守卫（规则在 core，UI 只负责调用）。
                                assertManualEditAllowed(draft, '编辑副页节点');
                                const pageCopy = draft.pages[pageId];
                                if (!pageCopy) throw new Error('副页不存在');
                                const vNodeCopy = pageCopy.virtualIndex[vId];
                                if (!vNodeCopy) throw new Error('虚拟节点不存在');
                                for (const ext of exts) {
                                    ext.apply(draft, pageId, vId, formData);
                                }
                            },
                            {
                                validate: false,
                                refreshParentId: null,
                                onSuccess: () => {
                                    showToast('副页节点已更新', 'success');
                                    resolve({ success: true });
                                },
                                onError: (err) => {
                                    showToast('保存失败: ' + err.message, 'error');
                                    resolve({ success: false, error: err.message });
                                }
                            }
                        );
                    } catch (err) {
                        resolve({ success: false, error: err.message });
                    }
                    return false;
                }}
            ]
        });
    });
}