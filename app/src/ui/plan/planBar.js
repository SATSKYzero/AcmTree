// ================================================================
// 训练计划条（ui/plan/planBar.js）
//
// 位置（设计稿 `docs/training-plan.md` ⑤）：树模式里 **「总览统计」与「树」之间** ——
//   槽位是 `index.html` 的 `#plan-bar`（由 `folder/folderShared.js:applyTreeLayout` 那条路渲染）。
// 职责：把 `state.plans` 画成"一眼能看"的几条，并把折叠 / 删计划 / 去题单页 / 新建计划接上。
//
// ⚠️ **数字一律来自 `core/trainingPlan.js:planProgressOf`**（现算，⑦：一个字节都不存）；
//    显示口径的值走 `viewDerivedDisplay(...) ?? viewValue(...)` ——**与统计页同一份**。
// ⚠️ **一趟渲染只算一遍**：角标（`pageBadges`）与这一行摘要吃的是**同一份** `progress`
//    （`renderPlanBar` 里算一次往下传）。2026-10-18 实测：三处各算一遍 ⇒ 计划栏占副页热切
//    41ms / 冷切 54ms，`planProgressOf` 在 3000 vNode 的副页上 ~15ms/次。
// ⚠️ **折叠态是视图态**（`state.view`，⑥）：不进数据、不落 `nodes`（落了会整片作废按代缓存），
//    真源 localStorage（`core/model/viewState.js` 的 `scheduleViewSave`）。
// ⚠️ 用**真元素**画（不是拼 innerHTML 字符串）：DOM 桩不解析 innerHTML ⇒ 拼字符串那一套
//    在冒烟里**查不到也点不了**（`v9.1.27` 的教训）。
// ⚠️ 重画**只重画这一条**：别派发 `UI_REFRESH_REQUIRED`（那是整棵树重画，比算这一条贵得多）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { escapeHtml } from '../../utils/A_helpers.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../../utils/diag.js';
import { getNowStr } from '../../utils/time.js';
// ★ 数字显示（最多一位小数）**只有一份**：`utils/num.js`（曾在本层抄了四份，见该文件头）
import { fmtAmount as fmt } from '../../utils/num.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
import { planProgressOf, periodKeyOf, PLAN_GRAINS, periodsNewestFirst } from '../../core/trainingPlan.js';
// ★ 计划侧"范围"（「取当前选中」/ 题集那两句文本）只有一份 —— 见那份文件头
import { problemSourceTextOf, planSourceWarnOf } from './planScope.js';
import {
    isPlanBarCollapsed, setPlanBarCollapsed,
    isPlanCollapsed, setPlanCollapsed,
    scheduleViewSave
} from '../../core/model/viewState.js';
// ★ 一对一的**唯一读口**：这个副页那一份计划（`v9.4.16`；别再自己 filter）
import { planOfPage } from '../../core/ops/plan.js';
// ★ 结构签名（折叠不该让这条进度失效 —— 见 `planBarProgressOf` 里的注释）
import { structureSignatureOf } from '../../core/model/page.js';
// ★ 按页分槽的记忆表（副页统计 / 树 HTML / 本条栏共用一份实现）
import { createSlots } from '../../utils/memoSlots.js';
// ★ 方框上的"计划强度角标"（算 + 注入；`view/` 那边只存展示位）
import { refreshPageBadges } from './pageBadges.js';

/** 槽位 id（`index.html`） */
export const PLAN_BAR_ID = 'plan-bar';

/** 展开时最多列几期（再多的期没人看，翻页留给内层页） */
const MAX_PERIOD_ROWS = 8;

/** 显示口径的取值器（与统计页/树上同一份：判重模式下 = 组那份） */
const shownValue = (node, field) => viewDerivedDisplay(AppState, node, field) ?? viewValue(AppState, node, field);

/**
 * 算一条计划的进度。**唯一入口** —— 界面别自己拼 `status2`/`acTime`。
 * @param {Object} plan
 * @param {string} grain 期粒度（缺省 = 计划的执行粒度）
 */
export function planBarDataOf(plan, grain) {
    return planProgressOf(AppState, plan, {
        grain: PLAN_GRAINS.includes(grain) ? grain : plan.goal.per,
        shownValue,
        tables: AppState.settings.trainingIntensityTables
    });
}

//: 计划栏那份进度的**每页独立槽记忆化**（2026-10-18，用户批的"按页 + 按数据代记忆化"）。
//: 为什么值得：`planProgressOf` = 整份题集扫一遍 + 逐题算强度，真包副页（3638 vNode）实测 **~31ms/次**，
//:   而它**每次渲染这一条栏都要算**（切回副页、改一个字段、折叠一次都算）。
//: ★ 每页一格、互不淘汰、**页对象没了那格自动回收**（`utils/memoSlots.js` 的 `WeakMap`）：
//:   用户 2026-10-18 连点三次 —— 共用槽位 ⇒ 来回切全落空；"改成独立槽位" ⇒ 每页一格；
//:   "为什么不收" ⇒ 键用页对象本身，删页后自动回收。
//: ⚠️ **漏一个键 = 静默错数**（这个坑本仓踩过两次）：`planProgressOf` 读到的东西一样都不能少 ——
//:   题集那半：`nodes` / `childOrder`（`collectByType` 走它）/ 那一页 / `virtualIndex`（屏蔽与否在 vNode 上）/
//:   `rootId`（范围根留空 = 超级根）/ `plan`（`pick`、`statuses`、`goal`、`rootIds` 都在里面）；
//:   显示口径那半：`accounts` / `trust` / `fieldRegistry` / `sources` / 两个身份指针 / `settings`（强度表、
//:   计数模式）/ `view`；再加上 `today`（期窗口 = 计划开始 → **今天**，跨零点要重算）。
//: 判据：`scripts/smoke/plan-bar.smoke.mjs` 的「进度是记忆化的，但数据一变就必须重算」那一组；
//:   槽的语义（每页一格、页没了自动回收）在 `src/test/perfGuards.test.js` ⑬。
const planBarSlots = createSlots();

/** 计划栏用的一趟进度（同一页+同一份数据 ⇒ 命中；**只给这条栏用**，别当通用缓存） */
function planBarProgressOf(plan) {
    const s = AppState;
    const page = (s.pages && plan && plan.pageId) ? s.pages[plan.pageId] : null;
    const today = getNowStr().split(' ')[0];
    // ★ 比**结构签名**、不比页对象：`expanded` 存在 vNode 上，折一下就换新页对象
    //   ⇒ 比页对象的话每次折叠都要重算这条进度（实测 23ms，用户 2026-10-18："副页折叠现在慢啊"）。
    const sig = page ? structureSignatureOf(page) : '';
    const hit = plan ? planBarSlots.get(page.id) : null;
    if (hit && hit.state === s && hit.plan === plan && hit.sig === sig && hit.today === today
        && hit.nodes === s.nodes && hit.childOrder === s.childOrder && hit.rootId === s.rootId
        && hit.view === s.view && hit.settings === s.settings
        && hit.accounts === s.accounts && hit.trust === s.trust
        && hit.fieldRegistry === s.fieldRegistry && hit.sources === s.sources
        && hit.viewingAccountId === s.viewingAccountId && hit.currentAccountId === s.currentAccountId) {
        return hit.progress;
    }
    const progress = planBarDataOf(plan);
    if (page) {
        planBarSlots.set(page.id, {
            state: s, plan, sig, today, progress,
            nodes: s.nodes, childOrder: s.childOrder, rootId: s.rootId,
            view: s.view, settings: s.settings, accounts: s.accounts, trust: s.trust,
            fieldRegistry: s.fieldRegistry, sources: s.sources,
            viewingAccountId: s.viewingAccountId, currentAccountId: s.currentAccountId
        });
    }
    return progress;
}

//: 计划栏"烘热"的延时（与副页桶缓存那条同一个姿态：先让首屏/交互画完，再算）
const PLAN_WARM_DEFER_MS = 60;
let planWarmTimer = null;

/**
 * 把**各页**的计划进度先在后台算一遍（用户 2026-10-18："在启动/刷新时就计算，跟主页一样，但可以延迟"）。
 *
 * 为什么需要：`planProgressOf` 冷算在真包副页上实测 **23ms**，而它只在"画的正是那个副页"时才露出在
 * 切页那一帧（`[计划栏] 进度 planProgressOf`）。提前算准 ⇒ 切进副页时那一格是 0ms。
 * ⚠️ 延时 + 只算一次（`planBarProgressOf` 自己有按页记忆化）⇒ 幂等；失败一律吞掉（后台任务不许炸主流程）。
 */
export function warmPlanBars(state = AppState) {
    if (planWarmTimer) return;
    planWarmTimer = setTimeout(() => {
        planWarmTimer = null;
        try {
            for (const id of Object.keys(state.pages || {})) {
                const plan = planOfPage(state, id);
                if (plan) planBarProgressOf(plan);
            }
        } catch { /* 后台任务不许炸主流程 */ }
    }, PLAN_WARM_DEFER_MS);
}

/** "当前那一期"：今天所在的那期；今天不在计划范围内 ⇒ 退回最后一期（面板上会写出它的标签） */
function currentPeriodOf(progress) {
    if (!progress.periods.length) return null;
    const todayKey = periodKeyOf(getNowStr(), progress.grain);
    return progress.periods.find((p) => p.key === todayKey)
        || progress.periods[progress.periods.length - 1];
}

/**
 * 一条计划的"一行摘要"文字（也是冒烟最好断言的落点）。
 * 第 2 轮起开头就是**已写 / 总训练强度**（用户要的那两个数），后面才是本期与累计。
 */
export function planSummaryText(plan, progress) {
    if (progress.missingPage) return '题单页已删除（计划还在）';
    const head = `已写 ${fmt(progress.doneIntensity || 0)}/${fmt(progress.totalIntensity || 0)} 强度`;
    const cur = currentPeriodOf(progress);
    const unit = progress.goalMode === 'count' ? '题' : '强度';
    if (!cur) {
        return `${head} · 题集 0 题（${progress.problemsSource === 'range' ? '选的范围里还没有题' : '题单页里还没有题'}）`;
    }
    const actual = fmt(cur.actual);
    const goal = fmt(cur.goal);
    const total = `${fmt(progress.totals.actual)}/${fmt(progress.totals.goal)}`;
    return `${head} · ${cur.label} ${actual}/${goal} ${unit} · 累计 ${total} ${unit}`;
}

// ================================================================
// 渲染
// ================================================================

/** 把一个计划画成一行（真元素；返回 `{ row, head, body }` 便于冒烟断言） */
function buildPlanRow(plan, progress) {
    const collapsed = isPlanCollapsed(AppState, plan.id);
    const row = document.createElement('div');
    row.className = 'plan-row';
    row.dataset.plan = plan.id;
    row.style.cssText = 'border:1px solid #e2e8f0;border-radius:8px;padding:6px 10px;margin-top:6px;background:#fff;';

    const head = document.createElement('div');
    head.className = 'plan-row-head';
    head.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';

    const name = document.createElement('span');
    name.className = 'plan-name';
    name.style.cssText = 'font-size:13px;font-weight:600;color:#334155;';
    name.textContent = `📄 ${plan.name}`;

    const summary = document.createElement('span');
    summary.className = 'plan-summary';
    summary.style.cssText = 'font-size:12px;color:#64748b;';
    summary.textContent = planSummaryText(plan, progress);

    const toggle = document.createElement('button');
    toggle.className = 'btn plan-row-toggle';
    toggle.dataset.plan = plan.id;
    toggle.textContent = collapsed ? '▸ 展开' : '▾ 收起';
    toggle.title = '展开/收起这一条的明细';
    toggle.addEventListener('click', () => {
        // 折叠态 = 视图态：直接改 + 合并落盘（**不进事务、不建历史步**，那是"折叠很慢"的来源）
        setPlanCollapsed(AppState, plan.id, !collapsed);
        scheduleViewSave(AppState);
        renderPlanBar();
    });

    // ★ 「完整信息」= 开内层页（⑭：点按钮进内层看完整信息）；懒引 tabs.js（它反过来静态引 planPage）
    const full = document.createElement('button');
    full.className = 'btn plan-full';
    full.dataset.plan = plan.id;
    full.textContent = '📖 完整信息';
    full.title = '打开这条计划的详细页（题单来源 / 题目列表与统计 / 每期完成情况 / 计划设置）';
    full.addEventListener('click', () => {
        import('../tabs.js').then((m) => m.openPlanTab(plan.id));
    });

    // ⚠️ **不再有「去题单页」**（2026-10-13 第 1 轮）：这条栏现在**只在自己那个副页上显示**
    //    ⇒ 你已经在题单页上了，那颗按钮是废的（内层页头部那颗还留着，从那儿点才有意义）。
    // ⚠️ **也不再有一颗「✖ 删除计划」**（用户 2026-10-15："计划不需要增删功能"）——
    //    计划是副页的一部分：删计划 = 删副页，没有"单独删一份计划"这件事。

    // ⚠️ 用 appendChild（不是 append）：DOM 桩（scripts/smoke/dom.mjs）只实现了前者，
    //    而这条栏刻意用**真元素**画（好让冒烟查得到、点得动）。
    for (const el of [name, summary, full, toggle]) head.appendChild(el);
    row.appendChild(head);

    if (!collapsed) {
        const body = document.createElement('div');
        body.className = 'plan-row-body';
        body.style.cssText = 'margin-top:6px;';
        body.innerHTML = planDetailHtml(plan, progress);
        row.appendChild(body);
    }
    return row;
}

/** 明细那一段（表格 + 警告行）—— 这一段是**只读**的展示，用 innerHTML 拼（冒烟按字符串断言） */
function planDetailHtml(plan, progress) {
    const out = [];
    if (progress.missingPage) {
        out.push('<div class="plan-warn" style="font-size:12px;color:#b45309;">⚠️ 题单页已删除 —— 这条计划算不出题集了（计划本身留着，重新选一个副页即可）。</div>');
        return out.join('');
    }
    const warns = [];
    // ★ "题集本身取不到"的警告（副页没了 / 范围根没了 / 一个根都没选）—— 文本在 `planScope.js` 一处
    const scopeWarn = planSourceWarnOf(progress);
    if (scopeWarn) warns.push(scopeWarn);
    if (progress.unknownDifficulty > 0) {
        // ★ 第 12 轮（用户："未填写的不计入 因为有热身赛等"）：警告还在，但说的是"**不计入**"
        warns.push(`⚠️ ${progress.unknownDifficulty} 道题没填难度，不计入强度`);
    }
    // ⚠️ **不再提醒"没有 AC 时间"**（用户 2026-10-13 第 4 轮："没 AC 很正常，不用提醒"）。
    //    那个数（`progress.undatedCount`）照旧算着（期表与图表要它），只是不再当"警示"报出来。
    if (warns.length) {
        out.push(`<div class="plan-warn" style="font-size:12px;color:#b45309;">${warns.map(escapeHtml).join('　')}</div>`);
    }
    const cur = currentPeriodOf(progress);
    // ★ 表格里的期序 = **越新的越靠前**（用户第 2 轮点名、第 4 轮："外侧时间也要倒序"）——
    //   规则只有一份：`core/trainingPlan.js:periodsNewestFirst`（别在这儿 `reverse()`）
    const rows = periodsNewestFirst(progress.periods).slice(0, MAX_PERIOD_ROWS);
    const unit = progress.goalMode === 'count' ? '题' : '强度';
    out.push('<table class="plan-periods" style="border-collapse:collapse;font-size:12px;color:#475569;margin-top:4px;">'
        + `<tr style="color:#94a3b8;"><th style="text-align:left;padding:2px 10px 2px 0;">期（${escapeHtml(progress.grain)}）</th>`
        + `<th style="text-align:right;padding:2px 10px 2px 0;">题数</th>`
        + `<th style="text-align:right;padding:2px 10px 2px 0;">Σ强度</th>`
        + `<th style="text-align:right;padding:2px 0;">目标</th><th style="text-align:left;padding:2px 0 2px 8px;">达标</th></tr>`);
    for (const p of rows) {
        const isCur = cur && p.key === cur.key;
        out.push('<tr' + (isCur ? ' class="plan-period-current"' : '') + '>'
            + `<td style="padding:2px 10px 2px 0;">${escapeHtml(p.label)}</td>`
            + `<td style="text-align:right;padding:2px 10px 2px 0;">${p.count}</td>`
            + `<td style="text-align:right;padding:2px 10px 2px 0;">${fmt(p.intensity)}</td>`
            + `<td style="text-align:right;padding:2px 0;">${fmt(p.goal)}</td>`
            + `<td style="padding:2px 0 2px 8px;">${p.reached === null ? '—' : (p.reached ? '✅' : '⬜')}</td>`
            + '</tr>');
    }
    out.push('</table>');
    out.push(`<div class="plan-hint" style="font-size:11px;color:#94a3b8;margin-top:2px;">`
        + `题集 ${progress.entries.length} 题（${escapeHtml(problemSourceTextOf(progress))}）`
        + ` · 目标口径：${progress.goalMode === 'count' ? '题数' : '训练强度'}（基准粒度 ${escapeHtml(progress.goalBase)}，本行按 ${escapeHtml(progress.grain)} 折算）`
        + ` · 强度源 ${escapeHtml(progress.source)}</div>`);
    return out.join('');
}

/**
 * 重画整条计划栏（**唯一入口**；`applyTreeLayout` 每次渲染都会调它）。
 * 槽位不存在（老桩 / 文件夹模式）⇒ 安静返回。
 */
export function renderPlanBar() {
    // 诊断（2026-10-18，量完"×3 → ×1"之后剩下那 31ms 是谁的）：开关在 `utils/diag.js` 一处。
    const pbT0 = nowMs();
    const pbLap = (n) => diag('计划栏', `${n} = ${msSince(pbT0)}ms（累计）`);
    const host = document.getElementById(PLAN_BAR_ID);
    if (!host) return false;
    host.innerHTML = '';

    // ★ **这条栏只属于"计划绑定的那个副页"**（用户 2026-10-13 第 1 轮：
    //   "主页完全与这个功能无关，训练计划属于哪个副页就只在哪个副页显示"）：
    //   主页（`main`）一律不显示；某个副页只显示**绑到它的**计划。
    //   ⚠️ 依赖 `AppState.currentPageId`（切页/换页时刷新链会重画这一条）。
    const pageId = AppState.currentPageId || 'main';
    // ⚠️ 副页被删掉时 `currentPageId` 可能还指着它（正常路径会回落到 main，这里兜底）：
    //    页都没了 ⇒ 这条栏也没有落点，别在一个不存在的页上画空态。
    const livePage = (pageId !== 'main' && AppState.pages) ? AppState.pages[pageId] : null;
    // ★ **一对一**（用户 2026-10-15："计划是副页的一部分、不需要增删功能"）：
    //   这个副页**就那一份**计划 —— 读口只有 `core/ops/plan.js:planOfPage` 一处
    //   （别再 `plans.filter(p => p.pageId === id)`：一对一下那会悄悄变成"取第一条"、与写路径分叉）。
    const plan = livePage ? planOfPage(AppState, pageId) : null;
    // ★★ **一条计划这一趟只算一遍**（2026-10-18）：原来的形状是
    //   `refreshPageBadges()` 调一次、路由过了早退再调一次、末了 `buildPlanRow(plan, planBarDataOf(plan))`
    //   再调一次 ⇒ 同一个 `planProgressOf`（整份题集扫一遍）在一趟渲染里算了 **3 遍**，
    //   实测计划栏占副页热切 41ms（冷切 54ms）里的大头。三处要的是**同一个** progress（入参完全相同：
    //   同一个 state / plan，`grain` 都退化成 `plan.goal.per`）⇒ 算一次、往下传。
    const progress = plan ? planBarProgressOf(plan) : null;
    pbLap('进度 planProgressOf');
    // ★ 副页方框上的**计划强度角标**（`剩 X / 共 Y`）：**在树画之前**算好并注入
    //   （这条栏在 `applyTreeLayout` 里正好画在树前面 ⇒ 这里是最省事、也不会晚一帧的位置）。
    //   ⚠️ 放在早退**之前**：切回主页时也要跑（那一趟要把角标**清掉**，否则主页上留着上一页的）。
    //   ⚠️ 只读注入，不写任何数据；口径与算法见 `ui/plan/pageBadges.js`。
    refreshPageBadges(AppState, progress);
    pbLap('角标 planSubtreeIntensityOf');
    if (!livePage) {
        host.style.display = 'none';
        host.innerHTML = '';
        return true;
    }
    host.style.display = '';
    const plans = plan ? [plan] : [];
    const collapsed = isPlanBarCollapsed(AppState);

    const head = document.createElement('div');
    head.className = 'plan-bar-head';
    head.style.cssText = 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;';

    const title = document.createElement('span');
    title.className = 'plan-bar-title';
    title.style.cssText = 'font-size:13px;font-weight:600;color:#334155;';
    // ★ 不再带"(N)"（用户 2026-10-15："训练计划的"(1)"可以去掉了"）：一对一下这个数恒为 0/1，
    //   是个噪声；"这条栏属于哪个副页"由它就在这个副页上显示这件事本身说明。
    title.textContent = '📅 训练计划';

    const toggle = document.createElement('button');
    toggle.className = 'btn plan-bar-toggle';
    toggle.textContent = collapsed ? '▸ 展开' : '▾ 收起';
    toggle.title = '整条栏展开/收起（折叠态只存在本地，不进数据）';
    toggle.addEventListener('click', () => {
        setPlanBarCollapsed(AppState, !collapsed);
        scheduleViewSave(AppState);
        renderPlanBar();
    });

    // ⚠️ **没有「＋ 新建计划」了**（用户 2026-10-15："计划不需要增删功能"）：
    //    一对一模型下建副页就自带一份计划（`core/ops/plan.js:ensurePagePlan`），
    //    入口撤掉、`ui/plan/planDialog.js` 随之退休。
    for (const el of [title, toggle]) head.appendChild(el);
    host.appendChild(head);

    if (collapsed) return true;
    if (!plans.length) {
        // 理论上不该出现（建页就有计划）；真碰上（旧数据/手写的页）就如实说，**不给建入口**
        const empty = document.createElement('div');
        empty.className = 'plan-bar-empty';
        empty.style.cssText = 'font-size:12px;color:#94a3b8;margin-top:4px;';
        empty.textContent = '这个副页还没有计划 —— 一对一模型下它本该自带一份（这页是旧数据：重建一个副页即可）。';
        host.appendChild(empty);
        return true;
    }
    for (const p of plans) {
        host.appendChild(buildPlanRow(p, progress));
    }
    pbLap('行 buildPlanRow + 拼 DOM');
    return true;
}

