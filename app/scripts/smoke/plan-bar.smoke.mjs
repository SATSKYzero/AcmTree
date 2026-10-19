// ================================================================
// 冒烟测试：训练计划条（scripts/smoke/plan-bar.smoke.mjs）
//
// 钉的是设计稿 `docs/training-plan.md` 的 ⑤⑥⑩⑬⑰ 那几条里**界面这一半**：
//   · 位置（在总览统计与树之间 —— 由 `applyTreeLayout` 画）与"没有计划时的空态"；
//   · 一条计划的**这一行摘要数字**（期 / 实际 / 目标 / 累计）对不对；
//   · **两处折叠**（整条栏 + 每个计划一行）真的收放，且**折叠态只进视图态**；
//   · 明细里的**两条警告**（⑰ 没填难度按默认强度算 / 没 AC 时间不进期）；
//   · 「去题单页」真的派发 `EVENTS.SWITCH_PAGE`。
//
// ⚠️ 这条栏是**真元素**画的（`ui/plan/planBar.js` 的注释里写了为什么：DOM 桩不解析 innerHTML）
//    ⇒ 这里能直接 `querySelector` + 派发点击，不必只按字符串断言。
// ⚠️ 但**明细那一段**（表格 + 提示行）是拼 `innerHTML` 的 ⇒ 那部分只能 `serialize()` 后按字符串断言。
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
for (const id of ['tree-container', 'tree-body', 'tree-stats', 'tree-root-info-container',
    'mode-action-btn-container', 'plan-bar', 'toast']) {
    makeContainer(app, id);
}
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const planBar = await import(mod('ui/plan/planBar.js'));
const { applyTreeLayout } = await import(mod('ui/folder/folderShared.js'));
const viewState = await import(mod('core/model/viewState.js'));

const bar = () => document.getElementById('plan-bar');
const btn = (cls) => bar().querySelector('.' + cls);
const rowOf = (id) => bar().querySelector(`.plan-row[data-plan="${id}"]`);

/** 一个副页（引用 p1/p2）+ 两条计划（一条强度/日、一条题数/周） */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.currentTab = 'main';
    AppState.settings.trainingIntensityTables = [];
    // ⚠️ `status2` / `acTime` 是**派生值** —— `viewDerivedDisplay` 在**没有派生表**时给的是占位符
    //    （`0` / `----.--.-- --:--`），**不会**回落成 `undefined` ⇒ 不跑派生表的话夹具永远是"没通过"。
    //    ⇒ 这里照**真路**来：P 下挂 R，让派生表自己算出来（与 `ignored-submission.smoke.mjs` 同一姿态）。
    const val = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', problemId: 'A', values: {} },
        p2: { id: 'p2', type: 'P', name: 'B题', problemId: 'B', values: {} },
        r1: { id: 'r1', type: 'R', values: { status: val('AC'), submitKind: val('赛时'), time: val(`${todayDay()} 10:00:00`) } },
        r2: { id: 'r2', type: 'R', values: { status: val('WA'), submitKind: val('赛时'), time: val(`${todayDay()} 11:00:00`) } }
    };
    AppState.childOrder = { root: ['p1', 'p2'], p1: ['r1'], p2: ['r2'], r1: [], r2: [] };
    AppState.parentOf = { p1: 'root', p2: 'root', r1: 'p1', r2: 'p2' };
    AppState.rootId = 'root';
    AppState.pages = {
        page_1: {
            id: 'page_1', name: '题单', rootId: 'v_root',
            virtualIndex: {
                v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['v1', 'v2'] },
                v1: { id: 'v1', refId: 'p1', type: 'P', parentId: 'v_root', children: [] },
                v2: { id: 'v2', refId: 'p2', type: 'P', parentId: 'v_root', children: [] }
            }
        },
        // ★ **一对一**（用户 2026-10-15）：一个副页一份计划 ⇒ 夹具也是"一页一条"
        //   （老夹具把两条计划都绑在 page_1 上，那是"多对一"时代的形态）
        page_2: {
            id: 'page_2', name: '另一个题单', rootId: 'v_root2',
            virtualIndex: {
                v_root2: { id: 'v_root2', refId: null, type: 'O', parentId: null, children: ['v3', 'v4'] },
                v3: { id: 'v3', refId: 'p1', type: 'P', parentId: 'v_root2', children: [] },
                v4: { id: 'v4', refId: 'p2', type: 'P', parentId: 'v_root2', children: [] }
            }
        }
    };

    AppState.plans = {
        plan_1: {
            id: 'plan_1', name: '每日补题', pageId: 'page_1',
            start: todayDay(), end: '', goal: { mode: 'intensity', per: 'day', value: 3 },
            statuses: [3, 4], intensitySource: 'xcpc', intensityTableId: ''
        },
        plan_2: {
            id: 'plan_2', name: '每周两道', pageId: 'page_2',
            start: todayDay(), end: '', goal: { mode: 'count', per: 'week', value: 2 },
            statuses: [3, 4], intensitySource: 'xcpc', intensityTableId: ''
        }
    };
    AppState.view = { expanded: {}, pages: {} };
    // ★ 这条栏现在**只在计划绑的那个副页上显示**（主页一律不显示）⇒ 夹具停在那个副页
    AppState.currentPageId = 'page_1';
}

/** 今天的 `YYYY.MM.DD`（与 `utils/time.js` 同一种写法） */
function todayDay() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

// ================================================================
group('计划条：位置 / 空态 / 真元素可点');
// ================================================================
seed();
AppState.plans = {};
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(!!bar(), '槽位 `#plan-bar` 在（`index.html` 里紧跟在统计那一行下面）');
ok(bar().style.display !== 'none', '树模式下这条栏显示');
eq(serialize(bar().querySelector('.plan-bar-title')), '📅 训练计划',
    '标题**不带条数**了（一对一下那个数恒为 0/1，是噪声 —— 用户 2026-10-15）');
ok(/还没有计划/.test(serialize(bar().querySelector('.plan-bar-empty'))), '空态给一句人话（不是空白栏）');
ok(!btn('plan-bar-add'), '★ **没有「＋ 新建计划」了**（一对一模型：计划是副页的一部分，不增删）');

applyTreeLayout({ statsContent: '统计', showStatsRow: false, showActionBtn: true, rootInfo: null });
eq(bar().style.display, 'none', '统计那一行不显示时（文件夹模式）这条栏也收起');
eq(serialize(bar()), '', '收起时连内容都清掉（不留下看不见的旧数字）');

// ================================================================
group('计划条：一行摘要 = 期 / 实际 / 目标 / 累计（数字来自 planProgressOf）');
// ================================================================
seed();
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(bar().querySelectorAll('.plan-row').length, 1, '★ **一对一**：这个副页就它那一份计划（一行）');
const r1 = rowOf('plan_1');
ok(!!r1, '第一条有自己的行（`data-plan`）');
ok(!r1.querySelector('.plan-del'), '★ 行上**没有「✖ 删除」**了（计划不增删：删计划 = 删副页）');
eq(serialize(r1.querySelector('.plan-name')), '📄 每日补题', '名字前面有 📄');
const sum1 = serialize(r1.querySelector('.plan-summary'));
// ★ 第 12 轮（"未填写的不计入 ⇒ 强度为 0"）：夹具里两道题**都没填难度** ⇒ 强度那一侧是 0
//   （题数那一条口径照样算 —— `plan_2` 是"每周 2 题"，下面钉的就是它）
ok(sum1.includes('0/3 强度'), `★ 强度那半句是 0/3（没填难度 ⇒ 强度 0，只有题数算）：${sum1}`);
ok(sum1.includes('强度'), '单位是「强度」');
ok(sum1.includes('累计'), '还带一句累计');

// 明细（innerHTML 拼的那段）里：题集条数与两条口径提示
const detail = serialize(r1.querySelector('.plan-row-body'));
ok(/plan-periods/.test(detail), '明细里有"每期"那张表');
ok(/题集 2 题/.test(detail), '写出题集题数（去重后的）');
ok(/目标口径：训练强度/.test(detail), '写明目标口径');
ok(/强度源 xcpc/.test(detail), '写明强度源（换表换源时一眼看得出）');

// plan_2 是"每周 2 题"：同一天里 p1 做完 ⇒ 1/2 —— ⚠️ 它绑的是 page_2，**切过去**才看得到（一对一）
AppState.currentPageId = 'page_2';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(!!rowOf('plan_2') && !rowOf('plan_1'), '★ 切到 page_2 ⇒ 显示的是它自己那一份');
const sum2 = serialize(rowOf('plan_2').querySelector('.plan-summary'));
ok(sum2.includes('1/2'), `题数口径按周折算目标 2：${sum2}`);
ok(sum2.includes('题'), '单位是"题"');

// ================================================================
group('计划条：两条警告（⑰ 没填难度 / 没 AC 时间不进期）');
// ================================================================
seed();
// 夹具里两道题都**没填难度** ⇒ 第 12 轮起**强度记 0**（用户："未填写的不计入 因为有热身赛等"）。
// ⚠️ "没有 AC 时间"那条**第 4 轮起不再报**（用户："没 AC 很正常，不用提醒"）—— 现在钉的是"它不出现"。
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
// ⚠️ 明细那一整段是**拼 innerHTML** 的（DOM 桩不解析）⇒ 只能 serialize 后按字符串找
const warn = serialize(rowOf('plan_1').querySelector('.plan-row-body'));
ok(/没填难度/.test(warn), `警告"没填难度"仍在（第 12 轮起措辞是"不计入强度"）：${warn}`);
ok(/不计入强度/.test(warn), '★ 措辞是"不计入强度"（不再是"按默认强度计"）');
ok(!/按默认强度计/.test(warn), '★ 不再说"按默认强度计"（那个数已经不存在了）');
ok(!/没有 AC 时间/.test(warn), '★ 不再提"没有 AC 时间不进任何一期"（用户第 4 轮）');

// ================================================================
group('计划条：两处折叠（⑥）—— 收放真的生效，且折叠态只进视图态');
// ================================================================
seed();
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
const plansRefBefore = AppState.plans;
const nodesRefBefore = AppState.nodes;

// ① 每个计划那一行
ok(!!rowOf('plan_1').querySelector('.plan-row-body'), '默认展开（有明细）');
rowOf('plan_1').querySelector('.plan-row-toggle').click();
ok(!rowOf('plan_1').querySelector('.plan-row-body'), '点一下 ⇒ 明细收起');
// ★ 一对一：这一页就它一份 ⇒ 原来那句"别的行不受影响"改成"**切到别的副页**那条没跟着收"
//   （折叠态是按**计划 id** 记的，不串）
AppState.currentPageId = 'page_2';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(!!rowOf('plan_2').querySelector('.plan-row-body'), '★ 收的是那一条：切页后另一份计划照旧展开');
AppState.currentPageId = 'page_1';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(viewState.isPlanCollapsed(AppState, 'plan_1'), '折叠态写进了视图态');
eq(AppState.plans, plansRefBefore, '⚠️ **数据一个字没动**（`state.plans` 引用都没换）');
eq(AppState.nodes, nodesRefBefore, '⚠️ `nodes` 更没动（落了会整片作废按代缓存）');
rowOf('plan_1').querySelector('.plan-row-toggle').click();
ok(!!rowOf('plan_1').querySelector('.plan-row-body'), '再点一下 ⇒ 展开回来');

// ② 整条栏
btn('plan-bar-toggle').click();
eq(bar().querySelectorAll('.plan-row').length, 0, '整条栏收起 ⇒ 一行都不画');
ok(!!bar().querySelector('.plan-bar-title'), '但标题行还在（看得出收起的是哪条栏、有几条计划）');
ok(viewState.isPlanBarCollapsed(AppState), '整条栏的折叠态也写进视图态');
btn('plan-bar-toggle').click();
eq(bar().querySelectorAll('.plan-row').length, 1, '展开回来（一对一：还是那一行）');

// ================================================================
group('第 1 轮改进 ①：这条栏**只属于计划绑的那个副页**（主页完全不显示）');
// ================================================================
seed();
// ① 主页 ⇒ 整条栏不显示（用户 2026-10-13："主页完全与这个功能无关"）
AppState.currentPageId = 'main';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(bar().style.display, 'none', '★ 主页上这条栏**不显示**');
eq(serialize(bar()), '', '而且内容也清干净（不留看不见的旧数字）');

// ② 回到它绑的那个副页 ⇒ 又出现，且只列**它自己那一份**
AppState.currentPageId = 'page_1';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(bar().style.display, '', '回到它绑的那个副页 ⇒ 显示');
eq(bar().querySelectorAll('.plan-row').length, 1, '★ **一对一**：page_1 上就它那一份计划');

// ③ 另一条计划绑的是**别的副页** ⇒ 在 page_1 上看不到它（一对一：一个副页一份）
AppState.currentPageId = 'page_2';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(!!rowOf('plan_2') && !rowOf('plan_1'), '★ 切到 page_2 ⇒ 换成它的那条（各看各的）');

// ④ 一个没绑计划的副页（旧数据/手写的页）⇒ 空态说人话，**但没有建入口**
AppState.pages.page_3 = {
    id: 'page_3', name: '空白副页', rootId: 'v_root3',
    virtualIndex: { v_root3: { id: 'v_root3', refId: null, type: 'O', parentId: null, children: [] } }
};
AppState.currentPageId = 'page_3';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(bar().style.display, '', '空副页上也显示（不然这条栏的落点都找不到）');
ok(/还没有计划/.test(serialize(bar())), '空态给一句人话');
ok(!btn('plan-bar-add'), '★ 也没有「＋ 新建计划」入口（一对一下不该出现；建副页自带计划）');

// ⑤ 行上**不再有**「去题单页」（你就在那个副页上，那颗是废的）；「📖 完整信息」还在
AppState.currentPageId = 'page_1';
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
ok(!rowOf('plan_1').querySelector('.plan-goto'), '★ 行上没有「去题单页」了（已冗余）');
ok(!!rowOf('plan_1').querySelector('.plan-full'), '「📖 完整信息」还在（那是内层页的入口）');

// ⑥ 题单页没了 ⇒ 摘要如实说，且这条栏这时不该硬留在主页上（页都没了）
AppState.pages = {};
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(bar().style.display, 'none', '题单页都删了 ⇒ 那条栏也没有落点（不显示）');

// ⑦ ★ 一对一模型：**建副页自带一份计划**（那条入口与弹窗都退休了）
//    口径见 `docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节。
//    ⚠️ 这里原来钉的是"新建计划弹窗建完要关掉"（`createModal` 的 `false` = 不关；那个 bug 修过）；
//       用户 2026-10-15 定了"计划不需要增删功能" ⇒ 弹窗（`ui/plan/planDialog.js`）整个退休，
//       那条断言随之作废 —— 现在钉的是"**建页就有一份计划**"这条模型本身。
group('⑦ 一对一：建副页自带一份计划（`ensurePagePlan`），界面没有增删入口');
{
    const { addPage } = await import(mod('core/ops/page.js'));
    const { execute } = await import(mod('shell/executor.js'));
    seed();
    AppState.plans = {};                       // 清空：等下由"建页"自己带出计划来
    await execute((draft) => addPage(draft, '冒烟新建的副页'), { validate: false, refreshParentId: null });
    const page = Object.values(AppState.pages).find((p) => p.name === '冒烟新建的副页');
    ok(!!page, '（前提）副页建出来了');
    const mine = Object.values(AppState.plans || {}).filter((p) => p.pageId === page.id);
    eq(mine.length, 1, '★ 建页就有一份计划（不用去点"新建计划"）');
    eq(mine[0].name, '冒烟新建的副页', '名字默认取副页名');
    eq(mine[0].goal.mode, 'intensity', '默认口径 = 训练强度');
    eq(mine[0].goal.per, 'day', '默认粒度 = 每天');
    eq(mine[0].goal.value, 3, '默认目标值 = 3');
    AppState.currentPageId = page.id;
    applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
    eq(bar().querySelectorAll('.plan-row').length, 1, '★ 切到新副页 ⇒ 那条栏画的就是它这一份');
    ok(!btn('plan-bar-add'), '而且仍然没有「＋ 新建计划」');
}

// ⑧ ★ 副页方框上的「计划强度角标」= `剩 X / 共 Y`（用户 2026-10-15；口径见 `docs/training-plan.md` §14 ②）
//    数字怎么算在 `core/trainingPlan.js:planSubtreeIntensityOf`（有单测），这里钉**接线**：
//    计划侧注入 → `view/nodeBadge.js` 存文案 → 方框按 Ctrl 显隐（CSS，`.node-badge`）。
group('⑧ 计划强度角标：展示位的契约 + 只对副页注入（数字本身在单测里钉）');
{
    const badges = await import(mod('view/nodeBadge.js'));
    seed();
    applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
    // ⚠️ 夹具两道题都**没填难度** ⇒ 强度 0 ⇒ 按口径**不画角标**（"剩 0 / 共 0"是噪声）
    ok(!badges.hasNodeBadges(), '★ 强度全是 0 ⇒ 一个角标都不画');
    // ⚠️ 这里**不去造"有强度"的夹具**：灌 `xcpcDifficulty` 走不通（夹具不经过产出链，
    //    强度那条路拿不到值）⇒ 数字由 `trainingPlan.test.js` 的 `planSubtreeIntensityOf`
    //    两条单测钉住，这一组只钉**展示位的契约**与"只对副页注入"。
    badges.setNodeBadges({ v1: '剩 1 / 共 2' });
    eq(badges.nodeBadgeOf('v1'), '剩 1 / 共 2', '展示位：按页内 id 取到那条文案');
    eq(badges.nodeBadgeOf('v2'), null, '没有的就是 null（不画空角标）');
    badges.setNodeBadges(null);
    ok(!badges.hasNodeBadges(), '传 null ⇒ 清掉（主页那条路就是这么清的）');

    // ⚠️ 只对**副页**算：切回主页 ⇒ 计划侧那一趟会把角标清掉
    AppState.currentPageId = 'page_1';
    applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
    AppState.currentPageId = 'main';
    applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
    ok(!badges.hasNodeBadges(), '★ 主页上不留角标（清掉）');

    // ---- ★ 角标必须是**悬浮**的（用户 2026-10-15："用悬浮的语法放入该元素，以完全不影响
    //      其他元素的排版"）：DOM 桩不排版 ⇒ 这条口径只能**源码级**钉（形状照抄
    //      `synth-view.smoke.mjs` 钉花纹那条）。
    //      实测踩过：它在流里时 `.node-meta`（`flex-wrap`）满行会把角标挤到下一行 ⇒ 方框变高。
    const { readFileSync } = await import('node:fs');
    const INDEX_HTML = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const badgeRule = /\.node-badge\s*\{([\s\S]*?)\}/.exec(INDEX_HTML);
    ok(!!badgeRule, 'index.html 里有 `.node-badge` 规则');
    const badgeBody = badgeRule ? badgeRule[1] : '';
    ok(/position\s*:\s*absolute/.test(badgeBody), '★ 角标 `position:absolute`（脱离文档流 ⇒ 不推别的元素）');
    ok(!/(^|[;{\s])(margin|vertical-align)\s*:/.test(badgeBody),
        '★ 角标里没有影响排版的属性（`margin` / `vertical-align`）');
    const metaRule = /\.node-meta\s*\{([\s\S]*?)\}/.exec(INDEX_HTML);
    ok(/position\s*:\s*relative/.test(metaRule ? metaRule[1] : ''),
        '★ `.node-meta` 是 `position:relative`（角标的定位参照 —— 去掉它角标会跑到字母按钮那一列）');
}

// ================================================================
group('计划条：进度是记忆化的，但**数据一变就必须重算**（漏一个键 = 静默错数）');
// ⚠️ 这条守的是 `planBarProgressOf` 那份记忆化（2026-10-18 加，省下切回副页的那 ~31ms）。
//    它和副页统计那份额边同一类坑：**键里漏一样东西 ⇒ 明明改了数据、栏上还是旧数**。
//    本仓已经踩过两次（`page-sync` 就地改 vNode / 统计记忆化把旧结果还回来）⇒ 钉一条。
// ================================================================
seed();
AppState.currentPageId = 'page_2';           // `plan_2` = 每周 2 题（题数口径，数字最好比）
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
const sumBefore = serialize(rowOf('plan_2').querySelector('.plan-summary'));
ok(sumBefore.includes('1/2'), `改前：一天里只做掉 r1 ⇒ 本期 1/2 题：${sumBefore}`);
// 同一份 state **再渲染一次**：这次必定命中记忆化（数一样 —— 也是"命中不改变结果"的那半条）
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
eq(serialize(rowOf('plan_2').querySelector('.plan-summary')), sumBefore, '同一份 state 再画一次：数不变');
// 改数据（照真实写路径：事务之后 `nodes` 是**新对象**，就地改一个 R 的提交状态）
const nodesNext = { ...AppState.nodes };
nodesNext.r2 = {
    ...nodesNext.r2,
    values: { ...nodesNext.r2.values, status: [{ v: 'AC', src: 'manual', at: 'T', account: '' }] }
};
AppState.nodes = nodesNext;
applyTreeLayout({ statsContent: '统计', showStatsRow: true, showActionBtn: true, rootInfo: null });
const sumAfter = serialize(rowOf('plan_2').querySelector('.plan-summary'));
ok(sumAfter.includes('2/2'), `★ 换了 \`nodes\` ⇒ 摘要里的数必须跟着变（现在是 2/2 题）：${sumAfter}`);

report();
