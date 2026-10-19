// ================================================================
// 判重测试（core/dedup.js）—— 归入合成节点
//
// 判定规则只有一条：**`ownerSynth` 非空且相等 ⟺ 归入同一个合成节点**
// （合成节点自己的身份是 `synthKey`）。所以这里既要钉"相等就一组"，
// 也要钉**不相等/为空绝不成组** —— 后者才是这条设计的意义（各渠道各出节点，
// 不许悄悄合并）。
//
// 还要钉三条硬约束：
//   · **合成节点自己不被推荐 / 不能被归入**（成员名单不能嵌套）；
//   · **W/S 不参与**（既不参与归入，也不参与推荐）；
//   · **推荐只推荐，不写**（`suggestMembers` 跑完节点表里一个字段都没变）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isSynthesisNode,
    isMaterialCandidate,
    synthGroups,
    unownedMaterialIds,
    suggestMembers,
    SYNTH_KEY_FIELD,
    OWNER_FIELD
} from '../core/dedup.js';

function c(id, extra = {}) {
    return { id, type: 'C', name: `比赛 ${id}`, extKey: '', ownerSynth: '', ...extra };
}

/** 合成节点（身份 = synthKey） */
function syn(id, key, extra = {}) {
    return { id, type: 'C', name: `合成 ${id}`, [SYNTH_KEY_FIELD]: key, ...extra };
}

function state(children, rootId = 'root') {
    return {
        rootId,
        nodes: children,
        childOrder: {},
        parentOf: {}
    };
}

// ---- 字段键（回归锚：界面文案「所属合成节点」不是字段键） ----

test('字段键就是 ownerSynth / synthKey，不是中文界面文案', () => {
    assert.equal(SYNTH_KEY_FIELD, 'synthKey');
    assert.equal(OWNER_FIELD, 'ownerSynth');
    const n = { id: 'a', type: 'C', name: 'x', '所属合成节点': 'synth:1' };
    assert.deepEqual(unownedMaterialIds({ a: n }), ['a'],
        '中文标签当键读 ⇒ 读不到任何指针、照样算"未归入"');
});

// ⚠️ "空/缺省/空白"这条口径由公开 API `unownedMaterialIds` 钉住。
test('未归入的判据：空/缺省/空白都算未归入，两端空白去掉', () => {
    assert.deepEqual(unownedMaterialIds({ a: c('a') }), ['a']);
    assert.deepEqual(unownedMaterialIds({ a: { id: 'a', type: 'C' } }), ['a'], '字段都没有 = 未归入');
    assert.deepEqual(unownedMaterialIds({ a: c('a', { ownerSynth: '   ' }) }), ['a'], '只有空白 = 未归入');
    assert.deepEqual(unownedMaterialIds({ a: c('a', { ownerSynth: '  x  ' }) }), [], '两端空白去掉 ⇒ 算已归入');
});

test('isSynthesisNode / isMaterialCandidate：合成节点不是候选（名单不能嵌套）', () => {
    assert.equal(isSynthesisNode(syn('s', 'synth:1')), true);
    assert.equal(isSynthesisNode(c('a')), false);
    assert.equal(isMaterialCandidate(syn('s', 'synth:1')), false, '合成节点不进候选');
    assert.equal(isMaterialCandidate(c('a')), true);
    assert.equal(isMaterialCandidate({ id: 'w', type: 'W', name: 'x' }), false, 'W 不参与合成');
    assert.equal(isMaterialCandidate({ id: 's', type: 'S', name: 'x' }), false, 'S 不参与合成');
    assert.equal(isMaterialCandidate({ id: 'o', type: 'O', name: 'x' }), false, 'O 不参与合成');
    assert.equal(isMaterialCandidate(null), false);
});

// ---- ① 分组依据 = ownerSynth；合成节点清单 ----
//
// ⚠️ 分组判定一律看下面的 `synthGroups` / `unownedMaterialIds`（配 `suggestMembers`）。

test('synthGroups：合成节点清单带成员，成员按**树序**', () => {
    const st = state({
        root: { id: 'root', type: 'O', name: '根' },
        s1: syn('s1', 'synth:1', { name: '甲合成' }),
        c2: c('c2', { ownerSynth: 'synth:1' }),
        c1: c('c1', { ownerSynth: 'synth:1' }),
        s2: syn('s2', 'synth:2', { name: '乙合成' })
    });
    // 树序：c2 在 c1 前面（只看 childOrder，不看对象键序）
    st.childOrder = { root: ['s1', 'c2', 'c1', 's2'], s1: [], c2: [], c1: [], s2: [] };
    const groups = synthGroups(st);
    assert.deepEqual(groups.map(g => g.key), ['synth:1', 'synth:2'], '按标识升序');
    assert.equal(groups[0].nodeId, 's1');
    assert.equal(groups[0].name, '甲合成');
    assert.equal(groups[0].memberIds.length, 2, '成员数按指针算');
    assert.deepEqual(groups[0].memberIds, ['c2', 'c1'], '按树序，不按对象键序');
    assert.equal(groups[1].memberIds.length, 0, '零成员的合成节点也在清单里（空组）');
    assert.equal(groups[0].danglingCount, 0);
});

test('synthGroups：悬空指针 → 组里标出来（不丢、不炸）', () => {
    const st = state({
        root: { id: 'root', type: 'O', name: '根' },
        s1: syn('s1', 'synth:1'),
        ghost: c('ghost', { ownerSynth: 'synth:1', type: 'P' })   // 类型不匹配（P vs C）
    });
    st.childOrder = { root: ['s1', 'ghost'], s1: [], ghost: [] };
    const groups = synthGroups(st);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].danglingCount, 1, '跨类型的指针要在组里如实标出来');
    assert.equal(unownedMaterialIds(st.nodes).includes('ghost'), false,
        '悬空原料**不**混进"未归入"（它自己有一条黄条 + 一键清理）');
});

test('synthGroups：指向不存在的合成节点 ⇒ 没有那个组（原料自己算一组）', () => {
    const st = state({
        root: { id: 'root', type: 'O', name: '根' },
        ghost: c('ghost', { ownerSynth: 'synth:不存在' })
    });
    st.childOrder = { root: ['ghost'], ghost: [] };
    assert.deepEqual(synthGroups(st), [], '没有这个合成节点 ⇒ 清单里没有它');
});

test('synthGroups：合成节点自己带指针也不算成员（名单不能嵌套）', () => {
    const st = state({
        root: { id: 'root', type: 'O', name: '根' },
        s1: syn('s1', 'k1'),
        s2: syn('s2', 'k2', { ownerSynth: 'k1' })   // 只有导入能造出这种数据
    });
    st.childOrder = { root: ['s1', 's2'], s1: [], s2: [] };
    const groups = synthGroups(st);
    assert.deepEqual(groups.find(g => g.key === 'k1').memberIds, [], '合成节点不当成员');
});

// ---- 未归入的原料：合成节点与 W/S 都不在里面 ----

test('unownedMaterialIds：排除合成节点、排除 W/S/O', () => {
    const nodes = {
        s1: syn('s1', 'k1'),
        w1: { id: 'w1', type: 'W', name: '平台' },
        c1: c('c1'),
        c2: c('c2', { ownerSynth: 'k1' }),
        p1: { id: 'p1', type: 'P', name: '题' },
        r1: { id: 'r1', type: 'R', name: '提交' }
    };
    assert.deepEqual(unownedMaterialIds(nodes), ['c1', 'p1', 'r1'],
        '合成节点 s1 与 W 不进"可被归入"的集合');
});

// ---- ② 推荐 ----

const parentOf = { a: 'S1', b: 'S1', d: 'S2', e: 'S1' };

/**
 * 只关心候选本身，截断信息默认不校验。
 *
 * ⚠️ 默认模式是 **`strict`（硬门槛）**，而本段用例钉的是**相似度口径**。
 * 它们是"硬门槛关掉之后"的**回归锚**，所以这里显式传 `mode:'similar'` ——
 * 别把它们改成 strict，那是另一组用例（见 dedupScope.test.js）。
 */
function cands(nodes, parents, opts) {
    return suggestMembers(nodes, parents, { mode: 'similar', ...(opts || {}) }).candidates;
}

test('推荐：同父 + 标题像 + 都没归属 → 建议"新建合成节点并归入"这一对', () => {
    const nodes = {
        a: c('a', { name: '2026 浙江省赛' }),
        b: c('b', { name: '2026 浙江省赛（榜单）' })
    };
    const s = cands(nodes, { a: 'S1', b: 'S1' });
    assert.equal(s.length, 1);
    assert.equal(s[0].a, 'a');
    assert.equal(s[0].b, 'b');
    assert.equal(s[0].suggestSynthId, '', '还没有合成节点可归 → 建议新建');
    assert.ok(s[0].score >= 0.7);
});

test('推荐：旁边已有同父同类型的合成节点 → 建议**归入它**（给 suggestSynthId）', () => {
    const nodes = {
        s1: syn('s1', 'synth:k1', { name: '2026 浙江省赛' }),
        b: c('b', { name: '2026 浙江省赛（榜单）' })
    };
    const s = cands(nodes, { s1: 'S1', b: 'S1' });
    assert.equal(s.length, 1, '合成节点与未归入的原料同块 → 出一条"归入"建议');
    assert.equal(s[0].a, 'b', '被归入的是那个**未归入的原料**');
    assert.equal(s[0].b, 's1');
    assert.equal(s[0].suggestSynthId, 's1');
    assert.equal(s[0].suggestKey, 'synth:k1');
});

test('推荐：已归入的不推荐', () => {
    const nodes = {
        a: c('a', { name: '2026 浙江省赛', ownerSynth: 'k1' }),
        b: c('b', { name: '2026 浙江省赛（榜单）' })
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }), []);
});

test('推荐：不同父（跨系列）不推荐 —— 同名不等于同一场', () => {
    const nodes = {
        a: c('a', { name: '2026 浙江省赛' }),
        b: c('b', { name: '2026 浙江省赛' })
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S2' }), []);
});

test('推荐：类型不同不推荐（平台与系列名字像纯属噪声）', () => {
    const nodes = {
        a: c('a', { name: 'XCPC' }),
        b: { id: 'b', type: 'W', name: 'XCPC', ownerSynth: '' }
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }), [], 'W 连候选都不是（分桶前就被排除）');
});

test('推荐：W/S 节点自己也不进候选（哪怕互相很像）', () => {
    const nodes = {
        w1: { id: 'w1', type: 'W', name: '2026 浙江省赛' },
        w2: { id: 'w2', type: 'W', name: '2026 浙江省赛（榜单）' }
    };
    assert.deepEqual(cands(nodes, { w1: 'S1', w2: 'S1' }), []);
});

test('推荐：合成节点不会被推荐（不参与"被别人绑定"）', () => {
    const nodes = {
        s1: syn('s1', 'k1', { name: '2026 浙江省赛' }),
        s2: syn('s2', 'k2', { name: '2026 浙江省赛（榜单）' })
    };
    assert.deepEqual(cands(nodes, { s1: 'S1', s2: 'S1' }), [],
        '两个合成节点像到 1.0 也不出候选：它不能被归入谁');
});

test('推荐：只差序号的一对跳过（编号系列天然 0.96，全是误报）', () => {
    const nodes = {
        a: c('a', { name: '2026 暑期联赛（1）' }),
        b: c('b', { name: '2026 暑期联赛（2）' })
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }), []);
});

test('推荐：建议标识取先有的那个 extKey（通常是权威来源的 slug）', () => {
    const nodes = {
        a: c('a', { name: '2026 浙江省赛', extKey: 'xcpc:c:zjcpc-2026' }),
        b: c('b', { name: '2026 浙江省赛（榜单）', extKey: 'qoj:c:1234' })
    };
    const s = cands(nodes, { a: 'S1', b: 'S1' });
    assert.equal(s[0].suggestKey, 'xcpc:c:zjcpc-2026');
});

test('推荐：阈值可调，边界按 ≥ 判', () => {
    const nodes = {
        a: c('a', { name: '2026 省赛 甲组' }),
        b: c('b', { name: '2026 省赛 乙组' })
    };
    assert.equal(cands(nodes, { a: 'S1', b: 'S1' }, { threshold: 0.1 }).length, 1, '阈值低就该报出来');
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }, { threshold: 0.99 }), [], '阈值高就不报');
});

// ---- 推荐只推荐，不写 ----

test('推荐**绝不写数据**：跑完之后节点表逐字段不变', () => {
    const nodes = {
        s1: syn('s1', 'synth:k1', { name: '2026 浙江省赛' }),
        b: c('b', { name: '2026 浙江省赛（榜单）' }),
        x: c('x', { name: '2026 省赛 甲组' }),
        y: c('y', { name: '2026 省赛 乙组' })
    };
    const before = JSON.stringify(nodes);
    const s = cands(nodes, { s1: 'S1', b: 'S1', x: 'S1', y: 'S1' }, { threshold: 0.1 });
    assert.ok(s.length > 0, '（前提）确实出了候选');
    assert.equal(JSON.stringify(nodes), before, '推荐跑完，一个字段都没改');
    assert.equal(nodes.b.ownerSynth, '', '尤其没有替用户写 ownerSynth');
    assert.equal(nodes.s1[SYNTH_KEY_FIELD], 'synth:k1');
});

// ---- 性能闸门（两万条也不能卡） ----
//
// 这几条钉的是"不会算不完"，不是"算得全"：
//   · 阻塞键：**第一个 token** 不同 → 不比（少提示一条，但不影响判定）；
//   · 总量预算：花完就退化成"同名配对"，并如实报 truncated；
//   · 空名字：没有 token，谁都不比。

test('阻塞：第一个 token 不同的一对不推荐（省掉大部分两两比）', () => {
    const nodes = {
        a: c('a', { name: '浙江省赛 2026 第一场' }),
        b: c('b', { name: '2026 浙江省赛 第一场' })
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }), [],
        '第一个 token 不同 → 不在同一块 → 不推荐（判定权仍在 ownerSynth 上）');
});

test('阻塞：只取第一个 token，所以"多一个字母"的一对仍能比到', () => {
    const nodes = {
        a: c('a', { name: 'Two Sum' }),
        b: c('b', { name: 'Two Sums' })
    };
    assert.equal(cands(nodes, { a: 'S1', b: 'S1' }).length, 1,
        '若阻塞键取前两个 token，`Two Sum` 与 `Two Sums` 会被切成两块而永远比不到');
});

test('预算：块太大时退化成"同名配对"，并报出被截断的块', () => {
    const nodes = {};
    const parents = {};
    // 80 个同前缀的兄弟：两两 3160 对，预算 10 → 必然走退化路径
    for (let i = 0; i < 80; i++) {
        const id = `x${i}`;
        nodes[id] = c(id, { name: `2026 省赛 第 ${i} 场` });
        parents[id] = 'S1';
    }
    // 其中两个名字完全相同（最强信号，退化路径也必须抓到）
    nodes.x7.name = '2026 省赛 特别场';
    nodes.x9.name = '2026 省赛 特别场';

    const res = suggestMembers(nodes, parents, { maxPairs: 10, mode: 'similar' });
    eqNames(res.candidates.map(p => `${p.a}-${p.b}`), ['x7-x9']);
    assert.equal(res.truncated.length, 1, '被截断的块要如实报出来（页面据此提示）');
    assert.equal(res.truncated[0].size, 80);
    assert.equal(res.truncated[0].parent, 'S1');
    assert.equal(res.truncated[0].type, 'C');
});

test('名字为空 / 全标点的节点不参与比较（没有可比语义）', () => {
    const nodes = {
        a: c('a', { name: '' }),
        b: c('b', { name: '' })
    };
    assert.deepEqual(cands(nodes, { a: 'S1', b: 'S1' }), []);
});

test('两万条：推荐不退回两两比（预算生效，且耗时在量级内）', () => {
    // 一个"练习容器挂了 4000 道散题"的最坏分布：同父同类型同前缀
    const nodes = {
        s0: syn('s0', 'synth:bench', { name: '2026 省赛 第 0 场' })
    };
    const parents = { s0: 'S1' };
    for (let i = 1; i <= 20000; i++) {
        const id = `n${i}`;
        nodes[id] = c(id, { type: 'P', name: `2026 省赛 第 ${i} 场` });
        parents[id] = 'S1';
    }
    const t0 = Date.now();
    const res = suggestMembers(nodes, parents, { mode: 'similar' });
    const ms = Date.now() - t0;
    assert.ok(res.truncated.length >= 1, '大块必须走退化路径（否则就是两两比）');
    assert.ok(ms < 3000, `2 万条同前缀散题应在 3 秒内算完（实测 ${ms}ms）`);
});

function eqNames(actual, expected) {
    assert.deepEqual(actual.slice().sort(), expected.slice().sort());
}
