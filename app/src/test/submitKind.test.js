// ================================================================
// R.submitKind（提交性质）与 P.status2 的「赛时通过 / 赛后补题」
//
// 需求："提交是不是赛时；这关系到主脚本题目的 stat2 3/4（AC 是否赛时）"
//
// 钉住三件事：
//   1. 判据是 **R.submitKind === '赛时'**，而不是"有没有 AC"+手工覆盖；
//   2. 赛时的 AC ⇒ 4；只有 VP / 补题的 AC ⇒ 3；手工覆盖仍然有效（向后兼容）；
//   3. 空 submitKind（老数据/判不出来）⇒ 退化成老行为（3），不会崩也不会误判成 4。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { pStatus2, SUBMIT_KIND_DURING, SUBMIT_KIND_VP, SUBMIT_KIND_AFTER, SUBMIT_KINDS }
    from '../core/model/status.js';
import { computePstatus2 } from '../core/autoComputeRules.js';
import { derivePstatus2 } from '../core/derive.js';
import { computeMerge } from '../features/AutoImport/merge.js';

const S2_WA = 2, S2_AFTER = 3, S2_DURING = 4, S2_IGNORE = 5;

// ---- 1. 纯规则 ----
test('pStatus2：赛时的 AC ⇒ 4；只有补题/VP 的 AC ⇒ 3', () => {
    assert.equal(pStatus2(true, true, 0, true), S2_DURING, '有赛时 AC');
    assert.equal(pStatus2(true, true, 0, false), S2_AFTER, '只有非赛时 AC');
    assert.equal(pStatus2(true, true, 0), S2_AFTER, '不传 hasDuringAC（老调用方）⇒ 老行为');
});

test('pStatus2：手工覆盖仍然压过自动判定', () => {
    assert.equal(pStatus2(true, true, S2_DURING, false), S2_DURING, '手标赛时通过 ⇒ 4');
    assert.equal(pStatus2(true, true, S2_IGNORE, true), S2_IGNORE, '忽略无条件保留');
    assert.equal(pStatus2(true, false, 0, false), S2_WA, '有提交没 AC');
    assert.equal(pStatus2(false, false, 1, false), 1, '待写');
});

// ---- 2. 缓存路径（computePstatus2 读 R 的缓存字段） ----
function tree(children) {
    const s = { rootId: 'p', nodes: { p: { id: 'p', type: 'P', status2: 0, childOrder: [] } }, childOrder: { p: [] }, parentOf: { p: null } };
    for (const c of children) {
        const id = 'r' + Object.keys(s.nodes).length;
        s.nodes[id] = { id, type: 'R', lastModified: '', ...c };
        s.nodes.p.childOrder.push(id);
        s.childOrder[id] = [];
        s.childOrder.p.push(id);
        s.parentOf[id] = 'p';
    }
    return s;
}

test('computePstatus2：赛时 AC ⇒ 4，纯补题 ⇒ 3', () => {
    const during = tree([{ status: 'AC', submitKind: SUBMIT_KIND_DURING, time: 't' }]);
    assert.equal(computePstatus2(during, during.nodes.p), S2_DURING);

    const after = tree([{ status: 'AC', submitKind: SUBMIT_KIND_AFTER, time: 't' }]);
    assert.equal(computePstatus2(after, after.nodes.p), S2_AFTER);

    const vp = tree([{ status: 'AC', submitKind: SUBMIT_KIND_VP, time: 't' }]);
    assert.equal(computePstatus2(vp, vp.nodes.p), S2_AFTER, 'VP 不算赛时通过');
});

test('computePstatus2：一条 WA 的赛时 + 一条 AC 的补题 ⇒ 仍算 3', () => {
    const s = tree([
        { status: 'WA', submitKind: SUBMIT_KIND_DURING, time: 't1' },
        { status: 'AC', submitKind: SUBMIT_KIND_AFTER, time: 't2' }
    ]);
    assert.equal(computePstatus2(s, s.nodes.p), S2_AFTER, '只有赛时的 **AC** 才算赛时通过');
});

test('computePstatus2：老数据（submitKind 空）⇒ 3，不会误判成赛时', () => {
    const s = tree([{ status: 'AC', time: 't' }]);
    assert.equal(computePstatus2(s, s.nodes.p), S2_AFTER);
});

// ---- 3. 派生路径（按账户范围算） ----
test('derivePstatus2：submitKind 也走 read()，所以按范围生效', () => {
    const state = { nodes: {}, childOrder: {}, parentOf: {} };
    state.nodes.p = { id: 'p', type: 'P' };
    state.nodes.r1 = { id: 'r1', type: 'R' };
    state.nodes.r2 = { id: 'r2', type: 'R' };
    state.childOrder.p = ['r1', 'r2'];
    // k1 看到的是"赛时 AC"，k2 看到的是"补题 AC"
    const byK1 = (n, f) => ({ status: 'AC', submitKind: SUBMIT_KIND_DURING }[f]);
    const byK2 = (n, f) => ({ status: 'AC', submitKind: SUBMIT_KIND_AFTER }[f]);
    assert.equal(derivePstatus2(state, state.nodes.p, byK1, () => 0), S2_DURING, 'k1：赛时通过');
    assert.equal(derivePstatus2(state, state.nodes.p, byK2, () => 0), S2_AFTER, 'k2：赛后补题');
});

// ---- 4. 导入能落节点（与 importPolicies 那条同源，这里再钉值域） ----
test('submitKind 能落节点，且值域就是那三个（空 = 判不出）', () => {
    const { fields } = computeMerge({
        type: 'R',
        incoming: { status: 'AC', time: 't', submitKind: SUBMIT_KIND_DURING },
        existing: null
    });
    assert.equal(fields.submitKind, SUBMIT_KIND_DURING);
    assert.deepEqual([...SUBMIT_KINDS], ['赛时', 'VP', '补题'], '值域：赛时 / VP / 补题（空表示判不出）');
});

// ---- 5. 跨语言契约：Python 的值域必须与这里**逐字**一致 ----
// 值域是跨语言的：应用侧真源是 `core/model/status.js`，爬虫侧真源是 `scripts/crate.py`。
// 任何一边改了文案，另一边就静默对不上 —— 应用仍会把值显示出来，但 `pStatus2` 的
// 「赛时通过」判定永远不成立（现象是"标了赛时却算成赛后补题"）。所以用测试钉住。
//
// 各适配器（nk/hdu/cf/qoj/pta_submissions）只准用 `crate.py` 的那三个常量，
// 不许各自抄字面量 —— 所以钉住这一处就等于钉住了全部产出点。
test('跨语言值域同步：crate.py 的 SUBMIT_KINDS 与 JS 的逐字一致', () => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const src = fs.readFileSync(path.join(root, 'scripts', 'crate.py'), 'utf8');
    const m = src.match(/^SUBMIT_KINDS\s*=\s*\(([^)]*)\)/m);
    assert.ok(m, 'crate.py 里应该有一行 `SUBMIT_KINDS = (...)`');
    const pyKinds = m[1].split(',')
        .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    assert.deepEqual(pyKinds, [...SUBMIT_KINDS],
        'Python 的 SUBMIT_KINDS 必须与 src/core/model/status.js 的逐字一致');
});

// ★ 数据驱动：上面那条只管"两边的表一不一样"，
//   管不了"包里**实际写进去的**值" —— 某个适配器自己拼一个字面量（`'赛时 '`、`'比赛时'`）
//   照样能产出包，而应用侧 `pStatus2` 的「赛时通过」判定会**永远不成立**
//   （现象：标了赛时却算成赛后补题）。这里直接读真包，把值域钉死。
test('★ 数据驱动：包里每个 `submitKind` 都必须在值域里（空 = 判不出，合法）', () => {
    const pkg = path.resolve(import.meta.dirname, '..', '..', 'acm-data', 'nodes', 'all_nodes.json');
    if (!fs.existsSync(pkg)) {
        assert.ok(true, '（还没有包，跳过）');
        return;
    }
    const doc = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    const bad = new Map();
    let seen = 0;
    for (const rec of doc.records || []) {
        if (rec['节点类型'] !== 'R') continue;
        const v = String(rec.submitKind ?? '').trim();
        if (!v) continue;                       // 空 = 判不出（老数据/判不出来），合法
        seen += 1;
        if (!SUBMIT_KINDS.includes(v)) bad.set(v, (bad.get(v) || 0) + 1);
    }
    assert.ok(seen > 0, '包里应该有带 `submitKind` 的 R 记录（一条都没有 ⇒ 这条守卫是空的）');
    assert.deepEqual([...bad.keys()].sort(), [],
        '这些值不在值域 ' + JSON.stringify([...SUBMIT_KINDS]) + ' 里（应用侧 pStatus2 判不出「赛时通过」）：\n'
        + [...bad.entries()].map(([v, n]) => `  ${JSON.stringify(v)} × ${n}`).join('\n'));
});
