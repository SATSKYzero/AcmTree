// ================================================================
// 两处检索的**共用件**契约（core/query/searchShared.js + nodes.js 的祖先链）
//
// 为什么单独一个文件：这两样若在两个 feature 里**各抄一份**（逐字相同）就会漂
// 共用件只有一份，这里钉住它的契约，
// 两个 feature 的测试只用管"接线对不对"。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { norm, hasText, hasList, sortRecords, matchTextPair } from '../core/query/searchShared.js';
import { getAncestors, getAncestorsRootFirst } from '../core/query/nodes.js';

// ---------------------------------------------------------------
// 条件判断
// ---------------------------------------------------------------
test('norm / hasText / hasList：空即"不筛选"', () => {
    assert.equal(norm(undefined), '');
    assert.equal(norm(null), '');
    assert.equal(norm('AbC'), 'abc');
    assert.equal(hasText(''), false);
    assert.equal(hasText('  '), false);
    assert.equal(hasText('x'), true);
    assert.equal(hasText(['x']), false);
    assert.equal(hasList([]), false);
    assert.equal(hasList(['x']), true);
    assert.equal(hasList('x'), false);
});

// ---------------------------------------------------------------
// 稳定排序
// ---------------------------------------------------------------
const rec = (id, v, extra = {}) => ({ id, v, ...extra });

test('sortRecords：数值键按大小、文本键按拼音；升/降序都认', () => {
    const list = [rec('a', 3), rec('b', 1), rec('c', 2)];
    assert.deepEqual(sortRecords(list, { keyOf: (r) => r.v }).map(r => r.id), ['b', 'c', 'a']);
    assert.deepEqual(sortRecords(list, { keyOf: (r) => r.v, direction: 'desc' }).map(r => r.id),
        ['a', 'c', 'b']);

    const names = [rec('a', '乙'), rec('b', '甲')];
    assert.deepEqual(sortRecords(names, { keyOf: (r) => r.v }).map(r => r.id), ['b', 'a'],
        '文本键按中文拼音（甲 < 乙）');
});

test('sortRecords：**稳定** —— 同值保持传入顺序', () => {
    const list = [rec('a', 1, { seq: 1 }), rec('b', 1, { seq: 2 }), rec('c', 0, { seq: 3 })];
    assert.deepEqual(sortRecords(list, { keyOf: (r) => r.v }).map(r => r.id), ['c', 'a', 'b'],
        '值相同的 a/b 不许因排序而换位');
});

test('sortRecords：`isBlank` 那类**升序降序都垫底**', () => {
    const list = [rec('real', 5), rec('none', 999, { empty: true }), rec('small', 1)];
    const opts = { keyOf: (r) => r.v, isBlank: (v, r) => !!r.empty };
    assert.deepEqual(sortRecords(list, opts).map(r => r.id), ['small', 'real', 'none']);
    assert.deepEqual(sortRecords(list, { ...opts, direction: 'desc' }).map(r => r.id),
        ['real', 'small', 'none'], '降序时它也不许跑到最前面');
});

test('sortRecords：不改传入数组', () => {
    const list = [rec('a', 2), rec('b', 1)];
    sortRecords(list, { keyOf: (r) => r.v });
    assert.deepEqual(list.map(r => r.id), ['a', 'b']);
});

// ---------------------------------------------------------------
// 祖先链（两处检索的"归属"共用的那一个）
// ---------------------------------------------------------------
function chainState() {
    return {
        rootId: 'root',
        nodes: {
            root: { id: 'root', name: '根' },
            w1: { id: 'w1', name: '平台' },
            s1: { id: 's1', name: '系列' },
            p1: { id: 'p1', name: '题目' }
        },
        childOrder: { root: ['w1'], w1: ['s1'], s1: ['p1'], p1: [] },
        parentOf: { root: null, w1: 'root', s1: 'w1', p1: 's1' }
    };
}

test('祖先链：`getAncestorsRootFirst` 根在前（两处检索的归属读的就是它）', () => {
    const st = chainState();
    assert.deepEqual(getAncestorsRootFirst(st, 'p1').map(n => n.id), ['root', 'w1', 's1']);
    assert.deepEqual(getAncestorsRootFirst(st, 'root'), []);
    assert.deepEqual(getAncestors(st, 'p1').map(n => n.id), ['s1', 'w1', 'root'],
        '`getAncestors` 是它的反序（末位是根）—— 两个名字就差顺序，别混用');
});

test('祖先链：断链 / 空状态 / 自指环都不炸', () => {
    assert.deepEqual(getAncestorsRootFirst(null, 'x'), []);
    const broken = chainState();
    broken.parentOf.p1 = '不存在的父';
    assert.deepEqual(getAncestorsRootFirst(broken, 'p1'), []);
    // 成环：`w1 ↔ s1`。**恰好走满上限**才是"上限真的在兜"（写 `<= 1000` 是恒真的，
    // 去掉上限只会让测试挂住而不是变红）。
    const loop = chainState();
    loop.parentOf.w1 = 's1';
    assert.equal(getAncestorsRootFirst(loop, 'p1').length, 1000, '成环时由深度上限兜住');
});

test('★「名称/题号」与「键」的并集 / 交集（检索条件栏那颗切换钮的唯一口径）', () => {
    // 默认 `and` = 交集：两个都要命中 ⇒ 与加那颗按钮之前**逐字相同**
    assert.equal(matchTextPair('XCPC 西安', '西安', 'xcpcio:icpc2024xian', ''), true);
    assert.equal(matchTextPair('XCPC 西安', '西安', 'xcpcio:icpc2024xian', 'nope'), false, '交集：键没命中 ⇒ 不选');
    assert.equal(matchTextPair('XCPC 西安', '', 'xcpcio:icpc2024xian', 'nope'), false, '交集：只填键时照旧筛');
    // 显式 'and' 与不传等价（防止"忘了传"变成另一种口径）
    assert.equal(matchTextPair('a', 'a', 'k', 'k', 'and'), true);
    // `or` = 并集：命中任一个就算
    assert.equal(matchTextPair('XCPC 西安', '西安', 'xcpcio:icpc2024xian', 'nope', 'or'), true, '并集：名称命中就够');
    assert.equal(matchTextPair('XCPC 西安', 'nope', 'xcpcio:icpc2024xian', 'xian', 'or'), true, '并集：键命中就够');
    assert.equal(matchTextPair('XCPC 西安', 'nope', 'xcpcio:icpc2024xian', 'nope2', 'or'), false, '并集：两个都不中');
    // 两个框都空 ⇒ 不筛（并集/交集都一样）
    assert.equal(matchTextPair('x', '', 'y', '', 'or'), true);
    assert.equal(matchTextPair('x', '', 'y', '', 'and'), true);
    // 包含匹配 + 不分大小写（与其它文本条件同一条规则）
    assert.equal(matchTextPair('Codeforces Round', 'round', 'CF:1', '', 'and'), true);
});

test('sortRecords 缺取键函数 ⇒ 当场报清楚（顺带证明 `valueOf` 那个坑已被避开）', () => {
    assert.throws(() => sortRecords([{ a: 1 }]), /keyOf/);
    // ⚠️ 选项名若叫 `valueOf`，解构会从 `Object.prototype` 上把那个函数取出来，
    //    "没传"永远判不出来 ⇒ 那种写法必须**直接报错**，而不是静默乱排。
    assert.throws(() => sortRecords([{ a: 2 }, { a: 1 }], { valueOf: (r) => r.a }), /keyOf/);
});
