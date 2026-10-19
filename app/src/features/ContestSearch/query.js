// ================================================================
// 比赛检索 — 过滤与排序（features/ContestSearch/query.js）
// 职责：对比赛索引执行「筛选 → 排序」两步纯计算
// 依赖：无
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用。
//
// 约定（与题目检索同一套，别各写一份口径）：
//   - 文本类条件为空串 / undefined 表示"不筛选"（**包含匹配**、不分大小写）
//   - 数组类条件为空数组 / undefined 表示"不筛选"（而非"全都不要"）
//   - 「性质」按**分类路径前缀**匹配（`cf/contest` 命中 `cf/contest/div2`）
// ================================================================

// 文本规范化 / 条件判断 / 稳定排序：与题目检索**共用一份**（`core/query/searchShared.js`）
import { norm, hasText, hasList, sortRecords, matchTextPair } from '../../core/query/searchShared.js';
import { isRealYear } from '../../core/natureFields.js';

/**
 * 时间维的归一化：**只看数字**。
 *
 * 为什么：包里的 `contestTime` 是 `2026.09.26 22:35`（点分隔），而人习惯敲 `2026-09` ——
 * 只把分隔符去掉再比，"敲什么分隔符都认"（`2026-09` / `2026.09` / `202609` 等价）。
 */
function normTime(text) {
    return String(text === undefined || text === null ? '' : text).replace(/[^0-9]/g, '');
}

/**
 * 判断一条比赛记录是否命中全部筛选条件（各条件之间为 AND）
 * @param {Object} rec - buildContestIndex 产出的记录
 * @param {Object} c - 筛选条件
 * @returns {boolean}
 */
export function matchContest(rec, c = {}) {
    // ---- 文本：名称 / 时间 / 地区 / 键 ----
    // ★「名称」与「键」这两框**可以取并集**（条件栏中间那颗按钮，规则只有一份：`matchTextPair`）——
    //   默认 `and` = 交集，与加按钮之前**逐字相同**。
    if (!matchTextPair(rec.name, c.name, rec.key, c.key, c.keyJoin)) return false;
    // 时间只比数字：`2026-09` 与包里的 `2026.09.26 22:35` 等价（见 `normTime`）
    if (hasText(c.time) && !normTime(rec.contestTime).includes(normTime(c.time))) return false;
    if (hasText(c.region) && !norm(rec.natureRegion).includes(norm(c.region))) return false;

    // ---- 年代：年份 + 特殊值（`无` / `待同步` … 原样比，不做数字比较）----
    if (hasList(c.years) && !c.years.includes(rec.year || '（空）')) return false;

    // ---- 性质：分类路径（**前缀**匹配，取的是 `natureClass`）----
    if (hasList(c.classPrefixes)) {
        const path = String(rec.natureClass || '');
        if (!c.classPrefixes.some(p => path === p || path.startsWith(p + '/'))) return false;
    }

    // ---- 种类：contest / practice / 未填 ----
    if (hasList(c.kinds) && !c.kinds.includes(rec.kind || '（空）')) return false;

    // ---- 归属：平台 / 系列 ----
    if (hasList(c.platforms) && !rec.platforms.some(p => c.platforms.includes(p))) return false;
    if (hasList(c.seriesList) && !rec.seriesList.some(s => c.seriesList.includes(s))) return false;

    return true;
}

/** 过滤比赛索引 */
export function filterContests(index = [], criteria = {}) {
    return index.filter(rec => matchContest(rec, criteria));
}

/** 可用的排序键 */
export const SORT_KEYS = ['time', 'name', 'year', 'class', 'region', 'problems', 'platform'];

/** 取某记录的排序值 */
function sortValueOf(rec, key) {
    switch (key) {
        case 'time':
            return rec.contestTime;
        case 'name':
            return rec.name;
        case 'year':
            // 特殊值（无 / 待同步…）排在所有真年份之后：给 0，降序时自然垫底
            // "是不是真年份"只问唯一入口（`isRealYear`）—— 别自己再写一遍正则（见 `src/test/yearSingleSource.test.js`）
            return isRealYear(rec.year) ? Number(rec.year) : 0;
        case 'class':
            return rec.natureClass;
        case 'region':
            return rec.natureRegion;
        case 'problems':
            return rec.problems;
        case 'platform':
            return rec.platforms[0] || '';
        default:
            return '';
    }
}

/**
 * 排序（稳定；数值键升序，文本键按中文拼音）
 * ⚠️ 「没有时间」的记录（上游没给开赛时间，如 rankland 那批）**恒排最后**，
 *    免得它在升序/降序之间来回跳（与题目检索的"未知难度恒垫底"同一个态度）。
 * @param {Array<Object>} list
 * @param {string} key - SORT_KEYS 之一
 * @param {'asc'|'desc'} direction
 * @returns {Array<Object>} 新数组
 */
export function sortContests(list = [], key = 'time', direction = 'desc') {
    return sortRecords(list, {
        direction,
        keyOf: (rec) => sortValueOf(rec, key),
        // ⚠️ 「没有时间」那类（上游没给开赛时间）**恒排最后** —— 与题目检索的
        //    "未知难度恒垫底"同一个态度。判据看的是 `contestTime` 而不是排序键。
        isBlank: (v, rec) => (key === 'time' ? !rec.contestTime : false)
    });
}

/**
 * 执行一次完整查询：先筛选，再排序
 * @param {Array<Object>} index
 * @param {Object} [opts] - `{ criteria, sortKey, direction }`
 * @returns {Array<Object>}
 */
export function runContestQuery(index = [], { criteria = {}, sortKey = 'time', direction = 'desc' } = {}) {
    return sortContests(filterContests(index, criteria), sortKey, direction);
}
