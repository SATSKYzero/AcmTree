// ================================================================
// 比赛补题概览 — 资格过滤（features/ContestOverview/filter.js）
// 职责：把「筛选模式」应用到这场比赛收集到的题目上
//
// ⚠️ 判据**不在这里**：模式 → 查什么（主树选中 / 副页映射覆盖），与
//    「题目分布统计」「训练强度热力图」共用 `view/filterMode.js`。
//    本文件只负责"把共用判据接到本特性的数据结构上"。
// 依赖：view/filterMode.js, A_constants.js, ./collect.js
// ================================================================
import { DEFAULT_STATS_FILTER_MODE } from '../../A_constants.js';
import { filterByMode } from '../../view/filterMode.js';
import { collectContests } from './collect.js';

/**
 * 收集并按筛选模式过滤后的比赛结构
 * @param {Object} state
 * @param {string} nodeId
 * @param {string} [filterMode]
 * @returns {Array<Object>}
 */
export function collectFilteredContests(state, nodeId, filterMode = DEFAULT_STATS_FILTER_MODE, read = undefined) {
    return collectContests(state, nodeId, read).map(c => ({
        ...c,
        problems: filterByMode(state, c.problems, filterMode)
    }));
}
