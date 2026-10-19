// ================================================================
// 计数模式接线（core/query/countMode.js）
//
// 职责：把「全局设置里选的计数模式」翻译成 `groupCount()` 的一次调用。
//   · 模式开关是**全局设置**：只有一份口径，
//     存在 `state.settings.stats.countMode`（缺省 `plain`）；
//   · 模式常量**复用** `groupCount.js` 的 `MODE_PLAIN` / `MODE_DEDUP`，
//     这里不抄第二份字面量；
//   · 非法 / 缺失一律回落 `plain` —— 老存档里没有这个键，回落必须等于逐节点计数。
//
// ⚠️ 三条硬约束：
//   ① **纯模块**：不 import 任何 UI / immer 依赖（保持可被纯 Node 单测直接跑）；
//   ② **只读**：不写派生字段、不写来源层、不进历史 —— 本文件只调 `groupCount()` 并把
//      它的结果原样返回（`groupCount` 本身也只读输入、不改任何输入对象）；
//   ③ **不接递推**：不同组不可加，所以这里是独立的一次扁平遍历（`groupCount` 内部
//      的欧拉序 + 一次扫描），**不是**"子节点加法递推"。
//
// 去重语义是 **scope-local**（"在这个子树内只算一次"），不是全局：传 `rootId` 就是
// 那个子树的根；不传 = 整棵树（每个节点各算自己那棵子树）。
// ================================================================
import { groupCount, MODE_PLAIN, MODE_DEDUP } from './groupCount.js';

/** 这个值是不是一个合法的计数模式 */
export function isCountMode(v) {
    return v === MODE_PLAIN || v === MODE_DEDUP;
}

/**
 * 从全局设置里解析计数模式。
 * @param {Object} settings - `state.settings`（可以是 undefined / 老存档缺键）
 * @returns {'plain'|'dedup'} 非法 / 缺失一律 `MODE_PLAIN`
 */
export function resolveCountMode(settings) {
    const raw = (settings && settings.stats) ? settings.stats.countMode : '';
    return isCountMode(raw) ? raw : MODE_PLAIN;
}

/**
 * 按全局设置（或显式 `mode`）对 `state` 做一次组计数。**只读**。
 *
 * @param {Object} state - `{ nodes, parentOf, childOrder, settings }`（只被读）
 * @param {Object} [opts]
 * @param {string} [opts.rootId] - 只算这棵子树；`''`/不给 = 每个节点都算（全树）
 * @param {'plain'|'dedup'|null} [opts.mode] - 显式覆盖；`null` = 读设置
 * @returns {ReturnType<typeof groupCount>}
 */
export function countGroupsOf(state, { rootId = '', mode = null } = {}) {
    const s = state || {};
    const m = isCountMode(mode) ? mode : resolveCountMode(s.settings);
    return groupCount({
        nodes: s.nodes || {},
        parentOf: s.parentOf || {},
        childOrder: s.childOrder || {},
        scopeRoot: rootId || '',
        mode: m
    });
}

// ================================================================
// 「判重」模式下：**每组只留一条代表**
//
// 为什么需要它：统计图 / 热力图 / AC 列表 / 比赛概览这几处的"计数"是**各自手搓的**
// （`collectByType('P')` 之后自己分桶），没走 `groupCount()` 那套去重 ⇒ 开了判重模式，
// 同一道题的多个来源副本会**各算一次**。这里给它们一个**统一**的"一组留一条"。
//
// ⚠️ 只有 `dedup` 才动；`plain` / 老存档缺键 ⇒ **原样返回同一个数组**（零开销、零变化）。
// ⚠️ 代表只影响**计数与分桶**：组的状态（`status1`/`status2`）本来就有"组那份"，各组员同值；
//    而**不在 `GROUP_FIELDS` 里的字段**（难度、`acTime`…）是各副本自己的 ⇒ 用 `hasValue`
//    优先挑一条"答得出这个问题"的（例如分桶要难度、AC 列表要 `acTime`），否则取先出现的。
// ================================================================

/** 一个节点属于哪个组：成员看 `ownerSynth`、合成节点看 `synthKey`；都没有 ⇒ `''`（自成一组） */
export function groupKeyOf(node) {
    if (!node) return '';
    return String(node.ownerSynth || node.synthKey || '');
}

/**
 * 「判重」模式下**每组只留一条代表**（其余成员从这批里去掉）。
 *
 * @param {Object} state - 只读 `state.settings`（模式）
 * @param {Array} nodes - 一批节点（保持**原顺序**：代表落在该组**第一次出现**的位置）
 * @param {Object} [opts]
 * @param {Function} [opts.hasValue] - `(node) => boolean`：这条能不能回答"这次要问的那个问题"
 *        （分桶要难度、AC 列表要 `acTime`）—— 组里已有代表不满足、而这条满足时**换成它**。
 * @param {Function} [opts.keyOf] - `(node) => string`：自定义分组键（热力图要"**每天**每组一条"，
 *        键里带上日期）；默认 `groupKeyOf`（同一组只留一条）。
 *        ⚠️ **自定义 `keyOf` 必须自己保证"没有组的节点彼此不同键"**：下面那个
 *        "没有组键 ⇒ 自成一组（`raw || '#' + id`）"的兜底**只在返回空串时生效** ——
 *        你一旦**拼了前缀**（如 `"<day>|" + group`），整串就永远非空、兜底永不触发，
 *        于是"那一天所有没有组的题"会被**合并成一条**。
 *        （`v9.1.24` 真踩：热力图上"一天最多 1"，而 AC 列表一个都不少 —— 用户 2026-10-13 实测。
 *         拼前缀时**把 id 一起拼进去**：`group || '#' + node.id`。）
 * @returns {Array} `plain` ⇒ **原数组**（同一个引用）；`dedup` ⇒ 新数组
 */
export function dedupRepresentatives(state, nodes, { hasValue = null, keyOf = groupKeyOf } = {}) {
    const list = Array.isArray(nodes) ? nodes : [];
    if (resolveCountMode(state && state.settings) !== MODE_DEDUP) return list;
    const out = [];
    const at = new Map();                       // 组键 → 代表在 out 里的下标
    for (const n of list) {
        const raw = keyOf(n);
        // 没有组键 ⇒ 自成一组（用节点 id 兜底，保证互不影响）
        const key = raw || `#${(n && n.id) || out.length}`;
        const hit = at.get(key);
        if (hit === undefined) {
            at.set(key, out.length);
            out.push(n);
            continue;
        }
        // 已经有代表：只有"这条更能回答这次的问题"时才换（同分不动 ⇒ 稳定）
        if (hasValue && !hasValue(out[hit]) && hasValue(n)) out[hit] = n;
    }
    return out;
}
