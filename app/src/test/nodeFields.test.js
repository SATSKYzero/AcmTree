// ================================================================
// 「完整字段表」测试（ui/nodeinfo/nodeFields.js）
//
// 它要证明的只有一件事：**投影会丢的东西，这里都在**。
// 所以断言全都盯着"被丢掉的那些" —— 被标不用的值、非权威来源、没来源的字段也要有行。
//
// 纯模块（无 DOM、无 AppState）：只吃一个 node 与一个 state 影子对象。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderNodeFieldsHtml, fieldsOf } from '../ui/nodeinfo/nodeFields.js';
import { addSourceValue } from '../core/fieldValue.js';
// 「组那份」列（派生读，值来自 `viewDerived(..., { column:'group' })`）
import { viewDerived } from '../view/scope.js';
import { hasGroupValue, clearGroupMemo } from '../core/groupCompute.js';
import { clearDerivedMemo } from '../core/derive.js';
import { SYNTH_PREFIX } from '../core/ops/synth.js';

const trust = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        'xcpcio:x': { kind: 'board', rank: 30 },
        'rankland:x': { kind: 'script', rank: 20 },
        manual: { kind: 'manual', rank: 100 }
    },
    fieldPrefer: {}
};

/** state 影子：字段表只用 trust / accounts / viewingAccountId 三项 */
const state = { trust, accounts: {}, viewingAccountId: '' };

function pnode() {
    const n = { id: 'p1', type: 'P', name: 'All Closed', values: {}, extKey: 'xcpc:p:p1' };
    addSourceValue(n, 'ratio', '10.85', 'xcpcio:x', { at: 'T1' });
    addSourceValue(n, 'ratio', '12.00', 'rankland:x', { at: 'T2' });
    addSourceValue(n, 'ratio', '9.90', 'manual', { at: 'T3' });
    // "标不用"就是来源层记的一条 invalid（投影会把它丢掉 —— 正是本表要摊开的东西）
    n.values.ratio.find(x => x.src === 'rankland:x').invalid = true;
    return n;
}

test('fieldsOf：元素表字段 + values 里出现过的字段，且不重复', () => {
    const n = pnode();
    const fields = fieldsOf(n);
    assert.ok(fields.includes('ratio'), '类型自带字段在内');
    assert.ok(fields.includes('problemId'), '没有来源值的字段也要有行（默认值）');
    assert.equal(new Set(fields).size, fields.length, '不重复');
});

test('fieldsOf：插件自有字段（不在元素表里）也算字段', () => {
    const n = pnode();
    n.values.ownerSynth = [{ v: 'x', src: 'manual', at: 'T' }];
    assert.ok(fieldsOf(n).includes('ownerSynth'));
});

test('完整字段表：每个来源原值都在，含被标"不用"的那个', () => {
    const html = renderNodeFieldsHtml(pnode(), state);
    assert.match(html, /完整字段表/);
    assert.match(html, /ratio/);
    assert.match(html, /10\.85/);
    assert.match(html, /12\.00/, '被标不用的值仍然列出来（投影会丢掉它）');
    assert.match(html, /9\.90/, '手改值也在');
    assert.match(html, /xcpcio:x/);
    assert.match(html, /rankland:x/);
    assert.match(html, /⛔/, '标不用的那个有记号');
});

// ★ 「客观手改」（= 所有人共用）在**这张表**里也要看得出来（用户 2026-10-13 实测漏掉的那处）。
//   判据与值级面板同一套（`manual` ∧ 没有账户），标记落在**值那一格**（`nif-val`）。
//   **去掉哪一行会红**：`ui/nodeinfo/nodeFields.js` 里 `+ sharedTag` 那一行去掉 ⇒ 第 1 条断言
//   要的 `/nif-val[^>]*>9\.90<span/` 匹配不到（值那一格直接以 `</div>` 收尾）。
test('★ 完整字段表：被采用的「客观手改」在值那一格带 🌐；非手改的客观值不带', () => {
    const html = renderNodeFieldsHtml(pnode(), state);
    // `pnode()` 的 `9.90` 是 manual 且不带账户（被采用）⇒ 带标记，title 与值级面板同一份
    assert.match(html, /class="nif-val"[^>]*>9\.90<span title="所有人共用（客观值）"/, '客观手改的值带 🌐');
    // 对照：同一格里的两个榜单/脚本客观值（10.85 / 12.00）**不带** —— 它们本来就不属于谁
    assert.doesNotMatch(html, /class="nif-val"[^>]*>(10\.85|12\.00)<span/);
});

test('★ 完整字段表：**账户私有**手改不带 🌐（那是"只有我能看见"，不是"所有人共用"）', () => {
    const n = pnode();
    n.values.ratio = [{ v: '9.90', src: 'manual', at: 'T3', account: 'k1' }];
    const st = { ...state, accounts: { k1: { id: 'k1', name: '主号' } }, viewingAccountId: 'k1' };
    const html = renderNodeFieldsHtml(n, st);
    assert.match(html, /class="nif-val"[^>]*>9\.90<\/div>/, '值那一格直接收尾（没有标记）');
    assert.doesNotMatch(html, /所有人共用（客观值）/, '连 title 都不该出现');
});

test('完整字段表：没有来源值的字段也出一行，不静默省略', () => {
    const html = renderNodeFieldsHtml(pnode(), state);
    assert.match(html, /problemId/);
    assert.match(html, /来源：默认值|来源：自动计算/);
});

test('完整字段表：元素表里的结构字段也在（extKey / createdAt 这类也算完整的一部分）', () => {
    const html = renderNodeFieldsHtml(pnode(), state);
    assert.match(html, /extKey/);
    assert.match(html, /createdAt/);
});

// ★ （"O-qoj 的 extKey 为 qoj，但字段表显示 extKey 为空"）：
//   结构字段**没有来源层**，它的值就是节点上那一格 ⇒ 必须照实显示。
//   一律读"来源层投影"（`explainField().value`）的话 ⇒ 所有结构字段永远显示空。
test('★ 完整字段表：结构字段显示**节点自己的值**（extKey= qoj，不是空）', () => {
    const w = { id: 'w1', type: 'W', name: 'QOJ', values: {}, extKey: 'qoj',
                createdAt: '2026-10-03T00:00:00.000Z', '分类依据': { natureClass: 'qoj:path-icpc' } };
    const html = renderNodeFieldsHtml(w, state);
    assert.match(html, />qoj</, 'extKey 的值要出现在表里');
    assert.match(html, /2026-10-03T00:00:00\.000Z/, 'createdAt 的值也在');
    assert.doesNotMatch(html, /nif-val[^>]*>—<\/div>\s*<div class="nif-src"[^>]*>[^<]*<\/div>\s*<\/div>\s*<div class="nif-row"[^>]*>\s*<div class="nif-key"[^>]*>extKey/,
        'extKey 那一行不能是「—」');
});

test('★ 结构字段照实显示**不影响业务字段**：业务字段仍只看来源层投影（读不到就是空）', () => {
    // 节点上缓存着一格 `ratio`，但来源层里没有 ⇒ 表里**不该**显示这个缓存值
    // （"没有老数据"那条：不许把节点缓存当成来源 —— 见 `core/fieldValue.js`）
    const n = pnode();
    delete n.values.ratio;
    n.ratio = '99.99';
    const html = renderNodeFieldsHtml(n, state);
    assert.doesNotMatch(html, /99\.99/, '业务字段不许退回节点缓存值');
    assert.match(html, /extKey[\s\S]{0,600}xcpc:p:p1/, '结构字段照旧显示自己的值');
});

test('fieldsOf：`values` 是来源层容器，不当字段（否则会打出一行 [object Object]）', () => {
    const n = pnode();
    assert.ok(!fieldsOf(n).includes('values'));
});

// ================================================================
// 「组那份」列（只进完整字段表 —— 口径已定）
//
// 口径：
//   · **没有合成节点 ⇒ 一行都不出**（没用到合成功能时这张表一行不多）；
//   · 有合成节点 ⇒ 紧跟同名「自己那份」后面，只给 `GROUP_FIELDS`（status1 / status2）；
//   · 只读：不发来源动作按钮、不写库、不进历史。
// ================================================================

/** 一条**手改覆盖**（`status1` / `status2` 的值是"用户按下的"，只有来源层里有） */
const manual = (v, account, at) => ({ v, src: 'manual', at, account });

/**
 * 一棵**有合成节点**的树：`synP`（合成）＋ `p1` / `p2`（成员，指针指过去）。
 * 值走来源层 —— 派生表只认投影。
 */
function synthState() {
    const st = {
        rootId: 'o',
        nodes: {
            o: { id: 'o', type: 'O' },
            synP: { id: 'synP', type: 'P', synthKey: SYNTH_PREFIX + 'gp', name: '合成题', values: {} },
            p1: { id: 'p1', type: 'P', ownerSynth: SYNTH_PREFIX + 'gp', name: '题1', values: {} },
            p2: { id: 'p2', type: 'P', ownerSynth: SYNTH_PREFIX + 'gp', name: '题2', values: {} }
        },
        childOrder: { o: ['synP', 'p1', 'p2'], synP: [], p1: [], p2: [] },
        parentOf: { o: null, synP: 'o', p1: 'o', p2: 'o' },
        accounts: { k1: { id: 'k1', name: '主号' } },
        sources: { manual: { kind: 'manual', rank: 100 } },
        trust,
        viewingAccountId: 'k1'
    };
    // `p1` 按下了「已处理」；`p2` 没按 ⇒ 组那份（取或）与"自己那份"不同，正好用来对照
    st.nodes.p1.values = { status1: [manual('1', 'k1', 'T1')] };
    st.nodes.p2.values = { status1: [manual('0', 'k1', 'T1')] };
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

/** 同一棵树，但**没有任何合成节点 / 指针**（回归锚：视图不变） */
function plainState() {
    const st = synthState();
    delete st.nodes.synP.synthKey;
    delete st.nodes.p1.ownerSynth;
    delete st.nodes.p2.ownerSynth;
    clearDerivedMemo();
    clearGroupMemo();
    return st;
}

/** 取出所有「组那份」行的 HTML 片段（到下一条 `nif-row` 为止） */
function groupRowTexts(html) {
    const marks = [];
    let i = html.indexOf('nif-row-group');
    while (i !== -1) {
        marks.push(i);
        i = html.indexOf('nif-row-group', i + 1);
    }
    return marks.map(m => {
        const nextRow = html.indexOf('class="nif-row', m + 1);
        return html.slice(m, nextRow === -1 ? html.length : nextRow);
    });
}

test('完整字段表：有合成节点时，聚合字段出「组那份」行（值与 viewDerived 一致）', () => {
    const st = synthState();
    const html = renderNodeFieldsHtml(st.nodes.p2, st);
    const fields = ['status1', 'status2'].filter(f => hasGroupValue(st, st.nodes.p2, f, {}));
    assert.ok(fields.includes('status1'), 'status1 一定有组那份（p1 按了、synP 没按 ⇒ 取或为 1）');
    const rows = groupRowTexts(html);
    assert.equal(rows.length, fields.length, '只给 GROUP_FIELDS 里"有组值"的字段加行');
    for (const f of fields) {
        const gv = viewDerived(st, st.nodes.p2, f, { column: 'group' });
        assert.ok(rows.some(r => r.includes(`组那份 · ${f}`)), `${f} 的「组那份」行在`);
        assert.ok(rows.some(r => r.includes(`>${String(gv)}<`)), `${f} 的值就是 viewDerived 给的那份`);
    }
    // 对照：p2 自己那份是 0，组那份是 1 —— 两行不相同，说明真的读了两列
    assert.equal(viewDerived(st, st.nodes.p2, 'status1'), 0, '自己那份：p2 没按');
    assert.equal(viewDerived(st, st.nodes.p2, 'status1', { column: 'group' }), 1, '组那份：p1 按了');
    assert.match(html, /另含 1 行「组那份」|另含 2 行「组那份」/, '表头如实说明多了几行');
});

test('完整字段表：没有合成节点时**不出**「组那份」行（不多出任何行）', () => {
    const st = plainState();
    const html = renderNodeFieldsHtml(st.nodes.p2, st);
    assert.equal(groupRowTexts(html).length, 0);
    assert.doesNotMatch(html, /组那份/);
    assert.doesNotMatch(html, /nif-row-group/);
});

test('「组那份」行是**只读**的：不发来源动作按钮，且渲染后节点/来源层一个字节没动', () => {
    const st = synthState();
    const before = JSON.stringify(st.nodes);
    const html = renderNodeFieldsHtml(st.nodes.p2, st);
    const rows = groupRowTexts(html);
    assert.ok(rows.length > 0, '先确认这次渲染真的画了组那份行');
    for (const r of rows) {
        assert.ok(!r.includes('data-src-act'), '组那份没有"设为首选/标不用/真删"这类写操作按钮');
    }
    assert.equal(JSON.stringify(st.nodes), before, '渲染不改任何节点（不写库、不进历史）');
});

test('「组那份」行不通往来源层：它不在 fieldsOf 里（不是新字段，只是同一字段的第二列）', () => {
    const st = synthState();
    const fields = fieldsOf(st.nodes.p2);
    assert.equal(fields.filter(f => f.includes('组那份')).length, 0);
    assert.deepEqual(fields, fieldsOf(st.nodes.p2), '字段清单本身不因合成而变');
});
