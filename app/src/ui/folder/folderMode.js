// ================================================================
// 文件夹模式（ui/folderMode.js）
// 职责：主页的树形/文件夹模式切换、文件夹导航、主页渲染
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import {
    getGlobalStatsSoon,
    updateInfoBar,
    getChildNodes
} from '../../view/index.js';
import { getDisplayData } from '../../view/dataAdapter.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, nowMs, msSince } from '../../utils/diag.js';
import { renderNode } from '../../view/renderers.js';
import { showToast } from '../G_modal/G_modals.js';
import { getCurrentTab } from '../tabs.js';
import { EVENTS } from '../../A_constants.js';

import {
    buildBreadcrumbHTML,
    bindBreadcrumbEvents,
    buildStatsSubTabsHTML,
    bindStatsSubTabEvents,
    resetViewContainers,
    applyTreeLayout,
    applyFolderLayout,
    paintStatsNumbers,
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
// 模块级 UI 状态
// ================================================================
export let folderCurrentId = null;
export let folderPath = [];
export let folderCurrentPage = 1;
export let folderView = 'children';   // 内置 'children' | 'stats'，或插件注册的视图 id

// ================================================================
// 内置节点视图（与插件视图同构，只是不经注册表）
// 契约：{ id, label, order, mount(ctx), unmount?(ctx) }
// ================================================================

/**
 * 异步调用统计图渲染，避免 folderMode 顶层依赖 statsCharts
 * @param {string} [containerId] - 画到哪个容器；节点信息大界面会传自己的容器
 */
function renderStatsChartAsync(state, root, chartType, containerId = 'stats-chart-container') {
    import('../stats/statsCharts.js').then(module => {
        module.renderStatsChart(state, root, chartType, null, containerId);
    });
}

/** 内置视图：子节点列表 */
function mountChildrenView(ctx) {
    const { state, folderData, treeBody, statsContainer, treeBodyId = 'tree-body' } = ctx;

    // 只清**本宿主**的统计子栏：这个 id 也是每个宿主一份，否则节点信息大界面一切子视图
    // 就会把主视图文件夹页的 XCPC/CF 子栏删掉（"开关它不影响别的页"）
    const subTabsWrapper = document.getElementById(ctx.subTabsId || 'stats-sub-tabs-wrapper');
    if (subTabsWrapper) subTabsWrapper.remove();
    if (statsContainer) {
        statsContainer.style.display = 'none';
        statsContainer.innerHTML = '';
    }
    if (treeBody) treeBody.style.display = 'block';

    if (folderData && folderData.type === 'list') {
        renderFolderView(state, folderData, treeBodyId);
    } else if (treeBody) {
        treeBody.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><p>该目录下没有内容</p></div>`;
    }

    // 点击进文件夹是**主视图**的行为；节点信息大界面是只读观察，不挂这个处理器
    if (typeof ctx.bindFolderClicks === 'function') ctx.bindFolderClicks();
}

/** 内置视图：题目分布统计 */
function mountStatsView(ctx) {
    const { state, nodeId, node, treeBody, statsContainer, viewTabsContainer,
            statsContainerId = 'stats-chart-container' } = ctx;

    // ★ 副页节点：交**节点对象**（页内 id 在 `state.nodes` 里查不到）—— 节点集合由
    //   `collectPNodes` 在**它的页内子树**上走（投影节点走 `children`）；主树照旧按 id 走。
    const root = (node && node._virtual) ? node : nodeId;

    if (treeBody) treeBody.style.display = 'none';
    if (!statsContainer) return;

    statsContainer.style.display = 'block';

    if (viewTabsContainer) {
        const subTabsWrapper = document.createElement('div');
        subTabsWrapper.id = ctx.subTabsId || 'stats-sub-tabs-wrapper';
        viewTabsContainer.after(subTabsWrapper);
        subTabsWrapper.innerHTML = buildStatsSubTabsHTML('xcpc');
        bindStatsSubTabEvents(subTabsWrapper, (chartType) => {
            renderStatsChartAsync(state, root, chartType, statsContainerId);
        });
    }

    renderStatsChartAsync(state, root, 'xcpc', statsContainerId);
}

const BUILTIN_FOLDER_VIEWS = [
    { id: 'children', label: '📂 子节点', order: 0, mount: mountChildrenView },
    { id: 'stats', label: '📊 题目分布统计', order: 10, mount: mountStatsView }
];

/**
 * 取「内置 + 插件」合并后的视图列表
 *
 * 导出是给**节点信息大界面**用的：它就是"把文件夹模式那层 tab 全搬过去"，
 * 所以两处必须是同一份清单（同一个视图定义、同一份挂载契约）。
 * @returns {Array<Object>}
 */
export function getFolderViews() {
    return resolveFolderViews(BUILTIN_FOLDER_VIEWS, getPluginFolderViews());
}

// ================================================================
// 编辑模式
// ================================================================
export function getEditMode() {
    return AppState.settings.mode.editMode || 'attribute';
}

export async function setEditMode(mode) {
    if (mode !== 'attribute' && mode !== 'selection') return;
    await execute(
        (draft) => { draft.settings.mode.editMode = mode; },
        { skipHistory: true, validate: false }
    );
}

// ================================================================
// 渲染模式
// ================================================================
export function getTreeDisplayMode() {
    return AppState.settings.mode.treeDisplayMode || 'tree';
}

// ================================================================
// 面包屑路径
// ================================================================
export function rebuildFolderPath(nodeId) {
    folderPath = [];
    if (!nodeId) {
        const root = AppState.nodes[AppState.rootId];
        if (root) folderPath = [root];
        return;
    }
    const path = [];
    let currentId = nodeId;
    while (currentId) {
        const node = AppState.nodes[currentId];
        if (!node) break;
        path.unshift(node);
        currentId = AppState.parentOf[currentId] ?? null;
    }
    const root = AppState.nodes[AppState.rootId];
    if (root && (!path.length || path[0].id !== root.id)) {
        path.unshift(root);
    }
    folderPath = path;
}

// ================================================================
// 导航
// ================================================================
export function enterFolder(nodeId) {
    const node = AppState.nodes[nodeId];
    if (!node) {
        showToast('节点不存在', 'error');
        return;
    }
    if (node.type === 'R') {
        showToast('提交记录不能作为文件夹', 'info');
        return;
    }
    folderCurrentId = nodeId;
    rebuildFolderPath(nodeId);
    folderCurrentPage = 1;
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

export function goToParentFolder() {
    if (folderPath.length <= 1) {
        folderCurrentId = null;
        folderPath = [];
        folderCurrentPage = 1;
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        return;
    }
    const parent = folderPath[folderPath.length - 2];
    folderCurrentId = parent.id;
    rebuildFolderPath(parent.id);
    folderCurrentPage = 1;
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

/**
 * 回到主树根目录。
 *
 * @param {{refresh?: boolean}} [opts] `refresh:false` ⇒ 只写状态、不派发刷新
 *        （批量场景用：要与副页**合并成同一次**重画时，见 `ui/buttons.js` 的「折叠全部 + Ctrl」）
 */
export function goToRootFolder(opts = {}) {
    const refresh = opts.refresh === undefined ? true : !!opts.refresh;
    folderCurrentId = null;
    folderPath = [];
    folderCurrentPage = 1;
    if (refresh) document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

export function getFolderChildren() {
    if (!folderCurrentId) {
        const root = AppState.nodes[AppState.rootId];
        if (!root) return [];
        return getChildNodes(AppState, root);
    }
    const parent = AppState.nodes[folderCurrentId];
    if (!parent) return [];
    return getChildNodes(AppState, parent);
}

export function getFolderCurrentPage() {
    return folderCurrentPage;
}

export function setFolderCurrentPage(page) {
    if (page < 1) page = 1;
    folderCurrentPage = page;
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
}

export function switchFolderView(view) {
    // 内置与插件视图一视同仁：只要在合并列表里就允许切换
    if (!getFolderViews().some(def => def.id === view)) return;
    folderView = view;
    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));

    if (view === 'stats') {
        // 立即反馈，不等整体刷新完成
        const nodeId = folderCurrentId || AppState.rootId;
        const currentChart = document.querySelector('.stats-sub-tab-btn.active')?.dataset.chart || 'xcpc';
        renderStatsChartAsync(AppState, nodeId, currentChart);
    }
}

// ================================================================
// 面包屑 & 视图 Tab
// ================================================================
export function renderFolderBreadcrumb() {
    const container = document.getElementById('folder-breadcrumb');
    if (!container) return;

    const mode = getTreeDisplayMode();
    if (mode !== 'folder') {
        container.innerHTML = '';
        return;
    }

    if (folderPath.length === 0) {
        const root = AppState.nodes[AppState.rootId];
        if (root) folderPath = [root];
    }

    const html = buildBreadcrumbHTML(folderPath, {
        getDisplayName: (node) => {
            if (node.type === 'O') return '🏠 根目录';
            return node.name || node.problemId || node.id || '未命名';
        },
        onNavigate: (id) => {
            const node = AppState.nodes[id];
            if (node && node.type === 'O') {
                goToRootFolder();
            } else {
                folderCurrentId = id;
                rebuildFolderPath(id);
                document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
            }
        },
        rootLabel: '🏠 根目录'
    });

    container.innerHTML = html;
    bindBreadcrumbEvents(container, (id) => {
        const node = AppState.nodes[id];
        if (node && node.type === 'O') {
            goToRootFolder();
        } else {
            folderCurrentId = id;
            rebuildFolderPath(id);
            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        }
    });
}

/** 构造传给视图 mount 的上下文 */
function buildFolderViewContext(folderData) {
    const currentNode = folderCurrentId
        ? AppState.nodes[folderCurrentId]
        : AppState.nodes[AppState.rootId];
    const isRoot = !folderCurrentId || (currentNode && currentNode.type === 'O');

    return {
        source: 'real',
        state: AppState,
        pageId: 'main',
        nodeId: folderCurrentId || AppState.rootId,
        node: currentNode || null,
        isRoot,
        folderData: folderData || null,
        // 内置视图渲染到哪：默认是主视图那套容器；节点信息大界面会换成自己那套
        treeBodyId: 'tree-body',
        statsContainerId: 'stats-chart-container',
        // 进文件夹的点击行为是主视图专有的，大界面不传（只读观察）
        bindFolderClicks: setupFolderClickEvents,
        treeBody: document.getElementById('tree-body'),
        statsContainer: document.getElementById('stats-chart-container'),
        viewTabsContainer: document.getElementById('folder-view-tabs'),
        refresh: () => document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED))
    };
}

export function renderFolderViewTabs(folderData) {
    const container = document.getElementById('folder-view-tabs');
    if (!container) return;

    const mode = getTreeDisplayMode();
    const statsContainer = document.getElementById('stats-chart-container');
    const views = getFolderViews();

    if (mode !== 'folder') {
        container.innerHTML = '';
        const statsSubTabs = document.getElementById('stats-sub-tabs-wrapper');
        if (statsSubTabs) statsSubTabs.remove();
        if (statsContainer) {
            statsContainer.style.display = 'none';
            statsContainer.innerHTML = '';
        }
        // 注意：插件页面板的收起**不在这里**。
        // renderTree() 在树形分支里提前 return，压根走不到本函数，
        // 所以把收起逻辑写在这儿是死代码（曾这么错过一次）。
        // 正确位置是 folderShared.js 的 resetViewContainers()——两种模式的公共重置点。
        return;
    }

    const requested = folderView || 'children';
    // 视图可能已被插件移除或持久化的是旧 id，回退到第一个可用视图
    const currentView = views.some(def => def.id === requested)
        ? requested
        : (views[0] ? views[0].id : requested);
    folderView = currentView;

    renderViewTabs({
        containerId: 'folder-view-tabs',
        currentView,
        views,
        onSwitch: switchFolderView
    });

    mountFolderView({
        views,
        viewId: currentView,
        ctx: buildFolderViewContext(folderData)
    });
}

// ================================================================
// 文件夹点击事件
// ================================================================
let folderClickHandlerBound = false;

function folderClickHandler(e) {
    const mode = getTreeDisplayMode();
    if (mode !== 'folder') return;
    if (e.ctrlKey) return;
    if (e.target.closest('.btn-icon, .toggle-btn, .pagination-btn, .btn, .file-input-wrapper, input, select, label')) return;

    const box = e.target.closest('.node-box');
    if (!box) return;
    const id = box.dataset.id;
    if (!id) return;

    const node = AppState.nodes[id];
    if (!node) return;
    if (node.type === 'R') {
        showToast('提交记录不能作为文件夹', 'info');
        return;
    }
    if (node.type === 'O') {
        goToRootFolder();
        return;
    }
    enterFolder(id);
}

export function setupFolderClickEvents() {
    const container = document.getElementById('tree-body');
    if (!container) return;
    if (folderClickHandlerBound) {
        container.removeEventListener('click', folderClickHandler);
    }
    container.addEventListener('click', folderClickHandler);
    folderClickHandlerBound = true;
}

// ================================================================
// 容器初始化
// ================================================================
export function ensureContainers() {
    let treeContainer = document.getElementById('tree-container');
    if (!treeContainer) {
        treeContainer = document.createElement('div');
        treeContainer.id = 'tree-container';
        const tabMain = document.getElementById('tab-main');
        if (tabMain) {
            const viewTabs = document.getElementById('folder-view-tabs');
            if (viewTabs) {
                viewTabs.after(treeContainer);
            } else {
                tabMain.appendChild(treeContainer);
            }
        }
    }

    let treeStats = document.getElementById('tree-stats');
    if (!treeStats) {
        treeStats = document.createElement('div');
        treeStats.id = 'tree-stats';
        treeStats.className = 'app-stats';
        treeStats.style.display = 'block';
        treeContainer.prepend(treeStats);
    }

    let treeBody = document.getElementById('tree-body');
    if (!treeBody) {
        treeBody = document.createElement('div');
        treeBody.id = 'tree-body';
        treeContainer.appendChild(treeBody);
    }

    let statsContainer = document.getElementById('stats-chart-container');
    if (!statsContainer) {
        statsContainer = document.createElement('div');
        statsContainer.id = 'stats-chart-container';
        statsContainer.style.display = 'none';
        treeContainer.appendChild(statsContainer);
    }

    if (!document.getElementById('folder-stats')) {
        console.warn('ensureContainers: #folder-stats 不存在，请检查 index.html');
    }
}

// ================================================================
// 主渲染函数
// ================================================================
export function renderTree(opts = {}) {
    const state = AppState;
    const mode = getTreeDisplayMode();
    const treeBody = document.getElementById('tree-body');
    // 诊断（2026-10-18：主树启动那 640ms 到底花在哪）—— 开关在 `utils/diag.js`，默认关。
    const _t0 = nowMs();
    const _lap = (n) => diag('主页', `${n} = ${msSince(_t0)}ms（累计）`);

    const data = getDisplayData(state, {
        mode: 'tree',
        pageId: 'main',
        folderCurrentId,
        folderCurrentPage
    });
    _lap('投影 getDisplayData');

    resetViewContainers();
    _lap('resetViewContainers');

    if (mode === 'tree') {
        // ★ 统计**先画上一次那串**，一拍之后再算准（`getGlobalStatsSoon`）
        //   —— 整表扫好几趟算出来的两串数字，不该卡住「点一下」的响应。
        const stats = getGlobalStatsSoon(state, paintStatsNumbers);
        _lap('总览统计 getGlobalStatsSoon');
        applyTreeLayout({
            statsContent: `<span>${stats.cStr}</span><span>${stats.pStr}</span>`,
            showStatsRow: true,
            showActionBtn: true,
            // ★ 根那一格的 📋（`v9.1.19`）：树模式下根同样不画方框 ⇒ 不传就永远打不开它的详页。
            rootInfo: state.rootId ? { id: state.rootId, title: '超级根的详细节点信息' } : null
        });
        _lap('applyTreeLayout（含计划栏）');

        if (data.type === 'tree') {
            renderTreeView(state, data, 'tree-body');
        } else {
            treeBody.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>还没有任何节点，点击右上方「添加根节点」按钮开始构建</p></div>`;
        }
        _lap('renderTreeView');
        updateInfoBar(state);
        _lap('updateInfoBar');
        return;
    }

    // ---- 文件夹模式 ----
    applyFolderLayout();

    const currentNode = folderCurrentId
        ? state.nodes[folderCurrentId]
        : state.nodes[state.rootId];
    const isRoot = !folderCurrentId || (currentNode && currentNode.type === 'O');

    const folderData = getDisplayData(state, {
        mode: 'folder',
        pageId: 'main',
        folderCurrentId,
        folderCurrentPage
    });

    // 根节点的总览统计同样"先画旧数、一拍后再算准"（理由见上面树模式那段）
    const stats = isRoot ? getGlobalStatsSoon(state, paintStatsNumbers) : null;
    renderFolderStatsComponent({
        state,
        stats,
        node: isRoot ? null : currentNode,
        isRoot,
        // ★ 超级根自己的详页入口（`v9.1.18`）：它没有方框 ⇒ 不传这个就永远打不开它的详页。
        //   ⚠️ 传的是**主树根节点 id**（`state.rootId`），与 `folderCurrentId` 无关 ——
        //      `folderCurrentId` 指的是"我现在进到哪一层"，根那一格两种情况都该给同一个入口。
        rootInfo: isRoot && state.rootId
            ? { id: state.rootId, title: '超级根的详细节点信息' } : null,
        // ★ 与**子节点同一套**（用户 2026-10-07）：这一格就是"文件夹模式所选节点"，
        //   除了"不能左键单击"（那件事本来就不在这一格上，见 `folderShared.js` 那段注释），
        //   UI 与行为都跟列表里的子节点一致（⬆/⬇ 由 `isCurrentFolder` 自动摘掉）。
        mode: 'folder',
        showAddBtn: isRoot
    });

    renderFolderBreadcrumb();
    // 视图 Tab 与当前视图内容：内置页与插件页统一由宿主挂载
    renderFolderViewTabs(folderData);

    updateInfoBar(state);
}

// ================================================================
// 切换渲染模式
// ================================================================
export async function switchDisplayMode(mode) {
    if (mode !== 'tree' && mode !== 'folder') return;

    await execute(
        (draft) => { draft.settings.mode.treeDisplayMode = mode; },
        {
            validate: false,
            refreshParentId: null,
            onSuccess: () => {
                if (mode === 'folder') {
                    folderCurrentId = null;
                    folderPath = [];
                    folderView = 'children';
                    folderCurrentPage = 1;
                    const root = AppState.nodes[AppState.rootId];
                    if (root) folderPath = [root];
                }
                document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
                showToast(`已切换到 ${mode === 'tree' ? '树形' : '文件夹'} 模式`, 'success');
            },
            onError: (err) => {
                showToast('切换模式失败: ' + err.message, 'error');
            }
        }
    );
}

// ================================================================
// 监听设置变更
// ================================================================
export function setupModeChangeListener() {
    document.addEventListener('settings-saved', () => {
        const mode = getTreeDisplayMode();
        if (getCurrentTab() === 'main') {
            if (mode === 'folder') {
                folderCurrentId = null;
                folderPath = [];
                folderView = 'children';
                const root = AppState.nodes[AppState.rootId];
                if (root) folderPath = [root];
            }
            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        }
    });
}

// ================================================================
// 重置文件夹状态
// ================================================================
export function resetFolderStateIfInvalid() {
    if (getTreeDisplayMode() !== 'folder') return;
    if (folderCurrentId) {
        const node = AppState.nodes[folderCurrentId];
        if (!node) {
            folderCurrentId = null;
            folderPath = [];
            folderView = 'children';
            folderCurrentPage = 1;
            const root = AppState.nodes[AppState.rootId];
            if (root) folderPath = [root];
            document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        }
    }
}