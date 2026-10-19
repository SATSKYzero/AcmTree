// ================================================================
// 比赛检索 — 子页（features/ContestSearch/view.js）
//
// 一级 tab「检索」下分 **比赛检索**（本文件）/ **题目检索**（现成那套）。
//
// 职责：C 节点的筛选（名称/时间/年代/性质/种类/地区/归属）+ 排序 + 分页 + 点击跳树上。
// 依赖：`../Search/kit.js`（控件）、`./collect.js` / `./query.js`（纯逻辑）、
//       `../../view/scope.js`（按查看范围取值）、`../../utils/html.js`（转义）
// 说明：本文件**只画自己那一块**，二级 tab 栏由 `../Search/index.js` 负责 ——
//       跳树派发 `EVENTS.REVEAL_NODE`（与题目检索同一颗事件，不 import ui/ 层）。
//       ★ 结果表那一格"**身份键 + 完整面包屑 + 📋**"（用户 2026-10-15）用的是**宿主注入**的
//         `ctx.nodeEntry`（`ui/tabs.js:mountPluginTab` 给的 `ui/kit/nodeEntry.js:nodeEntryLine`）——
//         **仍然不 import `ui/`**（与 `features/ContestOverview` 注入 `jumpId` 同一个先例）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS } from '../../A_constants.js';
import { viewValue, displayDerivedReader } from '../../view/scope.js';
import { escapeHtml as esc } from '../../utils/html.js';
import { buildContestIndex, collectContestFacets, EMPTY_KEY } from './collect.js';
import { runContestQuery, SORT_KEYS } from './query.js';
import { field, row, textInput, select, chipGroup, clearButton, emptyState, pager, joinButton } from '../Search/kit.js';

const SORT_LABELS = {
    time: '时间',
    name: '名称',
    year: '年代',
    class: '性质',
    region: '地区',
    problems: '题目数',
    platform: '平台'
};

/** 页面级状态（跨挂载保留；与题目检索一样**不持久化**） */
const viewState = {
    criteria: emptyCriteria(),
    sortKey: 'time',
    direction: 'desc',
    page: 1,
    pageSize: 100
};

function emptyCriteria() {
    return {
        name: '',
        key: '',
        // 「名称」与「键」怎么合：`'and'` = 交集（默认，= 没这颗按钮时的老行为）/ `'or'` = 并集
        keyJoin: 'and',
        time: '',
        region: '',
        years: [],
        classPrefixes: [],
        kinds: [],
        platforms: [],
        seriesList: []
    };
}

/**
 * 条件栏。
 *
 * ⚠️ **两个回调是刻意的**（与题目检索**同一份形状**，别各写一套）：
 *   · `onChange`（全量）：条件控件的**外观**要跟着变（chip 选中态 / 下拉 / 清空按钮）⇒ 重建整块；
 *   · `onTextInput`（只重画结果）：文本框改用这个 —— 全量重建会把**正在打字的那个输入框**
 *     换成新元素（用户 2026-10-08："比赛检索框输入英文字符时会丢失焦点，每输一个字符就要点一下"），
 *     中文输入法的合成也会当场被打断、光标跳到末尾。文字条件不改数据 ⇒ 不必重建索引。
 */
function buildControls(ctx, facets, onChange, onTextInput = onChange) {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex; flex-direction:column; gap:8px; padding:10px 4px 12px 4px; border-bottom:1px solid #eef2f6; margin-bottom:8px;';
    const reset = () => { viewState.page = 1; };

    // ---- 第一行：文本条件 + 清空 ----
    const row1 = row();
    row1.appendChild(field('名称', textInput(viewState.criteria.name, '包含匹配', v => {
        viewState.criteria.name = v; reset(); onTextInput();
    }, '150px')));
    // ★ 「名称」与「键」之间那颗并集/交集切换（用户 2026-10-18 定的形状：键框紧跟名称之后）：
    //   键 = `extKey` / 合成节点的 `synthKey`，**包含匹配**（按身份找那一场）。
    row1.appendChild(joinButton(viewState.criteria.keyJoin, () => {
        viewState.criteria.keyJoin = viewState.criteria.keyJoin === 'or' ? 'and' : 'or';
        reset(); onChange();                     // 按钮自己的外观要跟着翻 ⇒ 走全量重建
    }));
    row1.appendChild(field('键', textInput(viewState.criteria.key, 'extKey / synthKey', v => {
        viewState.criteria.key = v; reset(); onTextInput();
    }, '150px')));
    row1.appendChild(field('时间', textInput(viewState.criteria.time, '如 2024-10', v => {
        viewState.criteria.time = v; reset(); onTextInput();
    }, '110px')));
    row1.appendChild(field('地区', textInput(viewState.criteria.region, '包含匹配', v => {
        viewState.criteria.region = v; reset(); onTextInput();
    }, '100px')));
    row1.appendChild(clearButton(() => {
        viewState.criteria = emptyCriteria();
        reset();
        onChange();
    }));
    box.appendChild(row1);

    // ---- 第二行：年代 + 种类 ----
    const row2 = row();
    row2.appendChild(field('年代', chipGroup(
        facets.years.map(y => ({ value: y, label: y === EMPTY_KEY ? '未标' : y })),
        viewState.criteria.years,
        next => { viewState.criteria.years = next; reset(); onChange(); }
    )));
    row2.appendChild(field('种类', chipGroup(
        facets.kinds.map(k => ({ value: k, label: k === EMPTY_KEY ? '未标' : k })),
        viewState.criteria.kinds,
        next => { viewState.criteria.kinds = next; reset(); onChange(); }
    )));
    box.appendChild(row2);

    // ---- 第三行：性质（分类路径前两段）----
    const row3 = row();
    row3.appendChild(field('性质', chipGroup(
        facets.classPrefixes.map(p => ({ value: p, label: p })),
        viewState.criteria.classPrefixes,
        next => { viewState.criteria.classPrefixes = next; reset(); onChange(); }
    )));
    box.appendChild(row3);

    // ---- 第四行：归属（平台 / 系列）----
    const row4 = row();
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

    // ---- 第五行：排序 ----
    const row5 = row();
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
}

// ================================================================
// 结果表
// ================================================================
function buildResults(ctx, rows, total) {
    const box = document.createElement('div');

    const info = document.createElement('div');
    info.style.cssText = 'font-size:12px; color:#64748b; padding:2px 4px 8px 4px;';
    const shown = rows.length;
    info.textContent = `命中 ${total} 场比赛`
        + (shown < total ? `，本页显示前 ${shown} 场（共 ${Math.ceil(total / viewState.pageSize)} 页，翻页见下方）` : '')
        + '　·　点击任意一行跳到树上';
    box.appendChild(info);

    if (total === 0) {
        box.appendChild(emptyState('🏆', '没有符合条件的比赛'));
        return box;
    }

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:13px;';
    table.innerHTML = `<thead><tr style="background:#f8fafc; color:#475569; font-size:12px;">
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">名称</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">时间</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">年代</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">性质</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">地区</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">题目</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">归属</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">节点</th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    for (const rec of rows) {
        const tr = document.createElement('tr');
        tr.className = 'cs-result-row';
        tr.dataset.id = rec.id;
        tr.style.cssText = 'cursor:pointer; border-bottom:1px solid #f1f5f9;';
        tr.addEventListener('mouseenter', () => { tr.style.background = '#f0f7ff'; });
        tr.addEventListener('mouseleave', () => { tr.style.background = ''; });
        tr.addEventListener('click', (ev) => {
            // ⚠️ 与题目检索同一条：那一格里的面包屑（🔎）与 📋 是**自己的**交互
            //    ⇒ 点它们不许再触发整行跳树（否则一次点击派发两颗 `REVEAL_NODE` / 或"跳树 + 开详页"一起发生）。
            //    ⚠️ 只查单类 `.node-entry`：DOM 桩的 `closest` 不认逗号选择器。
            const t = ev && ev.target;
            if (t && typeof t.closest === 'function' && t.closest('.node-entry')) return;
            document.dispatchEvent(new CustomEvent(EVENTS.REVEAL_NODE, { detail: { nodeId: rec.id } }));
        });

        // 归属 = 平台 / 最近的系列（与题目检索那列同一口径）
        const owner = [rec.platforms[0], rec.seriesList[rec.seriesList.length - 1]]
            .filter(Boolean).join(' / ');
        tr.innerHTML = `
            <td style="padding:5px 8px; font-weight:600; color:#1e293b;">${esc(rec.name || '（无名）')}</td>
            <td style="padding:5px 8px; color:#475569; white-space:nowrap;">${esc(rec.contestTime || '—')}</td>
            <td style="padding:5px 8px; color:#475569; white-space:nowrap;">${esc(rec.year || '—')}</td>
            <td style="padding:5px 8px; color:#475569;">${esc(rec.natureClass || '（未标分类）')}</td>
            <td style="padding:5px 8px; color:#64748b; white-space:nowrap;">${esc(rec.natureRegion || '—')}</td>
            <td style="padding:5px 8px; color:#475569; white-space:nowrap;">${esc(String(rec.problems))}</td>
            <td style="padding:5px 8px; color:#64748b;">${esc(owner)}</td>
        `;
        // ★「节点」那一列（用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"）：
        //   名称那一格**一个字不动**，这里**另加一格**装现成的入口条（身份键 + 完整面包屑 + 📋）。
        //   ⚠️ 渲染器由**宿主注入**（`ui/tabs.js` 的 `ctx.nodeEntry`）—— 插件**不 import `ui/`**。
        const td = document.createElement('td');
        td.className = 'cs-node-cell';
        td.style.cssText = 'padding:5px 8px;';
        const node = AppState.nodes[rec.id];
        if (node && typeof ctx.nodeEntry === 'function') td.appendChild(ctx.nodeEntry(node, { compact: true }));
        else td.textContent = '—';
        tr.appendChild(td);
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    box.appendChild(table);

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
export function mountContestSearch(ctx) {
    const container = ctx.container;
    if (!container) return;

    const buildIndex = () => buildContestIndex(AppState, {
        // 与题目检索同一个口径：看到的值 = 树上（当前查看范围）的值
        // ⚠️ `value`（来源层字段）**故意**读靠前那份（本份）—— 与题目检索同一决定
        //    （用户 2026-10-12 拍板："检索写死读 own"）；派生列见下 `derived`。
        value: (node, field) => viewValue(AppState, node, field),
        // ★「合并显示」：与题目检索同一份显示读取器（去重 ⇒ 组那份）
        derived: displayDerivedReader(AppState)
    });
    let index = buildIndex();
    let facets = collectContestFacets(index);

    let resultsEl = null;

    /**
     * **只重画结果表**（`resultsEl` 是容器里**另一块**，与条件栏平级）—— 与题目检索同一份形状。
     *
     * 为什么文字条件走这条而全量重画：全量重画会把**正在打字的输入框**换成新元素
     * （用户 2026-10-08："比赛检索框输入英文字符时会丢失焦点，每输一个字符就要点一下；
     * 题目检索框没这个问题"）—— 中文输入法的合成也会被打断、光标跳到末尾。
     * 文字条件不改数据 ⇒ 不必重建索引。
     */
    function renderResults() {
        const matched = runContestQuery(index, {
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
        facets = collectContestFacets(index);
        render();
    }

    ctx.redraw = render;
    render();
}
