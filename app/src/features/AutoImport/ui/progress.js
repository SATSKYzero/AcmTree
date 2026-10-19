// ================================================================
// 进度条（features/AutoImport/ui/progress.js）
//
// 阶段名 + 条 + 预计时间。
// ⚠️ 导入是**一次事务**（要么全成要么全回滚），所以只报阶段与条数，不假装有百分比。
// ================================================================
import { fmtDuration } from './kit.js';


export function makeProgress(wrap, anchor = null) {
    const box = document.createElement('div');
    box.className = 'ai-progress';
    box.style.cssText = 'margin:8px 0 2px 0; padding:10px 12px; border:1px solid #e2e8f0;'
        + ' border-radius:6px; background:#f8fafc; font-size:12px; color:#475569;';
    box.dataset.phase = '';
    box.dataset.done = '0';
    box.dataset.total = '0';

    const label = document.createElement('div');
    label.className = 'ai-progress-label';
    label.style.cssText = 'margin-bottom:6px; font-weight:500;';
    label.textContent = '待开始';

    const track = document.createElement('div');
    track.style.cssText = 'height:8px; background:#e2e8f0; border-radius:4px; overflow:hidden;';
    const fill = document.createElement('div');
    fill.className = 'ai-progress-fill';
    fill.style.cssText = 'height:100%; width:0%; background:#2563eb; transition:width 0.12s;';
    track.appendChild(fill);

    const eta = document.createElement('div');
    eta.className = 'ai-progress-eta';
    eta.style.cssText = 'margin-top:6px; color:#64748b;';

    box.appendChild(label);
    box.appendChild(track);
    box.appendChild(eta);
    // 插在锚点（通常是工具栏）**后面**，别掉到面板最底下看不见
    if (anchor && anchor.parentNode === wrap && typeof wrap.insertBefore === 'function') {
        wrap.insertBefore(box, anchor.nextSibling);
    } else {
        wrap.appendChild(box);
    }

    let t0 = 0;
    let unit = '';
    return {
        el: box,
        /** @param {{phase:string, done:number, total:number, note?:string, unit?:string}} info */
        set(info = {}) {
            const { phase = '', done = 0, total = 0, note = '', unit: u = '' } = info;
            if (u) unit = u;
            if (!t0) t0 = Date.now();
            const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
            box.dataset.phase = phase;
            box.dataset.done = String(done);
            box.dataset.total = String(total);
            fill.style.width = `${pct}%`;
            label.textContent = `⏳ ${phase}：${done}/${total}${unit ? ` ${unit}` : ''}（${pct}%）`
                + (note ? `　·　${note}` : '');
            if (total > 0 && done > 0 && done < total) {
                const elapsed = Date.now() - t0;
                eta.textContent = `已用 ${fmtDuration(elapsed)}　·　预计还需 ${fmtDuration(elapsed / done * (total - done))}`;
            } else if (total > 0 && done >= total) {
                eta.textContent = `✅ 完成，用时 ${fmtDuration(Date.now() - t0)}`;
            } else {
                eta.textContent = '…';
            }
            return this;
        },
        /** 不可分片的阶段（写入/重绘）：只有阶段名与说明，不假装有百分比 */
        spin(phase, note = '') {
            box.dataset.phase = phase;
            box.dataset.done = '0';
            box.dataset.total = '0';
            fill.style.width = '100%';
            fill.style.opacity = '0.45';
            label.textContent = `⏳ ${phase}${note ? `：${note}` : ''}`;
            eta.textContent = '这一步不可分片（一次事务）';
            return this;
        },
        done(phase = '完成', note = '') {
            box.dataset.phase = phase;
            label.textContent = `✅ ${phase}${note ? `：${note}` : ''}`;
            fill.style.width = '100%';
            fill.style.opacity = '1';
            eta.textContent = t0 ? `用时 ${fmtDuration(Date.now() - t0)}` : '';
            return this;
        }
    };
}

/** 供"错误列表"跳转到节点（插件不 import ui，只派发事件） */
