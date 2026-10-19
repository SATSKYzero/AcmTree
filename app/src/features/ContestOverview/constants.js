// ================================================================
// 比赛补题概览 — 常量（features/ContestOverview/constants.js）
// ================================================================

/** 左侧比赛名栏宽度（px） */
export const NAME_GUTTER_W = 132;

/** 每个比赛行的高度（px） */
export const ROW_H = 56;

/** 大矩形的内边距（px） */
export const CANVAS_PAD = 10;

/** 难度轴左侧「特殊项」保留带宽（归一化 0~1）——未填写 / 其他（<800） */
export const SPECIAL_BAND_W = 0.08;

/** 特殊带的中心位置（归一化） */
export const SPECIAL_CENTER = SPECIAL_BAND_W / 2;

/** CF 难度轴左端（低于此值归入「其他」） */
export const CF_MIN = 800;

/** CF 难度轴默认右端，实际会随数据扩展 */
export const CF_DEFAULT_MAX = 3500;

/** 难度带的淡色透明度 */
export const BAND_ALPHA = 0.14;

/** 两个题目的 x 距离小于此值时，题号标签错开一行（避免文字重叠） */
export const LABEL_MIN_GAP = 0.042;

/** 视图视图类型 → 特殊分组标签 */
export const SPECIAL_LABEL = {
    cf: '其他（<800）',
    xcpc: '未填写'
};

/** 特殊项颜色（与 statsCharts 保持一致） */
export const SPECIAL_COLOR = '#94a3b8';

/** status1 = 1（已选中）时给点加上的橙色外圈 */
export const SELECTED_RING = '0 0 0 2px #f97316';
