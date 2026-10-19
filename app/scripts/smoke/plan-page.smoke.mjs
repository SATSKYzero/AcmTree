// ================================================================
// 冒烟测试：内层计划页（scripts/smoke/plan-page.smoke.mjs）
//
// 设计稿 `docs/training-plan.md` ⑭："外层简要信息 + 点按钮进内层看完整信息（**跟节点详页一个意思**）"。
// 这里钉的是**内层这一半**：
//   · 走的是 `ui/tabs.js` 的**同一个"第三类 tab"机制**（自带一条栏、可同时开多个、内容按需画）；
//   · 四块内容都在：题单来源 / 题目列表 / 状态×难度统计 / 每期完成情况 / 计划设置；
//   · 统计那一块**与统计页同一份口径**（分档取 `xcpcBucketOf`、行序取 `STATUS2_ORDER`）；
//   · 「计划设置」改完真的落库（`updatePlan`），"算做完的状态"那几个勾生效；
//   · 题单页被删 / 计划被删时的表现。
//
// ⚠️ 只读内容（列表 / 网格 / 每期表）是 `innerHTML` 拼的 ⇒ 只能 `serialize()` 后按字符串断言；
//    **可点的控件一律真元素**（DOM 桩不解析 innerHTML）⇒ 那些用 `querySelector(...).click()`。
// ⚠️ `status2`/`acTime` 是派生值：没有派生表时 `viewDerivedDisplay` 给的是**占位符**（不是 `undefined`）
//    ⇒ 夹具照真路搭（P 下挂 R），让派生表自己算。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom();
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
makeContainer(app, 'nodeinfo-tab-bar');
for (const id of ['tree-container', 'tree-body', 'tree-stats', 'tree-root-info-container',
    'mode-action-btn-container', 'plan-bar', 'folder-stats', 'folder-view-tabs', 'toast']) {
    makeContainer(app, id);
}
for (const [id, label] of [['dedup', '🧩 判重整理'], ['main', '🏠 主视图'], ['stats', '📊 数据统计']]) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = id;
    btn.textContent = label;
    tabBar.appendChild(btn);
    const pane = document.createElement('div');
    pane.className = 'tab-content';
    pane.id = `tab-${id}`;
    app.appendChild(pane);
}
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const tabs = await import(mod('ui/tabs.js'));
const planPage = await import(mod('ui/plan/planPage.js'));
const planBar = await import(mod('ui/plan/planBar.js'));

const pane = () => document.getElementById('tab-plan-plan_1');
const page = () => pane() && pane().querySelector('.plan-page');
const blockOf = (name) => page() && page().querySelector(`[data-plan-block="${name}"]`);
const textOf = (elm) => (elm ? serialize(elm) : '');

/** 昨天的 `YYYY.MM.DD`（夹具要**两期**才看得出"粒度切换"的差别） */
function yesterday() {
    const d = new Date(Date.now() - 86400000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}
function todayDay() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 两个副页 / 两道题（P 下挂 R，让派生表算出 status2 与 acTime）/ 一条计划 */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';
    AppState.settings.trainingIntensityTables = [];
    const val = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '某场比赛', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', problemId: 'A', values: { ratio: val('9') } },
        p2: { id: 'p2', type: 'P', name: 'B题', problemId: 'B', values: {} },
        r1: { id: 'r1', type: 'R', values: { status: val('AC'), submitKind: val('赛时'), time: val(`${yesterday()} 10:00:00`) } },
        r2: { id: 'r2', type: 'R', values: { status: val('WA'), submitKind: val('赛时'), time: val(`${todayDay()} 11:00:00`) } }
    };
    AppState.childOrder = { root: ['c1'], c1: ['p1', 'p2'], p1: ['r1'], p2: ['r2'], r1: [], r2: [] };
    AppState.parentOf = { c1: 'root', p1: 'c1', p2: 'c1', r1: 'p1', r2: 'p2' };
    AppState.rootId = 'root';
    AppState.pages = {
        page_1: {
            id: 'page_1', name: '题单', rootId: 'v_root',
            virtualIndex: {
                v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['vc'] },
                vc: { id: 'vc', refId: 'c1', type: 'C', parentId: 'v_root', children: [] }   // 整场比赛 ⇒ 子树两道题都算
            }
        }
    };
    AppState.plans = {
        plan_1: {
            id: 'plan_1', name: '每日补题', pageId: 'page_1',
            start: yesterday(), end: '', goal: { mode: 'intensity', per: 'day', value: 3 },
            statuses: [3, 4], intensitySource: 'xcpc', intensityTableId: ''
        }
    };
    AppState.view = { expanded: {}, pages: {} };
    AppState.currentTab = 'main';
}

// ================================================================
group('内层计划页：走的是"第三类 tab"（与节点详页同一套机制）');
// ================================================================
seed();
tabs.setupTabs();
eq(tabs.getPlanTabs().length, 0, '（前提）还没开计划页');
tabs.openPlanTab('plan_1');
eq(tabs.getPlanTabs().length, 1, '开出来了');
eq(tabs.getCurrentTab(), 'plan-plan_1', '并且切过去');
const niBar = document.getElementById('nodeinfo-tab-bar');
ok(!!niBar.querySelector('.tab-btn[data-plan-tab="1"]'), '★ 页签在**那条独立栏**上（与节点详页同处一条），带 `data-plan-tab`');
ok(!!pane(), '面板容器按需建好了（`ensureTabContent`）');
ok(!!page(), '页面本体画出来了');

// ================================================================
group('内层计划页：四块内容都在，且统计与统计页同一份口径');
// ================================================================
const src = textOf(blockOf('source'));
ok(/题单来源/.test(src), 'A 题单来源在');
ok(/题单/.test(src) && /共 <b>2<\/b> 道/.test(src), '★ 写出"题集 = 副页里的全部题"与题数（这里页里放的是整场比赛 ⇒ 子树 2 道都算）');
const list = textOf(blockOf('list'));
ok(/题目列表（2\/2 道）/.test(list), 'B 列表标题带「筛出\/全部」两道');
ok(/A题/.test(list) && /B题/.test(list), '两道题都在表里');
ok(/赛时通过/.test(list) && /已提交未通过/.test(list), '★ 状态2 文案取自 `STATUS2_LABELS`（没自己拼）');
ok(/银牌/.test(parseGridText()), 'C 统计里那道填了通过率的题落在 XCPC 档位里（分档走 `xcpcBucketOf`）');
const grid = blockOf('stats');
const gridText = textOf(grid);
ok(/状态 × 难度/.test(gridText), '状态×难度那一块在');
ok(!/与统计页同一份口径/.test(gridText), '★ 标题里不再写「（与统计页同一份口径）」（用户第 1 轮要求）');
ok(/合计/.test(gridText), '有合计行（`statusGridOf` 的产出）');
ok(/未填写/.test(gridText), '没填难度的题落到「未填写」那一列（不静默丢）');
const periods = textOf(blockOf('periods'));
ok(/每期完成情况/.test(periods), 'D 每期完成情况在');

// ================================================================
group('内层计划页：计划设置改完真的落库（`updatePlan`）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const settings = blockOf('settings');
const field = (f) => settings.querySelector(`[data-plan-field="${f}"]`);
ok(!!field('name') && !!field('start') && !!field('value') && !!field('source'), '表单字段都在（真元素，能改）');
field('name').value = '改名后的计划';
field('value').value = '5';
field('mode').value = 'count';
settings.querySelector('[data-plan-status="2"]').checked = true;      // 把"已提交未通过"也算做完
settings.querySelector('[data-plan-status="3"]').checked = false;     // 取消"赛后补题"
settings.querySelector('[data-plan-status="4"]').checked = false;     // 取消"赛时通过"
settings.querySelector('[data-plan-action="save"]').click();
await tick(60);
eq(AppState.plans.plan_1.name, '改名后的计划', '★ 名字落库');
eq(AppState.plans.plan_1.goal.value, 5, '★ 目标值落库');
eq(AppState.plans.plan_1.goal.mode, 'count', '★ 目标口径落库');
eq(AppState.plans.plan_1.statuses.sort().join(','), '2', '★ "算做完的状态"那几个勾落库（这勾改成只认 2）');
ok(/改名后的计划/.test(textOf(page())), '★ 重画之后页面上就是新名字（现算，不留旧值）');

// 「去题单页」= ① 回主视图那张 tab ② 再切副页（用户第 4 轮报的就是缺了①：
//   "会让主视图的 tab 切换，但不会直接跳过去显示对应副页"）
const seen = [];
const onSwitch = (e) => seen.push(e.detail && e.detail.pageId);
document.addEventListener(EVENTS.SWITCH_PAGE, onSwitch);
tabs.switchTab('plan-plan_1');            // 前提：先站在计划页上（用户看到问题的那一步）
eq(AppState.currentTab, 'plan-plan_1', '（前提）现在停在计划页那张 tab 上');
page().querySelector('[data-plan-action="goto-page"]').click();
await tick(20);                            // 那一步是懒引 tab 模块 ⇒ 派发在下一个微任务里
document.removeEventListener(EVENTS.SWITCH_PAGE, onSwitch);
eq(seen.join(','), 'page_1', '★ 走的是既有事件 `EVENTS.SWITCH_PAGE`');
eq(AppState.currentTab, 'main', '★ 并且真的切回了主视图那张 tab（否则人还留在计划页上、看不见那个副页）');

// ================================================================
group('第 13 轮 ①：计划设置里的题集 = 副页里的题 ∩ 范围根子树 ∩ 条件（取当前选中）');
// ================================================================
seed();
AppState.nodes.p1.selected = true;         // 树上只勾这一道题（计划要从"副页那 2 道"改成"这一道"）
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const s13 = blockOf('settings');
// ★ 字段名**不许重名**：保存时 `q(f)` 取的是**第一个**同名字段 ⇒ 重名会静默串值
//   （实测差点踩：题集来源与「强度源」都想叫 `source`）
const names13 = [...s13.querySelectorAll('[data-plan-field]')].map((n) => n.dataset.planField);
eq(new Set(names13).size, names13.length, '★ 「计划设置」里的字段名两两不同（q() 只取第一个）');
// ★ **没有「题集来源」那个下拉了**（用户 2026-10-14："「就用这个副页里的题」就是无选中时自动选
//   超级根节点的逻辑" ⇒ 不是两条来源，是"范围根留空 = 超级根"这一个旋钮）
ok(!/data-plan-field="psource"/.test(textOf(s13)), '★ 不再有「题集来源」下拉（退回两个来源就红）');
ok(/范围根：整个副页/.test(textOf(s13)), '★ 范围根留空 ⇒ 写"整个副页（超级根）"，不是"还没选"');
ok(/题单页里还没有题|副页/.test(textOf(blockOf('source'))), '（前提）现在写的是"题集 = 副页…"');
// ★ 把当前生效的规则写成一句人话 + 现算道数（用户 2026-10-14："逻辑看不懂 细讲"）
//   ⚠️ 第一段永远是**副页**（它是边界）；没有范围根时不写"子树"那一段
const formula13 = () => String(s13.querySelector('[data-plan-formula]').textContent || '');
ok(/题集 = 副页「题单」里的题/.test(formula13()), '★ 公式那一句：第一段永远是"副页里的题"（边界）');
ok(!/子树/.test(formula13()), '★ 没有范围根 ⇒ 公式里不出现"子树"那一段');
ok(/∩ 题集条件：不限（五维都空）/.test(formula13()), '★ 公式那一句：层与层用 ∩ 串起来（副页 ∩ 题集条件）');
// ★ 计划侧那一块叫「**题集条件**」（`plan.pick`：进数据、要保存）—— 与列表那栏的「列表筛选」分开命名
ok(/题集条件（改它 ⇒ 题集跟着变，记得保存）/.test(textOf(s13)), '★ 条件块前面写着「题集条件（改它 ⇒ 题集跟着变，记得保存）」');
ok(/⇒ 现在 2 道/.test(formula13()), '★ 公式那一句：末尾给现算的道数（= 副页那 2 道）');

s13.querySelector('[data-plan-action="take-selection"]').click();
s13.querySelector('[data-plan-action="save"]').click();
await tick(60);
eq((AppState.plans.plan_1.rootIds || []).join(','), 'p1', '★ 「取当前选中」把树上勾的那一个收成范围根');
eq(AppState.plans.plan_1.source, 'range', '★ `source` 是**推出来的**兼容字段（有根 ⇒ range）');
eq('filterMode' in AppState.plans.plan_1, false, '★ 计划里**没有 `filterMode`**（"实时范围"那一层整体删了）');
const d13 = planBar.planBarDataOf(AppState.plans.plan_1);
eq(d13.problemsSource, 'range', '现算时也确实有范围根');
eq(d13.entries.length, 1, '★ 题集 = 范围根子树里的题（1 道，不再是副页那 2 道）');
ok(/题集 = 副页「题单」里的题 ∩ 子树「.*A题.*」/.test(formula13()),
    '★ 公式那一句跟着变：副页（边界）∩ 子树（名字）');
ok(/⇒ 现在 1 道/.test(formula13()), '★ 现算的道数也跟着变（1 道）');
ok(/树上范围/.test(textOf(blockOf('source'))), '★ 来源那一块如实写"树上范围"');
ok(!/题单页已删除/.test(textOf(blockOf('source'))), '★ 有副页就不该说"题单页已删除"');

// 清空范围根 ⇒ **回到整个副页**（不是 0 道）
s13.querySelector('[data-plan-action="clear-roots"]').click();
s13.querySelector('[data-plan-action="save"]').click();
await tick(60);
eq((AppState.plans.plan_1.rootIds || []).length, 0, '清空范围根落库');
eq(AppState.plans.plan_1.source, 'page', '**推出来的** `source` 跟着回到 page');
eq(planBar.planBarDataOf(AppState.plans.plan_1).entries.length, 2, '★ 清空 = 回到整个副页（2 道），不是 0 道');
ok(!/还没选范围根/.test(textOf(blockOf('source'))), '★ 没有范围根**不是错误**（那是超级根）⇒ 不该报"还没选"');

// ---- 条件**不弹窗**，就画在设置栏里（用户看图后："可以不用弹窗，直接放在计划设置栏里"）----
ok(/data-pick="level"/.test(textOf(s13)), '★ 四维条件（档位芯片等）直接画在计划设置栏里');
ok(/id="pick-cf-min"/.test(textOf(s13)), '数值区间那两个框也在这一栏里');
ok(!/data-plan-action="pick-condition"/.test(textOf(s13)), '★ 没有「⚙ 条件…」那个弹窗按钮了（退回弹窗就红）');

// ---- 副页里那颗 ○（虚拟节点）也算"当前选中"（用户 2026-10-14 报的"选不中"就是这一路）----
seed();
AppState.pages.page_1.virtualIndex.vc.selected = true;      // 在副页里勾了整场比赛 c1
tabs.setupTabs();
tabs.openPlanTab('plan_1');
AppState.currentPageId = 'page_1';                          // 人在这个副页上
const s13b = blockOf('settings');
s13b.querySelector('[data-plan-action="take-selection"]').click();   // 主树一个没勾，副页勾了一个
await tick(20);
ok(!/还没有勾选/.test(textOf(s13b)), '★ 不再报"还没勾选任何节点"（副页里勾的也算）');
s13b.querySelector('[data-plan-action="save"]').click();
await tick(60);
eq((AppState.plans.plan_1.rootIds || []).join(','), 'c1',
    '★ 副页里勾的虚拟节点 ⇒ 用它的 refId 回到真实节点当范围根');
eq(planBar.planBarDataOf(AppState.plans.plan_1).entries.length, 2, '题集 = c1 子树里那两道题');

// ---- 父子都勾 ⇒ 只留父，但**必须说出来**（用户当天问："我选中了两个，为什么说范围根：XCPC 呢"）----
seed();
AppState.nodes.c1.selected = true;                          // 父
AppState.nodes.p1.selected = true;                          // 子（在 c1 之下，题集是重复的）
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const s13c = blockOf('settings');
s13c.querySelector('[data-plan-action="take-selection"]').click();
await tick(20);
ok(/范围根：某场比赛/.test(textOf(s13c)), '★ 只留父（c1）—— 子那一棵已经在父里，题集一样');
ok(/你勾了 2 个/.test(textOf(s13c)), '★ 并且**写明**"你勾了 2 个"（不许静默替用户合并掉一个）');
ok(/没单列/.test(textOf(s13c)), '…并且说清被合并的那个是"没单列"，不是丢了');

// ---- 两个**兄弟**染色 ⇒ 两个根都在（不许塌成它们的父）----
seed();
AppState.nodes.p1.selected = true;
AppState.nodes.p2.selected = true;              // p1/p2 是兄弟，都挂在 c1 下
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const s13e = blockOf('settings');
s13e.querySelector('[data-plan-action="take-selection"]').click();
await tick(20);
ok(/范围根：.*A题/.test(textOf(s13e)) && /B题/.test(textOf(s13e)), '★ 两个兄弟都是范围根（没有被并成一个）');
ok(!/没单列/.test(textOf(s13e)), '★ 没有多出来的"合并"说明（本来就该是两条）');

// ---- 页签那颗 ○（整页映射覆盖）**不算**勾选（用户："我没勾 XCPC 吧。这逻辑怎么看都不对"）----
// 病根：v9.4.2 那版把 `page.selected` 也当成"勾了这些节点"⇒ 整页的引用全进 picked，
//      于是收敛后只剩整页最上面那个（用户的截图：页签 ○ 亮着、只勾了两个年份，却收出 XCPC）。
seed();
AppState.pages.page_1.selected = true;          // 页签上那颗 ○ = 整页映射覆盖
tabs.setupTabs();
tabs.openPlanTab('plan_1');
AppState.currentPageId = 'page_1';
const s13f = blockOf('settings');
s13f.querySelector('[data-plan-action="take-selection"]').click();
await tick(20);
const toastEl = document.getElementById('toast');
ok(/范围根：整个副页/.test(textOf(s13f)), '★ 整页勾着 ⇒ **收不到**范围根（还是"整个副页/超级根"）');
ok(/整页映射覆盖/.test(String(toastEl && toastEl.textContent)), '★ 并且说清"那颗 ○ 是整页映射覆盖（统计页那边才算）"，不静默失败');

// ---- ★ **没有「筛选模式」这一格了**（用户 2026-10-14："怎么还有实时和快照两个版本的…能不能稳定一点"）----
//   `v9.4.5`~`v9.4.8` 这里还挂着一条"按副页里的标记**实时**筛"的判定，与「取当前选中」的**快照**做同一件事
//   ⇒ 两个旋钮互相打架。整层删掉：范围只认存下来的 `rootIds`。
seed();
{
    const pg = AppState.pages.page_1;
    pg.virtualIndex.v1 = { id: 'v1', refId: 'p1', type: 'P', parentId: 'v_root', children: [] };
    pg.virtualIndex.v_root.children = ['vc', 'v1'];
}
tabs.setupTabs();
tabs.openPlanTab('plan_1');
AppState.currentPageId = 'page_1';
const s13g = blockOf('settings');
ok(!/data-plan-field="filterMode"/.test(textOf(s13g)), '★ 设置卡里**没有**「筛选模式」那一格了（加回来就红）');
ok(!/筛选模式/.test(String(s13g.querySelector('[data-plan-formula]').textContent || '')),
    '★ 公式那一句里也不再出现"筛选模式"（它不是一层筛子）');
eq(planBar.planBarDataOf(AppState.plans.plan_1).entries.length, 2, '（前提）题集 = 副页里那 2 道题');
// ★ 之后**在副页里怎么标记都不改这条计划的题集**（那颗 ○ 是全局临时的）
AppState.pages.page_1.virtualIndex.v1.selected = true;
AppState.pages.page_1.selected = true;
eq(planBar.planBarDataOf(AppState.plans.plan_1).entries.length, 2,
    '★ 标记变了 ⇒ 题集一个字不变（只认「取当前选中」存下来的快照）');

// ================================================================
group('第 13 轮 ③：「清空所有数据」要真把计划与副页一起收走（用户："不删计划奇怪 / 不删副页也奇怪"）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
eq(Object.keys(AppState.pages).length, 1, '（前提）有一个副页');
eq(Object.keys(AppState.plans).length, 1, '（前提）有一条计划');
const { resetAllWithConfirm } = await import(mod('ui/G_modal/G3_settings.js'));
resetAllWithConfirm();
await tick(20);
const ovs = body.querySelectorAll('.modal-overlay');
const cpanel = ovs[ovs.length - 1];
ok(!!cpanel, '（前提）清空确认框弹出来了');
ok(/全部节点 · 全部副页 · 全部训练计划/.test(serialize(cpanel)), '★ 确认框里写清了要清掉哪三样');
const cbtn = cpanel.querySelectorAll('.btn-danger')[0];
ok(!!cbtn, '有那颗「确定」');
cbtn.disabled = false;              // 倒计时防误点：跑冒烟不真等 3 秒（与 accounts.smoke 同一姿态）
cbtn.click();
await tick(80);
eq(Object.keys(AppState.plans).length, 0, '★ 计划被清掉了（改前会留下一条指不到东西的壳）');
eq(Object.keys(AppState.pages).length, 0, '★ 副页**整页**删掉（改前只清空内容 ⇒ 页签还挂着）');
eq(AppState.currentPageId, 'main', '回到主树');
eq(Object.keys(AppState.nodes).length, 1, '节点只剩根（这一条是老口径，没变）');

// 树空了但副页/计划还在 ⇒ 仍然要能清（改前会拦下来说"已经是空树"）
seed();
AppState.childOrder[AppState.rootId] = [];
AppState.nodes = { [AppState.rootId]: AppState.nodes[AppState.rootId] };
resetAllWithConfirm();
await tick(20);
const ovs2 = body.querySelectorAll('.modal-overlay');
const cpanel2 = ovs2[ovs2.length - 1];
ok(!!cpanel2 && /清空所有数据/.test(serialize(cpanel2)), '★ 树空但副页/计划还在 ⇒ 不拦（改前报"已经是空树"）');
const cbtn2 = cpanel2.querySelectorAll('.btn-danger')[0];
cbtn2.disabled = false;
cbtn2.click();
await tick(80);
eq(Object.keys(AppState.pages).length, 0, '这一次也真清掉了副页');
eq(Object.keys(AppState.plans).length, 0, '……和计划');

// ================================================================
group('内层计划页：题单页被删 / 计划被删时的表现（不静默）');
// ================================================================
seed();
AppState.pages = {};
tabs.setupTabs();
tabs.openPlanTab('plan_1');
ok(/题单页已删除/.test(textOf(blockOf('source'))), '★ 题单页没了 ⇒ 来源那一块如实说（计划还在）');
ok(!/共 <b>\d+<\/b> 道/.test(textOf(blockOf('source'))),
    '★ 题单页都没了 ⇒ 不再报题数（不拿上一次的数字糊）');

seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
AppState.plans = {};
planPage.renderPlanPanel({ id: 'plan-plan_1', planId: 'plan_1' });
ok(/已被删除/.test(textOf(page())), '计划没了 ⇒ 页面写一句"已被删除"，不抛错');

// ================================================================
group('外层条 → 内层页：「📖 完整信息」真的开页（两边接线是同一套）');
// ================================================================
seed();
AppState.currentPageId = 'page_1';        // ★ 这条栏只在自己那个副页上显示（第 1 轮改进 ①）
tabs.setupTabs();
planBar.renderPlanBar();
const full = document.getElementById('plan-bar').querySelector('.plan-full');
ok(!!full, '外层的行上有「📖 完整信息」');
full.click();
await tick(30);
eq(tabs.getPlanTabs().length, 1, '★ 点一下真的开出了内层页（懒引 tabs.js）');
tabs.closePlanTab();
eq(tabs.getPlanTabs().length, 0, '关得掉（同一个关闭口）');
eq(tabs.getCurrentTab(), 'main', '关掉当前那个 ⇒ 回主视图');

function parseGridText() { return textOf(blockOf('stats')); }
function tick(ms = 20) { return new Promise((r) => setTimeout(r, ms)); }

// ================================================================
group('内层计划页：两张图（① 累计折线 + 目标斜线 / ② 每期柱 + 目标线）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const charts = blockOf('charts');
ok(!!charts, 'C 块里有"两张图"那一块');
const card = (k) => charts.querySelector(`[data-plan-chart="${k}"]`);
ok(!!card('line') && !!card('bar'), '两张图各一张卡');
const plansRef = AppState.plans;
const nodesRef = AppState.nodes;

// 默认查看粒度：折线日、柱状周（⑳）—— 与计划自己的执行粒度（日）互不影响
eq(charts.querySelector('[data-plan-chart="line:grain"]').value, 'day', '★ 折线默认按**日**');
eq(charts.querySelector('[data-plan-chart="bar:grain"]').value, 'week', '★ 柱状默认按**周**');
eq(AppState.plans.plan_1.goal.per, 'day', '计划自己的执行粒度还是"日"（看图粒度不动它）');

// ① 折线：实线 + 目标斜线（两串 polyline）+ 昨天/今天两个点
const lineSvg = textOf(charts.querySelector('[data-plan-chart="line:body"]'));
ok(/plan-actual-line/.test(lineSvg), '★ 折线（实际累计）那条在');
ok(/plan-goal-line/.test(lineSvg) && /stroke-dasharray/.test(lineSvg), '★ 目标那条**斜直线**在（虚线）');
ok((lineSvg.match(/polylines?/g) || []).length >= 2, '两条线都画出来了');
ok(/昨天|今|\.\d\d/.test(lineSvg), 'x 轴上有期标签');
// ② 柱状：每期一根柱 + 目标阶梯线
const barSvg = textOf(charts.querySelector('[data-plan-chart="bar:body"]'));
ok(/plan-bar-svg/.test(barSvg), '柱状图在');
ok((barSvg.match(/<rect/g) || []).length >= 1, '★ 每期一根柱');
ok(/plan-goal-steps/.test(barSvg), '★ 目标那条线在（按周粒度可能是阶梯线）');

// ③ 切粒度 ⇒ 这一张图自己重算（日 2 期 → 月 1 期），**不动**计划、也不动另一张图
const lineGrain = charts.querySelector('[data-plan-chart="line:grain"]');
lineGrain.value = 'month';
lineGrain.dispatchEvent({ type: 'change' });
await tick(30);
ok(/1 期/.test(textOf(blockOf('charts'))), '★ 折线切到"月" ⇒ 只剩 1 期（期数真的按这张图的粒度重算了）');
eq(blockOf('charts').querySelector('[data-plan-chart="bar:grain"]').value, 'week', '另一张图的粒度**没被带着改**');
eq(AppState.plans, plansRef, '⚠️ 换看图粒度**不改数据**（`state.plans` 引用都没换）');
eq(AppState.nodes, nodesRef, '⚠️ `nodes` 更没动');

// ④ 每张图各自可折叠（5 态里的"只显示其一"）
blockOf('charts').querySelector('[data-plan-chart="bar:toggle"]').click();
ok(!blockOf('charts').querySelector('[data-plan-chart="bar:body"]'), '柱状图收起 ⇒ 它的画布没了');
ok(!!blockOf('charts').querySelector('[data-plan-chart="line:body"]'), '折线还在（各折各的）');
blockOf('charts').querySelector('[data-plan-chart="bar:toggle"]').click();
ok(!!blockOf('charts').querySelector('[data-plan-chart="bar:body"]'), '再点一下展开回来');

// ⑤ 换序（上下对调）
// ⚠️ **别用逗号选择器**：`scripts/smoke/dom.mjs` 不解析它 ⇒ 两边都是空数组，
//    断言会"`'' === ''`"地**假通过**（这里真踩过一次）。改成遍历 `children` 按 dataset 过滤。
const orderOf = () => [...blockOf('charts').children]
    .filter((n) => n.dataset && (n.dataset.planChart === 'line' || n.dataset.planChart === 'bar'))
    .map((n) => n.dataset.planChart).join(',');
const orderBefore = orderOf();
eq(orderBefore, 'line,bar', '（前提）两张卡的顺序查得到（否则下面的换序断言是空转）');
blockOf('charts').querySelector('[data-plan-chart="swap"]').click();
await tick(20);
eq(orderOf(), 'bar,line', '★ 「⇅ 换序」真的把上下对调了');
eq(AppState.plans, plansRef, '换序也是视图态：数据一个字没动');

// ================================================================
group('第 1 轮改进 ②：题目列表可折叠 / 分页 / 可跳转 / 支持筛选');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const listBlock = () => blockOf('list');
eq(listBlock().querySelectorAll('[data-plan-row]').length, 2, '（前提）两行都在');
ok(!!listBlock().querySelector('[data-plan-action="list-toggle"]'), '有折叠按钮');
ok(!!listBlock().querySelector('[data-plan-filter="list-q"]'), '有关键字筛选框');
ok(!!listBlock().querySelector('[data-plan-filter="list-status-4"]'), '有状态2 多选');
ok(!!listBlock().querySelector('[data-plan-filter="list-levels:C+"]'), '难度档改成**多选芯片**（第 4 轮）');
ok(!!listBlock().querySelector('[data-plan-action="list-next"]'), '有翻页控件');
// ★ 第 14 轮（用户："题名所占的列太长了" / "尽量给各处难度文本涂上应有的颜色"）：
{
    const { XCPC_COLORS: LV_COLORS } = await import(mod('A_constants.js'));
    const rows14 = [...listBlock().querySelectorAll('[data-plan-row]')];
    const head14 = [...listBlock().children].find((c) => c.style && /display:flex/.test(String(c.style.cssText))
        && String(serialize(c)).includes('题名'));
    ok(!!head14, '（前提）找得到那张表的表头');
    // ① 表头与数据行的列宽**必须一致**（各写一份必然对不齐）；题名那列不再是 `flex:1`（吃满余下宽度）
    for (const r of rows14) {
        // ★ 列数 = `LIST_COLS` 的条数（用户 2026-10-15 加了「节点」那一列 ⇒ 7；
        //   ⚠️ 加列时**这个数要跟着改**，否则新那一列"表头与数据行对不对得齐"就没人管了）
        for (let i = 0; i < 7; i++) {
            const rowFlex = String(r.children[i].style.cssText).split(';').filter((s) => /^flex:/.test(s)).join(';');
            const headFlex = String(head14.children[i].style.cssText).split(';').filter((s) => /^flex:/.test(s)).join(';');
            eq(rowFlex, headFlex, `第 ${i + 1} 列的 flex 表头与数据行一致`);
        }
    }
    ok(/flex:0 1 320px/.test(String(rows14[0].children[1].style.cssText)),
        '★ 题名列最多 320px（不再是 `flex:1` —— 那会把后面几列推到最右）');
    // ★ 用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"：
    //   题名列**一个字不动**，**另加**第 7 列装现成的入口条（身份键 + 完整面包屑 + 📋）。
    {
        const nodeCell = rows14[0].children[6];
        ok(/flex:1 1 240px/.test(String(nodeCell.style.cssText)),
            '★ 新增的「节点」列是**唯一吃剩余宽度**的那一列（前六列各就各位）', nodeCell.style.cssText);
        ok(!!nodeCell.querySelector('.node-entry'),
            '★ 那一列装的就是现成的入口条（`ui/kit/nodeEntry.js:nodeEntryLine`，不是第 4 种实现）');
        ok(!!nodeCell.querySelector('.node-entry-id'), '★ 身份键在第一格');
        ok(!!nodeCell.querySelector('.node-entry-crumb[data-reveal-node]'),
            '★ 完整面包屑在，而且它自己就是 🔎（`data-reveal-node` 挂在它上面）');
        ok(!!nodeCell.querySelector('.btn-node-info'), '★ 📋 详页入口在');
    }
    // ★ 第 23~26 轮（用户反复："上面的强度还是没对齐"、"改淡色绝对是错的"）：
    //   定稿 = **数字那一格先摆**（定宽 54 + 右对齐 ⇒ 它的右端就是整格的右端），**说明原文跟在数字后面**
    //   ⇒ 那一行向左长出去，数字右端不受影响。列宽必须容下"54 + 4 + 说明 ≈70" ⇒ **132px**。
    // ⚠️ 真浏览器量过（`npm run measure:layout list`）：12 行（含没填难度那行）数字右端**全部 798**。
    {
        const cell23 = rows14[0].children[5];
        ok(/display:flex/.test(String(cell23.style.cssText)) && /align-items:baseline/.test(String(cell23.style.cssText)),
            '★ 强度格是 flex（数字与说明各自成格）');
        const num23 = cell23.children[0];
        ok(/flex:0 0 54px/.test(String(num23.style.cssText)) && /text-align:right/.test(String(num23.style.cssText)),
            '★ 数字那一格**排在最前** + 定宽 + 右对齐 ⇒ 右端一条竖线');
        ok(!/justify-content/.test(String(cell23.style.cssText)),
            '★ 不要 `justify-content`（数字在前就不需要靠右收；靠右收时说明会把数字往左推）');
        ok(/flex:0 0 132px/.test(String(head14.children[5].style.cssText)),
            '★ 「强度」列 132px（装得下"数字格 54 + 间隙 4 + 说明（没填难度）"）');
        // ★ 第 27 轮（用户："没改好！！"）：表头「强度」也要**压在数字上方** —— 它跟格子同形（两条轨道），
        //   标题那一格定宽 54 + 右对齐。⚠️ 只写 `text-align:right` 不行：表头那格会撑满整列。
        {
            const h = head14.children[5];
            ok(/display:grid/.test(String(h.style.cssText))
                && /grid-template-columns:54px 70px/.test(String(h.style.cssText)),
                '★ 表头「强度」是"两条轨道"的网格（与格子同形）');
            ok(/text-align:right/.test(String(h.children[0].style.cssText)),
                '★ 标题那一格右对齐 ⇒ 落在数字上方（真浏览器量过：两边右端都是 798px）');
        }
        const unfilled = rows14.find((r) => r.children[5].children.length === 2);
        if (unfilled) {
            const c = unfilled.children[5];
            ok(/^\s*0\s*$/.test(String(c.children[0].textContent || '')), '★ 数字那格只写 0');
            ok(/（没填难度）/.test(String(c.children[1].textContent || '')),
                '★ 说明**原文保留**「（没填难度）」（不许改淡、不许缩写）');
            ok(/没填难度/.test(String(c.title || '')), '★ 原因也写在 `title` 上（悬停能看）');
        }
    }
    // ② 难度文本用**难度自己的颜色**（唯一色表 `XCPC_COLORS`）；「未填写」没有颜色 ⇒ 保持灰
    for (const r of rows14) {
        const lv = String(r.children[2].textContent || '');
        const want = LV_COLORS[lv];
        const got = /color:([^;]+);/.exec(String(r.children[2].style.cssText));
        if (want) eq(got && got[1], want, `难度「${lv}」用 XCPC_COLORS 那个色`);
        else ok(!got, `难度「${lv}」不在色表里 ⇒ 不额外上色`);
    }
    // ③ ★ 第 16 轮（用户："xcpc难度的染色还漏了这个表的选择"）：**筛选芯片**（选择）里的档名也上色
    //    ⚠️ 别用 `[data-plan-filter^="list-levels:"]` 那种前缀选择器 —— 桩不解析（会空转地绿）
    const chipBox = (lv) => listBlock().querySelector(`[data-plan-filter="list-levels:${lv}"]`);
    for (const lv of ['银牌', 'C+', '未填写']) {
        const box = chipBox(lv);
        ok(!!box, `（前提）找得到「${lv}」那个芯片`);
        const label = box.parentNode;
        const chipText = label && label.children && label.children[1];
        const got = chipText ? /color:([^;]+);/.exec(String(chipText.style.cssText)) : null;
        const want = LV_COLORS[lv];
        if (want) eq(got && got[1], want, `芯片「${lv}」的文字用 XCPC_COLORS 那个色`);
        else ok(!got, `芯片「${lv}」（未填写）不在色表里 ⇒ 保持默认色`);
    }
}

// ① 筛选：按题名/题号关键字
const qInput = listBlock().querySelector('[data-plan-filter="list-q"]');
qInput.value = 'A题';
qInput.dispatchEvent({ type: 'change' });
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 1, '★ 关键字筛出 1 道');
ok(/A题/.test(textOf(blockOf('list'))), '剩下的就是 A题');

// ② 加上状态2（与关键字"与"起来）
const s2box = blockOf('list').querySelector('[data-plan-filter="list-status-2"]');
s2box.checked = true;
s2box.dispatchEvent({ type: 'change' });
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 0,
    '★ 关键字 + 状态2 两条"与"起来 ⇒ 0 道（A题不是"已提交未通过"）');
blockOf('list').querySelector('[data-plan-action="list-clear"]').click();
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 2, '★ 清筛选 ⇒ 两道都回来');
// ★ 那一栏叫「**列表筛选**」（`view.list`：只看这一屏，不动题集）—— 与计划设置里的「题集条件」分开命名
//   （用户 2026-10-14："'筛选'确实要先看看具体语义" ⇒ 语义清单见 `docs/ui-conventions.md` 第 19 节）
ok(/列表筛选：/.test(textOf(listBlock())), '★ 那一栏开头写着「列表筛选：」');
eq(blockOf('list').querySelector('[data-plan-action="list-clear"]').textContent, '✖ 清列表筛选',
    '★ 那颗按钮叫「清列表筛选」（不叫"清筛选" —— 后者会与计划侧的"题集条件"混）');

// ③ 可跳转：点一行 ⇒ 派发 REVEAL_NODE（带真实节点 id）
const seenReveal = [];
const onReveal = (e) => seenReveal.push(e.detail && e.detail.nodeId);
document.addEventListener(EVENTS.REVEAL_NODE, onReveal);
blockOf('list').querySelectorAll('[data-plan-row]')[0].click();
document.removeEventListener(EVENTS.REVEAL_NODE, onReveal);
eq(seenReveal.length, 1, '★ 点一行派发一次 REVEAL_NODE');
ok(['p1', 'p2'].includes(seenReveal[0]), `跳转带的是真实节点 id：${seenReveal[0]}`);

// ★ 行内那颗 📋（第 7 列里）**自己就是交互** ⇒ 点它不许再触发整行跳树
//   （否则一次点击 = "跳树 + 开详页"两件事；`src/features/AGENTS.md` 的 AutoImport 记过同一个坑）。
//   ⚠️ 这一下会真的开详页 ⇒ 放这条断言的**最后**。
{
    const seen2 = [];
    const onReveal2 = (e) => seen2.push(e.detail && e.detail.nodeId);
    document.addEventListener(EVENTS.REVEAL_NODE, onReveal2);
    blockOf('list').querySelectorAll('[data-plan-row]')[0].querySelector('.btn-node-info').click();
    document.removeEventListener(EVENTS.REVEAL_NODE, onReveal2);
    eq(seen2.length, 0, '★ 点行内的 📋 不派发 REVEAL_NODE（一次点击只做一件事）');
}

// ④ 可折叠（折叠态住视图态）
blockOf('list').querySelector('[data-plan-action="list-toggle"]').click();
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 0, '★ 收起 ⇒ 行都不画了');
const viewMod = await import(mod('core/model/viewState.js'));
eq(viewMod.planSectionViewOf(AppState, 'plan_1').list.open, false, '折叠态写进视图态');
const plansRefHere = AppState.plans;
eq(AppState.plans, plansRefHere, '⚠️ 折叠不动数据（折叠只动视图态）');
blockOf('list').querySelector('[data-plan-action="list-toggle"]').click();
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 2, '再点一下展开回来');

// ================================================================
group('第 1 轮改进 ③：状态 × 难度 = 统计页那一份渲染（点格子 ⇒ 筛列表）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const gridHost = blockOf('stats-grid');
ok(!!gridHost, '网格有自己的容器');
ok(!!gridHost.querySelector('.stats-status-grid'), '★ 用的就是统计页那个类名（`stats-status-grid`）');
ok(!!gridHost.querySelector('.ssg-cell'), '★ 格子是 `ssg-cell`（统计页同一套）');
ok(gridHost.querySelectorAll('[data-grid-level]').length > 0, '★ 格子带 `data-grid-level`（与统计页同一套测试钩子）');
ok(!!gridHost.querySelector('[data-grid-level="未填写"]'), '没填难度的题落在「未填写」列');
const headNames = [...gridHost.querySelectorAll('.ssg-head-level')].map((n) => n.textContent);
ok(headNames.includes('未填写'), `★ 列标题写出难度名（统计页靠柱子所以不写，这里必须写）：${headNames.join('/')}`);
const pickCell = [...gridHost.querySelectorAll('.ssg-cell')]
    .find((n) => n.dataset.gridLevel === '未填写' && n.dataset.gridStatus2 === '2');
ok(!!pickCell, '（前提）找到"未填写 × 已提交未通过"那一格');
pickCell.click();
await tick(30);

eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 1,
    '★ 点格子 ⇒ 下面列表筛成那一批（与统计页"点格子筛明细"同一个手感）');
ok(/B题/.test(textOf(blockOf('list'))), '筛出来的是 B题（未填写难度 + 已提交未通过）');

// ================================================================
group('第 1 轮改进 ④：每期完成情况可折叠 / 分页 / 范围筛选（日期带年份）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const per = () => blockOf('periods');
ok(!!per().querySelector('[data-plan-action="periods-toggle"]'), '有折叠按钮');
// ★ 第 2 轮：范围筛选换成**热力图那一套**（起止各 年/月/日 三个下拉 + 「确定」+「全部」）
ok(!!per().querySelector('[data-range="start-year"]'), '有「从·年」下拉');
ok(!!per().querySelector('[data-range="start-month"]'), '有「从·月」下拉');
ok(!!per().querySelector('[data-range="start-day"]'), '有「从·日」下拉');
ok(!!per().querySelector('[data-range="end-year"]'), '有「到·年」下拉');
ok(!!per().querySelector('[data-range="end-month"]'), '有「到·月」下拉');
ok(!!per().querySelector('[data-range="end-day"]'), '有「到·日」下拉');
ok(!!per().querySelector('[data-plan-action="periods-apply"]'), '有「确定」');
ok(!!per().querySelector('[data-plan-action="periods-reset"]'), '有「全部」');
ok(!per().querySelector('input[type="date"]'), '★ 不再用原生日期控件（改成热力图那种三级下拉）');
const years = (textOf(per()).match(/\d{4}[.\-/]\d{2}[.\-/]\d{2}/g) || []);
ok(years.length > 0, `★ 期标签里带年份：${years.slice(0, 3).join(', ')}`);
// 范围筛选（与热力图同一个意思：起 / 止 + 套用）
// ⚠️ 夹具里**只有一次 AC**（昨天）⇒ 期只有 1 个（"今天"那发是 WA，不产生 acTime）。
//    所以最有说服力的断言是"筛到今天 ⇒ 0 期"（空的那一段）。
const setDay = (which, key) => {
    const [y, m, d] = String(key).split('-');
    for (const [part, v] of [['year', Number(y)], ['month', Number(m)], ['day', Number(d)]]) {
        const sel = per().querySelector(`[data-range="${which}-${part}"]`);
        sel.value = String(v);
        sel.dispatchEvent({ type: 'change' });
    }
};
// ★ 第 13 轮（用户报的"**卡死在 2 条**"）：**区间一设，期表也跟着放宽**（以前只有两张图放宽 ⇒
//   计划刚建时把区间拉大到几个月，表还是只显示那 2 条）。判据 = 表里真画了几行。
const periodsBody = () => [...blockOf('periods').children].find((c) => c.dataset && c.dataset.planPeriodsTable);
const periodRows = () => {
    const body = periodsBody();
    return body ? (serialize(body).match(/data-plan-period="/g) || []).length : 0;
};
eq(periodRows(), 2, '（前提）没设区间时表里 2 行（计划开始 → 现在）');
const fromEl = per().querySelector('[data-range="start-year"]');
const toEl = per().querySelector('[data-range="end-year"]');
const yesterdayKey = yesterday().replace(/\./g, '-');
setDay('start', yesterdayKey);
setDay('end', yesterdayKey);
per().querySelector('[data-plan-action="periods-apply"]').click();
await tick(30);
ok(/按日，1 期/.test(textOf(blockOf('periods'))), '★ 确定「昨天→昨天」⇒ 1 期');
eq(periodRows(), 1, '★ **表**里也就那一行（区间对表也生效）');
// ★ 放宽到"计划开始之前"整段 ⇒ 表里就该有那么多天空期（这正是用户要的"别卡死"）
setDay('start', '2026-07-13');
setDay('end', '2026-07-15');
per().querySelector('[data-plan-action="periods-apply"]').click();
await tick(30);
ok(/按日，3 期/.test(textOf(blockOf('periods'))), '★ 区间拉到计划开始之前 ⇒ 3 期（不再被"计划开始"卡住）');
eq(periodRows(), 3, '★ 表里 3 行（空期也照排 —— 这就是"卡死在 2 条"的修法）');
// 范围**反了**（起 > 止）⇒ 0 期 + 一句人话
setDay('start', '2026-12-28');
setDay('end', '2026-07-13');
per().querySelector('[data-plan-action="periods-apply"]').click();
await tick(30);
ok(/按日，0 期/.test(textOf(blockOf('periods'))), '★ 起 > 止 ⇒ 0 期');
ok(/这一段里没有期/.test(textOf(blockOf('periods'))), '空的那一段给一句人话（不是空白）');
per().querySelector('[data-plan-action="periods-reset"]').click();
await tick(30);
ok(/按日，2 期/.test(textOf(blockOf('periods'))), '「全部」⇒ 又回到计划自己的范围（2 期）');
eq(periodRows(), 2, '表也回到 2 行');
// ★ 第 15 轮（用户："这里的表 放3列 就可以一次看30条了"）：一页 = **3 列 × 每列 `pageSize`(12) 条 = 36 条**
setDay('start', '2026-07-13');
setDay('end', '2026-08-31');                     // 50 天 ⇒ 50 期
per().querySelector('[data-plan-action="periods-apply"]').click();
await tick(30);
ok(/按日，50 期/.test(textOf(blockOf('periods'))), '★ 区间 50 天 ⇒ 50 期');
ok(/第 1 \/ 2 页（共 50 条）/.test(textOf(blockOf('periods'))), '★ 一页 36 条 ⇒ 50 期分 2 页');
eq(periodRows(), 36, '★ 头一页就画 36 行（改前只画 12 行 —— 一页翻 3 倍的信息）');
eq((serialize(periodsBody()).match(/<table/g) || []).length, 3, '★ 表按 **3 列**排（每列 12 行，列优先）');
// 列优先：DOM 里前 12 行是**时间上连续的**那一段（一列读到底再换下一列）
{
    const keys = [...serialize(periodsBody()).matchAll(/data-plan-period="([^"]+)"/g)].map((m) => m[1]);
    eq(keys.length, 36, '（前提）36 个期键都在');
    ok(keys[0] > keys[11] && keys[12] < keys[11], `★ 列优先：第 1 列是连续的一段（${keys[0]} … ${keys[11]}），第 2 列接着往下`);
}
per().querySelector('[data-plan-action="periods-reset"]').click();
await tick(30);
per().querySelector('[data-plan-action="periods-toggle"]').click();
await tick(20);
// ⚠️ 表体是**拼 `innerHTML`** 的、DOM 桩不解析 ⇒ `querySelector('table')` **恒为 null**（这条断言会空转地通过）。
//    改成按那个**真元素**钩子断言（表格是它的 `_html`）。
ok(!periodsBody(), '★ 收起 ⇒ 表不画了');
eq(viewMod.planSectionViewOf(AppState, 'plan_1').periods.open, false, '折叠态也进视图态');

// ================================================================
group('第 2 轮 ①：强度总账 = 已写/总训练强度 · 推荐 · 目标 + 预计完成日期');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const sum = () => blockOf('summary');
const stat = (hook) => {
    const node = sum().querySelector(`[data-plan-stat="${hook}"]`);
    return node ? textOf(node) : '';
};
ok(!!sum(), '有「💰 强度总账」那一块');
// 夹具：p1 = 银牌 8.5（赛时通过 ⇒ 做完）；p2 = 没填难度 ⇒ 强度 0（已提交未通过 ⇒ 没做完）
// 夹具：p1 通过率 9% ⇒ 按曲线插值（8% → 7.07、11% → 6.03；**指数段** ⇒ 9% ≈ 6.70）；
// ★ 第 12 轮（"未填写的不计入 ⇒ 强度为 0"）：p2 没填难度 ⇒ **强度 0**，于是"总"就等于"已写"、还差 0
eq(stat('done-intensity'), '6.7 / 6.7 强度', '★ 已写 / 总训练强度（p2 没填难度 ⇒ 不进分母）');
eq(stat('done-count'), '1 / 2 题', '题数也照实给（做完的定义写在旁边）');
eq(stat('goal-per-day'), '3 / 天', '★ 目标训练强度（计划填的是"每天 3"，折算到每天就是 3）');
eq(stat('recommend'), '—', '★ 没填结束时间 ⇒ 推荐强度算不出来（给 —，不给 0）');
ok(/结束时间/.test(textOf(sum())), '并说明"为什么算不出来"（缺结束时间）');
eq(stat('eta'), '2026.10.13'.replace(/2026\.10\.13/, todayDay()),
    '★ 还差 0 ⇒ 预计完成 = 今天');
ok(/计划开始到现在/.test(textOf(sum())), '★ 写明统计区间 = 计划开始到现在');

// 填上结束时间 ⇒ 推荐强度出来了（★ 第 12 轮：还差 0 ⇒ 推荐就是 0/天，而不是「—」）
const planNow = { ...AppState.plans.plan_1, end: addDaysForSmoke(todayDay(), 9) };
AppState.plans.plan_1 = planNow;
planPage2().renderPlanPanel({ id: 'plan-plan_1', planId: 'plan_1' });
const rec = stat('recommend');
ok(/\/ 天$/.test(rec), `★ 填了结束时间 ⇒ 推荐强度是"每天 X"，实际「${rec}」`);
eq(rec, '0 / 天', '★ 还差 0 ⇒ 推荐 0/天（"没填结束时间"才给「—」）');
ok(/恰好按时完成/.test(textOf(sum())), '并写清它的意思（"恰好按时完成"）');

// ================================================================
group('第 3 轮 ①：图表统一放大 2 倍（字与元素）');
// ================================================================
seed();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const lineSvg2 = textOf(blockOf('charts').querySelector('[data-plan-chart="line:body"]'));
ok(/height="280"/.test(lineSvg2), '★ 折线画布高 280（原 140 × 2）');
ok(/font-size="11"/.test(lineSvg2), '★ 轴上小字 11px —— **与块里那句灰字同大**（第 4 轮：不再跟着元素一起放大）');
ok(!!lineSvg2 && !/font-size="18"/.test(lineSvg2), '★ 图上再没有 18px 的字（元素大、字小）');
ok(/r="5"/.test(lineSvg2), '★ 数据点半径也放大（2.5 × 2）');
ok(/stroke-dasharray="8 6"/.test(lineSvg2), '★ 目标线虚线间隔也放大');
const barSvg2 = textOf(blockOf('charts').querySelector('[data-plan-chart="bar:body"]'));
ok(/height="280"/.test(barSvg2), '柱状图画布同样放大');
ok(/font-size="11"/.test(barSvg2), '柱状图轴上小字同样是 11px');
// 用户第 4 轮："日期要给换行" —— 一行的期标签（周 = `A~B`）在 `~` 处断成两行（`<tspan>`），
// 而且画布宽**按最长那一行**撑开（不撑开就必然挤成一团，实测那串糊在一起的日期就是这么来的）
ok(/<tspan/.test(barSvg2), '★ 周的期标签断成两行（`<tspan>`）');
// 画布宽**按最长那一行**撑开：拿 6 期（周粒度）直接调那个纯渲染函数看宽度
// （不撑开就必然挤成一团 —— 用户截图里那串糊在一起的日期就是这么来的）
const { planBarChartSvg } = await import(mod('ui/plan/planCharts.js'));
const manyWeeks = planBarChartSvg({
    points: Array.from({ length: 6 }, (_, i) => ({
        label: `2026.0${i + 1}.0${i + 1}~0${i + 2}.13`, value: 1, goal: 1, reached: true
    })),
    maxValue: 1
});
const manyW = Number((manyWeeks.match(/width="(\d+)"/) || [])[1] || 0);
ok(manyW > 6 * 100, `★ 六周的图按标签把画布撑到 ${manyW}px（每期 ≥100px ⇒ 日期不叠）`);

// ================================================================
group('第 3 轮 ②：每期完成情况**越新的越靠前**');
// ================================================================
const perText2 = textOf(blockOf('periods'));
const todayKey2 = todayDay();
const yKey2 = yesterday();
ok(perText2.indexOf(todayKey2) >= 0 && perText2.indexOf(yKey2) >= 0, '（前提）两期的标签都在表里');
ok(perText2.indexOf(todayKey2) < perText2.indexOf(yKey2), '★ 今天那一行排在昨天那行**前面**（越新越靠前）');

// ================================================================
group('第 3 轮 ③：当前强度表 —— 数值能看，也能一键去改');
// ================================================================
const it = () => blockOf('intensity');
ok(!!it(), '有「🏋️ 当前强度表」那一块');
ok(!it().querySelector('[data-intensity-ratio]'), '默认**收起**（它是"看一眼口径"的东西，不占地方）');
it().querySelector('[data-plan-action="intensity-toggle"]').click();
await tick(20);
// 第 5 轮起 XCPC 侧是**按通过率的控制点**（不再是 20 个档位的台阶）
const lvCells = [...blockOf('intensity').querySelectorAll('[data-intensity-ratio]')];
eq(lvCells.length, 22, '★ 展开后列出**全部 22 个通过率控制点**（20 个档位上限 + 拐点 + 到顶点）');
ok(!!blockOf('intensity').querySelector('[data-intensity-ratio="0.22"]'), '含「0.22%」（= C 那一档的分界点）');
// ★ 第 10 轮：去掉"≤"（这些点是曲线上的点，不是台阶）——旁注改成"档名 + 通过率"
ok(/C 0\.22%/.test(textOf(blockOf('intensity'))), '★ 每个点写「档名 + 通过率」（不再写"通过率 ≤ X"）');
ok(!/≤\s*0\.22/.test(textOf(blockOf('intensity'))), '★ 不再有"通过率 ≤ X"的说法');
ok(/0\.031%及更小/.test(textOf(blockOf('intensity'))), '★ 最难那一点写「0.031%及更小」（用户第 11 轮点名）');
ok(!/到顶/.test(textOf(blockOf('intensity'))), '★ "到顶"这个说法已经不用了');
ok(/银牌 11%/.test(textOf(blockOf('intensity'))), '中间的点也带档名');
// ★ 第 11 轮：表格**列优先**（一列读到底再换下一列）且**最多 3 列**（行优先会横铺成 9 列、折回来读）
const ratioGrid = blockOf('intensity').children
    .find((c) => c.querySelector && c.querySelector('[data-intensity-ratio]'));
ok(!!ratioGrid, '（前提）找得到那张通过率表');
// ★ 第 22 轮（用户："文本左对齐。" ⇒ 收口）：**一个列 = 一个网格**，列里所有"对"共用两条轨道
//   ⇒ 标签列宽 = 本列最长档名（档名左端对齐）+ 值列宽 = 本列最宽的值（值右端点对齐），对内恒 6px。
//   ⚠️ 上一版"每条对各一个网格"做不到值右端齐（每条对的标签列宽各按自己那条算）。
// ⚠️⚠️ **保命的一条**：`white-space:nowrap` 不许删 —— 窗口窄了宁可横向溢出，
//   也**不许**把档名逐字折行（第 18 轮就是这样把整张表糊成一竖条的，用户："xcpc难度也改得更坏了"）。
ok(/display:flex/.test(String(ratioGrid.style.cssText)), '★ 外层是 flex（3 个列 div 横排）');
ok(/gap:18px/.test(String(ratioGrid.style.cssText)), '★ 列与列之间 18px');
{
    const cols21 = [...ratioGrid.children].filter((c) => c.querySelector && c.querySelector('[data-intensity-ratio]'));
    eq(cols21.length, 3, '★ 3 个点列（列优先：22 个点 ⇒ 8+8+6）');
    eq(cols21[0].querySelectorAll('[data-intensity-ratio]').length, 8, '★ 第 1 列 8 条');
    eq(cols21[2].querySelectorAll('[data-intensity-ratio]').length, 6, '★ 第 3 列 6 条（列优先）');
    ok(/display:grid/.test(String(cols21[0].style.cssText))
        && /grid-template-columns:max-content max-content/.test(String(cols21[0].style.cssText)),
        '★ 每个列 div 是网格：两条轨道（标签列宽 = 本列最长档名 ⇒ 档名左端对齐）');
    ok(/grid-template-rows:repeat\(8,auto\)/.test(String(cols21[0].style.cssText)),
        '★ 8 行都在**同一个**网格里（列里所有对共用两条轨道）');
    ok(/justify-content:end/.test(String(cols21[0].style.cssText)),
        '★ 一对的左边紧贴值列（`justify-content:end`）：值列宽固定 ⇒ 档名与值之间恒 6px');
    ok(/max-width:max-content/.test(String(cols21[0].style.cssText)), '★ 列宽不撑满');
    ok(/white-space:nowrap/.test(String(cols21[0].style.cssText)),
        '★ `white-space:nowrap`（保命：别让档名逐字折行）');
    const cell21 = cols21[0].querySelector('[data-intensity-ratio]');
    const kids21 = cell21.children;
    eq(kids21.length, 2, '★ 每一对就是两格：档名 + 强度值');
    // ★ 第 24 轮（**真浏览器量出来的**）：`display:contents` 那对的子元素是 inline span，
    //   **`justify-self` 对它们不起作用**（量到"对内间隙"有 6~45px 好几种）⇒ 改用 `text-align`
    //   （span 默认 stretch 满轨道，左格左对齐、右格右对齐 ⇒ 间隙恒为轨道间那 6px）。
    ok(!/justify-self/.test(String(kids21[0].style.cssText))
        && !/justify-self/.test(String(kids21[1].style.cssText)),
        '★ 那两格**不许**再用 `justify-self`（对 inline span 无效 —— 真浏览器量过）');
    ok(/text-align:left/.test(String(kids21[0].style.cssText)), '★ 档名那格左对齐（用户："文本左对齐"）');
    ok(/text-align:right/.test(String(kids21[1].style.cssText)), '★ 值那格右对齐（"右端点对齐"）');
}
// ★ 数值侧：**保持用户认可的那一版**（用户："原来的数值难度很好,你怎么改了?"）
{
    const cfHtml17 = textOf(blockOf('intensity'));
    ok(/grid-template-columns:max-content max-content max-content/.test(cfHtml17),
        '★ 数值侧还是那个 `max-content` 三列网格（用户认可的版本，别动）');
    ok((cfHtml17.match(/data-intensity-cf=/g) || []).length === 9, '★ 数值侧 9 个控制点都在（一行一个）');
}
ok(!!blockOf('intensity').querySelector('[data-intensity-default]'), '★ 写着"没填难度的题强度记 0"（口径能看）');
// ⚠️ 这一栏走 `fmtAmount`（最多一位小数）⇒ 4000 那点显示成 `113.1`
// ★ 第 16 轮：数值难度那一半也要带 **CF 的色**（`getCfColor(4000)` = `#dc2626`）
// ⚠️ 色断言必须照**真实**样式串写：第 17 轮那对曾带 `text-align:right`、第 18 轮又撤掉了
//    （现在只剩 `color`）⇒ 每次改样式都要回来看一眼这条（写成样式里没有的形状 = 永远不匹配）。
ok(/color:#dc2626;/.test(textOf(blockOf('intensity'))) && textOf(blockOf('intensity')).includes('4000及以上</span> → '),
    '数值侧的控制点也列出来了（末点「4000及以上」⇒ 113.14 显示成 113.1；分值走 CF 色）');
ok(/按通过率/.test(textOf(blockOf('intensity'))), '★ 写明是按**通过率**查表（第 5 轮的口径）');
ok(!!blockOf('intensity').querySelector('[data-plan-action="intensity-edit"]'), '★ 有「⚙️ 去设置里编辑」（改的地方指得明明白白）');
ok(/内置默认/.test(textOf(blockOf('intensity'))), '没引用自定义表时写明"内置默认"');

// ================================================================
group('第 3 轮 ④：题目列表筛选"满血"（标签 / 平台 / 难度区间 / 排序 / 每页）');
// ================================================================
seed();
const val2 = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
AppState.nodes.p1.values = {
    ratio: val2('9'),
    // 数值难度那一维读的是 `fieldRegistry.difficultyValueOf`（老包无注册表 ⇒ 兜底 `cfDifficulty`），
    // **不是** `ratio`（ratio 只用来分 XCPC 档）⇒ 要测"难度区间"就得给它一个数值难度。
    cfDifficulty: val2('1800'),
    // ⚠️ `tags` 是**列表型**字段：`v` 本身是字符串数组，但**外面仍要包一层来源条目**
    //    （`usableValues` 会把非对象条目整条跳过 ⇒ 直接写 `['dp']` 读出来永远是空数组）。
    tags: [{ v: ['dp'], src: 'manual', at: 'T', account: '' }],
    natureClass: val2('cf/gyms')
};
// B题（p2）这一组里改成**今天 AC**：否则"按 AC 时间排序"两个方向都只剩 A题一个候选，
// 断言分不出"排序生效"还是"只有一条"（种子里 p2 是 WA ⇒ 没有 acTime）。
AppState.nodes.r2.values = { status: val2('AC'), submitKind: val2('赛时'), time: val2(`${todayDay()} 11:00:00`) };
// ⚠️ 上面是**同引用原地改夹具** ⇒ 派生表（status2/acTime）的记忆化不会自己失效，必须显式丢掉重算。
//    （`tags`/`cfDifficulty` 那种来源层字段直接读 state，没这个问题；派生值有。）
const { clearDerivedMemo } = await import(mod('core/derive.js'));
clearDerivedMemo();
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const listBlock2 = () => blockOf('list');
ok(!!listBlock2().querySelector('[data-plan-filter="list-cf-min"]'), '有数值难度下限');
ok(!!listBlock2().querySelector('[data-plan-filter="list-cf-max"]'), '有数值难度上限');
ok(!!listBlock2().querySelector('[data-plan-filter="list-tags:dp"]'), '★ 标签芯片（名单从题集里收）');
ok(!!listBlock2().querySelector('[data-plan-filter="list-platforms:cf"]'), '★ 平台芯片（取 natureClass 第一段）');
ok(!!listBlock2().querySelector('[data-plan-filter="list-sort"]'), '有排序');
ok(!!listBlock2().querySelector('[data-plan-filter="list-page-size"]'), '有每页条数');
// ★ 第 11 轮（用户："默认每页10"）：默认那一档必须是 10，而且**下拉里要有它**（否则会选不中、显示空白）
const sizeSel2 = listBlock2().querySelector('[data-plan-filter="list-page-size"]');
eq(sizeSel2.value, '10', '★ 默认每页 10');
ok(sizeSel2.children.some((o) => String(o.value) === '10'), '★ 下拉里有「每页 10」这一档');
const viewMod2 = await import(mod('core/model/viewState.js'));
eq(viewMod2.planSectionViewOf(AppState, 'plan_1').list.pageSize, 10, '默认值住在视图态的那一份里');

// 标签筛：只留带 dp 的（p1）
const tagBox = listBlock2().querySelector('[data-plan-filter="list-tags:dp"]');
tagBox.checked = true;
tagBox.dispatchEvent({ type: 'change' });
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 1, '★ 只勾「dp」⇒ 只剩带那个标签的一道');
ok(/A题/.test(textOf(blockOf('list'))), '剩下的正是 A题');
blockOf('list').querySelector('[data-plan-action="list-clear"]').click();
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 2, '清筛选 ⇒ 两道回来');

// 数值区间：设了区间 ⇒ **没填难度**的那道被排除
const cfMin2 = blockOf('list').querySelector('[data-plan-filter="list-cf-min"]');
cfMin2.value = '1000';
cfMin2.dispatchEvent({ type: 'change' });
await tick(20);
eq(blockOf('list').querySelectorAll('[data-plan-row]').length, 1,
    '★ 填了"难度≥1000" ⇒ 没填难度的 B题被排除（与挑题弹窗同一份判据）');
blockOf('list').querySelector('[data-plan-action="list-clear"]').click();
await tick(20);

// 排序：按 AC 时间倒序 ⇒ 第一行是今天那发（p2），正序 ⇒ 第一行是昨天那发（p1）
const sortSel2 = blockOf('list').querySelector('[data-plan-filter="list-sort"]');
sortSel2.value = 'ac-desc';
sortSel2.dispatchEvent({ type: 'change' });
await tick(20);
const firstRow = () => (blockOf('list').querySelectorAll('[data-plan-row]')[0] || {}).dataset?.planRow;
eq(firstRow(), 'p2', '★ 排序「AC 时间：新 → 旧」⇒ 第一行是今天那发');
blockOf('list').querySelector('[data-plan-filter="list-sort"]').value = 'ac-asc';
blockOf('list').querySelector('[data-plan-filter="list-sort"]').dispatchEvent({ type: 'change' });
await tick(20);
eq(firstRow(), 'p1', '★ 反序 ⇒ 第一行是昨天那发（排序真的生效）');

// 「没有那种值」的条目**两个方向都垫底**（这是仓里既有排序器 `sortRecords` 的 `isBlank` 口径，
// 不是本页自己定的）——⚠️ 派生的 `acTime` 取不到时是**占位符**（`----.--.-- --:--`，不是空串），
// 拿字符串比它天然最小 ⇒ 不显式声明 isBlank 的话，「旧→新」会把它顶到最前（v9.1.36 实测踩过）。
const { sortEntries } = await import(mod('ui/plan/planBlocks.js'));
const blankFirst = [
    { id: 'noAc', time: '----.--.-- --:--', intensity: 1, level: '未填写' },
    { id: 'hasAc', time: `${yesterday()} 10:00:00`, intensity: 3, level: '铜牌' }
];
eq(sortEntries(blankFirst, 'ac-desc').map((e) => e.id).join(','), 'hasAc,noAc',
    '★「AC 时间：新→旧」⇒ 没有 AC 的垫底');
eq(sortEntries(blankFirst, 'ac-asc').map((e) => e.id).join(','), 'hasAc,noAc',
    '★「AC 时间：旧→新」⇒ 没有 AC 的**也**垫底（isBlank 两个方向都垫底）');
eq(sortEntries(blankFirst, 'level-asc').map((e) => e.id).join(','), 'hasAc,noAc',
    '★ 难度排序同理：没填难度的垫底');

// ================================================================
group('第 4 轮 ①：外侧栏的期也是**新 → 旧**');
// ================================================================
seed();
AppState.currentPageId = 'page_1';       // 计划栏只在绑定的副页上出现
planBar.renderPlanBar();
const barText = textOf(document.getElementById('plan-bar'));
ok(barText.indexOf(todayDay()) < 0 || barText.indexOf(todayDay()) < barText.indexOf(yesterday()),
    '★ 外侧明细表里，"今天/更新"那一行排在旧的上面（期序 = 新 → 旧）');
// ⚠️ 这条断言依赖两期都在表里（种子：昨天那次 AC + 那一期的占位）
ok(barText.indexOf(yesterday()) >= 0, '（前提）旧的那一期也在表里');
// 直接对"期序"这条规则本身下断言（表里两行谁前谁后 + 它**不许就地改入参**）
const { periodsNewestFirst } = await import(mod('core/trainingPlan.js'));
const three = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
eq(periodsNewestFirst(three).map((p) => p.key).join(','), 'c,b,a', '★ 期序规则：新 → 旧');
eq(three.map((p) => p.key).join(','), 'a,b,c', '★ 它**不改入参**（图还要按时间正序画，同一个 progress 对象两边共用）');

// ================================================================
group('第 4 轮 ②：XCPC 难度可勾选（多选芯片）+ 数值难度一行');
// ================================================================
// ⚠️ 桩不支持 `[attr^="..."]` 这种前缀选择器（`querySelectorAll` 只认精确的 `[attr="v"]` / 标签）
//    ⇒ 按 dataset 自己过一遍（这也是仓里那三条"别指望桩解析选择器"的教训之一）
const lvChips = () => [...blockOf('list').querySelectorAll('input')]
    .filter((b) => String(b.dataset.planFilter || '').startsWith('list-levels:'));
ok(lvChips().length >= 21, `★ XCPC 一行是**多选**芯片（${lvChips().length} 个 ≥ 20 档 + 「未填写」）`);
eq(lvChips()[0].dataset.planFilter, 'list-levels:签到', '★ 顺序 = **易 → 难**（用户第 5 轮："应该全都易→难"）：第一个是签到');
eq(lvChips()[lvChips().length - 1].dataset.planFilter, 'list-levels:未填写', '末了跟哨兵「未填写」');
const grayOf = (text) => {
    const row = [...blockOf('list').children].find((r) => textOf(r).startsWith(text));
    return row && row.querySelector('span') && row.querySelector('span').style.cssText;
};
ok(String(grayOf('XCPC 难度')).includes('color:#94a3b8'), '★ 前缀是灰文本（与标签/平台那两行同形）');
ok(String(grayOf('数值难度')).includes('color:#94a3b8'), '★ 数值难度一行也是灰前缀');
ok(!!blockOf('list').querySelector('[data-plan-filter="list-cf-min"]')
    && !!blockOf('list').querySelector('[data-plan-filter="list-cf-max"]'), '★ 那一行后面就是难度范围');
ok(!blockOf('list').querySelector('[data-plan-filter="list-level"]'), '★ 旧的单选下拉已经没了');

// ================================================================
group('第 4 轮 ⑤：不再提醒"没有 AC 时间"');
// ================================================================
ok(barText.indexOf('没有 AC 时间') < 0, '★ 外侧栏不再报"N 道题没有 AC 时间，不进任何一期"');
ok(textOf(page()).indexOf('没有 AC 时间') < 0, '★ 内层页也不再报（同一份口径）');
ok(barText.indexOf('没填难度') >= 0, '⚠️ 但"没填难度按默认强度计"那条**保留**（那是要提醒的）');

// ================================================================
group('第 4 轮 ③：图块里的小按钮压扁一半（用户："收起按钮垂直大小应减半"）');
// ================================================================
const tg = blockOf('charts').querySelector('[data-plan-chart="line:toggle"]');
ok(!!tg, '（前提）找得到那张图的折叠按钮');
ok(String(tg.style.cssText).includes('padding:0 10px'), '★ 折叠按钮压扁了（不再用全站 `.btn` 的 6px 上下留白）');
ok(!String(tg.style.cssText).includes('padding:6px'), '★ 也没退回去用全站按钮那套 padding');
ok(String(tg.style.cssText).includes('font-size:11px'), '★ 按钮上的字与块里那句灰说明同大（11px）');
const sw = blockOf('charts').querySelector('[data-plan-chart="swap"]');
ok(!!sw && String(sw.style.cssText).includes('padding:0 10px'), '★ 「⇅ 换序」那颗同样压扁（同一份写法）');

// ================================================================
group('第 5 轮 ①：档位顺序一律**易 → 难**（用户："应该全都易→难"）');
// ================================================================
seed();
AppState.currentPageId = 'page_1';
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const gCells = [...blockOf('stats').querySelectorAll('[data-grid-level]')];
ok(gCells.length > 0, '（前提）网格有难度列');
// 列序 = `XCPC_ORDER`（易 → 难，与统计页同一套）；「未填写」殿后
// ⚠️ 每行都会画一遍同样的列 ⇒ 先去重（`Set` 保留插入序），别直接对整串比
const { XCPC_ORDER: ORDER5, XCPC_UNFILLED: UNFILLED5 } = await import(mod('utils/color.js'));
const rankOf = (lv) => (lv === UNFILLED5 ? ORDER5.length : ORDER5.indexOf(lv));
const colSeq = [...new Set(gCells.map((c) => c.dataset.gridLevel))];
ok(colSeq.length > 0 && colSeq.every((lv, i) => i === 0 || rankOf(lv) >= rankOf(colSeq[i - 1])),
    `★ 网格列序 = XCPC_ORDER（易 → 难，与统计页同一套）；实际 ${colSeq.join(' | ')}`);
blockOf('intensity').querySelector('[data-plan-action="intensity-toggle"]').click();
await tick(20);
const pts = [...blockOf('intensity').querySelectorAll('[data-intensity-ratio]')];
eq(pts.length, 22, '（前提）强度表的 22 个控制点都在');
eq(pts[0].dataset.intensityRatio, '100', '★ 强度控制点也从易到难：第一个是「100% → 1.3」');
eq(pts[pts.length - 1].dataset.intensityRatio, '0.03125', '最后一个是「到顶」那一点（0.03125% → 113.1）');
eq(pts[pts.length - 2].dataset.intensityRatio, '0.11', '倒数第二个才是 C+ 那一档（0.11% → 60.3）');

// ================================================================
group('第 5 轮 ②：「每期完成情况」= 一整块（表 + 两张图），**区间对整块生效**');
// ================================================================
seed();
AppState.currentPageId = 'page_1';
tabs.setupTabs();
tabs.openPlanTab('plan_1');
const perBlock = () => blockOf('periods');
ok(/每期完成情况/.test(textOf(perBlock())), '★ 这一整块有名字（"每期完成情况"）');
ok(!!perBlock().querySelector('[data-plan-block="charts"]'),
    '★ 两张图就在**这一块里面**（不再是与它并列的另一块）');
const phases = (txt) => (txt.match(/(\d+) 期 · 单位/g) || []).map((s) => Number(s.split(' ')[0]));
const beforePhases = phases(textOf(perBlock()));
ok(beforePhases.length === 2, `（前提）两张图各报一次期数（实际 ${beforePhases.join(',')}）`);
ok(beforePhases.includes(2), `★ 没卡区间时按**计划自己的范围**排期（日粒度 2 期，实际 ${beforePhases.join(',')}）`);
// 卡成"昨天→昨天"
const setDay5 = (which, key) => {
    const [y, m, d] = String(key).split('-');
    for (const [part, v] of [['year', Number(y)], ['month', Number(m)], ['day', Number(d)]]) {
        const sel = perBlock().querySelector(`[data-range="${which}-${part}"]`);
        sel.value = String(v);
        sel.dispatchEvent({ type: 'change' });
    }
};
const yKey5 = yesterday().replace(/\./g, '-');
setDay5('start', yKey5);
setDay5('end', yKey5);
perBlock().querySelector('[data-plan-action="periods-apply"]').click();
await tick(30);
const afterPhases = phases(textOf(perBlock()));
ok(afterPhases.length === 2 && afterPhases.every((n) => n === 1),
    `★ 卡到一天之后，**两张图**的期数都跟着缩到 1（改前只卡表、图还是 ${beforePhases.join(',')}；现在 ${afterPhases.join(',')}）`);
ok(!/2 期 · 单位/.test(textOf(perBlock())), '★ 图上不再有"2 期"那种没被区间卡住的说法');
perBlock().querySelector('[data-plan-action="periods-reset"]').click();
await tick(30);
eq(phases(textOf(perBlock())).join(','), beforePhases.join(','), '「全部」⇒ 两张图也回到原来的期数');

// ================================================================
group('第 6 轮：图里每项显示数值 + 悬停有信息 + **点一下列出这一期的题**');
// ================================================================
// ① 数值与 tooltip：直接拿那两份纯渲染函数看（桩不解析 innerHTML，只能按字符串断言）
const { planBarChartSvg: barSvg6, planLineChartSvg: lineSvg6 } = await import(mod('ui/plan/planCharts.js'));
const series6 = {
    unit: '强度', maxValue: 30, maxCumulative: 30,
    points: [
        { key: '2026.09.18', label: '2026.09.18', value: 0, cumulative: 0, goal: 30, goalCumulative: 30, reached: false, count: 0 },
        { key: '2026.09.19', label: '2026.09.19', value: 12.5, cumulative: 12.5, goal: 30, goalCumulative: 60, reached: false, count: 3 },
        { key: '2026.09.20', label: '2026.09.20', value: 30, cumulative: 42.5, goal: 30, goalCumulative: 90, reached: true, count: 9 }
    ]
};
const bar6 = barSvg6(series6, { pick: '2026.09.20' });
ok(/>12\.5</.test(bar6) && />30</.test(bar6), '★ 每根柱子顶上写着**数值**（第 6 轮："图表的每项应该显示数值"）');
ok(/<title>/.test(bar6) && /本期完成 12\.5 强度（目标 30）/.test(bar6) && /完成 3 题/.test(bar6),
    '★ 每根柱子带悬停信息（期 / 本期完成 / 目标 / 题数 / 是否达标 / 点一下能干什么）');
ok(/没达标/.test(bar6) && /✅ 达标/.test(bar6), '悬停里如实写达标与否');
ok(/data-plan-period="2026.09.19"/.test(bar6), '★ 每根柱子带 `data-plan-period`（点击就是靠它认出点的是哪一期）');
ok(/stroke="#1d4ed8"/.test(bar6), '★ 选中的那一根有高亮描边');
const line6 = lineSvg6(series6, { pick: '' });
ok(/<title>/.test(line6) && /累计完成 12\.5 强度（目标线 60）/.test(line6), '★ 折线的点也有悬停信息（累计口径）');
ok(/>42\.5</.test(line6), '★ 折线的点上也标数值');
ok(/data-plan-period="2026.09.20"/.test(line6), '折线的点同样带期键');

// ② 点一下 ⇒ 下面列出这一期做了哪些题（**走真实那条委托**：容器上一条，表与图共用）
const perCard = perBlock();
const pbBefore = perCard.querySelector('[data-plan-block="period-problems"]');
ok(!!pbBefore, '这一块里备着「这一期做了哪些题」的位置');
eq(pbBefore.querySelectorAll('[data-plan-row]').length, 0, '（前提）没选期时它不列题');
const yKey6 = yesterday();                       // 期键就是 `YYYY.MM.DD`
const fake = document.createElement('rect');      // 装作"点到了图里那一根"
fake.dataset.planPeriod = yKey6;
perCard.dispatchEvent({ type: 'click', target: fake });
await tick(30);
eq(String((AppState.view.planSections.plan_1 || {}).periods && AppState.view.planSections.plan_1.periods.pick), yKey6,
    '★ 点图里那一根 ⇒ 视图态记下这一期');
const pbAfter = perBlock().querySelector('[data-plan-block="period-problems"]');
eq(pbAfter.querySelectorAll('[data-plan-row]').length, 1, '★ 下面列出那一期**做完**的题（这里 1 道）');
ok(/A题/.test(textOf(pbAfter)), '列出来的正是那一期 AC 的那道题');
ok(/点某一行跳到树上/.test(textOf(pbAfter)), '如实写明点一行会跳树（与题目列表同一套行）');
// 表格那一行也带同一个期键（同一条委托 ⇒ 表和图点的是同一个东西）
// ⚠️ 表体是**拼 innerHTML** 的（桩不解析）⇒ 只能按字符串断言它带上了那个属性（真浏览器里点得到）
const tableHtml = textOf(perCard.querySelector('[data-plan-periods-table]'));
ok(tableHtml.includes(`data-plan-period="${yKey6}"`), '★ 表格的每一行也带 `data-plan-period`（表与图共用同一条点击委托）');
ok(tableHtml.includes('title="点一下看这一期做了哪些题"'), '表行上也写了"点一下能干什么"');
perBlock().querySelector('[data-plan-action="period-pick-clear"]').click();
await tick(30);
eq(perBlock().querySelector('[data-plan-block="period-problems"]').querySelectorAll('[data-plan-row]').length, 0,
    '「✖ 收起」⇒ 那一列题收起来');
report();

/** 冒烟里的 `YYYY.MM.DD` 加天数（不引 core，保持这份冒烟自足） */
function addDaysForSmoke(key, n) {
    const [y, m, d] = String(key).split('.').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
    const p = (v) => String(v).padStart(2, '0');
    return `${t.getUTCFullYear()}.${p(t.getUTCMonth() + 1)}.${p(t.getUTCDate())}`;
}
/** 计划页模块（总账那块要重画一次才看得到新值） */
function planPage2() { return planPage; }