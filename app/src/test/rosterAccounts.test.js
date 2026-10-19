// ================================================================
// 「映射 ⇄ me.json 名册」的单测（src/test/rosterAccounts.test.js）
//
// 方向：**绝对可信源是映射（在 AppState 里），
// me.json 本质上完全是映射的派生部分**。
//
// ⇒ 这里钉两件事：
//   ① **派生**：应用里的账户（映射）→ me.json 的名册形状
//      （`cf : handle = X` → `cf: "X"`；`nk:2026 : 用户名 = X` → `byYear.nk["2026"]`；
//       推不出来的如 `pta:icpc2026` **原样留**）；
//   ② 反着读（`accountOf` + `mappingsOfAccount`）能还原出同一批映射 —— 两边对得上。
//
// 另外钉文档级小改（改/建/删账户、切 current）—— 那是给"从 me.json 读回来"这类
// 一次性迁移用的纯函数。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    accountOf,
    mappingsOfAccount,
    rosterAccountsFrom,
    describeAccount,
    patchAccountInDoc,
    addAccountToDoc,
    removeAccountFromDoc,
    setCurrentInDoc
} from '../core/rosterAccounts.js';

/** 一份"派生结果"的样子（me.json 的 accounts[]） */
const DOC = {
    accounts: [
        {
            name: '我', nature: '本人',
            cf: 'me_cf', qoj: 'me_qoj', nk: '2026届队名', hdu: 'demo/teamA', pta: 'demo',
            byYear: { nk: { 2023: '某昵称', 2025: 'demo0' } },
            mappings: [{ source: 'pta:12345', field: '队伍', value: 'demo' }]
        },
        { name: '队友', cf: 'mate_cf', qoj: 'mate_qoj' }
    ],
    current: '我',
    cf: { apiKey: 'SECRET-1' },
    qoj: { cookie: 'SECRET-2' }
};

/** 应用里的账户（**真源**的形状） */
const APP_ACCOUNTS = {
    a1: {
        id: 'a1', name: '我', nature: '本人', children: [], isLocal: false, active: true,
        mappings: [
            { source: 'cf', field: 'handle', value: 'me_cf' },
            { source: 'qoj', field: '提交者', value: 'me_qoj' },
            { source: 'nk:2026', field: '用户名', value: '2026届队名' },
            { source: 'nk:2023', field: '用户名', value: '23届队名' },
            { source: 'hdu:2026', field: 'handle', value: 'demo/teamA' },
            { source: 'pta:icpc2026', field: '队伍', value: 'demo' }      // 命名空间 ⇒ 推不出来，原样留
        ]
    },
    a2: {
        id: 'a2', name: '队友', nature: '', children: [], isLocal: false, active: false,
        mappings: [{ source: 'cf', field: 'handle', value: 'mate_cf' }]
    },
    a3: { id: 'a3', name: '空的', children: [], isLocal: false, active: true, mappings: [] }
};

const texts = (list) => list.map((m) => `${m.source}:${m.field}=${m.value}`).sort();

test('① 派生：映射 → 名册项（cf 变字段 / `nk:2026` 变 byYear / 推不出来的原样留）', () => {
    const items = rosterAccountsFrom(APP_ACCOUNTS);
    assert.deepEqual(items.map((i) => i.name), ['我', '队友'], '空账户不导出（导了也没用）');
    const me = items[0];
    assert.equal(me.cf, 'me_cf');
    assert.equal(me.qoj, 'me_qoj');
    assert.equal(me.id, 'a1', 'id 一并带上');
    assert.equal(me.nature, '本人');
    assert.deepEqual(me.byYear, { nk: { 2026: '2026届队名', 2023: '23届队名' }, hdu: { 2026: 'demo/teamA' } },
        '`<平台>:<两位年>` → byYear 的 4 位年份');
    assert.deepEqual(me.mappings, [{ source: 'pta:icpc2026', field: '队伍', value: 'demo' }],
        '⚠️ 推不出来的映射**一条不丢**');
    assert.equal(items[1].active, false, '停用状态带出去（爬虫会跳过停用的账户）');
    assert.equal(items[0].active, true,
        '★ 活跃的也**显式写** true（用户 2026-10-15："每个账户都需要是否启用的信息"；'
        + '而且 me.json 表单那边"整列都是布尔"才给勾选框 ⇒ 不写就永远没有那一列）');
});

test('② 往返：派生 → 读回来，映射集合一条不差', () => {
    const items = rosterAccountsFrom(APP_ACCOUNTS);
    const me = accountOf(items[0]);
    assert.deepEqual(texts(mappingsOfAccount(me)), texts(APP_ACCOUNTS.a1.mappings),
        '导出去再读回来 == 同一批映射');
});

test('③ 读回来：账号推出来的 + 显式写着的（pta 命名空间靠显式那条）', () => {
    const acc = accountOf(DOC.accounts[0]);
    const all = texts(mappingsOfAccount(acc, new Date('2026-06-01T00:00:00Z')));
    assert.ok(all.includes('cf:handle=me_cf'), 'cf 推得出');
    assert.ok(all.includes('nk:2023:用户名=某昵称'), 'byYear 的往年推得出（线索的赛季是四位年）');
    assert.ok(all.includes('pta:12345:队伍=demo'), '显式那条也在');
    assert.ok(!all.some((t) => t.startsWith('pta:26')), 'pta 的赛季是命名空间 ⇒ 不从裸账号硬推');
});

test('④ 带赛季平台的"裸账号"算本赛季（多校每年换名字）', () => {
    const acc = accountOf({ name: '我', nk: 'X', hdu: 'Y' });
    assert.deepEqual(texts(mappingsOfAccount(acc, new Date('2026-06-01'))),
        ['hdu:2026:handle=Y', 'nk:2026:用户名=X']);
    assert.deepEqual(texts(mappingsOfAccount(acc, new Date('2027-03-01'))),
        ['hdu:2027:handle=Y', 'nk:2027:用户名=X'], '"今年"跟着年份走，不是写死的');
});

test('⑤ 凭据永远不会被当账号读进来', () => {
    assert.ok(!JSON.stringify(accountOf(DOC.accounts[0])).includes('SECRET'));
    assert.ok(!JSON.stringify(rosterAccountsFrom(APP_ACCOUNTS)).includes('SECRET'));
});

test('⑥ 名册项：对象/数组字段（byYear / mappings）原样读得出来', () => {
    const acc = accountOf(DOC.accounts[0]);
    assert.deepEqual(acc.handles, { cf: 'me_cf', qoj: 'me_qoj', nk: '2026届队名', hdu: 'demo/teamA', pta: 'demo' });
    assert.deepEqual(acc.byYear, { nk: { 2023: '某昵称', 2025: 'demo0' } });
    assert.deepEqual(acc.mappings, [{ source: 'pta:12345', field: '队伍', value: 'demo' }]);
    assert.equal(accountOf({ name: 'x', active: false }).active, false);
    assert.equal(accountOf(null).name, '');
});

test('⑦ 坏输入都不炸', () => {
    assert.deepEqual(rosterAccountsFrom(null), []);
    assert.deepEqual(rosterAccountsFrom({ x: { mappings: [{ source: 'cf', field: 'handle', value: 'a' }] } }), [],
        '没有名字的项跳过');
    assert.deepEqual(rosterAccountsFrom({ x: { name: 'A', mappings: 'bad' } }), [], '坏 mappings 当没有');
    assert.equal(accountOf(null).name, '');
    assert.deepEqual(mappingsOfAccount(accountOf({ name: 'x' })), []);
});

test('⑧ 文档级小改：改 / 建 / 删 / 切 current（都返回**新**对象，不改入参）', () => {
    const before = JSON.stringify(DOC);
    const renamed = patchAccountInDoc(DOC, '队友', { name: '队友B', nature: '搭档' });
    assert.equal(renamed.accounts[1].name, '队友B');
    assert.equal(renamed.accounts[1].nature, '搭档');
    assert.equal(JSON.stringify(DOC), before, '入参没被改（纯函数）');
    assert.equal(patchAccountInDoc(DOC, '不存在', { nature: 'x' }), null, '找不到 ⇒ null');
    assert.equal(patchAccountInDoc(DOC, '队友', { name: '我' }), null, '重名 ⇒ null（别悄悄合并）');

    const added = addAccountToDoc(DOC, { name: '第三人', cf: 'third_cf' });
    assert.equal(added.accounts.length, 3);
    assert.equal(added.current, '我', '新建账户**不**抢"登录账户"（那是"我是谁"）');
    assert.equal(addAccountToDoc(DOC, { name: '我' }), null, '重名不让加');

    const removed = removeAccountFromDoc(DOC, '我');
    assert.deepEqual(removed.accounts.map((a) => a.name), ['队友']);
    assert.equal(removed.current, '队友', 'current 不悬空');

    const switched = setCurrentInDoc(DOC, '队友', 'viewing');
    assert.equal(switched.viewing, '队友');
    assert.equal(switched.current, '我', 'current 不受影响');
    assert.equal(setCurrentInDoc(DOC, 'local', 'current').current, 'local',
        '内置「本机」不在文件里 ⇒ 用 `"local"` 标记指它');
    assert.equal(setCurrentInDoc(DOC, '查无此人', 'current'), null);
});

test('⑨ 改名时把别人的子账户指针与 current 一起搬', () => {
    const doc = {
        accounts: [
            { name: '父', children: ['子'] },
            { name: '子', cf: 'x' }
        ],
        current: '子'
    };
    const out = patchAccountInDoc(doc, '子', { name: '子B' });
    assert.deepEqual(out.accounts[0].children, ['子B'], '父的 children 跟着改');
    assert.equal(out.current, '子B', 'current 跟着改');
});

test('⑩ describeAccount：给界面看的"这人有哪些账号"', () => {
    const text = describeAccount(accountOf(DOC.accounts[0]));
    assert.match(text, /cf=me_cf/);
    assert.match(text, /nk:2025=demo0/);
});
