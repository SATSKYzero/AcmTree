// ================================================================
// 计数接线测试（src/test/countWiring.test.js）
//
// 钉三件事：
//   ① **回归锚**：没有合成节点时，`plain` 必须**逐节点等于**朴素的"子树节点数"递归
//      （这就是"不去重 ≡ 子树节点数加法"，接线不许改动这个口径）；
//   ② **真字段键**：分组读的是 `ownerSynth`（界面「所属合成节点」是 UI 标签）。
//      写中文键**不产生任何分组** —— 默认取值器读中文键会让生产里所有组退化成
//      单元素组、而单测照样绿，那正是这里要钉死的 bug；
//   ③ **设置解析**：`resolveCountMode` 缺省 / 非法一律 `plain`，只有 `'dedup'` 才是去重。
//
// 纯对象、无 immer / DOM 依赖（`npm test` 用纯 Node 跑）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupCount, MODE_PLAIN, MODE_DEDUP, SYNTH_PREFIX } from '../core/query/groupCount.js';
import { resolveCountMode, countGroupsOf, isCountMode } from '../core/query/countMode.js';

// ---- 造树小工具（与 groupCount.test.js 同形，另加 settings） ----
function makeState(settings) {
    const st = { rootId: null, nodes: {}, childOrder: {}, parentOf: {} };
    if (settings !== undefined) st.settings = settings;
    return st;
}

function add(state, id, type, parentId = null, extra = {}) {
    state.nodes[id] = { id, type, ...extra };
    state.childOrder[id] = [];
    if (parentId === null) {
        state.rootId = id;
        state.parentOf[id] = null;
    } else {
        state.childOrder[parentId].push(id);
        state.parentOf[id] = parentId;
    }
    return state.nodes[id];
}

/** 朴素递归：子树节点数（参照实现，故意写得笨） */
function recursiveCounts(state) {
    const out = {};
    (function walk(id) {
        let n = 1;
        for (const c of state.childOrder[id] || []) n += walk(c);
        out[id] = n;
        return n;
    })(state.rootId);
    return out;
}

/** 一个**真的**合成组：合成节点 syn + 成员 m1/m2（用真字段键 `ownerSynth`） */
function fixtureSynth(settings) {
    const st = makeState(settings);
    add(st, 'o', 'O');
    add(st, 'syn', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    add(st, 'm1', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    add(st, 'm2', 'C', 'o', { ownerSynth: SYNTH_PREFIX + 'g1' });
    return st;
}

// ================================================================
// ① resolveCountMode：缺省 / 非法 → plain；dedup → dedup
// ================================================================
test('resolveCountMode：缺省与非法值一律回落 plain，只有 dedup 才是去重', () => {
    assert.equal(resolveCountMode(undefined), MODE_PLAIN, '没有 settings ⇒ plain');
    assert.equal(resolveCountMode(null), MODE_PLAIN);
    assert.equal(resolveCountMode({}), MODE_PLAIN, '没有 stats ⇒ plain');
    assert.equal(resolveCountMode({ stats: {} }), MODE_PLAIN, '老存档缺 countMode ⇒ plain');
    assert.equal(resolveCountMode({ stats: { countMode: '' } }), MODE_PLAIN);
    assert.equal(resolveCountMode({ stats: { countMode: 'no-such-mode' } }), MODE_PLAIN, '非法值 ⇒ plain');
    assert.equal(resolveCountMode({ stats: { countMode: null } }), MODE_PLAIN);
    assert.equal(resolveCountMode({ stats: { countMode: 1 } }), MODE_PLAIN, '非字符串 ⇒ plain');
    assert.equal(resolveCountMode({ stats: { countMode: MODE_PLAIN } }), MODE_PLAIN);
    assert.equal(resolveCountMode({ stats: { countMode: MODE_DEDUP } }), MODE_DEDUP);
    assert.equal(resolveCountMode({ stats: { countMode: ' dedup ' } }), MODE_PLAIN, '不 trim：带空格也是非法值');
    assert.equal(isCountMode(MODE_PLAIN) && isCountMode(MODE_DEDUP), true);
});

// ================================================================
// ② 回归锚：无合成节点时，plain ≡ 朴素递归「子树节点数」；且 plain ≡ dedup
// ================================================================
test('无合成节点：plain 逐节点等于朴素递归的子树节点数，且 plain ≡ dedup', () => {
    // 确定性伪随机树（LCG，便于复现）；**刻意混入 C/P/R**，但不给 synthKey/ownerSynth
    const st = makeState();
    let seed = 20260930;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    add(st, 'n0', 'O');
    const ids = ['n0'];
    for (let i = 1; i <= 149; i++) {
        const parent = ids[Math.floor(rnd() * ids.length)];
        const id = 'n' + i;
        add(st, id, ['C', 'P', 'R', 'S', 'W'][i % 5], parent);
        ids.push(id);
    }

    const want = recursiveCounts(st);
    const plainState = makeState({ stats: { countMode: MODE_PLAIN } });
    const dedupState = makeState({ stats: { countMode: MODE_DEDUP } });
    for (const k of ['nodes', 'childOrder', 'parentOf', 'rootId']) {
        plainState[k] = st[k];
        dedupState[k] = st[k];
    }

    const plain = countGroupsOf(plainState);
    const dedup = countGroupsOf(dedupState);

    assert.equal(plain.byNode['n0'].groupCount, want['n0'], '根：plain = 子树节点数（回归锚）');
    assert.equal(plain.groupCount, plain.byNode['n0'].groupCount, '顶层口径 = 根子树的');
    for (const id of ids) {
        assert.equal(plain.byNode[id].groupCount, want[id], `plain ${id} = 朴素子树加法`);
        assert.equal(dedup.byNode[id].groupCount, want[id], `dedup ${id} = 朴素子树加法（无合成 ⇒ 无差别）`);
    }
    assert.deepEqual(dedup.byNode, plain.byNode, '无合成节点时两模式结果完全相等');
});

// ================================================================
// ③ 真字段键回归锚：ownerSynth 才分组；中文键「所属合成节点」不产生任何分组
// ================================================================
test('真字段键：ownerSynth 指向 synthKey ⇒ 两条合成一组（dedup 少算两次）', () => {
    const st = fixtureSynth({ stats: { countMode: MODE_DEDUP } });
    const r = countGroupsOf(st);

    assert.equal(r.byNode['o'].groupCount, 2, 'dedup：整棵树 = {o} + {g1} = 2 组');
    assert.equal(r.byNode['syn'].groupCount, 1, '合成节点自己那棵子树里只有 g1');
    const g = r.groups.get(SYNTH_PREFIX + 'g1');
    assert.ok(g, '必须真的存在 synth:g1 这一组');
    assert.equal(g.synthId, 'syn', '组的头 = 合成节点');
    assert.deepEqual(g.members, ['m1', 'm2'], '两个成员都归进同一组');
    assert.deepEqual(r.warnings, [], '干净数据不该有告警');

    // 同一棵树在 plain 下：所有原料都算（o/m1/m2），合成节点的成员在子树内 ⇒ 它不计
    const p = countGroupsOf(st, { mode: MODE_PLAIN });
    assert.equal(p.byNode['o'].groupCount, 3, 'plain = o + m1 + m2 = 3');
    assert.equal(p.byNode['o'].groupCount - r.byNode['o'].groupCount, 1,
        '差 = 合成节点数（2 个成员合成 1 组）');
});

test('中文键「所属合成节点」不是字段键 ⇒ 一个组都合不起来（把 bug 钉死）', () => {
    const st = makeState({ stats: { countMode: MODE_DEDUP } });
    add(st, 'o', 'O');
    add(st, 'syn', 'C', 'o', { synthKey: SYNTH_PREFIX + 'g1' });
    // ⚠️ 这里**故意**写界面中文标签当字段键
    add(st, 'm1', 'C', 'o', { '所属合成节点': SYNTH_PREFIX + 'g1' });
    add(st, 'm2', 'C', 'o', { '所属合成节点': SYNTH_PREFIX + 'g1' });

    const r = countGroupsOf(st);
    assert.equal(r.byNode['o'].groupCount, 4, 'o / syn / m1 / m2 各自一组 = 4（没有任何分组）');
    assert.deepEqual(r.groups.get(SYNTH_PREFIX + 'g1').members, [],
        '合成节点是空组：成员指针没被读到');
    for (const [key, slot] of r.groups) {
        assert.ok(slot.members.length <= 1, `组 ${key} 不该有多个成员`);
    }
    assert.deepEqual(r.warnings, [], '中文键只是"没有这个字段"，不是悬空指针 ⇒ 无告警');

    // 与真字段键那一版对照：同一个形状，只有字段键不同 ⇒ 4 vs 2
    const real = countGroupsOf(fixtureSynth({ stats: { countMode: MODE_DEDUP } }));
    assert.equal(real.byNode['o'].groupCount, 2);
    assert.notEqual(r.byNode['o'].groupCount, real.byNode['o'].groupCount,
        '字段键写错与写对必须给出不同结果（否则这个 bug 又会被单测盖住）');
});

// ================================================================
// ④ 接线本身：settings 驱动模式、scopeRoot 透传、只读、不进历史
// ================================================================
test('countGroupsOf：模式来自 settings.stats.countMode，rootId 透传 scopeRoot', () => {
    const st = fixtureSynth({ stats: { countMode: MODE_DEDUP } });
    assert.equal(countGroupsOf(st).byNode['o'].groupCount, 2, 'settings 说 dedup ⇒ 去重');

    st.settings.stats.countMode = MODE_PLAIN;
    assert.equal(countGroupsOf(st).byNode['o'].groupCount, 3, 'settings 说 plain ⇒ 不去重');

    // 显式 mode 覆盖设置
    st.settings.stats.countMode = MODE_PLAIN;
    assert.equal(countGroupsOf(st, { mode: MODE_DEDUP }).byNode['o'].groupCount, 2, '显式 dedup 覆盖设置');
    st.settings.stats.countMode = MODE_DEDUP;
    assert.equal(countGroupsOf(st, { mode: MODE_PLAIN }).byNode['o'].groupCount, 3, '显式 plain 覆盖设置');
    // 非法显式 mode：回落设置
    st.settings.stats.countMode = MODE_DEDUP;
    assert.equal(countGroupsOf(st, { mode: 'bogus' }).byNode['o'].groupCount, 2, '非法 mode ⇒ 回落设置');

    // scopeRoot 透传：只回答那棵子树
    const only = countGroupsOf(st, { rootId: 'syn' });
    assert.deepEqual(Object.keys(only.byNode), ['syn'], 'scopeRoot 只算这棵子树');
    assert.equal(only.groupCount, only.byNode['syn'].groupCount, '顶层口径 = scope 根的');

    // 与直接调 groupCount 逐字一致
    const direct = groupCount({
        nodes: st.nodes, parentOf: st.parentOf, childOrder: st.childOrder,
        scopeRoot: 'o', mode: MODE_DEDUP
    });
    assert.deepEqual(countGroupsOf(st, { rootId: 'o' }).byNode, direct.byNode);
});

test('countGroupsOf 只读：不写派生、不写来源层、不改输入', () => {
    const st = fixtureSynth({ stats: { countMode: MODE_DEDUP } });
    st.sources = { manual: { kind: 'manual' } };
    const before = JSON.stringify({ nodes: st.nodes, parentOf: st.parentOf, childOrder: st.childOrder, sources: st.sources, settings: st.settings });
    const nodeKeysBefore = Object.keys(st.nodes['m1']).sort();

    countGroupsOf(st);
    countGroupsOf(st, { rootId: 'o', mode: MODE_PLAIN });

    assert.equal(JSON.stringify({ nodes: st.nodes, parentOf: st.parentOf, childOrder: st.childOrder, sources: st.sources, settings: st.settings }), before,
        '输入（含来源层与设置）逐字节不变');
    assert.deepEqual(Object.keys(st.nodes['m1']).sort(), nodeKeysBefore,
        '没有往节点上写任何派生字段（两列值是派生缓存，绝不写回来源层）');
});
