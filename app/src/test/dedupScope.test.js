// ================================================================
// 判重「筛选范围 + 硬门槛」测试（core/dedup.js）
//
// 这一组用例的口径：
//   · 判重整理的建议必须支持筛选范围，且相信性质归类，跨性质的别建议；
//   · 筛选模板沿用一级 tab 栏的『题目检索』；
//   · 绑定只需要用在 [cf/xcpc 这些绑定的正确性可以保证]，
//     或 [xcpc 这种缩小比较范围后规模够小，足以手动处理] 的两种情形。
//
// 四件事：
//   1. **跨性质不建议**（`natureComboOf(a).matches(b)`，"两边都非空才比"）；
//   2. **硬门槛**（默认）：只有 `problemId` 非空且相同 / 归一化标题完全相同才出建议；
//   3. **硬门槛关掉 = 相似度口径**（`mode:'similar'`，回归锚，与 dedup.test.js 同一套口径）；
//   4. **筛选范围**：scope（整棵树 / 子树 / 单场比赛）+ nature 四维 + 类型 + 关键词 +
//      归入状态，并且**报出改造前 vs 改造后的建议条数**（最重要的证据）。
//
// ⚠️ 纯逻辑：本文件不碰 DOM、不读 AppState（`npm test` 不带 DOM 桩）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    suggestMembers,
    emptyDedupFilter,
    matchesDedupFilter,
    collectDedupFacets,
    scopeNodeIds,
    missingNatureKeysOf,
    collectNaturePendingItems,
    collectNatureItems,
    natureStatusOf,
    groupNaturePending,
    NATURE_PENDING_KEYS,
    SUGGEST_REASON,
    DEDUP_SCOPE_KINDS,
    DEDUP_SUGGEST_MODES,
    SYNTH_TYPES,
    // ★ 筛选的**哨兵值**（唯一真源就在 core；测试不抄字面量）
    NO_CLASS,
    PARTIAL_CLASS,
    NO_VALUE,
    HAS_VALUE
} from '../core/dedup.js';
import { NATURE_FIELD_KEYS, isKnownNatureValue } from '../core/natureFields.js';
import { MANUAL_LEVEL, RULE_LEVELS, CLASS_RULE_LEVEL, CLASS_RULE_COL, MANUAL_RULE } from '../core/natureConfidence.js';

// ---- 夹具工具 ----

/** 是哨兵值吗（`（没标…）`/`（有标…）`/`（分类不完全）`）—— 从真源那四个常量认，不写字面量 */
const SENTINELS = new Set([NO_CLASS, PARTIAL_CLASS, NO_VALUE, HAS_VALUE]);
const isSentinel = (v) => SENTINELS.has(v);

const syn = (id, key, extra = {}) => ({
    id, type: 'C', name: `合成 ${id}`, synthKey: key, ownerSynth: '', ...extra
});
const mat = (id, type, name, extra = {}) => ({ id, type, name, ownerSynth: '', ...extra });

/** 只取候选本身 */
const cands = (nodes, parents, opts) => suggestMembers(nodes, parents, opts).candidates;
/** 候选对的无序签名（断言"哪几对出来了"用） */
const pairSigs = list => list.map(c => [c.a, c.b].sort().join('~')).sort();

// ================================================================
// 一、跨性质不建议（核心口径）
// ================================================================

test('跨性质不建议：natureComboOf.matches 不成立的一对**不产生建议**', () => {
    const nodes = {
        a: mat('a', 'P', 'Two Sum', { problemId: 'A', natureClass: 'cf', natureYear: '2024' }),
        b: mat('b', 'P', 'Two Sum', { problemId: 'A', natureClass: 'xcpc', natureYear: '2024' })
    };
    const strict = cands(nodes, { a: 'C1', b: 'C1' }, {});
    assert.deepEqual(strict, [],
        '标题完全相同、题号也相同 —— 但分类不同（cf vs xcpc）⇒ 一条都不建议');

    // 相似度口径也一样被挡住：nature 闸门**与模式无关**
    assert.deepEqual(cands(nodes, { a: 'C1', b: 'C1' }, { mode: 'similar' }), []);
});

test('跨性质不建议：只在**两边都非空**时比 —— 一边没标不算冲突', () => {
    const nodes = {
        a: mat('a', 'P', 'Two Sum', { problemId: 'A', natureClass: 'cf' }),
        b: mat('b', 'P', 'Two Sum', { problemId: 'A' })
    };
    assert.deepEqual(pairSigs(cands(nodes, { a: 'C1', b: 'C1' }, {})), ['a~b'],
        '对方没标大类 ⇒ 无从判断 ⇒ 不否决（"没标就是没标"）');
});

test('跨性质不建议：年份不同也拦（同大类但不同年）', () => {
    const nodes = {
        a: mat('a', 'P', 'Two Sum', { natureYear: '2024' }),
        b: mat('b', 'P', 'Two Sum', { natureYear: '2025' })
    };
    assert.deepEqual(cands(nodes, { a: 'C1', b: 'C1' }, {}), []);
});

// ================================================================
// 二、硬门槛（默认）：只保留机器可判定的等价信号
// ================================================================

test('硬门槛：只有 problemId 相同 / 归一化标题完全相同才出建议，并写明**依据**', () => {
    const nodes = {
        // ① 标题完全相同（归一化后：大小写 / 全角 / 首尾标点都不算差异）
        t1: mat('t1', 'P', 'Two Sum'),
        t2: mat('t2', 'P', '  TWO SUM!!  '),
        // ② problemId 非空且相同（标题完全不同）
        p1: mat('p1', 'P', 'Three Axis Views', { problemId: 'A' }),
        p2: mat('p2', 'P', '三轴视图', { problemId: 'A' }),
        // ③ 只是"像"：标题差一个词 —— 硬门槛下**不该出现**
        s1: mat('s1', 'P', 'Coloring (Easy)'),
        s2: mat('s2', 'P', 'Coloring (Hard)'),
        // ④ 题号都是空的 —— "没填"不是"相同"
        e1: mat('e1', 'P', 'Alpha', { problemId: '' }),
        e2: mat('e2', 'P', 'Beta', { problemId: '' })
    };
    const parents = {};
    for (const id of Object.keys(nodes)) parents[id] = 'C1';
    const list = cands(nodes, parents, {});
    assert.deepEqual(pairSigs(list), ['p1~p2', 't1~t2'], '只有 ① 与 ② 出建议');
    for (const c of list) {
        assert.equal(c.score, 1, '硬门槛出的建议 score 一律是 1（它就是"完全相同"）');
        assert.notEqual(c.reason, SUGGEST_REASON.SIMILAR, '硬门槛里不许出现 similarity');
    }
    const byPair = Object.fromEntries(list.map(c => [[c.a, c.b].sort().join('~'), c]));
    assert.equal(byPair['t1~t2'].reason, SUGGEST_REASON.SAME_TITLE);
    assert.equal(byPair['t1~t2'].evidence, 'two sum', '依据带上"凭什么"的原文（归一化标题）');
    assert.equal(byPair['p1~p2'].reason, SUGGEST_REASON.PROBLEM_ID);
    assert.equal(byPair['p1~p2'].evidence, 'A', '依据带上题号本身');
});

test('硬门槛：两边题号都非空且不同 ⇒ 标题相同也**不建议**（arc120 F / F2 那个误报）', () => {
    // 实测案例：AtCoder ARC120 的 F 与 F2，name 都是 "Wine Thief" ——
    // 官方口径是"题面相同、约束与时限不同"，**两个独立 task**（不是同一道题）。
    // 题号权威，所以两边都有题号时以题号为准。
    const nodes = {
        f: mat('f', 'P', 'Wine Thief', { problemId: 'F' }),
        f2: mat('f2', 'P', 'Wine Thief', { problemId: 'F2' })
    };
    const parents = { f: 'C1', f2: 'C1' };
    assert.deepEqual(cands(nodes, parents, {}), [], '同父同类型、标题完全相同，但题号不同 ⇒ 一条建议都不出');

    // 反向锚：**一边没填题号**时，"标题完全相同"这个信号仍然有效（"没填"不是"不同"）
    const nodes2 = {
        x: mat('x', 'P', 'Wine Thief', { problemId: 'F' }),
        y: mat('y', 'P', 'Wine Thief', { problemId: '' })
    };
    const parents2 = { x: 'C1', y: 'C1' };
    assert.deepEqual(pairSigs(cands(nodes2, parents2, {})), ['x~y'], '一边没题号 ⇒ 仍按标题相同建议');

    // 反向锚：题号**相同**时当然照常建议（而且依据是题号，不是标题）
    const nodes3 = {
        m: mat('m', 'P', 'Wine Thief', { problemId: 'F' }),
        n: mat('n', 'P', 'Wine Thief（重题）', { problemId: 'F' })
    };
    const parents3 = { m: 'C1', n: 'C1' };
    const l3 = cands(nodes3, parents3, {});
    assert.deepEqual(pairSigs(l3), ['m~n'], '题号相同 ⇒ 建议');
    assert.equal(l3[0].reason, SUGGEST_REASON.PROBLEM_ID, '依据必须是题号');

    // 反向锚：`similar`（显式开启的辅助）行为**不受影响** —— 它本来就会出这种建议
    const l4 = cands(nodes, parents, { mode: 'similar' });
    assert.deepEqual(pairSigs(l4), ['f~f2'], 'similar 模式保留原行为（辅助口径，不套这条闸门）');
});

test('硬门槛：跨父 / 跨类型 / 已归入 这些判据一个都没放宽', () => {
    const nodes = {
        a: mat('a', 'P', 'Two Sum', { problemId: 'A' }),
        b: mat('b', 'P', 'Two Sum', { problemId: 'A' }),
        c: mat('c', 'P', 'Two Sum', { problemId: 'A', ownerSynth: 'k1' }),
        d: mat('d', 'R', 'Two Sum', { problemId: 'A', status: '-' })
    };
    assert.deepEqual(cands(nodes, { a: 'C1', b: 'C2' }, {}), [], '跨父不比');
    assert.deepEqual(cands(nodes, { a: 'C1', b: 'C1', d: 'C1' }, {}).map(x => x.b), ['b'],
        'R 与 P 不同桶（类型不同）');
    assert.deepEqual(cands(nodes, { a: 'C1', b: 'C1', c: 'C1' }, {}).map(x => x.a), ['a'],
        '已归入的 c 不进候选（默认 owned = unowned）');
});

test('硬门槛：旁边已有同名合成节点 ⇒ 建议**归入它**（而不是新建）', () => {
    const nodes = {
        sx: syn('sx', 'k:c:1', { name: '2026 浙江省赛' }),
        a: mat('a', 'C', '2026 浙江省赛')
    };
    const list = cands(nodes, { sx: 'S1', a: 'S1' }, {});
    assert.equal(list.length, 1, '未归入的原料 → 建议归入那个同名合成节点');
    assert.equal(list[0].a, 'a');
    assert.equal(list[0].b, 'sx');
    assert.equal(list[0].suggestSynthId, 'sx');
    assert.equal(list[0].suggestKey, 'k:c:1');
    assert.equal(list[0].reason, SUGGEST_REASON.SAME_TITLE);
    // 题号那条路也一样：标题完全不同、但题号相同 ⇒ 归入
    const byPid = {
        sp: syn('sp', 'k:p:1', { type: 'P', name: '三轴视图', problemId: 'A' }),
        q: mat('q', 'P', 'Three Axis Views', { problemId: 'A' })
    };
    const list2 = cands(byPid, { sp: 'C1', q: 'C1' }, {});
    assert.equal(list2.length, 1);
    assert.equal(list2[0].suggestSynthId, 'sp');
    assert.equal(list2[0].reason, SUGGEST_REASON.PROBLEM_ID);
});

test('硬门槛**不走两两比**：预算花完也不会漏掉可信信号（预算只挡相似度那条路）', () => {
    const nodes = {};
    const parents = {};
    // 一个"练习容器挂了上千道散题"的分布 + 其中两个同名（可信信号）
    for (let i = 0; i < 900; i++) {
        const id = `x${i}`;
        nodes[id] = mat(id, 'P', `散题 第 ${i} 号`);
        parents[id] = 'C1';
    }
    nodes.x7.name = '2026 省赛 特别场';
    nodes.x9.name = '2026 省赛 特别场';
    const res = suggestMembers(nodes, parents, { maxPairs: 1 });
    assert.deepEqual(pairSigs(res.candidates), ['x7~x9'], '硬门槛下 maxPairs=1 也照样出');
    assert.deepEqual(res.truncated, [], '硬门槛这条路不算预算，所以没有"被截断"');
});

// ================================================================
// 三、回归锚：硬门槛关掉 ⇒ 相似度口径回来
// ================================================================

test('回归锚：mode:"similar" 就是相似度口径**逐条**出建议（跳过只差序号）', () => {
    const nodes = {
        a: mat('a', 'C', '2026 浙江省赛'),
        b: mat('b', 'C', '2026 浙江省赛（榜单）'),
        n1: mat('n1', 'C', '2026 暑期联赛（1）'),
        n2: mat('n2', 'C', '2026 暑期联赛（2）')
    };
    const parents = { a: 'S1', b: 'S1', n1: 'S1', n2: 'S1' };
    const similar = cands(nodes, parents, { mode: 'similar' });
    assert.deepEqual(pairSigs(similar), ['a~b'], '相似的一对出、只差序号的一对不出');
    assert.equal(similar[0].reason, SUGGEST_REASON.SIMILAR);
    assert.ok(similar[0].score >= 0.7 && similar[0].score < 1, '相似度不是 1（名字确实不同）');
    // 默认（硬门槛）下同一批数据一条都不出 —— 这就是"把噪声藏起来"
    assert.deepEqual(cands(nodes, parents, {}), []);
    // 布尔别名 strict:false 等价于 mode:'similar'
    assert.deepEqual(pairSigs(cands(nodes, parents, { strict: false })), ['a~b']);
    // 模式清单本身是受控的
    assert.deepEqual([...DEDUP_SUGGEST_MODES], ['strict', 'similar', 'all']);
});

test('mode:"all" = 硬门槛 + 相似度建议（两边都出，且按依据排序）', () => {
    const nodes = {
        t1: mat('t1', 'P', 'Two Sum'),
        t2: mat('t2', 'P', 'Two Sum'),
        s1: mat('s1', 'P', 'Two Sums'),
        p1: mat('p1', 'P', 'Alpha', { problemId: 'A' }),
        p2: mat('p2', 'P', 'Beta', { problemId: 'A' })
    };
    const parents = {};
    for (const id of Object.keys(nodes)) parents[id] = 'C1';
    const list = cands(nodes, parents, { mode: 'all' });
    const sigs = pairSigs(list).join(',');
    assert.ok(sigs.includes('t1~t2'), '硬门槛那对在');
    assert.ok(sigs.includes('p1~p2'), '题号那对在');
    assert.ok(sigs.includes('s1~t1') || sigs.includes('s1~t2'), '相似度那对也在');
    // 依据可信的排在前面
    const rank = { [SUGGEST_REASON.PROBLEM_ID]: 0, [SUGGEST_REASON.SAME_TITLE]: 1, [SUGGEST_REASON.SIMILAR]: 2 };
    for (let i = 1; i < list.length; i++) {
        assert.ok(rank[list[i - 1].reason] <= rank[list[i].reason],
            '排序：problemId > 标题完全相同 > 相似度');
    }
});

// ================================================================
// 四、筛选范围
// ================================================================

test('scopeNodeIds：整棵树 → null（不限制）；子树 / 单场比赛 → 那棵子树的节点集', () => {
    const st = {
        rootId: 'O',
        nodes: { O: { id: 'O', type: 'O' }, S: { id: 'S' }, C: { id: 'C' }, P: { id: 'P' }, X: { id: 'X' } },
        childOrder: { O: ['S'], S: ['C'], C: ['P'], P: [] }
    };
    assert.equal(scopeNodeIds(st, { kind: 'all' }), null, '整棵树 = 不过滤');
    assert.deepEqual([...scopeNodeIds(st, { kind: 'subtree', nodeId: 'S' })].sort(), ['C', 'P', 'S'],
        '子树含根自己');
    assert.deepEqual([...scopeNodeIds(st, { kind: 'contest', nodeId: 'C' })].sort(), ['C', 'P'],
        '单场比赛 = 那个 C 容器 + 它的题目/提交');
    assert.equal(scopeNodeIds(st, { kind: 'subtree', nodeId: '不存在' }).size, 0,
        '范围节点不存在 ⇒ **空集**（不静默退化成"整棵树"）');
    assert.deepEqual([...DEDUP_SCOPE_KINDS], ['all', 'subtree', 'contest']);
});

test('scope 缩到单个 C 容器后：候选数 = 该容器内的候选数（别的容器一条都不进）', () => {
    const nodes = {
        c1: mat('c1', 'C', '2026 甲站'),
        c2: mat('c2', 'C', '2026 甲站'),
        d1: mat('d1', 'C', '2026 乙站'),
        d2: mat('d2', 'C', '2026 乙站'),
        // 甲站下的两道重复题（同号同名）
        q1: mat('q1', 'P', 'Two Sum', { problemId: 'A' }),
        q2: mat('q2', 'P', 'Two Sum', { problemId: 'A' })
    };
    const parents = { c1: 'S1', c2: 'S1', d1: 'S2', d2: 'S2', q1: 'c1', q2: 'c1' };
    const state = {
        rootId: 'S1',
        nodes: { ...nodes, S1: { id: 'S1', type: 'S' }, S2: { id: 'S2', type: 'S' } },
        childOrder: { S1: ['c1', 'c2'], S2: ['d1', 'd2'], c1: ['q1', 'q2'], c2: [], d1: [], d2: [], q1: [], q2: [] }
    };
    const whole = cands(nodes, parents, {});
    assert.deepEqual(pairSigs(whole), ['c1~c2', 'd1~d2', 'q1~q2'], '（前提）整棵树上有 3 对');

    const inC1 = cands(nodes, parents, { scopeIds: scopeNodeIds(state, { kind: 'contest', nodeId: 'c1' }) });
    assert.deepEqual(pairSigs(inC1), ['q1~q2'],
        '缩到 c1 后只剩 c1 容器内那一对：c1~c2 在**兄弟**容器之间（父是 S1，不在 c1 子树里）');

    const inS1 = cands(nodes, parents, { scopeIds: scopeNodeIds(state, { kind: 'subtree', nodeId: 'S1' }) });
    assert.deepEqual(pairSigs(inS1), ['c1~c2', 'q1~q2'], '缩到 S1 子树：两对，乙站不进');
});

test('筛选：类型 / 关键词（题名或题号）/ 归入状态', () => {
    const nodes = {
        c1: mat('c1', 'C', '2026 浙江省赛'),
        c2: mat('c2', 'C', '2026 浙江省赛'),
        p1: mat('p1', 'P', 'Two Sum', { problemId: 'A' }),
        p2: mat('p2', 'P', 'Two Sum', { problemId: 'A' })
    };
    const parents = { c1: 'S1', c2: 'S1', p1: 'C1', p2: 'C1' };
    const f = emptyDedupFilter();
    assert.deepEqual(Object.keys(f).sort(),
        [...NATURE_FIELD_KEYS, 'classLevel', 'keyword', 'owned', 'types'].sort(),
        '四个 nature 维度按字段键表生成（不手抄名字）+ 分类依据强度那一档');

    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, types: ['C'] } })),
        ['c1~c2'], '只看比赛');
    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, types: ['P'] } })),
        ['p1~p2'], '只看题目');
    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, keyword: '浙江' } })),
        ['c1~c2'], '题名包含匹配');
    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, keyword: 'two' } })),
        ['p1~p2'], '题名包含匹配（大小写不敏感）');
    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, keyword: 'A' } })),
        ['p1~p2'], '题号也参与包含匹配');
    assert.deepEqual(cands(nodes, parents, { filter: { ...f, keyword: '不存在的词' } }), []);
    assert.deepEqual(pairSigs(cands(nodes, parents, { filter: { ...f, types: SYNTH_TYPES } })),
        ['c1~c2', 'p1~p2'], '不选类型 = 不限制');
});

test('筛选：nature 三维（维度内"或"、维度之间"与"），分类按**前缀**匹配', () => {
    const nodes = {
        a: mat('a', 'P', 'Two Sum', { natureClass: 'cf/contest/div2', natureYear: '2024', natureRegion: '成都' }),
        b: mat('b', 'P', 'Two Sum', { natureClass: 'cf/contest/div2', natureYear: '2024', natureRegion: '成都' }),
        c: mat('c', 'P', 'Two Sum', { natureClass: 'xcpc/ccpc', natureYear: '2024', natureRegion: '成都' }),
        d: mat('d', 'P', 'Two Sum', { natureClass: 'xcpc/ccpc', natureYear: '2024', natureRegion: '成都' })
    };
    const parents = { a: 'X1', b: 'X1', c: 'X2', d: 'X2' };
    const f = emptyDedupFilter();
    const withF = patch => cands(nodes, parents, { filter: { ...f, ...patch } });
    assert.deepEqual(pairSigs(withF({ natureClass: ['cf'] })), ['a~b'], '前缀 `cf` 命中 `cf/contest/div2`');
    assert.deepEqual(pairSigs(withF({ natureClass: ['xcpc'] })), ['c~d']);
    assert.deepEqual(pairSigs(withF({ natureClass: ['cf', 'xcpc'] })), ['a~b', 'c~d'], '维度内是"或"');
    assert.deepEqual(pairSigs(withF({ natureClass: ['cf/contest/div2'] })), ['a~b'], '也可以直接筛到更深的路径');
    assert.deepEqual(pairSigs(withF({ natureClass: ['cf'], natureYear: ['2023'] })), [],
        '维度之间是"与"（cf 且 2023 ⇒ 一条都没有）');
    assert.deepEqual(pairSigs(withF({ natureYear: ['2024'] })), ['a~b', 'c~d']);
    assert.deepEqual(pairSigs(withF({ natureYear: ['2023'] })), []);
    assert.deepEqual(pairSigs(withF({ natureRegion: ['成都'] })), ['a~b', 'c~d']);
    // 没标的值**不匹配**任何选中项（"相信性质归类"，不把没标的混进来）
    const noNature = { x: mat('x', 'P', 'Two Sum'), y: mat('y', 'P', 'Two Sum') };
    assert.deepEqual(cands(noNature, { x: 'X', y: 'X' }, { filter: { ...f, natureClass: ['cf'] } }), []);
    assert.deepEqual(pairSigs(cands(noNature, { x: 'X', y: 'X' }, { filter: { ...f } })), ['x~y'],
        '没选 nature ⇒ 不限制');
});

test('collectDedupFacets：分类列出**数据里出现过的路径 + 它们在 Trie 里的祖先**', () => {
    // ★ 哨兵**永远列**（乙，2026-10-12 拍板；与 ③ 同一个口径）——空数据也列
    assert.deepEqual(collectDedupFacets({}).nature.natureClass.map(o => o.value), [NO_CLASS, PARTIAL_CLASS],
        '空数据：真值一个没有，但两个分类哨兵照列');
    const f1 = collectDedupFacets({
        a: mat('a', 'P', 'x', { natureClass: 'cf/contest/div2' }),
        b: mat('b', 'P', 'y', { natureClass: 'xcpc/icpc/ec/pre' })
    });
    // ⚠️ 哨兵（`（没标分类）`/`（分类不完全）`）**排在最前**，真值按字典序跟在后面
    assert.deepEqual(f1.nature.natureClass.map(o => o.value).filter(v => !isSentinel(v)),
        ['cf', 'cf/contest', 'cf/contest/div2', 'xcpc', 'xcpc/icpc', 'xcpc/icpc/ec', 'xcpc/icpc/ec/pre'],
        '深路径要能按它的祖先逐级筛（筛 `cf` 才选得动）');
    // 年份 / 地区：只列出现过的值（+ 数据里真有"没标/有标"时的那两个哨兵）
    const f2 = collectDedupFacets({
        a: mat('a', 'P', 'x', { natureYear: '2024', natureRegion: '成都' }),
        b: mat('b', 'P', 'y', { natureYear: '2025' })
    });
    assert.deepEqual(f2.nature.natureYear.map(o => o.value).filter(v => !isSentinel(v)), ['2024', '2025']);
    assert.deepEqual(f2.nature.natureRegion.map(o => o.value).filter(v => !isSentinel(v)), ['成都']);
    assert.ok(f2.nature.natureRegion.some(o => o.value === NO_VALUE), 'b 没标地区 ⇒ 列表里有「（没标地区）」');
    // 分类的标签是给人看的（段之间 ` / `）
    assert.equal(f1.nature.natureClass.find(o => o.value === 'cf/contest/div2').label, 'cf / contest / div2');
    // `无归类` 是合法值（"判过了"），和"没标"不是一回事
    assert.equal(isKnownNatureValue('natureClass', 'cf/contest/others/无归类'), true);
});

test('筛选：owned:"any" 把已归入的也当端点，但**不会**建议"搬到同一个组"', () => {
    const nodes = {
        sx: syn('sx', 'k:1', { type: 'P', name: 'Two Sum' }),         // 甲组（组头）
        a: mat('a', 'P', 'Two Sum', { ownerSynth: 'k:1' }),          // 已归入 sx
        b: mat('b', 'P', 'Two Sum'),                                  // 还没归入
        e1: mat('e1', 'P', 'Beta', { problemId: 'B', ownerSynth: 'k:1' }),
        e2: mat('e2', 'P', 'Beta', { problemId: 'B', ownerSynth: 'k:1' })
    };
    const parents = { sx: 'C1', a: 'C1', b: 'C1', e1: 'C1', e2: 'C1' };
    const f = emptyDedupFilter();
    const def = cands(nodes, parents, { filter: { ...f } });
    assert.deepEqual(def.map(c => c.a), ['b'], '默认只看未归入：只有 b 参与');
    assert.equal(def[0].suggestSynthId, 'sx', 'b 建议归入已存在的组头 sx');

    const any = cands(nodes, parents, { filter: { ...f, owned: 'any' } });
    // b 同时命中"归入 sx"与"归入 a 所在的组"，但 a 的组就是 sx ⇒ 同一个目标
    assert.ok(any.some(c => c.a === 'b' && c.suggestSynthId === 'sx'), 'b 仍建议归入 sx');
    assert.equal(any.some(c => c.a === 'a'), false,
        'a 已经归入 ⇒ 不会替它出"再归入一次"的建议');
    assert.equal(any.some(c => c.a === 'e1' || c.a === 'e2'), false,
        'e1/e2 都已经在同一组里 ⇒ 不产生建议');
    // 已归入的原料当**对照物**：未归入的那份被指向它所在的组
    const nodes2 = {
        sx2: syn('sx2', 'k:2', { type: 'P', name: 'Gamma' }),
        g: mat('g', 'P', 'Gamma', { ownerSynth: 'k:2' }),
        h: mat('h', 'P', 'Gamma')
    };
    const any2 = cands(nodes2, { sx2: 'C1', g: 'C1', h: 'C1' }, { filter: { ...f, owned: 'any' } });
    assert.equal(any2.length, 1);
    assert.equal(any2[0].a, 'h', '要写的是**还没归入**的那一份');
    assert.equal(any2[0].suggestKey, 'k:2', '归入已归入那份所在的组');
});

test('collectDedupFacets：可选项**从数据里收集**（不穷举词表），只列真的出现过的', () => {
    const nodes = {
        a: mat('a', 'P', 'x', { natureClass: 'cf/contest/div2', natureYear: '2024' }),
        b: mat('b', 'C', 'y', { natureClass: 'xcpc/icpc' }),
        c: mat('c', 'R', 'z', { natureClass: 'cf', natureRegion: '成都' }),
        w: { id: 'w', type: 'W', name: '平台' }
    };
    const facets = collectDedupFacets(nodes);
    assert.deepEqual(facets.nature.natureClass.map(o => o.value).filter(v => !isSentinel(v)),
        ['cf', 'cf/contest', 'cf/contest/div2', 'xcpc', 'xcpc/icpc'],
        '分类：数据里出现过的路径 + 它们的祖先（前缀筛选才点得动），按字典序');
    assert.deepEqual(facets.nature.natureYear.map(o => o.value).filter(v => !isSentinel(v)), ['2024']);
    assert.deepEqual(facets.nature.natureRegion.map(o => o.value).filter(v => !isSentinel(v)), ['成都']);
    assert.deepEqual(facets.types, ['C', 'P', 'R'], '只有真的出现过的合成类型，且按 C/P/R 固定顺序');
    assert.ok(facets.nature.natureClass.some(o => o.label === 'cf / contest / div2'), '分类标签是 `a / b / c` 形态');
    // 词表里有、数据里没有的值**不许**出现（"别穷举词表"）
    assert.equal(facets.nature.natureClass.some(o => o.value === 'qoj'), false);
    // ★ 哨兵**永远列**（乙）：不看不看数据有没有这种条目 —— 所以"赛季一个都没标"也照样列
    assert.ok(facets.nature.natureClass.some(o => o.value === NO_CLASS), '「（没标分类）」在');
    assert.ok(facets.nature.natureClass.some(o => o.value === PARTIAL_CLASS), '「（分类不完全）」在');
    for (const k of ['natureYear', 'natureSeason', 'natureRegion']) {
        assert.ok(facets.nature[k].some(o => o.value === NO_VALUE), `${k}：「（没标…）」在`);
        assert.ok(facets.nature[k].some(o => o.value === HAS_VALUE), `${k}：「（有标…）」在`);
    }
    // 数据全填满/全空，也照样在（这一档顶多是"等于全部"，但口径一致、动线稳定）
    const allFilled = collectDedupFacets({
        a: mat('a', 'P', 'x', { natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' }),
        b: mat('b', 'P', 'y', { natureClass: 'cf/contest/div1', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' })
    });
    for (const k of NATURE_FIELD_KEYS) {
        assert.ok(allFilled.nature[k].some(o => isSentinel(o.value)), `${k}：全填满也照样列哨兵（乙）`);
    }
});

test('matchesDedupFilter：纯字段判据（不属于它的范围/配对的事它不管）', () => {
    const f = { ...emptyDedupFilter(), types: ['P'], keyword: 'sum', natureYear: ['2024'] };
    assert.equal(matchesDedupFilter(mat('a', 'P', 'Two Sum', { natureYear: '2024' }), f), true);
    assert.equal(matchesDedupFilter(mat('a', 'C', 'Two Sum', { natureYear: '2024' }), f), false);
    assert.equal(matchesDedupFilter(mat('a', 'P', 'Two Sums', { natureYear: '2023' }), f), false);
    assert.equal(matchesDedupFilter(mat('a', 'P', 'Two Sum', { natureYear: '2024', ownerSynth: 'k' }), f), false,
        'owned 默认 unowned');
    assert.equal(matchesDedupFilter(mat('a', 'P', 'Two Sum', { natureYear: '2024', ownerSynth: 'k' }),
        { ...f, owned: 'any' }), true);
    assert.equal(matchesDedupFilter(null, f), false);
});

// ================================================================
// ★ 补齐的能力（2026-10-12）：**哨兵值** + **分类依据强度**
//
// 来由：② 与 ③ 的筛选栏 UI 不同、能力也不对等 —— ③ 能筛「（没标年份）」「（分类不完全）」
// 与「依据 ≤ C」，② 都不能。而 ② 的候选**本来就允许**"两边都没标分类"的配对
// （`natureComboOf` 是"两边都非空才比"）⇒ 少了哨兵档，那类候选就**筛不出来**。
// 现在两边共用 `core/dedup.js` 的哨兵常量与同一套 `classLevel` 判据。
// ================================================================
test('★ 哨兵：`（没标分类）`/`（分类不完全）`/`（没标年份）`/`（有标年份）` 都能筛', () => {
    const f = emptyDedupFilter();
    const withF = (node, patch) => matchesDedupFilter(mat('a', 'P', 'x', node), { ...f, ...patch });

    // 「没标」= 这一维为空；「有标」= 非空（`无`/`待同步`/`不确定` 也算"处理过了"）
    assert.equal(withF({}, { natureClass: [NO_CLASS] }), true, '没标分类 ⇒ 命中「（没标分类）」');
    assert.equal(withF({ natureClass: 'cf' }, { natureClass: [NO_CLASS] }), false, '标了分类 ⇒ 不命中');
    assert.equal(withF({ natureClass: 'cf' }, { natureClass: [PARTIAL_CLASS] }), true,
        '`cf` 没到叶子 ⇒ 命中「（分类不完全）」');
    assert.equal(withF({ natureClass: 'cf/contest/div2' }, { natureClass: [PARTIAL_CLASS] }), false,
        '到叶子了 ⇒ 不命中');
    assert.equal(withF({}, { natureClass: [PARTIAL_CLASS] }), false, '没标 ≠ 不完全（两者不能混）');

    assert.equal(withF({}, { natureYear: [NO_VALUE] }), true, '没标年份 ⇒ 命中「（没标年份）」');
    assert.equal(withF({ natureYear: '2024' }, { natureYear: [NO_VALUE] }), false);
    assert.equal(withF({ natureYear: '2024' }, { natureYear: [HAS_VALUE] }), true);
    assert.equal(withF({ natureYear: '待同步' }, { natureYear: [HAS_VALUE] }), true,
        '`待同步` 也算**有标**（它是"处理过了"，只是值不是年份）');
    assert.equal(withF({}, { natureYear: [HAS_VALUE] }), false);
    // 真值 + 哨兵混选 = 并集（维度内"或"）
    assert.equal(withF({ natureYear: '2024' }, { natureYear: [NO_VALUE, '2024'] }), true);
});

test('★ 依据强度：`M 人工` / `≤ X` 与 ③ 的 `passFilters` 同口径（未知级别不收）', () => {
    const f = emptyDedupFilter();
    // `分类依据` 是**元列**（`{ 字段: <规则 id> }`），级别由 `levelOfClassRule` 算（唯一一份）
    // ⇒ 夹具要拿**真规则 id**，别把级别字母当规则写进去。
    const ruleAt = (lv) => Object.keys(CLASS_RULE_LEVEL).find(k => CLASS_RULE_LEVEL[k] === lv);
    const withRule = (rule, classLevel) => matchesDedupFilter(
        mat('a', 'C', 'x', { natureClass: 'cf/contest/div2', [CLASS_RULE_COL]: { natureClass: rule } }),
        { ...f, classLevel });
    const top = RULE_LEVELS[0];                       // A（最硬）
    const weak = RULE_LEVELS[RULE_LEVELS.length - 1]; // E（最弱）

    assert.equal(withRule(undefined, ''), true, '不选依据 ⇒ 不限制');
    assert.equal(withRule(ruleAt(top), top), true, `${top} 过 ≤${top}`);
    // ⚠️ 口径是「**该级及更弱**」：`A` 最硬 ⇒ `≤ A` 收 A…E（只排除"没有依据"的那种）
    assert.equal(withRule(ruleAt(weak), top), true, `${weak} 比 ${top} 弱 ⇒ 过 ≤${top}`);
    assert.equal(withRule(ruleAt(top), weak), false, `${top} 比 ${weak} 硬 ⇒ **不过** ≤${weak}`);
    assert.equal(withRule(ruleAt(weak), weak), true, `${weak} 过 ≤${weak}`);
    assert.equal(withRule(undefined, top), false, '级别未知（老数据）⇒ 任何「≤ X」都不收');
    // `M 人工` 是单选那一档：只收人填的（`manual:set` 那条规则）
    assert.equal(withRule(MANUAL_RULE, MANUAL_LEVEL), true, '人填的 ⇒ 命中「M 人工」');
    assert.equal(withRule(ruleAt(top), MANUAL_LEVEL), false, '规则判的 ⇒ 不命中「M 人工」');
    assert.equal(withRule(MANUAL_RULE, top), false, '人填的不在"≤ X"里（`M` 比 A 还硬）');
});
// ================================================================
// 五、改造前 vs 改造后（**最重要的证据**）
//
// 走真实规模：约 2 万个节点、20 个系列、1400 场比赛、1.8 万道题，
// 标题按真实噪声模板造（`（榜单）` 后缀、`Easy`/`Hard` 成对），
// nature 四维混合。然后数**同一批数据**在两种口径下的建议条数。
// ================================================================
function buildScaleFixture() {
    const nodes = { root: { id: 'root', type: 'O', name: '根' } };
    const parentOf = { root: '' };
    const childOrder = { root: [] };
    const attach = (id, parent) => { parentOf[id] = parent; (childOrder[parent] ||= []).push(id); childOrder[id] = []; };
    const MAINS = ['xcpc/icpc', 'cf/contest/div2'];
    const REGIONS = ['成都', '南京', '沈阳', '澳門'];

    const SERIES = 40;
    const CONTESTS_PER_SERIES = 35;          // 40 × 35 = 1400 场比赛
    const DUP_CONTESTS = 20;                 // 每个系列前 20 场有"真的重复"（两个来源各一份）
    const PROBLEMS_PER_CONTEST = 6;          // 3 对 Easy/Hard
    let truePairs = 0;

    for (let s = 0; s < SERIES; s++) {
        const sId = `S${s}`;
        nodes[sId] = {
            id: sId, type: 'S', name: `${2020 + (s % 5)} 赛系 ${s}`,
            natureClass: MAINS[s % 2], natureYear: String(2020 + (s % 5)),
            natureRegion: REGIONS[s % 4]
        };
        attach(sId, 'root');
        for (let c = 0; c < CONTESTS_PER_SERIES; c++) {
            const cId = `C${s}_${c}`;
            const year = String(2020 + (c % 5));
            const common = {
                natureClass: MAINS[(s + c) % 2],
                natureYear: year, natureRegion: REGIONS[(s + c) % 4]
            };
            // 噪声①：同一场比赛的"榜单"副本 —— 标题只差一个后缀（**不是**同一份数据）
            nodes[cId] = { id: cId, type: 'C', name: `ICPC EC Online (${c})`, ownerSynth: '', ...common };
            attach(cId, sId);
            const twin = `${cId}b`;
            nodes[twin] = { id: twin, type: 'C', name: `ICPC EC Online (${c})（榜单）`, ownerSynth: '', ...common };
            attach(twin, sId);

            // 噪声②：同一场里成对的 Easy / Hard 题目（**不是**同一道题）
            for (let k = 0; k < PROBLEMS_PER_CONTEST / 2; k++) {
                const eId = `${cId}p${k}e`;
                const hId = `${cId}p${k}h`;
                const base = {
                    natureClass: common.natureClass,
                    natureYear: year, natureRegion: common.natureRegion
                };
                nodes[eId] = { id: eId, type: 'P', name: `Coloring ${k} (Easy)`, problemId: String.fromCharCode(65 + k), ownerSynth: '', ...base };
                nodes[hId] = { id: hId, type: 'P', name: `Coloring ${k} (Hard)`, problemId: String.fromCharCode(65 + k + 3), ownerSynth: '', ...base };
                attach(eId, cId); attach(hId, cId);
            }
            // 真信号：同一道题被两个来源各抓了一份（同名 + 同号）
            if (c < DUP_CONTESTS) {
                for (const suffix of ['pd', 'pd2']) {
                    const id = `${cId}${suffix}`;
                    nodes[id] = {
                        id, type: 'P', name: 'Three-Axis Views', problemId: 'Z', ownerSynth: '',
                        natureClass: common.natureClass,
                        natureYear: year, natureRegion: common.natureRegion
                    };
                    attach(id, cId);
                }
                truePairs++;
            }
        }
    }
    // 提交（xcpc 里 R 有 7156 条）：挂在题目下，一个桶里就一两条，不会额外刷屏
    for (let i = 0; i < 8000; i++) {
        const s = i % SERIES;
        const c = Math.floor(i / SERIES) % CONTESTS_PER_SERIES;
        const k = i % (PROBLEMS_PER_CONTEST / 2);
        const id = `R${i}`;
        nodes[id] = { id, type: 'R', name: `提交 ${i}`, status: '-', ownerSynth: '' };
        attach(id, `C${s}_${c}p${k}e`);
    }
    return { nodes, parentOf, childOrder, truePairs, contests: SERIES * CONTESTS_PER_SERIES };
}

test('改造前 vs 改造后：真的重复留下、模板噪声消失（并打印条数对比）', () => {
    const fx = buildScaleFixture();
    const nodeCount = Object.keys(fx.nodes).length;

    // 改造前：**相似度口径**（mode:'similar'）。总量预算放开 —— 要量的是"语义上会刷多少屏"，
    // 而不是"被它自己的性能闸门截断之后剩多少"（那是另一回事，见下面的 truncated）。
    const t0 = Date.now();
    const before = suggestMembers(fx.nodes, fx.parentOf, { mode: 'similar', maxPairs: 1e9 });
    const beforeMs = Date.now() - t0;

    // 改造后：**默认**（硬门槛）
    const t1 = Date.now();
    const after = suggestMembers(fx.nodes, fx.parentOf, {}).candidates;
    const afterMs = Date.now() - t1;

    // 真信号（同一场里同名同号的两份）一条不少
    const trueIds = new Set();
    for (const id of Object.keys(fx.nodes)) {
        if (id.endsWith('pd') || id.endsWith('pd2')) trueIds.add(id);
    }
    const kept = after.filter(c => trueIds.has(c.a) && trueIds.has(c.b));
    assert.equal(kept.length, fx.truePairs, '真的重复一条都没漏');
    assert.equal(after.length, fx.truePairs, '硬门槛下**只有**真的重复（噪声一条都不出）');
    assert.equal(after.every(c => c.reason === SUGGEST_REASON.SAME_TITLE), true);

    // 改造前确实刷屏：噪声（榜单副本 / Easy-Hard）占绝大多数
    assert.ok(before.candidates.length > 4000,
        `改造前应有大量噪声（实际 ${before.candidates.length} 条）`);
    assert.ok(after.length * 10 < before.candidates.length, '数量级上的收紧');

    // 打印关键数字（这是交付证据，不是调试残留）
    const pct = (100 * (1 - after.length / before.candidates.length)).toFixed(1);
    console.log(`  [规模] 节点 ${nodeCount}、比赛 ${fx.contests}、真重复 ${fx.truePairs} 对`);
    console.log(`  [改造前 mode:similar] ${before.candidates.length} 条建议`
        + `（预算放开，${beforeMs}ms；被截断的桶 ${before.truncated.length} 个）`);
    console.log(`  [改造后 默认硬门槛]   ${after.length} 条建议（${afterMs}ms）—— 减少 ${pct}%`);
    assert.ok(afterMs < 3000, `硬门槛在 ${nodeCount} 节点上要在 3 秒内算完（实测 ${afterMs}ms）`);
});

test('范围把建议缩到"够小能手工处理"：单场比赛内通常个位数', () => {
    const fx = buildScaleFixture();
    const wide = suggestMembers(fx.nodes, fx.parentOf, {}).candidates.length;

    // 取"有真重复"的一场
    const scopeIds = scopeNodeIds({ nodes: fx.nodes, childOrder: fx.childOrder, rootId: 'root' },
        { kind: 'contest', nodeId: 'C0_0' });
    const scoped = suggestMembers(fx.nodes, fx.parentOf, { scopeIds }).candidates;
    assert.equal(scoped.length, 1, '缩到单场比赛后只剩该容器内那一条');
    assert.ok(wide > scoped.length * 10, '（对比）整棵树上有几十条');

    // 同时：nature 筛选也能把范围压下来
    const cfOnly = suggestMembers(fx.nodes, fx.parentOf, {
        filter: { ...emptyDedupFilter(), natureClass: ['cf'] }
    }).candidates;
    assert.ok(cfOnly.length > 0 && cfOnly.length < wide, '按分类筛（前缀 cf）之后更少，但仍有结果');
    console.log(`  [范围] 整棵树 ${wide} 条 → 单场比赛 ${scoped.length} 条；`
        + `按分类 cf 筛 ${cfOnly.length} 条`);
});

// ================================================================
// 五、「性质待补」的口径 —— 判重页那一块的数据面（最直白的列表 + 手填）
//
// 口径：xcpc 若另 3 个 nature 未填就该提醒用户。
//
// 这里只钉**口径**（哪些算待补 / 怎么分组），界面接线在冒烟里
// （`scripts/smoke/dedup-synth.smoke.mjs`），写路径在 `core/ops/node.js`。
// ================================================================

test('性质待补：**比赛（C）没有分类也算缺**；分类还要**细到 Trie 的叶子**才算填好', () => {
    assert.deepEqual([...NATURE_PENDING_KEYS], ['natureYear', 'natureSeason', 'natureRegion'],
        '待补的其余字段 = 除分类以外的 nature 字段（派生，不手抄一份）');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x', { natureClass: 'cf/contest/div2' })),
        ['natureYear', 'natureSeason', 'natureRegion'], '分类是**叶子**（cf/contest/div2）⇒ 只缺年份/赛季/地区');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x')),
        ['natureClass', 'natureYear', 'natureSeason', 'natureRegion'],
        'C 没有分类 ⇒ 把「分类」也列进"缺"里（顺序 = 字段顺序）');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x', { natureClass: '   ' })),
        ['natureClass', 'natureYear', 'natureSeason', 'natureRegion'], '空白串按空算（只 trim）');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
        { natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024' })),
        ['natureRegion'], '分类到叶子时不提分类（缺几项报几项）');
    // ⚠️ nature 的分类字段只有在 Trie 树的叶子节点时才被视为填好
    for (const prefix of ['cf', 'cf/contest/others', 'xcpc', 'xcpc/icpc', 'atcoder']) {
        assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
            { natureClass: prefix, natureYear: '2024', natureSeason: '2024', natureRegion: '成都' })),
            ['natureClass'],
            `停在中间（${prefix}）⇒ 分类**仍算缺**，继续留在待补里（其余都不缺）`);
    }
    for (const type of ['W', 'S', 'P', 'R']) {
        assert.deepEqual(missingNatureKeysOf(mat('a', type, 'x')), [],
            `${type} 没有分类**不算缺**（它本来就不是比赛）`);
    }
    assert.deepEqual(missingNatureKeysOf(null), [], '没有节点 ⇒ 空数组');
});

test('性质待补：字段**逐字段独立**判（缺哪几个就报哪几个）', () => {
    const full = { natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' };
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x', full)), [], '字段齐全 ⇒ 不在列表里');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x', { ...full, natureRegion: '' })),
        ['natureRegion'], '只缺地区');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x', { natureClass: 'qoj/无归类' })),
        ['natureYear', 'natureSeason', 'natureRegion'],
        '缺年份/赛季/地区 —— 顺序 = 字段顺序，界面直接照它写「缺：年份、赛季、地区」');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
        { natureClass: 'atcoder/abc', natureYear: '2025', natureSeason: '2025', natureRegion: '  ' })),
        ['natureRegion'], '地区是空白串 ⇒ 照样算缺（不是"看着有值"）');
    // ★ 年份（举办）与赛季是**两个**字段：只填一个仍然算缺
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
        { natureClass: 'xcpc/icpc/ec/final/official', natureYear: '2024', natureRegion: '无' })),
        ['natureSeason'], '★ 只填了举办年份 ⇒ 缺赛季（EC-Final 那种跨年场次两者不同）');
    // ★ 地区的三个"不是地名但合法"的值**都算填过了**
    //   （ucup、ecfinal、ccfinal、ccpc 女生/高职场都由脚本填『待填写』，**但在判定层面被视为已填写**）。
    //   ⇒ 它们不挂在 ③ 等人"补"，想填时按值筛出来填即可。
    for (const v of ['无', '待填写', '不需要']) {
        assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
            { natureClass: 'qoj/ucup', natureYear: '无', natureSeason: '无', natureRegion: v })), [],
            `地区 = ${v} ⇒ **算填满了**（不进 ③ 待补）`);
    }
    // ⚠️ 地区是**自由文本** ⇒ 判定层面认的其实是"**非空**"：那三个词只是**约定**
    //   （管线写它们，手填时候选里有），并不是一张白名单 —— 写"成都"/"某个新城市"一样算填过。
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
        { natureClass: 'qoj/ucup', natureYear: '无', natureSeason: '无', natureRegion: '待' })), [],
        '任意非空值都算填过（自由文本，没有白名单）');
    assert.deepEqual(missingNatureKeysOf(mat('a', 'C', 'x',
        { natureClass: 'qoj/ucup', natureYear: '无', natureSeason: '无', natureRegion: '   ' })),
        ['natureRegion'], '只有**空 / 空白**才算缺');
});

test('性质待补：根节点（O）不列 —— 既有写路径没有它的入口，列出来也填不动', () => {
    assert.deepEqual(missingNatureKeysOf({ id: 'r', type: 'O', name: '根', natureClass: 'cf/contest/div2' }), []);
    for (const type of ['W', 'S', 'C', 'P', 'R']) {
        assert.deepEqual(missingNatureKeysOf(mat('a', type, 'x', { natureClass: 'qoj/无归类' })),
            ['natureYear', 'natureSeason', 'natureRegion'], `${type} 要进列表`);
    }
});

test('性质待补：collectNaturePendingItems 只收待补的，且按**树序**给', () => {
    const state = {
        rootId: 'root',
        nodes: {
            root: { id: 'root', type: 'O', name: '根' },
            // ⚠️ 对象键序刻意与树序**相反**：结果必须是树序（childOrder），不是键序
            c_b: mat('c_b', 'C', '乙赛', { natureClass: 'qoj/无归类' }),
            c_a: mat('c_a', 'C', '甲赛', { natureClass: 'qoj/无归类' }),
            c_ok: mat('c_ok', 'C', '已齐', {
                natureClass: 'qoj/无归类', natureYear: '2024', natureSeason: '2024', natureRegion: '成都'
            }),
            c_none: mat('c_none', 'C', '没标', {})
        },
        childOrder: { root: ['c_a', 'c_b', 'c_ok', 'c_none'], c_a: [], c_b: [], c_ok: [], c_none: [] }
    };
    const items = collectNaturePendingItems(state);
    assert.deepEqual(items.map(it => it.id), ['c_a', 'c_b', 'c_none'],
        '有"分类到叶子但有小缺"的两条 + 一条"连分类都没标"的比赛，顺序 = 树序');
    assert.deepEqual(items[0].missing, ['natureYear', 'natureSeason', 'natureRegion']);
    assert.equal(items[0].cls, 'qoj/无归类', '条目带的是分类路径（字段名 `cls`）');
    assert.equal(items[0].year, '', '年份读出来是空串（界面据此写「年份未知」）');
    assert.equal(items[0].season, '', '赛季同样是空串');
    assert.equal(items[0].type, 'C');
    assert.equal(items[0].name, '甲赛');
    assert.deepEqual(items[2].missing,
        ['natureClass', 'natureYear', 'natureSeason', 'natureRegion'],
        '连分类都没标的比赛：全缺（界面写「缺：分类、年份、赛季、地区」）');
    assert.equal(items[2].cls, '', 'cls 是空串 ⇒ 分组时归到「没标分类」那一组');
});

test('性质：`natureStatusOf` 把"填满了"与"根本不参与"分开（后者数量上万，不能混进来）', () => {
    // 填满（分类**到叶子**）
    assert.deepEqual(natureStatusOf(mat('a', 'C', 'x',
        { natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' })),
        { participates: true, missing: [] });
    // 参与但缺
    assert.deepEqual(natureStatusOf(mat('a', 'C', 'x', { natureClass: 'qoj/无归类' })),
        { participates: true, missing: ['natureYear', 'natureSeason', 'natureRegion'] });
    // 分类**没到叶子** ⇒ 分类也算缺（哪怕年份/赛季/地区都填了）
    assert.deepEqual(natureStatusOf(mat('a', 'C', 'x',
        { natureClass: 'xcpc/icpc', natureYear: '2024', natureSeason: '2024', natureRegion: '成都' })),
        { participates: true, missing: ['natureClass'] });
    // C 连分类都没标 ⇒ 参与（全缺）
    assert.deepEqual(natureStatusOf(mat('a', 'C', 'x')),
        { participates: true, missing: ['natureClass', 'natureYear', 'natureSeason', 'natureRegion'] });
    // 题/提交没分类 ⇒ **不参与**（不能当成"已填满"，否则两万条会被列出来）
    assert.deepEqual(natureStatusOf(mat('a', 'P', '题')), { participates: false, missing: [] });
    assert.deepEqual(natureStatusOf(mat('a', 'R', '提交')), { participates: false, missing: [] });
    // 根节点没有手改入口 ⇒ 不参与
    assert.deepEqual(natureStatusOf({ id: 'r', type: 'O', name: '根' }), { participates: false, missing: [] });
    assert.deepEqual(natureStatusOf(null), { participates: false, missing: [] });
});

test('性质：`collectNatureItems` 一次给出两摞（待补 + 已填满），都按树序、都带 `filled` 标记', () => {
    const state = {
        rootId: 'root',
        nodes: {
            root: { id: 'root', type: 'O', name: '根' },
            // 键序刻意与树序相反
            f1: mat('f1', 'C', '已填满乙', { natureClass: 'cf/contest/div2', natureYear: '2024',
                natureSeason: '2024', natureRegion: '无' }),
            // ⚠️ 分类**停在中间**（`cf` 不是叶子）⇒ 即便其余都填了，仍算**待补**
            p1: mat('p1', 'C', '待补甲', { natureClass: 'cf', natureYear: '2024',
                natureSeason: '2024', natureRegion: '成都' }),
            f2: mat('f2', 'C', '已填满甲', { natureClass: 'qoj/无归类', natureYear: '2024',
                natureSeason: '2024', natureRegion: '成都' }),
            q1: mat('q1', 'P', '一道题（不参与）'),
            p2: mat('p2', 'C', '待补乙')
        },
        childOrder: { root: ['p1', 'f1', 'f2', 'q1', 'p2'], p1: [], f1: [], f2: [], q1: [], p2: [] }
    };
    const all = collectNatureItems(state, { includeFilled: true });
    assert.deepEqual(all.pending.map(it => it.id), ['p1', 'p2'], '待补那摞 = 树序');
    assert.deepEqual(all.filled.map(it => it.id), ['f1', 'f2'], '已填满那摞 = 树序');
    assert.deepEqual(all.pending[0].missing, ['natureClass'],
        '★ 分类没细到叶子 ⇒ 算缺分类（"已填满"必须到叶子）');
    assert.equal(all.filled.every(it => it.filled === true && it.missing.length === 0), true);
    assert.equal(all.pending.every(it => it.filled === false), true);
    assert.equal(all.pending.concat(all.filled).some(it => it.id === 'q1'), false,
        '不参与的（P 没分类）两摞都不进');
    assert.equal(all.filled[0].region, '无', '条目也带地区（③ 按地区筛要用它）');
    assert.equal(all.filled[0].season, '2024', '条目也带赛季（③ 按赛季筛要用它）');

    // 默认（不开开关）只回待补那一摞；`collectNaturePendingItems` 就是它的薄包装
    const onlyPending = collectNatureItems(state, {});
    assert.deepEqual(onlyPending.filled, [], '没开开关 ⇒ 已填满那摞是空的');
    assert.deepEqual(collectNaturePendingItems(state).map(it => it.id), ['p1', 'p2'],
        '只回待补那一摞（③ 的计数只看它）');
});

test('性质待补：按「分类 + 赛季」分组（赛季未知自成一组；顺序稳定）', () => {
    const state = {
        rootId: 'root',
        nodes: {
            root: { id: 'root', type: 'O', name: '根' },
            a1: mat('a1', 'C', '2024 甲站', { natureClass: 'xcpc/icpc', natureYear: '2024', natureSeason: '2024' }),
            a2: mat('a2', 'C', '2024 乙站', { natureClass: 'xcpc/icpc/eu/regional/official', natureYear: '2024',
                natureSeason: '2024', natureRegion: '成都' }),
            a3: mat('a3', 'C', '某站', { natureClass: 'xcpc' }),
            a4: mat('a4', 'C', '另一站', { natureClass: 'xcpc/ccpc' }),
            b1: mat('b1', 'C', 'CF Round', { natureClass: 'cf/contest/div2', natureYear: '2025', natureSeason: '2025' }),
            b2: mat('b2', 'C', 'CF 早期', { natureClass: 'cf' }),
            z1: mat('z1', 'C', '没标分类的')
        },
        childOrder: { root: ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'z1'] }
    };
    const groups = groupNaturePending(collectNaturePendingItems(state));

    // 组顺序 = **Trie 的书写顺序**（`xcpc` 在 `xcpc/icpc` 前、`cf` 在 `cf/contest/div2` 前），
    // 组内赛季升序、赛季未知最后；不在 Trie 里的（这里是空分类）排最后
    assert.deepEqual(groups.map(g => `${g.main}|${g.mainLabel}|${g.season}|${g.items.length}`),
        ['xcpc|xcpc||1', 'xcpc/icpc|xcpc / icpc|2024|1', 'xcpc/ccpc|xcpc / ccpc||1',
            'cf|cf||1', 'cf/contest/div2|cf / contest / div2|2025|1', '|没标分类||1'],
        '分组口径 = **整条分类路径** + 赛季（键用的是赛季，见 `planKeyOf`）；空分类自成一组并标「没标分类」');
    assert.deepEqual(groups[0].items.map(it => it.id), ['a3'], '分类只到 `xcpc` 的自成一组');
    assert.deepEqual(groups[1].items.map(it => it.id), ['a1'], 'a2 已填齐（不在待补里）');
    assert.deepEqual(groups[2].items.map(it => it.id), ['a4'], '`xcpc/ccpc` 是另一组');
    assert.equal(groups[5].mainLabel, '没标分类', '空分类那一组有专门文案');

    // 赛季排序：数字按**数**排，词表外的写法按字典序，空永远最后
    const yearGroups = groupNaturePending([
        { id: 'y1', cls: 'xcpc', season: '' },
        { id: 'y2', cls: 'xcpc', season: '2025' },
        { id: 'y3', cls: 'xcpc', season: '26' },
        { id: 'y4', cls: 'xcpc', season: '2024' }
    ]);
    assert.deepEqual(yearGroups.map(g => g.season), ['2024', '2025', '26', ''],
        '20xx 按数排 → 其它写法按字典序 → 空最后');
});
