// ================================================================
// 重跑归认测试（core/ops/reattribute.js）
//
// P3：补映射之后，把**已经躺在数据里的**值按当前映射重算归属。
// 只改 `account`，不碰 `v / src / at`；没有线索的老值**不猜、不动**。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reattributeValues, describeReattribute, collectUnmatchedClues, clueText,
         purgeValuesByClue, describePurge } from '../core/ops/reattribute.js';

function makeState() {
    return {
        accounts: {
            local: { id: 'local', name: '本机', children: [], isLocal: true, mappings: [] },
            k1: {
                id: 'k1', name: '主号', children: [], isLocal: false,
                mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]
            }
        },
        nodes: {
            r1: {
                id: 'r1', type: 'R',
                values: {
                    status: [{
                        v: 'AC', src: 'qoj', at: 'T1',
                        clue: { source: 'qoj', field: '提交者', value: 'alice' }
                    }]
                }
            }
        }
    };
}

test('P3：把"客观"值改成认得出的账户（只动 account）', () => {
    const s = makeState();
    const r = reattributeValues(s);
    assert.equal(r.withClue, 1);
    assert.equal(r.matched, 1);
    assert.equal(r.changed, 1);
    assert.equal(s.nodes.r1.values.status[0].account, 'k1');
    assert.equal(s.nodes.r1.values.status[0].v, 'AC', '值本身没动');
    assert.equal(s.nodes.r1.values.status[0].src, 'qoj', '来源没动');
    assert.equal(s.nodes.r1.values.status[0].at, 'T1', '时间没动');
    assert.deepEqual(s.nodes.r1.values.status[0].clue,
        { source: 'qoj', field: '提交者', value: 'alice' }, '线索留着（下次还能重跑）');
});

test('P3：幂等 —— 再跑一遍没有任何变化', () => {
    const s = makeState();
    reattributeValues(s);
    const again = reattributeValues(s);
    assert.equal(again.changed, 0);
    assert.equal(again.withClue, 1);
});

test('P3：映射删掉后重跑 → 回落客观（删掉 account 键，不写空串）', () => {
    const s = makeState();
    reattributeValues(s);
    assert.equal(s.nodes.r1.values.status[0].account, 'k1');
    s.accounts.k1.mappings = [];
    const r = reattributeValues(s);
    assert.equal(r.changed, 1);
    assert.equal(r.unmatched, 1);
    assert.equal('account' in s.nodes.r1.values.status[0], false);
});

test('P3：没有线索的老值**不动**（不猜）', () => {
    const s = makeState();
    s.nodes.r1.values.ratio = [{ v: '4.61', src: 'local:v7', at: 'T0' }];
    const r = reattributeValues(s);
    assert.equal(r.withClue, 1, '只有那条带线索的算数');
    assert.equal(s.nodes.r1.values.ratio[0].account, undefined, '老值没被凭空指派账户');
});

test('P3：冲突（多个账户认领同一线索）→ 留作客观并报出来', () => {
    const s = makeState();
    s.accounts.k2 = {
        id: 'k2', name: '小号', children: [], isLocal: false,
        mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]
    };
    const r = reattributeValues(s);
    assert.equal(r.matched, 0);
    assert.equal(r.conflicts, 1);
    assert.equal(r.conflictList.length, 1);
    assert.deepEqual(r.conflictList[0].accounts.sort(), ['k1', 'k2']);
    assert.equal(r.conflictList[0].clue, 'qoj:提交者=alice');
    assert.equal('account' in s.nodes.r1.values.status[0], false, '不猜 → 客观');
});

test('P3：停用的账户不参与（重跑也不会把它认回来）', () => {
    const s = makeState();
    s.accounts.k1.active = false;
    const r = reattributeValues(s);
    assert.equal(r.matched, 0);
    assert.equal(r.unmatched, 1);
});

test('P3：dryRun 只统计不写（界面预览用）', () => {
    const s = makeState();
    const before = JSON.stringify(s.nodes.r1.values);
    const r = reattributeValues(s, { dryRun: true });
    assert.equal(r.changed, 1, '预览说"会改 1 条"');
    assert.equal(JSON.stringify(s.nodes.r1.values), before, '但状态一点没动');
});

test('P3：跨节点、跨字段都能重跑；坏数据不炸', () => {
    const s = makeState();
    s.nodes.r2 = {
        id: 'r2', type: 'R',
        values: {
            time: [
                { v: 'T', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'alice' } },
                { v: 'X', src: 's', at: '', clue: null },
                { v: 'Y', src: 's', at: '', clue: { source: '', field: '', value: '' } }
            ],
            link: 'not-an-array'
        }
    };
    s.nodes.bad = null;
    const r = reattributeValues(s);
    assert.equal(r.scanned, 4, '两条带线索 + 两条噪声');
    assert.equal(r.changed, 2, 'r1.status + r2.time[0]（另外两条没线索/线索无效）');
    assert.equal(s.nodes.r2.values.time[0].account, 'k1');
    assert.equal(s.nodes.r2.values.time[1].account, undefined);
    assert.equal(s.nodes.r2.values.time[2].account, undefined);
});

test('P3：describeReattribute 给界面用', () => {
    const s = makeState();
    const r = reattributeValues(s);
    assert.match(describeReattribute(r), /重算 1 条带线索的值/);
    assert.match(describeReattribute(r), /改了 1 条归属/);
    assert.match(describeReattribute({ withClue: 0 }), /没有带账户线索的值/);
    assert.equal(describeReattribute(null), '');
});

// ================================================================
// 「未认领的线索」清单（实测"2183 条没匹配上"却不知道是哪条）
// ================================================================

test('collectUnmatchedClues：按"源:字段=值"聚合、按条数降序、带例子', () => {
    const s = makeState();
    s.nodes.r2 = {
        id: 'r2', type: 'R', name: '提交 2',
        values: {
            status: [
                // 没登记的 qoj 用户 ×2
                { v: 'AC', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'bob' } },
                { v: 'WA', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'bob' } },
                // 没登记的 cf handle ×1
                { v: 'AC', src: 's', at: '', clue: { source: 'cf:26', field: 'handle', value: 'teammate_a' } },
                // 认得出的（k1）→ 不算
                { v: 'AC', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'alice' } },
                // 完全没线索 → 不算（那属于"源没给"）
                { v: 'AC', src: 's', at: '', clue: null }
            ]
        }
    };
    const { total, kinds } = collectUnmatchedClues(s);
    assert.equal(total, 3, '只有"填了线索但认不出"的进清单');
    assert.equal(kinds.length, 2, '聚合成两种');
    assert.equal(kinds[0].value, 'bob', '条数多的排前面');
    assert.equal(kinds[0].count, 2);
    assert.equal(kinds[0].source, 'qoj');
    assert.equal(kinds[0].conflict, false);
    assert.ok(kinds[0].examples.length >= 1, '带例子（节点/字段）');
    assert.equal(kinds[1].source, 'cf:26');
    assert.equal(kinds[1].count, 1);
    assert.equal(clueText(kinds[1]), 'cf:26:handle=teammate_a');
});

test('collectUnmatchedClues：认得出的一条都不列；top 只限条数', () => {
    const s = makeState();          // 只有 k1 能认出来的那条
    const all = collectUnmatchedClues(s);
    assert.equal(all.total, 0);
    assert.deepEqual(all.kinds, []);

    s.nodes.r3 = {
        id: 'r3', type: 'R',
        values: {
            status: [
                { v: 'A', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'A' } },
                { v: 'B', src: 's', at: '', clue: { source: 'qoj', field: '提交者', value: 'B' } }
            ]
        }
    };
    const top1 = collectUnmatchedClues(s, { top: 1 });
    assert.equal(top1.total, 2, 'total 是"值条数"，不受 top 影响');
    assert.equal(top1.kinds.length, 1, 'top 只限制列出的种类');
});

test('collectUnmatchedClues：被多个账户同时认领的线索标 conflict（不是缺映射）', () => {
    const s = makeState();
    s.accounts.k2 = {
        id: 'k2', name: '小号', children: [], isLocal: false,
        mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }]   // 与 k1 重复
    };
    const { kinds } = collectUnmatchedClues(s);
    assert.equal(kinds.length, 1);
    assert.equal(kinds[0].conflict, true, '冲突要标出来');
    assert.deepEqual(kinds[0].accounts.sort(), ['k1', 'k2']);
});

test('collectUnmatchedClues：坏数据不炸（null 节点 / 非数组 / 空线索）', () => {
    const s = { accounts: {}, nodes: { bad: null, x: { values: { f: 'not-an-array', g: [] } } } };
    const r = collectUnmatchedClues(s);
    assert.equal(r.total, 0);
    assert.deepEqual(r.kinds, []);
    assert.deepEqual(collectUnmatchedClues(null), { total: 0, kinds: [] });
});

// ================================================================
// 按线索清值（`purgeValuesByClue`）—— 2026-10-17 加的运维动作
//
// 真事：适配器把各年的账户线索写错成同一个值（杭电 2021/2023/2024/2025 全写成 `TEAM0/teamA`）。
// 修好后重新导入，新线索是另一组（合并键里线索算身份）⇒ 旧组留着、每格两条一样的值。
// 这个动作按"源+字段+值"把**无主**的那些删掉。
// ================================================================
function makePurgeState() {
    const oldClue = { source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' };
    const newClue = { source: 'hdu:2025', field: 'handle', value: 'teamE' };
    return {
        accounts: {
            local: { id: 'local', name: '本机', children: [], isLocal: true, mappings: [] },
            me: {
                id: 'me', name: '我', children: [], isLocal: false,
                mappings: [{ source: 'hdu:2025', field: 'handle', value: 'teamE' }]
            }
        },
        nodes: {
            r1: {
                id: 'r1', type: 'R',
                values: {
                    // 同一格两条：旧线索（无主）+ 新线索（已被 me 认领）
                    language: [
                        { v: 'G++', src: 'hdu-scraper', at: 'T2', clue: newClue },
                        { v: 'G++', src: 'hdu-scraper', at: 'T1', clue: oldClue }
                    ],
                    // 只有旧线索 ⇒ 删完这一格该整个消失
                    memoryUsed: [{ v: '0', src: 'hdu-scraper', at: 'T1', clue: oldClue }]
                }
            },
            r2: {
                id: 'r2', type: 'R',
                values: { language: [{ v: 'C++', src: 'hdu-scraper', at: 'T1', clue: oldClue }] }
            }
        }
    };
}

test('purgeValuesByClue：只删这条线索的无主值（同格别的线索照留）', () => {
    const s = makePurgeState();
    const r = purgeValuesByClue(s, { source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' });
    assert.equal(r.removed, 3, 'r1.language 的旧那条 + r1.memoryUsed + r2.language');
    assert.equal(r.skippedMapped, 0);
    assert.equal(r.fields, 2, 'r1.memoryUsed 与 r2.language 整格被清空 ⇒ 字段撤掉（r1.language 还剩新线索那条）');
    assert.equal(s.nodes.r1.values.language.length, 1, '新线索那条必须留下');
    assert.equal(s.nodes.r1.values.language[0].clue.value, 'teamE');
    assert.equal(s.nodes.r1.values.memoryUsed, undefined, '清空的字段要一起撤掉（别留空数组）');
    assert.equal(s.nodes.r2.values.language, undefined);
});

test('★ 已认领的不动：补了映射之后，这条动作就管不着它了', () => {
    const s = makePurgeState();
    // 把旧线索也映射到"我" ⇒ 它变成有主的值
    s.accounts.me.mappings.push({ source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' });
    const r = purgeValuesByClue(s, { source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' });
    assert.equal(r.removed, 0, '有主的值一条都不许删');
    assert.equal(r.skippedMapped, 3);
    assert.equal(s.nodes.r2.values.language.length, 1);
});

test('purgeValuesByClue：dry-run 一个字节都不动，且只认整条线索（不按值清）', () => {
    const s = makePurgeState();
    const before = JSON.stringify(s);
    const r = purgeValuesByClue(s, { source: 'hdu:2025', field: 'handle', value: 'TEAM0/teamA' }, { dryRun: true });
    assert.equal(r.removed, 3);
    assert.equal(JSON.stringify(s), before, 'dry-run 不许改任何东西');
    // 换个 value（同一个源/字段）⇒ 不该命中
    const r2 = purgeValuesByClue(s, { source: 'hdu:2025', field: 'handle', value: '2026' });
    assert.equal(r2.removed, 0);
    // 没有线索 ⇒ 不表态
    assert.equal(purgeValuesByClue(s, null).removed, 0);
    assert.match(describePurge({ removed: 3, fields: 1, skippedMapped: 2 }), /已删掉 3 条值/);
    assert.match(describePurge({ removed: 3, fields: 1, skippedMapped: 2 }), /2 条已被映射认领/);
});

