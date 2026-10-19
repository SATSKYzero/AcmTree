// ================================================================
// 比赛补题概览 — 数据收集与渲染测试（纯逻辑，无 DOM）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectContests, flattenProblems } from '../features/ContestOverview/collect.js';
import { buildOverviewHTML, isSpecialProblem } from '../features/ContestOverview/render.js';
import { SPECIAL_BAND_W } from '../features/ContestOverview/constants.js';

// ================================================================
// 测试用假状态
// ================================================================

function node(id, type, extra = {}) {
    return { id, type, name: extra.name || id, ...extra };
}

/**
 * 构造一棵：
 * root(O) → contest1(C) → p1,p2(P)
 *          → contest2(C) → p3(P)
 *          → contest3(C)（无 P，应被忽略）
 *          → p4(P)（直接挂在 root 下，不属于任何比赛）
 */
function makeState() {
    const nodes = {
        root: node('root', 'O', { name: '根' }),
        c1: node('c1', 'C', { name: '比赛一' }),
        c2: node('c2', 'C', { name: '比赛二' }),
        c3: node('c3', 'C', { name: '空比赛' }),
        p1: node('p1', 'P', { name: 'P1', problemId: 'A', status2: 4, status1: 1, xcpcDifficulty: '签到', ratio: '90', cfDifficulty: 800 }),
        p2: node('p2', 'P', { name: 'P2', problemId: 'B', status2: 2, status1: 0, xcpcDifficulty: 'C+', ratio: '5', cfDifficulty: 2400 }),
        p3: node('p3', 'P', { name: 'P3', problemId: 'C', status2: 0, status1: 0, xcpcDifficulty: '-', ratio: '', cfDifficulty: 0 }),
        p4: node('p4', 'P', { name: 'P4', problemId: 'D', status2: 3, xcpcDifficulty: '铁牌', ratio: '50', cfDifficulty: 1500 })
    };
    const childOrder = {
        root: ['c1', 'c2', 'c3', 'p4'],
        c1: ['p1', 'p2'],
        c2: ['p3'],
        c3: [],
        p1: [], p2: [], p3: [], p4: []
    };
    return { rootId: 'root', nodes, childOrder, parentOf: {}, settings: { stats: {} } };
}

// ================================================================
// collectContests
// ================================================================

test('以 C 节点为单位收集，忽略不含 P 的比赛', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    assert.deepEqual(contests.map(c => c.id), ['c1', 'c2']);
    assert.deepEqual(contests[0].problems.map(p => p.id), ['p1', 'p2']);
    assert.deepEqual(contests[1].problems.map(p => p.id), ['p3']);
});

test('直接挂在节点下的 P（不属于任何比赛）不出现在结果里', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const flat = flattenProblems(contests).map(p => p.id);
    assert.equal(flat.includes('p4'), false);
});

test('当前节点本身就是 C 时，该比赛作为一行出现', () => {
    const state = makeState();
    const contests = collectContests(state, 'c1');
    assert.deepEqual(contests.map(c => c.id), ['c1']);
});

test('当前节点是 P / R 时返回空', () => {
    const state = makeState();
    assert.deepEqual(collectContests(state, 'p1'), []);
    assert.deepEqual(collectContests(state, 'missing'), []);
    assert.deepEqual(collectContests(null, 'root'), []);
});

test('记录每个比赛的全部题目数（供名称栏计数用）', () => {
    const state = makeState();
    const [c1] = collectContests(state, 'root');
    assert.equal(c1.totalProblems, 2);
});

// ================================================================
// isSpecialProblem
// ================================================================

test('isSpecialProblem 识别未填写 / 其他（<800）', () => {
    assert.equal(isSpecialProblem({ xcpcDifficulty: '-' }, 'xcpc'), true);
    assert.equal(isSpecialProblem({}, 'xcpc'), true);
    assert.equal(isSpecialProblem({ xcpcDifficulty: '签到' }, 'xcpc'), false);

    assert.equal(isSpecialProblem({ cfDifficulty: 0 }, 'cf'), true);
    assert.equal(isSpecialProblem({ cfDifficulty: 799 }, 'cf'), true);
    assert.equal(isSpecialProblem({ cfDifficulty: 800 }, 'cf'), false);
});

// ================================================================
// buildOverviewHTML
// ================================================================

test('没有比赛时给出空态', () => {
    const html = buildOverviewHTML({ contests: [], chartType: 'xcpc', showSpecial: true });
    assert.match(html, /没有含题目的比赛/);
});

test('渲染出每个比赛一行，并带比赛名', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });

    assert.match(html, /比赛一/);
    assert.match(html, /比赛二/);
    // 每行一个 .co-row
    assert.equal((html.match(/class="co-row"/g) || []).length, 2);
});

test('每题一个点，点下方有题号', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });

    // c1 两题 + c2 一题
    assert.equal((html.match(/class="co-dot"/g) || []).length, 3);
    assert.equal((html.match(/class="co-pid"/g) || []).length, 3);
    assert.match(html, />A</);
    assert.match(html, />B</);
    assert.match(html, />C</);
});

test('点按 status2 着色', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    // p1 status2=4 → #00db00；p2 status2=2 → #fed7aa
    assert.match(html, /background:#00db00/);
    assert.match(html, /background:#fed7aa/);
});

test('status1=1 的点加橙色外圈', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.match(html, /box-shadow:0 0 0 2px #f97316/);
});

test('竖向难度带：XCPC 20 档 + 特殊带', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    // 20 个难度带 + 1 个特殊带
    assert.equal((html.match(/class="co-band"/g) || []).length, 21);
});

test('竖向难度带：CF 档位数少于 XCPC', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'cf', showSpecial: true });
    assert.equal((html.match(/class="co-band"/g) || []).length, 9);  // 8 档 + 特殊带
});

test('每行都有居中横线', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.equal((html.match(/class="co-line"/g) || []).length, 2);
});

test('showSpecial=false 时隐藏未填写题；整行被滤空则隐藏该比赛', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');

    const hidden = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: false });
    // c2 只有一道未填写题 → 整行消失
    assert.equal((hidden.match(/class="co-row"/g) || []).length, 1);
    assert.doesNotMatch(hidden, /比赛二/);

    const shown = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.equal((shown.match(/class="co-row"/g) || []).length, 2);
});

test('异常态：未填写题的横坐标落在特殊带内（未填写题靠最左）', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    // 特殊带中心 = SPECIAL_BAND_W/2 = 4%
    const center = ((SPECIAL_BAND_W / 2) * 100).toFixed(3);
    assert.match(html, new RegExp(`left:${center}%`));
});

test('特殊带标签随难度类型变化（xcpc=未填写 / cf=其他（<800））', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');

    const xcpc = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.match(xcpc, /未填写/);

    const cf = buildOverviewHTML({ contests, chartType: 'cf', showSpecial: true });
    assert.match(cf, /其他（&lt;800）|其他（<800）/);
});

test('showSpecial=false 时特殊带不显示标签', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: false });
    assert.doesNotMatch(html, /未填写/);
});

test('比赛名与题号做 HTML 转义（防注入）', () => {
    const state = makeState();
    const contests = [{
        id: 'x',
        name: '<img src=x onerror=alert(1)>',
        problems: [{ id: 'p', problemId: '"><script>', status2: 1, status1: 0, xcpcDifficulty: '签到', ratio: '90' }],
        totalProblems: 1
    }];
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;img/);
    assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('所有题都被过滤时给出条件空态', () => {
    const html = buildOverviewHTML({
        contests: [{ id: 'c', name: '仅未填写', problems: [{ problemId: 'A', xcpcDifficulty: '-' }], totalProblems: 1 }],
        chartType: 'xcpc',
        showSpecial: false
    });
    assert.match(html, /没有可展示的题目/);
});

// ================================================================
// ★ 跳转 / 详情的接线（G4）：靠 `data-reveal-node` 属性 + `ui/` 那条**文档级**委托
//
// 本模块只出 HTML、不碰 DOM ⇒ 接线只能落在属性上（`index.js` 注入解析函数）。
// 判据两条：
//   · **解析出主树节点的 ⇒ 点与题号都带 `data-reveal-node`**（点 11px，题号也一起带上，
//     点中面积才够大）；
//   · **解析不出的 ⇒ 一个入口都不画**（副页页内 id / 已删节点 —— 假链接比纯文本更糟）。
// ================================================================

test('★ 跳转接线：解析出的节点带 `data-reveal-node`（点 + 题号 + 比赛名），解析不出的一个都不带', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    // 模拟宿主那个解析函数：p2「解析不出」（副页根节点 / 节点已删），其余解析成主树 id
    const jumpId = (id) => (id === 'p2' ? '' : `m_${id}`);
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true, jumpId });

    assert.equal((html.match(/data-reveal-node="m_p1"/g) || []).length, 2,
        'p1 的**点与题号**都带（`class="co-dot"` 只有 11px，题号一起带上才点得着）');
    assert.equal((html.match(/data-reveal-node="m_p3"/g) || []).length, 2, '另一行的题也一样');
    assert.doesNotMatch(html, /data-reveal-node="[^"]*p2/, '★ 解析不出的 p2 **一个入口都不给**');
    assert.doesNotMatch(html, /data-id="[^"]*p2/, '★ p2 也不给 📋（同一条判据）');
    assert.match(html, /data-reveal-node="m_c1"/, '比赛名那一截指向这场比赛（解析后的 id）');
    assert.match(html, /class="btn-icon btn-node-info co-node-info" data-id="m_c1"/,
        '比赛名那一行的 📋 用的是**解析后**的主树 id（不是页内 id）');

    // 全都解析不出 ⇒ 点/题号上一个入口、一个 `cursor:pointer` 都不许有（别装成能点）
    const none = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true, jumpId: () => '' });
    assert.doesNotMatch(none, /data-reveal-node/);
    for (const tag of none.match(/<div class="co-(?:dot|pid)"[^>]*>/g) || []) {
        assert.doesNotMatch(tag, /cursor:pointer/, '解析不出的点 / 题号别装成能点');
    }
});

test('★ 不传 `jumpId` ⇒ 一个跳转 / 详情入口都不画（纯渲染自检、没接的宿主不许凭空长按钮）', () => {
    const state = makeState();
    const contests = collectContests(state, 'root');
    const html = buildOverviewHTML({ contests, chartType: 'xcpc', showSpecial: true });
    assert.doesNotMatch(html, /data-reveal-node/, '没有解析函数就没有 data-reveal-node');
    assert.doesNotMatch(html, /btn-node-info/, '也没有 📋');
});

