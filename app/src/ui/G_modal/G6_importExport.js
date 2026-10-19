// ================================================================
// 导入导出模态框（ui/G_modal/G6_importExport.js）
// 职责：导出类型选择模态框、导入触发
// 依赖：createModal (G1_core.js), shell/state.js,
//       handlers/H_importExport.js, A_constants.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { createModal } from './G1_core.js';
import {
    exportFullJSON,
    exportFullCompressedJSON,
    exportMarkdown,
    exportCSV
} from '../../handlers/H_importExport.js';

// ================================================================
// 导入模态框
// 只有完整导入，直接触发文件选择
// ================================================================
export function showImportModal() {
    document.getElementById('file-input-full')?.click();
}

// ================================================================
// 导出模态框
// ================================================================
export function showExportModal() {
    const html = `
        <p style="font-size:13px; color:#6b7280; margin-bottom:8px;">选择导出类型：</p>
        <select id="export-type-select" style="width:100%; padding:6px 10px; border:1px solid #d1d5db; border-radius:6px; font-size:14px;">
            <option value="full">📦 导出完整数据</option>
            <option value="full-gz">📦 导出完整数据 (.gz)</option>
            <option value="md">📝 导出 Markdown</option>
            <option value="csv">📊 导出 CSV</option>
        </select>
    `;
    const { panel, close } = createModal({
        title: '📤 导出数据',
        content: html,
        maxWidth: '400px',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            { label: '确定', className: 'btn btn-primary', callback: () => {
                const select = panel.querySelector('#export-type-select');
                const value = select ? select.value : 'full';
                close();
                switch (value) {
                    case 'full': exportFullJSON(AppState); break;
                    case 'full-gz': exportFullCompressedJSON(AppState); break;
                    case 'md': exportMarkdown(AppState); break;
                    case 'csv': exportCSV(AppState); break;
                }
            }}
        ]
    });
}