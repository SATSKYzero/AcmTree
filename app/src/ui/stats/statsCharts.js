// ================================================================
// 题目统计图表（ui/statsCharts.js）
// 职责：柱状图统计（XCPC/CF 难度分布）
// ================================================================
import { AppState } from '../../shell/state.js';
import { difficultyValueOf } from '../../core/fieldRegistry.js';
import { execute } from '../../shell/executor.js';
import { collectByType } from '../../core/query/stats.js';
// ★「合并显示」：判重模式下图上按**组**计数（每组一条代表）
import { dedupRepresentatives } from '../../core/query/countMode.js';
import { filterByMode, FILTER_OPTIONS } from '../../view/filterMode.js';
import { STATUS2_COLORS, STATUS2_LABELS, XCPC_COLORS, DEFAULT_STATS_FILTER_MODE } from '../../A_constants.js';
import { getCfColor } from '../../utils/A_helpers.js';
import { XCPC_ORDER } from '../../utils/color.js';
import { viewValue, viewDerived, viewDerivedDisplay } from '../../view/scope.js';
import { renderNode } from '../../view/index.js';
// ★「点柱 ⇒ 看这一批」的节点行复用现成两份：树上那套只读方框 + 那一行入口条
//   （`ui/kit/nodeEntry.js` 只组合 `markGoto` / `btn-node-info` / `breadcrumbHtml` 三份现成的）
import { appendNodeEntries } from '../kit/nodeEntry.js';
// ★ 统计图下面那张「网格表」：行序（`STATUS2_ORDER`）与数据都从这一份纯模块取 ——
//   图与表**同一次分档结果**、**同一个堆叠顺序**，别再各算一遍（那是 `statsCharts` 里最容易分叉的地方）
import { STATUS2_ORDER, statusGridOf, ALL_STATUS2, COL_GAP, AREA_PAD_LEFT, ROW_LABEL_W } from './statusGrid.js';
// ★ 网格的**渲染**也搬出去了（统计页与训练计划内层页共用同一份）
import { renderStatusGrid } from './statusGridView.js';

// ================================================================
// 柱状图 与 网格表 **共用**的几何口径
//
// ★ 为什么要有这几个常量：用户要求"网格的列与柱状图的柱子**完全对齐**" ⇒ 两边必须用同一把尺子。
//   以前这些数字散在 `chartWrapper` 的 `padding` / `gap` 与 `barGroup.style.width` 里，
//   网格只要自己写一套就必然错位（差 1px 都看得出来）。改这里 = 两边一起改。
// ================================================================
/** 列间距：柱子之间、网格格之间（同一个值） */
// ⚠️ 网格/柱子的三件尺子（`COL_GAP` / `AREA_PAD_LEFT` / `ROW_LABEL_W`）与网格渲染器**都搬走了**：
//    它们现在住 `./statusGrid.js`（口径）与 `./statusGridView.js`（渲染）—— 训练计划内层页也要用同一份
//    （用户 2026-10-13："状态 × 难度的格式大可与统计页完全相同"）。

// ================================================================
// 模块级 UI 状态
// ================================================================
let statsChartType = 'xcpc';      // 'xcpc' | 'cf'
let statsCurrentNodeId = null;

/** 当前选中的柱段（`''` = 没选）—— 只影响观感与下面那块明细；**不影响图本身的分档口径** */
let selectedSegmentKey = '';
let selectedStatus = '';
/** 明细里那一批节点（点柱时按**算图同一份分档**筛出来的） */
let segmentNodes = [];
/** 记下"怎么重画这张图"：换筛选模式 / 关掉明细都走它（参数太长，不在各处重抄一遍） */
let rerenderChart = null;

// ================================================================
// 收集当前节点下所有 P 节点
// ★「合并显示」：**判重模式下每组只留一条代表**（同一道题在多个来源/比赛里
//   各有一份拷贝，图上只该算一次）。代表优先挑"答得出难度"的那条（难度**不在** `GROUP_FIELDS` 里，
//   是各副本自己的），否则取先出现的那条 —— 见 `core/query/countMode.js` 的 `dedupRepresentatives`。
// ================================================================
function collectPNodes(state, root) {
    const node = (root && typeof root === 'object') ? root : state.nodes[root];
    if (!node) return [];
    if (node.type === 'P' || node.type === 'R') return [];
    // ★ 子树从哪来由 `collectByType` 一处判据管：真实节点走 `childOrder`，
    //   **副页投影节点走它自己的 `children`**（交**节点对象**给它 —— 页内 id 查不到）。
    const ps = collectByType(state, node, 'P');
    return dedupRepresentatives(state, ps, { hasValue: (n) => hasAxisValue(state, n) });
}

/** 这条 P 能不能给出**分桶用的难度**（CF 数值 / XCPC 档位任一非空） */
function hasAxisValue(state, n) {
    const cf = Number(viewValue(state, n, 'cfDifficulty')) || 0;
    if (cf > 0) return true;
    // 难度不在 `GROUP_FIELDS` 里 ⇒ 读自己那份（"挑哪一份"由调用方的 `hasValue` 决定）
    const lv = viewDerived(state, n, 'xcpcDifficulty');
    return !!lv && lv !== '-';
}

// ================================================================
// XCPC 等级顺序统一取自 utils/color.js（唯一真源）
// ================================================================

// ================================================================
// ★ 分档口径（**唯一一份**，图与"点柱筛出那一批"共用）
//
// 原先 `buildXcpcData` / `buildCfData` 各自在循环里算键，而"这一档对应哪些题"
// 本来没人算过 ⇒ 点柱要落地就必须把这件事收成**一处**，否则一定会分叉
// （症状：图上那一档 137 题、点进去列出来 139 题，而两边都没有报错）。
// 所以：数据构建、柱高、明细列表**都从这两个函数取键**。
// ================================================================

/**
 * 一档 XCPC 难度在图上那个键。
 *
 * 与 `buildXcpcData` 逐字同口径：值取**显示列**（`viewDerivedDisplay`），
 * 空 / `'-'` / 不在 `XCPC_ORDER` 里的值都算「未填写」。
 */
export function xcpcBucketOf(state, p) {
    const level = viewDerivedDisplay(state, p, 'xcpcDifficulty') || '未填写';
    if (!level || level === '-' || !XCPC_ORDER.includes(level)) return '未填写';
    return level;
}

/**
 * 一根 CF 难度柱在图上那个键。
 *
 * 与 `buildCfData` 逐字同口径：数值走 `difficultyValueOf`（**显示列**取值器），
 * `<800` 与 `>=5000` 都归「其他（<800）」，其余按 100 一桶。
 * ⚠️ 阈值仍是 CF 那套（见 `buildCfData` 里那条已知近似）。
 */
export function cfBucketOf(state, p) {
    const diff = difficultyValueOf(state, p,
        { shownValue: (n, f) => viewDerivedDisplay(state, n, f) ?? viewValue(state, n, f) }).value;
    if (diff < 800 || diff > 4999) return '其他（<800）';
    const lower = Math.floor(diff / 100) * 100;
    return `${lower}-${lower + 99}`;
}

// ================================================================
// XCPC 数据构建
// ================================================================
function buildXcpcData(state, pNodes) {
    const groups = {};
    for (const level of XCPC_ORDER) {
        groups[level] = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    }
    groups['未填写'] = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

    // ★ 分档键与 `xcpcBucketOf` 是**同一份**（见那一段的说明）
    for (const p of pNodes) {
        const s2 = viewDerivedDisplay(state, p, 'status2') ?? 0;
        const level = xcpcBucketOf(state, p);
        groups[level][s2] = (groups[level][s2] || 0) + 1;
    }

    const result = {};
    for (const [level, counts] of Object.entries(groups)) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total > 0) {
            result[level] = counts;
        }
    }

    const sortedResult = {};
    if (result['未填写']) {
        sortedResult['未填写'] = result['未填写'];
        delete result['未填写'];
    }
    for (const level of XCPC_ORDER) {
        if (result[level]) {
            sortedResult[level] = result[level];
        }
    }
    for (const [level, counts] of Object.entries(result)) {
        if (!sortedResult[level]) {
            sortedResult[level] = counts;
        }
    }
    return sortedResult;
}

// ================================================================
// CF 数据构建
// ================================================================
function buildCfData(state, pNodes) {
    const groups = {};

    for (const p of pNodes) {
        const s2 = viewDerivedDisplay(state, p, 'status2') ?? 0;
        // ★ 分档键与 `cfBucketOf` 是**同一份**（见那一段的说明）；
        //   口径与树上/小方框一致 —— ★ 按**显示列**取：`plain` ⇒ 自己那份，去重 ⇒ 组那份。
        const key = cfBucketOf(state, p);

        if (!groups[key]) {
            groups[key] = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        }
        groups[key][s2] = (groups[key][s2] || 0) + 1;
    }

    const result = {};
    if (groups['其他（<800）']) {
        const total = Object.values(groups['其他（<800）']).reduce((a, b) => a + b, 0);
        if (total > 0) {
            result['其他（<800）'] = groups['其他（<800）'];
        }
        delete groups['其他（<800）'];
    }

    const sortedKeys = Object.keys(groups).sort((a, b) => {
        const aStart = parseInt(a.split('-')[0]);
        const bStart = parseInt(b.split('-')[0]);
        if (isNaN(aStart)) return 1;
        if (isNaN(bStart)) return -1;
        return aStart - bStart;
    });

    for (const key of sortedKeys) {
        const total = Object.values(groups[key]).reduce((a, b) => a + b, 0);
        if (total > 0) {
            result[key] = groups[key];
        }
    }
    return result;
}

// ================================================================
// 颜色工具
// ================================================================
function getXcpcColor(level) {
    if (level === '未填写') return '#94a3b8';
    return XCPC_COLORS[level] || '#94a3b8';
}

function getCfRangeColor(rangeKey) {
    if (rangeKey === '其他（<800）') return '#94a3b8';
    const parts = rangeKey.split('-');
    if (parts.length !== 2) return '#94a3b8';
    const start = parseInt(parts[0]);
    if (isNaN(start)) return '#94a3b8';
    const mid = start + 50;
    return getCfColor(mid);
}

// ================================================================
// 最大柱高
// ================================================================
function getMaxCount(data) {
    let max = 0;
    for (const [, counts] of Object.entries(data)) {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total > max) max = total;
    }
    return Math.max(max, 1);
}

// ================================================================
// 柱状图渲染（通用）
//
// `config` 里与交互有关的四个（都可省，省了就退回"死图"的老样子）：
//   `onSegmentClick(levelKey, status2, ev)` 点某一段柱
//   `selectedLevel` / `selectedStatus`      当前选中的那一段（只影响观感）
//   `getLevelLabel(level)`                  柱下面那个标签（标题里也用它）
// ================================================================
/**
 * 图表下面那张「网格表」（用户 2026-10-13 要的）：行 = 状态2、列 = 难度档、格内 = 题数、
 * 每行最右 = 该状态2的合计。
 *
 * ★ **列与柱子逐列对齐**靠三件事（都在上面的常量里，两边共用）：
 *   ① 同样的左内边距 `AREA_PAD_LEFT`（柱子那一行左边还有一格 `ROW_LABEL_W` 的空位）；
 *   ② 同样的列宽 `config.barWidth`（`flex:0 0` ⇒ 不被内容挤开）+ 同样的列间距 `COL_GAP`；
 *   ③ **同一个横向滚动区**（调用方把它和柱子放进同一个 `scrollArea`）——
 *      少了这条，图能横滚、表不动，列就白对了。
 *
 * 行序 = `STATUS2_ORDER`（正序，`未使用` 在最上）—— 用户先说"要相反"、随后明确"别反了"，
 * 别再顺手改成倒序；数据与行序都在 `./statusGrid.js:statusGridOf`（纯函数，有 Node 单测）。
 */

function renderBarChart(container, data, config) {
    const {
        getLevelLabel, getLevelColor, maxHeight = 280, barWidth = 36,
        onSegmentClick = null, selectedLevel = '', selectedStatus = ''
    } = config;
    const maxCount = getMaxCount(data);
    const levels = Object.keys(data);
    // 堆叠顺序取**唯一一份** `STATUS2_ORDER`（网格表的行序也从它来）
    const statusOrder = STATUS2_ORDER;

    if (levels.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">
                <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">📊</div>
                <p>当前节点下没有题目数据</p>
            </div>
        `;
        return;
    }

    const chartWrapper = document.createElement('div');
    chartWrapper.className = 'stats-bar-row';
    chartWrapper.style.cssText = `
        display: flex;
        flex-direction: row;
        align-items: flex-end;
        gap: ${COL_GAP}px;
        padding: 16px ${AREA_PAD_LEFT}px 8px ${AREA_PAD_LEFT}px;
        min-height: ${maxHeight + 40}px;
        border-bottom: 2px solid #e2e8f0;
    `;
    // ⚠️ 横向滚动**不在这里**：挪到外面那个 `scrollArea`（与网格表同一个滚动区）
    //    —— 否则"图能横滚、表不动"，列就白对齐了。
    // 左边先占一格与网格「状态2」标签列**同样宽**的空位 ⇒ 两边的第一列都从那之后开始
    const chartGutter = document.createElement('div');
    chartGutter.className = 'stats-bar-gutter';
    chartGutter.style.cssText = `width:${ROW_LABEL_W}px; flex:0 0 ${ROW_LABEL_W}px;`;
    chartWrapper.appendChild(chartGutter);

    for (const level of levels) {
        const counts = data[level];
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        const heightRatio = total / maxCount;
        const barHeight = Math.max(heightRatio * maxHeight, total > 0 ? 4 : 0);

        const barGroup = document.createElement('div');
        barGroup.style.cssText = `
            display: flex;
            flex-direction: column;
            align-items: center;
            flex-shrink: 0;
            width: ${barWidth}px;
        `;

        const barContainer = document.createElement('div');
        barContainer.style.cssText = `
            display: flex;
            flex-direction: column-reverse;
            align-items: stretch;
            width: 100%;
            height: ${maxHeight}px;
            border: 1px solid #e2e8f0;
            border-radius: 2px;
            overflow: hidden;
            background: #f8fafc;
            position: relative;
        `;

        let stacked = 0;
        const nonEmpty = Object.keys(counts).filter(k => counts[k] > 0).length;
        for (const s2 of statusOrder) {
            const count = counts[s2] || 0;
            if (count === 0) continue;

            const segmentHeight = (count / total) * barHeight;
            const seg = document.createElement('div');
            const color = STATUS2_COLORS[s2] || '#e5e7eb';
            seg.style.cssText = `
                height: ${segmentHeight}px;
                min-height: 2px;
                background: ${color};
                border: 1px solid #000000;
                border-width: 1px 1px 0 1px;
                flex-shrink: 0;
                transition: height 0.2s;
            `;
            if (stacked === 0) {
                seg.style.borderBottomWidth = '1px';
            }
            if (stacked === nonEmpty - 1) {
                seg.style.borderTopWidth = '1px';
            }
            // ★ 柱段可点（`v9.0.18`）：点一下 ⇒ 把**这一档 × 这一状态**那一批题列在图表下面。
            //   分档口径就是上面那两个 `*BucketOf`（与算图同一份）；状态就是这段的 `s2`。
            //   `title` 把"点了会做什么"写出来（不然这就是个没人知道能点的色块）。
            const statusLabel = STATUS2_LABELS[s2] || String(s2);
            seg.dataset.level = level;
            seg.dataset.status2 = String(s2);
            seg.style.cursor = 'pointer';
            seg.title = `${getLevelLabel(level)} · ${statusLabel}：${count} 题　—— 点一下把这一批列在图表下面`;
            if (level === selectedLevel && String(s2) === String(selectedStatus)) {
                seg.style.outline = '2px solid #1d4ed8';
                seg.style.outlineOffset = '-2px';
            }
            seg.addEventListener('click', (ev) => {
                if (typeof onSegmentClick === 'function') onSegmentClick(level, s2, ev);
            });
            barContainer.prepend(seg);
            stacked++;
        }

        if (stacked === 0) {
            const seg = document.createElement('div');
            seg.style.cssText = `
                height: 4px;
                min-height: 2px;
                background: #f1f5f9;
                border: 1px solid #e2e8f0;
            `;
            barContainer.appendChild(seg);
        }

        // ★ 柱子上面那行"每档合计"**已撤销**（用户 2026-10-13：搬进网格表当最下面那行「合计」）——
        //   它的值现在由 `renderStatusGrid` 的 `colTotals` 给出（同一份求和，别在这里再画一遍）。

        const levelLabel = document.createElement('div');
        const labelColor = getLevelColor(level);
        levelLabel.textContent = getLevelLabel(level);
        levelLabel.style.cssText = `
            font-size: 11px;
            font-weight: 600;
            color: ${labelColor};
            margin-top: 4px;
            text-align: center;
            word-break: break-word;
            max-width: ${barWidth + 16}px;
            line-height: 1.3;
        `;

        barGroup.appendChild(barContainer);
        barGroup.appendChild(levelLabel);
        chartWrapper.appendChild(barGroup);
    }

    // ★ 柱子与网格表放**同一个横向滚动区**（列对齐的必要条件之一，见 `renderStatusGrid` 的文件头）。
    //   顺序：**网格表在上、柱状图在下**（用户 2026-10-13："表格与柱状图交换位置"）——
    //   两块仍在同一个滚动区里，所以横滚时列照旧一起动。
    const scrollArea = document.createElement('div');
    scrollArea.className = 'stats-chart-scroll';
    scrollArea.style.cssText = 'overflow-x: auto;';
    renderStatusGrid(scrollArea, data, config);
    scrollArea.appendChild(chartWrapper);

    container.innerHTML = '';
    container.appendChild(scrollArea);

    const legend = document.createElement('div');
    legend.style.cssText = `
        display: flex;
        flex-wrap: wrap;
        gap: 8px 16px;
        padding: 12px 8px 4px 8px;
        font-size: 12px;
        color: #475569;
        border-top: 1px solid #eef2f6;
        margin-top: 8px;
    `;
    for (let i = 0; i <= 5; i++) {
        const item = document.createElement('span');
        item.style.cssText = `display: inline-flex; align-items: center; gap: 4px;`;
        const dot = document.createElement('span');
        dot.style.cssText = `
            width: 14px;
            height: 14px;
            background: ${STATUS2_COLORS[i] || '#e5e7eb'};
            border: 1px solid #000000;
            border-radius: 2px;
            display: inline-block;
        `;
        item.appendChild(dot);
        const label = document.createTextNode(STATUS2_LABELS[i]);
        item.appendChild(label);
        legend.appendChild(item);
    }
    container.appendChild(legend);
}

// ================================================================
// ★「这一批是哪几道题」—— 点柱段之后列在图表下面的那一块（`v9.0.18`）
//
// 复用现成的两份：树上那套**只读**节点方框（`view/renderers.js:renderNode(...'readonly')`）
// 与节点行入口条（`ui/kit/nodeEntry.js`：🔎 / 📋 / 面包屑）——
// ⚠️ **不自造节点行、不自造第二套筛选器**（`docs/node-navigation.md` 第 5 节）。
// 这一批节点是**按算图同一份分档**从"图上那份列表"里筛出来的（`batchOf`），
// 所以列出来的条数与柱段上的数字**同源**。
// ================================================================
function renderSegmentDetail(container, state, batch, label) {
    const box = document.createElement('div');
    box.className = 'stats-segment-detail';
    box.style.cssText = 'margin-top:10px; padding:8px 4px; border-top:2px solid #dbeafe;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px;';
    const title = document.createElement('span');
    title.style.cssText = 'font-size:13px; font-weight:600; color:#0f172a;';
    title.textContent = `📌 ${label}：${batch.length} 题（点上面的柱段换一批）`;
    head.appendChild(title);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn stats-segment-close';
    close.style.cssText = 'padding:1px 8px; font-size:12px; cursor:pointer;';
    close.textContent = '✖ 收起';
    close.addEventListener('click', (ev) => {
        if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
        selectedSegmentKey = '';
        selectedStatus = '';
        segmentNodes = [];
        if (typeof rerenderChart === 'function') rerenderChart();
    });
    head.appendChild(close);
    box.appendChild(head);

    if (!batch.length) {
        const none = document.createElement('div');
        none.style.cssText = 'font-size:12px; color:#94a3b8;';
        none.textContent = '这一批现在是空的。';
        box.appendChild(none);
        container.appendChild(box);
        return;
    }

    const rows = document.createElement('div');
    rows.className = 'stats-segment-rows';
    rows.style.cssText = 'display:flex; flex-direction:column; gap:2px; max-height:520px; overflow-y:auto;';
    batch.forEach((node, i) => {
        rows.innerHTML += renderNode(state, node, i, [], null, true, 'readonly');
    });
    box.appendChild(rows);
    container.appendChild(box);

    // ⚠️ 方框来自 `innerHTML` ⇒ 冒烟桩里查不到它们（见 `ui/kit/nodeEntry.js` 的说明）；
    //    这里只保证**接线**与 AC 列表那两处一样（源码级守卫也盯着这条）。
    appendNodeEntries(box, state, '.stats-segment-rows');
}

// ================================================================
// 渲染题目分布统计
// ================================================================
export function renderStatsChart(state, nodeId, chartType = null, pNodes = null, containerId = 'stats-chart-container', useIndependentSetting = false) {
    if (chartType) statsChartType = chartType;

    const container = document.getElementById(containerId);
    if (!container) return;

    function getShowSpecialGroups() {
        if (useIndependentSetting) {
            return state.settings.stats.acStatsShowSpecial !== undefined
                ? state.settings.stats.acStatsShowSpecial
                : true;
        }
        return state.settings.stats.showSpecialGroups !== undefined
            ? state.settings.stats.showSpecialGroups
            : true;
    }

    function setShowSpecialGroups(value) {
        execute(
            (draft) => {
                if (useIndependentSetting) {
                    draft.settings.stats.acStatsShowSpecial = value;
                } else {
                    draft.settings.stats.showSpecialGroups = value;
                }
            },
            { skipHistory: true, validate: false }
        ).catch(() => {});
    }

    let collectedPNodes = pNodes;
    if (!collectedPNodes || collectedPNodes.length === 0) {
        // `nodeId` 收**节点对象或 id 都行**（副页节点的 id 是页内 id，`state.nodes` 里查不到）
        const node = (nodeId && typeof nodeId === 'object') ? nodeId : (nodeId ? state.nodes[nodeId] : null);
        if (!node) {
            console.error('[renderStatsChart] 调用错误：未提供 pNodes 且节点不存在');
            container.innerHTML = `<div class="empty-state"><p>❌ 数据源缺失：请检查调用参数</p></div>`;
            return;
        }
        if (node.type === 'P' || node.type === 'R') {
            container.innerHTML = `
                <div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">
                    <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">🚫</div>
                    <p style="font-size:16px; font-weight:500;">当前节点不支持题目分布统计</p>
                    <p style="font-size:13px; margin-top:4px;">仅 O / W / S / C 节点支持</p>
                </div>
            `;
            return;
        }
        collectedPNodes = collectPNodes(state, nodeId);
    }

    if (collectedPNodes.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">
                <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">📭</div>
                <p>当前节点下没有题目</p>
            </div>
        `;
        return;
    }

    if (nodeId) statsCurrentNodeId = nodeId;

    const filterMode = state.settings.stats.statsFilterMode || DEFAULT_STATS_FILTER_MODE;
    // 判据在 `view/filterMode.js`（**唯一一份**：统计图 / 热力图 / 比赛概览共用）
    const filteredPNodes = filterByMode(state, collectedPNodes, filterMode);

    container.innerHTML = '';

    const controlsDiv = document.createElement('div');
    controlsDiv.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 4px 12px 4px;
        border-bottom: 1px solid #eef2f6;
        margin-bottom: 8px;
        flex-wrap: wrap;
    `;

    const filterLabel = document.createElement('span');
    filterLabel.textContent = '筛选模式：';
    filterLabel.style.cssText = 'font-size:13px; color:#475569;';

    const filterSelect = document.createElement('select');
    filterSelect.style.cssText = 'padding:3px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff; cursor:pointer;';
    // 选项文案从共用件取（与比赛概览同一份）
    for (const opt of FILTER_OPTIONS) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.title) option.title = opt.title;
        if (opt.value === filterMode) option.selected = true;
        filterSelect.appendChild(option);
    }
    filterSelect.addEventListener('change', function () {
        execute(
            (draft) => { draft.settings.stats.statsFilterMode = this.value; },
            { skipHistory: true, validate: false }
        ).catch(() => {});

        if (nodeId) {
            renderStatsChart(state, nodeId, statsChartType, null, containerId, useIndependentSetting);
        } else if (pNodes && pNodes.length > 0) {
            renderStatsChart(state, null, statsChartType, pNodes, containerId, useIndependentSetting);
        } else {
            console.error('[renderStatsChart] 切换筛选时无法确定数据源');
            container.innerHTML = `<div class="empty-state"><p>❌ 数据源丢失，无法切换筛选</p></div>`;
        }
    });

    controlsDiv.appendChild(filterLabel);
    controlsDiv.appendChild(filterSelect);

    if (useIndependentSetting) {
        const hint = document.createElement('div');
        hint.textContent = '由于技术限制，在本页面修改筛选模式需要刷新后才能得到正确结果';
        hint.style.cssText = 'font-size:11px; color:#94a3b8; margin-top:2px; width:100%;';
        controlsDiv.appendChild(hint);
    }

    const showSpecial = getShowSpecialGroups();
    const label = document.createElement('label');
    label.style.cssText = `display: flex; align-items: center; gap: 6px; font-size: 13px; color: #475569; cursor: pointer; user-select: none;`;
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = showSpecial;
    checkbox.style.cssText = `width: 16px; height: 16px; cursor: pointer; accent-color: #2563eb;`;
    const labelText = document.createTextNode(`显示“${statsChartType === 'cf' ? '其他（<800）' : '未填写'}”项`);
    label.appendChild(checkbox);
    label.appendChild(labelText);
    controlsDiv.appendChild(label);

    container.appendChild(controlsDiv);

    checkbox.addEventListener('change', function () {
        const newValue = this.checked;
        setShowSpecialGroups(newValue);
        if (nodeId) {
            renderStatsChart(state, nodeId, statsChartType, null, containerId, useIndependentSetting);
        } else if (pNodes && pNodes.length > 0) {
            renderStatsChart(state, null, statsChartType, pNodes, containerId, useIndependentSetting);
        } else {
            console.error('[renderStatsChart] 切换复选框时无法确定数据源');
            container.innerHTML = `<div class="empty-state"><p>❌ 数据源丢失，无法切换</p></div>`;
        }
    });

    if (filteredPNodes.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.style.cssText = 'padding:40px 20px; text-align:center; color:#94a3b8;';
        emptyDiv.innerHTML = `
            <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">🔍</div>
            <p>当前筛选条件下没有匹配的题目</p>
        `;
        container.appendChild(emptyDiv);
        return;
    }

    let fullData;
    if (statsChartType === 'cf') {
        fullData = buildCfData(state, filteredPNodes);
    } else {
        fullData = buildXcpcData(state, filteredPNodes);
    }

    let filteredData = {};
    const specialKeys = statsChartType === 'cf' ? ['其他（<800）'] : ['未填写'];
    for (const [key, counts] of Object.entries(fullData)) {
        if (showSpecial || !specialKeys.includes(key)) {
            filteredData[key] = counts;
        }
    }

    if (Object.keys(filteredData).length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'empty-state';
        emptyDiv.style.cssText = 'padding:40px 20px; text-align:center; color:#94a3b8;';
        emptyDiv.innerHTML = `
            <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">🔍</div>
            <p>已隐藏所有特殊分组，无数据可显示</p>
        `;
        container.appendChild(emptyDiv);
        return;
    }

    let config;
    if (statsChartType === 'cf') {
        config = {
            getLevelLabel: (level) => level,
            getLevelColor: (level) => getCfRangeColor(level),
            maxHeight: 280,
            barWidth: 34
        };
    } else {
        config = {
            getLevelLabel: (level) => level,
            getLevelColor: (level) => getXcpcColor(level),
            maxHeight: 280,
            barWidth: 34
        };
    }

    // ★ 点柱段 ⇒ 把**这一档 × 这一状态**那一批题列在图表下面（`v9.0.18`）。
    //   分档口径 = 上面那两个 `*BucketOf`（**唯一一份**，与算图共用）；
    //   候选池 = `filteredPNodes`（图上那份，已经过筛选模式 / 合并显示）⇒ 计数与柱段同源。
    //   ⚠️ 这一层能在几个筛选/勾选回调里被重画（换筛选模式 / 显示特殊项）——
    //      重画走的是各自的 `renderStatsChart(...)`，选择被记住；但那时**分档可能已经变了**
    //      （例如筛选模式换了、候选池换了）⇒ 也重新筛一遍那一批，不沿用旧的列表。
    const bucketOf = statsChartType === 'cf' ? cfBucketOf : xcpcBucketOf;
    // ⚠️ `status2` 可能是**哨兵** `ALL_STATUS2`（点表底「合计」那一格）⇒ 那时只按档筛、**不看状态2**。
    //    柱段点击传的是真的 `0..5`，两条路共用这一个函数 ⇒ 口径不会分叉。
    const recomputeBatch = (levelKey, status2) => filteredPNodes.filter(
        (p) => bucketOf(state, p) === levelKey
            && (String(status2) === ALL_STATUS2
                || Number(viewDerivedDisplay(state, p, 'status2') ?? 0) === Number(status2)));
    if (selectedSegmentKey !== '') segmentNodes = recomputeBatch(selectedSegmentKey, selectedStatus);
    // 选中的那一档被隐藏了（"显示特殊项"关掉）⇒ 明细跟着收起，别留一个指向不存在柱段的列表
    if (selectedSegmentKey !== '' && !(selectedSegmentKey in filteredData)) {
        selectedSegmentKey = '';
        selectedStatus = '';
        segmentNodes = [];
    }
    // 记下"怎么重画"：点柱 / 收起明细都走它（参数一长就容易在各处抄漏一项）。
    // ⚠️ 转交的仍是**调用方原来给的那一份**参数（`null` 就还是 `null`）——
    //    擅自把 `pNodes` 换成别的东西会让"AC 列表那一处传进来的题集"被重新采集一遍。
    rerenderChart = () => renderStatsChart(
        state, nodeId, statsChartType, pNodes, containerId, useIndependentSetting);
    config.onSegmentClick = (levelKey, status2) => {
        if (selectedSegmentKey === levelKey && String(selectedStatus) === String(status2)) {
            // 再点同一段 = 收起（省得去找那个"收起"按钮）
            selectedSegmentKey = '';
            selectedStatus = '';
            segmentNodes = [];
        } else {
            selectedSegmentKey = levelKey;
            selectedStatus = String(status2);
            segmentNodes = recomputeBatch(levelKey, status2);
        }
        rerenderChart();
    };
    config.selectedLevel = selectedSegmentKey;
    config.selectedStatus = selectedStatus;

    const chartContainer = document.createElement('div');
    chartContainer.id = 'chart-inner-container';
    container.appendChild(chartContainer);
    renderBarChart(chartContainer, filteredData, config);

    // 明细块（点过柱段 / 点过表格格子才有内容）
    if (selectedSegmentKey !== '') {
        const statusLabel = String(selectedStatus) === ALL_STATUS2
            ? '全部状态'
            : (STATUS2_LABELS[selectedStatus] || selectedStatus);
        const label = `${config.getLevelLabel(selectedSegmentKey)} · ${statusLabel}`;
        renderSegmentDetail(container, state, segmentNodes, label);
    }

    document.querySelectorAll('.stats-sub-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.chart === statsChartType);
    });
}

// ================================================================
// 初始化
// ================================================================
export function initStatsCharts() {
    document.querySelectorAll('.stats-sub-tab-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const chartType = this.dataset.chart;
            if (chartType && statsCurrentNodeId) {
                renderStatsChart(AppState, statsCurrentNodeId, chartType);
            }
        });
    });

    document.addEventListener('folder-changed', (e) => {
        const nodeId = e.detail?.nodeId;
        if (nodeId) {
            const activeViewTab = document.querySelector('.folder-view-tab-btn.active');
            if (activeViewTab && activeViewTab.dataset.view === 'stats') {
                renderStatsChart(AppState, nodeId);
            }
        }
    });
}
