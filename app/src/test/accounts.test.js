// ================================================================
// 账户归认测试（core/accounts.js）
//
// 归认只做一件事：**查表**。所以这里的重点不是"猜得准不准"，
// 而是三类结果必须**分得开**、并且不猜：
//   - 认出来（唯一命中）
//   - 填了线索但没匹配上（用户该去补映射）
//   - 完全没填线索（源里根本没这个信息）
//   - 匹配到多个账户 → 报冲突，**不挑一个**
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ACCOUNT_CLUE_KEY,
    clueOf,
    resolveAccount,
    resolveClueAndCount,
    newCounter,
    describeCounter
} from '../core/accounts.js';

function accounts() {
    return {
        local: {
            id: 'local', name: '本机', isLocal: true,
            mappings: [{ source: 'local', field: '主账户', value: 'yes' }]
        },
        'k7f2p': {
            id: 'k7f2p', name: '主号',
            mappings: [
                { source: 'cf', field: 'handle', value: 'ALICE_CF' },
                { source: 'qoj', field: '提交者', value: 'alice' }
            ]
        },
        'x91qz': {
            id: 'x91qz', name: '小号',
            mappings: [{ source: 'qoj', field: '提交者', value: 'alice_alt' }]
        }
    };
}

test('clueOf：只认元列里的非空值', () => {
    assert.deepEqual(
        clueOf({ [ACCOUNT_CLUE_KEY]: { source: 'cf', field: 'handle', value: ' A ' } }),
        { source: 'cf', field: 'handle', value: 'A' }
    );
    // 没有元列 / 元列不是对象 / 值是空的 → 都是"没线索"
    assert.equal(clueOf({}), null);
    assert.equal(clueOf({ [ACCOUNT_CLUE_KEY]: 'cf' }), null);
    assert.equal(clueOf({ [ACCOUNT_CLUE_KEY]: { source: 'cf', field: 'handle', value: '  ' } }), null);
    assert.equal(clueOf(null), null);
});

test('resolveAccount：唯一命中才给账户', () => {
    const acc = accounts();
    assert.equal(
        resolveAccount(acc, { source: 'qoj', field: '提交者', value: 'alice' }).accountId,
        'k7f2p'
    );
    // source / field / value 任一不同都不算命中（不做模糊匹配、不做大小写折叠）
    assert.equal(
        resolveAccount(acc, { source: 'cf', field: 'handle', value: 'alice_cf' }).accountId,
        ''
    );
    assert.equal(
        resolveAccount(acc, { source: 'cf', field: '提交者', value: 'alice' }).accountId,
        ''
    );
    // 没匹配上 ≠ 冲突
    assert.deepEqual(
        resolveAccount(acc, { source: 'cf', field: 'handle', value: '别人' }).conflict,
        []
    );
});

test('resolveAccount：多个账户都声明了同一映射 → 报冲突，不猜', () => {
    const acc = accounts();
    acc['x91qz'].mappings.push({ source: 'qoj', field: '提交者', value: 'alice' });
    const r = resolveAccount(acc, { source: 'qoj', field: '提交者', value: 'alice' });
    assert.equal(r.accountId, '');
    assert.deepEqual(r.conflict.sort(), ['k7f2p', 'x91qz']);
});

test('resolveAccount：线索 source 逐字符全等 —— 不做"去赛季"之类的推断', () => {
    // CF/QOJ 的线索**不带赛季**（账号不会每年一换）。
    // 于是带赛季的旧线索**不该**被认成平台级映射 —— 宁可报"没匹配上"，
    // 也不要靠推断把值安到别人头上（要换格式就重导一次，见 _usage.md）。
    const acc = accounts();
    const r = resolveAccount(acc, { source: 'cf:23', field: 'handle', value: 'alice_cf' });
    assert.equal(r.accountId, '', '不猜：`cf:23` ≠ `cf`');
    assert.deepEqual(r.conflict, []);
});

test('resolveClueAndCount：三类分开计数，冲突单独留痕', () => {
    const acc = accounts();
    acc['x91qz'].mappings.push({ source: 'qoj', field: '提交者', value: 'alice' });

    const c = newCounter();
    const clue = (v) => (v ? { source: 'qoj', field: '提交者', value: v } : null);

    assert.equal(resolveClueAndCount(acc, clue('alice_alt'), c), 'x91qz');
    assert.equal(resolveClueAndCount(acc, clue('没登记过'), c), '');
    assert.equal(resolveClueAndCount(acc, clue(null), c), '');
    assert.equal(resolveClueAndCount(acc, clue('alice'), c), '');

    assert.equal(c.matched, 1);
    assert.equal(c.unmatched, 2, '没匹配上 + 冲突 都算"填了但没认出来"');
    assert.equal(c.noClue, 1);
    assert.equal(c.conflicts.length, 1);
    assert.deepEqual(c.conflicts[0].accounts.sort(), ['k7f2p', 'x91qz']);
    assert.equal(c.conflicts[0].value, 'alice');
});

test('resolveClueAndCount：线索本来就是 null 时算「源没给线索」', () => {
    const c = newCounter();
    assert.equal(resolveClueAndCount(accounts(), null, c), '');
    assert.equal(c.noClue, 1);
    assert.equal(c.unmatched, 0);
});

test('计数器可以省略（只要 id，不要统计）', () => {
    assert.equal(
        resolveClueAndCount(accounts(), { source: 'qoj', field: '提交者', value: 'alice' }),
        'k7f2p'
    );
});

test('describeCounter：人话摘要，且认不出比认得出更值得说', () => {
    assert.equal(describeCounter(newCounter()), '没有可归认的记录');
    const c = newCounter();
    c.matched = 12;
    c.unmatched = 2;
    c.noClue = 300;
    assert.equal(describeCounter(c), '认出 12 条，线索没匹配上 2 条，源没给线索 300 条');
    assert.equal(describeCounter(null), '');
});

test('空注册表 / 坏数据不炸', () => {
    const c = newCounter();
    const clue = { source: 'qoj', field: '提交者', value: 'alice' };
    assert.equal(resolveAccount({}, clue).accountId, '');
    assert.equal(resolveAccount(null, clue).accountId, '');
    assert.equal(resolveClueAndCount({ 'a': { mappings: 'not-an-array' } }, clue, c), '');
    assert.equal(c.unmatched, 1);
});
