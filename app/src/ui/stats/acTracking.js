// ================================================================
// acTracking.js —— **公开面（barrel）**
//
// 实现按职责分在 `ac/` 下（见各自头注）；
// 这里只 re-export，**调用方（`ui/stats.js` 等）的 import 路径一个字不用改**。
// ================================================================
export { acTrackingCachedNodes, acTrackingCurrentPage, getACTrackingPageSize, setACTrackingCachedNodes, setACTrackingCurrentPage, setACTrackingPageSize } from './ac/state.js';
export { collectACNodes, renderACTracking } from './ac/tracking.js';
export { renderTrainingHeatmap } from './ac/heatmap.js';
export { renderDailyACList, renderTimeRangeACList } from './ac/dailyList.js';
export { getStatsTab, renderStatsTabContent, setStatsTab, setupACTrackingAutoRefresh, setupACTrackingEvents } from './ac/tabs.js';
