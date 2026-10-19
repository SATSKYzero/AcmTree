// ================================================================
// 比赛检索 — 索引构建（features/ContestSearch/collect.js）
// 职责：把 State 里所有 C 节点摊平成可检索的记录（名称/时间/年代/性质/地区/归属/题目数）
// 依赖：无（只读 State 结构）
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用 —— 与 `ProblemSearch/collect.js`
//       同一套路（含"按查看范围取值"的注入式取值器）。
//
//    buildContestIndex(state, {
//        value:   (node, field) => viewValue(state, node, field),
//        derived: (node, field) => viewDerived(state, node, field)
//    })
//
// ⚠️ 口径（与 `docs/field-rules.md` 对齐）：
//   · 「名称/时间」= C 自己的 `name` / `contestTime`（**上游没有就留空**，不借用别的来源）；
//   · 「年代」= `natureYear`，**特殊值照原样进筛选**（`无` / `待同步` / `不确定` / `待填写` /
//      `不需要` —— 它们都是"结论"，不是空缺，见 field-rules §1.2）；
//   · 「性质」= `natureClass` 分类路径（前缀匹配 ⇒ 芯片给的是**前两段**，如 `cf/contest`）；
//   · 「归属」= 祖先链上的 W（平台）/ S（系列）名字，与题目检索同一口径。
// ================================================================
import { NATURE_NOT_APPLICABLE } from '../../core/natureFields.js';

/** 默认取值器：直接读缓存字段 */
const cacheValue = (node, field) => node[field];

/** "这一格没值"在筛选里的键（唯一一处；`view.js` 也用它） */
export const EMPTY_KEY = '（空）';

/**
 * 年份维的"还没定 / 不适用"那一类（不是缺口，是结论 —— 原样出现在筛选里）。
 *
 * ⚠️ 名单**派生自** `core/natureFields` 的"确定不用"表（`NATURE_NOT_APPLICABLE`）+
 *    "这一格没值"那个键。手写名单会漏词（例如 `上游异常`）—— 后果是它被当成
 *    **真年份**参与排序，年份筛选里被顶到最前面。加词表里的词就不用再改这里了。
 */
export const YEAR_SPECIALS = [...new Set([
    ...NATURE_NOT_APPLICABLE.natureYear,
    ...NATURE_NOT_APPLICABLE.natureRegion,   // 待填写 / 不需要 / 不知道 也出现在年份列里过
    EMPTY_KEY
])];

/** 中文排序，但"没值"那个键**恒垫底**（`（空）` 排在最前会把噪声顶到眼前） */
function sortZhEmptyLast(list) {
    return [...list].sort((a, b) => {
        const ea = a === EMPTY_KEY, eb = b === EMPTY_KEY;
        if (ea !== eb) return ea ? 1 : -1;
        return a.localeCompare(b, 'zh-Hans-CN');
    });
}

/**
 * 收集某节点的祖先链（由根到父，不含自身）—— 与题目检索同一实现（各写一份就会漂）
 * @param {Object} state
 * @param {string} nodeId
 * @returns {Array<Object>}
 */
/**
 * 收集某节点的祖先链（**根在前**，不含自身）
 *
 * ⚠️ 实现在 `core/query/nodes.js`（全仓唯一一处）：题目检索读的是**同一个函数** ——
 *    两处各抄一份逐字相同的就会漂。
 */
import { getAncestorsRootFirst as collectAncestorChain } from '../../core/query/nodes.js';
// 节点的身份键（`extKey` / `synthKey`）—— 唯一那一份
import { identityKeyOf } from '../../core/fieldRegistry.js';
export { collectAncestorChain };

/** 取节点显示名（无 name 时回落到 id） */
function nameOf(node, value) {
    if (!node) return '';
    const n = value ? value(node, 'name') : node.name;
    return (n === undefined || n === null || n === '') ? (node.id || '') : String(n);
}

/** 分类路径的前两段（芯片粒度：`cf/contest/div2` → `cf/contest`） */
export function classPrefixOf(natureClass) {
    const parts = String(natureClass || '').split('/').filter(Boolean);
    if (!parts.length) return '';
    return parts.slice(0, 2).join('/');
}

/**
 * 构建比赛检索索引
 * @param {Object} state
 * @param {Object} [readers] - `{ value, derived }` 两个取值器（缺省读缓存）
 * @returns {Array<Object>} 记录数组，每条对应一个 C 节点
 */
export function buildContestIndex(state, readers = {}) {
    const out = [];
    if (!state || !state.nodes) return out;
    const value = typeof readers.value === 'function' ? readers.value : cacheValue;

    // 先数一遍"每个 C 下有几个 P"（一次 O(n) 扫描；逐节点向上数会很慢）
    const problems = Object.create(null);
    if (state.parentOf) {
        for (const pid in state.nodes) {
            const pnode = state.nodes[pid];
            if (!pnode || pnode.type !== 'P') continue;
            const parent = state.parentOf[pid];
            if (parent) problems[parent] = (problems[parent] || 0) + 1;
        }
    }

    for (const id in state.nodes) {
        const node = state.nodes[id];
        if (!node || node.type !== 'C') continue;

        const chain = collectAncestorChain(state, id);
        const platforms = [];
        const seriesList = [];
        for (const anc of chain) {
            if (anc.type === 'W') platforms.push(nameOf(anc, value));
            else if (anc.type === 'S') seriesList.push(nameOf(anc, value));
        }

        const natureClass = value(node, 'natureClass') || '';
        const natureYear = value(node, 'natureYear') || '';
        out.push({
            id,
            // ★ 身份键（`extKey`，合成节点退回 `synthKey`）—— 唯一那一份在 `core/fieldRegistry.js`
            key: identityKeyOf(node),
            name: value(node, 'name') || '',
            contestTime: value(node, 'contestTime') || '',
            // 时间维的"年代"：优先 natureYear，没标就退到 contestTime 的头 4 位（只认 20xx）
            year: natureYear || yearFromTime(value(node, 'contestTime')),
            natureClass,
            classPrefix: classPrefixOf(natureClass),
            natureSeason: value(node, 'natureSeason') || '',
            natureRegion: value(node, 'natureRegion') || '',
            kind: value(node, 'kind') || '',
            problems: problems[id] || 0,
            link: value(node, 'link') || '',
            platforms,
            seriesList,
            path: chain.map(anc => nameOf(anc, value))
        });
    }

    return out;
}

/** `2024-10-26 09:00:00` → `2024`（认不出返回空串；**特殊值不在这里编**，那由 natureYear 管） */
export function yearFromTime(contestTime) {
    const m = /(20\d{2})/.exec(String(contestTime || ''));
    return m ? m[1] : '';
}

/**
 * 汇总索引中出现过的可选项（供筛选芯片使用）
 * @param {Array<Object>} index
 * @returns {{years: string[], classPrefixes: string[], kinds: string[], platforms: string[],
 *            series: string[], regions: string[]}}
 */
export function collectContestFacets(index = []) {
    const years = new Set();
    const classPrefixes = new Set();
    const kinds = new Set();
    const platforms = new Set();
    const series = new Set();
    const regions = new Set();

    for (const rec of index) {
        years.add(rec.year || EMPTY_KEY);
        if (rec.classPrefix) classPrefixes.add(rec.classPrefix);
        kinds.add(rec.kind || EMPTY_KEY);
        for (const p of rec.platforms) if (p) platforms.add(p);
        for (const s of rec.seriesList) if (s) series.add(s);
        if (rec.natureRegion) regions.add(rec.natureRegion);
    }

    const sortZh = (a, b) => a.localeCompare(b, 'zh-Hans-CN');
    const yearList = [...years].sort((a, b) => {
        const sa = YEAR_SPECIALS.includes(a), sb = YEAR_SPECIALS.includes(b);
        if (sa !== sb) return sa ? 1 : -1;              // 特殊值恒排最后
        return String(b).localeCompare(String(a));      // 年份新的在前
    });

    return {
        years: yearList,
        classPrefixes: sortZhEmptyLast(classPrefixes),
        kinds: sortZhEmptyLast(kinds),
        platforms: [...platforms].sort(sortZh),
        series: [...series].sort(sortZh),
        regions: [...regions].sort(sortZh)
    };
}
