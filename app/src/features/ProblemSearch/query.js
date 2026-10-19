// ================================================================
// 题目检索 — 过滤与排序（features/ProblemSearch/query.js）
// 职责：对索引执行「筛选 → 排序」两步纯计算
// 依赖：utils/color.js（XCPC 档位顺序）
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用。
//
// 约定：
//   - 文本类条件为空串 / undefined 表示"不筛选"
//   - 数组类条件为空数组 / undefined 表示"不筛选"（而非"全都不要"）
//   - CF 难度区间为闭区间，min/max 缺省表示该端不限
// ================================================================
import { getXcpcLevelIndex } from '../../utils/color.js';
// 文本规范化 / 条件判断 / 稳定排序：与比赛检索**共用一份**（`core/query/searchShared.js`）
import { norm, hasText, hasList, sortRecords, matchTextPair } from '../../core/query/searchShared.js';

/** 未填写难度的排序权重（排在所有已知难度之后） */
const UNKNOWN_DIFF_INDEX = Number.MAX_SAFE_INTEGER;

/**
 * 判断题record 是否命中全部筛选条件（各条件之间为 AND）
 * @param {Object} rec - buildProblemIndex 产出的记录
 * @param {Object} c - 筛选条件
 * @returns {boolean}
 */
export function matchRecord(rec, c = {}) {
    // ---- 文本：题号 / 题名 / 标签 / 键 ----
    // ★「题号」与「键」这两框**可以取并集**（条件栏中间那颗按钮，规则只有一份：`matchTextPair`）
    if (!matchTextPair(rec.problemId, c.problemId, rec.key, c.key, c.keyJoin)) return false;
    if (hasText(c.name) && !norm(rec.name).includes(norm(c.name))) return false;
    if (hasText(c.tag)) {
        const kw = norm(c.tag);
        if (!rec.tags.some(t => norm(t).includes(kw))) return false;
    }

    // ---- 归属：平台 / 系列 / 比赛 ----
    if (hasList(c.platforms) && !rec.platforms.some(p => c.platforms.includes(p))) return false;
    if (hasList(c.seriesList) && !rec.seriesList.some(s => c.seriesList.includes(s))) return false;
    if (hasText(c.contest) && !norm(rec.contest).includes(norm(c.contest))) return false;

    // ---- 状态 ----
    if (hasList(c.status2) && !c.status2.includes(rec.status2)) return false;

    // ---- 难度：XCPC 档 ----
    if (hasList(c.xcpcLevels)) {
        const lv = rec.xcpcDifficulty || '-';
        // 特殊档 '未填写' 对应 '-' / 空
        const key = (!lv || lv === '-') ? '未填写' : lv;
        if (!c.xcpcLevels.includes(key)) return false;
    }

    // ---- 难度：CF 区间（闭区间）----
    const hasCfMin = Number.isFinite(c.cfMin);
    const hasCfMax = Number.isFinite(c.cfMax);
    if (hasCfMin || hasCfMax) {
        const d = rec.cfDifficulty;
        if (hasCfMin && d < c.cfMin) return false;
        if (hasCfMax && d > c.cfMax) return false;
    }

    return true;
}

/**
 * 过滤索引
 * @param {Array<Object>} index
 * @param {Object} criteria
 * @returns {Array<Object>}
 */
export function filterProblems(index = [], criteria = {}) {
    return index.filter(rec => matchRecord(rec, criteria));
}

/** 可用的排序键 */
export const SORT_KEYS = ['cf', 'xcpc', 'problemId', 'name', 'status2', 'contest', 'platform'];

/**
 * 取某记录的排序值
 * @param {Object} rec
 * @param {string} key
 * @returns {number|string}
 */
function sortValueOf(rec, key) {
    switch (key) {
        case 'cf':
            // 未填写（< 800）视作未知，排在最后
            return rec.cfDifficulty >= 800 ? rec.cfDifficulty : UNKNOWN_DIFF_INDEX;
        case 'xcpc': {
            const idx = getXcpcLevelIndex(rec.xcpcDifficulty);
            return idx < 0 ? UNKNOWN_DIFF_INDEX : idx;
        }
        case 'problemId':
            return rec.problemId;
        case 'name':
            return rec.name;
        case 'status2':
            return rec.status2;
        case 'contest':
            return rec.contest;
        case 'platform':
            return rec.platforms[0] || '';
        default:
            return '';
    }
}

/**
 * 排序（稳定；数值键升序，文本键按中文拼音）
 * 「未知难度」无论升序降序都排在最后，避免它一会儿在头一会儿在尾。
 * @param {Array<Object>} list
 * @param {string} key - SORT_KEYS 之一
 * @param {'asc'|'desc'} direction
 * @returns {Array<Object>} 新数组
 */
export function sortProblems(list = [], key = 'cf', direction = 'asc') {
    return sortRecords(list, {
        direction,
        keyOf: (rec) => sortValueOf(rec, key),
        isBlank: (v) => v === UNKNOWN_DIFF_INDEX   // 「未知难度」恒排最后
    });
}

/**
 * 执行一次完整查询：先筛选，再排序
 * @param {Array<Object>} index
 * @param {Object} [opts]
 * @param {Object} [opts.criteria]
 * @param {string} [opts.sortKey]
 * @param {'asc'|'desc'} [opts.direction]
 * @returns {Array<Object>}
 */
export function runQuery(index = [], { criteria = {}, sortKey = 'cf', direction = 'asc' } = {}) {
    return sortProblems(filterProblems(index, criteria), sortKey, direction);
}
