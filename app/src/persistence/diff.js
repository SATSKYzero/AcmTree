// ================================================================
// 状态差分（persistence/diff.js）
// 职责：比较前后状态，输出增量 changes
// 依赖：A_registry.js（meta 层字段名单）
// 说明：利用 Immer 结构共享：引用不同 = 变化
// ================================================================
import { META_FIELD_KEYS } from '../A_registry.js';

/**
 * @returns {Object} changes
 */
export function computeDiff(before, after) {
    const changes = {
        nodesAdded: {},
        nodesRemoved: [],
        nodesChanged: {},
        childOrderChanged: {},
        pagesAdded: {},
        pagesRemoved: [],
        pagesChanged: {},
        meta: {},
        metaFields: {}
    };

    diffMap(before.nodes, after.nodes, changes.nodesAdded, changes.nodesChanged, changes.nodesRemoved);
    diffMap(before.pages, after.pages, changes.pagesAdded, changes.pagesChanged, changes.pagesRemoved);
    diffChildOrder(before.childOrder, after.childOrder, changes.childOrderChanged);

    // meta 层字段：逐个按**注册表**比引用（`A_registry.js` 的 META_FIELD_KEYS）。
    // 依赖 Immer 结构共享：引用没变 = 没改。
    // ⚠️ 手写清单会漏字段，症状是"刷新一次就没了、还看不出来" ——
    //    名单只有一处，忘了登记会被 `src/test/registryCoverage.test.js` 逮住。
    for (const key of META_FIELD_KEYS) {
        if (before[key] !== after[key]) changes.metaFields[key] = after[key];
    }

    // infoState：captureRef 每次生成新对象，必须字段级比较
    const iBefore = before.infoState || {};
    const iAfter = after.infoState || {};
    if (iBefore.lastSaveTime !== iAfter.lastSaveTime
        || iBefore.lastModifiedTime !== iAfter.lastModifiedTime
        || iBefore.jsonIsSaved !== iAfter.jsonIsSaved
        || iBefore.jsonLastSaveTime !== iAfter.jsonLastSaveTime) {
        changes.metaFields.infoState = iAfter;
    }

    return changes;
}

function diffMap(before, after, added, changed, removed) {
    before = before || {};
    after = after || {};
    for (const id in after) {
        if (!(id in before)) added[id] = after[id];
        else if (before[id] !== after[id]) changed[id] = after[id];
    }
    for (const id in before) {
        if (!(id in after)) removed.push(id);
    }
}

function diffChildOrder(before, after, out) {
    before = before || {};
    after = after || {};
    for (const id in after) {
        if (before[id] !== after[id]) out[id] = after[id];
    }
    for (const id in before) {
        if (!(id in after)) out[id] = null;  // null 表示删除
    }
}

export function isEmptyDiff(c) {
    return Object.keys(c.nodesAdded).length === 0
        && c.nodesRemoved.length === 0
        && Object.keys(c.nodesChanged).length === 0
        && Object.keys(c.childOrderChanged).length === 0
        && Object.keys(c.pagesAdded).length === 0
        && c.pagesRemoved.length === 0
        && Object.keys(c.pagesChanged).length === 0
        && Object.keys(c.metaFields).length === 0;
}

/**
 * 将 diff 转为 IndexedDB 批量写操作
 *
 * 折叠/翻页是"看的姿势"，**不在节点上**（state.view）⇒ 落盘载荷里天然没有它们。这步若对整棵树做，会毁掉"按引用做差"
 *    （每次落盘都以为全变了 ⇒ 整棵树重写）；见 `persistence/index.js` 的 `captureRef`。
 */
export function diffToIDBOps(c) {
    const ops = [];
    for (const id in c.nodesAdded) ops.push({ store: 'nodes', op: 'put', value: c.nodesAdded[id] });
    for (const id in c.nodesChanged) ops.push({ store: 'nodes', op: 'put', value: c.nodesChanged[id] });
    for (const id of c.nodesRemoved) ops.push({ store: 'nodes', op: 'delete', key: id });

    for (const id in c.childOrderChanged) {
        const v = c.childOrderChanged[id];
        if (v === null) ops.push({ store: 'childOrder', op: 'delete', key: id });
        else ops.push({ store: 'childOrder', op: 'put', value: { id, children: v } });
    }

    for (const id in c.pagesAdded) ops.push({ store: 'pages', op: 'put', value: c.pagesAdded[id] });
    for (const id in c.pagesChanged) ops.push({ store: 'pages', op: 'put', value: c.pagesChanged[id] });
    for (const id of c.pagesRemoved) ops.push({ store: 'pages', op: 'delete', key: id });

    for (const key in c.metaFields) {
        ops.push({ store: 'meta', op: 'put', value: { key, value: c.metaFields[key] } });
    }
    return ops;
}