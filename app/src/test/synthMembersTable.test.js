// ================================================================
// 合成节点**成员表**（core/ops/synth.js 的 `synthMembersTable`）
//
// 要有这张表的原因：XCPC 那块会有**几百个合成节点**，而
// `synthMembers(state, key)` 每调一次就是一趟全树 DFS —— 渲染时"每个合成节点各调一次"
// 就是 O(#合成 × N)，几百 × 两万 = 几千万次访问，不可接受。
//
// 本文件钉四件事：
//   ① **树序正确**：表里每一组与 `synthMembers(state, key)` **逐元素相等**
//      （fixture 刻意让"对象插入序 ≠ 树序"）；
//   ② **口径一致**：只收"从根走得到"的节点；悬空标识不是键；空组也是空数组；
//      批量算出的 `synthMembers` 与逐键单查逐元素相同（含两万节点的深链不爆栈）；
//   ③ **只做一趟遍历**（用计数桩包 `childOrder` 的读取：访问次数 == 节点数，
//      且**不随合成节点数变化** —— 500 组与 1000 组给出同一个数字）；
//   ④ **性能回归锚**：500 个合成节点 + 两万节点，建一次表 + 取全部成员 < 200ms。
//
// 依赖：core/ops/synth.js（可进纯 Node 单测）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthMembers, synthMembersTable, synthIndex } from '../core/ops/synth.js';

// ================================================================
// 构造器：**插入序**与**树序**刻意不同（见 `makeSmallState` 的注释）
// ================================================================

/** 造一棵结构上"讲得通"的小树（类型链不重要，synth.js 只看 `childOrder` / `parentOf`） */
function makeSmallState() {
    const nodes = {};
    const childOrder = {};
    const parentOf = {};
    const add = (id, type, parent, extra = {}) => {
        nodes[id] = { id, type, name: id, ownerSynth: '', synthKey: '', ...extra };
        childOrder[id] = childOrder[id] || [];
        if (parent === null) { parentOf[id] = null; return nodes[id]; }
        childOrder[parent] = childOrder[parent] || [];
        childOrder[parent].push(id);
        parentOf[id] = parent;
        return nodes[id];
    };

    add('o', 'O', null);
    add('w', 'W', 'o');
    add('s', 'S', 'w');
    add('cA', 'C', 's');
    add('cB', 'C', 's');
    // 两个合成节点：k:P 有 3 个成员、k:C 一个都没有（空组）
    add('synP', 'P', 'cA', { synthKey: 'k:P' });
    add('synC', 'C', 's', { synthKey: 'k:C' });
    // ⚠️ 插入序：p3 在 p1 / p2 **之前**；树序：cA 下的 p1、p2 在 cB 下的 p3 **之前**
    add('p3', 'P', 'cB', { ownerSynth: 'k:P' });
    add('p1', 'P', 'cA', { ownerSynth: 'k:P' });
    add('p2', 'P', 'cA', { ownerSynth: 'k:P' });
    // 悬空指针：指向一个不存在的标识（它不是表的键 —— 与"组"的定义一致）
    add('x1', 'P', 'cB', { ownerSynth: 'k:missing' });
    // 不在任何 childOrder 上（从根走不到）⇒ 两边都不该收它
    add('orphan', 'P', null, { ownerSynth: 'k:P' });
    // 自指（数据坏了）：合成节点自己也有 ownerSynth —— 如实陈列，不静默丢
    add('weird', 'P', 'cB', { synthKey: 'k:SELF', ownerSynth: 'k:SELF' });

    return { rootId: 'o', nodes, childOrder, parentOf };
}

/**
 * 大 fixture：**K 个合成节点 + 约两万节点**，每个合成节点分到一批成员
 * （形状刻意接近 XCPC：W/S/C 是骨头，P 是叶子，合成节点与成员都在叶子层）。
 */
function makeBigState(synthCount) {
    const nodes = {};
    const childOrder = {};
    const parentOf = {};
    const add = (id, type, parent, extra = {}) => {
        nodes[id] = { id, type, name: id, ownerSynth: '', synthKey: '', ...extra };
        childOrder[id] = [];
        if (parent === null) { parentOf[id] = null; return; }
        childOrder[parent].push(id);
        parentOf[id] = parent;
    };

    add('o', 'O', null);
    const W = 50;
    const C = 100;
    const P = 3;
    for (let i = 0; i < W; i++) add('w' + i, 'W', 'o');
    let pIndex = 0;
    for (let i = 0; i < W; i++) {
        for (let j = 0; j < C; j++) {
            const cid = `c${i}_${j}`;
            add(cid, 'C', 'w' + i);
            for (let k = 0; k < P; k++) {
                // 每 synthCount 个叶子挑一个当合成节点，其余全部挂到某个合成节点下面
                const idx = pIndex++;
                const isSynth = idx % Math.ceil((W * C * P) / synthCount) === 0;
                const sid = `p${idx}`;
                if (isSynth) add(sid, 'P', cid, { synthKey: 'k:' + idx });
                else add(sid, 'P', cid, { ownerSynth: 'k:' + (Math.floor(idx / Math.ceil((W * C * P) / synthCount)) * Math.ceil((W * C * P) / synthCount)) });
            }
        }
    }
    return { rootId: 'o', nodes, childOrder, parentOf };
}

/** 把 `childOrder` 包成计数桩：每一次 `childOrder[id]` 读取都记一笔 */
function withCountingChildOrder(state) {
    const counter = { get: 0 };
    state.childOrder = new Proxy(state.childOrder, {
        get(target, prop) {
            counter.get++;
            return Reflect.get(target, prop);
        }
    });
    return counter;
}

/** 捕获 `console.warn`（本项目既有的日志出口；测试里只临时替换，结束即还原） */
function captureWarn(fn) {
    const out = [];
    const original = console.warn;
    console.warn = (...args) => out.push(args.join(' '));
    try {
        return { out, result: fn() };
    } finally {
        console.warn = original;
    }
}

/** 一棵干净的小树：o → syn(k:1) 、o → m(→ k:1)，都在树上、标识不重复 */
function makeCleanState() {
    const nodes = {
        o: { id: 'o', type: 'O', name: 'o', synthKey: '', ownerSynth: '' },
        syn: { id: 'syn', type: 'P', name: 'syn', synthKey: 'k:1', ownerSynth: '' },
        m: { id: 'm', type: 'P', name: 'm', synthKey: '', ownerSynth: 'k:1' }
    };
    const childOrder = { o: ['syn', 'm'], syn: [], m: [] };
    return { rootId: 'o', nodes, childOrder };
}

// ================================================================
test('成员表：每一组与 synthMembers 逐元素相等（树序，不是插入序）', () => {
    const st = makeSmallState();
    const table = synthMembersTable(st);

    // ① 表的键集 = 真的有合成节点占着的标识（悬空标识不是键）
    assert.deepEqual([...table.keys()].sort(), ['k:C', 'k:P', 'k:SELF']);

    // ② 逐元素相等 —— 这是本表存在的唯一理由，一个字都不能差
    for (const [key, ids] of table) {
        assert.deepEqual(ids, synthMembers(st, key), `${key} 与 synthMembers 不一致`);
    }

    // ③ 树序：cA 下的 p1、p2 在 cB 下的 p3 之前
    assert.deepEqual(table.get('k:P'), ['p1', 'p2', 'p3']);
    assert.equal(synthIndex(st).members.get('k:P')[0], 'p3', '插入序确实是另一个顺序（对照用）');

    // ④ 口径：空组给空数组；走不到的节点两边都不收
    assert.deepEqual(table.get('k:C'), []);
    assert.ok(!table.get('k:P').includes('orphan'), '从根走不到的节点不进名单（与 synthMembers 同口径）');
    // 悬空标识：单点查询照样能"照着指针找出成员"，但它**不是键**
    // （表的口径是"真的有合成节点占着的标识"，与组一致；悬空由界面单独标黄）
    assert.deepEqual(synthMembers(st, 'k:missing'), ['x1'], '悬空指针的成员单点查询找得到');
    assert.equal(table.has('k:missing'), false, '悬空标识不是表的键');
    assert.ok(![...table.values()].some(list => list.includes('x1')), '悬空成员不进任何组');

    // ⑤ 自指的数据如实陈列（不静默丢 —— 由 findDanglingOwners 负责标出来）
    assert.deepEqual(table.get('k:SELF'), ['weird']);
});

test('synthMembers：返回值与"每键单独走一趟"完全一致，且深链不爆栈', () => {
    // 两万节点的**深链**（链深 == 节点数）：递归会爆栈，迭代实现必须活下来
    const nodes = {};
    const childOrder = {};
    const DEPTH = 20000;
    for (let i = 0; i < DEPTH; i++) {
        const id = 'n' + i;
        nodes[id] = { id, type: 'P', name: id, ownerSynth: i % 500 === 0 ? 'k:deep' : '', synthKey: '' };
        childOrder[id] = i + 1 < DEPTH ? ['n' + (i + 1)] : [];
    }
    // 合成节点自己（不放链上也行：表的键集只看"谁占了标识"）
    nodes.deepSynth = { id: 'deepSynth', type: 'P', name: '深链合成', ownerSynth: '', synthKey: 'k:deep' };
    childOrder.deepSynth = [];
    const st = { rootId: 'n0', nodes, childOrder };

    const expected = [];
    for (let i = 0; i < DEPTH; i += 500) expected.push('n' + i);
    assert.deepEqual(synthMembers(st, 'k:deep'), expected, '深链下逐元素相同（不爆栈）');

    const table = synthMembersTable(st);
    assert.deepEqual(table.get('k:deep'), expected, '深链下建表也逐元素相同');
});

test('成员表：全表遍历只发生一趟 —— 读取次数 == 节点数，且不随合成节点数变化', () => {
    // 500 组 / 1000 组：**节点总数一样**，只有"多少个合成节点"不同。
    // 若实现是"每个合成节点各扫一遍全树"，读取次数会翻倍；一趟遍历则纹丝不动。
    const a = makeBigState(500);
    const b = makeBigState(1000);
    const nA = Object.keys(a.nodes).length;
    const nB = Object.keys(b.nodes).length;
    assert.equal(nA, nB, '两个 fixture 的节点总数必须一样（否则这个对照没意义）');
    assert.ok(nA > 20000, `节点数要够大（实测 ${nA}）`);

    const cA = withCountingChildOrder(a);
    const cB = withCountingChildOrder(b);
    const tA = synthMembersTable(a);
    const tB = synthMembersTable(b);
    const getsA = cA.get;
    const getsB = cB.get;

    assert.equal(tA.size, 500, '表里正好 500 组');
    assert.equal(tB.size, 1000, '表里正好 1000 组');
    assert.equal(getsA, nA, `childOrder 读取次数 == 节点数（一趟遍历）：${getsA} vs ${nA}`);
    assert.equal(getsB, nB, `childOrder 读取次数 == 节点数（一趟遍历）：${getsB} vs ${nB}`);
    assert.equal(getsA, getsB, '合成节点数翻倍，遍历次数**不**变（不是 O(#合成 × N)）');
});

test('性能回归锚：500 个合成节点 + 两万节点，"建一次表 + 取全部成员" < 200ms', () => {
    const st = makeBigState(500);
    const nodeCount = Object.keys(st.nodes).length;

    const run = () => {
        const t0 = performance.now();
        const table = synthMembersTable(st);
        let total = 0;
        for (const ids of table.values()) total += ids.length;
        return { ms: performance.now() - t0, table, total };
    };

    run();                                     // 预热（JIT / 首次分配的噪声）
    const samples = [run(), run(), run()];
    const best = samples.reduce((m, s) => Math.min(m, s.ms), Infinity);
    const { table, total } = samples[0];

    console.log(`[synthMembersTable] 节点 ${nodeCount} · 合成节点 ${table.size} · 成员 ${total}`
        + ` · 建表+取全部成员 ${samples.map(s => s.ms.toFixed(1) + 'ms').join(' / ')}`);

    assert.equal(table.size, 500, '500 个合成节点');
    assert.ok(total > 10000, `成员总数要对得上量级（实测 ${total}）`);
    assert.ok(best < 200, `建表 + 取全部成员应 < 200ms（实测最好 ${best.toFixed(1)}ms）`);

    // 逐元素抽检（表在大 fixture 上也必须与单点查询一致；合成节点在 idx = 0 / 30 / 60…）
    for (const key of ['k:0', 'k:450', 'k:14970']) {
        assert.ok(table.has(key), `${key} 应当是表里的键`);
        assert.deepEqual(table.get(key), synthMembers(st, key), `${key} 大 fixture 上不一致`);
    }
});

// ================================================================
// ⑤ 坏数据告警：**口径一个字不改**，只是不再静默
//
// 只在坏数据下可见的触发条件给出足够警告；不为此加补丁，白白使逻辑复杂化。
// ⇒ 走本项目既有的 `console.warn`（不新造日志机制），
// 且检测全是**顺带 O(1) / 集合大小差**，不重扫全表、不加常驻缓存。
// ================================================================
test('坏数据告警：两个节点共用同一个 synthKey ⇒ 点名两个节点 id，仍取最后出现的', () => {
    const nodes = {
        o: { id: 'o', type: 'O', name: 'o', synthKey: '', ownerSynth: '' },
        dupA: { id: 'dupA', type: 'P', name: 'a', synthKey: 'k:dup', ownerSynth: '' },
        dupB: { id: 'dupB', type: 'P', name: 'b', synthKey: 'k:dup', ownerSynth: '' }
    };
    const st = { rootId: 'o', nodes, childOrder: { o: ['dupA', 'dupB'], dupA: [], dupB: [] } };

    const { out, result } = captureWarn(() => synthIndex(st));
    assert.equal(out.length, 1, `只报一次，实际：${out.join(' | ')}`);
    assert.ok(out[0].includes('k:dup'), `要点名标识：${out[0]}`);
    assert.ok(out[0].includes('dupA') && out[0].includes('dupB'), `两个节点 id 都要点名：${out[0]}`);
    assert.equal(result.byKey.get('k:dup'), 'dupB', '结果不变：最后出现的赢（口径不改）');
});

test('坏数据告警：ownerSynth 写成节点 id ⇒ 报出来，成员表按标识读不到它（口径不变）', () => {
    const nodes = {
        o: { id: 'o', type: 'O', name: 'o', synthKey: '', ownerSynth: '' },
        synNode: { id: 'synNode', type: 'P', name: 's', synthKey: 'k:1', ownerSynth: '' },
        m: { id: 'm', type: 'P', name: 'm', synthKey: '', ownerSynth: 'synNode' }   // ← 节点 id
    };
    const st = { rootId: 'o', nodes, childOrder: { o: ['synNode', 'm'], synNode: [], m: [] } };

    const { out } = captureWarn(() => synthIndex(st));
    assert.equal(out.length, 1, `只报一次，实际：${out.join(' | ')}`);
    assert.ok(out[0].includes('节点 m 的'), `要点名是哪个节点写错了：${out[0]}`);
    assert.ok(out[0].includes('synNode') && out[0].includes('k:1'),
        `写错的节点 id 与应写的标识都要点名：${out[0]}`);

    // 口径不变：本表按**标识**建组 ⇒ 节点 id 指针读不出来（这正是与 groupCount 的分叉点）
    const { result: table } = captureWarn(() => synthMembersTable(st));
    assert.deepEqual(table.get('k:1'), [], 'k:1 的名单是空的');
    assert.deepEqual(synthMembers(st, 'k:1'), [], '单点查询同口径（也读不出来）');
});

test('坏数据告警：成员从根走不到 ⇒ 建表时报出来，且名单里依旧没有它', () => {
    const st = makeSmallState();      // 里面本就有 orphan：ownerSynth = k:P，但不在任何 childOrder 上
    const { out, result: table } = captureWarn(() => synthMembersTable(st));

    const hits = out.filter(w => w.includes('走不到'));
    assert.equal(hits.length, 1, `只报 k:P 这一处，实际：${out.join(' | ')}`);
    assert.ok(hits[0].includes('k:P'), `要点名是哪个标识：${hits[0]}`);
    assert.ok(hits[0].includes('orphan'), `要点名走不到的成员：${hits[0]}`);

    // 结果**不变**：表与单点查询都不收它（与加警告前逐元素相同）
    assert.ok(!table.get('k:P').includes('orphan'));
    assert.deepEqual(table.get('k:P'), synthMembers(st, 'k:P'));
});

test('好数据**零告警**（回归锚）：synthIndex / synthMembersTable 一声不吭', () => {
    const st = makeCleanState();
    const { out, result: table } = captureWarn(() => {
        synthIndex(st);
        return synthMembersTable(st);
    });
    assert.deepEqual(out, [], '干净数据不该有任何 console.warn');
    assert.deepEqual(table.get('k:1'), ['m'], '成员照样收进来（不是靠警告才工作的）');
});
