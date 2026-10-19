// ================================================================
// 数据不变量冒烟（scripts/smoke/data-invariants.smoke.mjs）
//
// 钉住三件"数据完整性"的事：
//   ① **往返守恒**：导出 → 导入之后，来源层（含 account/clue/invalid）、origin、
//      账户注册表（含 active/mappings）、两个指针、trust/sources、副页 都不丢、不变形；
//   ② **幂等**：`normalizeStateValues` 跑第二次不再回填、不再迁移，数据一字未变；
//   ③ **显示路径只读**：渲染 / 统计 / 查询 / 换范围之后，state 深比较一字未变。
//
// 跑法：node --import ./scripts/smoke/register.mjs scripts/smoke/data-invariants.smoke.mjs
// ================================================================
import { installDom } from './dom.mjs';
import { group, eq, deepEq, ok, report } from './harness.mjs';

installDom();

const { AppState, replaceState } = await import('../../src/shell/state.js');
const { createInitialState } = await import('../../src/core/model/state.js');
const { createNode } = await import('../../src/core/model/node.js');
const { buildExportData } = await import('../../src/persistence/index.js');
const { importState } = await import('../../src/shell/executor.js');
const { normalizeStateValues } = await import('../../src/core/fieldValue.js');
const { setViewingAccount } = await import('../../src/core/ops/account.js');
const { viewValue, viewDerived, viewNote } = await import('../../src/view/scope.js');
const { renderNode } = await import('../../src/view/renderers.js');
const { buildPNodeTitle, buildPNodeMeta } = await import('../../src/view/builders.js');
const { getDisplayData } = await import('../../src/view/dataAdapter.js');
const { getGlobalStats, getVirtualGlobalStats, getCProblemSummary, getWSMatchSummary, getWSProblemSummary,
        getCStatusDistribution, getTotalNodeCount, markStatsDirty } = await import('../../src/view/stats.js');
const { buildDerivedTable, clearDerivedMemo } = await import('../../src/core/derive.js');
const { explainField } = await import('../../src/core/fieldValue.js');
const { buildProblemIndex } = await import('../../src/features/ProblemSearch/collect.js');
// 比赛检索的索引也是**只读**路径（与题目检索同一条纪律）
const { buildContestIndex } = await import('../../src/features/ContestSearch/collect.js');

// ================================================================
// 夹具：一份"什么都有一点"的状态
// ================================================================
function makeFixture() {
    const nodes = {
        root: { id: 'root', type: 'O', name: '根', expanded: true, currentPage: 1, selected: false, createdAt: 'T0', lastModified: 'T0', values: {} },
        c1: { id: 'c1', type: 'C', name: '比赛1', expanded: true, currentPage: 1, selected: false, createdAt: 'T0', lastModified: 'T0', values: {} },
        p1: {
            id: 'p1', type: 'P', name: '题1（缓存）', problemId: 'A', ratio: '缓存比例', cfDifficulty: 0,
            status2: 0, status1: 0, tags: [{ id: 't1', text: 'dp', color: '红' }],
            expanded: false, currentPage: 1, selected: false, createdAt: 'T0', lastModified: 'T1',
            origin: { src: 'pta', account: 'k1', at: 'T0' },
            values: {
                name: [
                    { v: '题1 我的名字', src: 'manual', at: 'T1', account: 'k1' },
                    { v: '题1 队友名字', src: 'manual', at: 'T2', account: 'k2' },
                    { v: '题1 客观名', src: 'pta:x', at: 'T3' }
                ],
                ratio: [
                    { v: '20.00', src: 'pta:x', at: 'T1', account: 'k1', clue: { source: 'qoj', field: '提交者', value: 'alice' } },
                    { v: '30.00', src: 'pta:x', at: 'T2', account: 'k2', invalid: true }
                ],
                status2: [{ v: '5', src: 'manual', at: 'T4', account: 'k1' }],
                tags: [{ v: ['dp', 'math'], src: 'manual', at: 'T1', account: 'k1' }]
            }
        },
        r1: {
            id: 'r1', type: 'R', name: '提交', status: 'AC', time: '2026.09.22 21:00', expanded: false,
            currentPage: 1, selected: false, createdAt: 'T0', lastModified: 'T0',
            values: { status: [{ v: 'AC', src: 'qoj:x', at: 'T1', account: 'k1' }] }
        },
        legacy: { id: 'legacy', type: 'P', name: '老节点（只有缓存）', ratio: '4.61', status2: 3, status1: 1, tags: [], createdAt: 'T0', lastModified: 'T0' }
    };
    const childOrder = { root: ['c1', 'legacy'], c1: ['p1'], p1: ['r1'], r1: [], legacy: [] };
    return {
        rootId: 'root', nodes, childOrder,
        parentOf: { root: null, c1: 'root', p1: 'c1', r1: 'p1', legacy: 'root' },
        pages: {
            pg1: {
                id: 'pg1', name: '副页A', rootId: 'v1', selected: true, createdAt: 'T0', lastModified: 'T0',
                virtualIndex: {
                    v1: { id: 'v1', type: 'O', refId: null, children: ['v2'], expanded: true, currentPage: 1, selected: false },
                    v2: { id: 'v2', type: 'P', refId: 'p1', children: [], expanded: false, currentPage: 1, selected: false }
                },
                vNodeStats: { v1: { statusComplete1: 0, statusComplete2: 0 } }
            }
        },
        settings: { mode: { treeDisplayMode: 'tree', editMode: 'attribute' }, stats: {} },
        meta: { idCounter: 42 },
        sources: { 'pta:x': { kind: 'board', rank: 30 } },
        trust: { categoryRank: ['manual', 'board', 'script', 'derived'], sources: { 'pta:x': { kind: 'board', rank: 30 } }, fieldPrefer: { ratio: ['pta:*'] } },
        accounts: {
            local: { id: 'local', name: '本机', isLocal: true, children: [], mappings: [] },
            k1: { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [{ source: 'qoj', field: '提交者', value: 'alice' }] },
            k2: { id: 'k2', name: '小号', children: [], isLocal: false, active: false, mappings: [] }
        },
        currentAccountId: 'k1',
        viewingAccountId: 'k2',
        currentPageId: 'pg1',
        currentTab: 'main',
        // ★ **随包元数据**也是应用数据（从包里导进来、落盘、进快照）
        //   ⇒ 「完整数据导出」必须带上它们，否则导出→导入一轮，体检页与字段条就空了。
        fieldRegistry: { registryVersion: 1, fields: { natureClass: { expect: 'required' } } },
        reports: { coverage: { rows: [{ type: 'C', field: 'natureClass', missing: 0 }] } }
    };
}

// ================================================================
// ① 导出 → 导入 往返守恒
// ================================================================
group('① 导出 → 导入：往返守恒');

const seeded = makeFixture();
// ⚠️ 顺序要与真实路径一致（`persistence` 的 loadData / `importState`）：**先归一化、再整体替换**。
//    反过来的话归一化就是在"事务之外就地改节点"—— 现在节点对象是冻的，会当场抛错
//    （见 `core/model/state.js` 的 freezeNodes）。
const loaded = JSON.parse(JSON.stringify(seeded));
normalizeStateValues(loaded);
replaceState(loaded);

// 导出（模拟"落到文件再读回来"），再把内存清成"另一台机器"的样子
const payload = JSON.parse(JSON.stringify(buildExportData(AppState)));
const blank = JSON.parse(JSON.stringify(seeded));
blank.accounts = {};
blank.trust = {};
blank.sources = {};
blank.currentAccountId = '';
blank.viewingAccountId = '';
blank.fieldRegistry = null;      // ★ E3：清掉才能证明它是**从存档回来的**
blank.reports = null;
replaceState(blank);

await importState(payload);
const p1 = AppState.nodes.p1;
const legacy = AppState.nodes.legacy;

// ★ **随包元数据也要往返守恒** —— 导出与导入**两头都得管**
//   （`buildExportData` 漏了不导出、`importState` 漏了不收，任一头都会丢）⇒ 导出→导入一轮，体检页/字段条就空了。
ok(AppState.fieldRegistry && AppState.fieldRegistry.registryVersion === 1
   && AppState.fieldRegistry.fields.natureClass.expect === 'required',
    '★ fieldRegistry 往返回来了（字段「应有」表）');
ok(AppState.reports && AppState.reports.coverage
   && AppState.reports.coverage.rows.length === 1,
    '★ reports 往返回来了（体检报告）');

deepEq(p1.values.name.map(x => [x.v, x.account]),
    [['题1 我的名字', 'k1'], ['题1 队友名字', 'k2'], ['题1 客观名', undefined]],
    'values.name 三条来源值与各自账户');
deepEq(p1.values.ratio.map(x => [x.v, x.clue && x.clue.value, !!x.invalid]),
    [['20.00', 'alice', false], ['30.00', undefined, true]],
    'values.ratio 的 clue 与 invalid 都保留');
deepEq(p1.values.status2.map(x => [x.v, x.account]), [['5', 'k1']], '派生字段的手动覆盖（带账户）');
deepEq(p1.values.tags.map(x => x.v), [['dp', 'math']], '列表型值仍是字符串数组');
deepEq(p1.origin, { src: 'pta', account: 'k1', at: 'T0' }, 'origin 一字不变');
deepEq(Object.keys(AppState.accounts).sort(), ['k1', 'k2', 'local'], '账户注册表');
eq(AppState.accounts.k2.active, false, '停用标记跟着存档走');
deepEq(AppState.accounts.k1.mappings, [{ source: 'qoj', field: '提交者', value: 'alice' }], '归认映射跟着存档走');
deepEq(AppState.trust.fieldPrefer, { ratio: ['pta:*'] }, '字段偏好跟着存档走');
deepEq(Object.keys(AppState.pages), ['pg1'], '副页跟着存档走');
eq(AppState.pages.pg1.virtualIndex.v2.refId, 'p1', 'vNode 仍指向真实节点');
eq(AppState.parentOf.p1, 'c1', 'parentOf 按 childOrder 重建');

// 两处"看起来不符、实为设计如此"的行为，一并钉住
deepEq(legacy.values && legacy.values.ratio.map(x => [x.v, x.src]), [['4.61', 'local:v7']],
    '老节点加载后回填来源层（既定行为）');
eq(legacy.ratio, '4.61', '老节点的缓存字段仍在（读取退回缓存）');
deepEq([AppState.currentAccountId, AppState.viewingAccountId], ['k1', 'k1'],
    '存档里"在看的账户"已停用 → 指针回落到登录账户（既定规则）');
ok(Object.keys(AppState.sources).includes('local:v7'), '回填来源被登记进 sources');

// ================================================================
// ② normalizeStateValues 幂等
// ================================================================
group('② 规范化 / 迁移幂等');
const snapshot = JSON.stringify({ nodes: AppState.nodes, accounts: AppState.accounts, sources: AppState.sources });
const again = normalizeStateValues(AppState);
deepEq([again.nodes, again.fields], [0, 0], '第二次不再回填任何字段');
ok(JSON.stringify({ nodes: AppState.nodes, accounts: AppState.accounts, sources: AppState.sources }) === snapshot,
    '第二次规范化后数据一字未变');

// 活跃账户的"在看"指针应当被保留
AppState.accounts.k2.active = true;
setViewingAccount(AppState, 'k2');
const payload2 = buildExportData(AppState);
replaceState(JSON.parse(JSON.stringify(blank)));
await importState(payload2);
eq(AppState.viewingAccountId, 'k2', '活跃账户的"在看"指针跟着存档走');

// ================================================================
// ③ 显示路径只读
// ================================================================
group('③ 渲染 / 统计 / 查询：state 一字未变');

const state = createInitialState();
const ids = { w: 'w1', c: 'c1', p: 'p1', r: 'r1' };
state.nodes[ids.w] = createNode(ids.w, 'W', { name: '平台' });
state.nodes[ids.c] = createNode(ids.c, 'C', { name: '比赛' });
state.nodes[ids.p] = createNode(ids.p, 'P', { name: '题目', problemId: 'A', ratio: '9.99' });
state.nodes[ids.r] = createNode(ids.r, 'R', { name: '提交', status: 'AC', time: '2026.09.22 21:00' });
state.nodes[ids.p].values = {
    name: [{ v: '题目的真名', src: 'manual', at: 'T1', account: 'k1' }],
    ratio: [{ v: '20.00', src: 'pta:x', at: 'T1' }, { v: '30.00', src: 'qoj:x', at: 'T2', account: 'k2' }],
    tags: [{ v: ['dp'], src: 'manual', at: 'T1', account: 'k1' }]
};
state.nodes[ids.r].values = { status: [{ v: 'AC', src: 'qoj:x', at: 'T1', account: 'k1' }] };
state.childOrder[state.rootId] = [ids.w];
state.childOrder[ids.w] = [ids.c];
state.childOrder[ids.c] = [ids.p];
state.childOrder[ids.p] = [ids.r];
state.childOrder[ids.r] = [];
state.parentOf = { [state.rootId]: null, [ids.w]: state.rootId, [ids.c]: ids.w, [ids.p]: ids.c, [ids.r]: ids.p };
state.accounts = {
    local: { id: 'local', name: '本机', isLocal: true, children: [], mappings: [] },
    k1: { id: 'k1', name: '主号', children: [], isLocal: false, mappings: [] },
    k2: { id: 'k2', name: '小号', children: [], isLocal: false, active: false, children: [], mappings: [] }
};
state.currentAccountId = 'k1';
state.viewingAccountId = 'k1';
state.sources = { 'pta:x': { kind: 'board', rank: 30 }, 'qoj:x': { kind: 'script', rank: 20 } };
state.trust = { categoryRank: ['manual', 'board', 'script', 'derived'], sources: { 'pta:x': { kind: 'board', rank: 30 } }, fieldPrefer: {} };
state.pages = {
    pg1: {
        id: 'pg1', name: '副页A', rootId: 'v1', selected: false, createdAt: 'T0', lastModified: 'T0',
        virtualIndex: {
            v1: { id: 'v1', type: 'O', refId: null, children: ['v2'], expanded: true, currentPage: 1, selected: false },
            v2: { id: 'v2', type: 'P', refId: ids.p, children: [], expanded: false, currentPage: 1, selected: false }
        },
        vNodeStats: { v1: { statusComplete1: 0, statusComplete2: 0 } }
    }
};

const before = JSON.stringify(state);
const p = state.nodes[ids.p];
renderNode(state, p, 0, state.childOrder[ids.c], ids.c);
buildPNodeTitle(state, p);
buildPNodeMeta(state, p);
explainField(p, 'name', state.trust, { viewingAccount: 'k1', accounts: state.accounts });
viewValue(state, p, 'name');
viewValue(state, p, 'tags');
viewDerived(state, p, 'status2');
viewNote(state);
getDisplayData(state, { pageId: 'main' });
getDisplayData(state, { pageId: 'pg1' });
getGlobalStats(state);
getVirtualGlobalStats(state, state.pages.pg1);
getCProblemSummary(state, state.nodes[ids.c]);
getWSMatchSummary(state, state.nodes[ids.w]);
getWSProblemSummary(state, state.nodes[ids.w]);
getCStatusDistribution(state, state.nodes[ids.c]);
getTotalNodeCount(state);
markStatsDirty();
buildProblemIndex(state, {
    value: (n, f) => viewValue(state, n, f),
    derived: (n, f) => viewDerived(state, n, f)
});
buildContestIndex(state, { value: (n, f) => viewValue(state, n, f) });
buildDerivedTable(state, { viewingAccount: 'k1' });
buildDerivedTable(state, { scopeAccounts: ['k1', 'k2'] });
buildDerivedTable(state, {});
clearDerivedMemo();
buildDerivedTable(state, { viewingAccount: 'k2' });
ok(JSON.stringify(state) === before, '渲染 + 统计 + 查询 + 换范围之后，state 深比较一字未变');

// ---- B4 的原始复现场景：页码越界时渲染**不许**写回 node.currentPage ----
// 若 `ensureCurrentPage` 把夹紧后的页码写进节点：赋值不抛错（autoFreeze 关着），
// 而 diff 只按节点引用判脏 → 这个改动既不入历史也不落盘，内存与盘上静默不一致。
{
    const { ensureCurrentPage } = await import('../../src/view/helpers.js');
    const c = state.nodes[ids.c];
    c.currentPage = 99;                        // 越界：实际只有 1 页
    const snapshot = JSON.stringify(state);
    const html = renderNode(state, c, 0, state.childOrder[ids.w], ids.w);
    eq(c.currentPage, 99, '★ 渲染没有把 currentPage 写回去（只算不写）');
    ok(JSON.stringify(state) === snapshot, '渲染越界页码后 state 仍一字未变');
    eq(ensureCurrentPage(state, c), 1, '夹紧后的页码由返回值给出');
    ok(/1 \/ 1|1 \/ \d/.test(html) || html.length > 0, '渲染照样出内容');
}

// ---- **W/S 的链接也进「按类别分组」的链接块**（口径：
//      "最好所有节点的链接（就是所有链接）都进『按类别分组』的链接块"）----
// C 与 W/S 都走 `buildLinkBlock`；若 W/S 单独画一个不带类别的 `🔗 链接`，同一份来源层
// 数据两种画法，链接一多就看不出哪条是榜单、哪条是仓库。
{
    const w = state.nodes[ids.w];
    w.values = { link: [
        { v: 'https://board.example/x', src: 'xcpcio:x', at: 'T1', linkKind: 'board' },
        { v: 'https://github.com/a/b', src: 'rankland:x', at: 'T1', linkKind: 'repo' },
        { v: 'https://qoj.ac/', src: 'qoj', at: 'T1', linkKind: 'browse' }
    ] };
    const html = renderNode(state, w, 0, state.childOrder[state.rootId], state.rootId);
    ok(/link-block/.test(html), 'W 节点也出「链接」块（不再是单个 🔗 链接）');
    ok(/🏆 榜单/.test(html) && /📦 仓库/.test(html) && /🧭 浏览/.test(html),
        '按类别分组：三类小标题都在');
    ok(/链接 \(3\)/.test(html), '折叠头带总数（🔗 链接 (3)）');
    delete w.values.link;
    delete w.values;
}

// ================================================================
// 状态不变量：**事务之外节点对象是冻的**（`freezeNodes` 的副作用）
//
// 为什么放冒烟而不是单测：`shell/state.js` 牵进裸包名 `immer`，纯 Node 单测解析不了。
// 为什么必须有这一条：`src/test/perfGuards.test.js` 的 ⑧ 对 `replaceState` 那个挂钩点
//   **只做源码字符串匹配** —— 改成 `if (false) freezeNodes(AppState);` 它照样绿，
//   而且 ⑧b 只测 `applyState`。这条（⑧c 指着的那个锚）真跑一次整体替换和一次事务。
// ================================================================
group('状态不变量：replaceState 之后节点是冻的');
{
    const small = {
        rootId: 'r',
        nodes: { r: { id: 'r', type: 'O', name: '根', values: {}, expanded: true } },
        childOrder: { r: [] },
        parentOf: { r: null },
        pages: {}, accounts: {}, trust: {}, sources: {},
        meta: { idCounter: 1 },
        settings: { performance: { historySteps: 25 }, display: {}, mode: {}, stats: {} }
    };
    replaceState(small);
    eq(Object.isFrozen(AppState.nodes.r), true,
        '★ replaceState 之后节点是冻的（启动加载 / 整包导入走的是这条口）');

    let err = null;
    try { AppState.nodes.r.name = '事务外改一下'; } catch (e) { err = e; }
    ok(!!err && /read only|not extensible/.test(err.message),
        `★ 事务外就地改节点 ⇒ 当场抛"冻结"那个 TypeError（实际：${err && err.message}）`);

    // 事务里照样改得动；而且改完**又被补冻**（`applyState` 那条口，⑧b 只测了函数本身）
    const { execute } = await import('../../src/shell/executor.js');
    await execute((d) => { d.nodes.r.name = '事务里改的'; },
        { skipHistory: true, skipPersist: true, validateFn: null });
    eq(AppState.nodes.r.name, '事务里改的', '（前提）冻结不影响 produce：事务里照样改得动');
    eq(Object.isFrozen(AppState.nodes.r), true, '★ 事务之后新产生的那个节点对象又被补冻了');

    // 对**已经冻过**的 state 再整体替换一次不许炸：`applyView` 是就地写 `expanded` 的，
    // 冻结之后它必须走"换一个新对象放回字典"那一支（否则就地写冻对象会炸 —— `fold-bench.mjs` 就是这么撞上的）
    const { produce } = await import('immer');
    let err2 = null;
    try {
        replaceState(produce(AppState, (d) => { d.meta.__probe = 1; }));
    } catch (e) { err2 = e; }
    eq(err2 && err2.message, null,
        '★ 已经是冻结态再走一次 replaceState 不许炸（折叠缓存贴回那条路）');
    eq(Object.isFrozen(AppState.nodes.r), true, '整体替换之后仍然是冻的');

    // 兜底那条也得能核：包**缺 nodes** 时 `importedState` 会沿用手上这份（**已冻结**），
    // 紧接着的 `normalizeStateValues` 是就地写 ⇒ 不兜底的话会抛一句看不懂的
    // "object is not extensible"。这里钉住"说人话"那句（`shell/executor.js` 的兜底）。
    let err3 = null;
    try { await importState({ rootId: 'r', childOrder: { r: [] } }); } catch (e) { err3 = e; }
    ok(!!err3 && /缺少 nodes/.test(err3.message),
        `★ 导入包缺 nodes ⇒ 报"缺少 nodes"，而不是冻结那句看不懂的（实际：${err3 && err3.message}）`);
    eq(err3 && /not extensible|read only/.test(err3.message), false,
        '（反向锚）绝对不能是"就地写冻结节点"那一句');
}

report();
