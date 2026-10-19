// ================================================================
// 视图范围测试（view/scope.js）
//
// P7（方案 B）：渲染时全走投影，这里钉住"显示策略"与"严格口径"的分工：
//   - 显示（`viewValue`）：范围内的值优先；只有范围外的值时**显示缓存值**（不丢信息），
//     并用 `viewBorrowed` 让渲染层加悬停说明 —— 树是浏览视图，名字突然消失比"标注"糟；
//   - 聚合（`viewValueStrict`）：范围外的值**不算数** —— "只看我的"的数字才是真的我的。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    scopeOpts,
    viewValue,
    viewValueStrict,
    viewBorrowed,
    viewBorrowedTitle,
    viewNote,
    viewDerived
} from '../view/scope.js';

const trust = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        'pta:x': { kind: 'board', rank: 30 },
        'srk:x': { kind: 'script', rank: 20 }
    },
    fieldPrefer: {}
};

/** 一个节点的 ratio：k1 说的、k2 说的、以及客观来源说的 */
function makeState(viewingAccountId = 'k1', currentAccountId = 'k1') {
    return {
        trust,
        viewingAccountId,
        currentAccountId,
        accounts: {
            local: { id: 'local', name: '本机', mappings: [] },
            k1: { id: 'k1', name: '主号', mappings: [] },
            k2: { id: 'k2', name: '小号', mappings: [] }
        },
        nodes: {
            p1: {
                id: 'p1', type: 'P', name: '缓存里的名字', ratio: '缓存里的比例',
                values: {
                    ratio: [
                        { v: 'k1 的比例', src: 'pta:x', at: 'T1', account: 'k1' },
                        { v: 'k2 的比例', src: 'srk:x', at: 'T2', account: 'k2' },
                        { v: '客观比例', src: 'srk:x', at: 'T3' }
                    ],
                    name: [{ v: 'k2 的名字', src: 'srk:x', at: 'T1', account: 'k2' }]
                }
            },
            legacy: { id: 'legacy', type: 'P', name: '老数据', ratio: '4.61', values: {} }
        }
    };
}

test('scopeOpts：范围 = { 在查看的账户 }；同一 state 只算一次', () => {
    const s = makeState();
    const o1 = scopeOpts(s);
    assert.deepEqual(o1.scopeAccounts, ['k1']);
    assert.equal(o1.accounts, s.accounts);
    assert.equal(o1.trust, s.trust);
    assert.equal(scopeOpts(s), o1, '同一个 state 记忆化（渲染里会被调上万次）');

    // 换了在查看的账户 → 重新算
    const s2 = makeState('k2');
    assert.deepEqual(scopeOpts(s2).scopeAccounts, ['k2']);

    // 没配置账户的老状态 → 空集合（只看客观值），不炸
    assert.deepEqual(scopeOpts({}).scopeAccounts, []);
    assert.deepEqual(scopeOpts(null).scopeAccounts, []);
});

// ★ `v9.1.23`（用户 2026-10-13）：把「子账户」机制用起来 —— 但**做成一个选项、与原逻辑并列**
//   （用户："最好是绑定账户的选项，与原逻辑并列" → 追问后定成**全局设置** `settings.scopeMergeChildren`）。
//   开启时：**查看范围 = 本账户 + 它的直接子账户**（原话："不用递归，下层直接算就行"）。
//   为什么走 `scopeOpts` 一处就够：它是**显示路径唯一的范围构造口**（树上 / 统计 / 值级面板都走它）。
test('★ 开关关（默认）= 原逻辑：范围只有本账户，子账户不参与', () => {
    const s = makeState('k1');
    s.accounts.k1.children = ['k2', 'k3'];
    assert.deepEqual(scopeOpts(s).scopeAccounts, ['k1'],
        '★ 默认一字不变 —— 这是回归锚（改这个开关不许动到没开它的人）');
});

test('★ 开关开：范围 = 本账户 + **直接**子账户（不递归子孙）', () => {
    const s = makeState('k1');
    s.settings = { scopeMergeChildren: true };
    s.accounts.k1.children = ['k2', 'k3'];          // k1 的两个直接子账户
    s.accounts.k3 = { id: 'k3', name: '小号2', children: ['k4'], mappings: [] };
    s.accounts.k4 = { id: 'k4', name: '孙号', mappings: [] };
    assert.deepEqual(scopeOpts(s).scopeAccounts, ['k1', 'k2', 'k3'],
        '★ 本账户在头 + 直接子账户；**k4（孙）不在里面** —— 用户明确"不用递归"');

    // 开着但没有子账户 ⇒ 与关着一样（同一份东西，别多算）
    const solo = makeState('local');
    solo.settings = { scopeMergeChildren: true };
    assert.deepEqual(scopeOpts(solo).scopeAccounts, ['local']);
});

test('★ 开关开：子账户的提交算进"我这份"（本账号与子账户各交一发，合并后就是"过了"）', () => {
    const s = makeState('k1');
    s.settings = { scopeMergeChildren: true };
    s.accounts.k1.children = ['k2'];
    s.nodes.r1 = { id: 'r1', type: 'R', status: 'WA', time: '2026.01.01 10:00:00',
        values: { status: [{ v: 'WA', src: 'srk:x', at: 'T1', account: 'k1' }] } };
    s.nodes.r2 = { id: 'r2', type: 'R', status: 'AC', time: '2026.01.02 10:00:00',
        values: { status: [{ v: 'AC', src: 'srk:x', at: 'T2', account: 'k2' }] } };
    s.nodes.p1 = { id: 'p1', type: 'P', name: '题', values: {} };
    // ⚠️ 夹具要有**根**：派生表是从 `rootId` 往后序遍历出来的（少了根，表是空的 ⇒ 取到 undefined）
    s.nodes.o = { id: 'o', type: 'O', name: '根', values: {} };
    s.rootId = 'o';
    s.childOrder = { o: ['p1'], p1: ['r1', 'r2'] };
    s.parentOf = { p1: 'o', r1: 'p1', r2: 'p1' };
    s.view = {};
    s.pages = {};

    assert.deepEqual(scopeOpts(s).scopeAccounts, ['k1', 'k2']);
    assert.equal(viewDerived(s, s.nodes.p1, 'status2', scopeOpts(s)), 3,
        '★ 子账户那发 AC 在范围内 ⇒ "我这份" = 过了（3 赛后补题；夹具那两条 R 没有 submitKind ⇒ 不是 4 赛时通过）');

    // 对照：**同一个夹具**，只是把开关关掉 ⇒ 只看 k1 那发 WA（老行为）。
    //   ⚠️ 整份共享（`{...s}`）而不是另造一个：另造容易漏 `rootId`/根节点 ⇒ 派生表是空的 ⇒ 假红（刚踩过）。
    const off = { ...s, settings: {} };
    assert.deepEqual(scopeOpts(off).scopeAccounts, ['k1'], '开关关 ⇒ 有子账户也不带');
    assert.equal(viewDerived(off, off.nodes.p1, 'status2', scopeOpts(off)), 2,
        '不勾 ⇒ 只看自己那发 WA（已提交未通过 = 2）');
});

test('viewValue：范围内的值优先（范围外的账户不参与）', () => {
    const s = makeState('k1');
    assert.equal(viewValue(s, s.nodes.p1, 'ratio'), 'k1 的比例', 'k1 的榜单值（board 30）胜出');

    // ⚠️ 一个**刻意的性质**：账户层只是**过滤**，不是优先级项。
    //    看 k2 时候选 = k2 的 + 客观的，两者同来源类别/等级 → 按"时间新的"取客观那条。
    //    （"我自己的值要不要压过客观值"是个**产品决定**，现在没做；
    //      要做只需在 core/trust.js 的 score() 里加一项，并明确它对多账户视图的含义。）
    const s2 = makeState('k2');
    assert.equal(viewValue(s2, s2.nodes.p1, 'ratio'), '客观比例',
        'k2 的值与客观值同类同级时，取时间新的（规则如此，不是"谁属于我"）');
});

test('viewValue（显示策略）：只有别人的值时**显示缓存值**，不丢信息', () => {
    const s = makeState('k1');
    // name 只有 k2 的值 → k1 范围内没有 → 显示缓存（"缓存里的名字"）
    assert.equal(viewValue(s, s.nodes.p1, 'name'), '缓存里的名字');
    assert.equal(viewBorrowed(s, s.nodes.p1, 'name'), true, '渲染层据此加悬停说明');
    assert.match(viewBorrowedTitle(s, s.nodes.p1, 'name'), /不属于当前「在查看」的账户/);
    // 范围内有值的字段不算"借来的"
    assert.equal(viewBorrowed(s, s.nodes.p1, 'ratio'), false);
    assert.equal(viewBorrowedTitle(s, s.nodes.p1, 'ratio'), '');
});

test('viewValueStrict（聚合口径）：范围外的值**不算数**', () => {
    const s = makeState('k1');
    assert.equal(viewValueStrict(s, s.nodes.p1, 'ratio'), 'k1 的比例');
    assert.equal(viewValueStrict(s, s.nodes.p1, 'name'), '',
        '只有别人的值 → 严格口径下就是"没有"（统计不该把它算成我的）');
    // 空集合（在看一个不相干的账户）→ 只剩客观值
    const s3 = makeState('local');
    assert.equal(viewValueStrict(s3, s3.nodes.p1, 'ratio'), '客观比例');
});

test('viewValue：一条来源值都没有 → 退回缓存（老数据照样显示）', () => {
    const s = makeState();
    assert.equal(viewValue(s, s.nodes.legacy, 'ratio'), '4.61');
    assert.equal(viewBorrowed(s, s.nodes.legacy, 'ratio'), false, '这不是"借来的"，是没有来源值只能退回缓存');
    assert.equal(viewValueStrict(s, s.nodes.legacy, 'ratio'), '4.61');
});

test('列表字段的空是 []：显示与严格口径一致', () => {
    const s = makeState();
    assert.deepEqual(viewValueStrict(s, { id: 'x', values: {} }, 'tags'), [], '严格口径的空列表');
    assert.deepEqual(viewValue(s, { id: 'y', values: {} }, 'tags'), [], '显示口径的空列表');
});

test('viewNote：说清"在看谁"以及口径例外', () => {
    const same = makeState('k1', 'k1');
    assert.match(viewNote(same), /口径：主号/);
    assert.match(viewNote(same), /全部按这个账户算/);

    const diff = makeState('k2', 'k1');
    assert.match(viewNote(diff), /只看「小号」/);
    assert.doesNotMatch(viewNote(diff), /暂按登录账户/,
        'status1 / statusComplete1 也 scope 化之后，不该再声称有登录口径的例外');

    assert.equal(viewNote({}), '', '没配置账户 → 不占版面');
});

test('viewValue：绝不写状态（换范围不改数据）', () => {
    const s = makeState('k1');
    const before = JSON.stringify(s);
    viewValue(s, s.nodes.p1, 'ratio');
    viewValueStrict(s, s.nodes.p1, 'name');
    viewBorrowed(s, s.nodes.p1, 'name');
    viewNote(s);
    assert.equal(JSON.stringify(s), before);
});
