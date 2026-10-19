// ================================================================
// 「疑似被拆开的组」（core/synthPlan.js 的 isSuspectSplit / suspectSplitPairs）
//
// 省赛那一支正交化成 `<主办>/<类型>` 之后，**主办是从各来源自己的赛名读的**，
// 而同一场比赛在不同来源的名字里品牌词不一致（qoj 官方英文名写 `ICPC`、中文来源一个品牌词都不写）
// ⇒ 同一场被拆成两组。这类组**不自动合**（按组投票不可从零复现），这 20 组交给人处理，
// 但**必须有一条正确的警告**把它们报出来 —— 这个文件就是"警告正确"的定义。
//
// ★ 夹具**全部是实测的真数据**（那 20 组逐条抄自包里）：
//   · 4 组是**真·两场**（两边都明说品牌且不同）⇒ 警告**必须一声不吭**；
//   · 16 组是**同一场被拆坏**（一边明说、一边 `无`）⇒ 警告**必须全部命中**。
//   ⚠️ 别为了让测试好写而改这些数字 —— 改了就等于把"警告正确"的定义改掉。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    groupFacetsOf, isSuspectSplit, suspectSplitPairs, PROVINCIAL_ORG_NONE
} from '../core/synthPlan.js';

/** 照真记录的形状造一个组头（`natureClass` 就是实测值那样拼的），再过 `groupFacetsOf` */
function G(org, type, season, place, members) {
    const tail = `${place}${org === PROVINCIAL_ORG_NONE ? '' : org}${type}`;
    return groupFacetsOf({
        synthKey: `synth:xcpc:provincial&invitational:${season}:${tail}`,
        name: `${season} ${tail}`,
        natureClass: `xcpc/provincial&invitational/${org}/${type}/official`,
        natureSeason: String(season),
        natureRegion: place
    }, members);
}

// ---- ① 真·两场：两边都写了品牌、且不同 ⇒ 本来就是要拆开，警告必须**不命中** ----
const REAL_PAIRS = [
    // [赛季, 地点, 类型, 甲的主办, 甲的成员数, 乙的主办, 乙的成员数]
    [2026, '江西', '省赛暨邀请赛', 'CC', 1, 'IC', 1],
    [2025, '江西', '省赛暨邀请赛', 'CC', 3, 'IC', 3],
    [2026, '河南', '省赛', 'CC', 3, 'IC', 2],
    [2024, '河南', '省赛', 'IC', 2, 'CC', 2]
];

test('★ 真·两场（两边都明说品牌且不同）⇒ 警告**必须不命中**（报它就是误报）', () => {
    const wrong = [];
    for (const [season, place, type, orgA, na, orgB, nb] of REAL_PAIRS) {
        const a = G(orgA, type, season, place, na);
        const b = G(orgB, type, season, place, nb);
        if (isSuspectSplit(a, b)) wrong.push(`(${season} ${place}${type}：${orgA} vs ${orgB})`);
    }
    assert.deepEqual(wrong, [], '河南/江西那 4 组本来是两场，不许报警');
});

// ---- ② 同一场被拆坏：一边明说品牌、一边 `无` ⇒ 警告**必须命中** ----
const BROKEN_PAIRS = [
    [2026, '黑龙江', '省赛', 'CC', 1, '无', 2],
    [2026, '四川', '省赛', 'IC', 1, '无', 2],
    [2026, '浙江', '省赛', 'IC', 1, '无', 3],
    [2025, '四川', '省赛', 'IC', 1, '无', 2],
    [2025, '浙江', '省赛', 'IC', 1, '无', 2],
    [2025, '广西', '省赛', '无', 1, 'IC&CC', 2],
    [2025, '河北', '省赛', 'CC', 1, '无', 2],
    [2024, '北京', '省赛', 'CC', 1, '无', 3],
    [2024, '四川', '省赛', 'IC', 1, '无', 3],
    [2024, '浙江', '省赛', 'IC', 1, '无', 2],
    [2022, '浙江', '省赛', 'IC', 1, '无', 2],
    [2022, '河北', '省赛', 'CC', 1, '无', 1],
    [2021, '四川', '省赛', 'IC', 1, '无', 1],
    [2021, '浙江', '省赛', 'IC', 1, '无', 2],
    [2020, '浙江', '省赛', 'IC', 1, '无', 1],
    [2023, '湖北', '省赛', 'CC', 2, '无', 1]
];

test('★ 同一场被拆坏（一边明说品牌、一边 `无`）⇒ 警告**必须全部命中**', () => {
    const missed = [];
    for (const [season, place, type, orgA, na, orgB, nb] of BROKEN_PAIRS) {
        const a = G(orgA, type, season, place, na);
        const b = G(orgB, type, season, place, nb);
        if (!isSuspectSplit(a, b)) missed.push(`(${season} ${place}${type}：${orgA} vs ${orgB})`);
    }
    assert.deepEqual(missed, [], '这 16 组是同一场被拆开，一条都不许漏');
});

test('★ 20 组真数据整体过一遍：命中数正好 16（不是 20、也不是 4）', () => {
    const groups = [];
    for (const [s, p, t, oa, na, ob, nb] of REAL_PAIRS) {
        groups.push(G(oa, t, s, p, na), G(ob, t, s, p, nb));
    }
    for (const [s, p, t, oa, na, ob, nb] of BROKEN_PAIRS) {
        groups.push(G(oa, t, s, p, na), G(ob, t, s, p, nb));
    }
    assert.equal(suspectSplitPairs(groups).length, 16, '4 组真·两场 + 16 组拆坏 ⇒ 只该报 16 对');
});

// ---- ③ 反向锚：这条警告**不许**在别的维度上乱咬 ----
test('反向锚：空组不报（人并回去之后剩下的空壳必须让警告自动消失）', () => {
    const a = G('IC', '省赛', 2026, '浙江', 1);
    const b = G('无', '省赛', 2026, '浙江', 0);      // 人已经把人挪走 ⇒ 空壳
    assert.equal(isSuspectSplit(a, b), false);
    assert.equal(isSuspectSplit(G('无', '省赛', 2026, '浙江', 0), G('IC', '省赛', 2026, '浙江', 0)), false);
});

test('反向锚：赛季 / 地点 / 类型 任一不同就不报（那本来就是两场不同的比赛）', () => {
    const base = G('IC', '省赛', 2026, '浙江', 1);
    const none = G('无', '省赛', 2026, '浙江', 1);
    assert.equal(isSuspectSplit(base, none), true, '（前提）同一场才报');
    assert.equal(isSuspectSplit(base, G('无', '省赛', 2025, '浙江', 1)), false, '赛季不同 ⇒ 两场');
    assert.equal(isSuspectSplit(base, G('无', '省赛', 2026, '江苏', 1)), false, '地点不同 ⇒ 两场');
    assert.equal(isSuspectSplit(base, G('无', '邀请赛', 2026, '浙江', 1)), false, '类型不同 ⇒ 两场');
});

test('反向锚：两边都是 `无` 不报（谁都没说主办，没有"不一致"可言）', () => {
    assert.equal(isSuspectSplit(G('无', '省赛', 2026, '浙江', 1), G('无', '省赛', 2026, '浙江', 1)), false);
});

test('反向锚：不是省赛支的组不报（只有那一支有主办轴）', () => {
    const syn = (cls, n) => groupFacetsOf({
        synthKey: `synth:xcpc:${cls}`, name: 'x', natureClass: cls,
        natureSeason: '2026', natureRegion: '成都'
    }, n);
    assert.equal(isSuspectSplit(syn('xcpc/icpc/ec/regional/official', 1), syn('xcpc/ccpc/regional/official', 1)),
        false, 'icpc / ccpc 两支没有主办那一段');
});

test('反向锚：地点不是真地名（`无` / 空）⇒ 不报（无从判断是不是同一场）', () => {
    const a = G('IC', '省赛', 2026, '无', 1);
    const b = { ...G('无', '省赛', 2026, '无', 1), place: '' };
    assert.equal(isSuspectSplit(a, b), false);
});

test('★ `suspectSplitPairs` 与"逐对暴力"结果**逐条、逐序相同**（分桶优化不许改结果）', () => {
    // 2026-10-18：这个函数原来是双循环 O(n²)（真包约 2400 组 ⇒ 约 290 万次比较），
    // 改成按 (赛季, 地点, 类型) 分桶 + 只把"主办=无 / 不是无"配对。
    // 这条守卫就是它的**等价性判据**：拿同一批组，分桶版与暴力版必须一模一样（含顺序）。
    const groups = [
        G('IC', '省赛', 2026, '浙江', 1),
        G('无', '省赛', 2026, '浙江', 1),          // ↔ 上面一条：命中
        G('CC', '省赛', 2026, '浙江', 1),          // 与 IC 是"真·两场"，与 `无` 也是命中
        G('无', '省赛', 2026, '江苏', 2),          // 地点不同：不命中
        G('IC', '邀请赛', 2026, '浙江', 1),        // 类型不同：不命中
        G('无', '邀请赛', 2026, '浙江', 1),        // ↔ 上一条：命中
        G('无', '省赛', 2025, '浙江', 1),          // 赛季不同：不命中
        G('IC', '省赛', 2026, '浙江', 0),          // 空壳（没有成员）：不命中
        { ...G('无', '省赛', 2026, '无', 1), place: '' },  // 没地点：不参与
        G('IC', '省赛', 2026, '浙江', 1)           // 与第 1 条完全同键：两两都要算
    ];
    // 暴力版（原实现）——**故意写在测试里**，作为"结果的定义"
    const brute = [];
    for (let i = 0; i < groups.length; i++) {
        for (let j = i + 1; j < groups.length; j++) {
            if (isSuspectSplit(groups[i], groups[j])) brute.push([i, j]);
        }
    }
    const got = suspectSplitPairs(groups).map(([a, b]) => [groups.indexOf(a), groups.indexOf(b)]);
    assert.deepEqual(got, brute, '分桶版必须与暴力版逐条逐序相同');
    assert.ok(brute.length >= 3, `（前提）夹具里得真有命中，别空转地绿：${brute.length} 对`);
});

// ---- ④ 判据住哪儿 / 谁在用（源码级）----
test('源码级：`synth-bind.mjs` 不自己另写一套"疑似被拆开"的判据，只调 synthPlan 那一份', async () => {
    const fs = await import('node:fs');
    const strip = s => s.replace(/\/\/.*$/gm, '');
    const src = strip(fs.readFileSync(new URL('../../scripts/synth-bind.mjs', import.meta.url), 'utf8'));
    assert.match(src, /suspectSplitPairs/, '产包侧要报这条警告');
    assert.match(src, /from '\.\.\/src\/core\/synthPlan\.js'/, '判据从 synthPlan 取（别在这里另写）');
});
