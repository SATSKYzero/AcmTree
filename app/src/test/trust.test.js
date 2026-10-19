// ================================================================
// 多来源投影测试（core/trust.js）
//
// 这些用例钉的是**规则本身**：谁赢、为什么赢、以及"没有值时不乱写"。
// 依据：投影规则
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SOURCE_KINDS,
    DEFAULT_TRUST,
    normalizeTrust,
    isEmptyValue,
    usableValues,
    projectField,
    sourceRankOf
} from '../core/trust.js';

/** 造一个测试用配置：pta 是权威榜单、srk 是脚本、manual 是手改 */
function trust(extra = {}) {
    return {
        categoryRank: ['manual', 'board', 'script', 'derived'],
        sources: {
            'pta:x': { kind: 'board', rank: 30 },
            'srk:x': { kind: 'script', rank: 20 },
            'qoj:x': { kind: 'script', rank: 20 },
            'manual': { kind: 'manual', rank: 100 },
            'derived': { kind: 'derived', rank: 0 }
        },
        fieldPrefer: {},
        ...extra
    };
}

const v = (value, src, at = '2026-09-01T00:00:00+08:00') => ({ v: value, src, at });

// ---- 基本 ----

test('单个来源 → 用它，理由是"唯一来源"', () => {
    const r = projectField('name', [v('All Closed', 'srk:x')], trust());
    assert.equal(r.value, 'All Closed');
    assert.equal(r.src, 'srk:x');
    assert.equal(r.reason, '唯一来源');
    assert.equal(r.empty, false);
});

test('多个来源说同一句话 → 合并，不刷屏', () => {
    const r = projectField('name', [v('All Closed', 'srk:x'), v('All Closed', 'pta:x')], trust());
    assert.equal(r.value, 'All Closed');
    assert.equal(r.reason, '2 个来源一致');
    assert.equal(r.src, 'pta:x', '代表来源应当取优先级更高的那个');
});

test('没有可用值 → empty=true 且值为空串（调用方负责"保持原值"）', () => {
    const r = projectField('ratio', [], trust());
    assert.equal(r.value, '');
    assert.equal(r.empty, true);
    assert.equal(r.reason, '没有来源值');
});

// ---- 优先级规则 ----

test('★ 同类之内排来源：现场/官方榜（xcpcio/pta/rankland/srk）> 混非正式榜（cf/nk）> 普通脚本', () => {
    // 用户 2026-10-16："按道理，xcpcio/rankland/pta 优先于 cf，因为基本就是前者现场、后者混非正式"，
    // 随后定的全表三档：**30 现场/官方榜 ｜ 25 榜但混非正式（CF gym、牛客多校/重现）｜ 20 脚本/补充**。
    // 这几条同为 `board`，所以胜负只能由**来源级等级**（`SOURCE_RANK`）说话 ——
    // 也正因为如此，"混非正式榜那份更新"是这条规则最容易被写反的地方（改前就输在这一步）。
    const t = trust({
        sources: {
            'xcpcio:x': { kind: 'board', rank: 30 },
            'pta:x': { kind: 'board', rank: 30 },
            'rankland-index:x': { kind: 'board', rank: 30 },
            'srk-x': { kind: 'board', rank: 30 },
            'cf-x': { kind: 'board', rank: 30 },
            'nk-gxcpc9th': { kind: 'board', rank: 30 },
            'nk-scraper': { kind: 'script', rank: 20 },
            'hdu-scraper': { kind: 'script', rank: 20 }
        }
    });
    // ① 现场/官方榜 > 混非正式榜（后者那份**更新**也不行）
    for (const onSite of ['xcpcio:x', 'pta:x', 'rankland-index:x', 'srk-x']) {
        for (const mix of ['cf-x', 'nk-gxcpc9th']) {
            const r = projectField('ratio',
                [v('4.61', onSite, '2026-09-01T00:00:00+08:00'), v('4.90', mix, '2026-09-30T00:00:00+08:00')], t);
            assert.equal(r.src, onSite, `${onSite} 必须压过 ${mix}（更新也不行）`);
        }
    }
    // ② 混非正式榜仍是"榜" ⇒ 压过脚本档（含写 ratio 的两个大户）
    for (const scr of ['nk-scraper', 'hdu-scraper']) {
        const r = projectField('ratio',
            [v('4.90', 'cf-x', '2026-09-01T00:00:00+08:00'), v('4.95', scr, '2026-09-30T00:00:00+08:00')], t);
        assert.equal(r.src, 'cf-x', `压一档 ≠ 降到脚本档（${scr}）`);
    }
    // ③ 反例：榜不在 ⇒ 脚本照常用
    assert.equal(projectField('ratio', [v('4.95', 'hdu-scraper')], t).value, '4.95');
});

test('★ 覆盖表里**只写偏离类别默认的档次**（30/20 档不写 —— 写了就是第二份真源）', () => {
    const cases = [
        ['xcpcio-bjcpc2024', 'board'], ['pta-bjcpc2025', 'board'],
        ['rankland-index-bjcpc2025', 'board'], ['srk-icpc2026preliminary-1', 'board'],   // 30 档
        ['hdu-scraper', 'script'], ['nk-scraper', 'script'], ['cf-titles-ccpc2019final', 'script'],
        ['cf-contest', 'script'], ['cf-web-x', 'script'], ['rankland-refs-bjcpc2025', 'script'],
        ['qoj', 'script'], ['atcoder', 'script'], ['synth', 'script']                     // 20 档
    ];
    for (const [src, kind] of cases) {
        assert.equal(sourceRankOf(src, kind), null, `${src}（${kind}）不该有覆盖 —— 用类别默认`);
    }
    // 只有"榜但混非正式"那两条压在中间（25 = board 30 与 script 20 之间）
    assert.equal(sourceRankOf('cf-ccpc2024ladies', 'board'), 25);
    assert.equal(sourceRankOf('nk-gxcpc9th', 'board'), 25);
    // 类别分档不许串：`nk-scraper` / `cf-titles-*` 是 script，**不许**被上面那条前缀命中
    assert.equal(sourceRankOf('nk-scraper', 'script'), null);
    assert.equal(sourceRankOf('cf-titles-ccpc2019final', 'script'), null);
});

test('权威榜单 > 脚本（类别的力量）', () => {
    const r = projectField('ratio', [v('4.60', 'srk:x'), v('4.61', 'pta:x')], trust());
    assert.equal(r.value, '4.61');
    assert.match(r.reason, /^权威榜单优先/, `实际理由：${r.reason}`);
});

test('手改永远最高（即使榜单是权威）', () => {
    const r = projectField('ratio', [v('4.61', 'pta:x'), v('5.00', 'manual')], trust());
    assert.equal(r.value, '5.00');
    assert.match(r.reason, /^你手改的/, `实际理由：${r.reason}`);
    assert.match(r.reason, /未采用/, '被压下去的榜单值也要说出来');
});

test('字段级偏好能插队（ratio 以后听 rankland）', () => {
    const t = trust({ fieldPrefer: { ratio: ['srk:x'] } });
    const r = projectField('ratio', [v('4.61', 'pta:x'), v('4.60', 'srk:x')], t);
    assert.equal(r.value, '4.60');
    assert.match(r.reason, /^你指定这个字段优先用 srk:x/, `实际理由：${r.reason}`);
});

test('字段级偏好支持前缀模式（pta:*）', () => {
    const t = trust({ fieldPrefer: { ratio: ['srk:*'] } });
    const r = projectField('ratio', [v('4.61', 'pta:x'), v('4.60', 'srk:x')], t);
    assert.equal(r.value, '4.60');
});

test('同类来源比等级；等级相同取更新时间新的', () => {
    const t = trust({
        sources: {
            'srk:x': { kind: 'script', rank: 20 },
            'qoj:x': { kind: 'script', rank: 20 }
        }
    });
    const newer = projectField('ratio',
        [v('A', 'srk:x', '2026-09-01T00:00:00+08:00'), v('B', 'qoj:x', '2026-09-02T00:00:00+08:00')], t);
    assert.equal(newer.value, 'B', '同等级应取更新的');

    const sameTime = projectField('ratio', [v('A', 'srk:x', ''), v('B', 'qoj:x', '')], t);
    assert.equal(sameTime.value, 'A', '完全平手时"先到者胜"，投影必须稳定');
});

test('等级不同 → 等级高的赢', () => {
    const t = trust({
        sources: {
            'srk:x': { kind: 'script', rank: 20 },
            'qoj:x': { kind: 'script', rank: 5 }
        }
    });
    const r = projectField('ratio', [v('低', 'qoj:x'), v('高', 'srk:x')], t);
    assert.equal(r.value, '高');
    assert.match(r.reason, /来源等级更高/);
});

// ---- 分歧必须摆出来，不能藏 ----

test('未采用的说法要写进理由里（核心态度：不隐藏分歧）', () => {
    const r = projectField('ratio', [v('4.61', 'pta:x'), v('4.60', 'srk:x')], trust());
    assert.match(r.reason, /另有/);
    assert.match(r.reason, /4\.60/);
    assert.match(r.reason, /未采用/);
});

test('all 字段标出每个值是否被采用（给值级界面用）', () => {
    const r = projectField('ratio', [v('4.61', 'pta:x'), v('4.60', 'srk:x')], trust());
    assert.equal(r.all.length, 2);
    assert.equal(r.all.find(x => x.v === '4.61').selected, true);
    assert.equal(r.all.find(x => x.v === '4.60').selected, false);
});

// ---- 失效与空值 ----

test('invalid 的值不参与投影（但也不报错）', () => {
    const r = projectField('ratio', [
        v('4.61', 'pta:x'),
        { v: '9.99', src: 'srk:x', at: '', invalid: true }
    ], trust());
    assert.equal(r.value, '4.61');
    assert.equal(r.reason, '唯一来源');
});

test('空串不参与投影（否则低优先级的空白会盖掉真值）', () => {
    const r = projectField('ratio', [v('', 'pta:x'), v('4.60', 'srk:x')], trust());
    assert.equal(r.value, '4.60');
});

test("'-' 是有效值，不是空（用它表示「未填写」）", () => {
    assert.equal(isEmptyValue('-'), false);
    assert.equal(isEmptyValue(''), true);
    assert.equal(isEmptyValue('   '), true);
    assert.equal(isEmptyValue(null), true);
    const r = projectField('status', [v('-', 'cf:x')], trust());
    assert.equal(r.value, '-');
});

test('全部失效 → empty=true', () => {
    const r = projectField('ratio', [{ v: '4.61', src: 'pta:x', invalid: true }], trust());
    assert.equal(r.empty, true);
    assert.equal(r.value, '');
});

// ---- 纯函数性质 ----

test('不修改入参（纯函数）', () => {
    const values = [v('4.61', 'pta:x'), v('4.60', 'srk:x')];
    const snapshot = JSON.stringify(values);
    projectField('ratio', values, trust());
    assert.equal(JSON.stringify(values), snapshot);
});

test('配置缺项回落默认值，不炸', () => {
    const r1 = projectField('ratio', [v('1', 'srk:x')], undefined);
    assert.equal(r1.value, '1');
    const r2 = projectField('ratio', [v('1', 'srk:x')], {});
    assert.equal(r2.value, '1');
    const t = normalizeTrust({ fieldPrefer: { ratio: 'pta:x' } });
    assert.deepEqual(t.fieldPrefer.ratio, 'pta:x', '非数组写法也要能读');
    assert.deepEqual(normalizeTrust(null).categoryRank, DEFAULT_TRUST.categoryRank);
});

test('入参不是数组时按"没有值"处理', () => {
    assert.equal(projectField('ratio', null, trust()).empty, true);
    assert.equal(projectField('ratio', 'oops', trust()).empty, true);
    assert.deepEqual(usableValues('ratio', null, trust()), []);
});

// ---- 批量（逐字段投影的用法：字段多了就自己循环） ----

test('逐字段投影：每个字段都能拿到值与理由', () => {
    const name = projectField('name', [v('All Closed', 'srk:x')], trust());
    const ratio = projectField('ratio', [v('4.61', 'pta:x'), v('4.60', 'srk:x')], trust());
    assert.equal(name.value, 'All Closed');
    assert.equal(ratio.value, '4.61');
    assert.equal(name.reason, '唯一来源');
    assert.match(ratio.reason, /权威榜单优先/);
});

test('SOURCE_KINDS 与默认配置的形状固定（界面/注册表按它写）', () => {
    assert.deepEqual(Object.values(SOURCE_KINDS), ['manual', 'board', 'script', 'derived']);
    assert.deepEqual(DEFAULT_TRUST.categoryRank, ['manual', 'board', 'script', 'derived']);
    assert.deepEqual(DEFAULT_TRUST.fieldPrefer, {});
});

// ---- 账户层 ----

test('账户层：viewing 账户的个性化值优先于客观值', () => {
    const values = [
        { v: '客观', src: 'srk:x', at: 'T1' },
        { v: '我的', src: 'manual', at: 'T1', account: 'A' },
        { v: '别人的', src: 'manual', at: 'T1', account: 'B' }
    ];
    const r = projectField('name', values, trust(), { viewingAccount: 'A' });
    assert.equal(r.value, '我的');
    assert.equal(r.src, 'manual');
});

test('账户层：自己没有值时回落到客观值（别人的值不算）', () => {
    const values = [
        { v: '客观', src: 'srk:x', at: 'T1' },
        { v: '别人的', src: 'manual', at: 'T1', account: 'B' }
    ];
    assert.equal(projectField('name', values, trust(), { viewingAccount: 'C' }).value, '客观');
});

test('账户层：别人的值不进候选（all 里没有它）', () => {
    const values = [
        { v: '客观', src: 'srk:x', at: 'T1' },
        { v: '别人的', src: 'manual', at: 'T1', account: 'B' }
    ];
    const r = projectField('name', values, trust(), { viewingAccount: 'A' });
    assert.equal(r.all.length, 1);
    assert.equal(r.all.some(x => x.v === '别人的'), false);
});

test('账户层：不传 viewingAccount → 不过滤（老调用方行为不变）', () => {
    const values = [
        { v: '客观', src: 'srk:x', at: 'T1' },
        { v: '别人的', src: 'manual', at: 'T1', account: 'B' }
    ];
    const r = projectField('name', values, trust());
    assert.equal(r.value, '别人的', '手改仍最高');
    assert.equal(r.all.length, 2);
});

test('账户层：同一来源给不同账户报同一个值 → 按账户各自成候选', () => {
    const values = [
        { v: '3', src: 'pta', at: 'T1', account: 'A' },
        { v: '3', src: 'pta', at: 'T1', account: 'B' }
    ];
    const a = usableValues('rank', values, trust(), { viewingAccount: 'A' });
    assert.equal(a.length, 1);
    assert.equal(a[0].account, 'A');
    assert.equal(usableValues('rank', values, trust(), { viewingAccount: 'B' })[0].account, 'B');
});
