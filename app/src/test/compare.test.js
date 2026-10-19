// ================================================================
// 多账户对比矩阵测试（core/query/compare.js）
//
// 这个功能的全部意义就是"同一份数据、按 3 个账户各算一份" ——
// 所以测试的重点是：**同一个人过了、另一个人没过时，两个人的格子必须不一样**。
// 如果哪天有人把"范围"写成了摆设，这里会立刻红。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCompareMatrix, rowMatches } from '../core/query/compare.js';
import { collectPStats } from '../core/query/stats.js';
import { MODE_DEDUP } from '../core/query/groupCount.js';
import { createNode } from '../core/model/node.js';

/** 造一棵：根 → 比赛 c1 → 题 p1 / p2；比赛 c2 → 题 p3 */
function makeState() {
    const s = {
        rootId: 'o',
        nodes: {},
        childOrder: {},
        parentOf: {},
        accounts: {
            local: { id: 'local', name: '本机', isLocal: true, children: [], mappings: [] },
            k1: { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] },
            k2: { id: 'k2', name: '小号', children: [], isLocal: false, mappings: [] },
            k3: { id: 'k3', name: '停用的', children: [], isLocal: false, active: false, mappings: [] }
        },
        sources: {},
        trust: { categoryRank: ['manual', 'board', 'script', 'derived'], sources: {}, fieldPrefer: {} }
    };
    const put = (id, type, parentId, extra = {}) => {
        s.nodes[id] = createNode(id, type, extra);
        s.childOrder[id] = s.childOrder[id] || [];
        s.parentOf[id] = parentId;
        if (parentId) s.childOrder[parentId].push(id);
    };
    put('o', 'O', null, { name: '根' });
    put('c1', 'C', 'o', { name: '第一场' });
    put('p1', 'P', 'c1', { name: 'A 题', problemId: 'A' });
    put('p2', 'P', 'c1', { name: 'B 题', problemId: 'B' });
    put('c2', 'C', 'o', { name: '第二场' });
    put('p3', 'P', 'c2', { name: 'C 题', problemId: 'C' });

    // p1：k1 赛时通过（AC 的 R 属于 k1）
    put('r1', 'R', 'p1', { name: '提交1', status: 'AC', time: '2026.09.01 10:00' });
    s.nodes.r1.values = { status: [{ v: 'AC', src: 'qoj:x', at: 'T1', account: 'k1' }] };
    // p2：k2 提交但没过（WA）
    put('r2', 'R', 'p2', { name: '提交2', status: 'WA', time: '2026.09.01 11:00' });
    s.nodes.r2.values = { status: [{ v: 'WA', src: 'qoj:x', at: 'T1', account: 'k2' }] };
    // p3：谁都没有提交（两人都应显示"未使用"）
    return s;
}

test('对比矩阵：同一道题，不同账户的格子必须不同', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k2'] });
    assert.deepEqual(m.accounts.map(a => a.id), ['k1', 'k2'], '列顺序 = 传入顺序');
    assert.deepEqual(m.accounts.map(a => a.name), ['主号', '小号']);

    const c1 = m.groups.find(g => g.id === 'c1');
    assert.equal(c1.problems.length, 2);
    const p1 = c1.problems.find(p => p.id === 'p1');
    const p2 = c1.problems.find(p => p.id === 'p2');

    assert.equal(p1.cells.k1, 3, 'k1 在 p1 上是「赛后补题（通过）」');
    assert.equal(p1.cells.k2, 0, 'k2 在这道题上没有任何提交 → 未使用');
    assert.equal(p2.cells.k2, 2, 'k2 在 p2 上提交过但没过');
    assert.equal(p2.cells.k1, 0, 'k1 没碰过 p2');
});

test('对比矩阵：范围外的人不影响这一列（自己看自己）', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k2'] });
    const p1 = m.groups.find(g => g.id === 'c1').problems.find(p => p.id === 'p1');
    assert.equal(p1.cells.k2, 0, 'k2 看到的是"自己没过"，不会借 k1 的 AC');
});

test('对比矩阵：容器的完成状态也按各自口径算', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k2'] });
    const c1 = m.groups.find(g => g.id === 'c1');
    const c2 = m.groups.find(g => g.id === 'c2');
    assert.equal(c1.cells.k1, 1, 'k1：两题里过了一题 → 有接触');
    assert.equal(c1.cells.k2, 0, 'k2：都没过 → 未动');
    assert.equal(c2.cells.k1, 0, '第二场谁都没动');
    assert.equal(c2.cells.k2, 0);
});

test('对比矩阵：列头汇总（每人通过/处理）', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k2'] });
    assert.deepEqual(m.summary.k1, { total: 3, passed: 1, processed: 0 },
        'k1：3 道题里通过 1 道；「我处理了吗」是登录口径，这里不比');
    assert.deepEqual(m.summary.k2, { total: 3, passed: 0, processed: 0 });
});

test('对比矩阵：不存在的账户与停用的账户被剔除并报出来', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k3', '不存在', 'k2', 'k1'] });
    assert.deepEqual(m.accounts.map(a => a.id), ['k1', 'k2'], '重复的只留一份');
    assert.deepEqual(m.dropped.sort(), ['k3', '不存在'], '停用/不存在都报出来（不静默）');
});

test('对比矩阵：列数上限（防止表格宽到没法看）', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k2'], maxAccounts: 1 });
    assert.deepEqual(m.accounts.map(a => a.id), ['k1']);
    assert.deepEqual(m.dropped, ['k2']);
});

test('对比矩阵：限定子树（只看一场比赛）', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1'], rootId: 'c2' });
    assert.deepEqual(m.groups.map(g => g.id), ['c2'], '只有第二场');
    assert.equal(m.summary.k1.total, 1, '汇总也只算这棵子树');
});

test('对比矩阵：没有账户 / 空 state 不炸', () => {
    assert.deepEqual(buildCompareMatrix(makeState(), { accounts: [] }).accounts, []);
    assert.deepEqual(buildCompareMatrix(null, { accounts: ['k1'] }).groups, []);
});

test('对比矩阵：全局设置是 dedup 时**仍走 plain** —— 两个账户的差异不被组头状态盖掉', () => {
    const s = makeState();
    s.settings = { stats: { countMode: 'dedup' } };
    // c1 下再挂一个 P 合成节点 ps（空壳：没有 R 子节点），把 p1 / p2 归入它。
    // 若对比表跟着全局设置走 dedup，这一组只会算一次、档位取"组那份"
    // （ps + p1 + p2 的缓存字段都是 0）⇒ 对谁都是 0，
    // 两个人的合计一模一样，"谁过了哪道题"的差异被盖掉。所以这里固定 `plain`。
    s.nodes.ps = createNode('ps', 'P', { name: '合成题', synthKey: 'synth:p' });
    s.childOrder.ps = [];
    s.parentOf.ps = 'c1';
    s.childOrder.c1.push('ps');
    s.nodes.p1.ownerSynth = 'synth:p';
    s.nodes.p2.ownerSynth = 'synth:p';

    // （对照）如果跟着设置走 dedup：p1 / p2 被并成一组（+ p3 自己一组），
    // 组那份（ps + p1 + p2 都是 0）⇒ 这一组对谁都是 0，"谁过了 p1"的差异没了。
    assert.deepEqual(collectPStats(s, s.rootId, undefined, { mode: MODE_DEDUP }), {
        total: 2, passed: 0, passedIgnore: 0, processed: 0, processedIgnore: 0
    }, '（对照）dedup 会把 p1 / p2 合成一组、档位取那一组的组那份（这里都是 0）');

    const m = buildCompareMatrix(s, { accounts: ['k1', 'k2'] });
    assert.equal(m.summary.k1.total, 3, 'plain：p1 / p2 / p3 各算一次（ps 的成员在范围内 ⇒ ps 不计）');
    assert.equal(m.summary.k2.total, 3);
    assert.equal(m.summary.k1.passed, 1, 'k1 在 p1 上通过');
    assert.equal(m.summary.k2.passed, 0, 'k2 没过 —— 差异必须保留（不被组头 ps 的 0 盖掉）');
    assert.notDeepEqual(m.summary.k1, m.summary.k2);
});

// ---- 筛选 ----

test('筛选：只看"有人没过"、只看"各人不同"、只看某人没过', () => {
    const m = buildCompareMatrix(makeState(), { accounts: ['k1', 'k2'] });
    const c1 = m.groups.find(g => g.id === 'c1');
    const p1 = c1.problems.find(p => p.id === 'p1');   // k1 过了、k2 没碰
    const p2 = c1.problems.find(p => p.id === 'p2');   // k2 没过、k1 没碰
    const cols = ['k1', 'k2'];

    assert.equal(rowMatches(p1, { accounts: cols, only: 'undone' }), true, '有人没过 → 显示');
    assert.equal(rowMatches(p1, { accounts: cols, only: 'diff' }), true, '一人过一人没过 → 差异');
    assert.equal(rowMatches(p1, { accounts: cols, only: 'k2' }), true, 'k2 没过 → 显示');
    assert.equal(rowMatches(p1, { accounts: cols, only: 'k1' }), false, 'k1 过了 → 不显示');
    assert.equal(rowMatches(p2, { accounts: cols, only: 'k1' }), true);
    assert.equal(rowMatches(p2, { accounts: cols, only: 'k2' }), true);

    // 两人都过了 → 不算"有人没过"，也不算差异
    const both = { problemId: 'X', name: '都过', cells: { k1: 3, k2: 4 } };
    assert.equal(rowMatches(both, { accounts: cols, only: 'undone' }), false);
    assert.equal(rowMatches(both, { accounts: cols, only: 'diff' }), false);
    // 被忽略（5）不算"没过"
    const ignored = { problemId: 'Y', name: '忽略', cells: { k1: 5, k2: 4 } };
    assert.equal(rowMatches(ignored, { accounts: cols, only: 'undone' }), false, '忽略 = 用户按下的"别算它"');
});

test('筛选：搜索匹配题号与名称', () => {
    const row = { problemId: 'B2', name: 'Two Sum', cells: {} };
    assert.equal(rowMatches(row, { accounts: [], search: 'b2' }), true, '不区分大小写');
    assert.equal(rowMatches(row, { accounts: [], search: 'sum' }), true);
    assert.equal(rowMatches(row, { accounts: [], search: 'nope' }), false);
});

// ================================================================
// 源码级守卫：表格的行事件**只许重画表格**，不许调整个面板的渲染器
//
// 真实踩过的坑（用户 2026-10-13 截图）：`renderTable` 的组头 click 写的是
// `renderAccountCompare(host)` —— 而那里的 `host` 是 `#compare-table-host`（**表格那一格**），
// 不是面板 ⇒ 每点一次「展开/收起」，整条控制条（"👥 对比谁" + 筛选 + 汇总）就**再画进表格格子里**一份。
// 症状 = "账户对比头渲染多个，每点击一次折叠就多一个"。
//
// 为什么只能这样守：`scripts/smoke/dom.mjs` **不解析 `innerHTML`** ⇒ `querySelectorAll('.compare-group')`
// 在桩里恒空、click 永远绑不上，行为断言写不出来。
// ================================================================
test('★ 源码守卫：renderTable 里不许调 renderAccountCompare（面板渲染器）', () => {
    const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const src = fs.readFileSync(path.join(REPO, 'src', 'ui', 'stats', 'compare.js'), 'utf8');

    const start = src.indexOf('function renderTable(');
    assert.notEqual(start, -1, 'renderTable 还在吗？（找不到就该更新这条守卫）');
    // 取到下一个顶层 function 为止（bindEvents 排在它后面）
    const end = src.indexOf('\nfunction ', start);
    const body = src.slice(start, end === -1 ? undefined : end);

    assert.equal(
        /renderAccountCompare\s*\(/.test(body), false,
        'renderTable 里调了 renderAccountCompare —— 那会把整条控制条画进表格格子里（折叠一次多一份）'
    );
});
