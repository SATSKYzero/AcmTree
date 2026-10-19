// ================================================================
// 派生字段"按范围计算"测试（core/derive.js）
//
// 阶段 2 的核心命题：**派生字段本身就是按账户的**。
//   status2（这题过没过）由子 R 的 status 推出，而 R 的 status 带账户 ——
//   所以"我的补题情况"和"队友的补题情况"是两套 status2，缓存字段表达不了。
//
// 这里用**纯 state 对象**驱动（不经过 Immer / UI），逐条验证：
//   - 范围不同 → 派生结果不同；
//   - 范围外的提交/比例不被算进来；
//   - 手动覆盖（忽略 / 赛时通过 / 已处理）也带归属；
//   - status1 / statusComplete1 本阶段仍是登录口径；
//   - 表按 (nodes 引用 + 范围) 记忆化，读一遍不改数据。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    buildDerivedTable,
    derivedTable,
    derivedOf,
    clearDerivedMemo,
    derivePstatus2,
    derivePxcpcDifficulty
} from '../core/derive.js';
// 覆盖（pin）的取值现在住在 `core/pin.js`（**唯一一份**，自动计算那条路也调它）
import { pinnedValue } from '../core/pin.js';
import { setDerivedOverride } from '../core/fieldValue.js';

const TIME = '----.--.-- --:--';

/**
 * 造一棵 W→S→C→P→R 的树。
 *
 * R 的 status 分别归给 k1 / k2；ratio 有两个说法（k1 的 10、客观的 40）。
 * 缓存字段故意填成"第三套值"，用来证明读的是算出来的、不是缓存。
 */
function makeTree() {
    const nodes = {
        w: { id: 'w', type: 'W', name: 'W', statusComplete1: 0, statusComplete2: 9, values: {} },
        s: { id: 's', type: 'S', name: 'S', statusComplete1: 0, statusComplete2: 9, values: {} },
        c: { id: 'c', type: 'C', name: 'C', statusComplete1: 0, statusComplete2: 9, values: {} },
        p: {
            id: 'p', type: 'P', name: 'P', status1: 0, status2: 9,
            acTime: '缓存时间', lastSubmitTime: '缓存时间', xcpcDifficulty: '缓存难度',
            ratio: '缓存比例', values: {
                ratio: [
                    { v: '10', src: 'srk:x', at: 'T1', account: 'k1' },
                    { v: '40', src: 'pta:x', at: 'T2' }
                ]
            }
        },
        r1: {
            id: 'r1', type: 'R', time: TIME, status: '-', values: {
                status: [{ v: 'WA', src: 'qoj:x', at: 'T1', account: 'k1' }],
                time: [{ v: '2026.09.13 22:04', src: 'qoj:x', at: 'T1', account: 'k1' }]
            }
        },
        r2: {
            id: 'r2', type: 'R', time: TIME, status: '-', values: {
                status: [{ v: 'AC', src: 'qoj:x', at: 'T2', account: 'k2' }],
                time: [{ v: '2026.09.13 22:06', src: 'qoj:x', at: 'T2', account: 'k2' }]
            }
        },
        r3: {
            id: 'r3', type: 'R', time: TIME, status: '-', values: {
                // 没有账户 = 客观（谁都能看见）
                status: [{ v: 'TLE', src: 'qoj:x', at: 'T3' }],
                time: [{ v: '2026.09.13 22:08', src: 'qoj:x', at: 'T3' }]
            }
        }
    };
    return {
        rootId: 'w',
        nodes,
        childOrder: { w: ['s'], s: ['c'], c: ['p'], p: ['r1', 'r2', 'r3'], r1: [], r2: [], r3: [] },
        parentOf: { w: null, s: 'w', c: 's', p: 'c', r1: 'p', r2: 'p', r3: 'p' },
        accounts: {
            local: { id: 'local', name: '本机', mappings: [] },
            k1: { id: 'k1', name: '主号', mappings: [] },
            k2: { id: 'k2', name: '小号', mappings: [] }
        },
        sources: {
            'qoj:x': { kind: 'script', rank: 20 },
            'srk:x': { kind: 'script', rank: 20 },
            'pta:x': { kind: 'board', rank: 30 }
        },
        trust: {
            categoryRank: ['manual', 'board', 'script', 'derived'],
            sources: {
                'qoj:x': { kind: 'script', rank: 20 },
                'srk:x': { kind: 'script', rank: 20 },
                'pta:x': { kind: 'board', rank: 30 }
            },
            fieldPrefer: {}
        }
    };
}

const scopeOf = (state, ...ids) => ({ scopeAccounts: ids, accounts: state.accounts, trust: state.trust });

test('stage2：status2 按范围算 —— k1 只看到自己的 WA，k2 看到自己的 AC', () => {
    const state = makeTree();

    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1')).get('p');
    assert.equal(asK1.status2, 2, 'k1 范围内只有 WA（无 AC）→ 状态2 = 2（已提交未通过）');
    assert.equal(asK1.acTime, TIME, 'k1 没有 AC → 没有 AC 时间');
    assert.equal(asK1.lastSubmitTime, '2026.09.13 22:08',
        'k1 自己的最晚是 r1(22:04)，但**客观的 r3** 也在这个范围里（22:08）→ 取 22:08');

    const asK2 = buildDerivedTable(state, scopeOf(state, 'k2')).get('p');
    assert.equal(asK2.status2, 3, 'k2 范围内有 AC → 3');
    assert.equal(asK2.acTime, '2026.09.13 22:06');

    // 客观值（r3，无账户）在谁的范围内都算
    const asNobody = buildDerivedTable(state, scopeOf(state, 'k1', 'k2')).get('p');
    assert.equal(asNobody.status2, 3, '两个人一起看 → 有 AC');
    assert.equal(asNobody.lastSubmitTime, '2026.09.13 22:08', '客观的 r3 是最后的提交');

    // 缓存字段（9 / 缓存时间）一个都没被读
    assert.notEqual(asK1.status2, 9);
    assert.equal(asK1.lastSubmitTime === '缓存时间', false);
});

test('stage2：容器的 statusComplete2 也跟着范围变（这就是"各自补题情况"）', () => {
    const state = makeTree();
    const t1 = buildDerivedTable(state, scopeOf(state, 'k1'));
    const t2 = buildDerivedTable(state, scopeOf(state, 'k2'));
    assert.equal(t1.get('c').statusComplete2, 0, 'k1：这题没过 → 0');
    assert.equal(t2.get('c').statusComplete2, 3, 'k2：过了 → 3（全部通过）');
    assert.equal(t1.get('w').statusComplete2, 0, '上层容器跟着算（不是抄缓存里的 9）');
    assert.equal(t2.get('w').statusComplete2, 3);
});

test('stage2：xcpcDifficulty 由**范围内**的 ratio 派生（且沿用"过滤不是优先级"的性质）', () => {
    const state = makeTree();
    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1')).get('p');
    const asAll = buildDerivedTable(state, {}).get('p');

    assert.notEqual(asK1.xcpcDifficulty, '缓存难度', '不是抄缓存');
    // k1 范围里有两个候选：k1 自己的 10（脚本）+ **客观的** 40（榜单）
    // → 榜单值胜出。账户层只做"过滤"，不是"我的一定优先"（阶段 1 记下的性质，
    //   在派生字段上同样成立 —— 因为派生读的就是投影值）。
    assert.equal(asK1.xcpcDifficulty, derivePxcpcDifficulty('40'));
    assert.equal(asAll.xcpcDifficulty, derivePxcpcDifficulty('40'));
    assert.equal(asK1.xcpcDifficulty, asAll.xcpcDifficulty, '这部分两者一致（榜单是客观值）');

    // 把客观那条去掉 → k1 范围内只剩自己的 10 → 难度档跟着变
    state.nodes.p.values.ratio = [{ v: '10', src: 'srk:x', at: 'T1', account: 'k1' }];
    clearDerivedMemo();
    const onlyMine = buildDerivedTable(state, scopeOf(state, 'k1')).get('p');
    assert.equal(onlyMine.xcpcDifficulty, derivePxcpcDifficulty('10'));
    assert.notEqual(onlyMine.xcpcDifficulty, derivePxcpcDifficulty('40'));
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k2')).get('p').xcpcDifficulty, '-',
        'k2 的范围里既没有自己的 ratio、也没有客观值 → 没有难度');
});

test('stage2：手动覆盖（忽略 / 赛时通过）也按范围生效', () => {
    const state = makeTree();
    // k1 把这道题标记为"忽略"（来源层里带账户的 manual 值）
    state.nodes.p.values.status2 = [{ v: '5', src: 'manual', at: 'T9', account: 'k1' }];

    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1')).get('p');
    assert.equal(asK1.status2, 5, 'k1 的"忽略"生效');
    const asK2 = buildDerivedTable(state, scopeOf(state, 'k2')).get('p');
    assert.equal(asK2.status2, 3, 'k2 不受 k1 的"忽略"影响（覆盖带归属）');

    // 客观覆盖（无账户）对谁都生效
    state.nodes.p.values.status2 = [{ v: '5', src: 'manual', at: 'T9' }];
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k1')).get('p').status2, 5);
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k2')).get('p').status2, 5);
});

test('stage2：容器的"忽略"（statusComplete2 = 4）同样带归属', () => {
    const state = makeTree();
    state.nodes.c.values.statusComplete2 = [{ v: '4', src: 'manual', at: 'T9', account: 'k2' }];
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k2')).get('c').statusComplete2, 4);
    assert.notEqual(buildDerivedTable(state, scopeOf(state, 'k1')).get('c').statusComplete2, 4);
});

test('status1 / statusComplete1 也按账户算（不是登录口径例外）', () => {
    const state = makeTree();
    // k1 按下了"已处理"——记进来源层，**带账户**
    setDerivedOverride(state.nodes.p, 'status1', 1, { account: 'k1', at: '2026-01-01' });
    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1'));
    const asK2 = buildDerivedTable(state, scopeOf(state, 'k2'));
    assert.equal(asK1.get('p').status1, 1, 'k1 自己按的 → 看得到');
    assert.equal(asK2.get('p').status1, 0, 'k2 看不到别人按的（这是按账户算的意义）');
    assert.equal(asK1.get('c').statusComplete1, 1, '按 k1：子树全处理完');
    assert.equal(asK2.get('c').statusComplete1, 0, '按 k2：没处理完');
});

test('stage2：一条来源值都没有的老数据 → 自动退回缓存（与阶段 1 同一套口径）', () => {
    const state = makeTree();
    // 把 r2 的来源层清掉（模拟 v7 老数据：只有缓存字段）
    state.nodes.r2.values = {};
    state.nodes.r2.status = 'AC';
    state.nodes.r2.time = '2026.09.13 22:06';
    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1')).get('p');
    assert.equal(asK1.status2, 3, 'r2 退回缓存（AC）→ 有 AC');
    assert.equal(asK1.acTime, '2026.09.13 22:06');
});

test('stage2：没有覆盖时，规则与 v7 的 autoComputeRules 完全一致', () => {
    const state = makeTree();
    state.nodes.p.values = {};           // 全部退回缓存
    state.nodes.p.ratio = '4.61';
    state.nodes.r1.values = {}; state.nodes.r1.status = 'AC'; state.nodes.r1.time = '2026.09.13 22:00';
    state.nodes.r2.values = {}; state.nodes.r2.status = 'AC'; state.nodes.r2.time = '2026.09.13 22:09';
    state.nodes.r3.values = {}; state.nodes.r3.status = 'WA'; state.nodes.r3.time = '2026.09.13 22:10';
    const d = buildDerivedTable(state, {}).get('p');
    assert.equal(d.status2, 3);
    assert.equal(d.acTime, '2026.09.13 22:00', '最早的 AC');
    assert.equal(d.lastSubmitTime, '2026.09.13 22:10');
    assert.equal(d.xcpcDifficulty, derivePxcpcDifficulty('4.61'));
});

test('stage2：pinnedValue 只认 manual，且按范围过滤', () => {
    const state = makeTree();
    const node = {
        values: {
            status2: [
                { v: '5', src: 'manual', at: 'T1', account: 'k1' },
                { v: '4', src: 'manual', at: 'T2', account: 'k2' },
                { v: '3', src: 'qoj:x', at: 'T3' }        // 不是 manual → 不算覆盖
            ]
        }
    };
    const scopeK1 = new Set(['k1']);
    assert.equal(pinnedValue(node, 'status2', null), '4', '不过滤时取最新的一条 manual');
    assert.equal(pinnedValue(node, 'status2', scopeK1), '5', '只认范围内那条');
    assert.equal(pinnedValue(node, 'status2', new Set(['k9'])), null, '都不在范围内 → 没有覆盖');
    assert.equal(pinnedValue({ values: {} }, 'status2', null), null);
});

test('stage2：记忆化 —— 同一份数据 + 同一范围只算一次；数据/范围变了就重算', () => {
    clearDerivedMemo();
    const state = makeTree();
    const t1 = derivedTable(state, scopeOf(state, 'k1'));
    assert.equal(derivedTable(state, scopeOf(state, 'k1')), t1, '同一份数据 → 同一张表');
    // 数据变了（模拟 Immer 换引用）
    const changed = { ...state, nodes: { ...state.nodes } };
    assert.notEqual(derivedTable(changed, scopeOf(changed, 'k1')), t1, '数据引用变了 → 重算');
    // 范围变了
    assert.notEqual(derivedTable(state, scopeOf(state, 'k2')), t1, '范围变了 → 重算');
});

test('stage2：derivedOf 直接读值；不在表里的节点退回缓存', () => {
    clearDerivedMemo();
    const state = makeTree();
    const opts = scopeOf(state, 'k2');
    assert.equal(derivedOf(state, state.nodes.p, 'status2', opts), 3);
    const virtual = { id: 'v_不存在', type: 'P', status2: 7 };
    assert.equal(derivedOf(state, virtual, 'status2', opts), 7, '虚拟节点 → 缓存');
    assert.equal(derivedOf(state, null, 'status2', opts), undefined);
});

test('stage2：算一遍**不改数据**（表是只读的）', () => {
    const state = makeTree();
    const before = JSON.stringify(state);
    buildDerivedTable(state, scopeOf(state, 'k1'));
    derivedTable(state, scopeOf(state, 'k1'));
    assert.equal(JSON.stringify(state), before);
});

test('多账户口径：只有别人提交过的题，对"我"是未使用', () => {
    // 判据：**读得到的 status 才算这个范围内的提交**（只按"存在一个 R 子节点"算 hasSub
    // 的话，一道"只有你提交过"的题在队友的口径下会显示成「已提交未通过」—— 他碰都没碰过）。
    const state = makeTree();                       // 里面 p 有 r1(AC,k1) 与 r2(WA,k2)
    state.nodes.p.values = {
        ...state.nodes.p.values,
        ratio: [{ v: '50', src: 'pta:x', at: 'T1' }]
    };
    // 造一个"只有 k1 提交过"的干净场景：p2 只挂 k1 的 R
    state.nodes.p2 = {
        id: 'p2', type: 'P', name: 'P2', status1: 0, status2: 0, ratio: '',
        values: {}
    };
    state.nodes.r3 = {
        id: 'r3', type: 'R', name: 'R3', status: 'WA', time: '2026.09.13 22:20',
        values: { status: [{ v: 'WA', src: 'qoj:x', at: 'T1', account: 'k1' }] }
    };
    state.childOrder.p2 = ['r3'];
    state.childOrder.r3 = [];
    state.parentOf.r3 = 'p2';
    state.childOrder.c.push('p2');
    state.parentOf.p2 = 'c';

    const asK1 = buildDerivedTable(state, scopeOf(state, 'k1')).get('p2').status2;
    const asK2 = buildDerivedTable(state, scopeOf(state, 'k2')).get('p2').status2;
    assert.equal(asK1, 2, 'k1：自己提交了但没过 → 已提交未通过');
    assert.equal(asK2, 0, 'k2：自己没碰过 → 未使用');

    // 谁都不提交过的题，两个人都是 0
    const p3 = { id: 'p3', type: 'P', name: 'P3', status1: 0, status2: 0, ratio: '', values: {} };
    state.nodes.p3 = p3;
    state.childOrder.p3 = [];
    state.parentOf.p3 = 'c';
    state.childOrder.c.push('p3');
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k1')).get('p3').status2, 0);
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k2')).get('p3').status2, 0);

    // `'-'`（提交了但没判）仍算提交 —— 不能被上面的判据误伤
    const r4 = {
        id: 'r4', type: 'R', name: 'R4', status: '-', time: '2026.09.13 22:30',
        values: { status: [{ v: '-', src: 'qoj:x', at: 'T1', account: 'k1' }] }
    };
    state.nodes.r4 = r4;
    state.childOrder.r4 = [];
    state.parentOf.r4 = 'p3';
    state.childOrder.p3.push('r4');
    assert.equal(buildDerivedTable(state, scopeOf(state, 'k1')).get('p3').status2, 2,
        '`-` 是合法值（提交了没判）→ 仍算"已提交未通过"这一档');
});

test('B6：派生表只装**派生**字段，不会把普通字段的缓存值混进来', () => {    clearDerivedMemo();
    const state = makeTree();
    const opts = scopeOf(state, 'k2');
    const t = buildDerivedTable(state, opts);
    const row = t.get('p');
    // 普通字段（name/ratio/cfDifficulty…）不该出现在派生表里 ——
    // 把"按登录口径直接取缓存"的过滤条件写反，就会塞非派生元素进来，于是
    // `derivedOf(state, p, 'name')` 会拿到缓存值、绕过范围投影。
    assert.equal('name' in row, false, 'name 不是派生字段');
    assert.equal('ratio' in row, false, 'ratio 不是派生字段');
    assert.equal(derivedOf(state, state.nodes.p, 'name', opts), undefined,
        '按范围读派生值时，普通字段拿不到缓存值（该走 viewValue/viewValueStrict）');
    // 派生字段都在表里（status1 也按范围算，不是登录口径的例外）
    assert.equal(row.status1 !== undefined, true, 'status1 在派生表里');
});

