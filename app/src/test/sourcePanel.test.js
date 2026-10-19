// ================================================================
// 值级来源面板测试（ui/G_modal/sourcePanel.js）
//
// 它是纯字符串函数，所以能在 Node 里直接测（不需要 DOM）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSourcePanelHtml, buildSourcePanels } from '../ui/G_modal/sourcePanel.js';

const trust = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {
        'pta:x': { kind: 'board', rank: 30 },
        'srk:x': { kind: 'script', rank: 20 },
        manual: { kind: 'manual', rank: 100 }
    },
    fieldPrefer: {}
};

test('常规字段没有来源值 → "来源：默认值"（手动新建的节点就是这样）', () => {
    // **没有老数据**：不拿缓存值编一句"来源：未记录"。
    // `ops/tree.js` 建节点时只给**填过的**字段记 manual，其余字段停在 `createNode`
    // 的默认值上 —— 所以"常规字段没有来源"是**正常状态**，不是异常。
    for (const n of [{ values: {} }, { name: '', values: {} }, { name: '题', values: {}, importSource: 'pkg-1' }]) {
        const html = buildSourcePanelHtml(n, 'name', trust);
        assert.match(html, /来源：默认值/);
        assert.doesNotMatch(html, /v7|未记录/);
    }
    assert.equal(buildSourcePanelHtml(null, 'name', trust), '', '没有节点 → 空串');
});

test('派生字段没有来源值 → "来源：自动计算"（不空着，也不编来源）', () => {
    const node = { type: 'P', status1: 0, values: {} };
    const html = buildSourcePanelHtml(node, 'status1', trust);
    assert.match(html, /来源：自动计算/);
    assert.doesNotMatch(html, /v7|未记录|默认值/);
});

test('派生字段被你按下过（有 manual 来源值）→ 照常显示来源，不显示那句话', () => {
    const node = { type: 'P', status1: 1, values: { status1: [{ v: '1', src: 'manual', at: 'T1' }] } };
    const html = buildSourcePanelHtml(node, 'status1', trust);
    // 钉的是**那行提示语**（"来源：自动计算 / 默认值"）没出现 ——
    // 不能写成 `doesNotMatch(/默认值/)`：`真删` 按钮的 title 里就有"回到默认值"这个词
    assert.doesNotMatch(html, /来源：自动计算|来源：默认值/);
    assert.match(html, /manual/, '显示真正的来源');
});

test('每个字段都有「依据级别」徽标（把 nature 那套泛化到所有字段）', () => {
    // "字段来源的可信优先级设定"覆盖**所有字段**，不只 nature 分类：
    // 同一张面板上 ratio 同样有依据强度徽标。
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: '' },        // kind=board ⇒ A
        { v: '4.60', src: 'srk:x', at: '' }         // kind=script ⇒ B
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust);
    assert.match(html, /title="依据级别 A：权威榜单 \/ 官方来源"/, '权威榜单 ⇒ A（带理由）');
    assert.match(html, /title="依据级别 B：脚本从原始数据抓的"/, '脚本 ⇒ B（带理由）');

    // 人改的 ⇒ M（同一个面板上）
    const manualNode = { values: { ratio: [{ v: '9', src: 'manual', at: '' }] } };
    assert.match(buildSourcePanelHtml(manualNode, 'ratio', trust), /title="依据级别 M：人改的"/);
});

test('只有一个来源 → 一行灰字说明', () => {
    const node = { values: { name: [{ v: 'All Closed', src: 'srk:x', at: '' }] } };
    const html = buildSourcePanelHtml(node, 'name', trust);
    assert.match(html, /来源：srk:x/);
    assert.match(html, /唯一来源/);
    assert.equal(html.includes('<details'), false, '单来源不展开');
});

test('多个来源 → 可展开，列出每个说法与当前选中的', () => {
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: '2026-09-22' },
        { v: '4.60', src: 'srk:x', at: '2026-09-21' }
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust);
    assert.match(html, /<details/);
    assert.match(html, /2 个来源/);
    assert.match(html, /4\.61/);
    assert.match(html, /4\.60/);
    assert.match(html, /权威榜单优先/, '理由要显示出来');
    assert.match(html, /当前用 <b>pta:x<\/b>/);
    // 选中的值打勾，未被采用的没有
    const lines = html.split('<div style="margin:2px 0;">');
    assert.match(lines[1], /✅.*4\.61/);
    assert.match(lines[2], /4\.60/);
    assert.equal(/✅.*4\.60/.test(lines[2]), false);
});

test('链接值显示**类别**（仓库/榜单/补题都看得见）', () => {
    // "「仓库」与「未知」两类也应在非空时显示"——
    // 编辑弹窗的来源面板本来就逐值列出"谁给的"，这里补上"这是哪一类"。
    const node = { values: { link: [
        { v: 'https://qoj.ac/contest/2567', src: 'qoj-x', at: 'T1', linkKind: 'problems' },
        { v: 'https://github.com/algoux/srk-collection-raw/tree/master/files/x', src: 'rankland-index-x', at: 'T1', linkKind: 'repo' }
    ] } };
    const html = buildSourcePanelHtml(node, 'link', trust);

    assert.match(html, /2 个来源/);
    assert.match(html, /🔗 补题/, '补题类别要显示');
    assert.match(html, /📦 仓库/, '仓库类别也要显示（不许藏）');
});

test('点掉一个来源后：仍然列出**全部**来源，失效的可恢复', () => {    // 两个来源点掉一个 → 面板退回"单来源"布局、按钮消失、
    // 而且失效的那个值从列表里消失（没法点回来）。
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: 'T1' },
        { v: '4.60', src: 'srk:x', at: 'T1', invalid: true }
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust);

    assert.match(html, /<details/, '仍然是多来源布局，不能退回单来源');
    assert.match(html, /2 个来源/);
    assert.match(html, /其中 1 个已标不用/);
    assert.match(html, /4\.60/, '失效的值仍要列出来');
    assert.match(html, /data-src-act="restore"/, '失效的要能恢复');
    assert.match(html, /已标不用/);
    // 只剩一个可用值 → 不给"不用"按钮（core/ops/trust.js 不许失效唯一可用值）
    assert.equal(/data-src-act="dump"/.test(html), false);
});

test('两个可用来源时才有「不用」按钮', () => {
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: 'T1' },
        { v: '4.60', src: 'srk:x', at: 'T1' }
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust);
    assert.match(html, /data-src-act="dump"/);
    assert.match(html, /data-src-act="prefer"/);
});

// ---- 「真删」：**只给本账户的手改值**（当且仅当）----
// 规则的理由：爬虫/榜单给的值是**数据**，不是我的笔迹（要屏蔽用「不用」，可恢复）；
// 别人账户的手改值不该由我删（各账户手改互不干扰）；只有"我手改的那条"才该能撤销。
test('「真删」只出现在本账户的手改值上', () => {
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: 'T1' },                       // 榜单给的 → 不给
        { v: '4.60', src: 'srk:x', at: 'T1' },                       // 别来源 → 不给
        { v: '4.55', src: 'manual', at: 'T2', account: 'k2' },       // 别人手改 → 不给
        { v: '4.50', src: 'manual', at: 'T3', account: 'k1' }        // 本账户手改 → 给
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust,
        { accounts: { k1: { id: 'k1', name: '主号' }, k2: { id: 'k2', name: '队友' } },
          currentAccount: 'k1' });
    assert.equal((html.match(/data-src-act="remove"/g) || []).length, 1, '四行里只有一行的真删');
    const rows = html.split('<div style="margin:2px 0;');
    const mine = rows.find(r => r.includes('4.50'));
    assert.match(mine, /data-src-act="remove"/);
    assert.match(mine, /data-account="k1"/, '按钮必须带上账户 —— 不带就会删到别人那条');
    const theirs = rows.find(r => r.includes('4.55'));
    assert.equal(/data-src-act="remove"/.test(theirs), false, '队友的手改值不给真删');
    assert.equal(/data-src-act="remove"/.test(rows.find(r => r.includes('4.61'))), false,
        '爬虫/榜单给的值永远不给真删');
});

test('本账户没在操作任何账户时，手改值按"客观"那条比', () => {
    const node = { values: { name: [
        { v: '我写的', src: 'manual', at: 'T1' },
        { v: '别的', src: 'srk:x', at: 'T1' }
    ] } };
    const html = buildSourcePanelHtml(node, 'name', trust);      // 不传账户上下文
    assert.match(html, /data-src-act="remove"/, '无账户上下文 ⇒ 按 account="" 比');
});

test('唯一一条是**本账户手改值** → 也要给「真删」（单来源也要给）', () => {
    const node = { type: 'P', problemId: 'A',
        values: { name: [{ v: '我写的', src: 'manual', at: 'T1', account: 'k1' }] } };
    const html = buildSourcePanelHtml(node, 'name', trust,
        { accounts: { k1: { id: 'k1', name: '主号' } }, currentAccount: 'k1' });
    assert.match(html, /data-src-act="remove"/, '单来源分支也要给真删');
    assert.equal(html.includes('<details'), false, '仍然不展开（单来源布局不变）');
});

test('唯一一条是别人的手改值 → 不给「真删」', () => {
    const node = { type: 'P', values: { name: [{ v: '队友写的', src: 'manual', at: 'T1', account: 'k2' }] } };
    const html = buildSourcePanelHtml(node, 'name', trust,
        { accounts: { k1: { id: 'k1', name: '主号' }, k2: { id: 'k2', name: '队友' } },
          currentAccount: 'k1' });
    assert.equal(/data-src-act="remove"/.test(html), false);
});

test('值里的 HTML 会被转义（爬虫数据不可信）', () => {
    // 多来源分支会把"值"渲染出来，所以拿它测转义
    const node = { values: { name: [
        { v: '<img src=x onerror=alert(1)>', src: 'srk:x', at: '' },
        { v: '安全值', src: 'pta:x', at: '' }
    ] } };
    const html = buildSourcePanelHtml(node, 'name', trust);
    assert.equal(/<img/.test(html), false, '不能把值原样塞进 HTML');
    assert.match(html, /&lt;img/);
});

test('来源名也会被转义（来源可能是外部字符串）', () => {
    const node = { values: { name: [{ v: 'A', src: '<b>坏来源', at: '' }] } };
    const html = buildSourcePanelHtml(node, 'name', trust);
    assert.equal(/<b>/.test(html), false);
    assert.match(html, /&lt;b&gt;/);
});

test('buildSourcePanels：每个字段都会生成（没有来源值的也给"默认值/自动计算"一行）', () => {
    const node = { values: { name: [{ v: 'A', src: 'srk:x', at: '' }] } };
    const panels = buildSourcePanels(node, [{ key: 'name' }, { key: 'ratio' }], trust);
    assert.deepEqual(Object.keys(panels), ['name', 'ratio']);
    // `only` 仍然只挑指定的那些（这里 fields 里没有 ratio → 空）
    const only = buildSourcePanels(node, [{ key: 'name' }], trust, { only: ['ratio'] });
    assert.deepEqual(Object.keys(only), []);
});

// ================================================================
// 账户维度：值面板要显示"这个值是谁的"
//
// 为什么必须有：归认的结果只在**这里**能被人看见（值 = {v, src, at, account}）。
// 这就是"导入完了，归认在哪看"的答案之一。
// ================================================================

const accounts = {
    local: { id: 'local', name: '本机', mappings: [] },
    k1: { id: 'k1', name: '主号', mappings: [] },
    k2: { id: 'k2', name: '小号', mappings: [] }
};

test('值带账户 → 面板显示账户名（单来源也要显示）', () => {
    const node = { values: { status: [{ v: 'AC', src: 'qoj', at: '', account: 'k1' }] } };
    const html = buildSourcePanelHtml(node, 'status', trust, { accounts });
    assert.match(html, /来源：qoj/);
    assert.match(html, /👤主号 #k1/, '要带账户名与 id 后 4 位');
});

test('同名账户靠 id 后 4 位区分（不然两个"主号"分不清）', () => {
    const same = {
        aaaa1111: { id: 'aaaa1111', name: '主号', mappings: [] },
        bbbb2222: { id: 'bbbb2222', name: '主号', mappings: [] }
    };
    const n1 = { values: { status: [{ v: 'AC', src: 's', at: '', account: 'aaaa1111' }] } };
    const n2 = { values: { status: [{ v: 'WA', src: 's', at: '', account: 'bbbb2222' }] } };
    const h1 = buildSourcePanelHtml(n1, 'status', trust, { accounts: same });
    const h2 = buildSourcePanelHtml(n2, 'status', trust, { accounts: same });
    assert.match(h1, /#1111/);
    assert.match(h2, /#2222/);
    assert.notEqual(h1, h2);
});

test('值没有账户 → 明说"客观"，不是留空让人猜', () => {
    const node = { values: { ratio: [
        { v: '4.61', src: 'pta:x', at: 'T1' },
        { v: '4.60', src: 'srk:x', at: 'T1' }
    ] } };
    const html = buildSourcePanelHtml(node, 'ratio', trust, { accounts });
    assert.match(html, /客观/);
    assert.equal(/👤/.test(html), false, '客观值不该有账户标记');
});

test('单来源的客观值也要写「客观」（否则分不清"没有账户信息"和"不属于任何账户"）', () => {
    const node = { values: { name: [{ v: 'All Closed', src: 'srk:x', at: '' }] } };
    const html = buildSourcePanelHtml(node, 'name', trust, { accounts });
    assert.match(html, /唯一来源/);
    assert.match(html, /客观/);
    // 对照：同一形状但带账户 → 写账户，不写客观
    const mine = { values: { name: [{ v: 'A', src: 'srk:x', at: '', account: 'k1' }] } };
    const h2 = buildSourcePanelHtml(mine, 'name', trust, { accounts });
    assert.match(h2, /👤主号/);
    assert.equal(/客观/.test(h2), false);
});

test('账户名会被转义（名字是用户输入的）', () => {
    const bad = { x: { id: 'x', name: '<img src=x>', mappings: [] } };
    const node = { values: { status: [{ v: 'AC', src: 's', at: '', account: 'x' }] } };
    const html = buildSourcePanelHtml(node, 'status', trust, { accounts: bad });
    assert.equal(/<img/.test(html), false);
    assert.match(html, /&lt;img/);
});

test('注册表里没有的账户 id：不传 accounts → 原样显示；传了 → 当作"不活跃"隐藏（P2）', () => {
    const node = { values: { status: [
        { v: 'AC', src: 's', at: '', account: 'ghost' },
        { v: 'WA', src: 's2', at: '' }
    ] } };
    // 不传账户表（老调用方）：照旧显示 id，不炸
    const html = buildSourcePanelHtml(node, 'status', trust);
    assert.match(html, /👤ghost/);
    // 传了账户表：ghost 不在表里（= 账户不在活跃列表）→ 它的信息不显示，并说明隐藏了几条
    const filtered = buildSourcePanelHtml(node, 'status', trust, { accounts });
    assert.equal(/ghost/.test(filtered), false, '不在活跃列表里的账户信息不显示');
    assert.match(filtered, /已停用账户/);
    assert.match(filtered, /来源：s2/, '客观值（唯一来源）照常显示');
});

test('停用的账户：它的值不显示（P2 规则）', () => {
    const withOff = {
        ...accounts,
        k3: { id: 'k3', name: '退休号', active: false, mappings: [] }
    };
    const node = { values: { status: [
        { v: 'AC', src: 's', at: '', account: 'k3' },
        { v: 'WA', src: 's2', at: '', account: 'k1' }
    ] } };
    const html = buildSourcePanelHtml(node, 'status', trust, { accounts: withOff });
    assert.equal(/退休号/.test(html), false, '停用账户的名字不该出现在来源里');
    assert.match(html, /👤主号/);
    assert.match(html, /已停用账户/);
});

test('别的账户（活跃但不在查看中）：显示但标明"不在查看中"', () => {
    const node = { values: { name: [
        { v: 'A 的名字', src: 's', at: '', account: 'k1' },
        { v: 'B 的名字', src: 's2', at: '', account: 'k2' }
    ] } };
    const html = buildSourcePanelHtml(node, 'name', trust, { accounts, viewingAccount: 'k1' });
    assert.match(html, /不在查看中/, 'B 的值要标出来 —— 否则用户看不懂"为什么当前用 A 的值"');
    assert.match(html, /👤小号/);
});

test('不传 accounts 也照常工作（只显示 id）—— 老调用方不受影响', () => {
    const node = { values: { status: [{ v: 'AC', src: 's', at: '', account: 'k1' }] } };
    const html = buildSourcePanelHtml(node, 'status', trust);
    assert.match(html, /👤k1/);
});

// 口径："每个字段条都有『是否应有』『是否已有』『来源』『优先级』"——
//   后两样本来就有（来源行 + 级别徽标），这里补的是前两样（`opts.registry` = 随包发布的注册表）。
test('应有 / 已有：有注册表就显示，缺的标出来；没有注册表就整行不显示', () => {
    const registry = { fields: {
        ratio: { expect: 'optional', types: ['P'], why: '榜单给的通过率' },
        cfDifficulty: { expect: 'expected', types: ['P'],
                        when: { extKeyPrefix: ['cf:c:'] }, why: 'CF 常规轮次题按说都有难度分' }
    } };

    const miss = { extKey: 'cf:c:663:p:B', 节点类型: 'P',
                   values: { ratio: [{ v: '4.61', src: 's', at: '' }] } };
    const html = buildSourcePanelHtml(miss, 'cfDifficulty', trust, { registry });
    assert.match(html, /应有：应该有/, 'expected 档');
    assert.match(html, /已有：缺/);
    assert.match(html, /#b45309/, '缺 ⇒ 琥珀色');

    const has = { ...miss, cfDifficulty: '2000' };
    assert.match(buildSourcePanelHtml(has, 'cfDifficulty', trust, { registry }), /已有：有/);

    // 没有来源值的那条分支（默认值/自动计算）也必须有这一行 —— 那正是"缺"最常出现的地方
    const empty = { extKey: 'cf:c:663:p:B', 节点类型: 'P', values: {} };
    const emptyHtml = buildSourcePanelHtml(empty, 'cfDifficulty', trust, { registry });
    assert.match(emptyHtml, /来源：默认值/);
    assert.match(emptyHtml, /应有：应该有 · 已有：缺/, '两行并存，缺的那行在最上面');

    // 不传注册表 ⇒ 与老行为**逐字相同**（不显摆）
    assert.doesNotMatch(buildSourcePanelHtml(miss, 'cfDifficulty', trust), /应有：/);
});

// 口径（用户 2026-10-13 实测抓到）：**客观手改值（「所有人共用」）也要给「真删」**。
// 为什么：它不是"别人账户的值"，而且「转成所有人共用」那句提示写着"（撤销可还原）"——
//   不给真删的话，转完面板上连一个能按的都没有，只剩 `Ctrl+Z`（用户原话："手改值怎么没有「真删」"）。
test('★ 客观手改值（所有人共用）也给「真删」；别人账户的手改值仍然不给', () => {
    const DECL = { v: '0', src: 'local:v7', at: 'T0' };

    // ① 本账户手改 + 客观手改：两条都给「真删」
    const mine = { type: 'P', values: { cfDifficulty: [{ v: '2400', src: 'manual', at: 'T2', account: 'k1' },
        { v: '1500', src: 'manual', at: 'T1', account: '' }, DECL] } };
    const htmlMine = buildSourcePanelHtml(mine, 'cfDifficulty', trust, { currentAccount: 'k1' });
    assert.equal((htmlMine.match(/data-src-act="remove"/g) || []).length, 2,
        '本账户那条 + 客观那条，各一颗「真删」');

    // ② 只有客观手改一条（= 刚 promote 完、别的值还在）：也给
    const promoted = { type: 'P', values: { cfDifficulty: [
        { v: '2400', src: 'manual', at: 'T2', account: '' }, DECL] } };
    assert.match(buildSourcePanelHtml(promoted, 'cfDifficulty', trust, { currentAccount: 'k1' }),
        /data-src-act="remove"/, '★ "转成所有人共用"之后不能只剩 Ctrl+Z 一条退路');

    // ③ 别人账户的手改值：**仍然不给**（我不该删队友的）—— 这条边界一个字没动
    const other = { type: 'P', values: { cfDifficulty: [
        { v: '2400', src: 'manual', at: 'T2', account: 'k2' }, DECL] } };
    assert.doesNotMatch(buildSourcePanelHtml(other, 'cfDifficulty', trust, { currentAccount: 'k1' }),
        /data-src-act="remove"/, '★ 队友的手改不许我删');

    // ④ 单来源分支同理（唯一一条就是客观手改 ⇒ 也得能删）
    const only = { type: 'P', values: { cfDifficulty: [{ v: '2400', src: 'manual', at: 'T2', account: '' }] } };
    assert.match(buildSourcePanelHtml(only, 'cfDifficulty', trust, { currentAccount: 'k1' }),
        /data-src-act="remove"/, '单来源那条分支也认客观手改');
});
