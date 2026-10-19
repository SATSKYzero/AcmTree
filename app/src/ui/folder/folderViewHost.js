// ================================================================
// 文件夹节点视图宿主（ui/folder/folderViewHost.js）
// 职责：
//   1. 渲染视图 Tab 栏并绑定切换
//   2. 分发到具体视图的 mount，管理插件专属面板容器
// 依赖：./folderViewRegistry.js（纯逻辑）, ./folderShared.js（Tab 样式）
//
// 设计约定：
//   - 内置视图与插件视图共用同一份接口契约，二者完全同构：
//       { id, label, order?, mount(ctx), unmount?(ctx) }
//   - 合并/排序/判重见 folderViewRegistry.js（不碰 DOM，可单测）
//   - 插件视图独占自己的面板容器 `#folder-view-panel-<id>`；
//     内置视图继续使用既有容器（#tree-body / #stats-chart-container）
//   - ctx 由调用方（folderMode / virtualFolderMode）构造，
//     宿主本身不 import 任何模式模块，避免循环依赖。
// ================================================================
import { buildViewTabsHTML, bindViewTabEvents } from './folderShared.js';
import {
    resolveFolderViews,
    pickFolderView,
    panelIdOf,
    PLUGIN_VIEW_ORDER
} from './folderViewRegistry.js';

// 供外部沿用宿主入口访问纯逻辑（避免调用方多一处 import）
export { resolveFolderViews, pickFolderView, panelIdOf, PLUGIN_VIEW_ORDER };
/** 内置视图挂载时使用的容器 id（默认宿主 = 主视图的文件夹页） */
const BUILTIN_CONTAINER_IDS = ['tree-body', 'stats-chart-container'];

// ================================================================
// 面板容器管理
// ================================================================

/**
 * 隐藏某宿主作用域下的全部插件面板
 * @param {Array<Object>} views
 * @param {string} [scope] - 宿主作用域；节点信息大界面用自己的 scope，免得隐藏到主视图的面板
 */
function hidePluginPanels(views, scope = '') {
    for (const view of views) {
        if (!view.isPlugin) continue;
        const panel = document.getElementById(panelIdOf(view.id, scope));
        if (panel) panel.style.display = 'none';
    }
}

/**
 * 收起本宿主作用域下所有插件视图面板（供离开文件夹模式时调用）
 *
 * 为什么需要导出：插件面板是**独立于内置容器**的 DOM 节点，由本模块创建。
 * 离开文件夹模式（切到树形）时，`folderMode` 只会隐藏内置容器
 * （`tree-body` / `stats-chart-container` / `folder-view-tabs`），
 * **不会**知道有插件面板存在 —— 于是它们会一直留在屏幕上
 * （实测症状：切回树形模式后插件页内容仍覆盖在树上）。
 *
 * @param {Array<Object>} [views] - 视图列表；缺省用当前已注册的全部视图
 * @param {string} [scope] - 宿主作用域，默认 ''（主视图的文件夹页）
 */
export function hideAllPluginPanels(views, scope = '') {
    const list = Array.isArray(views) ? views : resolveFolderViews([]);
    hidePluginPanels(list, scope);
}

/** 隐藏内置视图使用的容器 */
function hideBuiltinContainers(containerIds = BUILTIN_CONTAINER_IDS) {
    for (const id of containerIds) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    }
}

/**
 * 取得（必要时创建）某插件视图的面板容器
 * @param {string} viewId
 * @param {string} [hostContainerId]
 * @param {string} [scope] - 宿主作用域（见 panelIdOf）
 * @returns {HTMLElement|null}
 */
export function ensurePluginPanel(viewId, hostContainerId = 'tree-container', scope = '') {
    const id = panelIdOf(viewId, scope);
    let panel = document.getElementById(id);
    if (panel) return panel;

    const host = document.getElementById(hostContainerId)
        || document.getElementById('tab-main')
        || document.body;
    if (!host) return null;

    panel = document.createElement('div');
    panel.id = id;
    panel.className = 'folder-view-panel';
    panel.style.display = 'none';
    host.appendChild(panel);
    return panel;
}

// ================================================================
// 渲染入口
// ================================================================

/**
 * 渲染视图 Tab 栏
 * @param {Object} opts
 * @param {string} opts.containerId - Tab 栏容器 id，默认 'folder-view-tabs'
 * @param {string} opts.currentView
 * @param {Array<Object>} opts.views
 * @param {Function} opts.onSwitch - (viewId) => void
 * @returns {HTMLElement|null} Tab 栏容器
 */
export function renderViewTabs({ containerId = 'folder-view-tabs', currentView, views, onSwitch }) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    container.innerHTML = buildViewTabsHTML(currentView, views);
    bindViewTabEvents(container, (view) => {
        if (view && view !== currentView && typeof onSwitch === 'function') onSwitch(view);
    });
    return container;
}

/**
 * 挂载指定视图
 * @param {Object} opts
 * @param {Array<Object>} opts.views
 * @param {string} opts.viewId
 * @param {Object} opts.ctx - 传给 view.mount 的上下文
 * @param {string} [opts.hostContainerId] - 插件面板的父容器 id
 * @param {string} [opts.scope] - 宿主作用域（面板 id 前缀），见 panelIdOf
 * @param {Array<string>} [opts.builtinContainerIds] - 该宿主要看住的内置容器 id
 * @returns {Object|null} 实际挂载的视图定义
 */
export function mountFolderView({
    views,
    viewId,
    ctx,
    hostContainerId = 'tree-container',
    scope = '',
    builtinContainerIds = BUILTIN_CONTAINER_IDS
}) {
    const view = pickFolderView(views, viewId);
    if (!view) return null;

    // 先清场：本宿主作用域内的插件面板收起
    hidePluginPanels(views, scope);

    if (view.isPlugin) {
        // 插件视图独占自己的面板，内置容器让位
        hideBuiltinContainers(builtinContainerIds);
        const panel = ensurePluginPanel(view.id, hostContainerId, scope);
        if (panel) {
            panel.style.display = 'block';
            ctx = { ...ctx, panel, panelId: panelIdOf(view.id, scope) };
        }
    }

    try {
        view.mount(ctx);
    } catch (err) {
        // 插件自身的错误不应中断主界面渲染
        console.error(`[folderViewHost] 视图 "${view.id}" 挂载失败:`, err);
        const panel = document.getElementById(panelIdOf(view.id, scope));
        if (panel) {
            panel.innerHTML = `<div class="empty-state"><p>插件页「${view.label}」加载失败：${err && err.message ? err.message : err}</p></div>`;
        }
    }

    return view;
}

/**
 * 取视图的 unmount 并安全调用
 * @param {Object|null} view
 * @param {Object} ctx
 */
export function unmountFolderView(view, ctx) {
    if (!view || typeof view.unmount !== 'function') return;
    try {
        view.unmount(ctx);
    } catch (err) {
        console.error(`[folderViewHost] 视图 "${view.id}" 卸载失败:`, err);
    }
}
