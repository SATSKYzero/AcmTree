// ================================================================
// 「应有 / 已有」判定（core/fieldRegistry.js）单测
//
// 每个字段条都有『是否应有』『是否已有』『来源』『优先级』。
// 这里的规则必须与构建侧 `scripts/field-coverage.py` 的 `predicate_holds()` / `is_filled()`
// **逐条对齐** —— 两边算出来不一样，界面说的"缺"就跟体检报告对不上。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EXPECT_LABEL, expectNoteHtml, expectOf, identityKeyOf, isFilledValue, makeParentResolver,
    nodeTypeOf, predicateHolds, ruleOf
} from '../core/fieldRegistry.js';

const nameKey = 'https://codeforces.com/problemset/problem/663/B';

const registry = {
    registryVersion: 1,
    fields: {
        name: { expect: 'required', types: ['*'], when: { notExtKeyPrefix: ['aux-'] }, why: '没名字没法读' },
        problemId: { expect: 'required', types: ['P'], why: '题号是身份之一' },
        cfDifficulty: {
            expect: 'expected', types: ['P'],
            when: { extKeyPrefix: ['cf:c:'], contestIdBelow: 100000, evidence: 'cf-page' },
            why: 'CF 常规轮次题按说都有难度分'
        },
        link: { expect: 'optional', types: ['*'], why: '有的渠道就是没有链接' }
    }
};

test('identityKeyOf：extKey 优先，合成节点退回 synthKey', () => {
    assert.equal(identityKeyOf({ extKey: 'cf:c:1:p:A' }), 'cf:c:1:p:A');
    assert.equal(identityKeyOf({ synthKey: 'synth:problem:cf:c:1:p:A' }), 'synth:problem:cf:c:1:p:A');
    assert.equal(identityKeyOf({}), '');
    assert.equal(identityKeyOf(null), '');
});

test('isFilledValue：空串/空数组/空对象算"没有"，0 算"有"（与构建侧 is_filled 一致）', () => {
    assert.equal(isFilledValue(''), false);
    assert.equal(isFilledValue('   '), false);
    assert.equal(isFilledValue(null), false);
    assert.equal(isFilledValue(undefined), false);
    assert.equal(isFilledValue([]), false);
    assert.equal(isFilledValue({}), false);
    assert.equal(isFilledValue(0), true);
    assert.equal(isFilledValue('0'), true);
    assert.equal(isFilledValue(['a']), true);
});

test('predicateHolds：四个谓词与"未知键不参与判定"', () => {
    assert.equal(predicateHolds({ when: {} }, { extKey: 'x' }), true, '没有 when ⇒ 恒成立');
    assert.equal(predicateHolds(ruleOf(registry, 'cfDifficulty'),
        { extKey: 'qoj:c:1:p:A', type: 'P' }), false, '前缀不匹配 ⇒ 不成立');
    assert.equal(predicateHolds(ruleOf(registry, 'cfDifficulty'),
        { extKey: 'cf:c:663:p:B', type: 'P' }), true);
    assert.equal(predicateHolds(ruleOf(registry, 'cfDifficulty'),
        { extKey: 'cf:c:105161:p:A', type: 'P' }), false, 'gym（≥100000）⇒ 不成立');
    assert.equal(predicateHolds(ruleOf(registry, 'name'),
        { extKey: 'aux-pta:c:1:p:A', type: 'P' }), false, 'aux- 豁免 ⇒ 不成立');
    assert.equal(predicateHolds({ when: { parentKind: 'R' } },
        { extKey: 'x', parentExtKey: 'r1' }, { parentOf: { r1: { type: 'R' } } }), false,
        '⚠️ parentOf 必须是**函数**（传 `state.nodes` 那种 id→节点 的表 = 永远查不到 ⇒ 静默"不适用"）');
    assert.equal(predicateHolds({ when: { parentKind: 'R' } },
        { extKey: 'x', parentExtKey: 'r1' }, { parentOf: (k) => (k === 'r1' ? { type: 'R' } : null) }),
        true, '按 extKey 查父 ⇒ 成立');
    assert.equal(predicateHolds({ when: { parentKind: 'R' } }, { extKey: 'x', parentExtKey: 'r1' }),
        false, '拿不到父 ⇒ 判不出来就不成立（不瞎猜）');
});

test('makeParentResolver：按 extKey 找父（state.nodes 是 id→节点，必须自己建索引）', () => {
    const parent = { id: 'n7', type: 'C', extKey: 'cf:c:663' };
    const child = { id: 'n8', type: 'P', extKey: 'cf:c:663:p:B', parentExtKey: 'cf:c:663' };
    const state = { nodes: { n7: parent, n8: child } };
    const parentOf = makeParentResolver(state);
    assert.equal(parentOf('cf:c:663'), parent, '按 extKey 命中');
    assert.equal(parentOf('cf:c:663:p:B'), child);
    assert.equal(parentOf('不存在'), null);
    assert.equal(parentOf(''), null);
    assert.equal(makeParentResolver(null)('x'), null, '没有 state ⇒ 一律 null，不抛');
    // 与谓词连起来用：这才是 `parentKind` 规则的正确用法
    assert.equal(predicateHolds({ when: { parentKind: 'C' } }, child, { parentOf }), true);
    assert.equal(predicateHolds({ when: { parentKind: 'P' } }, child, { parentOf }), false);
});

test('expectOf / expectNoteHtml：`已有` 问的是**界面上那个值**（shownValue），不是缓存字段', () => {
    const node = { extKey: 'cf:c:663:p:B', type: 'P', cfDifficulty: '' };   // 缓存字段是空的
    // 界面（投影）却有值（比如手改过）：那就不该说"缺"
    const shown = expectNoteHtml(registry, node, 'cfDifficulty', { shownValue: () => '2000' });
    assert.match(shown, /已有：有/, '投影值有 ⇒ 已有=有');
    const cached = expectNoteHtml(registry, node, 'cfDifficulty');
    assert.match(cached, /已有：缺/, '不传 shownValue 才退回缓存字段（这时确实是空的）');
    assert.equal(expectOf(registry, node, 'cfDifficulty', { shownValue: () => '2000' }).hasValue, true);
});

test('nature 四维：C 的规则（nature 四维进注册表）', () => {
    // 与 `acm-data/field-registry.json` 里那四条同形：natureClass 必须有，年/赛季/地区应该有
    const natureReg = { fields: {
        natureClass: { expect: 'required', types: ['C'], why: '分类路径是骨架' },
        natureYear: { expect: 'expected', types: ['C'], why: '比赛年份' },
        natureSeason: { expect: 'expected', types: ['C'], why: '赛季' },
        natureRegion: { expect: 'expected', types: ['C'], why: '地区' },
        language: { expect: 'optional', types: ['R'], when: { notExtKeyPrefix: ['aux-pta:'] } }
    } };
    const c = { type: 'C', extKey: 'qoj:c:1924', natureClass: 'qoj/xcpc/icpc/ec/final/official',
                natureYear: '2023', natureSeason: '2023', natureRegion: '待填写' };
    const cls = expectOf(natureReg, c, 'natureClass');
    assert.equal(cls.level, 'required');
    assert.equal(cls.applies, true, 'C 上适用');
    assert.equal(cls.hasValue, true);
    // 特殊值（`待填写`/`无`/`不需要`）算"已填" —— 与构建侧同一口径（那是**结论**，不是空缺）
    assert.equal(expectOf(natureReg, c, 'natureRegion').hasValue, true, '`待填写` 算有值');
    // 类型的边界：nature 只管 C、language 只管 R
    assert.equal(expectOf(natureReg, { type: 'P', extKey: 'qoj:c:1:p:A' }, 'natureClass'), null);
    assert.equal(expectOf(natureReg, { type: 'C', extKey: 'x' }, 'language'), null);
    // 缺 region ⇒ 琥珀（应该有）；缺 classification ⇒ 红（必须有）
    const missing = expectNoteHtml(natureReg, { ...c, natureRegion: '' }, 'natureRegion');
    assert.match(missing, /应有：应该有 · 已有：缺/);
    assert.match(missing, /#b45309/);
    const bad = expectNoteHtml(natureReg, { ...c, natureClass: '' }, 'natureClass');
    assert.match(bad, /应有：必须有 · 已有：缺/);
    assert.match(bad, /#b91c1c/);
    // language 降级成"可有可无"（直接标可有可无）
    const lang = expectNoteHtml(natureReg, { type: 'R', extKey: 'qoj:c:1:sub:9' }, 'language');
    assert.match(lang, /应有：可有可无 · 已有：无/, '缺了只说"无"，不说"缺"');
});

test('expectOf：档位 / 适用 / 已有 / 证据标记', () => {
    const p = { extKey: 'cf:c:663:p:B', type: 'P' };
    const miss = expectOf(registry, p, 'cfDifficulty');
    assert.equal(miss.level, 'expected');
    assert.equal(miss.applies, true);
    assert.equal(miss.hasValue, false, '没有值 ⇒ 已有=无');
    assert.equal(miss.evidence, true, '注册表带 evidence ⇒ 界面提一句"可能有豁免"');
    assert.equal(miss.why, 'CF 常规轮次题按说都有难度分', '理由照抄注册表');

    const has = expectOf(registry, { ...p, cfDifficulty: '2000' }, 'cfDifficulty');
    assert.equal(has.hasValue, true);

    // 类型不适用 / 规则不存在 ⇒ null（界面不显示那一行）
    assert.equal(expectOf(registry, { type: 'R' }, 'problemId'), null, 'P 的规则不问 R');
    assert.equal(expectOf(registry, p, '不存在的字段'), null);
    assert.equal(expectOf(null, p, 'cfDifficulty'), null, '没有注册表 ⇒ 一律 null');
});

test('expectNoteHtml：缺 ⇒ 标出来并按档位配色；不适用 ⇒ 明说"不适用"', () => {
    const missing = expectNoteHtml(registry, { extKey: 'cf:c:663:p:B', type: 'P' }, 'cfDifficulty');
    assert.match(missing, /应有：应该有/);
    assert.match(missing, /已有：缺/);
    assert.match(missing, /#b45309/, 'expected 缺 ⇒ 琥珀色');
    assert.match(missing, /title="CF 常规轮次题按说都有难度分"/);

    const required = expectNoteHtml(registry, { type: 'P', extKey: 'cf:c:1:p:A' }, 'name');
    assert.match(required, /应有：必须有/);
    assert.match(required, /#b91c1c/, 'required 缺 ⇒ 红色');

    const optional = expectNoteHtml(registry, { type: 'P', extKey: 'cf:c:1:p:A', link: '' }, 'link');
    assert.match(optional, /已有：无/, '可有可无的字段缺了就说"无"，不说"缺"');

    const filled = expectNoteHtml(registry, { type: 'P', extKey: 'cf:c:1:p:A', name: 'Rebus' }, 'name');
    assert.match(filled, /已有：有/);

    const na = expectNoteHtml(registry, { extKey: 'cf:c:105161:p:A', type: 'P' }, 'cfDifficulty');
    assert.match(na, /应有：不适用/, '谓词不成立 ⇒ 明说不适用（不是"缺"）');

    assert.equal(expectNoteHtml(registry, { type: 'P' }, '不存在'), '', '不认识的字段 ⇒ 空串');
    assert.equal(EXPECT_LABEL.required, '必须有', '档位中文说法只有一份');
    assert.equal(nameKey.length > 0, true);
});

test('nodeTypeOf：应用用 `type`、包用 `节点类型`，两个都要认（回归）', () => {
    // 病灶：只读 `node.节点类型` ⇒ 应用里恒为空 ⇒ 凡是有具体 `types` 的规则全返回 null，
    //       只剩 `types:['*']` 的 name/link 有「应有/已有」那一行。
    assert.equal(nodeTypeOf({ type: 'C' }), 'C', '应用节点');
    assert.equal(nodeTypeOf({ 节点类型: 'C' }), 'C', '包里的记录');
    assert.equal(nodeTypeOf({ type: 'C', 节点类型: 'R' }), 'C', '两个都有 ⇒ 以应用那个为准');
    assert.equal(nodeTypeOf({}), '');
    assert.equal(nodeTypeOf(null), '');

    const natureReg = { fields: { natureClass: { expect: 'required', types: ['C'] } } };
    const appNode = { id: 'n1', type: 'C', extKey: 'qoj:c:1924',
                      natureClass: 'qoj/xcpc/icpc/ec/final/official' };
    assert.match(expectNoteHtml(natureReg, appNode, 'natureClass'), /应有：必须有 · 已有：有/,
        '应用里的 C 节点必须能算出「应有」');
});
