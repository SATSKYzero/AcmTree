// ================================================================
// 「筛选模式」共用件（view/filterMode.js）
//
// **唯一一份**：模式 → 判据（查不查"选中"、查不查"副页映射覆盖"）+ 选项文案。
// 为什么要有它：同一套规则不该**三处各写各的** ——
//   ① `ui/stats/statsCharts.js`（题目分布统计）  ② `ui/stats/acTracking.js`（热力图/AC 列表）
//   ③ `features/ContestOverview/filter.js`（比赛补题概览），
// 选项文案还有**两份**（`FILTER_OPTIONS` 与 ① 里那段内联的 `modeOptions`）。
// 判据各写各的时，在"模式认不出来"下**行为还不一样**（② 会把所有题都滤掉、①③ 原样返回）——
// 这种分歧正是"同一规则抄三份"的典型后果，所以这里统一成 **认不出 ⇒ 当 `ALL`**。
//
// 依赖方向：判据在 `view/eligible.js`（**纯模块**，只读 state 形状）⇒ 本模块也能进
// `npm test` 的纯 Node 单测。**不要 import `helpers.js`** —— 那个文件拉
// `core/pluginRegistry.js` → `shell/state.js` → `immer`，一 import 就再也测不了。
// ================================================================
import { DEFAULT_STATS_FILTER_MODE, STATS_FILTER_MODES } from '../A_constants.js';
import { hasEligibleAncestor } from './eligible.js';

/**
 * 模式 → 要查哪两件事（`null` = 不过滤）。
 *
 * `selected`  = 自身或祖先在**主树**里被选中；
 * `projected` = 自身或祖先被**副页映射**覆盖。
 */
export const FILTER_MODE_CHECKS = Object.freeze({
    [STATS_FILTER_MODES.ALL]: null,
    [STATS_FILTER_MODES.SP_ANCESTOR]: { selected: true, projected: true },
    [STATS_FILTER_MODES.SELECTED_ANCESTOR]: { selected: true, projected: false },
    [STATS_FILTER_MODES.PAGE_MAPPING_ONLY]: { selected: false, projected: true }
});

/** 下拉框的选项（label 是界面文案、title 是悬停解释）—— 界面只从这里取 */
export const FILTER_OPTIONS = Object.freeze([
    { value: STATS_FILTER_MODES.ALL, label: '无限制', title: '显示当前节点下所有题目，不做任何筛选' },
    { value: STATS_FILTER_MODES.SP_ANCESTOR, label: '全局覆盖', title: '显示自身或祖先满足「主树选中」或「副页映射覆盖」的题目' },
    { value: STATS_FILTER_MODES.SELECTED_ANCESTOR, label: '仅主页覆盖', title: '显示自身或祖先满足「主树选中」的题目' },
    { value: STATS_FILTER_MODES.PAGE_MAPPING_ONLY, label: '仅选中副页映射覆盖', title: '显示自身或祖先满足「副页映射覆盖」的题目' }
]);

/** 认不出的模式一律当 `无限制`（各写各的实现里有的会"全滤掉"，那是 bug 不是口径） */
export function normalizeFilterMode(mode) {
    return mode in FILTER_MODE_CHECKS ? mode : DEFAULT_STATS_FILTER_MODE;
}

/**
 * 按筛选模式过滤一批节点。
 *
 * **合成节点与"成员引用"的显式口径**（结论：本文件**不需要**为它们加分支）
 * ------------------------------------------------------------------------------
 * ① **合成节点 = 真节点**：它照样按**自己的类型**参与筛选 —— 它是 P 就出现在 P 的列表里、
 *    按自己的 `selected` / 祖先链判资格（`hasEligibleAncestor` 走 `parentOf`，
 *    合成节点的 parentOf 与普通节点一模一样）。**不做任何特殊对待**：把合成节点偷偷滤掉
 *    会让"我选中的那个比赛合成"在统计里凭空消失，那不是筛选模式该干的事。
 * ② **"成员引用"不是节点**：成员资格由 `ownerSynth` 指出去，**不在 `parentOf` / `childOrder` 里**，
 *    所以它压根不会出现在"被过滤的一批节点"里 —— 本文件没有"引用"这种输入，天然不参与。
 *    推论（这是刻意的、也是这一条最容易被人当 bug 的地方）：**归入某合成节点不会让成员
 *    获得该合成节点的祖先资格** —— 成员关系是**指针/名单**，不是父子，所以"选中合成节点"
 *    不等于"选中它的成员"。要按组筛，那是统计侧（`state.settings.stats.countMode === 'dedup'`
 *    + `core/query/countMode.js`）的事，与本模块无关。
 * ③ **筛选后的计数不因合成而变化**：本模块只做 `filter`（返回通过的节点），不数数；
 *    去重模式下的计数由统计侧负责（`countGroupsOf`）。
 *
 * ⚠️ 以后若有人想在这里"顺手把成员也带上"，先想清楚 ②：那会变成"按组展开"，
 *    一个节点可能被多个组引用 ⇒ 列表出现重复项，与"筛选是子集"的语义冲突。
 *
 * @param {Object} state
 * @param {Array<Object>} nodes - 通常是 P 节点
 * @param {string} [mode] - 缺省读 `state.settings.stats.statsFilterMode`
 * @returns {Array<Object>} 通过筛选的节点（`ALL` 时**原样返回同一个数组**）
 */
export function filterByMode(state, nodes, mode) {
    const list = Array.isArray(nodes) ? nodes : [];
    const raw = mode || (state && state.settings && state.settings.stats
        ? state.settings.stats.statsFilterMode : '');
    const checks = FILTER_MODE_CHECKS[normalizeFilterMode(raw)];
    if (!checks) return list;
    // 投影（副页覆盖）要沿祖先链反复问，缓存一次算好
    const cache = new Map();
    return list.filter(n => hasEligibleAncestor(state, n, checks.selected, checks.projected, cache));
}
