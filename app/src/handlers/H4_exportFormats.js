// ================================================================
// Markdown / CSV 导出（handlers/H4_exportFormats.js）
// 职责：从 state 导出 Markdown / CSV 文件
// 依赖：A_constants.js
// ================================================================

import { STATUS2_LABELS } from '../A_constants.js';
import { viewValue, viewDerived } from '../view/scope.js';

// ----- Toast 事件（解耦 UI） -----
function showToast(msg, type = 'info') {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { message: msg, type } }));
}

// ----- 时间戳 -----
function makeTimestamp() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
}

// ----- 收集 P 节点行 -----
// 导出的是"**我看到的那份**" —— 值级与派生字段都按当前查看范围取，
// 否则导出的 CSV/Markdown 会和界面上看到的对不上（尤其在看别人/看团队时）。
function collectPRows(state) {
    const rows = [];
    const rootId = state.rootId;
    if (!rootId) return rows;

    function walk(node, path) {
        if (node.type === 'P') {
            const problemId = viewValue(state, node, 'problemId') || '';
            const name = viewValue(state, node, 'name') || '';
            const ratioRaw = viewValue(state, node, 'ratio');
            const ratio = ratioRaw ? parseFloat(ratioRaw).toFixed(2) + '%' : '';
            const difficulty = viewDerived(state, node, 'xcpcDifficulty') || '-';
            // ⚠️ 导出**永远读"自己那份"**，不许换成 `viewDerivedDisplay`：
            //    导出的是**数据**，不该随"判重/合并显示"这个显示开关变
            //    （否则同一份数据导两次内容不一样，也没法再导回去）。
            const status = STATUS2_LABELS[viewDerived(state, node, 'status2')] || '';
            const tagsRaw = viewValue(state, node, 'tags');
            const tags = (Array.isArray(tagsRaw) ? tagsRaw : [])
                .map(t => (t && t.text !== undefined ? t.text : t)).join(', ');
            rows.push({
                path,
                problemId,
                name,
                ratio,
                difficulty,
                status,
                tags,
                link: viewValue(state, node, 'link') || ''
            });
        }
        const childIds = state.childOrder[node.id];
        for (const cid of childIds) {
            const child = state.nodes[cid];
            if (!child) continue;
            walk(child, path + ' > ' + (viewValue(state, child, 'name') || viewValue(state, child, 'problemId') || '未命名'));
        }
    }

    for (const cid of state.childOrder[rootId]) {
        const child = state.nodes[cid];
        if (!child) continue;
        walk(child, viewValue(state, child, 'name') || '根');
    }
    return rows;
}

// ----- 导出 Markdown -----
export function exportMarkdown(state) {
    // ⚠️ **空树 / 没题目也允许导出**：出来的就是一份只有表头的 Markdown —— 不拦。
    const rows = collectPRows(state);

    function escapeMarkdownCell(str) {
        if (str === undefined || str === null) return '';
        return String(str).replace(/\|/g, '\\|');
    }

    let md = '| 路径 | 题号 | 名称 | 过题比例 | XCPC难度 | 状态 | 标签 | 链接 |\n';
    md += '|------|------|------|----------|----------|------|------|------|\n';
    for (const r of rows) {
        md += `| ${escapeMarkdownCell(r.path)} | ${escapeMarkdownCell(r.problemId)} | ${escapeMarkdownCell(r.name)} | ${escapeMarkdownCell(r.ratio)} | ${escapeMarkdownCell(r.difficulty)} | ${escapeMarkdownCell(r.status)} | ${escapeMarkdownCell(r.tags)} | ${escapeMarkdownCell(r.link)} |\n`;
    }

    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `AcmTree_${makeTimestamp()}.md`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Markdown 导出成功', 'success');
}

// ----- 导出 CSV -----
export function exportCSV(state) {
    // 同 `exportMarkdown`：空树 / 没题目也允许导出（表头-only 的 CSV）。
    const rows = collectPRows(state);

    function escapeCSV(str) {
        if (str === undefined || str === null) return '';
        str = String(str);
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    }

    const header = ['路径', '题号', '名称', '过题比例', 'XCPC难度', '状态', '标签', '链接'];
    let csv = header.map(escapeCSV).join(',') + '\n';
    for (const r of rows) {
        const fields = [r.path, r.problemId, r.name, r.ratio, r.difficulty, r.status, r.tags, r.link];
        csv += fields.map(escapeCSV).join(',') + '\n';
    }

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = `AcmTree_${makeTimestamp()}.csv`;
    a.href = url;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('CSV 导出成功', 'success');
}