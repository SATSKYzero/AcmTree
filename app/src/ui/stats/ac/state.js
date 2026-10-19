// ================================================================
// AC 追踪页的模块级状态（ui/stats/ac/state.js）
//
// 职责：当前页码、缓存的那批节点、每页条数。
// ⚠️ 可变状态（`let`）**必须与它的写入者同组** —— 跨模块给 import 进来的绑定赋值会直接
// TypeError，所以 `acListView*` 那七个 `let` 留在 `listView.js`、每日清单那两个留在
// `dailyList.js`（都是"谁赋值谁持有"）。
// ================================================================
import { execute } from '../../../shell/executor.js';
import { AppState } from '../../../shell/state.js';

export let acTrackingCurrentPage = 1;

export let acTrackingCachedNodes = [];

export function setACTrackingCurrentPage(page) {
    acTrackingCurrentPage = page;
}

export function setACTrackingCachedNodes(nodes) {
    acTrackingCachedNodes = nodes;
}

// XCPC 等级顺序与等级下标统一取自 utils/color.js（唯一真源）

// ================================================================
// 二级 Tab 状态
// ================================================================

export function getACTrackingPageSize() {
    const val = AppState.settings.stats.acTrackingPageSize;
    if (val !== undefined && val !== null && val >= 1 && val <= 100) {
        return val;
    }
    return 20;
}

export function setACTrackingPageSize(size) {
    if (size >= 1 && size <= 100) {
        execute(
            (draft) => { draft.settings.stats.acTrackingPageSize = size; },
            { skipHistory: true, validate: false }
        ).catch(() => {});
    }
}

// ================================================================
// 渲染最近 AC 题目列表
// ================================================================
