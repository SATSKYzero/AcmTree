// ================================================================
// 判重页的**模块级状态**（ui/dedup/state.js）
//
// 当前视图状态（筛选范围/关键词/模式/是否显示已填满）与每块的页码。
// ⚠️ 切栏 / 翻页**不清筛选条件**这条行为就靠它 —— 共享可变状态只此一份，别在别处再存。
// ⚠️ 那份"按数据引用缓存"的模型（`cache`）**不在这里**：它会被 `model.js` 的两处重新赋值，
// 跨模块给 import 进来的绑定赋值会直接抛 TypeError。
// ================================================================
import { emptyDedupFilter } from '../../core/dedup.js';


export const viewState = {
    scopeKind: 'all',        // all / subtree / contest
    scopeNodeId: '',
    scopeSearch: '',         // 「单场比赛」下拉的临时筛选词（不进判据，只筛选项）
    filter: emptyDedupFilter(),
    mode: 'strict',          // strict（默认硬门槛）/ all（叠加相似度辅助）
    section: 'synth'         // 二级 tab：synth / dupes / nature / summary
};

/** 当前页码（会话级；数据一变 / 条件一变就回到第 1 页） */

export const pageState = { groups: 1, candidates: 1, unowned: 1, pending: 1, pendingFilled: 1 };

/** 上次算出来的结果（翻页时直接复用，不重算） */
