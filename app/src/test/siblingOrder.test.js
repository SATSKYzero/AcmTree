// ================================================================
// 同层排序的单测（core/siblingOrder.js）
//
// 规则：各处的同层节点时间顺序**越新的越靠上为宜**
// （顺序容易在补充节点时被破坏）—— 这里把那条规则钉死。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timeKey, yearKey, isYearLayer, compareSiblings, shouldOrder, orderedIds,
         orderChildren, treeOrder, isWarmupLayer, isFinalsLayer } from '../core/siblingOrder.js';

// ================================================================
// 基本换算
// ================================================================
test('时间键：两种写法都归成纯数字（包里有 `2026.09.26` 与 `2024-05-01` 两种）', () => {
    assert.equal(timeKey('2026.09.26 22:35'), '202609262235');
    assert.equal(timeKey('2024-05-01 10:00:00'), '20240501100000');
    assert.equal(timeKey(''), '');
    assert.equal(timeKey(undefined), '');
});

test('年份键：只有 `20xx` 是年份，特殊值一律 -1（垫底）', () => {
    assert.equal(yearKey('2024'), 2024);
    assert.equal(yearKey('无'), -1);
    assert.equal(yearKey('待同步'), -1);
    assert.equal(yearKey(''), -1);
});

test('年份层：`2026` / `年份未知` 算，别的（`cat-21`）不算', () => {
    assert.equal(isYearLayer('2026'), true);
    assert.equal(isYearLayer('年份未知'), true);
    assert.equal(isYearLayer('cat-2:cat-17'), false);
    assert.equal(isYearLayer(''), false);
});

// ================================================================
// 规则
// ================================================================
const C = (id, contestTime, natureYear = '', name = '') => ({ id, type: 'C', contestTime, natureYear, name });

test('比赛：时间倒序；没有时间的垫底（升序降序都一样）', () => {
    const list = [C('a', '2024-05-01 10:00:00'), C('b', ''), C('c', '2026.09.26 22:35')];
    assert.deepEqual(orderedIds(list).order, ['c', 'a', 'b']);
});

test('比赛：时间相同时按年份、再按名字（稳定，不随输入顺序摇摆）', () => {
    const list = [C('x', '2024-05-01 10:00:00', '2024', 'B 场'), C('y', '2024-05-01 10:00:00', '2024', 'A 场')];
    assert.deepEqual(orderedIds(list).order, ['y', 'x']);
    assert.deepEqual(orderedIds([...list].reverse()).order, ['y', 'x'], '反过来喂也一样');
});

test('提交（R）：按提交时间倒序', () => {
    const list = [
        { id: 'r1', type: 'R', time: '2026.01.01 10:00' },
        { id: 'r2', type: 'R', time: '2026.03.01 10:00' },
        { id: 'r3', type: 'R', time: '' }
    ];
    assert.deepEqual(orderedIds(list).order, ['r2', 'r1', 'r3']);
});

test('年份层 S：年份倒序、`年份未知` 垫底；非年份层（cat-*）不排', () => {
    const years = [{ id: 's2024', type: 'S', name: '2024' }, { id: 's2026', type: 'S', name: '2026' },
        { id: 'sunk', type: 'S', name: '年份未知' }];
    assert.deepEqual(orderedIds(years).order, ['s2026', 's2024', 'sunk']);
    const cats = [{ id: 'c1', type: 'S', name: 'Asia East Continent' }, { id: 'c0', type: 'S', name: 'ICPC' }];
    assert.deepEqual(orderedIds(cats).order, ['c1', 'c0'], '来源自带的分类层保持原样');
});

test('★ P（题）：**按题号升序**', () => {
    // 来由：题目的顺序一直沿用**包里的记录顺序**，而那是各来源自己的排列 ——
    // 实测 `2026 北京市赛` 出来是 `D K J F E L B H C I G A`。题号就是题目的身份，
    // 与"比赛按开赛时间、提交按提交时间"同一个道理 ⇒ 归 `siblingOrder` 这一份判据管。
    const ps = [
        { id: 'pB', type: 'P', name: 'B', problemId: 'B' },
        { id: 'pA', type: 'P', name: 'A', problemId: 'A' }
    ];
    assert.equal(shouldOrder(ps), true, '全是 P ⇒ 要排');
    assert.deepEqual(orderedIds(ps).order, ['pA', 'pB'], 'A 在前');
    // 那 12 个真实顺序：按题号排完必须是 A…L
    const scrambled = 'D K J F E L B H C I G A'.split(' ')
        .map((id) => ({ id: 'x' + id, type: 'P', problemId: id }));
    assert.deepEqual(orderedIds(scrambled).order.map((id) => id.slice(1)),
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'],
        '★ 北京那 12 个题号排完就是 A…L');
});

test('P 的题号比较：字母按字母序、数字按**数值**、空题号垫底、同号保持原序', () => {
    const got = (pids) => orderedIds(pids.map((p, i) => ({ id: 'n' + i, type: 'P', problemId: p }))).order;
    // 字母：就是字母序（`A` < `AA` < `Z`；真实比赛题号到不了 27 题，这条只是把口径写死）
    assert.deepEqual(got(['AA', 'Z', 'A']), ['n2', 'n0', 'n1'], '字母序（A < AA < Z）');
    assert.deepEqual(got(['A10', 'A2']), ['n1', 'n0'], '同前缀带数字 ⇒ 按数值（A2 < A10）');
    assert.deepEqual(got(['10', '9', '2']), ['n2', 'n1', 'n0'], '数字题号按数值：2 < 9 < 10（不是字符串序）');
    assert.deepEqual(got(['', 'B', '']), ['n1', 'n0', 'n2'], '空题号垫底（没填 = 认不出身份）');
    assert.deepEqual(got(['A', 'A']), ['n0', 'n1'], '题号打平 ⇒ 保持原顺序（稳定）');
});

test('混合类型：**一个字都不动**（不猜）', () => {
    const mixed = [{ id: 'c1', type: 'C', contestTime: '2024-01-01' }, { id: 's1', type: 'S', name: '2024' }];
    assert.equal(shouldOrder(mixed), false, '混合类型不猜');
    const cp = [{ id: 'c1', type: 'C' }, { id: 'p1', type: 'P', problemId: 'A' }];
    assert.equal(shouldOrder(cp), false, 'C 里混着 P（不是全 P）⇒ 也不猜');
});

// ================================================================
// 就地重排（应用侧用）
// ================================================================
test('orderChildren：只动该动的容器，认不出的 id 一个不丢', () => {
    const draft = {
        nodes: {
            root: { id: 'root', type: 'O' },
            c1: C('c1', '2024-05-01 10:00:00', '2024', '旧场'),
            c2: C('c2', '2026.09.26 22:35', '2026', '新场'),
            p1: { id: 'p1', type: 'P', name: 'A', problemId: 'A' },
            p2: { id: 'p2', type: 'P', name: 'B', problemId: 'B' }
        },
        childOrder: { root: ['c1', 'c2', '幽灵节点'], c1: ['p2', 'p1'], c2: [] }
    };
    const res = orderChildren(draft);
    assert.deepEqual(draft.childOrder.root, ['c2', 'c1', '幽灵节点'], '★ 新场排到前面；查不到的 id 留在原位（没丢）');
    assert.deepEqual(draft.childOrder.c1, ['p1', 'p2'], '★ P 也按题号排（见上面那条的来由）');
    assert.equal(res.moved, 2, 'root 与 c1 两处都动了');
});

test('orderChildren：已经是好的顺序 ⇒ changed=false（幂等，不制造无谓改动）', () => {
    const draft = {
        nodes: { r: { id: 'r', type: 'O' }, a: C('a', '2026.01.01 00:00', '2026'), b: C('b', '2025.01.01 00:00', '2025') },
        childOrder: { r: ['a', 'b'] }
    };
    assert.equal(orderChildren(draft).moved, 0);
    assert.deepEqual(draft.childOrder.r, ['a', 'b']);
});

test('orderChildren：**人排过的容器**（`manualOrder`）不许被重排', () => {
    // 来由：手排（题目排序对话框 / 上移下移）写的是 `childOrder`，而导入后这里一律按规范序重排
    // ⇒ 手动顺序**下一次导入就被冲掉**。`manualOrder = true` 的容器跳过。
    const draft = {
        nodes: {
            r: { id: 'r', type: 'O' },
            c1: C('c1', '2024-05-01 10:00:00', '2024', '旧场'),
            c2: C('c2', '2026.09.26 22:35', '2026', '新场'),
            locked: C('locked', '2023.01.01 00:00', '2023', '人排过'),
            p1: { id: 'p1', type: 'P', problemId: 'A' },
            p2: { id: 'p2', type: 'P', problemId: 'B' }
        },
        childOrder: { r: ['c1', 'c2'], locked: ['p2', 'p1'] }
    };
    draft.nodes.locked.manualOrder = true;
    orderChildren(draft);
    assert.deepEqual(draft.childOrder.r, ['c2', 'c1'], '没标记的照规范序排（新场在前）');
    assert.deepEqual(draft.childOrder.locked, ['p2', 'p1'], '★ 标记过的：手动顺序原样留着');
});

// ================================================================
// ★ 41p：两种"位置固定"的层 —— 热身赛垫底、Finals 置顶
//   （热身赛放赛季的最后 / Finals 放 Europe 系列的顶部）
// ================================================================
test('热身赛层 / Finals 层：按层名与键尾都认得出', () => {
    assert.equal(isWarmupLayer({ type: 'S', name: '热身赛', id: 'x:2024:warm-up' }), true);
    assert.equal(isWarmupLayer({ type: 'S', name: '?', id: 'qoj:s:a:2024:warm-up' }), true);
    assert.equal(isWarmupLayer({ type: 'C', name: '热身赛' }), false, 'C 不算层');
    assert.equal(isWarmupLayer({ type: 'S', name: '2024' }), false);
    assert.equal(isFinalsLayer({ type: 'S', name: 'Finals', id: 'qoj:s:a:finals' }), true);
    assert.equal(isFinalsLayer({ type: 'S', name: '别 F 的重名', id: 'qoj:s:a:finals' }), true, '键尾也算');
    assert.equal(isFinalsLayer({ type: 'S', name: 'Central Europe' }), false);
});

test('赛季层里：比赛按时间、热身赛垫底、Finals 置顶', () => {
    const nodes = [
        { id: 'w', type: 'S', name: '热身赛' },
        { id: 'old', type: 'C', contestTime: '2024.05.01 09:00' },
        { id: 'f', type: 'S', name: 'Finals' },
        { id: 'new', type: 'C', contestTime: '2025.11.03 09:20' }
    ];
    assert.equal(shouldOrder(nodes), true, '混着固定位层的组也要排');
    assert.deepEqual(orderedIds(nodes).order, ['f', 'new', 'old', 'w'],
        '★ Finals 最前 → 比赛时间倒序 → 热身赛最后');
    assert.equal(shouldOrder([{ id: 'w', type: 'S', name: '热身赛' }, { id: 'p', type: 'P', name: 'A' }]), false,
        '★ 混着 P（题）就不碰（题号顺序要保住）');
});

test('全是 S 的组里若有 Finals ⇒ 也排，且其余保持原顺序', () => {
    const nodes = [
        { id: 'eu:cat-28', type: 'S', name: 'Central Europe' },
        { id: 'eu:cat-27', type: 'S', name: 'Northwestern Europe' },
        { id: 'eu:finals', type: 'S', name: 'Finals' }
    ];
    assert.equal(shouldOrder(nodes), true);
    assert.deepEqual(orderedIds(nodes).order, ['eu:finals', 'eu:cat-28', 'eu:cat-27'],
        '★ Finals 置顶；没有规则可言的兄弟**保持原顺序**（不按 id 重排）');
    const plain = [{ id: 'b:cat-2', type: 'S', name: 'B' }, { id: 'a:cat-1', type: 'S', name: 'A' }];
    assert.equal(shouldOrder(plain), false, '没有 Finals / 年份层 ⇒ 一个字都不动');
    assert.deepEqual(orderedIds(plain).order, ['b:cat-2', 'a:cat-1']);
});

// ================================================================
// 产包侧的整表重排（crate-merge 用）
// ================================================================
test('treeOrder：父在前、子按规则；父不在本包里的留在最后（不猜不丢）', () => {
    const recs = [
        { extKey: 'c1', 节点类型: 'C', parentExtKey: 's1', contestTime: '2024-01-01 00:00:00' },
        { extKey: 's1', 节点类型: 'S', parentExtKey: 'w1', name: 'x' },
        { extKey: 'c2', 节点类型: 'C', parentExtKey: 's1', contestTime: '2026-01-01 00:00:00' },
        { extKey: '孤儿', 节点类型: 'P', parentExtKey: '不在包里', problemId: 'A' },
        { extKey: 'p1', 节点类型: 'P', parentExtKey: 'c1', problemId: 'A' },
        { extKey: 'p2', 节点类型: 'P', parentExtKey: 'c1', problemId: 'B' }
    ];
    const out = treeOrder(recs, { keyOf: (r) => r.extKey, parentOf: (r) => r.parentExtKey });
    assert.deepEqual(out.map((r) => r.extKey), ['s1', 'c2', 'c1', 'p1', 'p2', '孤儿'],
        '★ 新场 c2 在旧场 c1 前；父 s1 在子之前；P 保持原序；孤儿在最后');
    assert.equal(out.length, recs.length, '一条不多一条不少');
});

test('treeOrder：成环 / 重复身份也不丢记录', () => {
    const recs = [
        { extKey: 'a', 节点类型: 'S', parentExtKey: 'b', name: '2024' },
        { extKey: 'b', 节点类型: 'S', parentExtKey: 'a', name: '2023' }
    ];
    const out = treeOrder(recs, { keyOf: (r) => r.extKey, parentOf: (r) => r.parentExtKey });
    assert.equal(out.length, 2, '成环也一条不丢');
});

// ================================================================
// ★ 产包侧真正的输入形状：**条目**（`{record, file, fieldSrc}`）
//
// 这一条钉的是：`treeOrder` 若只认"记录本身就是节点形状"，
// 而 crate-merge 传的是条目 —— 于是 `type` 读到空串、`shouldOrder` 一律 false，
// **重排静默失效**（包照产不误，顺序一个都没动，看日志还一切正常）。
// 所以这里必须钉死"条目 + nodeOf"这条路真的会排。
// ================================================================
test('treeOrder：条目形状（crate-merge 的输入）+ nodeOf ⇒ 真的会排序', () => {
    const entry = (key, type, parent, fields) =>
        ({ record: { extKey: key, type, parentExtKey: parent, fields }, file: 'f.json' });
    const recs = [
        entry('c1', 'C', 's1', { name: '旧场', contestTime: '2024-01-01 00:00:00' }),
        entry('s1', 'S', 'w1', { name: 'xcpc' }),
        entry('c2', 'C', 's1', { name: '新场', contestTime: '2026-01-01 00:00:00' })
    ];
    const out = treeOrder(recs, {
        keyOf: (e) => e.record.extKey || e.record.synthKey || '',
        parentOf: (e) => e.record.parentExtKey || e.record.parentSynthKey || '',
        nodeOf: (e) => {
            const f = (e.record && e.record.fields) || {};
            return { type: e.record.type, name: f.name, contestTime: f.contestTime,
                     time: f.time, natureYear: f.natureYear };
        }
    });
    assert.deepEqual(out.map((e) => e.record.extKey), ['s1', 'c2', 'c1'],
        '★ 新场排在旧场前 —— 少了 nodeOf 这条会原样输出 [c1, s1, c2]，等于没排');
});
