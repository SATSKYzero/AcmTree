// ================================================================
// 每日 / 时间段清单（ui/stats/ac/dailyList.js）
//
// 职责：按日/按时间段筛 AC 记录、日期与时间范围控件。
// ================================================================
import { renderACListView } from './listView.js';
import { AppState } from '../../../shell/state.js';
import { filterByMode } from '../../../view/filterMode.js';
import { viewDerived } from '../../../view/scope.js';
// ★「合并显示」：判重模式下列表**每组只留一条**（同一道题的多个来源副本不重复列）
// ⚠️ 但排序用的 `acTime` 读**靠前那份**（本份）—— 见 `tracking.js` 顶部那条说明
//    （用户 2026-10-12 拍板：AC 时间规则保留现状）。
import { dedupRepresentatives } from '../../../core/query/countMode.js';
// ★ v9.2.2：时间范围那六个下拉 + 级联改用**共用组件**（与计划页同一份：`ui/kit/dateRangePicker.js`）
import { buildDateRangePicker } from '../../kit/dateRangePicker.js';

let dailyACPage = 1;

let currentDailyDate = null;

let timeRangePage = 1;

let currentTimeRangeResult = null;

// ================================================================
// 「当前展示的是哪一段」—— 热力图据此把**区间外**调淡（`v9.1.7`）
//
// 为什么不能只认"按下确定的时间范围"：用户要求**单日选中时也这样**
//（"我想选中单点时也这样：只有这一个不淡化，即套入该天为始终"）。
// 所以这里记住**界面此刻正在展示的那一段**：单日 ⇒ `[那天, 那天]`；时间范围 ⇒ `[起, 止]`。
// ⚠️ 谁改这段状态就走 `setActiveSelection` —— 它会在**真的变了**的时候通知热力图重画一次
//   （`setSelectionRepaint` 由 `heatmap.js` 注册；**别让 dailyList 反过来 import heatmap**，会成环）。
// ================================================================
let activeSelection = null;
let lastSelectionKey = '';
let selectionRepaint = null;

/** 热力图注册"我该怎么重画"（只注册一次，重复注册同一个函数是无害的） */
export function setSelectionRepaint(fn) {
    selectionRepaint = (typeof fn === 'function') ? fn : null;
}

/** 界面此刻展示的那一段（`{ startDate, endDate, kind }`；什么都没有 = `null`） */
export function getHeatmapHighlightRange() {
    return activeSelection;
}

function setActiveSelection(startDate, endDate, kind) {
    activeSelection = (startDate && endDate) ? { startDate, endDate, kind } : null;
    const key = activeSelection
        ? `${activeSelection.kind}|${activeSelection.startDate.getTime()}|${activeSelection.endDate.getTime()}`
        : 'none';
    // ⚠️ 只在**真的换了段**时通知：翻页会重复调 `renderTimeRangeACList`，每次都重画热力图是白费
    if (key !== lastSelectionKey) {
        lastSelectionKey = key;
        if (selectionRepaint) selectionRepaint();
    }
}

/**
 * **已经按下过「确定」的那段时间范围**（`{ startDate, endDate, pNodes }`；没按过 = `null`）。
 *
 * ⚠️ 热力图**不该**直接用它 —— 它只回答"按下确定的那一段"，而单日选中时界面展示的是那一天。
 *    给热力图的是 `getHeatmapHighlightRange()`（当前展示的那一段）。
 */
export function getTimeRangeResult() {
    return currentTimeRangeResult;
}

function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

export function renderDailyACList(dateStr, page = 1) {
    dailyACPage = page;
    currentDailyDate = dateStr;

    // ★ 单日选中 ⇒ 热力图把**别的天**调淡（"只有这一个不淡化，即套入该天为始终"）
    const [dy, dm, dd] = String(dateStr || '').split('.').map(Number);
    setActiveSelection(new Date(dy, dm - 1, dd), new Date(dy, dm - 1, dd), 'day');

    const timeRangeView = document.getElementById('time-range-view');
    const dailyACView = document.getElementById('daily-ac-view');
    const listContainer = document.getElementById('daily-ac-list-container');

    if (!dailyACView || !listContainer) return;

    if (timeRangeView) timeRangeView.style.display = 'none';
    dailyACView.style.display = 'block';

    const state = AppState;
    const pNodes = [];
    if (state.rootId) {
        (function walk(id) {
            const n = state.nodes[id];
            if (!n) return;
            if (n.type === 'P') {
                const acTime = viewDerived(state, n, 'acTime');
                if (acTime && acTime !== '----.--.-- --:--') {
                    const acDate = acTime.split(' ')[0];
                    if (acDate === dateStr) {
                        pNodes.push(n);
                    }
                }
            }
            for (const cid of state.childOrder[id]) {
                walk(cid);
            }
        })(state.rootId);
    }

    pNodes.sort((a, b) => {
        const timeA = viewDerived(state, a, 'acTime') || '----.--.-- --:--';
        const timeB = viewDerived(state, b, 'acTime') || '----.--.-- --:--';
        return timeB.localeCompare(timeA);
    });

    const filteredNodes = dedupRepresentatives(state, filterByMode(state, pNodes));
    // ★「合并显示」：判重模式下**这一组只算一次**（同一天里同一道题的多个来源副本
    //   不该在列表里出现两次）。`plain` / 老存档 ⇒ 原样返回，行为不变。

    renderACListView({
        state,
        nodes: filteredNodes,
        title: `${dateStr} 的AC题目`,
        containerId: 'daily-ac-list-container',
        page: dailyACPage,
        onPageChange: (newPage) => {
            renderDailyACList(dateStr, newPage);
        },
        showCloseBtn: true,
        closeHandler: () => {
            const timeRangeView2 = document.getElementById('time-range-view');
            const dailyACView2 = document.getElementById('daily-ac-view');
            if (dailyACView2) dailyACView2.style.display = 'none';
            if (timeRangeView2) timeRangeView2.style.display = 'block';
            dailyACPage = 1;
            currentDailyDate = null;
            renderTimeRangeACList(timeRangePage);
        }
    });
}

window.renderDailyACList = renderDailyACList;

// ================================================================
// 时间范围 AC 题目列表
// ================================================================

/**
 * 建起时间范围那一排控件 + 接上"确定/重置"。
 *
 * ★ v9.2.2：**六个下拉与级联改用共用组件**（`ui/kit/dateRangePicker.js:buildDateRangePicker`）——
 *   与计划页（`ui/plan/planBlocks.js`）**同一份实现**。
 *   ⚠️ 前缀刻意用 `tr-start` / `tr-end` ⇒ 建出来的 id 与 `index.html` 原来那六个**一模一样**
 *   （`renderTimeRangeACList` 那六行 `getElementById('tr-…')` **一个字不用改**）；
 *   代价是 `index.html` 里那六个静态 `<select>` 必须删掉（重名），换成 `<span id="tr-picker">`。
 *   ⚠️ 按钮语义照旧：**「确定」= 按当前六个下拉筛，「重置」= 回到"今年 1 月 1 日 → 今天"**。
 *   共用组件那颗重置按钮叫「全部」，这里不用它（`withButtons` 仍要开 —— 用它的「确定」）。
 *
 * ⚠️ 历史上这里还有一套自己的年/月/日下拉 + `bindTimeRangeControls`（含 Enter 转发）——
 *    `v9.2.2` 起全部撤掉（级联在组件里，按钮行为在下面的 `onApply` / `onReset` 里）。
 */
export function initTimeRangeControls() {
    const host = document.getElementById('tr-picker');
    if (!host || document.getElementById('tr-start-year')) return;   // 没有容器（或已经建过）⇒ 不重复建
    const now = new Date();
    const today = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`
        + `.${String(now.getDate()).padStart(2, '0')}`;
    host.appendChild(buildDateRangePicker({
        startPrefix: 'tr-start',
        endPrefix: 'tr-end',
        defaultFrom: `${now.getFullYear()}.01.01`,   // 与老实现一致：起点是今年 1 月 1 日
        defaultTo: today,
        onApply: () => {
            timeRangePage = 1;
            renderTimeRangeACList(1);
        },
        onReset: () => resetTimeRangeToDefault()
    }));
    // 那两颗按钮由组件给（「确定」/「全部」）—— 行为在 `onApply` / `onReset` 里，见上面的说明
}

/** 重置 = 回到"今年 1 月 1 日 → 今天"再筛一次（老 `#tr-reset-btn` 的行为，原样搬过来） */
function resetTimeRangeToDefault() {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const day = now.getDate();
    const setV = (id, v) => { const s = document.getElementById(id); if (s) s.value = String(v); };
    setV('tr-start-year', year);
    setV('tr-start-month', 1);
    setV('tr-start-day', 1);
    setV('tr-end-year', year);
    setV('tr-end-month', month);
    setV('tr-end-day', Math.min(day, getDaysInMonth(year, month)));
    const endMonth = document.getElementById('tr-end-month');
    if (endMonth) endMonth.dispatchEvent(new Event('change'));   // 让"日"按当月天数重填
    timeRangePage = 1;
    renderTimeRangeACList(1);
}

export function renderTimeRangeACList(page = 1) {
    timeRangePage = page;
    const listContainer = document.getElementById('time-range-ac-list');
    if (!listContainer) return;

    const startYear = parseInt(document.getElementById('tr-start-year')?.value);
    const startMonth = parseInt(document.getElementById('tr-start-month')?.value);
    const startDay = parseInt(document.getElementById('tr-start-day')?.value);
    const endYear = parseInt(document.getElementById('tr-end-year')?.value);
    const endMonth = parseInt(document.getElementById('tr-end-month')?.value);
    const endDay = parseInt(document.getElementById('tr-end-day')?.value);

    if (!startYear || !startMonth || !startDay || !endYear || !endMonth || !endDay) {
        listContainer.innerHTML = '<div class="empty-state" style="padding:20px; color:#94a3b8; font-size:13px;">请完善日期</div>';
        return;
    }

    const startDate = new Date(startYear, startMonth - 1, startDay);
    const endDate = new Date(endYear, endMonth - 1, endDay);

    const state = AppState;
    const pNodes = [];
    if (state.rootId) {
        (function walk(id) {
            const n = state.nodes[id];
            if (!n) return;
            if (n.type === 'P') {
                const acTime = viewDerived(state, n, 'acTime');
                if (acTime && acTime !== '----.--.-- --:--') {
                    const parts = acTime.split(' ')[0].split('.');
                    if (parts.length === 3) {
                        const y = parseInt(parts[0]);
                        const m = parseInt(parts[1]);
                        const d = parseInt(parts[2]);
                        const acDate = new Date(y, m - 1, d);
                        if (acDate >= startDate && acDate <= endDate) {
                            pNodes.push(n);
                        }
                    }
                }
            }
            for (const cid of state.childOrder[id]) {
                walk(cid);
            }
        })(state.rootId);
    }

    pNodes.sort((a, b) => {
        const timeA = viewDerived(state, a, 'acTime') || '----.--.-- --:--';
        const timeB = viewDerived(state, b, 'acTime') || '----.--.-- --:--';
        return timeB.localeCompare(timeA);
    });

    const filteredNodes = dedupRepresentatives(state, filterByMode(state, pNodes));

    currentTimeRangeResult = { startDate, endDate, pNodes: filteredNodes };
    // ★ 展示的是这一段 ⇒ 热力图按它淡化区间外（`kind:'range'`）
    setActiveSelection(startDate, endDate, 'range');

    const countEl = document.getElementById('tr-result-count');
    if (countEl) {
        countEl.textContent = `共 ${filteredNodes.length} 题`;
    }

    const dateRangeStr = `${startYear}/${startMonth}/${startDay} ~ ${endYear}/${endMonth}/${endDay}`;
    renderACListView({
        state,
        nodes: filteredNodes,
        title: dateRangeStr,
        containerId: 'time-range-ac-list',
        page: timeRangePage,
        onPageChange: (newPage) => {
            renderTimeRangeACList(newPage);
        },
        showCloseBtn: false,
        closeHandler: null
    });
}

/**
 * 按**当前账户范围**重算"此刻展示的那一段"的列表（`v9.1.7`）。
 *
 * 为什么必须有：列表只在**按下确定 / 点某一天**时建一次；换了「查看账户」以后，
 * 那份列表还是**旧口径**建的那一批，而它下面的统计 / 明细是按**当前**范围读值的
 * ⇒ 用户实测到的症状：**AC 是队友（teammate_b）提交的题，在当前范围下不该算"我的 AC"，
 * 却仍留在"时间范围 AC 列表"里**，于是统计里出现「未使用 / 已提交未通过」。
 * 每次重画（`heatmap.js:renderTrainingHeatmap`，`I_app.js` 每次刷新都会调）都重算一次，
 * 两边就同口径了。
 *
 * @returns {boolean} 真的重算了 = true（什么都没展示时不做事）
 */
export function refreshActiveACList() {
    if (currentDailyDate) {
        renderDailyACList(currentDailyDate, dailyACPage);
        return true;
    }
    if (currentTimeRangeResult) {
        renderTimeRangeACList(timeRangePage);
        return true;
    }
    return false;
}

export function bindTimeRangeControls() {
    // ★ v9.2.2：这一支**整体撤掉** —— "确定 / 重置"的行为搬进 `initTimeRangeControls` 传给
    //   共用组件的 `onApply` / `onReset` 回调里（组件自己给那两颗按钮挂监听）。
    //   ⚠️ 留给它的这个空函数**不许**被删掉再改调用点：`heatmap.js` 还按老样子调一下它，
    //   删了就不会红、而是"运行时说不清哪个函数没了"（保守起见保留成空实现 + 这句说明）。
}

// ================================================================
// 通用 AC 列表渲染（列表/统计模式切换）
// ================================================================
