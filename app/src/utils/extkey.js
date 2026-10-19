// ================================================================
// extKey 的**第一段**（`src/utils/extkey.js`）
//
// 「这条记录来自哪棵树」= `extKey` 的第一段：
//   `aux-xcpcio:c:x` → `aux-xcpcio`、`qoj:c:1` → `qoj`、`cf:c:1:p:A` → `cf`。
//
// ⚠️ **判据只有这一份**（原先全仓有四处各写一遍 `split(':')[0]`：`core/synthPlan.js`
//    的 `extTreeOf`、`utils/similarity.js`、`core/synthRegistry.js`、
//    `features/AutoImport/extKeyPanel.js`）。四处里三处先 trim、一处没 trim ⇒ 同一份数据
//    在不同界面上可能得到 `' qoj'` 与 `'qoj'` 两个"树"（等于两棵树）。
//
// 为什么放在 `utils/`：它是**叶子**（不 import 任何东西），于是 core 与 utils 两侧都能引，
// 不会把 `utils → core` 的依赖方向倒过来。
// ================================================================

/**
 * `extKey` 的第一段（没见过 `:` ⇒ 整串就是它自己；空 ⇒ `''`）。
 *
 * @param {string} extKey - 身份键（`aux-rankland:c:zjcpc23rd`）
 * @returns {string} 树前缀（`aux-rankland`）；空/缺 ⇒ `''`
 */
export function treeOfExtKey(extKey) {
    const s = String(extKey === undefined || extKey === null ? '' : extKey).trim();
    return s ? s.split(':')[0] : '';
}
