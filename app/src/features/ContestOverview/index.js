// ================================================================
// 比赛补题概览 — 插件入口（features/ContestOverview/index.js）
// 职责：注册「比赛补题概览」文件夹节点视图，并接线控制栏
// 依赖：shell/executor.js, A_constants.js, ./filter.js, ./render.js
//
// 视图布局：
//   大矩形 = 难度轴区域
//     ├─ 竖向难度带（全高，淡色）：XCPC 每档等宽；CF 完全线性
//     └─ 每个「比赛」一行小矩形（与大矩形等宽）
//          ├─ 居中横线
//          └─ 线上若干点（一点一题，按 status2 着色，status1=1 加橙色圈）
//               点下方为题号
//   比赛名标注在小矩形左侧的名称栏内（与各行逐行对齐）
// ================================================================
import { execute } from '../../shell/executor.js';
import { DEFAULT_STATS_FILTER_MODE } from '../../A_constants.js';
import { FILTER_OPTIONS } from '../../view/filterMode.js';
import { collectFilteredContests } from './filter.js';
import { buildOverviewHTML } from './render.js';
import { viewValue, viewDerivedDisplay, displayDerivedReader } from '../../view/scope.js';
// 「这个 id 能不能跳 / 跳到哪个主树节点」的**唯一判据**（core/ops：解析副页页内 id +
// 要求 `state.nodes` 里真有；插件可以 import core）
import { mainTreeNodeIdOf } from '../../core/ops/page.js';
import { SPECIAL_LABEL } from './constants.js';

const VIEW_ID = 'contest-overview';
const VIEW_LABEL = '🏁 比赛补题概览';
/** 内置页 children=0 / stats=10，本页插在它们之后 */
const VIEW_ORDER = 20;

// 筛选模式的**选项文案与判据**都在 `view/filterMode.js`（唯一一份）——
// 多处各存一份文案会漂。
export { FILTER_OPTIONS };

// 难度类型在本页独立记忆（与内置统计页互不影响）
let chartType = 'xcpc';

// ================================================================
// 读取/写入共享设置
// ================================================================

function getFilterMode(state) {
    return state?.settings?.stats?.statsFilterMode || DEFAULT_STATS_FILTER_MODE;
}

function getShowSpecial(state) {
    const v = state?.settings?.stats?.showSpecialGroups;
    return v === undefined ? true : v;
}

/** 写设置并等待提交完成（applyState 原地回填，await 后即可读到新值） */
async function writeSetting(mutator) {
    try {
        await execute(mutator, { skipHistory: true, validate: false });
    } catch (err) {
        console.error('[ContestOverview] 写入设置失败:', err);
    }
}

// ================================================================
// 控制栏
// ================================================================

function buildChartTypeButton(type, label, active) {
    const btn = document.createElement('button');
    btn.className = 'co-chart-btn';
    btn.dataset.chart = type;
    btn.textContent = label;
    btn.style.cssText = `padding:3px 12px; border:none; border-radius:4px; font-size:12px; font-weight:500; cursor:pointer; background:${active ? '#2563eb' : 'transparent'}; color:${active ? '#fff' : '#64748b'};`;
    return btn;
}

/**
 * 构建控制栏
 * @param {Object} opts
 * @param {Object} opts.state
 * @param {Function} opts.onChange - 任一控件变化后调用（重新绘制）
 * @returns {HTMLElement}
 */
function buildControls({ state, onChange }) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; align-items:center; gap:12px; padding:8px 4px 12px 4px; border-bottom:1px solid #eef2f6; margin-bottom:8px; flex-wrap:wrap;';

    // ---- 筛选模式 ----
    const filterLabel = document.createElement('span');
    filterLabel.textContent = '筛选模式：';
    filterLabel.style.cssText = 'font-size:13px; color:#475569;';
    wrap.appendChild(filterLabel);

    const select = document.createElement('select');
    select.style.cssText = 'padding:3px 8px; border:1px solid #d1d5db; border-radius:4px; font-size:13px; background:#fff; cursor:pointer;';
    const current = getFilterMode(state);
    for (const opt of FILTER_OPTIONS) {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        if (opt.title) option.title = opt.title;
        if (opt.value === current) option.selected = true;
        select.appendChild(option);
    }
    select.addEventListener('change', async () => {
        const value = select.value;
        await writeSetting(draft => { draft.settings.stats.statsFilterMode = value; });
        onChange();
    });
    wrap.appendChild(select);

    // ---- 显示「未填写 / 其他」----
    const showSpecial = getShowSpecial(state);
    const checkLabel = document.createElement('label');
    checkLabel.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:13px; color:#475569; cursor:pointer; user-select:none;';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = showSpecial;
    checkbox.style.cssText = 'width:16px; height:16px; cursor:pointer; accent-color:#2563eb;';
    checkLabel.appendChild(checkbox);
    checkLabel.appendChild(document.createTextNode(`显示“${SPECIAL_LABEL[chartType]}”项`));
    checkbox.addEventListener('change', async () => {
        const value = checkbox.checked;
        await writeSetting(draft => { draft.settings.stats.showSpecialGroups = value; });
        onChange();
    });
    wrap.appendChild(checkLabel);

    // ---- 难度类型切换 ----
    const switchWrap = document.createElement('div');
    switchWrap.style.cssText = 'display:flex; gap:4px; margin-left:auto;';
    const btnXcpc = buildChartTypeButton('xcpc', 'XCPC难度', chartType === 'xcpc');
    const btnCf = buildChartTypeButton('cf', 'CF难度', chartType === 'cf');
    for (const btn of [btnXcpc, btnCf]) {
        btn.addEventListener('click', () => {
            const next = btn.dataset.chart;
            if (next === chartType) return;
            chartType = next;
            onChange();
        });
        switchWrap.appendChild(btn);
    }
    wrap.appendChild(switchWrap);

    return wrap;
}

// ================================================================
// 视图挂载
// ================================================================

function mountOverview(ctx) {
    const panel = ctx.panel;
    if (!panel) return;

    const state = ctx.state;
    const nodeId = ctx.nodeId;

    function draw() {
        const showSpecial = getShowSpecial(state);
        // 概览里的颜色/难度/文案/比赛名一律按**当前查看范围**取（与树上一致）
        const read = {
            // ★ 值按**显示列**取：`plain` ⇒ 自己那份，去重 ⇒ 组那份（取不到退回自己那份）
            value: (node, field) => viewDerivedDisplay(state, node, field) ?? viewValue(state, node, field),
            // ★「合并显示」：点色 / 圈（`status2` / `status1`）按**显示口径**取
            //   （判重 ⇒ 组那份；不去重 ⇒ 每个节点各显示各的）。
            //   ⚠️ 这一页是**按比赛**看的（一场一列、一道题一个点）⇒ **不去重列表**：
            //   同一道题在两个来源各有一场时，两场都该看到它（去重是"跨比赛计数"那类视图的事）。
            derived: displayDerivedReader(state)
        };
        // ★ 副页节点：交**节点对象**（页内 id 在 `state.nodes` 里查不到）；
        //   子树与取值都由既有那一处判据管（投影节点走它的 `children`，值取所映射的主节点）
        const root = (ctx.node && ctx.node._virtual) ? ctx.node : nodeId;
        const contests = collectFilteredContests(state, root, getFilterMode(state), read);

        panel.innerHTML = '';
        panel.appendChild(buildControls({ state, onChange: draw }));

        const body = document.createElement('div');
        // ★ 「点一下 ⇒ 跳到树上 / 打开详页」：接线靠 `data-reveal-node` 属性 +
        //   `ui/` 那条**文档级**委托（插件**不 import `ui/`**）；`render.js` 保持纯。
        //   ⚠️ **副页**里拿到的是页内 id（`v_xxx`），`state.nodes` 里查不到 ⇒ 先
        //      `mainTreeNodeIdOf` 解析（+ 确认树上真有）；**解析不出（副页根 / 节点已删）
        //      ⇒ 返回空串 ⇒ 不画成可点**。那一份判据在 `core/ops/page.js`，
        //      与 `ui/kit/nodeEntry.js` 的入口条**共用同一处**（以前两边各写一遍）。
        body.innerHTML = buildOverviewHTML({
            contests, chartType, showSpecial, read,
            jumpId: (id) => mainTreeNodeIdOf(state, id)
        });
        panel.appendChild(body);
    }

    draw();
}

// ================================================================
// 激活
// ================================================================

export function activateContestOverview(api) {
    api.registerFolderView({
        id: VIEW_ID,
        label: VIEW_LABEL,
        order: VIEW_ORDER,
        mount: mountOverview
    });
}
