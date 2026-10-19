// ================================================================
// 卡片（那一排小方框）的顺序：`core/query/stats.js` 的 `cProblemNodes`
//
// 口径：**卡片跟树上的顺序**（`childOrder`）。这是 `v9.0.2` 立的，`v9.0.7` 修的是它的**判据**。
//
// 来由（用户 2026-10-12 实测）：在一场"组头 + 4 个成员"的比赛上点「XCPC难度降序」，
// 提示说"已按…排序"、**树序也确实变了**（`A B C…` → `F M C L A D N G J H K I B E`），
// 可**那一行方框一个都没动**。病根：`cProblemNodes` 按"走过几个根"（`roots.length`）判断
// "有没有树序"，而组头的**成员副本**也会被走一遍（它们贡献的题**按组去重全被丢掉**）
// ⇒ 存活的题其实**全来自组头自己**（有树序），却被判成"跨子树、退回题号序"。
// 现在判据是「**存活的题**来自几个根」。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cProblemNodes } from '../core/query/stats.js';

const P = (id, problemId, ownerSynth) => ({
    id, type: 'P', problemId, values: {}, ...(ownerSynth ? { ownerSynth } : {})
});
const C = (id, extra = {}) => ({ id, type: 'C', name: id, values: {}, ...extra });
const ids = (ns) => ns.map((n) => n.problemId).join('');

/** 一棵最小树：`head`（可当组头）挂在 `o` 下，`head.order` / 成员各自的 P 由参数给 */
function makeState({ headOrder, headIsSynth, memberP = [], memberId = 'm1' }) {
    const nodes = { o: { id: 'o', type: 'O' } };
    const childOrder = { o: [headIsSynth ? 'head' : 'head', memberId] };
    const parentOf = { o: null, head: 'o', [memberId]: 'o' };
    nodes.head = C('head', headIsSynth ? { synthKey: 'synth:c1' } : {});
    nodes[memberId] = C(memberId, headIsSynth ? { ownerSynth: 'synth:c1' } : {});
    childOrder.head = headOrder.map((n) => n.id);
    childOrder[memberId] = memberP.map((n) => n.id);
    for (const n of [...headOrder, ...memberP]) { nodes[n.id] = n; parentOf[n.id] = null; }
    for (const n of headOrder) parentOf[n.id] = 'head';
    for (const n of memberP) parentOf[n.id] = memberId;
    for (const n of [...headOrder, ...memberP]) childOrder[n.id] = [];
    return { rootId: 'o', settings: { stats: { countMode: 'plain' } }, nodes, childOrder, parentOf, accounts: {}, sources: {} };
}

test('普通 C：卡片跟 `childOrder`（人排过的顺序），不按题号重排', () => {
    const st = makeState({
        headIsSynth: false,
        headOrder: [P('pC', 'C'), P('pA', 'A'), P('pB', 'B')]
    });
    assert.equal(ids(cProblemNodes(st, st.nodes.head)), 'CAB',
        '`childOrder` 是 `C A B` ⇒ 卡片就是 `C A B`（按题号会得到 `ABC` —— 那是老的错行为）');
});

test('★ 组头 + 成员：成员副本的题被组去重掉 ⇒ 卡片仍跟**组头自己的** `childOrder`', () => {
    // ⚠️ 组键要按**题**给（每道题自己有组），不是按**比赛**：真包里 `ownerSynth` 指向的是题目组，
    //    跨平台副本共享同一个题目组键 ⇒ 副本被去重掉。头下的题各属自己的组。
    const st = makeState({
        headIsSynth: true,
        headOrder: [P('pC', 'C', 'synth:gpC'), P('pA', 'A', 'synth:gpA'), P('pB', 'B', 'synth:gpB')],
        // 成员上交的是**同一批题**（题目组键相同 ⇒ 被去重；`v9.0.7` 之前正是它们把判据带偏的）
        memberP: [P('pC2', 'C', 'synth:gpC'), P('pA2', 'A', 'synth:gpA')]
    });
    const got = cProblemNodes(st, st.nodes.head);
    assert.equal(ids(got), 'CAB',
        '存活的题全来自组头 ⇒ 跟它的树序；**不能**因为"走过多个根"就退回题号序（`ABC` 是 v9.0.7 修掉的症状）');
    assert.equal(got.length, 3, '成员上交的同组题必须被去重掉（不是 5 题）');
});

test('真的跨了子树（成员独有的题）：组头那份在前按树序，成员独有的题垫底', () => {
    const st = makeState({
        headIsSynth: true,
        headOrder: [P('pC', 'C', 'synth:gpC'), P('pA', 'A', 'synth:gpA')],
        // 这两题**不属于**组头那几个题目组 ⇒ 不会被去重 ⇒ 它们是"成员独有的题"
        memberP: [P('pM', 'M', 'synth:gpM'), P('pB', 'B', 'synth:gpB')]
    });
    assert.equal(ids(cProblemNodes(st, st.nodes.head)), 'CABM',
        '组头那两题按树序（`C A`）在前；成员独有的题（`M` / `B`）按题号序（`B M`）垫底');
});
