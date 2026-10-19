// ================================================================
// 颜色映射（utils/color.js）
// 职责：CF 难度颜色、XCPC 难度等级与范围
// 依赖：A_constants.js
// ================================================================
import { CF_COLORS, XCPC_THRESHOLDS } from '../A_constants.js';

export function getCfColor(val) {
    for (const entry of CF_COLORS) {
        if (val >= entry.range[0] && val <= entry.range[1]) return entry.color;
    }
    return '#6b7280';
}

export function getXcpcDifficulty(ratioPercent) {
    if (ratioPercent === null || ratioPercent === undefined || ratioPercent === '' || isNaN(ratioPercent)) return '-';
    const r = parseFloat(ratioPercent);
    if (r < 0 || r > 100) return '-';
    for (const entry of XCPC_THRESHOLDS) {
        if (r >= entry.lower && r <= entry.upper) {
            return entry.level;
        }
    }
    return '签到';
}

export function getXcpcRange(ratioPercent) {
    if (ratioPercent === null || ratioPercent === undefined || ratioPercent === '' || isNaN(ratioPercent)) return null;
    const r = parseFloat(ratioPercent);
    if (r < 0 || r > 100) return null;
    for (const entry of XCPC_THRESHOLDS) {
        if (r >= entry.lower && r <= entry.upper) {
            return { level: entry.level, lower: entry.lower, upper: entry.upper };
        }
    }
    return null;
}

// ================================================================
// XCPC 难度等级顺序（由难到易排列的 XCPC_THRESHOLDS 反转而来）
// 供需要"档位排序/比较"的地方共用，避免各处各写一份
// 低 → 高：签到, 签到+, 铁牌-, …, R+, C-, C, C+
// ================================================================
export const XCPC_ORDER = XCPC_THRESHOLDS.map(t => t.level).reverse();

/**
 * 「未填写难度」在界面上的名字 —— 它是**兜底档**（不在 `XCPC_ORDER` 那 20 档里）。
 *
 * ⚠️ **这里是唯一一份**：凡是"档位筛选项 / 分档键 / 网格列"需要这个字面量，都 import 它，
 *    别再加第 N 份（`ui/stats/statsCharts.js` / `features/ContestOverview` 里还各有一份**局部**的同名串，
 *    改到那两处时顺手改成 import 这一个）。
 * ⚠️ 筛选用它当**哨兵值**：`core/problemPick.js:matchesProblemFilter` 把"认不出的档位"一律算成
 *    这个值 ⇒ 勾上它 = 「要那些没填难度的题」（而不是"什么都不匹配"）。
 */
export const XCPC_UNFILLED = '未填写';

/**
 * 取难度等级在顺序表中的下标（越大越难）
 * @param {string} level - XCPC 等级，如 '银牌'；'-' / '' / 未知 返回 -1
 * @returns {number} 下标，未填写返回 -1
 */
export function getXcpcLevelIndex(level) {
    if (!level || level === '-') return -1;
    return XCPC_ORDER.indexOf(level);
}