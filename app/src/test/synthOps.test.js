// ================================================================
// 合成节点写操作测试（core/ops/synth.js）
//
// 盯住六件事（任何一条破了都意味着"合成"这件事在数据层就已经错了）：
//   ① W/S 不许合成
//   ② 悬空指针"标得出 + 一键清得掉"
//   ③ 改标识 ⇒ 一次事务里所有成员指针跟着改
//   ④ 跨类型不许绑
//   ⑤ 删掉合成节点 ⇒ 成员指针被清（不留死指针）
//   ⑥ 两套身份（`extKey` / `synthKey`）互不干扰
// 外加一条属性表口径：新字段「导入可写、但不记手改来源值」。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SYNTH_PREFIX,
    MAX_SYNTH_KEY_LEN,
    createSynthNode,
    assignSynthKey,
    bindOwner,
    unbindOwner,
    applyOwnerSynth,
    findReusableSynthSibling,
    synthIndex,
    synthMembers,
    isSynthesis,
    synthKeyOf,
    ownerSynthOf,
    findDanglingOwners,
    clearDanglingOwners,
    clearOwnersOf
} from '../core/ops/synth.js';
// ★ 2026-10-18 起**事务里不再写 `draft.parentOf`**（派生索引，提交时由 `applyState` 重建）
//   ⇒ 断言"挂在谁下面"走这条读口（与 ops 里同一份：`ops/_helpers.js:parentOfInDraft`）。
import { parentOfInDraft } from '../core/ops/_helpers.js';
import { isImportable, isManuallyEditable, elementOf } from '../core/model/elements.js';
import { createNode } from '../core/model/node.js';

/**
 * 一棵**结构合法**的假树（类型链按 `TYPE_CHILDREN_MAP`）：
 *   root(O) → w1(W) → s1(S) → c1(C)/c2(C)/c3(C)，c1 → ps(P) → r1(R)
 * 合成节点自己也是普通节点，所以它得挂在"允许放这种类型"的父亲下：
 * C 的合成节点挂 S（S→C），P 的合成节点挂 C（C→P）。
 */
function makeState() {
    return {
        rootId: 'root',
        currentAccountId: 'local',
        viewingAccountId: 'local',
        meta: { idCounter: 0 },
        nodes: {
            root: { id: 'root', type: 'O', name: '根' },
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

test('① 合成只能建在 C/P/R 上：W/S 直接抛（并且点名说了为什么）', () => {
    const s = makeState();
    assert.throws(() => createSynthNode(s, 'w1', { type: 'W' }), /不能合成 W 节点/);
    // 类型合法，但树不放它：C 不能挂在 C 下（`TYPE_CHILDREN_MAP` 说了算）
    assert.throws(() => createSynthNode(s, 'c1', { type: 'C' }), /不允许添加/);
    // 正路：C 的合成节点挂 S
    const n = createSynthNode(s, 's1', { type: 'C', name: 'CF 106701' });
    assert.equal(n.type, 'C');
    assert.equal(s.nodes[n.id], n);
    assert.equal(parentOfInDraft(s, n.id), 's1');
    assert.equal(s.childOrder.s1.includes(n.id), true);
    assert.equal(isSynthesis(n), true, '有非空 synthKey ⇒ 合成节点');
    assert.equal(n.synthKey.startsWith(SYNTH_PREFIX), true, '自动标识带保留前缀');
});

test('标识：全局唯一、保留前缀不许手填、长度有上限', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'cf:106701', name: '甲' });
    assert.equal(a.synthKey, 'cf:106701');
    assert.throws(() => createSynthNode(s, 's1', { type: 'C', synthKey: 'cf:106701' }), /已被占用/);
    assert.throws(() => createSynthNode(s, 's1', { type: 'C', synthKey: 'synth:9' }), /保留前缀/);
    assert.throws(
        () => createSynthNode(s, 's1', { type: 'C', synthKey: 'x'.repeat(MAX_SYNTH_KEY_LEN + 1) }),
        /太长/
    );
    // 空白标识 = 没给 → 自动生成（表单留空就是"帮我起一个"，不是错误）
    const auto = createSynthNode(s, 's1', { type: 'C', synthKey: '   ' });
    assert.equal(auto.synthKey.startsWith(SYNTH_PREFIX), true);
    // 自动标识不会撞上已用的
    const b = createSynthNode(s, 's1', { type: 'C' });
    assert.notEqual(b.synthKey, a.synthKey);
    assert.notEqual(b.synthKey, auto.synthKey);
});

test('② 悬空指针：标得出、一键清得掉，且**不删节点**', () => {
    const s = makeState();
    const synth = createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    bindOwner(s, 'c2', 'k1');
    assert.equal(ownerSynthOf(s.nodes.c2), 'k1');

    // 手写一个指向不存在标识的值（**直接改字段**，绕过 ops —— 模拟存档里的历史坏数据）。
    // ⚠️ 不能用 `setOwnerRaw` 造它：写路径直接拒绝悬空指针
    //    （见 synthWriteReject.test.js 的四条拒绝）。
    s.nodes.c1.ownerSynth = 'ghost';
    assert.deepEqual(findDanglingOwners(s), [{ id: 'c1', synthKey: 'ghost', reason: 'missing' }]);

    const r = clearDanglingOwners(s);
    assert.equal(r.cleaned, 1);
    assert.equal(ownerSynthOf(s.nodes.c1), '');
    assert.equal(s.nodes.c1 !== undefined, true, '清理指针不许带走节点');
    assert.equal(ownerSynthOf(s.nodes.c2), 'k1', '好指针不许被误清');
    assert.equal(s.nodes[synth.id].synthKey, 'k1');
});

test('③ 改标识：同一事务里把所有成员指针改过来（旧标识一个不留）', () => {
    const s = makeState();
    const synth = createSynthNode(s, 's1', { type: 'C', synthKey: 'old', name: '甲' });
    bindOwner(s, 'c1', 'old');
    bindOwner(s, 'c2', 'old');
    const before = synth.lastModified;

    const r = assignSynthKey(s, synth.id, 'new');
    assert.equal(r.from, 'old');
    assert.equal(r.to, 'new');
    assert.equal(r.moved, 2, '两个成员都在这一次里改完');
    assert.equal(synth.synthKey, 'new');
    assert.equal(ownerSynthOf(s.nodes.c1), 'new');
    assert.equal(ownerSynthOf(s.nodes.c2), 'new');
    assert.equal(findDanglingOwners(s).length, 0, '改完不许留一条指向旧标识的指针');
    // 幂等：改成自己什么都不做
    assert.equal(assignSynthKey(s, synth.id, 'new').moved, 0);
    assert.throws(() => assignSynthKey(s, synth.id, ''), /不能为空/);
    assert.equal(typeof before, 'string');
    assert.equal(typeof synth.lastModified, 'string');
});

test('④ 跨类型不许绑；指向不存在/自己都不许（手改这条路必须严格）', () => {
    const s = makeState();
    const synth = createSynthNode(s, 's1', { type: 'C', synthKey: 'kC', name: '甲' });
    bindOwner(s, 'c2', 'kC');
    assert.equal(ownerSynthOf(s.nodes.c2), 'kC');

    assert.throws(() => bindOwner(s, 'ps', 'kC'), /同类型/);   // P 不能进 C 的合成
    assert.throws(() => bindOwner(s, 'r1', 'kC'), /同类型/);   // R 也不能
    assert.throws(() => bindOwner(s, 'c1', 'nope'), /不存在/);
    assert.throws(() => bindOwner(s, synth.id, 'kC'), /不能有「所属合成节点」/);
    // 解绑：值清空，节点还在
    unbindOwner(s, 'c2');
    assert.equal(ownerSynthOf(s.nodes.c2), '');
    assert.equal(s.nodes.c2 !== undefined, true);
    // 合成节点不许当成员（它自己是 C，但没有"所属合成节点"这回事）
    assert.throws(() => applyOwnerSynth(s, synth, 'kC'), /不能有「所属合成节点」/);
    // 同类型的正路：P 的合成节点挂 C，P 成员绑它
    createSynthNode(s, 'c1', { type: 'P', synthKey: 'kP', name: '题合成' });
    bindOwner(s, 'ps', 'kP');
    assert.equal(ownerSynthOf(s.nodes.ps), 'kP');
});

test('⑤ 删掉合成节点 ⇒ 同事务清掉成员指针（不留死指针）', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C', synthKey: 'ka', name: '甲' });
    const b = createSynthNode(s, 's1', { type: 'C', synthKey: 'kb', name: '乙' });
    bindOwner(s, 'c1', 'ka');
    bindOwner(s, 'c2', 'ka');
    bindOwner(s, 'c3', 'kb');

    // `tree.deleteNode` 走的就是这一步：先收下被删节点的 synthKey，再清指针
    const cleared = clearOwnersOf(s, [a.synthKey]);
    assert.equal(cleared, 2, '指向 ka 的两条都清了');
    assert.equal(ownerSynthOf(s.nodes.c1), '');
    assert.equal(ownerSynthOf(s.nodes.c2), '');
    assert.equal(ownerSynthOf(s.nodes.c3), 'kb', '别的合成节点不受影响');
    assert.equal(synthIndex(s).byKey.get('kb'), b.id);
    assert.equal(clearOwnersOf(s, ['']), 0, '空标识清单 = 什么都不做');
});

test('⑥ 两套身份互不干扰：extKey 不是合成标识，合成标识也不进 extKey', () => {
    const s = makeState();
    const synth = createSynthNode(s, 's1', { type: 'C', synthKey: 'cf:1', name: '甲' });
    // 合成标识与某个 extKey 字面相同 —— 谁也不影响谁
    assert.equal(isSynthesis(s.nodes.c1), false);
    assert.equal(synthKeyOf(s.nodes.c1), '');
    assert.equal(s.nodes.c1.extKey, 'cf:1', 'extKey 原样保留');
    bindOwner(s, 'c1', 'cf:1');
    assert.equal(s.nodes.c1.extKey, 'cf:1', '绑成成员也不会动它自己的 extKey');
    assert.equal(s.nodes[synth.id].extKey, undefined, '合成节点没有 extKey');
    // 反查表只看 synthKey
    const idx = synthIndex(s);
    assert.deepEqual([...idx.keys], ['cf:1']);
    assert.deepEqual(idx.members.get('cf:1'), ['c1']);
});

test('成员顺序按树序（DFS），不是对象键序', () => {
    const s = makeState();
    createSynthNode(s, 's1', { type: 'C', synthKey: 'k1', name: '甲' });
    // 故意让绑定顺序与树序相反
    bindOwner(s, 'c3', 'k1');
    bindOwner(s, 'c1', 'k1');
    assert.deepEqual(synthMembers(s, 'k1'), ['c1', 'c3']);
    assert.deepEqual(synthMembers(s, 'nope'), []);
});

test('属性表口径：「导入可写 + 不记手改来源值」', () => {
    for (const key of ['synthKey', 'ownerSynth']) {
        assert.equal(isImportable(key), true, `${key} 要能随导入包走`);
        assert.equal(isManuallyEditable(key), false, `${key} 不记手改来源值（结构是全局的）`);
    }
    assert.equal(elementOf('mappingElementValue'), undefined, '这个字段不存在，不留双份');
    const c = createNode('probe', 'C', {});
    assert.equal(c.synthKey, '', '默认空 = 不是合成节点');
    assert.equal(c.ownerSynth, '', '默认空 = 不属于任何合成节点');
    const w = createNode('probeW', 'W', {});
    assert.equal(w.ownerSynth, undefined, 'W/S/O 上没有这个键：合成只在 C/P/R 上做');
    assert.equal(w.synthKey, undefined);
});

// ================================================================
// 生成时的"两条都不撞"：**名字不撞** + **位置不撞**
//
//   ① 名字不撞：同一父下，新合成节点的 `name` 不与**任何已有兄弟**重名
//      （原料、别的合成节点、R 上的合成节点 —— 一个不落），规则**确定性**：
//      「合成」→「合成1」→「合成2」…（`ensureUniqueName`，没有随机数）。
//   ② 位置不撞：那个位置上已经有"代表同一批东西"的合成节点时，**复用/归入它**，
//      别在旁边再叠一个几乎同名的组头。判据只有一条：
//      `findReusableSynthSibling`（判重页 `createAndJoin` 调的就是它）。
// ================================================================

test('名字不撞①：同一父下连建 3 个合成节点 ⇒ 三个名字互不相同（且顺序可预测）', () => {
    const s = makeState();
    const a = createSynthNode(s, 's1', { type: 'C' });
    const b = createSynthNode(s, 's1', { type: 'C' });
    const c = createSynthNode(s, 's1', { type: 'C' });
    const names = [a.name, b.name, c.name];
    assert.equal(new Set(names).size, 3, `三个名字必须互不相同：${names.join(' / ')}`);
    // 确定性、可预测（不是随机数）：默认「合成」→「合成1」→「合成2」
    assert.deepEqual(names, ['合成', '合成1', '合成2']);
    // 三个标识也互不相同（名字与身份各管各的）
    assert.equal(new Set([a, b, c].map(synthKeyOf)).size, 3);
});

test('名字不撞②：也不与**同名的原料兄弟**撞（去重范围 = 所有兄弟，不是"只在合成节点之间"）', () => {
    const s = makeState();
    // 先来一个叫「合成」的**原料**兄弟占住这个名字
    s.nodes.c3.name = '合成';
    const n1 = createSynthNode(s, 's1', { type: 'C' });
    const n2 = createSynthNode(s, 's1', { type: 'C' });
    assert.equal(n1.name, '合成1');
    assert.equal(n2.name, '合成2');
    const siblingNames = s.childOrder.s1.map(id => s.nodes[id].name);
    assert.deepEqual(siblingNames, ['渠道甲', '渠道乙', '合成', '合成1', '合成2']);
    assert.equal(new Set(siblingNames).size, siblingNames.length, '同父下不许有两个同名兄弟');
});

test('名字不撞③：R 上的合成节点同样是兄弟（R 不参与去重 ⇒ 它们全叫「合成」）', () => {
    const s = makeState();
    const a = createSynthNode(s, 'ps', { type: 'R' });
    const b = createSynthNode(s, 'ps', { type: 'R' });
    const c = createSynthNode(s, 'ps', { type: 'R' });
    assert.deepEqual([a.name, b.name, c.name], ['合成', '合成1', '合成2']);
    // R 原料自己没名字（空名不参与去重），所以 r1 不影响上面的结果
    assert.equal(s.nodes.r1.name, '');
});

test('位置不撞①：同父 + 同类型 + **名字一字不差** ⇒ 复用那个已有的合成节点', () => {
    const s = makeState();
    // 这个名字没有同名兄弟，所以它真叫「某场比赛」（没被 `ensureUniqueName` 加序号）
    const existing = createSynthNode(s, 's1', { type: 'C', name: '某场比赛' });
    assert.equal(existing.name, '某场比赛');
    assert.equal(findReusableSynthSibling(s, 's1', { name: '某场比赛', type: 'C' }), existing);
    // 被去重改过名的（`渠道甲` → `渠道甲1`）**不算**"同一批"：只认一字不差
    const renamed = createSynthNode(s, 's1', { type: 'C', name: '渠道甲' });
    assert.equal(renamed.name, '渠道甲1', '原料 c1 已占「渠道甲」⇒ 新合成节点退到「渠道甲1」');
    assert.equal(findReusableSynthSibling(s, 's1', { name: '渠道甲', type: 'C' }), null);
    assert.equal(findReusableSynthSibling(s, 's1', { name: '渠道甲1', type: 'C' }), renamed);
    // 类型不同 / 父不同 / 父不存在 / 没给判据 ⇒ 都不复用（各自新建）
    assert.equal(findReusableSynthSibling(s, 's1', { name: '某场比赛', type: 'P' }), null);
    assert.equal(findReusableSynthSibling(s, 'c1', { name: '某场比赛', type: 'C' }), null);
    assert.equal(findReusableSynthSibling(s, 'nope', { name: '某场比赛', type: 'C' }), null);
    assert.equal(findReusableSynthSibling(s, 's1', { type: 'C' }), null);
    // 只读：找过一圈，树上什么都没变
    assert.equal(s.childOrder.s1.filter(id => isSynthesis(s.nodes[id])).length, 2);
});

test('位置不撞②：候选给的标识被**同父同类型**的兄弟占着 ⇒ 复用那个占据者（不新建、不改标识）', () => {
    const s = makeState();
    const holder = createSynthNode(s, 's1', { type: 'C', synthKey: 'cf:9', name: '某场比赛' });
    assert.equal(findReusableSynthSibling(s, 's1', { synthKey: 'cf:9', type: 'C' }), holder);
    // 跨类型 / 跨父不复用：位置对不上，宁可新建也不把成员挂到别处的组头上
    assert.equal(findReusableSynthSibling(s, 's1', { synthKey: 'cf:9', type: 'P' }), null);
    assert.equal(findReusableSynthSibling(s, 'c1', { synthKey: 'cf:9', type: 'C' }), null);
    // 同父下第二个合成节点（不同名不同标识）不受影响：要新建就新建
    const other = createSynthNode(s, 's1', { type: 'C', synthKey: 'cf:10', name: '另一场比赛' });
    assert.equal(findReusableSynthSibling(s, 's1', { synthKey: 'cf:10', type: 'C' }), other);
    assert.notEqual(other, holder);
});

test('位置不撞③：同一父下不会留下两个"代表同一批成员"的合成节点（判重页的复用口径）', () => {
    const s = makeState();
    const synthCount = () => Object.values(s.nodes).filter(isSynthesis).length;
    // 判重页 `createAndJoin` 的落点决策：先问"这个位置上有没有可复用的"，
    // 没有再 `createSynthNode`（同父、同类型、名字取第一个成员的名字）。
    const placeOrReuse = (parentId, memberIds, name, firstType, suggestKey) => {
        const reusable = findReusableSynthSibling(s, parentId, {
            synthKey: suggestKey, name, memberIds, type: firstType
        });
        if (reusable) return reusable;
        return createSynthNode(s, parentId, {
            type: firstType, name, synthKey: suggestKey || undefined
        });
    };
    const batch = ['c1', 'c2'];

    // 第一次「新建合成节点并归入 c1 + c2」
    const a = placeOrReuse('s1', batch, s.nodes.c1.name, 'C', '');
    for (const id of batch) bindOwner(s, id, synthKeyOf(a));
    assert.deepEqual(synthMembers(s, synthKeyOf(a)), ['c1', 'c2']);
    assert.equal(synthCount(), 1);

    // 第二次（同一批成员又被点了一次）⇒ **复用**，绝不并排第二个。
    // ⚠️ 这一条只有"成员集合"认得出：新建那个的名字已被去重成「渠道甲1」，
    //    和原料的「渠道甲」不再同名 —— 名字规则在这里帮不上忙。
    const b = placeOrReuse('s1', batch, s.nodes.c1.name, 'C', '');
    assert.equal(b, a, '同一父下已有代表同一批成员的组头 ⇒ 归入它');
    assert.equal(synthCount(), 1, '同父下只有一个合成节点（没有并排的近似同名组头）');
    assert.deepEqual(synthMembers(s, synthKeyOf(a)), ['c1', 'c2'], '重新归入是幂等的，名单不变');

    // 换成另一批成员 ⇒ 照常新建（不会因为"父下已有一个合成节点"就一律复用）
    const c = placeOrReuse('s1', ['c3'], '另一批东西', 'C', '');
    assert.notEqual(c, a);
    assert.equal(synthCount(), 2);
    // 且新建的那个名字不撞：同父下没有任何两个兄弟同名
    const names = s.childOrder.s1.map(id => s.nodes[id].name);
    assert.equal(new Set(names).size, names.length, `同父下有重名：${names.join(' / ')}`);
});
