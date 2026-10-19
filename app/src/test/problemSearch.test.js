// ================================================================
// 题目检索 — 索引与查询测试（纯逻辑）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildProblemIndex, collectFacetOptions, collectAncestorChain } from '../features/ProblemSearch/collect.js';
import { filterProblems, sortProblems, runQuery, matchRecord, SORT_KEYS } from '../features/ProblemSearch/query.js';

// ================================================================
// 假状态：平台 W → 系列 S → 比赛 C → 题目 P
// ================================================================
function node(id, type, extra = {}) {
    return { id, type, name: extra.name || id, ...extra };
}

function makeState() {
    const nodes = {
        root: node('root', 'O', { name: '根' }),
        w1: node('w1', 'W', { name: 'Codeforces' }),
        w2: node('w2', 'W', { name: '牛客' }),
        s1: node('s1', 'S', { name: 'Div2' }),
        s2: node('s2', 'S', { name: '省赛' }),
        c1: node('c1', 'C', { name: 'Round 900' }),
        c2: node('c2', 'C', { name: '2024 省赛' }),
        p1: node('p1', 'P', { name: 'Two Sum', problemId: 'A', cfDifficulty: 800, xcpcDifficulty: '签到', status2: 4, status1: 1, ratio: '90', tags: [{ id: 't1', text: 'dp', color: '红' }] }),
        p2: node('p2', 'P', { name: 'Graph Walk', problemId: 'B', cfDifficulty: 1800, xcpcDifficulty: '银牌', status2: 1, status1: 0, ratio: '10', tags: [{ id: 't2', text: '图论', color: '蓝' }, { id: 't3', text: 'dp', color: '红' }] }),
        p3: node('p3', 'P', { name: 'Hard One', problemId: 'C', cfDifficulty: 2600, xcpcDifficulty: 'C+', status2: 2, status1: 0, ratio: '3', tags: [] }),
        p4: node('p4', 'P', { name: '牛客题', problemId: 'D', cfDifficulty: 0, xcpcDifficulty: '-', status2: 0, status1: 0, ratio: '', tags: [] }),
        r1: node('r1', 'R', { name: '提交' })
    };
    const parentOf = {
        w1: 'root', w2: 'root', s1: 'w1', s2: 'w2',
        c1: 's1', c2: 's2', p1: 'c1', p2: 'c1', p3: 'c2', p4: 'w2', r1: 'p1'
    };
    const childOrder = {};
    for (const id in nodes) childOrder[id] = [];
    for (const id in parentOf) childOrder[parentOf[id]].push(id);
    return { rootId: 'root', nodes, parentOf, childOrder, settings: {} };
}

const state = makeState();
const index = buildProblemIndex(state);
const byId = id => index.find(r => r.id === id);

// ================================================================
// 索引构建
// ================================================================

test('只为 P 节点建索引', () => {
    assert.deepEqual(index.map(r => r.id).sort(), ['p1', 'p2', 'p3', 'p4']);
});

test('解析出平台 / 系列 / 比赛归属', () => {
    const p1 = byId('p1');
    assert.deepEqual(p1.platforms, ['Codeforces']);
    assert.deepEqual(p1.seriesList, ['Div2']);
    assert.equal(p1.contest, 'Round 900');

    const p4 = byId('p4');
    assert.deepEqual(p4.platforms, ['牛客']);
    assert.deepEqual(p4.seriesList, []);
    assert.equal(p4.contest, '');
});

test('path 为根到父的完整祖先名链', () => {
    assert.deepEqual(byId('p1').path, ['根', 'Codeforces', 'Div2', 'Round 900']);
});

test('标签摊平为文本数组', () => {
    assert.deepEqual(byId('p2').tags, ['图论', 'dp']);
    assert.deepEqual(byId('p3').tags, []);
});

test('缺失字段有安全默认值', () => {
    const p = byId('p4');
    assert.equal(p.cfDifficulty, 0);
    assert.equal(p.xcpcDifficulty, '-');
    assert.equal(p.status2, 0);
    assert.equal(p.ratio, '');
});

test('collectAncestorChain 处理断链与空状态', () => {
    assert.deepEqual(collectAncestorChain(state, 'root'), []);
    assert.deepEqual(collectAncestorChain(null, 'p1'), []);
    const broken = { nodes: { p: { id: 'p', type: 'P' } }, parentOf: { p: 'ghost' } };
    assert.deepEqual(collectAncestorChain(broken, 'p'), []);
});

test('collectFacetOptions 汇总可选项并去重', () => {
    const facets = collectFacetOptions(index);

    // 跨语种（汉字 vs 拉丁）的先后由 ICU 的 zh 排序决定，各环境可能不同，
    // 因此这里只钉内容与去重，不钉跨语种顺序。
    const sameSet = (actual, expected) => {
        const norm = arr => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        assert.deepEqual(norm(actual), norm(expected));
    };

    // 每个平台/标签都出现多次，同时验证去重
    sameSet(facets.platforms, ['Codeforces', '牛客']);
    sameSet(facets.series, ['Div2', '省赛']);
    sameSet(facets.tags, ['dp', '图论']);
});

test('collectFacetOptions 结果已排序（同一次调用内稳定）', () => {
    const a = collectFacetOptions(index);
    const b = collectFacetOptions(index);
    assert.deepEqual(a.platforms, b.platforms);
    assert.deepEqual(a.tags, b.tags);
});

// ================================================================
// 筛选
// ================================================================

test('空条件不筛选', () => {
    assert.equal(filterProblems(index, {}).length, 4);
});

test('题号 / 题名：包含匹配且忽略大小写', () => {
    assert.deepEqual(filterProblems(index, { problemId: 'a' }).map(r => r.id), ['p1']);
    assert.deepEqual(filterProblems(index, { name: 'graph' }).map(r => r.id), ['p2']);
    assert.deepEqual(filterProblems(index, { name: '没有这个' }), []);
});

test('标签：命中任一标签即可', () => {
    assert.deepEqual(filterProblems(index, { tag: 'dp' }).map(r => r.id).sort(), ['p1', 'p2']);
    assert.deepEqual(filterProblems(index, { tag: '图论' }).map(r => r.id), ['p2']);
});

test('状态2：多选为 OR', () => {
    assert.deepEqual(filterProblems(index, { status2: [1, 2] }).map(r => r.id).sort(), ['p2', 'p3']);
    assert.deepEqual(filterProblems(index, { status2: [4] }).map(r => r.id), ['p1']);
});

test('平台 / 系列：按归属过滤', () => {
    assert.deepEqual(filterProblems(index, { platforms: ['Codeforces'] }).map(r => r.id).sort(), ['p1', 'p2']);
    assert.deepEqual(filterProblems(index, { seriesList: ['省赛'] }).map(r => r.id), ['p3']);
});

test('比赛：包含匹配', () => {
    assert.deepEqual(filterProblems(index, { contest: 'round' }).map(r => r.id).sort(), ['p1', 'p2']);
});

test('XCPC 档：可筛具体档，也可筛未填写', () => {
    assert.deepEqual(filterProblems(index, { xcpcLevels: ['银牌'] }).map(r => r.id), ['p2']);
    assert.deepEqual(filterProblems(index, { xcpcLevels: ['未填写'] }).map(r => r.id), ['p4']);
    assert.deepEqual(filterProblems(index, { xcpcLevels: ['签到', 'C+'] }).map(r => r.id).sort(), ['p1', 'p3']);
});

test('CF 区间：闭区间，可只给一端', () => {
    assert.deepEqual(filterProblems(index, { cfMin: 800, cfMax: 1800 }).map(r => r.id).sort(), ['p1', 'p2']);
    assert.deepEqual(filterProblems(index, { cfMin: 2000 }).map(r => r.id), ['p3']);
    assert.deepEqual(filterProblems(index, { cfMax: 1000 }).map(r => r.id).sort(), ['p1', 'p4']);
});

test('多条件之间是 AND', () => {
    const got = filterProblems(index, { platforms: ['Codeforces'], status2: [1] }).map(r => r.id);
    assert.deepEqual(got, ['p2']);
});

test('空数组条件表示不筛选，而非全部排除', () => {
    assert.equal(filterProblems(index, { status2: [], xcpcLevels: [], platforms: [] }).length, 4);
});

test('matchRecord 对缺字段记录安全', () => {
    assert.equal(matchRecord({ id: 'x' }, {}), true);
    assert.equal(matchRecord({ id: 'x', tags: [] }, { tag: 'a' }), false);
});

// ================================================================
// 排序
// ================================================================

test('SORT_KEYS 覆盖约定的排序维度', () => {
    assert.deepEqual(SORT_KEYS, ['cf', 'xcpc', 'problemId', 'name', 'status2', 'contest', 'platform']);
});

test('按 CF 难度升序：未填写排在最后', () => {
    assert.deepEqual(sortProblems(index, 'cf', 'asc').map(r => r.id), ['p1', 'p2', 'p3', 'p4']);
});

test('按 CF 难度降序：未填写同样排在最后（不因方向翻转跑到最前）', () => {
    const got = sortProblems(index, 'cf', 'desc').map(r => r.id);
    assert.deepEqual(got, ['p3', 'p2', 'p1', 'p4']);
    assert.equal(got[got.length - 1], 'p4', '未知难度恒在末位');
});

test('按 XCPC 难度升序：档位顺序而非字典序', () => {
    const got = sortProblems(index, 'xcpc', 'asc').map(r => r.id);
    // 签到 < 银牌 < C+ < 未填写
    assert.deepEqual(got, ['p1', 'p2', 'p3', 'p4']);
});

test('按状态2排序', () => {
    assert.deepEqual(sortProblems(index, 'status2', 'asc').map(r => r.id), ['p4', 'p2', 'p3', 'p1']);
});

test('排序保持稳定（同键值不重排）', () => {
    const list = [
        { id: 'x', name: 'same', cfDifficulty: 1000 },
        { id: 'y', name: 'same', cfDifficulty: 1000 },
        { id: 'z', name: 'same', cfDifficulty: 1000 }
    ];
    assert.deepEqual(sortProblems(list, 'name', 'asc').map(r => r.id), ['x', 'y', 'z']);
});

test('排序不修改原数组', () => {
    const before = index.map(r => r.id);
    sortProblems(index, 'cf', 'desc');
    assert.deepEqual(index.map(r => r.id), before);
});

// ================================================================
// 组合
// ================================================================

test('runQuery 先筛选后排序', () => {
    const got = runQuery(index, {
        criteria: { platforms: ['Codeforces'] },
        sortKey: 'cf',
        direction: 'desc'
    }).map(r => r.id);
    assert.deepEqual(got, ['p2', 'p1']);
});

test('runQuery 无参可用', () => {
    assert.equal(runQuery(index).length, 4);
});
