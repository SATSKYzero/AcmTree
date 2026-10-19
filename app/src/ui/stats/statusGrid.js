// ================================================================
// 统计图下面那张「网格表」的数据（ui/stats/statusGrid.js）
//
// 职责：**只算数据、不进 DOM** —— 行 = 状态2、列 = 难度档、格内 = 题数、每行最右 = 该状态2的合计。
//       画它的是 `ui/stats/statsCharts.js:renderStatusGrid`（那一份负责列宽/间距/对齐）。
//
// 为什么单独一个文件：这份是**纯函数**（只依赖 `A_constants` 的两张表），能进 `npm test`
//   （`src/test/statusGrid.test.js`）；而"画出来对不对齐"只能在 DOM 里看（冒烟 + 真浏览器）。
//
// ⚠️ **行序 = 柱内堆叠顺序**（`STATUS2_ORDER`）：`未使用` 在最上、`忽略` 在最下，
//    与柱子里各段的**上下顺序一致**（`renderBarChart` 的 `prepend` + `column-reverse` 出来的就是这个视觉序）。
//    用户 2026-10-13 **先要"行序与柱状图相反"、随后明确改成"别反了"** ⇒ 这里就是正序，
//    别再"顺手"改成倒序（网格第一行与柱子最上面那段对齐才对）。
// ================================================================
import { STATUS2_LABELS } from '../../A_constants.js';

/**
 * 柱内堆叠顺序（**唯一一份**）：柱状图的循环与网格表的行序都从它取。
 * ⚠️ 它的长度必须与 `STATUS2_LABELS` / `STATUS2_COLORS` / `STATUS2_VALUES` 一致
 *    （守卫：`src/test/status2Tables.test.js`）。
 */
export const STATUS2_ORDER = [0, 1, 2, 3, 4, 5];

// ----------------------------------------------------------------
// 布局的三件"同一把尺子"（**柱子和网格共用**）
//
// ⚠️ 它们住这儿（而不是 `statsCharts.js`）：网格的**渲染**在 `./statusGridView.js`，两边都要用，
//    放渲染那边会让"柱子对齐"依赖渲染模块；住数据这边，两边都只是 import。
//    改这三个数 = **柱子和网格一起动**（这才是对得齐的原因，别只改一边）。
// ----------------------------------------------------------------
/** 列间距（柱子那一行与网格每一行都用它） */
export const COL_GAP = 8;
/** 图表区左内边距（柱子那一行与网格每一行都用它） */
export const AREA_PAD_LEFT = 8;
/** 网格最左那列「状态2」的宽：柱子那一行用**同样宽的空位**占着 ⇒ 列才对得齐 */
export const ROW_LABEL_W = 58;

/**
 * 「**全部状态2**」的哨兵值（`v9.1.4`）：点表底「合计」行那一格时用它当"状态2 参数"，
 * 意思是"这一档**所有状态**的题"。
 *
 * ⚠️ **不能**用 `''` 兼职：空串在 `statsCharts.js` 里已经是"**没选中任何柱段**"的意思
 *    （`selectedSegmentKey === ''` / `selectedStatus === ''`）⇒ 兼职会让"点了合计格"被当成"取消选择"。
 * ⚠️ 也不可能与真的状态2 撞车（那是 `0..5` 的字符串）。
 */
export const ALL_STATUS2 = 'all';

/**
 * 网格表数据。
 *
 * @param {Object} data - 与画图**同一份**分档结果：`{ 难度档: { 状态2: 题数 } }`
 *        （`buildXcpcData` / `buildCfData` 的产出；列的先后 = `Object.keys(data)`）
 * @param {number[]} [order] - 行序；缺省 = `STATUS2_ORDER`
 * @returns {{ levels: string[], rows: Array<{ s2:number, label:string, cells:number[], total:number }>,
 *            colTotals: number[], grand: number }}
 *          `colTotals` = 每一**档**的合计（= 原先画在柱子上面那行数字）；`grand` = 全部题数（最右那一格）。
 */
export function statusGridOf(data, order = STATUS2_ORDER) {
    const levels = Object.keys(data || {});
    const rows = order.map((s2) => {
        const cells = levels.map((lv) => Number(((data || {})[lv] || {})[s2] || 0));
        return {
            s2,
            label: STATUS2_LABELS[s2] || String(s2),
            cells,
            total: cells.reduce((a, b) => a + b, 0)
        };
    });
    // 每一档的合计（跨全部状态2）—— 用户 2026-10-13 要求"把柱子上面那行数字搬进表格"，
    // 那行数字就是它（所以直接从同一份 `rows` 求和，别再去数一遍 `data`：两条路会分叉）。
    const colTotals = levels.map((_, i) => rows.reduce((a, r) => a + r.cells[i], 0));
    const grand = colTotals.reduce((a, b) => a + b, 0);
    return { levels, rows, colTotals, grand };
}
