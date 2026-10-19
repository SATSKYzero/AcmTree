// ================================================================
// 冒烟测试：节点定位 ui/revealNode.js（scripts/smoke/reveal-node.smoke.mjs）
//
// 覆盖：切主视图 / 切主页面 / 树模式展开祖先并翻页 / 文件夹模式进入父目录
//
// ⚠️ 覆盖边界（务必知悉）：
//   本套件用的是**最小 DOM 桩**，它不解析 innerHTML 字符串，因此由
//   renderTree 渲染出来的 `.node-box` 在桩里查不到。所以"滚动到目标并高亮"
//   这一步无法在这里验证，只在预置了 box 的场景下断言滚动被调用。
//   真实滚动/高亮的最终确认仍需在浏览器里点一次。
//
// 运行：npm run test:smoke
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report, patchNodes } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

/** 等待若干毫秒（高亮看护是定时轮询，需要给它时间） */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const body = installDom();
const app = makeContainer(body, 'app');
makeContainer(app, 'tab-bar');
makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'tab-main');
makeContainer(app, 'folder-breadcrumb');
makeContainer(app, 'folder-stats');
// ⚠️ `#toast` 是**必须**的：切页失败时事件桥会 `showToast` 报错，而没有这个容器时
//    `showToast` 自己会抛 ⇒ 真错误被那层 catch 吞掉（症状：切页静默失败、日志里什么都没有）。
makeContainer(app, 'toast');

globalThis.fetch = async () => ({ ok: true, json: async () => ({ plugins: [] }) });

const { AppState, replaceState } = await import(mod('shell/state.js'));
const { isExpanded, setExpanded, pageOf, setNodePage } = await import(mod('core/model/viewState.js'));
const { revealNode } = await import(mod('ui/revealNode.js'));
const folder = await import(mod('ui/folder/folderMode.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const eventBridge = await import(mod('ui/eventBridge.js'));

eventBridge.registerAllEvents();

// ---- 造数据：c1 下有 3 道题，nodePerPage=2 → p3 在第 2 页 ----
const N = (id, type, extra = {}) => ({ id, type, name: extra.name || id, expanded: false, ...extra });
const nodes = {
    root: N('root', 'O', { name: '根' }),
    w1: N('w1', 'W', { name: 'CF' }),
    c1: N('c1', 'C', { name: 'Round 900' }),
    p1: N('p1', 'P', { name: 'A题', problemId: 'A' }),
    p2: N('p2', 'P', { name: 'B题', problemId: 'B' }),
    p3: N('p3', 'P', { name: 'C题', problemId: 'C' })
};
const parentOf = { w1: 'root', c1: 'w1', p1: 'c1', p2: 'c1', p3: 'c1' };
const childOrder = { root: ['w1'], w1: ['c1'], c1: ['p1', 'p2', 'p3'], p1: [], p2: [], p3: [] };

replaceState({
    rootId: 'root',
    nodes,
    parentOf: Object.assign({}, parentOf, { root: null, w1: 'root' }),
    childOrder,
    pages: {},
    currentPageId: 'main',
    settings: {
        display: { nodePerPage: 2 },
        mode: { treeDisplayMode: 'tree', editMode: 'attribute' },
        performance: { historySteps: 25, expandedNodeBlockLimit: 9999 }
    },
    meta: { idCounter: 10 },
    currentTab: 'main'
});

// ===============================================================
group('定位：树模式展开祖先并翻到目标的页');
// ===============================================================

// 说明：本组会真的触发事务 → 刷新 → renderTree，而 renderTree 会把
// tree-body 的 innerHTML 清空重设；桩不解析 innerHTML，所以渲染之后
// 查不到 .node-box。因此本组只断言"状态被正确改动"，不断言滚动。
// 滚动一步放在下一组（无变更、不发生渲染）里验证。
const okReveal = await revealNode('p3');
eq(isExpanded(AppState, 'root'), true, '根节点被展开');
eq(isExpanded(AppState, 'w1'), true, '中间祖先 w1 被展开');
eq(isExpanded(AppState, 'c1'), true, '父节点 c1 被展开');
eq(pageOf(AppState, 'c1'), 2, '父节点翻到第 2 页（perPage=2，p3 序号 2）');
eq(okReveal, false, '渲染后桩查不到节点 → 返回 false（桩限制，非产品缺陷）');

// ===============================================================
group('定位：翻页计算随目标序号变化');
// ===============================================================

// ⚠️ 摆"展开/页码"也要走事务（节点对象是冻的，事务外就地改会抛错，见 harness 的 patchNodes）
await patchNodes(AppState, (d) => {
    for (const id of ['c1', 'root', 'w1']) if (d.nodes[id]) setExpanded(d, id, false);
});
// 前提锚：不锚一下的话，`patchNodes` 变成空操作这组也照样绿
//（`revealNode` 自己会把 expanded 设回 true，后面那些断言看不出区别）
eq(isExpanded(AppState, 'c1'), false, '（前提）摆好了：c1 先收起');

await revealNode('p1');
eq(pageOf(AppState, 'c1'), 1, 'p1 序号 0 → 第 1 页');
eq(isExpanded(AppState, 'c1'), true, '同样会展开父节点');

// ===============================================================
group('定位：无需变更时只做滚动 + 高亮');
// ===============================================================

// 目标已可见：祖先已展开、父节点页码正确、且停在主视图主页面
await patchNodes(AppState, (d) => {
    for (const id of ['root', 'w1']) if (d.nodes[id]) setExpanded(d, id, true);
    if (d.nodes.c1) { setExpanded(d, 'c1', true); setNodePage(d, 'c1', 2); }
});
eq(pageOf(AppState, 'c1'), 2, '（前提）摆好了：c1 停在第 2 页');
AppState.currentTab = 'main';
AppState.currentPageId = 'main';

// 预置 box：本组不会发生渲染，因此它不会被清掉
const visibleBox = document.createElement('div');
visibleBox.className = 'node-box';
visibleBox.dataset.id = 'p3';
document.getElementById('tree-body').appendChild(visibleBox);

const okScroll = await revealNode('p3');
eq(okScroll, true, '无需变更时定位成功');
eq(visibleBox.scrollCalls && visibleBox.scrollCalls.length, 1, '对目标调用了 scrollIntoView');
eq(visibleBox.scrollCalls && visibleBox.scrollCalls[0].block, 'center', '滚动到视口居中');

// ===============================================================
group('定位：文件夹模式进入目标所在目录');
// ===============================================================

AppState.settings.mode.treeDisplayMode = 'folder';
AppState.currentTab = 'main';

await revealNode('p3');
eq(folder.folderCurrentId, 'c1', '进入目标所在目录（父节点 c1）');
eq(folder.getTreeDisplayMode(), 'folder', '仍处于文件夹模式');

// 目标是根的直接子节点时，应回到根目录
const w1box = document.createElement('div');
w1box.className = 'node-box';
w1box.dataset.id = 'w1';
document.getElementById('tree-body').appendChild(w1box);
await revealNode('w1');
eq(folder.folderCurrentId, null, '目标是根的子节点时回到根目录（folderCurrentId=null）');

// ===============================================================
group('高亮机制：元素被替换后自动重新高亮');
// ===============================================================

// 背景：文件夹模式会连续触发两次重渲染，若高亮只作用在"某一时刻的元素"上，
// 元素被替换后高亮就没了（树形模式只渲染一次，所以不容易暴露）。
const { markHighlighted, watchHighlight } = await import(mod('ui/revealNode.js'));

const treeBody = document.getElementById('tree-body');
const mkBox = nodeId => {
    const el = document.createElement('div');
    el.className = 'node-box';
    el.dataset.id = nodeId;
    treeBody.appendChild(el);
    return el;
};

const boxA = mkBox('h1');
eq(markHighlighted('h1'), true, '找到目标方框');
ok(boxA.classList.contains('node-revealed'), '方框带上了高亮类');
eq(markHighlighted('并不存在'), false, '目标不存在时返回 false');

// 启动看护，然后模拟"重新渲染把元素换掉"
const watcher = watchHighlight('h1', 600, 40);
boxA.remove();
const boxB = mkBox('h1');
await sleep(140);
ok(boxB.classList.contains('node-revealed'), '元素被替换后，新元素被自动重新高亮');
ok(watcher.everFound(), '看护过程记录到目标被命中过');
watcher.stop();

// ===============================================================
group('高亮机制：目标出现较晚也能命中');
// ===============================================================

const lateWatcher = watchHighlight('h2', 800, 40);
await sleep(60);
eq(document.querySelector('.node-box[data-id="h2"]'), null, '此刻目标尚未出现');
const boxLate = mkBox('h2');
await sleep(160);
ok(boxLate.classList.contains('node-revealed'), '出现后自动被高亮');
lateWatcher.stop();

// ===============================================================
group('高亮机制：到期后自动移除');
// ===============================================================

const boxC = mkBox('h3');
const shortWatcher = watchHighlight('h3', 200, 40);
ok(boxC.classList.contains('node-revealed'), '开始时已高亮');
await sleep(320);
ok(!boxC.classList.contains('node-revealed'), '到期后高亮被移除');
shortWatcher.stop();

// ===============================================================
group('定位：安全边界');
// ===============================================================

eq(await revealNode('不存在的节点'), false, '未知节点返回 false');
eq(await revealNode(''), false, '空 id 返回 false');
eq(await revealNode(null), false, 'null 返回 false');

// ===============================================================
group('★ G11：目标不在主视图时**不许误报成功**（别滚到看不见的副本上）');
// ===============================================================
// 病根：`findNodeBox` 以前是 `document.querySelector('.node-box[data-id=…]')` 取**第一个**，
// 而 `class="node-box" data-id=…` 在**别处也有**（节点详页头部那一格、AC 只读列表、
// 选节点弹窗、"当前节点"格）⇒ 目标不在当前页/祖先没展开时，会滚到一个**看不见的副本**
// 上、还 `return true`。收窄到主视图那两格（`#tree-body` / `#folder-stats`）之后：
// **主树里没有就是没有**，如实返回 false。
for (const el of [...treeBody.querySelectorAll('.node-box')]) el.remove();
AppState.settings.mode.treeDisplayMode = 'tree';
AppState.currentTab = 'main';
AppState.currentPageId = 'main';

const copyHost = document.getElementById('stats-chart-container');
const copyBox = document.createElement('div');
copyBox.className = 'node-box';
copyBox.dataset.id = 'p3';
copyHost.appendChild(copyBox);
eq(treeBody.querySelectorAll('.node-box[data-id="p3"]').length, 0, '（前提）主树里没有 p3 的方框');

eq(await revealNode('p3'), false,
    '★ 主树里找不到 ⇒ 返回 false（旧实现：命中别处那个副本 ⇒ 误报 true）');
await sleep(140);
ok(!copyBox.classList.contains('node-revealed'), '★ 副本不会被高亮（连"看着像成功了"都没有）');
copyBox.remove();

// ===============================================================
group('★ 跳转承载：点一次只派发**一颗** REVEAL_NODE（G8 双派发已修）');
// ===============================================================
// 病根：`features/AutoImport/ui/summary.js:appendPointerIssues` 原先自带一份
// `[data-reveal-node]` 委托，而 `ui/nodeinfo/nodeGroupActions.js` 那条是**文档级**的 ——
// 两个监听都在冒泡路径上、又都不 `stopPropagation` ⇒ 一次点击**两颗**事件
// （`revealNode` 跑两趟：两套高亮看护定时器）。现在只留文档级那一条。
await import(mod('ui/nodeinfo/nodeGroupActions.js'));          // app 启动时本来就装配的那一条
const { appendPointerIssues } = await import(mod('features/AutoImport/ui/summary.js'));
const issueHost = document.createElement('div');
body.appendChild(issueHost);
appendPointerIssues(issueHost, {
    synth: {
        pointers: [{ index: 1, extKey: 'qoj:c:1', synthKey: 'synth:k', nodeId: 'p1', action: 'reject', reason: '指针被拒' }]
    }
});
const issueLink = issueHost.querySelector('[data-reveal-node]');
ok(!!issueLink, '（前提）指针异常那一行画出了「🔎 跳到树上」');
const seenReveal = [];
const countReveal = e => seenReveal.push(e.detail && e.detail.nodeId);
document.addEventListener(EVENTS.REVEAL_NODE, countReveal);
issueLink.click();
eq(seenReveal.length, 1, '★ 点一次只派发一颗（旧的双派发在这里会数到 2）');
eq(seenReveal[0], 'p1', '带的是那个节点的 id');
document.removeEventListener(EVENTS.REVEAL_NODE, countReveal);
issueHost.remove();

// 切回树模式，避免影响其他断言
AppState.settings.mode.treeDisplayMode = 'tree';

// ===============================================================
group('★ 副页页内 id：切到那一页并在**页内**定位（`v9.0.17`）');
// ===============================================================
// 需求（用户 2026-10-13）：副页节点详页头部**已经**有一颗「🔎 跳到它引用的主节点」，
// 那串蓝 id 再跳主节点 = 同一件事两个入口 ⇒ 蓝字改成"跳到该副页内的对应位置"。
// 实现落在 `ui/revealNode.js`：`revealNode` 认**页内 id**（归属判据 =
// `core/ops/page.js:locateVirtualNode`）⇒ 切到它所属的副页，再页内定位。
//
// 本组验**文件夹模式**（页内视图态在 `virtualFolderMode.js` 里，桩里读得到、也断言得到）。
// ⚠️ 树模式的页内定位（展开页内祖先 + 翻 `vNode.currentPage`）在下一组验状态。
const { getVirtualState } = await import(mod('ui/folder/virtualFolderMode.js'));

const PAGE = 'pg1';
const VROOT = 'v_root';
const VC = 'v_c';          // 页内文件夹（引用主树的 vc_real）
const VT = 'v_t3';         // 页内目标（在 VC 下第 3 位 ⇒ 第 2 页）
// ⚠️ 页内 id 与上面那些夹具 id **不许重名**（桩里两页的方框住在同一对容器，
//    同名会先把旧的那个查出来 ⇒ 断言全是假绿）。
AppState.settings.mode.treeDisplayMode = 'folder';
AppState.settings.display.nodePerPage = 2;

// ⚠️ **副页里引用的主树节点必须是"真节点"**（用 `createNode` 那个唯一工厂造）：
//    副页统计（`refreshAllVirtualStats` / `view/stats.js`）会逐条读 `status1` 等字段，
//    缺字段它**抛错** ⇒ 那次事务回滚（连"切页"一起回滚），页面压根切不过去。
//    手搓 `{id,type}` 那种最小节点在这里不够用（实测踩到：
//    `[副页统计] 真实 P 节点 … 的 status1 字段缺失`）。
//    ⚠️ 也**不许借上面那些夹具节点**（`c1` / `p1`… 都是最小对象，同样缺字段）⇒ 用一套独立 id。
const { createNode } = await import(mod('core/model/node.js'));
await patchNodes(AppState, (d) => {
    // ⚠️ 主树那几个"真实节点"的 id **不许与页内 id 同名**：`revealNode` 的归属判据是
    //    "先问 `AppState.nodes`" ⇒ 同名会让页内那一个**永远走不到**（实测踩到）。
    for (const id of ['rvp_a', 'rvp_b', 'rvp_t']) d.nodes[id] = createNode(id, 'P', { name: id, problemId: id });
    d.nodes.vc_real = createNode('vc_real', 'C', { name: '页内文件夹本体' });
    d.pages[PAGE] = {
        id: PAGE,
        name: '我的题单',
        rootId: VROOT,
        virtualIndex: {
            [VROOT]: { id: VROOT, type: 'O', children: [VC], refId: null },
            [VC]: { id: VC, type: 'C', refId: 'vc_real', parentId: VROOT, children: ['vpa', 'vpb', VT] },
            vpa: { id: 'vpa', type: 'P', refId: 'rvp_a', parentId: VC, children: [], expanded: false, currentPage: 1 },
            vpb: { id: 'vpb', type: 'P', refId: 'rvp_b', parentId: VC, children: [], expanded: false, currentPage: 1 },
            [VT]: { id: VT, type: 'P', refId: 'rvp_t', parentId: VC, children: [], expanded: false, currentPage: 1 }
        },
        vNodeStats: {}
    };
});
AppState.currentTab = 'main';
AppState.currentPageId = 'main';       // 先停在主页面：这一步会验"它真的切过去了"

eq(await revealNode(VT), false,
    '★ 副页页内 id ⇒ 页面级的路走通了（桩里渲染不出页内方框 ⇒ 返回值按桩限制是 false）');
eq(AppState.nodes[VT], undefined, '（前提）页内 id **不在** `AppState.nodes` 里（投影，不是真节点）');
eq(AppState.currentPageId, PAGE, '★ 切到了**它所属的那个副页**（不是主页面）');
eq(getVirtualState(PAGE).currentId, VC, '★ 进到了它所在的**页内文件夹**（父虚拟节点 v_c）');
eq(getVirtualState(PAGE).currentPage, 2, '★ 翻到包含它的那一页（perPage=2，它在第 3 位 ⇒ 第 2 页）');
eq(getVirtualState(PAGE).view, 'children', '视图页确保是「子节点」（否则那一页画的是统计图）');

// 页内根（v_root，type 'O'）回到副页根目录：它是"这一页"本身，不画方框
//（`nodeInfoView` 也据此不给蓝字，两处判据一致）
eq(getVirtualState(PAGE).currentId, VC, '（前提）此刻停在页内文件夹 v_c 里');
eq(await revealNode(VROOT), false,
    '★ 页内**根**节点：那一页不画它的方框 ⇒ 如实返回 false（不假装成功）');
eq(getVirtualState(PAGE).currentId, null, '但它仍会把这一页带回根目录（页内根 = 那一页的根）');

// ---- 已在该页、该文件夹、该页码时：只滚动 + 高亮（不重画，因此预置的方框还在） ----
// 这一段与主树那组「无需变更时只做滚动 + 高亮」对称：桩不解析 innerHTML，
// 真实渲染出来的方框查不到 ⇒ 只能用**预置**方框验"确实滚过去了、确实高亮了"。
// ⚠️ 前提是**一次重画都不会发生**（`revealInVirtualFolderMode` 只在真的要切时才派发刷新）——
//    这正是"别白画一遍"那条改动的可执行判据。
AppState.settings.mode.treeDisplayMode = 'folder';
AppState.currentPageId = 'main';
// 目标取页内文件夹**里面的**一个（靶子是子节点、要进的是它的父文件夹）——
// 与"目标就是文件夹自己"那种情形不同：后者会让页内目录回落，`v_c` 自己也就定位不到了。
// （下面"已在正确位置 ⇒ 只滚动高亮"那一段同样用子节点当靶子。）
const VB = 'vpb';
eq(await revealNode(VB), false, '切到页内文件夹 v_c（桩里没有子节点的方框 ⇒ false）');
eq(getVirtualState(PAGE).currentId, VC, '（前提）现在停在这一页的 v_c 里');
eq(getVirtualState(PAGE).currentPage, 1, '（前提）停在第一页（`vpb` 是第 2 位 ⇒ 第 1 页）');

const vBox = document.createElement('div');
vBox.className = 'node-box';
vBox.dataset.id = VB;
document.getElementById('tree-body').appendChild(vBox);
// 预置好"方框就在页面上"的状态：进对了文件夹、也停对了页 ⇒ reveal 不需要改任何页内视图态
eq(await revealNode(VB), true, '★ 已在目标那一页/文件夹/页码 ⇒ 定位成功（不再白画一遍）');
eq(vBox.scrollCalls && vBox.scrollCalls.length, 1, '★ 对页内那个方框调用了 scrollIntoView（真定位，不是只切页）');
ok(vBox.classList.contains('node-revealed'), '★ 页内那个方框带上了高亮类');

// ===============================================================
group('★ 副页页内 id（树模式）：展开页内祖先 + 翻到它那一页');
// ===============================================================
AppState.settings.mode.treeDisplayMode = 'tree';
AppState.currentPageId = 'main';

eq(await revealNode(VT), false,
    '树模式下桩查不到页内方框（桩限制）⇒ 返回 false，但状态该写的一次不少');
const vState2 = getVirtualState(PAGE);
void vState2;
{
    const page = AppState.pages[PAGE];
    eq(page.virtualIndex[VT].currentPage, 1, '目标是叶子 ⇒ 它自己那格页码不动（要翻的是**父**那一格）');
    eq(page.virtualIndex[VC].currentPage, 2, '★ 父虚拟节点被翻到包含它的那一页（写进了页内页码）');
    eq(page.virtualIndex[VC].expanded, true, '★ 页内祖先（v_c）被展开 —— 树模式下不展开就看不见');
    eq(AppState.currentPageId, PAGE, '★ 页内 id 切到的是**它所属的副页**');
}

// ===============================================================
group('★ 判据顺序同 `findNodeBox`：先主树 id，再页内 id（同名时主树赢）');
// ===============================================================
// 用户 2026-10-13 定的顺序："**先主树那两格；找不到且该 id 属于某个副页 ⇒ 切到那个副页，
// 再只在该副页的容器里找**"。`revealNode` 的归属判据必须是**同一个顺序**，否则会出现
// "该跳主树的链接把页面切到副页去了"（同名 vNode 劫持）。
// 夹具：主树真有一个 `c1`（上面那些定位断言一直在用它）；副页里**再放**一个 id 也叫 `c1` 的 vNode。
await patchNodes(AppState, (d) => {
    d.pages[PAGE].virtualIndex.c1 = {
        id: 'c1', type: 'C', refId: 'vc_real', parentId: VROOT, children: [], expanded: false, currentPage: 1
    };
    d.pages[PAGE].virtualIndex[VROOT].children.push('c1');
});
AppState.currentPageId = PAGE;
AppState.settings.mode.treeDisplayMode = 'folder';
const vCurrentBefore = getVirtualState(PAGE).currentId;

eq(await revealNode('c1'), false,
    '主树那一支走的是老路（桩里没有 `c1` 的方框 ⇒ 返回值按桩限制是 false）');
eq(AppState.currentPageId, 'main', '★ 切回的是**主页面**（同名 vNode 不许把页面劫持到副页）');
eq(folder.folderCurrentId, 'w1', '★ 主树定位照旧：进到它所在的目录（`c1` 的父 = w1）');
// ⚠️ 别拿"等于 null"断言 —— 这里要的是**主树那一支根本没碰过它**（值原样不变）。
eq(getVirtualState(PAGE).currentId, vCurrentBefore, '★ 页内视图态**一个字没动**（主树那一支与副页无关）');
// ⚠️ 这条**桩里造不出来**：桩不解析 innerHTML、预置的方框会被渲染清掉 ⇒ 只能钉源码。
const srcReveal = fs.readFileSync(path.join(SRC, 'ui', 'revealNode.js'), 'utf8').replace(/\/\/.*$/gm, '');
ok(/AppState\.nodes\[id\] \? null : locateVirtualNode\(AppState, id\)/.test(srcReveal),
    '★ 源码级：归属判据是"**先主树**（`AppState.nodes`）、再副页（`locateVirtualNode`）"，'
    + '与 `findNodeBox` 那条搜索顺序同序');

// 切回树模式，避免影响其他断言
AppState.settings.mode.treeDisplayMode = 'tree';

report();
