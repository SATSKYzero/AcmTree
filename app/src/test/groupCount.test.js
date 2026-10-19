// ================================================================
// 组计数测试（src/test/groupCount.test.js）
//
// 语义来自 A 系列模型（详见 core/query/groupCount.js 头部）：
//   · 组 = 合成节点 + 它的全部成员原料；无所指的原料自己一组
//   · plain（不去重）= 所有原料 + "子树内没有任何成员"的合成节点
//   · dedup（去重）= 同组只算一次，状态以合成节点为准（组值 = 合成自己优先 + 成员顺序）
//   · 去重是 scope-local
// 纯对象、无 immer 依赖（`npm test` 用纯 Node 跑）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    groupCount, collectGroups, makeOrAgg, makeStatus2Agg,
    MODE_PLAIN, MODE_DEDUP, SYNTH_PREFIX
} from '../core/query/groupCount.js';

// ---- 造树小工具：state = { rootId, nodes, parentOf, childOrder } ----
function makeState() {
    return { rootId: null, nodes: {}, childOrder: {}, parentOf: {} };
}

function add(state, id, type, parentId = null, extra = {}) {
    state.nodes[id] = { id, type, ...extra };
    state.childOrder[id] = [];
    if (parentId === null) {
        state.rootId = id;
        state.parentOf[id] = null;
    } else {
        state.childOrder[parentId].push(id);
        state.parentOf[id] = parentId;
    }
    return state.nodes[id];
}

/**
 * 现模型里的指针字段 = **真字段键 `ownerSynth`**（界面显示名是「所属合成节点」）。
 * ⚠️ 这里**绝不能**写中文标签：那是 UI 文案，节点上没有这个键 —— 默认取值器
 *    读中文键，生产里所有组都退化成单元素组，而本文件把假键一起钉住了，单测照样绿。
 */
const OWNER = 'ownerSynth';

/** 上述 state 直接喂给 groupCount（模块只吃普通对象） */
const run = (state, opts = {}) => groupCount({
    nodes: state.nodes, parentOf: state.parentOf, childOrder: state.childOrder, ...opts
});

// ================================================================
// ① plain：成员在子树内 ⇒ 合成节点不计；零成员在内 ⇒ 计一次
// ================================================================
function fixtureStandin() {
    //  o
    //  ├ a (C, synth:g1)        ← 合成节点；成员 p1/p2 在 w 那支
    //  └ w
    //     ├ p1 (P, → synth:g1)
    //     └ s
    //        └ p2 (P, → synth:g1)
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'a', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1' });   // 合成节点的类型与成员相同
    add(st, 'w', 'W', 'o');
    add(st, 'p1', 'P', 'w', { [OWNER]: SYNTH_PREFIX + 'g1' });
    add(st, 's', 'S', 'w');
    add(st, 'p2', 'P', 's', { [OWNER]: SYNTH_PREFIX + 'g1' });
    return st;
}

test('plain：合成节点在子树内、但成员都不在 ⇒ 算它一次（替身）', () => {
    const st = fixtureStandin();
    const r = run(st, { mode: MODE_PLAIN });
    assert.equal(r.byNode['a'].groupCount, 1, '子树 a = {a}：零成员在内 ⇒ 合成节点计一次');
    assert.equal(r.byNode['s'].groupCount, 2, '子树 s = {s,p2}：只有原料，两个都算');
    assert.equal(r.byNode['w'].groupCount, 4, '子树 w = {w,p1,s,p2}：全是原料 ⇒ 4');
    assert.equal(r.byNode['o'].groupCount, 5, '整棵树：合成节点 a 的成员在子树内 ⇒ a 不计');
});

test('plain：合成节点在子树内且成员也在 ⇒ 只算成员、不算它', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'a', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'p1', 'P', 'a', { [OWNER]: SYNTH_PREFIX + 'g1' });   // 成员就在它自己子树下
    const r = run(st, { mode: MODE_PLAIN });
    assert.equal(r.byNode['a'].groupCount, 1, '子树 a = {a,p1}：p1 算原料，a 因成员在内而不计 ⇒ 1');
    assert.equal(r.byNode['o'].groupCount, 2, '整棵树：原料 = o + p1 = 2（a 不计）');
});

// ================================================================
// ② dedup：同组多次出现只算一次；组状态以合成节点为准
// ================================================================
test('dedup：同组在子树内出现多次只算一次，且组值由合成节点聚合（成员顺序在后）', () => {
    const st = fixtureStandin();
    // 给状态值：合成节点 status1 = 0，两个成员一个 1 一个 0 ⇒ 组值 = 1（取或）
    st.nodes['a'].status1 = 0;
    st.nodes['p1'].status1 = 1;
    st.nodes['p2'].status1 = 0;
    st.nodes['w'].status1 = 0;
    st.nodes['s'].status1 = 0;
    const agg = makeOrAgg(n => n.status1);
    const r = run(st, { mode: MODE_DEDUP, agg });
    assert.equal(r.byNode['w'].groupCount, 3, '子树 w：{w}{s}{g1} = 3（p1/p2 是同一组，只算一次）');
    assert.equal(r.byNode['w'].groupAgg, 1, '组值取或 ⇒ 1');
    assert.equal(r.byNode['s'].groupCount, 2, '子树 s：{s}{g1(p2)} = 2');
    assert.equal(r.byNode['a'].groupCount, 1, '子树 a：只有 g1 组');
    assert.equal(r.byNode['o'].groupCount, 4, '整棵树：{o}{g1}{w}{s} = 4');
});

test('dedup：合成节点自己那份最优先（成员不能把它盖掉）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'a', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1', status2: 5 });
    add(st, 'm', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g1', status2: 3 });
    const agg = makeStatus2Agg(n => n.status2);
    const r = run(st, { mode: MODE_DEDUP, agg });
    assert.equal(r.byNode['o'].groupAgg, 5, '字面语义：组内出现非忽略就取 max ⇒ 5');
    const r2 = run(st, { mode: MODE_DEDUP, agg: makeStatus2Agg(n => n.status2, { preferReal: true }) });
    assert.equal(r2.byNode['o'].groupAgg, 3, 'preferReal：只在非忽略里取 max ⇒ 3');
});

// ================================================================
// ③ 跨父绑定：去重是 scope-local
// ================================================================
test('跨父绑定：成员分散在不同子树时，去重只在各自子树内成立', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'x', 'C', 'o', { synthKey: SYNTH_PREFIX + 'gA' });
    add(st, 'u', 'S', 'o');
    add(st, 'p1', 'C', 'u', { [OWNER]: SYNTH_PREFIX + 'gA' });
    add(st, 'v', 'S', 'o');
    add(st, 'p2', 'C', 'v', { [OWNER]: SYNTH_PREFIX + 'gA' });
    const r = run(st, { mode: MODE_DEDUP });
    assert.equal(r.byNode['u'].groupCount, 2, '子树 u = {u}{gA}：只出现一次 ⇒ 2');
    assert.equal(r.byNode['v'].groupCount, 2, '子树 v 同理 ⇒ 2');
    assert.equal(r.byNode['o'].groupCount, 4, '整棵树：{o}{x=gA}{u}{v} = 4（gA 的多次出现合一）');
    const p = run(st, { mode: MODE_PLAIN });
    assert.equal(p.byNode['o'].groupCount, 5, 'plain：所有原料 = o,u,p1,v,p2 = 5（成员各算一次）');
});

// ================================================================
// ④ 无所指的原料 = 单元素组
// ================================================================
test('无所指的原料自己就是一组（单元素组）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'p', 'P', 'o');
    const { groups } = collectGroups({ nodes: st.nodes });
    assert.equal(groups.size, 2, 'o 与 p 各一组');
    assert.equal(groups.get('p').synthId, '', '单元素组没有合成头');
    assert.deepEqual(groups.get('p').members, ['p']);
    const d = run(st, { mode: MODE_DEDUP });
    assert.equal(d.byNode['o'].groupCount, 2);
    const pl = run(st, { mode: MODE_PLAIN });
    assert.equal(pl.byNode['o'].groupCount, 2, '没有合成节点时两模式一致（每个节点自成一组）');
});

// ================================================================
// ⑤ 空组 / 悬空指针 / 指到原料 / 合成节点填指针：不炸、行为明确
// ================================================================
test('悬空指针与坏数据：按单元素组处理，并给出告警', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'empty', 'P', 'o', { synthKey: SYNTH_PREFIX + 'ge' });        // 空组（零成员）
    add(st, 'bad1', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'nope' });        // 指向不存在
    add(st, 'bad2', 'P', 'o', { [OWNER]: 'o' });                          // 指向的不是合成节点
    add(st, 's1', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1', [OWNER]: SYNTH_PREFIX + 'ge' }); // 合成节点填了指针
    add(st, 'm1', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g1' });
    const r = run(st, { mode: MODE_DEDUP });
    assert.ok(r.warnings.length >= 3, `应有 ≥3 条告警，实际 ${r.warnings.length}：${r.warnings.join(' | ')}`);
    assert.ok(r.warnings.some(w => w.includes('不存在的')), '悬空指针要报');
    assert.ok(r.warnings.some(w => w.includes('不是合成节点')), '指到原料要报');
    assert.ok(r.warnings.some(w => w.includes('不允许填')), '合成节点填指针要报');
    // 行为：bad1/bad2 各自单元素组；s1 仍是 g1 的头、m1 归入 g1；empty 单元素组
    const { groups } = collectGroups({ nodes: st.nodes });
    assert.deepEqual(groups.get('bad1').members, ['bad1']);
    assert.deepEqual(groups.get('bad2').members, ['bad2']);
    assert.equal(groups.get(SYNTH_PREFIX + 'g1').synthId, 's1');
    assert.deepEqual(groups.get(SYNTH_PREFIX + 'g1').members, ['m1']);
    assert.equal(r.byNode['o'].groupCount, 5, 'o + ge + bad1 + bad2 + g1 = 5 组');
});

test('类型不同要告警，但仍按同组处理（不静默）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'a', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'm', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g1' });   // P 指向 C 的合成节点
    const r = run(st, { mode: MODE_DEDUP });
    assert.ok(r.warnings.some(w => w.includes('类型不同')), r.warnings.join(' | '));
});

// ================================================================
// ⑤′ 坏数据（**只在坏数据下可见**的两个分叉点）：报出来，口径一个字不改
//
// 口径："只在坏数据下可见的，这些触发条件给出足够警告。
// 但没必要加补丁，白白使逻辑复杂化。"
// ⇒ 只补 `warnings`；**不合流**两套口径、不加兜底分支，结果与加警告前逐字段相同。
// ================================================================
test('坏数据①：ownerSynth 写成**节点 id** ⇒ 报一次并点名两个 id；分组结果不变', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'synNode', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1' });   // 节点 id = synNode
    add(st, 'm', 'P', 'o', { [OWNER]: 'synNode' });                    // ← 写的是节点 id

    const r = run(st, { mode: MODE_DEDUP });
    const hits = r.warnings.filter(w => w.includes('节点 id'));
    assert.equal(hits.length, 1, `只报一次，实际：${r.warnings.join(' | ')}`);
    assert.ok(hits[0].startsWith('m:'), `要点名是哪个节点写错了：${hits[0]}`);
    assert.ok(hits[0].includes('synNode') && hits[0].includes(SYNTH_PREFIX + 'g1'),
        `写错的 id 与应写的 synthKey 都要点名：${hits[0]}`);
    assert.equal(r.warnings.some(w => w.includes('不存在')), false,
        '它确实命中了另一个节点 ⇒ 不该同时报成"悬空"（别重复报两遍）');

    // 结果**不变**：本模块仍然顺手认了节点 id ⇒ m 归入 g1 组（不是单元素组）
    const { groups } = collectGroups({ nodes: st.nodes });
    assert.equal(groups.get(SYNTH_PREFIX + 'g1').synthId, 'synNode');
    assert.deepEqual(groups.get(SYNTH_PREFIX + 'g1').members, ['m']);
    assert.equal(groups.size, 2, 'o 一组 + g1 一组');
    assert.equal(r.byNode['o'].groupCount, 2, 'o + g1 = 2 组（与加警告前逐字段相同）');
    assert.equal(r.byNode['m'].groupCount, 1, 'm 那棵子树里只有 g1 一组');
});

test('坏数据②：两个节点共用同一个 synthKey ⇒ 报一次并点名两个节点 id；仍取先出现的', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'dupA', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'dupB', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1' });      // ← 同一个标识
    add(st, 'm', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g1' });

    const r = run(st, { mode: MODE_DEDUP });
    const hits = r.warnings.filter(w => w.includes('同一个标识出现在多个节点上'));
    assert.equal(hits.length, 1, `只报一次，实际：${r.warnings.join(' | ')}`);
    assert.ok(hits[0].startsWith('dupB:'), `要点名后出现的那个：${hits[0]}`);
    assert.ok(hits[0].includes('dupA') && hits[0].includes('dupB'), `两个 id 都要点名：${hits[0]}`);

    // 结果**不变**：组头仍是**先出现**的 dupA；dupB 被并进同一组、自己不再单独计数
    const { groups } = collectGroups({ nodes: st.nodes });
    assert.equal(groups.get(SYNTH_PREFIX + 'g1').synthId, 'dupA');
    assert.deepEqual(groups.get(SYNTH_PREFIX + 'g1').members, ['m']);
    assert.equal(groups.size, 2, 'o 一组 + g1 一组（dupB 不另占一组）');
    assert.equal(groups.get('dupB'), undefined, 'dupB 没有自己的组 —— 这正是要报出来的原因');
    assert.equal(r.byNode['o'].groupCount, 2, '整棵树 = {o} + {g1} = 2 组');
    assert.equal(r.byNode['dupB'].groupCount, 1, 'dupB 那棵子树落进 g1 组 ⇒ 1');
});

test('好数据**零告警**（回归锚）：正常合成树跑一遍，warnings 为空', () => {
    const st = fixtureStandin();
    assert.deepEqual(run(st, { mode: MODE_PLAIN }).warnings, [], 'plain 下干净数据零告警');
    assert.deepEqual(run(st, { mode: MODE_DEDUP }).warnings, [], 'dedup 下干净数据零告警');

    // 再来一棵"多组、跨子树、每个标识只出现一次"的正常树
    const st2 = makeState();
    add(st2, 'o', 'O');
    add(st2, 'g0', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g0' });
    add(st2, 'g1', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st2, 'm0', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g0' });
    add(st2, 'm1', 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g1' });
    assert.deepEqual(run(st2, { mode: MODE_DEDUP }).warnings, [], '多组正常树零告警');
});

// ================================================================
// ⑥ 回归锚点：没有合成节点时，与"子节点加法递推"完全等价
// ================================================================
function recursiveCounts(state) {
    const out = {};
    (function walk(id) {
        let n = 1;
        for (const c of state.childOrder[id] || []) n += walk(c);
        out[id] = n;
        return n;
    })(state.rootId);
    return out;
}

test('没有合成节点时，两种模式都等于"子树节点数"（递推锚点）', () => {
    // 确定性伪随机树（LCG，便于复现）
    const st = makeState();
    let seed = 20260929;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    add(st, 'n0', 'O');
    const ids = ['n0'];
    for (let i = 1; i <= 199; i++) {
        const parent = ids[Math.floor(rnd() * ids.length)];
        const id = 'n' + i;
        add(st, id, ['C', 'P', 'R', 'S', 'W'][i % 5], parent);
        ids.push(id);
    }
    const want = recursiveCounts(st);
    const plain = run(st, { mode: MODE_PLAIN });
    const dedup = run(st, { mode: MODE_DEDUP });
    for (const id of ids) {
        assert.equal(plain.byNode[id].groupCount, want[id], `plain ${id}`);
        assert.equal(dedup.byNode[id].groupCount, want[id], `dedup ${id}`);
    }
});

// ================================================================
// ⑦ 规模与模式差：plain 与 dedup 的差 = "合起来的那些成员少算的份数"
// ================================================================
test('大树：plain 与 dedup 的差符合预期', () => {
    const st = makeState();
    add(st, 'o', 'O');
    const R = 5, P = 20;      // 5 个合成节点，每个 20 个成员 ⇒ 100 个原料
    for (let g = 0; g < R; g++) {
        add(st, `syn${g}`, 'P', 'o', { synthKey: SYNTH_PREFIX + 'g' + g });
    }
    for (let g = 0; g < R; g++) {
        for (let m = 0; m < P; m++) {
            add(st, `s${g}_${m}`, 'P', 'o', { [OWNER]: SYNTH_PREFIX + 'g' + g });
        }
    }
    const plain = run(st, { mode: MODE_PLAIN });
    const dedup = run(st, { mode: MODE_DEDUP });
    // plain：原料 = o + 100 个成员 = 101；5 个合成节点的成员都在树里 ⇒ 它们一个都不计
    assert.equal(plain.byNode['o'].groupCount, 1 + 100, 'plain：所有原料（o + 100 成员）');
    assert.equal(dedup.byNode['o'].groupCount, 1 + 5, 'dedup：o + 5 组');
    assert.equal(plain.byNode['o'].groupCount - dedup.byNode['o'].groupCount, 100 - 5,
        '差 = 成员数 − 合成节点数（100 个成员合成了 5 组）');
});

// ================================================================
// 附加：范围裁剪（scopeRoot）与只计数默认聚合器
// ================================================================
test('scopeRoot：只算这棵子树；不传则每个节点都算', () => {
    const st = fixtureStandin();
    const only = run(st, { mode: MODE_DEDUP, scopeRoot: 'w' });
    assert.deepEqual(Object.keys(only.byNode).sort(), ['p1', 'p2', 's', 'w'], '只算 w 子树');
    assert.equal(only.groupCount, only.byNode['w'].groupCount, '顶层口径 = scope 根的');
    const all = run(st, { mode: MODE_DEDUP });
    assert.equal(Object.keys(all.byNode).length, 6);
    assert.equal(all.byNode['w'].groupCount, only.byNode['w'].groupCount, '同一子树两种调用结果一致');
});

test('不给 agg ⇒ groupAgg 与 groupCount 同口径；给 sum 聚合器能按组求和', () => {
    const st = fixtureStandin();
    st.nodes['p1'].n = 2; st.nodes['p2'].n = 3;
    const sum = { identity: 0, value: n => n.n || 0, combine: (a, b) => a + b };
    const r = run(st, { mode: MODE_DEDUP, agg: sum });
    assert.equal(r.byNode['w'].groupAgg, 5, 'g1 组内 2+3（合成节点没有 n ⇒ 0）');
    const d = run(st, { mode: MODE_DEDUP });
    assert.equal(d.byNode['w'].groupAgg, 3, '不给 agg：子树 w 里 3 个组 ⇒ 与 groupCount 同口径');
    assert.equal(d.byNode['w'].groupAgg, d.byNode['w'].groupCount);
});
