// ================================================================
// 「检索」两个子页共用的控件（features/Search/kit.js）
//
// 「比赛检索」「题目检索」共用这一套控件：两边要**一模一样**的观感 ⇒
// 与其抄第三份，不如抽出来。
// ⚠️ 签名与样式与 `ProblemSearch` 的控件逐字一致（`ui/dedup/kit.js` 那份是**故意**抄一份的 ——
//    `ui/` 不许依赖 `features/`，那条例外仍然成立；这里是 features 内部共用，没有那层顾虑）。
//
// 本模块**只造元素**，不认识 AppState、不认识查询逻辑。
// ⚠️ 唯一的 import 是 `utils/text.js`（叶子、不碰 DOM）：**悬停提示也要去 Markdown 记号**，
//    而那是"人看得见的字"的统一口径 —— 别在这里抄一份 replace。
// ================================================================
import { plain } from '../../utils/text.js';

export const INPUT_CSS = 'padding:4px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff;';
export const LABEL_CSS = 'font-size:12px; color:#475569; white-space:nowrap;';

/** 标签 + 控件（一行一个条件） */
export function field(labelText, control) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex; align-items:center; gap:6px;';
    const span = document.createElement('span');
    span.textContent = labelText;
    span.style.cssText = LABEL_CSS;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
}

/** 条件栏的一行（`display:flex` + 换行） */
export function row() {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
    return el;
}

/**
 * 文本输入框。
 *
 * ⚠️ **中文输入法**：合成（拼音候选）期间**不许**调 `onInput` —— 用中文输入法时，每敲一个
 *    字母都会走一趟 `onInput`，而调用方通常会据此重建面板；**输入框一旦被换掉，合成就当场
 *    中断**（表现为"输入一个字符就被打断"）。这里在合成期间按住不发，`compositionend`
 *    再发一次最终值（`isComposing` 是同一件事的标准判据，浏览器不支持时它恒为 false，
 *    不会误伤普通键入）。
 */
export function textInput(value, placeholder, onInput, width = '130px') {
    const el = document.createElement('input');
    el.type = 'text';
    el.value = value || '';
    el.placeholder = placeholder || '';
    el.style.cssText = INPUT_CSS + `width:${width};`;
    let composing = false;
    el.addEventListener('compositionstart', () => { composing = true; });
    el.addEventListener('compositionend', () => { composing = false; onInput(el.value); });
    el.addEventListener('input', (e) => {
        if (composing || (e && e.isComposing)) return;   // 合成中：等 compositionend
        onInput(el.value);
    });
    return el;
}

export function numberInput(value, placeholder, onInput) {
    const el = document.createElement('input');
    el.type = 'number';
    el.value = (value === undefined || value === null || Number.isNaN(value)) ? '' : String(value);
    el.placeholder = placeholder || '';
    el.style.cssText = INPUT_CSS + 'width:78px;';
    el.addEventListener('input', () => onInput(el.value === '' ? undefined : Number(el.value)));
    return el;
}

export function select(options, value, onChange) {
    const el = document.createElement('select');
    el.style.cssText = INPUT_CSS + 'cursor:pointer;';
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === value) o.selected = true;
        el.appendChild(o);
    }
    el.addEventListener('change', () => onChange(el.value));
    return el;
}

/**
 * 多选芯片组（状态2 / 档位 / 平台 / 系列 / 年份…都用它）
 * @param {Array<{value:string,label:string,color?:string}>} options
 * @param {string[]} selected
 * @param {Function} onChange - (nextSelected: string[]) => void
 */
export function chipGroup(options, selected, onChange) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px;';

    for (const opt of options) {
        const on = selected.includes(opt.value);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ps-chip';
        btn.dataset.value = opt.value;
        btn.textContent = opt.label;
        btn.title = plain(on ? '点击取消' : '点击选中');
        btn.style.cssText = `padding:2px 8px; border:1px solid ${on ? '#2563eb' : '#d1d5db'}; border-radius:10px; font-size:12px; cursor:pointer; background:${on ? '#2563eb' : '#fff'}; color:${on ? '#fff' : '#475569'};`;
        btn.addEventListener('click', () => {
            const next = on ? selected.filter(v => v !== opt.value) : [...selected, opt.value];
            onChange(next);
        });
        wrap.appendChild(btn);
    }
    return wrap;
}

/** 空态（没有命中时那块） */
export function emptyState(icon, text) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.cssText = 'padding:40px 20px; text-align:center; color:#94a3b8;';
    empty.innerHTML = `<div style="font-size:40px; margin-bottom:12px; opacity:0.5;">${icon}</div>`
        + `<p>${text}</p>`;
    return empty;
}

/**
 * 翻页条（只有一页时调用方别挂它）
 * @param {number} page - 当前页（1 基）
 * @param {number} pageCount
 * @param {Function} go - (nextPage) => void
 */
export function pager(page, pageCount, go) {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex; align-items:center; gap:10px; padding:10px 4px 0 4px; font-size:13px; color:#475569;';
    const mkBtn = (label, target, disabled) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.disabled = disabled;
        b.style.cssText = `padding:3px 10px; border:1px solid #d1d5db; border-radius:4px; background:#fff; cursor:${disabled ? 'not-allowed' : 'pointer'}; opacity:${disabled ? 0.4 : 1};`;
        b.addEventListener('click', () => go(target));
        return b;
    };
    box.appendChild(mkBtn('◀ 上一页', page - 1, page <= 1));
    const span = document.createElement('span');
    span.textContent = `${page} / ${pageCount}`;
    box.appendChild(span);
    box.appendChild(mkBtn('下一页 ▶', page + 1, page >= pageCount));
    return box;
}

/**
 * 「名称/题号 ↔ 键」之间那颗**并集 / 交集**切换钮（两个子页共用这一份）。
 *
 * 用户 2026-10-18 定的形状：键框**放在「名称」/「题号」之后**，中间隔这颗按钮，
 * 一键切换"这两个文本条件取并集还是交集"（默认交集 = 原来的行为，逐字不变）。
 * ⚠️ 文案只在这一个函数里（别在页面里各写一套）：提示语要说清"管的是哪两个框"。
 * @param {string} join - `'and'`（交集，默认）/ `'or'`（并集）
 * @param {Function} onToggle - 点一下回调（页面自己去翻 `join`）
 */
export function joinButton(join, onToggle) {
    const and = join !== 'or';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-join';
    btn.textContent = and ? '∩ 交集' : '∪ 并集';
    btn.title = '切换「名称/题号」与「键」的组合方式：交集 = 两个都要命中（默认）；并集 = 命中任一个就算';
    btn.style.cssText = 'padding:3px 8px; border:1px solid ' + (and ? '#d1d5db' : '#93c5fd')
        + '; border-radius:4px; background:' + (and ? '#fff' : '#eff6ff')
        + '; font-size:12px; color:' + (and ? '#475569' : '#1d4ed8') + '; cursor:pointer; white-space:nowrap;';
    btn.addEventListener('click', onToggle);
    return btn;
}

/**
 * 「清空条件」按钮（两个子页各一组条件，行为一致）
 * @param {Function} onClear
 */
export function clearButton(onClear) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-clear';
    btn.textContent = '清空条件';
    btn.style.cssText = 'margin-left:auto; padding:3px 10px; border:1px solid #d1d5db; border-radius:4px; background:#fff; font-size:12px; color:#475569; cursor:pointer;';
    btn.addEventListener('click', onClear);
    return btn;
}
