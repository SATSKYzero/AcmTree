// ================================================================
// 查询层统一导出（core/query/index.js）
// ================================================================
export {
    getNode,
    getChildIds,
    getChildren,
    getParentId,
    getParent,
    getRoot,
    getSiblings,
    getAncestors,
    getAncestorsRootFirst,
    getDescendants,
    getSubtreeIds,
    isAncestor,
    getDepth,
    getPath
} from './nodes.js';

export {
    collectByType,
    collectAllByType,
    countNodes,
    collectPStats,
    collectCStats,
    getGlobalStats
} from './stats.js';

export { norm, hasText, hasList, sortRecords } from './searchShared.js';