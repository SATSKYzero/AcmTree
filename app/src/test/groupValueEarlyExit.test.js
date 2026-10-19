// ================================================================
// 「组那份」取值的**早退**（`core/groupCompute.js`）
//
// 钉住的是那条**便宜**的路：
//   `hasGroupValue()` 为了回答"这题有没有『组那份』"这**一个是/否**，会把
//   `groupComputed`（整棵树算一遍，真包 27k 节点 **~750ms**）整个跑完。
//   而"**不在任何组里**"的节点（没有 `ownerSynth`、也不是组头）答案必然是"没有"。
//
// 钉两件事：
//   ① **语义**：不在组里 ⇒ `groupValueOf` 恒 `undefined`、`hasGroupValue` 恒 `false`；
//   ② **常数时间**：那一趟"整树扫描"**真的没发生** —— 用"一被枚举就抛错"的 `nodes` 代理来证
//      （只要它还扫全表，这个测试就会炸）。⚠️ 别把这条改成"看耗时"的断言：那是 flaky 的。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { groupValueOf, hasGroupValue, clearGroupMemo } from '../core/groupCompute.js';
import { SYNTH_PREFIX } from '../core/query/groupCount.js';

const TRUST = { categoryRank: ['manual'], sources: { manual: { kind: 'manual', rank: 100 } }, fieldPrefer: {} };
const manual = (v) => ({ v, src: 'manual', at: 'T1', account: 'k1' });

/** 一个**不在任何组里**的节点（没有 ownerSynth、没有 synthKey） */
const loner = () => ({ id: 'p9', type: 'P', name: '散题', values: { status1: [manual('1')] } });

test('① 不在组里 ⇒ `groupValueOf` 恒 `undefined`、`hasGroupValue` 恒 `false`', () => {
    const st = {
        rootId: 'o', settings: { stats: { countMode: 'plain' } },
        nodes: { o: { id: 'o', type: 'O' }, p9: loner() },
        childOrder: { o: ['p9'], p9: [] }, parentOf: { o: null, p9: 'o' },
        accounts: { k1: { id: 'k1', name: '主号' } }, trust: TRUST, viewingAccountId: 'k1'
    };
    clearGroupMemo();
    assert.equal(groupValueOf(st, st.nodes.p9, 'status1'), undefined);
    assert.equal(hasGroupValue(st, st.nodes.p9, 'status1'), false);
    // 反向锚：非组聚合字段（`name`）本来就不该有组那份
    assert.equal(groupValueOf(st, st.nodes.p9, 'name'), undefined);
    // 空节点 / 没给节点也别抛
    assert.equal(groupValueOf(st, null, 'status1'), undefined);
    assert.equal(hasGroupValue(st, undefined, 'status1'), false);
});

test('★ ② 常数时间：早退那一步**没有**去扫全表（`nodes` 一被枚举就抛）', () => {
    const st = {
        rootId: 'o', settings: { stats: { countMode: 'plain' } },
        // 只要有人 `Object.keys(nodes)` / `for...in` / 建表，立刻炸 —— 早退就不该走到那儿
        nodes: new Proxy({ o: { id: 'o', type: 'O' }, p9: loner() }, {
            ownKeys() { throw new Error('不该枚举 nodes（那就是整棵树算一遍）'); },
            get(t, k) { if (k === 'p9') return t.p9; return t[k]; }
        }),
        childOrder: { o: ['p9'], p9: [] }, parentOf: { o: null, p9: 'o' },
        accounts: { k1: { id: 'k1', name: '主号' } }, trust: TRUST, viewingAccountId: 'k1'
    };
    clearGroupMemo();
    assert.equal(groupValueOf(st, st.nodes.p9, 'status1'), undefined, '不在组里 ⇒ 直接说不，不扫表');
    assert.equal(hasGroupValue(st, st.nodes.p9, 'status1'), false);
});

test('③ 对照：**在组里**的节点仍然照常算（组头 / 成员都认）', () => {
    const st = {
        rootId: 'o', settings: { stats: { countMode: 'plain' } },
        nodes: {
            o: { id: 'o', type: 'O' },
            syn: { id: 'syn', type: 'P', synthKey: `${SYNTH_PREFIX}gp`, name: '合成', values: {} },
            m1: { id: 'm1', type: 'P', ownerSynth: `${SYNTH_PREFIX}gp`, name: 'a', values: { status1: [manual('1')] } },
            m2: { id: 'm2', type: 'P', ownerSynth: `${SYNTH_PREFIX}gp`, name: 'b', values: { status1: [manual('0')] } }
        },
        childOrder: { o: ['syn', 'm1', 'm2'], syn: [], m1: [], m2: [] },
        parentOf: { o: null, syn: 'o', m1: 'o', m2: 'o' },
        accounts: { k1: { id: 'k1', name: '主号' } }, trust: TRUST, viewingAccountId: 'k1'
    };
    clearGroupMemo();
    // 成员 m2 自己没按，但组里 m1 按了 ⇒ 组那份是 1（这条口径是既有的，早退不能把它挡掉）
    assert.equal(groupValueOf(st, st.nodes.m2, 'status1'), 1, '在组里 ⇒ 照常给组那份');
    assert.equal(hasGroupValue(st, st.nodes.m2, 'status1'), true);
    assert.equal(groupValueOf(st, st.nodes.syn, 'status1'), 1, '组头也一样');
});
