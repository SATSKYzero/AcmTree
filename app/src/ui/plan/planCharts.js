// ================================================================
// 计划页的两张图（ui/plan/planCharts.js）
//
// 设计稿 `docs/training-plan.md` ⑱⑲⑳ 的**渲染**那一半（数据那一半是
// `core/trainingPlan.js:planChartSeriesOf`，纯函数、进 `npm test`）：
//   · 图① **累计**：折线（从计划起逐期累加）+ **斜直线**目标线（每期目标 × 期序）；
//   · 图② **每期**：柱（每期的量）+ **每期目标**那条水平线。
//
// ⚠️ **折线是仓里没有的组件**（全仓 `polyline|<svg|createElementNS` 零命中）：这里用**内联 SVG 字符串**
//    画（`div.innerHTML = '<svg>…'` 在 HTML5 里会把 `svg` 放进 SVG 命名空间，是真能渲染的），
//    于是**冒烟只能按字符串断言**（DOM 桩不解析 innerHTML）—— 真观感要在浏览器里看一眼。
//    ⚠️ 别改成 `document.createElementNS`：`scripts/smoke/dom.mjs` 没有那个 API（会当场炸）。
// ⚠️ 色值**只从 `A_constants.js` 取**（`STATUS2_COLORS` / `XCPC_COLORS` 那份），别在这儿另调一套色。
// ⚠️ **两张图各有自己的查看粒度**（⑳，住视图态）；切粒度**不动**计划自己的执行粒度。
// ⚠️ 显示方式 = **每张图各自可折叠 + 一颗「⇅ 换序」**（用户已选这种；等价于"全折/只①/只②/都显示两种上下序"5 态）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { el } from '../../utils/dom.js';
import { escapeHtml } from '../../utils/A_helpers.js';
// ★ 数字显示（最多一位小数）只有一份：`utils/num.js`
import { fmtAmount as fmt } from '../../utils/num.js';
import { STATUS2_COLORS } from '../../A_constants.js';
import { PLAN_GRAINS, planChartSeriesOf } from '../../core/trainingPlan.js';
import { planChartViewOf, setPlanChartView, scheduleViewSave } from '../../core/model/viewState.js';

// ★ 图表整体缩放（用户 2026-10-13 第 3 轮："两个图表的字与元素太小了，统一放大 2 倍"）。
//   ⚠️ **只用这一个系数**：字号、线宽、圆点、柱宽、内边距、画布高全乘它 ——
//      别在各处手改数字（改一半就会"字大了线还细"）。横向仍靠 `overflow-x:auto` 滚动。
const CHART_SCALE = 2;
const S = (n) => Math.round(n * CHART_SCALE);
const SVG_H = S(140);                                        // 画布高（含 x 轴标签那一行）
const PAD = { l: S(34), r: S(10), t: S(10), b: S(24) };
const STROKE = CHART_SCALE;                                  // 折线线宽
const DOT_R = 2.5 * CHART_SCALE;                             // 数据点半径
const DASH = `${S(4)} ${S(3)}`;                              // 目标线虚线
// ★ 轴上的字**不跟 `CHART_SCALE` 放大**（用户 2026-10-13 第 4 轮："图表内的所有灰字也放小到
//   「N 期 · 单位：强度」相同的大小"）—— 与块里那句灰色说明同为 11px。
const AXIS_FONT = 11;
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.7;';
// ★ 小块里的按钮**压扁到一半高**（用户第 4 轮："图表的'收起按钮'垂直大小应减半"）：
//   `.btn` 是全站按钮（`padding:6px 14px` ≈ 30px 高），图里那几个小控件要的是 ~16px。
//   ⚠️ **只在本文件这些"图块内的小按钮"上用**；别去改全局 `.btn`（全站按钮会一起变矮）。
const BTN_SM = 'padding:0 10px;font-size:11px;line-height:1.5;';
const GRAIN_LABEL = { day: '日', week: '周', month: '月', all: '整段' };
/** 折线最多标几个点的数值（点多了就只标刻度那几个：31 天全标会糊成一团） */
const VALUE_LABEL_MAX = 12;

/**
 * 悬停那一条信息（`<title>`，原生 tooltip；用户第 6 轮："最好还可光标悬停显示信息"）。
 * 内容按"那一项自己知道的东西"写：期、本期/累计的量、目标、达标、题数。
 */
function chartTip(p, series, kind) {
    const unit = series.unit || '';
    const lines = [String(p.label || '')];
    if (kind === '累计') {
        lines.push(`累计完成 ${fmt(p.cumulative)} ${unit}（目标线 ${fmt(p.goalCumulative)}）`);
    } else {
        lines.push(`本期完成 ${fmt(p.value)} ${unit}（目标 ${fmt(p.goal)}）`);
        if (typeof p.count === 'number') lines.push(`完成 ${p.count} 题`);
    }
    lines.push(p.reached === null ? '（这一段没定目标）' : (p.reached ? '✅ 达标' : '⬜ 没达标'));
    lines.push('点一下：下面列出这一期的题');
    return lines.join('\n');
}

/** 图上用的两条色（**都从仓里既有的色表取**，别自造色值） */
const LINE_COLOR = STATUS2_COLORS[4] || '#22c55e';     // 「赛时通过」那支绿
const GOAL_COLOR = '#94a3b8';                          // 目标线：中性灰（与"参考线"的语义一致）

/**
 * 期标签怎么在 x 轴上排（用户第 4 轮："日期要给换行"）。
 *
 * 一周的标签是 `2026.09.07~09.13` 这种长串，而柱子只有几十像素宽 ⇒ 不换行就**互相压成一团**
 * （实测那样的截图：一串日期糊在一起、谁都读不出）。
 * 规则：在 `~` 处断成两行；没有 `~`（日 `2026.09.13` / 月 `2026.09` / 整段）就一行。
 *
 * @returns {string[]} 1~2 行
 */
function chartLabelLines(label) {
    const s = String(label === undefined || label === null ? '' : label);
    const i = s.indexOf('~');
    return (i > 0) ? [s.slice(0, i), s.slice(i)] : [s];
}

/**
 * 画布宽：**保证标签排得下**（每期至少能放下"最长那一行"）。
 * 期多了就横向滚动（外层 `overflow-x:auto`）—— 宁可滚，也别让字叠在一起。
 */
function chartWidth(count, lines) {
    const longest = lines.reduce((m, one) => Math.max(m, String(one).length), 0);
    const perSlot = Math.max(S(26), Math.round(longest * AXIS_FONT * 0.62) + S(6));
    return Math.max(S(240), PAD.l + PAD.r + count * perSlot);
}

/** 一条标签画成 1~2 行（`<tspan>` 换行） */
function labelSpans(x, lines) {
    const baseY = SVG_H - S(6);
    if (lines.length === 1) {
        return `<text x="${x.toFixed(1)}" y="${baseY}" font-size="${AXIS_FONT}" fill="#94a3b8" text-anchor="middle">${escapeHtml(lines[0])}</text>`;
    }
    return `<text x="${x.toFixed(1)}" y="${(baseY - AXIS_FONT * 0.9).toFixed(1)}" font-size="${AXIS_FONT}" fill="#94a3b8" text-anchor="middle">`
        + `<tspan x="${x.toFixed(1)}">${escapeHtml(lines[0])}</tspan>`
        + `<tspan x="${x.toFixed(1)}" dy="${AXIS_FONT}">${escapeHtml(lines[1])}</tspan>`
        + '</text>';
}

/** 一条期的标签在 x 轴上要抽稀（期多了写不下）：最多画 8 个刻度 */
function tickIndexes(count, max = 8) {
    if (count <= max) return [...Array(count).keys()];
    const step = Math.ceil(count / max);
    const out = [];
    for (let i = 0; i < count; i += step) out.push(i);
    if (out[out.length - 1] !== count - 1) out.push(count - 1);
    return out;
}

/**
 * 折线图（图① 累计）：`y = cumulative`，另加一条**斜直线** `y = goalCumulative`。
 * @param {ReturnType<typeof import('../../core/trainingPlan.js').planChartSeriesOf>} series
 * @returns {string} `<svg>…</svg>` 字符串（同一条尺子：两张图共用 `series.cumulative` 那套）
 */
export function planLineChartSvg(series, opts = {}) {
    const pts = series.points || [];
    if (pts.length < 1) return '<div style="' + HINT + '">还没有期可画。</div>';
    const lines = pts.map((p) => chartLabelLines(p.label));
    const W = chartWidth(pts.length, lines);
    const innerW = W - PAD.l - PAD.r;
    const innerH = SVG_H - PAD.t - PAD.b;
    const maxY = Math.max(series.maxCumulative, 1);
    const xOf = (i) => PAD.l + (pts.length === 1 ? innerW / 2 : (innerW * i) / (pts.length - 1));
    const yOf = (v) => PAD.t + innerH - (innerH * Math.max(0, v)) / maxY;

    const actual = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.cumulative).toFixed(1)}`).join(' ');
    const goal = pts.map((p, i) => `${xOf(i).toFixed(1)},${yOf(p.goalCumulative).toFixed(1)}`).join(' ');
    // ★ 每个数据点一个可点/可悬停的圆（第 6 轮："每项显示数值 + 悬停看信息 + 点击呼出题目列表"）：
    //   圆圈本身承载 `data-plan-period`（点击由「每期完成情况」那块容器的委托接住）+ `<title>` 悬停信息。
    const dots = pts.map((p, i) => {
        const cx = xOf(i).toFixed(1);
        const cy = yOf(p.cumulative).toFixed(1);
        const on = opts.pick && p.key === opts.pick;
        return `<circle cx="${cx}" cy="${cy}" r="${on ? DOT_R + 2 : DOT_R}" fill="${LINE_COLOR}" `
            + `${on ? `stroke="#1d4ed8" stroke-width="2"` : ''} `
            + `data-plan-period="${escapeHtml(p.key)}" style="cursor:pointer">`
            + `<title>${escapeHtml(chartTip(p, series, '累计'))}</title></circle>`;
    }).join('');
    // 数值（折线点很多时只标刻度那几个 —— 31 个点全标会糊成一团）
    const valueIdx = (pts.length <= VALUE_LABEL_MAX) ? [...Array(pts.length).keys()] : tickIndexes(pts.length);
    const values = valueIdx.map((i) =>
        `<text x="${xOf(i).toFixed(1)}" y="${(yOf(pts[i].cumulative) - S(4)).toFixed(1)}" font-size="${AXIS_FONT}" `
        + `fill="#0f172a" text-anchor="middle">${fmt(pts[i].cumulative)}</text>`).join('');
    const labels = tickIndexes(pts.length).map((i) => labelSpans(xOf(i), lines[i])).join('');
    const yTicks = [0, maxY / 2, maxY].map((v) =>
        `<text x="${PAD.l - 4}" y="${(yOf(v) + 3).toFixed(1)}" font-size="${AXIS_FONT}" fill="#94a3b8" text-anchor="end">${fmt(v)}</text>`
    ).join('');
    return `<svg class="plan-line-svg" viewBox="0 0 ${W} ${SVG_H}" width="${W}" height="${SVG_H}" role="img">`
        + `<line x1="${PAD.l}" y1="${PAD.t + innerH}" x2="${W - PAD.r}" y2="${PAD.t + innerH}" stroke="#e2e8f0"/>`
        + `<polyline class="plan-goal-line" points="${goal}" fill="none" stroke="${GOAL_COLOR}" stroke-width="1.5" stroke-dasharray="${DASH}"/>`
        + `<polyline class="plan-actual-line" points="${actual}" fill="none" stroke="${LINE_COLOR}" stroke-width="${STROKE}"/>`
        + dots + values + yTicks + labels
        + '</svg>';
}

/**
 * 柱状图（图② 每期）：`y = value`，另加一条**每期目标**水平线。
 * @param {ReturnType<typeof import('../../core/trainingPlan.js').planChartSeriesOf>} series
 */
export function planBarChartSvg(series, opts = {}) {
    const pts = series.points || [];
    if (!pts.length) return '<div style="' + HINT + '">还没有期可画。</div>';
    const lines = pts.map((p) => chartLabelLines(p.label));
    const W = chartWidth(pts.length, lines);
    const innerW = W - PAD.l - PAD.r;
    const innerH = SVG_H - PAD.t - PAD.b;
    const maxY = Math.max(series.maxValue, 1);
    const slot = innerW / pts.length;
    const barW = Math.max(S(6), Math.min(S(18), slot * 0.6));
    const yOf = (v) => PAD.t + innerH - (innerH * Math.max(0, v)) / maxY;
    const bars = pts.map((p, i) => {
        const x = PAD.l + slot * i + (slot - barW) / 2;
        const y = yOf(p.value);
        const h = Math.max(0, PAD.t + innerH - y);
        // 达标那几根实心、没达标的浅一点（观感差别，不靠颜色区分状态）
        // 达标实心、没达标淡一点（只是观感差别；"达标"本身由 ✅/⬜ 与目标线说清）
        const opacity = p.reached === false ? '0.45' : '0.9';
        const on = opts.pick && p.key === opts.pick;
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" `
            + `fill="${LINE_COLOR}" opacity="${opacity}" data-plan-period="${escapeHtml(p.key)}" style="cursor:pointer"`
            + `${on ? ' stroke="#1d4ed8" stroke-width="2"' : ''}>`
            + `<title>${escapeHtml(chartTip(p, series, '这一期'))}</title></rect>`;
    }).join('');
    // ★ 每根柱子顶上写**数值**（第 6 轮："图表的每项应该显示数值"）
    const values = pts.map((p, i) => {
        const x = PAD.l + slot * i + slot / 2;
        const y = Math.max(PAD.t + AXIS_FONT, yOf(p.value) - S(3));
        return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${AXIS_FONT}" fill="#0f172a" `
            + `text-anchor="middle" pointer-events="none">${fmt(p.value)}</text>`;
    }).join('');
    // 目标水平线：每期目标其实**可能逐期不同**（月粒度天数不同）⇒ 画成一条**阶梯线**（不是一条水平线）
    const goalPts = [];
    for (let i = 0; i < pts.length; i++) {
        const g = pts[i].goal;
        const x0 = PAD.l + slot * i;
        const x1 = x0 + slot;
        const y = yOf(g);
        goalPts.push(`${x0.toFixed(1)},${y.toFixed(1)}`, `${x1.toFixed(1)},${y.toFixed(1)}`);
    }
    const labels = tickIndexes(pts.length).map((i) => labelSpans(PAD.l + slot * i + slot / 2, lines[i])).join('');
    const yTicks = [0, maxY / 2, maxY].map((v) =>
        `<text x="${PAD.l - 4}" y="${(yOf(v) + 3).toFixed(1)}" font-size="${AXIS_FONT}" fill="#94a3b8" text-anchor="end">${fmt(v)}</text>`
    ).join('');
    return `<svg class="plan-bar-svg" viewBox="0 0 ${W} ${SVG_H}" width="${W}" height="${SVG_H}" role="img">`
        + `<line x1="${PAD.l}" y1="${PAD.t + innerH}" x2="${W - PAD.r}" y2="${PAD.t + innerH}" stroke="#e2e8f0"/>`
        + bars
        + `<polyline class="plan-goal-steps" points="${goalPts.join(' ')}" fill="none" stroke="${GOAL_COLOR}" stroke-width="1.5" stroke-dasharray="${DASH}"/>`
        + values + yTicks + labels
        + '</svg>';
}

/**
 * 画"每期完成情况"的两张图那一块（含每张图自己的粒度选择器 + 折叠 + 换序）。
 *
 * @param {Object} plan
 * @param {(grain:string) => Object} dataOf 按粒度取 `planProgressOf` 结果（**由调用方传**：
 *        本文件不 import `planPage.js` —— 那边 import 本文件，硬引会成环）
 * @param {Function} redraw 重画整个内层页
 * @param {{pick?:string}} [opts] `pick` = 现在选中的期键（第 6 轮）：高亮那一根/那一点，
 *        并让每个形状都带 `data-plan-period`（点击由外层的委托接住 —— 本文件**不自己挂监听**）
 * @returns {HTMLElement}
 */
export function renderChartsBlock(plan, dataOf, redraw, opts = {}) {
    const view = planChartViewOf(AppState, plan.id);
    const wrap = el('div', '');
    wrap.dataset.planBlock = 'charts';

    const head = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;');
    head.appendChild(el('div', 'font-size:12px;color:#475569;font-weight:600;',
        '📉 两张图（① 累计 + 目标斜线 / ② 每期 + 目标线）'));
    const swap = document.createElement('button');
    swap.className = 'btn';
    swap.style.cssText = BTN_SM;                 // 用户第 4 轮：图块内的小按钮压扁到一半高
    swap.dataset.planChart = 'swap';
    swap.textContent = '⇅ 换序';
    swap.title = '把两张图上下对调';
    swap.addEventListener('click', () => {
        // 折叠/换序/粒度都是**视图态**：直接改 + 合并落盘（不进事务、不建历史步）
        setPlanChartView(AppState, plan.id, { order: view.order === 'line-bar' ? 'bar-line' : 'line-bar' });
        scheduleViewSave(AppState);
        redraw();
    });
    head.appendChild(swap);
    wrap.appendChild(head);

    const chartDefs = [
        { key: 'line', title: '① 累计（含目标斜线）', build: planLineChartSvg },
        { key: 'bar', title: '② 每期（含目标线）', build: planBarChartSvg }
    ];
    if (view.order === 'bar-line') chartDefs.reverse();

    for (const def of chartDefs) {
        const hidden = !!view.hidden[def.key];
        const grain = view.grain[def.key];
        const card = el('div', 'border:1px solid #eef2f6;border-radius:8px;padding:8px;margin-bottom:8px;');
        card.dataset.planChart = def.key;
        const bar = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
        bar.appendChild(el('span', 'font-size:12px;color:#334155;', def.title));

        const toggle = document.createElement('button');
        toggle.className = 'btn';
        toggle.style.cssText = BTN_SM;           // 同上：这一颗就是用户点名"垂直大小减半"的那个
        toggle.dataset.planChart = `${def.key}:toggle`;
        toggle.textContent = hidden ? '▸ 展开' : '▾ 收起';
        toggle.addEventListener('click', () => {
            const patch = { hidden: {} };
            patch.hidden[def.key] = !hidden;
            setPlanChartView(AppState, plan.id, patch);
            scheduleViewSave(AppState);
            redraw();
        });
        bar.appendChild(toggle);

        // 这张图**自己**的查看粒度（⑳：折线默认日、柱状默认周；与执行粒度无关）
        const grainSel = document.createElement('select');
        grainSel.style.cssText = 'padding:2px 4px;border:1px solid #d1d5db;border-radius:6px;font-size:11px;';
        grainSel.dataset.planChart = `${def.key}:grain`;
        for (const g of PLAN_GRAINS) {
            const opt = document.createElement('option');
            opt.value = g;
            opt.textContent = `按${GRAIN_LABEL[g] || g}`;
            grainSel.appendChild(opt);
        }
        grainSel.value = grain;
        grainSel.addEventListener('change', () => {
            const patch = { grain: {} };
            patch.grain[def.key] = grainSel.value;
            setPlanChartView(AppState, plan.id, patch);
            scheduleViewSave(AppState);
            redraw();
        });
        bar.appendChild(grainSel);
        // 这张图自己那一份数（**按它自己的粒度**现算，⑲⑳）—— 单位也写在标签上
        const series = planChartSeriesOf(dataOf(grain));
        bar.appendChild(el('span', 'font-size:11px;color:#94a3b8;',
            `${series.points.length} 期 · 单位：${series.unit}`));
        card.appendChild(bar);

        if (!hidden) {
            const body = el('div', 'margin-top:4px;overflow-x:auto;');
            body.dataset.planChart = `${def.key}:body`;
            body.innerHTML = def.build(series, opts);
            card.appendChild(body);
        }
        wrap.appendChild(card);
    }
    wrap.appendChild(el('div', HINT,
        '⚠️ 两张图各有自己的查看粒度（默认 折线=日 / 柱状=周），切换不影响计划的执行粒度，也不改你填的目标值。'
        + ' 目标线按"每天配额 × 期天数"折算。'));
    return wrap;
}
