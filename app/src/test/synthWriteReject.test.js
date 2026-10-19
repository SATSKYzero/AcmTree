// ================================================================
// 合成写路径的**四条拒绝**（core/ops/synth.js）
//
// 口径："这些该直接拒绝操作。" 读路径只在坏数据可见处补**警告**，
// 它只管"文件里已经躺着的坏数据"（读档时没法拒绝，只能报）。相应地：
//
//   写路径（绑定 / 归入 / 新建 / 改标识 / 导入两阶段）**直接拒绝**产生坏数据 ——
//   抛错 = 事务回滚 = 什么都没改。四条：
//     ① 目标 `synthKey` 不存在（悬空指针不能由操作产生）
//     ② 写的是**节点 id** 而不是 `synthKey`（一律只认 synthKey）
//     ③ 目标标识**已被别的节点占用**（两个节点不许共用一个标识）
//     ④ 成员**不在树上**（从 rootId 走不到 ⇒ 归入它没有意义）
//     ⑤ **合成节点不能当成员**（它自己就是组头 ⇒ 成员名单不能嵌套）
//        —— 导入的 plan 层挡不住它（`setOwnerRaw` 能绕过去）；
//           校验收在 `assertOwnerTarget`（唯一一处），导入与手改同一套判据。
//
// 本文件钉两件事（缺一不可）：
//   · **拒绝得住**：每条都抛错（文案含可辨识关键词），且状态**逐字段不变**；
//   · **不误伤**：合法操作（建 / 归入 / 改名 / 解绑 / 导入两阶段 / 解绑不在树上的节点）
//     一个都不能被拒 —— 这条比"拒绝得住"更重要。
// 外加一条回归锚：历史坏数据（直接构造、绕过 ops）读路径仍然**只警告、不抛错**。
//
// 依赖：core/ops/synth.js + core/query/groupCount.js（都能进纯 Node 单测）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    createSynthNode,
    assignSynthKey,
    bindOwner,
    unbindOwner,
    setOwnerRaw,
    applyOwnerSynth,
    isSynthKeyTaken,
    synthIndex,
    synthMembers,
    synthMembersTable,
    synthKeyOf,
    ownerSynthOf,
    findDanglingOwners
} from '../core/ops/synth.js';
import { collectGroups } from '../core/query/groupCount.js';

/**
 * 一棵**结构合法**的假树（与 synthOps.test.js 同一形状）：
 *   root(O) → w1(W) → s1(S) → c1/c2/c3(C)，c1 → ps(P) → r1(R)
 * 合成节点自己也是普通节点，挂"允许放这种类型"的父亲下：C 的合成挂 S，P 的合成挂 C，
 * R 的合成挂 P（见 `TYPE_CHILDREN_MAP`）。
 */
function makeState() {
    return {
        rootId: 'root',
        currentAccountId: 'local',
        viewingAccountId: 'local',
        meta: { idCounter: 0 },
        nodes: {
            root: { id: 'root', type: 'O', name: '根', ownerSynth: '', synthKey: '' },
            w1: { id: 'w1', type: 'W', name: '比赛甲', ownerSynth: '', synthKey: '' },
            s1: { id: 's1', type: 'S', name: '系列甲', ownerSynth: '', synthKey: '' },
            c1: { id: 'c1', type: 'C', name: '渠道甲', ownerSynth: '', synthKey: '', extKey: 'cf:1' },
            c2: { id: 'c2', type: 'C', name: '渠道乙', ownerSynth: '', synthKey: '', extKey: 'qoj:1' },
            c3: { id: 'c3', type: 'C', name: '渠道丙', ownerSynth: '', synthKey: '' },
            ps: { id: 'ps', type: 'P', name: 'A 题', ownerSynth: '', synthKey: '' },
            r1: { id: 'r1', type: 'R', name: '', ownerSynth: '', synthKey: '', extKey: 'cf:1:s1' }
        },
        childOrder: {
            root: ['w1'], w1: ['s1'], s1: ['c1', 'c2', 'c3'],
            c1: ['ps'], c2: [], c3: [], ps: ['r1'], r1: []
        },
        parentOf: {
            w1: 'root', s1: 'w1', c1: 's1', c2: 's1', c3: 's1',
            ps: 'c1', r1: 'ps'
        }
    };
}

/** 逐字段快照（"拒绝 = 什么都没改"就靠它比） */
const snap = s => JSON.stringify(s);

/** 捕获 `console.warn`（本项目既有的日志出口）—— 证明读路径"只警告、不抛错" */
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

// ================================================================
// 四条拒绝：抛错 + 关键词 + 状态逐字段不变
// ================================================================

test('拒绝①：目标 synthKey 不存在（悬空）—— 三个写入口全抛，状态一个字段都没改', () => {
    const s = makeState();
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    const before = snap(s);

    assert.throws(() => bindOwner(s, 'c2', 'ghost'), /不存在/, 'bindOwner');
    assert.throws(() => applyOwnerSynth(s, s.nodes.c2, 'ghost'), /不存在/, 'applyOwnerSynth');
    assert.throws(() => setOwnerRaw(s, 'c2', 'ghost'), /不存在/, 'setOwnerRaw（导入第二阶段）');

    assert.equal(snap(s), before, '拒绝 = 什么都没改（绝不留下半个指针）');
});

test('拒绝②：写的是节点 id 而不是 synthKey —— 文案点名"要写 synthKey"', () => {
    const s = makeState();
    const synth = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    const before = snap(s);

    // 三个入口都要抛，且文案必须让人看懂"你要写的是另一个值"
    const isNodeIdError = (err) => /节点 id/.test(err.message)
        && /synthKey/.test(err.message)
        && err.message.includes('k1');
    assert.throws(() => bindOwner(s, 'c2', synth.id), isNodeIdError, 'bindOwner');
    assert.throws(() => applyOwnerSynth(s, s.nodes.c2, synth.id), isNodeIdError, 'applyOwnerSynth');
    assert.throws(() => setOwnerRaw(s, 'c2', synth.id), isNodeIdError, 'setOwnerRaw');

    assert.equal(snap(s), before, '拒绝 = 什么都没改');
});

test('拒绝③：合成标识被别的节点占用 —— 新建 / 改标识都抛，且判据只有一处', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    const b = createSynthNode(s, 's1', { type: 'C', synthKey: 'k2', name: '乙' });
    const before = snap(s);

    assert.throws(() => createSynthNode(s, 's1', { type: 'C', synthKey: 'k1' }), /已被占用/, '新建');
    assert.throws(() => assignSynthKey(s, b.id, 'k1'), /已被占用/, '改标识');
    assert.equal(snap(s), before, '拒绝 = 什么都没改');

    // ★ 判据只有一个：`isSynthKeyTaken`（判重页的 createAndJoin 也调它）
    assert.equal(isSynthKeyTaken(s, 'k1'), true);
    assert.equal(isSynthKeyTaken(s, 'k1', a.id), false, '自己不算占用（改自己的标识是合法的）');
    assert.equal(isSynthKeyTaken(s, 'k2', b.id), false);
    assert.equal(isSynthKeyTaken(s, 'nope'), false);
    assert.equal(isSynthKeyTaken(s, '   '), false, '空标识 = 还没给，不算被占用');
    // 与真正建出来的表口径一致
    assert.equal(isSynthKeyTaken(s, 'k1'), synthIndex(s).byKey.has('k1'));
});

test('拒绝④：成员不在树上（从根走不到）—— 归入它没有意义', () => {
    const s = makeState();
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    // 半拉子节点：在 `nodes` 表里，但 parentOf / childOrder 都链不到根
    s.nodes.orphan = { id: 'orphan', type: 'C', name: '孤儿', ownerSynth: '', synthKey: '' };
    const before = snap(s);

    assert.throws(() => bindOwner(s, 'orphan', 'k1'), /不在树上/, 'bindOwner');
    assert.throws(() => applyOwnerSynth(s, s.nodes.orphan, 'k1'), /不在树上/, 'applyOwnerSynth');
    assert.throws(() => setOwnerRaw(s, 'orphan', 'k1'), /不在树上/, 'setOwnerRaw');

    assert.equal(snap(s), before, '拒绝 = 什么都没改');
    // 反向：**解绑**永远允许（把指针清掉不会写坏数据，哪怕节点不在树上）
    assert.equal(setOwnerRaw(s, 'orphan', ''), '');
    assert.equal(ownerSynthOf(s.nodes.orphan), '');
});

test('拒绝⑤：合成节点不能当成员（它自己就是组头）—— 三个写入口全抛', () => {
    const s = makeState();
    const k1 = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k2', name: '乙' });
    const before = snap(s);

    assert.throws(() => bindOwner(s, k1.id, 'k2'), /成员名单不能嵌套/, 'bindOwner');
    assert.throws(() => applyOwnerSynth(s, s.nodes[k1.id], 'k2'), /成员名单不能嵌套/, 'applyOwnerSynth');
    assert.throws(() => setOwnerRaw(s, k1.id, 'k2'), /成员名单不能嵌套/, 'setOwnerRaw');

    assert.equal(snap(s), before, '拒绝 = 什么都没改');
});

// ================================================================
// 反向锚（最重要）：合法操作一个都不能被误拒
// ================================================================
test('反向锚：建 / 归入 / 改名 / 解绑 全都要通过（C、P、R 三种成员各来一遍）', () => {
    const s = makeState();

    // 建 + 归入（C）
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    bindOwner(s, 'c1', 'k1');
    bindOwner(s, 'c2', 'k1');
    assert.equal(ownerSynthOf(s.nodes.c1), 'k1');
    assert.equal(ownerSynthOf(s.nodes.c2), 'k1');
    assert.deepEqual(synthMembers(s, 'k1'), ['c1', 'c2'], '（顺带）成员按树序');

    // 改标识：成员指针同事务跟着改
    const r = assignSynthKey(s, a.id, 'k1-new');
    assert.equal(r.moved, 2);
    assert.equal(ownerSynthOf(s.nodes.c1), 'k1-new');
    assert.equal(ownerSynthOf(s.nodes.c2), 'k1-new');

    // 解绑：节点还在，只是不在名单里
    unbindOwner(s, 'c1');
    assert.equal(ownerSynthOf(s.nodes.c1), '');
    assert.equal(s.nodes.c1 !== undefined, true);

    // P 的合成挂 C、R 的合成挂 P —— 合法父类型与合法成员一起过
    createSynthNode(s, 'c1', { type: 'P', synthKey: 'kP', name: '题合成' });
    bindOwner(s, 'ps', 'kP');
    createSynthNode(s, 'ps', { type: 'R', synthKey: 'kR', name: '提交合成' });
    bindOwner(s, 'r1', 'kR');
    assert.equal(ownerSynthOf(s.nodes.ps), 'kP');
    assert.equal(ownerSynthOf(s.nodes.r1), 'kR');

    // 自动标识（不传 synthKey）也是合法路径
    const auto = createSynthNode(s, 's1', { type: 'C' });
    assert.equal(synthKeyOf(auto).startsWith('synth:'), true);

    assert.deepEqual(findDanglingOwners(s), [], '★ 一路合法操作下来，树上没有一条悬空指针');
});

test('反向锚：setOwnerRaw（导入第二阶段）指向已存在的合成节点照写，空值 = 解绑', () => {
    const s = makeState();
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });

    assert.equal(setOwnerRaw(s, 'c2', 'k1'), 'k1', '目标已存在（第一阶段已落地）⇒ 照写');
    assert.equal(ownerSynthOf(s.nodes.c2), 'k1');
    assert.equal(setOwnerRaw(s, 'c2', ''), '', '空值 = 解绑，任何时刻都允许');
    assert.equal(ownerSynthOf(s.nodes.c2), '');
});

test('反向锚：改自己的标识（值没变 / 换成没被占用的）都不算"被占用"', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    assert.equal(assignSynthKey(s, a.id, 'k1').moved, 0, '改成自己 = 幂等，不抛');
    assert.equal(assignSynthKey(s, a.id, 'k9').to, 'k9', '换成没被占用的照过');
    assert.equal(synthKeyOf(a), 'k9');
});

// ================================================================
// 历史坏数据（直接构造 state，绕过 ops）：读路径只警告 + 单元素组，**不抛错**
//
// 口径："警告只保留给已经躺在存档/文件里的历史数据（读档时没法拒绝，只能报）。"
// 与 `synthMembersTable.test.js` 的坏数据告警是同一批锚点，这里只从"写拒绝"的角度回看它。
// ================================================================

test('历史坏数据回归锚：悬空 / 写节点 id / 重复标识 / 不在树上 ⇒ 只警告，读路径不抛错', () => {
    const s = makeState();
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    const synA = Object.values(s.nodes).find(n => n.synthKey === 'k1');
    // ① 悬空指针（存档里的历史数据）
    s.nodes.c2.ownerSynth = 'ghost';
    // ② ownerSynth 写成节点 id
    s.nodes.c1.ownerSynth = synA.id;
    // ③ 两个节点共用一个标识
    s.nodes.dupSyn = { id: 'dupSyn', type: 'C', name: '重复标识', ownerSynth: '', synthKey: 'k1' };
    s.parentOf.dupSyn = 's1';
    s.childOrder.s1.push('dupSyn');
    s.childOrder.dupSyn = [];
    // ④ 成员从根走不到（挂在表里但没有 parentOf / childOrder）
    s.nodes.orphan = { id: 'orphan', type: 'C', name: '孤儿', ownerSynth: 'k1', synthKey: '' };

    const { out, result: table } = captureWarn(() => {
        synthIndex(s);
        return synthMembersTable(s);
    });

    assert.ok(out.some(w => /被多个节点共用/.test(w)), `重复标识要报：${out.join(' | ')}`);
    assert.ok(out.some(w => /节点 id/.test(w)), `写节点 id 要报：${out.join(' | ')}`);
    assert.ok(out.some(w => /走不到/.test(w)), `成员走不到要报：${out.join(' | ')}`);
    // ★ 文案同步：说清"这是历史数据，新的写入会被拒绝"
    assert.ok(out.some(w => /历史数据/.test(w) && /拒绝/.test(w)),
        `警告文案要说明"历史数据 + 新写入会被拒"：${out.join(' | ')}`);

    // 读路径的**结果口径一个字不改**：悬空指针不进任何组（成员表里没有它）
    assert.ok(!table.get('k1').includes('c2'), '悬空指针收不进成员表');
    assert.ok(!table.get('k1').includes('orphan'), '走不到的成员也收不进');

    // 悬空指针仍然"标得出 + 一键清得掉"，**写路径不产生它**
    const dangling = findDanglingOwners(s).map(d => d.id).sort();
    assert.deepEqual(dangling, ['c1', 'c2'], 'c1 写成节点 id、c2 悬空，都算悬空（读路径口径不变）');

    // 计数口径（groupCount.js）仍然把悬空当**单元素组**：不炸、不丢节点
    const { groups } = collectGroups({ nodes: s.nodes });
    assert.deepEqual(groups.get('c2').members, ['c2'], '悬空 ⇒ 单元素组');
    assert.equal(groups.get('c2').synthId, '', '单元素组没有合成头');
});

test('好数据零告警零拒绝（回归锚）：一条合法链路走下来，读路径一声不吭', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    bindOwner(s, 'c1', 'k1');
    bindOwner(s, 'c2', 'k1');
    assignSynthKey(s, a.id, 'k1-new');

    const { out } = captureWarn(() => {
        synthIndex(s);
        synthMembersTable(s);
    });
    assert.deepEqual(out, [], '合法数据不该有任何 console.warn');
});
