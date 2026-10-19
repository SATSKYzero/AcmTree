// ================================================================
// 冒烟测试：副页「与主树对齐 + 屏蔽 + 仪表盘」（scripts/smoke/page-sync.smoke.mjs）
//
// 用户 2026-10-15："新爬的比赛/题目/提交进不了副页" + 补充：「副页节点增加可编辑的『屏蔽』字段；
// 与主树对齐时，走到屏蔽的节点就不会递归」+「副页需要一个仪表盘，用来装副页的全局操作」。
// 口径：`docs/subpage-sync.md`。单测（`src/test/pageSync.test.js`）钉 core 的字节级口径；
// 这里钉 **UI 接线**：
//   ① 仪表盘**只在副页出现**（主页隐藏且清空），上面有 🔄 对齐；
//   ② 点「与主树对齐」⇒ 主树里新长的节点真的补进页里，并报数；
//   ③ 副页节点上那颗 🚫 能翻转屏蔽（真委托 + 真渲染）；
//   ④ 屏蔽之后，那一支不再补；仪表盘的清单能一键取消屏蔽；
//   ⑤ 只读模式下点了不崩、也不改数据。
//
// ⚠️ 用 `installDom([], { parseHtml: true })`：节点方框与仪表盘都是 `innerHTML` 拼的，
//    桩默认不解析 ⇒ `querySelector('.btn-toggle-blocked')` 恒为 null，断言会**空转地绿**。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// ---- DOM 桩（镜像 index.html 里副页 tab 栏与副页渲染要用的那几格）----
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
makeContainer(app, 'app-header');                   // 顶部栏（全局）
makeContainer(app, 'tab-bar');
// ⚠️ 副页栏的宿主是** id** `page-tabs-host`（v9.4.28 起；原来挂在 `.app-header` 后面，
//    那样顶部栏就没法挪到一级 tab 栏上方 —— 见 `ui/G_pageUI.js:renderPageTabs()`）
makeContainer(app, 'page-tabs-host');
makeContainer(app, 'nodeinfo-tab-bar');
makeContainer(app, 'toast');
// ⚠️ `#tree-body` 必须是 `#tree-container` 的**孩子**（与 `index.html` 同形）：
//    `G_events.js` 那条节点按钮委托挂在 `#tree-container` 上，靠**冒泡**接住 ——
//    挂成兄弟的话"点 🚫"在冒烟里一次都不会触发（实测踩过）。
const treeContainer = makeContainer(app, 'tree-container');
for (const id of ['tree-body', 'tree-stats']) {
    makeContainer(treeContainer, id);
}
for (const id of ['folder-stats', 'folder-view-tabs', 'folder-breadcrumb', 'stats-chart-container']) {
    makeContainer(app, id);
}
for (const id of ['main', 'stats', 'dedup', 'settings']) {
    const pane = document.createElement('div');
    pane.id = `tab-${id}`;
    pane.className = 'tab-content';
    app.appendChild(pane);
}

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createPage, createVNode } = await import(mod('core/model/page.js'));
const pageUI = await import(mod('ui/G_pageUI.js'));
const { setupEventDelegation } = await import(mod('ui/G_events.js'));

/**
 * 副页：根 → v_c(c1)，c1 底下**只有** v_p1（主树里还有 p2、p1 下面还有 r1 ⇒ 都是"该补的"）。
 * ⚠️ P 上要留 `status1`/`status2`：副页统计读的是节点上物化那份 —— 取不到会抛错并回滚（实测踩过）。
 */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    const val = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '2026 郑州', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', problemId: 'A', status1: 0, status2: 0,
            values: { ratio: val('9'), status1: val('0'), status2: val('0') } },
        p2: { id: 'p2', type: 'P', name: 'B题', problemId: 'B', status1: 0, status2: 0,
            values: { status1: val('0'), status2: val('0') } },
        r1: { id: 'r1', type: 'R', values: { status: val('AC'), submitKind: val('赛时'), time: val('2026.10.13 10:00:00') } },
        r2: { id: 'r2', type: 'R', values: { status: val('WA'), submitKind: val('赛时'), time: val('2026.10.13 11:00:00') } }
    };
    AppState.childOrder = { root: ['c1'], c1: ['p1', 'p2'], p1: ['r1'], p2: ['r2'], r1: [], r2: [] };
    AppState.parentOf = { c1: 'root', p1: 'c1', p2: 'c1', r1: 'p1', r2: 'p2' };
    AppState.rootId = 'root';

    const page = createPage('page_src', '我的题单', 'vroot');
    page.virtualIndex.vroot = createVNode('vroot', null, 'O', null);
    const vc = createVNode('v_c', 'c1', 'C', 'vroot');
    vc.expanded = true;                            // ⚠️ 展开才有子节点的方框（不然只有 v_c 一颗按钮）
    page.virtualIndex.v_c = vc;
    page.virtualIndex.vroot.children = ['v_c'];
    page.virtualIndex.v_p1 = createVNode('v_p1', 'p1', 'P', 'v_c');
    vc.children = ['v_p1'];                       // 页里**只有** p1：p2 与 r1 等着被对齐补进来
    AppState.pages = { page_src: page };
    AppState.currentPageId = 'page_src';
    AppState.currentTab = 'main';
    AppState.viewingAccountId = '';
    AppState.settings.mode = Object.assign({}, AppState.settings.mode, { editMode: 'attribute' });
}

const dash = () => document.getElementById('page-dashboard');
const dashText = () => String(serialize(dash()));
const refsOf = (pid = 'page_src') => Object.values(AppState.pages[pid].virtualIndex)
    .map((v) => v.refId).filter(Boolean).sort();
const vIdOfRef = (refId, pid = 'page_src') => Object.values(AppState.pages[pid].virtualIndex)
    .find((v) => v.refId === refId)?.id || '';
/**
 * 点一个元素（**从元素自己派发 ⇒ 沿 parent 冒泡到 document**）。
 *
 * ⚠️ 必须这么派：仪表盘那几颗走的是 **document 级**委托（`G_pageUI.setupPageTabsEvents`），
 *    而节点方框上的 🚫 走的是**容器级**委托（`G_events.js:bindActionDelegation` 挂在
 *    `#tree-container` / `#folder-stats` 上）—— 只往 document 派的话后者**一次都不会触发**
 *    （实测踩过：断言全绿、数据一字未改）。
 * ⚠️ 元素不存在就**当场炸**（断言会空转，不如让夹具自己说话）。
 */
const clickOn = (el, ctrlKey = false) => {
    if (!el) throw new Error('clickOn：拿到的元素是空的（夹具/选择器写错了，别让断言空转）');
    el.dispatchEvent({ type: 'click', target: el, ctrlKey });
};

setupEventDelegation();
pageUI.setupPageTabsEvents();
seed();
pageUI.renderPageTabs();
pageUI.refreshCurrentPage();
await tick(60);

group('🎛 仪表盘：只在副页出现，装着全局操作');
ok(!!dash(), '有仪表盘槽位');
ok(dash().style.display !== 'none', '★ 副页上**看得见**');
ok(dashText().includes('🔄 与主树对齐'), '★ 上面有「与主树对齐」（用户 2026-10-15）');
ok(dashText().includes('⧉ 复制副页') && dashText().includes('✖ 删除副页'), '复制 / 删除也住在这里');
ok(dashText().includes('我的题单'), '概况里报出这一页的名字');
eq(String(serialize(document.getElementById('page-tabs'))).includes('page-sync-btn'), false,
    '★ tab 上**没有**它（全局操作只有一处入口）');

group('🎛 仪表盘：重画多少次都只有一块（别一层摞一层）');
// 实测踩到：`renderPageTabs()` 每次都会建一个槽位，只建不删 ⇒ 页面上叠了 4 块一样的仪表盘。
{
    pageUI.renderPageTabs();
    pageUI.renderPageTabs();
    await tick(30);
    eq(document.querySelectorAll('.page-sync-btn').length, 1,
        '★ 连着重画两次，页面上仍然**只有一块**仪表盘');
    eq(document.querySelectorAll('.page-copy-btn').length, 1, '复制按钮同理（同一块槽位里）');
}

group('🔄 与主树对齐：新爬的节点补进来（点仪表盘那颗）');
{
    // 主树那边新长出来的：c1 下多了一场题 p3、p1 下多了一条提交 r1b
    // ⚠️ 新 P 也要带 `status1`/`status2`（副页统计读节点上物化那份，取不到会抛错并回滚 —— 同 seed 那条注释）
    // ⚠️ 2026-10-18：副页统计有按"引用"的记忆化（`view/stats.js` 的 `virtualStatsSlots`，
    //   按页分槽、键里含 `nodes`）⇒ 夹具往 `nodes` 里加东西必须**换字典**（原地加一格引用不变 ⇒ 统计会拿旧值）。
    AppState.nodes = { ...AppState.nodes };
    AppState.nodes.p3 = { id: 'p3', type: 'P', name: 'C题', problemId: 'C', status1: 0, status2: 0,
        values: { ratio: [{ v: '5', src: 'manual', at: 'T', account: '' }],
            status1: [{ v: '0', src: 'manual', at: 'T', account: '' }],
            status2: [{ v: '0', src: 'manual', at: 'T', account: '' }] } };
    AppState.nodes.r1b = { id: 'r1b', type: 'R', values: {
        status: [{ v: 'AC', src: 'manual', at: 'T', account: '' }],
        submitKind: [{ v: '赛时', src: 'manual', at: 'T', account: '' }],
        time: [{ v: '2026.10.13 12:00:00', src: 'manual', at: 'T', account: '' }] } };
    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel` 白名单）⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    AppState.childOrder.c1 = ['p1', 'p2', 'p3'];
    AppState.childOrder.p3 = [];                   // ⚠️ 新节点也补上 `childOrder` 那一条（缺了会让走不通）
    AppState.childOrder.p1 = ['r1', 'r1b'];        // ★ 新提交要挂进**已有的** p1 下面才知道该补它
    AppState.childOrder.r1b = [];
    AppState.parentOf.r1b = 'p1';

    const before = refsOf();
    clickOn(dash().querySelector('.page-sync-btn'), false);
    await tick(80);

    const after = refsOf();
    ok(after.length > before.length, '★ 真的补进来了', `${before.length} → ${after.length}`);
    ok(after.includes('p2'), '新的一支（p2）进来了');
    ok(after.includes('r1b'), '★ **已有的 P 下面**新爬的提交（r1b）也进来了');
    ok(after.includes('p3'), 'c1 下新加的题（p3）进来了');
    for (const id of before) {
        ok(after.includes(id), `已有的 ${id} 一个都没丢（只加不删）`);
    }

    // ★ **子节点顺序也纳入"与主树一致"**（用户 2026-10-16）：手动把这一层调换一下，
    //   再对齐一次 ⇒ 顺序被拨回主树那样（并报出"1 层顺序跟主树"）。
    const childRefsOf = (refId) => (AppState.pages.page_src.virtualIndex[vIdOfRef(refId)].children || [])
        .map((id) => AppState.pages.page_src.virtualIndex[id].refId);
    const vc = AppState.pages.page_src.virtualIndex[vIdOfRef('c1')];
    vc.children = [...vc.children].reverse();
    ok(childRefsOf('c1').join(',') !== AppState.childOrder.c1.join(','), '（前提）现在这一层是反的');
    clickOn(dash().querySelector('.page-sync-btn'), false);
    await tick(80);
    eq(childRefsOf('c1').join(','), AppState.childOrder.c1.join(','),
        '★ 对齐把这一层的顺序拨成主树 `childOrder` 那样');
    ok(String(serialize(document.getElementById('toast'))).includes('1 层顺序跟主树'),
        '★ 报数里说清楚"顺序也动了"',
        String(serialize(document.getElementById('toast'))).slice(0, 200));
}

group('🚫 屏蔽：副页节点上那颗按钮（真渲染 + 真委托）');
{
    const btn = document.querySelector('.btn-toggle-blocked');
    ok(!!btn, '★ 副页节点方框上有屏蔽按钮（`buildActions` 那唯一一处加的）');
    const vid = btn.dataset.id;
    const vp2 = vIdOfRef('p2');
    ok(!!vp2, '（前提）页里已经有 p2');
    // 屏蔽 p1 那一支（它下面已经补进了 r1b）
    const p1Btn = [...document.querySelectorAll('.btn-toggle-blocked')]
        .find((b) => b.dataset.id === vIdOfRef('p1'));
    ok(!!p1Btn, '（前提）找得到 p1 那一颗');
    clickOn(p1Btn, false);
    await tick(80);
    eq(AppState.pages.page_src.virtualIndex[vIdOfRef('p1')].syncBlocked, true, '★ 点一下真的屏蔽了（写进数据）');

    // 主树再长一条新提交 ⇒ 对齐时**不许**进这一支
    AppState.nodes.r1c = { id: 'r1c', type: 'R', values: {
        status: [{ v: 'WA', src: 'manual', at: 'T', account: '' }],
        submitKind: [{ v: '赛时', src: 'manual', at: 'T', account: '' }],
        time: [{ v: '2026.10.13 13:00:00', src: 'manual', at: 'T', account: '' }] } };
    // ⚠️ 2026-10-18：顶层大字典（`childOrder`/`parentOf`）现在会被**冻结**
    //   （`freezeTopLevel` 白名单）⇒ 夹具不许再"就地改一格"，改成**换整张字典**
    //   （赋值给 `AppState` 本身是允许的，语义等价）。
    AppState.childOrder = { ...AppState.childOrder, r1c: [], p1: ['r1', 'r1b', 'r1c'] };
    AppState.parentOf = { ...AppState.parentOf, r1c: 'p1' };

    clickOn(dash().querySelector('.page-sync-btn'), false);
    await tick(80);
    eq(refsOf().includes('r1c'), false, '★ 屏蔽的那一支不再往下补');
    ok(dashText().includes('已屏蔽 1 处'), '★ 仪表盘报出"已屏蔽 1 处"', dashText().slice(0, 200));
    ok(!!dash().querySelector('.page-blocked-toggle'), '给了那颗"折/展"的按钮');
    eq(document.querySelectorAll('.page-unblock-btn').length, 0,
        '★ **默认折叠**（用户 2026-10-15："屏蔽请默认折叠"）—— 清单里那几十条先不画');
}

group('🚫 屏蔽的部分**不参与统计**（用户 2026-10-15）');
{
    const statsOf = async () => {
        const statsMod = await import(mod('view/stats.js'));   // ⚠️ 别把局部变量取名 `mod`（会盖住上面那个 helper）
        return statsMod.getVirtualGlobalStats(AppState, AppState.pages.page_src);
    };
    const blockedNow = await statsOf();
    // 对比：把屏蔽摘掉算一遍（同一个夹具，只差"屏蔽"这一个开关）
    // ⚠️ 2026-10-18：副页统计可能按**引用**记忆化（`view/stats.js`）⇒ 改 vNode 后必须**换页对象**，
    //   否则引用不变、统计会拿旧值（真机上这一步走事务、Immer 本来就会换引用）。
    const flipBlocked = (v) => {
        const pg = AppState.pages.page_src;
        const vid = vIdOfRef('p1');
        AppState.pages = {
            ...AppState.pages,
            page_src: { ...pg, virtualIndex: { ...pg.virtualIndex, [vid]: { ...pg.virtualIndex[vid], syncBlocked: v } } }
        };
    };
    flipBlocked(false);
    const unblocked = await statsOf();
    flipBlocked(true);
    const blockedAgain = await statsOf();
    ok(unblocked.pStr !== blockedAgain.pStr,
        '★ 屏蔽前后 P 统计**不一样**（屏蔽的支不算进去）', `${unblocked.pStr} → ${blockedAgain.pStr}`);
    ok(unblocked.cStr !== blockedAgain.cStr || unblocked.pStr !== blockedAgain.pStr,
        'C 或 P 至少有一条变了（这一支里既有题也有提交）');
    ok(blockedNow.pStr === blockedAgain.pStr, '同一个状态算两次结果一致（没别的副作用）');
}

group('🚫 折开清单 → 一行有三件套（🔎 / 📋 / 面包屑）→ 一键取消屏蔽');
{
    clickOn(dash().querySelector('.page-blocked-toggle'), false);
    await tick(80);
    eq(document.querySelectorAll('.page-unblock-btn').length, 1, '★ 折开之后清单出来了');
    // ★ 用户 2026-10-15："这些列表都该尽可能有详尽的信息与功能（面包屑、点击跳转、详页…）"
    //   ⇒ 然后又说"太臃肿了 **一条只占一行**" ⇒ 现在走的是 `nodeEntryLine(..., { compact: true })`
    eq(document.querySelectorAll('#page-blocked-rows .node-entry').length, 1,
        '★ 每一行都带一条"入口条"（`ui/kit/nodeEntry.js:nodeEntryLine` 那一份）');
    const entry = dash().querySelector('#page-blocked-rows .node-entry');
    ok(String(entry.style.cssText).includes('nowrap') && !String(entry.style.cssText).includes('flex-wrap:wrap'),
        '★ **不换行**（"一条只占一行"）', entry.style.cssText);
    // ★ 用户 2026-10-15（指着计划那张表）："题目列表的**详页按钮又没对齐**了"
    //   ⇒ 入口条必须**吃下剩余宽度**：📋 靠的是自己的 `margin-left:auto`，
    //     只有剩余空白在**入口条里面**，它才落得到右端点（按内容收窄时空白留在外面、`auto` 白写）。
    ok(/flex:1 1 auto/.test(String(entry.style.cssText)),
        '★ 入口条**吃下剩余宽度**（`flex:1 1 auto`）—— 这样 📋 的 `margin-left:auto` 才有空白可吃',
        entry.style.cssText);
    const row = dash().querySelector('#page-blocked-rows .page-blocked-row');
    ok(String(row.style.cssText).includes('nowrap'), '★ 整行也是 nowrap flex');
    ok(/display:flex/.test(String(row.style.cssText)) && !/fit-content/.test(String(row.style.cssText)),
        '★ 行**占满可用宽度**（不给 `fit-content` —— 否则 `margin-left:auto` 无空白可吃、贴不到右端）',
        row.style.cssText);
    ok(/border-radius/.test(String(row.style.cssText)) && /border:1px solid/.test(String(row.style.cssText)),
        '★ 每行是一个**圆角淡框**（"每项都要假想装在矩形里"）', row.style.cssText);
    // ⚠️ 容器在代码里用 `.style.cssText` 赋的（不是 innerHTML 里的属性 —— 桩那边读不到）⇒ 这条读得到。
    const rowsBox = dash().querySelector('#page-blocked-rows');
    ok(/flex-direction:column/.test(String(rowsBox.style.cssText))
        && !/flex-wrap:wrap/.test(String(rowsBox.style.cssText)),
        '★ **每条独占一行**（装它们的容器是 column，不是 wrap —— 否则短卡片会并排挤在一行里）',
        rowsBox.style.cssText);
    ok(!/align-items:flex-start/.test(String(rowsBox.style.cssText)),
        '★ 容器不给 `align-items:flex-start`（那会让卡片按内容收窄，卡内的 `margin-left:auto` 就失效）',
        rowsBox.style.cssText);
    // ★ 用户 2026-10-15："应该在最前面放 id/extkey" + "总之信息给全，各列表都给全"
    const idChip = dash().querySelectorAll('#page-blocked-rows .node-entry-id')[0];
    ok(!!idChip && String(idChip.textContent).trim().length > 0,
        '★ 第一格是**身份键**（`extKey`，没有才退回 id）',
        idChip ? String(idChip.textContent) : '（没有 id 芯片）');
    const gotoChip = dash().querySelectorAll('#page-blocked-rows .node-entry-id [data-reveal-node]');
    eq(gotoChip.length, 0, '★ 身份键那一格**不**是跳转入口（跳转挂在面包屑上，只有一处）');
    ok(!!dash().querySelectorAll('#page-blocked-rows .node-entry-crumb[data-reveal-node]')[0],
        '★ 第二格是面包屑，**它自己就是 🔎 跳转**（`data-reveal-node` 挂在它上面）');
    const info = dash().querySelectorAll('#page-blocked-rows .btn-node-info')[0];
    ok(!!info, '★ 有 📋 打开详页');
    ok(String(info.style.cssText).includes('margin-left:auto'),
        '★ 📋 用 `margin-left:auto` **贴右端点**（用户："我不是让你右端点取 max 吗"）', info.style.cssText);
    eq(String(info.textContent).trim(), '📋', '★ 紧凑形态：📋 只留图标（不再写"打开详页"四个字）');
    const crumb = dash().querySelectorAll('#page-blocked-rows .node-entry-crumb')[0];
    ok(!!crumb && String(serialize(crumb)).trim().length > 0, '★ 面包屑还在（单行、放不下会省略）',
        crumb ? String(serialize(crumb)).slice(0, 80) : '（没有 crumb）');
    ok(/#1d4ed8/.test(String(crumb && crumb.style.cssText)), '★ 面包屑整条**蓝色**（"全蓝"）',
        crumb ? String(crumb.style.cssText) : '');
    // ⚠️ 用 `querySelector('.crumb-self')` 找那一（桩开了解析 ⇒ 元素树里有它）；
    //    别拿 `innerHTML` 原串判（解析模式下那个 getter 是空的 ⇒ 会**空转地红/绿**）。
    ok(!!(crumb && crumb.querySelector('.crumb-self')),
        '★ 面包屑**一级不缺**（含节点自己那一段 —— `crumb-self`）',
        crumb ? String(serialize(crumb)) : '');
    clickOn(dash().querySelector('.page-unblock-btn'), false);
    await tick(80);
    eq(AppState.pages.page_src.virtualIndex[vIdOfRef('p1')].syncBlocked, false, '★ 一键取消屏蔽');
    ok(!dashText().includes('已屏蔽 1 处'), '仪表盘上那条也没了');
}

group('🙈「不显示屏蔽的部分」：勾上 ⇒ 屏蔽的支**不渲染**（数据不动）');
{
    // 再屏蔽一次（上一组刚取消），然后用仪表盘那个勾选框把它藏起来
    const p1Vid = vIdOfRef('p1');
    AppState.pages.page_src.virtualIndex[p1Vid].syncBlocked = true;
    pageUI.renderPageTabs();
    pageUI.refreshCurrentPage();
    await tick(60);
    const boxCountBefore = document.querySelectorAll('.btn-toggle-blocked').length;
    const box = dash().querySelector('.page-hide-blocked');
    ok(!!box, '★ 仪表盘上有「不显示屏蔽的部分」这个勾选框');
    eq(!!box.checked, false, '默认**没勾**（老行为：屏蔽的支照画）');
    eq(AppState.pages.page_src.hideBlocked || false, false, '字段缺省 false');
    box.checked = true;
    clickOn(box, false);
    await tick(80);
    eq(AppState.pages.page_src.hideBlocked, true, '★ 勾上写进了**页级字段**（数据，不是纯界面状态）');
    const boxCountAfter = document.querySelectorAll('.btn-toggle-blocked').length;
    ok(boxCountAfter < boxCountBefore,
        '★ 屏蔽那一支不再渲染（连它的方框一起没了）', `${boxCountBefore} → ${boxCountAfter}`);
    ok(refsOf().includes('p1'), '⚠️ 只是不画：数据里 p1 那一支**还在**（vNode 一个都没删）');
    // 复原（后面的组还要用干净状态）
    AppState.pages.page_src.hideBlocked = false;
    AppState.pages.page_src.virtualIndex[p1Vid].syncBlocked = false;
    pageUI.renderPageTabs();
    pageUI.refreshCurrentPage();
    await tick(60);
}

group('📄 屏蔽清单分页（用户 2026-10-15："分页，默认 10"）');
{
    const page = AppState.pages.page_src;
    const parentVid = 'v_c';                     // ⚠️ 夹具里那个 C 叫 `v_c`（不是 v_c1）
    // 手工堆 12 条屏蔽（超过一页），用完就摘掉
    const added = [];
    // ⚠️ 2026-10-18：顶层大字典可能被冻结 ⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    // 副页的 `virtualIndex` 也被冻结（`freezeTopLevel`）⇒ 换一份可变的，`page` 重新取
    AppState.pages = {
        ...AppState.pages,
        page_src: { ...page, virtualIndex: { ...page.virtualIndex } }
    };
    const mutablePage = AppState.pages.page_src;
    for (let i = 1; i <= 12; i++) {
        const rid = `xk${i}`;
        AppState.nodes[rid] = { id: rid, type: 'P', name: `第${i}题`, problemId: String(i),
            status1: 0, status2: 0, values: {} };
        AppState.childOrder[rid] = [];
        const vid = `vxk${i}`;
        const v = createVNode(vid, rid, 'P', parentVid);
        v.syncBlocked = true;
        mutablePage.virtualIndex[vid] = v;
        mutablePage.virtualIndex[parentVid].children.push(vid);
        added.push(vid);
    }
    pageUI.renderPageTabs();
    pageUI.refreshCurrentPage();
    await tick(60);
    // 清单得是**折开**的才看得到行（默认折叠）
    const toggle = dash().querySelector('.page-blocked-toggle');
    if (toggle && String(toggle.textContent).includes('▸')) {
        clickOn(toggle, false);
        await tick(60);
    }
    eq(document.querySelectorAll('#page-blocked-rows .page-blocked-row').length, 10,
        '★ 一页只画 10 条（默认页大小）');
    ok(dashText().includes('1 / 2'), '分页器写着 1 / 2', dashText().slice(-160));
    ok(dashText().includes('(1~10 / 12)'), '范围写着 1~10 / 12');
    clickOn(dash().querySelector('.page-blocked-next'), false);
    await tick(60);
    eq(document.querySelectorAll('#page-blocked-rows .page-blocked-row').length, 2, '★ 第 2 页只剩 2 条');
    ok(dashText().includes('2 / 2') && dashText().includes('(11~12 / 12)'), '第 2 页的页码与范围都对');
    clickOn(dash().querySelector('.page-blocked-prev'), false);
    await tick(60);
    eq(document.querySelectorAll('#page-blocked-rows .page-blocked-row').length, 10, '◀ 翻回第 1 页');

    // 复原（后面的组要干净状态）
    // ⚠️ 2026-10-18：顶层大字典可能被冻结 ⇒ 删格前换可变副本；**页对象也可能换过**（上面 clone 了），
    //   所以这里一律从 `AppState.pages` 重新取，别用上面那个旧的 `page`。
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    AppState.nodes = { ...AppState.nodes };
    AppState.pages = {
        ...AppState.pages,
        page_src: { ...AppState.pages.page_src, virtualIndex: { ...AppState.pages.page_src.virtualIndex } }
    };
    const livePage = AppState.pages.page_src;
    for (const vid of added) {
        const v = livePage.virtualIndex[vid];
        if (!v) continue;
        livePage.virtualIndex[parentVid].children = livePage.virtualIndex[parentVid].children.filter((x) => x !== vid);
        delete livePage.virtualIndex[vid];
        delete AppState.nodes[v.refId];
        delete AppState.childOrder[v.refId];
    }
    pageUI.renderPageTabs();
    pageUI.refreshCurrentPage();
    await tick(60);
}

group('主页上仪表盘收起（且清空）');
{
    AppState.currentPageId = 'main';
    pageUI.refreshCurrentPage();
    await tick(60);
    eq(dash().style.display, 'none', '★ 主页不显示仪表盘');
    eq(String(dash().innerHTML).trim(), '', '内容也清掉了（别把上一页的操作留在主页上）');
    AppState.currentPageId = 'page_src';
    pageUI.refreshCurrentPage();
    await tick(60);
    ok(dash().style.display !== 'none', '切回副页又出来');
}

group('只读（"只看别人"）：点了不崩、也不改数据');
{
    AppState.viewingAccountId = 'acc_other';
    const before = refsOf().join(',');
    AppState.nodes.p9 = { id: 'p9', type: 'P', name: 'D题', problemId: 'D', status1: 0, status2: 0,
        values: { status1: [{ v: '0', src: 'manual', at: 'T', account: '' }],
            status2: [{ v: '0', src: 'manual', at: 'T', account: '' }] } };
    // ⚠️ 2026-10-18：顶层大字典可能被冻结 ⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    AppState.childOrder.c1 = ['p1', 'p2', 'p3', 'p9'];
    AppState.childOrder.p9 = [];
    AppState.parentOf.p9 = 'c1';
    clickOn(dash().querySelector('.page-sync-btn'), false);
    await tick(80);
    eq(refsOf().join(','), before, '★ 只读时对齐一个节点都没补');
    ok(true, '★ 也没抛到外面（错误由 toast 承接）');
    AppState.viewingAccountId = '';
}

report();
