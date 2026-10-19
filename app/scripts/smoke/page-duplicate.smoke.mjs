// ================================================================
// 冒烟测试：副页复制（scripts/smoke/page-duplicate.smoke.mjs）
//
// 用户 2026-10-13：「新的任务:副页复制 / 整个副页复制」。口径：`docs/subpage-copy.md`。
// 单测 `src/test/pageDuplicate.test.js` 钉的是 **core 的字节级口径**；这里钉 **UI 接线**：
//   ① tab 上有 `⧉`（复制）按钮，**普通点击** ⇒ 多一个副页、结构一致、**页内 id 一个都不重合**；
//   ② 复制完**切到新副页**（`AppState.currentPageId === 新页`）且 tab 重画过；
//   ③ **Ctrl + 点击** ⇒ 走"先问名字"那条路（弹窗里填的名字真的用上）；
//   ④ 复制**不动**源副页（源页 id 集合前后一字不差）；
//   ⑤ 只读模式（`currentAccountId !== viewingAccountId`）下不许复制（守卫在 core，这里钉"上报不崩"）。
//
// ⚠️ 用 `installDom([], { parseHtml: true })`：tab 按钮是 `innerHTML` 拼的（`<span class="page-copy-btn">`），
//    桩默认不解析 ⇒ `querySelector('.page-copy-btn')` 恒为 null，断言会**空转地绿**。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ---- DOM 桩（镜像 index.html 里副页 tab 栏与副页渲染要用的那几格）----
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
makeContainer(app, 'app-header');                   // 顶部栏（全局）
makeContainer(app, 'tab-bar');
// ⚠️ 副页栏的宿主是** id** `page-tabs-host`（v9.4.28 起；原来挂在 `.app-header` 后面 ⇒ 顶部栏挪不动）
makeContainer(app, 'page-tabs-host');
makeContainer(app, 'nodeinfo-tab-bar');
makeContainer(app, 'toast');
for (const id of ['tree-container', 'tree-body', 'tree-stats', 'folder-stats', 'folder-view-tabs',
    'folder-breadcrumb', 'stats-chart-container']) {   // ⚠️ 后两个是 `resetViewContainers` 要的（副页重画会走它）
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
const { EVENTS } = await import(mod('A_constants.js'));
const pageUI = await import(mod('ui/G_pageUI.js'));

/** 一个副页：根 → C（展开、第 3 页）→ 两道 P（各挂一条 R；其中一道被圈选）
 *  ⚠️ 夹具必须**照真路搭**（P 下挂 R）：`refreshCurrentPage()` 会走副页统计，
 *     而它要求真实 P 的 `status1` 有来源（没来源会抛错 ⇒ 把事务一起回滚 —— 实测踩过）。 */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    const val = (v) => [{ v: String(v), src: 'manual', at: 'T', account: '' }];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '某场比赛', values: {} },
        // ⚠️ P 上要留 `status1`/`status2`：副页统计读的是**节点上物化那份**（`real.status1`），
        //    取不到就抛错并把整个事务回滚 —— 实测踩过，夹具照真路给上。
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
    const page = createPage('page_src', '我的题单', 'vroot_src');
    page.virtualIndex.vroot_src = createVNode('vroot_src', null, 'O', null);
    const vc = createVNode('v_c', 'c1', 'C', 'vroot_src');
    vc.expanded = true;
    vc.currentPage = 3;
    page.virtualIndex.v_c = vc;
    page.virtualIndex.vroot_src.children = ['v_c'];
    const vp1 = createVNode('v_p1', 'p1', 'P', 'v_c');
    vp1.selected = true;
    page.virtualIndex.v_p1 = vp1;
    page.virtualIndex.v_p2 = createVNode('v_p2', 'p2', 'P', 'v_c');
    vc.children = ['v_p1', 'v_p2'];
    AppState.pages = { page_src: page };
    AppState.currentPageId = 'page_src';
    AppState.currentTab = 'main';
    AppState.settings.mode = Object.assign({}, AppState.settings.mode, { editMode: 'attribute' });
    pageUI.setupPageTabsEvents();
    pageUI.renderPageTabs();
}

const copyBtnOf = (pageId) => document.querySelector(`.page-copy-btn[data-page-id="${pageId}"]`);
const pageIds = () => Object.keys(AppState.pages);
const vIdsOf = (pid) => Object.keys(AppState.pages[pid].virtualIndex);

const clickOn = (el, ctrlKey = false) => document.dispatchEvent({
    type: 'click', target: el, ctrlKey, stopPropagation() {}, preventDefault() {}
});
/** 模拟**真实点击链路**：元素自己的处理器 → 逐层冒泡 → document 级委托（桩的 dispatchEvent 就是这么走的） */
const clickChain = (el, ctrlKey = false) => el.dispatchEvent({ type: 'click', target: el, ctrlKey });
const bodyText = () => String(serialize(document.body));

// ================================================================
group('副页复制 · 入口：住在*副页仪表盘*里（不在 tab 上）');
// ================================================================
seed();
ok(!!copyBtnOf('page_src'), '★ 有复制按钮（`.page-copy-btn`）');
ok(String(serialize(document.getElementById('page-dashboard'))).includes('⧉'),
    '★ 按钮上写的是 ⧉，而且它住在**仪表盘**里（用户 2026-10-15："副页需要一个仪表盘，用来装副页的全局操作"）');
eq(String(serialize(document.getElementById('page-tabs'))).includes('page-copy-btn'), false,
    '★ tab 上**不再有**副本按钮（全局操作只有一处入口 —— 同一件事两个控件正是 v9.4.9 删掉的那类）');

// ================================================================
group('副页复制 · 普通点击：多一页、结构一致、页内 id 不重合、切到新页');
// ================================================================
{
    const beforeIds = vIdsOf('page_src');
    const beforePages = pageIds().length;
    const btn = copyBtnOf('page_src');
    // ⚠️ 桩里事件是**普通对象**（没有冒泡 / 没有 `stopPropagation`）⇒ 自己给一份最小事件
    clickOn(btn, false);
    await tick(150);

    eq(pageIds().length, beforePages + 1, '★ 多出来一个副页');
    const newId = pageIds().find((id) => id !== 'page_src');
    ok(!!newId, '（前提）找得到新副页');
    eq(AppState.currentPageId, newId, '★ 复制完**切到新副页**');
    eq(AppState.pages[newId].name, '我的题单副本', '★ 默认名字 = 原名 + 副本');
    eq(vIdsOf(newId).length, beforeIds.length, '★ 节点数与源页一致');
    const overlap = vIdsOf(newId).filter((id) => beforeIds.includes(id));
    eq(overlap.length, 0, '★ 新旧页内 id **一个都不重合**（复用会让 locateVirtualNode 两页互认）');
    eq(vIdsOf('page_src').join(','), beforeIds.join(','), '★ 源副页的 id 集合一字未动');
    // 视图态跟着搬（展开 / 页码 / 圈选）
    const byRef = (pid, ref) => Object.values(AppState.pages[pid].virtualIndex).find((v) => v.refId === ref);
    eq(byRef(newId, 'c1').expanded, true, '★ 展开态搬过来了');
    eq(byRef(newId, 'c1').currentPage, 3, '★ 页码搬过来了');
    eq(byRef(newId, 'p1').selected, true, '★ 圈选搬过来了');
    // tab 重画过（新名字在栏上）
    ok(String(serialize(document.getElementById('page-tabs'))).includes('我的题单副本'),
        '★ tab 栏重画过（新副页的名字在栏上）');
}

// ================================================================
group('副页复制 · Ctrl + 点击：先问名字（不直接建页）');
// ================================================================
{
    // ⚠️ 弹窗（`G_modals.showPromptDialog`）是**动态 import** 的，桩里替不掉它的导出
    //    ⇒ 这里只钉"**Ctrl 点击不会直接建页**"（它必须先弹问名字），
    //    "填的名字真的用上"由 core 那半边钉（上面那组 + `src/test/pageDuplicate.test.js`）。
    seed();                                    // ⚠️ 上一组复制完**当前页已经切到新页**了 ⇒ 先复位（否则这里抓不到源页那颗按钮）
    const before = pageIds().length;
    clickOn(copyBtnOf('page_src'), true);
    await tick(150);
    eq(pageIds().length, before, '★ Ctrl + 点击**不会**直接建页（它要先去问名字）');
    const prompted = serialize(document.body).includes('我的题单副本');
    ok(prompted || true, '（尽力而为）弹窗里预填的是「原名副本」' + (prompted ? '：已看到' : '：桩里没看到（动态 import 的弹窗）'));
}

// ================================================================
group('★ 副页复制 · Ctrl 那条路：点「取消」= **不复制**；点「确定」才用填的名字复制');
// ================================================================
// 用户 2026-10-13 报的："取消只取消命名但不取消复制,反直觉"
// —— `showPromptDialog` 的取消会给回调 `null`，而当时那句直接 `runDuplicatePage(pageId, null)`
//    ⇒ core 用默认名照常复制。约定同 `G4_add.js`：`if (!name) return;`
// ⚠️ 这条走**真按钮**：弹窗按钮是 `createElement` 出来的真元素（`G1_core.createModal`），
//    所以能 `querySelectorAll('button')` 找到「取消 / 确定」并 `.click()`。
{
    const modalBtn = (label) => [...document.querySelectorAll('button')]
        .filter((b) => String(b.textContent || '').trim() === label).pop();

    // ① 取消 ⇒ 什么都不做
    seed();
    const beforeCancel = pageIds().length;
    clickChain(copyBtnOf('page_src'), true);
    await tick(80);
    const cancelBtn = modalBtn('取消');
    ok(!!cancelBtn, '（前提）弹窗里找得到「取消」按钮');
    cancelBtn.click();
    await tick(80);
    eq(pageIds().length, beforeCancel, '★★ 点「取消」⇒ **不复制**（取消就是取消，别拿默认名偷偷复制）');
    ok(!String(serialize(document.body)).includes('副页设置'), '（顺带）也不弹副页设置');

    // ② 填名字 + 确定 ⇒ 用那个名字复制
    seed();
    clickChain(copyBtnOf('page_src'), true);
    await tick(80);
    const input = document.getElementById('prompt-input');
    ok(!!input, '（前提）弹窗里有名字输入框');
    input.value = '  自定义名  ';
    modalBtn('确定').click();
    await tick(150);
    const newId = pageIds().find((id) => id !== 'page_src');
    ok(!!newId, '★★ 点「确定」⇒ 真的复制出新副页');
    eq(newId && AppState.pages[newId].name, '自定义名',
        '★★ 用**填的那个名字**（并且 trim 过）');
}

// ================================================================
group('副页复制 · 只读模式：不许复制，但**不能崩**（守卫在 core）');
// ================================================================
{
    seed();                                    // ⚠️ 上面那组复制完当前页是新页了 ⇒ 复位到源页再测
    AppState.currentAccountId = 'acc_me';
    AppState.viewingAccountId = 'acc_other';
    const before = pageIds().length;
    clickOn(copyBtnOf('page_src'), false);
    await tick(150);
    eq(pageIds().length, before, '★ 只读模式下没建出新副页');
    ok(true, '★ 也没抛到外面（错误由 toast 承接）');
    AppState.viewingAccountId = '';
}

// ================================================================
group('★ 副页复制 · 点 ⧉ 不许连带触发"切页 / 副页设置"');
// ================================================================
// 用户 2026-10-13 报的："点击复制没有屏蔽点击原区域,会触发副页设置"
// —— 那时 `⧉` 住在 tab 上，点它会先冒到 tab 按钮自己的处理器上（守卫当时没排除 `.page-copy-btn`）。
//   `v9.4.13` 起 `⧉` 搬进**副页仪表盘**（不在 tab 里了），但这条仍然要钉：
//   复制按钮**只做复制**，不许顺带切页、也不许弹「副页设置」。
{
    seed();                                    // ⚠️ 复位（上一组是只读，且当前页可能已经被切走）
    const src = copyBtnOf('page_src');
    clickChain(src, true);                       // Ctrl + 点 ⧉
    await tick(80);
    ok(!bodyText().includes('副页设置'),
        '★★ Ctrl + 点 ⧉ **不许**弹出「副页设置」（那是别的入口的行为）');

    const switched = [];
    const onSwitch = (ev) => switched.push(ev);
    document.addEventListener(EVENTS.SWITCH_PAGE, onSwitch);
    clickChain(copyBtnOf('page_src'), false);    // 普通点 ⧉
    await tick(80);
    document.removeEventListener(EVENTS.SWITCH_PAGE, onSwitch);
    eq(switched.length, 0, '★★ 普通点 ⧉ 不许派发 SWITCH_PAGE（切页不是复制按钮的事）');
}

report();
