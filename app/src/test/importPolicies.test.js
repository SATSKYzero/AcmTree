// ================================================================
// 导入策略回归（`features/AutoImport`）
//
// 钉住一件事：**包里的字段必须真的能落进节点**。
//
// 背景（实测踩到）：`merge.js` 对"不在策略表里的字段"一律回落 `never`。
// `language` / `timeUsed` / `memoryUsed` / `codeLength`（R）与 `kind`（C）、
// `identityKey`（P）**漏在表外** → 适配器抓来的值只写进来源层，
// 节点缓存字段永远是空，界面上完全看不到（数据在包里、却导不进去）。
//
// 本测试用**真实 computeMerge** 直接断言"写进去了"，以后再漏一个字段就会红。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeMerge } from '../features/AutoImport/merge.js';
import { CREATE_POLICY_DEFAULTS, EXISTING_POLICY_DEFAULTS, EXISTING_NEVER }
    from '../features/AutoImport/constants.js';
import { ELEMENTS } from '../core/model/elements.js';

// 必须"能落节点"的字段（行为用例仍按名单写：它们是**具体的场景**）
const MUST_LAND = {
    R: ['language', 'timeUsed', 'memoryUsed', 'codeLength', 'submitKind'],
    C: ['kind'],
    P: ['identityKey'],
    // 「性质」四字段是**跨类型**的（`types: '*'`），所以对每个类型都要求能落节点 ——
    // 漏登记策略表的后果见本文件顶部（值进来源层、节点永远空）
    '*': ['natureClass', 'natureYear', 'natureSeason', 'natureRegion']
};

// ★ 覆盖性守卫按 `elements.js` 派生：
//   单靠一份**手写名单**（`MUST_LAND`）—— 名单漏了哪个字段，它就查不出哪个字段：
//   实测 `atcoderDifficulty` / `clistDifficulty` 加进 `elements.js` 时没补策略表，
//   4600 多个值导不进节点，而名单式检查**全绿**（因为名单里没有它们）。
//   ⇒ **凡是 `importable: true` 的元素都必须在表里**（同一真源 = `elements.js`）。
test('策略表覆盖**所有** importable 字段（派生，不用手写名单）', () => {
    const importable = Object.values(ELEMENTS).length
        ? Object.entries(ELEMENTS).filter(([, d]) => d && d.importable === true).map(([k]) => k)
        : [];
    assert.ok(importable.length > 10, `importable 字段数看起来不对：${importable.length}`);
    for (const f of importable) {
        assert.ok(f in CREATE_POLICY_DEFAULTS,
            `${f} 是 importable 却不在 CREATE_POLICY_DEFAULTS 里（新建节点时被静默丢弃）`);
        // 「已存在」允许**显式** never（tags/synthKey/time/status —— 理由写在 constants.js 的
        // EXISTING_NEVER 上）；但不允许"根本没列到"（那也会回落 never，且没人知道为什么）
        const listed = f in EXISTING_POLICY_DEFAULTS;
        const explicitNever = EXISTING_NEVER.includes(f);
        assert.ok(listed || explicitNever,
            `${f} 既不在 EXISTING_POLICY_DEFAULTS 里、也不在 EXISTING_NEVER 里（静默回落 never）`);
    }
    // 难度字段漏网过 ⇒ 单独钉一次（回归就红）
    for (const f of ['cfDifficulty', 'atcoderDifficulty', 'clistDifficulty']) {
        assert.equal(CREATE_POLICY_DEFAULTS[f], 'overwrite-if-changed', `${f} 新建时要能写`);
        assert.equal(EXISTING_POLICY_DEFAULTS[f], 'fill-if-empty', `${f} 已存在时只补空`);
    }
});

test('★ 难度三员：包里带的值真的写得进节点（E1 的行为证据）', () => {
    for (const field of ['atcoderDifficulty', 'clistDifficulty']) {
        const imp = {};
        imp[field] = 1234;
        const created = computeMerge({ type: 'P', incoming: imp, existing: null }).fields;
        assert.equal(created[field], 1234, `${field} 新建节点时要写进节点`);
        const filled = computeMerge({ type: 'P', incoming: imp, existing: { [field]: '' } }).fields;
        assert.equal(filled[field], 1234, `${field} 已存在但空时要补上`);
        const kept = computeMerge({ type: 'P', incoming: imp, existing: { [field]: 999 } });
        // `fields` 里**出现** = 要写；不出现 = 本次不动（fill-if-empty 的语义）
        assert.ok(!(field in kept.fields), `${field} 已有值不动（本次不写）`);
        assert.equal(kept.fields[field], undefined, `${field} 不动就一个字都不写`);
    }
});

test('R 的四个运行字段：新建时就写进节点', () => {
    const incoming = {
        status: 'AC', time: '2026.08.03 12:21',
        language: 'G++', timeUsed: '859', memoryUsed: '3063808', codeLength: '1921'
    };
    const { fields } = computeMerge({ type: 'R', incoming, existing: null });
    for (const f of MUST_LAND.R) {
        assert.equal(fields[f], incoming[f], `${f} 应该写进节点`);
    }
});

test('R 的四个运行字段：已有节点为空时补上，你手填过的绝不动', () => {
    const incoming = { language: 'G++', timeUsed: '859', memoryUsed: '1', codeLength: '2' };

    const empty = computeMerge({
        type: 'R', incoming,
        existing: { language: '', timeUsed: null, memoryUsed: undefined, codeLength: '' }
    });
    assert.equal(empty.fields.language, 'G++', '空着 → 补');
    assert.equal(empty.fields.timeUsed, '859', 'null → 补');

    const manual = computeMerge({ type: 'R', incoming, existing: { language: '我手填的' } });
    assert.equal('language' in manual.fields, false, '手填值必须保住（策略是 fill-if-empty）');
    assert.equal(manual.fields.timeUsed, '859', '别的空字段照补');
});

test('C 的 kind 与 P 的 identityKey 也能落节点', () => {
    const c = computeMerge({
        type: 'C',
        incoming: { name: 'X', kind: 'practice' },
        existing: null
    });
    assert.equal(c.fields.kind, 'practice');
    const p = computeMerge({ type: 'P', incoming: { name: 'A', identityKey: 'cf:gym:1:A' }, existing: null });
    assert.equal(p.fields.identityKey, 'cf:gym:1:A');
});

test('C 的链接：已有值（你贴过的）不被覆盖', () => {
    // `boardLink` 不在表里，所有链接都进 `link` —— 这条断言钉 `link` 的
    // `fill-if-empty`（原意一字不变：手贴过的一律不动）。
    const { fields } = computeMerge({
        type: 'C',
        incoming: { link: 'https://board.xcpcio.com/ccpc/8th/final' },
        existing: { link: 'https://我自己的榜单' }
    });
    assert.equal('link' in fields, false, '策略是 fill-if-empty ⇒ 已有值不动');
});

test('tags 仍然不写（它是手工整理的知识点，策略刻意是 never）', () => {
    const { fields } = computeMerge({
        type: 'P', incoming: { tags: ['dp'], ratio: '10.00' }, existing: { tags: ['我整理的'] }
    });
    assert.equal('tags' in fields, false, 'tags 不在策略表内 ⇒ never，不能被导入覆盖');
    assert.equal(fields.ratio, '10.00', 'ratio 照写');
});

test('「性质」三字段：新建时写进节点，已有值（手填的）绝不被包覆盖', () => {
    const incoming = {
        natureClass: 'xcpc/icpc', natureYear: '2025', natureRegion: '成都'
    };
    for (const type of ['W', 'S', 'C', 'P', 'R']) {
        const created = computeMerge({ type, incoming, existing: null });
        for (const f of MUST_LAND['*']) {
            assert.equal(created.fields[f], incoming[f], `${type} 新建时 ${f} 应该写进节点`);
        }
    }
    // 策略是 fill-if-empty ⇒ 手翻过的归类一律不动（nature 是**人工整理**的信息）
    const kept = computeMerge({
        type: 'C', incoming,
        existing: { natureClass: 'xcpc', natureYear: '' }
    });
    assert.equal('natureClass' in kept.fields, false, '已有的分类不动');
    assert.equal(kept.fields.natureYear, '2025', '空着的年份照补');
});
