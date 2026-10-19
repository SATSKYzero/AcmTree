// ================================================================
// 「哪些节点不该算合成键」的注册表（src/test/synthRegistry.test.js）
//
// 「有些节点不该算合成键」的逻辑与注册表：
// "节点级白名单 + 分类白名单，是**不同层的属性叠加**"，例子："**比如平壤**"。
//
// 这里钉四件事：
//   ① 注册表本体**加载得起来**且形状自检会拦坏数据；
//   ② 分类白名单：**去镜像前缀**后比、**精确或前缀**都算命中；
//   ③ 节点白名单：按 `extKey`（也认 `synthKey`）点名；
//   ④ "注册表里点名了、给的这批节点里却没有" 要能报出来（写错 extKey / 那场没了）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SYNTH_CLASS_RULES, SYNTH_NODE_RULES, SYNTH_REGISTRY_VERSION, assertSynthRegistry,
    classRuleHit, matchText, missingSynthRules, noSynthReasonOf, noSynthRuleOf,
} from '../core/synthRegistry.js';

test('注册表加载：版本读得出来，且两条白名单都是数组（空的也算合法）', () => {
    assert.ok(SYNTH_REGISTRY_VERSION >= 1, `registryVersion=${SYNTH_REGISTRY_VERSION}`);
    assert.ok(Array.isArray(SYNTH_CLASS_RULES));
    assert.ok(Array.isArray(SYNTH_NODE_RULES));
});

test('形状自检：坏数据必须当场抛（它是人的结论，写坏了不许静默）', () => {
    assert.throws(() => assertSynthRegistry(null), /顶层必须是对象/);
    assert.throws(() => assertSynthRegistry({}), /registryVersion/);
    assert.throws(() => assertSynthRegistry({ registryVersion: 1, classRules: {} }), /必须是数组/);
    assert.throws(() => assertSynthRegistry({ registryVersion: 1, classRules: [{ match: 'x' }] }),
        /缺 why/, '没有理由的规则不许进注册表');
    assert.throws(() => assertSynthRegistry({ registryVersion: 1, nodeRules: [{ why: 'x' }] }),
        /既没有 extKey 也没有 synthKey/);
    assert.doesNotThrow(() => assertSynthRegistry({ registryVersion: 1, classRules: [], nodeRules: [] }));
});

test('归一化：先去镜像前缀再比（`qoj/xcpc/…` / `cf/gyms/xcpc/…` 与 `xcpc/…` 是同一件事）', () => {
    assert.equal(matchText('qoj/xcpc/icpc/ec/regional'), 'xcpc/icpc/ec/regional');
    assert.equal(matchText('cf/gyms/xcpc/ccpc/final'), 'xcpc/ccpc/final');
    assert.equal(matchText('xcpc/icpc'), 'xcpc/icpc');
    // ⚠️ 没有 `xcpc` 那一段的（如 `qoj/无归类`）原样保留 —— 那三支镜像各算各的
    assert.equal(matchText('qoj/无归类'), 'qoj/无归类');
    assert.equal(matchText(' qoj/ucup '), 'qoj/ucup');
});

test('分类白名单：精确或**前缀**都算命中（写 `xcpc/icpc/ec` 一处覆盖它下面所有子路径）', () => {
    const cls = 'qoj/xcpc/icpc/ec/regional/official';
    assert.equal(classRuleHit('xcpc/icpc/ec', cls), true, '前缀命中');
    assert.equal(classRuleHit('qoj/xcpc/icpc/ec/regional/official', cls), true, '精确命中（另一边写镜像前缀也行）');
    assert.equal(classRuleHit('xcpc/icpc/ec/regional', cls), true);
    assert.equal(classRuleHit('xcpc/icpc', cls), true, '更短的父路径也算');
    assert.equal(classRuleHit('xcpc/ccpc', cls), false, '不同分支不命中');
    assert.equal(classRuleHit('xcpc/icpc/ecx', cls), false, '★ 按**段**对齐：不许把 `ecx` 当成 `ec/` 的前缀');
    assert.equal(classRuleHit('', cls), false, '空规则不命中（不会误伤全库）');
});

test('节点白名单：`qoj:c:2180`（平壤）被排除；别的场次不受影响', () => {
    const rule = noSynthRuleOf({ extKey: 'qoj:c:2180', natureClass: 'qoj/xcpc/icpc/ec/regional/official' });
    assert.ok(rule, '★ 举的例子（"比如平壤"）必须在注册表里');
    assert.equal(rule.layer, 'nodeRules');
    assert.equal(rule.match, 'qoj:c:2180');
    assert.match(rule.why, /平壤/, '理由里要写清为什么（场地在中国境外）');
    assert.equal(noSynthRuleOf({ extKey: 'qoj:c:2181', natureClass: 'qoj/xcpc/icpc/ec/regional/official' }), null,
        '同一分类的其它场次**不受影响**（这正是"节点级"存在的理由）');
    assert.equal(noSynthRuleOf(null), null);
    assert.match(noSynthReasonOf({ extKey: 'qoj:c:2180' }), /节点白名单：qoj:c:2180/);
    assert.equal(noSynthReasonOf({ extKey: 'qoj:c:1' }), '');
});

test('"注册表里点名了、这批节点里却没有" 要报出来（写错 extKey / 那场没了）', () => {
    const miss = missingSynthRules([{ extKey: 'qoj:c:1' }]);
    assert.deepEqual(miss, ['qoj:c:2180'], '没命中就报它的 key');
    assert.deepEqual(missingSynthRules([{ extKey: 'qoj:c:2180' }]), [], '命中就不报');
});
