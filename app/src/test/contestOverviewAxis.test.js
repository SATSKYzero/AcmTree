// ================================================================
// 比赛补题概览 — 难度轴数学测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    XCPC_ORDER,
    buildBands,
    positionOf,
    layoutRow,
    cfBands,
    cfDomainMax
} from '../features/ContestOverview/axis.js';
import { SPECIAL_BAND_W, SPECIAL_CENTER } from '../features/ContestOverview/constants.js';

/** 浮点近似断言 */
function near(actual, expected, tol = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= tol,
        `期望 ${expected}±${tol}，实际 ${actual}`);
}

// ================================================================
// XCPC_ORDER
// ================================================================

test('XCPC_ORDER 由易到难共 20 档', () => {
    assert.equal(XCPC_ORDER.length, 20);
    assert.equal(XCPC_ORDER[0], '签到');
    assert.equal(XCPC_ORDER[XCPC_ORDER.length - 1], 'C+');
});

test('XCPC_ORDER 与既定的 20 档顺序逐项一致（档序迁移的保障）', () => {
    // 这份 20 档顺序是唯一的一份定义（`utils/color.js`）。此断言锁定它的顺序不变。
    const expected = [
        '签到', '签到+', '铁牌-', '铁牌', '铁牌+',
        '铜牌-', '铜牌', '铜牌+',
        '银牌-', '银牌', '银牌+',
        '金牌-', '金牌', '金牌+',
        'R-', 'R', 'R+',
        'C-', 'C', 'C+'
    ];
    assert.deepEqual(XCPC_ORDER, expected);
});

// ================================================================
// cfBands / cfDomainMax
// ================================================================

test('cfBands 去掉无穷端并按难度升序', () => {
    const bands = cfBands();
    assert.equal(bands[0].from, 800);
    assert.equal(bands[bands.length - 1].from, 3000);
    assert.equal(bands[bands.length - 1].to, null, '最高档向右延伸');
    for (let i = 1; i < bands.length; i++) {
        assert.ok(bands[i].from > bands[i - 1].from);
    }
});

test('cfDomainMax 默认 3500，随数据向上扩展到百位', () => {
    assert.equal(cfDomainMax([]), 3500);
    assert.equal(cfDomainMax([{ cfDifficulty: 1200 }]), 3500);
    assert.equal(cfDomainMax([{ cfDifficulty: 3600 }]), 3600);
    assert.equal(cfDomainMax([{ cfDifficulty: 3612 }]), 3700);
});

// ================================================================
// buildBands
// ================================================================

test('XCPC 难度带：20 档等宽，铺满特殊带之后的整个区间', () => {
    const bands = buildBands('xcpc');
    assert.equal(bands.length, 20);
    near(bands[0].x0, SPECIAL_BAND_W);
    near(bands[bands.length - 1].x1, 1);

    const w0 = bands[0].x1 - bands[0].x0;
    for (const b of bands) {
        near(b.x1 - b.x0, w0, 1e-9);
    }
    // 首尾档位对应最易/最难
    assert.equal(bands[0].label, '签到');
    assert.equal(bands[19].label, 'C+');
});

test('XCPC 难度带带色取自 XCPC_COLORS', () => {
    const bands = buildBands('xcpc');
    const cPlus = bands.find(b => b.label === 'C+');
    assert.equal(cPlus.color, '#9b59b6');
    const qianDao = bands.find(b => b.label === '签到');
    assert.equal(qianDao.color, '#22c55e');
});

test('CF 难度带：完全线性，宽度随档位差自然不同', () => {
    const bands = buildBands('cf', 3500);
    assert.equal(bands.length, 8);
    // 第一档 800-1199（400 宽）应明显宽于 1200-1399（200 宽）
    const w1 = bands[0].x1 - bands[0].x0;
    const w2 = bands[1].x1 - bands[1].x0;
    near(w1 / w2, 2, 1e-6);
    near(bands[0].x0, SPECIAL_BAND_W);
    near(bands[bands.length - 1].x1, 1);
});

// ================================================================
// positionOf
// ================================================================

test('未填写 / 无难度 → 特殊带中心', () => {
    assert.equal(positionOf({ xcpcDifficulty: '-' }, 'xcpc').special, true);
    assert.equal(positionOf({ xcpcDifficulty: '' }, 'xcpc').special, true);
    assert.equal(positionOf({}, 'xcpc').special, true);
    assert.equal(positionOf({ cfDifficulty: 0 }, 'cf').special, true);
    assert.equal(positionOf({ cfDifficulty: 799 }, 'cf').special, true);

    near(positionOf({ xcpcDifficulty: '-' }, 'xcpc').x, SPECIAL_CENTER);
});

test('XCPC：最容易档的容易端在最左，最难档的难端在最右', () => {
    const easiest = positionOf({ xcpcDifficulty: '签到', ratio: '100' }, 'xcpc');
    near(easiest.x, SPECIAL_BAND_W, 1e-9);

    const hardest = positionOf({ xcpcDifficulty: 'C+', ratio: '0' }, 'xcpc');
    near(hardest.x, 1, 1e-9);
});

test('XCPC：档内线性（ratio 越小越靠右）', () => {
    // 铁牌档 40~55
    const at40 = positionOf({ xcpcDifficulty: '铁牌', ratio: '40' }, 'xcpc');
    const at55 = positionOf({ xcpcDifficulty: '铁牌', ratio: '55' }, 'xcpc');
    assert.ok(at40.x > at55.x, '40% 通过率应比 55% 更靠右');

    const tierW = (1 - SPECIAL_BAND_W) / 20;
    const idx = XCPC_ORDER.indexOf('铁牌');
    const tierStart = SPECIAL_BAND_W + idx * tierW;

    near(at55.x, tierStart, 1e-9);           // 该档最容易端
    near(at40.x, tierStart + tierW, 1e-9);   // 该档最难端
});

test('XCPC：无 ratio 但有等级 → 落在该档中点', () => {
    const tierW = (1 - SPECIAL_BAND_W) / 20;
    const idx = XCPC_ORDER.indexOf('银牌');
    const mid = positionOf({ xcpcDifficulty: '银牌' }, 'xcpc');
    near(mid.x, SPECIAL_BAND_W + idx * tierW + tierW / 2, 1e-9);
});

test('XCPC：档位由 ratio 派生，位置始终落在难度轴内', () => {
    for (const level of XCPC_ORDER) {
        for (const ratio of ['0', '25', '50', '75', '100']) {
            const { x, special } = positionOf({ xcpcDifficulty: level, ratio }, 'xcpc');
            assert.equal(special, false);
            assert.ok(x >= SPECIAL_BAND_W - 1e-9 && x <= 1 + 1e-9,
                `${level} ratio=${ratio} → ${x} 越出难度轴`);
        }
    }
});

test('XCPC：ratio 越小横坐标越靠右（全局单调）', () => {
    // 从最容易到最难逐点采样，x 必须严格不降
    const ratios = [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 5, 1, 0];
    let prev = -Infinity;
    for (const r of ratios) {
        const { x } = positionOf({ ratio: String(r) }, 'xcpc');
        assert.ok(x >= prev, `ratio=${r} 的 x=${x} 小于前一个 ${prev}`);
        prev = x;
    }
});

test('XCPC：等级与 ratio 冲突时以 ratio 为准（与难度柱同源）', () => {
    // 存库 level 写成 铁牌，但 ratio=40 实际属于 铁牌+ 档
    const p = positionOf({ xcpcDifficulty: '铁牌', ratio: '40' }, 'xcpc');
    assert.equal(p.bandKey, '铁牌+', '应以 ratio 派生的档位为准');
    const tierW = (1 - SPECIAL_BAND_W) / 20;
    const expected = SPECIAL_BAND_W + XCPC_ORDER.indexOf('铁牌+') * tierW;
    near(p.x, expected, 1e-9);
});

test('CF：完全线性', () => {
    const at800 = positionOf({ cfDifficulty: 800 }, 'cf', 3500);
    const at3500 = positionOf({ cfDifficulty: 3500 }, 'cf', 3500);
    near(at800.x, SPECIAL_BAND_W, 1e-9);
    near(at3500.x, 1, 1e-9);

    const mid = positionOf({ cfDifficulty: 2150 }, 'cf', 3500);
    const expected = SPECIAL_BAND_W + (1 - SPECIAL_BAND_W) * ((2150 - 800) / (3500 - 800));
    near(mid.x, expected, 1e-9);

    // 等距采样应等距
    const a = positionOf({ cfDifficulty: 1300 }, 'cf', 3500).x;
    const b = positionOf({ cfDifficulty: 1800 }, 'cf', 3500).x;
    const c = positionOf({ cfDifficulty: 2300 }, 'cf', 3500).x;
    near(b - a, c - b, 1e-9);
});

test('CF：超出轴右端被夹到 1', () => {
    const x = positionOf({ cfDifficulty: 4000 }, 'cf', 3500).x;
    near(x, 1, 1e-9);
});

// ================================================================
// layoutRow
// ================================================================

test('layoutRow 按横坐标升序返回', () => {
    const items = layoutRow([
        { xcpcDifficulty: 'C+', ratio: '0' },
        { xcpcDifficulty: '签到', ratio: '100' },
        { xcpcDifficulty: '-' }
    ], 'xcpc');
    for (let i = 1; i < items.length; i++) {
        assert.ok(items[i].x >= items[i - 1].x);
    }
});

test('layoutRow 距离过近时错开标签行', () => {
    // 两道完全同难度的题 → x 相同 → 必须分到不同 lane
    const items = layoutRow([
        { problemId: 'A', xcpcDifficulty: '银牌', ratio: '10' },
        { problemId: 'B', xcpcDifficulty: '银牌', ratio: '10' }
    ], 'xcpc');
    assert.equal(items.length, 2);
    assert.notEqual(items[0].lane, items[1].lane, '同坐标的两题应错开标签行');
});

test('layoutRow 距离足够远时都在同一行', () => {
    const items = layoutRow([
        { problemId: 'A', xcpcDifficulty: '签到', ratio: '100' },
        { problemId: 'B', xcpcDifficulty: 'C+', ratio: '0' }
    ], 'xcpc');
    assert.deepEqual(items.map(i => i.lane), [0, 0]);
});

test('layoutRow 空数组安全', () => {
    assert.deepEqual(layoutRow([], 'xcpc'), []);
    assert.deepEqual(layoutRow(undefined, 'cf'), []);
});
