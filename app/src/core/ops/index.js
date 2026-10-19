// ================================================================
// 操作层统一导出（core/ops/index.js）
// ================================================================

// 树结构
export {
    addRoot,
    addChild,
    deleteNode,
    moveUp,
    moveDown,
    copyNode,
    clearProblems,
    clearSubmissions,
    getNextProblemId
} from './tree.js';

// 节点属性
export {
    updateP,
    updateR,
    updateWS,
    updateRemark
} from './node.js';

// 标签
export {
    addTag,
    deleteTag,
    moveTagUp,
    moveTagDown
} from './tag.js';

// 批量
export {
    batchAddPNodes
} from './batch.js';

// 增量 upsert（节点自动导入）
export {
    upsertRecord,
    buildExtKeyIndex,
    cleanNodeFields,
    assignExtKey,
    isWritableField,
    PROTECTED_NODE_KEYS,
    AUTO_NODE_KEYS
} from './upsert.js';

// 副页
export {
    addPage,
    deletePage,
    renamePage,
    duplicatePage,
    setPageSelected,
    copyRealNodeToPage,
    batchCopyToPage,
    deleteVirtualNode,
    moveVirtualNode,
    cleanDeletedRealNode,
    clearAllPages,
    resetAllVirtualPages
} from './page.js';

// 训练计划（设计稿 `docs/training-plan.md`）：计划形状 + 强度映射表库
export {
    nextPlanId,
    normalizePlanShape,
    addPlan,
    updatePlan,
    deletePlan,
    nextIntensityTableId,
    addIntensityTable,
    updateIntensityTable,
    deleteIntensityTable
} from './plan.js';

// 副页虚拟节点统计
export {
    refreshVirtualStatsForPage,
    refreshAllVirtualStats
} from './virtualStats.js';

// 视图状态
export {
    setNodeExpanded,
    toggleNodeExpanded,
    setNodeCurrentPage,
    setNodeSelected,
    toggleNodeSelected,
    flipChildrenSelection,
    clearSelectionInScope,
    setVirtualNodeExpanded,
    toggleVirtualNodeExpanded,
    setVirtualNodeCurrentPage,
    setVirtualNodeSelected,
    toggleVirtualNodeSelected,
    flipVirtualChildrenSelection
} from './view.js';

// 设置
export {
    updateSettings,
    setSetting
} from './settings.js';