// ================================================================
// 手改值的归属：客观（所有人共用）/ 账户私有（core/ops/node.js）
//
// 用户 2026-10-13 拍板，口径见 `docs/manual-values.md` 的「已拍板」一节：
//   ① 默认归属 = 记住上次选择（`settings.manualScope`），未设置则**按字段回落**（老行为）；
//   ② 清空按**这次编辑的归属**清（不再按字段名单分流）；
//   ③ 一键"转成所有人共用"。
//
// 每条都写清"去掉哪一行它会红"（否则它不是判据，只是复述实现）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

import { readField } from '../core/fieldValue.js';
import { createInitialState } from '../core/model/state.js';

// ⚠️ `core/ops/node.js` 在**纯 Node** 里直接 import 不起来：它取 `getXcpcDifficulty` 时
//    牵进 `utils/A_helpers.js` → `utils/id.js` → `shell/state.js` → **裸包名 `immer`**
//    （浏览器靠 `index.html` 的 import map 认，Node 没有 import map）。
//    这不是代码问题、是环境差异 —— 补它的那份钩子就是 `scripts/smoke/specifier-loader.mjs`
//    （冒烟测试全都靠它）。这里借它一次，好让本条判据能留在 `npm test` 里。
register(new URL('../../scripts/smoke/specifier-loader.mjs', import.meta.url));
const { recordManualValue, manualScopeOf, promoteManualToObjective, OBJECTIVE_PROMOTABLE_FIELDS } =
    await import('../core/ops/node.js');

const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { manual: { kind: 'manual', rank: 100 }, 'srk:x': { kind: 'script', rank: 20 } },
    fieldPrefer: {}
};

/** 一个能跑 `recordManualValue` 的最小 draft（清空那条要 `draft.nodes` 才收得了尾） */
function fixture(values = {}, settings = {}) {
    const node = { id: 'p1', type: 'P', name: '旧名', values, lastModified: 'T0' };
    return {
        node,
        draft: {
            nodes: { p1: node }, trust: TRUST,
            currentAccountId: 'k1', viewingAccountId: 'k1', settings
        }
    };
}

const entryAccount = e => (e.account === undefined ? '' : e.account);
const manuals = (node, field = 'name') => (node.values[field] || []).filter(x => x.src === 'manual');

// ① 手改成客观 ⇒ 换任意账户读**仍可见**
//    **去掉哪一行会红**：`const account = scope === 'objective' ? '' : draft.currentAccountId;`
//    换回老的 `NATURE_FIELD_KEYS.includes(field) ? '' : draft.currentAccountId` ⇒
//    `name` 会记成 k1 ⇒ 别的账户范围里读出来是空。
test('手改成客观：换任意账户读都还在', () => {
    const { node, draft } = fixture();
    node.lastModified = 'T1';
    assert.equal(recordManualValue(draft, node, 'name', '旧名', '所有人共用', { scope: 'objective' }), true);
    assert.deepEqual(manuals(node), [{ v: '所有人共用', src: 'manual', at: 'T1' }], '客观那条不写 account 键');
    for (const acc of ['k1', 'k2', 'local']) {
        assert.equal(readField(node, 'name', { trust: TRUST, scopeAccounts: [acc] }), '所有人共用');
    }
});

// ② 同一字段"客观 + 本账户"两条并存 ⇒ **最近写的那条赢**（优先级不新增规则）
//    **去掉哪一行会红**：写入时那行 `at: node.lastModified || getNowStr()`（改成空 / 不记时间）⇒
//    两条同分，`trust.js` 的 `isBetter` 只能"先到者胜" ⇒ 回到先写的客观那条。
test('客观与本账户两条并存：最近写的那条赢', () => {
    const { node, draft } = fixture();
    node.lastModified = '2024-01-01';                              // 先写客观
    recordManualValue(draft, node, 'name', '旧名', '客观的', { scope: 'objective' });
    node.lastModified = '2025-01-01';                              // 再写本账户（更晚）
    recordManualValue(draft, node, 'name', '客观的', '我的', { scope: 'account' });
    assert.equal(manuals(node).length, 2, '两条并存（各留各的）');
    assert.equal(readField(node, 'name', { trust: TRUST, viewingAccount: 'k1' }), '我的');

    node.lastModified = '2026-01-01';                              // 反过来：客观更晚 ⇒ 客观赢
    recordManualValue(draft, node, 'name', '我的', '客观的', { scope: 'objective' });
    assert.equal(readField(node, 'name', { trust: TRUST, viewingAccount: 'k1' }), '客观的');
});

// ③ 清空按**这次编辑的归属**清：清掉客观那条，本账户那条**还在**（反之亦然）
//    **去掉哪一行会红**：把清空那行换回老的按字段名单分流
//    （`NATURE_FIELD_KEYS.includes(field) ? removeManualFieldValue(node, field) : …`）⇒
//    清客观时会用"不看账户"的那条，把本账户那条一起带走。
test('清空按这次编辑的归属清（两条互不牵连）', () => {
    for (const scope of ['objective', 'account']) {
        const { node, draft } = fixture({
            name: [
                { v: '客观的', src: 'manual', at: 'T1' },
                { v: '我的', src: 'manual', at: 'T2', account: 'k1' }
            ]
        });
        assert.equal(recordManualValue(draft, node, 'name', '现显示值', '', { scope }), true);
        const left = manuals(node);
        assert.equal(left.length, 1, `清「${scope}」只该带走一条`);
        assert.equal(entryAccount(left[0]), scope === 'objective' ? 'k1' : '');
    }
});

// ③b 兜底（`v9.1.20`，补残余 1）：老数据里 nature 那格**带账户**的手改，按归属清是**清不掉**的
//     （nature 回落客观 = `''`，而那条挂在 k2 名下 ⇒ 精确那条命不中）⇒ 退回"这一格的手改（不看账户）"。
//    **去掉哪一行会红**：`if (!removed) removed = removeManualFieldValue(node, field);`
//    （去掉后 ① 的 `recordManualValue` 返回 false、那条 `manual` 原样留着 —— 正是用户那句
//      "这个重复怎么不停出现，我修了 3 回了"）
test('★ 兜底：nature 那格"带账户的老数据"也清得掉；但正常的另一条**不许被顺手带走**', () => {
    // ① 老数据：人填在 k2 名下 ⇒ 这次归属按字段回落成客观 ⇒ 精确清命不中 ⇒ 必须走兜底
    const a = fixture({ natureYear: [{ v: '2023', src: 'manual', at: 'T1', account: 'k2' }] });
    assert.equal(recordManualValue(a.draft, a.node, 'natureYear', '2023', '', {}), true,
        '★ 清空必须成功（改前 `removed === false` ⇒ 值留着 = 用户视角"清不掉"）');
    assert.equal(manuals(a.node, 'natureYear').length, 0, '那条手改真的没了');

    // ② 对照：客观 + 另一个账户两条并存，清客观**只**带走客观那条（兜底不许越权）
    const b = fixture({ natureYear: [
        { v: '客观的', src: 'manual', at: 'T1' },
        { v: '别人的', src: 'manual', at: 'T2', account: 'k2' }
    ] });
    assert.equal(recordManualValue(b.draft, b.node, 'natureYear', '客观的', '', { scope: 'objective' }), true);
    const left = manuals(b.node, 'natureYear');
    assert.equal(left.length, 1, '精确那条命中了 ⇒ 兜底**不该**被触发（否则 v9.1.10 那条口径就白定了）');
    assert.equal(entryAccount(left[0]), 'k2', '别人的那条留着');
});

// ④ 一键转客观：取**第一个非空账户**那条的值 ⇒ 只剩**一条** `account === ''` 的手改
//    **去掉哪一行会红**：`removeManualFieldValue(node, field);`（转之前先清掉其余 manual）——
//    不清的话 k1 那条还会留着，按"最近写的那条赢"把结果顶回去。
// ★ 规则（用户 2026-10-13 第二版）：只对某些字段开放；取**第一个取到的账户条目**（不是本账户那条）；
//   客观已有 ⇒ **不动它**；否则客观取第一个账户条目的值；之后**所有账户条目消失**。
//    **去掉哪一行会红**：`node.js` 里 `for (const acc of [...new Set(mine.map(accountOfEntry))]) removeManualValue(...)`
//    ⇒ 去掉后 k2 那条留着，第 1 条与本条都会红。
test('一键转成所有人共用：只留一条客观手改，其余按账户条目清掉', () => {
    const { node, draft } = fixture({
        cfDifficulty: [
            { v: '2400', src: 'manual', at: 'T9', account: 'k2' },     // 第一个取到的账户条目
            { v: '1800', src: 'manual', at: 'T1', account: 'k1' },
            { v: '1500', src: 'srk:x', at: 'T0' }                      // 别的来源，不许动
        ]
    });
    const r = promoteManualToObjective(draft, 'p1', 'cfDifficulty');
    assert.deepEqual({ converted: r.converted, value: r.value, from: r.from, kept: r.keptObjective },
        { converted: true, value: '2400', from: 'k2', kept: false });
    const left = manuals(node, 'cfDifficulty');
    assert.equal(left.length, 1, '其余 manual 条目一并清掉');
    assert.equal(entryAccount(left[0]), '', '唯一那条是客观的');
    assert.equal(left[0].v, '2400');
    assert.equal(readField(node, 'cfDifficulty', { trust: TRUST, scopeAccounts: ['k3'] }), '2400', '换谁看都是它');
    assert.equal(node.values.cfDifficulty.some(x => x.src === 'srk:x'), true, '别的来源一个字节没动');
});

test('★ 客观那条已经存在 ⇒ **不动它**，只把按账户的条目清掉', () => {
    const { node, draft } = fixture({
        contestTime: [
            { v: '客观时间', src: 'manual', at: 'T1', account: '' },
            { v: '我的时间', src: 'manual', at: 'T9', account: 'k1' }
        ]
    });
    const r = promoteManualToObjective(draft, 'p1', 'contestTime');
    assert.deepEqual({ converted: r.converted, value: r.value, kept: r.keptObjective },
        { converted: true, value: '客观时间', kept: true });
    const left = manuals(node, 'contestTime');
    assert.equal(left.length, 1);
    assert.equal(entryAccount(left[0]), '');
    assert.equal(left[0].v, '客观时间', '客观那条的值没被账户那条顶掉');
});

test('★ 只有名单里的字段能做这个动作（名单是唯一一处）', () => {
    assert.deepEqual([...OBJECTIVE_PROMOTABLE_FIELDS],
        ['contestTime', 'cfDifficulty', 'atcoderDifficulty', 'clistDifficulty']);
    assert.equal(OBJECTIVE_PROMOTABLE_FIELDS.includes('ratio'), false, '通过率不是"难度"，不在名单里');
});

test('一键转客观：没有可转的 / 字段不在名单里 ⇒ 什么都不动，如实返回"没转"', () => {
    const a = fixture({ name: [{ v: '脚本的', src: 'srk:x', at: 'T0' }] });
    const before = JSON.stringify(a.node.values);
    assert.equal(promoteManualToObjective(a.draft, 'p1', 'name').converted, false, '字段不在名单里 ⇒ 不转');
    assert.equal(JSON.stringify(a.node.values), before, '一个字节都不动');

    const b = fixture({ cfDifficulty: [{ v: '脚本的', src: 'srk:x', at: 'T0' }] });
    const before2 = JSON.stringify(b.node.values);
    assert.equal(promoteManualToObjective(b.draft, 'p1', 'cfDifficulty').converted, false, '没有按账户的手改 ⇒ 不转');
    assert.equal(JSON.stringify(b.node.values), before2, '一个字节都不动');
});

// ★ 回归锚：`settings.manualScope` **没设过**时按字段回落（nature 四格客观 / 其余账户）
//    **去掉哪一行会红**：`manualScopeOf` 里 `return NATURE_FIELD_KEYS.includes(field) ? 'objective' : 'account';`
//    （改成一律 `'account'`）⇒ nature 那条记成 k1。
test('没设过 manualScope：nature 四格客观、其余账户（老行为）', () => {
    assert.equal(createInitialState().settings.manualScope, '',
        `新状态里也是"没选过"（真给了 'account' 就会改掉 nature 四格的老行为）`);
    const { node, draft } = fixture({}, {});
    recordManualValue(draft, node, 'natureClass', undefined, 'xcpc/icpc/ec/pre');
    recordManualValue(draft, node, 'name', '旧名', '我的名字');
    assert.equal(entryAccount(manuals(node, 'natureClass')[0]), '', 'nature 四格客观');
    assert.equal(entryAccount(manuals(node)[0]), 'k1', '其余字段账户私有');

    // 设置成 objective（= 编辑框"上次的选择"）⇒ 连 `name` 也跟着走；显式 `opts.scope` 压过设置
    const b = fixture({}, { manualScope: 'objective' });
    recordManualValue(b.draft, b.node, 'name', '旧名', '共用');
    assert.equal(entryAccount(manuals(b.node)[0]), '');
    const c = fixture({}, { manualScope: 'objective' });
    recordManualValue(c.draft, c.node, 'name', '旧名', '我的', { scope: 'account' });
    assert.equal(entryAccount(manuals(c.node)[0]), 'k1', '显式 scope 优先于设置');
    assert.equal(manualScopeOf(c.draft, 'name', {}), 'objective', '设置仍是那个默认');
});
