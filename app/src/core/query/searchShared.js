// ================================================================
// 两处检索的共用件（core/query/searchShared.js）
// 职责：文本规范化 / 条件判断 / **稳定排序** —— 只有这一份实现
// 依赖：无（纯函数）
//
// 为什么抽出来：
//   `ProblemSearch/query.js` 与 `ContestSearch/query.js` 需要**同一份**
//   `norm` / `hasText` / `hasList` / 比较器 —— 筛选与排序口径一漂，两页就各说一套。
//
// 约定（两处检索都靠它）：
//   · 文本条件为空串 / `undefined` ⇒ **不筛选**；数组条件为空数组 ⇒ 不筛选；
//   · 匹配一律**包含匹配、不分大小写**（各页自己决定拿哪个字段比）；
//   · 排序**稳定**：值相同保持传入顺序；数值键按大小、文本键按中文拼音；
//   · `isBlank` 命中的记录**无论升序降序都垫底**（"未知难度" / "没有时间"这种
//     一会儿在头一会儿在尾的噪声，比排错更烦人）。
// ================================================================

/** 把文本规范化为小写，便于不区分大小写匹配 */
export function norm(text) {
    return String(text === undefined || text === null ? '' : text).toLowerCase();
}

/** 是否设置了文本条件 */
export function hasText(v) {
    return typeof v === 'string' && v.trim() !== '';
}

/** 是否设置了数组条件 */
export function hasList(v) {
    return Array.isArray(v) && v.length > 0;
}

/**
 * **「名称/题号」与「键」这两个文本条件怎么合**（唯一一份）。
 *
 * 用户 2026-10-18 定的形状：键框紧跟在「名称」/「题号」后面，中间那颗按钮切换 **交集 / 并集**。
 *   · `join = 'and'`（默认，交集）：两个都要命中 —— 与加这颗按钮之前**逐字相同**；
 *   · `join = 'or'`（并集）：命中任一个就算（两个都空 ⇒ 不筛）。
 * 两条匹配都是**包含匹配**（`norm` 之后 `includes`），与其它文本条件同一条规则。
 *
 * @param {string} valueA - 第一个框对应的记录字段值（名称 / 题号）
 * @param {string} queryA - 第一个框里人敲的字
 * @param {string} valueB - 第二个框对应的记录字段值（键）
 * @param {string} queryB - 第二个框里人敲的字
 * @param {string} join - `'and'`（交集）/ `'or'`（并集）
 * @returns {boolean} 这条记录在这两个条件上算不算命中
 */
export function matchTextPair(valueA, queryA, valueB, queryB, join = 'and') {
    const onA = hasText(queryA);
    const onB = hasText(queryB);
    if (!onA && !onB) return true;                       // 两个都没填 ⇒ 不筛
    const hitA = onA && norm(valueA).includes(norm(queryA));
    const hitB = onB && norm(valueB).includes(norm(queryB));
    if (join === 'or') return hitA || hitB;
    return (!onA || hitA) && (!onB || hitB);
}

/**
 * 稳定排序
 * @param {Array<Object>} list
 * @param {Object} opts
 * @param {(rec: Object) => *} opts.keyOf - 取排序键
 * @param {(v: *, rec: Object) => boolean} [opts.isBlank] - 谁是"垫底那类"
 * @param {'asc'|'desc'} [opts.direction]
 * @returns {Array<Object>} 新数组（不改传入的）
 *
 * ⚠️ 选项名**不要**叫 `valueOf`：解构会顺着原型链把 `Object.prototype.valueOf`
 *    取出来（那是个函数！）⇒ "没传"永远判不出来，然后 `valueOf(rec)` 抛一个
 *    与调用点毫无关系的 `Cannot convert undefined or null to object`（实测踩到）。
 */
export function sortRecords(list = [], { keyOf, isBlank = () => false, direction = 'asc' } = {}) {
    if (typeof keyOf !== 'function') {
        throw new TypeError('sortRecords 需要 opts.keyOf（一个"记录 → 排序键"的函数）');
    }
    const dir = direction === 'desc' ? -1 : 1;
    const decorated = list.map((rec, i) => {
        const v = keyOf(rec);
        return { rec, i, v, blank: !!isBlank(v, rec) };
    });

    decorated.sort((a, b) => {
        if (a.blank !== b.blank) return a.blank ? 1 : -1;   // 垫底那类恒排最后
        const cmp = (typeof a.v === 'number' && typeof b.v === 'number')
            ? a.v - b.v
            : String(a.v).localeCompare(String(b.v), 'zh-Hans-CN');
        if (cmp === 0) return a.i - b.i;                    // 保持原顺序（稳定）
        return cmp * dir;
    });

    return decorated.map(d => d.rec);
}
