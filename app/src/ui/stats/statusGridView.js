// ================================================================
// 「状态 × 难度」网格的**渲染**（ui/stats/statusGridView.js）
//
// 为什么单独一个文件：这张网格有**两个消费者** ——
//   · 「数据统计」页（柱子下面/上面那张表，`ui/stats/statsCharts.js`）；
//   · 训练计划的内层页（`ui/plan/planPage.js`，用户 2026-10-13："状态 × 难度的格式大可与统计页完全相同"）。
// 两个消费者 ⇒ **只能有一份渲染**（否则"看着一样、慢慢就分叉"是本仓最恨的坑）。
// 数据那一半仍然只有一份：`./statusGrid.js:statusGridOf`（纯函数、进 `npm test`）。
//
// ⚠️ **列的尺子与柱子共用**（`COL_GAP` / `AREA_PAD_LEFT` / `ROW_LABEL_W` 都从 `./statusGrid.js` 取）：
//    统计页柱子那一行的左留白、列宽、间距全靠它 ⇒ 改了这三个数，柱子和网格一起动（这才对得齐）。
// ⚠️ 网格一律用 `grid*` 前缀的 dataset：`data-level` / `data-status2` 是**柱段**的测试钩子。
// ================================================================
import { statusGridOf, STATUS2_ORDER, ALL_STATUS2, COL_GAP, AREA_PAD_LEFT, ROW_LABEL_W } from './statusGrid.js';
import { STATUS2_COLORS, XCPC_COLORS } from '../../A_constants.js';

/**
 * 画「状态2 × 难度档」网格。
 *
 * @param {HTMLElement} container
 * @param {Object} data `{ 难度档: { 状态2: 题数 } }`（与柱子**同一份**分档结果）
 * @param {Object} [config]
 *        `barWidth` 列宽（默认 34，**与柱子同宽**）、`selectedLevel`/`selectedStatus` 高亮哪一格、
 *        `onSegmentClick(level, status2)` 点格子的回调（统计页 = 柱子那一条；计划页 = 筛下面的列表）、
 *        `getLevelLabel(level)` 列标题怎么叫、
 *        ★ `showLevelNames` = 列标题**写出难度名**（默认 `false`）：
 *          统计页**不写**（柱子那一排就在下面/上面，写着是重复）；计划页**要写**（它没有柱子）。
 */
export function renderStatusGrid(container, data, config = {}) {
    const {
        barWidth = 34, selectedLevel = '', selectedStatus = '',
        onSegmentClick = null, getLevelLabel = (x) => x, showLevelNames = false
    } = config;
    const { levels, rows, colTotals, grand } = statusGridOf(data);
    if (levels.length === 0) return;
    // ★ 格子**可点**（`v9.1.4`，用户要的）：走的是**柱子那一条** `onSegmentClick`
    //   （同一个回调 ⇒ "效果与柱相同"是结构上保证的，不是两边各写一套筛选）。
    //   点表底「合计」那一行 ⇒ 传哨兵 `ALL_STATUS2`（那一档**所有状态**的题）。
    const bindCell = (el, level, status2) => {
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => {
            if (typeof onSegmentClick === 'function') onSegmentClick(String(level), status2);
        });
    };

    const box = document.createElement('div');
    box.className = 'stats-status-grid';
    box.style.cssText = `padding:0 ${AREA_PAD_LEFT}px 10px ${AREA_PAD_LEFT}px; font-size:11px;`;
    const rowCss = `display:flex; align-items:center; gap:${COL_GAP}px;`;
    const fixed = (w) => `width:${w}px; flex:0 0 ${w}px; box-sizing:border-box; text-align:center;`;

    // ---- 表头：左"状态2 ＼ 难度"、右"合计"；中间那排**默认只占位**（柱子下面已经有难度名了）----
    const head = document.createElement('div');
    head.className = 'ssg-head';
    head.style.cssText = rowCss;
    const headLabel = document.createElement('div');
    headLabel.textContent = '状态2 ＼ 难度';
    headLabel.style.cssText = `width:${ROW_LABEL_W}px; flex:0 0 ${ROW_LABEL_W}px; color:#64748b;`;
    head.appendChild(headLabel);
    for (let i = 0; i < levels.length; i++) {
        if (showLevelNames) {
            const th = document.createElement('div');
            th.className = 'ssg-head-level';
            th.dataset.gridLevel = String(levels[i]);
            th.textContent = String(getLevelLabel(levels[i]));
            // 档名可能比一列宽（"银牌+"还好，"未填写"就挤）⇒ 允许换行、缩一点行高
            // ★ 第 14 轮（用户："尽量给各处难度文本涂上应有的颜色"）：档名用**难度自己的颜色**
            //   （唯一色表 `A_constants.js:XCPC_COLORS`，与树上那个方框里的档名同一份）；
            //   「未填写」不在表里 ⇒ 保持原来的灰。
            th.style.cssText = `${fixed(barWidth)} color:${XCPC_COLORS[levels[i]] || '#64748b'}; `
                + 'line-height:1.1; word-break:break-all;';
            head.appendChild(th);
        } else {
            const spacer = document.createElement('div');
            spacer.style.cssText = `${fixed(barWidth)}`;
            head.appendChild(spacer);
        }
    }
    const headTotal = document.createElement('div');
    headTotal.textContent = '合计';
    headTotal.style.cssText = `${fixed(barWidth)} color:#64748b;`;
    head.appendChild(headTotal);
    box.appendChild(head);

    for (const row of rows) {
        const tr = document.createElement('div');
        tr.className = 'ssg-row';
        tr.dataset.gridStatus2 = String(row.s2);
        tr.style.cssText = rowCss + ' margin-top:2px;';

        const label = document.createElement('div');
        label.className = 'ssg-row-label';
        label.dataset.gridStatus2 = String(row.s2);
        label.style.cssText = `width:${ROW_LABEL_W}px; flex:0 0 ${ROW_LABEL_W}px; display:flex; align-items:center; gap:4px; color:#475569;`;
        const dot = document.createElement('span');
        // 色块与柱段、图例同一份颜色（`STATUS2_COLORS`）
        dot.style.cssText = 'width:10px; height:10px; flex:0 0 auto; display:inline-block; '
            + `background:${STATUS2_COLORS[row.s2] || '#e5e7eb'}; border:1px solid #000000;`;
        label.appendChild(dot);
        const name = document.createElement('span');
        name.textContent = row.label;
        // 名字比这一列宽（"已提交未通过"）⇒ 允许换行，别把列撑开
        name.style.cssText = 'line-height:1.15; word-break:break-word;';
        label.appendChild(name);
        tr.appendChild(label);

        row.cells.forEach((n, i) => {
            const cell = document.createElement('div');
            cell.className = 'ssg-cell';
            cell.dataset.gridLevel = String(levels[i]);
            cell.dataset.gridStatus2 = String(row.s2);
            cell.textContent = String(n);
            const on = String(levels[i]) === String(selectedLevel) && String(row.s2) === String(selectedStatus);
            // ★ 方格**背景染色**（用户 2026-10-13 要的）：色值取**同一份** `STATUS2_COLORS`
            //   —— 与柱段、图例逐字一致（这一行的格子看着就跟柱子里那一段一个色）。
            //   ⚠️ 零格用**半透明深色**文字：`赛时通过` 那行底色是亮绿，写浅灰数字会看不清；
            //   半透明深色在六种底色上都读得出来，不必为每行挑颜色。
            const bg = STATUS2_COLORS[row.s2] || '#e5e7eb';
            cell.style.cssText = `${fixed(barWidth)} padding:1px 0; border:1px solid #e2e8f0; `
                + `background:${bg}; color:${n === 0 ? 'rgba(15,23,42,0.35)' : '#0f172a'};`
                + (on ? ' outline:2px solid #1d4ed8; outline-offset:-2px;' : '');
            cell.title = `${getLevelLabel(levels[i])} · ${row.label}：${n} 题　—— 点一下把这一批列在图表下面`;
            bindCell(cell, levels[i], row.s2);
            tr.appendChild(cell);
        });

        const total = document.createElement('div');
        total.className = 'ssg-total';
        total.dataset.gridStatus2 = String(row.s2);
        total.textContent = String(row.total);
        // 合计格也**跟着这一行染色**（"每个方格背景染色"），只是加粗 + 边框深一点以示"这是合计"
        total.style.cssText = `${fixed(barWidth)} padding:1px 0; border:1px solid #cbd5e1; `
            + `background:${STATUS2_COLORS[row.s2] || '#e5e7eb'}; font-weight:600; color:#0f172a;`;
        tr.appendChild(total);

        box.appendChild(tr);
    }

    // ---- 最下面一行「合计」（用户 2026-10-13 要的）----
    // 左：文本「合计」；中：每一**档**的合计（= 原先画在柱子上面的那行数字，已从柱区撤掉）；
    // 最右那一格：**总数**（全部题数，也就是上面所有行合计之和）。
    // ★ 格式**照旧**：与其它行同一套格子（同样的列宽/边框），只是不染状态2的色（它不是某一种状态2）；
    //   用户明确"不用加框" ⇒ 别给这一行加外框 / 别换成另一套样式。
    const sum = document.createElement('div');
    sum.className = 'ssg-sum-row';
    sum.style.cssText = rowCss + ' margin-top:2px;';
    const sumLabel = document.createElement('div');
    sumLabel.className = 'ssg-sum-label';
    sumLabel.textContent = '合计';
    sumLabel.style.cssText = `width:${ROW_LABEL_W}px; flex:0 0 ${ROW_LABEL_W}px; color:#475569;`;
    sum.appendChild(sumLabel);
    colTotals.forEach((n, i) => {
        const cell = document.createElement('div');
        cell.className = 'ssg-col-total';
        cell.dataset.gridLevel = String(levels[i]);
        cell.textContent = String(n);
        const on = String(levels[i]) === String(selectedLevel) && String(selectedStatus) === ALL_STATUS2;
        cell.style.cssText = `${fixed(barWidth)} padding:1px 0; border:1px solid #e2e8f0; `
            + 'background:#f8fafc; color:#0f172a;'
            + (on ? ' outline:2px solid #1d4ed8; outline-offset:-2px;' : '');
        // ★ 点这一格 = 这一档**所有状态**的题（用户 2026-10-13："合计格的列表包含所有 stat2"）
        cell.title = `${getLevelLabel(levels[i])} · 全部状态：${n} 题　—— 点一下把这一批列在图表下面`;
        bindCell(cell, levels[i], ALL_STATUS2);
        sum.appendChild(cell);
    });
    const grandCell = document.createElement('div');
    grandCell.className = 'ssg-grand-total';
    grandCell.textContent = String(grand);
    grandCell.style.cssText = `${fixed(barWidth)} padding:1px 0; border:1px solid #cbd5e1; `
        + 'background:#f8fafc; font-weight:600; color:#0f172a;';
    sum.appendChild(grandCell);
    box.appendChild(sum);
    container.appendChild(box);
}

/** 网格表的行序（对外也留一份，免得别处再写一遍） */
export { STATUS2_ORDER, ALL_STATUS2 };
