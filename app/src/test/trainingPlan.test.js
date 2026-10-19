// ================================================================
// 训练计划纯逻辑测试（core/trainingPlan.js）
//
// 设计依据：`docs/training-plan.md`（v5）。这里钉的是**会红的口径**：
//   · 期与粒度（㉑ 折算、⑲ 粒度、⑳ 执行/查看两套粒度互相独立）
//   · 训练强度查表（⑮⑯⑰：全局若干张表 / 计划选自选源 / 没填难度按默认值）
//   · 题集（①③㉒：只来自副页；C 子树里的题也算；同一题只算一次）
//   · 各期达成（④ 状态口径、③ 组层去重跟整体计数口径走）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { USER_FIELDS, META_FIELD_KEYS, metaDefaults, importedState } from '../A_registry.js';

import {
    PLAN_GRAINS,
    DEFAULT_PLAN_GRAIN,
    DEFAULT_CHART_GRAINS,
    DEFAULT_PLAN_STATUSES,
    DEFAULT_INTENSITY_TABLE,
    dayKeyOf,
    addDays,
    daysBetween,
    mondayOf,
    periodKeyOf,
    periodLabelOf,
    daysInPeriod,
    spanDays,
    periodsBetween,
    intensityTableById,
    intensityOf,
    intensityAtPoints,
    cfIntensityAt,
    CF_INTENSITY_FLOOR_AT,
    CF_INTENSITY_MAX,
    CF_INTENSITY_TOP,
    xcpcIntensityAt,
    xcpcIntensityPoints,
    ratioEquivCfAt,
    RATIO_INTENSITY_KNEE,
    RATIO_INTENSITY_TOP_AT,
    xcpcPointLabelOf,
    xcpcPointTextOf,
    cfPointTextOf,
    planProblemsOf,
    dailyQuotaOf,
    periodGoalOf,
    planProgressOf,
    planChartSeriesOf,
    planForecastOf,
    planSubtreeIntensityOf
} from '../core/trainingPlan.js';

// ----------------------------------------------------------------
// 期与粒度
// ----------------------------------------------------------------

test('粒度名单只有四种，默认是日；两张图的默认查看粒度是 日 / 周（⑳）', () => {
    assert.deepEqual(PLAN_GRAINS, ['day', 'week', 'month', 'all']);
    assert.equal(DEFAULT_PLAN_GRAIN, 'day');
    assert.deepEqual(DEFAULT_CHART_GRAINS, { line: 'day', bar: 'week' });
    assert.deepEqual(DEFAULT_PLAN_STATUSES, [3, 4]);
});

test('dayKeyOf：只认仓里那一种时间写法，取不出来给空串（= 这题没定期）', () => {
    assert.equal(dayKeyOf('2026.10.05 10:00:00'), '2026.10.05');
    assert.equal(dayKeyOf('2026.10.05 10:00'), '2026.10.05');
    assert.equal(dayKeyOf('2026-10-05T10:00:00+08:00'), '2026.10.05');
    assert.equal(dayKeyOf('----.--.-- --:--'), '');
    assert.equal(dayKeyOf(''), '');
    assert.equal(dayKeyOf(null), '');
});

test('周一~周日算一周：周日归**前面那个周一**（不是下一周）', () => {
    assert.equal(mondayOf('2026.10.05'), '2026.10.05');      // 2026-10-05 是周一
    assert.equal(mondayOf('2026.10.11'), '2026.10.05');      // 周日 ⇒ 还是这一周
    assert.equal(mondayOf('2026.10.12'), '2026.10.12');      // 下一个周一
    assert.equal(addDays('2026.10.05', 6), '2026.10.11');
    assert.equal(daysBetween('2026.11.01', '2026.10.31'), 1); // 跨月
});

test('periodKeyOf：四种粒度各给一种键；`all` 恒为 all；没日期给空串', () => {
    const t = '2026.10.07 21:30:00';                          // 周三
    assert.equal(periodKeyOf(t, 'day'), '2026.10.07');
    assert.equal(periodKeyOf(t, 'week'), '2026.10.05');
    assert.equal(periodKeyOf(t, 'month'), '2026.10');
    assert.equal(periodKeyOf(t, 'all'), 'all');
    assert.equal(periodKeyOf('----.--.-- --:--', 'day'), '');
    assert.equal(periodKeyOf(t, 'bogus'), '2026.10.07');      // 非法粒度 ⇒ 退回默认（日）
});

test('periodLabelOf 给人看的短标签；daysInPeriod 与 spanDays（㉑ 折算的尺子）', () => {
    assert.equal(periodLabelOf('2026.10.07', 'day'), '2026.10.07', '★ 带年份（用户 2026-10-13 要的）');
    assert.equal(periodLabelOf('2026.10.05', 'week'), '2026.10.05~10.11', '★ 带年份（同年只写一次）');
    assert.equal(periodLabelOf('2026.10', 'month'), '2026.10');
    assert.equal(periodLabelOf('all', 'all'), '整段');
    assert.equal(daysInPeriod('2026.10.07', 'day'), 1);
    assert.equal(daysInPeriod('2026.10.05', 'week'), 7);
    assert.equal(daysInPeriod('2026.02', 'month'), 28);
    assert.equal(daysInPeriod('2024.02', 'month'), 29);       // 闰年
    assert.equal(daysInPeriod('2026.10', 'month'), 31);
    assert.equal(spanDays('2026.10.01', '2026.10.01'), 1);
    assert.equal(spanDays('2026.10.01', '2026.10.31'), 31);
});

test('periodsBetween：连续期列表（空期也占位）；跨月、按周对齐、all 只有一格', () => {
    assert.deepEqual(periodsBetween('2026.10.01', '2026.10.03', 'day'),
        ['2026.10.01', '2026.10.02', '2026.10.03']);
    assert.deepEqual(periodsBetween('2026.10.28', '2026.11.02', 'month'), ['2026.10', '2026.11']);
    assert.deepEqual(periodsBetween('2026.10.07', '2026.10.20', 'week'),
        ['2026.10.05', '2026.10.12', '2026.10.19']);          // 起点所在那一周起算
    assert.deepEqual(periodsBetween('2026.10.01', '2026.12.31', 'all'), ['all']);
    assert.deepEqual(periodsBetween('', '2026.10.03', 'day'), []);
});

// ----------------------------------------------------------------
// 训练强度（⑮⑯⑰）
// ----------------------------------------------------------------

test('★ 强度查表（第 5 轮起 = 按通过率插值）：C/R 最大，随通过率平滑下降', () => {
    const t = DEFAULT_INTENSITY_TABLE;
    const node = (ratio) => ({ id: 'p', values: { ratio: [{ v: String(ratio), src: 'manual', at: 'T', account: '' }] } });
    const shown = (n, f) => { const l = (n.values || {})[f]; return l && l.length ? l[0].v : undefined; };
    const at = (r) => intensityOf(node(r), { table: t, source: 'xcpc', shownValue: shown });
    // C/R 那一段（通过率 ≤ 0.11% 起）是**最大**值；一路平滑降到 100% 的 1.26（不是 1）
    assert.equal(at(0.02).value, 113.14, '通过率 0.02%（C+ 一带，已到顶）⇒ 最大强度（4000 分封顶）');
    assert.equal(at(0.02).usedDefault, false);
    assert.equal(at(100).value, 1.26, '通过率 100%（签到）⇒ 最低强度 1.26');
    assert.ok(at(1).value > at(5).value && at(5).value > at(20).value && at(20).value > at(90).value,
        '★ 单调：通过率越大（越容易）强度越低');
    // 插值（不是台阶）：两个控制点之间的值应当**严格落在两者之间**
    const v8 = at(8).value;
    const v11 = at(11).value;
    const v9 = at(9).value;
    assert.ok(v9 < v8 && v9 > v11, `9% 应当落在 8%(${v8}) 与 11%(${v11}) 之间，实际 ${v9}`);
    // 没有 ratio、但有档位 ⇒ 用那一档区间的中点近似
    const noRatio = intensityOf({ id: 'p', xcpcDifficulty: 'R' }, { table: t, source: 'xcpc' });
    assert.equal(noRatio.usedDefault, false, '有档位就还能算（别退回默认值）');
    assert.ok(noRatio.value > 22 && noRatio.value < 27, `R 档中点（0.67%）应当落在 R+/R- 之间，实际 ${noRatio.value}`);
    // 两样都没有 ⇒ 默认值
    assert.equal(intensityOf({ id: 'p' }, { table: t, source: 'xcpc' }).usedDefault, true);
});

test('★ 通过率侧的口径（第 9 轮）：通过率 → 等价数值难度 → 复用那条式子（"不会明写，只是数值一致"）', () => {
    // ① 折线本身：16% 对标 2200，更难侧**每折半 +200 分**、更易侧**每翻倍 −300 分**
    assert.equal(RATIO_INTENSITY_KNEE, 16);
    assert.equal(ratioEquivCfAt(16), 2200, '16% 对标 2200');
    assert.equal(ratioEquivCfAt(8), 2400, '8% = 16% 折半 ⇒ +200');
    assert.equal(ratioEquivCfAt(4), 2600, '4% ⇒ 2600');
    assert.equal(ratioEquivCfAt(2), 2800, '2% ⇒ 2800（再折半）');
    assert.equal(ratioEquivCfAt(32), 1900, '32% = 16% 翻倍 ⇒ −300');
    assert.equal(ratioEquivCfAt(64), 1600, '64% ⇒ 1600（再翻倍）');
    assert.equal(ratioEquivCfAt(0), null, '通过率读不出 / ≤ 0 ⇒ null');
    assert.equal(ratioEquivCfAt(''), null, '空串也是 null（别落到 Number(\'\')===0）');
    // ② 上限：等价分**对 `CF_INTENSITY_TOP` 封顶**（"上限对标 3500"／第 10 轮"其实上限改成 4000 也行"）
    assert.ok(Math.abs(ratioEquivCfAt(RATIO_INTENSITY_TOP_AT) - CF_INTENSITY_TOP) < 0.01,
        '封顶点处的等价分就是上限（它按 5 位小数取的，差不到 0.01）');
    assert.equal(CF_INTENSITY_TOP, 4000, '上限取 4000');
    assert.ok(Math.abs(ratioEquivCfAt(0.11) - 3636.88) < 0.01, 'C+ 那一档（0.11%）还没到顶 ⇒ 给的是一条真实分值');
    assert.equal(xcpcIntensityAt(0.11), 60.3, '于是 C+ 给 60.3 —— 不再是"整档压在 47.57 上"');
    assert.equal(xcpcIntensityAt(0.001), CF_INTENSITY_MAX, '比封顶点更难的取封顶强度 113.14');
    assert.equal(xcpcIntensityAt(0.03125), CF_INTENSITY_MAX, '封顶点自己也是封顶强度');
    // ③ 强度：就是那条式子作用在等价分上（用户点名的几个数）
    for (const [r, cf] of [[16, 2200], [8, 2400], [4, 2600], [2, 2800], [1, 3000], [32, 1900], [64, 1600], [100, 1406.83]]) {
        assert.equal(xcpcIntensityAt(r), cfIntensityAt(ratioEquivCfAt(r)), `${r}% 走的就是那条式子`);
        assert.equal(xcpcIntensityAt(r), cfIntensityAt(cf), `${r}% ⇒ 等价 ${cf} 分 ⇒ ${cfIntensityAt(cf)}`);
    }
    assert.equal(xcpcIntensityAt(16), 5, '16% ⇒ 2200 的强度 5');
    assert.equal(xcpcIntensityAt(8), 7.07, '8% ⇒ 2400 的强度 7.07');
    assert.equal(xcpcIntensityAt(4), 10, '4% ⇒ 2600 的强度 10');
    // ④ 下限：式子触底（= 1）的等价分是 1271，那要**通过率 400%** ⇒ 通过率侧**永远到不了 1**
    assert.equal(xcpcIntensityAt(100), 1.26, '通过率 100%（最容易）⇒ 1.26，不是 1');
    assert.ok(CF_INTENSITY_FLOOR_AT < ratioEquivCfAt(100),
        '触底点（1271 分）比"通过率 100%"的等价分（≈1407）还低 ⇒ 通过率侧永远够不到那个 1');
    // ⑤ 控制点：各档的通过率上限 + 式子自己的两个折点（共 22 个），**每一点都取自同一条式子**
    const pts = xcpcIntensityPoints();
    assert.equal(pts.length, 22, '20 个档位上限 + 拐点 16% + 封顶点');
    assert.deepEqual(pts, DEFAULT_INTENSITY_TABLE.byRatio, '出厂表用的就是这一份（别是第二份手抄）');
    for (const p of pts) {
        assert.equal(p.value, xcpcIntensityAt(p.max), `控制点 ${p.max}% 的值应当就是式子的值`);
    }
    assert.ok(pts.some((p) => p.max === RATIO_INTENSITY_TOP_AT), '封顶点在控制点里');
    assert.ok(pts.some((p) => p.max === RATIO_INTENSITY_KNEE), '拐点也在控制点里');
    // 旁注（档名 / 拐点 / 到顶）只有一份实现
    assert.equal(xcpcPointLabelOf(11), '银牌');
    assert.equal(xcpcPointLabelOf(RATIO_INTENSITY_KNEE), '拐点');
    assert.equal(xcpcPointLabelOf(RATIO_INTENSITY_TOP_AT), '到顶');
    assert.equal(xcpcPointLabelOf(7.77), '', '手加的点没有旁注');
    // 计划页那一栏**怎么写**（左边那半句）——用户第 11 轮点名的两处写法
    assert.equal(xcpcPointTextOf(RATIO_INTENSITY_TOP_AT), '0.031%及更小', '最难那一点：它管"这个值以及更难的"');
    assert.equal(xcpcPointTextOf(100), '签到 100%');
    assert.equal(xcpcPointTextOf(11), '银牌 11%');
    assert.equal(xcpcPointTextOf(RATIO_INTENSITY_KNEE), '拐点 16%');
    assert.equal(xcpcPointTextOf(7.77), '7.77%', '手加的点就写通过率');
    assert.equal(xcpcPointTextOf(null), '（兜底）');
    assert.equal(cfPointTextOf(CF_INTENSITY_TOP), '4000及以上', '数值侧上限那一点');
    assert.equal(cfPointTextOf(2600), '2600');
    assert.equal(cfPointTextOf(null), '（兜底）');
    // ⑥ 查表 vs 式子：**横轴取对数** ⇒ 除"控制点只存两位小数"外处处相等（实测 <1%）
    let worst = 0;
    for (let x = RATIO_INTENSITY_TOP_AT; x <= 100; x += 0.01) {
        const got = intensityAtPoints(pts, x, 'exp', true);
        worst = Math.max(worst, Math.abs(got - xcpcIntensityAt(x)) / xcpcIntensityAt(x));
    }
    assert.ok(worst < 0.01, `取对数后全区间最大相对偏差应当 <1%（实测 ${(worst * 100).toFixed(2)}%）`);
    // ⚠️ 反证：不取对数（老写法）在同一段上会明显跑偏（顶段跨 3.5 倍时实测 10%）
    const noLog = intensityAtPoints(pts, 0.0633, 'exp', false);
    assert.ok(Math.abs(noLog - xcpcIntensityAt(0.0633)) / xcpcIntensityAt(0.0633) > 0.05,
        `不取对数时顶段会偏到 ${((Math.abs(noLog - xcpcIntensityAt(0.0633)) / xcpcIntensityAt(0.0633)) * 100).toFixed(1)}%`);
    // x = 0（真数据里 632 道题的 ratio 就是 0.00）⇒ 取第一个控制点，不炸（log(0) 要躲开）
    assert.equal(intensityAtPoints(pts, 0, 'exp', true), CF_INTENSITY_MAX, 'ratio = 0 ⇒ 封顶强度');
    assert.equal(intensityOf({}, { table: DEFAULT_INTENSITY_TABLE, source: 'xcpc', numericValue: 0 }).value, 0,
        '（数值源那边 0 = "没填难度" ⇒ 强度 0）');
});

test('★ 强度查表（数值源）：**一条式子** 2600→10、每 400 分翻倍、对 1 取 max（≈1271 前都是 1）', () => {
    const t = DEFAULT_INTENSITY_TABLE;
    // 用户第 7 轮举的那几个数（逐条对拍）
    assert.equal(cfIntensityAt(2600), 10, '基准点 2600 ⇒ 10');
    assert.equal(cfIntensityAt(3000), 20, '3000 ⇒ 20（+400 翻倍）');
    assert.equal(cfIntensityAt(3400), 40, '3400 ⇒ 40');
    assert.equal(cfIntensityAt(2200), 5, '2200 ⇒ 5（−400 减半）');
    assert.equal(cfIntensityAt(1800), 2.5, '1800 ⇒ 2.5');
    // ⚠️ 用户写的是"1600 取 1.25"，严格式子给的是 1600 → 1.77、**1400** → 1.25；
    //    而他给的"1271 触底"正好是严格式子的解 ⇒ 以式子为准（已在报告里点明这一处）
    assert.equal(cfIntensityAt(1400), 1.25, '1400 ⇒ 1.25（他写的 1.25 是这一档）');
    assert.equal(cfIntensityAt(1600), 1.77, '1600 ⇒ 1.77（严格式子，不是 1.25）');
    // 下限：式子 ≈1271.2 处触底 1
    assert.equal(CF_INTENSITY_FLOOR_AT, 1271, '触底点 = 2600 − 400·log2(10) ≈ 1271');
    assert.equal(cfIntensityAt(1271), 1);
    assert.equal(cfIntensityAt(800), 1, '比触底点还低 ⇒ 取 max 的 1');
    assert.equal(cfIntensityAt(0), null, '0 / 不是数 ⇒ null（走默认强度）');
    // ★ 上限（第 9 轮用户："数值难度的强度计算上限也是 3500，3500 以上与 3500 同强度"；
    //   第 10 轮："其实上限改成 4000 也行"）
    assert.equal(CF_INTENSITY_TOP, 4000);
    assert.equal(CF_INTENSITY_MAX, 113.14, '上限处的强度就是全表的上限');
    assert.equal(cfIntensityAt(4000), CF_INTENSITY_MAX);
    assert.equal(cfIntensityAt(4500), CF_INTENSITY_MAX, '比上限高 ⇒ 同强度（式子里就封顶，不靠查表兜）');
    assert.equal(cfIntensityAt(9999), CF_INTENSITY_MAX);
    assert.equal(cfIntensityAt(3500), 47.57, '3500 那一点照式子算（真数据里 cf 最高就是它）');
    // 查表走的就是这条式子：**采样点上逐字相等**，格之间线性相接的偏差 <1.5%
    const byLookup = (d) => intensityOf({}, { table: t, source: 'cf', numericValue: d }).value;
    for (const d of [1400, 1800, 2200, 2600, 3000, 3400, 3500]) {
        assert.equal(byLookup(d), cfIntensityAt(d), `查表在 ${d} 处应当就是式子的值`);
    }
    // ★ 出厂的 `mode` 是**指数段** ⇒ 控制点之间也**恒等于那条式子**（不再是"直线逼近"）
    for (const d of [1300, 1500, 1650, 2000, 2500, 2777, 2900, 3300, 3450]) {
        assert.equal(byLookup(d), cfIntensityAt(d), `${d}：指数段相接应当就是式子的值（查表 ${byLookup(d)}）`);
    }
    // 换成线段模式 ⇒ 才会出现逼近误差（这条是"指数段确实在起作用"的反证）
    const lineTable = { ...t, mode: 'line' };
    const lineLookup = (d) => intensityOf({}, { table: lineTable, source: 'cf', numericValue: d }).value;
    assert.notEqual(lineLookup(2500), cfIntensityAt(2500), '线段模式下 2500 会偏离式子（说明指数段不是白设的）');
    assert.ok(Math.abs(lineLookup(2500) - cfIntensityAt(2500)) / cfIntensityAt(2500) < 0.06,
        '线段模式的偏差 <6%（实测 4%：2200→2600 那一段正好差一倍，弦的中点必然偏低）');
    assert.equal(intensityOf({}, { table: t, source: 'cf', numericValue: 9999 }).value, cfIntensityAt(CF_INTENSITY_TOP),
        '超出最后一个点 ⇒ 取最后那一点的值（= 上限）');
    const zero = intensityOf({}, { table: t, source: 'cf', numericValue: 0 });
    assert.equal(zero.usedDefault, true);
    assert.equal(zero.value, 0, '第 12 轮：没填难度 ⇒ 强度 0（不再有"默认强度"那个数）');
});

test('★ 控制点两条曲线的口径：单调 + `smooth` 模式也穿过控制点、且不过冲', () => {
    const t = DEFAULT_INTENSITY_TABLE;
    // XCPC：升序控制点，值**单调不增**（通过率越高越轻）
    for (let i = 1; i < t.byRatio.length; i++) {
        assert.ok(t.byRatio[i].max > t.byRatio[i - 1].max, '控制点按通过率升序');
        assert.ok(t.byRatio[i].value <= t.byRatio[i - 1].value, '强度随通过率单调不增');
    }
    // 数值：升序 + 单调不减
    for (let i = 1; i < t.byCf.length; i++) {
        assert.ok(t.byCf[i].max > t.byCf[i - 1].max, '控制点按数值升序');
        assert.ok(t.byCf[i].value >= t.byCf[i - 1].value, '强度随数值单调不减');
    }
    // 两种模式在控制点上必须**给出同一个值**
    for (const p of t.byCf) {
        assert.equal(intensityAtPoints(t.byCf, p.max, 'line'), p.value, '线段模式穿过控制点');
        assert.equal(intensityAtPoints(t.byCf, p.max, 'smooth'), p.value, '平滑模式也穿过控制点');
    }
    // 平滑模式不许过冲：任意采样都夹在 1（下限）与最高那点之间
    const cfTop = t.byCf[t.byCf.length - 1].value;
    for (let x = CF_INTENSITY_FLOOR_AT; x <= 3500; x += 37) {
        const v = intensityAtPoints(t.byCf, x, 'smooth');
        assert.ok(v >= 1 - 1e-9 && v <= cfTop + 1e-9, `smooth 在 ${x} 处过冲到 ${v}`);
    }
    // 读不出来（null / 空串）⇒ 不是 0（那会静默取到第一个控制点的值）
    assert.equal(intensityAtPoints(t.byCf, null), null);
    assert.equal(intensityAtPoints(t.byCf, ''), null);
});

test('默认强度表**单调**（难度越高强度越大 / 通过率越低强度越大）—— 改表时先看这条', () => {
    const t = DEFAULT_INTENSITY_TABLE;
    const cfValues = t.byCf.map((r) => r.value);
    for (let i = 1; i < cfValues.length; i++) {
        assert.ok(cfValues[i] >= cfValues[i - 1], `byCf 第 ${i} 点比上一点小：${cfValues[i - 1]} → ${cfValues[i]}`);
    }
    const ratioValues = t.byRatio.map((r) => r.value);
    for (let i = 1; i < ratioValues.length; i++) {
        assert.ok(ratioValues[i] <= ratioValues[i - 1], `byRatio 第 ${i} 点比上一点大（通过率越高应当越轻）`);
    }
    assert.equal(t.mode, 'exp', '★ 出厂默认是**指数段**相接（用户第 8 轮：尽量用指数函数连接整个公式）');
});

test('强度表按 id 取；取不到就用默认那张 / 表库的第一张（口径只一处）', () => {
    const a = { id: 'ti_a', name: 'A', byRatio: [], byCf: [] };
    const b = { id: 'ti_b', name: 'B', byRatio: [], byCf: [] };
    assert.equal(intensityTableById([a, b], 'ti_b').id, 'ti_b');
    assert.equal(intensityTableById([a, b], '不存在').id, 'ti_a');
    assert.equal(intensityTableById([a, b], '').id, DEFAULT_INTENSITY_TABLE.id,
        '★ 空 id = **内置那张**（"没引用任何自定义表"就是这种，别退化成"第一张"）');
    assert.equal(intensityTableById([], 'x').id, DEFAULT_INTENSITY_TABLE.id);
    assert.equal(intensityTableById(null, 'x').id, DEFAULT_INTENSITY_TABLE.id);
});

// ----------------------------------------------------------------
// 题集（①③㉒）
// ----------------------------------------------------------------

/** 一个副页：页内引用 p1、p2（同一道题引用两次）、整场比赛 c1（子树 p3/p4），外加一道页内独有的 p5 */
function pageState() {
    const P = (id, extra = {}) => ({ id, type: 'P', name: id, ...extra });
    return {
        settings: { stats: { countMode: 'plain' } },
        nodes: {
            c1: { id: 'c1', type: 'C', name: '比赛' },
            p1: P('p1', { acTime: '2026.10.05 10:00:00', status2: 4, xcpcDifficulty: '银牌' }),
            p2: P('p2', { acTime: '2026.10.06 10:00:00', status2: 2 }),
            p3: P('p3', { acTime: '2026.10.07 10:00:00', status2: 4 }),
            p4: P('p4', { status2: 0 }),
            p5: P('p5', { acTime: '2026.11.02 10:00:00', status2: 3 })
        },
        childOrder: { c1: ['p3', 'p4'], p1: [], p2: [], p3: [], p4: [], p5: [] },
        parentOf: { p3: 'c1', p4: 'c1' },
        pages: {
            page_1: {
                id: 'page_1', name: '题单', rootId: 'v_root',
                virtualIndex: {
                    v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['v1', 'v2', 'v2b', 'vc', 'v5'] },
                    v1: { id: 'v1', refId: 'p1', type: 'P', parentId: 'v_root', children: [] },
                    v2: { id: 'v2', refId: 'p2', type: 'P', parentId: 'v_root', children: [] },
                    v2b: { id: 'v2b', refId: 'p2', type: 'P', parentId: 'v_root', children: [] },   // 同一题又引用一次
                    vc: { id: 'vc', refId: 'c1', type: 'C', parentId: 'v_root', children: [] },     // 整场比赛
                    v5: { id: 'v5', refId: 'p5', type: 'P', parentId: 'v_root', children: [] }
                }
            }
        }
    };
}

test('题集：只来自副页；C 子树里的题也算；同一道题引用两次只算一次', () => {
    const st = pageState();
    const got = planProblemsOf(st, { pageId: 'page_1' });
    assert.equal(got.missingPage, false);
    assert.deepEqual(got.ids, ['p1', 'p2', 'p3', 'p4', 'p5']);
    assert.equal(got.linkCount, 4, '页里引用到的**真实节点**去重后 4 个（p1/p2/c1/p5）');
});

test('题集：计划绑的副页没了 ⇒ missingPage（别当成空题集，界面要提示）', () => {
    const st = pageState();
    assert.equal(planProblemsOf(st, { pageId: '没了' }).missingPage, true);
    assert.deepEqual(planProblemsOf(st, { pageId: '没了' }).ids, []);
    assert.deepEqual(planProblemsOf(st, null).ids, []);
});

// ----------------------------------------------------------------
// 题集来源：`range`（§13：范围根子树 ∩ 条件）+ 筛选模式那一份判据（界面注入）
// ----------------------------------------------------------------

test('题集：老计划（没有 rootIds/pick）⇒ 与第 1 轮口径逐字相同', () => {
    const st = pageState();
    const got = planProblemsOf(st, { pageId: 'page_1' });      // 老存档里就是这个形状
    assert.equal(got.source, 'page', '没有范围根 ⇒ 兼容字段推成 page');
    assert.deepEqual(got.ids, ['p1', 'p2', 'p3', 'p4', 'p5']);
    assert.equal(got.linkCount, 4);
    assert.deepEqual(got.missingRoots, []);
    assert.equal(got.usingSuperRoot, true, '没有范围根 = 超级根（整个副页）');

    // 老计划过一遍归一化（界面/导入都走这一道）之后，行为必须一个字不差
    const norm = normalizePlanShape({ pageId: 'page_1' });
    assert.equal(norm.source, 'page');
    assert.deepEqual(norm.rootIds, []);
    assert.deepEqual(norm.pick, { levels: [], cfMin: '', cfMax: '', tags: [], platforms: [] });
    assert.deepEqual(planProblemsOf(st, norm).ids, got.ids, '归一化前后一道不少');
    assert.equal('filterMode' in norm, false, '★ **没有 `filterMode` 这一格了**（"实时范围"那一层整体删掉）');
});

/**
 * 范围型夹具：CCPC 2023（s23）下两场比赛、CCPC 2022（s22）下一场。
 *
 * ★ 两个副页各引用一个系列 —— 因为**副页是题集的边界**（用户 2026-10-14："副页范围应该是默认的"）：
 *   `page_23` 只引用 `s23` ⇒ `s22` 那边的 `pd` **压根不在池子里**（哪怕把它选成范围根）。
 */
function rangeState() {
    const P = (id, extra = {}) => ({ id, type: 'P', name: id, ...extra });
    const pg = (id, name, refId) => ({
        id, name, rootId: `${id}_vroot`,
        virtualIndex: {
            [`${id}_vroot`]: { id: `${id}_vroot`, refId: null, type: 'O', parentId: null, children: [`${id}_v`] },
            [`${id}_v`]: { id: `${id}_v`, refId, type: refId === 's23' ? 'S' : 'S', parentId: `${id}_vroot`, children: [] }
        }
    });
    return {
        settings: { stats: { countMode: 'plain' } },
        nodes: {
            s23: { id: 's23', type: 'S', name: 'CCPC 2023' },
            s22: { id: 's22', type: 'S', name: 'CCPC 2022' },
            c1: { id: 'c1', type: 'C', name: 'CCPC 2023 桂林' },
            c2: { id: 'c2', type: 'C', name: 'CCPC 2023 深圳' },
            c3: { id: 'c3', type: 'C', name: 'CCPC 2022 广州' },
            pa: P('pa', { xcpcDifficulty: '银牌', cfDifficulty: 2400, tags: ['图论'], natureClass: 'cf/Div2' }),
            pb: P('pb', { xcpcDifficulty: '金牌', cfDifficulty: 3000 }),
            pc: P('pc', { xcpcDifficulty: '银牌', cfDifficulty: 1800, tags: ['dp'], natureClass: 'qoj' }),
            pe: P('pe', { xcpcDifficulty: '银牌', tags: ['dp'] }),          // 没填数值难度
            pd: P('pd', { xcpcDifficulty: '银牌', cfDifficulty: 2500 })
        },
        childOrder: {
            s23: ['c1', 'c2'], s22: ['c3'],
            c1: ['pa', 'pb'], c2: ['pc', 'pe'], c3: ['pd'],
            pa: [], pb: [], pc: [], pe: [], pd: []
        },
        parentOf: { c1: 's23', c2: 's23', c3: 's22', pa: 'c1', pb: 'c1', pc: 'c2', pe: 'c2', pd: 'c3' },
        pages: { page_23: pg('page_23', '题单23', 's23'), page_22: pg('page_22', '题单22', 's22') }
    };
}
/** `range` 型计划（默认绑 `page_23`，它只装 CCPC 2023 那一支） */
const RANGE = (rootIds, pick = {}, pageId = 'page_23') => ({ source: 'range', rootIds, pick, pageId });

test('★ 副页是题集的边界：范围根只在这个副页里缩，副页外的题**进不来**', () => {
    const st = rangeState();
    // `page_23` 只引用 s23 ⇒ 哪怕把 s22 也选成范围根，pd（在 s22 下）也进不来
    const onPage23 = planProblemsOf(st, RANGE(['s23', 's22'], { levels: ['银牌'] }));
    assert.deepEqual(onPage23.ids, ['pa', 'pc', 'pe'], '副页里没有的就进不来（s22 那一支只当了个空根）');
    assert.equal(onPage23.rootsInPage, 1, '两个根里只有 1 个真在池子里挑到了题 ⇒ 界面要提示另一个白选了');
    // 换成 `page_22`（只装 CCPC 2022）⇒ 同一套范围根，出来的题完全不同
    const onPage22 = planProblemsOf(st, RANGE(['s23', 's22'], { levels: ['银牌'] }, 'page_22'));
    assert.deepEqual(onPage22.ids, ['pd'], '★ 换个副页 ⇒ 题集跟着换（题集 = 副页里的题 ∩ 范围）');
    assert.equal(onPage22.rootsInPage, 1);
    // 根完全不在这个副页里 ⇒ 一道都挑不出来（如实报，别静默）
    const outside = planProblemsOf(st, RANGE(['c3', 's22'], { levels: ['银牌'] }));
    assert.deepEqual(outside.ids, [], '根都在副页外 ⇒ 空题集');
    assert.equal(outside.rootCount, 2, '根是解析到的（存在）');
    assert.equal(outside.rootsInPage, 0, '★ 但一个都没在池子里命中 ⇒ `rootsInPage` = 0（界面提示"不在这个副页里"）');
});

test('★ 副页没了 ⇒ **两种来源都**算不出题集（边界没了，`missingPage`）', () => {
    const st = rangeState();
    assert.equal(planProblemsOf(st, RANGE(['s23'], {}, '没了')).missingPage, true);
    assert.deepEqual(planProblemsOf(st, RANGE(['s23'], {}, '没了')).ids, []);
    assert.equal(planProblemsOf(st, { pageId: '没了' }).missingPage, true, 'page 型照旧');
    assert.deepEqual(planProblemsOf(st, { pageId: '', source: 'range', rootIds: ['s23'] }).ids, [], '没绑副页 ⇒ 空');
});

test('★ 范围根**留空 = 超级根**（"就用这个副页里的题"），条件照样生效', () => {
    const st = rangeState();
    // 用户 2026-10-14："「就用这个副页里的题」就是**无选中时自动选超级根节点**的逻辑"
    const noRoots = planProblemsOf(st, RANGE([]));
    assert.equal(noRoots.usingSuperRoot, true, '没有范围根 ⇒ 自动用超级根');
    assert.deepEqual(noRoots.ids, ['pa', 'pb', 'pc', 'pe'], '= 池子本身（整个副页的题）');
    assert.equal(noRoots.source, 'page', '兼容字段跟着推：没根 ⇒ page');
    // ★ 条件**永远**生效（不再有"哪种来源吃条件"的分叉）
    assert.deepEqual(planProblemsOf(st, RANGE([], { levels: ['银牌'] })).ids, ['pa', 'pc', 'pe'],
        '留空范围根 + 档位条件 ⇒ 就是在整个副页里按档位筛');
    // 有根 ⇒ 同一套逻辑只是多缩一道
    const withRoots = planProblemsOf(st, RANGE(['c1']));
    assert.equal(withRoots.usingSuperRoot, false);
    assert.equal(withRoots.source, 'range');
    assert.deepEqual(withRoots.ids, ['pa', 'pb'], '只留 c1 那一支');
});

test('题集来源 `range`：范围根子树里的题；多根并集；重叠/重复的根同一道题只算一次', () => {
    const st = rangeState();
    const one = planProblemsOf(st, RANGE(['s23'], { levels: ['银牌'] }));
    assert.equal(one.source, 'range');
    assert.equal(one.rootCount, 1);
    assert.equal(one.rootsInPage, 1);
    assert.deepEqual(one.ids, ['pa', 'pc', 'pe'], '金牌的 pb 被档位条件滤掉');
    assert.equal(one.linkCount, 1, '副页里引用到的真实节点 1 个（s23）');

    const dup = planProblemsOf(st, RANGE(['s23', 's23', 'c1'], { levels: ['银牌'] }));
    assert.deepEqual(dup.ids, ['pa', 'pc', 'pe'], '同一个根写两遍 / 根与根重叠 ⇒ 一道题只算一次');
    assert.equal(dup.rootCount, 2, '同 id 的根去重后是 2 个（`s23` / `c1`）');
});

test('题集来源 `range`：四个条件维度都走 `matchesProblemFilter` 那一份（不另立判据）', () => {
    const st = rangeState();
    const ids = (pick) => planProblemsOf(st, RANGE(['s23'], pick)).ids;
    assert.deepEqual(ids({ levels: ['银牌', '金牌'] }), ['pa', 'pb', 'pc', 'pe'], '档位可多选（"银牌三档"就是这种）');
    assert.deepEqual(ids({ cfMin: '2400' }), ['pa', 'pb'], '数值难度下限');
    assert.deepEqual(ids({ cfMin: '2400', cfMax: '2600' }), ['pa'], '区间两端都生效；pe 无难度 ⇒ 排除');
    assert.deepEqual(ids({ tags: ['图论'] }), ['pa'], '标签命中任意一个即可');
    assert.deepEqual(ids({ tags: ['dp'] }), ['pc', 'pe']);
    assert.deepEqual(ids({ platforms: ['qoj'] }), ['pc'], '平台取 `natureClass` 的第一段');
    assert.deepEqual(ids({}), ['pa', 'pb', 'pc', 'pe'], '四维全空 = 不限');
});

test('题集来源 `range`：坏值不炸 —— 根不存在如实报 `missingRoots`，`pick` 乱值当不限', () => {
    const st = rangeState();
    const got = planProblemsOf(st, RANGE(['s23', '早就删了'], { levels: ['银牌'] }));
    assert.deepEqual(got.ids, ['pa', 'pc', 'pe'], '能解析的那部分照常出题');
    assert.deepEqual(got.missingRoots, ['早就删了'], '解析不到的根要报出来（界面不能当成"空范围"）');
    assert.equal(got.rootCount, 1);
    assert.deepEqual(planProblemsOf(st, { pageId: 'page_23', source: 'range', rootIds: '不是数组' }).ids,
        ['pa', 'pb', 'pc', 'pe'], 'rootIds 不是数组 ⇒ 当"没有根" ⇒ 超级根（整个副页）');
    assert.deepEqual(planProblemsOf(st, { pageId: 'page_23', source: 'range', rootIds: ['s23'], pick: '乱写' }).ids,
        ['pa', 'pb', 'pc', 'pe'], 'pick 乱值 ⇒ 四维不限（失败方向是安全的）');
});

test('★ 计划侧**没有"实时范围"那一层**：题集只认存下来的 `rootIds`（快照）', () => {
    // 用户 2026-10-14："怎么还有实时和快照两个版本的…能不能稳定一点" ⇒ 实时那一层（`eligible`）整体删掉。
    const st = rangeState();
    const plan = RANGE(['s23'], { levels: ['银牌'] });
    const before = planProblemsOf(st, plan).ids;
    assert.deepEqual(before, ['pa', 'pc', 'pe']);
    // 之后**在副页里怎么标记都不会改这条计划的题集**（那颗 ○ 是全局临时的，统计页那边也用它）
    st.pages.page_23.virtualIndex.page_23_v.selected = true;
    assert.deepEqual(planProblemsOf(st, plan).ids, before, '标记变了 ⇒ 题集一个字不变（只认快照）');
    st.pages.page_23.selected = true;                 // 连整页 ○ 也一样
    assert.deepEqual(planProblemsOf(st, plan).ids, before, '整页 ○ 也不影响');
    // 想改范围就再取一次（换 rootIds）；`planProgressOf` 不再收 `eligible`
    const prog = planProgressOf(st, { ...plan, start: '2026.10.01', goal: { mode: 'count', per: 'day', value: 1 } },
        { today: TODAY, startKey: '2026.10.01', endKey: '2026.11.10' });
    assert.equal(prog.entries.length, 3, 'entries = 题集（pa/pc/pe）');
});

// ----------------------------------------------------------------
// 目标折算（㉑）
// ----------------------------------------------------------------

test('目标只存一份：每天 3 ⇒ 周到 21、月按天数、整段按整段天数（㉑）', () => {
    const plan = { goal: { mode: 'intensity', per: 'day', value: 3 } };
    assert.equal(dailyQuotaOf(plan, { startKey: '2026.10.01', endKey: '2026.10.31' }), 3);
    assert.equal(periodGoalOf(plan, 'week', '2026.10.05', { startKey: '2026.10.01' }), 21);
    assert.equal(periodGoalOf(plan, 'day', '2026.10.05', { startKey: '2026.10.01' }), 3);
    assert.equal(periodGoalOf(plan, 'month', '2026.10', { startKey: '2026.10.01' }), 93);   // 3 × 31
    assert.equal(periodGoalOf(plan, 'all', 'all', { startKey: '2026.10.01', endKey: '2026.10.10' }), 30);

    // "每周 20" 也读得出来（基准粒度是周 ⇒ 每天 20/7）
    const wk = { goal: { mode: 'intensity', per: 'week', value: 20 } };
    assert.equal(periodGoalOf(wk, 'week', '2026.10.05', { startKey: '2026.10.01' }), 20);
    assert.equal(periodGoalOf(wk, 'day', '2026.10.05', { startKey: '2026.10.01' }), 20 / 7);
    assert.equal(dailyQuotaOf({ goal: { value: 0 } }, { startKey: '2026.10.01' }), 0);
});

// ----------------------------------------------------------------
// 各期达成（④⑫⑬③）
// ----------------------------------------------------------------

// ★ 固定"今天"：期范围现在是"计划开始 → **现在**"（用户第 2 轮口径）⇒ 测试必须能定住今天，
//   否则期数会随真实日期漂（夹具最后一条 AC 在 11.02，取 11.10 让它在窗口内）。
const TODAY = '2026.11.10';

const PLAN = {
    id: 'plan_1', name: '10月补题', pageId: 'page_1',
    start: '2026.10.01', end: null,
    goal: { mode: 'intensity', per: 'day', value: 3 },
    statuses: [3, 4],
    intensitySource: 'xcpc',
    intensityTableId: 'ti_default'
};

test('各期达成：按期分组、只算做完的、目标按期折算（期只到「今天」）', () => {
    const st = pageState();
    const r = planProgressOf(st, PLAN, { grain: 'day', tables: [DEFAULT_INTENSITY_TABLE], today: TODAY });
    assert.equal(r.ok, true);
    assert.equal(r.grain, 'day');
    assert.equal(r.startKey, '2026.10.01');
    // ★ 口径（用户 2026-10-13 第 2 轮）：期只排到**今天**（"计划开始到现在"），不再排到"最后一次 AC"
    assert.equal(r.endKey, TODAY, 'endKey = 今天（这里把今天注入成 11.10）');

    const byKey = new Map(r.periods.map((p) => [p.key, p]));
    assert.equal(byKey.size, 41, '10.01 ~ 11.10 每天一格（空期也占位；到**今天**为止）');
    // p1 有「银牌」档但没 ratio ⇒ 用那一档区间的**中点 9.5%** 插值（第 10 轮起横轴取对数 ⇒ 就是那条式子）= 6.49、s2=4 ⇒ 做完
    assert.equal(byKey.get('2026.10.05').count, 1);
    assert.equal(byKey.get('2026.10.05').intensity, 6.49);
    assert.equal(byKey.get('2026.10.05').goal, 3);
    assert.equal(byKey.get('2026.10.05').reached, true);
    // p2 = s2 2 ⇒ 没做完：题数/强度都不进"达成"，但 countAll 看得到
    assert.equal(byKey.get('2026.10.06').count, 0);
    assert.equal(byKey.get('2026.10.06').countAll, 1);
    assert.equal(byKey.get('2026.10.06').reached, false);
    // p5 = s2 3 ⇒ 也算做完（④ 默认 [3,4]）
    assert.equal(byKey.get('2026.11.02').count, 1);

    assert.equal(r.totals.count, 3, '做完的：p1、c1 子树里的 p3、p5');
    assert.equal(r.totals.countAll, 4, '⚠️ countAll 只数**有 AC 时间的题**（4 道）—— 没时间的那道走 undatedCount');
    assert.equal(r.undatedCount, 1, 'p4 没有 acTime ⇒ 不进任何期，单独计数');
});

test('各期达成：`statuses` 口径可改 —— 只要 4 时，"赛后补题"不算做完（含 5 忽略永不算）', () => {
    const st = pageState();
    const onlyDuring = planProgressOf(st, { ...PLAN, statuses: [4] }, { grain: 'day', today: TODAY });
    const byKey = new Map(onlyDuring.periods.map((p) => [p.key, p]));
    assert.equal(byKey.get('2026.11.02').count, 0, 'p5 是 3 赛后补题 ⇒ 不算');
    const broader = planProgressOf(st, { ...PLAN, statuses: [3, 4] }, { grain: 'day', today: TODAY });
    assert.equal(broader.totals.count, 3, '[3,4]：p1 / p3 / p5 三道');
    const withIgnore = planProgressOf(st, { ...PLAN, statuses: [3, 4, 5] }, { grain: 'day', today: TODAY });
    assert.equal(withIgnore.totals.count, broader.totals.count,
        '★ 把 5（忽略）加进口径**不会多算**任何题 —— 本夹具没有 s2=5 的题，两边必须相等');
});

test('各期达成：粒度切换只换"期"与目标线，题集与总量不变（⑲⑳ 两套粒度独立）', () => {
    const st = pageState();
    const day = planProgressOf(st, PLAN, { grain: 'day', today: TODAY });
    const week = planProgressOf(st, PLAN, { grain: 'week', tables: [DEFAULT_INTENSITY_TABLE], today: TODAY });
    const month = planProgressOf(st, PLAN, { grain: 'month', tables: [DEFAULT_INTENSITY_TABLE], today: TODAY });
    assert.equal(day.totals.count, week.totals.count);
    assert.equal(day.totals.count, month.totals.count);
    assert.equal(day.totals.intensity, week.totals.intensity);

    const wk = new Map(week.periods.map((p) => [p.key, p]));
    assert.equal(wk.get('2026.10.05').count, 2, '10.05~10.11 这一周做完两道：p1（10.05）与 p3（10.07）');
    assert.equal(wk.get('2026.10.05').goal, 21, '目标随粒度折算：每天 3 ⇒ 每周 21');
    assert.equal(wk.get('2026.10.05').days, 7);
    const mo = new Map(month.periods.map((p) => [p.key, p]));
    assert.equal(mo.get('2026.10').goal, 93, '10 月 31 天 ⇒ 3 × 31');
    assert.equal(mo.get('2026.10').count, 2, '10 月做完两道（p1、p3）—— p5 落在 11 月');
    assert.equal(mo.get('2026.11').count, 1, '11 月那格是 p5');
});

test('★ 没填难度的题**强度记 0**（第 12 轮用户："未填写的不计入 因为有热身赛等"⇒"强度为0就行了"）', () => {
    const st = pageState();
    const r = planProgressOf(st, PLAN, { grain: 'day', tables: [DEFAULT_INTENSITY_TABLE], today: TODAY });
    // p2/p3/p4/p5 都没填 xcpcDifficulty（p1 有）⇒ 至少 3 道（做完的里 p3、p5）
    assert.ok(r.unknownDifficulty >= 3, `没填难度的题数应 ≥3，实际 ${r.unknownDifficulty}`);
    const p3 = r.entries.find((e) => e.id === 'p3');
    assert.equal(p3.usedDefault, true);
    assert.equal(p3.intensity, 0, '★ 没填难度 ⇒ 强度 0（不再去表里取什么"默认强度"）');
    // 于是所有合计天然不含它（**加 0 不影响和**，不需要在聚合那侧再判一次）
    assert.equal(r.totalIntensity, 6.49, '题集里只有 p1 填了难度 ⇒ 总强度就是它那道');
    assert.equal(r.doneIntensity, 6.49, 'p1 做完了 ⇒ 已写 = 总（热身赛那类题不再挂在账上）');
    assert.equal(r.remainingIntensity, 0, '✨ 于是"还差 0"');
    assert.equal(r.totalCount, 5, '⚠️ 但**题数照旧算 5**（题数目标不看难度）');
    assert.equal(r.totals.intensityAll, 6.49, '每期那两栏也不含（p1 有 AC 时间 ⇒ 进 intensityAll）');
    // 反证：把 p1 的难度也抹掉 ⇒ 全都是 0，而题数一个不少
    const noDiff = { ...st, nodes: { ...st.nodes, p1: { ...st.nodes.p1, xcpcDifficulty: '' } } };
    const z = planProgressOf(noDiff, PLAN, { grain: 'day', today: TODAY });
    assert.equal(z.totalIntensity, 0, '全都没填难度 ⇒ 总强度 0');
    assert.equal(z.doneIntensity, 0);
    assert.equal(z.totals.intensity, 0, '每期那一格同样 0');
    assert.equal(z.totalCount, 5, '题数照旧 5');
});

test('各期达成：组层去重**跟整体计数口径走**（plain 各算各的、dedup 同组只算一条）', () => {
    const st = pageState();
    // 把 p2 与 p3 设成同一组（p2 是页内直引，p3 在 c1 子树里）
    st.nodes.p2.ownerSynth = 'synth:xcpc:x-p2';
    st.nodes.p3.ownerSynth = 'synth:xcpc:x-p2';
    // ⚠️ 真实界面传进来的 `shownValue` 是**显示口径**（`viewDerivedDisplay`）：
    //    判重模式下 `status2` 早就读了"组那份"（`GROUP_FIELDS`）⇒ 组里两条同值。
    //    这里照那个口径模拟：同组的 status2 一律按"组那份 = 4 赛时通过"。
    const shown = (n, f) => (f === 'status2' && n.ownerSynth ? 4 : n[f]);

    const plain = planProgressOf(st, PLAN, { grain: 'day', shownValue: shown, today: TODAY });
    assert.equal(plain.totals.countAll, 4, 'plain：有 AC 时间的 4 道都算（含同组两条：p2/p3）');

    st.settings.stats.countMode = 'dedup';
    const dedup = planProgressOf(st, PLAN, { grain: 'day', shownValue: shown, today: TODAY });
    assert.equal(dedup.totals.countAll, 3, '★ dedup：同组只留一条代表 ⇒ 少一道');
    assert.equal(dedup.totals.count, plain.totals.count - 1,
        '★ plain 把**同一道题的两个副本**各算了一次（这正是去重要解决的"重复"）；'
        + 'dedup 只算一次 —— 而且那一条**仍然算"做完"**（它读的是组那份 = 4，不是某个副本自己的）');
});

test('各期达成：目标口径可换成题数（`goal.mode = count`）', () => {
    const st = pageState();
    const r = planProgressOf(st, { ...PLAN, goal: { mode: 'count', per: 'week', value: 3 } },
        { grain: 'week', today: TODAY });
    assert.equal(r.goalMode, 'count');
    const wk = new Map(r.periods.map((p) => [p.key, p]));
    assert.equal(wk.get('2026.10.05').goal, 3, '每周 3 题');
    assert.equal(wk.get('2026.10.05').actual, wk.get('2026.10.05').count, 'actual 选题数口径');
    assert.equal(wk.get('2026.10.05').count, 2, '这一周做完 2 道（p1、p3）');
    assert.equal(wk.get('2026.10.05').reached, false, '目标 3 道、实际 2 道 ⇒ 没达成');
});

// ================================================================
// 计划与强度表**写入口**（`core/ops/plan.js`）
//
// 这一层管两件事，都是"只能有一处"的：
//   · **归一化**（`normalizePlanShape` / `normalizeTableShape`）：导入通道与界面**共用同一份判据**
//     （包可以手改是这个项目**有意**留的口子 ⇒ 坏值必须在这一层收敛）；
//   · **只读守卫**：新建/改/删都是手改 ⇒ 每个写口都过 `assertManualEditAllowed`
//     （那条的判据在 `scripts/smoke/readonly-boundary.smoke.mjs` 的名单里）。
// ================================================================
import {
    addPlan, updatePlan, deletePlan, normalizePlanShape,
    addIntensityTable, updateIntensityTable, deleteIntensityTable,
    ensurePagePlan, planOfPage, DEFAULT_PLAN_GOAL
} from '../core/ops/plan.js';
import { addPage } from '../core/ops/page.js';

/** 一个够写的最小 draft：一个副页 + 空计划表 + 空强度表库 */
function draftState() {
    return {
        currentAccountId: 'local', viewingAccountId: 'local',
        pages: { page_1: { id: 'page_1', name: '题单', rootId: 'v_root', virtualIndex: {} } },
        plans: {},
        settings: { trainingIntensityTables: [] }
    };
}
const OK = { name: '10月补题', pageId: 'page_1', start: '2026.10.01', goal: { mode: 'intensity', per: 'day', value: 3 } };

test('addPlan：生成 id + 归一化（非法粒度/状态/源都收敛到默认）', () => {
    const d = draftState();
    const p = addPlan(d, { ...OK, goal: { mode: '怪', per: '半月', value: 3 }, statuses: [4, 4, 9, 'x'], intensitySource: '乱写' });
    assert.ok(d.plans[p.id], '进 plans 表了');
    assert.match(p.id, /^plan_/);
    assert.equal(p.goal.mode, 'intensity', '非法口径 ⇒ 强度');
    assert.equal(p.goal.per, 'day', '非法粒度 ⇒ 默认日');
    assert.deepEqual(p.statuses, [4], '状态去重 + 剔掉越界的 9');
    assert.equal(p.intensitySource, 'xcpc', '非法源 ⇒ 默认');
    assert.ok(p.createdAt && p.lastModified, '两个时间戳都有');
});

test('addPlan：名字 / 副页 / 开始时间 / 目标值四道校验各拦一次（含副页不存在）', () => {
    const d = draftState();
    assert.throws(() => addPlan(d, { ...OK, name: '   ' }), /名称不能为空/);
    assert.throws(() => addPlan(d, { ...OK, pageId: '' }), /必须绑一个副页/);
    assert.throws(() => addPlan(d, { ...OK, pageId: '没了' }), /题单页不存在/);
    assert.throws(() => addPlan(d, { ...OK, start: '下个月' }), /开始时间/);
    assert.throws(() => addPlan(d, { ...OK, goal: { per: 'day', value: 0 } }), /目标值要大于 0/);
    assert.deepEqual(Object.keys(d.plans), [], '一次都不该落库');
});

test('updatePlan：只改传进来的字段，别的字段一字不动；id 改不了', () => {
    const d = draftState();
    const p = addPlan(d, { ...OK, end: '2026.10.31' });
    const before = { ...p, goal: { ...p.goal }, statuses: [...p.statuses] };
    const after = updatePlan(d, p.id, { name: '改名', goal: { mode: 'count', per: 'week', value: 2 } });
    assert.equal(after.id, before.id, 'id 不变');
    assert.equal(after.name, '改名');
    assert.equal(after.end, '2026.10.31', '没传的字段保留');
    assert.equal(after.start, '2026.10.01', '没传的字段保留');
    assert.equal(after.goal.per, 'week');
    assert.equal(after.goal.mode, 'count');
    assert.equal(d.plans[p.id], after, '改的是表里那一条（不是副本）');
    assert.throws(() => updatePlan(d, 'plan_没有', { name: 'x' }), /计划不存在/);
});

test('updatePlan：换题单页要真的存在；名字清空 / 目标归零都拦', () => {
    const d = draftState();
    const p = addPlan(d, OK);
    assert.throws(() => updatePlan(d, p.id, { pageId: '没了' }), /题单页不存在/);
    assert.throws(() => updatePlan(d, p.id, { name: ' ' }), /名称不能为空/);
    assert.throws(() => updatePlan(d, p.id, { goal: { value: -1 } }), /目标值要大于 0/);
    assert.equal(d.plans[p.id].name, '10月补题', '拦下之后一个字没改');
});

test('deletePlan：删掉那一条；删副页**不会**动计划（§10 ⑧：计划留着并提示）', () => {
    const d = draftState();
    const p = addPlan(d, OK);
    delete d.pages.page_1;                       // 题单页没了
    assert.ok(d.plans[p.id], '计划还在（界面按 missingPage 提示）');
    assert.equal(deletePlan(d, p.id), true);
    assert.equal(d.plans[p.id], undefined);
    assert.throws(() => deletePlan(d, p.id), /计划不存在/);
});

test('normalizePlanShape：包/老存档里的坏值一律收敛（导入通道与界面共用这一份）', () => {
    const s = normalizePlanShape({ name: 42, pageId: null, start: '2026-10-01', end: 'x', goal: null, statuses: '甲', intensitySource: 7 });
    assert.equal(s.name, '42', '名字转字符串');
    assert.equal(s.pageId, '');
    assert.equal(s.start, '', '写法不对 ⇒ 空串（由 add/update 去报"要填开始时间"）');
    assert.equal(s.end, '');
    assert.deepEqual(s.goal, { mode: 'intensity', per: 'day', value: 0 });
    assert.deepEqual(s.statuses, [3, 4], '不是数组 ⇒ 默认 [3,4]');
    assert.equal(s.intensitySource, 'xcpc');
    assert.equal(s.intensityTableId, '');
    assert.equal(normalizePlanShape(null).name, '', 'null 也不炸');
});

test('normalizePlanShape：题集那几个新字段的坏值也收敛（`pick` 的空串不许变成 0）', () => {
    const bad = normalizePlanShape({
        source: '石头', rootIds: 's23',
        pick: { levels: ['银牌', '银牌', ''], cfMin: 'abc', cfMax: null, tags: 'dp', platforms: [7, 'qoj'] }
    });
    assert.equal(bad.source, 'page', '★ `source` 是**推出来的**：没根 ⇒ page（认它写的是什么）');
    assert.deepEqual(bad.rootIds, [], '不是数组 ⇒ 空');
    assert.deepEqual(bad.pick.levels, ['银牌'], '去空、去重');
    assert.equal(bad.pick.cfMin, '', '取不出数字 ⇒ 空（"这一维不限"）');
    assert.equal(bad.pick.cfMax, '', 'null ⇒ 空');
    assert.deepEqual(bad.pick.tags, [], '不是数组 ⇒ 空');
    assert.deepEqual(bad.pick.platforms, ['7', 'qoj'], '数字也转字符串');
    assert.equal(normalizePlanShape({ pick: { cfMin: 0 } }).pick.cfMin, '0',
        '★ 真的填了 0 要留住（只有**空串**才是"不限"）');
    assert.equal(normalizePlanShape({ source: 'range', rootIds: ['s23', '', 's23'] }).rootIds.join(','), 's23');
    assert.equal(normalizePlanShape({ rootIds: ['s23'] }).source, 'range', '有根 ⇒ 推成 range');
});

test('强度表：加/改/删 + 重名拦（表库是全局的、计划只引用 id）', () => {
    const d = draftState();
    const t = addIntensityTable(d, {
        name: '我的表',
        byRatio: [{ max: 11, value: 9 }, { max: 5, value: 20 }, { max: 3, value: -1 }],
        byCf: [{ max: 2000, value: 3 }],
        defaultValue: 2                 // ← 老字段：第 12 轮起**丢掉**（没填难度 ⇒ 强度 0）
    });
    assert.equal('defaultValue' in t, false, '★ 第 12 轮起表里不再有 defaultValue 那个字段');
    assert.match(t.id, /^ti_/);
    assert.deepEqual(t.byRatio, [{ max: 5, value: 20 }, { max: 11, value: 9 }],
        '★ 负数强度被剔掉，且**按 max 升序**排好（插值要按升序读）');
    assert.equal(d.settings.trainingIntensityTables.length, 1);
    assert.throws(() => addIntensityTable(d, { name: '我的表' }), /已存在/);

    // 老形状（只有 `byXcpc`）**迁一次**：每档那一点落在它自己的通过率上限上
    const legacy = addIntensityTable(d, { name: '老表', byXcpc: { '银牌': 9, '签到': 0.5 } });
    const silverPt = legacy.byRatio.find((p) => Number(p.max) === 11);
    assert.ok(silverPt && silverPt.value === 9, '★ 老 `byXcpc` 迁成了按通过率的控制点（银牌 ⇒ ≤11%）');
    assert.equal(legacy.mode, 'exp', '老表迁移后默认指数段相接');

    const t2 = addIntensityTable(d, { name: '第二张' });
    assert.throws(() => updateIntensityTable(d, t2.id, { name: '我的表' }), /已存在/, '改名撞车也拦');
    updateIntensityTable(d, t2.id, { name: '改名后' });
    assert.equal(t2.name, '改名后');
    assert.equal(deleteIntensityTable(d, t.id), true);
    assert.equal(d.settings.trainingIntensityTables.length, 2);
    assert.throws(() => deleteIntensityTable(d, t.id), /强度表不存在/);
});

test('强度表的 `byCf` 一律按 max 升序（顺序乱了会挑错档 —— 归一化时就排好）', () => {
    const d = draftState();
    const t = addIntensityTable(d, {
        name: '乱序表',
        byCf: [{ max: 2400, value: 7 }, { max: null, value: 16 }, { max: 1400, value: 2 }, { max: 1900, value: 4 }]
    });
    assert.deepEqual(t.byCf.map((r) => r.max), [1400, 1900, 2400, null], '升序 + null 殿后');
});
test('`plans` 在注册表里是"既落盘又进包、还进撤销快照"（漏一格 = 静默丢计划）', () => {
    // 这一条防的是"注册表某一格写错"（例如 persist: false ⇒ 刷新一次计划就没了）。
    // 名单派生自 `A_registry.js:USER_FIELDS`，本测试只核**那一行的三个开关**是否还是我们要的。
    assert.equal(USER_FIELDS.plans.persist, true, '要落盘');
    assert.equal(USER_FIELDS.plans.export, true, '要进导出包（用户 ⑦）');
    assert.equal(USER_FIELDS.plans.snapshot, true, '要进撤销快照（删计划能撤回）');
    assert.ok(META_FIELD_KEYS.includes('plans'), '走 meta 表（不是单开 store）');
    const fresh = metaDefaults();
    assert.deepEqual(fresh.plans, {}, '缺省是空表（不是 undefined）');
    const incoming = importedState({ plans: { plan_x: { name: '包里的计划' } } }, { plans: {} });
    assert.equal(incoming.plans.plan_x.name, '包里的计划', '导入通道接得住（派生自注册表）');
});
// ----------------------------------------------------------------
// 两张图的数据（⑱：图①累计+目标斜线 / 图②每期+目标线）
// ----------------------------------------------------------------

test('图表数据：图①累计逐期相加、图②每期各自的值；目标线也逐期累加（⑱）', () => {
    const st = pageState();
    const progress = planProgressOf(st, PLAN, { grain: 'day', today: TODAY });
    const series = planChartSeriesOf(progress);
    assert.equal(series.points.length, progress.periods.length, '期数与图上的点一一对应（空期也占位）');
    assert.equal(series.unit, '强度', '强度口径时单位是"强度"');
    // 累计 = 前面所有期之和（图①那条折线）
    let cum = 0;
    for (const p of series.points) {
        cum += p.value;
        assert.equal(p.cumulative, cum, `第 ${p.label} 期的累计值不对`);
    }
    // 目标斜线 = 每期目标逐期相加（图①那条虚线就是它）
    let gcum = 0;
    for (const p of series.points) {
        gcum += p.goal;
        assert.equal(p.goalCumulative, gcum, `第 ${p.label} 期的累计目标不对`);
    }
    // ⚠️ y 轴上限 = **实际累计与目标斜线里大的那个**（只按实际算的话，目标线会画到画布外面去）
    assert.equal(series.maxCumulative, Math.max(cum, gcum), 'y 轴上限覆盖"实际累计"与"目标斜线"两条线');
    assert.ok(series.maxCumulative >= cum && series.maxCumulative >= gcum, '两条线都在画布内');
});

test('图表数据：目标口径换成题数时，图上的 y 也跟着是题数（同一把尺子）', () => {
    const st = pageState();
    const progress = planProgressOf(st, { ...PLAN, goal: { mode: 'count', per: 'week', value: 2 } }, { grain: 'week', today: TODAY });
    const series = planChartSeriesOf(progress);
    assert.equal(series.unit, '题');
    const byKey = new Map(series.points.map((p) => [p.key, p]));
    assert.equal(byKey.get(progress.periods[0].key).value, progress.periods[0].count, 'value 就是题数');
    assert.equal(byKey.get(progress.periods[0].key).goal, 2, '每期目标 = 每周 2 题');
});

test('图表数据：空计划 / 没有期也不炸（点数 0、上限 0）', () => {
    const s = planChartSeriesOf({ periods: [], goalMode: 'intensity', grain: 'day' });
    assert.deepEqual(s.points, []);
    assert.equal(s.maxValue, 0);
    assert.equal(s.maxCumulative, 0);
    assert.equal(planChartSeriesOf(null).points.length, 0);
});
test('★ 期的标签都带年份；跨年那周两端都写全（⑲ 期标签口径）', () => {
    assert.equal(periodLabelOf('2026.10.13', 'day'), '2026.10.13');
    assert.equal(periodLabelOf('2026.10.12', 'week'), '2026.10.12~10.18');
    assert.equal(periodLabelOf('2026.12.28', 'week'), '2026.12.28~2027.01.03', '跨年 ⇒ 两端都写全');
    assert.equal(periodLabelOf('2026.10', 'month'), '2026.10');
    assert.equal(periodLabelOf('all', 'all'), '整段');
});
// ----------------------------------------------------------------
// 第 2 轮：已写/总训练强度、推荐训练强度、目标训练强度 + 预计完成日期
// ----------------------------------------------------------------

test('★ 三个数：已写 / 总训练强度（总 = 题集里**填了难度**的题强度和）', () => {
    const st = pageState();
    const r = planProgressOf(st, PLAN, { grain: 'day', today: TODAY });
    // 题集 5 道：p1 有「银牌」档但**没有 ratio** ⇒ 用那一档区间的中点 9.5%（= 那条式子的值）= 6.49；
    // ★ 第 12 轮（"未填写的不计入"）：p2/p3/p4/p5 **都没填难度 ⇒ 强度 0** ⇒ 总 = 已写 = 6.49、还差 0。
    assert.equal(r.totalIntensity, 6.49, '总训练强度 = 题集里**填了难度**的题强度和（热身赛那类记 0）');
    assert.equal(r.doneIntensity, 6.49, '已写 = 做完那些题的强度和（p1 做完了）');
    assert.equal(r.remainingIntensity, 0, '还差 = 总 - 已写 ⇒ 0');
    assert.equal(r.doneCount, 3, '⚠️ 题数照旧（题数目标不看难度）');
    assert.equal(r.totalCount, 5);
    // ⚠️ 与"有 AC 时间的那些"不是一回事（p4 没 AC 时间 ⇒ 不进这一项，但**进** totalIntensity）
    assert.equal(r.totals.intensityAll, 6.49, 'totals.intensityAll 只数**有 AC 时间**的（只有 p1 有难度）');
});

test('★ 推荐训练强度：**只有填了结束时间**才算（把还差的按剩余天数摊平）', () => {
    const st = pageState();
    // 没填结束时间 ⇒ 算不了
    const noEnd = planForecastOf(planProgressOf(st, PLAN, { grain: 'day', today: TODAY }), { today: TODAY });
    assert.equal(noEnd.hasEnd, false);
    assert.equal(noEnd.recommendPerDay, null, '没有结束时间 ⇒ 推荐强度 null（不是 0）');
    assert.equal(noEnd.leftDays, null);

    // ★ 第 12 轮：题集里只有 p1 有难度、而它做完了 ⇒ 还差 0 ⇒ 推荐 0/天（不是"没结束时间"那种 null）
    const done = planForecastOf(
        planProgressOf(st, { ...PLAN, end: '2026.11.20' }, { grain: 'day', today: TODAY }),
        { today: TODAY });
    assert.equal(done.hasEnd, true);
    assert.equal(done.leftDays, 11, '剩余天数含今天');
    assert.equal(done.recommendPerDay, 0, '还差 0 ⇒ 推荐 0/天（≠ null）');

    // 还差 > 0 时才是"摊平"：给 p2（没做完）也填上难度 ⇒ 还差 6.49 ⇒ 6.49/11
    const st2 = { ...st, nodes: { ...st.nodes, p2: { ...st.nodes.p2, xcpcDifficulty: '银牌' } } };
    const withEnd = planForecastOf(
        planProgressOf(st2, { ...PLAN, end: '2026.11.20' }, { grain: 'day', today: TODAY }),
        { today: TODAY });
    assert.equal(withEnd.leftDays, 11);
    assert.ok(Math.abs(withEnd.recommendPerDay - (6.49 / 11)) < 1e-9,
        `推荐 ≈ 6.49/11，实际 ${withEnd.recommendPerDay}`);
});

test('★ 目标训练强度 + 预计完成日期：按目标速度从今天起算还要几天', () => {
    const st = pageState();
    // ★ 第 12 轮（"未填写的不计入"）：夹具里**只有 p1 有难度**、而它做完了 ⇒ 还差 0。
    //   要验"按目标速度算几天"就得先造出一道**没做完且有难度**的题 —— 给 p2（status2=2，没做完）一个档位。
    const st2 = { ...st, nodes: { ...st.nodes, p2: { ...st.nodes.p2, xcpcDifficulty: '银牌' } } };
    // 目标 每天 3 强度 ⇒ 还差 6.49 强度 ⇒ ceil(6.49/3)=3 天 ⇒ 11.12
    const f1 = planForecastOf(planProgressOf(st2, PLAN, { grain: 'day', today: TODAY }), { today: TODAY });
    assert.equal(f1.goalPerDay, 3, '目标折算到"每天"就是 3');
    assert.equal(f1.etaDays, 3, '还差 6.49 ÷ 每天 3 ⇒ 3 天');
    assert.equal(f1.etaKey, '2026.11.12', '今天 + 2 天 = 11.12（第 3 天完成）');
    // 而"只剩做完的那道"时，还差 0 ⇒ 也是今天（不该因为 0 而算不出来）
    assert.equal(planForecastOf(planProgressOf(st, PLAN, { grain: 'day', today: TODAY }), { today: TODAY }).etaKey,
        TODAY, '还差 0 ⇒ 今天就算完成');

    // 目标 每周 3 强度 ⇒ 每天 3/7≈0.43 ⇒ 还差 6.49 ⇒ 需要 ceil(6.49/0.4286)=16 天 ⇒ 11.25
    const slow = { ...PLAN, goal: { mode: 'intensity', per: 'week', value: 3 } };
    const f2 = planForecastOf(planProgressOf(st2, slow, { grain: 'day', today: TODAY }), { today: TODAY });
    assert.ok(Math.abs(f2.goalPerDay - (3 / 7)) < 1e-9, `每天目标 = 3/7，实际 ${f2.goalPerDay}`);
    assert.equal(f2.etaDays, 16, '还差 6.49 强度 ÷ 每天 3/7 ⇒ 16 天');
    assert.equal(f2.etaKey, '2026.11.25', '今天 + 15 天 = 11.25（第 16 天完成）');

    // 目标为 0 ⇒ 算不出预计日期（不瞎猜）
    const zero = planForecastOf(planProgressOf(st, { ...PLAN, goal: { mode: 'intensity', per: 'day', value: 0 } },
        { grain: 'day', today: TODAY }), { today: TODAY });
    assert.equal(zero.goalPerDay, 0);
    assert.equal(zero.etaKey, '');
});

test('★ 期范围 = 计划开始 → 今天（计划已结束 ⇒ 到结束那天；还没开始 ⇒ 一期都没有）', () => {
    const st = pageState();
    const r = planProgressOf(st, PLAN, { grain: 'day', today: TODAY });
    assert.equal(r.startKey, '2026.10.01');
    assert.equal(r.endKey, TODAY);

    // 结束时间在过去 ⇒ 终点就是那天（不再往后摆空期）
    const past = planProgressOf(st, { ...PLAN, end: '2026.11.05' }, { grain: 'day', today: TODAY });
    assert.equal(past.endKey, '2026.11.05', '计划已收尾 ⇒ 只到结束那天');
    assert.equal(past.planEndKey, '2026.11.05');

    // 还没开始 ⇒ 没有期（不是"从今天开始排"）
    const future = planProgressOf(st, { ...PLAN, start: '2026.12.01' }, { grain: 'day', today: TODAY });
    assert.deepEqual(future.periods, [], '计划还没开始 ⇒ 一期都不排');
    assert.equal(future.futureStart, undefined, '（没有这个字段 —— 界面按 startKey > today 自己判）');
});

// ================================================================
// ★ 副页 ⇄ 计划**一对一**（用户 2026-10-15 定的模型："计划不需要增删功能，位置也固定，
//   只是需要默认初始状态"；存量本来就是一对一 ⇒ 不需要迁移）。口径见
//   `docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节。
// ================================================================

test('★ 建副页 ⇒ 自带一份计划（默认初始状态：强度/每天/3、题集 = 这个副页、名字取页名）', () => {
    const d = draftState();
    const page = addPage(d, '新题单');
    const plan = planOfPage(d, page.id);
    assert.ok(plan, '★ 建页就有计划（不用先去点"新建计划"）');
    assert.equal(plan.pageId, page.id, '绑的正是这个副页');
    assert.equal(plan.name, '新题单', '名字默认取副页名（之后可改）');
    assert.deepEqual(plan.goal, { ...DEFAULT_PLAN_GOAL }, '目标 = 训练强度 / 每天 / 3');
    assert.equal(plan.goal.per, 'day');
    assert.deepEqual(plan.rootIds, [], '★ 题集 = 这个副页里的题（空 = 超级根）');
    assert.equal(plan.source, 'page', '兼容字段跟着 rootIds 推出来');
    assert.ok(/^\d{4}\.\d{2}\.\d{2}$/.test(plan.start), '开始时间 = 建页当天（有值、形状对）');
    // 一对一：这个副页**只有**这一份
    const mine = Object.values(d.plans).filter((p) => p.pageId === page.id);
    assert.equal(mine.length, 1, '★ 一个副页一份计划');
});

test('★ `ensurePagePlan` 幂等：已经有了就原样返回，不叠第二条', () => {
    const d = draftState();
    const page = addPage(d, '新题单');
    const first = planOfPage(d, page.id);
    const again = ensurePagePlan(d, page.id);
    assert.equal(again.id, first.id, '还是那一份');
    assert.equal(Object.keys(d.plans).length, 1, '★ 没叠出第二条');
});

test('★ `planOfPage`：认的是 pageId；没有就是 null；别的页不串味', () => {
    const d = draftState();
    const a = addPage(d, 'A 页');
    const b = addPage(d, 'B 页');
    assert.notEqual(planOfPage(d, a.id).id, planOfPage(d, b.id).id, '两页各有各的');
    assert.equal(planOfPage(d, a.id).pageId, a.id);
    assert.equal(planOfPage(d, '不存在的页'), null);
    assert.equal(planOfPage(d, ''), null);
    // `draftState()` 里那个手写的 page_1 没计划 ⇒ 如实 null（渲染那边按"没有计划"处理）
    assert.equal(planOfPage(d, 'page_1'), null);
});

// ================================================================
// ★ 副页方框上的强度角标：`剩 / 共`（用户 2026-10-15；口径见 `docs/training-plan.md` §14 ②）
// ================================================================

test('★ `planSubtreeIntensityOf`：子树两个数（剩 = 没打完的、共 = 全部）', () => {
    const page = {
        rootId: 'v_root',
        virtualIndex: {
            v_root: { id: 'v_root', refId: null, type: 'O', children: ['v_c', 'v_p3'] },
            // 一场比赛那一支：p1（做完，强度 10）+ p2（没做完，强度 4）
            v_c: { id: 'v_c', refId: 'c1', type: 'C', children: ['v_p1', 'v_p2'] },
            v_p1: { id: 'v_p1', refId: 'p1', type: 'P', children: [] },
            v_p2: { id: 'v_p2', refId: 'p2', type: 'P', children: [] },
            v_p3: { id: 'v_p3', refId: 'p3', type: 'P', children: [] }
        }
    };
    const entries = [
        { id: 'p1', intensity: 10, done: true },
        { id: 'p2', intensity: 4, done: false },
        { id: 'p3', intensity: 6, done: false }
    ];
    const got = planSubtreeIntensityOf(page, entries);
    assert.deepEqual(got.v_p1, { remaining: 0, total: 10 }, '做完的那道：剩 0 / 共 10');
    assert.deepEqual(got.v_p2, { remaining: 4, total: 4 }, '没做完的：剩 4 / 共 4');
    assert.deepEqual(got.v_c, { remaining: 4, total: 14 }, '★ 比赛那一支 = 孩子的合计');
    assert.deepEqual(got.v_p3, { remaining: 6, total: 6 });
    assert.deepEqual(got.v_root, { remaining: 10, total: 20 }, '★ 页根 = 全页合计');
});

test('★ `planSubtreeIntensityOf`：同一道题在页里出现两次只算一次；不在计划里的题不计', () => {
    const page = {
        rootId: 'v_root',
        virtualIndex: {
            v_root: { id: 'v_root', refId: null, type: 'O', children: ['v_a', 'v_b', 'v_x'] },
            v_a: { id: 'v_a', refId: 'p1', type: 'P', children: [] },
            v_b: { id: 'v_b', refId: 'p1', type: 'P', children: [] },   // 同一道题又来一次
            v_x: { id: 'v_x', refId: 'p9', type: 'P', children: [] }    // 被条件筛掉的题
        }
    };
    const got = planSubtreeIntensityOf(page, [{ id: 'p1', intensity: 7, done: false }]);
    assert.deepEqual(got.v_a, { remaining: 7, total: 7 });
    assert.deepEqual(got.v_b, { remaining: 7, total: 7 });
    assert.deepEqual(got.v_x, { remaining: 0, total: 0 }, '不在计划里的题 ⇒ 0（不占计划的强度）');
    assert.deepEqual(got.v_root, { remaining: 7, total: 7 }, '★ 去重后只算一次（不是 14）');
});