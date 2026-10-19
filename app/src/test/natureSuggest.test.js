// ================================================================
// 性质推荐（src/test/natureSuggest.test.js）
//
// 钉的是 `core/natureSuggest.js` 的口径：
//   · **只推荐、不写**（本模块一个写操作都没有）；
//   · **没证据就不推**（`null`，不是"猜一个最像的"）；
//   · **年份（举办）与赛季是两个字段**：
//       年份 = 只认节点自己的**开赛时间**；
//       赛季 = 标识 → 名字 → 父容器（这些写的都是"哪一届"）；
//     ⚠️ 两个概念**不许互相顶替**（EC-Final 常跨年：2023 赛季在 2024-01 办）；
//   · 只认 `20xx`（两个字段的合法形态都是 `^20\d{2}$`，19xx 推出去也写不进）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    yearInText,
    yearInIdentifier,
    hasSeasonConcept,
    suggestNatureYear,
    suggestNatureSeason,
    suggestNature,
    suggestNatureFields,
    suggestRank,
    SUGGEST_FROM
} from '../core/natureSuggest.js';

/** 造一个最小 state（只需要 nodes / parentOf） */
function mkState(nodes, parentOf = {}) {
    return { nodes, parentOf };
}

test('yearInText：只取第一个 20xx；19xx 不算（写进年份字段也不合法）', () => {
    assert.equal(yearInText('2023.11.05 11:00:00'), '2023');
    assert.equal(yearInText('The 2017 ACM-ICPC Asia East Regionals'), '2017');
    assert.equal(yearInText('CCPC 2025-2026 赛季'), '2025', '取第一个');
    assert.equal(yearInText('1999 年的老场'), '', '19xx 不是合法年份');
    assert.equal(yearInText(''), '');
    assert.equal(yearInText(null), '');
    assert.equal(yearInText(undefined), '');
    assert.equal(yearInText('没有年份'), '');
});

test('已经填了的字段 ⇒ 不推荐那一格（推荐不覆盖已有值）', () => {
    const s = mkState({
        c1: { id: 'c1', type: 'C', natureYear: '2020', natureSeason: '2019',
              contestTime: '2023.11.05', extKey: 'xcpc:c:zjcpc-2021' }
    });
    assert.equal(suggestNatureYear(s, 'c1'), null);
    assert.equal(suggestNatureSeason(s, 'c1'), null);
    assert.deepEqual(suggestNature(s, 'c1'), { year: null, season: null, region: null });
});

test('★ 年份（举办）= 只认开赛时间；赛季 = 只认标识/名字/容器（两者不互相顶替）', () => {
    // "2023 赛季（第 48 届）的 EC-Final 在 24 年 1 月举行…可见赛季与举办年份是要区分开的"
    const s = mkState({
        c1: {
            id: 'c1', type: 'C', natureClass: 'xcpc/icpc/ec/final',
            extKey: 'aux-rankland:c:icpc2023ecfinal', contestTime: '2024.01.13 10:00:00',
            name: 'The 48th ICPC Asia East Continent Final Contest'
        }
    });
    const y = suggestNatureYear(s, 'c1');
    assert.equal(y.value, '2024', '★ 年份 = 举办年（2024-01 那场）');
    assert.equal(y.from, SUGGEST_FROM.TIME);
    assert.match(y.why, /开赛时间/);
    const sea = suggestNatureSeason(s, 'c1');
    assert.equal(sea.value, '2023', '★ 赛季 = 2023（标识里写着 icpc2023ecfinal）');
    assert.equal(sea.from, SUGGEST_FROM.KEY);
    assert.notEqual(y.value, sea.value, '这一场两个值**就是不一样** —— 拆成两个字段的意义所在');
});

test('★ 同一届的另一个来源有时 ⇒ 用它（比拿赛季顶准）', () => {
    // 场景：QOJ 那场 EC-Final 没有日期（QOJ 基本不记），但 XCPC 那边的镜像有真实日期。
    // ⚠️ 两边分类不同（`qoj/xcpc/…` vs `xcpc/…`）—— 同届判定**掐掉 `qoj/` 前缀**后逐字相同。
    const s = mkState({
        q: { id: 'q', type: 'C', natureClass: 'qoj/xcpc/icpc/ec/final', natureSeason: '2023' },
        x: {
            id: 'x', type: 'C', name: '2023 EC-Final', natureClass: 'xcpc/icpc/ec/final',
            natureSeason: '2023', natureYear: '2024'
        }
    });
    const got = suggestNatureYear(s, 'q');
    assert.equal(got.value, '2024', '★ XCPC 那边的镜像写着 2024 ⇒ 推荐它（不是赛季 2023）');
    assert.equal(got.from, SUGGEST_FROM.SIBLING);
    assert.equal(got.fromId, 'x', '出处指回那个节点（点了能跳过去核对）');
    assert.match(got.why, /另一个来源/);
    // 同支（都是 qoj）同样认
    const s2 = mkState({
        q: { id: 'q', type: 'C', natureClass: 'qoj/xcpc/icpc/ec/final', natureSeason: '2023' },
        q2: {
            id: 'q2', type: 'C', name: 'EC-Final 2023（另一来源）',
            natureClass: 'qoj/xcpc/icpc/ec/final', natureSeason: '2023', natureYear: '2024'
        }
    });
    assert.equal(suggestNatureYear(s2, 'q').value, '2024');
    // 同届来源互相矛盾 ⇒ 不按它推，退到最后那条"赛季反推"（why 里照样写着可能差一年）
    const s3 = mkState({
        a: { id: 'a', type: 'C', natureClass: 'xcpc/ccpc/final', natureSeason: '2023' },
        b: { id: 'b', type: 'C', natureClass: 'xcpc/ccpc/final', natureSeason: '2023', natureYear: '2023' },
        c: { id: 'c', type: 'C', natureClass: 'xcpc/ccpc/final', natureSeason: '2023', natureYear: '2024' }
    });
    const got3 = suggestNatureYear(s3, 'a');
    assert.equal(got3.from, SUGGEST_FROM.SEASON, '两个来源一个说 2023 一个说 2024 ⇒ 不采信任何一边');
    assert.match(got3.why, /可能差一年/);
    // 开赛时间仍然最硬（哪怕有同届来源）
    const s4 = mkState({
        a: { id: 'a', type: 'C', natureClass: 'xcpc/ccpc/final', natureSeason: '2023',
             contestTime: '2024.05.11' },
        b: { id: 'b', type: 'C', natureClass: 'xcpc/ccpc/final', natureSeason: '2023', natureYear: '2023' }
    });
    assert.equal(suggestNatureYear(s4, 'a').from, SUGGEST_FROM.TIME);
});

test('★ 年份没有开赛时间 ⇒ 退到**赛季反推**（why 里必须写明"可能差一年"）', () => {
    const s = mkState({ c1: { id: 'c1', type: 'C', extKey: 'qoj:c:1522', natureSeason: '2023' } });
    const y = suggestNatureYear(s, 'c1');
    assert.equal(y.value, '2023', '没有开赛时间 ⇒ 用赛季年（"qoj 应该没记开赛时间，从赛季反推"）');
    assert.equal(y.from, SUGGEST_FROM.SEASON);
    assert.match(y.why, /从「赛季」/);
    assert.match(y.why, /可能差一年/, '必须提醒这是反推的');
    // 有开赛时间时**不**反推（时间永远第一）
    const s2 = mkState({
        c1: { id: 'c1', type: 'C', contestTime: '2024.01.13', natureSeason: '2023' }
    });
    assert.equal(suggestNatureYear(s2, 'c1').value, '2024');
    assert.equal(suggestNatureYear(s2, 'c1').from, SUGGEST_FROM.TIME);
    // 两个都没有 ⇒ 不推
    assert.equal(suggestNatureYear(mkState({ c: { id: 'c', type: 'C' } }), 'c'), null);
});

test('★ 占位取值（`无` / `待同步` / `不确定`）绝不会被推荐', () => {
    // "cf gym 不要填赛季无，也不要推荐赛季无/年份无"。
    // gym 的赛季 = 举办年份（见 `cf_board_adapter.cf_nature`）⇒ 没有开赛时间时**什么都不推**，
    // 而不是推一个「无」上去（推「无」= 把"不知道"说成"不适用"）。
    const gym = mkState({
        g: { id: 'g', type: 'C', natureClass: 'cf/gyms', name: 'ICPC Asia Regional Gym' }
    });
    assert.equal(suggestNatureYear(gym, 'g'), null);
    assert.equal(suggestNatureSeason(gym, 'g'), null);
    // 赛季是 `无`（CF 正式轮次 / AtCoder）⇒ 不能拿它反推"举办年份"
    const cf = mkState({ c: { id: 'c', type: 'C', natureClass: 'cf/contest/div2', natureSeason: '无' } });
    assert.equal(suggestNatureYear(cf, 'c'), null, '`无` 不是年份，反推出来就是一个假的年份');
    // 赛季是占位取值 ⇒ 同样不推（`待同步`/`不确定` 不是"哪一届"）
    for (const v of ['待同步', '不确定']) {
        const s = mkState({ c: { id: 'c', type: 'C', natureClass: 'xcpc/icpc/ec/final', natureSeason: v } });
        assert.equal(suggestNatureYear(s, 'c'), null, `${v} 不能当年份用`);
    }
    // 占位取值**算填过了**（那一格有值就不推）—— 这正是"以后有用"的那层意思
    const done = mkState({ c: { id: 'c', type: 'C', natureSeason: '待同步', natureYear: '不确定' } });
    assert.equal(suggestNatureYear(done, 'c'), null);
    assert.equal(suggestNatureSeason(done, 'c'), null);
    // 同届索引只收**真年份**：赛季 `无` 的 CF 单场不会互相当成"同届"
    const same = mkState({
        a: { id: 'a', type: 'C', natureClass: 'cf/contest/div2', natureSeason: '无', natureYear: '2024' },
        b: { id: 'b', type: 'C', natureClass: 'cf/contest/div2', natureSeason: '无' }
    });
    assert.equal(suggestNatureYear(same, 'b'), null, '`无` 不成"届"（否则不相干的比赛会被并到一届里）');
});

test('赛季：标识 → 名字 → 父容器（顺序 = 证据强度）', () => {
    // 标识里有 ⇒ 用它
    const a = mkState({ c: { id: 'c', type: 'C', extKey: 'xcpc:c:ccpc2023final', name: '2022 某站' } });
    assert.equal(suggestNatureSeason(a, 'c').from, SUGGEST_FROM.KEY);
    assert.equal(suggestNatureSeason(a, 'c').value, '2023');
    // 标识里没有 ⇒ 名字
    const b = mkState({ c: { id: 'c', type: 'C', extKey: 'xcpc:c:chengdu', name: '第十一届 CCPC 2025' } });
    assert.equal(suggestNatureSeason(b, 'c').from, SUGGEST_FROM.NAME);
    assert.equal(suggestNatureSeason(b, 'c').value, '2025');
    // 都没有 ⇒ 父容器里写着年份的那一层
    const c2 = mkState({
        c1: { id: 'c1', type: 'C' },
        s2: { id: 's2', type: 'S', name: '浙江赛区' },
        s1: { id: 's1', type: 'S', name: '2026 浙江省赛' }
    }, { c1: 's2', s2: 's1' });
    const got = suggestNatureSeason(c2, 'c1');
    assert.equal(got.value, '2026');
    assert.equal(got.from, SUGGEST_FROM.CONTAINER);
    assert.equal(got.fromId, 's1', '出处指回那一层容器（点了能跳过去核对）');
    // 都没有 ⇒ null
    assert.equal(suggestNatureSeason(mkState({ c: { id: 'c', type: 'C', name: '成都站' } }), 'c'), null);
});

test('父容器数据成环也不会死循环', () => {
    const s = mkState({
        c1: { id: 'c1', type: 'C' },
        a: { id: 'a', type: 'S', name: '甲' },
        b: { id: 'b', type: 'S', name: '乙' }
    }, { c1: 'a', a: 'b', b: 'a' });
    assert.equal(suggestNatureSeason(s, 'c1'), null);
});

test('地区**一律不推荐**（库里还没有真实地名可学；接口先留着）', () => {
    const s = mkState({
        c1: { id: 'c1', type: 'C', natureClass: 'xcpc/icpc' },
        c2: { id: 'c2', type: 'C', name: '成都站', natureRegion: '成都' }
    });
    assert.equal(suggestNature(s, 'c1').region, null);
});

test('批量：只返回推得出来的字段；一个字段都推不出来就不进列表', () => {
    const s = mkState({
        a: { id: 'a', type: 'C', contestTime: '2024.05.01', extKey: 'xcpc:c:zjcpc-2023' },
        b: { id: 'b', type: 'C', name: '成都站' },
        c: { id: 'c', type: 'C', extKey: 'xcpc:c:zjcpc-2026' }
    });
    const got = suggestNatureFields(s, ['a', 'b', 'c']);
    assert.deepEqual(got.map(g => g.id), ['a', 'c'], 'b 一个字都推不出来 ⇒ 不进列表');
    assert.deepEqual(got[0].fields, { natureYear: '2024', natureSeason: '2023' }, 'a 两个字段都有依据');
    assert.deepEqual(got[1].fields, { natureSeason: '2026' }, 'c 只有赛季');
    assert.match(got[0].whys.natureYear, /开赛时间/);
    assert.match(got[0].whys.natureSeason, /标识/);
    assert.deepEqual(suggestNatureFields(s, []), []);
});

test('没证据 ⇒ `null`（不是"猜一个最像的"）', () => {
    const s = mkState({ c1: { id: 'c1', type: 'C', name: '成都站', extKey: 'xcpc:c:chengdu' } });
    assert.equal(suggestNatureYear(s, 'c1'), null);
    assert.equal(suggestNatureSeason(s, 'c1'), null);
    assert.equal(suggestNatureYear(s, '不存在'), null);
    assert.equal(suggestNatureYear(null, 'c1'), null);
});

test('★ 标识里的**纯数字段是 id，不是年份**（`qoj:c:2028` 不能推出 2028）', () => {
    // 实际："比赛 The 2016 ACM-ICPC Asia China-Final Contest（qoj:c:2028）
    // 的年份被误判成 2028 了，很多比赛也有这个问题" —— 2028 是 **QOJ 的场次 id**。
    assert.equal(yearInText('qoj:c:2028'), '2028', '（这是"整串找 20xx"会犯的错）');
    assert.equal(yearInIdentifier('qoj:c:2028'), '', '★ 丢掉纯数字段 ⇒ 不再误判');
    assert.equal(yearInIdentifier('cf:c:2039'), '', 'CF 的比赛号同理');
    assert.equal(yearInIdentifier('qoj:s:cat-2:cat-17:cat-21:cat-458'), '', '分类 id 同理');
    assert.equal(yearInIdentifier('xcpc:c:zjcpc-2026'), '2026', '年份长在 slug 里 ⇒ 照旧取到');
    assert.equal(yearInIdentifier('synth:cf:1459c'), '', '不是年份就不是');

    // 端到端：这一场的**赛季**只能从名字里拿到 2016（而不是从标识拿 2028）
    const s = mkState({
        c1: {
            id: 'c1', type: 'C', extKey: 'qoj:c:2028',
            name: 'The 2016 ACM-ICPC Asia China-Final Contest (CHINA-Final 2016)'
        }
    });
    const got = suggestNatureSeason(s, 'c1');
    assert.equal(got.value, '2016');
    assert.equal(got.from, SUGGEST_FROM.NAME, '只能靠名字（并带着"未必是赛季年"的提醒）');
    assert.match(got.why, /名字/);
});

test('强度序：时间 < 同届其它来源 < 标识 < 容器 < 名字 < 赛季反推（界面按它取最优）', () => {
    assert.ok(suggestRank(SUGGEST_FROM.TIME) < suggestRank(SUGGEST_FROM.SIBLING),
        '开赛时间最硬');
    assert.ok(suggestRank(SUGGEST_FROM.SIBLING) < suggestRank(SUGGEST_FROM.KEY),
        '「同一届的另一个来源填过什么」比 slug / 名字这些间接证据硬');
    assert.ok(suggestRank(SUGGEST_FROM.KEY) < suggestRank(SUGGEST_FROM.CONTAINER));
    assert.ok(suggestRank(SUGGEST_FROM.CONTAINER) < suggestRank(SUGGEST_FROM.NAME));
    assert.ok(suggestRank(SUGGEST_FROM.NAME) < suggestRank(SUGGEST_FROM.SEASON),
        '「从赛季反推」是最后的兜底（时间 > 一切）');
    assert.equal(suggestRank('不认识'), 6, '不认识的排最后');
});

// ================================================================
// 依据强度（"『按推荐填』让用户选择接受 A/B/C/D/E 级及以上的推荐"）
// ================================================================
test('★ 每条推荐都带**依据强度**（`level`），与出处一一对应', () => {
    const s = mkState({
        a: { id: 'a', type: 'C', contestTime: '2024.05.01' },              // 时间 ⇒ A
        b: { id: 'b', type: 'C', extKey: 'xcpc:c:zjcpc-2021' },            // 标识 ⇒ B
        c: { id: 'c', type: 'C', name: '第 8 届 CCPC 2023 总决赛' },        // 名字 ⇒ C
        d: { id: 'd', type: 'C', natureSeason: '2022' }                    // 赛季反推 ⇒ D
    });
    assert.equal(suggestNatureYear(s, 'a').level, 'A');
    assert.equal(suggestNatureYear(s, 'd').level, 'D');
    assert.equal(suggestNatureSeason(s, 'b').level, 'B');
    assert.equal(suggestNatureSeason(s, 'c').level, 'C');
    // 父容器那条也是 C（容器是我们自己分的组）
    const s2 = mkState({
        c1: { id: 'c1', type: 'C' },
        s1: { id: 's1', type: 'S', name: '2026 浙江省赛' }
    }, { c1: 's1' });
    assert.equal(suggestNatureSeason(s2, 'c1').level, 'C');
});

test('★ `suggestNatureFields(..., {minLevel})`：门槛之下的推荐**不进结果**（= 不会被批量写）', () => {
    const s = mkState({
        a: { id: 'a', type: 'C', contestTime: '2024.05.01' },              // 年份 A
        b: { id: 'b', type: 'C', extKey: 'xcpc:c:zjcpc-2021' },            // 赛季 B
        d: { id: 'd', type: 'C', natureSeason: '2022' }                    // 年份 D（反推）
    });
    const ids = ['a', 'b', 'd'];
    // 门槛 E（= 全收，今天的默认行为）
    const all = suggestNatureFields(s, ids, { minLevel: 'E' });
    assert.deepEqual(all.map(x => x.id), ['a', 'b', 'd']);
    // 门槛 A：只有"官方开赛时间"那条能过
    const onlyA = suggestNatureFields(s, ids, { minLevel: 'A' });
    assert.deepEqual(onlyA.map(x => x.id), ['a']);
    assert.deepEqual(onlyA[0].fields, { natureYear: '2024' });
    assert.deepEqual(onlyA[0].levels, { natureYear: 'A' }, '结果里也带逐字段级别');
    // 门槛 B：A + B
    assert.deepEqual(suggestNatureFields(s, ids, { minLevel: 'B' }).map(x => x.id), ['a', 'b']);
    // 门槛 D：A + B + D（D 级"从赛季反推"要 D 门槛才收）
    assert.deepEqual(suggestNatureFields(s, ids, { minLevel: 'D' }).map(x => x.id),
        ['a', 'b', 'd']);
    // 一次都不给 opts ⇒ 与门槛 E 等价（不传门槛的调用方行为不变）
    assert.deepEqual(suggestNatureFields(s, ids).map(x => x.id), ['a', 'b', 'd']);
});

