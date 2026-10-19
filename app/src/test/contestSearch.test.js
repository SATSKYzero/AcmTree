// ================================================================
// 比赛检索 — 索引与查询测试（纯逻辑，features/ContestSearch/）
//
// 一级 tab「检索」下的「比赛检索」子页。
// 这里钉三件事：① 只给 C 建索引、归属/题目数算得对；② 各条件的判据（尤其
// **性质按前缀**、**年代的特殊值原样比**）；③ 排序里"没有时间恒垫底"。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContestIndex, collectContestFacets, classPrefixOf, yearFromTime,
         collectAncestorChain, YEAR_SPECIALS } from '../features/ContestSearch/collect.js';
import { matchContest, filterContests, sortContests, runContestQuery, SORT_KEYS }
    from '../features/ContestSearch/query.js';
import { NATURE_NOT_APPLICABLE } from '../core/natureFields.js';
import { getAncestorsRootFirst } from '../core/query/nodes.js';
import { collectAncestorChain as problemCollectAncestorChain } from '../features/ProblemSearch/collect.js';

function node(id, type, extra = {}) {
    return { id, type, name: extra.name || id, ...extra };
}

function makeState() {
    const nodes = {
        root: node('root', 'O', { name: '根' }),
        w1: node('w1', 'W', { name: 'Codeforces' }),
        w2: node('w2', 'W', { name: 'XCPCIO' }),
        s1: node('s1', 'S', { name: 'Div2' }),
        s2: node('s2', 'S', { name: '省赛' }),
        c1: node('c1', 'C', {
            name: 'Round 900', contestTime: '2024-05-01 10:00:00', kind: 'contest',
            natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024',
            natureRegion: '无', link: 'https://codeforces.com/contest/900'
        }),
        c2: node('c2', 'C', {
            name: '2025 浙江省赛', contestTime: '2025-10-02 09:00:00',
            natureClass: 'xcpc/provincial&invitational/official', natureYear: '2025',
            natureSeason: '2025', natureRegion: '浙江'
        }),
        // 上游没给开赛时间、也没标年份（rankland 那批的真实形态）
        c3: node('c3', 'C', {
            name: '没时间的场', natureClass: 'qoj/ucup', natureYear: '无', natureRegion: '无'
        }),
        p1: node('p1', 'P', { name: 'A 题', problemId: 'A' }),
        p2: node('p2', 'P', { name: 'B 题', problemId: 'B' }),
        p3: node('p3', 'P', { name: 'C 题', problemId: 'C' }),
        p4: node('p4', 'P', { name: '省赛题', problemId: 'A' }),
        r1: node('r1', 'R', { name: '提交' })
    };
    const parentOf = {
        w1: 'root', w2: 'root', s1: 'w1', s2: 'w2',
        c1: 's1', c2: 's2', c3: 'w2',
        p1: 'c1', p2: 'c1', p3: 'c1', p4: 'c2', r1: 'p1'
    };
    const childOrder = {};
    for (const id in nodes) childOrder[id] = [];
    for (const id in parentOf) childOrder[parentOf[id]].push(id);
    return { rootId: 'root', nodes, parentOf, childOrder, settings: {} };
}

const state = makeState();
const index = buildContestIndex(state);
const byId = id => index.find(r => r.id === id);

// ================================================================
// 索引构建
// ================================================================

test('只为 C 节点建索引（P / R / W / S 都不进）', () => {
    assert.deepEqual(index.map(r => r.id).sort(), ['c1', 'c2', 'c3']);
    assert.ok(!index.some(r => r.id === 'p1'), '题目不进比赛索引');
    assert.ok(!index.some(r => r.id === 'w1'), '平台不进比赛索引');
});

test('归属与题目数：平台/系列取祖先链，题目数只数 C 下的 P', () => {
    const c1 = byId('c1');
    assert.deepEqual(c1.platforms, ['Codeforces']);
    assert.deepEqual(c1.seriesList, ['Div2']);
    assert.equal(c1.problems, 3, 'c1 下 3 道 P');
    assert.equal(byId('c2').problems, 1, 'c2 下 1 道 P');
    assert.equal(byId('c3').problems, 0, 'c3 下没有 P');
});

test('时间 / 年代 / 性质：`natureYear` 优先，没标才从 contestTime 取头 4 位', () => {
    assert.equal(byId('c1').contestTime, '2024-05-01 10:00:00');
    assert.equal(byId('c1').year, '2024');
    assert.equal(byId('c3').year, '无', '特殊值原样保留（`无` 是结论，不是空缺）');
    assert.equal(yearFromTime('2025-10-02 09:00:00'), '2025');
    assert.equal(yearFromTime(''), '');
    assert.equal(classPrefixOf('cf/contest/div2'), 'cf/contest');
    assert.equal(classPrefixOf('nk/多校'), 'nk/多校');
    assert.equal(classPrefixOf(''), '');
});

test('取值器注入：按查看范围取值（与题目检索同一套路）', () => {
    const scoped = buildContestIndex(state, { value: (n, f) => (f === 'name' ? `[${n.name}]` : n[f]) });
    assert.equal(scoped.find(r => r.id === 'c1').name, '[Round 900]');
});

test('簇选项：年份新的在前、特殊值垫底；性质给的是前两段', () => {
    const facets = collectContestFacets(index);
    assert.deepEqual(facets.years, ['2025', '2024', '无']);
    assert.deepEqual(facets.classPrefixes, ['cf/contest', 'qoj/ucup', 'xcpc/provincial&invitational']);
    assert.deepEqual(facets.kinds, ['contest', '（空）'], '"没值"那个键垫底（噪声别顶到眼前）');
    // 平台/系列的**顺序**没意义（就是芯片排布）⇒ 只比集合；年份/性质/种类那几条才比顺序
    assert.deepEqual([...facets.platforms].sort(), ['Codeforces', 'XCPCIO']);
    assert.deepEqual([...facets.series].sort(), ['Div2', '省赛']);
    // ⚠️ 只断 `YEAR_SPECIALS.includes('无')` 不够 —— 常量自证常量，漏了 `上游异常` 照样绿。
    //    所以这里钉**派生**：词表里每一个"年份：确定不用"的值都必须在里面（含 `上游异常`，
    //    否则它被当真年份，年份芯片里被顶到最前面）。
    const notYear = [...NATURE_NOT_APPLICABLE.natureYear, '（空）'];
    assert.deepEqual(notYear.filter(v => !YEAR_SPECIALS.includes(v)), [],
        'NATURE_NOT_APPLICABLE.natureYear 里每个值都必须在 YEAR_SPECIALS 里');
    assert.ok(YEAR_SPECIALS.includes('上游异常'), '`上游异常` 也是"还没定"那一类');
});

// ================================================================
// 筛选
// ================================================================

test('文本条件：名称 / 时间 / 地区都是包含匹配、不分大小写', () => {
    assert.deepEqual(filterContests(index, { name: '省赛' }).map(r => r.id), ['c2']);
    assert.deepEqual(filterContests(index, { name: 'round' }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { time: '2024-05' }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { region: '浙江' }).map(r => r.id), ['c2']);
    assert.equal(filterContests(index, { name: '  ' }).length, 3, '空白 = 不筛选');
});

test('时间只看数字：包里的 `2026.09.26` 与敲的 `2026-09`（或 `202609`）等价', () => {
    // 实测包里的形状就是点分隔（`2026.09.26 22:35`），人却习惯敲横杠 ⇒ 两边都去掉分隔符再比
    assert.deepEqual(filterContests(index, { time: '2024-05' }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { time: '2024.05' }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { time: '20240501' }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { time: '2025' }).map(r => r.id), ['c2']);
});

test('年代：真年份精确比，特殊值也按原样比（不是数字比较）', () => {
    assert.deepEqual(filterContests(index, { years: ['2025'] }).map(r => r.id), ['c2']);
    assert.deepEqual(filterContests(index, { years: ['无'] }).map(r => r.id), ['c3']);
    assert.equal(filterContests(index, { years: [] }).length, 3, '空数组 = 不筛选');
});

test('性质：按分类路径**前缀**匹配（`cf/contest` 命中 `cf/contest/div2`）', () => {
    assert.deepEqual(filterContests(index, { classPrefixes: ['cf/contest'] }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { classPrefixes: ['xcpc'] }).map(r => r.id), ['c2']);
    assert.equal(filterContests(index, { classPrefixes: ['cf/contest/div2'] }).length, 1,
        '给完整路径也认（等于或前缀命中）');
    assert.equal(filterContests(index, { classPrefixes: ['cf/contest/div1'] }).length, 0,
        '**不许**把 `cf/contest` 当成 `cf/contest/div1` 的前缀命中');
});

test('种类 / 平台 / 系列：多选是"任一命中"', () => {
    assert.deepEqual(filterContests(index, { kinds: ['contest'] }).map(r => r.id), ['c1']);
    assert.deepEqual(filterContests(index, { kinds: ['（空）'] }).map(r => r.id), ['c2', 'c3']);
    assert.deepEqual(filterContests(index, { platforms: ['XCPCIO'] }).map(r => r.id), ['c2', 'c3']);
    assert.deepEqual(filterContests(index, { seriesList: ['Div2'] }).map(r => r.id), ['c1']);
});

test('条件之间是 AND', () => {
    const got = filterContests(index, { platforms: ['XCPCIO'], years: ['2025'] });
    assert.deepEqual(got.map(r => r.id), ['c2']);
    assert.equal(matchContest(byId('c3'), { platforms: ['XCPCIO'], years: ['2025'] }), false);
});

// ================================================================
// 排序
// ================================================================

test('排序：时间倒序（默认）、名称、题目数', () => {
    assert.deepEqual(runContestQuery(index, { sortKey: 'time', direction: 'desc' }).map(r => r.id),
        ['c2', 'c1', 'c3'], '★ 没时间的 c3 恒垫底');
    assert.deepEqual(runContestQuery(index, { sortKey: 'time', direction: 'asc' }).map(r => r.id),
        ['c1', 'c2', 'c3'], '★ 升序时没时间的**仍然**垫底（不来回跳）');
    assert.deepEqual(sortContests(index, 'problems', 'desc').map(r => r.id), ['c1', 'c2', 'c3']);
    assert.deepEqual(sortContests(index, 'name', 'asc').map(r => r.id), ['c2', 'c3', 'c1']);
});

test('排序：年代键给特殊值 0 分 ⇒ 降序时垫底', () => {
    assert.deepEqual(sortContests(index, 'year', 'desc').map(r => r.id), ['c2', 'c1', 'c3']);
});

test('排序稳定：同值时保持原顺序（不随实现摇摆）', () => {
    const list = [
        { id: 'x', problems: 1, contestTime: '2024-01-01 00:00:00' },
        { id: 'y', problems: 1, contestTime: '2024-01-01 00:00:00' },
        { id: 'z', problems: 1, contestTime: '2024-01-01 00:00:00' }
    ];
    assert.deepEqual(sortContests(list, 'problems', 'asc').map(r => r.id), ['x', 'y', 'z']);
});

test('SORT_KEYS 与排序实现一一对应（加键别忘了实现）', () => {
    assert.deepEqual(SORT_KEYS, ['time', 'name', 'year', 'class', 'region', 'problems', 'platform']);
    for (const key of SORT_KEYS) {
        assert.equal(sortContests(index, key, 'asc').length, index.length, `${key} 排得动`);
    }
});

test('祖先链：与题目检索**是同一个函数**（不是"各写一份、碰巧一样"）', () => {
    assert.deepEqual(collectAncestorChain(state, 'c1').map(n => n.id), ['root', 'w1', 's1']);
    assert.deepEqual(collectAncestorChain(state, '不存在'), []);
    // ⚠️ 这条不查行为，查**是不是同一个东西** —— 断言文案说的"同一实现"必须字面为真，
    //    否则下次谁再抄一份、只改一边，两页的"归属"就分叉。
    assert.equal(collectAncestorChain, problemCollectAncestorChain,
        '两处检索的祖先链必须是同一个函数对象（见 core/query/nodes.js）');
    assert.equal(collectAncestorChain, getAncestorsRootFirst, '而且就是 core/query 的那一个');
});
