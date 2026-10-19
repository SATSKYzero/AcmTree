// ================================================================
// 统计的计数模式（src/test/statsCountMode.test.js）
//
// 钉四件事：
//   ① **`plain` 回归锚（无合成节点）**：不传 mode / 设置缺省 / 非法值 / 显式 `plain`
//      ⇒ 与"逐节点"的 **legacy** 参照实现（`collectByType('P')` + `addProblem`）**逐字段相等**；
//   ② **`plain` = §二 模式 1**（有合成节点时）：**原料各算一次** +
//      **合成节点只在"本子树内没有任何它的 P 成员"时算一次**（不再与成员重复计）；
//   ③ **`dedup` 是真按组**：范围内每个组只算一次，**档位取那一组的「组那份」**
//      —— 即「(合成头自己那份 + 列表成员各自那份) 再聚合」：`status1` 取或、
//      `status2` `preferReal` 外加"合成头自己=忽略 ⇒ 整组忽略"的特例
//      （规则与实现见 `core/groupValue.js`）；组头在范围外也照样按它那一组算（scope-local）；
//      总组数与 `countGroupsOf`（`groupCount(MODE_DEDUP)`）**同口径**；
//   ④ **C 侧接 dedup**（"两者合并"）：合成 C 的档位 =
//      `max(① 自己子树 P 汇总出的 statusComplete2, ② 组内 C 成员各自的 statusComplete2)`；
//      pin 覆盖 `4` 仍优先；**无合成节点时与逐节点逐字段相等**。
//
// 纯对象、无 immer / DOM（`npm test` 用纯 Node 跑）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    collectPStats, collectCStats, getGlobalStats,
    collectByType, collectAllByType
} from '../core/query/stats.js';
import { newProblemBuckets, newContestBuckets, addProblem, addContest } from '../core/model/status.js';
import { MODE_PLAIN, MODE_DEDUP } from '../core/query/groupCount.js';
import { countGroupsOf } from '../core/query/countMode.js';
import { deriveContainerStatusComplete2 } from '../core/derive.js';

const G1 = 'synth:g1';
const G2 = 'synth:g2';

/** 空分档（`plain` 参照实现的初值） */
function emptyBuckets() {
    return newProblemBuckets();
}

/**
 * 一棵**全是 P** 的合成树（`p0` 为根，`childOrder` 才是权威形状）：
 *
 *   p0 ─ syn1(g1) ─ m1,m2(g1) ─ syn2(g2,**无成员**) ─ lone ─ gh(悬空) ─ sub ─ m3(g1)
 *
 * 组：{p0} / g1{syn1,m1,m2,m3} / g2{syn2} / {lone} / {gh} / {sub}  ⇒ **dedup 6 组**
 * 逐节点：p0 syn1 m1 m2 syn2 lone gh sub m3                ⇒ **plain 9 个**
 *
 * 状态刻意做成"成员比组头强"（m1/2/3 的 status1=1、status2 有 3/4/5），
 * 组头 syn1 却是 (0,1) —— 只有这样才分得清"组那份"到底合没合成员
 * （组 g1 的组那份 = OR(0,1,1,1)=1、preferReal(1,3,4)=4）。
 */
function fixture({ settings, withSynth = true } = {}) {
    const st = { rootId: 'p0', nodes: {}, childOrder: {}, parentOf: {} };
    if (settings !== undefined) st.settings = settings;
    const add = (id, parentId, extra = {}) => {
        st.nodes[id] = { id, type: 'P', status1: 0, status2: 0, ...extra };
        st.childOrder[id] = [];
        if (parentId) {
            st.parentOf[id] = parentId;
            st.childOrder[parentId].push(id);
        }
        return st.nodes[id];
    };
    add('p0', null);
    if (withSynth) {
        add('syn1', 'p0', { synthKey: G1, status2: 1 });
        add('syn2', 'p0', { synthKey: G2 });
        add('m1', 'p0', { ownerSynth: G1, status1: 1, status2: 3 });
        add('m2', 'p0', { ownerSynth: G1, status1: 1, status2: 4 });
        add('lone', 'p0', { status1: 1, status2: 3 });
        add('gh', 'p0', { ownerSynth: 'synth:不存在', status1: 1, status2: 3 });
        add('sub', 'p0');
        add('m3', 'sub', { ownerSynth: G1, status1: 1, status2: 5 });
    } else {
        add('a', 'p0', { status1: 1, status2: 3 });
        add('b', 'p0', { status2: 4 });
        add('sub', 'p0', { status1: 1, status2: 5 });
        add('c', 'sub', { status2: 2 });
    }
    return st;
}

/** 参照实现（legacy）：**逐节点**分档（纯公开 API，故意写得笨） */
function refLegacyPlain(state, rootId) {
    const b = emptyBuckets();
    const pNodes = rootId
        ? collectByType(state, rootId, 'P')
        : collectAllByType(state, 'P');
    for (const p of pNodes) addProblem(b, p.status1, p.status2);
    return b;
}

/** 子树内节点 id 集合（不传 rootId = 全树；根不在 nodes 里 = 空集） */
function scopeNodeIds(state, rootId) {
    if (!rootId) return new Set(Object.keys(state.nodes));
    const out = new Set();
    (function walk(id) {
        const n = state.nodes[id];
        if (!n) return;
        out.add(id);
        for (const cid of state.childOrder[id] || []) walk(cid);
    })(rootId);
    return out;
}

/**
 * 参照实现（§二 模式 1）：**原料各算一次** + **子树内没有任何同类型成员的合成节点各算一次**
 * （只用节点表，故意写得笨；与实现不共享任何代码，以免"用实现验实现"）。
 */
function refPlainMode1(state, rootId, type = 'P') {
    const b = type === 'P' ? newProblemBuckets() : newContestBuckets();
    const add = type === 'P'
        ? (n) => addProblem(b, n.status1, n.status2)
        : (n) => addContest(b, n.statusComplete2);
    const scope = scopeNodeIds(state, rootId);
    const nodes = state.nodes;
    const isSynth = n => !!(n && n.synthKey);
    const membersOf = new Map();          // synthKey → 成员 id（悬空指针在这里没有组头）
    for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || isSynth(n)) continue;
        const owner = String(n.ownerSynth || '').trim();
        if (!owner) continue;
        if (!membersOf.has(owner)) membersOf.set(owner, []);
        membersOf.get(owner).push(id);
    }
    for (const id of scope) {
        const n = nodes[id];
        if (!n || n.type !== type) continue;
        if (!isSynth(n)) { add(n); continue; }                     // 原料：一定算
        const mine = membersOf.get(String(n.synthKey).trim()) || [];
        const inside = mine.some(mid => scope.has(mid) && nodes[mid].type === type);
        if (!inside) add(n);                                       // 子树内无成员才算
    }
    return b;
}

// ================================================================
// ① plain 回归锚（**没有合成节点** ⇒ 与 legacy 逐节点逐字段相等）
// ================================================================
test('plain 回归锚：无合成节点时，不传 mode / 设置缺省或非法 / 显式 plain ⇒ 逐字段等于 legacy 逐节点参照', () => {
    const cases = [
        ['完全不给 settings', fixture({ withSynth: false }), null],
        ['设置缺省（没有 stats）', fixture({ withSynth: false, settings: {} }), null],
        ['设置显式 plain', fixture({ withSynth: false, settings: { stats: { countMode: MODE_PLAIN } } }), null],
        ['设置是非法值', fixture({ withSynth: false, settings: { stats: { countMode: 'bogus' } } }), null],
        ['设置是 dedup，但显式传 plain', fixture({ withSynth: false, settings: { stats: { countMode: MODE_DEDUP } } }), MODE_PLAIN]
    ];
    for (const [label, st, explicit] of cases) {
        const opts = explicit ? { mode: explicit } : {};
        for (const scope of ['p0', 'sub', null]) {
            assert.deepEqual(collectPStats(st, scope, undefined, opts), refLegacyPlain(st, scope), `${label} / scope=${scope}`);
        }
    }
});

// ================================================================
// ② plain = §二 模式 1（有合成节点：合成节点只在"子树内无成员"时计一次）
// ================================================================
test('plain（§二 模式 1）：原料各一次 + 子树内无成员的合成节点各一次，不再与成员重复计', () => {
    const st = fixture();
    for (const scope of ['p0', 'sub', 'm3', 'syn1', null]) {
        assert.deepEqual(collectPStats(st, scope, undefined, { mode: MODE_PLAIN }), refPlainMode1(st, scope), `scope=${scope}`);
    }
    // 9 个 P 节点 − syn1（成员 m1/m2/m3 里有 2 个在 p0 子树内 ⇒ 不计）= 8
    assert.equal(collectPStats(st, 'p0', undefined, { mode: MODE_PLAIN }).total, 8);
    assert.equal(collectPStats(st, 'p0').total, 8, '缺省就是 plain ⇒ 同一份口径');
    assert.notEqual(collectPStats(st, 'p0').total, refLegacyPlain(st, 'p0').total,
        '有合成节点时**不再**等于 legacy 逐节点（syn1 与它的成员不再各算一次）');
});

test('plain 回归锚：总数（§二 模式 1）与 legacy 的差异只来自"成员在子树内的合成节点"', () => {
    const st = fixture();
    assert.equal(collectPStats(st, 'p0').total, 8, 'p0 m1 m2 syn2 lone gh sub m3（syn1 不计：成员在子树内）');
    assert.equal(collectPStats(st, 'sub').total, 2, 'sub + m3（syn1 不计）');
    assert.equal(collectPStats(st, 'm3').total, 1, 'm3（syn1 不计）');
    assert.equal(collectPStats(st, 'syn1').total, 1, 'syn1 自己：子树里没有它的成员 ⇒ 算一次');
    assert.equal(collectPStats(st, null).total, 8, '整棵树');
    assert.equal(collectPStats(st, 'no-such-node').total, 0, '根不在 nodes 里 ⇒ 空（与 collectByType 同口径）');
    // 无合成节点时逐字等于 legacy
    const plain = fixture({ withSynth: false });
    assert.equal(collectPStats(plain, 'p0').total, 5, 'p0 a b sub c');
    assert.deepEqual(collectPStats(plain, 'p0'), refLegacyPlain(plain, 'p0'));
});

// ================================================================
// ② dedup：真按组
// ================================================================
test('dedup：无合成节点时与 plain 逐字段相等（每个原料自己一组）', () => {
    const st = fixture({ withSynth: false, settings: { stats: { countMode: MODE_DEDUP } } });
    for (const scope of ['p0', 'sub', null]) {
        assert.deepEqual(collectPStats(st, scope), refLegacyPlain(st, scope), `scope=${scope}`);
        assert.deepEqual(collectPStats(st, scope), collectPStats(st, scope, undefined, { mode: MODE_PLAIN }));
    }
    assert.equal(collectPStats(st, 'p0').total, 5, 'p0 a b sub c');
});

test('dedup：按组算（total 与逐节点不同），**档位取该组的「组那份」**、成员参与合并', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    const b = collectPStats(st, 'p0');
    // g1 的组那份 = OR(0,1,1,1)=1 / preferReal(1,3,4,5)=4
    //   ⇒ processed（status1=1）+ passedIgnore（4 是"赛时通过"）
    // 其余 5 组：{p0} g2 {lone} {gh} {sub}（lone/gh 各自 (1,3)）
    assert.deepEqual(b, {
        total: 6,           // {p0} g1 g2 {lone} {gh} {sub}
        passed: 1,          // g1 的组那份 status2 = 4（m2 的赛时通过）
        passedIgnore: 3,    // g1(4) + lone(3) + gh 悬空自己一组(3)
        processed: 3,       // g1(组里 m1/m2/m3 都处理过) + lone(1) + gh(1)
        processedIgnore: 3
    });
    assert.equal(b.total, 6);
    assert.notEqual(b.total, refPlainMode1(st, 'p0').total,
        'dedup 的 total 必须真的按组（8 → 6），不是把 plain 的数字改一改');
});

test('dedup：显式 mode 覆盖设置（反之亦然），非法显式值回落设置', () => {
    const dedupState = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    assert.deepEqual(collectPStats(dedupState, 'p0', undefined, { mode: MODE_PLAIN }), refPlainMode1(dedupState, 'p0'));
    const plainState = fixture({ settings: { stats: { countMode: MODE_PLAIN } } });
    assert.equal(collectPStats(plainState, 'p0', undefined, { mode: MODE_DEDUP }).total, 6);
    assert.equal(collectPStats(dedupState, 'p0', undefined, { mode: 'bogus' }).total, 6, '非法显式 mode ⇒ 回落设置');
});

test('dedup：总组数与 countGroupsOf（groupCount 的去重口径）一致', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    const viaModule = countGroupsOf(st);
    assert.equal(viaModule.groupCount, 6);
    assert.equal(viaModule.byNode['p0'].groupCount, 6);
    assert.equal(collectPStats(st, 'p0').total, viaModule.byNode['p0'].groupCount,
        '统计的"按组计数"与计数模块同一口径（全 P 树 ⇒ 两者可比）');
    assert.equal(collectPStats(st, 'sub').total, countGroupsOf(st, { rootId: 'sub' }).groupCount);
    // ① 落地后，统计的 `plain`（§二 模式 1）与计数模块的 `plain` **同一口径**了：
    //    两边都不把"成员在子树内的合成节点"（这里是 syn1）单独计 ⇒ 8。
    assert.equal(countGroupsOf(st, { mode: MODE_PLAIN }).byNode['p0'].groupCount, 8);
    assert.equal(collectPStats(st, 'p0', undefined, { mode: MODE_PLAIN }).total, 8);
});

test('dedup：悬空指针落成单元素组（状态取它自己），不丢不炸', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    assert.deepEqual(collectPStats(st, 'gh'), {
        total: 1, passed: 0, passedIgnore: 1, processed: 1, processedIgnore: 1
    }, 'gh 指向不存在的标识 ⇒ 自己一组，状态就是它自己的 (1,3)');
    assert.equal(collectPStats(st, 'p0').total, 6, '全树里 gh 自己占一组（g1 只有 syn1/m1/m2/m3）');
});

test('dedup：组头在范围外也按它那一组的组那份算（scope-local，成员在范围内即该组在范围内）', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    // scope=m3：只有 m3 在范围里，但它的组头 syn1 在范围外 —— 仍然只算一次，
    // 档位取**组 g1 的组那份** (1,4)，**不是** m3 自己的 (1,5)，也不是组头自己的 (0,1)。
    assert.deepEqual(collectPStats(st, 'm3'), {
        total: 1, passed: 1, passedIgnore: 1, processed: 1, processedIgnore: 1
    });
    // scope=sub：{sub}(0,0) + {g1}(1,4) = 2 组
    assert.deepEqual(collectPStats(st, 'sub'), {
        total: 2, passed: 1, passedIgnore: 1, processed: 1, processedIgnore: 1
    });
    // scope=syn1：组头自己在范围里 ⇒ 还是 1 组
    assert.equal(collectPStats(st, 'syn1').total, 1);
});

test('dedup：自定义取值器作用在**整组**上（生产走 viewDerived，只是换了个 reader）', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    const forced = (node, field) => (field === 'status2' ? 4 : node[field]);
    assert.deepEqual(collectPStats(st, 'p0', forced), {
        total: 6, passed: 6, passedIgnore: 6, processed: 3, processedIgnore: 3
    }, 'status2 由 reader 给成 4 ⇒ 6 组全是"赛时通过"；status1 仍按各节点自己的值取或'
        + '（组 g1 里有成员是 1 ⇒ 该组 processed）');
});

// ================================================================
// ③ 只读 + 全局统计
// ================================================================
test('dedup：只读（不写派生、不改输入、不进历史）', () => {
    const st = fixture({ settings: { stats: { countMode: MODE_DEDUP } } });
    st.sources = { manual: { kind: 'manual' } };
    const before = JSON.stringify(st);
    collectPStats(st, 'p0');
    collectPStats(st, 'sub', undefined, { mode: MODE_PLAIN });
    collectCStats(st, null, undefined, { mode: MODE_DEDUP });
    getGlobalStats(st, undefined, { mode: MODE_DEDUP });
    assert.equal(JSON.stringify(st), before, '输入（含来源层与设置）逐字节不变');
});

test('getGlobalStats：模式同时作用在 P / C 两侧', () => {
    const st = cFixture();
    const t = cTable(st);
    const read = cReader(t);
    const dedupGlobal = getGlobalStats(st, read, { mode: MODE_DEDUP });
    const plainGlobal = getGlobalStats(st, read, { mode: MODE_PLAIN });
    assert.equal(dedupGlobal.pRaw.total, 5, 'P：p0…p4 都没有归属 ⇒ 各自一组 = 逐节点');
    assert.equal(plainGlobal.pRaw.total, 5);
    assert.equal(dedupGlobal.cRaw.total, 3, 'C：按组（g1 / {c3} / g2）');
    assert.equal(plainGlobal.cRaw.total, 6, 'C：逐节点');
    assert.deepEqual(dedupGlobal.cRaw, collectCStats(st, null, read, { mode: MODE_DEDUP }));
    assert.match(dedupGlobal.pStr, /^P:\d{2,}\//);
    assert.match(dedupGlobal.cStr, /^C:/);
});

// ================================================================
// ④ C 侧接 dedup（"两者合并"）
// ================================================================
/**
 * C 合成树（`o` 为根；`p*` 都挂在 C 的子树里）：
 *
 *   o ─ cs (C, synth:c1) ─ p0 (P 1,2)      ⇒ ① 自己子树 ⇒ 2（全处理）
 *     ├ c1 (C, owner synth:c1) ─ p1 (P 1,3) ⇒ ② 成员 ⇒ 3（AK）
 *     ├ c2 (C, owner synth:c1) ─ p2 (P 0,0) ⇒ ② 成员 ⇒ 0
 *     ├ c3 (C, 无归属)         ─ p3 (P 1,2) ⇒ 单元素组 ⇒ 2
 *     ├ cs2 (C, synth:c2) ─ p4 (P 1,3)      ⇒ ① 自己 ⇒ 3（AK）
 *     └ c4 (C, owner synth:c2) （空）        ⇒ ② 成员 ⇒ 0
 *
 * 组：g1{cs,c1,c2} / {c3} / g2{cs2,c4}  ⇒ **dedup 3 组**；逐节点 6 个 C。
 */
function cFixture() {
    const st = { rootId: 'o', nodes: {}, childOrder: {}, parentOf: {} };
    const add = (id, type, parentId, extra = {}) => {
        st.nodes[id] = {
            id, type, name: id, status1: 0, status2: 0, statusComplete2: undefined, ...extra
        };
        st.childOrder[id] = [];
        if (parentId) {
            st.parentOf[id] = parentId;
            st.childOrder[parentId].push(id);
        }
        return st.nodes[id];
    };
    add('o', 'O', null);
    add('cs', 'C', 'o', { synthKey: G1 });
    add('p0', 'P', 'cs', { status1: 1, status2: 2 });
    add('c1', 'C', 'o', { ownerSynth: G1 });
    add('p1', 'P', 'c1', { status1: 1, status2: 3 });
    add('c2', 'C', 'o', { ownerSynth: G1 });
    add('p2', 'P', 'c2');
    add('c3', 'C', 'o');
    add('p3', 'P', 'c3', { status1: 1, status2: 2 });
    add('cs2', 'C', 'o', { synthKey: G2 });
    add('p4', 'P', 'cs2', { status1: 1, status2: 3 });
    add('c4', 'C', 'o', { ownerSynth: G2 });
    return st;
}

/**
 * `statusComplete2` 的取值表：**就是 `core/derive.js` 的容器推导**（① 的那一份，不另写）。
 * `pins[id] === '4'` 模拟"用户按下的覆盖 4（忽略）"。
 */
function cTable(state, pins = {}) {
    const t = new Map();
    const s1 = n => n.status1;
    const s2 = n => n.status2;
    for (const id of Object.keys(state.nodes)) {
        const n = state.nodes[id];
        if (n.type === 'P') { t.set(id, { status1: n.status1, status2: n.status2 }); continue; }
        t.set(id, { statusComplete2: deriveContainerStatusComplete2(state, n, s1, s2, pins[id]) });
    }
    return t;
}

const cReader = t => (node, field) => (t.get(node.id) || {})[field];

/** legacy 参照：C 逐节点分档 */
function refLegacyC(state, rootId, derived) {
    const b = newContestBuckets();
    const cs = rootId ? collectByType(state, rootId, 'C') : collectAllByType(state, 'C');
    for (const c of cs) addContest(b, derived(c, 'statusComplete2'));
    return b;
}

test('C · plain 回归锚：无合成节点时 dedup 与 plain / legacy 逐字段相等', () => {
    const st = cFixture();
    delete st.nodes.cs.synthKey;
    delete st.nodes.cs2.synthKey;
    delete st.nodes.c1.ownerSynth;
    delete st.nodes.c2.ownerSynth;
    delete st.nodes.c4.ownerSynth;
    const read = cReader(cTable(st));
    for (const scope of ['o', 'c1', null]) {
        assert.deepEqual(collectCStats(st, scope, read, { mode: MODE_DEDUP }),
            collectCStats(st, scope, read, { mode: MODE_PLAIN }), `scope=${scope}`);
        assert.deepEqual(collectCStats(st, scope, read, { mode: MODE_PLAIN }),
            refLegacyC(st, scope, read), `scope=${scope}：plain C 与 legacy 逐节点逐字段相等`);
    }
});

test('C · plain：有合成节点时逐节点不变（C 侧 plain 一行没动）', () => {
    const st = cFixture();
    const read = cReader(cTable(st));
    assert.deepEqual(collectCStats(st, 'o', read, { mode: MODE_PLAIN }), {
        total: 6, ak: 2, proc: 4, contact: 4, ign: 4
    });
    assert.deepEqual(collectCStats(st, 'o', read, { mode: MODE_PLAIN }), refLegacyC(st, 'o', read));
});

test('C · dedup：每组一次，档位 = max(合成 C 自己子树 P 的结果, 组内 C 成员聚合)', () => {
    const st = cFixture();
    const t = cTable(st);
    const read = cReader(t);
    // 前提：① 与 ② 各自的值（分得清到底取了谁）
    assert.equal(t.get('cs').statusComplete2, 2, '① cs 自己子树：一题处理了但没过 ⇒ 2 全处理');
    assert.equal(t.get('c1').statusComplete2, 3, '② c1 自己子树：过了 ⇒ 3 AK');
    assert.equal(t.get('c2').statusComplete2, 0);
    assert.equal(t.get('cs2').statusComplete2, 3, '① cs2 自己子树 ⇒ 3');
    assert.equal(t.get('c4').statusComplete2, 0);
    const b = collectCStats(st, 'o', read, { mode: MODE_DEDUP });
    assert.deepEqual(b, { total: 3, ak: 2, proc: 3, contact: 3, ign: 3 },
        'g1 = max(2,3,0)=3；{c3} = 2；g2 = max(3,0)=3');
    assert.notEqual(b.total, refLegacyC(st, 'o', read).total, 'dedup 真的按组（6 → 3）');
    // 单看 g1：成员的 3 压过组头自己的 2 ⇒ 说明 ① ② 合并了（不是只看组头）
    assert.equal(collectCStats(st, 'c2', read, { mode: MODE_DEDUP }).ak, 1,
        'scope=c2：只有成员在范围内，仍按组算一次，且取 max(组头 2, c1 的 3, c2 的 0) = 3');
});

test('C · dedup：pin 覆盖 4（忽略）仍优先（它压过 max 出来的真实档位）', () => {
    const st = cFixture();
    const read = cReader(cTable(st, { c2: '4' }));
    const b = collectCStats(st, 'o', read, { mode: MODE_DEDUP });
    assert.deepEqual(b, { total: 3, ak: 1, proc: 2, contact: 2, ign: 3 },
        'g1 = max(2,3,4)=4（忽略优先）；g2 仍是 3');
    // 组头自己按下的 4（忽略）同理优先
    const read2 = cReader(cTable(st, { cs: '4' }));
    assert.deepEqual(collectCStats(st, 'o', read2, { mode: MODE_DEDUP }),
        { total: 3, ak: 1, proc: 2, contact: 2, ign: 3 }, '组头自己的 pin 也是 4');
});
