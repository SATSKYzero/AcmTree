// ================================================================
// 映射对话框（G3_mapping.js）
// ================================================================
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';

// ================================================================
// 字段映射对话框（用于批量导入）
// ================================================================
export function showMappingDialog({ title, fileKeys, systemFields, storedMapping, onConfirm }) {
    let selectsHtml = '';
    fileKeys.forEach(key => {
        const storedVal = storedMapping[key] || '';
        selectsHtml += `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <span style="width:120px;font-weight:500;">${key}</span>
                <select id="map-${key}" style="flex:1;padding:4px;">
                    <option value="">（忽略）</option>
                    ${systemFields.map(f => `<option value="${f}" ${f === storedVal ? 'selected' : ''}>${f}</option>`).join('')}
                </select>
            </div>
        `;
    });
    const html = `
        <p style="font-size:13px;color:#6b7280;">将JSON中的属性名映射到系统字段（不映射则忽略）</p>
        <div style="margin:12px 0;">${selectsHtml}</div>
    `;
    const { close } = createModal({
        title,
        content: html,
        maxWidth: '600px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            { label: '开始导入', className: 'btn btn-primary', callback: () => {
                const mapping = {};
                let hasMapping = false;
                fileKeys.forEach(key => {
                    const select = document.getElementById(`map-${key}`);
                    if (select && select.value) {
                        mapping[key] = select.value;
                        hasMapping = true;
                    }
                });
                if (!hasMapping) {
                    showToast('至少映射一个字段', 'error');
                    return false;
                }
                close();
                onConfirm(mapping);
            }}
        ]
    });
}

// ================================================================
// 题目信息批量导入对话框
// ================================================================
export function showProblemInfoDialog({ pNodes, editableProps, onExecute }) {
    const propOptions = editableProps.map(p => `<option value="${p.key}">${p.label}</option>`).join('');
    const html = `
        <p style="font-size:13px;color:#6b7280;margin-bottom:12px;">
            选择赋值模式：
            <strong>按序赋值</strong> – 每行对应一个题目（按顺序），空行跳过，行数不超过题目总数。
            <strong>指定题号赋值</strong> – 每两行为一组（题号 + 值），行数为偶数，题号必须存在且不重复。
        </p>
        <label>选择要修改的属性：</label>
        <select id="batch-property-select" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-bottom:10px;">${propOptions}</select>
        <label>排序方式（仅按序赋值有效）：</label>
        <select id="batch-sort-select" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-bottom:10px;">
            <option value="position">按当前位置（现有顺序）</option>
            <option value="id">按题号排序</option>
        </select>
        <label>赋值模式：</label>
        <select id="batch-mode-select" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;margin-bottom:10px;">
            <option value="sequential">按序赋值</option>
            <option value="specified">指定题号赋值</option>
        </select>
        <label>输入内容（支持 CLEAR 指令清空）：</label>
        <textarea id="batch-textarea" rows="10" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ccc;font-size:14px;font-family:monospace;" placeholder="每行一个值（按序赋值）或 题号/值 成对（指定题号赋值）..."></textarea>
    `;
    const { panel, close } = createModal({
        title: '题目信息批量导入',
        content: html,
        maxWidth: '650px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            { label: '执行', className: 'btn btn-primary', callback: async () => {
                const propKey = panel.querySelector('#batch-property-select').value;
                const sortMode = panel.querySelector('#batch-sort-select').value;
                const mode = panel.querySelector('#batch-mode-select').value;
                const textarea = panel.querySelector('#batch-textarea');
                const lines = textarea.value.split('\n').map(s => s.trim());
                try {
                    const result = await onExecute(propKey, sortMode, mode, lines);
                    if (result !== false) {
                        close();
                    }
                } catch (err) {
                    showToast('执行失败: ' + err.message, 'error');
                }
                return false;
            }}
        ]
    });
}