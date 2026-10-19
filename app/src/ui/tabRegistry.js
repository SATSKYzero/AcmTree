// ================================================================
// 一级 Tab 注册表解析（ui/tabRegistry.js）
// 职责：内置 Tab 与插件 Tab 的合并、判重、排序、选取
// 依赖：core/pluginRegistry.js, ui/extensibleList.js
// 说明：本模块**不碰 DOM**，因此可在 Node 测试中直接引用。
//       内置 Tab 的来源（index.html 的静态按钮）由 ui/tabs.js 读取后传入。
// ================================================================
import { getPluginTabs } from '../core/pluginRegistry.js';
import { mergeExtensible, pickById, hasId } from './extensibleList.js';

/** 插件 Tab 的默认排序值（内置 Tab 占 0~999，插件默认排在其后） */
export const PLUGIN_TAB_ORDER = 1000;

/** 兜底 Tab：任何异常情况下都回落到它 */
export const DEFAULT_TAB_ID = 'main';

/** 取某 Tab 对应的内容容器 id */
export function tabContentId(tabId) {
    return `tab-${tabId}`;
}

/**
 * 合并内置 Tab 与插件 Tab
 * @param {Array<Object>} builtins - 内置 Tab 定义
 * @param {Array<Object>} [pluginTabs] - 插件注册的 Tab，默认取全局注册表
 * @returns {Array<Object>} 排序后的 Tab 列表（插件项带 isPlugin: true）
 */
export function resolveTabs(builtins = [], pluginTabs = getPluginTabs()) {
    return mergeExtensible(builtins, pluginTabs, { pluginOrder: PLUGIN_TAB_ORDER });
}

/**
 * 按 id 取 Tab
 * @param {Array<Object>} tabs
 * @param {string} tabId
 * @returns {Object|null} 未命中则回退到第一项
 */
export function pickTab(tabs, tabId) {
    return pickById(tabs, tabId);
}

/**
 * 判断某 id 是否为已知 Tab（内置或插件）
 * @param {Array<Object>} tabs
 * @param {string} tabId
 * @returns {boolean}
 */
export function isKnownTabId(tabs, tabId) {
    return hasId(tabs, tabId);
}
