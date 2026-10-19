// ================================================================
// 插件注册表（core/pluginRegistry.js）
// 职责：集中定义插件可注册的所有钩子，并提供查表 API
// 依赖：无
// 说明：
//   - 插件不 import 本文件，通过 api 对象在激活时调用
//   - 核心其他模块 import 本文件提供的查表函数
//   - 核心不 import 任何插件
// ================================================================

// ================================================================
// 注册表（模块级私有）
// ================================================================
const nodeMigrations = [];
const vNodeMigrations = [];
const vNodeCopyHooks = [];
const computeRulesByType = {};       // { type: [{ key, compute }] }
const vNodeComputeRulesByType = {};  // { type: [{ key, compute }] }
const nodeEditorExtensions = [];     // [{ nodeTypes, fields, apply }]
const vNodeEditorExtensions = [];    // [{ vNodeTypes, fields, apply }]
const renderSlotsMap = {};           // { slotId: [renderer] }
const folderViews = [];              // [{ id, label, order, mount, unmount }]
const tabs = [];                     // [{ id, label, order, mount, unmount }]

// ================================================================
// 已知渲染槽清单
// 职责：把"有哪些槽可挂"从隐式字符串变成显式契约
// 说明：helpers.js 等消费点一律引用本常量，插件可从 api.RENDER_SLOTS 读取
// ================================================================
export const RENDER_SLOTS = Object.freeze({
    /** 节点盒子内，选中圆点之前 */
    NODE_SELECT_DOT_BEFORE: 'node-select-dot-before'
});

/** 取所有已知槽 id */
export function getKnownSlotIds() {
    return Object.values(RENDER_SLOTS);
}

// ================================================================
// 插件调用失败记录
// 语义：以下是"隔离型"钩子——单个插件出错只降级该插件，不中断主流程。
//       记录失败供排查，重复失败只报一次，但计数累加。
// ================================================================
const pluginFailures = [];           // [{ label, message, count }]
const reportedFailures = new Set();

/**
 * 安全调用一个插件钩子
 * @param {string} label - 失败标识，如 'migration'
 * @param {Function} fn - 被调用的插件函数
 * @param {Array} args
 * @returns {{ok: boolean, value?: *}} ok=false 表示插件抛错且已被隔离
 */
function safeInvoke(label, fn, args) {
    try {
        return { ok: true, value: fn(...args) };
    } catch (err) {
        recordFailure(label, err);
        return { ok: false };
    }
}

/** 记录一次插件失败（去重上报，计数累加） */
function recordFailure(label, err) {
    const message = err && err.message ? err.message : String(err);
    const existing = pluginFailures.find(f => f.label === label && f.message === message);
    if (existing) {
        existing.count++;
        return;
    }
    pluginFailures.push({ label, message, count: 1 });
    const key = `${label}\u0000${message}`;
    if (!reportedFailures.has(key)) {
        reportedFailures.add(key);
        console.error(`[pluginRegistry] 插件钩子 "${label}" 抛出异常（已隔离）:`, err);
    }
}

/**
 * 取已记录的插件失败（副本）
 * @returns {Array<{label, message, count}>}
 */
export function getPluginFailures() {
    return pluginFailures.map(f => ({ ...f }));
}

/** 清空失败记录 */
export function clearPluginFailures() {
    pluginFailures.length = 0;
    reportedFailures.clear();
}

// ================================================================
// 注册 API（供 bootstrap 传给插件的 api 对象使用）
// ================================================================

export function registerNodeMigration(fn) {
    if (typeof fn !== 'function') throw new Error('registerNodeMigration 需要函数');
    nodeMigrations.push(fn);
}

export function registerVNodeMigration(fn) {
    if (typeof fn !== 'function') throw new Error('registerVNodeMigration 需要函数');
    vNodeMigrations.push(fn);
}

export function registerVNodeCopyHook(fn) {
    if (typeof fn !== 'function') throw new Error('registerVNodeCopyHook 需要函数');
    vNodeCopyHooks.push(fn);
}

// ----- 计算规则 -----
// 注意：计算规则**故意不做异常隔离**，与上面的迁移/槽位不同。
// 两个原因：
//   1. 规则函数是直接暴露给 autoCompute 调用的，函数同一性是既有契约；
//   2. 计算规则抛错意味着"字段值算错了"，静默跳过会留下过期错值并被写回状态，
//      比让事务直接失败更危险。因此这里保持"响亮失败"。
export function registerComputeRule(type, key, compute) {
    if (typeof type !== 'string') throw new Error('registerComputeRule: type 需为字符串');
    if (typeof key !== 'string') throw new Error('registerComputeRule: key 需为字符串');
    if (typeof compute !== 'function') throw new Error('registerComputeRule: compute 需为函数');
    if (!computeRulesByType[type]) computeRulesByType[type] = [];
    computeRulesByType[type].push({ key, compute });
}

export function registerVNodeComputeRule(type, key, compute) {
    if (typeof type !== 'string') throw new Error('registerVNodeComputeRule: type 需为字符串');
    if (typeof key !== 'string') throw new Error('registerVNodeComputeRule: key 需为字符串');
    if (typeof compute !== 'function') throw new Error('registerVNodeComputeRule: compute 需为函数');
    if (!vNodeComputeRulesByType[type]) vNodeComputeRulesByType[type] = [];
    vNodeComputeRulesByType[type].push({ key, compute });
}

export function registerNodeEditorExtension(ext) {
    if (!ext || !Array.isArray(ext.nodeTypes) || !Array.isArray(ext.fields) || typeof ext.apply !== 'function') {
        throw new Error('registerNodeEditorExtension: 需 { nodeTypes, fields, apply }');
    }
    nodeEditorExtensions.push(ext);
}

export function registerVNodeEditorExtension(ext) {
    if (!ext || !Array.isArray(ext.vNodeTypes) || !Array.isArray(ext.fields) || typeof ext.apply !== 'function') {
        throw new Error('registerVNodeEditorExtension: 需 { vNodeTypes, fields, apply }');
    }
    vNodeEditorExtensions.push(ext);
}

export function registerRenderSlot(slotId, renderer) {
    if (typeof slotId !== 'string') throw new Error('registerRenderSlot: slotId 需为字符串');
    if (typeof renderer !== 'function') throw new Error('registerRenderSlot: renderer 需为函数');
    if (!getKnownSlotIds().includes(slotId)) {
        // 不抛错：允许插件先于核心新增槽注册而不至于激活失败；
        // 但未知槽永远不会被渲染，因此必须告警，避免"注册了却毫无效果"。
        console.warn(`[pluginRegistry] registerRenderSlot: 未知槽 "${slotId}"，可用槽见 RENDER_SLOTS`);
    }
    if (!renderSlotsMap[slotId]) renderSlotsMap[slotId] = [];
    renderSlotsMap[slotId].push(renderer);
}

// ----- 页面级扩展点：视图定义公共校验 -----
/**
 * 校验一个页面级视图定义（文件夹节点视图 / 一级 Tab 通用形状）
 * @param {Object} def - { id, label, order?, mount, unmount? }
 * @param {string} what - 报错前缀，如 'registerFolderView'
 */
function assertViewDef(def, what) {
    if (!def || typeof def !== 'object') throw new Error(`${what}: 需传入视图定义对象`);
    if (typeof def.id !== 'string' || def.id === '') throw new Error(`${what}: id 需为非空字符串`);
    if (typeof def.label !== 'string' || def.label === '') throw new Error(`${what}: label 需为非空字符串`);
    if (typeof def.mount !== 'function') throw new Error(`${what}: mount 需为函数`);
    if (def.unmount !== undefined && typeof def.unmount !== 'function') throw new Error(`${what}: unmount 需为函数`);
    if (def.order !== undefined && typeof def.order !== 'number') throw new Error(`${what}: order 需为数字`);
}

/** 从列表中按 id 判重 */
function assertIdFree(list, id, what) {
    if (list.some(def => def.id === id)) throw new Error(`${what}: id "${id}" 已被注册`);
}

/**
 * 注册「文件夹模式 → 节点视图」插件页
 * @param {Object} def - { id, label, order?, mount(ctx), unmount?(ctx) }
 */
export function registerFolderView(def) {
    assertViewDef(def, 'registerFolderView');
    assertIdFree(folderViews, def.id, 'registerFolderView');
    folderViews.push(def);
}

/**
 * 注册「一级 Tab 栏」插件页
 * @param {Object} def - { id, label, order?, mount(ctx), unmount?(ctx) }
 */
export function registerTab(def) {
    assertViewDef(def, 'registerTab');
    assertIdFree(tabs, def.id, 'registerTab');
    tabs.push(def);
}

// ================================================================
// 查表 API（供核心其他模块使用）
// ================================================================

export function runNodeMigrations(node) {
    for (const fn of nodeMigrations) safeInvoke('nodeMigration', fn, [node]);
}

export function runVNodeMigrations(vNode) {
    for (const fn of vNodeMigrations) safeInvoke('vNodeMigration', fn, [vNode]);
}

export function runVNodeCopyHooks(realNode, vNode) {
    for (const fn of vNodeCopyHooks) safeInvoke('vNodeCopyHook', fn, [realNode, vNode]);
}

/**
 * 取某类型的计算规则（含 '*' 通配规则）
 * @param {string} type - 'O' | 'W' | 'S' | 'C' | 'P' | 'R'
 * @returns {Array<{key, compute}>}
 */
export function getComputeRules(type) {
    const specific = computeRulesByType[type] || [];
    const wildcard = computeRulesByType['*'] || [];
    return [...specific, ...wildcard];
}

export function getVNodeComputeRules(type) {
    const specific = vNodeComputeRulesByType[type] || [];
    const wildcard = vNodeComputeRulesByType['*'] || [];
    return [...specific, ...wildcard];
}

/**
 * 取适用于某节点的编辑扩展
 * @param {Object} node
 * @returns {Array<ext>}
 */
export function getNodeEditorExtensions(node) {
    return nodeEditorExtensions.filter(ext =>
        ext.nodeTypes.includes('*') || ext.nodeTypes.includes(node.type)
    );
}

export function getVNodeEditorExtensions(vNode) {
    return vNodeEditorExtensions.filter(ext =>
        ext.vNodeTypes.includes('*') || ext.vNodeTypes.includes(vNode.type)
    );
}

/**
 * 渲染指定 slot 的所有片段。
 * 单个 renderer 抛错会被隔离（该片段不渲染），不影响其余插件与整棵树的渲染。
 * @param {string} slotId
 * @param {Object} state
 * @param {Object} context
 * @returns {string} HTML 拼接
 */
export function renderSlots(slotId, state, context) {
    const renderers = renderSlotsMap[slotId] || [];
    let html = '';
    for (const fn of renderers) {
        const res = safeInvoke(`renderSlot:${slotId}`, fn, [state, context]);
        if (res.ok && typeof res.value === 'string') html += res.value;
    }
    return html;
}

/**
 * 取所有插件注册的文件夹节点视图（返回副本，调用方不可改动注册表）
 * @returns {Array<Object>}
 */
export function getPluginFolderViews() {
    return [...folderViews];
}

/**
 * 取所有插件注册的一级 Tab（返回副本）
 * @returns {Array<Object>}
 */
export function getPluginTabs() {
    return [...tabs];
}

/**
 * 判断某 id 是否为插件注册的一级 Tab
 * @param {string} tabId
 * @returns {boolean}
 */
export function isPluginTab(tabId) {
    return tabs.some(def => def.id === tabId);
}

// ================================================================
// 生成 api 对象（bootstrap 传给插件的激活函数）
// ================================================================
export function createPluginApi() {
    return {
        registerNodeMigration,
        registerVNodeMigration,
        registerVNodeCopyHook,
        registerComputeRule,
        registerVNodeComputeRule,
        registerNodeEditorExtension,
        registerVNodeEditorExtension,
        registerRenderSlot,
        registerFolderView,
        registerTab,
        // 只读契约：可用槽清单，插件据此避免拼错槽 id
        RENDER_SLOTS
    };
}

// ================================================================
// 测试专用：重置全部注册表
// 生产代码不调用
// ================================================================
export function __resetRegistryForTest() {
    nodeMigrations.length = 0;
    vNodeMigrations.length = 0;
    vNodeCopyHooks.length = 0;
    for (const k in computeRulesByType) delete computeRulesByType[k];
    for (const k in vNodeComputeRulesByType) delete vNodeComputeRulesByType[k];
    nodeEditorExtensions.length = 0;
    vNodeEditorExtensions.length = 0;
    for (const k in renderSlotsMap) delete renderSlotsMap[k];
    folderViews.length = 0;
    tabs.length = 0;
    clearPluginFailures();
}