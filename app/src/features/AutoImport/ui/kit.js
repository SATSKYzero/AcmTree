// ================================================================
// 面板小工具（features/AutoImport/ui/kit.js）
//
// 按钮 / 吐司 / 让帧 / 时长 / 标题 / 短值 ——
// 与业务无关，谁都能用。
// ================================================================
import { EVENTS } from '../../../A_constants.js';

export const INPUT_CSS = 'padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff;';

export const BTN_CSS = 'padding:5px 14px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; cursor:pointer; background:#fff; color:#334155;';

export const BTN_PRIMARY_CSS = 'padding:5px 14px; border:1px solid #2563eb; border-radius:4px; font-size:13px; cursor:pointer; background:#2563eb; color:#fff; font-weight:500;';

/** 纯函数转义（utils/html.js 的 escapeHtml 不转义引号，属性位不能用） */

export function showToast(msg, type = 'info') {
    document.dispatchEvent(new CustomEvent(EVENTS.SHOW_TOAST, { detail: { message: msg, type } }));
}

export function button(label, onClick, primary = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = primary ? BTN_PRIMARY_CSS : BTN_CSS;
    b.addEventListener('click', onClick);
    return b;
}

// ================================================================
// 进度与预计时间（大范围下总是慢的，所以要有进度条、预计时间）
// ================================================================
//
// 设计：**先拿到总数再逐项推进** —— 每个阶段都先算出 total，再按"已处理/总数"推进；
// 每次推进都 `await yieldToUI()` 让出一次宏任务，界面不会冻住。
//
// ⚠️ 能分片的只有"读文件"与"逐文件出计划"两段；**写入那一段不能分片** ——
//    它是一次事务（要么全成要么全回滚，见 applyPlans），硬拆会改掉导入语义。
//    所以那一段只报"写入中（一次事务，N 条）"，不假装有百分比。

export function yieldToUI() {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
        else setTimeout(resolve, 0);
    });
}

/** 把毫秒说成人话：`12 秒` / `1 分 05 秒` */

export function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} 秒`;
    return `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/**
 * 造一个进度条控制器（纯 DOM，不依赖任何状态）
 *
 * 暴露给 smoke 的钩子：`.ai-progress` 上有 `data-phase / data-done / data-total`。
 */

export function titleOf(rec) {
    const n = (rec.raw && (rec.raw['题目名称'] || rec.raw['比赛名称'] || rec.raw['name'])) || '';
    if (n) return String(n);
    if (rec.fields && rec.fields.name) return String(rec.fields.name);
    return rec.extKey;
}

export function shortValue(v) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (s.length > 28) s = s.slice(0, 27) + '…';
    return s;
}

// ================================================================
// 渲染：执行区
// ================================================================
