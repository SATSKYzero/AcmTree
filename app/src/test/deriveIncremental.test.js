// ================================================================
// 派生表的**增量重算**（`core/derive.js`）
//
// "`nodes` 引用一变就整份重算"是白付的 —— 真包 27k 节点实测 **~107ms**，
//   而一次操作通常只动一两个节点。
//   所以初始化建一次，之后**只重算"引用变了的节点 + 它们的祖先"**（容器要把子汇总上来）。
//
// 这个文件钉三件事（都是"改错了会静默算错数"的）：
//   ① **对拍**：增量出来的表必须与"清掉记忆化、整份重算"的那份**逐字段相等**；
//   ② **复用锚**：没动的节点，行必须是**同一个对象**（`===`）—— 否则"增量"是假的；
//   ③ **保守边界**：结构（`childOrder`）一变、或变化面太大 ⇒ 退回整份重算。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { derivedTable, clearDerivedMemo, noteValueDelta } from '../core/derive.js';

const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { manual: { kind: 'manual', rank: 100 } },
    fieldPrefer: {}
};
const manual = (v, account, at) => ({ v, src: 'manual', at, account });

/**
 * 一棵小但**有结构**的树：O → W → S → C → P1/P2，每个 P 下面一个 R。
 * 值走来源层（派生表只认投影）。
 */
function makeState() {
    const node = (id, type, extra = {}) => ({
        id, type, name: id, status1: 0, status2: 0, values: {}, ...extra
    });
    const nodes = {
        o: node('o', 'O'),
        w: node('w', 'W'),
        s: node('s', 'S'),
        c: node('c', 'C'),
        p1: node('p1', 'P', { values: { status1: [manual('1', 'k1', 'T1')] } }),
        p2: node('p2', 'P', { values: { status1: [manual('0', 'k1', 'T1')] } }),
        r1: node('r1', 'R', { status: 'AC', time: '2026-01-01 10:00' }),
        r2: node('r2', 'R', { status: 'WA', time: '2026-01-02 10:00' })
    };
    const childOrder = { o: ['w'], w: ['s'], s: ['c'], c: ['p1', 'p2'], p1: ['r1'], p2: ['r2'], r1: [], r2: [] };
    const parentOf = {};
    for (const [pid, kids] of Object.entries(childOrder)) for (const k of kids) parentOf[k] = pid;
    return {
        rootId: 'o', nodes, childOrder, parentOf,
        accounts: { k1: { id: 'k1', name: '主号' } },
        trust: TRUST, viewingAccountId: 'k1'
    };
}

/** 表 → 可比较的形状（`Map` 比不了，转成排序后的数组） */
const snapshot = (table) => [...table.entries()]
    .map(([id, row]) => [id, JSON.stringify(row)]).sort((a, b) => a[0].localeCompare(b[0]));

/** 整份重算（清掉记忆化再算） */
function fullOf(state) {
    clearDerivedMemo();
    return derivedTable(state);
}

/** 只换一个节点（模拟 Immer 的结构共享：其余节点**引用不变**） */
function withNode(state, id, patch) {
    return { ...state, nodes: { ...state.nodes, [id]: { ...state.nodes[id], ...patch } } };
}

test('① 对拍：增量 == 整份重算（改值 / 加节点 / 改结构 三种都试）', () => {
    let st = makeState();
    derivedTable(st);                                    // 建初始表（= 初始化那一次）
    assert.deepEqual(snapshot(derivedTable(st)), snapshot(fullOf(st)), '初始表本来就该一样');

    // (a) 改一个 P 的覆盖值（父容器的 statusComplete 要跟着变）
    st = withNode(st, 'p2', { values: { status1: [manual('1', 'k1', 'T2')] } });
    const incA = snapshot(derivedTable(st));
    assert.deepEqual(incA, snapshot(fullOf(st)), '改一个 P 之后：增量 == 整份');

    // (b) 加一个 P（`childOrder` 也变了 ⇒ 走整份重算那条路，仍然必须一样）
    {
        const nodes = { ...st.nodes, p3: { id: 'p3', type: 'P', name: 'p3', values: {}, status1: 0, status2: 0 } };
        const childOrder = { ...st.childOrder, c: [...st.childOrder.c, 'p3'], p3: [] };
        const parentOf = { ...st.parentOf, p3: 'c' };
        st = { ...st, nodes, childOrder, parentOf };
        assert.deepEqual(snapshot(derivedTable(st)), snapshot(fullOf(st)), '加节点之后：一样');
    }

    // (c) 改一个 R 的状态（P 的 status2/acTime 由子提交算出来 ⇒ 必须重算到）
    st = withNode(st, 'r1', { status: 'WA' });
    assert.deepEqual(snapshot(derivedTable(st)), snapshot(fullOf(st)), '改 R 之后：一样');

    // (d) 删一个 P
    {
        const nodes = { ...st.nodes };
        delete nodes.p3;
        const childOrder = { ...st.childOrder, c: st.childOrder.c.filter((x) => x !== 'p3') };
        const parentOf = { ...st.parentOf };
        delete parentOf.p3;
        st = { ...st, nodes, childOrder, parentOf };
        assert.deepEqual(snapshot(derivedTable(st)), snapshot(fullOf(st)), '删节点之后：一样');
    }
});

test('② 复用锚：没动的节点，行是**同一个对象**（否则"增量"是假的）', () => {
    let st = makeState();
    const before = derivedTable(st);
    const rowsBefore = new Map(before);

    // 只动 p2 ⇒ p1 / r1 / r2 这些没碰过的行必须原样复用
    st = withNode(st, 'p2', { values: { status1: [manual('1', 'k1', 'T2')] } });
    const after = derivedTable(st);
    for (const id of ['p1', 'r1', 'r2']) {
        assert.equal(after.get(id), rowsBefore.get(id), `${id} 没有变化 ⇒ 行对象应当被复用`);
    }
    // 而"变了的"与"它的祖先"必须是**新算的**（祖先要重算子汇总）
    for (const id of ['p2', 'c', 's', 'w']) {
        assert.notEqual(after.get(id), rowsBefore.get(id), `${id} 该重算（它自己变了 / 是它的祖先）`);
    }
});

test('③ 保守边界：`childOrder` 一变就整份（**试过放宽，反而更慢，已回滚**）', () => {
    const st = makeState();
    const before = derivedTable(st);
    const st2 = { ...st, childOrder: { ...st.childOrder, c: [...st.childOrder.c] } };
    const after = derivedTable(st2);
    assert.notEqual(after, before, '换了一份表');
    // 全量重算 ⇒ 每个行对象都是新的（一个都没复用）
    for (const [id, row] of before) {
        assert.notEqual(after.get(id), row, `${id}：结构变了就该整份重算`);
    }
    assert.deepEqual(snapshot(after), snapshot(fullOf(st2)), '而且结果与整份重算一致');
});

// ================================================================
// ④ ★ 写路径交来的名单（`noteValueDelta`）+ 增量**只折受影响的那些组头**
//
// 这一条钉的是两处**错了会静默算错数**的地方（组头的"子树"是它的**成员**，而成员是
// 指针关系、**不在 `childOrder` 里** ⇒ 它不在"变了的 + 祖先"那条链上）：
//   · **成员的值变了** ⇒ 它所属的**组头**那一行必须跟着重折；
//   · **组划分变了**（成员改指别的组）⇒ "某个组头**少了一个**成员"这件事，从**新的**
//     指针里读不出来 ⇒ 这种改动必须退回"所有组头都折一遍"，**不许挑名单**。
//
// ⚠️ 那条路只在"名单与记忆化里那两代**对得上**"时才走（见 `derive.js` 的 `noteValueDelta`），
//    所以这里必须**显式调它**（与写路径同形）；对不上时自己扫全表那条路另有用例涵着。
// ⚠️ 对拍口径与 ① 相同：**增量出来的表必须与"清掉记忆化、整份重算"逐字段相等**。
// ================================================================

/** 一棵带**合成组**的树：`o→w→s→[c1, h1, h2, h3]`，`c1` 下五道题，三个组头各带成员 */
function makeSynthState() {
    const node = (id, type, extra = {}) => ({
        id, type, name: id, status1: 0, status2: 0, values: {}, ...extra
    });
    // status2：`AC`（没有 submitKind 证据）⇒ 3 赛后补题；提交未通过 ⇒ 2；组值 = 成员里**取最大**
    // （`AGG_BUILDERS.status2`）⇒ 组里"最好那一档"的成员一离开，组值就会变 —— 这正是要对拍的点。
    const nodes = {
        o: node('o', 'O'),
        w: node('w', 'W'),
        s: node('s', 'S'),
        c1: node('c1', 'C'),
        // 组头：`synthKey` 非空 ⇒ 合成节点；成员靠 `ownerSynth` 指过来（**不在 `childOrder` 里**）
        h1: node('h1', 'P', { synthKey: 'k:1' }),
        h2: node('h2', 'P', { synthKey: 'k:2' }),
        h3: node('h3', 'P', { synthKey: 'k:3' }),
        p1: node('p1', 'P', { ownerSynth: 'k:1' }),
        p2: node('p2', 'P', { ownerSynth: 'k:1' }),
        p3: node('p3', 'P', { ownerSynth: 'k:2' }),
        p4: node('p4', 'P', { ownerSynth: 'k:2' }),
        p5: node('p5', 'P', { ownerSynth: 'k:3' }),
        r1: node('r1', 'R', { status: 'AC', time: '2026-01-01 10:00' }),
        r2: node('r2', 'R', { status: 'WA', time: '2026-01-02 10:00' }),
        r3: node('r3', 'R', { status: 'WA', time: '2026-01-03 10:00' }),
        r4: node('r4', 'R', { status: 'AC', time: '2026-01-04 10:00' }),
        r5: node('r5', 'R', { status: 'WA', time: '2026-01-05 10:00' })
    };
    const childOrder = {
        o: ['w'], w: ['s'], s: ['c1', 'h1', 'h2', 'h3'],
        c1: ['p1', 'p2', 'p3', 'p4', 'p5'],
        h1: [], h2: [], h3: [],
        p1: ['r1'], p2: ['r2'], p3: ['r3'], p4: ['r4'], p5: ['r5'],
        r1: [], r2: [], r3: [], r4: [], r5: []
    };
    const parentOf = {};
    for (const [pid, kids] of Object.entries(childOrder)) for (const k of kids) parentOf[k] = pid;
    return {
        rootId: 'o', nodes, childOrder, parentOf,
        accounts: { k1: { id: 'k1', name: '主号' } },
        trust: TRUST, viewingAccountId: 'k1'
    };
}

test('④ 组：成员改值 / 成员改指别组 ⇒ 增量仍与整份重算逐字段相等', () => {
    const st0 = makeSynthState();
    derivedTable(st0);                                   // 初始那份（= 上一代）
    const rows0 = derivedTable(st0);
    // ⚠️ 必须**当场**串成字符串：增量复用的行对象是**同一个**（`computeHeadRow` 就地在上面改写），
    //    事后再读 `rows0` 拿到的是改完的值 —— 那样"变了没有"这一条恒成立、等于没测。
    const s2 = (table, id) => JSON.stringify(table.get(id));
    const h1Before = s2(rows0, 'h1');

    // ---------- (a) 成员的值变了 ⇒ 它所属的**组头**要重折 ----------
    // `r1` 从 AC 改成 WA ⇒ `p1` 那份从 3 掉到 2 ⇒ 组 `k:1`（{p1,p2} 取最大）从 3 掉到 2
    const stA = withNode(st0, 'r1', { status: 'WA' });
    noteValueDelta(st0.nodes, stA.nodes, ['r1']);         // ← 写路径那份名单（同形）
    const incA = derivedTable(stA);
    assert.notEqual(s2(incA, 'h1'), h1Before,
        '成员的值变了 ⇒ 组头 `h1` 那一行必须跟着变（不变的话下面的对拍是空转）');
    assert.deepEqual(snapshot(incA), snapshot(fullOf(stA)), '(a) 成员改值：增量 == 整份');

    // ---------- (b) 组划分变了 ⇒ **旧组头少了一个成员**也得重折 ----------
    // `p4`（组 `k:2` 里那个 AC）改指 `k:3` ⇒ `k:2` 掉到 2、`k:3` 升到 3
    const beforeB = derivedTable(stA);
    const h1BeforeB = s2(beforeB, 'h1');
    const h2Before = s2(beforeB, 'h2');
    const h3Before = s2(beforeB, 'h3');
    const stB = withNode(stA, 'p4', { ownerSynth: 'k:3' });
    // ⚠️ 必须声明"组划分动过"（写路径就是这么判的）：挑名单会把**旧组头** `h2` 漏掉
    noteValueDelta(stA.nodes, stB.nodes, ['p4'], true);
    const incB = derivedTable(stB);
    assert.notEqual(s2(incB, 'h2'), h2Before, '旧组头 `h2`（少了一个成员）必须重折');
    assert.notEqual(s2(incB, 'h3'), h3Before, '新组头 `h3`（多了一个成员）必须重折');
    assert.equal(s2(incB, 'h1'), h1BeforeB, '没碰过的组头 `h1` 不该变');
    assert.deepEqual(snapshot(incB), snapshot(fullOf(stB)), '(b) 组划分变：增量 == 整份');

    // ---------- (c) 名单与这两代**对不上** ⇒ 退回自己扫全表（结果照样对） ----------
    // `r2` 从 WA 改成 AC ⇒ `p2` 那份 2 → 3 ⇒ 组 `k:1` 从 2 升到 3
    const prevC = derivedTable(stB);
    const h1BeforeC = s2(prevC, 'h1');
    const stC = withNode(stB, 'r2', { status: 'AC' });
    noteValueDelta(st0.nodes, stB.nodes, ['r1']);         // ← 上一代那份名单（这两代对不上）
    const incC = derivedTable(stC);
    assert.notEqual(s2(incC, 'h1'), h1BeforeC, '(c) 这一轮真的动了组头（否则这一轮是空转）');
    assert.deepEqual(snapshot(incC), snapshot(fullOf(stC)), '(c) 名单对不上：自己扫，结果仍 == 整份');
});
