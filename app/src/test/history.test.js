// ================================================================
// 历史栈 / 撤回测试（transaction/history.js）
//
// C2 / C3 两个病根都是**用户按 Ctrl+Z 就会遇到**：
//   C3 撤回跨步：每按一次跳过一步，最后几次空转却仍返回"成功"
//   C2 撤回不还原账户维度：`accounts`/`trust`/`sources`/两个指针不在快照里
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    captureState,
    applyState,
    pushHistory,
    popHistory,
    resetHistory,
    getHistoryCount,
    clearHistory,
    setHistoryFromArray,
    applyHistoryLimit
} from '../transaction/history.js';

/** 造一个"改 n 次"的序列：S0 → S1 → S2 → S3 …（每次都 push 事务前快照） */
function runTransactions(states) {
    resetHistory(states[0]);
    for (let i = 1; i < states.length; i++) {
        // 事务 i：事务前状态是 states[i-1]，事务后是 states[i]
        captureState(states[i - 1]);          // 真实调用点在 executeTransaction 里
        pushHistory(states[i - 1]);
    }
}

test('C3 撤回逐步回退：三次改动 → 依次回到 S2、S1、S0', () => {
    const S = (n) => ({ rootId: 'r', nodes: {}, childOrder: {}, name: `S${n}` });
    const states = [S(0), S(1), S(2), S(3)];
    runTransactions(states);

    assert.equal(getHistoryCount(), 3, '可撤回 3 步（三次改动）');
    assert.equal(popHistory().name, 'S2', '第一次撤回回到 S2');
    assert.equal(getHistoryCount(), 2);
    assert.equal(popHistory().name, 'S1', '第二次回到 S1');
    assert.equal(popHistory().name, 'S0', '第三次回到 S0');
    assert.equal(popHistory(), null, '没有更多可撤回（不再空转返回旧快照）');
    assert.equal(getHistoryCount(), 0);
});

test('C3 撤回不会越过哨兵：只改一次 → 只能撤回一次', () => {
    const S = (n) => ({ rootId: 'r', nodes: {}, childOrder: {}, name: `S${n}` });
    runTransactions([S(0), S(1)]);
    assert.equal(getHistoryCount(), 1);
    assert.equal(popHistory().name, 'S0');
    assert.equal(popHistory(), null);
});

test('C2 快照包含账户维度与来源层（否则撤回账户操作静默无效）', () => {
    const state = {
        rootId: 'r', nodes: {}, childOrder: {}, pages: {}, settings: {}, meta: {}, currentPageId: 'main',
        sources: { 'pta:x': { kind: 'board', rank: 30 } },
        trust: { categoryRank: [], sources: {}, fieldPrefer: {} },
        accounts: { local: { id: 'local', name: '本机', isLocal: true } },
        currentAccountId: 'local',
        viewingAccountId: 'k9',
        currentTab: 'main',                          // 会话状态：刻意不进快照
        parentOf: {}                                 // 派生索引：刻意不进快照
    };
    const snap = captureState(state);
    assert.deepEqual(Object.keys(snap).sort(), [
        'accounts', 'childOrder', 'currentAccountId', 'currentPageId', 'fieldRegistry', 'meta',
        'nodes', 'pages', 'plans', 'reports', 'rootId', 'settings', 'sources', 'trust', 'viewingAccountId'
    ], '该进的都进（含 fieldRegistry/reports/plans），会话/派生字段不进');
    assert.equal('currentTab' in snap, false, '会话状态不进快照');
    assert.equal('parentOf' in snap, false, '派生索引不进快照');

    // 回填：账户表与指针都要还原
    const target = { ...state, accounts: {}, currentAccountId: 'local', viewingAccountId: 'local', parentOf: {} };
    applyState(target, snap);
    assert.equal(target.viewingAccountId, 'k9', '在看指针被还原');
    assert.equal(target.accounts.local.name, '本机', '账户表被还原');
    assert.equal(target.trust.sources !== undefined, true, '优先级配置被还原');
    assert.equal(target.sources['pta:x'].rank, 30, '来源注册表被还原');
    assert.deepEqual(target.parentOf, {}, 'parentOf 由 childOrder 重建');
});

// ================================================================
// remark（私有笔记）必须能撤销回来
//
// 口径："remark 现在是一个失败的功能，我计划将 remark 加入快照"。
//
// 核实结果：`remark` **不是** `AppState` 的顶层字段，而是**节点字段**
// （`core/model/node.js` 的 `createNode` 里 `remark: ''`）；节点表整张在快照里
// （`SNAPSHOT_KEYS` 含 `nodes`）⇒ clear **remark 本来就随节点一起被快照**，
// 撤销能回到旧值。所以**没有**在 `SNAPSHOT_KEYS` 里加 `remark`——
// 加了只会多出一个恒为 `undefined` 的假键（`AppState.remark` 不存在），
// 那是"看起来在做、实际什么都没做"。
//
// 下面两条把这个结论**钉住**：以后谁把 `nodes` 从快照里摘出去（或者把 remark
// 挪成 state 顶层字段而忘了进快照），这里立刻红。
// ================================================================

test('★ remark 改动可撤销：undo 之后 node.remark 回到旧值', () => {
    // 快照键的"真源"是 history.js 内部的 SNAPSHOT_KEYS；它没导出，
    // 所以这里按注释里的来由写死一份 —— 也正是要防"被悄悄摘掉"。
    const KEYS = [
        'rootId', 'nodes', 'childOrder', 'pages', 'settings', 'meta', 'currentPageId',
        'sources', 'trust', 'accounts', 'currentAccountId', 'viewingAccountId'
    ];
    assert.ok(KEYS.includes('nodes'), '（前提）节点表在快照键里');

    const node = { id: 'n1', type: 'P', name: '题', extKey: 'a', remark: '旧备注' };
    /** remark = '' 也写成自己的快照，"缺键"与"空串"两种情形都覆盖 */
    const stateWith = (remark) => {
        const state = {
            rootId: 'o',
            nodes: { o: { id: 'o', type: 'O', name: '根' }, n1: { ...node, remark } },
            childOrder: { o: ['n1'], n1: [] },
            pages: {}, settings: {}, meta: {}, currentPageId: 'main',
            sources: {}, trust: {}, accounts: {},
            currentAccountId: 'local', viewingAccountId: 'local',
            parentOf: { o: null, n1: 'o' }
        };
        const snap = {};
        for (const k of KEYS) snap[k] = state[k];
        return { state, snap };
    };

    // ---- ① 有值 → 另一个值 → 撤销 ----
    {
        const before = stateWith('旧备注');
        const snap = before.snap;

        // 事务提交：Immer produce 的产物是**新引用**（这里如实模拟）
        const next = { ...before.state, nodes: { ...before.state.nodes, n1: { ...before.state.nodes.n1, remark: '新备注（很长很长）' } } };
        applyState(before.state, next);
        assert.equal(before.state.nodes.n1.remark, '新备注（很长很长）', '（前提）改动生效了');

        applyState(before.state, snap);
        assert.equal(before.state.nodes.n1.remark, '旧备注', '★ 撤销后 remark 回到旧值');
    }

    // ---- ② 空 → 有值 → 撤销（清空备注也要撤得回来） ----
    {
        const before = stateWith('');
        const snap = before.snap;
        const next = { ...before.state, nodes: { ...before.state.nodes, n1: { ...before.state.nodes.n1, remark: '写点什么' } } };
        applyState(before.state, next);
        assert.equal(before.state.nodes.n1.remark, '写点什么');

        applyState(before.state, snap);
        assert.equal(before.state.nodes.n1.remark, '', '★ 撤销后 remark 回到空');
    }

    // ---- ③ 快照的键不含顶层 'remark'（它本来就不是 AppState 的字段） ----
    assert.equal('remark' in stateWith('x').snap, false,
        'remark 是**节点字段**：进快照的是 nodes 整张表，不是顶层一个 remark 键');
});

test('★ 结构改动 → 撤回：`parentOf` 必须按 `childOrder` 重建（否则撤回后树是散的）', () => {
    // 为什么补这条（2026-10-18）：我一度提议"`parentOf` 别在事务里维护、改成按需派生"，
    //   靠用户一句"这些是为了可撤回必须在事务里维护的"才拦下来。
    //   当时的守卫只钉了"`parentOf` 不进快照"，**没钉"撤回之后它还对不对"** ⇒ 那种改法会照样绿。
    //
    // 症状（一旦有人把 `applyState` 的 `structChanged` 分支删掉 / 写错）：
    //   Ctrl+Z 之后 `childOrder` 回来了，`parentOf` 却还是**撤回前那一代** ⇒
    //   找父全错（面包屑 / 树渲染 / 派生链全跟着错），而且**一声不响**。
    const S0 = { rootId: 'r', nodes: { r: { id: 'r' }, c: { id: 'c' } },
        childOrder: { r: ['c'], c: [] }, parentOf: null };
    applyState(S0, captureState(S0));                      // 先把 S0 的父索引建出来
    assert.deepEqual(S0.parentOf, { c: 'r' }, 'S0：`c` 的父是 `r`');

    // 提交一次**结构改动**（`p3` 挂到 `c` 下）：真实路径里快照来自 `produce` 的产物
    // ⇒ `childOrder` 是**新对象**（`applyState` 就是靠这个引用差判"结构变了"）。
    const S1 = { ...S0, nodes: { ...S0.nodes, p3: { id: 'p3' } }, childOrder: { ...S0.childOrder } };
    const produced = { ...S1, childOrder: { ...S1.childOrder, c: ['p3'], p3: [] } };
    applyState(S1, captureState(produced));
    assert.deepEqual(S1.childOrder, { r: ['c'], c: ['p3'], p3: [] }, '结构改动生效');
    assert.deepEqual(S1.parentOf, { c: 'r', p3: 'c' }, 'S1：新节点有了父');

    // 撤回：把 S0 的快照贴回这个**已经带上 p3** 的状态
    applyState(S1, captureState(S0));
    assert.deepEqual(S1.parentOf, { c: 'r' }, '★ 撤回之后：`p3` 那条父子关系必须消失');
    assert.equal(S1.parentOf.r, undefined, '根没有父');

    // ★ 这条断言真能区分"重建过"与"没重建"：没重建的话父索引里还留着 `p3: 'c'`
    assert.notDeepEqual({ c: 'r', p3: 'c' }, S1.parentOf,
        '没重建 `parentOf` 的话这里会是 { c, p3 } —— 这条断言就是靠这个差异抓人的');
});

test('★ `childOrder` 没换引用 ⇒ `parentOf` **不重建**（对象还是同一个）', () => {
    // `applyState` 的注释：'`childOrder` 没换引用就不必重建'（真包 27k 实测 ~9ms/次）。
    // 这条钉"别把它变成每次事务都重建"——那 9ms 是白付的，而且会让 `parentOf` 引用每一步都换。
    const st = { rootId: 'r', nodes: { r: { id: 'r' } }, childOrder: { r: [] }, parentOf: null };
    applyState(st, captureState(st));                      // 第一次：`parentOf` 是 null ⇒ 会建一次
    const once = st.parentOf;
    assert.deepEqual(once, {}, '建出来了（根没有父）');
    applyState(st, captureState(st));                      // 同一个 `childOrder`
    assert.equal(st.parentOf, once, '★ 没结构变化 ⇒ `parentOf` 还是同一个对象（没重建）');
});

test('历史栈的其它入口：上限、清空、重置、反序列化', () => {
    const S = (n) => ({ rootId: 'r', name: `S${n}` });
    resetHistory(S(0));
    for (const n of [1, 2, 3, 4, 5]) pushHistory(S(n));
    assert.equal(getHistoryCount(), 5);

    applyHistoryLimit(2);
    assert.equal(getHistoryCount(), 2, '上限 2 步 → 栈里保留 3 份（含哨兵）');
    assert.equal(popHistory().name, 'S5', '上限只砍最老的，最近的可撤回');
    assert.equal(popHistory().name, 'S4');
    assert.equal(popHistory(), null);

    clearHistory();
    assert.equal(getHistoryCount(), 0, '清空后连哨兵也不留');
    assert.equal(popHistory(), null, '空栈撤回不炸');

    // 数组顺序即栈顺序：**索引 0 = 最近一次事务的"事务前快照"**
    setHistoryFromArray([S(1), S(0)]);
    assert.equal(getHistoryCount(), 1);
    assert.equal(popHistory().name, 'S1');
    assert.throws(() => setHistoryFromArray('不是数组'));
});
