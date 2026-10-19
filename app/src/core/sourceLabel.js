// ================================================================
// 来源 id 的**人话名字**（src/core/sourceLabel.js）
//
// 职责：把来源 id 翻译成给人看的文字；**唯一一处**。
// 为什么单独一个零依赖文件（用户 2026-10-13 定，踩过一次）：
//   · `core/trust.js` 的"人话理由"里要写"另有 X 说 Y（未采用）" —— 那里的 X 是**来源 id**，
//     晒 `local:v7` 给用户看没有意义；
//   · 而 `core/trust.js` 的文件头写着"**依赖：无**（纯函数，不碰 DOM / 不读全局状态）"，
//     它**不能**去 import `core/fieldValue.js` —— 那个文件反过来 `import { projectField } from './trust.js'`
//     （`fieldValue.js:22`）⇒ 成环。
//   ⇒ 所以这一份口头禅放在**谁都不依赖**的小模块里：`trust.js`、`fieldValue.js`、UI 都能引它。
// ================================================================

/**
 * 回填时用的来源 id（老数据不知道是谁给的，就记成它）。
 * ⚠️ 它**同时**是"这条值没有原始出处"的标记 —— 显示时走 `srcLabel`。
 */
export const BACKFILL_SRC = 'local:v7';

/** `local:v7` 给人看的名字（用户 2026-10-13：**直接叫「默认值」**，他保证没有需要区分"旧数据回填"的数据） */
export const BACKFILL_LABEL = '默认值';

/**
 * 来源 id → 给人看的名字。
 *
 * ⚠️ **只用于"给人看的文本"**：`data-src="..."` 那类**属性**必须保持原始 id
 * （"优先 / 不用 / 真删"那些动作靠它识别来源）。
 *
 * @param {string} src
 * @returns {string}
 */
export function srcLabel(src) {
    return src === BACKFILL_SRC ? BACKFILL_LABEL : String(src || '');
}
