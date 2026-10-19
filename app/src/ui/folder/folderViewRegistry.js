// ================================================================
// 文件夹节点视图：注册表解析（ui/folder/folderViewRegistry.js）
// 职责：内置视图与插件视图的合并、判重、排序、选取
// 依赖：core/pluginRegistry.js, ui/extensibleList.js
// 说明：本模块**不碰 DOM**，因此可在 Node 测试中直接引用。
//       DOM 相关的挂载逻辑在 folderViewHost.js。
//       合并语义与一级 Tab 共用 ui/extensibleList.js。
// ================================================================
import { getPluginFolderViews } from '../../core/pluginRegistry.js';
import { mergeExtensible, pickById } from '../extensibleList.js';

/** 插件视图的默认排序值（内置视图占 0~99） */
export const PLUGIN_VIEW_ORDER = 100;

/** 插件专属面板容器的 id 前缀 */
const PANEL_PREFIX = 'folder-view-panel-';

/**
 * 取某视图的面板容器 id
 *
 * `scope` 用于**同一个视图被两个宿主同时挂载**的场合（主视图的文件夹页 + 节点信息大界面）：
 * 面板是按 id 单例的 DOM 节点，不区分宿主就会互相覆盖 —— 表现为"在节点页里看过概览之后，
 * 回到主视图的文件夹页，看到的却是那个节点页的内容"。默认不带 scope，保持既有 id 不变。
 *
 * @param {string} viewId
 * @param {string} [scope] - 宿主作用域（调用方保证只含 id 安全字符）
 */
export function panelIdOf(viewId, scope = '') {
    return `${PANEL_PREFIX}${scope ? `${scope}-` : ''}${viewId}`;
}

/**
 * 合并内置视图与插件视图
 * @param {Array<Object>} builtins - 内置视图定义
 * @param {Array<Object>} [pluginViews] - 插件注册的视图定义，默认取全局注册表
 * @returns {Array<Object>} 排序后的视图列表（插件项带 isPlugin: true）
 */
export function resolveFolderViews(builtins = [], pluginViews = getPluginFolderViews()) {
    return mergeExtensible(builtins, pluginViews, { pluginOrder: PLUGIN_VIEW_ORDER });
}

/**
 * 取当前应展示的视图定义
 * @param {Array<Object>} views
 * @param {string} viewId
 * @returns {Object|null} 找不到则回退到第一个视图
 */
export function pickFolderView(views, viewId) {
    return pickById(views, viewId);
}
