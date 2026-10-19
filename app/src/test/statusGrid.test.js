// ================================================================
// 统计图下面那张「网格表」的数据（src/test/statusGrid.test.js）
//
// 覆盖 `ui/stats/statusGrid.js:statusGridOf`（**纯函数**，不碰 DOM）：
//   · 列 = 难度档，顺序 = 图那一份 `data` 的键序（**图与表同一次分档结果**）；
//   · 行 = 状态2，顺序 = `STATUS2_ORDER` **正序**（未使用在最上）；
//   · 格 = 题数；每行最右 = 该状态2的合计。
//
// ⚠️ 这里钉的是"**行序别再反过来**"：用户 2026-10-13 先说"行的顺序与柱状图相反"、
//    随后明确"还是别反了" ⇒ 正序是**定稿**，谁把它改成 `reverse()` 这条当场红。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { statusGridOf, STATUS2_ORDER } from '../ui/stats/statusGrid.js';
import { STATUS2_LABELS } from '../A_constants.js';

/** 与画图同一形状的夹具：`{ 难度档: { 状态2: 题数 } }` */
const DATA = {
    '未写': { 0: 349, 4: 7 },
    '签到': { 0: 29, 1: 1, 4: 1 },
    '银牌': { 0: 14, 2: 3, 5: 1 }
};

test('列 = 难度档，顺序与图那一份 data 的键序一致', () => {
    const g = statusGridOf(DATA);
    assert.deepEqual(g.levels, ['未写', '签到', '银牌']);
});

test('★ 行序 = STATUS2_ORDER 正序（未使用在最上、忽略在最下，不取倒序）', () => {
    const g = statusGridOf(DATA);
    assert.deepEqual(g.rows.map(r => r.s2), STATUS2_ORDER);
    assert.deepEqual(g.rows.map(r => r.s2), [0, 1, 2, 3, 4, 5]);
    assert.equal(g.rows[0].label, STATUS2_LABELS[0]);
    assert.equal(g.rows[g.rows.length - 1].label, STATUS2_LABELS[5]);
});

test('格 = 该档 × 该状态2 的题数（缺格按 0），列序与 levels 对齐', () => {
    const g = statusGridOf(DATA);
    assert.deepEqual(g.rows[0].cells, [349, 29, 14], '未使用：未写 349 / 签到 29 / 银牌 14');
    assert.deepEqual(g.rows[1].cells, [0, 1, 0], '待写：只有签到 1');
    assert.deepEqual(g.rows[2].cells, [0, 0, 3], '已提交未通过：只有银牌 3');
    assert.deepEqual(g.rows[4].cells, [7, 1, 0], '赛时通过：未写 7 / 签到 1');
    assert.deepEqual(g.rows[5].cells, [0, 0, 1], '忽略：只有银牌 1');
});

test('★ 每行最右 = 该状态2的合计（跨全部难度档求和）', () => {
    const g = statusGridOf(DATA);
    assert.equal(g.rows[0].total, 349 + 29 + 14);
    assert.equal(g.rows[1].total, 1);
    assert.equal(g.rows[2].total, 3);
    assert.equal(g.rows[3].total, 0, '一格都没有的状态2 ⇒ 合计 0（不是 NaN/undefined）');
    assert.equal(g.rows[4].total, 8);
    assert.equal(g.rows[5].total, 1);
    // 所有行的合计之和 = 图上所有柱段的总数（两条路算出来必须是同一个数）
    const sumRows = g.rows.reduce((a, r) => a + r.total, 0);
    const sumData = Object.values(DATA).reduce(
        (a, counts) => a + Object.values(counts).reduce((x, y) => x + y, 0), 0);
    assert.equal(sumRows, sumData);
});

test('★ 每一档的合计 colTotals + 最右的总数 grand（= 原先画在柱子上面的那行数字）', () => {
    const g = statusGridOf(DATA);
    assert.deepEqual(g.colTotals, [349 + 7, 29 + 1 + 1, 14 + 3 + 1],
        '未写 / 签到 / 银牌 三档的合计（**按档**跨状态2 求和：356 / 31 / 18）');
    // 同一件事必须有两条路能对上：① 各列格子相加；② 各行合计相加
    assert.equal(g.grand, g.rows.reduce((a, r) => a + r.total, 0));
    assert.equal(g.grand, g.colTotals.reduce((a, b) => a + b, 0));
    assert.equal(g.grand, 349 + 7 + 29 + 1 + 1 + 14 + 3 + 1, '也等于 data 里所有题数之和');
    // 空数据：三个数都必须是 0（不是 NaN/undefined）
    const empty = statusGridOf({});
    assert.deepEqual(empty.colTotals, []);
    assert.equal(empty.grand, 0);
    assert.deepEqual(statusGridOf({ '未写': { 0: 5 }, '签到': { 4: 2 } }).colTotals, [5, 2]);
});

test('空数据 / 缺列：不炸，行仍在（每行全 0）', () => {
    const empty = statusGridOf({});
    assert.deepEqual(empty.levels, []);
    assert.deepEqual(empty.rows.map(r => r.total), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(statusGridOf(null).levels, [], 'null 当空数据（调用点可能还没算完）');
    // 某一档**整列缺这个状态2**的键 ⇒ 那一格按 0，不是 undefined
    const partial = statusGridOf({ '未写': {} });
    assert.deepEqual(partial.rows[0].cells, [0]);
});
