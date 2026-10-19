// ================================================================
// 失败明细（features/AutoImport/ui/failures.js）
//
// 按原因码分组 + 逐条 `⛔ [code] 标识 — reason`。
// ================================================================
import { escapeHtml as esc } from '../../../utils/html.js';

export function renderImportFailures(wrap, v) {
    const last = v && v.lastImport;
    const list = (last && Array.isArray(last.failures)) ? last.failures : [];
    if (!list.length) return;

    const box = document.createElement('div');
    box.className = 'ai-failures';
    box.dataset.failed = String(list.length);
    box.style.cssText = 'margin:8px 0 2px 0; padding:10px 12px; background:#fef2f2; border:1px solid #fecaca;'
        + ' border-radius:6px; font-size:12px; color:#991b1b; line-height:1.8;';

    // 按原因码分组（"179 条 parent-not-found" 比 179 行字有用得多）
    const byCode = new Map();
    for (const f of list) {
        const code = (f && f.code) || '(未知)';
        byCode.set(code, (byCode.get(code) || 0) + 1);
    }
    const head = document.createElement('div');
    head.className = 'ai-failures-head';
    head.innerHTML = `❌ <b>上次导入失败 ${list.length} 条</b>（${esc(last.files && last.files.join('、') || '')}）：`
        + [...byCode.entries()].map(([code, n]) => `${esc(code)} × ${n}`).join('、')
        + '　<span style="color:#b45309; font-weight:400;">'
        + '（明细见下；完整对象在浏览器控制台，搜「导入失败」）</span>';
    box.appendChild(head);

    // 逐条明细：默认只列前 50 条（够定位"是哪一类、哪些标识"），其余折叠成一句
    const LIMIT = 50;
    const rows = document.createElement('div');
    rows.className = 'ai-failures-rows';
    rows.style.cssText = 'margin-top:4px; max-height:220px; overflow:auto;';
    for (const f of list.slice(0, LIMIT)) {
        const line = document.createElement('div');
        line.className = 'ai-failure-row';
        line.dataset.code = (f && f.code) || '';
        line.style.cssText = 'font-family:ui-monospace,Consolas,monospace; font-size:11px; word-break:break-all;';
        // 合成节点报的是 synthKey（它没有 extKey），普通记录报 extKey —— 哪个有就显示哪个
        line.textContent = `⛔ [${(f && f.code) || '?'}] `
            + `${(f && (f.synthKey || f.extKey)) || '(无标识)'} — ${(f && f.reason) || ''}`;
        rows.appendChild(line);
    }
    if (list.length > LIMIT) {
        const more = document.createElement('div');
        more.className = 'ai-failures-more';
        more.style.cssText = 'color:#b45309; margin-top:2px;';
        more.textContent = `…还有 ${list.length - LIMIT} 条（控制台里有全部 ${list.length} 条）`;
        rows.appendChild(more);
    }
    box.appendChild(rows);
    wrap.appendChild(box);
}

/**
 * 执行当前批次的导入
 * @param {HTMLElement} container
 * @param {Object} v - 视图状态
 */
