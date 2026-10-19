// ================================================================
// 题目检索 — 子页（features/ProblemSearch/index.js）
// 职责：P 节点的筛选（题号/题名/标签/比赛/平台/系列/状态/难度）+ 二次排序 + 定位
// 依赖：shell/state.js, A_constants.js, utils/color.js,
//       ./collect.js, ./query.js, ../Search/kit.js（共用控件）
//
// ⚠️ 一级 Tab 的 owner 是 **`features/Search/index.js`**
//    （那里挂「🔍 检索」+ 二级 tab 栏）；本文件只提供 `mountProblemSearch(ctx)`，
//    不 `registerTab`。控件在 `../Search/kit.js`（观感一字未改）。
//
// 依赖说明：
//   本插件**不 import ui/ 的功能模块**。需要"跳到树上"时只派发
//   EVENTS.REVEAL_NODE 事件，由 ui/revealNode.js 实现——与本项目既有的
//   EDIT_NODE / SWITCH_PAGE 等事件模式一致。
//   ★ 结果表那一格"**身份键 + 完整面包屑 + 📋**"（用户 2026-10-15："还是题名和完整面包屑都有为好"）
//     同样**不 import**：用的是**宿主注入**的 `ctx.nodeEntry`（`ui/tabs.js:mountPluginTab` 给的
//     `ui/kit/nodeEntry.js:nodeEntryLine`，由 `features/Search/index.js` 原样转发）——
//     照 `features/ContestOverview` 注入 `jumpId` 的先例（面包屑/跳转/详页在本仓各只有一份实现）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS, STATUS2_LABELS } from '../../A_constants.js';
import { buildProblemIndex, collectFacetOptions } from './collect.js';
import { viewValue, displayDerivedReader } from '../../view/scope.js';
import { runQuery, SORT_KEYS } from './query.js';
import { XCPC_ORDER } from '../../utils/color.js';
import { escapeHtml as esc } from '../../utils/html.js';
import { field, textInput, numberInput, select, chipGroup, clearButton, emptyState, pager, joinButton } from '../Search/kit.js';

/** 未填写难度的筛选项键名 */
const UNFILLED = '未填写';

/** 排序键的显示名 */
const SORT_LABELS = {
    cf: 'CF难度',
    xcpc: 'XCPC难度',
    problemId: '题号',
    name: '题名',
    status2: '状态2',
    contest: '所属比赛',
    platform: '平台'
};

/** 页面级状态（跨挂载保留）；刻意不叫 state，避免与 AppState / ctx.state 混淆 */
const viewState = {
    criteria: emptyCriteria(),
    sortKey: 'cf',
    direction: 'asc',
    page: 1,
    pageSize: 100
};

function emptyCriteria() {
    return {
        problemId: '',
        key: '',
        // 「题号」与「键」怎么合：`'and'` = 交集（默认，= 没这颗按钮时的老行为）/ `'or'` = 并集
        keyJoin: 'and',
        name: '',
        tag: '',
        contest: '',
        platforms: [],
        seriesList: [],
        status2: [],
        xcpcLevels: [],
        cfMin: undefined,
        cfMax: undefined
    };
}

// ================================================================
// 控制栏
// ================================================================

/**
 * 条件栏。
 *
 * ⚠️ **两个回调是刻意的**：
 *   · `onChange`（全量）：条件控件的**外观**要跟着变（chip 选中态 / 下拉 / 清空按钮）⇒ 重建整块；
 *   · `onTextInput`（只重画结果）：文本框改用这个 —— 全量重建会把**正在打字的那个输入框**
 *     换成新元素，中文输入法的合成当场被打断（"输入一个字符就被打断"），光标也会跳到末尾。
 *     文字条件不改数据 ⇒ 不需要重建索引，只重画结果表就够。
 */
function buildControls(ctx, facets, onChange, onTextInput = onChange) {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px 4px 12px 4px; border-bottom:1px solid #eef2f6; margin-bottom:8px;';

    // ---- 第一行：文本条件 ----
    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
    row1.appendChild(field('题号', textInput(viewState.criteria.problemId, '如 A / 1920', v => { viewState.criteria.problemId = v; reset(); onTextInput(); }, '100px')));
    // ★ 「题号」与「键」之间那颗并集/交集切换（用户 2026-10-18 定的形状：键框紧跟题号之后）。
    //   键 = `extKey` / 合成节点的 `synthKey`，**包含匹配**（按身份找那道题）
    row1.appendChild(joinButton(viewState.criteria.keyJoin, () => {
        viewState.criteria.keyJoin = viewState.criteria.keyJoin === 'or' ? 'and' : 'or';
        reset(); onChange();                     // 按钮自己的外观要跟着翻 ⇒ 走全量重建
    }));
    row1.appendChild(field('键', textInput(viewState.criteria.key, 'extKey / synthKey', v => { viewState.criteria.key = v; reset(); onTextInput(); }, '150px')));
    row1.appendChild(field('题名', textInput(viewState.criteria.name, '包含匹配', v => { viewState.criteria.name = v; reset(); onTextInput(); }, '150px')));
    row1.appendChild(field('标签', textInput(viewState.criteria.tag, '包含匹配', v => { viewState.criteria.tag = v; reset(); onTextInput(); }, '120px')));
    row1.appendChild(field('比赛', textInput(viewState.criteria.contest, '包含匹配', v => { viewState.criteria.contest = v; reset(); onTextInput(); }, '130px')));

    const clearBtn = clearButton(() => {
        viewState.criteria = emptyCriteria();
        reset();
        onChange();
    });
    row1.appendChild(clearBtn);
    box.appendChild(row1);

    // ---- 第二行：难度 ----
    const row2 = document.createElement('div');
    row2.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
    row2.appendChild(field('CF难度', (() => {
        const g = document.createElement('div');
        g.style.cssText = 'display:flex; align-items:center; gap:4px;';
        g.appendChild(numberInput(viewState.criteria.cfMin, 'min', v => { viewState.criteria.cfMin = v; reset(); onTextInput(); }));
        const dash = document.createElement('span');
        dash.textContent = '~';
        dash.style.cssText = 'color:#94a3b8;';
        g.appendChild(dash);
        g.appendChild(numberInput(viewState.criteria.cfMax, 'max', v => { viewState.criteria.cfMax = v; reset(); onTextInput(); }));
        return g;
    })()));

    row2.appendChild(field('XCPC档', chipGroup(
        [...XCPC_ORDER.map(l => ({ value: l, label: l })), { value: UNFILLED, label: UNFILLED }],
        viewState.criteria.xcpcLevels,
        next => { viewState.criteria.xcpcLevels = next; reset(); onChange(); }
    )));
    box.appendChild(row2);

    // ---- 第三行：状态2 ----
    const row3 = document.createElement('div');
    row3.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
    const statusOptions = STATUS2_LABELS.map((label, i) => ({ value: String(i), label: `${i} ${label}` }));
    row3.appendChild(field('状态2', chipGroup(statusOptions, viewState.criteria.status2.map(String), next => {
        viewState.criteria.status2 = next.map(Number);
        reset();
        onChange();
    })));
    box.appendChild(row3);

    // ---- 第四行：归属 + 排序 ----
    const row4 = document.createElement('div');
    row4.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';

    if (facets.platforms.length > 0) {
        row4.appendChild(field('平台', chipGroup(
            facets.platforms.map(p => ({ value: p, label: p })),
            viewState.criteria.platforms,
            next => { viewState.criteria.platforms = next; reset(); onChange(); }
        )));
    }
    if (facets.series.length > 0) {
        row4.appendChild(field('系列', chipGroup(
            facets.series.map(s => ({ value: s, label: s })),
            viewState.criteria.seriesList,
            next => { viewState.criteria.seriesList = next; reset(); onChange(); }
        )));
    }
    box.appendChild(row4);

    const row5 = document.createElement('div');
    row5.style.cssText = 'display:flex; align-items:center; gap:14px; flex-wrap:wrap;';
    row5.appendChild(field('排序', select(
        SORT_KEYS.map(k => ({ value: k, label: SORT_LABELS[k] || k })),
        viewState.sortKey,
        v => { viewState.sortKey = v; reset(); onChange(); }
    )));
    row5.appendChild(field('方向', select(
        [{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }],
        viewState.direction,
        v => { viewState.direction = v; reset(); onChange(); }
    )));
    box.appendChild(row5);

    return box;

    function reset() { viewState.page = 1; }
}

// ================================================================
// 结果表
// ================================================================

function difficultyText(rec) {
    const cf = rec.cfDifficulty >= 800 ? `CF ${rec.cfDifficulty}` : '';
    const xcpc = rec.xcpcDifficulty && rec.xcpcDifficulty !== '-' ? rec.xcpcDifficulty : '';
    return [cf, xcpc].filter(Boolean).join(' · ') || '未填写';
}

function buildResults(ctx, rows, total) {
    const box = document.createElement('div');

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px; color:#64748b; padding:2px 4px 8px 4px;';
    const shown = rows.length;
    info.textContent = `命中 ${total} 道题`
        + (shown < total ? `，本页显示前 ${shown} 道（共 ${Math.ceil(total / viewState.pageSize)} 页，翻页见下方）` : '')
        + '　·　点击任意一行跳到树上';
    box.appendChild(info);

    if (total === 0) {
        box.appendChild(emptyState('🔍', '没有符合条件的题目'));
        return box;
    }

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:13px;';
    table.innerHTML = `<thead><tr style="background:#f8fafc; color:#475569; font-size:12px;">
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">题号</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">题名</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">难度</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">状态2</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">标签</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">归属</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">节点</th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const rec of rows) {
        const tr = document.createElement('tr');
        tr.className = 'ps-result-row';
        tr.dataset.id = rec.id;
        tr.style.cssText = 'cursor:pointer; border-bottom:1px solid #f1f5f9;';
        tr.addEventListener('mouseenter', () => { tr.style.background = '#f0f7ff'; });
        tr.addEventListener('mouseleave', () => { tr.style.background = ''; });
        tr.addEventListener('click', (ev) => {
            // ⚠️ 那一格里的面包屑（🔎）与 📋 自己就是交互 ⇒ 点它们**不许**再走"整行跳树"，
            //    否则一次点击要么派发**两颗** `REVEAL_NODE`、要么"跳树 + 开详页"一起发生
            //    （`src/features/AGENTS.md` 里 AutoImport 记过同一个坑）。
            //    ⚠️ 判据只查**单类** `.node-entry`（列里那几格都在它里面）—— DOM 桩的 `closest`
            //       **不认逗号选择器**（`docs/ui-conventions.md` 的「8. 冒烟 / DOM 桩的边界」一节）。
            const t = ev && ev.target;
            if (t && typeof t.closest === 'function' && t.closest('.node-entry')) return;
            document.dispatchEvent(new CustomEvent(EVENTS.REVEAL_NODE, { detail: { nodeId: rec.id } }));
        });

        const statusLabel = STATUS2_LABELS[rec.status2] || String(rec.status2);
        const owner = [rec.platforms[0], rec.seriesList[rec.seriesList.length - 1], rec.contest]
            .filter(Boolean).join(' / ');

        tr.innerHTML = `
            <td style="padding:5px 8px; font-weight:600; color:#1e293b;">${esc(rec.problemId || '?')}</td>
            <td style="padding:5px 8px; color:#334155;">${esc(rec.name)}</td>
            <td style="padding:5px 8px; color:#475569; white-space:nowrap;">${esc(difficultyText(rec))}</td>
            <td style="padding:5px 8px; color:#475569; white-space:nowrap;">${esc(rec.status2 + ' ' + statusLabel)}</td>
            <td style="padding:5px 8px; color:#64748b;">${esc(rec.tags.join(', '))}</td>
            <td style="padding:5px 8px; color:#64748b;">${esc(owner)}</td>
        `;
        // ★「节点」那一列（用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"）：
        //   题名那一格**一个字不动**，这里**另加一格**装现成的入口条（身份键 + 完整面包屑 + 📋）。
        //   ⚠️ 渲染器是**宿主注入**的（`ui/tabs.js` 的 `ctx.nodeEntry`）—— 插件**不 import `ui/`**；
        //      没注入（单测里直接调 `mountProblemSearch`）就如实写「—」，不假装有这个格子。
        const td = document.createElement('td');
        td.className = 'ps-node-cell';
        td.style.cssText = 'padding:5px 8px;';
        const node = AppState.nodes[rec.id];
        if (node && typeof ctx.nodeEntry === 'function') td.appendChild(ctx.nodeEntry(node, { compact: true }));
        else td.textContent = '—';
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

    // ---- 翻页 ----
    const pageCount = Math.max(1, Math.ceil(total / viewState.pageSize));
    if (pageCount > 1) {
        box.appendChild(pager(viewState.page, pageCount, next => {
            viewState.page = next;
            ctx.redraw();
        }));
    }

    return box;
}

// ================================================================
// 挂载（由 `features/Search/index.js` 调用）
// ================================================================

export function mountProblemSearch(ctx) {
    const container = ctx.container;
    if (!container) return;

    const buildIndex = () => buildProblemIndex(AppState, {
        // 检索看到的必须与树上看到的一致 —— 传当前范围的取值器
        // ⚠️ `value`（**来源层字段**）读的是**靠前那份**（本份），这是**故意**的
        //    （用户 2026-10-12 拍板："检索写死读 own，暂时就这样设计"）：检索表里那一列要的是
        //    "**这条记录自己**说的值"；**派生列**（status1/status2…）才跟显示模式走（见下 `derived`）。
        value: (node, field) => viewValue(AppState, node, field),
        // ★「合并显示」：**显示**用的派生读取器 ⇒ 去重模式下 status1/status2 读
        //   「组那份」（与树上同一口径）；`plain` 下与 `viewDerived` 逐字相同。
        derived: displayDerivedReader(AppState)
    });
    let index = buildIndex();
    let facets = collectFacetOptions(index);

    let resultsEl = null;

    /**
     * **只重画结果表**（`resultsEl` 是容器里**另一块**，与条件栏平级）。
     *
     * 为什么文字条件走这条而全量重画：全量重画会把**正在打字的输入框**换成新元素 ——
     * 中文输入法的合成当场被打断（用户："输入一个字符就被打断"），光标也跳到末尾。
     * 文字条件不改数据 ⇒ 不必重建索引。
     */
    function renderResults() {
        const matched = runQuery(index, {
            criteria: viewState.criteria,
            sortKey: viewState.sortKey,
            direction: viewState.direction
        });
        const total = matched.length;
        const pageCount = Math.max(1, Math.ceil(total / viewState.pageSize));
        if (viewState.page > pageCount) viewState.page = pageCount;
        const start = (viewState.page - 1) * viewState.pageSize;
        const rows = matched.slice(start, start + viewState.pageSize);

        if (!resultsEl) {
            resultsEl = document.createElement('div');
            container.appendChild(resultsEl);
        }
        resultsEl.innerHTML = '';
        resultsEl.appendChild(buildResults(ctx, rows, total));
    }

    /** 全量重画：条件控件的外观也要跟着变（chip 选中态 / 下拉 / 清空按钮） */
    function render() {
        container.innerHTML = '';
        resultsEl = null;
        container.appendChild(buildControls(ctx, facets, () => rebuild(), () => renderResults()));
        renderResults();
    }

    /** 条件变化时重建索引（数据可能已被别的操作改动） */
    function rebuild() {
        index = buildIndex();
        facets = collectFacetOptions(index);
        render();
    }

    ctx.redraw = render;
    render();
}
