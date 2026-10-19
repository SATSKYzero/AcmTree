// ================================================================
// 冒烟测试：「折叠全部」按钮 ui/buttons.js（scripts/smoke/collapse-all.smoke.mjs）
//
// 与 `settings-page.smoke.mjs` 的 ⑬ 组**不重叠**（那份测的是**树模式**分支：清 `view.expanded`
// 与 `virtualIndex[*].expanded`）；这里补的是**文件夹模式**分支 + 刷新次数，两处合起来才等于"这颗按钮全覆盖"。
//
// 为什么有这一份（两个真实踩过的坑，缺一个都不成立）：
//   ① **文件夹模式那条分支从没被点过** ⇒ 只被它用到的 import 漏了也全绿
//      （`v9.0.20`：`goToVirtualRoot` 没 import —— 树模式那组照样通过，CI 全绿，
//      浏览器里按 Ctrl 点了没反应）。本文件真的点一下，那条分支断了当场红。
//   ② **回根的刷新次数**：`goToVirtualRoot(pageId)` 每调一次派发一次
//      `UI_REFRESH_REQUIRED`，早先「折叠全部 + Ctrl」是在循环里逐个调
//      ⇒ **1 + 副页数** 次重画（页越多越慢，而且是同一个可见页被重复重画）。
//      现在要求：主树 + 所有副页**合并成一次**。判据就是下面的 `eq(refreshes, 1)` ——
//      回到"循环调"的写法这条必红。
//
// ⚠️ 覆盖边界：这里是 DOM 桩，`innerHTML` 不解析 ⇒ 只断言**状态与派发次数**，
//    "画出来长什么样"仍需在浏览器里点一次（本文件不假装覆盖了那个）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ---------------------------------------------------------------
// 1. 先装 DOM 桩（必须在 import 被测模块之前）
// ---------------------------------------------------------------
const body = installDom();
const app = makeContainer(body, 'app');
// 这几个容器是 `installDom` 之后"刷新一次"会走到的地方（与 reveal-node 冒烟同一套镜像）
makeContainer(app, 'tab-bar');
makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'folder-breadcrumb');
makeContainer(app, 'folder-stats');
makeContainer(app, 'tab-main');
// ⚠️ `#toast` 是**必须**的：没有它 `showToast` 自己会抛，真错误反而被吞掉
makeContainer(app, 'toast');
// 被测的那颗按钮（`bindUIButtons` 按 id 取）
const btn = makeContainer(app, 'btn-collapse-all');

globalThis.fetch = async () => ({ ok: true, json: async () => ({ plugins: [] }) });

// ---------------------------------------------------------------
// 2. 动态 import 被测模块
// ---------------------------------------------------------------
const { AppState, replaceState } = await import(mod('shell/state.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const eventBridge = await import(mod('ui/eventBridge.js'));
const folder = await import(mod('ui/folder/folderMode.js'));
const vfm = await import(mod('ui/folder/virtualFolderMode.js'));
// ★ 这一步就是坑①的守卫：import 失败 / `bindUIButtons` 里引用了没 import 的东西 → 当场炸
const { bindUIButtons } = await import(mod('ui/buttons.js'));

eventBridge.registerAllEvents();

// ---- 造数据：主树 w1 里有一道题；两个副页各有一个子节点 ----
const N = (id, type, extra = {}) => ({ id, type, name: id, expanded: false, ...extra });
const nodes = {
    root: N('root', 'O', { name: '根' }),
    w1: N('w1', 'W', { name: 'CF' }),
    c1: N('c1', 'C', { name: 'Round 900' }),
    p1: N('p1', 'P', { name: 'A题', problemId: 'A' })
};
const vnode = (id, parentId) => ({ id, parentId, type: 'C', children: [], refId: null });

replaceState({
    rootId: 'root',
    nodes,
    parentOf: { root: null, w1: 'root', c1: 'w1', p1: 'c1' },
    childOrder: { root: ['w1'], w1: ['c1'], c1: ['p1'], p1: [] },
    pages: {
        pA: { name: '测试页A', rootId: 'vA0', virtualIndex: { vA0: vnode('vA0', null), vA1: vnode('vA1', 'vA0') } },
        pB: { name: '测试页B', rootId: 'vB0', virtualIndex: { vB0: vnode('vB0', null), vB1: vnode('vB1', 'vB0') } }
    },
    currentPageId: 'main',
    settings: {
        display: { nodePerPage: 50 },
        mode: { treeDisplayMode: 'folder', editMode: 'attribute' },
        performance: { historySteps: 25, expandedNodeBlockLimit: 9999 }
    },
    meta: { idCounter: 10 },
    currentTab: 'main'
});

bindUIButtons();

// ---- 数 `UI_REFRESH_REQUIRED`（本文件的核心判据） ----
let refreshes = 0;
document.addEventListener(EVENTS.UI_REFRESH_REQUIRED, () => { refreshes++; });

/** 把三处导航都摆成"进了文件夹里面"，然后清掉布置阶段派发的刷新计数 */
function setupInside() {
    AppState.settings.mode.treeDisplayMode = 'folder';
    folder.enterFolder('w1');
    vfm.enterVirtualFolder('vA1', 'pA');
    vfm.enterVirtualFolder('vB1', 'pB');
    refreshes = 0;
}

// ===============================================================
group('文件夹模式「折叠全部 + Ctrl」：主树 + 所有副页合并成一次刷新');
// ===============================================================
AppState.currentPageId = 'main';
setupInside();
// 前提锚：不锚的话"布置失败 ⇒ 后面断言看不出区别"（例如 enterFolder 早退）
eq(folder.folderCurrentId, 'w1', '（前提）主树先停在 w1 里');
eq(vfm.getVirtualState('pA').currentId, 'vA1', '（前提）副页 pA 先停在 vA1 里');
eq(vfm.getVirtualState('pB').currentId, 'vB1', '（前提）副页 pB 先停在 vB1 里');

btn.dispatchEvent({ type: 'click', ctrlKey: true });
eq(refreshes, 1, '恰好 1 次 UI_REFRESH_REQUIRED（改回"循环逐个回根"这里就是 3）');
eq(folder.folderCurrentId, null, '主树回到根目录');
eq(vfm.getVirtualState('pA').currentId, null, '副页 pA 回到根');
eq(vfm.getVirtualState('pB').currentId, null, '副页 pB 回到根');
eq(vfm.getVirtualState('pA').currentPage, 1, '副页 pA 页码也回 1');

// ===============================================================
group('文件夹模式「折叠全部」（不带 Ctrl）：只回当前页');
// ===============================================================
AppState.currentPageId = 'pA';
setupInside();
btn.dispatchEvent({ type: 'click' });
eq(refreshes, 1, '恰好 1 次刷新（单页本来就只该一次）');
eq(vfm.getVirtualState('pA').currentId, null, '当前页 pA 回到根');
eq(vfm.getVirtualState('pB').currentId, 'vB1', '别的副页不受影响（仍在 vB1 里）');
eq(folder.folderCurrentId, 'w1', '主树也不受影响（仍在 w1 里）');

// ===============================================================
group('文件夹模式「折叠全部」（不带 Ctrl）· 当前页就是主树：只回主树根');
// ===============================================================
// 这一组补的是**唯一还没被任何测试执行过的那条分支**：不带 Ctrl 且 `currentPageId === 'main'`
// ⇒ 走 `goToRootFolder()` 单个口（上一组走的是 `goToVirtualRoot(curPageId)`，⑬ 组走的是树模式那两支）。
AppState.currentPageId = 'main';
setupInside();
btn.dispatchEvent({ type: 'click' });
eq(refreshes, 1, '恰好 1 次刷新');
eq(folder.folderCurrentId, null, '主树回到根目录');
eq(vfm.getVirtualState('pA').currentId, 'vA1', '副页不受影响（仍在 vA1 里）');
eq(vfm.getVirtualState('pB').currentId, 'vB1', '另一张副页也不受影响');

report();
