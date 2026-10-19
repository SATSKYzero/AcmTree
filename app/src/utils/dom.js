// ================================================================
// 建元素（utils/dom.js）
//
// 为什么单独一个模块：这段 "createElement + 设 class/style/textContent" 的小工具
// 若三个页面各写一份（判重整理 / 设置 / 体检），**签名很容易不一样**
// （`mk(tag, cls, style)` vs `mk(tag, cls, css, text)` vs `el(tag, css, text)`）——
// 于是"照抄隔壁那个 helper"抄过来的调用经常会静默丢掉一个参数。
//
// ⚠️ 这里**故意导出两个名字**（`el` 与 `mk`）：它们的调用点各有几十处，
//    签名差别只是"有没有 text / 有没有 class"。统一到 `mk` 一个函数要把几十处调用
//    逐条改写（纯噪音、还容易改错），不如让 `el` 当 `mk` 的薄别名 —— 一份实现、零改写。
// ================================================================

/**
 * 建一个元素（**不设 class** 的那一版：`el(tag, css, text)`）。
 *
 * @param {string} tag - 标签名
 * @param {string} [css] - 内联样式（`style.cssText`；空串 = 不设）
 * @param {string|null} [text] - 文本（`textContent`；`null` = 不设，注意不是 `''`）
 * @returns {HTMLElement}
 */
export function el(tag, css = '', text = null) {
    return mk(tag, '', css, text);
}

/**
 * 建一个元素（完整版：class + 内联样式 + 文本）。
 *
 * @param {string} tag
 * @param {string} [cls] - `className`（空串 = 不设）
 * @param {string} [css] - `style.cssText`（空串 = 不设）
 * @param {string|null} [text] - `textContent`（`null` = 不设 —— 传 `''` 会得到一个空文本节点，
 *        有些"重画时先清空"的地方依赖它，所以**别把 `null` 和 `''` 混起来**）
 * @returns {HTMLElement}
 */
export function mk(tag, cls = '', css = '', text = null) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (css) node.style.cssText = css;
    if (text !== null) node.textContent = text;
    return node;
}
