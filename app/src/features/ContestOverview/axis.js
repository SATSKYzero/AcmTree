// ================================================================
// 比赛补题概览 — 难度轴数学（features/ContestOverview/axis.js）
// 职责：难度 → 横坐标映射、竖向难度带划分、行内标签防重叠
// 依赖：A_constants.js, utils/color.js
// 说明：本模块**不碰 DOM**，可在 Node 测试中直接引用。
//
// 映射约定（横轴：左易右难）：
//   [0, SPECIAL_BAND_W)          特殊带（未填写 / 其他（<800））
//   [SPECIAL_BAND_W, 1]          难度轴
//     - XCPC：20 档等宽，档内按 ratio 线性（档内越难越靠右）
//     - CF  ：完全线性，档位仅用于着色
// ================================================================
import { XCPC_COLORS, CF_COLORS } from '../../A_constants.js';
import { getXcpcRange, XCPC_ORDER as SHARED_XCPC_ORDER } from '../../utils/color.js';
import {
    SPECIAL_BAND_W,
    SPECIAL_CENTER,
    CF_MIN,
    CF_DEFAULT_MAX,
    LABEL_MIN_GAP
} from './constants.js';

/**
 * XCPC 等级顺序（由易到难）。
 * 真源在 utils/color.js（与 getXcpcRange 同处），这里再导出以便本插件内部与测试使用。
 * 结果与 statsCharts.js 的 XCPC_ORDER 完全一致：
 *   签到, 签到+, 铁牌-, …, R+, C-, C, C+
 */
export const XCPC_ORDER = SHARED_XCPC_ORDER;

/**
 * 默认取值器：直接读缓存字段。
 * 调用方（插件的 index.js）会传入**按查看范围**取值的版本 —— 见 collect.js 的说明。
 */
const cacheRead = {
    value: (node, field) => node[field],
    derived: (node, field) => node[field]
};

/** 取某等级的 XCPC 颜色 */
function xcpcColorOf(level) {
    return XCPC_COLORS[level] || '#94a3b8';
}

/**
 * CF 难度带（派生自 CF_COLORS，去掉 ±∞ 两端）
 * @returns {Array<{from:number, to:number|null, color:string}>} to 为 null 表示延伸到轴右端
 */
export function cfBands() {
    return CF_COLORS
        .filter(e => Number.isFinite(e.range[0]) && e.range[0] >= CF_MIN)
        .map(e => ({
            from: e.range[0],
            to: Number.isFinite(e.range[1]) ? e.range[1] : null,
            color: e.color
        }));
}

/** 夹取到 [0,1] */
function clamp01(v) {
    if (!Number.isFinite(v)) return 0;
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 难度带区间 → 归一化 x 区间（右端按开区间处理，保证档与档无缝相接） */
function bandToX(from, to, domainMax) {
    const span = domainMax - CF_MIN;
    const usable = 1 - SPECIAL_BAND_W;
    if (span <= 0) return { x0: SPECIAL_BAND_W, x1: 1 };
    // to 是闭区间右端（如 1199），作为边界应取到 1200，否则相邻档之间会出现缝隙
    const right = to === null ? domainMax : to + 1;
    const x0 = SPECIAL_BAND_W + usable * clamp01((from - CF_MIN) / span);
    const x1 = SPECIAL_BAND_W + usable * clamp01((right - CF_MIN) / span);
    return { x0, x1 };
}

/**
 * 取 CF 难度轴右端（随数据扩展，向上取整到百位）
 * @param {Array<Object>} problems
 * @returns {number}
 */
export function cfDomainMax(problems = [], read = cacheRead) {
    let max = CF_DEFAULT_MAX;
    for (const p of problems) {
        const d = Number(read.value(p, 'cfDifficulty')) || 0;
        if (d > max) max = d;
    }
    return Math.ceil(max / 100) * 100;
}

/**
 * 构建竖向难度带
 * @param {'xcpc'|'cf'} chartType
 * @param {number} domainMax - CF 轴右端（xcpc 忽略）
 * @returns {Array<{key:string, label:string, x0:number, x1:number, color:string}>}
 */
export function buildBands(chartType, domainMax = CF_DEFAULT_MAX) {
    const bands = [];

    if (chartType === 'cf') {
        for (const b of cfBands()) {
            const { x0, x1 } = bandToX(b.from, b.to, domainMax);
            if (x1 > x0) {
                bands.push({
                    key: `cf-${b.from}`,
                    label: b.to === null ? `${b.from}+` : `${b.from}-${b.to}`,
                    x0, x1, color: b.color
                });
            }
        }
        return bands;
    }

    const usable = 1 - SPECIAL_BAND_W;
    const tierW = usable / XCPC_ORDER.length;
    for (let i = 0; i < XCPC_ORDER.length; i++) {
        const level = XCPC_ORDER[i];
        bands.push({
            key: level,
            label: level,
            x0: SPECIAL_BAND_W + i * tierW,
            x1: SPECIAL_BAND_W + (i + 1) * tierW,
            color: xcpcColorOf(level)
        });
    }
    return bands;
}

/**
 * 计算单个题目的横坐标
 * @param {Object} p - P 节点
 * @param {'xcpc'|'cf'} chartType
 * @param {number} domainMax
 * @returns {{x:number, special:boolean, bandKey:string|null}}
 */
export function positionOf(p, chartType, domainMax = CF_DEFAULT_MAX, read = cacheRead) {
    if (chartType === 'cf') {
        const d = Number(read.value(p, 'cfDifficulty')) || 0;
        if (!(d >= CF_MIN)) {
            return { x: SPECIAL_CENTER, special: true, bandKey: null };
        }
        const usable = 1 - SPECIAL_BAND_W;
        const x = SPECIAL_BAND_W + usable * clamp01((d - CF_MIN) / (domainMax - CF_MIN));

        // 反查所属难度带（仅用于 tooltip / 着色参考）
        let bandKey = null;
        for (const b of cfBands()) {
            const upper = b.to === null ? Number.POSITIVE_INFINITY : b.to;
            if (d >= b.from && d <= upper) { bandKey = `cf-${b.from}`; break; }
        }
        return { x, special: false, bandKey };
    }

    // ---- XCPC：档等宽，档内线性 ----
    const usable = 1 - SPECIAL_BAND_W;
    const tierW = usable / XCPC_ORDER.length;

    // ratio 有效时以它为准——难度等级本就由 ratio 派生（与 C 节点小方框难度柱同源），
    // 这样即使存库的 level 与 ratio 不一致，位置也不会自相矛盾。
    const ratio = read.value(p, 'ratio');
    const num = parseFloat(ratio);
    if (Number.isFinite(num) && num >= 0 && num <= 100) {
        const info = getXcpcRange(ratio);
        if (info) {
            const idxByRatio = XCPC_ORDER.indexOf(info.level);
            if (idxByRatio >= 0) {
                // 档内难度系数 t：0 = 该档最容易端，1 = 最难端（ratio 越小越难）
                let t = 0.5;
                if (info.upper > info.lower) {
                    t = clamp01((info.upper - num) / (info.upper - info.lower));
                }
                return {
                    x: SPECIAL_BAND_W + idxByRatio * tierW + t * tierW,
                    special: false,
                    bandKey: info.level
                };
            }
        }
    }

    // 无有效 ratio：按存储的等级落档，取档中位置
    const level = read.derived(p, 'xcpcDifficulty');
    const idx = XCPC_ORDER.indexOf(level);
    if (idx < 0) {
        // '-' / '' / undefined 视为未填写
        return { x: SPECIAL_CENTER, special: true, bandKey: null };
    }
    return {
        x: SPECIAL_BAND_W + idx * tierW + tierW / 2,
        special: false,
        bandKey: level
    };
}

/**
 * 排布一行内的所有题目：给出横坐标并错开标签行，避免题号文字重叠
 * @param {Array<Object>} problems
 * @param {'xcpc'|'cf'} chartType
 * @param {number} domainMax
 * @returns {Array<{problem:Object, x:number, special:boolean, bandKey:string|null, lane:number}>}
 */
export function layoutRow(problems = [], chartType = 'xcpc', domainMax = CF_DEFAULT_MAX, read = cacheRead) {
    const items = problems.map(p => {
        const pos = positionOf(p, chartType, domainMax, read);
        return { problem: p, x: pos.x, special: pos.special, bandKey: pos.bandKey, lane: 0 };
    });

    // 按 x 排序后依次分配标签行；非特殊项之间才需要错开
    items.sort((a, b) => a.x - b.x);

    const lastXByLane = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const it of items) {
        // 优先放 0 行；与 0 行上一个太近则放 1 行
        let lane = 0;
        if (it.x - lastXByLane[0] < LABEL_MIN_GAP) {
            lane = it.x - lastXByLane[1] < LABEL_MIN_GAP ? 0 : 1;
        }
        it.lane = lane;
        lastXByLane[lane] = it.x;
    }

    return items;
}
