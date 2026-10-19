// ================================================================
// HTML 工具（utils/html.js）
// 职责：HTML 转义
// 依赖：无（**不依赖 DOM** —— 见下面为什么）
// ================================================================

/** 需要转义的字符 → 实体 */
const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

/**
 * HTML 转义（`& < > " '` **五个都转** —— 文本位与属性位共用它一个就够）。
 *
 * ⚠️ 各功能模块（AutoImport / ProblemSearch / ContestOverview）**别再各抄一份 `esc()`**：
 *    注释里"`utils/html.js` 的 `escapeHtml` **不转义引号**、属性位不能用"的说法是错的
 *    （这张表里一直有 `"` 与 `'`）—— 一律 import 这里的 `escapeHtml`。**别再另抄一份**。
 *
 * 不用 `document.createElement('div')` 借浏览器的 textContent→innerHTML 来转义，
 * 因为那样**在 Node 里就没法用**（单测跑不了、`document is not defined`）。
 * 而这些工具函数的价值恰恰在于"能在没有 DOM 的地方被复用"（例如只读小样、
 * 纯字符串渲染函数），所以用查表实现 —— 行为等价，且哪儿都能跑。
 *
 * 注意：`&` 必须排在最前，否则会把后面生成的实体再转一遍（`&lt;` → `&amp;lt;`）。
 */
export function escapeHtml(text) {
    if (text === null || text === undefined || text === '') return '';
    return String(text).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/**
 * 外链 `<a>` 的固定属性（**唯一一份**：所有"点开源站"的地方都拼这一段）。
 *
 * 为什么必须带 `noreferrer` / `referrerpolicy="no-referrer"`：
 * 有些源站开了**防盗链**，按 `Referer` 判断 —— 从本地页面（`http://127.0.0.1:8321`）
 * 点过去会带上这个 Referer，站点直接回 **403 Forbidden（openresty）**；
 * 而把它复制到新标签页打开（没有 Referer）就正常。
 * 实测：`board.xcpcio.com` 带 Referer → 403、不带 → 200；`qoj.ac` / `codeforces.com`
 * 等不受影响（所以症状只在**部分**链接上出现，很容易被当成"链接写错了"）。
 * `noopener` 则是安全惯例（新页面拿不到 `window.opener`）。
 */
export const EXTERNAL_LINK_ATTRS = 'target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"';