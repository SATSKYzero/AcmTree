// ================================================================
// 年 / 月 / 日 起止选择器（ui/kit/dateRangePicker.js）
//
// 形态：**起止各三个下拉（年/月/日）**，改年 ⇒ 月归 1、改月 ⇒ 按当月天数重填"日"。
//
// ★ 这一份现在是**全仓唯一**的日期范围选择器（`v9.2.2` 起）：
//   · 计划页（`ui/plan/planBlocks.js`，前缀 `plan-range-*`）用它；
//   · 统计页的时间范围（`ui/stats/ac/dailyList.js:initTimeRangeControls`）**也用它** ——
//     用户 2026-10-13："在不影响功能的前提下最好实现一致,若模块复杂可以共用"。
//     ⚠️ 统计页传的前缀刻意是 `tr-start` / `tr-end` ⇒ 建出来的 id 与老 `index.html` 那六个**一模一样**
//     （`renderTimeRangeACList` 读值那六行一个字没改）；代价是 `index.html` 里那六个静态 `<select>`
//     必须删掉（重名）⇒ 那边只剩一个 `<span id="tr-picker">`。
//   ⚠️ 删掉的那套手写实现（旧 `initTimeRangeControls` 的级联 + `bindTimeRangeControls`）**别再写回来**。
//
// ⚠️ 这一层只出 **`YYYY.MM.DD` 字符串**（仓里时间口径只有这一种写法，见 `utils/time.js`）。
// ⚠️ 冒烟：`scripts/smoke/date-range-picker.smoke.mjs`（必须开 `parseHtml` —— 选项是 `innerHTML` 塞的）。
// ================================================================
import { el } from '../../utils/dom.js';

/** 年份下拉给到哪一年（与统计页那套一致） */
const YEAR_FROM = 2000;
/** 六格里每格的样式（统计页那份是内联写的，这里取同一观感） */
const SELECT = 'padding:2px 6px;border:1px solid #d1d5db;border-radius:4px;font-size:12px;background:#fff;cursor:pointer;';

const pad2 = (n) => String(n).padStart(2, '0');

/** 某年某月几天（`m` 是 1..12） */
export function daysInMonthOf(year, month) {
    return new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
}

/** `YYYY.MM.DD` → `{y, m, d}`；取不出来给 `null` */
export function parseDay(key) {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** 今天（`YYYY.MM.DD`）——与 `utils/time.js` 同一写法；只在这里取一次，别处都从入参来 */
function todayKey(now = new Date()) {
    return `${now.getFullYear()}.${pad2(now.getMonth() + 1)}.${pad2(now.getDate())}`;
}

function setOptions(select, values, value) {
    if (!select) return;
    select.innerHTML = values.map((v) =>
        `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${v}</option>`).join('');
}

/**
 * 建一个"起止选择器"（六个下拉 + 可选的「套用」「全部」按钮）。
 *
 * @param {Object} opts
 * @param {string} [opts.startPrefix] 起：元素 id 前缀（默认 `plan-range-start`）
 * @param {string} [opts.endPrefix]   止：元素 id 前缀（默认 `plan-range-end`）
 * @param {string} [opts.from] 初始起（`YYYY.MM.DD`，空 = 用默认区间）
 * @param {string} [opts.to]   初始止
 * @param {string} [opts.defaultFrom] 没给 `from` 时的起点（缺省 = 今年 1 月 1 日）
 * @param {string} [opts.defaultTo]   没给 `to` 时的终点（缺省 = 今天）
 * @param {Function} [opts.onApply] 点「套用」⇒ `onApply({from, to})`
 * @param {Function} [opts.onReset] 点「全部」⇒ `onReset()`
 * @param {boolean} [opts.withButtons] 要不要那两颗按钮（默认要）
 * @returns {HTMLElement} 一行（真实元素；`querySelector('[data-range="…"]')` 是给冒烟的钩子）
 */
export function buildDateRangePicker(opts = {}) {
    const startPrefix = opts.startPrefix || 'plan-range-start';
    const endPrefix = opts.endPrefix || 'plan-range-end';
    const now = opts.now || new Date();
    const today = todayKey(now);
    const nowY = now.getFullYear();
    const defFrom = opts.defaultFrom || `${nowY}.01.01`;
    const defTo = opts.defaultTo || today;

    const wrap = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:#475569;');
    wrap.className = 'date-range-picker';
    wrap.dataset.range = 'picker';

    const years = [];
    for (let y = nowY; y >= YEAR_FROM; y--) years.push(y);

    const mkSelect = (id, dataRange) => {
        const s = document.createElement('select');
        s.id = id;
        s.style.cssText = SELECT;
        s.dataset.range = dataRange;
        return s;
    };

    const fromP = parseDay(opts.from) || parseDay(defFrom) || { y: nowY, m: 1, d: 1 };
    const toP = parseDay(opts.to) || parseDay(defTo) || { y: nowY, m: 1, d: 1 };

    const startYear = mkSelect(`${startPrefix}-year`, 'start-year');
    const startMonth = mkSelect(`${startPrefix}-month`, 'start-month');
    const startDay = mkSelect(`${startPrefix}-day`, 'start-day');
    const endYear = mkSelect(`${endPrefix}-year`, 'end-year');
    const endMonth = mkSelect(`${endPrefix}-month`, 'end-month');
    const endDay = mkSelect(`${endPrefix}-day`, 'end-day');

    setOptions(startYear, years, fromP.y);
    setOptions(endYear, years, toP.y);
    setOptions(startMonth, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], fromP.m);
    setOptions(endMonth, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], toP.m);
    setOptions(startDay, Array.from({ length: daysInMonthOf(fromP.y, fromP.m) }, (_, i) => i + 1), fromP.d);
    setOptions(endDay, Array.from({ length: daysInMonthOf(toP.y, toP.m) }, (_, i) => i + 1), toP.d);

    // 级联：改年 ⇒ 月归 1（跟着重填"日"）；改月 ⇒ 按当月天数重填"日"（超界的天回到最后一天）
    const wire = (prefix, yearSel, monthSel, daySel) => {
        yearSel.addEventListener('change', () => {
            monthSel.value = '1';
            monthSel.dispatchEvent({ type: 'change' });
        });
        monthSel.addEventListener('change', () => {
            const y = Number(yearSel.value);
            const m = Number(monthSel.value);
            const days = daysInMonthOf(y, m);
            const keep = Math.min(Number(daySel.value) || 1, days);
            setOptions(daySel, Array.from({ length: days }, (_, i) => i + 1), keep);
        });
    };
    wire(startPrefix, startYear, startMonth, startDay);
    wire(endPrefix, endYear, endMonth, endDay);

    const label = (t) => el('span', 'color:#94a3b8;', t);
    for (const node of [label('从'), startYear, label('年'), startMonth, label('月'), startDay, label('日')]) wrap.appendChild(node);
    wrap.appendChild(el('span', 'width:8px;', ''));
    for (const node of [label('到'), endYear, label('年'), endMonth, label('月'), endDay, label('日')]) wrap.appendChild(node);

    if (opts.withButtons !== false) {
        const apply = document.createElement('button');
        apply.className = 'btn';
        apply.dataset.planAction = opts.applyAction || 'range-apply';
        apply.textContent = '确定';
        apply.addEventListener('click', () => {
            const r = readDateRange(startPrefix, endPrefix);
            if (typeof opts.onApply === 'function') opts.onApply(r);
        });
        const reset = document.createElement('button');
        reset.className = 'btn';
        reset.dataset.planAction = opts.resetAction || 'range-reset';
        reset.textContent = '全部';
        reset.addEventListener('click', () => {
            if (typeof opts.onReset === 'function') opts.onReset();
        });
        wrap.appendChild(apply);
        wrap.appendChild(reset);
    }
    return wrap;
}

/** 读这六个下拉现在的值 ⇒ `{from, to}`（`YYYY.MM.DD`；填不全给空串） */
export function readDateRange(startPrefix = 'plan-range-start', endPrefix = 'plan-range-end') {
    const val = (id, fallback) => {
        const node = document.getElementById(id);
        return node ? String(node.value) : fallback;
    };
    const y1 = val(`${startPrefix}-year`, '');
    const m1 = val(`${startPrefix}-month`, '');
    const d1 = val(`${startPrefix}-day`, '');
    const y2 = val(`${endPrefix}-year`, '');
    const m2 = val(`${endPrefix}-month`, '');
    const d2 = val(`${endPrefix}-day`, '');
    const from = (y1 && m1 && d1) ? `${y1}.${pad2(m1)}.${pad2(d1)}` : '';
    const to = (y2 && m2 && d2) ? `${y2}.${pad2(m2)}.${pad2(d2)}` : '';
    return { from, to };
}
