// ================================================================
// `countPass.readOwnRow`：组值合并的取值器必须读"**本范围投影过**的自己那份"
// （src/test/readOwnRowProjection.test.js）
//
// 症状（用户实测，2026-10-13 拍板方案 A）：dedup 下组那份 `acTime` 走的是**缓存字段**
//   （谁过过都算、分不清账户），而同一行的 `status2` 走投影 ⇒ 组头带着"别人账户的 AC 时间"
//   进了「时间范围 AC 列表」，网格那一格按当前范围算成 未使用(0) / 已提交未通过(2)。
//   只换「查看账户」这个不一致就消失。
//
// 本夹具：一个合成头 + 两个成员（**同一个组**、各自挂在自己的 C 下），
//   · AC 提交（r1）记在账户 **A** 名下；WA 提交（r2）记在账户 **B** 名下；
//   · 组头的缓存字段 `acTime` = 导入时 autoCompute 写下的"含那次 AC"那份（**不分账户**）。
// ⇒ 查 B：组那份 `acTime` 必须是空（B 没 AC），而组那份 `status2` = 2（提交过、没通过）；
//    查 A：两者都是"过了"。
//
// 纯逻辑（不碰 DOM / IndexedDB）：`npm test` 用纯 Node 跑。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCountPass } from '../core/query/countPass.js';
import { SYNTH_PREFIX } from '../core/query/groupCount.js';
import { TIME_PLACEHOLDER } from '../core/model/constants.js';

const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { 'qoj:x': { kind: 'script', rank: 20 } },
    fieldPrefer: {}, groupPrefer: {}
};
const SRC = 'qoj:x';
const KEY = `${SYNTH_PREFIX}gp`;
const set = (v, account) => [{ v, src: SRC, at: 'T1', account }];

/**
 * o
 * ├ synP（P，synthKey=KEY）   ← 组头（缓存字段 `acTime` 是"含 A 那次 AC"的那份）
 * ├ c1 └ p1（P，ownerSynth=KEY）└ r1（R：AC / 时间 / **账户 A**）
 * └ c2 └ p2（P，ownerSynth=KEY）└ r2（R：WA / 时间 / **账户 B**）
 */
function fixture() {
    const nodes = {
        o: { id: 'o', type: 'O' },
        // ⚠️ 组头的缓存字段 = 缓存的一份物化结果（这里刻意给成"含 A 那次 AC"）
        synP: { id: 'synP', type: 'P', synthKey: KEY, name: '合成题', acTime: '2026.03.19 22:32:42' },
        c1: { id: 'c1', type: 'C' },
        p1: { id: 'p1', type: 'P', ownerSynth: KEY },
        c2: { id: 'c2', type: 'C' },
        p2: { id: 'p2', type: 'P', ownerSynth: KEY },
        r1: { id: 'r1', type: 'R', values: { status: set('AC', 'A'), time: set('2026.03.19 22:32:42', 'A') } },
        r2: { id: 'r2', type: 'R', values: { status: set('WA', 'B'), time: set('2026.03.20 10:00:00', 'B') } }
    };
    const childOrder = { o: ['synP', 'c1', 'c2'], synP: [], c1: ['p1'], c2: ['p2'], p1: ['r1'], p2: ['r2'], r1: [], r2: [] };
    const parentOf = { o: null, synP: 'o', c1: 'o', c2: 'o', p1: 'c1', p2: 'c2', r1: 'p1', r2: 'p2' };
    return {
        rootId: 'o', nodes, childOrder, parentOf,
        accounts: { A: { id: 'A', name: '甲', mappings: [] }, B: { id: 'B', name: '乙', mappings: [] } },
        trust: TRUST, settings: { stats: { countMode: 'dedup' } }
    };
}

/** 跑那一趟（dedup、只看某一个账户），返回组头那一行 */
function headRow(viewing) {
    const st = fixture();
    st.viewingAccountId = viewing;
    const pass = runCountPass(st, {
        mode: 'dedup', scopeAccounts: [viewing], accounts: st.accounts, trust: TRUST
    });
    return { row: pass.rowOf('synP'), own: pass.rowOf('p1') };
}

test('查看 B（只交过 WA）：组那份 acTime 必须为空 / 与 status2 同口径', () => {
    const { row, own } = headRow('B');
    assert.equal(row.status2, 2, 'B 提交过、没通过 ⇒ 组那份 status2 = 2');
    // ★ 病灶：组那份 acTime 原来读**缓存字段** ⇒ 这里是 A 那次 AC 的时间（别人的）
    assert.ok(row.acTime === undefined || row.acTime === '' || row.acTime === TIME_PLACEHOLDER,
        `查看 B 时组那份 acTime 不能是"别人的 AC"：实际 ${JSON.stringify(row.acTime)}`);
    // ★ 网格那一格：`p1` 自己那份（B 在这道副本上没提交过 ⇒ 未使用(0)）；`p2` = 2
    //    —— 这才是与"组那份 acTime 却说 B 过了"自相矛盾的那一格
    assert.equal(own.status2, 0, 'B 在 p1 这道副本上没提交过 ⇒ 未使用(0)');
    assert.ok(own.acTime === undefined || own.acTime === '' || own.acTime === TIME_PLACEHOLDER,
        `查看 B 时自己那份 acTime 也不能有值：实际 ${JSON.stringify(own.acTime)}`);
});

test('查看 A（AC 是 A 的）：组那份 acTime 与 status2 都是"过了"', () => {
    const { row } = headRow('A');
    assert.equal(row.status2, 3, '有范围内的 AC ⇒ 组那份 status2 = 3');
    assert.equal(row.acTime, '2026.03.19 22:32:42', '组那份 acTime = 范围内那次 AC 的时间');
});
