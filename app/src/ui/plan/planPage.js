// ================================================================
// 内层计划页（ui/plan/planPage.js）
//
// 设计稿 `docs/training-plan.md` ⑭："分两层 —— 外层简要信息（`planBar.js`）+ 点按钮进内层看完整信息"，
// 而且用户明确"**跟节点详页一个意思**" ⇒ 这里走的是 `ui/tabs.js` 的**同一个"第三类 tab"机制**
// （自带一条栏、可同时开多个、内容按需 `ensureTabContent` 画），tab id 形如 `plan-<planId>`。
//
// 内层四块（⑩⑫）：
//   A 题单来源 —— 计划绑的副页（题集就是它）+「去题单页」
//   B 列表 + 统计 —— 被筛题目列表 + 「状态2 × 难度档」网格（**数据复用** `ui/stats/statusGrid.js:statusGridOf`、
//                     分档复用 `ui/stats/statsCharts.js:xcpcBucketOf`、色表复用 `A_constants.js`）
//   C 每期完成情况 —— ⏳ 下一轮（两张图：累计折线 + 每期柱；**折线是仓里没有的组件**）
//   D 计划设置 —— 名字 / 起止 / 目标（口径+粒度+值）/ 算做完的状态 / 强度源与强度表 ⇒ `updatePlan`
//
// ⚠️ 数字一律来自 `core/trainingPlan.js:planProgressOf`（现算）；显示口径走
//    `viewDerivedDisplay(...) ?? viewValue(...)`（与树上/统计页同一份）。
// ⚠️ **只读内容用 innerHTML**（冒烟按 `serialize()` 字符串断言），
//    **可点的控件一律真元素**（DOM 桩不解析 innerHTML ⇒ 拼字符串的按钮在冒烟里点不动）。
// ⚠️ 别在这儿派发 `UI_REFRESH_REQUIRED`：这一页自己重画自己就够（整棵树重画贵得多）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { escapeHtml } from '../../utils/A_helpers.js';
// ★ 数字显示（最多一位小数）只有一份：`utils/num.js`
import { fmtAmount as fmt } from '../../utils/num.js';
import { el } from '../../utils/dom.js';
import { tabContentId } from '../tabRegistry.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
import { EVENTS, STATUS2_LABELS } from '../../A_constants.js';
// ★ 题目列表 / 每期完成情况 / 状态×难度三块都搬到了 `./planBlocks.js`（用户第 1 轮改进：折叠/分页/筛选/跳转）
import { renderSummaryBlock, renderIntensityBlock, renderListBlock, renderGridBlock, renderPeriodsBlock } from './planBlocks.js';
import { xcpcBucketOf } from '../stats/statsCharts.js';
import { planProgressOf, planProblemsOf, PLAN_GRAINS, INTENSITY_SOURCES, intensityTableById } from '../../core/trainingPlan.js';
import { selectionScopeOf, planSourceWarnOf } from './planScope.js';
import { updatePlan } from '../../core/ops/plan.js';
import { showToast } from '../G_modal/G_modals.js';
// ★「四维条件」的渲染 / 读回只有一份（挑题弹窗用同一份）—— `ui/kit/pickFilter.js`
import { pickConditionHtml, readPickCondition } from '../kit/pickFilter.js';
import { planSectionViewOf } from '../../core/model/viewState.js';
// 档位顺序（易 → 难）的唯一一份 —— 条件摘要也要按它排（见 `pickConditionTextOf`）
import { getXcpcLevelIndex } from '../../utils/color.js';
// ★ 两张图（⑱）由「每期完成情况」那一块自己画（第 5 轮：表 + 图合成一整块、区间对整块生效）
//   ⇒ 这里不再直接引 `renderChartsBlock`

/** 内层计划页的 tab id（`ui/tabs.js:openPlanTab` 用同一个） */
export function planTabId(planId) {
    return `plan-${planId}`;
}

const CARD = 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;';
const H3 = 'margin:0 0 8px;font-size:14px;font-weight:600;color:#334155;';
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.7;';
const INPUT = 'padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;';

const shownValue = (node, field) => viewDerivedDisplay(AppState, node, field) ?? viewValue(AppState, node, field);
const GRAIN_LABEL = { day: '每天', week: '每周', month: '每月', all: '整段' };

/**
 * 这一条计划现在算出来的东西（**唯一入口**：界面别自己拼 status2/acTime）。
 *
 * @param {Object} plan
 * @param {string} [grain]
 * @param {{from?:string, to?:string}|null} [range] 「每期完成情况」那块选的时间区间（`YYYY.MM.DD`）：
 *        ★ 用户第 5 轮："让'每期完成情况'的时间区间对**这一整块**（表 + 两张图）生效" ⇒
 *        区间直接当 `planProgressOf` 的期窗口传下去（起止都含；空 = 用计划自己的范围）。
 */
export function planPageDataOf(plan, grain, range = null) {
    const from = String((range && range.from) || '');
    const to = String((range && range.to) || '');
    return planProgressOf(AppState, plan, {
        grain: PLAN_GRAINS.includes(grain) ? grain : plan.goal.per,
        shownValue,
        tables: AppState.settings.trainingIntensityTables,
        // ★ 分档**只走统计页那一份**（`xcpcBucketOf`）：那样"没填难度"在**条目里**与**网格列里**
        //   才是同一个名字（都叫「未填写」）。曾经用默认口径 ⇒ 条目里是占位符 `'-'`、
        //   网格列里是「未填写」⇒ 点那一列筛出 0 条（2026-10-13 冒烟抓到的）。
        levelOf: (p) => xcpcBucketOf(AppState, p),
        // 区间：给了就**卡**在这一段里（`planProgressOf` 的 `startKey`/`endKey` 是它既有的口）
        ...(from ? { startKey: from } : {}),
        ...(to ? { endKey: to } : {})
    });
}

/** 「每期完成情况」那块现在选的时间区间（**唯一读口**：表与两张图都从这儿取） */
export function planRangeOf(plan) {
    const v = planSectionViewOf(AppState, plan.id).periods;
    return { from: v.from || '', to: v.to || '' };
}

// ----------------------------------------------------------------
// 只读那几块（innerHTML）
// ----------------------------------------------------------------

function kvInput(field, value, width = '120px', type = 'text') {
    const input = document.createElement('input');
    input.type = type;
    if (type === 'number') { input.min = '0'; input.step = '0.5'; }
    input.style.cssText = INPUT + `width:${width};`;
    input.dataset.planField = field;
    input.value = (value === undefined || value === null) ? '' : String(value);
    return input;
}

function kvSelect(field, options, value) {
    const select = document.createElement('select');
    select.style.cssText = INPUT;
    select.dataset.planField = field;
    for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        select.appendChild(o);
    }
    select.value = value;
    return select;
}

function labeled(text, control) {
    const lab = el('label', 'display:flex;flex-direction:column;gap:2px;font-size:12px;color:#475569;');
    lab.appendChild(el('span', 'font-size:11px;color:#94a3b8;', text));
    lab.appendChild(control);
    return lab;
}

// ----------------------------------------------------------------
// 题集来源（§13）：条件摘要 + 那句"来源是什么"
//
// ⚠️ 「四维条件」的渲染 / 读回**只有一份**：`ui/kit/pickFilter.js`
//    （挑题弹窗 `G5_todoSheet.js` 用的是同一份）—— 别在这儿再画一遍芯片。
// ★ 条件**不弹窗**（用户 2026-10-14 看图后："可以不用弹窗，直接放在计划设置栏里"）
//   ⇒ 就画在设置卡里那个 `[data-plan-cond-box]` 里，改一下当场生效。
// ----------------------------------------------------------------

/**
 * 条件的摘要（只报"哪几维设了"，值不铺开 —— 值就在上面那几行芯片里）。
 *
 * ⚠️ **档位按"易 → 难"排**（`utils/color.js:getXcpcLevelIndex`，那一份是档位顺序的唯一实现）——
 *    全仓口径只有这一条（芯片行、网格列序、强度控制点都照它）。
 *    ⚠️ 注意方向：**`-` 是"易"的那一端**（`银牌-` 通过率上限 15% ＞ `银牌` 11% ＞ `银牌+` 8%）
 *    ⇒ 易→难 = `银牌- / 银牌 / 银牌+`（别把 `-` 看成"更难"）。
 *    这里排序是为了让摘要**与点选顺序无关**（芯片行永远按易→难画；先点 `银牌` 再点 `银牌-` 时，
 *    不排就会印成 `银牌/银牌-`，与上面那行顺序对不上）。存的那一份仍是点选顺序，**只排显示**。
 */
export function pickConditionTextOf(pick) {
    const p = pick || {};
    const bits = [];
    const levels = [...(p.levels || [])].sort((a, b) => {
        const ia = getXcpcLevelIndex(a); const ib = getXcpcLevelIndex(b);
        return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib);
    });
    if (levels.length) bits.push(`档位 ${levels.join('/')}`);
    if (String(p.cfMin || '') !== '' || String(p.cfMax || '') !== '') {
        bits.push(`数值 ${p.cfMin === '' || p.cfMin === undefined ? '不限' : p.cfMin}~${p.cfMax === '' || p.cfMax === undefined ? '不限' : p.cfMax}`);
    }
    if ((p.tags || []).length) bits.push(`标签 ${p.tags.join('/')}`);
    if ((p.platforms || []).length) bits.push(`平台 ${p.platforms.join('/')}`);
    // ★ 前缀写「**题集条件**」不写"条件"：这一格进数据（要保存），与列表那栏的"列表筛选"不是一回事
    return bits.length ? `题集条件：${bits.join('，')}` : '题集条件：不限（五维都空）';
}

/** D 计划设置（真元素表单 + 自己的保存按钮） */
function settingsCard(plan, redraw) {
    const card = el('div', CARD);
    card.dataset.planBlock = 'settings';
    const h = el('h3', H3, '⚙️ 计划设置');
    card.appendChild(h);

    const row1 = el('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px;');
    row1.appendChild(labeled('名称', kvInput('name', plan.name, '180px')));
    row1.appendChild(labeled('开始时间', kvInput('start', plan.start, '120px')));
    row1.appendChild(labeled('结束时间（可空）', kvInput('end', plan.end, '120px')));
    card.appendChild(row1);

    const row2 = el('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-bottom:8px;');
    row2.appendChild(labeled('目标口径', kvSelect('mode', [
        { value: 'intensity', label: '训练强度' }, { value: 'count', label: '题数' }
    ], plan.goal.mode)));
    row2.appendChild(labeled('目标值', kvInput('value', plan.goal.value, '80px', 'number')));
    row2.appendChild(labeled('基准粒度', kvSelect('per', PLAN_GRAINS.filter((g) => g !== 'all').map((g) => ({
        value: g, label: GRAIN_LABEL[g]
    })), plan.goal.per)));
    row2.appendChild(labeled('强度源', kvSelect('source', INTENSITY_SOURCES.map((s) => ({
        value: s, label: s === 'xcpc' ? 'XCPC 档位' : '数值难度'
    })), plan.intensitySource)));
    const tables = Array.isArray(AppState.settings.trainingIntensityTables) ? AppState.settings.trainingIntensityTables : [];
    row2.appendChild(labeled('强度表', kvSelect('table', [{ value: '', label: '默认（内置）' }].concat(
        tables.map((t) => ({ value: t.id, label: t.name }))
    ), plan.intensityTableId || '')));
    card.appendChild(row2);

    // ---- 题集（§13：**副页 = 边界**；范围根留空 = 超级根；**没有"实时范围"那一层**）----
    //  ★ 状态就存在这两个局部变量里（点保存才写回），改动时不重画整张卡 —— 与这张卡的其它字段同姿态。
    let rootIds = Array.isArray(plan.rootIds) ? plan.rootIds.slice().filter(Boolean) : [];
    let pick = { ...(plan.pick || {}) };
    // ★ **把当前生效的规则写成一句人话 + 它现在算出来几道**（"逻辑看不懂"最有效的解药：
    //   别让人从几个下拉里自己推）。改任一处都会重算这一句。
    const formulaText = el('div', HINT);
    formulaText.dataset.planFormula = '1';
    card.appendChild(formulaText);

    // 范围根那一格：**留空 = 超级根**（用户 2026-10-14："「就用这个副页里的题」就是无选中时
    // 自动选超级根节点的逻辑"）⇒ 所以这里不再是"两种来源"，而是同一个旋钮的两种取值。
    const rootRow = el('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;');
    rootRow.dataset.planRoots = '1';
    const rootText = el('span', 'font-size:12px;color:#475569;');
    const nameOf = (id) => {
        const n = AppState.nodes[id];
        return n ? (n.name || id) : `${id}（已不存在）`;
    };
    // ★ "你勾了几个"要记着（用户 2026-10-14 问："我选中了两个，为什么说范围根：XCPC"）——
    //   "父子都勾 ⇒ 只留父"是**对的**（题集一样、还省一趟遍历），但**不能不说**。
    let pickedCount = 0;
    const rootNamesOf = () => {
        if (!rootIds.length) return '整个副页（超级根 —— 没勾节点时就是这个）';
        const merged = pickedCount > rootIds.length ? `（你勾了 ${pickedCount} 个；已在别的范围根之下的没单列，题集一样）` : '';
        return rootIds.map(nameOf).join('、') + merged;
    };
    // 条件那一段（四维）—— **不弹窗**，就画在下面那个格子里（`ui/kit/pickFilter.js` 那一份）
    const condBox = el('div', 'border:1px solid #eef2f6;border-radius:8px;padding:8px;margin:2px 0 4px;');
    condBox.dataset.planCondBox = '1';
    const shownNow = () => (n, f) => viewDerivedDisplay(AppState, n, f) ?? viewValue(AppState, n, f);
    /** 重画条件那一段（**从 `pick` 画**，所以重画不会丢当前勾选） */
    const paintCond = () => {
        condBox.innerHTML = pickConditionHtml({ rootIds, initial: pick, shownValue: shownNow() });
        paintFormula();                    // ★ 条件一变，"现在算出来几道"跟着变
    };
    // 改一下当场记下来（`change` 会从里面的勾/输入框冒到这一格）
    // ⚠️ 摘要**不在这儿再印一份**：上面那句"这条计划的题集 = …"里已经有「条件：…」那一段了
    //    （同一句灰字隔两行出现两次 = 噪音；实测用户在截图里同时看到两处）
    condBox.addEventListener('change', () => {
        pick = readPickCondition(condBox);
        paintFormula();
    });
    const paintRoots = () => { rootText.textContent = `范围根：${rootNamesOf()}`; };
    /** 范围根动了 ⇒ 标签/平台那两行的"可选值"也跟着变（**先把当前勾选读回来**，别丢） */
    const repaintCond = () => {
        pick = readPickCondition(condBox);
        paintCond();
    };
    /**
     * ★ "现在这条计划的题集是怎么算的" —— 一句人话 + 现算的道数（用户 2026-10-14："逻辑看不懂 细讲"）。
     *   层与层之间用 `∩` 串起来，末了给数：**别让人从几个下拉里自己推**。
     * ⚠️ 第一段**永远是副页**（它是边界，用户："副页范围应该是默认的"）；
     *    范围根**留空就不写这一段**（= 自动超级根 = 就用这个副页里的题，用户："「就用这个副页里的题」
     *    就是无选中时自动选超级根节点的逻辑"）。
     * ⚠️ 算的是**屏幕上这一份**（没保存的改动也算），所以一句里的数和你按完立刻看到的一致。
     * ⚠️ 代价：改一处就现算一遍题集（`planProblemsOf`）—— 只在**点击**时发生，
     *    与计划栏/详细页每次都现算是同一量级（同一个纯函数）。
     */
    const paintFormula = () => {
        const probe = { ...plan, rootIds, pick };
        const got = planProblemsOf(AppState, probe, { shownValue: shownNow() });
        const pg = AppState.pages[plan.pageId];
        const parts = [pg ? `副页「${pg.name}」里的题` : '（绑的副页已删除 ⇒ 取不到题）'];
        if (rootIds.length) parts.push(`子树「${rootIds.map(nameOf).join('、')}」`);
        parts.push(pickConditionTextOf(pick));
        const warns = [];
        if (got.missingRoots.length) warns.push(`${got.missingRoots.length} 个范围根已不存在`);
        if (got.rootCount && !got.rootsInPage) warns.push('这些范围根不在这个副页里');
        formulaText.textContent = `这条计划的题集 = ${parts.join(' ∩ ')} ⇒ 现在 ${got.ids.length} 道`
            + (warns.length ? `（${warns.join('；')}）` : '');
    };
    paintRoots();
    paintCond();
    const takeSel = document.createElement('button');
    takeSel.className = 'btn';
    takeSel.dataset.planAction = 'take-selection';
    takeSel.textContent = '⭯ 取当前选中';
    takeSel.title = '把染了色的那几点收成范围根（点行上那颗 ○；父子都染色 ⇒ 只留父）';
    takeSel.addEventListener('click', () => {
        const got = selectionScopeOf();
        // ⚠️ 只要 `picked` 非空，`roots` 就非空（每一串染色点里最上面那个一定没被祖先盖住）⇒ 不用再判 roots
        if (!got.picked.length) {
            // ★ 页签那颗 ○ 是"整页映射覆盖"（统计页那几个筛选模式读它），**不是**"我标记了这些节点" —— 必须说清，
            //   否则用户会以为"我明明点了 ○ 怎么收不到"（见 `planScope.js` 文件头）
            showToast(got.wholePage
                ? '这个副页整页亮着（那是「整页映射覆盖」，统计页那边才算它）—— 要收范围根，请在行上点那颗 ○'
                : '主树或这个副页里还没有标记任何节点', 'info');
            return;
        }
        rootIds = got.roots;
        pickedCount = got.picked.length;
        paintRoots();
        repaintCond();
        // ★ 把"合并了"这件事当场说出来（别让人以为自己的勾丢了）
        const mergedNote = got.absorbed.length
            ? `；你勾了 ${got.picked.length} 个，${got.absorbed.map(nameOf).join('、')} 在别的根之下 ⇒ 没单列（题集一样）`
            : '';
        showToast(`已收成范围根：${got.roots.map(nameOf).join('、')}${mergedNote}`, 'success');
    });
    const clearRoots = document.createElement('button');
    clearRoots.className = 'btn';
    clearRoots.dataset.planAction = 'clear-roots';
    clearRoots.textContent = '清空';
    clearRoots.title = '清空 = 回到"整个副页"（超级根）';
    clearRoots.addEventListener('click', () => { rootIds = []; pickedCount = 0; paintRoots(); repaintCond(); });
    rootRow.appendChild(rootText);
    rootRow.appendChild(takeSel);
    rootRow.appendChild(clearRoots);
    card.appendChild(rootRow);
    // ⚠️ 这块叫「**题集条件**」（`plan.pick`）：它**进数据、要保存**，改它题集就变（强度/达成/图表全跟着变）。
    //    与详细页「📋 题目列表」那一栏的「**列表筛选**」（`view.list`，只看这一屏）**不是一回事** ——
    //    两处都叫"筛选"会串（用户 2026-10-14："'筛选'确实要先看看具体语义"）；
    //    语义清单见 `docs/ui-conventions.md` 的「19. 语义查询：本仓里筛选一词有五种主语」一节。
    card.appendChild(el('div', 'font-size:11px;color:#94a3b8;margin:4px 0 2px;',
        '题集条件（改它 ⇒ 题集跟着变，记得保存）'));
    card.appendChild(condBox);
    card.appendChild(el('div', HINT, '题集 = 这个副页里的题 ∩ 范围根子树 ∩ 题集条件。'
        + '「范围根」留空就是整个副页（= 超级根，也就是"就用这个副页里的题"）；'
        + '想缩小就在这个副页里（或树上）标记节点，再点「取当前选中」把那份标记存成范围根'
        + '—— 之后别处怎么标记都不会改这条计划的题集，想改就再取一次。'
        + '「题集条件」不勾 / 留空的一维 = 不限，判据与「按条件挑题」是同一份。'));

    // 算"做完"的 status2（多选；⑤ 口径就落在这几个勾上）
    const statusRow = el('div', 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:6px;');
    statusRow.appendChild(el('span', 'font-size:11px;color:#94a3b8;', '算「做完」的状态2：'));
    for (let s2 = 0; s2 <= 5; s2++) {
        const lab = el('label', 'display:flex;align-items:center;gap:4px;font-size:12px;color:#475569;cursor:pointer;');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.planStatus = String(s2);
        box.checked = (plan.statuses || []).includes(s2);
        lab.appendChild(box);
        lab.appendChild(el('span', '', `${s2} ${STATUS2_LABELS[s2]}`));
        statusRow.appendChild(lab);
    }
    card.appendChild(statusRow);
    card.appendChild(el('div', HINT, '「忽略」那档一般不该算做完（被忽略的提交本来就不算数）。'));

    const foot = el('div', 'display:flex;gap:8px;align-items:center;margin-top:10px;');
    const save = document.createElement('button');
    save.className = 'btn btn-primary';
    save.dataset.planAction = 'save';
    save.textContent = '💾 保存计划';
    save.addEventListener('click', () => {
        const q = (f) => { const n = card.querySelector(`[data-plan-field="${f}"]`); return n ? n.value : ''; };
        const statuses = [];
        for (const box of card.querySelectorAll('[data-plan-status]')) if (box.checked) statuses.push(Number(box.dataset.planStatus));
        const patch = {
            name: q('name'),
            start: q('start'),
            end: q('end'),
            goal: { mode: q('mode'), per: q('per'), value: Number(q('value')) },
            statuses,
            intensitySource: q('source'),
            intensityTableId: q('table'),
            // ---- 题集（§13）----
            // ⚠️ **不写 `source`**：它是兼容字段，由 `rootIds` 推出（`core/ops/plan.js:normalizePlanShape`）
            //    —— 两个字段各写一份迟早会互相矛盾（"说是有范围根、其实空"）。
            rootIds,
            pick
        };
        execute((draft) => updatePlan(draft, plan.id, patch), {
            validate: false,
            refreshParentId: null,
            onSuccess: () => { showToast('计划已保存', 'success'); redraw(); },
            onError: (err) => showToast('保存失败：' + err.message, 'error')
        }).catch(() => {});
    });
    const del = document.createElement('button');
    del.className = 'btn';
    del.dataset.planAction = 'delete';
    del.textContent = '✖ 删除这条计划';
    del.title = '删计划（题单页留着）——外层条上那颗也是同一个操作';
    del.addEventListener('click', () => {
        import('./planBar.js').then((m) => m.renderPlanBar());
        showToast('删除请用外层条上的 ✖（那儿带确认框）', 'info');
    });
    foot.appendChild(save);
    foot.appendChild(del);
    card.appendChild(foot);
    return card;
}

// ----------------------------------------------------------------
// 页面
// ----------------------------------------------------------------

/**
 * 画一条计划的内层页（`ui/tabs.js` 在切页 / 整页刷新时调它）。
 * @param {{id:string, planId:string}} tab
 */
export function renderPlanPanel(tab) {
    const container = document.getElementById(tabContentId(tab.id));
    if (!container) return;
    const plan = (AppState.plans || {})[tab.planId];
    container.innerHTML = '';
    const page = el('div', 'padding:16px;');
    page.className = 'plan-page';
    container.appendChild(page);

    if (!plan) {
        page.innerHTML = '<div style="color:#94a3b8;">（这条计划已被删除）</div>';
        return;
    }
    // ⚠️ 重画这一页时**顺手把外层条也重画**：计划改名/改目标之后，那条栏原先还显示旧名字，
    //    直到下次整页刷新（2026-10-13 第 1 轮之前我自己发现的缺陷）。懒引避免与 planBar 成环。
    const redraw = () => {
        renderPlanPanel(tab);
        import('./planBar.js').then((m) => m.renderPlanBar()).catch(() => {});
    };
    const data = planPageDataOf(plan);

    // ---- 头：标题 + 两个动作（真元素） ----
    const head = el('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;');
    head.appendChild(el('h2', 'margin:0;font-size:18px;', `📅 ${plan.name}`));
    const unit = data.goalMode === 'count' ? '题' : '强度';
    head.appendChild(el('span', 'font-size:12px;color:#64748b;',
        `${plan.start || '（没填开始时间）'} ~ ${plan.end || '至今'} · 目标 ${GRAIN_LABEL[data.goalBase] || data.goalBase} ${fmt(plan.goal.value)} ${unit}`
        + ` · 累计 ${fmt(data.totals.actual)}/${fmt(data.totals.goal)} ${unit}`));
    const goto = document.createElement('button');
    goto.className = 'btn';
    goto.dataset.planAction = 'goto-page';
    goto.textContent = '📄 去题单页';
    goto.addEventListener('click', () => {
        if (!AppState.pages[plan.pageId]) { showToast('题单页已删除', 'error'); return; }
        // ★ 两步，缺一不可（用户第 4 轮报的就是缺第一步："会让主视图的 tab 切换，但不会直接跳过去显示副页"）：
        //   ① 回到主视图那张 tab（否则 `SWITCH_PAGE` 只改了 `currentPageId`、人还留在计划页上）；
        //   ② 再切副页。顺序与 `ui/revealNode.js:switchPageTo` 那条既有的跳转一致。
        //   ⚠️ `tabs.js` 静态引本文件 ⇒ 这里**懒引**（硬引会成环）。
        import('../tabs.js').then((m) => {
            m.switchTab('main');
            document.dispatchEvent(new CustomEvent(EVENTS.SWITCH_PAGE, { detail: { pageId: plan.pageId } }));
        });
    });
    const toBar = document.createElement('button');
    toBar.className = 'btn';
    toBar.dataset.planAction = 'to-main';
    toBar.textContent = '↩︎ 回主视图';
    toBar.addEventListener('click', () => {
        import('../tabs.js').then((m) => m.switchTab('main'));
    });
    head.appendChild(goto);
    head.appendChild(toBar);
    page.appendChild(head);

    // ---- 总账（第 2 轮）：已写/总训练强度 · 推荐 · 目标 + 预计完成日期 ----
    page.appendChild(renderSummaryBlock(plan, data));

    // ---- A 题单来源 ----
    const page_ = AppState.pages[plan.pageId];
    const a = el('div', CARD);
    a.dataset.planBlock = 'source';
    a.appendChild(el('h3', H3, '📄 题单来源'));
    const aBody = el('div', '');
    // ★ 「题集从哪来」只有一份文本（`planScope.js`）；两种来源如实各说一句，取不全就直说（不静默报 0）
    const srcWarn = planSourceWarnOf(data);
    aBody.innerHTML = `<div style="font-size:12px;color:#475569;">`
        + (data.problemsSource === 'range'
            // ★ **两种来源都以副页为边界**（用户 2026-10-14："副页范围应该是默认的"）⇒ 这句要从副页说起
            ? `这条计划的题集 = 副页「<b>${escapeHtml((page_ && page_.name) || '?')}</b>」里的题`
              + ` ∩ <b>树上范围</b>（${data.rootCount} 个范围根`
              + `${(data.missingRoots || []).length ? `，其中 ${data.missingRoots.length} 个已不存在` : ''}）`
              + `，再按「题集条件」筛过，共 <b>${data.entries.length}</b> 道。`
              + `<br><span style="${HINT}">范围根与题集条件都在「计划设置」里改（「取当前选中」/题集条件那一块）；`
              + `范围根必须落在这个副页里才有用 —— 题集只从副页里取。</span>`
            : (page_
                ? `这条计划的题集 = 副页「<b>${escapeHtml(page_.name)}</b>」里的全部题（含比赛子树里的题），共 <b>${data.entries.length}</b> 道。`
                  // ⚠️ 别写"计划这边不再筛一遍"：`v9.4.6` 起**题集条件永远生效**（在那个副页里再筛一道），
                  //    那句老话从那时起就是假的（2026-10-14 清掉）。
                  + `<br><span style="${HINT}">想再缩一道：在「计划设置」里取范围根、或勾「题集条件」（难度 / 标签 / 平台…）`
                  + `—— 两者都是在<b>这个副页里</b>筛；「列表筛选」是另一回事（只看下面那张列表，不改题集）。</span>`
                : '<b style="color:#b45309;">题单页已删除</b> —— 计划还在，重新在「计划设置」里指一个副页即可。'))
        + (srcWarn && !data.missingPage ? `<br><b style="color:#b45309;">${escapeHtml(srcWarn)}</b>` : '')
        + '</div>';
    a.appendChild(aBody);
    page.appendChild(a);

    // ---- B 题目列表（②可折叠 / 分页 / 可跳转 / 支持筛选）----
    page.appendChild(renderListBlock(plan, data, redraw));

    // ---- B2 状态 × 难度（③与统计页**同一份渲染**；点格子 ⇒ 筛上面的列表）----
    page.appendChild(renderGridBlock(plan, data, redraw));

    // ---- C 「每期完成情况」**一整块**（表 + 两张图；用户第 5 轮："你放在同一块，不妨让
    //      '每期完成情况'的时间区间对这一整块生效，这一整块要命名"）----
    //   ⇒ 命名成一块，区间（`periods.from/to`）**同时**卡住表与两张图：两边吃的都是
    //      `dataOf(grain)`，而 `dataOf` 把那一段当 `planProgressOf` 的期窗口传下去。
    //   ⚠️ 这一块**自己就是那张卡片**（别再套一层带同样 `data-plan-block` 的外壳 —— 那两个钩子会打架）
    const range = planRangeOf(plan);
    const dataOf = (grain) => planPageDataOf(plan, grain, range);
    const warns = [];
    // ★ 第 12 轮（用户："未填写的不计入 因为有热身赛等"）：不再是"按默认强度计"，而是**根本不进合计**
    if (data.unknownDifficulty > 0) warns.push(`${data.unknownDifficulty} 道题没填难度，不计入强度`);
    // ⚠️ 不提醒"没有 AC 时间"（用户第 4 轮："没 AC 很正常，不用提醒"）—— 与计划栏那一处同一条口径。
    page.appendChild(renderPeriodsBlock(plan, data, redraw, { dataOf, warns }));

    // ---- C2 当前强度表（第 3 轮："强度表的数值在哪看?"）----
    page.appendChild(renderIntensityBlock(plan, data, redraw));

    // ---- D 计划设置 ----
    page.appendChild(settingsCard(plan, redraw));
}
