// ================================================================
// 组值 / 两列值 / 每层三趟 测试（src/test/groupValue.test.js）
//
// 对照 `docs/field-rules.md`（计数与组值）：
//   ① **回归锚**：无合成节点时，三趟与 `fullAutoUpdate`（不带组的实现）逐字段相同，
//      且倒推覆盖表为空 —— "中间态不破坏现状"；
//   ② **组值 = (合成节点自己那份 + 列表成员各自那份) 再聚合**（口径：
//      **合并**，不是"组头压过成员"）；成员名单按树序；
//   ③ `status1` 取或；`status2` `preferReal`（成员里的忽略不压过真实档位；全为忽略 → 5），
//      外加"**合成头自己那份 == 5（忽略）⇒ 整组 5**"的特例（详见 `groupSynthAgg.test.js`）；
//   ④ **来源条目数不变**：跑前后逐字段断言 `node.values` 与来源表（§6.6 第 10 条）；
//   ⑤ `viewDerived` 不给 `{ column:'group' }` 时与 `derivedOf` **逐字段相等**。
//
// 两层的测试分开写，这是**刻意的**：
//   · **纯算法层**（②③）用 `runGroupPasses(st, { baseOf })` —— 直接以"节点上的值"
//     当"自己那份"，把 `status1/status2` 的语义（取或 / preferReal）钉死，
//     不受"派生值要按范围投影"的干扰；
//   · **接线层**（①④⑤ + 倒推覆盖）用完整 state 走 `viewDerived` / `buildDerivedTable`
//     —— 值的来源是**来源层**（`node.values`），因为派生表只认投影
//     （`derivePstatus1` 读的是"用户按下的覆盖"，不读缓存）。
//
// 纯对象、无 immer / DOM（`npm test` 用纯 Node 跑）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fullAutoUpdate, fullAutoUpdateWithGroups, computeGroupValues } from '../core/autoCompute.js';
import { clearDerivedMemo, buildDerivedTable, derivedOf } from '../core/derive.js';
import { clearGroupMemo, groupComputed, groupValueOf } from '../core/groupCompute.js';
import { runGroupPasses, groupMemberOrder, GROUP_LEVELS } from '../core/groupValue.js';
import { viewDerived } from '../view/scope.js';
import { SYNTH_PREFIX } from '../core/ops/synth.js';
import { MODE_PLAIN, MODE_DEDUP, makeStatus2Agg } from '../core/query/groupCount.js';

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

/** 一条**手改覆盖**（`status1` 只认 0/1；`status2` 的覆盖值只有 1/4/5） */
const manual = (v, account, at) => ({ v, src: 'manual', at, account });

/**
 * 一棵**有合成节点**的树（值的来源是**来源层**，因为派生表只认投影）：
 *
 *   o (O)
 *   ├ synP (P, synth:gp)   status2=0（它下面没有 R ⇒ "未使用"）
 *   ├ p1  (P, → synth:gp)  下面挂 WA 的 R     ⇒ 自己那份 status2 = 2
 *   ├ synC(C, synth:g1)    ← 比赛合成节点
 *   ├ c1  (C, → synth:g1)  ← 比赛成员
 *   └ p2  (P, → synth:gp)  下面挂 AC 的 R     ⇒ 自己那份 status2 = 3
 *
 * 成员关系**跨父**（synP 与 p2 不同父）—— 成员不是父子，这是刻意的。
 */
function fixtureSynth() {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'synP', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp', name: '合成题' });
    add(st, 'p1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp', status1: 1 });
    add(st, 'synC', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1', name: '合成比赛' });
    add(st, 'c1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1', name: '比赛1' });
    add(st, 'p2', 'P', 'synC', { ownerSynth: SYNTH_PREFIX + 'gp', status1: 0 });
    add(st, 'r1', 'R', 'p1', { status: 'WA' });
    add(st, 'r2', 'R', 'p2', { status: 'AC' });
    // `status1` 是"用户按下的覆盖" ⇒ 只有来源层里有，派生表才看得见
    st.nodes.p1.values = { status1: [manual('1', 'k1', 'T1')] };
    st.nodes.p2.values = { status1: [manual('0', 'k1', 'T1')] };
    st.nodes.synP.values = { status1: [manual('0', 'k1', 'T1')] };
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

/** 同一棵树，但**没有任何合成节点 / 指针**（回归锚用） */
function fixturePlain() {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'w', 'W', 'o', { name: '平台' });
    add(st, 's', 'S', 'w', { name: '系列' });
    add(st, 'c1', 'C', 's', { name: '比赛' });
    add(st, 'p1', 'P', 'c1', { status1: 1, status2: 0 });
    add(st, 'p2', 'P', 'c1', { status1: 0, status2: 0 });
    add(st, 'r1', 'R', 'p1', { status: 'AC', time: '2025.01.01 10:00' });
    add(st, 'r2', 'R', 'p2', { status: 'WA', time: '2025.01.02 10:00' });
    return st;
}

/** 纯算法层的取值器：直接读节点上的字段（刻意绕开投影 —— 见文件头说明） */
const cacheOf = (node, field) => node && node[field];

/**
 * 组值这条轴上的**来源权威**：`ratio`（通过率）与它派生的档（`xcpcDifficulty`）
 * **按"这条值是谁说的"挑**，不再是"成员树序第一个有值的"。
 *
 * 实测踩到（2026-10-16，用户报的）：xcpcio 榜给 **0.19%**，组里却显示 **0.77%** ——
 * 那是某个成员身上**残留的** cf 值（导入只加不删），而组值当时按"树序先到者"取，正好先撞上它。
 * 口径：难度数值**无序**（1200 vs 1500 无从比较 ⇒ 仍按"第一个"），但**通过率有对错**
 * ⇒ 按来源权威挑（`candidateScore`），**平手仍按老顺序**（组头 → 成员树序）。
 */
function ratioFixture(trust, mk) {
    const st = makeState({ trust });
    add(st, 'o', 'O');
    add(st, 'synP', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp' });   // 组头自己那份由 mk 决定
    mk(st);
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}
const RATIO_TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        // ⚠️ `manual` 必须登记（真机上 `state.trust.sources.manual` 是回填好的）——
        //    "谁更权威"查的就是这张表，缺了它手改会被当成 script（值级投影同样如此）
        manual: { kind: 'manual', rank: 100 },
        'xcpcio-x': { kind: 'board', rank: 30 },
        'cf-x': { kind: 'script', rank: 20 },
        'qoj-x': { kind: 'script', rank: 20 }
    },
    fieldPrefer: {}
};
const member = (id, ratio, src, diff) => (st) => add(st, id, 'P', 'o', {
    ownerSynth: SYNTH_PREFIX + 'gp', ratio, xcpcDifficulty: diff,
    values: { ratio: [{ v: ratio, src, at: 'T1' }] }
});

test('★ 组值：ratio 与它的档按**来源权威**挑（cf 排在树序前面也不再赢）', () => {
    // ⚠️ cf 成员**排在前面**（树序先到者）—— 改前正是它赢，这就是这条测试钉的回归
    const st = ratioFixture(RATIO_TRUST, (s) => {
        member('pCf', '0.77', 'cf-x', 'R')(s);
        member('pXc', '0.19', 'xcpcio-x', 'C')(s);
    });
    const head = runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('synP');
    assert.equal(head.ratio, '0.19', '权威榜那份赢，与成员树序无关');
    assert.equal(head.xcpcDifficulty, 'C', '★ 档必须跟着 ratio 的来源走（否则会显示 0.19%(R)）');
});

test('组值：权威相同时**回到老顺序**（树序第一个有值的），难度那几档也照旧', () => {
    const st = ratioFixture(RATIO_TRUST, (s) => {
        member('pA', '0.77', 'cf-x', 'R')(s);
        member('pB', '0.19', 'qoj-x', 'C')(s);
    });
    const head = runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('synP');
    assert.equal(head.ratio, '0.77', '同权威 ⇒ 先到者胜（与改前一字不差）');
    assert.equal(head.xcpcDifficulty, 'R');
});

test('组值：说不出出处的那份排在最后（残留挂在**组头**上也不例外）', () => {
    // 组头有 cache 值、来源层里没有条目（老数据/残留）⇒ 让位给"有出处"的成员
    const st = ratioFixture(RATIO_TRUST, (s) => {
        s.nodes.synP.ratio = '0.77';
        s.nodes.synP.xcpcDifficulty = 'R';
        member('pXc', '0.19', 'xcpcio-x', 'C')(s);
    });
    const head = runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('synP');
    assert.equal(head.ratio, '0.19');
    assert.equal(head.xcpcDifficulty, 'C');
    // 反例：**两边都没有出处**（旧数据）⇒ 全是空 kind ⇒ 平手 ⇒ 老顺序（组头优先）
    const st2 = ratioFixture(RATIO_TRUST, (s) => {
        s.nodes.synP.ratio = '0.77';
        add(s, 'pXc', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp', ratio: '0.19', xcpcDifficulty: 'C' });
    });
    const head2 = runGroupPasses(st2, { type: 'P', baseOf: cacheOf }).working.get('synP');
    assert.equal(head2.ratio, '0.77', '都没有出处 ⇒ 行为与改前相同');
});

test('组值：手改（manual）永远压过抓来的', () => {
    const st = ratioFixture(RATIO_TRUST, (s) => {
        member('pXc', '0.19', 'xcpcio-x', 'C')(s);
        add(s, 'pMan', 'P', 'o', {
            ownerSynth: SYNTH_PREFIX + 'gp', ratio: '0.55', xcpcDifficulty: 'R',
            values: { ratio: [{ v: '0.55', src: 'manual', at: 'T1' }] }
        });
    });
    const head = runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('synP');
    assert.equal(head.ratio, '0.55');
    assert.equal(head.xcpcDifficulty, 'R');
});

/** 把整份 state 里所有 `node.values` 与来源表拍平成一份可比对的快照（§6.6 第 10 条） */
function snapshotSources(state) {
    const nodes = {};
    for (const id of Object.keys(state.nodes).sort()) {
        nodes[id] = JSON.parse(JSON.stringify(state.nodes[id].values || {}));
    }
    return {
        nodes,
        sources: JSON.parse(JSON.stringify(state.sources || {})),
        entryCount: Object.values(nodes).reduce(
            (n, vals) => n + Object.values(vals).reduce((m, list) => m + (list ? list.length : 0), 0), 0)
    };
}

// ================================================================
// ① 回归锚：无合成节点 ⇒ 三趟什么都不做，且与 `fullAutoUpdate` 逐字段相同
// ================================================================
test('无合成节点：fullAutoUpdateWithGroups 的结果与 fullAutoUpdate 逐字段相同', () => {
    const oldState = fixturePlain();
    const newState = structuredClone(oldState);

    const changedOld = fullAutoUpdate(oldState);
    const { changed, group } = fullAutoUpdateWithGroups(newState);

    assert.equal(changed, changedOld, '"改了几个节点"的返回语义不变（调用方在看这个数字）');
    for (const id of Object.keys(oldState.nodes)) {
        assert.deepEqual(newState.nodes[id], oldState.nodes[id], `${id} 的字段逐字段相同`);
    }
    assert.equal(group.hasSynthesis, false, '没有合成节点 ⇒ 不跑组逻辑');
    assert.equal(group.working.size, 0, '倒推覆盖表为空（组那份 ≡ 自己那份）');
    assert.deepEqual(group.layers.map(l => l.layer), [GROUP_LEVELS[0]],
        '一发现没有合成节点就停（只留一个空壳层记录）');
});

test('无合成节点：computeGroupValues 不改任何节点、不改来源层', () => {
    const st = fixturePlain();
    const before = JSON.stringify({ nodes: st.nodes, childOrder: st.childOrder, sources: st.sources });
    computeGroupValues(st);
    assert.equal(JSON.stringify({ nodes: st.nodes, childOrder: st.childOrder, sources: st.sources }), before,
        '只读：连派生缓存字段都没被写（那是 fullAutoUpdate 的活）');
});

// ================================================================
// ② 组值 = (合成节点自己那份 + 列表成员各自那份) 再聚合；成员名单按树序
// ================================================================
test('组值 = 合并（不是"组头压过成员"）：status1 取或（纯算法层）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', status1: 0 });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 1 });
    add(st, 'm2', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 1 });
    const step = runGroupPasses(st, { type: 'P', baseOf: cacheOf });
    assert.equal(step.working.get('m1').status1, 1,
        'status1 取或：A(syn=0) ⊕ B(成员 1,1) → 1（合成节点自己走 A，成员走 B，merge 才相遇）');
    // ⚠️ 成员列表 = **映射列表**（只有成员原料，按树序），合成节点**不在里面** ——
    //    它通过 **A** 参与，不通过 B。见 `core/groupValue.js` 文件头 ⑤。
    assert.deepEqual(groupMemberOrder(st).get(SYNTH_PREFIX + 'g'), ['m1', 'm2'],
        '组内名单 = 映射列表（成员，树序）：合成节点**不在自己的成员列表里**');

    // A 与 B 是两套独立计算，只在 merge 那一步相遇：
    //   A = 合成节点自己那份；B = 成员各自那份按该字段聚合器折叠。
    // 或 / 取最大都满足交换律 ⇒ B 内部顺序只影响"名单"怎么读，不改结果。
    const a = st.nodes.syn.status1;
    const b = ['m1', 'm2'].map(id => st.nodes[id].status1).reduce((x, y) => (x || y) ? 1 : 0, 0);
    assert.equal(step.working.get('syn').status1, (a || b) ? 1 : 0, '与"A 与 B 再取或"逐位相同');
});

test('成员顺序起作用：映射列表就是 B 的输入集合（树序）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp' });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp', status2: 3 });
    add(st, 'm2', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp', status2: 4 });
    const step = runGroupPasses(st, { type: 'P', baseOf: cacheOf });
    assert.equal(step.working.get('m1').status2, 4, '组那份 = 非忽略里取最大 ⇒ 4');
    assert.equal(step.working.get('m2').status2, 4, '同一组的成员看到同一个组值');
    assert.equal(step.working.get('syn').status2, 4, '合成节点看自己那一组的组值（它走 A 参与）');

    // 只改树序（不改值）⇒ 映射列表跟着树序走
    // （`groupMemberOrder` 每次现算 —— `synthIndex` 不缓存顺序）
    // ⚠️ 名单里只有成员。
    st.childOrder.o = ['syn', 'm2', 'm1'];
    assert.deepEqual(groupMemberOrder(st).get(SYNTH_PREFIX + 'gp'), ['m2', 'm1'],
        '映射列表 = 树序（不是对象键序），且**不含合成节点自己**');
});

// ================================================================
// ③ status1 取或 / status2 preferReal
// ================================================================
test('status1 聚合 = 取或', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', status1: 0 });
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 0 });
    add(st, 'm2', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status1: 1 });
    assert.equal(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('m1').status1, 1,
        '组内有一个 1 ⇒ 1');

    st.nodes.m2.status1 = 0;
    assert.equal(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('m1').status1, 0,
        '全 0 ⇒ 0');
});

test('status2 聚合 = preferReal（成员里的忽略不压过真实档位；全为忽略才是 5）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'g', status2: 3 });   // 赛后补题
    add(st, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'g', status2: 5 });  // 忽略
    assert.equal(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('syn').status2, 3,
        'preferReal：只在非忽略档位里取最大 ⇒ [3,5] → 3（忽略不压过真实档位）');

    // ⚠️ **特例**：合成头**自己那份**是忽略 ⇒ 整组 5（盖过其他）。
    //    细则与"自己=5 / 成员=3 ⇒ 5"在 `groupSynthAgg.test.js` 里钉死。
    st.nodes.syn.status2 = 5;
    assert.equal(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('syn').status2, 5,
        '合成头自己=忽略 ⇒ 整组 5（特意保留的特例，不走 preferReal 的"取最大"）');

    st.nodes.m1.status2 = 5;
    assert.equal(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('syn').status2, 5,
        '全为忽略才是 5');

    // 对照：字面语义（`preferReal:false`，即 `makeStatus2Agg` 的**默认值**）会给 5
    // —— 这条把"调用方必须显式传 `preferReal:true`"钉住（`groupCount.js:92`）。
    st.nodes.syn.status2 = 3;
    st.nodes.m1.status2 = 5;
    const literal = makeStatus2Agg(n => n.status2).combine(5, 3);
    assert.equal(literal, 5, '默认（字面语义）下 [5,3] → 5');
    assert.notEqual(runGroupPasses(st, { type: 'P', baseOf: cacheOf }).working.get('m1').status2, literal,
        '我们走的是 preferReal:true ⇒ 成员侧那份不是字面语义的那个 5');
});

test('只有 C/P 参与 status1/status2 聚合（R 不参与）', () => {
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'syn', 'R', 'o', { synthKey: SYNTH_PREFIX + 'gr', status2: 3, status1: 1 });
    add(st, 'm1', 'R', 'o', { ownerSynth: SYNTH_PREFIX + 'gr', status2: 5, status1: 0 });
    const step = runGroupPasses(st, { type: 'R', baseOf: cacheOf });
    assert.equal(step.hasSynthesis, true, '树里确实有合成节点');
    assert.equal(step.layers[0].groups, 0, 'R 这一层不叠 status 字段 ⇒ 组值一个都不算');
    assert.equal(step.working.size, 0, 'R 不参与 status1/status2 的聚合 ⇒ 不产生倒推覆盖');

    const st2 = makeState();
    add(st2, 'o', 'O');
    add(st2, 'syn', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp', status1: 0 });
    add(st2, 'm1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp', status1: 1 });
    assert.ok(runGroupPasses(st2, { type: 'P', baseOf: cacheOf }).working.size > 0,
        'P 参与聚合 ⇒ 有倒推覆盖');
});

// ================================================================
// ④ 绝不写回来源层（§6.6 第 10 条：来源条目数不变）
// ================================================================
test('组值 / 两列值都不写回来源层：来源条目数与内容逐字段不变', () => {
    const st = fixtureSynth();
    // 再加点来源层的东西：一条客观导入值 + 一条别的账户的手改覆盖
    st.nodes.r1.values = { status: [{ v: 'WA', src: 'qoj:x', at: 'T2' }] };
    st.nodes.p1.values = {
        status1: [manual('1', 'k1', 'T1')],
        status2: [manual('5', 'k1', 'T1')]
    };
    fullAutoUpdate(st);                       // 先把缓存字段算好
    clearDerivedMemo();
    clearGroupMemo();
    const before = snapshotSources(st);
    const nodeFieldsBefore = JSON.stringify(st.nodes);

    // ---- 反复读两列值（含两种计数模式、两个账户范围）----
    for (const mode of [MODE_PLAIN, MODE_DEDUP]) {
        for (const account of ['k1', 'local']) {
            st.settings = { stats: { countMode: mode } };
            st.viewingAccountId = account;
            clearDerivedMemo();
            clearGroupMemo();
            for (const field of ['status1', 'status2']) {
                for (const id of Object.keys(st.nodes)) {
                    viewDerived(st, st.nodes[id], field);
                    viewDerived(st, st.nodes[id], field, { column: 'group' });
                }
            }
            computeGroupValues(st);
        }
    }

    const after = snapshotSources(st);
    assert.deepEqual(after, before, '来源层（每个节点的 node.values + 来源表）逐字段不变');
    assert.equal(after.entryCount, before.entryCount, `来源条目数不变（${before.entryCount}）`);
    assert.equal(JSON.stringify(st.nodes), nodeFieldsBefore,
        '**连缓存字段都没被写**：组值不物化到 node 上（只是派生）');
});

test('组值不写回 ⇒ 不会震荡：连算三次结果稳定', () => {
    const st = fixtureSynth();
    clearGroupMemo();
    const a = groupValueOf(st, st.nodes.p2, 'status2');
    clearGroupMemo();
    const b = groupValueOf(st, st.nodes.p2, 'status2');
    clearGroupMemo();
    const c = groupValueOf(st, st.nodes.p2, 'status2');
    assert.equal(a, 3, '组那份：synP=0 / p1=2 / p2=3 ⇒ 3');
    assert.equal(b, a, '第二次同值');
    assert.equal(c, a, '第三次同值 —— 若把组值写回 node，这里会漂移');
});

// ================================================================
// ⑤ viewDerived：不给 `{ column:'group' }` ⇒ 与 `derivedOf` 逐字段相等
// ================================================================
test('viewDerived 不给 column ⇒ 与 derivedOf 逐字段相等（回归底线）', () => {
    const st = fixtureSynth();
    st.viewingAccountId = 'k1';
    const opts = { viewingAccountId: 'k1' };
    const fields = ['status1', 'status2', 'acTime', 'lastSubmitTime', 'xcpcDifficulty',
        'statusComplete1', 'statusComplete2'];
    for (const id of Object.keys(st.nodes)) {
        for (const field of fields) {
            assert.deepEqual(
                viewDerived(st, st.nodes[id], field),
                derivedOf(st, st.nodes[id], field, { viewingAccount: 'k1' }),
                `${id}.${field}：不给 column 时必须与 derivedOf 逐字段相等`
            );
            assert.deepEqual(
                viewDerived(st, st.nodes[id], field, { column: 'own' }),
                viewDerived(st, st.nodes[id], field),
                `${id}.${field}：column:'own' 与不给 column 等价`
            );
        }
    }
    assert.deepEqual(opts, { viewingAccountId: 'k1' }, '测试自己没改 opts 对象');
});

test('viewDerived({ column:\'group\' }) 给的是组那份', () => {
    const st = fixtureSynth();
    st.nodes.p1.values = { status1: [manual('1', 'k1', 'T1')] };
    st.nodes.p2.values = { status1: [manual('0', 'k1', 'T1')] };
    st.nodes.synP.values = { status1: [manual('0', 'k1', 'T1')] };
    st.viewingAccountId = 'k1';
    clearDerivedMemo();
    clearGroupMemo();
    assert.equal(viewDerived(st, st.nodes.p2, 'status1'), 0, '自己那份：p2 没处理');
    assert.equal(viewDerived(st, st.nodes.p2, 'status1', { column: 'group' }), 1,
        '组那份：这一组里 p1 处理过 ⇒ 1');
    assert.equal(viewDerived(st, st.nodes.synP, 'status1', { column: 'group' }), 1,
        '合成节点也看组那份（它自己那条是 0，组里 p1 是 1）');
    // 不聚合的字段 ⇒ 组那份退回自己那份
    assert.equal(viewDerived(st, st.nodes.p1, 'name', { column: 'group' }),
        viewDerived(st, st.nodes.p1, 'name'));
    // 虚拟节点没有"组"这回事（它不在 state.nodes 里）
    const v = { id: 'v1', type: 'P', _virtual: true, _pageId: 'pg', _virtualId: 'v1', _refId: 'p1' };
    assert.deepEqual(viewDerived(st, v, 'status1', { column: 'group' }), viewDerived(st, v, 'status1'));
});

// ================================================================
// ⑥ 倒推覆盖：成员原料能看到"它所属组的组值"
// ================================================================
test('倒推覆盖：成员原料能看到所属组的组值（跨父成员也算）', () => {
    const st = fixtureSynth();
    st.viewingAccountId = 'k1';
    clearGroupMemo();
    const g = groupComputed(st);
    assert.equal(g.hasSynthesis, true);
    assert.equal(g.working.get('p2').status2, 3, 'p2 的倒推覆盖 = 它所属组（synP + p1 + p2）的组值');
    assert.equal(g.working.get('p1').status2, 3, '同组成员拿到同一个组值');
    assert.equal(g.working.get('synP').status2, 3, '合成节点自己也在组里');
    // 跨父成员：synP 与 p2 不同父，仍然同组
    assert.notEqual(st.parentOf['p2'], st.parentOf['synP']);
    assert.equal(g.working.get('c1').status2, undefined, 'c1 不是 gp 组的成员（不在名单里）');
});

test('倒推覆盖参与上一层派生：容器 statusComplete2 按组那份算', () => {
    const st = fixtureSynth();
    st.viewingAccountId = 'k1';
    clearGroupMemo();
    clearDerivedMemo();
    const withTable = buildDerivedTable(st, { group: groupComputed(st).working });

    // ⚠️ **节点"自己那份"不被组值改写**（两列值的前提）：
    //    p1 下面挂着 WA 的 R ⇒ 自己那份 status2 = 2，即使组那份是 3。
    assert.equal(withTable.get('p1').status2, 2, 'p1 自己那份 = 2（组那份 3 不改写它）');
    assert.equal(withTable.get('p2').status2, 3, 'p2 自己那份本来就是 3（下面有 AC 的 R）');

    // 倒推覆盖落在**容器汇总**上：c1 是 C，它汇总子 P 时用"组那份"
    assert.equal(typeof withTable.get('c1').statusComplete2, 'number');

    // 对照组：不给覆盖表 ⇒ 全是"自己那份"，逐字段一致
    clearDerivedMemo();
    const withoutTable = buildDerivedTable(st, {});
    for (const id of Object.keys(st.nodes)) {
        for (const field of ['status1', 'status2', 'statusComplete1', 'statusComplete2']) {
            const row = withoutTable.get(id);
            if (row && row[field] !== undefined) {
                assert.deepEqual(row[field], derivedOf(st, st.nodes[id], field, {}),
                    `${id}.${field}：不给 group ⇒ 与 derivedOf 一致`);
            }
        }
    }
});

test('倒推覆盖确实改了上一层的输入：只有组里别人过时，容器才算"过"', () => {
    // p2 自己没提交（自己那份 0），但同组的 p1 过了 ⇒ 组那份 3。
    // c1 汇总子树里的 P 时读到的是**组那份** ⇒ c1 = 3（全部通过）。
    const st = makeState();
    add(st, 'o', 'O');
    add(st, 'synP', 'P', 'o', { synthKey: SYNTH_PREFIX + 'gp' });
    add(st, 'p1', 'P', 'o', { ownerSynth: SYNTH_PREFIX + 'gp' });
    add(st, 'r1', 'R', 'p1', { status: 'AC' });
    add(st, 'c1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    add(st, 'p2', 'P', 'c1', { ownerSynth: SYNTH_PREFIX + 'gp' });
    st.nodes.p1.values = { status1: [manual('1', 'k1', 'T1')] };
    st.nodes.p2.values = { status1: [manual('0', 'k1', 'T1')] };
    st.nodes.synP.values = { status1: [manual('0', 'k1', 'T1')] };
    st.viewingAccountId = 'k1';
    clearGroupMemo();
    clearDerivedMemo();

    const own = buildDerivedTable(st, {});
    assert.equal(own.get('p2').status2, 0, '自己那份：p2 没提交过');
    assert.equal(own.get('c1').statusComplete2, 0, '不给组值：c1 子树里没有"过"的题');

    clearDerivedMemo();
    const grouped = buildDerivedTable(st, { group: groupComputed(st).working });
    assert.equal(grouped.get('p2').status2, 0, 'p2 自己那份不变（两列值的前提）');
    assert.equal(grouped.get('c1').statusComplete2, 3,
        '容器按组那份汇总：同组的 p1 过了 ⇒ c1 全部通过（倒推覆盖参与上层读取）');
});

// ================================================================
// ⑦ 计数模式：读全局设置，缺省 plain
// ================================================================
test('计数模式来自 state.settings.stats.countMode（缺省 / 非法 = plain）', () => {
    const st = fixtureSynth();
    assert.doesNotThrow(() => groupValueOf(st, st.nodes.p2, 'status2'));
    st.settings = { stats: { countMode: MODE_DEDUP } };
    clearGroupMemo();
    assert.equal(groupValueOf(st, st.nodes.p2, 'status2'), 3, 'dedup 模式下组值不变（组值本来就按组算）');
    st.settings = { stats: { countMode: 'bogus' } };
    clearGroupMemo();
    assert.equal(groupValueOf(st, st.nodes.p2, 'status2'), 3, '非法模式回落 plain，行为不变');
});

// ================================================================
// ⑧ 记忆化 / 只读
// ================================================================
test('组表按 (nodes 引用, childOrder 引用, 账户, 计数模式) 记忆化；换引用就重算', () => {
    const st = fixtureSynth();
    clearGroupMemo();
    const a = groupComputed(st);
    assert.equal(groupComputed(st), a, '同一份数据 + 同一范围 ⇒ 同一份结果（渲染里会被调上万次）');

    const changed = { ...st, nodes: { ...st.nodes } };
    assert.notEqual(groupComputed(changed), a, 'nodes 引用变了 ⇒ 重算（Immer 下任何改动都会换引用）');

    clearGroupMemo();
    const base = groupComputed(st);
    st.settings = { stats: { countMode: MODE_DEDUP } };
    assert.notEqual(groupComputed(st), base, '计数模式变了 ⇒ 重算');
});

test('三趟编排只读：跑一遍不改输入（含来源层）', () => {
    const st = fixtureSynth();
    clearGroupMemo();
    const before = JSON.stringify(st);
    groupComputed(st);
    computeGroupValues(st);
    runGroupPasses(st, { type: 'P', baseOf: cacheOf });
    assert.equal(JSON.stringify(st), before, '输入逐字节不变（组值是派生，绝不写回）');
});
