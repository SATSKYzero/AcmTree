// ================================================================
// 逐字段「依据级别」的单测（src/test/fieldLevel.test.js）
//
// 字段来源的可信优先级设定覆盖**所有字段**。
// 这里钉住泛化后的口径：人工 ⇒ M、权威榜单 ⇒ A、脚本 ⇒ B、派生 ⇒ C、旧回填 ⇒ D、
// nature 字段有规则 id 时**以规则为准**、认不出来源时**不瞎猜**（`''`）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    KIND_LEVEL, BACKFILL_LEVEL, LEVEL_REASON,
    levelOfSourceKind, levelReason, fieldLevelOf, fieldLevelNote
} from '../core/fieldLevel.js';
import { SOURCE_KINDS, KIND_RANK } from '../core/trust.js';
import { BACKFILL_SRC } from '../core/fieldValue.js';
import { CLASS_RULE_COL } from '../core/natureConfidence.js';

/** 一份最小 state：来源注册表里四个类别各一个 */
const state = {
    sources: {
        manual: { kind: SOURCE_KINDS.MANUAL },
        'xcpcio-bjcpc2024': { kind: SOURCE_KINDS.BOARD },
        qoj: { kind: SOURCE_KINDS.SCRIPT },
        synth: { kind: SOURCE_KINDS.DERIVED }
    }
};

test('来源类别 → 级别：四个类别各一档，且**每个类别都有**（新增类别必须补表）', () => {
    assert.equal(levelOfSourceKind(SOURCE_KINDS.MANUAL), 'M');
    assert.equal(levelOfSourceKind(SOURCE_KINDS.BOARD), 'A');
    assert.equal(levelOfSourceKind(SOURCE_KINDS.SCRIPT), 'B');
    assert.equal(levelOfSourceKind(SOURCE_KINDS.DERIVED), 'C');
    for (const kind of Object.keys(KIND_RANK)) {
        assert.ok(KIND_LEVEL[kind], `类别 ${kind} 在 KIND_RANK 里有、KIND_LEVEL 里也得有`);
    }
    assert.equal(levelOfSourceKind('不存在的类别'), '', '认不出来源 ⇒ 空（不瞎猜）');
});

test('逐字段取级别：人工 M / 权威 A / 脚本 B / 派生 C / 旧回填 D', () => {
    const node = { extKey: 'cf:c:1:p:A' };
    assert.equal(fieldLevelOf(state, SOURCE_KINDS.MANUAL, 'ratio', node).level, 'M');
    assert.equal(fieldLevelOf(state, 'xcpcio-bjcpc2024', 'ratio', node).level, 'A');
    assert.equal(fieldLevelOf(state, 'qoj', 'ratio', node).level, 'B');
    assert.equal(fieldLevelOf(state, 'synth', 'ratio', node).level, 'C');
    assert.equal(fieldLevelOf(state, BACKFILL_SRC, 'ratio', node).level, BACKFILL_LEVEL);
    assert.equal(fieldLevelOf(state, '从来没见过的来源', 'ratio', node).level, '', '没有来源信息 ⇒ 空');
});

test('nature 字段有规则 id 时**以规则为准**（比来源类别更精确）', () => {
    // `cf-contest:filterTypes` 在规则表里是 A；这里故意把来源说成脚本（B）
    const node = { extKey: 'cf:c:1', [CLASS_RULE_COL]: { natureClass: 'cf-contest:filterTypes' } };
    const got = fieldLevelOf(state, 'qoj', 'natureClass', node);
    assert.equal(got.rule, 'cf-contest:filterTypes');
    assert.equal(got.level, 'A', '按规则走，而不是按"脚本 ⇒ B"');
    assert.match(got.why, /cf-contest:filterTypes/, '理由里要写明是哪条规则');

    // 其它字段没有规则 ⇒ 按来源类别（同一个节点、同一个来源）
    assert.equal(fieldLevelOf(state, 'qoj', 'ratio', node).level, 'B');
});

test('理由与说明：人话、未知级别不编话', () => {
    assert.equal(levelReason('M'), LEVEL_REASON.M);
    assert.equal(levelReason('B'), '脚本从原始数据抓的');
    assert.equal(levelReason('X'), '');
    assert.equal(fieldLevelNote('A'), '依据级别 A：权威榜单 / 官方来源');
    assert.equal(fieldLevelNote(''), '', '未知级别 ⇒ 不给说明（界面就不画徽标）');
    assert.equal(fieldLevelOf(null, 'qoj', 'ratio', null).level, '', '没有 state 也不炸');
});
