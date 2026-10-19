// ================================================================
// 视图渲染层统一导出（view/index.js）
// 职责：对外暴露 view 层所有公共 API
// 依赖：view/helpers.js, view/stats.js, view/builders.js,
//       view/renderers.js, view/tree.js, view/info.js, view/dataAdapter.js
// ================================================================

// ---- 通用辅助 ----
export {
    getChildNodes,
    getNodePerPage,
    ensureCurrentPage,
    getSubmitSummary,
    isNodeRendered,
    renderNodeBox,
    buildToggleButton,
    buildTimeTags,
    getProjected,
    hasEligibleAncestor,
    countEligibleSubtree,
    buildActions
} from './helpers.js';

// ---- 统计 ----
export {
    markStatsDirty,
    getTotalNodeCount,
    collectPStats,
    getCProblemSummary,
    getCStatusDistribution,
    getWSMatchSummary,
    getWSProblemSummary,
    getGlobalStats,
    getGlobalStatsSoon,
    getVirtualGlobalStats,
    updateVirtualGlobalStats
} from './stats.js';

// ---- 标题/元数据构建 ----
export {
    buildPNodeTitle,
    buildPNodeMeta,
    buildRNodeTitle,
    buildRNodeMeta,
    buildCNodeTitle,
    buildCNodeMeta,
    buildWSNodeTitle,
    buildWSNodeMeta,
    buildPaginationHtml
} from './builders.js';

// ---- 节点渲染 ----
export {
    renderPNode,
    renderRNode,
    renderCNode,
    renderWSNode,
    renderNode
} from './renderers.js';

// ---- 树更新 ----
export {
    insertNodeAt,
    updateNode
} from './tree.js';

// ---- 信息栏 ----
// ⚠️ 统计栏是"延迟一拍"的（`getGlobalStatsSoon` + `paintStatsNumbers`）：要画统计栏走
//    `ui/folder/folderShared.js` 的 `paintStatsNumbers`；同步调 `getGlobalStats` 直接写 DOM
//    会在渲染路径上多出 ~100ms 的同步算。
export {
    markSizeDirty,
    updateInfoBar
} from './info.js';

// ---- 数据适配 ----
export {
    getDisplayData,
    buildVirtualTreeRoot
} from './dataAdapter.js';