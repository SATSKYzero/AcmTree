// ================================================================
// 虚拟文件夹模式（ui/virtualFolderMode.js）
// 职责：副页的树形/文件夹双模式渲染 + 导航
// 依赖：shell/, view/, ui/folderShared.js, ui/folderMode.js,
//       ui/statsCharts.js, view/viewRenderers.js, A_constants.js
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import {
    updateInfoBar,
    getVirtualGlobalStats,
    getChildNodes
} from '../../view/index.js';
import { getDisplayData } from '../../view/dataAdapter.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../../utils/diag.js';
/**
 * 副页渲染缓存的键（2026-10-18）。**必须把所有影响输出的东西都放进来**：
 *   数据代（`nodes` 引用 —— 主页一改就变）、页对象、视图态、显示设置、账户/trust/字段注册表、
 *  "以谁的身份看"（`viewingAccountId`/`currentAccountId`）、页 id、显示模式、编辑模式。
 * 只用**引用身份**（`refIdOf` 给每个对象发一个递增号），所以拼键是 O(1)，不扫数据。
 */
const REF_IDS = new WeakMap();
let REF_SEQ = 0;
function refIdOf(v) {
    if (!v || typeof v !== 'object') return String(v);
    let id = REF_IDS.get(v);
    if (id === undefined) { id = ++REF_SEQ; REF_IDS.set(v, id); }
    return id;
}
function pageRenderKey(state, pageId, mode, editMode) {
    return [
        pageId, mode, editMode,
        refIdOf(state.nodes), refIdOf((state.pages || {})[pageId]), refIdOf(state.view),
        refIdOf(state.settings), refIdOf(state.accounts), refIdOf(state.trust),
        refIdOf(state.fieldRegistry), refIdOf(state.sources),
        state.viewingAccountId, state.currentAccountId
    ].join('|');
}
import { showToast } from '../G_modal/G_modals.js';
import { getTreeDisplayMode, getEditMode } from './folderMode.js';
import { renderStatsChart } from '../stats/statsCharts.js';
import { EVENTS } from '../../A_constants.js';

import {
    buildBreadcrumbHTML,
    bindBreadcrumbEvents,
    buildStatsSubTabsHTML,
    bindStatsSubTabEvents,
    resetViewContainers,
    applyTreeLayout,
    applyFolderLayout,
    renderFolderStatsComponent
} from './folderShared.js';
import { renderTreeView, renderFolderView } from '../../view/viewRenderers.js';
import { getPluginFolderViews } from '../../core/pluginRegistry.js';
import {
    resolveFolderViews,
    renderViewTabs,
    mountFolderView
} from './folderViewHost.js';

// ================================================================
// 模块级 UI 状态（按 pageId 存储）
// ================================================================
const virtualFolderState = {};  // pageId -> { currentId, path, view, currentPage }

function getVirtualState(pageId) {
    if (!virtualFolderState[pageId]) {
        virtualFolderState[pageId] = {
            currentId: null,
            path: [],
            view: 'children',
            currentPage: 1
        };
    }
    return virtualFolderState[pageId];
}

function saveVirtualState(pageId, state) {
    virtualFolderState[pageId] = state;
}

export { getVirtualState };

// ================================================================
// 虚拟子节点工具
// ================================================================

function collectVirtualPNodes(pageId, virtualId) {
    const page = AppState.pages[pageId];
    if (!page) return [];

    const startId = virtualId || page.rootId;
    const startVNode = page.virtualIndex[startId];
    if (!startVNode) return [];

    const realIds = [];
    (function walk(vid) {
        const v = page.virtualIndex[vid];
        if (!v) return;
        if (v.refId) realIds.push(v.refId);
        for (const cid of (v.children || [])) walk(cid);
    })(startId);

    const pNodes = [];
    for (const id of realIds) {
        const node = AppState.nodes[id];
        if (node && node.type === 'P') pNodes.push(node);
    }
    return pNodes;
}

function getVirtualChildren(pageId, virtualId) {
    const page = AppState.pages[pageId];
    if (!page) return [];
    const targetId = virtualId || page.rootId;
    const vNode = page.virtualIndex[targetId];
    if (!vNode) return [];
    return vNode.children.map(id => page.virtualIndex[id]).filter(Boolean);
}

function rebuildVirtualPath(pageId, virtualId) {
    const state = getVirtualState(pageId);
    const page = AppState.pages[pageId];
    if (!page) return;

    const path = [];
    if (!virtualId) {
        const rootNode = page.virtualIndex[page.rootId];
        if (rootNode) path.push(rootNode);
        state.path = path;
        saveVirtualState(pageId, state);
        return;
    }

    let currentId = virtualId;
    while (currentId) {
        const node = page.virtualIndex[currentId];
        if (!node) break;
        path.unshift(node);
        currentId = node.parentId;
    }

    const rootNode = page.virtualIndex[page.rootId];
    if (rootNode && (!path.length || path[0].id !== rootNode.id)) {
        path.unshift(rootNode);
    }

    state.path = path;
    saveVirtualState(pageId, state);
}

// ================================================================
// 导航
// ================================================================
export function enterVirtualFolder(virtualId, pageId) {
    const page = AppState.pages[pageId];
    if (!page) {
        showToast('副页不存在', 'error');
        return;
    }
    const vNode = page.virtualIndex[virtualId];
    if (!vNode) {
        showToast('虚拟节点不存在', 'error');
        return;
    }
    if (vNode.type === 'R') {
        showToast('提交记录不能作为文件夹', 'info');
        return;
    }

    const state = getVirtualState(pageId);
    state.currentId = virtualId;
    state.currentPage = 1;
    rebuildVirtualPath(pageId, virtualId);
    saveVirtualState(pageId, state);

    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

/**
 * 回到这一页的根。
 *
 * @param {string} pageId
 * @param {{refresh?: boolean}} [opts] `refresh:false` ⇒ **只写状态、不派发刷新**
 *        （批量场景用：逐个刷新会变成 "N 个副页 = N 次重画"，见 `goToAllVirtualRoots`）
 */
export function goToVirtualRoot(pageId, opts = {}) {
    const refresh = opts.refresh === undefined ? true : !!opts.refresh;
    const state = getVirtualState(pageId);
    state.currentId = null;
    state.path = [];
    state.currentPage = 1;
    rebuildVirtualPath(pageId, null);
    saveVirtualState(pageId, state);
    if (refresh) document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

/**
 * **一次**把所有（给定）副页回到根 —— 只派发**一次**刷新。
 *
 * ⚠️ 别在循环里逐个调 `goToVirtualRoot`（每调一次派发一次 `UI_REFRESH_REQUIRED` ⇒ N 页 N 次重画；
 *    「折叠全部 + Ctrl」在文件夹模式下就是这么来的）。要分批就加到这个函数里，别在调用点自己循环。
 */
export function goToAllVirtualRoots(pageIds = []) {
    for (const pid of pageIds) goToVirtualRoot(pid, { refresh: false });
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

export function switchVirtualView(pageId, view) {
    // 内置与插件视图一视同仁
    if (!getVirtualViews().some(def => def.id === view)) return;
    const state = getVirtualState(pageId);
    state.view = view;
    saveVirtualState(pageId, state);
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

// ================================================================
// 面包屑
// ================================================================
function renderVirtualBreadcrumb(pageId) {
    const container = document.getElementById('folder-breadcrumb');
    if (!container) return;

    const mode = getTreeDisplayMode();
    if (mode !== 'folder') {
        container.innerHTML = '';
        return;
    }

    const state = getVirtualState(pageId);
    if (state.path.length === 0) {
        rebuildVirtualPath(pageId, state.currentId);
    }

    const page = AppState.pages[pageId];
    if (!page) return;

    const html = buildBreadcrumbHTML(state.path, {
        getDisplayName: (vNode) => {
            if (vNode.type === 'O') return '🏠 根目录';
            if (vNode.refId) {
                return AppState.nodes[vNode.refId]?.name || vNode.id || '未命名';
            }
            return vNode.id || '未命名';
        },
        onNavigate: (id) => {
            const vNode = AppState.pages[pageId].virtualIndex[id];
            if (vNode && vNode.type === 'O') {
                goToVirtualRoot(pageId);
            } else {
                enterVirtualFolder(id, pageId);
            }
        },
        prefixLabel: `📄 ${page.name}`
    });

    container.innerHTML = html;
    bindBreadcrumbEvents(container, (id) => {
        const vNode = AppState.pages[pageId].virtualIndex[id];
        if (vNode && vNode.type === 'O') {
            goToVirtualRoot(pageId);
        } else {
            enterVirtualFolder(id, pageId);
        }
    });
}

// ================================================================
// 内置视图（副页版，与插件视图同构）
// 契约：{ id, label, order, mount(ctx), unmount?(ctx) }
// ================================================================

/** 内置视图：子节点列表 */
function mountVirtualChildrenView(ctx) {
    const { state, pageId, folderData, treeBody, statsContainer } = ctx;

    const wrapper = document.getElementById('stats-sub-tabs-wrapper');
    if (wrapper) wrapper.remove();
    const legacySubTabs = document.getElementById('stats-sub-tabs');
    if (legacySubTabs) legacySubTabs.remove();
    if (statsContainer) {
        statsContainer.style.display = 'none';
        statsContainer.innerHTML = '';
    }
    if (treeBody) treeBody.style.display = 'block';

    if (folderData && folderData.type === 'list') {
        renderFolderView(state, folderData, 'tree-body');
    } else if (treeBody) {
        treeBody.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><p>该目录下没有内容</p></div>`;
    }

    setupVirtualClickEvents();
}

/** 内置视图：题目分布统计 */
function mountVirtualStatsView(ctx) {
    const { state, pageId, treeBody, statsContainer, viewTabsContainer } = ctx;

    if (treeBody) {
        treeBody.style.display = 'none';
        treeBody.innerHTML = '';
    }
    if (statsContainer) statsContainer.style.display = 'block';

    if (viewTabsContainer) {
        const subTabsWrapper = document.createElement('div');
        subTabsWrapper.id = 'stats-sub-tabs-wrapper';
        viewTabsContainer.after(subTabsWrapper);
        subTabsWrapper.innerHTML = buildStatsSubTabsHTML('xcpc');
        bindStatsSubTabEvents(subTabsWrapper, (chartType) => {
            const vState = getVirtualState(pageId);
            const pNodes = collectVirtualPNodes(pageId, vState.currentId);
            renderStatsChart(state, null, chartType, pNodes);
        });
    }

    const vState = getVirtualState(pageId);
    const pNodes = collectVirtualPNodes(pageId, vState.currentId);
    renderStatsChart(state, null, null, pNodes);
}

const BUILTIN_VIRTUAL_VIEWS = [
    { id: 'children', label: '📂 子节点', order: 0, mount: mountVirtualChildrenView },
    { id: 'stats', label: '📊 题目分布统计', order: 10, mount: mountVirtualStatsView }
];

/** 取「内置 + 插件」合并后的视图列表 */
function getVirtualViews() {
    return resolveFolderViews(BUILTIN_VIRTUAL_VIEWS, getPluginFolderViews());
}

/** 构造传给视图 mount 的上下文 */
function buildVirtualViewContext(pageId, folderData) {
    const vState = getVirtualState(pageId);
    const page = AppState.pages[pageId];
    const currentNode = vState.currentId && page
        ? (page.virtualIndex[vState.currentId] || null)
        : null;
    const isRoot = !vState.currentId || (currentNode && currentNode.type === 'O');

    return {
        source: 'virtual',
        state: AppState,
        pageId,
        nodeId: vState.currentId || null,
        node: currentNode,
        isRoot,
        folderData: folderData || null,
        treeBody: document.getElementById('tree-body'),
        statsContainer: document.getElementById('stats-chart-container'),
        viewTabsContainer: document.getElementById('folder-view-tabs'),
        refresh: () => document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED))
    };
}

// ================================================================
// 视图 Tab
// ================================================================
function renderVirtualViewTabs(pageId, folderData) {
    const container = document.getElementById('folder-view-tabs');
    if (!container) return;

    const statsContainer = document.getElementById('stats-chart-container');
    const statsSubTabs = document.getElementById('stats-sub-tabs');

    const mode = getTreeDisplayMode();
    if (mode !== 'folder') {
        container.innerHTML = '';
        if (statsSubTabs) statsSubTabs.remove();
        if (statsContainer) {
            statsContainer.style.display = 'none';
            statsContainer.innerHTML = '';
        }
        return;
    }

    const state = getVirtualState(pageId);
    const views = getVirtualViews();
    const requested = state.view || 'children';
    const currentView = views.some(def => def.id === requested)
        ? requested
        : (views[0] ? views[0].id : requested);
    state.view = currentView;
    saveVirtualState(pageId, state);

    renderViewTabs({
        containerId: 'folder-view-tabs',
        currentView,
        views,
        onSwitch: (view) => switchVirtualView(pageId, view)
    });

    mountFolderView({
        views,
        viewId: currentView,
        ctx: buildVirtualViewContext(pageId, folderData)
    });
}

// ================================================================
// 点击事件
// ================================================================
let virtualClickHandlerBound = false;

function virtualClickHandler(e) {
    const pageId = AppState.currentPageId;
    if (pageId === 'main') return;

    const mode = getTreeDisplayMode();
    if (mode !== 'folder') return;
    if (e.ctrlKey) return;
    if (e.target.closest('.btn-icon, .toggle-btn, .pagination-btn, .btn, .file-input-wrapper, input, select, label')) return;

    const box = e.target.closest('.node-box');
    if (!box) return;
    const id = box.dataset.id;
    if (!id) return;

    const page = AppState.pages[pageId];
    if (!page) return;
    const vNode = page.virtualIndex[id];
    if (!vNode) return;

    if (vNode.type === 'R') {
        showToast('提交记录不能作为文件夹', 'info');
        return;
    }
    if (vNode.type === 'O') {
        goToVirtualRoot(pageId);
        return;
    }
    enterVirtualFolder(id, pageId);
}

function setupVirtualClickEvents() {
    const container = document.getElementById('tree-body');
    if (!container) return;
    if (virtualClickHandlerBound) {
        container.removeEventListener('click', virtualClickHandler);
    }
    container.addEventListener('click', virtualClickHandler);
    virtualClickHandlerBound = true;
}

// ================================================================
// 监听副页文件夹翻页事件
// ================================================================
document.addEventListener(EVENTS.FOLDER_PAGE_CHANGE, (e) => {
    const { pageId, delta } = e.detail || {};
    if (!pageId || pageId === 'main') return;
    const state = getVirtualState(pageId);
    const newPage = (state.currentPage || 1) + delta;
    if (newPage >= 1) {
        state.currentPage = newPage;
        saveVirtualState(pageId, state);
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
    }
});

// ================================================================
// 统一副页渲染入口
// ================================================================
//: 诊断序号（每次 `renderVirtualPage` 自增）—— 见下面那段注释：两趟混在一起时只有序号能分开
let VT_SEQ = 0;

export function renderVirtualPage(pageId) {
    const state = AppState;
    const treeBody = document.getElementById('tree-body');
    const mode = getTreeDisplayMode();
    const editMode = getEditMode();
    // 诊断（2026-10-18，用户："充足优化下副页还比主页慢是反直觉"）：把副页渲染拆段打毫秒。
    //   ⚠️ 纯日志；开关在 `utils/diag.js` 一处（`localStorage.DSH_DIAG = '1'` + 刷新）。
    //   ⚠️ 带**序号**：一趟切页里这条链可能被**再进来一次**（`refreshFn` 又会派发 `UI_REFRESH_REQUIRED`），
    //      两趟的"累计"混在一起就没法读（实测见过 "统计 538ms" 后面跟着 "计划栏 33ms" 这种不可能递减的数）
    //      ⇒ 打印 `#序号`，同一序号内的数才可比。
    const vtSeq = ++VT_SEQ;
    const vt0 = nowMs();
    const vLap = (name) => diag('副页·段', `#${vtSeq} ${name} = ${msSince(vt0)}ms（累计）`);

    resetViewContainers();
    vLap('resetViewContainers');

    if (mode === 'tree') {
        const page = state.pages[pageId];
        const stats = page ? getVirtualGlobalStats(state, page) : { cStr: 'C:00/00/00/00/00', pStr: 'P:00/00/00/00/00' };
        vLap('getVirtualGlobalStats');
        applyTreeLayout({
            statsContent: `<span>${stats.cStr}</span><span>${stats.pStr}</span>`,
            showStatsRow: true,
            showActionBtn: (editMode === 'selection'),
            // ★ 副页根的 📋（`v9.1.19`，与文件夹模式那条同一个规则）：给页内身份、**不给 data-id**。
            rootInfo: page ? { vid: page.rootId, pageId, title: '这个副页根节点的详细信息' } : null
        });
        vLap('applyTreeLayout');

        const data = getDisplayData(state, { mode: 'tree', pageId });
        vLap('getDisplayData');
        if (data.type === 'tree') {
            // ★ 副页的树 HTML **按"数据代 + 视图态"缓存**（2026-10-18）：用户报"切进副页比切进主页慢"
            //   实测切回副页 77ms、其中 72ms 是逐行重建（3000 行）。键里**必须**含 `nodes`
            //   （主页一改就换引用 ⇒ 键变 ⇒ 必重画，绝不会拿旧表）、页对象、视图态、显示设置、
            //   账户 / trust / 字段注册表（它们同样影响显示值）。
            renderTreeView(state, data, 'tree-body', pageRenderKey(state, pageId, 'tree', editMode));
            vLap('renderTreeView');
        } else {
            treeBody.innerHTML = `<div class="empty-state"><p>副页为空</p></div>`;
        }
        updateInfoBar(state);
        return;
    }

    // ---- 文件夹模式 ----
    applyFolderLayout();

    const vState = getVirtualState(pageId);
    const currentNode = vState.currentId ? state.pages[pageId].virtualIndex[vState.currentId] : null;
    const isRoot = !vState.currentId || (currentNode && currentNode.type === 'O');

    if (isRoot) {
        const page = state.pages[pageId];
        const stats = page ? getVirtualGlobalStats(state, page) : null;
        renderFolderStatsComponent({
            state,
            stats,
            isRoot,
            // ★ 副页根的详页入口（`v9.1.18`，用户"如方便，副页'根'也可以加"）：
            //   页内 `v_root` 在那一页上**不画方框**（它代表"这一页"本身）⇒ 同样没入口。
            //   ⚠️ **不给 `data-id`**（它不引用任何主树节点）⇒ 走"看哪个"时如实说
            //      "这是副页根节点…"，只列"副页节点本身"（判据见 `folderShared.js:rootInfoButton`）。
            rootInfo: page ? { vid: page.rootId, pageId, title: '这个副页根节点的详细信息' } : null,
            showAddBtn: (editMode === 'selection')
        });
    } else if (currentNode && currentNode.refId) {
        const realNode = state.nodes[currentNode.refId];
        renderFolderStatsComponent({
            state,
            node: realNode,
            isRoot: false,
            mode: 'folder-header'
        });
    } else {
        const folderStats = document.getElementById('folder-stats');
        if (folderStats) folderStats.style.display = 'none';
    }

    const addBtn = document.getElementById('btn-add-root');
    if (addBtn) addBtn.style.display = 'none';

    const breadcrumb = document.getElementById('folder-breadcrumb');
    const viewTabs = document.getElementById('folder-view-tabs');
    breadcrumb.style.display = 'block';
    viewTabs.style.display = 'block';

    if (vState.path.length === 0) {
        rebuildVirtualPath(pageId, vState.currentId);
    }

    const folderData = getDisplayData(state, {
        mode: 'folder',
        pageId,
        folderCurrentId: vState.currentId,
        folderCurrentPage: vState.currentPage
    });

    renderVirtualBreadcrumb(pageId);
    // 视图 Tab 与当前视图内容：内置页与插件页统一由宿主挂载
    renderVirtualViewTabs(pageId, folderData);

    updateInfoBar(state);
}

export { getVirtualChildren };