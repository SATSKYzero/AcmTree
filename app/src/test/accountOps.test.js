// ================================================================
// 账户注册表写操作测试（core/ops/account.js）
//
// 这里钉的是三件容易做错、后果都不小的事：
//   1. **DAG 不成环**（children 是真源，加边必须查环）
//   2. **删账户不伤数据**（摘点 + 指针回落，别的账户的 children 也要摘掉）
//   3. **只读边界**（viewing ≠ current ⇒ 手改抛异常；相等或没填 ⇒ 放行）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LOCAL_ACCOUNT_ID,
    newAccountId,
    hasAccount,
    listAccountIds,
    listActiveAccountIds,
    isAccountActive,
    accountLabel,
    accountName,
    childrenOf,
    parentsOf,
    ancestorsOf,
    descendantsOf,
    wouldCycle,
    candidateChildren,
    isViewOnly,
    assertManualEditAllowed,
    createAccount,
    saveAccount,
    removeAccount,
    setCurrentAccount,
    setViewingAccount,
    setAccountActive,
    moveAccount,
    normalizeMappings,
    findMappingConflicts
} from '../core/ops/account.js';
import { resolveClueAndCount } from '../core/accounts.js';
import { usableValues } from '../core/trust.js';

/** 一个只有默认账户的空壳（形状与 core/model/state.js 一致） */
function makeState() {
    return {
        accounts: {
            local: {
                id: 'local', name: '本机', nature: '默认', children: [], isLocal: true,
                mappings: [{ source: 'local', field: '主账户', value: 'yes' }]
            }
        },
        currentAccountId: 'local',
        viewingAccountId: 'local'
    };
}

test('newAccountId：12 位乱码，与名字无关', () => {
    const a = newAccountId();
    const b = newAccountId();
    assert.equal(a.length, 12);
    assert.match(a, /^[a-z0-9]{12}$/);
    assert.notEqual(a, b, '两次生成不该撞（12 位 36 进制）');
});

test('createAccount：必填名字、可挂父、id 不重复', () => {
    const s = makeState();
    const id = createAccount(s, { name: '主号', nature: '本人唯一账号', id: 'k11111111111' });
    assert.equal(id, 'k11111111111');
    assert.equal(s.accounts[id].name, '主号');
    assert.deepEqual(s.accounts[id].children, [], '新账户没有子账户');
    assert.deepEqual(s.accounts[id].mappings, [], '新账户没有映射');
    assert.equal(s.accounts[id].isLocal, false);

    assert.throws(() => createAccount(s, { name: '  ' }), /名称不能为空/);
    assert.throws(() => createAccount(s, { name: 'x', id: 'k11111111111' }), /已存在/);

    // 挂到父下
    const child = createAccount(s, { name: '小号', parentId: id });
    assert.deepEqual(childrenOf(s, id), [child]);
    assert.deepEqual(parentsOf(s, child), [id]);
    assert.throws(() => createAccount(s, { name: 'x', parentId: '不存在' }), /父账户不存在/);
});

test('DAG：一个子账户可以有多个父，且不能成环', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    const b = createAccount(s, { name: 'B', id: 'bbbbbbbbbbbb' });
    const c = createAccount(s, { name: 'C', id: 'cccccccccccc' });
    saveAccount(s, a, { children: [c] });
    saveAccount(s, b, { children: [c] });

    assert.deepEqual(childrenOf(s, a), [c]);
    assert.deepEqual(parentsOf(s, c).sort(), [a, b].sort(), 'C 有两个父（DAG）');
    assert.deepEqual(descendantsOf(s, a), [c]);
    assert.deepEqual(ancestorsOf(s, c).sort(), [a, b].sort());

    // a → c 已存在；把 a 挂到 c 下就成环
    assert.equal(wouldCycle(s, c, a), true, 'parent=c, child=a：a 的子孙里有 c');
    assert.equal(wouldCycle(s, a, c), false, '已有的边不是环');
    assert.equal(wouldCycle(s, a, a), true, '自己挂自己是环');

    // 候选里不能出现自己与自己的祖先
    const cand = candidateChildren(s, a);
    assert.equal(cand.includes(a), false, '候选不含自己');
    // a 的祖先目前没有，所以剩下 b / c / local
    assert.deepEqual(cand.sort(), [b, c, LOCAL_ACCOUNT_ID].sort());

    // saveAccount 兜底：硬塞成环 / 塞自己不写进去，也不崩
    //   a 的祖先为空集（没人把 a 当子账户）→ b 是合法子账户，只有 a 自己会被剔除
    const dropped = saveAccount(s, a, { children: [c, b, a] });
    assert.deepEqual(dropped, [a], '只有"自己"会被剔除');
    assert.deepEqual(childrenOf(s, a).sort(), [b, c].sort());

    // 真的成环时会被剔除：把 a 挂到 c 下（c 在 a 的子孙里）
    saveAccount(s, c, { children: [a] });
    assert.equal(childrenOf(s, c).includes(a), false, '成环的边不会写进去');
});

test('saveAccount：名称必填、映射去空去重、children 清洗', () => {
    const s = makeState();
    const id = createAccount(s, { name: '主号', id: 'k11111111111' });

    assert.throws(() => saveAccount(s, id, { name: '   ' }), /名称不能为空/);
    assert.throws(() => saveAccount(s, 'nope', { name: 'x' }), /账户不存在/);

    const dropped = saveAccount(s, id, {
        name: '主号2',
        nature: '小号',
        children: ['不存在', id],
        mappings: [
            { source: ' cf ', field: ' handle ', value: ' alice ' },
            { source: 'cf', field: 'handle', value: 'alice' },      // 完全重复 → 去掉
            { source: 'cf', field: 'handle', value: '' },            // 值空 → 去掉
            { source: 'qoj', field: '提交者', value: 'alice' }
        ]
    });

    assert.equal(s.accounts[id].name, '主号2');
    assert.equal(s.accounts[id].nature, '小号');
    assert.deepEqual(s.accounts[id].children, [], '不存在与自己都被剔除');
    assert.deepEqual(dropped.sort(), ['不存在', id].sort());
    assert.deepEqual(s.accounts[id].mappings, [
        { source: 'cf', field: 'handle', value: 'alice', current: true },
        { source: 'qoj', field: '提交者', value: 'alice', current: true }
    ]);
});

test('removeAccount：local 不可删；摘掉别的账户里的引用；指针回落', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    const b = createAccount(s, { name: 'B', id: 'bbbbbbbbbbbb', parentId: a });
    setViewingAccount(s, b);
    setCurrentAccount(s, b);

    assert.throws(() => removeAccount(s, LOCAL_ACCOUNT_ID), /不能删除/);

    removeAccount(s, b);
    assert.equal(hasAccount(s, b), false);
    assert.deepEqual(childrenOf(s, a), [], '父的 children 里也要摘掉它');
    assert.equal(s.viewingAccountId, LOCAL_ACCOUNT_ID, '指针不能指向已删的账户');
    assert.equal(s.currentAccountId, LOCAL_ACCOUNT_ID);
});

test('指针切换：账户必须存在', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    assert.equal(setViewingAccount(s, a), a);
    assert.throws(() => setViewingAccount(s, '不存在'), /账户不存在/);
    assert.throws(() => setCurrentAccount(s, '不存在'), /账户不存在/);
});

test('只读边界：viewing ≠ current 才禁手改，且错误信息说清是谁', () => {
    const s = makeState();
    const a = createAccount(s, { name: '主号', id: 'aaaaaaaaaaaa' });
    const b = createAccount(s, { name: '小号', id: 'bbbbbbbbbbbb' });

    // 同一个账户：不禁
    setCurrentAccount(s, a);
    setViewingAccount(s, a);
    assert.equal(isViewOnly(s), false);
    assertManualEditAllowed(s, '修改题目字段');

    // 看别人：禁
    setViewingAccount(s, b);
    assert.equal(isViewOnly(s), true);
    assert.throws(() => assertManualEditAllowed(s, '修改题目字段'),
        (err) => /正在查看「小号」/.test(err.message) && /登录账户是「主号」/.test(err.message));

    // 什么都没填（旧状态）：不禁 —— 老数据不能突然变只读
    assert.equal(isViewOnly({}), false);
    assert.equal(isViewOnly({ currentAccountId: 'local' }), false);
    assert.equal(isViewOnly(null), false);
    assertManualEditAllowed({}, 'x');
});

test('accountLabel / listAccountIds：同名账户靠 id 后 4 位区分', () => {
    const s = makeState();
    createAccount(s, { name: '主号', id: 'aaaaaaaaaaaa' });
    createAccount(s, { name: '主号', id: 'bbbbbbbbbbbb' });
    assert.equal(accountLabel(s, 'aaaaaaaaaaaa'), '主号 #aaaa');
    assert.equal(accountLabel(s, 'bbbbbbbbbbbb'), '主号 #bbbb');
    assert.notEqual(accountLabel(s, 'aaaaaaaaaaaa'), accountLabel(s, 'bbbbbbbbbbbb'));
    assert.equal(accountLabel(s, ''), '（无）');
    assert.equal(accountName(s, 'nope'), 'nope', '查不到时原样显示，不抛');
    assert.deepEqual(listAccountIds(s).length, 3, '含默认账户');
});

test('normalizeMappings：非对象 / 半截行一律丢掉', () => {
    assert.deepEqual(normalizeMappings(null), []);
    assert.deepEqual(normalizeMappings([null, 1, 'x', {}]), []);
    assert.deepEqual(
        normalizeMappings([{ source: 'cf', field: 'handle', value: 'A', current: false }]),
        [{ source: 'cf', field: 'handle', value: 'A', current: false }],
        'current:false 要保留（界面上的"当前"勾选）'
    );
});

test('findMappingConflicts：谁还也声明了同一条线索', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    const b = createAccount(s, { name: 'B', id: 'bbbbbbbbbbbb' });
    const m = { source: 'qoj', field: '提交者', value: 'alice' };
    saveAccount(s, a, { mappings: [m] });
    saveAccount(s, b, { mappings: [m] });

    assert.deepEqual(findMappingConflicts(s, m, a), [b], 'B 也认领了 → 冲突');
    assert.deepEqual(findMappingConflicts(s, m, b), [a]);
    assert.deepEqual(findMappingConflicts(s, m, 'cccccccccccc'), [a, b]);
    assert.deepEqual(findMappingConflicts(s, { source: 'qoj', field: '提交者', value: 'X' }, a), []);
    assert.deepEqual(findMappingConflicts(s, { source: '', field: '', value: '' }, a), []);
});

// ================================================================
// 活跃账户
// 「只有活跃账户能作登录/查看、参与归认、显示在字段来源里」
// ================================================================

test('P2：默认活跃；local 永远活跃（停用不了）', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    assert.equal(isAccountActive(s, a), true, '新建的账户默认活跃');
    assert.equal(isAccountActive(s, LOCAL_ACCOUNT_ID), true, 'local 活跃');
    assert.equal(isAccountActive(s, '不存在'), false);

    assert.throws(() => setAccountActive(s, LOCAL_ACCOUNT_ID, false), /本机/);
    assert.throws(() => saveAccount(s, LOCAL_ACCOUNT_ID, { active: false }), /本机/);
    setAccountActive(s, a, false);
    assert.equal(isAccountActive(s, a), false);
    setAccountActive(s, a, true);
    assert.equal(isAccountActive(s, a), true, '可以启用回来（停用≠删除）');
});

test('P2：老数据没有 active 键 → 视为活跃（不打标记就是活跃）', () => {
    const s = makeState();
    s.accounts.old = { id: 'old', name: '老账户', children: [], mappings: [] };
    assert.equal(isAccountActive(s, 'old'), true);
});

// ================================================================
// 41m：账户顺序（账户允许交换顺序）
// ================================================================

/** 三个账户，名字故意与"建的顺序"相反（只按名字排的话是 阿/波/次） */
function stateWithThree() {
    const s = makeState();
    createAccount(s, { name: '次', id: 'cccccccccccc' });
    createAccount(s, { name: '阿', id: 'aaaaaaaaaaaa' });
    createAccount(s, { name: '波', id: 'bbbbbbbbbbbb' });
    return s;
}

test('41m：没有 `order` 时按名字排（老数据照旧），「本机」恒第一', () => {
    const s = makeState();
    s.accounts.a1 = { id: 'a1', name: '波', children: [], mappings: [] };
    s.accounts.a2 = { id: 'a2', name: '阿', children: [], mappings: [] };
    assert.deepEqual(listAccountIds(s), [LOCAL_ACCOUNT_ID, 'a2', 'a1'], '本机第一，其余按名字');
});

test('41m：新建的账户带 `order`，排在最后（不会插进按名字排的那一段）', () => {
    const s = stateWithThree();
    assert.equal(typeof s.accounts.aaaaaaaaaaaa.order, 'number', '新建就写好 order');
    assert.deepEqual(listAccountIds(s),
        [LOCAL_ACCOUNT_ID, 'cccccccccccc', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
        '顺序 = 建的先后（不是名字）');
});

test('41m：moveAccount 上移/下移一位，并把整列归一化成 0..n-1', () => {
    const s = stateWithThree();
    const before = listAccountIds(s).filter((id) => id !== LOCAL_ACCOUNT_ID);
    assert.equal(moveAccount(s, before[2], -1), true, '波 上移一位');
    const moved = listAccountIds(s).filter((id) => id !== LOCAL_ACCOUNT_ID);
    assert.deepEqual(moved, [before[0], before[2], before[1]], '与上一位交换');
    // ⚠️ 序号是**整列**（含恒在第一的「本机」）重排的 ⇒ 它从 1 起；「本机」拿 0（白拿，它靠规则恒第一）
    assert.deepEqual(moved.map((id) => s.accounts[id].order), [1, 2, 3],
        '★ 整列被重写成紧凑序号（不是只改两个）');
    assert.equal(moveAccount(s, before[2], 1), true, '再下移回去');
    assert.deepEqual(listAccountIds(s).filter((id) => id !== LOCAL_ACCOUNT_ID), before);
});

test('41m：到头了返回 false（界面据此把箭头画灰，而不是不画）', () => {
    const s = stateWithThree();
    const ids = listAccountIds(s).filter((id) => id !== LOCAL_ACCOUNT_ID);
    assert.equal(moveAccount(s, ids[0], -1), false, '第一个不能再上移');
    assert.equal(moveAccount(s, ids[2], 1), false, '最后一个不能再下移');
    assert.deepEqual(listAccountIds(s).filter((id) => id !== LOCAL_ACCOUNT_ID), ids, '没动');
});

test('41m：「本机」不参与交换（它不是一个能被排序的人）', () => {
    const s = stateWithThree();
    assert.equal(moveAccount(s, LOCAL_ACCOUNT_ID, 1), false);
    assert.equal(listAccountIds(s)[0], LOCAL_ACCOUNT_ID, '还在第一');
    assert.equal(s.accounts.local.order, undefined, '也没给它写 order');
});

test('41m：认不出的账户 id ⇒ 抛（不是静默什么都不做）', () => {
    const s = stateWithThree();
    assert.throws(() => moveAccount(s, '不存在', 1), /账户不存在/);
});

test('41m：只读模式（viewing ≠ current）⇒ 调整顺序也被拒', () => {
    const s = stateWithThree();
    s.currentAccountId = 'aaaaaaaaaaaa';
    s.viewingAccountId = 'bbbbbbbbbbbb';
    assert.throws(() => moveAccount(s, 'cccccccccccc', 1), /只读|正在查看/);
});

test('P2：停用的账户不能作登录/查看账户', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    setAccountActive(s, a, false);
    assert.throws(() => setCurrentAccount(s, a), /已停用/);
    assert.throws(() => setViewingAccount(s, a), /已停用/);
    assert.deepEqual(listActiveAccountIds(s), [LOCAL_ACCOUNT_ID], '活跃列表里没有它');
});

test('P2：停用当前/正在查看的账户 → 指针回落 local（不悬空）', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    setCurrentAccount(s, a);
    setViewingAccount(s, a);
    setAccountActive(s, a, false);
    assert.equal(s.currentAccountId, LOCAL_ACCOUNT_ID);
    assert.equal(s.viewingAccountId, LOCAL_ACCOUNT_ID);
});

test('P2：停用的账户不参与归认（映射留着，但不生效）', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    saveAccount(s, a, { mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }] });
    const counter = { matched: 0, unmatched: 0, noClue: 0, conflicts: [] };

    assert.equal(
        resolveClueAndCount(s.accounts, { source: 'qoj', field: '提交者', value: 'alice' }, counter),
        a, '活跃时认得出'
    );
    setAccountActive(s, a, false);
    assert.equal(
        resolveClueAndCount(s.accounts, { source: 'qoj', field: '提交者', value: 'alice' }, counter),
        '', '停用后认不出（映射还在，只是不生效）'
    );
    assert.equal(s.accounts[a].mappings.length, 1, '映射没被删');
});

test('P2：与停用账户重复的映射不算冲突', () => {
    const s = makeState();
    const a = createAccount(s, { name: 'A', id: 'aaaaaaaaaaaa' });
    const b = createAccount(s, { name: 'B', id: 'bbbbbbbbbbbb' });
    const m = { source: 'qoj', field: '提交者', value: 'alice' };
    saveAccount(s, a, { mappings: [m] });
    saveAccount(s, b, { mappings: [m] });
    assert.deepEqual(findMappingConflicts(s, m, a), [b]);
    setAccountActive(s, b, false);
    assert.deepEqual(findMappingConflicts(s, m, a), [], '停用账户不参与归认 → 不算冲突');
});

test('P2：非活跃账户的值不参与投影（usableValues）', () => {
    const accounts = {
        k1: { id: 'k1', name: '主号' },
        k2: { id: 'k2', name: '小号', active: false }
    };
    const values = [
        { v: 'A', src: 's1', at: '', account: 'k1' },
        { v: 'B', src: 's2', at: '', account: 'k2' },
        { v: '客观', src: 's3', at: '' }
    ];
    const t = { categoryRank: ['manual', 'board', 'script', 'derived'], sources: {}, fieldPrefer: {} };

    const all = usableValues('name', values, t, { viewingAccount: 'k1' });
    assert.deepEqual(all.map(x => x.v), ['A', '客观'], '停用账户的 B 不参与投影');
    // 不传任何 opts（老调用方）→ 完全不过滤（行为一字不变）
    assert.equal(usableValues('name', values, t).length, 3);
    // 只传 viewing、不传 accounts：viewing 指向一个**已删**的账户 → 它的值照样算候选
    // （没传账户表时的行为；传了账户表就不行了 —— 见下一条）
    const dangling = [
        { v: 'A', src: 's1', at: '', account: 'k1' },
        { v: '悬空', src: 's9', at: '', account: '已删账户' }
    ];
    assert.deepEqual(
        usableValues('name', dangling, t, { viewingAccount: '已删账户' }).map(x => x.v),
        ['悬空'], '没传账户表时：悬空 id 仍可被查看'
    );
    assert.deepEqual(
        usableValues('name', dangling, t, { viewingAccount: '已删账户', accounts }).map(x => x.v),
        [], '传了账户表 → 悬空 id（账户已删）也不参与'
    );
    // 传了 accounts 且**在查看**的账户恰好是停用的 → 它的值同样不参与（指针本来也不该指向它）
    const off = usableValues('name', values, t, { viewingAccount: 'k2', accounts });
    assert.deepEqual(off.map(x => x.v), ['客观']);
});
