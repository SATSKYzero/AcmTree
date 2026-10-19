// ================================================================
// 题目检索 — 索引构建（features/ProblemSearch/collect.js）
// 职责：把 State 里所有 P 节点摊平成可检索的记录，并解析其平台/系列/比赛归属
// 依赖：无（只读 State 结构）
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用。
//       State 结构约定见 core/model/state.js：
//         state.nodes[id]、state.parentOf[id]
//
// 索引里的值**按查看范围**取。本模块刻意**不认识** view 层，
// 由调用方注入两个取值器（与 core/query/stats.js 同一个套路）：
//
//     buildProblemIndex(state, {
//         value:   (node, field) => viewValue(state, node, field),    // 值级字段
//         derived: (node, field) => viewDerived(state, node, field)   // 派生字段
//     })
//
// 不传 → 直接读缓存字段。这样"检索看到的"和"树上看到的"是同一套口径。
// ================================================================

/** 默认取值器：直接读缓存字段 */
const cacheValue = (node, field) => node[field];

/**
 * 收集某节点的祖先链（**根在前**，不含自身）
 *
 * ⚠️ 实现在 `core/query/nodes.js`（全仓唯一一处）：比赛检索读的是**同一个函数** ——
 *    两处各抄一份逐字相同的就会漂。
 */
import { getAncestorsRootFirst as collectAncestorChain } from '../../core/query/nodes.js';
// 节点的身份键（`extKey` / `synthKey`）—— 唯一那一份
import { identityKeyOf } from '../../core/fieldRegistry.js';
export { collectAncestorChain };

/** 取节点显示名（无 name 时回落到 id）；`value` 是注入的值级取值器 */
function nameOf(node, value) {
    if (!node) return '';
    const n = value ? value(node, 'name') : node.name;
    return (n === undefined || n === null || n === '') ? (node.id || '') : String(n);
}

/**
 * 构建题目检索索引
 * @param {Object} state
 * @param {Object} [readers] - `{ value, derived }` 两个取值器（缺省读缓存）
 * @returns {Array<Object>} 记录数组，每条对应一个 P 节点
 */
export function buildProblemIndex(state, readers = {}) {
    const out = [];
    if (!state || !state.nodes) return out;
    const value = typeof readers.value === 'function' ? readers.value : cacheValue;
    const derived = typeof readers.derived === 'function' ? readers.derived : cacheValue;

    for (const id in state.nodes) {
        const node = state.nodes[id];
        if (!node || node.type !== 'P') continue;

        const chain = collectAncestorChain(state, id);
        const platforms = [];
        const seriesList = [];
        let contest = '';

        for (const anc of chain) {
            if (anc.type === 'W') platforms.push(nameOf(anc, value));
            else if (anc.type === 'S') seriesList.push(nameOf(anc, value));
            else if (anc.type === 'C') contest = nameOf(anc, value);   // 最近的比赛
        }

        const ratioRaw = value(node, 'ratio');
        const tagsRaw = value(node, 'tags');
        out.push({
            id,
            // ★ 身份键（`extKey`，合成节点退回 `synthKey`）—— 唯一那一份在 `core/fieldRegistry.js`
            key: identityKeyOf(node),
            problemId: value(node, 'problemId') || '',
            name: value(node, 'name') || '',
            cfDifficulty: Number(value(node, 'cfDifficulty')) || 0,
            xcpcDifficulty: derived(node, 'xcpcDifficulty') || '-',
            ratio: ratioRaw === undefined || ratioRaw === null ? '' : String(ratioRaw),
            // status1 也是"用户按下的覆盖"，和别的派生字段一样按范围算
            status1: derived(node, 'status1') === undefined ? 0 : derived(node, 'status1'),
            status2: derived(node, 'status2') === undefined ? 0 : derived(node, 'status2'),
            tags: (Array.isArray(tagsRaw) ? tagsRaw : [])
                .map(t => (t && t.text !== undefined ? String(t.text) : String(t)))
                .filter(Boolean),
            link: value(node, 'link') || '',
            platforms,
            seriesList,
            contest,
            path: chain.map(anc => nameOf(anc, value))
        });
    }

    return out;
}

/**
 * 汇总索引中出现过的可选项（供筛选下拉框使用）
 * @param {Array<Object>} index
 * @returns {{platforms: string[], series: string[], tags: string[]}}
 */
export function collectFacetOptions(index = []) {
    const platforms = new Set();
    const series = new Set();
    const tags = new Set();

    for (const rec of index) {
        for (const p of rec.platforms) if (p) platforms.add(p);
        for (const s of rec.seriesList) if (s) series.add(s);
        for (const t of rec.tags) if (t) tags.add(t);
    }

    const sortZh = (a, b) => a.localeCompare(b, 'zh-Hans-CN');
    return {
        platforms: [...platforms].sort(sortZh),
        series: [...series].sort(sortZh),
        tags: [...tags].sort(sortZh)
    };
}
