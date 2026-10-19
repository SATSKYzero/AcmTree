// ================================================================
// 类型与取值的小判据（utils/guards.js）
//
// 为什么单独一个模块：这三条判据散在 **9 个文件里各写一份**
// （`isPlainObject` ×9、`s()` ×2、`num()` ×2）—— 同一件事各有各的写法、
// 改一处漏一处，连"`escapeHtml` 转不转义引号"这种事实都会各写各的。
//
// ⚠️ **新增判据先看这里**：能复用就别再定义第 N 份；真要加新的，加到这个文件里。
// ================================================================

/**
 * 普通对象（非 null、非数组）—— "这是个对象吗"的唯一判据。
 *
 * ⚠️ 别写成 `typeof v === 'object'` 单独用：那样 `null` 和数组都会过。
 */
export function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 去空白后的字符串（`null`/`undefined` ⇒ `''`） */
export function str(v) {
    return v === undefined || v === null ? '' : String(v).trim();
}

/** 数字（认不出就 0）—— "这一格是几"的统一口径；不抛、不返回 NaN */
export function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}
