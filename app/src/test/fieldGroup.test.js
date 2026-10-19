// ================================================================
// **字段组**（数值难度）单测：
//   数值难度有 cf 本身难度 & clist 难度两个来源 ⇒ 它自己就是一个字段组，
//   并且需要**快捷切换所查看系列**。
//
// 组 = 同一类信息、各来源各写各的字段。构建侧的对应实现是
// `scripts/field-coverage.py` 的 `group_rows()`（判"这一组该不该有"），两边的组定义
// **都来自注册表的 `groups` 段**（随包发布）—— 这是"一份规则两处用"的那条线。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    groupNoteHtml, groupOfField, groupValues, pickInGroup
} from '../core/fieldRegistry.js';

const registry = {
    groups: {
        数值难度: {
            fields: ['cfDifficulty', 'atcoderDifficulty'],
            expect: 'expected',
            anyOf: true,
            why: '同一道题的数值难度，各来源各写各的字段'
        }
    },
    fields: {
        cfDifficulty: { expect: 'expected', types: ['P'], when: { extKeyPrefix: ['cf:c:'] } },
        atcoderDifficulty: { expect: 'expected', types: ['P'], when: { extKeyPrefix: ['atcoder:'] } }
    }
};

const cfNode = { id: 'n1', type: 'P', extKey: 'cf:c:663:p:B', cfDifficulty: 2000 };
const atNode = { id: 'n2', type: 'P', extKey: 'atcoder:abc138:p:A', atcoderDifficulty: -848 };
const both = { id: 'n3', type: 'P', extKey: 'cf:c:1:p:A', cfDifficulty: 1200, atcoderDifficulty: 300 };
const neither = { id: 'n4', type: 'P', extKey: 'cf:c:1:p:B' };

test('groupOfField：认得出成员，也认得出"不属于任何组"', () => {
    const g = groupOfField(registry, 'atcoderDifficulty');
    assert.equal(g.name, '数值难度');
    assert.deepEqual(g.fields, ['cfDifficulty', 'atcoderDifficulty']);
    assert.equal(g.anyOf, true);
    assert.equal(groupOfField(registry, 'ratio'), null, '不在组里的字段 ⇒ null');
    assert.equal(groupOfField(null, 'cfDifficulty'), null, '没有注册表 ⇒ null');
    assert.equal(groupOfField({}, 'cfDifficulty'), null, '注册表没有 groups 段 ⇒ null');
});

test('groupValues / pickInGroup：谁有值、现在看哪个（**顺序 + 显式偏好**两条规则）', () => {
    assert.deepEqual(groupValues(registry, cfNode, '数值难度').map(x => x.field), ['cfDifficulty']);
    assert.deepEqual(groupValues(registry, both, '数值难度').map(x => x.field),
        ['cfDifficulty', 'atcoderDifficulty'], '两个都有 ⇒ 按注册表顺序列出来');

    // ① 没设偏好：按**注册表成员顺序**取第一个有值的（顺序 = 优先级声明）
    const p1 = pickInGroup(registry, both, '数值难度');
    assert.equal(p1.field, 'cfDifficulty');
    assert.equal(p1.pickedBy, 'order');
    assert.deepEqual(p1.others.map(x => x.field), ['atcoderDifficulty'], '其余成员作为"可切换"的候选');

    // ② 设了偏好：用它（用户显式选过，最高）
    const trust = { groupPrefer: { 数值难度: 'atcoderDifficulty' } };
    const p2 = pickInGroup(registry, both, '数值难度', { trust });
    assert.equal(p2.field, 'atcoderDifficulty');
    assert.equal(p2.pickedBy, 'prefer');
    assert.deepEqual(p2.others.map(x => x.field), ['cfDifficulty']);

    // ③ 偏好指向的成员**没有值** ⇒ 退回顺序规则（不能显示一个空的口径）
    const noValue = pickInGroup(registry, cfNode, '数值难度',
        { trust: { groupPrefer: { 数值难度: 'atcoderDifficulty' } } });
    assert.equal(noValue.field, 'cfDifficulty');
    assert.equal(noValue.pickedBy, 'order');

    // ④ 全都没有 ⇒ null
    assert.equal(pickInGroup(registry, neither, '数值难度'), null);
});

test('groupNoteHtml：显示当前口径 + 其余成员的**快捷切换**按钮 + 取消偏好', () => {
    const html = groupNoteHtml(registry, both, 'cfDifficulty');
    assert.match(html, /数值难度：<b>cf 1200<\/b>/, '显示当前选的成员（短名 + 值）');
    assert.match(html, /data-src-act="group-pick"/, '其余成员有快捷切换按钮');
    assert.match(html, /切到 atcoder 300/);
    assert.match(html, /data-field="atcoderDifficulty"/);
    assert.match(html, /data-group="数值难度"/);
    assert.doesNotMatch(html, /取消偏好/, '没设偏好时不显示"取消偏好"');

    const picked = groupNoteHtml(registry, both, 'cfDifficulty',
        { trust: { groupPrefer: { 数值难度: 'atcoderDifficulty' } } });
    assert.match(picked, /数值难度：<b>atcoder 300<\/b>/, '偏好生效');
    assert.match(picked, /（你选的）/, '标出这是用户选的');
    assert.match(picked, /data-src-act="group-clear"/, '设了偏好 ⇒ 给"取消偏好"');

    const missing = groupNoteHtml(registry, neither, 'cfDifficulty');
    assert.match(missing, /数值难度：缺（cf \/ atcoder 都没有）/);
    assert.match(missing, /#b45309/, 'expected 组缺 ⇒ 琥珀');

    assert.equal(groupNoteHtml(registry, cfNode, 'ratio'), '', '不属于任何组 ⇒ 空串');
    assert.equal(groupNoteHtml(null, cfNode, 'cfDifficulty'), '', '没有注册表 ⇒ 空串');
});

test('组偏好的值是**显示口径**：切换不动任何成员自己的值', () => {
    const node = { ...both };
    const before = JSON.stringify(node);
    pickInGroup(registry, node, '数值难度', { trust: { groupPrefer: { 数值难度: 'atcoderDifficulty' } } });
    groupNoteHtml(registry, node, 'cfDifficulty', { trust: { groupPrefer: { 数值难度: 'atcoderDifficulty' } } });
    assert.equal(JSON.stringify(node), before, '算"看哪个"不该改节点（无副作用）');
});
