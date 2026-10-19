// ================================================================
// 「依据强度」级别（src/test/natureConfidence.test.js）
//
// 口径："节点自动分类/填值规则高度依赖社区命名规范…如果要做得精，
// 我觉得应该引入『可信度级别』概念" + "『按推荐填』让用户选择接受 A/B/C/D/E 级及以上的推荐"。
//
// 这里钉住四件事：
//   ① 五档的顺序与"门槛"语义（**A 最硬**，`meetsMinLevel(level, min)` 是"够不够硬"）；
//   ② 推荐出处 → 级别，且**与 `natureSuggest` 的强度序（`suggestRank`）同调**；
//   ③ 分类的规则 id → 级别（表 + 前缀兜底）；没有 `分类依据` 那一列 ⇒ 返回空串（未知）；
//   ④ 两条纪律：级别**不用于回删**（纯函数，没写任何东西）、不认识的级别一律当最弱；
//   ⑤ 元列 `分类依据` 的**读/清**（手改分类后旧依据必须清掉，否则徽标在撒谎）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CONFIDENCE_LEVELS,
    CONFIDENCE_LABELS,
    normalizeLevel,
    levelRank,
    meetsMinLevel,
    levelLabel,
    SUGGEST_LEVEL,
    levelOfSuggestFrom,
    CLASS_RULE_LEVEL,
    levelOfClassRule,
    classLevelOf,
    CLASS_RULE_COL,
    classRulesOf,
    classRuleOf,
    clearClassRule,
    setClassRule,
    RULE_LEVELS,
    MANUAL_LEVEL,
    MANUAL_RULE
} from '../core/natureConfidence.js';
import { SUGGEST_FROM, suggestRank } from '../core/natureSuggest.js';

test('六档顺序 = M(人工，最硬) / A(最硬) … E(最弱)；文案齐全', () => {
    assert.deepEqual([...CONFIDENCE_LEVELS], ['M', 'A', 'B', 'C', 'D', 'E']);
    // ★ "手改的 nature 可以标为 M" —— M 是**人的结论**，比任何规则都硬；
    //   而"规则级别"是另一份名单（界面上的门槛/筛选只列它）。
    assert.deepEqual([...RULE_LEVELS], ['A', 'B', 'C', 'D', 'E'], '规则级别只有 A…E');
    assert.equal(MANUAL_LEVEL, 'M');
    assert.equal(MANUAL_RULE, 'manual:set', '元列 `分类依据` 里代表"人定的"那个 id');
    for (const lv of CONFIDENCE_LEVELS) {
        assert.ok(CONFIDENCE_LABELS[lv], `${lv} 要有文案`);
        assert.equal(levelLabel(lv), CONFIDENCE_LABELS[lv]);
    }
    assert.deepEqual(CONFIDENCE_LEVELS.map(levelRank), [0, 1, 2, 3, 4, 5], '顺序即强度序');
    assert.ok(levelRank('M') < levelRank('A'), '★ M 比 A 还硬（"≤ X"那套筛选取不到它）');
    assert.equal(levelOfClassRule(MANUAL_RULE), 'M', '★ `manual:set` 必须查表命中（兜底会判成 E）');
    for (const lv of RULE_LEVELS) {
        assert.equal(CONFIDENCE_LEVELS.includes(lv), true, `规则级别 ${lv} 要在总表里`);
    }
});

test('不认识 / 空值一律当最弱（E），不会被误当成"硬"', () => {
    assert.equal(normalizeLevel('a'), 'A', '大小写不敏感');
    for (const bad of ['', null, undefined, 'F', '权威', 0]) {
        assert.equal(normalizeLevel(bad), 'E', `${bad} → E`);
        assert.equal(levelRank(bad) > levelRank('E'), true, `${bad} 的强度序在 E 之后（排最后）`);
    }
    assert.equal(levelLabel('F'), 'F', '不认识的级别文案给原样（不编一个）');
});

test('`meetsMinLevel`：门槛 A 只收 A；门槛 E 全收（"X 级及以上"）', () => {
    assert.equal(meetsMinLevel('A', 'A'), true);
    assert.equal(meetsMinLevel('B', 'A'), false, '★ A 是最硬的门槛：B 不够');
    assert.equal(meetsMinLevel('A', 'C'), true, '★ 门槛 C 收 A/B/C');
    assert.equal(meetsMinLevel('D', 'C'), false);
    for (const lv of CONFIDENCE_LEVELS) {
        assert.equal(meetsMinLevel(lv, 'E'), true, `门槛 E 收全部（含 ${lv}）`);
    }
});

test('★ 推荐出处 → 级别，且与 `natureSuggest.suggestRank` 的强度序**同调**', () => {
    // 级别表里的每个出处都要是 `SUGGEST_FROM` 里真有的（防跨文件漂）
    const known = new Set(Object.values(SUGGEST_FROM));
    for (const from of Object.keys(SUGGEST_LEVEL)) {
        assert.equal(known.has(from), true, `级别表里有陌生的出处 ${from}`);
    }
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.TIME), 'A', '开赛时间 = 官方数据 ⇒ A');
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.SIBLING), 'B');
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.KEY), 'B');
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.CONTAINER), 'C');
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.NAME), 'C');
    assert.equal(levelOfSuggestFrom(SUGGEST_FROM.SEASON), 'D', '从赛季反推最弱');
    assert.equal(levelOfSuggestFrom('不存在的出处'), 'E');
    // 同调：强度序更强的，级别不会更弱（两者是同一份事实的两种说法）
    const byRank = [...Object.values(SUGGEST_FROM)]
        .sort((a, b) => suggestRank(a) - suggestRank(b));
    const ranks = byRank.map(f => levelRank(levelOfSuggestFrom(f)));
    for (let i = 1; i < ranks.length; i += 1) {
        assert.ok(ranks[i] >= ranks[i - 1],
            `强度序第 ${i} 个（${byRank[i]}）的级别不该比前一个更硬：${ranks}`);
    }
});

test('分类的规则 id → 级别：先查表，再按前缀兜底', () => {
    assert.equal(levelOfClassRule('cf-contest:filterTypes'), 'A');
    assert.equal(levelOfClassRule('qoj:path-icpc'), 'A');
    assert.equal(levelOfClassRule('xcpc:series'), 'B');
    assert.equal(levelOfClassRule('gym:name-provincial'), 'C');
    assert.equal(levelOfClassRule('qoj:ucup-title'), 'C');
    assert.equal(levelOfClassRule('gym:infer-region'), 'D');
    assert.equal(levelOfClassRule('xcpc:shallow'), 'E');
    // ★ 这几条：都是"没命中任何判据"那一类 ⇒ E
    assert.equal(levelOfClassRule('xcpc:unclassified'), 'E', '阶段判不出 ⇒ 无依据');
    assert.equal(levelOfClassRule('qoj:shallow'), 'E', '路径说是 ICPC 但赛区读不出 ⇒ 停在浅处');
    assert.equal(levelOfClassRule('gym:shallow'), 'E', 'gym 的赛区读不出 ⇒ 停在浅处');
    // 兜底（表里没登记的同族规则）
    assert.equal(levelOfClassRule('qoj:path-something-new'), 'A');
    assert.equal(levelOfClassRule('atcoder:series'), 'A');
    assert.equal(levelOfClassRule('hdu:series'), 'A');
    assert.equal(levelOfClassRule('qoj:name-whatever'), 'C');
    assert.equal(levelOfClassRule('gym:infer-other'), 'D');
    assert.equal(levelOfClassRule(''), '', '空 id ⇒ 认不出（不是 E）');
    // ★ **认不出**（表/值级表/前缀三条路都没命中）⇒ **空串**，不是 `E`：
    //   `E` 是"规则本身说：什么都没命中"（`xcpc:shallow` 那种，登记在表里）；
    //   拼错的 id 画出一个看起来合理的"E 无依据"徽标，正是把事故盖住的那种静默
    //   （也是 `crossLangTables.test.js` 那条对拍以前恒真的根因）。
    assert.equal(levelOfClassRule('完全陌生的写法'), '', '认不出的 id ⇒ 空串');
    // 表里登记的每一条都要能查出来（别自己都兜不住）
    for (const [id, lv] of Object.entries(CLASS_RULE_LEVEL)) {
        assert.equal(levelOfClassRule(id), lv, `${id} 查表应得 ${lv}`);
    }
});

test('`classLevelOf`：读元信息列 `分类依据`；**没有那一列 ⇒ 空串（未知）**', () => {
    assert.equal(classLevelOf({ '分类依据': { natureClass: 'qoj:path-icpc' } }), 'A');
    assert.equal(classLevelOf({ '分类依据': { natureClass: 'gym:name-provincial' } }), 'C');
    // 现有数据还没有这一列 ⇒ 一律"未知"（界面不画徽标、也不影响判断）
    assert.equal(classLevelOf({ natureClass: 'cf/contest/div2' }), '');
    assert.equal(classLevelOf({ '分类依据': {} }), '');
    assert.equal(classLevelOf({ '分类依据': 'qoj:path-icpc' }), '', '形状不对时不瞎猜');
    assert.equal(classLevelOf(null), '');
});

test('`分类依据` 的读/清：形状只有一种，手改后必须清掉', () => {
    // 读：认得 `{ 字段: 规则id }`；空值/错形状一律当"没有"
    assert.deepEqual(classRulesOf({ '分类依据': { natureClass: 'qoj:path-icpc' } }),
        { natureClass: 'qoj:path-icpc' });
    assert.deepEqual(classRulesOf({ '分类依据': { natureClass: '  ', natureYear: 'x:y' } }),
        { natureYear: 'x:y' }, '空规则丢掉（不写空壳）');
    for (const bad of [{}, null, { '分类依据': [] }, { '分类依据': 'qoj:path-icpc' }, { '分类依据': 3 }]) {
        assert.deepEqual(classRulesOf(bad), {}, `形状不对 ⇒ {}：${JSON.stringify(bad)}`);
    }
    assert.equal(classRuleOf({ '分类依据': { natureClass: 'qoj:path-icpc' } }), 'qoj:path-icpc');
    assert.equal(classRuleOf({ '分类依据': { natureClass: 'qoj:path-icpc' } }, 'natureYear'), '');
    assert.equal(CLASS_RULE_COL, '分类依据', '列名与 crate 侧（scripts/crate.py）必须是同一个');

    // 清：只清那一个字段；清空 ⇒ 整个键删掉（不写空壳，与 crate 侧同一姿态）
    const two = { '分类依据': { natureClass: 'qoj:path-icpc', natureYear: 'x:y' } };
    assert.equal(clearClassRule(two), true);
    assert.deepEqual(two, { '分类依据': { natureYear: 'x:y' } }, '只清 natureClass');
    assert.equal(clearClassRule(two, 'natureYear'), true);
    assert.deepEqual(two, {}, '清空了 ⇒ 键也没了');
    assert.equal(clearClassRule(two), false, '没得清 ⇒ false（调用方据此不写脏事务）');
    assert.equal(clearClassRule(null), false);
    assert.equal(clearClassRule({}), false);

    // 写：`setClassRule` 是"键的形状"的另一半（手改时补 `manual:set`）
    const one = {};
    assert.equal(setClassRule(one, 'natureClass', MANUAL_RULE), true);
    assert.deepEqual(one, { '分类依据': { natureClass: 'manual:set' } });
    assert.equal(classLevelOf(one), 'M', '★ 写完之后徽标级别就是 M');
    assert.equal(setClassRule(one, 'natureClass', MANUAL_RULE), false, '没变 ⇒ false');
    assert.equal(setClassRule(one, 'natureYear', 'xcpc:series'), true, '可以给别的字段也写一条');
    assert.deepEqual(one['分类依据'], { natureClass: 'manual:set', natureYear: 'xcpc:series' });
    assert.equal(setClassRule(one, 'natureClass', ''), true, '空规则 = 清掉那一条（不是写个空串）');
    assert.deepEqual(one['分类依据'], { natureYear: 'xcpc:series' });
    assert.equal(setClassRule(null, 'natureClass', MANUAL_RULE), false);
});
