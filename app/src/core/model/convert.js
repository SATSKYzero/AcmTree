// ================================================================
// 格式转换（core/model/convert.js）
// 职责：旧嵌套树 ↔ 新扁平结构（过渡期使用）
// 依赖：state.js, page.js, constants.js
// ================================================================
import { rebuildParentOf } from './state.js';
import { STATE_VERSION } from './constants.js';

/**
 * 从 nodes 反推 idCounter（避免旧数据 idCounter 不可靠导致的 id 冲突）
 * 扫描所有 id，提取 `n_<数字>_<时间戳>` 中的数字部分，取最大值
 *
 * ⚠️ 这是**节点 id 那一族**的老入口（旧嵌套树转换用）。新的统一入口是下面的
 *    `normalizeIdCounter`（它把**所有族**都扫一遍）—— 两者都留着，别互相顶。
 * @param {Object} nodes - 节点映射 { [id]: node }
 * @returns {number} 最大数字前缀
 */
export function rebuildIdCounter(nodes) {
    let max = 0;
    for (const id of Object.keys(nodes || {})) {
        const m = /^[a-z]+_(\d+)_/.exec(id);
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
    }
    return max;
}

/**
 * ★ **所有 id 族**的最大计数器（唯一性的**地基**，`v9.3.1` 立）。
 *
 * 为什么必须扫**全部族**：id 现在是一个计数器发的（`core/ops/_helpers.js:nextIdOf`，
 * 形式 `<前缀>_<计数器>_<毫秒36>`）⇒ 只要计数器**不回退**，id 就**不可能重复**（构造性唯一，
 * 不是"概率很低"）。而"不回退"靠的就是这里：**载入 / 导入时把计数器抬到所有已有 id 之上**。
 * 以前只扫 `n_<数字>_`（节点），于是副页 id / 页内 vNode id / 计划 id 不受保护 ——
 * `v9.3.0` 的"复制副页后一个容器变成一个单题"就是这条链断在半路（vNode id 撞了）。
 *
 * @param {Object} state - 载入/导入后的 state（或 draft）
 * @returns {number} 出现的最大数字前缀（没有 ⇒ 0）
 */
export function maxIdCounterOf(state) {
    let max = 0;
    const eat = (id) => {
        const m = /^[a-z]+_(\d+)_/.exec(String(id || ''));
        if (m) {
            const n = parseInt(m[1], 10);
            if (n > max) max = n;
        }
    };
    for (const k in (state.nodes || {})) eat(k);
    for (const k in (state.tags || {})) eat(k);
    const pages = state.pages || {};
    for (const pid in pages) {
        eat(pid);
        const page = pages[pid] || {};
        eat(page.rootId);
        for (const vid in (page.virtualIndex || {})) eat(vid);
    }
    for (const k in (state.plans || {})) eat(k);
    const tables = (state.settings && state.settings.trainingIntensityTables) || [];
    if (Array.isArray(tables)) for (const t of tables) if (t && t.id) eat(t.id);
    return max;
}

/**
 * 把 `meta.idCounter` 抬到"所有已有 id 之上"（**就地改这个 state**，返回它）。
 *
 * ⚠️ 两个调用点缺一不可：`restoreDerived`（从盘里读存档）与
 *    `shell/executor.js:importState`（导入导出包）。少一处，那条路上新发的 id
 *    就可能与已有的重合（以前导入通道**正是漏的那一处**）。
 */
export function normalizeIdCounter(state) {
    const meta = state.meta || (state.meta = {});
    const current = Number.isFinite(meta.idCounter) ? meta.idCounter : 0;
    const scanned = maxIdCounterOf(state);
    if (scanned > current) meta.idCounter = scanned;
    if (!Number.isFinite(meta.idCounter)) meta.idCounter = 0;
    return state;
}
/**
 * 旧嵌套树 → 新扁平结构
 * @param {Array} treeData   旧 treeData（含 O 根节点的数组）
 * @param {Object} pages     旧 pages（virtualIndex 为数组 [{id, vNode}]）
 * @param {Object} settings  旧 settings
 * @param {number} idCounter 旧 idCounter
 * @returns {Object} 新 State
 */
export function nestedToFlat(treeData, pages, settings, idCounter) {
    const state = {
        rootId: null,
        nodes: {},
        childOrder: {},
        parentOf: {},
        pages: {},
        settings: settings || {},
        meta: {
            idCounter: idCounter || 0,
            version: STATE_VERSION
        }
    };

    // ---- 递归转换树 ----
    function walk(oldNode, parentId) {
        const id = oldNode.id;
        // 剥离 children，其余字段保留
        const { children, ...rest } = oldNode;
        state.nodes[id] = rest;
        state.parentOf[id] = parentId;
        state.childOrder[id] = [];
        if (Array.isArray(children) && children.length > 0) {
            for (const child of children) {
                state.childOrder[id].push(child.id);
                walk(child, id);
            }
        }
    }

    if (Array.isArray(treeData) && treeData.length > 0) {
        const root = treeData[0];
        state.rootId = root.id;
        walk(root, null);
    }

    // ---- 转换副页 ----
    if (pages && typeof pages === 'object') {
        for (const pid in pages) {
            const oldPage = pages[pid];
            const newPage = {
                id: oldPage.id,
                name: oldPage.name,
                rootId: oldPage.rootId,
                virtualIndex: {},
                createdAt: oldPage.createdAt,
                lastModified: oldPage.lastModified,
                selected: oldPage.selected || false
            };
            // virtualIndex：数组 → 对象
            const vIndex = oldPage.virtualIndex || [];
            for (const item of vIndex) {
                if (item && item.vNode) {
                    newPage.virtualIndex[item.id] = item.vNode;
                }
            }
            state.pages[pid] = newPage;
        }
    }

    // ★ 用扫描结果重建 idCounter，避免旧数据 idCounter 不可靠导致的 id 冲突
    const scanned = rebuildIdCounter(state.nodes);
    state.meta.idCounter = Math.max(state.meta.idCounter || 0, scanned);

    return state;
}

/**
 * 新扁平结构 → 旧嵌套树（用于过渡期渲染）
 * @param {Object} state 新 State
 * @returns {{ treeData: Array, pages: Object }}
 */
export function flatToNested(state) {
    // ---- 递归构建旧格式节点（含 children） ----
    function buildNode(id) {
        const node = state.nodes[id];
        if (!node) return null;
        const childIds = state.childOrder[id] || [];
        const children = [];
        for (const cid of childIds) {
            const child = buildNode(cid);
            if (child) children.push(child);
        }
        return { ...node, children };
    }

    const treeData = [];
    if (state.rootId) {
        const root = buildNode(state.rootId);
        if (root) treeData.push(root);
    }

    // ---- 副页：virtualIndex 对象 → 数组 ----
    const pages = {};
    for (const pid in state.pages) {
        const page = state.pages[pid];
        const virtualIndex = [];
        for (const vId in page.virtualIndex) {
            const vNode = page.virtualIndex[vId];
            virtualIndex.push({ id: vId, vNode });
        }
        pages[pid] = {
            id: page.id,
            name: page.name,
            rootId: page.rootId,
            virtualIndex,
            createdAt: page.createdAt,
            lastModified: page.lastModified,
            selected: page.selected
        };
    }

    return { treeData, pages };
}

/**
 * 序列化时剥离 parentOf（持久化不写它，加载时重建）
 * @param {Object} state 运行时 State
 * @returns {Object} 不含 parentOf 的 State
 */
export function stripDerived(state) {
    const { parentOf, ...rest } = state;
    return rest;
}

/**
 * 反序列化后重建 parentOf
 * @param {Object} rawState 从磁盘读到的 State（不含 parentOf）
 * @returns {Object} 完整 State
 */
export function restoreDerived(rawState) {
    const nodes = rawState.nodes || {};
    const scanned = rebuildIdCounter(nodes);
    const meta = rawState.meta || {};
    const current = meta.idCounter || 0;
    const out = {
        ...rawState,
        parentOf: rebuildParentOf(rawState.childOrder || {}),
        meta: {
            ...meta,
            idCounter: Math.max(current, scanned)
        }
    };
    // ★ 再从**所有族**抬一次（节点之外还有副页 / 页内 vNode / 计划 / 强度表）
    return normalizeIdCounter(out);
}