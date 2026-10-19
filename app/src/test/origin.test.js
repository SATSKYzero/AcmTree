// ================================================================
// 创建归属测试（core/ops/origin.js）
//
// P0：节点"在不在"也是一个元素，它同样要记"谁让它出现的"。
// 这里钉住三条：**幂等**（先到先得）、**不编造**、**空账户 = 客观**。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ORIGIN_FIELD,
    MANUAL_ORIGIN,
    markOrigin,
    originOf
} from '../core/ops/origin.js';

test('markOrigin：写入创建归属，时间取 createdAt', () => {
    const node = { createdAt: '2026.09.22 21:50' };
    assert.equal(markOrigin(node, { src: 'pta-x', account: 'k1' }), true);
    assert.deepEqual(node[ORIGIN_FIELD], {
        src: 'pta-x', account: 'k1', at: '2026.09.22 21:50'
    });
    assert.notEqual(originOf(node).src, MANUAL_ORIGIN, '不是手建的');
});

test('markOrigin 幂等：**永不覆盖**（先到先得 = 真正的创建者）', () => {
    const node = { createdAt: 'T1' };
    markOrigin(node, { src: MANUAL_ORIGIN, account: 'k1', at: 'T1' });
    // 之后别的东西（比如重新导入）想改写它 → 一律不动
    assert.equal(markOrigin(node, { src: 'qoj-y', account: 'k2', at: 'T2' }), false);
    assert.deepEqual(originOf(node), { src: MANUAL_ORIGIN, account: 'k1', at: 'T1' });
});

test('account 缺省 = 客观（空串），不是 undefined', () => {
    const node = { createdAt: 'T1' };
    markOrigin(node, { src: 'pkg' });
    assert.equal(originOf(node).account, '');
    assert.equal(Object.prototype.hasOwnProperty.call(node[ORIGIN_FIELD], 'account'), true);
});

test('src 缺省 = manual（手建是默认情况）', () => {
    const node = { createdAt: 'T1' };
    markOrigin(node, {});
    assert.equal(originOf(node).src, MANUAL_ORIGIN);
});

test('originOf：老节点没有 origin → null（**不编造**"来源未知"这类假记录）', () => {
    assert.equal(originOf({}), null);
    assert.equal(originOf({ origin: 'not-an-object' }), null);
    assert.equal(originOf(null), null);
});

test('坏输入不炸', () => {
    assert.equal(markOrigin(null, { src: 'x' }), false);
    assert.equal(markOrigin('不是对象', { src: 'x' }), false);
    assert.equal(originOf(undefined), null);
});

test('空 at 会回落到 createdAt（区分"没有时间"与"时间就是空"）', () => {
    const node = { createdAt: 'T9' };
    markOrigin(node, { src: 'pkg', account: '', at: '' });
    assert.equal(originOf(node).at, 'T9');
});
