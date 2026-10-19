// ================================================================
// 来源优先级写操作测试（core/ops/trust.js）
//
// 三个动作都必须**可逆**、**幂等**，而且不能把字段值弄空。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    getFieldPrefer,
    setFieldPrefer,
    clearFieldPrefer,
    markValueInvalid,
    removeSourceValue,
    reprojectField
} from '../core/ops/trust.js';

function makeState() {
    return {
        trust: {
            categoryRank: ['manual', 'board', 'script', 'derived'],
            sources: { 'pta:x': { kind: 'board', rank: 30 }, 'srk:x': { kind: 'script', rank: 20 } },
            fieldPrefer: {}
        },
        nodes: {
            p1: {
                id: 'p1', type: 'P', name: 'A', ratio: '4.61',
                values: { ratio: [
                    { v: '4.61', src: 'pta:x', at: 'T1' },
                    { v: '4.60', src: 'srk:x', at: 'T1' }
                ] }
            },
            p2: { id: 'p2', type: 'P', ratio: '1.00', values: {} }
        }
    };
}

test('getFieldPrefer：数组/单值/缺省都能读', () => {
    assert.deepEqual(getFieldPrefer({ fieldPrefer: { ratio: 'pta:x' } }, 'ratio'), ['pta:x']);
    assert.deepEqual(getFieldPrefer({ fieldPrefer: { ratio: ['a', 'b'] } }, 'ratio'), ['a', 'b']);
    assert.deepEqual(getFieldPrefer({}, 'ratio'), []);
});

test('setFieldPrefer：改配置 + **立刻重算该字段的值**（否则设了没反应）', () => {
    const s = makeState();
    const r = setFieldPrefer(s, 'ratio', 'srk:x');
    assert.equal(r.ok, true);
    assert.deepEqual(s.trust.fieldPrefer.ratio, ['srk:x']);
    assert.equal(s.nodes.p1.ratio, '4.60', '缓存值应当跟着偏好变');
    assert.equal(r.reprojected.changed, 1);
    assert.equal(s.nodes.p2.ratio, '1.00', '没有来源值的节点不许动');
});

test('可逆：清掉偏好 → 值回到另一个来源', () => {
    const s = makeState();
    setFieldPrefer(s, 'ratio', 'srk:x');
    assert.equal(s.nodes.p1.ratio, '4.60');
    const r = clearFieldPrefer(s, 'ratio');
    assert.equal(r.ok, true);
    assert.equal(s.nodes.p1.ratio, '4.61', '清掉偏好后回到权威榜单');
});

test('不给手改设偏好（手改本来就最高，设了会让人误解）', () => {
    const s = makeState();
    const r = setFieldPrefer(s, 'ratio', 'manual');
    assert.equal(r.ok, false);
    assert.match(r.reason, /手改/);
    assert.deepEqual(s.trust.fieldPrefer, {});
});

test('清一个本来就没有偏好的字段 → 明确说没有，不静默成功', () => {
    const r = clearFieldPrefer(makeState(), 'ratio');
    assert.equal(r.ok, false);
    assert.match(r.reason, /没有偏好/);
});

test('markValueInvalid：标失效 + 重投影（用另一个来源的值）', () => {
    const s = makeState();
    const r = markValueInvalid(s, 'p1', 'ratio', 'pta:x', '4.61');
    assert.equal(r.ok, true);
    assert.equal(s.nodes.p1.values.ratio[0].invalid, true);
    assert.equal(s.nodes.p1.ratio, '4.60', '失效后应当改用剩下的那个来源');
});

test('markValueInvalid：不许失效唯一的值（否则字段会变空）', () => {
    const s = makeState();
    const r = markValueInvalid(s, 'p2', 'ratio', 'x', 'y');   // p2 没有来源值
    assert.equal(r.ok, false);
    assert.match(r.reason, /没找到/);

    const s2 = makeState();
    s2.nodes.p1.values.ratio = [{ v: '4.61', src: 'pta:x', at: 'T1' }];
    const r2 = markValueInvalid(s2, 'p1', 'ratio', 'pta:x', '4.61');
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /唯一的值/);
    assert.equal(s2.nodes.p1.ratio, '4.61', '值不能被弄空');
});

test('markValueInvalid：可以恢复（invalid=false）', () => {
    const s = makeState();
    markValueInvalid(s, 'p1', 'ratio', 'pta:x', '4.61');
    const back = markValueInvalid(s, 'p1', 'ratio', 'pta:x', '4.61', false);
    assert.equal(back.ok, true);
    assert.equal(s.nodes.p1.values.ratio[0].invalid, false);
    assert.equal(s.nodes.p1.ratio, '4.61');
});

test('reprojectField：没来源值的节点不碰（与 applyProjection 契约一致）', () => {
    const s = makeState();
    const r = reprojectField(s, 'ratio');
    assert.equal(r.nodes, 1, '只有 p1 有来源值');
    assert.equal(s.nodes.p2.ratio, '1.00');
});

test('reprojectField：同值再投一次不算变化（幂等）', () => {
    const s = makeState();
    reprojectField(s, 'ratio');
    const again = reprojectField(s, 'ratio');
    assert.equal(again.changed, 0);
});

// ================================================================
// 「真删」：界面要能"真删手改值"
// 与「不用」的区别：`不用` 只标记（值留着留痕、可恢复）；`真删` 把值**移除**。
// 但两者共用同一条硬规则：**不许把字段弄成"没有可用值"**。
// ================================================================

test('removeSourceValue：删掉那条值 + 重投影到剩下的来源', () => {
    const s = makeState();
    const r = removeSourceValue(s, 'p1', 'ratio', 'pta:x', '4.61');
    assert.equal(r.ok, true);
    assert.equal(s.nodes.p1.values.ratio.length, 1, '来源层里真的少了一条');
    assert.equal(s.nodes.p1.values.ratio[0].src, 'srk:x');
    assert.equal(s.nodes.p1.ratio, '4.60', '删掉当前选中的那条 → 缓存值落到别的来源');
    assert.deepEqual(r.removed, { v: '4.61', src: 'pta:x' });
});

test('removeSourceValue：删"已标不用"的那条是合法的（剩下的可用值不受影响）', () => {
    const s = makeState();
    s.nodes.p1.values.ratio[1].invalid = true;      // srk 那条已标不用
    const r = removeSourceValue(s, 'p1', 'ratio', 'srk:x', '4.60');
    assert.equal(r.ok, true, '清掉"已标不用"的值正是真删的常见用途');
    assert.equal(s.nodes.p1.values.ratio.length, 1);
    assert.equal(s.nodes.p1.ratio, '4.61');
});

test('removeSourceValue：删掉唯一一条 ⇒ 字段回到默认值（不再拦）', () => {
    // 「真删」：允许删掉唯一一条（否则"唯一一条是手改值时面板上一个按钮都没有、
    // 根本清不掉"），代价是要把**缓存值一起回默认** —— 否则字段会继续显示刚删掉的那个值。
    const s = makeState();
    s.nodes.p1.values.ratio = [{ v: '4.61', src: 'manual', at: 'T1', account: 'k1' }];
    const r = removeSourceValue(s, 'p1', 'ratio', 'manual', '4.61', 'k1');
    assert.equal(r.ok, true);
    assert.equal(r.cleared, true);
    assert.equal(s.nodes.p1.values.ratio, undefined, '来源层清空（键也去掉）');
    assert.equal(s.nodes.p1.ratio, '', 'ratio 的默认值是空串');
});

test('removeSourceValue：删完只剩"已标不用"的 ⇒ 也回默认值', () => {
    const s = makeState();
    s.nodes.p1.values.ratio = [
        { v: '4.50', src: 'manual', at: 'T2', account: 'k1' },     // 唯一可用
        { v: '4.60', src: 'srk:x', at: 'T1', invalid: true }       // 已标不用
    ];
    const r = removeSourceValue(s, 'p1', 'ratio', 'manual', '4.50', 'k1');
    assert.equal(r.ok, true);
    assert.equal(r.cleared, true, '没有可用值了 ⇒ 回默认（否则字段还显示 4.50，像没删掉）');
    assert.equal(s.nodes.p1.ratio, '');
    assert.equal(s.nodes.p1.values.ratio.length, 1, '那条"已标不用"的仍留在来源层留痕');
});

test('removeSourceValue：按**账户**精确配对（不许删到别人那条手改值）', () => {
    const s = makeState();
    s.nodes.p1.values.ratio = [
        { v: '4.50', src: 'manual', at: 'T1', account: 'k1' },
        { v: '4.40', src: 'manual', at: 'T2', account: 'k2' },
        { v: '4.61', src: 'pta:x', at: 'T1' }
    ];
    const r = removeSourceValue(s, 'p1', 'ratio', 'manual', '4.40', 'k1');
    assert.equal(r.ok, false, 'k1 想删 k2 那条 → 找不到（同 src 同值也不行）');
    assert.match(r.reason, /没找到/);
    assert.equal(s.nodes.p1.values.ratio.length, 3);
    const ok = removeSourceValue(s, 'p1', 'ratio', 'manual', '4.40', 'k2');
    assert.equal(ok.ok, true, '带着对账户就删得掉');
    assert.equal(s.nodes.p1.values.ratio.length, 2);
});

test('removeSourceValue：找不到这条值就明说，不静默', () => {
    const s = makeState();
    const r = removeSourceValue(s, 'p1', 'ratio', '不存在', '9.99');
    assert.equal(r.ok, false);
    assert.match(r.reason, /没找到/);
    const r2 = removeSourceValue(s, '不存在', 'ratio', 'pta:x', '4.61');
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /节点不存在/);
});
