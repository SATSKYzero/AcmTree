// ================================================================
// 冒烟测试：节点自动导入插件（scripts/smoke/auto-import.smoke.mjs）
//
// 覆盖 Node 单测覆盖不到的部分（它们 import 了 shell/ → immer）：
//   - 插件激活并注册 Tab / 文件夹视图 / 节点迁移 / 编辑扩展
//   - 预览界面真实装配到 DOM
//   - **一次事务真实执行**：AppState 变更、指纹写回、幂等收敛
//   - 补身份键：按标识配对（非顺序）、不覆盖已有 key、冲突拒绝
//   - 目录轮询的纯判定（shouldAutoApply / isCrateFileName）
//
// 运行：npm run test:smoke
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// ---------------------------------------------------------------
// 1. DOM 桩 + FileReader 桩（必须在 import 被测模块之前）
// ---------------------------------------------------------------
const body = installDom();
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
const treeContainer = makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'tab-main');
// resetViewContainers() 会触碰这些内置容器（内置元素缺一个就抛 TypeError）
makeContainer(app, 'folder-breadcrumb');
makeContainer(app, 'folder-stats');
// 它还会用 '#tree-container > div:first-child' 定位统计行，故补一个子节点
treeContainer.appendChild(document.createElement('div'));

globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'))
});

// FileReader 桩：把 file._text 读成 ArrayBuffer
globalThis.FileReader = class {
    readAsArrayBuffer(file) {
        const text = file && file._text !== undefined ? file._text : '';
        const bytes = new TextEncoder().encode(text);
        this.onload({ target: { result: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } });
    }
};
// DecompressionStream 不存在 → files.js 会走"普通 JSON"分支（给 .gz 才报错）

/** 造一个假 File */
function fakeFile(name, text) {
    return { name, _text: text };
}

// 镜像 index.html 的静态一级 Tab
for (const [id, label] of [['main', '🏠 主视图'], ['stats', '📊 数据统计']]) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = id;
    btn.innerHTML = label;
    tabBar.appendChild(btn);
}
for (const id of ['main', 'stats']) {
    const pane = document.createElement('div');
    pane.className = 'tab-content';
    pane.id = `tab-${id}`;
    app.appendChild(pane);
}

// ---------------------------------------------------------------
// 2. 动态 import 被测模块
// ---------------------------------------------------------------
const registry = await import(mod('core/pluginRegistry.js'));
const tabs = await import(mod('ui/tabs.js'));
const host = await import(mod('ui/folder/folderViewHost.js'));
const folderShared = await import(mod('ui/folder/folderShared.js'));
const { bootstrapPlugins } = await import(mod('shell/bootstrap.js'));
const { AppState } = await import(mod('shell/state.js'));
const { isExpanded } = await import(mod('core/model/viewState.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { setByPath } = await import(mod('A_registry.js'));
const { createNode } = await import(mod('core/model/node.js'));

const ai = await import(mod('features/AutoImport/index.js'));
// ⚠️ 「📋 打开详页」的**文档级**委托由它装配（`installNodeInfoDelegate`）——
//    extKey 面板那两行的 📋 就是靠它接住的，所以要显式 `setupEventDelegation()`
const gevents = await import(mod('ui/G_events.js'));
// ⚠️ 假服务器**必须**报当前接口版本：面板先查"接口是不是旧的"（`ping.api < API_VERSION`），
//    版本号写死成字面量的话，每次升版这套用例都会莫名其妙地走进「旧进程」分支、连 POST 都不会发。
const { API_VERSION, BUILD_MODES, startBuild } = await import(mod('features/AutoImport/buildApi.js'));
const panelMod = await import(mod('features/AutoImport/extKeyPanel.js'));
const watcher = await import(mod('features/AutoImport/dirWatcher.js'));
const { collectExtKeyConflicts } = await import(mod('core/validate/upsertConflict.js'));
const { EVENTS } = await import(mod('A_constants.js'));

// ---- 造一份最小但合法的 AppState（让 execute() 能跑） ----
function seedState() {
    const base = createInitialState();
    for (const key of Object.keys(base)) {
        AppState[key] = base[key];
    }
    AppState.currentTab = 'main';
}
seedState();

/** 在根下建一个带 extKey 的平台容器，返回它的 id */
function addPlatform(extKey = 'qoj', name = 'QOJ') {
    const id = 'w_' + extKey.replace(/[^a-z0-9]/gi, '_');
    const node = createNode(id, 'W', { name, extKey });
    AppState.nodes[id] = node;
    AppState.childOrder[id] = [];
    AppState.childOrder[AppState.rootId].push(id);
    AppState.parentOf[id] = AppState.rootId;
    AppState.meta.idCounter++;
    return id;
}

// 样本数据统一放在 acm-data/raw/（见 acm-data/readme.md）
const readSample = name => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'acm-data', 'raw', name), 'utf8')
);

// ===============================================================
group('插件激活与注册');
// ===============================================================
const summary = await bootstrapPlugins();
ok(summary.activated.includes('AutoImport'), 'AutoImport 已激活');
eq(summary.failed.length, 0, '无激活失败');

ok(registry.getPluginTabs().some(t => t.id === 'auto-import'), '注册了一级 Tab: auto-import');
ok(registry.getPluginFolderViews().some(v => v.id === 'auto-import-sync'), '注册了文件夹视图: auto-import-sync');

// 迁移：新节点应带上 extKey / importFingerprint / importSource
const probe = createNode('n_probe', 'P', { name: '探针' });
eq(probe.extKey, '', '节点迁移补上 extKey 默认空串');
eq(probe.importFingerprint, '', '节点迁移补上 importFingerprint');
eq(probe.importSource, '', '节点迁移补上 importSource');

// ===============================================================
group('补身份键：对照表解析（按标识配对，不按顺序）');
// ===============================================================
const parsedTable = panelMod.parseAssignmentTable(
    '# 注释行会被忽略\n'
    + 'qoj:4113:20236\tA\n'
    + 'qoj:4113:20237, B\n'
    + 'qoj:4113:20238    C\n'
    + '格式不对的一行\n'
);
eq(parsedTable.pairs.length, 3, '解析出 3 条配对');
eq(parsedTable.pairs[0].extKey, 'qoj:4113:20236', '第一条 key 正确');
eq(parsedTable.pairs[0].token, 'A', '第一条标识正确');
eq(parsedTable.pairs[1].token, 'B', '逗号分隔也认');
eq(parsedTable.pairs[2].token, 'C', '多空格分隔也认');
eq(parsedTable.errors.length, 1, '格式不对的行被报出来');

// 配对：故意把行顺序打乱，仍应按题号配上
const nodes = [
    { id: 'p1', type: 'P', problemId: 'A', name: 'All Closed', extKey: '' },
    { id: 'p2', type: 'P', problemId: 'B', name: 'Bread', extKey: '' },
    { id: 'p3', type: 'P', problemId: 'C', name: 'Cut Tree', extKey: 'existing:key' }
];
const matched = panelMod.matchAssignments(nodes, [
    { extKey: 'qoj:4113:20238', token: 'C' },   // 已有 key → 应跳过
    { extKey: 'qoj:4113:20237', token: 'B' },
    { extKey: 'qoj:4113:20236', token: 'A' },
    { extKey: 'qoj:4113:99999', token: 'Z' }    // 无此节点 → 未匹配
]);
eq(matched.assignments.length, 2, '只有 2 条可写入（C 已有 key，Z 未匹配）');
eq(matched.assignments.find(a => a.nodeId === 'p1').extKey, 'qoj:4113:20236', '题号 A 配到正确的 key');
eq(matched.assignments.find(a => a.nodeId === 'p2').extKey, 'qoj:4113:20237', '题号 B 配到正确的 key');
eq(matched.skippedNonEmpty, 1, '已有 key 的节点被跳过（不覆盖）');
eq(matched.unmatched.length, 1, '未匹配的标识被列出');

// 歧义：同一层两个节点都用 B 题号 → 必须歧义而不是随便挑
const ambiguous = panelMod.matchAssignments(
    [{ id: 'x1', problemId: 'B', name: 'B1', extKey: '' }, { id: 'x2', problemId: 'B', name: 'B2', extKey: '' }],
    [{ extKey: 'k:B', token: 'B' }]
);
eq(ambiguous.assignments.length, 0, '歧义时不写入');
eq(ambiguous.ambiguous.length, 1, '歧义被显式报出');

// ===============================================================
group('补身份键面板装配');
// ===============================================================
seedState();
const platformId = addPlatform('qoj', 'QOJ');
const pA = createNode('pA', 'P', { name: 'All Closed', problemId: 'A', extKey: '' });
AppState.nodes.pA = pA;
AppState.childOrder.pA = [];
AppState.childOrder[platformId].push('pA');
AppState.parentOf.pA = platformId;

const panelHost = document.createElement('div');
document.body.appendChild(panelHost);
panelMod.renderExtKeyPanel(panelHost, { nodeId: platformId, node: AppState.nodes[platformId] });

const html = serialize(panelHost);
ok(/补身份键/.test(html), '面板渲染出标题');
ok(/逃生舱/.test(html), '逃生舱（批量生成）有明确的风险标注');
ok(!!panelHost.querySelector('.ai-paste-area'), '渲染出粘贴框');
ok(!!panelHost.querySelector('.ai-gen-btn'), '渲染出批量生成按钮');
// 注：节点列表现在用**真实 DOM 元素**构建，因此可以直接查询到行
// （用 innerHTML 拼串的话桩不解析它，只能退化成断言序列化字符串）。
ok(panelHost.querySelectorAll('.ai-extkey-row').length === 1,
    '节点列表渲染出 1 行（真实元素，可查询）');
ok(/All Closed/.test(html), '列出子节点名称');
ok(/\(空\)/.test(html), '缺少 extKey 的节点被标红提示');

// ===============================================================
group('预览界面装配（一级 Tab）');
// ===============================================================
AppState.currentTab = 'main';
tabs.setupTabs();
tabs.switchTab('auto-import');

const tabPane = document.getElementById('tab-auto-import');
ok(!!tabPane, '插件 Tab 容器已创建');
eq(tabPane.classList.contains('active'), true, '插件 Tab 已激活');
ok(!!tabPane.querySelector('.ai-pick-btn'), '渲染出「选择导入文件」按钮');
ok(!!tabPane.querySelector('.ai-dir-btn'), '渲染出「选择爬虫输出目录」按钮');
ok(/还没有载入导入包/.test(serialize(tabPane)), '空态提示可见');

// ===============================================================
group('文件夹视图挂载');
// ===============================================================
const views = host.resolveFolderViews([
    { id: 'children', label: '📂 子节点', order: 0, mount() {} },
    { id: 'stats', label: '📊 题目分布统计', order: 10, mount() {} }
]);
ok(views.some(v => v.id === 'auto-import-sync'), '插件文件夹视图已并入');

host.mountFolderView({
    views,
    viewId: 'auto-import-sync',
    ctx: {
        state: AppState,
        nodeId: platformId,
        node: AppState.nodes[platformId],
        pageId: 'main',
        source: 'real'
    }
});
const fvPanel = document.getElementById('folder-view-panel-auto-import-sync');
ok(!!fvPanel, '文件夹视图专属面板已创建');
eq(fvPanel.style.display, 'block', '面板可见');
ok(/导入目标/.test(serialize(fvPanel)), '显示导入目标（当前文件夹）');

// ===============================================================
group('真实执行：qoj 样本导入 → 幂等收敛');
// ===============================================================
seedState();
addPlatform('qoj', 'QOJ');

const problemsText = JSON.stringify(readSample('qoj_problems.json'));
const tabPane2 = document.getElementById('tab-auto-import');

const batches1 = await ai.loadFiles([fakeFile('qoj_problems.json', problemsText)]);
eq(batches1.length, 1, '载入 1 个批次');
eq(batches1[0].error, '', '解析无错误');
eq(batches1[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(batches1[0].plan.errors)}`);
// 树上已有平台 → 新增 S + C + 12 P
eq(batches1[0].plan.summary.create, 14, '新增 14（S + C + 12 道题；平台已存在）');

// 执行
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
// 节点的「分类依据」要能被界面读到（级别表在 core/natureConfidence.js）
const { classLevelOf } = await import(mod('core/natureConfidence.js'));
const res1 = await applyPlans({ state: AppState, items: [{ plan: batches1[0].plan, source: 'qoj-scraper' }] });
eq(res1.ok, true, `执行成功：${res1.error || ''}`);
eq(res1.created, 14, '写入 14 个新节点');

// 节点真的进了主树
const byKey = {};
for (const id in AppState.nodes) {
    const n = AppState.nodes[id];
    if (n && n.extKey) byKey[n.extKey] = n;
}
ok(!!byKey['qoj:contest'], 'S 层比赛分组已建立（W 下不能直接放 C）');
ok(!!byKey['qoj:4113'], '比赛节点已建立');
ok(!!byKey['qoj:4113:20236'], '第一道题已建立');
eq(byKey['qoj:4113:20236'].name, 'All Closed', '题名正确');
eq(byKey['qoj:4113:20236'].problemId, 'A', '题号正确');
eq(byKey['qoj:4113:20236'].importFingerprint !== '', true, '指纹已写回');
eq(byKey['qoj:4113:20236'].importSource, 'qoj-scraper', '来源已写回');

// 层级关系正确：W → S → C → P
const sId = byKey['qoj:contest'].id;
const cId = byKey['qoj:4113'].id;
const pId = byKey['qoj:4113:20236'].id;
eq(AppState.parentOf[sId], byKey['qoj'].id, 'S 挂在 W 下');
eq(AppState.parentOf[cId], sId, 'C 挂在 S 下');
eq(AppState.parentOf[pId], cId, 'P 挂在 C 下');

// ---- 回归：导入**不**展开节点 ----
// 一次导入动辄上百个节点，逐级展开会把整棵树炸开、还会撞上展开上限。
eq(isExpanded(AppState, byKey['qoj:contest'].id), false, '新建的 S 默认折叠');
eq(isExpanded(AppState, byKey['qoj:4113'].id), false, '新建的 C 默认折叠');
eq(isExpanded(AppState, byKey['qoj:4113:20236'].id), false, '新建的 P 默认折叠');
eq(isExpanded(AppState, byKey['qoj'].id), false, '导入不展开已存在的平台 W');

// ---- 第二次导入：必须收敛为全跳过 ----
const batches2 = await ai.loadFiles([fakeFile('qoj_problems.json', problemsText)]);
eq(batches2[0].plan.summary.create, 0, '第二次不再新建');
eq(batches2[0].plan.summary.update, 0, '第二次不再更新');
// 注意是 15 而不是 14：第一次时平台记录已经在树上（预置的 W），
// 但它**不在**第一次生成的 plan 里；第二次全部 15 条都能对上，
// 所以跳过数 = crate 里的全部记录数。
eq(batches2[0].plan.summary.skip, 15, '第二次全部跳过（收敛）');

const res2 = await applyPlans({ state: AppState, items: [{ plan: batches2[0].plan, source: 'qoj-scraper' }] });
eq(res2.ok, true, '第二次执行成功');
eq(res2.created, 0, '第二次写入 0 个新节点');
eq(res2.updated, 0, '第二次更新 0 个节点');

// 节点总数没变（没产生重复）
const pCount = Object.values(AppState.nodes).filter(n => n && n.type === 'P').length;
eq(pCount, 12, '始终只有 12 道题，没有重复');

// ===============================================================
group('真实执行：提交记录 → 自动推导 status2');
// ===============================================================
// ⚠️ 这一节读的是**个人提交导出** `qoj_submissions.json` —— 这份仓库里不带它（清个人数据时删掉了）
//    ⇒ 缺样本就整节跳过（**不是失败**）。别把它改成 assert：那样一跑冒烟就见红。
if (!fs.existsSync(path.join(ROOT, 'acm-data', 'raw', 'qoj_submissions.json'))) {
    console.log('   ⏭ 跳过这一节：acm-data/raw/qoj_submissions.json 不在'
        + '（个人样本，这份仓库里已清掉，属预期）');
} else {
    const subsText = JSON.stringify(readSample('qoj_submissions.json'));
    const batches3 = await ai.loadFiles([fakeFile('qoj_submissions.json', subsText)]);
    eq(batches3[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(batches3[0].plan.errors)}`);
    ok(batches3[0].plan.records.some(r => r.type === 'R'), '产出 R 记录');

    const res3 = await applyPlans({ state: AppState, items: [{ plan: batches3[0].plan, source: 'qoj-scraper' }] });
    eq(res3.ok, true, `执行成功：${res3.error || ''}`);

    const byKey3 = {};
    for (const id in AppState.nodes) {
        const n = AppState.nodes[id];
        if (n && n.extKey) byKey3[n.extKey] = n;
    }
    ok(!!byKey3['qoj:sub:2951241'], 'AC 提交已建立');
    eq(byKey3['qoj:sub:2951241'].status, 'AC', '提交结果正确');

    // 关键：爬虫一个字都没写 status2，但 autoCompute 从 R 推导出来了
    const island = byKey3['qoj:4113:20244'];
    ok(!!island, 'I 题已由提交顺带补出');
    eq(island.status2, 3, 'P.status2 由 R 自动推导为「赛后补题」（爬虫未写状态）');
    // 时间**保留到秒**（14 位）—— 同一分钟内多条提交靠它排序，`acTime` 才准
    eq(island.acTime, '2026.09.13 22:06:07', 'acTime 也自动推导出来了（带秒）');
}

// ===============================================================
group('回归：ratio → xcpcDifficulty 由 autoCompute 派生（导入只写 ratio）');
// ===============================================================
// 背景：xcpcDifficulty 是派生字段（导入写不进去）。若它只在
// core/ops/node.js 的 updateP（手动编辑）里算，于是导入进来的题目
// 永远停在默认值 '-'，树上显示成 `28.19%(-)`。
// qoj 样本没有 ratio，所以这里另造一份带 ratio 的最小 crate。
const ratioCrate = JSON.stringify({
    crateVersion: 1,
    source: { id: 'ratio-fixture' },
    fieldMap: {},
    records: [
        { 节点类型: 'W', extKey: 'ratiofix', name: 'RatioFix' },
        { 节点类型: 'S', extKey: 'ratiofix:s', 父extKey: 'ratiofix', name: '分组' },
        { 节点类型: 'C', extKey: 'ratiofix:s:c', 父extKey: 'ratiofix:s', name: '比赛' },
        { 节点类型: 'P', extKey: 'ratiofix:s:c:A', 父extKey: 'ratiofix:s:c', name: '题A', problemId: 'A', ratio: '28.19' }
    ]
});
const batchesR = await ai.loadFiles([fakeFile('ratio-fixture.json', ratioCrate)]);
eq(batchesR[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(batchesR[0].plan.errors)}`);
const resR = await applyPlans({ state: AppState, items: [{ plan: batchesR[0].plan, source: 'ratio-fixture' }] });
eq(resR.ok, true, `执行成功：${resR.error || ''}`);

const pRatio = Object.values(AppState.nodes).find(n => n && n.extKey === 'ratiofix:s:c:A');
ok(!!pRatio, '带 ratio 的题目已建出');
eq(pRatio.ratio, '28.19', 'ratio 已写入（导入只负责写原料）');
// 28.19% 落在 [25, 30) → 铜牌-（A_constants.js 的 XCPC_THRESHOLDS）
eq(pRatio.xcpcDifficulty, '铜牌-', 'xcpcDifficulty 已由 ratio 派生（不再停在 "-"）');
eq(isExpanded(AppState, pRatio.id), false, '导入的题目依旧默认折叠');

// ---- 来源层：导入的值要留下"谁给的"----
// 这里钉的是端到端的那条链：applyPlans → recordIncoming → node.values
ok(Array.isArray(pRatio.values && pRatio.values.ratio),
    `ratio 的来源层已写入：${JSON.stringify(pRatio.values)}`);
eq(pRatio.values.ratio[0].v, '28.19', '来源值内容正确');
eq(pRatio.values.ratio[0].src, 'ratio-fixture', '来源 id = 导入包来源');
ok(!!AppState.sources['ratio-fixture'], '来源已登记进注册表（state.sources）');
// 投影实际查的是 `trust.sources`（core/trust.js 的 normalizeTrust），不是 state.sources。
// 两处必须同步 —— 否则所有来源在投影眼里都是"默认 script / rank 0"，
// 手改的"永远优先"与权威榜单的类别优先都会静默失效。
ok(!!(AppState.trust && AppState.trust.sources && AppState.trust.sources['ratio-fixture']),
    '投影用的 trust.sources 也登记了');
// ★ 回归：来源层不能因为"节点默认值共享"而跨节点串味
//   （createNode 浅拷贝 COMMON_DEFAULTS，addSourceValue 又原地 push）
//   这里断言：这个节点的 name 只属于它自己 —— 别的题目名不许出现在这儿。
eq(pRatio.values.name.length, 1, `本节点的来源值不串味：${JSON.stringify(pRatio.values.name)}`);
eq(pRatio.values.name[0].src, 'ratio-fixture', '同一来源的其它字段也留了出处');
eq(pRatio.values.name[0].v, '题A', '值正确');
// ⚠️ 关键：来源层是**旁路**，缓存字段仍按 v7 策略写（行为不变）
eq(pRatio.name, '题A', '缓存字段没被来源层改动');
eq('mode' in AppState.trust, false, '`trust.mode` 设置不存在（没人读它，不许再加）');

// ===============================================================
group('回归：全部跳过的导入也必须记来源层（补第二个来源）');
// ===============================================================
// 这条 bug：先导入主包（来源 A），再导入另一个片段（来源 B）给同一批节点
// 补一个**同样的值**——第二次预览是「新增 0 / 更新 0 / 跳过 N」，
// 界面上执行按钮被禁用（提示"没有需要写入的变更"），于是 `applyPlans` **从未被调用**，
// 来源 B 永远进不了 `node.values`。
// 根因：UI 把"有待写入字段"当成了"有事可做"；而来源层是**旁路**——skip 的记录
// 也要记"这个来源说过什么"。这一组走**用户真实路径**（渲染面板 → 点执行按钮）。
{
    seedState();
    addPlatform('xcpc', 'XCPC');

    const makeCrate = srcId => JSON.stringify({
        crateVersion: 1,
        source: { id: srcId },
        fieldMap: {},
        records: [
            { 节点类型: 'S', extKey: 'xcpc:s1', 父extKey: 'xcpc', name: '系列' },
            { 节点类型: 'C', extKey: 'xcpc:s1:c1', 父extKey: 'xcpc:s1', name: '初赛' },
            { 节点类型: 'P', extKey: 'xcpc:s1:c1:A', 父extKey: 'xcpc:s1:c1', name: '题A', problemId: 'A', ratio: '28.19' }
        ]
    });

    // 1) 第一个来源：主包
    const b1 = await ai.loadFiles([fakeFile('pta-demo.json', makeCrate('pta-demo'))]);
    eq(b1[0].plan.summary.errors, 0, `主包预览无错误：${JSON.stringify(b1[0].plan.errors)}`);
    const resA = await applyPlans({ state: AppState, items: [{ plan: b1[0].plan, source: b1[0].source }] });
    eq(resA.ok, true, `主包执行成功：${resA.error || ''}`);

    const findA = () => Object.values(AppState.nodes).find(n => n && n.extKey === 'xcpc:s1:c1:A');
    eq(findA().values.ratio.length, 1, '主包写完：ratio 的来源层有 1 条');
    eq(findA().values.ratio[0].src, 'pta-demo', '第一条来源 = 主包');

    // 2) 第二个来源：同 extKey、同值（指纹相同 → 策略判定整条 skip）
    const b2 = await ai.loadFiles([fakeFile('srk-cache.json', makeCrate('srk-cache'))]);
    eq(b2[0].plan.summary.create, 0, '第二次不新建');
    eq(b2[0].plan.summary.update, 0, '第二次不更新');
    eq(b2[0].plan.summary.skip, 3, '第二次全部跳过（这正是触发 bug 的场景）');

    // 3) 走界面：全跳过的计划，执行按钮**不能**被禁用
    const hostSrc = document.createElement('div');
    document.body.appendChild(hostSrc);
    const view = { kind: 'tab', forcedParentId: '', batches: b2, selected: 0 };
    ai.renderPanel(hostSrc, view);

    const execBtn = hostSrc.querySelector('.ai-execute-btn');
    ok(!!execBtn, '渲染出执行按钮');
    eq(execBtn.disabled, false, '全跳过时执行按钮仍可用（来源层要记，不能短路掉 applyPlans）');
    ok(!/没有需要写入的变更/.test(serialize(hostSrc)), '不再显示"没有需要写入的变更（已是最新）"');

    // 4) 点它 → 第二个来源必须进来源层，且**缓存字段一个都不能动**
    // 插件不 import ui，提示走 `EVENTS.SHOW_TOAST` 事件（由 eventBridge 转成真 toast），
    // 所以这里听事件而不是看 DOM。
    let lastToastMsg = '';
    const onToast = (e) => { lastToastMsg = (e.detail && e.detail.message) || ''; };
    document.addEventListener(EVENTS.SHOW_TOAST, onToast);
    execBtn.click();
    await new Promise(r => setTimeout(r, 120));
    document.removeEventListener(EVENTS.SHOW_TOAST, onToast);

    const node = findA();
    eq(node.values.ratio.length, 2, `ratio 的来源层多了第二个来源：${JSON.stringify(node.values.ratio)}`);
    ok(node.values.ratio.some(x => x.src === 'srk-cache' && x.v === '28.19'),
        '第二个来源（srk-cache）已记进 node.values.ratio');
    eq(node.ratio, '28.19', '缓存字段 ratio 没被改动（来源层是旁路）');
    eq(node.name, '题A', '缓存字段 name 没被改动');
    ok(!!AppState.sources['srk-cache'], '第二个来源已登记进 state.sources');
    eq('mode' in AppState.trust, false, '`trust.mode` 设置不存在（没人读它，不许再加）');
    // 导入完成的提示里必须带上归认结果 —— 否则"什么都没提示"无法区分
    // "全都认对了"和"归认根本没跑"。
    ok(/归认：认出 \d+ 条/.test(lastToastMsg),
        `导入提示里带归认结果：${lastToastMsg}`);
}

// ===============================================================
group('撤销可回退（逐步，不跳步）');
// ===============================================================
// 注意断言的是**"撤回一次 = 退一步"**：
// 若 `popHistory` 把栈顶丢掉再返回更旧的一份，每按一次撤回都会跳过一步。
// 所以这里不能假设"撤一次就退过整个导入"，而要钉住"退的正好是上一次事务之前"。
{
    const { undo, execute } = await import(mod('shell/executor.js'));
    const { addChild } = await import(mod('core/ops/tree.js'));

    const beforeAdd = Object.keys(AppState.nodes).length;
    const platformId = Object.values(AppState.nodes).find(n => n && n.type === 'W').id;
    await execute((d) => { addChild(d, platformId, 'S', '撤销用系列'); },
        { validate: false, refreshParentId: null });
    const afterAdd = Object.keys(AppState.nodes).length;
    eq(afterAdd, beforeAdd + 1, `（前提）新建了一个节点：${beforeAdd} → ${afterAdd}`);

    await undo();
    eq(Object.keys(AppState.nodes).length, beforeAdd,
        `★ 撤回一次正好退回上一步（${afterAdd} → ${Object.keys(AppState.nodes).length}）`);
}

// ===============================================================
// 回归：点「优先」要**同时**改值 + 同步弹窗里的输入框
// ===============================================================
group('回归：点「优先」要同时改值 + 同步弹窗输入框');
// 这条 bug：P 节点 ratio 有两个来源（pta 说 4.61、srk 说 4.55）。
// 点「优先」选 srk 之后：
//   - `AppState` 里的值**确实**重算成了 4.55（core/ops/trust.js 是对的），
//   - 但弹窗里的 `#field-ratio` 输入框还是旧值 4.61。于是：
//       ① 用户看到的是"我点了却没反应"（输入框没变）；
//       ② 接着点「确定」时，`G4_edit.js` 读的是**输入框**的值，
//          把旧值又写回去（并被记成一条 manual 来源）——偏好明明在、
//          理由也显示"你指定这个字段优先用 srk-…"，值却还是旧的。
// 这一组走**用户真实路径**：按钮属性取自 sourcePanel 生成的 HTML，
// 点击走 sourceActions 注册在 document 上的委托监听。
{
    seedState();
    const { execute } = await import(mod('shell/executor.js'));
    const { updateP } = await import(mod('core/ops/node.js'));
    const { explainField } = await import(mod('core/fieldValue.js'));
    const { buildSourcePanelHtml } = await import(mod('ui/G_modal/sourcePanel.js'));
    // import 即注册委托监听（与 P 弹窗里的做法一致）
    await import(mod('ui/G_modal/sourceActions.js'));

    const PTA = 'pta-icpc2026preliminary-2';
    const SRK = 'srk-icpc2026preliminary-2';
    const AT = '2026-09-21T21:45:03.669Z';

    // 1) 两个来源；v7 策略当前采用的是先到的 pta 那条
    const pid = 'p_two_src';
    const pNode = createNode(pid, 'P', { name: 'All Closed', problemId: 'A', extKey: 'xcpc:two:A' });
    AppState.nodes[pid] = pNode;
    AppState.childOrder[pid] = [];
    AppState.childOrder[AppState.rootId].push(pid);
    AppState.parentOf[pid] = AppState.rootId;
    pNode.ratio = '4.61';
    pNode.values = {
        ratio: [
            { v: '4.61', src: PTA, at: AT },
            { v: '4.55', src: SRK, at: AT }
        ]
    };
    eq(explainField(pNode, 'ratio', AppState.trust).value, '4.61',
        '前提：投影当前采用 pta 的 4.61（与用户看到的一致）');

    // 2) 造出弹窗里的那段 DOM：来源面板 + 该字段的输入框
    const panelHtml = buildSourcePanelHtml(pNode, 'ratio', AppState.trust);
    ok(/data-field="ratio"/.test(panelHtml), '面板按钮带的是**内部字段名** ratio（H1）');
    const btnHtml = panelHtml.match(
        /<button[^>]*data-src-act="prefer"[^>]*data-src="srk-icpc2026preliminary-2"[^>]*>/
    );
    ok(!!btnHtml, '面板给 srk 那一行生成了「优先」按钮');
    const preferBtn = document.createElement('button');
    preferBtn.className = 'src-act';
    for (const m of btnHtml[0].matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
        preferBtn.dataset[m[1].replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())] = m[2];
    }
    const details = document.createElement('div');
    details.className = 'src-details';
    document.body.appendChild(details);
    details.appendChild(preferBtn);

    const input = document.createElement('input');
    input.id = 'field-ratio';
    input.value = String(pNode.ratio);          // 弹窗打开时显示的就是它
    document.body.appendChild(input);

    // 3) 用户路径：点「优先」
    document.dispatchEvent({ type: 'click', target: preferBtn, preventDefault() {}, stopPropagation() {} });
    await new Promise(r => setTimeout(r, 120));

    const after = AppState.nodes[pid];
    eq(after.ratio, '4.55', '缓存字段跟着偏好重算（core/ops/trust.js）');
    eq(input.value, '4.55', '★ 弹窗里的输入框也要同步成新值（不同步就会停在 4.61）');
    ok(/你指定这个字段优先用 srk/.test(explainField(after, 'ratio', AppState.trust).reason),
        '面板理由显示偏好已生效');

    // 4) 反向验证：模拟用户接着点「确定」——G4_edit.js 取的是**输入框**的值。
    //    输入框不同步时，这一步会把旧值写回去，等于把偏好抹掉。
    //    ⚠️ 必须带上 `manualFields`（弹窗的真实做法，见 G4_edit.js）：用户这一路
    //       只点了「优先」、一个键都没敲，所以清单是**空的**。
    //       （漏传这个参数 → 走 updateP 的 fallback 分支，等于没覆盖弹窗路径 ——
    //         正是"点「优先」却记出一条 manual"这个 bug 漏网的原因。
    //         完整弹窗路径的回归见 scripts/smoke/manual-input.smoke.mjs。）
    await execute(draft => {
        updateP(draft, pid, {
            name: after.name,
            status1: after.status1,
            status2: after.status2,
            problemId: after.problemId,
            cfDifficulty: after.cfDifficulty,
            link: after.link,
            ratio: input.value                     // ← 弹窗里那个输入框的值
        }, { manualFields: [] });                  // ← 用户没敲过任何输入框
        return true;
    });
    eq(AppState.nodes[pid].ratio, '4.55', '点「确定」不会再把手改前的旧值写回去');

    // 5) ★ 另一个问题：**"切换数据源"不该被算成手改**。
    //    弹窗点「确定」会把所有字段原样回传一遍；如果 updateP 不看"到底改没改"，
    //    就会给你根本没动过的值记一条 manual 来源 —— 而 manual 优先级最高，
    //    从此压过一切来源，偏好设置也就白设了。
    const vals = AppState.nodes[pid].values.ratio || [];
    eq(vals.filter(x => x.src === 'manual').length, 0,
        `来源动作 + 确定 之后不该产生 manual 来源值：${JSON.stringify(vals)}`);
    ok(/你指定这个字段优先用 srk/.test(explainField(AppState.nodes[pid], 'ratio', AppState.trust).reason),
        '偏好仍然生效（没有被 manual 顶掉）');

    // 6) 对照：**真的手改**一个不同的值 → 才该记 manual
    await execute(draft => {
        updateP(draft, pid, { ratio: '9.99' });
        return true;
    });
    eq(AppState.nodes[pid].ratio, '9.99', '手改生效');
    ok((AppState.nodes[pid].values.ratio || []).some(x => x.src === 'manual' && x.v === '9.99'),
        '真的手改才记 manual 来源值');

    // 7) ★ 判据：**"我动了它" ∧ "它确实变了"** 才算真正手改。
    //    ——敲了个和现在一样的值 → 不算手改（值没变）。
    const manualBefore = (AppState.nodes[pid].values.ratio || []).filter(x => x.src === 'manual').length;
    await execute(draft => {
        updateP(draft, pid, { ratio: '9.99' }, { manualFields: ['ratio'] });
        return true;
    });
    eq((AppState.nodes[pid].values.ratio || []).filter(x => x.src === 'manual').length, manualBefore,
        '敲了字但值没变 → 不记 manual（"动了" ∧ "变了" 两条都要满足）');

    // 8) ★ 另一半：**连续手改不该攒出多条 manual**。
    //    手改表达的是"我现在要什么"，不是"我历史上改过什么"；
    //    而 manual 优先级最高，一条过时的手改值会永远压着所有来源。
    await execute(draft => { updateP(draft, pid, { ratio: '8.88' }, { manualFields: ['ratio'] }); return true; });
    await execute(draft => { updateP(draft, pid, { ratio: '7.77' }, { manualFields: ['ratio'] }); return true; });
    const manuals = (AppState.nodes[pid].values.ratio || []).filter(x => x.src === 'manual');
    eq(manuals.length, 1, `连续手改只留一条 manual：${JSON.stringify(manuals)}`);
    eq(manuals[0].v, '7.77', '留下的是最新那次手改');

    // 清理，别让 #field-ratio 留在 document 上
    input.remove();
    details.remove();
}

// ===============================================================
group('回归：点「选择导入文件」→ 预览（用户实际路径）');
// ===============================================================
// 背景：Tab 的按钮若写成 `() => onPickFiles()`（漏传 container），
// 点一下就在 renderPanel 里抛 "Cannot set properties of undefined"。
// 这一组**真的点按钮**，把那条路径钉死。
{
    seedState();
    addPlatform('qoj', 'QOJ');

    // 桩：把"用户选了文件"塞进 input.onchange，并在 click() 时触发
    const realCreateElement = document.createElement.bind(document);
    let pendingFiles = [];
    document.createElement = (tag) => {
        const el = realCreateElement(tag);
        if (tag === 'input') {
            el.click = () => {
                el.files = pendingFiles;
                if (typeof el.onchange === 'function') el.onchange({ target: el });
            };
        }
        return el;
    };

    AppState.currentTab = 'main';
    tabs.setupTabs();
    tabs.switchTab('auto-import');

    const pane = document.getElementById('tab-auto-import');
    const btn = pane.querySelector('.ai-pick-btn');
    ok(!!btn, '找到「选择导入文件」按钮');

    // 先空选一次（用户取消）—— 不应抛错
    pendingFiles = [];
    btn.click();
    await new Promise(r => setTimeout(r, 10));
    // ★ 不能写成 `ok(true, '取消选择不会抛错')` —— **永不失败的假绿**。
    //   改成断**可观察的结果**：空选之后**一个批次都没载入**（面板保持"还没有载入导入包"）。
    // 可观察：面板上仍是"还没有载入导入包"（空选不该载入任何批次），
    // 而且**没有把错误写到控制台外的红框**（面板里不出现"载入失败"）。
    ok(/还没有载入导入包/.test(serialize(pane)),
        '★ 取消选择 ⇒ 一个批次都没载入（面板还是"还没有载入导入包"）');
    ok(!/载入失败|无法解析/.test(serialize(pane)), '★ 也没把它当成一次失败的载入');

    // 再选真文件
    pendingFiles = [fakeFile('qoj_problems.json', JSON.stringify(readSample('qoj_problems.json')))];
    btn.click();
    // pickFiles 内部有 focus 兜底计时器，等它跑完
    await new Promise(r => setTimeout(r, 500));

    const htmlAfterClick = serialize(pane);
    // 注意：serialize 读的是 _html/_text，不输出 className 属性，
    // 所以这里按**文本**断言，而不是按 class 名。
    ok(/新增/.test(htmlAfterClick) && /错误/.test(htmlAfterClick),
        '点击后渲染出汇总（不再抛 "Cannot set properties of undefined"）');
    ok(/新增 14/.test(htmlAfterClick), '汇总显示新增 14（平台已存在）');
    ok(!!pane.querySelector('.ai-execute-btn'), '渲染出执行按钮');
    ok(!!pane.querySelector('.ai-record-row'), '渲染出逐条计划表');
    // ★ ③ 记录表的「操作」格（🔎/📋）：**新增行一个入口都不给** ——
    //   树上还没有这个节点（`plan.records[*].nodeId` 为 null），画成可点就是"点了没反应的假链接"。
    //    （单元格是 `tr.innerHTML` 渲出来的 ⇒ 断言同样落在 `serialize()` 的串上。）
    {
        const firstRow = pane.querySelector('.ai-record-row');
        ok(!serialize(firstRow).includes('data-reveal-node')
            && !serialize(firstRow).includes('btn-node-info'),
        '★ 全新导入（树上都还没有）⇒ 记录表一行都不带 🔎/📋');
    }

    // 再点执行按钮 → 真的写进 AppState
    const execBtn = pane.querySelector('.ai-execute-btn');
    eq(execBtn.disabled, false, '有变更时执行按钮可用');
    execBtn.click();
    await new Promise(r => setTimeout(r, 80));

    const byKey = {};
    for (const id in AppState.nodes) {
        const n = AppState.nodes[id];
        if (n && n.extKey) byKey[n.extKey] = n;
    }
    ok(!!byKey['qoj:4113:20236'], '点按钮执行后节点真的进了主树');
    ok(/跳过/.test(serialize(pane)), '执行后预览自动重算，显示为「跳过」（幂等的可视证据）');

    document.createElement = realCreateElement;
}

// ===============================================================
group('回归：容器为空时必须重挂（刷新/切回后不空白）');
// ===============================================================
// 背景：tabs.js 的 mountPluginTab 若只比较 id 就直接 return，
// 若"记录说已挂载、容器实际为空"，该页会永久卡成空白。
// 这里把"容器被清空后再次 setupTabs 必须重新渲染"钉死。
{
    AppState.currentTab = 'main';
    tabs.setupTabs();
    tabs.switchTab('auto-import');

    const pane = document.getElementById('tab-auto-import');
    ok(!!pane.querySelector('.ai-pick-btn'), '前提：插件页已渲染');

    // 模拟"容器被清空"（真实里可能来自框架重渲染、缓存模块等）
    pane.innerHTML = '';
    eq(pane.children.length, 0, '容器已清空');

    // 再次走启动路径
    tabs.setupTabs();

    ok(!!pane.querySelector('.ai-pick-btn'),
        '容器为空时 setupTabs 会重新挂载（不再卡成空白）');
}

// ===============================================================
group('回归：冷启动落在插件页时必须创建容器（所有插件页通病）');
// ===============================================================
// 背景：setupTabs()（冷启动路径）**没有** ensureTabContent 这一步，
// 而容器是按需创建的 → mountPluginTab 里 getElementById 返回 null → 静默 return。
// 症状：刷新后插件页按钮高亮、内容空白；点别的 Tab 再切回来才好。
// ProblemSearch 与 AutoImport 都受影响。这条用例复现"容器不存在"的冷启动。
//
// 造法：把容器从 DOM 上摘掉（等价于新页面里它还没被创建），
// 再走一次 setupTabs —— 这正是刷新后的第一条路径。
{
    AppState.currentTab = 'main';
    tabs.setupTabs();
    tabs.switchTab('auto-import');

    // 摘掉容器，模拟"新页面尚未创建它"
    const existing = document.getElementById('tab-auto-import');
    ok(!!existing, '前提：容器此前存在');
    existing.remove();
    eq(document.getElementById('tab-auto-import'), null, '前提：容器已摘除（模拟冷启动）');

    // 冷启动路径
    tabs.setupTabs();

    const pane = document.getElementById('tab-auto-import');
    ok(!!pane, 'setupTabs 会在容器缺失时创建它');
    ok(!!pane.querySelector('.ai-pick-btn'),
        '并完成挂载（刷新后不再空白）');
}

// ===============================================================
group('回归：切回树形模式必须收起插件面板');
// ===============================================================
// 背景：插件面板是**独立于内置容器**的 DOM 节点（由 folderViewHost 创建）。
//
// ⚠️ 断言必须打到真实路径上：只断言 hideAllPluginPanels() 本身等于没覆盖 ——
//    真正的失败点在 **renderTree() 在树形分支提前 return**，
//    压根走不到 renderFolderViewTabs —— 于是"函数测过了"但线上依旧坏。
//    所以这里断言 **resetViewContainers()**（两种模式的公共重置点）。
{
    AppState.currentTab = 'main';
    tabs.setupTabs();

    // 直接造一个"可见的插件面板"，**不经 mountFolderView** ——
    // 否则前面那一步可能已经把面板设成 hidden，用例即使没有修复也会"通过"。
    // （只断言结果、不证明是这条路径造成的，就会放过这种假绿。）
    const panelId = 'folder-view-panel-probe-tree-mode';
    const panel = document.createElement('div');
    panel.id = panelId;
    panel.className = 'folder-view-panel';
    panel.style.display = 'block';
    document.getElementById('tree-container').appendChild(panel);
    eq(panel.style.display, 'block', '前提：造出一个可见的插件面板');

    // 走**真实路径**：renderTree() 每次开头都会调 resetViewContainers
    folderShared.resetViewContainers();

    eq(panel.style.display, 'none',
        'resetViewContainers 收起插件面板（树形模式的真实路径）');

    // 幂等
    folderShared.resetViewContainers();
    eq(panel.style.display, 'none', '重复重置是安全的');
    ok(document.getElementById(panelId) === panel,
        '只隐藏、不删除容器（切回文件夹模式时还能复用）');
}

// ===============================================================
group('更换 extKey：表单、强警告、清空、可撤销');
// ===============================================================
{
    seedState();
    const pid = addPlatform('qoj', 'QOJ');
    const pA = createNode('pA', 'P', { name: 'All Closed', problemId: 'A', extKey: 'old:key' });
    AppState.nodes.pA = pA;
    AppState.childOrder.pA = [];
    AppState.childOrder[pid].push('pA');
    AppState.parentOf.pA = pid;

    const host2 = document.createElement('div');
    document.body.appendChild(host2);
    panelMod.renderExtKeyPanel(host2, { nodeId: pid, node: AppState.nodes[pid] });

    // ---- 列表现在用真实 DOM 构建，"更换"按钮可查得到 ----
    const changeBtn = host2.querySelector('.ai-extkey-change');
    ok(!!changeBtn, '每个节点都有「更换」按钮（真实元素，可查询）');

    // ---- 点开表单：必须先看到强警告 ----
    changeBtn.click();
    const form = host2.querySelector('.ai-extkey-change-form');
    ok(!!form, '点「更换」后原地展开表单');

    const formText = serialize(form);
    ok(/单向操作/.test(formText), '表单里明确写了"单向操作"');
    ok(/下一次导入会新建一个节点/.test(formText), '讲清了后果：下次导入会新建节点');
    ok(/题解不会丢/.test(formText), '讲清了被换 key 的节点题解不丢');
    ok(/清空身份/.test(formText), '说明了留空 = 清空身份（救援通道）');

    const input = host2.querySelector('.ai-change-input');
    ok(!!input, '有输入框');
    eq(input.value, 'old:key', '输入框预填当前 key');

    // ---- ① 取消确认时绝不能改数据 ----
    const realConfirm = window.confirm;
    window.confirm = () => false;
    input.value = 'new:key';
    host2.querySelector('.ai-change-confirm').click();
    await new Promise(r => setTimeout(r, 30));
    eq(AppState.nodes.pA.extKey, 'old:key', '用户在确认框点"取消" → key 不变');

    // ---- ② 确认后才生效 ----
    window.confirm = () => true;
    host2.querySelector('.ai-change-confirm').click();
    await new Promise(r => setTimeout(r, 60));
    eq(AppState.nodes.pA.extKey, 'new:key', '确认后 key 真的换了');

    // ---- ③ 清空（救援通道）----
    host2.innerHTML = '';
    panelMod.renderExtKeyPanel(host2, { nodeId: pid, node: AppState.nodes[pid] });
    host2.querySelector('.ai-extkey-change').click();
    const input2 = host2.querySelector('.ai-change-input');
    input2.value = '';
    host2.querySelector('.ai-change-confirm').click();
    await new Promise(r => setTimeout(r, 60));
    eq(AppState.nodes.pA.extKey, '', '留空 + 确认 → 清空身份');
    window.confirm = realConfirm;

    // ---- ④ 目标 key 被别的节点占用 → 拒绝，且表单里给出原因 ----
    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换成可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    const pB = createNode('pB', 'P', { name: 'Bread', problemId: 'B', extKey: 'taken' });
    AppState.nodes.pB = pB;
    AppState.childOrder.pB = [];
    AppState.childOrder[pid].push('pB');
    AppState.parentOf.pB = pid;

    host2.innerHTML = '';
    panelMod.renderExtKeyPanel(host2, { nodeId: pid, node: AppState.nodes[pid] });
    const btns = host2.querySelectorAll('.ai-extkey-change');
    const btnA = btns.find(b => b.closest('tr').dataset.node === 'pA');
    const realConfirm2 = window.confirm;
    window.confirm = () => true;
    btnA.click();
    const input3 = host2.querySelector('.ai-change-input');
    input3.value = 'taken';
    host2.querySelector('.ai-change-confirm').click();
    await new Promise(r => setTimeout(r, 60));

    ok(/已被节点/.test(serialize(host2.querySelector('.ai-change-form')
        || host2.querySelector('.ai-extkey-change-form') || host2)),
        '占用冲突时把原因显示在表单里');
    eq(AppState.nodes.pA.extKey, '', '冲突时不写入');
    eq(AppState.nodes.pB.extKey, 'taken', '持有者不受影响');
    window.confirm = realConfirm2;
}

// ===============================================================
group('根节点的 extKey（列表里看不到它，必须能单独设置）');
// ===============================================================
{
    seedState();
    const rootId = AppState.rootId;

    // 列表只列子节点 → 根不在其中。这块表单是根节点的唯一入口。
    const host3 = document.createElement('div');
    document.body.appendChild(host3);
    panelMod.renderExtKeyPanel(host3, { nodeId: rootId, node: AppState.nodes[rootId] });

    ok(!!host3.querySelector('.ai-self-key-box'), '渲染出"当前文件夹自身 extKey"区块');
    const input = host3.querySelector('.ai-self-key-input');
    ok(!!input, '有根节点 extKey 输入框');
    eq(input.value, '', '根节点初始无 key');

    // 根节点不在子节点列表里（这正是需要单独表单的原因）
    eq(host3.querySelectorAll('.ai-extkey-row').length, 0, '根文件夹下没有子节点行');

    // ---- 补空：无需二次确认 ----
    const realConfirm = window.confirm;
    let confirmCalled = 0;
    window.confirm = () => { confirmCalled++; return true; };

    input.value = 'acmtree:root';
    host3.querySelector('.ai-self-key-save').click();
    await new Promise(r => setTimeout(r, 60));

    eq(AppState.nodes[rootId].extKey, 'acmtree:root', '根节点的 extKey 已写入');
    eq(confirmCalled, 0, '补空不需要二次确认（与"只补空的"语义一致）');

    // ---- 已有值 → 更换必须二次确认 ----
    host3.innerHTML = '';
    panelMod.renderExtKeyPanel(host3, { nodeId: rootId, node: AppState.nodes[rootId] });
    const input2 = host3.querySelector('.ai-self-key-input');
    eq(input2.value, 'acmtree:root', '再次打开时预填根节点现有 key');
    eq(host3.querySelector('.ai-self-key-save').textContent, '更换',
        '已有值时按钮文案变为「更换」（提示这是危险操作）');

    input2.value = 'root2';
    window.confirm = () => false;      // 用户取消
    host3.querySelector('.ai-self-key-save').click();
    await new Promise(r => setTimeout(r, 40));
    eq(AppState.nodes[rootId].extKey, 'acmtree:root', '取消确认 → 根 key 不变');

    window.confirm = () => true;
    host3.querySelector('.ai-self-key-save').click();
    await new Promise(r => setTimeout(r, 60));
    eq(AppState.nodes[rootId].extKey, 'root2', '确认后根 key 真的换了');

    // ---- 冲突保护同样适用 ----
    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    const w2 = createNode('w_dup', 'W', { name: 'dup', extKey: 'taken-key' });
    AppState.nodes.w_dup = w2;
    AppState.childOrder.w_dup = [];
    AppState.childOrder[rootId].push('w_dup');
    AppState.parentOf.w_dup = rootId;

    host3.innerHTML = '';
    panelMod.renderExtKeyPanel(host3, { nodeId: rootId, node: AppState.nodes[rootId] });
    const input3 = host3.querySelector('.ai-self-key-input');
    input3.value = 'taken-key';
    window.confirm = () => true;
    host3.querySelector('.ai-self-key-save').click();
    await new Promise(r => setTimeout(r, 60));
    eq(AppState.nodes[rootId].extKey, 'root2', '目标 key 被占用时不写入');
    ok(/已被节点/.test(serialize(host3)), '冲突原因显示在界面上');

    window.confirm = realConfirm;
}

// ===============================================================
group('extKey 全局唯一不变量');
// ===============================================================
eq(collectExtKeyConflicts(AppState).length, 0, '导入后树上没有重复 extKey');

// ===============================================================
group('目录轮询：纯判定');
// ===============================================================
eq(watcher.isCrateFileName('a.json'), true, '认得 .json');
eq(watcher.isCrateFileName('a.json.gz'), true, '认得 .json.gz');
eq(watcher.isCrateFileName('a.gz'), true, '认得 .gz');
eq(watcher.isCrateFileName('a.txt'), false, '不认 .txt');
eq(watcher.isCrateFileName('notes.md'), false, '不认 .md');

const cleanPlan = { summary: { create: 3, update: 0, errors: 0 } };
const dirtyPlan = { summary: { create: 3, update: 0, errors: 1 } };
const hugePlan = { summary: { create: 5000, update: 0, errors: 0 } };
eq(watcher.shouldAutoApply(cleanPlan, { autoApply: false }), false, '默认不自动应用');
eq(watcher.shouldAutoApply(cleanPlan, { autoApply: true }), true, '显式开启且零错误 → 允许');
eq(watcher.shouldAutoApply(dirtyPlan, { autoApply: true }), false, '有错误 → 拒绝自动应用');
eq(watcher.shouldAutoApply(hugePlan, { autoApply: true }), false, '超出上限 → 拒绝自动应用');

// ===============================================================
group('文件夹视图以当前文件夹为目标');
// ===============================================================
// ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换可变副本
AppState.childOrder = { ...AppState.childOrder };
AppState.parentOf = { ...AppState.parentOf };
const noKeyNode = createNode('noKey', 'S', { name: '没有键的系列' });
AppState.nodes.noKey = noKeyNode;
AppState.childOrder.noKey = [];
AppState.childOrder[AppState.rootId].push('noKey');
AppState.parentOf.noKey = AppState.rootId;

const forced = await ai.loadFiles([fakeFile('x.json', problemsText)], { forcedParentExtKey: 'noKey' });
eq(forced.length, 1, '载入 1 个批次');
ok(/没有 extKey/.test(forced[0].error), '目标文件夹缺 extKey 时给出可行动的错误');

// ===============================================================
group('导入归认：账户线索 → accountId → 来源层 account');
// ===============================================================
// 端到端那条链：crate 的元列 `账户线索` → plan.accountClue →
// apply 查 `state.accounts[*].mappings` → 值上带 account。
// 三类结果（认出 / 填了但没匹配上 / 源没给线索）都要**分别**报出来。
{
    seedState();
    addPlatform('xcpc', 'XCPC');
    // 账户注册表：id 是乱码（API-key 类似物），name 只是给人看的
    AppState.accounts.k1 = {
        id: 'k1', name: '主号', nature: '本人在 CF 的号',
        mappings: [{ source: 'cf', field: 'handle', value: 'alice' }]
    };
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';

    const clueCrate = JSON.stringify({
        crateVersion: 1,
        source: { id: 'cf-adapter' },
        fieldMap: {},
        records: [
            { 节点类型: 'S', extKey: 'cx:s', 父extKey: 'xcpc', name: '系列' },
            { 节点类型: 'C', extKey: 'cx:s:c', 父extKey: 'cx:s', name: '比赛' },
            { 节点类型: 'P', extKey: 'cx:s:c:A', 父extKey: 'cx:s:c', name: '题A', problemId: 'A' },
            { 节点类型: 'R', extKey: 'cx:s:c:A:r1', 父extKey: 'cx:s:c:A', status: 'AC', time: '2026.09.13 22:06',
              link: 'https://qoj.ac/submission/1',
              账户线索: { source: 'cf', field: 'handle', value: 'alice' } },
            { 节点类型: 'R', extKey: 'cx:s:c:A:r2', 父extKey: 'cx:s:c:A', status: 'WA', time: '2026.09.13 22:04',
              账户线索: { source: 'cf', field: 'handle', value: '没登记过的号' } },
            { 节点类型: 'R', extKey: 'cx:s:c:A:r3', 父extKey: 'cx:s:c:A', status: 'TLE', time: '2026.09.13 22:04' }
        ]
    });
    const bc = await ai.loadFiles([fakeFile('cf-clue.json', clueCrate)]);
    eq(bc[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(bc[0].plan.errors)}`);

    // 线索必须被搬到计划上 —— 否则 apply 那边永远查不到
    const prec = bc[0].plan.records.find(r => r.extKey === 'cx:s:c:A:r1');
    eq(prec.accountClue && prec.accountClue.value, 'alice', '线索随记录进计划');
    // 线索是**元列**：不能变成业务字段、也不能被报成"未使用列"
    ok(!('账户线索' in (prec.fields || {})), '线索不进业务字段');
    ok(!(prec.unusedColumns || []).includes('账户线索'), '线索不报「未使用列」');

    const resc = await applyPlans({ state: AppState, items: [{ plan: bc[0].plan, source: 'cf-adapter' }] });
    eq(resc.ok, true, `执行成功：${resc.error || ''}`);
    eq(resc.accounts.matched, 1, '认出 1 条');
    eq(resc.accounts.unmatched, 1, '填了线索但没匹配上 1 条');
    // 预览口径（loadFiles 出来的计划里就带着）——用户该在**点导入之前**看到
    eq(bc[0].plan.summary.accounts.matched, 1, '预览也能看出会认到 1 条');
    eq(bc[0].plan.summary.accounts.unmatched, 1, '预览也能看出有 1 条认不出');
    eq(prec.accountId, 'k1', '计划里就写好了会认到哪个账户');
    // 「源没给线索」是**逐记录**数的，容器（S/C/P）本来也没有账户可言 ——
    // 所以这里是 3 个容器 + 1 条没线索的提交 = 4。（这也是为什么它只在
    // 导入记录里留个数字，不弹提示：用户没有可行动作。）
    eq(resc.accounts.noClue, 4, `源没给线索的记录数（含 3 个容器）：${JSON.stringify(resc.accounts)}`);

    const nodeOf = key => Object.values(AppState.nodes).find(n => n && n.extKey === key);
    const nr1 = nodeOf('cx:s:c:A:r1');
    eq(nr1.values.status[0].account, 'k1', `认出来的值带账户：${JSON.stringify(nr1.values.status)}`);
    eq(nr1.values.status[0].src, 'cf-adapter', '来源没被账户顶掉');
    // 归属是**记录级**的：同一条提交的每个字段都该带同一个账户
    // （"这条提交关于谁"对 time/link 同样成立）。
    eq(nr1.values.time[0].account, 'k1', '同一条提交的时间也带账户');
    eq(nr1.values.link[0].account, 'k1', '同一条提交的链接也带账户');
    // 认不出来的**不猜**：值照样记（客观事实），但 account 为空
    const nr2 = nodeOf('cx:s:c:A:r2');
    eq(nr2.values.status[0].account, undefined, '没匹配上 → 不带账户（不猜）');
    const nr3 = nodeOf('cx:s:c:A:r3');
    eq(nr3.values.status[0].account, undefined, '没有线索 → 不带账户');
    // 缓存字段不受账户层影响（A1：账户是**来源层**的维度）
    eq(nr1.status, 'AC', '缓存字段照旧由 v7 策略写');
}

// ===============================================================
group('链接分类：C 的 link 由应用层从分类派生（端到端）');
// ===============================================================
// 背景：爬取层**不写** C 的 `link`，改写元列 `链接分类`
// （"数据爬取部分不应该有『存在多值时排除一些值』的逻辑"）。
// **所有类别的链接都进 `link` 一个字段**（`boardLink` 不存在），界面上按类别分组显示。
// 这条路必须在**真实导入链**上通：parseCrate → buildPlan → applyPlans → node.values。
{
    const linkCrate = JSON.stringify({
        crateVersion: 1,
        source: { id: 'xcpcio-chengdu', kind: 'board' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'lk', name: 'XCPC' },
            { 节点类型: 'S', extKey: 'lk:s', 父extKey: 'lk', name: '系列' },
            {
                节点类型: 'C', extKey: 'lk:s:c', 父extKey: 'lk:s', name: '成都站',
                contestTime: '2025.11.09 09:00',
                链接分类: {
                    board: [{ v: 'https://board.xcpcio.com/icpc/50th/chengdu', src: 'xcpcio-chengdu' }],
                    problems: [{ v: 'https://qoj.ac/contest/2567', src: 'qoj-chengdu' }],
                    repo: [{
                        v: 'https://github.com/algoux/srk-collection/blob/master/official/icpc/icpc2025/icpc2025chengdu.srk.json',
                        src: 'rankland-index-chengdu'
                    }],
                    unknown: [{ v: 'https://ccpc.io/', src: 'cf-web-chengdu' }]
                }
            }
        ]
    });
    const bLink = await ai.loadFiles([fakeFile('link-kinds.json', linkCrate)]);
    eq(bLink[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(bLink[0].plan.errors)}`);

    const precLink = bLink[0].plan.records.find(r => r.extKey === 'lk:s:c');
    eq(precLink.fields.link, 'https://qoj.ac/contest/2567', '计划里 link = 补题（有补题时优先）');
    eq(precLink.linkKindsByField && precLink.linkKindsByField.link, 'problems', '缓存值的类别');
    // 元列本身不能变成业务字段、也不能被报成"未使用列"
    ok(!('链接分类' in (precLink.fields || {})), '链接分类不进业务字段');
    ok(!(precLink.unusedColumns || []).includes('链接分类'), '链接分类不报「未使用列」');

    const resLink = await applyPlans({ state: AppState, items: [{ plan: bLink[0].plan, source: 'xcpcio-chengdu' }] });
    eq(resLink.ok, true, `执行成功：${resLink.error || ''}`);

    const nC = Object.values(AppState.nodes).find(n => n && n.extKey === 'lk:s:c');
    ok(!!nC, 'C 节点已建出');
    // ★ 这就是"应用里看不到链接"要钉住的东西：**缓存字段**
    eq(nC.link, 'https://qoj.ac/contest/2567', '缓存字段 link 已派生');
    ok(!('boardLink' in nC) || nC.boardLink === undefined || nC.boardLink === '',
        'boardLink 已彻底退场');
    // 来源层：**所有类别都在 `link`**，每条带出处与类别
    const vals = nC.values.link || [];
    eq(vals[0].v, 'https://qoj.ac/contest/2567', '来源层第一条是补题');
    eq(vals[0].src, 'qoj-chengdu', '补题值的出处 = QOJ（不是包来源）');
    eq(vals[0].linkKind, 'problems', '来源值带类别');
    const kinds = vals.map(x => `${x.linkKind}|${x.v}`);
    ok(kinds.includes('board|https://board.xcpcio.com/icpc/50th/chengdu'), '榜单也在 link 里');
    ok(kinds.includes('repo|https://github.com/algoux/srk-collection/blob/master/official/icpc/icpc2025/icpc2025chengdu.srk.json'),
        `仓库类链接必须留下：${JSON.stringify(kinds)}`);
    ok(kinds.includes('unknown|https://ccpc.io/'), `其它类链接必须留下：${JSON.stringify(kinds)}`);
    // 选中的那条只出现一次（落选值里不许重复）
    eq(vals.filter(x => x.v === 'https://qoj.ac/contest/2567').length, 1, '选中的值不重复进来源层');
    // 每一条都要有类别（否则界面上会掉进「未分类」组）
    eq(vals.every(x => !!x.linkKind), true, '来源层每条链接都带类别');
}

// ===============================================================
group('分类依据：元列 → 节点（端到端）—— 依据徽标的数据面');
// ===============================================================
// 口径："引入『可信度级别』概念" —— 爬虫把"这条分类是哪条规则判出来的"
// 写进元列 `分类依据`，应用只在界面上查级别表（`core/natureConfidence.js`）。
// 这条路必须在**真实导入链**上通：parseCrate → buildPlan → applyPlans → 节点上的键。
// 三件事：① 有规则的字段 ⇒ 落到节点上；② **没写进去的字段的规则不许落**
//（策略保留了别人的值，规则描述的就是"别人的值"了）；③ 人改分类 ⇒ 那条规则被清掉。
{
    const ruleCrate = JSON.stringify({
        crateVersion: 1,
        source: { id: 'qoj-x', kind: 'board' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'rr', name: 'QOJ' },
            { 节点类型: 'S', extKey: 'rr:s', 父extKey: 'rr', name: '系列' },
            {
                节点类型: 'C', extKey: 'rr:s:c1', 父extKey: 'rr:s', name: '甲场',
                natureClass: 'qoj/xcpc/icpc/ec/pre/official', natureYear: '2024',
                // ⚠️ `natureRegion` 这一条**故意没有值**（比赛不写地区）⇒ 它的规则**不许落**：
                //    规则描述的是"那个值"，字段根本没写进去就没有可描述的对象。
                分类依据: { natureClass: 'qoj:path-icpc', natureRegion: 'gym:infer-region' }
            },
            {
                节点类型: 'C', extKey: 'rr:s:c2', 父extKey: 'rr:s', name: '乙场',
                natureClass: 'qoj/无归类',
                分类依据: { natureClass: 'qoj:unclassified' }
            }
        ]
    });
    const bRule = await ai.loadFiles([fakeFile('class-rules.json', ruleCrate)]);
    eq(bRule[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(bRule[0].plan.errors)}`);
    const prec = bRule[0].plan.records.find(r => r.extKey === 'rr:s:c1');
    ok(!!prec.classRules && prec.classRules.natureClass === 'qoj:path-icpc',
        '计划记录上带 `classRules`（从元列读出来，原样搬运）');
    ok(!('分类依据' in (prec.fields || {})), '元列不进业务字段');

    const resRule = await applyPlans({ state: AppState, items: [{ plan: bRule[0].plan, source: 'qoj-x' }] });
    eq(resRule.ok, true, `执行成功：${resRule.error || ''}`);

    const n1 = Object.values(AppState.nodes).find(n => n && n.extKey === 'rr:s:c1');
    const n2 = Object.values(AppState.nodes).find(n => n && n.extKey === 'rr:s:c2');
    ok(!!n1 && !!n2, '两个 C 节点都建出来了');
    eq(JSON.stringify(n1['分类依据']), JSON.stringify({ natureClass: 'qoj:path-icpc' }),
        '★ 规则落到节点上（界面 `classLevelOf` 读的就是它）');
    eq(n1['分类依据'].natureRegion, undefined,
        '★ 没写进去的字段的规则**不落**（`natureRegion` 这条记录根本没写值）');
    eq(classLevelOf(n1), 'A', '★ 查级别表 ⇒ A 权威（QOJ 分类路径）');
    eq(classLevelOf(n2), 'E', '`qoj:unclassified` ⇒ E 无依据');

    // ★ 人改分类 ⇒ 标成 M（人工）：那条规则描述的已经不是现在这个值了，
    //   而"这个值凭什么"的答案是**人**（"手改的 nature 可以标为 M"）。
    const n1id = n1.id;
    const { updateWS } = await import(mod('core/ops/node.js'));
    const { execute } = await import(mod('shell/executor.js'));
    // ⚠️ 操作必须返回**原语**：`updateWS` 返回的是节点（draft 代理），
    //    事务提交后那个代理会被 revoke，直接当返回值用会炸（"proxy has been revoked"）。
    await execute(draft => { updateWS(draft, n1id, { natureClass: 'qoj/ucup' }); return 1; });
    const n1b = AppState.nodes[n1id];
    eq(n1b.natureClass, 'qoj/ucup', '（前提）分类改掉了');
    eq(classLevelOf(n1b), 'M', '★ 人改过 ⇒ 依据变 M（不是"没有依据"，是"人定的"）');
}

// ===============================================================
group('分类依据：**重导一次**就能补上（`分类依据` 不进指纹 ⇒ 走的是 skip 分支）');
// ===============================================================
// 这是**真正的上线路径**：老包（没有 `分类依据`）已经导过了，节点上有分类、没有依据；
// 新包**业务字段一个字没变**、只多了一列元信息 ⇒ 指纹相同 ⇒ 计划里那一条是 `skip`。
// 若不在这条路上也补依据，"重导一次让徽标亮起来"就会落空（而库里 1426 个 C 全是这种情况）。
{
    const body = rules => JSON.stringify({
        crateVersion: 1,
        source: { id: 'qoj-re', kind: 'board' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'rd', name: 'QOJ' },
            { 节点类型: 'S', extKey: 'rd:s', 父extKey: 'rd', name: '系列' },
            {
                节点类型: 'C', extKey: 'rd:s:c', 父extKey: 'rd:s', name: '重导场',
                natureClass: 'qoj/xcpc/icpc/ec/regional/official', natureYear: '2025',
                ...rules
            }
        ]
    });
    // ① 老包（没有那一列）
    const bOld = await ai.loadFiles([fakeFile('re-old.json', body({}))]);
    eq(bOld[0].plan.summary.errors, 0, `老包预览无错误：${JSON.stringify(bOld[0].plan.errors)}`);
    eq(await applyPlans({ state: AppState, items: [{ plan: bOld[0].plan, source: 'qoj-re' }] }).then(r => r.ok),
        true, '老包执行成功');
    const node = Object.values(AppState.nodes).find(n => n && n.extKey === 'rd:s:c');
    ok(!!node, '节点建出来了');
    eq(classLevelOf(node), '', '（前提）老包没有依据 ⇒ 没有徽标');

    // ② 新包：**业务字段一模一样**，只多了 `分类依据`
    const bNew = await ai.loadFiles([fakeFile('re-new.json', body({
        分类依据: { natureClass: 'qoj:path-icpc' }
    }))]);
    eq(bNew[0].plan.summary.errors, 0, `新包预览无错误：${JSON.stringify(bNew[0].plan.errors)}`);
    const recNew = bNew[0].plan.records.find(r => r.extKey === 'rd:s:c');
    eq(recNew.action, 'skip', '★ 业务字段没变 ⇒ 计划里是 **skip**（`分类依据` 不进指纹；`账户线索` 才进）');
    await applyPlans({ state: AppState, items: [{ plan: bNew[0].plan, source: 'qoj-re' }] });
    const after = Object.values(AppState.nodes).find(n => n && n.extKey === 'rd:s:c');
    eq(after['分类依据'] && after['分类依据'].natureClass, 'qoj:path-icpc',
        '★ 跳过的记录也把依据补上了（否则"重导一次"永远是白导）');

    // ③ 值对不上就不许贴：另一条记录声称的分类与节点上现有的不同
    const bWrong = await ai.loadFiles([fakeFile('re-wrong.json', JSON.stringify({
        crateVersion: 1,
        source: { id: 'other-src', kind: 'script' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'rd', name: 'QOJ' },
            { 节点类型: 'S', extKey: 'rd:s', 父extKey: 'rd', name: '系列' },
            {
                节点类型: 'C', extKey: 'rd:s:c', 父extKey: 'rd:s', name: '重导场',
                natureClass: 'qoj/无归类',
                分类依据: { natureClass: 'qoj:unclassified' }
            }
        ]
    }))]);
    await applyPlans({ state: AppState, items: [{ plan: bWrong[0].plan, source: 'other-src' }] });
    const after2 = Object.values(AppState.nodes).find(n => n && n.extKey === 'rd:s:c');
    eq(after2.natureClass, 'qoj/xcpc/icpc/ec/regional/official', '（前提）分类值没被改（fill-if-empty）');
    eq(after2['分类依据'].natureClass, 'qoj:path-icpc',
        '★ 值对不上 ⇒ 那条规则**不落**（徽标不许描述别人的值）');
}

// ===============================================================
group('性质差异：**导入预览里报出来**（"导入数据不会判断 nature 的差异"）');
// ===============================================================
// 性质四字段是 **fill-if-empty**（人手填过的值不该被一次重导冲掉）⇒
// "包里判成 `xcpc/icpc/ec/regional`、树上写着 `xcpc/icpc`"这种事**悄悄地不发生**：
// 用户既不知道有差异、也不知道树上的值已经旧了。这一组钉：
//   ① 计划里逐字段报出来（`natureChanged` / `rec.natureDiff`）；
//   ② 汇总栏一句「⚠️ 性质不一致 N 条」+「只看这几条」开关；
//   ③ 记录表那一行带 ⚠️ 标记，点开关只留它们（**纯显示**：计数与要写的内容一个字不变）。
{
    const body = (cls, year, rules) => JSON.stringify({
        crateVersion: 1,
        source: { id: 'nd-src', kind: 'script' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'nd', name: 'XCPC' },
            { 节点类型: 'S', extKey: 'nd:s', 父extKey: 'nd', name: '系列' },
            {
                节点类型: 'C', extKey: 'nd:s:c1', 父extKey: 'nd:s', name: '甲站',
                natureClass: cls, natureYear: year, natureSeason: year, ...rules
            },
            // 乙站两条包一模一样 ⇒ 它**不该**算差异（对照组：不是"有 nature 就报"）
            {
                节点类型: 'C', extKey: 'nd:s:c2', 父extKey: 'nd:s', name: '乙站',
                natureClass: 'xcpc/ccpc/pre/official', natureYear: '2024', natureSeason: '2024'
            }
        ]
    });
    // ① 树上先有"浅分类"（= 人手填过的那种）：导一次浅的
    const bShallow = await ai.loadFiles([fakeFile('nd-shallow.json', body('xcpc/icpc', '2024', {}))]);
    eq(await applyPlans({ state: AppState, items: [{ plan: bShallow[0].plan, source: 'nd-src' }] })
        .then(r => r.ok), true, '浅分类那包执行成功');

    // ② 再载入"细分类"的包（分类/年份/赛季都变了，且带着依据规则）
    const bDeep = await ai.loadFiles([fakeFile('nd-deep.json',
        body('xcpc/icpc/ec/regional/official', '2025', { 分类依据: { natureClass: 'xcpc:name-stage' } }))]);
    const pd = bDeep[0].plan;
    eq(pd.summary.errors, 0, `预览无错误：${JSON.stringify(pd.errors)}`);
    eq(pd.summary.natureChanged, 1, '★ 只有真变过的那条算差异（乙站两条一模一样）');
    const recDiff = pd.records.find(r => r.extKey === 'nd:s:c1').natureDiff;
    eq(recDiff.map(d => d.field).join(','), 'natureClass,natureYear,natureSeason',
        '★ 逐字段报：分类 / 年份 / 赛季三个都不一致');
    eq(recDiff[0].oldValue, 'xcpc/icpc', '旧值 = 树上的');
    eq(recDiff[0].newValue, 'xcpc/icpc/ec/regional/official', '新值 = 包里的');
    eq(recDiff[0].rule, 'xcpc:name-stage', '★ 顺带带上"包里这条分类凭什么"（依据规则）');
    eq('natureClass' in pd.records.find(r => r.extKey === 'nd:s:c1').fields, false,
        '★ 报归报：fill-if-empty 仍然**不覆盖**');

    // ③ 界面：汇总栏那一句 + 开关 + 行标记
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = { kind: 'tab', forcedParentId: '', batches: bDeep, selected: 0 };
    ai.renderPanel(host, view);
    ok(!!host.querySelector('.ai-nature-diff-note'), '★ 汇总栏里有一句"性质不一致"');
    ok(/性质不一致 1 条/.test(serialize(host)), '写着条数');
    const marked = host.querySelectorAll('.ai-record-row[data-naturediff="1"]');
    eq(marked.length, 1, '★ 记录表里那一行被标出来');
    const markedHtml = serialize(marked[0]);
    ok(/⚠️ 分类、年份、赛季/.test(markedHtml), '标记里写着"哪几维不一致"');
    // ⚠️ 记录表的单元格是 `tr.innerHTML` 渲出来的，而本冒烟桩**默认不解析 innerHTML**
    //    ⇒ 断在 `serialize()` 出来的 HTML 串上（与文件里其它表格断言同一姿态）。
    ok(/title="[^"]*树上「xcpc\/icpc」→ 包里「xcpc\/icpc\/ec\/regional\/official」[^"]*"/
        .test(markedHtml), '★ 悬停给出"树上 → 包里"的具体值');
    ok(/依据 xcpc:name-stage/.test(markedHtml), '★ 顺带写出"包里这条分类凭什么判的"');

    // ★ ③ 记录表的「操作」格（G5 的后半）：树上 id 是 plan 里**现成的**（`rec.nodeId`）——
    //   有它才画 🔎（`data-reveal-node`，文档级委托）与 📋（`btn-node-info[data-id]`）；
    //   新增行（树上还没有）那格只有一个「—」。正反两条一起钉，别只钉正向。
    {
        const byKey = new Map(pd.records.map(r => [r.extKey, r]));
        let withId = 0;
        for (const tr of host.querySelectorAll('.ai-record-row:not(.ai-synth-row)')) {
            const rec = byKey.get(tr.dataset.extkey);
            const rowHtml = serialize(tr);
            if (rec && rec.nodeId) {
                withId++;
                ok(rowHtml.includes(`data-reveal-node="${rec.nodeId}"`),
                    `★ 树上已有 ⇒ 带 🔎 指向它（${rec.extKey}）`);
                ok(rowHtml.includes(`btn-node-info ai-record-info" data-id="${rec.nodeId}"`),
                    `★ 也带 📋（${rec.extKey}）`);
            } else {
                ok(!rowHtml.includes('data-reveal-node') && !rowHtml.includes('btn-node-info'),
                    `★ 树上还没有这个节点 ⇒ 一个入口都不给（${rec ? rec.extKey : '?'}）`);
            }
        }
        ok(withId > 0, '（前提）夹具里得有"树上已有"的行 —— 否则上面那条正向断言是空转');
    }

    eq(host.querySelectorAll('.ai-record-row').length, 4, '（前提）四条记录都在表里（W + S + 两个 C）');
    host.querySelector('.ai-nature-only-btn').click();
    eq(host.querySelectorAll('.ai-record-row').length, 1, '★ 点「只看这几条」⇒ 只剩性质不一致的那条');
    eq(view.natureOnly, true, '开关状态挂在视图上（重画不丢）');
    ok(/显示全部记录/.test(serialize(host)), '按钮变成「显示全部记录」');
    eq(pd.summary.natureChanged, 1, '★ 纯显示筛选：计数一个字不变');
    host.querySelector('.ai-nature-only-btn').click();
    eq(host.querySelectorAll('.ai-record-row').length, 4, '再点一次 ⇒ 恢复全部');

    // ★ ④ 「以包里为准」：勾上 ⇒ **重算计划** ⇒ 那一行"将写入字段"里出现 natureClass，执行后真的覆盖
    const forceCb = host.querySelector('.ai-nature-force-cb');
    ok(!!forceCb, '★ 有「以包里为准」勾选框（默认不勾）');
    eq(forceCb.checked, false, '默认**关**（只报不改）');
    eq(pd.summary.natureForced, 0, '没勾 ⇒ 0 处覆盖');
    forceCb.checked = true;
    forceCb.dispatchEvent({ type: 'change' });
    eq(view.natureForce, true, '开关状态挂在视图上');
    const forcedPlan = view.batches[0].plan;
    eq(forcedPlan.summary.natureForced, 3, '★ 重算计划：分类 / 年份 / 赛季三处会被覆盖');
    const forcedRec = forcedPlan.records.find(r => r.extKey === 'nd:s:c1');
    eq(forcedRec.fields.natureClass, 'xcpc/icpc/ec/regional/official', '★ 分类进了"要写的字段"');
    eq(forcedRec.fields.natureYear, '2025', '★ 年份也进了');
    eq(forcedRec.action, 'update', '有东西要写 ⇒ 不再 skip');
    ok(/已勾「以包里为准」：本次会覆盖 3 处/.test(serialize(host)), '汇总栏如实报"会覆盖几处"');
    ok(/★ 本次会覆盖/.test(serialize(host)), '表格那一列的 tooltip 标出"本次会覆盖"');
    eq(pd.records.find(r => r.extKey === 'nd:s:c2').fields.natureClass, undefined,
        '对照：乙站没有差异 ⇒ 不受影响');

    // 真导一次：树上的分类/年份被包里的顶掉
    await applyPlans({ state: AppState, items: [{ plan: forcedPlan, source: 'nd-src' }] });
    const ndNode = Object.values(AppState.nodes).find(n => n && n.extKey === 'nd:s:c1');
    eq(ndNode.natureClass, 'xcpc/icpc/ec/regional/official', '★ 勾了之后真的覆盖了树上的分类');
    eq(ndNode.natureYear, '2025', '★ 年份也覆盖了');

    // ⑤ 再载入一份**新包**时开关必须回到"关"（会改数据的开关不能跨批次悄悄留着）
    //    ⚠️ 这份新包的性质与树上**又不一样** —— 否则连勾选框都不画（没差异 → 没得覆盖），
    //       那样测的是"没有差异"，不是"开关复位"。
    const bAgain = await ai.loadFiles([fakeFile('nd-again.json',
        body('xcpc/ccpc/final/official', '2026', {}))]);
    const view2 = { kind: 'tab', forcedParentId: '', batches: bAgain, selected: 0 };
    ai.renderPanel(host, view2);
    const cb2 = host.querySelector('.ai-nature-force-cb');
    ok(!!cb2, '（前提）新包同样有性质差异 ⇒ 勾选框在');
    eq(cb2.checked, false, '★ 新载入的包 ⇒ 开关回默认（关）');
    eq(bAgain[0].plan.summary.natureForced, 0, '★ 而且计划是**没勾**的那一份（没有偷偷覆盖）');
}

// ===============================================================
group('★ 记录表默认只画前 N 行（真包 27408 条时全铺会 30.6MB HTML / 49.3 万标签）');
// ===============================================================
// 症状：一次导入几万条时，预览表把**每一条**都建成 DOM，而外面那层框只有
//   `max-height:420px` ⇒ 绝大多数行永远看不到，却要在每次渲染时全建一遍。
// 做法照 `ui/failures.js` 的先例（`slice(0, LIMIT)` + 一句"还有 N 条"），
//   另加一个**显式**的「显示全部」（点了才付那笔开销）。
// 这一组钉的是**画出来的行数**与那句灰字的数字 —— 桩里能直接数，不需要真浏览器。
{
    const { AI_RECORD_LIMIT, resetRecordTableLimit } = await import(mod('features/AutoImport/ui/recordTable.js'));
    // ⚠️ 期望行数**写字面量**、不从被测常量推：拿 `AI_RECORD_LIMIT` 当期望值的话，
    //    把上限改大（= 取消限行）这条断言会**跟着一起变绿** —— 那是"永远绿"的假守卫
    //    （实测过：把常量改成 999999，用常量当期望值时这一组照样全绿）。
    const N_LIMIT = 250;
    eq(AI_RECORD_LIMIT, N_LIMIT, '（守门）默认上限就是 250 行 —— 改成别的值这条先红');
    const mkRecords = n => Array.from({ length: n }, (_, i) => ({
        extKey: `big:${i}`, type: 'P', action: 'skip', fields: {}, nodeId: null
    }));
    const N_BIG = N_LIMIT + 37;

    const hostBig = document.createElement('div');
    document.body.appendChild(hostBig);
    resetRecordTableLimit();
    ai.renderPanel(hostBig, {
        kind: 'tab', forcedParentId: '', selected: 0,
        batches: [{ plan: { records: mkRecords(N_BIG), synth: { nodes: [] }, summary: { create: 0, update: 0, errors: 0, skip: N_BIG } }, source: 'big' }]
    });

    eq(hostBig.querySelectorAll('.ai-record-row').length, N_LIMIT,
        `★ 全量 plan（${N_BIG} 行）下默认只画前 ${N_LIMIT} 行`);
    const foot = hostBig.querySelector('.ai-record-foot');
    ok(!!foot, '★ 表下面有那句灰字（不是"悄悄截断"）');
    ok(new RegExp(`还有 ${N_BIG - N_LIMIT} 行未显示`).test(serialize(foot)),
        '★ 灰字里的数字 = 总数 - 已画数（37 条没画就说 37 条）');
    ok(/共 \d+ 行/.test(serialize(foot)), '灰字里也写出总行数（用户能判断"还差多少"）');
    const showAllBtn = foot.querySelector('.ai-record-show-all');
    ok(!!showAllBtn, '有一个「显示全部」按钮');
    ok(/卡/.test(showAllBtn.textContent), '★ 按钮文案里注明"会卡"（这是它存在的理由）');

    // ★ 点了才全量画：后面那 37 行必须出现
    showAllBtn.click();
    eq(hostBig.querySelectorAll('.ai-record-row').length, N_BIG,
        '★ 点「显示全部」⇒ 后面的行才出现（全部 N 行都在）');    ok(!hostBig.querySelector('.ai-record-foot') || !hostBig.querySelector('.ai-record-foot').parentNode,
        '全画完之后那句灰字撤掉（没有"还有 0 行"这种废话）');

    // 反面对照：行数不超过上限时**不画**那句灰字、也不给按钮（否则每张小表都挂一颗按钮）
    const hostSmall = document.createElement('div');
    document.body.appendChild(hostSmall);
    resetRecordTableLimit();
    ai.renderPanel(hostSmall, {
        kind: 'tab', forcedParentId: '', selected: 0,
        batches: [{ plan: { records: mkRecords(3), synth: { nodes: [] }, summary: { create: 0, update: 0, errors: 0, skip: 3 } }, source: 'small' }]
    });
    eq(hostSmall.querySelectorAll('.ai-record-row').length, 3, '少量行照旧全画');
    ok(!hostSmall.querySelector('.ai-record-foot'), '★ 没超过上限 ⇒ 不画灰字、不给按钮');

    // 换一批包 ⇒ 复位（别把上一批按下的「显示全部」带过来）
    resetRecordTableLimit();
    ai.renderPanel(hostSmall, {
        kind: 'tab', forcedParentId: '', selected: 0,
        batches: [{ plan: { records: mkRecords(N_BIG), synth: { nodes: [] }, summary: { create: 0, update: 0, errors: 0, skip: N_BIG } }, source: 'big2' }]
    });
    eq(hostSmall.querySelectorAll('.ai-record-row').length, N_LIMIT,
        '★ 复位之后再画大包 ⇒ 回到"只画前 N 行"（不是把上一批的「显示全部」记住）');
}

// ===============================================================
group('一键重建总包（本机接口）→ **自动导入**');
// ===============================================================
// 口径："这个建包的步骤能不能直接在主脚本里放个按钮之类的来触发，最好再自动导入"。
// 命令由本机开发服务器代跑（`scripts/dev-server.py` 的 `/api/build`），页面这边：
//   ① 探活失败（用别的静态服务器打开）⇒ **照常说清原因、不炸**；
//   ② 接口在 ⇒ 起构建 → 轮询日志 → 成功后取包 → 走**既有导入通道** → 计划 0 错误才自动执行。
{
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = { kind: 'tab', forcedParentId: '', batches: [], selected: 0 };
    ai.renderPanel(host, view);
    const buildBtn = host.querySelector('.ai-build-btn');
    ok(!!buildBtn, '★ 工具栏里有「🛠 重建总包并导入」按钮');
    // 口径："主脚本建包又不能手输指令，给个选项" ⇒ 工具栏那个**档位**下拉框。
    // ★ 口径："那『离线』就不能算『不联网』；干脆 5 个档位都进下拉框" ——
    //   「离线」勾选框**并进档位**：一个下拉框 = 一个完整预设（`offline` + `mode` 一起定死）。
    const modeSel = host.querySelector('.ai-build-mode-sel');
    ok(!!modeSel, '★ 工具栏里有「档位」下拉框（本机建包不能手输指令，只能给枚举选项）');
    eq([...modeSel.querySelectorAll('option')].map(o => o.value).join(','),
        'offline,standard,needs,needs-low,probe-all,purge',
        '★ 六档都在下拉框里、且**越轻越前**（离线 → 标准 → 三个补抓档 → **全删重爬**；'
        + '除离线外的五个键与服务器 build_chain.BUILD_MODES 一一对应）');
    ok(!host.querySelector('.ai-offline-cb'),
        '★ 「离线」勾选框不在了（两个控件表达同一件事只会写出别扭的描述 —— 并进档位了）');
    eq(modeSel.value, 'standard', '★ 默认档 = `standard`（不加任何档位时的行为）');
    // 每个预设两个轴都写全（漏一个 ⇒ 面板会按 undefined 发请求）
    const badPreset = BUILD_MODES.find(m => typeof m.offline !== 'boolean' || !m.mode);
    ok(!badPreset, '★ 每个档位都同时给出 `offline`（轴 A）与 `mode`（轴 B）');
    const offOne = BUILD_MODES.find(m => m.key === 'offline') || {};
    ok(offOne.offline === true && offOne.mode === 'standard',
        '★ 「离线重建」= `offline:true` + 标准档（一次不联网；轴 B 不做补抓）');
    const needOnes = BUILD_MODES.filter(m => m.key !== 'offline');
    ok(needOnes.every(m => m.offline === false),
        '★ 五个标准/补抓/全删重爬档都是联网档（离线与补抓是**互斥**的两个轴，不许凑成一个组合）');
    ok(/不联网/.test(offOne.label) && /不联网/.test(offOne.hint),
        '★ 离线的描述把"一次也不联网"说清（它换的是**产包策略**，不是"省一点"）');

    // ★ **暂停按钮**（"加暂停按钮"）——语义是「跑完当前步就停」，
    //   所以判据是"在跑、且没请求过暂停"才可点。这里先把静态那半边钉住。
    const stopBtn0 = host.querySelector('.ai-build-stop');
    ok(!!stopBtn0, '★ 工具栏里有「⏸ 暂停」按钮');
    eq(stopBtn0.disabled, true, '★ 没在跑 ⇒ 不可点（不然点下去只能得到一个"没什么可暂停的"）');

    const realFetch = globalThis.fetch;
    const realFile = globalThis.File;

    // ① 哪儿都没有这个服务器（双击 index.html / 别的静态服务器，且本机没起主脚本）
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: '接口没开' }) });
    buildBtn.click();
    await new Promise(r => setTimeout(r, 50));
    ok(/用不上本机/.test(serialize(host)), '★ 用不上主脚本时把话说明白（不抛、不白点）');
    ok(/试过/.test(serialize(host)), '★ 列出**试过哪些地址**（不然没法排查）');
    ok(/背后\*\*有\*\*服务器/.test(serialize(host)) || /不是主脚本/.test(serialize(host)),
        '★ 页面这个源上有服务器（只是不是主脚本）⇒ 要认出来，别说成"没在跑"');
    ok(/启动AcmTree\.bat/.test(serialize(host)), '★ 指路 启动AcmTree.bat（再双击一次是安全的）');

    // ② 服务器在，但**页面是旧代码**（模块缓存）—— "点了没反应"的真凶之一
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('api/ping')) {
            return {
                ok: true, status: 200,
                json: async () => ({ ok: true, api: API_VERSION, pid: 4242, port: 8000, root: 'D:/repo',
                                     diskBuild: 'v8.5.0-新', pageBuild: 'v8.5.0-旧', stalePage: true, steps: [] })
            };
        }
        throw new Error('旧页面不该走到这里：' + u);
    };
    buildBtn.click();
    await new Promise(r => setTimeout(r, 50));
    ok(/页面是旧代码/.test(serialize(host)), '★ 页面是旧代码 ⇒ 直接说出来');
    ok(/Ctrl\+Shift\+R/.test(serialize(host)), '★ 并给出唯一的动作：刷新页面');

    // ③ 服务器是**还在跑的旧进程**（接口版本低）
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('api/ping')) {
            return { ok: true, status: 200, json: async () => ({ ok: true, api: 1, pid: 1, port: 8000, root: 'D:/repo' }) };
        }
        throw new Error('不该走到这里：' + u);
    };
    buildBtn.click();
    await new Promise(r => setTimeout(r, 50));
    ok(/旧进程/.test(serialize(host)), '★ 接口版本低 ⇒ 判成"旧进程"而不是含糊的 404');

    // ② 接口在：起构建 → 第一次轮询就报"完成" → 取包 → 自动导入
    const pkgText = JSON.stringify({
        crateVersion: 1,
        source: { id: 'built-pkg' },
        fieldMap: {},
        records: [
            { 节点类型: 'W', extKey: 'built', name: '重建出来的平台' },
            { 节点类型: 'S', extKey: 'built:s', 父extKey: 'built', name: '系列' },
            { 节点类型: 'C', extKey: 'built:s:c', 父extKey: 'built:s', name: '重建出来的比赛',
              natureClass: 'xcpc/icpc/ec/regional/official', natureYear: '2024', natureSeason: '2024',
              natureRegion: '南京' }
        ]
    });
    let posted = 0;
    let postedBody = '';
    let stopPosted = 0;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        // ⚠️ 匹配用相对路径（`api/ping`，没有前导斜杠）—— 客户端就是发相对路径
        if (u.includes('api/ping')) {
            return {
                ok: true, status: 200,
                json: async () => ({ ok: true, api: API_VERSION, pid: 4242, port: 8000, root: 'D:/repo',
                                     srcSha: 'abc123', diskBuild: '同一个版本', pageBuild: '同一个版本',
                                     stalePage: false, steps: ['registry', 'nature', 'crate', 'check'] })
            };
        }
        if (u.includes('api/build/stop')) {
            stopPosted++;
            return {
                ok: true, status: 200,
                json: async () => ({
                    ok: true, accepted: true,
                    status: { running: true, stopRequested: true, code: null, steps: [], lines: [] }
                })
            };
        }
        if (u.includes('api/build') && (opts.method || 'GET') === 'POST') {
            posted++;
            postedBody = String(opts.body || '');
            return { ok: true, status: 200, json: async () => ({ ok: true, started: true, status: null }) };
        }
        if (u.includes('api/build')) {
            return {
                ok: true, status: 200,
                json: async () => ({
                    ok: true,
                    status: {
                        running: false, code: 0,
                        cmd: 'build_chain: registry → nature → crate → check', elapsed: 152,
                        steps: [
                            { key: 'registry', title: '注册表（xcpc_registry build）', state: 'ok', seconds: 3.1 },
                            { key: 'crate', title: '产包（xcpc_pipeline --force --all-nodes）', state: 'ok', seconds: 120.4 },
                            { key: 'check', title: '离线试跑（crate-check）', state: 'ok', seconds: 9.5 }
                        ],
                        lines: ['✅ 可写入 22606 个节点', '✅ 已回代 22 处人工填写']
                    }
                })
            };
        }
        // 取包：`blob()` 给一个带 `_text` 的假 blob（FileReader 桩按 `_text` 读）
        return { ok: true, status: 200, blob: async () => ({ _text: pkgText, size: pkgText.length }) };
    };
    // 桩 File：把 blob 的 `_text` 带上，供 FileReader 桩读取
    globalThis.File = class {
        constructor(parts, name, o) {
            this.name = name; this.type = o && o.type;
            this._text = (parts && parts[0] && parts[0]._text) || '';
        }
    };
    try {
        // ★ 档位：选「补抓 + 连"多半拿不到"一起」（= 命令行 `--needs --pursue low`）——
        //   这是点名要的那个选项：本机建包传不了命令，但能选一个**写死的档位**。
        //   ⚠️ 这一档是**联网档** ⇒ 请求体里 offline 必须是 `false`（离线与补抓互斥，别凑一起）。
        modeSel.value = 'needs-low';
        modeSel.dispatchEvent(new Event('change'));
        buildBtn.click();
        await new Promise(r => setTimeout(r, 80));         // 还没到第一次轮询（1.2s）
        eq(posted, 1, '★ 真的 POST 了一次重建');
        ok(/"offline":false/.test(postedBody),
            '★ 联网档 ⇒ 请求体里带 offline:false（服务器只认这一个布尔）');
        ok(/"mode":"needs-low"/.test(postedBody),
            '★ 选了档位 ⇒ 请求体里带 mode（页面能传的第二样，仍然只是个枚举名）');
        ok(/档位：补抓 \+ 连"多半拿不到"一起/.test(serialize(host)),
            '★ 日志里写明这一轮按哪个档位跑（不然"选了没生效"看不出来）');

        // ★ 「离线重建」那一档的请求体：`offline:true` 且 **不带 mode**（它就是"标准档 + 不联网"）。
        //   这里直接喂 `startBuild` 一个假 fetch（不动全局那个），避免为了这一条再跑一整轮重建。
        let offBody = '';
        await startBuild(async (_url, opts = {}) => {
            offBody = String(opts.body || '');
            return { ok: true, status: 200, json: async () => ({ ok: true, started: false, status: null }) };
        }, 'http://127.0.0.1:8000/', !!offOne.offline, offOne.mode);
        ok(/"offline":true/.test(offBody) && !/"mode"/.test(offBody),
            '★ 选「离线重建」⇒ 请求体只有 `offline:true`（mode 是默认档就不发；老服务器照样认）');
        ok(/已开始重建/.test(serialize(host)), '刚点下去就把"已开始"写进日志');
        ok(/已连上/.test(serialize(host)), '★ 连上后自报身份（pid / 端口 / 接口版本 / 源码指纹）');

        // ★ 在跑 ⇒ 暂停可点；点下去 ⇒ POST 暂停接口，按钮自己变成"正在停…"且不可再点
        const stopBtn = host.querySelector('.ai-build-stop');
        eq(stopBtn.disabled, false, '★ 在跑 ⇒ 「⏸ 暂停」可点');
        stopBtn.click();
        await new Promise(r => setTimeout(r, 60));
        eq(stopPosted, 1, '★ 点「⏸ 暂停」⇒ POST 了暂停接口（不是只把按钮变灰）');
        eq(stopBtn.disabled, true, '★ 请求过 ⇒ 不许再点（重复请求没有意义）');
        eq(stopBtn.textContent, '正在停…（跑完当前步）', '★ 文案说清楚"跑完当前步"（不是"立刻停"）');
        ok(/已请求暂停/.test(serialize(host)), '★ 日志里说明：当前这一步会跑完，产物可用');
        // ⚠️ 断言 parentNode（标准语义），不用 host.querySelector(...) === null —— DOM 桩会留陈旧命中
        const logBoxEl = host.querySelector('.ai-build-log');
        ok(!!logBoxEl && logBoxEl.parentNode !== null,
            '★ 点「暂停」**不**关掉日志框（暂停的语义就是"停下来"，顺手关掉日志就看不到进度了）');

        await new Promise(r => setTimeout(r, 1500));       // 轮询间隔 1.2s ⇒ 这一次就该跑完
        // ⚠️ 导入会触发一次 `redraw`（面板清空重画）—— 日志框是**单例**，所以日志还在
        //（下面那条"服务器日志画在页面上"就是"重画没把日志吃掉"的回归点）
        ok(/可写入 22606 个节点/.test(serialize(host)), '★ 服务器日志画在页面上（看得到进度与结论）');
        ok(/重建完成/.test(serialize(host)), '★ 正常跑完说「重建完成」（与「被暂停」分开说）');
        ok(/产包/.test(serialize(host)), '★ 每步进度也画出来（进程内跑 ⇒ 状态是结构化的，不用猜）');
        eq(view.batches.length, 1, '包走的是既有导入通道（批次里有它）');
        eq(view.batches[0].plan.summary.errors, 0, '计划 0 错误');
        // 口径："**最后一步点击导入让用户来**" ⇒ 跑完只把包载进预览，**不自动写盘**。
        ok(!Object.values(AppState.nodes).some(n => n && n.extKey === 'built:s:c'),
            '★ 跑完**不自动执行**（树上还没有它）');
        ok(/请点下面的「▶ 执行导入」/.test(serialize(host)),
            '★ 并且明确告诉他去点「执行导入」');
        const execBtn = host.querySelector('.ai-execute-btn');
        ok(!!execBtn, '★ 预览上就有「▶ 执行导入」这条');
        execBtn.click();
        await new Promise(r => setTimeout(r, 250));
        const built = Object.values(AppState.nodes).find(n => n && n.extKey === 'built:s:c');
        ok(!!built, '★ 用户点一下 ⇒ 才真的导入（节点上树）');
        eq(built && built.natureRegion, '南京', '包里带来的性质也落地了');
    } finally {
        globalThis.fetch = realFetch;
        globalThis.File = realFile;
    }
}


// ===============================================================
group('重建日志框：**不在跑的时候**点框外不消失（✕ 才关），关掉后重画不复活');
// ===============================================================
// 口径（用户 2026-10-16）："让建包的运行信息框可折叠，且**跑完不消失**"。
// ⚠️ 与上面那句老口径（"希望这个黑框在点出页面时关闭 点入也行"）**故意相反**：
//    "点框外就关"只保留给**正在跑**的时候（那会儿轮询重画会把它挂回来，语义是"别挡着用应用"）；
//    跑完（或这一组这种"根本没跑起来"）之后，随手点别处**不该把日志弄丢** —— 那正是用户要看的。
{
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = { kind: 'tab', forcedParentId: '', batches: [], selected: 0 };
    ai.renderPanel(host, view);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ ok: false, error: '接口没开' }) });
    const buildBtn = host.querySelector('.ai-build-btn');
    buildBtn.click();
    await new Promise(r => setTimeout(r, 60));
    const box = host.querySelector('.ai-build-log');
    ok(!!box, '★ 点了按钮就出现日志框');
    ok(!!host.querySelector('.ai-build-close'), '★ 框上有个 ✕');

    // ① 这一轮**没跑起来**（接口没开）⇒ 点框外**留着**（跑完的日志不该一点就没 —— 用户要看的正是它）
    document.body.click();
    await new Promise(r => setTimeout(r, 10));
    ok(!!box.parentNode, '★ 不在跑的时候点框外 ⇒ 框**还在**（跑完不消失）');

    // ② 重画也照样在（它是"留着"的那一份）
    ai.renderPanel(host, view);
    ok(!!box.parentNode, '★ 重画之后仍在（不是"关一下就回来"的反面：它压根不关）');

    // ③ ✕ 才是"关"；关掉之后再重画**不该**复活
    //   ⚠️ 断言 parentNode === null 而不是 host.querySelector(...) === null：
    //      DOM 桩的子树遍历在该场景下会留一个陈旧命中（真实浏览器里没有这回事），
    //      而 parentNode 是标准语义 —— 摘下来了就是 null。
    box.querySelector('.ai-build-close').click();
    await new Promise(r => setTimeout(r, 10));
    ok(!box.parentNode, '★ ✕ 能关');
    ai.renderPanel(host, view);
    ok(!host.querySelector('.ai-build-log') || !box.parentNode,
        '★ 关掉后重画不复活（不是"关一下就回来"）');

    // ④ 再点一次按钮 ⇒ 重新出现（并且**自动展开**：新一次重建就是来看日志的）
    const btn2 = host.querySelector('.ai-build-btn');
    btn2.click();
    await new Promise(r => setTimeout(r, 60));
    const box2 = host.querySelector('.ai-build-log');
    ok(!!box2, '★ 再点一次按钮，日志框回来了');
    eq(box2.querySelector('pre').style.display, '', '★ 新一次重建**自动展开**（上一次收起的状态不带过来）');

    globalThis.fetch = realFetch;
}


// ===============================================================
group('日志框：跑着的时候重画要挂回来（关过也挂）');
// ===============================================================
// 口径：“正在跑时没挂回来” —— 进度不能被藏掉。
{
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = { kind: 'tab', forcedParentId: '', batches: [], selected: 0 };
    ai.renderPanel(host, view);
    const realFetch = globalThis.fetch;
    let finishing = false;
    globalThis.fetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes('api/ping')) {
            return { ok: true, status: 200,
                     json: async () => ({ ok: true, api: API_VERSION, pid: 1, port: 8321, root: 'D:/repo', stalePage: false, steps: [] }) };
        }
        if (u.includes('api/build') && (opts.method || 'GET') === 'POST') {
            return { ok: true, status: 200, json: async () => ({ ok: true, started: true, status: null }) };
        }
        if (u.includes('api/build')) {
            return { ok: true, status: 200,
                     json: async () => ({ ok: true, status: {
                         running: !finishing, code: finishing ? 0 : null, cmd: 'build_chain',
                         elapsed: 3, steps: [], lines: ['跑着呢'] } }) };
        }
        return { ok: false, status: 404, json: async () => ({ ok: false, error: 'x' }) };
    };
    try {
        host.querySelector('.ai-build-btn').click();
        await new Promise(r => setTimeout(r, 1400));       // 第一次轮询 ⇒ running=true
        ok(!!host.querySelector('.ai-build-log'), '跑着的时候日志框在');
        host.querySelector('.ai-build-close').click();
        await new Promise(r => setTimeout(r, 10));
        ok(!host.querySelector('.ai-build-log') || !host.querySelector('.ai-build-log').parentNode,
            '先把它关掉');
        ai.renderPanel(host, view);                        // 切页 / 回来 ⇒ 重画
        ok(!!host.querySelector('.ai-build-log'),
            '★ 还在跑 ⇒ 重画把日志框挂回来（进度不能被藏掉）');
        finishing = true;
        await new Promise(r => setTimeout(r, 1500));       // 让它跑完，定时器自己清掉
    } finally {
        globalThis.fetch = realFetch;
    }
}

// ===============================================================
group('失败明细：面板上能看见"失败在哪"（不只是条数）');
// ===============================================================
// 症状：看到「导入完成：新增 0，更新 0，失败 179」时问"怎么看失败在哪"。
// `perItem[].failures`（`{extKey|synthKey, code, reason}`）若收完就扔，就只剩个条数。
{
    const host = document.createElement('div');
    document.body.appendChild(host);

    // ① 没有失败 ⇒ 不画那块（别占地方、别吓人）
    ai.renderPanel(host, { kind: 'tab', forcedParentId: '', batches: [], selected: 0,
        lastImport: { files: ['a.json'], created: 1, updated: 0, failed: 0, failures: [] } });
    ok(!host.querySelector('.ai-failures'), '没失败就不画红框');

    // ② 有失败 ⇒ 按原因码分组 + 逐条明细（合成节点报 synthKey，普通记录报 extKey）
    ai.renderPanel(host, { kind: 'tab', forcedParentId: '', batches: [], selected: 0,
        lastImport: {
            files: ['all_nodes.json'], created: 0, updated: 0, failed: 3,
            failures: [
                { extKey: 'cf:c:1:p:A', code: 'parent-not-found', reason: '父节点不存在', source: 'cf' },
                { synthKey: 'synth:xcpc:bjcpc2024', code: 'parent-not-found', reason: '父合成节点不存在', source: 'synth' },
                { extKey: 'qoj:c:9', code: 'field-not-applicable', reason: 'C 节点不适用字段：ratio', source: 'qoj' }
            ]
        } });
    const box = host.querySelector('.ai-failures');
    ok(!!box, '有失败就画出红框');
    eq(box.dataset.failed, '3', '条数写在 data-failed（便于断言/排查）');
    const text = serialize(box);
    ok(/失败 3 条/.test(text), '标题带总条数');
    ok(/parent-not-found × 2/.test(text), '按原因码分组（重复的合并计数）');
    ok(/field-not-applicable × 1/.test(text), '第二个原因码也在');
    ok(/cf:c:1:p:A/.test(text), '逐条明细里有普通记录的 extKey');
    ok(/synth:xcpc:bjcpc2024/.test(text), '合成节点报的是 synthKey（它没有 extKey）');
    ok(/C 节点不适用字段：ratio/.test(text), '原因原文在（不是只给个码）');
    eq(box.querySelectorAll('.ai-failure-row').length, 3, '三条明细各一行');

    // ③ 特别多的时候只列前 50 条 + 一句"还有 N 条"（不能把面板刷成墙）
    const many = Array.from({ length: 130 }, (_, i) => ({ extKey: `x:${i}`, code: 'no-node', reason: 'r' }));
    host.innerHTML = '';
    ai.renderPanel(host, { kind: 'tab', forcedParentId: '', batches: [], selected: 0,
        lastImport: { files: ['b.json'], created: 0, updated: 0, failed: 130, failures: many } });
    const box2 = host.querySelector('.ai-failures');
    eq(box2.querySelectorAll('.ai-failure-row').length, 50, '只列前 50 条');
    ok(/还有 80 条/.test(serialize(box2)), '剩下的折成一句话（并提示控制台有全部）');
    eq(box2.dataset.failed, '130', '总条数照实写');
}

// ===============================================================
group('包里的元数据（体检报告 / 应有注册表）：没有记录要写时也得写进状态');
// ===============================================================
// 口径："我不删原包直接导行吗" —— 行：导入是增量合并，已存在的记录值没变就跳过。
// 但"全跳过"这条路上有个**真坑**：那笔事务一旦被短路，`reports` / `fieldRegistry`
// 就写不进状态 ⇒ 表现是"导了包、体检页还说这个包没带报告"。所以：
//   ① 全跳过（树里全有、这次只有报告是新的）⇒ 照写；
//   ② **计划里一条可执行记录都没有**（记录全被拒 / 空包）⇒ 也得写。
{
    const { parseCrate } = await import(mod('features/AutoImport/parse.js'));
    const { buildPlan } = await import(mod('features/AutoImport/plan.js'));
    const { buildExtKeyIndex } = await import(mod('core/ops/upsert.js'));
    const { applyFieldMap: afm2, RESERVED_KEYS: RK } = await import(mod('features/AutoImport/fieldmap.js'));

    const withReports = (records) => ({
        crateVersion: 1, source: { id: 'meta-fixture' },
        fieldMap: { 节点类型: '节点类型', extKey: 'extKey', 父extKey: '父extKey', name: 'name' },
        reports: { coverage: { package: 'x', records: 1, rows: [{ type: 'P', field: 'name', expect: 'required', missing: 0 }], inconsistent: [] },
                   needs: { package: 'y', needs: [] } },
        records
    });
    const planFor = (raw) => {
        const parsed = parseCrate(raw, {});
        return buildPlan({
            crate: parsed.crate, state: AppState, keyIndex: buildExtKeyIndex(AppState),
            applyFieldMap: (r, fm) => afm2(r, fm, { reservedKeys: RK })
        });
    };
    const okRecords = [
        { 节点类型: 'S', extKey: 'meta:s1', name: '系列' },
        { 节点类型: 'C', extKey: 'meta:s1:c1', 父extKey: 'meta:s1', name: '一场' },
        { 节点类型: 'P', extKey: 'meta:s1:c1:A', 父extKey: 'meta:s1:c1', name: '题A' }
    ];

    const resFirst = await applyPlans({ state: AppState, items: [{ plan: planFor(withReports(okRecords)), source: 'meta-fixture' }] });
    eq(resFirst.created, 3, '（前提）三层记录先建出来');
    ok(!!AppState.reports, '（前提）第一次导入把 reports 写进了状态');

    // ① 全跳过：树里全有了，包里只有报告是新的
    AppState.reports = null;
    const planSkip = planFor(withReports(okRecords));
    eq(planSkip.summary.create + planSkip.summary.update, 0, '（前提）第二次没有新建/更新');
    eq(planSkip.summary.skip, 3, '（前提）三条全跳过');
    const resSkip = await applyPlans({ state: AppState, items: [{ plan: planSkip, source: 'meta-fixture' }] });
    ok(!!AppState.reports && AppState.reports.coverage.rows.length === 1,
        '★ 全跳过也把 reports 写进状态（不删原包直接重导就靠这条）');
    eq(resSkip.rejected, 0, '全跳过不算失败');

    // ② 计划里 0 条可执行记录（记录全被拒）：那笔事务不能短路
    AppState.reports = null;
    const planZero = planFor(withReports([{ 节点类型: 'P', extKey: 'meta:p1', 父extKey: '不存在的父', name: '孤儿' }]));
    eq(planZero.records.length, 0, '（前提）一条可执行记录都没有');
    ok(planZero.errors.length > 0, '（前提）那条记录被计划拒了');
    const resZero = await applyPlans({ state: AppState, items: [{ plan: planZero, source: 'meta-fixture' }] });
    ok(!!AppState.reports, '★ 0 条可执行记录时也写 reports（被短路掉报告就丢了）');
    eq(resZero.ok, true, '整批仍然算成功');
}

// ===============================================================
group('★ extKey 面板的入口必须接在**文档级那一条**委托上（v9.0.15 修的真病根）');
// ===============================================================
// 病根：`ui/G_events.js:installNodeInfoDelegate` 原先用 `closest('#tree-container')`
// 把**整个树容器里**的 `.btn-node-info` 一律拒收，指望容器上那条 `onActionClick` 接住。
// 但插件页（folder 视图宿主 `ui/folder/folderViewHost.js`）**就挂在 `#tree-container` 里**
// ⇒ extKey 面板行上的 📋 被文档级那条拒收、只剩容器那条；而容器那条认的是**逗号选择器**
// （`.btn-icon, .toggle-btn, .pagination-btn`），而 DOM 桩**不解析逗号选择器**
// ⇒ 这条路径在 CI 里恒为空转，"点了没反应"**没有任何断言会红**（用户实测反馈的那一处）。
// 修法：排除只留 `.node-box` **自己那颗**（容器那条会 `stopPropagation`，不会重复开）。
// ---------------------------------------------------------------
{
    seedState();
    const pid = addPlatform('qoj', 'QOJ');
    const pA = createNode('pA', 'P', { name: 'All Closed', problemId: 'A', extKey: '' });
    AppState.nodes.pA = pA;
    AppState.childOrder.pA = [];
    AppState.childOrder[pid].push('pA');
    AppState.parentOf.pA = pid;

    // ★ 按**产品里真实的位置**摆：插件面板挂在 `#tree-container` 里（不是随便找个 div）
    gevents.setupEventDelegation();
    const panelHost = document.createElement('div');
    panelHost.className = 'folder-view-panel';
    treeContainer.appendChild(panelHost);
    panelMod.renderExtKeyPanel(panelHost, { nodeId: pid, node: AppState.nodes[pid] });

    const goto = panelHost.querySelector('.ai-extkey-goto');
    const info = panelHost.querySelector('.ai-extkey-info');
    ok(!!goto && !!info, '（前提）面板渲染出 🔎 与 📋');
    ok(!!goto && !!goto.closest('#tree-container'),
        '（前提）它就摆在那处「病根位置」：`#tree-container` 里（否则这条覆盖不到）');
    eq(goto && goto.getAttribute('data-reveal-node'), 'pA', '🔎 的承载是 data-reveal-node，指向那一行节点');
    eq(info && info.getAttribute('data-id'), 'pA', '📋 的入口是 btn-node-info[data-id]');

    // ★ 「操作」那一格的**排版契约**（2026-10-13 用户看板上指出"排版不好"后改的）：
    //   三个盒子（🔎 / 📋 / 更换）必须排在**一行 flex** 里、等高居中。改前是"裸 emoji + 下划线链接
    //   + 两个不同内边距的按钮"各带 `margin-right` ⇒ 三个盒子对不齐（截图里 🔎 的下划线压在 emoji 底下、
    //   📋 的 emoji 贴左上角）。桩不解析样式、也不做布局，所以这里钉的是**机制**（同一行 flex + 等高）
    //   —— 退回旧写法（`BTN_CSS + ' margin-right:6px;'`）这几条当场红。
    {
        const opsRow = info.parent;
        const opsCss = (opsRow && opsRow.style && opsRow.style.cssText) || '';
        ok(opsCss.includes('display:flex'), '★ 操作格排成一行 flex（三个盒子才可能对齐）');
        ok(opsCss.includes('gap:'), '★ 间距用 gap，不是每个元素各写 margin-right');
        eq(opsRow ? opsRow.children.length : 0, 3, '★ 这一行里正好三样：🔎 / 📋 / 更换');
        ok(info.style.cssText.includes('width:24px') && info.style.cssText.includes('height:24px'),
            '★ 📋 是 24×24 的图标盒（`BTN_ICON_CSS`）');
        ok(info.style.cssText.includes('inline-flex'), '★ 📋 的内容在盒子里居中（不是贴左上角）');
        const chg = opsRow && opsRow.children[2];
        ok(!!chg && chg.className === 'ai-extkey-change', '（前提）第三个盒子是「更换」');
        ok(!!chg && chg.style.cssText.includes('height:24px'), '★ 「更换」与 📋 **同高**');
        ok(!goto.style.cssText.includes('text-decoration:underline'),
            '★ 🔎 不再带下划线（下划线会压在 emoji 底下，看着就是歪的）');
        ok(goto.style.cssText.includes('width:22px'), '★ 🔎 也有固定盒宽（否则它那截宽度随字体变）');
    }

    // ① 🔎：点一次只派发**一颗** REVEAL_NODE（与 G8 同款判据）
    const seen = [];
    const countReveal = e => seen.push(e.detail && e.detail.nodeId);
    document.addEventListener(EVENTS.REVEAL_NODE, countReveal);
    goto.click();
    eq(seen.length, 1, '★ 点 🔎 派发一颗 REVEAL_NODE（第二份局部委托会数到 2）');
    eq(seen[0], 'pA', '★ 带的是那一行的节点 id');
    document.removeEventListener(EVENTS.REVEAL_NODE, countReveal);

    // ② 📋：必须真的开详页。
    //    旧实现下这一条**红**：文档级那条拒收 `#tree-container`，而容器那条在桩里认不出
    //    逗号选择器 ⇒ 一次点击什么都不发生（这正是"面板点不动、CI 却全绿"）。
    const beforeTabs = tabs.getNodeInfoTabs().length;
    info.click();
    ok(tabs.getNodeInfoTabs().some(t => t.nodeId === 'pA'),
        `★ 点 📋 真的开了详页（旧实现：一个都没多，仍是 ${beforeTabs} 个）`);

    panelHost.remove();
}

report();
