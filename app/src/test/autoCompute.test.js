// ================================================================
// 自动计算测试
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    computePacTime,
    computePlastSubmitTime,
    computePstatus2,
    computePxcpcDifficulty,
    computeContainerStatusComplete1,
    computeContainerStatusComplete2
} from '../core/autoComputeRules.js';
import { autoUpdateNode, fullAutoUpdate, propagateUp, autoUpdateSubtree } from '../core/autoCompute.js';
import { setDerivedOverride } from '../core/fieldValue.js';

/** 来源层里的一条**手改覆盖**（`status2` 的覆盖值只有 1/4/5，见 elements.js 的 pinValues） */
function manual(v, account, at) {
    return { v, src: 'manual', at, account };
}

// ---- 辅助：构造 state ----
function makeState() {
    return {
        rootId: null,
        nodes: {},
        childOrder: {},
        parentOf: {}
    };
}

function addNode(state, id, type, parentId = null, extra = {}) {
    state.nodes[id] = { id, type, lastModified: '', ...extra };
    state.childOrder[id] = [];
    if (parentId === null) {
        state.rootId = id;
        state.parentOf[id] = null;
    } else {
        state.childOrder[parentId].push(id);
        state.parentOf[id] = parentId;
    }
}

// ---- computePacTime ----
test('computePacTime 无 R 返回占位', () => {
    const s = makeState();
    addNode(s, 'p1', 'P');
    assert.equal(computePacTime(s, s.nodes['p1']), '----.--.-- --:--');
});

test('computePacTime 返回最早 AC 时间', () => {
    const s = makeState();
    addNode(s, 'p1', 'P');
    addNode(s, 'r1', 'R', 'p1', { time: '2025.03.01 10:00', status: 'AC' });
    addNode(s, 'r2', 'R', 'p1', { time: '2025.01.15 10:00', status: 'AC' });
    addNode(s, 'r3', 'R', 'p1', { time: '2025.02.01 10:00', status: 'WA' });
    assert.equal(computePacTime(s, s.nodes['p1']), '2025.01.15 10:00');
});

test('computePacTime 忽略非 AC 提交', () => {
    const s = makeState();
    addNode(s, 'p1', 'P');
    addNode(s, 'r1', 'R', 'p1', { time: '2025.01.15 10:00', status: 'WA' });
    assert.equal(computePacTime(s, s.nodes['p1']), '----.--.-- --:--');
});

// ---- computePlastSubmitTime ----
test('computePlastSubmitTime 返回最新时间', () => {
    const s = makeState();
    addNode(s, 'p1', 'P');
    addNode(s, 'r1', 'R', 'p1', { time: '2025.01.15 10:00', status: 'AC' });
    addNode(s, 'r2', 'R', 'p1', { time: '2025.03.01 12:00', status: 'WA' });
    assert.equal(computePlastSubmitTime(s, s.nodes['p1']), '2025.03.01 12:00');
});

// ---- computePstatus2 ----
test('computePstatus2 无 R 返回 0', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 0 });
    assert.equal(computePstatus2(s, s.nodes['p1']), 0);
});

test('computePstatus2 无 R 但覆盖"待写"(1) → 保留 1', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 1, values: { status2: [manual('1', 'k1', 'T1')] } });
    assert.equal(computePstatus2(s, s.nodes['p1']), 1);
});

test('computePstatus2 有 R 无 AC 返回 2', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 0 });
    addNode(s, 'r1', 'R', 'p1', { status: 'WA' });
    assert.equal(computePstatus2(s, s.nodes['p1']), 2);
});

test('computePstatus2 有 AC 返回 3', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 0 });
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    assert.equal(computePstatus2(s, s.nodes['p1']), 3);
});

test('computePstatus2 有 AC 且覆盖"赛时通过"(4) → 保留 4', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 4, values: { status2: [manual('4', 'k1', 'T1')] } });
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    assert.equal(computePstatus2(s, s.nodes['p1']), 4);
});

// ⚠️ 手改值为忽略时，自动计算不能抛开手改值
test('computePstatus2 覆盖"忽略"(5) → 无条件保留（哪怕有 AC）', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 5, values: { status2: [manual('5', 'k1', 'T1')] } });
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    assert.equal(computePstatus2(s, s.nodes['p1']), 5, '忽略是用户按下的，自动计算不许推翻它');
});

// ---- 覆盖只从**来源层**来（缓存字段不是覆盖的来源）----
// `computePstatus2` 拿 `node.status2`（缓存字段）当覆盖不行 —— 缓存只有一份，
// 多账户下会把**别人**的覆盖当成我的。
test('computePstatus2：覆盖按**当前账户**取，别人的忽略不算我的', () => {
    const s = makeState();
    // 缓存里躺着 5（队友那次投影写下的），来源层那条覆盖属于 k2
    addNode(s, 'p1', 'P', null, { status2: 5, values: { status2: [manual('5', 'k2', 'T1')] } });
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    s.currentAccountId = 'k1';
    assert.equal(computePstatus2(s, s.nodes['p1']), 3,
        'k1 名下的自动计算不该继承 k2 的"忽略"（缓存字段说了不算）');
    s.currentAccountId = 'k2';
    assert.equal(computePstatus2(s, s.nodes['p1']), 5, '换到 k2 就该是 5');
});

test('computePstatus2：缓存里是 5 但来源层没有覆盖 → 按算出来的值（没有老数据）', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 5 });            // 光有缓存字段、来源层空
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    assert.equal(computePstatus2(s, s.nodes['p1']), 3, '覆盖只从来源层来（没有老数据：读路径不留回退兜底）');
});

test('自动算出来的 status2 **不会**被记成手改（只有覆盖值才进来源层）', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { status2: 0, values: {} });
    addNode(s, 'r1', 'R', 'p1', { status: 'AC' });
    addNode(s, 'r2', 'R', 'p1', { status: 'WA' });
    const p = s.nodes['p1'];
    assert.equal(computePstatus2(s, p), 3);
    s.currentAccountId = 'k1';
    // 走应用真正的入口写状态：3 不是覆盖值 ⇒ 不许留下 manual 来源值
    setDerivedOverride(p, 'status2', 3, { at: 'T2', account: 'k1' });
    assert.deepEqual(p.values.status2 || [], [], '算出来的值不记 manual');
    // 而覆盖值（5）要记
    setDerivedOverride(p, 'status2', 5, { at: 'T3', account: 'k1' });
    assert.equal(p.values.status2.length, 1);
    assert.equal(p.values.status2[0].src, 'manual');
    assert.equal(p.values.status2[0].v, '5');
});

// ---- computePxcpcDifficulty ----
test('computePxcpcDifficulty 空 / "-" → "-"', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { ratio: '' });
    addNode(s, 'p2', 'P', null, { ratio: '-' });
    addNode(s, 'p3', 'P', null, {});
    assert.equal(computePxcpcDifficulty(s, s.nodes['p1']), '-');
    assert.equal(computePxcpcDifficulty(s, s.nodes['p2']), '-');
    assert.equal(computePxcpcDifficulty(s, s.nodes['p3']), '-');
});

test('computePxcpcDifficulty 由 ratio 派生出等级', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { ratio: '28.19' });
    // 28.19% 落在 [25, 30) → 铜牌-（见 A_constants.js 的 XCPC_THRESHOLDS）
    assert.equal(computePxcpcDifficulty(s, s.nodes['p1']), '铜牌-');
});

test('computePxcpcDifficulty 容忍带 % 的 ratio（与 updateP 同口径）', () => {
    const s = makeState();
    addNode(s, 'p1', 'P', null, { ratio: '28.19%' });
    assert.equal(computePxcpcDifficulty(s, s.nodes['p1']), '铜牌-');
});

test('fullAutoUpdate 会补上导入遗漏的 xcpcDifficulty', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    // 模拟 upsert 建出来的节点：只有 ratio，xcpcDifficulty 还是默认的 '-'
    addNode(s, 'p', 'P', 'c', { ratio: '1.72', xcpcDifficulty: '-' });

    fullAutoUpdate(s);

    assert.notEqual(s.nodes['p'].xcpcDifficulty, '-');
    assert.equal(s.nodes['p'].xcpcDifficulty, computePxcpcDifficulty(s, s.nodes['p']));
});

// ---- computeContainerStatusComplete1 ----
test('container1 无 P 返回 0', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    assert.equal(computeContainerStatusComplete1(s, s.nodes['c1']), 0);
});

test('container1 全 status1=1 返回 1', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    addNode(s, 'p1', 'P', 'c1', { status1: 1 });
    addNode(s, 'p2', 'P', 'c1', { status1: 1 });
    assert.equal(computeContainerStatusComplete1(s, s.nodes['c1']), 1);
});

test('container1 有 P 未处理返回 0', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    addNode(s, 'p1', 'P', 'c1', { status1: 1 });
    addNode(s, 'p2', 'P', 'c1', { status1: 0 });
    assert.equal(computeContainerStatusComplete1(s, s.nodes['c1']), 0);
});

// ---- computeContainerStatusComplete2 ----
test('container2 无 P 返回 0', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    assert.equal(computeContainerStatusComplete2(s, s.nodes['c1']), 0);
});

test('container2 全通过返回 3', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    addNode(s, 'p1', 'P', 'c1', { status2: 3 });
    addNode(s, 'p2', 'P', 'c1', { status2: 4 });
    assert.equal(computeContainerStatusComplete2(s, s.nodes['c1']), 3);
});

test('container2 全处理但未全通过返回 2', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    addNode(s, 'p1', 'P', 'c1', { status2: 3, status1: 1 });
    addNode(s, 'p2', 'P', 'c1', { status2: 5, status1: 1 });
    assert.equal(computeContainerStatusComplete2(s, s.nodes['c1']), 2);
});

test('container2 部分通过返回 1', () => {
    const s = makeState();
    addNode(s, 'c1', 'C');
    addNode(s, 'p1', 'P', 'c1', { status2: 3 });
    addNode(s, 'p2', 'P', 'c1', { status2: 0 });
    assert.equal(computeContainerStatusComplete2(s, s.nodes['c1']), 1);
});

test('container2 statusComplete2=4 保留', () => {
    const s = makeState();
    addNode(s, 'c1', 'C', null, { statusComplete2: 4 });
    addNode(s, 'p1', 'P', 'c1', { status2: 0 });
    assert.equal(computeContainerStatusComplete2(s, s.nodes['c1']), 4);
});

// ---- fullAutoUpdate ----
test('fullAutoUpdate 后序重算整棵树', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'w', 'W', 'o', { name: '平台' });
    addNode(s, 's', 'S', 'w', { name: '系列' });
    addNode(s, 'c', 'C', 's', { name: '比赛' });
    addNode(s, 'p', 'P', 'c', { status1: 0, status2: 0 });
    addNode(s, 'r', 'R', 'p', { time: '2025.01.15 10:00', status: 'AC' });

    fullAutoUpdate(s);

    assert.equal(s.nodes['p'].status2, 3);
    assert.equal(s.nodes['p'].acTime, '2025.01.15 10:00');
    assert.equal(s.nodes['c'].statusComplete2, 3);
    assert.equal(s.nodes['s'].statusComplete2, 3);
    assert.equal(s.nodes['w'].statusComplete2, 3);
});

// ---- propagateUp ----
test('propagateUp 从 R 向上传播', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'c', 'C', 'o');
    addNode(s, 'p', 'P', 'c');
    addNode(s, 'r', 'R', 'p', { time: '2025.01.15 10:00', status: 'AC' });

    // 手动改 R 时间后传播
    propagateUp(s, 'r');

    assert.equal(s.nodes['p'].status2, 3);
    assert.equal(s.nodes['c'].statusComplete2, 3);
});

// ---- autoUpdateSubtree ----
test('autoUpdateSubtree 只更新子树', () => {
    const s = makeState();
    addNode(s, 'o', 'O');
    addNode(s, 'w1', 'W', 'o');
    addNode(s, 'w2', 'W', 'o', { statusComplete2: 0 });
    addNode(s, 'c1', 'C', 'w1');
    addNode(s, 'p1', 'P', 'c1', { status2: 0 });
    addNode(s, 'r1', 'R', 'p1', { time: '2025.01.15 10:00', status: 'AC' });

    autoUpdateSubtree(s, 'w1');

    assert.equal(s.nodes['p1'].status2, 3);
    assert.equal(s.nodes['c1'].statusComplete2, 3);
    assert.equal(s.nodes['w1'].statusComplete2, 3);
    // w2 不在 w1 子树内，未被更新
    assert.equal(s.nodes['w2'].statusComplete2, 0);
});