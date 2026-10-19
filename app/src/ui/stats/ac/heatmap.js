// ================================================================
// 训练强度热力图（ui/stats/ac/heatmap.js）
//
// 职责：整年热力图 + 单年网格（含每日 AC 列表）。
// ================================================================
import { collectACNodes } from './tracking.js';
import {
    bindTimeRangeControls, initTimeRangeControls, renderDailyACList, renderTimeRangeACList,
    getHeatmapHighlightRange, setSelectionRepaint, refreshActiveACList
} from './dailyList.js';
import { XCPC_COLORS } from '../../../A_constants.js';
import { execute } from '../../../shell/executor.js';
import { AppState } from '../../../shell/state.js';
import { getCfColor } from '../../../utils/A_helpers.js';
import { getXcpcLevelIndex } from '../../../utils/color.js';
import { filterByMode } from '../../../view/filterMode.js';
import { viewDerived, viewValue } from '../../../view/scope.js';
// ★「合并显示」：判重模式下热力图按"每天每组一条"计数
// ⚠️ 但 `acTime` / 每天那条时间读**靠前那份**（本份）—— 见 `tracking.js` 顶部那条说明
//    （用户 2026-10-12 拍板：AC 时间规则保留现状）。
import { dedupRepresentatives, groupKeyOf } from '../../../core/query/countMode.js';

export function renderTrainingHeatmap() {
    const container = document.getElementById('training-heatmap');
    if (!container) return;

    // ★ 界面此刻展示的那一段（**单日选中 = 那一天**；时间范围 = 那一段）⇒ 区间外调淡。
    //   见 `dailyList.js:getHeatmapHighlightRange()`。
    const range = getHeatmapHighlightRange();

    const state = AppState;
    const allACNodes = collectACNodes(state);
    // ★ **先取一次时间、再排序**（2026-10-18）：原来排序的比较器里每次比较都调
    //   `viewDerived(state, a, 'acTime')`（走派生表/范围投影，不是白给的）⇒ 真包 1.3 万条 AC 时
    //   是 O(n log n) 次派生读（≈18 万次），"一级 tab 切到数据统计"慢就慢在这儿。
    //   现在每条只读一次（O(n)），排序只比字符串 —— **结果逐字不变**（同键的相对次序由 `localeCompare` 决定，
    //   而它只依赖这两个字符串）。
    const NO_TIME = '----.--.-- --:--';
    const decorated = allACNodes.map((n) => ({ n, t: viewDerived(state, n, 'acTime') || NO_TIME }));
    decorated.sort((a, b) => b.t.localeCompare(a.t));
    const sorted = decorated.map((d) => d.n);

    const filteredNodes = filterByMode(state, sorted);

    const acMap = new Map();
    // ★「合并显示」：判重模式下**同一天、同一组只算一次**（分组键里带上日期）——
    //   同一道题的两个来源副本若同一天都过了，热力图上不该算两格。
    const rows = dedupRepresentatives(state, filteredNodes, {
        keyOf: (x) => {
            const t = viewDerived(state, x, 'acTime');
            const day = (t && t !== '----.--.-- --:--') ? t.split(' ')[0] : '';
            // ⚠️⚠️ **没有组键时必须把节点 id 拼进去**（`v9.1.24` 修的真坑）：
            //    本函数返回的是**带前缀**的自定义键，所以整串**永远非空** ——
            //    而 `dedupRepresentatives` 的"没有组键 ⇒ 自成一组"兜底是 `raw || '#' + id`
            //    （`core/query/countMode.js:98`），**空串才触发**。
            //    ⇒ 写成 `${day}|${groupKeyOf(x)}` 的话，那一天所有**没有组**的题（散题、
            //      没进任何合成组的比赛下的题）会共用 `"<day>|"` 一个键、只留第一条
            //      ⇒ **一天最多显示 1**。用户 2026-10-13 实测："2026TEAM0 的统计…大量的数字是 1，
            //      但实际上远不止"、"只有热力图内"（AC 列表走默认 `groupKeyOf`，一个都不少）。
            //    判据：`src/test/dedupDisplay.test.js` 的「自定义 keyOf 的兜底」那条。
            return `${day}|${groupKeyOf(x) || '#' + ((x && x.id) || '')}`;
        }
    });
    for (const n of rows) {
        const acTime = viewDerived(state, n, 'acTime');
        if (acTime && acTime !== '----.--.-- --:--') {
            const dateStr = acTime.split(' ')[0];
            if (!acMap.has(dateStr)) {
                acMap.set(dateStr, { count: 0, maxCf: 0, maxXcpc: null });
            }
            const entry = acMap.get(dateStr);
            entry.count++;
            const cf = viewValue(state, n, 'cfDifficulty') || 0;
            if (cf > entry.maxCf) entry.maxCf = cf;
            const xcpc = viewDerived(state, n, 'xcpcDifficulty') || '-';
            if (xcpc !== '-' && xcpc !== '') {
                if (!entry.maxXcpc || getXcpcLevelIndex(xcpc) > getXcpcLevelIndex(entry.maxXcpc)) {
                    entry.maxXcpc = xcpc;
                }
            }
        }
    }

    if (acMap.size === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:60px 20px; text-align:center; color:#94a3b8;">
                <div style="font-size:48px; margin-bottom:12px; opacity:0.5;">📭</div>
                <p style="font-size:16px; font-weight:500; color:#64748b;">暂无AC记录</p>
                <p style="font-size:13px; margin-top:4px;">开始刷题，数据将在这里显示</p>
            </div>
        `;
        const legendContainer = document.getElementById('training-legend');
        if (legendContainer) legendContainer.innerHTML = '';
        return;
    }

    const years = new Set();
    for (const dateStr of acMap.keys()) {
        const year = parseInt(dateStr.split('.')[0]);
        if (!isNaN(year)) years.add(year);
    }
    const sortedYears = Array.from(years).sort((a, b) => a - b);

    let selectedYear = sortedYears[sortedYears.length - 1];
    const yearSelect = document.getElementById('training-year-select');
    if (yearSelect) {
        const val = parseInt(yearSelect.value);
        if (!isNaN(val) && years.has(val)) {
            selectedYear = val;
        }
    }

    const controlsDiv = document.getElementById('training-controls');
    if (controlsDiv) {
        const yearOptions = sortedYears.map(y =>
            `<option value="${y}" ${y === selectedYear ? 'selected' : ''}>${y}年</option>`
        ).join('');

        const currentMode = state.settings.stats.heatmapMode || 'count';

        controlsDiv.innerHTML = `
            <span style="font-size:13px; color:#64748b;">📊 每日AC</span>
            <select id="training-year-select" style="padding:3px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff; cursor:pointer;">
                ${yearOptions}
            </select>
            <select id="training-mode-select" style="padding:3px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff; cursor:pointer;">
                <option value="count" ${currentMode === 'count' ? 'selected' : ''}>关注题数</option>
                <option value="cf" ${currentMode === 'cf' ? 'selected' : ''}>关注CF难度</option>
                <option value="xcpc" ${currentMode === 'xcpc' ? 'selected' : ''}>关注XCPC难度</option>
            </select>
            <span style="flex:1;"></span>
            <span id="training-stats" style="font-size:12px; color:#94a3b8;">加载中...</span>
        `;

        const newSelect = document.getElementById('training-year-select');
        if (newSelect) {
            newSelect.addEventListener('change', function () {
                renderTrainingHeatmap();
            });
        }

        const modeSelect = document.getElementById('training-mode-select');
        if (modeSelect) {
            modeSelect.addEventListener('change', function () {
                execute(
                    (draft) => { draft.settings.stats.heatmapMode = this.value; },
                    { skipHistory: true, validate: false }
                ).catch(() => {});
                renderTrainingHeatmap();
            });
        }
    }

    renderHeatmapForYear(container, acMap, selectedYear, range);

    if (!window._timeRangeInitialized) {
        initTimeRangeControls();
        bindTimeRangeControls();
        window._timeRangeInitialized = true;
        // 建出默认范围（那之后 `setActiveSelection` 会回调过来把热力图重画一次）
        setTimeout(() => renderTimeRangeACList(1), 50);
    } else {
        // ★ 每次重画（`I_app.js` 每次刷新都会调进来）都把"此刻展示的那一段"**按当前账户范围重算**：
        //   否则换了「查看账户」之后，列表还是旧口径那一批，而下面的统计按新口径读值
        //   ⇒ "AC 列表里却有未使用/已提交未通过"（用户 2026-10-13 实测的正是这个）。
        refreshActiveACList();
    }

    const legendContainer = document.getElementById('training-legend');
    if (legendContainer) {
        const legendColors = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];
        const legendLabels = ['0', '1', '3', '6', '10+'];
        legendContainer.innerHTML = `
            <span>少</span>
            <span id="legend-colors" style="display:flex; gap:2px;">
                ${legendColors.map((c, i) =>
                    `<span style="display:inline-block; width:14px; height:14px; background:${c}; border-radius:2px; border:1px solid #e2e8f0;" title="${legendLabels[i]}"></span>`
                ).join('')}
            </span>
            <span>多</span>
        `;
    }
}

// ================================================================
// 指定年份热力图
// ================================================================

// ================================================================
// 时间范围 ⇒ 热力图"范围外变淡"（`v9.1.5` 加、`v9.1.6` 按用户"不要高亮了"改成淡化）
//
// 需求演变（用户 2026-10-13）：先说"在时间段内的格子白边换成淡蓝、底下放大小正好的正方形"，
// 看过之后说 **"看着很糊…不要高亮了，要不让范围外的变淡？"** ⇒ 定稿：
// **有已应用的范围时，区间外的格子调淡**（`opacity`），区间内的**一格不动**。
// 好处：不动布局、不叠颜色，也不会跟格子自己的绿/蓝/黄打架。
//
// ⚠️ 范围来自 `dailyList.js:getTimeRangeResult()`（**按下确定的那一段**，不是下拉框里的临时值）；
//    闭区间（`>=` / `<=`）—— 用户明确"点框也算在时间段内"。
// ⚠️ 用 `opacity` 而不是套一层 div：**不改变布局**（格子仍是 18×18、间距 3px）。
// ================================================================
const OUT_OF_RANGE_OPACITY = 0.28;   // 范围外那一档的透明度（越小越淡）

// 谁改了"当前展示的那一段"（单日 / 时间范围）就重画一次热力图 —— 由 `dailyList` 回调进来，
// ⚠️ 不在这里给按钮挂监听：那样单日选中与"收起单日视图"这两条路都漏掉（`v9.1.7` 改的）。
setSelectionRepaint(() => renderTrainingHeatmap());

/**
 * 画某一年的热力图（**导出是为了能在冒烟里直接喂一份 `acMap` + 范围** —— 见
 * `scripts/smoke/ui-wiring.smoke.mjs` 的时间范围染色那组；`innerHTML` 拼出来的格子，
 * 桩不解析 DOM，所以那一组断言的是 `serialize()` 出来的 HTML 串）。
 *
 * @param {Map<string, {count:number, maxCf:number, maxXcpc:string|null}>} acMap - 日期 → 当天统计
 * @param {number} year
 * @param {{startDate:Date, endDate:Date}|null} range - **已应用**的时间范围（闭区间）
 */
export function renderHeatmapForYear(container, acMap, year, range = null) {
    const pad = n => String(n).padStart(2, '0');
    const mode = AppState.settings.stats.heatmapMode || 'count';

    // ★ 「点一格 ⇒ 看那一天的题」走**事件委托**，不再往格子里塞内联 `onclick="window.…"`
    //   （G12：那是全仓最后一处内联事件 + `window` 全局挂载，改成模块化时它会**静默失效**）。
    //   委托挂在**容器**上：`container.innerHTML` 只换子元素，监听器跟着容器活 ⇒ 重画不用重挂。
    //   判据用 `[data-ac-date]`（单属性选择器）——`scripts/smoke/dom.mjs` 的 `closest`
    //   **不解析逗号选择器**，别改成那种写法。
    if (!container.__acDailyBound) {
        container.addEventListener('click', (e) => {
            const t = e.target;
            const cell = (t && typeof t.closest === 'function') ? t.closest('[data-ac-date]') : null;
            if (cell) renderDailyACList(cell.getAttribute('data-ac-date'));
        });
        container.__acDailyBound = true;
    }

    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year, 11, 31);
    const today = new Date();
    const actualEnd = endDate > today ? today : endDate;

    const daysDiff = Math.ceil((actualEnd - startDate) / (24 * 60 * 60 * 1000));
    if (daysDiff < 0) {
        container.innerHTML = `<div class="empty-state"><p>该年暂无数据</p></div>`;
        return;
    }

    const allDates = [];
    let totalAC = 0;
    let activeDays = 0;
    for (let i = 0; i <= daysDiff; i++) {
        const d = new Date(startDate);
        d.setDate(d.getDate() + i);
        const key = `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
        const entry = acMap.get(key);
        const count = entry ? entry.count : 0;
        allDates.push({
            date: d,
            key,
            count,
            maxCf: entry ? entry.maxCf : 0,
            maxXcpc: entry ? entry.maxXcpc : null
        });
        totalAC += count;
        if (count > 0) activeDays++;
    }

    const statsEl = document.getElementById('training-stats');
    if (statsEl) {
        statsEl.textContent = `总AC: ${totalAC} 题 · 活跃: ${activeDays} 天`;
    }

    if (totalAC === 0) {
        container.innerHTML = `<div class="empty-state"><p>该年暂无AC记录</p></div>`;
        return;
    }

    function getCellColor(entry) {
        const count = entry ? entry.count : 0;
        if (count === 0) return '#ebedf0';

        if (mode === 'count') {
            if (count <= 1) return '#9be9a8';
            if (count <= 3) return '#40c463';
            if (count <= 6) return '#30a14e';
            return '#216e39';
        }

        if (mode === 'cf') {
            const cf = entry ? entry.maxCf : 0;
            if (cf === 0) return '#ced0d4';
            if (cf >= 3000) return '#8B0000';
            return getCfColor(cf);
        }

        const xcpc = entry ? entry.maxXcpc : null;
        if (!xcpc || xcpc === '-') return '#ced0d4';
        return XCPC_COLORS[xcpc] || '#6b7280';
    }

    function getCellText(entry) {
        const count = entry ? entry.count : 0;
        if (count === 0) return '';
        if (mode === 'count') {
            if (count >= 100) return '∞';
            return String(count);
        }
        return '';
    }

    function getTextColor(entry) {
        const count = entry ? entry.count : 0;
        if (count === 0) return 'transparent';
        if (mode === 'count') {
            if (count <= 1) return '#000000';
            return '#ffffff';
        }
        if (mode === 'cf') {
            const cf = entry ? entry.maxCf : 0;
            if (cf === 0) return 'transparent';
            if (cf >= 3000) return '#ffffff';
            const color = getCfColor(cf);
            const r = parseInt(color.slice(1,3), 16);
            const g = parseInt(color.slice(3,5), 16);
            const b = parseInt(color.slice(5,7), 16);
            const brightness = (r * 299 + g * 587 + b * 114) / 1000;
            return brightness > 160 ? '#000000' : '#ffffff';
        }
        const xcpc = entry ? entry.maxXcpc : null;
        if (!xcpc || xcpc === '-') return 'transparent';
        const color = XCPC_COLORS[xcpc] || '#ebedf0';
        const r = parseInt(color.slice(1,3), 16);
        const g = parseInt(color.slice(3,5), 16);
        const b = parseInt(color.slice(5,7), 16);
        const brightness = (r * 299 + g * 587 + b * 114) / 1000;
        return brightness > 160 ? '#000000' : '#ffffff';
    }

    function getFontSize(entry, text) {
        if (mode === 'count') {
            const count = entry ? entry.count : 0;
            if (count >= 100 || text === '∞') return '12px';
            if (count >= 10) return '11px';
            return '14px';
        }
        if (mode === 'cf') {
            const cf = entry ? entry.maxCf : 0;
            if (cf >= 3000) return '14px';
            if (cf >= 1000) return '11px';
            return '12px';
        }
        return '12px';
    }

    const firstDayOfWeek = startDate.getDay();
    const offset = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;

    const weeks = [];
    let currentWeek = [];
    for (let i = 0; i < allDates.length; i++) {
        const item = allDates[i];
        const dayOfWeek = item.date.getDay();
        const adjustedDay = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

        if (adjustedDay === 0 && currentWeek.length > 0) {
            weeks.push(currentWeek);
            currentWeek = [];
        }

        if (i === 0 && adjustedDay > 0) {
            for (let j = 0; j < adjustedDay; j++) {
                currentWeek.push(null);
            }
        }

        currentWeek.push(item);

        if (i === allDates.length - 1 && currentWeek.length > 0) {
            weeks.push(currentWeek);
        }
    }

    if (weeks.length > 0) {
        const lastWeek = weeks[weeks.length - 1];
        while (lastWeek.length < 7) {
            lastWeek.push(null);
        }
    }
    for (const week of weeks) {
        while (week.length < 7) {
            week.push(null);
        }
    }

    const weekDays = ['一', '二', '三', '四', '五', '六', '日'];
    let html = '<div style="display:flex; gap:3px; overflow-x:auto; padding:6px 0;">';

    html += '<div style="display:flex; flex-direction:column; gap:3px; padding-right:9px; font-size:17px; color:#94a3b8; min-width:27px;">';
    html += `<div style="height:21px; line-height:21px; text-align:center;"></div>`;
    for (let i = 0; i < 7; i++) {
        html += `<div style="height:18px; line-height:18px; text-align:center;">${weekDays[i]}</div>`;
    }
    html += '</div>';

    html += '<div style="display:flex; gap:3px; flex:1;">';
    for (let wi = 0; wi < weeks.length; wi++) {
        const week = weeks[wi];
        let monthLabel = '';
        for (const item of week) {
            if (item) {
                const month = item.date.getMonth() + 1;
                if (wi === 0 || (wi > 0 && weeks[wi-1].some(i => i && i.date.getMonth() !== month))) {
                    monthLabel = `${month}`;
                }
                break;
            }
        }
        html += `<div style="display:flex; flex-direction:column; gap:3px; align-items:center;">`;
        html += `<div style="font-size:15px; color:#94a3b8; height:21px; line-height:21px;">${monthLabel}</div>`;
        for (let di = 0; di < 7; di++) {
            const item = week[di];
            if (item) {
                const color = getCellColor(item);
                const text = getCellText(item);
                const textColor = getTextColor(item);
                const fontSize = getFontSize(item, text);
                const count = item.count;
                const dateAttr = (count > 0) ? `data-ac-date="${item.key}"` : '';
                const cursorStyle = (count > 0) ? 'pointer' : 'default';
                const tooltip = (count > 0) ? `${item.key} · ${count} 题` : item.key;
                // ★ 时间范围：**区间外的格子调淡**（闭区间 —— `点框也算在时间段内`）；
                //   区间内一格不动；没按过确定（`range === null`）⇒ 谁都不淡。
                const inRange = !!(range && item.date >= range.startDate && item.date <= range.endDate);
                const dim = (range && !inRange) ? ` opacity:${OUT_OF_RANGE_OPACITY};` : '';
                html += `<div style="width:18px; height:18px; background:${color}; border-radius:3px; cursor:${cursorStyle}; display:flex; align-items:center; justify-content:center; font-size:${fontSize}; font-weight:700; color:${textColor}; line-height:1;${dim}" title="${tooltip}" ${dateAttr}>${text}</div>`;
            } else {
                // 占位格（不属于这一年的那几格）：不在范围判定里，保持原样
                html += `<div style="width:18px; height:18px; background:transparent;"></div>`;
            }
        }
        html += '</div>';
    }
    html += '</div>';
    html += '</div>';

    container.innerHTML = html;
}

// ================================================================
// 统一渲染数据统计内容（Tab 切换）
// ================================================================
