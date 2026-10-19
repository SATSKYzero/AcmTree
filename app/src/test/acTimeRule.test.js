// ================================================================
// 题目 AC 时间"怎么挑"（src/test/acTimeRule.test.js）
//
// 用户 2026-10-13：同一道题被多次训练（间隔很久）时，"取最早"只让**第一次**进训练追踪。
// 设计稿 `docs/ac-time-rule.md`；规则唯一一份在 `core/acTimeRule.js`。
//
// 这个文件钉三件事：
//   ① `pickAcTime` / 键与截断值的归一化（**纯函数**，边界全在这儿）；
//   ② 三种规则的语义（`earliest` = 老行为；`latest`；`cutoff` = 截断后最早、没有就取最晚）；
//   ③ **三家必须同义**：`derivePacTime` / `derivePtriple` / `computePacTime`
//      （以前它们各写一遍"排序取 [0]"，改规则就会漏一家）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    pickAcTime, acTimeKey, normalizeAcTimeCutoff, acTimeRuleOf,
    isSubmissionIgnored,
    AC_TIME_RULES, DEFAULT_AC_TIME_RULE
} from '../core/acTimeRule.js';
import { derivePacTime, derivePtriple } from '../core/derive.js';
import { computePacTime } from '../core/autoComputeRules.js';

const PH = '----.--.-- --:--';
const T = (d, hm = '10:00:00') => `${d} ${hm}`;

// ---- ① 归一化 ----
test('acTimeKey：时间 → 14 位数字比较键（缺的补 0；占位符/空 ⇒ 空串）', () => {
    assert.equal(acTimeKey(T('2026.03.19', '22:32:42')), '20260319223242');
    assert.equal(acTimeKey(T('2025.01.15')), '20250115100000', '到分的补到秒');
    assert.equal(acTimeKey(PH), '', '占位符不是时间');
    assert.equal(acTimeKey(''), '');
    assert.equal(acTimeKey(undefined), '');
});

test('normalizeAcTimeCutoff：认 8 / 12 / 14 位（分隔符随便写），别的形状 ⇒ 空串', () => {
    assert.equal(normalizeAcTimeCutoff('20260101'), '20260101000000', '8 位 = 到天');
    assert.equal(normalizeAcTimeCutoff('202601011200'), '20260101120000', '12 位 = 到分');
    assert.equal(normalizeAcTimeCutoff('20260101120000'), '20260101120000', '14 位 = 到秒');
    assert.equal(normalizeAcTimeCutoff('2026-01-01'), '20260101000000', '分隔符随便写');
    assert.equal(normalizeAcTimeCutoff('2026.01.01 12:00'), '20260101120000');
    assert.equal(normalizeAcTimeCutoff('2026010112'), '', '10 位不是合法形状');
    assert.equal(normalizeAcTimeCutoff(''), '');
    assert.equal(normalizeAcTimeCutoff(undefined), '');
});

test('acTimeRuleOf：没设/设坏了 ⇒ earliest；cutoff 没给合法截断值也 ⇒ earliest', () => {
    // ⚠️ `v9.1.26` 起返回值多了 `ignoreBefore`（第 4 种规则"截断前整体不算"的那个开关）
    const R = (rule, cutoff = '', ignoreBefore = false) => ({ rule, cutoff, ignoreBefore });
    assert.deepEqual(acTimeRuleOf(undefined), R(DEFAULT_AC_TIME_RULE));
    assert.deepEqual(acTimeRuleOf({}), R('earliest'), '老存档没这个键');
    assert.deepEqual(acTimeRuleOf({ acTimeRule: '乱写的' }), R('earliest'));
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'latest' }), R('latest'));
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'cutoff', acTimeCutoff: '20260101' }),
        R('cutoff', '20260101000000'));
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' }),
        R('cutoffIgnore', '20260101000000', true), '★ 第 4 种：挑法同 cutoff，但**要忽略截断前的提交**');
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'cutoff' }), R('earliest'),
        '★ 选了 cutoff 却没填截断值 ⇒ 退回 earliest（不是"什么都挑不出来"）');
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'cutoff', acTimeCutoff: '12' }), R('earliest'));
    assert.deepEqual(acTimeRuleOf({ acTimeRule: 'cutoffIgnore' }), R('earliest'),
        '第 4 种也一样：没截断值 ⇒ 退回 earliest（**不能**变成"全忽略"）');
    assert.deepEqual([...AC_TIME_RULES], ['earliest', 'latest', 'cutoff', 'cutoffIgnore'], '名单唯一一份');
});

// ---- 第 4 种规则：**忽略截断前的提交**（`v9.1.26`，用户 2026-10-13）----
//   用户的方向："提交**不存更多字段**，只是**按条件判断**（提交是否忽略）" ⇒ `isSubmissionIgnored` 是纯函数。
test('★ isSubmissionIgnored：只有第 4 种规则才忽略；判据是"**严格早于**截断"', () => {
    const ig = (t, s) => isSubmissionIgnored(t, acTimeRuleOf(s));
    const cut = { acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' };
    assert.equal(ig('2019.01.01 10:00:00', cut), true, '早于截断 ⇒ 忽略');
    assert.equal(ig('2025.12.31 23:59:59', cut), true, '差一秒也算早');
    assert.equal(ig('2026.01.01 00:00:00', cut), false, '★ **恰好等于**截断 ⇒ **不**忽略（与入选的 `>=` 互补）');
    assert.equal(ig('2026.03.19 22:32:42', cut), false, '晚于 ⇒ 不忽略');
    // 别的规则一个字都不忽略
    for (const r of ['earliest', 'latest', 'cutoff']) {
        assert.equal(ig('2019.01.01 10:00:00', { acTimeRule: r, acTimeCutoff: '20260101' }), false,
            `${r} 不忽略任何提交（前三种只改"挑哪一条"）`);
    }
    assert.equal(ig('----.--.-- --:--', cut), false, '占位符不算时间 ⇒ 不忽略（别把"没时间"当"截断前"）');
    assert.equal(ig('', cut), false);
});

test('★ 第 4 种规则的 acTime：截断前的全不算 ⇒ 没有就是**没有**（不像规则 3 会取最晚）', () => {
    const cut = acTimeRuleOf({ acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' });
    const cut3 = acTimeRuleOf({ acTimeRule: 'cutoff', acTimeCutoff: '20260101' });
    const v = ['2019.01.01 10:00:00', '2025.06.01 10:00:00', '2026.03.19 22:32:42'];
    assert.equal(pickAcTime(v, cut), '2026.03.19 22:32:42', '截断后的那条');
    assert.equal(pickAcTime(v, cut3), '2026.03.19 22:32:42', '规则 3 同值（都取截断后最早）');
    // ⚠️ 分水岭在这儿：**全都早于截断**时，规则 3 取最晚，规则 4 直接**没有**
    const old = ['2019.01.01 10:00:00', '2025.06.01 10:00:00'];
    assert.equal(pickAcTime(old, cut3), '2025.06.01 10:00:00', '规则 3：截断后没有 ⇒ 取最晚那条');
    assert.equal(pickAcTime(old, cut), PH, '★ 规则 4：全被忽略 ⇒ 占位符（"这条题这次没做过"）');
});

// ---- ② 三种规则 ----
test('earliest / latest：就是最小 / 最大（首个等于老行为）', () => {
    const v = [T('2020.05.05'), T('2019.01.01'), T('2026.03.19')];
    assert.equal(pickAcTime(v, { rule: 'earliest', cutoff: '' }), T('2019.01.01'));
    assert.equal(pickAcTime(v, { rule: 'latest', cutoff: '' }), T('2026.03.19'));
    assert.equal(pickAcTime(v), T('2019.01.01'), '不给规则 = earliest');
});

test('cutoff：取"不早于截断"的那些里最早的一条', () => {
    const v = [T('2020.05.05'), T('2026.03.19', '22:32:42'), T('2026.01.01', '00:00:00')];
    // 截断 = 2026-01-01 00:00 ⇒ 后两条都在范围内，取最早的那条（2026.01.01）
    assert.equal(pickAcTime(v, { rule: 'cutoff', cutoff: '20260101000000' }), T('2026.01.01', '00:00:00'));
    // 截断往后挪 ⇒ 只剩 2026.03.19 那条
    assert.equal(pickAcTime(v, { rule: 'cutoff', cutoff: '20260201000000' }), T('2026.03.19', '22:32:42'));
});

test('★ cutoff：一条都不满足 ⇒ 取**全部里最晚**的那条（用户原话"截断后没有就取最晚"）', () => {
    const v = [T('2018.01.01'), T('2020.05.05'), T('2019.03.03')];
    assert.equal(pickAcTime(v, { rule: 'cutoff', cutoff: '20260101000000' }), T('2020.05.05'));
});

test('★ cutoff 是**闭区间**（恰好等于截断那条算在内）；秒级也分得开', () => {
    const v = [T('2026.01.01', '00:00:00'), T('2025.12.31', '23:59:59')];
    assert.equal(pickAcTime(v, { rule: 'cutoff', cutoff: '20260101000000' }), T('2026.01.01', '00:00:00'),
        '≥ 截断才算 ⇒ 恰好等于要进来');
    // 12 位截断（到分）：秒级的比较不能退化成"同分钟都相等"
    const w = [T('2026.01.01', '00:00:30'), T('2026.01.01', '00:01:00')];
    assert.equal(pickAcTime(w, { rule: 'cutoff', cutoff: '20260101000000' }), T('2026.01.01', '00:00:30'),
        '同一分钟靠秒分先后');
});

test('候选里混着占位符 / 空串 ⇒ 自己滤掉；一个都不剩 ⇒ 返回占位符', () => {
    assert.equal(pickAcTime([PH, '', '  ', T('2021.02.02')], { rule: 'latest', cutoff: '' }), T('2021.02.02'));
    assert.equal(pickAcTime([PH, ''], { rule: 'earliest', cutoff: '' }), PH);
    assert.equal(pickAcTime([], { rule: 'cutoff', cutoff: '20260101000000' }), PH);
    assert.equal(pickAcTime(null), PH);
});

// ---- ③ 三家同义（**这条最重要**：改规则时漏一家就会"树上一个答案、缓存另一个答案"） ----
/** 一棵 `R…(AC, time) → P` 的最小树 */
function tree(times, settings) {
    const nodes = { p: { id: 'p', type: 'P' } };
    const order = [];
    times.forEach((t, i) => {
        const id = 'r' + i;
        nodes[id] = { id, type: 'R', status: 'AC', time: t, submitKind: 'upsolve' };
        order.push(id);
    });
    return { nodes, childOrder: { p: order }, settings };
}
const readOf = (n, f) => n[f];

test('★ 三家同义：derivePacTime / derivePtriple / computePacTime 对同一棵树逐字同值', () => {
    const cases = [
        [{}, '默认（没设置）'],
        [{ acTimeRule: 'earliest' }, 'earliest'],
        [{ acTimeRule: 'latest' }, 'latest'],
        [{ acTimeRule: 'cutoff', acTimeCutoff: '20260101' }, 'cutoff'],
        [{ acTimeRule: 'cutoff', acTimeCutoff: '20300101' }, 'cutoff（谁都不满足 ⇒ 取最晚）']
    ];
    const times = [T('2019.01.01'), T('2026.03.19', '22:32:42'), T('2026.01.01', '00:00:00')];
    for (const [settings, label] of cases) {
        const state = tree(times, settings);
        const a = derivePacTime(state, state.nodes.p, readOf);
        const b = derivePtriple(state, state.nodes.p, readOf, null).acTime;
        const c = computePacTime(state, state.nodes.p);
        assert.equal(a, b, `derivePacTime 与 derivePtriple 必须同值（${label}）`);
        assert.equal(b, c, `derivePtriple 与 computePacTime（写缓存那条路）必须同值（${label}）`);
    }
    // 顺带把三种规则的答案本身钉一下（上面只保证"三家一致"，一起错也会一起一致）
    const s = rule => { const st = tree(times, rule); return derivePacTime(st, st.nodes.p, readOf); };
    assert.equal(s({ acTimeRule: 'earliest' }), T('2019.01.01'));
    assert.equal(s({ acTimeRule: 'latest' }), T('2026.03.19', '22:32:42'));
    assert.equal(s({ acTimeRule: 'cutoff', acTimeCutoff: '20260101' }), T('2026.01.01', '00:00:00'),
        '★ 这道题 2019 过过一次、2026 又过（重训）⇒ 截断后取 2026 那次（训练追踪就该看见它）');
});

test('★ 只有一次 AC 时，三种规则同值（回归锚：别把单次 AC 的题算丢）', () => {
    const only = [T('2024.07.07', '18:30:11')];
    for (const rule of AC_TIME_RULES) {
        const st = tree(only, rule === 'cutoff'
            ? { acTimeRule: rule, acTimeCutoff: '20200101' }
            : { acTimeRule: rule });
        assert.equal(derivePacTime(st, st.nodes.p, readOf), only[0], `${rule}：单次 AC 就是它自己`);
    }
});

// ★★ 第 4 种规则的**端到端**：被忽略的提交，对 status2 / acTime / lastSubmitTime **全都不算**。
//   用户原话："题目的 Ac时间/最新提交/stat2 要按条件判断（提交是否忽略）每个提交是否取"。
test('★★ cutoffIgnore：截断前的提交对 status2 / acTime / 最新提交**全都不算**', () => {
    /** 三发：2019 AC、2025 WA（两条都在截断前）、2026 WA（截断后） */
    const mixed = settings => ({
        nodes: {
            o: { id: 'o', type: 'O', values: {} },
            p: { id: 'p', type: 'P', values: {} },
            r1: { id: 'r1', type: 'R', status: 'AC', time: T('2019.01.01'), submitKind: 'upsolve' },
            r2: { id: 'r2', type: 'R', status: 'WA', time: T('2025.06.01'), submitKind: 'upsolve' },
            r3: { id: 'r3', type: 'R', status: 'WA', time: T('2026.05.01'), submitKind: 'upsolve' }
        },
        childOrder: { o: ['p'], p: ['r1', 'r2', 'r3'] },
        rootId: 'o',
        settings
    });
    const read = (n, f) => n[f];
    const tripleOf = st => derivePtriple(st, st.nodes.p, read, null);

    // ---- 对照：默认规则 ⇒ 老行为（2019 那次 AC 说了算，最新提交 = 2026.05.01）----
    const off = mixed({ acTimeRule: 'earliest' });
    const a = tripleOf(off);
    assert.equal(a.status2, 3, '有 AC ⇒ 过了');
    assert.equal(a.acTime, T('2019.01.01'));
    assert.equal(a.lastSubmitTime, T('2026.05.01'));

    // ---- 第 4 种规则：截断前的两发**整个不算** ----
    const st = mixed({ acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' });
    const b = tripleOf(st);
    assert.equal(b.status2, 2, '★ 2019 那次 AC 被忽略 ⇒ 只剩 2026 那发 WA ⇒「已提交未通过」');
    assert.equal(b.acTime, PH, '★ 没有（截断后的）AC ⇒ 占位符 —— **不是**"取截断前最晚那条"');
    assert.equal(b.lastSubmitTime, T('2026.05.01'), '最新提交只看没被忽略的那发');
    // 三条同义（写缓存那条路也必须一样）
    assert.equal(computePacTime(st, st.nodes.p), b.acTime, 'computePacTime 同值');
    assert.equal(derivePacTime(st, st.nodes.p, read), b.acTime, 'derivePacTime 同值');

    // ---- 边界：截断**之后完全没有提交** ⇒ 整题回到"未使用" ----
    const onlyOld = mixed({ acTimeRule: 'cutoffIgnore', acTimeCutoff: '20300101' });
    const c = tripleOf(onlyOld);
    assert.equal(c.status2, 0, '★ 全都早于截断 ⇒ 一发都不算 ⇒「未使用」（这就是"重新开始练"）');
    assert.equal(c.acTime, PH);
    assert.equal(c.lastSubmitTime, PH, '最新提交也空');
});
