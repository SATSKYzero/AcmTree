// ================================================================
// 合成节点的组值：A（树内）⊕ B（映射）两套独立，merge 才相遇
//                                        （src/test/groupSynthAgg.test.js）
//
// 合成节点**不排成员列表的第 0 位**：A、B 拆开算
//   · **A = 树内计算（只看子树）**：节点自己的记录 + 子节点情况的聚合。合成 P 的
//     `status1` / `status2` 的 A 就是**它自己那份**；合成 C 的 `statusComplete2` 的 A
//     就是 `core/derive.js` 的**容器推导**。
//   · **B = 映射计算（列表）**：`ownerSynth` 指向它的成员原料各自那份，按该字段聚合器折叠。
//   · **合并**：`status2` 是"A 为忽略 ⇒ 保持忽略，否则 max"；其余字段直接用该字段聚合器。
//   · **合成节点只通过 A 参与**，成员只通过 B 参与 —— 成员列表里**没有合成节点自己**
//     （不存在"合成头排第 0 位 + 单独一趟打补丁"那种排法）。
//
// 落地规则（`core/groupValue.js` 的文件头是唯一来源，这里只钉行为）：
//   · `status1` = `A OR B` —— 任一是 1 就是 1；
//   · `status2` = A == 忽略 ⇒ 忽略；否则 `preferReal(A, B)`（非忽略里取最大，全为忽略才是 5）；
//   · `statusComplete2`（C）= `max(A 容器推导, B 成员聚合)`（覆盖 4 忽略是序数最大 ⇒ 自然优先）。
//
// 纯对象、无 immer / DOM（`npm test` 用纯 Node 跑）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runGroupPasses, groupAggregateOf, groupMemberOrder } from '../core/groupValue.js';
import { clearGroupMemo, groupValueOf, groupComputed } from '../core/groupCompute.js';
import { clearDerivedMemo, deriveContainerStatusComplete2 } from '../core/derive.js';
import { collectPStats, collectCStats } from '../core/query/stats.js';
import { addProblem, newProblemBuckets } from '../core/model/status.js';
import { MODE_PLAIN, MODE_DEDUP, STATUS2_IGNORED } from '../core/query/groupCount.js';
import { viewDerived } from '../view/scope.js';
import { SYNTH_PREFIX, synthMembersTable } from '../core/ops/synth.js';

// ================================================================
// 造数据的小工具（真字段键：`synthKey` / `ownerSynth`）
// ================================================================
const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { 'qoj:x': { kind: 'script', rank: 20 } },
    fieldPrefer: {}
};

function makeState(extra = {}) {
    return {
        rootId: null,
        nodes: {},
        childOrder: {},
        parentOf: {},
        accounts: {
            local: { id: 'local', name: '本机', mappings: [] },
            k1: { id: 'k1', name: '主号', mappings: [] }
        },
        sources: { 'qoj:x': { kind: 'script', rank: 20 }, manual: { kind: 'manual', rank: 100 } },
        trust: TRUST,
        ...extra
    };
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

/** 纯算法层的取值器：直接读节点上的字段（绕开投影，见 `groupValue.test.js` 的文件头） */
const cacheOf = (node, field) => node && node[field];

/** 一条**手改覆盖**（`status1` 只认 0/1） */
const manual = (v, account, at) => ({ v, src: 'manual', at, account });

/**
 * 一个合成 P 组：`syn`（合成头）+ `m1` / `m2`（成员）。
 * 三个节点都挂在 `o` 下（成员关系是指针，不是父子）。
 */
function synthGroup(own = {}, m1 = {}, m2 = {}) {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', ...own });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', ...m1 });
    add(st, 'm2', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', ...m2 });
    return st;
}

/** 跑 P 层三趟，返回倒推覆盖表（`nodeId → 组值`） */
const passP = st => runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working;

// ================================================================
// ① 合成 P · status1 = OR(自己那份, 成员们的 status1)
// ================================================================
test('合成 P · status1：自己=0 / 成员全 0 ⇒ 0；自己=0 / 有成员=1 ⇒ 1；自己=1 / 成员全 0 ⇒ 1', () => {
    const st = synthGroup({ status1: 0 }, { status1: 0 }, { status1: 0 });
    let w = passP(st);
    assert.equal(w.get('syn').status1, 0, '全 0 ⇒ 0');
    assert.equal(w.get('m1').status1, 0, '同一组的成员看到同一个组值');

    st.nodes.m2.status1 = 1;
    w = passP(st);
    assert.equal(w.get('syn').status1, 1,
        '⚠️ 判别断言：合成头自己=0、成员有 1 ⇒ 组值 = 1（**合并 ≠ 覆盖**；'
        + '只看组头自己那份，这里会给 0）');
    assert.equal(w.get('m1').status1, 1, '成员看到的是组值（1），不是自己那份（0）');

    st.nodes.m2.status1 = 0;
    st.nodes.syn.status1 = 1;
    w = passP(st);
    assert.equal(w.get('syn').status1, 1, '自己=1 / 成员全 0 ⇒ 1');
});

// ================================================================
// ② 合成 P · status2：特例（自己=忽略 ⇒ 整组忽略）+ preferReal
// ================================================================
test('合成 P · status2：自己=5（忽略）⇒ 整组 5（特例，盖过成员的其它档位）', () => {
    const st = synthGroup({ status2: STATUS2_IGNORED }, { status2: 3 });
    const w = passP(st);
    assert.equal(w.get('syn').status2, 5,
        '特例：合成头自己那份 == 5 ⇒ 5（**特意保留**，别按 preferReal 算成 3）');
    assert.equal(w.get('m1').status2, 5, '整组都看到 5');
    assert.equal(w.get('m2').status2, 5, '连没有值的那份也被组值盖成 5（组值只有一个）');
});

test('合成 P · status2：自己非 5 ⇒ preferReal（非忽略里取最大；全为忽略才是 5）', () => {
    const st = synthGroup({ status2: 3 }, { status2: STATUS2_IGNORED }, { status2: 4 });
    const w = passP(st);
    assert.equal(w.get('syn').status2, 4,
        'preferReal：[自己=3, 5, 4] ⇒ 只在非忽略里取最大 = 4（忽略不压过真实档位）');

    // ⚠️ 任务里那条"自己=3 / 成员全 5 ⇒ 5"与**显式落地规则**（`makeStatus2Agg(preferReal:true)`
    //    + "自己 == 5 才整组 5"）互相冲突：规则给 **3**（非忽略只有自己那份 3）。
    //    这里按**显式规则**断言，冲突已在施工报告里点出 ——
    //    别为了凑那个 5 改成字面 `max`（那会让"一个成员标了忽略"把整组真实档位盖掉，
    //    与 `groupCount.js:92` 钉死的 preferReal 语义相反）。
    st.nodes.m2.status2 = STATUS2_IGNORED;
    const w2 = passP(st);
    assert.equal(w2.get('syn').status2, 3,
        '自己=3 / 成员全 5 ⇒ 3（preferReal：非忽略里只有 3；全为忽略才是 5）');

    st.nodes.syn.status2 = STATUS2_IGNORED;
    const w3 = passP(st);
    assert.equal(w3.get('syn').status2, 5, '**全**为忽略（含自己）⇒ 5（这一条与特例一致）');
});

test('合成 P · status2 特例不影响对照组：合成 C / 无合成节点时行为不变', () => {
    // 合成 C 的 status1/status2 走同一套聚合器（`AGG_BUILDERS`），特例同样只在
    // "头自己那份 == 5"时生效 —— 这是 `groupAggregateOf` 与第 2b 趟共用的判定。
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'synC', 'C', 'o', { synthKey: SYNTH_PREFIX + 'gc', status2: 3 });
    add(st, 'c1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'gc', status2: 4 });
    const wc = runGroupPasses(st, { type: 'C', baseOf: cacheOf }).working;
    assert.equal(wc.get('synC').status2, 4, '合成 C 同理：preferReal ⇒ 4');
    st.nodes.synC.status2 = STATUS2_IGNORED;
    assert.equal(runGroupPasses(st, { type: 'C', baseOf: cacheOf }).working.get('synC').status2, 5,
        '合成 C 的头自己=5 ⇒ 整组 5（同一条特例）');
});

// ================================================================
// ③ 回归底线：没有合成节点 ⇒ 与逐节点实现（`fullAutoUpdate`）逐字段相等
// ================================================================
/** 一棵**没有合成节点 / 没有指针**的树（`c1` 下三题，一题没提交过） */
function plainTree() {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'c1', 'C', 'o');
    add(st, 'p1', 'P', 'c1', { status1: 1, status2: 3 });
    add(st, 'p2', 'P', 'c1', { status1: 0, status2: STATUS2_IGNORED });
    add(st, 'p3', 'P', 'c1', { status1: 0 });
    add(st, 'r1', 'R', 'p1', { status: 'AC' });
    return st;
}

test('无合成节点：三趟什么都不做，且 dedup 与逐节点 legacy 逐字段相等', () => {
    const st = plainTree();
    const step = runGroupPasses(st, { type: 'P', baseOf: cacheOf });
    assert.equal(step.hasSynthesis, false, '没有合成节点');
    assert.equal(step.working.size, 0, '倒推覆盖表为空（组那份 ≡ 自己那份）');
    assert.deepEqual(step.layers, [], '直接短路，连层记录都不产生');
    clearGroupMemo();
    for (const id of Object.keys(st.nodes)) {
        for (const field of ['status1', 'status2']) {
            assert.equal(groupValueOf(st, st.nodes[id], field), undefined,
                `${id}.${field}：没有组 ⇒ 组那份退回自己那份`);
        }
    }

    // 逐节点 legacy 参照（只用公开 API，故意写得笨）
    const ref = newProblemBuckets();
    for (const id of ['p1', 'p2', 'p3']) addProblem(ref, st.nodes[id].status1, st.nodes[id].status2);
    assert.deepEqual(ref, {
        total: 3, passed: 0, passedIgnore: 1, processed: 1, processedIgnore: 2
    }, '参照值本身（p1: 过 + 处理；p2: 忽略；p3: 空）');
    assert.deepEqual(collectPStats(st, 'c1', undefined, { mode: MODE_DEDUP }), ref,
        'dedup：没有合成节点 ⇒ 每个原料自己一组 ⇒ 与逐节点逐字段相等');
    assert.deepEqual(collectPStats(st, 'c1', undefined, { mode: MODE_PLAIN }), ref,
        'plain 一字未动，照样相等');
    assert.deepEqual(collectPStats(st, 'c1', undefined, { mode: MODE_DEDUP }),
        collectPStats(st, 'c1', undefined, { mode: MODE_PLAIN }));
});

// ================================================================
// ④ 统计去重：P 的档位 = 「组那份」（组头自己填 0、成员有 1 ⇒ 已处理）
// ================================================================
test('统计去重（dedup）· P 档位 = 「组那份」：组头自己填 0、成员有 1 ⇒ 进"已处理"档', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', status1: 0, status2: 0 });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 1, status2: 3 });
    assert.equal(st.nodes.syn.status1, 0, '前提：组头自己填的是 0 / 0（只看组头自己那份会一档都不落）');

    const b = collectPStats(st, 'o', undefined, { mode: MODE_DEDUP });
    assert.deepEqual(b, {
        total: 1, passed: 0, passedIgnore: 1, processed: 1, processedIgnore: 1
    }, '组那份 = (OR(0,1), preferReal(0,3)) = (1,3) ⇒ 已处理 + 过题；**不是** (0,0)');
    assert.equal(b.processed, 1, '该组进的是"已处理"档');

    // 与 `groupAggregateOf`（同一套规则）逐字段一致
    const rep = st.nodes.syn;
    assert.equal(groupAggregateOf(st, {
        headId: rep.id, memberIds: ['m1'], field: 'status1', readOf: cacheOf
    }), 1);
    assert.equal(groupAggregateOf(st, {
        headId: rep.id, memberIds: ['m1'], field: 'status2', readOf: cacheOf
    }), 3);
});

test('统计去重（dedup）· status2 特例照样生效：组头自己=5 ⇒ 该组进"处理+忽略"', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', status1: 0, status2: STATUS2_IGNORED });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 1, status2: 3 });
    assert.deepEqual(collectPStats(st, 'o', undefined, { mode: MODE_DEDUP }), {
        total: 1, passed: 0, passedIgnore: 0, processed: 1, processedIgnore: 1
    }, '组那份 = (1, 5) ⇒ 处理 + 处理含忽略（5 盖过成员的 3）');
});

test('统计去重（dedup）· 单元素组（非合成）不受影响：档位就是它自己那份', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'p1', 'P', 'o', { status1: 1, status2: 4 });
    assert.deepEqual(collectPStats(st, 'o', undefined, { mode: MODE_DEDUP }), {
        total: 1, passed: 1, passedIgnore: 1, processed: 1, processedIgnore: 1
    });
});

// ================================================================
// ⑤ 口径合一：统计去重取的那份 == 界面「组那份」（`viewDerived({column:'group'})`）
// ================================================================
/**
 * 有合成节点的完整 state（值在**来源层**，因为派生表只认投影）：
 *
 *   o
 *   ├ synP (P, synth:gp)          ← 合成头：自己那份 (0, 0)
 *   ├ p1   (P, → synth:gp) WA 的 R ⇒ 自己那份 (1, 2)
 *   ├ synC (C, synth:g1)
 *   ├ c1   (C, → synth:g1)
 *   └ p2   (P, → synth:gp) AC 的 R ⇒ 自己那份 (0, 3)
 *
 * 组 gp 的组那份 = (OR(0,1,0), preferReal(0,2,3)) = (1, 3)。
 */
function groupedTree() {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'synP', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp' });
    add(st, 'p1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp' });
    add(st, 'synC', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'c1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    add(st, 'p2', 'P', 'synC', { ownerSynth: SYNTH_PREFIX + 'gp' });
    add(st, 'r1', 'R', 'p1', { status: 'WA' });
    add(st, 'r2', 'R', 'p2', { status: 'AC' });
    // `status1` 是"用户按下的覆盖" ⇒ 只有来源层里有，派生表才看得见
    st.nodes.p1.values = { status1: [manual('1', 'k1', 'T1')] };
    st.nodes.p2.values = { status1: [manual('0', 'k1', 'T1')] };
    st.nodes.synP.values = { status1: [manual('0', 'k1', 'T1')] };
    st.viewingAccountId = 'k1';
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

test('统计去重的档位 == 界面的「组那份」（两条实现路径逐字段一致）', () => {
    const st = groupedTree();
    const read = (n, f) => viewDerived(st, n, f);

    // 界面的「组那份」（走 `groupCompute.js` → `groupValue.js` → `groupCount`）
    for (const id of ['synP', 'p1', 'p2']) {
        assert.equal(viewDerived(st, st.nodes[id], 'status1', { column: 'group' }), 1,
            `${id}：组那份 status1 = OR(0,1,0) = 1`);
        assert.equal(viewDerived(st, st.nodes[id], 'status2', { column: 'group' }), 3,
            `${id}：组那份 status2 = preferReal(0,2,3) = 3`);
    }

    // 统计去重（走 `groupAggregateOf`）：同一组、同一份值 ⇒ 同一档
    const viaStats = collectPStats(st, 'o', read, { mode: MODE_DEDUP });
    const ref = newProblemBuckets();
    addProblem(ref,
        viewDerived(st, st.nodes.synP, 'status1', { column: 'group' }),
        viewDerived(st, st.nodes.synP, 'status2', { column: 'group' }));
    assert.deepEqual(viaStats, ref, '统计去重逐字段等于"按组那份分档"');
    assert.deepEqual(viaStats, {
        total: 1, passed: 0, passedIgnore: 1, processed: 1, processedIgnore: 1
    }, 'gp 是唯一的 P 组：档位 (1,3)');

    // 组头在范围外也一样（scope-local）：只有成员 p1 在范围内
    assert.deepEqual(collectPStats(st, 'p1', read, { mode: MODE_DEDUP }),
        viaStats, 'scope=p1：只有成员在范围内，仍按同一组同一份档位算一次');
    assert.equal(collectPStats(st, 'c1', read, { mode: MODE_DEDUP }).total, 0,
        'scope=c1：子树里一个 P 都没有 ⇒ 没有组（空子树不凭空造档）');
});

test('口径合一的只读性：算组值 / 统计不改任何节点与来源层', () => {
    const st = groupedTree();
    const before = JSON.stringify(st);
    const read = (n, f) => viewDerived(st, n, f);
    collectPStats(st, 'o', read, { mode: MODE_DEDUP });
    groupAggregateOf(st, { headId: 'synP', memberIds: ['p1', 'p2'], field: 'status2', readOf: read });
    assert.equal(JSON.stringify(st), before, '输入逐字节不变（组值是派生，绝不写回）');
});

// ================================================================
// ⑥ 判别断言：A（树内）与 B（映射）两套独立，merge 才相遇
//
// 这一节是"拆开"与否的**分水岭** —— 逐条对着任务里的七条判别断言写。
// ================================================================

test('判别① 合成P：A(status2)=3、B=聚合(成员 [5,4]) ⇒ 4（成员的忽略不吸收）', () => {
    const st = synthGroup({ status2: 3 }, { status2: STATUS2_IGNORED }, { status2: 4 });
    const w = passP(st);
    assert.equal(w.get('syn').status2, 4,
        'merge(A=3, B=preferReal(5,4)=4) ⇒ 4：**成员的忽略不吸收**（它在 B 那一套里就被滤掉了）');
    assert.equal(w.get('m1').status2, 4, '成员看到的是组值（B 那套的结论随组走）');
    assert.equal(w.get('m2').status2, 4, '另一个成员看到同一个组值');
});

test('判别② 合成P：A(status2)=忽略、B=3 ⇒ 忽略（A 的忽略保持）', () => {
    const st = synthGroup({ status2: STATUS2_IGNORED }, { status2: 3 });
    const w = passP(st);
    assert.equal(w.get('syn').status2, STATUS2_IGNORED,
        '**A**（合成节点自己那份 = 树内计算）为忽略 ⇒ 保持忽略，不看 B');
    assert.equal(w.get('m1').status2, STATUS2_IGNORED, '整组都看到忽略');
});

test('判别③ 合成P：A(status1)=0、B 里有成员=1 ⇒ 1', () => {
    const st = synthGroup({ status1: 0 }, { status1: 1 }, { status1: 0 });
    const w = passP(st);
    assert.equal(w.get('syn').status1, 1, 'merge(A=0, B=OR(1,0)) ⇒ 1（两套在 merge 相遇）');
    assert.equal(w.get('m2').status1, 1, '没按过的成员也看到组值 1');
});

test('判别④ 合成P：A、B 都为空 ⇒ 该字段返回 undefined（调用方退回"自己那份"）', () => {
    const st = synthGroup();                       // 三个节点都没有 status2
    const w = passP(st);
    assert.equal(w.get('syn').status2, undefined, 'A 空 + B 空 ⇒ **不产生**这一份（不是 null）');
    assert.equal(w.get('m1').status2, undefined, '成员也一样（不凭空造值）');
    assert.equal(w.get('syn').status1, 0, '对照：status1 的单位元是 0 ⇒ 照样有值');

    // 单元素组（没有映射列表）同理：A 空 ⇒ 不入表
    const solo = makeState();
    add(solo, 'o', 'O');
    add(solo, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gs' });
    assert.equal(runGroupPasses(solo, { type: 'P', baseOf: cacheOf }).working.get('syn').status2,
        undefined, '单元素组：A 空 ⇒ 组那份是 undefined，调用方退回自己那份');
});

test('判别⑤ 合成节点不出现在自己的成员列表里（普通数据 + 自指坏数据）', () => {
    const st = synthGroup({}, {}, {});
    const key = SYNTH_PREFIX + 'g';
    assert.deepEqual(groupMemberOrder(st).get(key), ['m1', 'm2'],
        '映射列表 = 成员原料（树序），**没有合成节点自己**（不再排第 0 位）');
    assert.ok(!(synthMembersTable(st).get(key) || []).includes('syn'),
        '`synthMembersTable` 的名单里也没有它（它没有 `ownerSynth` 指针）');

    // 坏数据：合成节点自己填了指向自己的 `ownerSynth`（手改会被 `applyOwnerSynth` 拒绝，
    // 导入包可能带进来）——成员聚合的输入集合里**仍然不许**出现它。
    const bad = synthGroup({}, {}, {});
    bad.nodes.syn.ownerSynth = key;
    assert.ok((synthMembersTable(bad).get(key) || []).includes('syn'),
        '（前提）底层建表如实陈列这条自指');
    const list = groupMemberOrder(bad).get(key);
    assert.ok(!list.includes('syn'), '但成员聚合的输入集合里再滤一道 headId ⇒ 没有它');
    assert.deepEqual(list, ['m1', 'm2'], '名单仍然只有成员原料');
});

test('判别⑥ 没有合成节点时：组值 ≡ 自己那份（回归底线）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'c1', 'C', 'o');
    add(st, 'p1', 'P', 'c1', { status1: 1, status2: 3 });
    add(st, 'p2', 'P', 'c1', { status1: 0 });
    add(st, 'r1', 'R', 'p1', { status: 'WA' });
    clearDerivedMemo();
    clearGroupMemo();
    const c = groupComputed(st);
    assert.equal(c.hasSynthesis, false, '没有合成节点');
    assert.equal(c.working.size, 0, '不倒推、不产生覆盖表');
    for (const id of Object.keys(st.nodes)) {
        for (const f of ['status1', 'status2']) {
            assert.equal(groupValueOf(st, st.nodes[id], f), undefined, `${id}.${f}：没有组那份`);
            assert.deepEqual(viewDerived(st, st.nodes[id], f, { column: 'group' }),
                viewDerived(st, st.nodes[id], f), `${id}.${f}：两列逐字段相同（组那份退回自己那份）`);
        }
    }
});

/**
 * C 合成组（形状与 `statsCountMode.test.js` 的 cFixture 同源，便于互相当锚）：
 *
 *   o ─ cs (C, synth:g1) ─ p0 (P 1,2)   ⇒ A：cs 自己子树 ⇒ 2（全处理）
 *     ├ c1 (C, → synth:g1) ─ p1 (P 1,3) ⇒ B：成员 ⇒ 3（AK）
 *     ├ c2 (C, → synth:g1) ─ p2 (P 0,0) ⇒ B：成员 ⇒ 0
 *     └ c3 (C, 无归属)     ─ p3 (P 1,2) ⇒ 单元素组 ⇒ 2
 */
function cGroupTree() {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'cs', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'p0', 'P', 'cs', { status1: 1, status2: 2 });
    add(st, 'c1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    add(st, 'p1', 'P', 'c1', { status1: 1, status2: 3 });
    add(st, 'c2', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    add(st, 'p2', 'P', 'c2');
    add(st, 'c3', 'C', 'o');
    add(st, 'p3', 'P', 'c3', { status1: 1, status2: 2 });
    return st;
}

/** `statusComplete2` 的取值器 = **`core/derive.js` 的容器推导**（A 的那一份，不另写） */
const cRead = (state, pins = {}) => {
    const s1 = n => n.status1;
    const s2 = n => n.status2;
    return (n, f) => {
        if (f !== 'statusComplete2') return n[f];
        return deriveContainerStatusComplete2(state, n, s1, s2, pins[n.id]);
    };
};

test('判别⑦ C：A = 容器推导值、B = 成员 C 的 statusComplete2 聚合，merge 后与现在等价', () => {
    const st = cGroupTree();
    const read = cRead(st);
    const key = SYNTH_PREFIX + 'g1';
    clearDerivedMemo();
    clearGroupMemo();

    assert.deepEqual(groupMemberOrder(st).get(key), ['c1', 'c2'],
        'C 组的映射列表同样只有成员（合成 C 自己不在里面）');
    const a = read(st.nodes.cs, 'statusComplete2');
    assert.equal(a, 2, 'A：容器推导 —— cs 自己子树里 p0 处理了但没过 ⇒ 2 全处理');
    const b = Math.max(read(st.nodes.c1, 'statusComplete2'), read(st.nodes.c2, 'statusComplete2'));
    assert.equal(b, 3, 'B：成员 C 聚合 max(3, 0) = 3');
    assert.equal(groupAggregateOf(st, {
        headId: 'cs', memberIds: ['c1', 'c2'], field: 'statusComplete2', readOf: read
    }), 3, 'merge(A=2, B=3) = 3（与逐字段 max(①,②) 等价）');

    // 统计 C 侧走的就是这一个入口 ⇒ 锚在 `statsCountMode.test.js` 的期望值上
    assert.deepEqual(collectCStats(st, 'o', read, { mode: MODE_DEDUP }),
        { total: 2, ak: 1, proc: 2, contact: 2, ign: 2 },
        'g1 = 3（AK）；{c3} 单元素组取它自己 2 —— 与 `statsCountMode.test.js` 的 C 侧锚同一口径');

    // pin 覆盖 4（忽略）仍是序数最大 ⇒ merge 后照样优先（既有 pin 语义保持）
    const pinned = cRead(st, { c2: '4' });
    assert.equal(groupAggregateOf(st, {
        headId: 'cs', memberIds: ['c1', 'c2'], field: 'statusComplete2', readOf: pinned
    }), 4, '成员按下的 4（忽略）压过 A/B 的真实档位');
});
