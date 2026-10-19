// ================================================================
// 比赛补题概览 — 结构收集（features/ContestOverview/collect.js）
// 职责：从当前节点收集「比赛 → 题目」结构（不做资格过滤）
// 依赖：core/query/stats.js
// 说明：本模块**不碰 DOM、不依赖视图层**，可在 Node 测试中直接引用。
//       需要按筛选模式过滤请用 filter.js（那里才依赖 view/helpers）。
// ================================================================
import { collectByType } from '../../core/query/stats.js';

/**
 * 默认取值器：直接读缓存字段。
 * 调用方（插件 index.js）会传**按查看范围**取值的版本 —— 见 ProblemSearch/collect.js 的同一套路。
 */
const cacheRead = {
    value: (node, field) => node[field],
    derived: (node, field) => node[field]
};

/**
 * 收集「比赛 → 题目」结构
 *
 * 单位 = 当前节点子树内的 C（比赛）节点，**不含 P 子节点的比赛被忽略**。
 * 当前节点本身若是 C，也会作为一行出现。
 * 注意：嵌套比赛时，外层比赛会包含内层比赛的题目（按「比赛包含的题目」语义）。
 *
 * @param {Object} state
 * @param {Object|string} root - 当前节点（**节点对象或 id 都行**：副页节点的 id 是页内 id，
 *        `state.nodes` 里查不到 ⇒ 只给 id 会一场比赛都收不到）
 * @returns {Array<{id:string, name:string, problems:Array<Object>, totalProblems:number}>}
 */
export function collectContests(state, root, read = cacheRead) {
    if (!state || !root) return [];
    const node = (root && typeof root === 'object') ? root : (state.nodes ? state.nodes[root] : null);
    if (!node) return [];
    // 当前节点是 P/R 时不适用
    if (node.type === 'P' || node.type === 'R') return [];

    // ★ 子树从哪来由 `collectByType` 一处判据管：真实节点走 `childOrder`，
    //   **副页投影节点走它自己的 `children`**（交**节点对象**给它 —— 页内 id 查不到）。
    const contests = collectByType(state, node, 'C');
    const out = [];

    for (const c of contests) {
        const problems = collectByType(state, c, 'P');
        if (problems.length === 0) continue;   // 不含 P 节点的比赛忽略
        out.push({
            id: c.id,
            name: read.value(c, 'name') || c.id,
            problems,
            totalProblems: problems.length
        });
    }

    return out;
}

/**
 * 汇总所有比赛下的题目（用于计算难度轴右端等全局量）
 * @param {Array<Object>} contests
 * @returns {Array<Object>}
 */
export function flattenProblems(contests = []) {
    const out = [];
    for (const c of contests) out.push(...c.problems);
    return out;
}
