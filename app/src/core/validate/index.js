// ================================================================
// 校验层统一导出（core/validate/index.js）
// ================================================================
export {
    collectPNodeConflicts,
    checkProblemIdUnique,
    collectBatchConflicts
} from './conflict.js';

export {
    countRenderedNodesOnTree,
    getCurrentRenderedCount,
    validateExpandedLimit
} from './expanded.js';

// extKey 全局唯一（节点自动导入的身份不变量）
export {
    collectExtKeyConflicts,
    collectBatchExtKeyConflicts,
    checkExtKeyUnique
} from './upsertConflict.js';