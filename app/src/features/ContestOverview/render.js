// ================================================================
// 比赛补题概览 — 渲染（features/ContestOverview/render.js）
// 职责：把「比赛 → 题目」结构渲染成大矩形 + 每比赛一行小矩形
// 依赖：axis.js, constants.js, A_constants.js
// 说明：
//   - 本模块只产出 HTML 字符串，**不碰 DOM**，可在 Node 测试中直接引用
//   - 自带纯函数转义器（utils/html.js 的 escapeHtml 依赖 document 且不转义引号，
//     不适合用在 title="..." 这类属性里）
// ================================================================
import { STATUS2_COLORS, STATUS2_LABELS, XCPC_COLORS } from '../../A_constants.js';
import { buildBands, layoutRow, cfDomainMax } from './axis.js';
import { escapeHtml as esc } from '../../utils/html.js';

/** 默认取值器：直接读缓存字段；插件会传入按查看范围取值的版本 */
const cacheRead = {
    value: (node, field) => node[field],
    derived: (node, field) => node[field]
};
import {
    NAME_GUTTER_W,
    ROW_H,
    CANVAS_PAD,
    BAND_ALPHA,
    SELECTED_RING,
    SPECIAL_LABEL,
    SPECIAL_COLOR,
    SPECIAL_BAND_W
} from './constants.js';

// ================================================================
// 工具
// ================================================================

/** 纯函数 HTML 转义（含引号，可安全用于属性） */
/** '#rrggbb' + alpha → 'rgba(r,g,b,a)'；解析失败时原样返回 */
function withAlpha(hex, alpha) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

/** 取题号显示文本（走同一个 `read`，别在同一个屏上混两套口径） */
function problemLabel(p, read = cacheRead) {
    const id = read.value(p, 'problemId');
    return id === undefined || id === null || id === '' ? '?' : String(id);
}

/** 取点颜色（按 status2） */
function dotColor(p, read) {
    const s2 = read.derived(p, 'status2') ?? 0;
    return STATUS2_COLORS[s2] || '#ffffff';
}

/** 取 status2 文案 */
function status2Text(p, read) {
    const s2 = read.derived(p, 'status2') ?? 0;
    return STATUS2_LABELS[s2] || String(s2);
}

/** 难度文案（用于 tooltip） */
function difficultyText(p, chartType, read) {
    if (chartType === 'cf') {
        const d = Number(read.value(p, 'cfDifficulty')) || 0;
        return d >= 800 ? `CF ${d}` : SPECIAL_LABEL.cf;
    }
    const lv = read.derived(p, 'xcpcDifficulty');
    return lv && lv !== '-' ? `XCPC ${lv}` : SPECIAL_LABEL.xcpc;
}

// ================================================================
// 过滤
// ================================================================

/**
 * 判断某题是否属于「特殊项」（未填写 / 其他（<800））
 * @param {Object} p
 * @param {'xcpc'|'cf'} chartType
 * @returns {boolean}
 */
export function isSpecialProblem(p, chartType, read = cacheRead) {
    if (chartType === 'cf') {
        const d = Number(read.value(p, 'cfDifficulty')) || 0;
        return !(d >= 800);
    }
    const lv = read.derived(p, 'xcpcDifficulty');
    return !lv || lv === '-' || !XCPC_COLORS[lv];
}

// ================================================================
// 竖向难度带
// ================================================================

function buildBandsHTML(bands, canvasH, showSpecial, chartType) {
    let html = '';

    // 特殊带（未填写 / 其他）——始终保留，保证横坐标映射稳定
    const specialLabel = showSpecial ? (SPECIAL_LABEL[chartType] || SPECIAL_LABEL.xcpc) : '';
    html += `<div class="co-band" style="position:absolute; left:0; width:${(SPECIAL_BAND_W * 100).toFixed(3)}%; top:0; height:${canvasH}px; background:${withAlpha(SPECIAL_COLOR, BAND_ALPHA)};"></div>`;
    html += `<div class="co-band-label" style="position:absolute; left:0; width:${(SPECIAL_BAND_W * 100).toFixed(3)}%; bottom:2px; text-align:center; font-size:9px; color:#94a3b8; white-space:nowrap; overflow:hidden;">${esc(specialLabel)}</div>`;

    for (const b of bands) {
        const left = (b.x0 * 100).toFixed(3);
        const width = ((b.x1 - b.x0) * 100).toFixed(3);
        html += `<div class="co-band" style="position:absolute; left:${left}%; width:${width}%; top:0; height:${canvasH}px; background:${withAlpha(b.color, BAND_ALPHA)}; border-left:1px solid rgba(148,163,184,0.18);"></div>`;
        html += `<div class="co-band-label" style="position:absolute; left:${left}%; width:${width}%; bottom:2px; text-align:center; font-size:9px; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${esc(b.label)}</div>`;
    }
    return html;
}

// ================================================================
// 每行（一个比赛）
// ================================================================

/**
 * 「跳到树上」的接线（**可选**）。
 *
 * 本模块**只产出 HTML 字符串、不碰 DOM**（那是它的不变量）⇒ 交互只能靠
 * **属性 + 全局委托**：`data-reveal-node` 由 `ui/nodeinfo/nodeGroupActions.js` 那条
 * **文档级**委托接住（`ui/revealNode.js` 负责切页/展开祖先/滚动/高亮）。
 * 插件**不 import `ui/`**，所以调用方（`index.js`）把解析函数传进来。
 *
 * ⚠️ **副页的页内 id（`v_xxx`）在 `state.nodes` 里查不到** ⇒ 调用方的解析函数必须先
 * `realNodeIdOf` 解析；**解析不出就返回空串** ⇒ 这里**不画成可点**（假链接比纯文本更糟）。
 *
 * @param {string|Function} jumpId - `(id) => 主树真实 id | ''`
 * @returns {string} 形如 ` data-reveal-node="p1"`；解析不出时是**空串**
 */
function jumpAttrOf(id, jumpId) {
    const real = jumpIdOf(id, jumpId);
    return real ? ` data-reveal-node="${esc(real)}"` : '';
}

/** 解析出来可以跳的**主树节点 id**（解析不出 ⇒ 空串 = 不画成可点） */
function jumpIdOf(id, jumpId) {
    const fn = typeof jumpId === 'function' ? jumpId : null;
    if (!fn) return '';
    return String(fn(id) || '').trim();
}

function buildRowHTML(contest, chartType, domainMax, read, jumpId = null) {
    const items = layoutRow(contest.problems, chartType, domainMax, read);

    let dotsHtml = '';
    for (const it of items) {
        const p = it.problem;
        const xPct = (it.x * 100).toFixed(3);
        const ring = (read.derived(p, 'status1') === 1) ? ` box-shadow:${SELECTED_RING};` : '';
        const bg = dotColor(p, read);
        const tip = `${contest.name} · ${problemLabel(p, read)} · ${status2Text(p, read)} · ${difficultyText(p, chartType, read)}`;
        // 标签行错开：lane 1 的题号往下再放一行，避免文字重叠
        const labelTop = it.lane === 1 ? 'calc(50% + 19px)' : 'calc(50% + 8px)';
        // ★ 点一下 ⇒ 跳到这道题在树上的位置（`.co-dot` 只有 11px ⇒ 题号也一起带上，
        //   点中面积大一圈；两者指向同一个节点）
        const jump = jumpAttrOf(p.id, jumpId);
        const cursor = jump ? 'cursor:pointer;' : '';

        dotsHtml += `<div class="co-dot"${jump} title="${esc(tip)}" style="position:absolute; left:${xPct}%; top:50%; transform:translate(-50%,-50%); width:11px; height:11px; border-radius:50%; background:${bg}; border:1px solid #94a3b8; z-index:2;${cursor}${ring}"></div>`;
        dotsHtml += `<div class="co-pid"${jump} style="position:absolute; left:${xPct}%; top:${labelTop}; transform:translateX(-50%); font-size:10px; line-height:1; color:#475569; white-space:nowrap; z-index:2;${cursor}">${esc(problemLabel(p, read))}</div>`;
    }

    return `<div class="co-row" style="position:relative; height:${ROW_H}px; border-bottom:1px solid #eef2f6;">
        <div class="co-line" style="position:absolute; left:0; right:0; top:50%; height:1px; background:#cbd5e1; z-index:1;"></div>
        ${dotsHtml}
    </div>`;
}

/** 比赛名栏（与 canvas 逐行对齐） */
function buildNamesHTML(rows, jumpId = null) {
    let html = `<div class="co-names" style="flex:0 0 ${NAME_GUTTER_W}px; width:${NAME_GUTTER_W}px; padding-top:${CANVAS_PAD}px;">`;
    for (const c of rows) {
        const count = c.problems.length;
        // ⚠️ 可点的只是**名字那一截**，不是整行 —— 行里有那颗 📋（`btn-node-info`），
        //    把 `data-reveal-node` 挂在行上会让点 📋 同时触发"跳树"（两条委托都会命中）。
        const jump = jumpAttrOf(c.id, jumpId);
        const jumpId2 = jumpIdOf(c.id, jumpId);
        const nameStyle = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:right;'
            + (jump ? 'cursor:pointer;text-decoration:underline dotted;' : '');
        // 📋 打开详页：`btn-node-info[data-id]` 由 `ui/G_events.js` 的文档级委托接住
        // （与树上那颗 📋 是同一件事）——同样只在**解析出主树节点**时才画
        const info = jump
            ? `<button class="btn-icon btn-node-info co-node-info" data-id="${esc(jumpId2)}" title="打开这个比赛的详页（与树上那个 📋 是同一件事）" style="flex:0 0 auto;font-size:11px;padding:0 6px;cursor:pointer;">📋</button>`
            : '';
        html += `<div class="co-name-row" title="${esc(c.name)}（${count} 题）" style="height:${ROW_H}px; display:flex; align-items:center; justify-content:flex-end; gap:4px; padding-right:8px; font-size:12px; color:#334155; border-bottom:1px solid #eef2f6; box-sizing:border-box;">
            <span${jump} style="${nameStyle}">${esc(c.name)}</span>
            ${info}
            <span style="flex:0 0 auto; font-size:10px; color:#94a3b8;">${count}</span>
        </div>`;
    }
    html += '</div>';
    return html;
}

// ================================================================
// 主入口
// ================================================================

/**
 * 生成「比赛补题概览」主体 HTML（不含控制栏）
 * @param {Object} opts
 * @param {Array<Object>} opts.contests - collectContests 的结果
 * @param {'xcpc'|'cf'} opts.chartType
 * @param {boolean} opts.showSpecial - 是否显示「未填写 / 其他（<800）」题
 * @param {Function} [opts.jumpId] - `(id) => 主树真实 id | ''`（见 `jumpAttrOf`）。
 *        **不传 = 一个跳转/详情入口都不画**（纯渲染自检、以及"还没接"的宿主）
 * @returns {string}
 */
export function buildOverviewHTML({ contests = [], chartType = 'xcpc', showSpecial = false, read = cacheRead, jumpId = null } = {}) {
    // 逐行过滤特殊项；整行都被滤掉则隐藏该比赛
    const rows = [];
    for (const c of contests) {
        const problems = showSpecial
            ? c.problems
            : c.problems.filter(p => !isSpecialProblem(p, chartType, read));
        if (problems.length === 0) continue;
        rows.push({ id: c.id, name: c.name, problems });
    }

    if (rows.length === 0) {
        const reason = contests.length === 0
            ? '当前节点下没有含题目的比赛'
            : '当前筛选/显示条件下没有可展示的题目';
        return `<div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">
            <div style="font-size:40px; margin-bottom:12px; opacity:0.5;">🏁</div>
            <p>${esc(reason)}</p>
        </div>`;
    }

    const allProblems = [];
    for (const r of rows) allProblems.push(...r.problems);
    const domainMax = cfDomainMax(allProblems, read);
    const bands = buildBands(chartType, domainMax);

    const rowsH = rows.length * ROW_H;
    const canvasH = rowsH + CANVAS_PAD * 2;

    let rowsHtml = '';
    for (const r of rows) {
        rowsHtml += buildRowHTML(r, chartType, domainMax, read, jumpId);
    }

    return `<div class="co-body" style="display:flex; align-items:flex-start; overflow-x:auto;">
        ${buildNamesHTML(rows, jumpId)}
        <div class="co-canvas" style="position:relative; flex:1 1 auto; min-width:420px; height:${canvasH}px; padding:${CANVAS_PAD}px 0; box-sizing:border-box; border:1px solid #cbd5e1; border-radius:6px; background:#fff;">
            <div class="co-bands" style="position:absolute; left:0; right:0; top:0; height:${canvasH}px; z-index:0;">
                ${buildBandsHTML(bands, canvasH, showSpecial, chartType)}
            </div>
            <div class="co-rows" style="position:absolute; left:0; right:0; top:${CANVAS_PAD}px; z-index:1;">
                ${rowsHtml}
            </div>
        </div>
    </div>`;
}
