// ================================================================
// 冒烟测试：导入包携带合成节点与成员指针（DOM 部分）
//
// Node 单测（src/test/autoImportSynth.test.js）已经钉住了纯逻辑（两阶段解析、
// never 口径、overwrite-if-changed、来源层不留痕、悬空/写节点 id 被拒绝）。
// 这里补三件**只能在真实装配下验**的事：
//   ① 导入预览真的把那两项计数画出来了（「新建/更新合成节点 N」「设置成员指针 M」
//      + "被拒绝的成员指针"单独一行），并且**只带合成节点的包**也能点执行；
//   ② 走**真实事务**（applyPlans → execute）落库：合成节点进树、指针进字段，
//      来源层不多出 ownerSynth/synthKey 的条目；
//   ③ **导出 → 导入往返**：`buildExportData` → `importState` 之后，
//      合成节点数量、每个 synthKey、每个成员指针逐字段相等。
//
// 运行：npm run test:smoke
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, deepEq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

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
makeContainer(app, 'folder-breadcrumb');
makeContainer(app, 'folder-stats');
treeContainer.appendChild(document.createElement('div'));

globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'))
});

globalThis.FileReader = class {
    readAsArrayBuffer(file) {
        const text = file && file._text !== undefined ? file._text : '';
        const bytes = new TextEncoder().encode(text);
        this.onload({ target: { result: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } });
    }
};

const fakeFile = (name, text) => ({ name, _text: text });

// ---------------------------------------------------------------
// 2. import 被测模块
// ---------------------------------------------------------------
const { bootstrapPlugins } = await import(mod('shell/bootstrap.js'));
const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const ai = await import(mod('features/AutoImport/index.js'));
const { applyPlans } = await import(mod('features/AutoImport/apply.js'));
const { buildExportData } = await import(mod('persistence/index.js'));
const { importState } = await import(mod('shell/executor.js'));

const summary = await bootstrapPlugins();
ok(summary.activated.includes('AutoImport'), 'AutoImport 已激活');

function seedState() {
    const base = createInitialState();
    for (const key of Object.keys(base)) AppState[key] = base[key];
    AppState.currentTab = 'main';
}

/** 在树上预置一个 S 容器 + 一个 C 成员节点 */
function seedTree() {
    const s = createNode('s1', 'S', { name: '系列', extKey: 'p' });
    const c = createNode('c1', 'C', { name: '浙江省赛', extKey: 'p:c1' });
    AppState.nodes.s1 = s;
    AppState.nodes.c1 = c;
    AppState.childOrder.s1 = ['c1'];
    AppState.childOrder.c1 = [];
    AppState.childOrder[AppState.rootId].push('s1');
    AppState.parentOf.s1 = AppState.rootId;
    AppState.parentOf.c1 = 's1';
    AppState.meta.idCounter += 2;
    return { s, c };
}

const crateJson = records => JSON.stringify({
    crateVersion: 1,
    source: { id: 'synth-smoke', kind: 'script' },
    generatedAt: '2026-09-29T00:00:00Z',
    fieldMap: { name: 'name', synthKey: 'synthKey', ownerSynth: 'ownerSynth' },
    records
});

const renderPreview = (batches) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    ai.renderPanel(host, { kind: 'tab', forcedParentId: '', batches, selected: 0 });
    return host;
};

const snapshotSynth = () => ({
    synth: Object.values(AppState.nodes)
        .filter(n => n && n.synthKey)
        .map(n => `${n.synthKey}|${n.type}|${n.name}`)
        .sort(),
    members: Object.values(AppState.nodes)
        .filter(n => n && n.ownerSynth)
        .map(n => `${n.extKey}|${n.ownerSynth}`)
        .sort()
});

// ===============================================================
group('预览：两项计数 + 只有合成节点的包也能执行');
// ===============================================================
seedState();
seedTree();

// ① 只带一个合成节点（没有任何普通记录）—— 这正是"执行按钮会被误禁用"的场景
const batchA = await ai.loadFiles([fakeFile('synth-only.json', crateJson([
    { 节点类型: 'C', synthKey: 'synth:zj', 父extKey: 'p', name: '浙江省赛（合成）' }
]))]);
eq(batchA.length, 1, '载入 1 个批次');
eq(batchA[0].plan.summary.errors, 0, `预览无错误：${JSON.stringify(batchA[0].plan.errors)}`);
eq(batchA[0].plan.records.length, 0, '合成节点记录不进 plan.records（走两阶段通道）');
eq(batchA[0].plan.summary.synthNodes, 1, '预览：新建/更新合成节点 1');
eq(batchA[0].plan.summary.pointerSet, 0, '预览：设置成员指针 0');
eq(batchA[0].plan.summary.pointerDangling, 0, '包里没有指针，谈不上悬空');

const hostA = renderPreview(batchA);
const htmlA = serialize(hostA);
ok(/新建\/更新合成节点 1/.test(htmlA), `预览出现「新建/更新合成节点 1」：${htmlA.slice(0, 400)}`);
ok(/设置成员指针 0/.test(htmlA), '预览出现「设置成员指针 0」');
ok(!!hostA.querySelector('.ai-synth-row'), '合成节点在记录表里单独成行');
const execA = hostA.querySelector('.ai-execute-btn');
ok(!!execA, '渲染出执行按钮');
eq(execA.disabled, false, '★ 只有合成节点的包，执行按钮**可用**（不被误判成"没有变更"）');

const resA = await applyPlans({ state: AppState, items: [{ plan: batchA[0].plan, source: 'synth-smoke' }] });
eq(resA.ok, true, `执行成功：${resA.error || ''}`);
eq(resA.synthCreated, 1,
    `落地：新建合成节点 1（失败：${JSON.stringify(resA.perItem.flatMap(p => p.failures || []))}）`);
const zj = Object.values(AppState.nodes).find(n => n && n.synthKey === 'synth:zj');
ok(!!zj, '合成节点真的进了树');
eq(zj.extKey || '', '', '★ 合成节点没有 extKey');
eq(AppState.parentOf[zj.id], 's1', '挂在父容器下（普通节点）');
ok(!!zj.origin && zj.origin.src === 'synth-smoke', `存在性归属写上了：${JSON.stringify(zj.origin)}`);

// ===============================================================
group('预览：包想改但没改的成员指针单独列一行');
// ===============================================================
// ② 包里带的指针 **树上空着** → 照写（M=1）
const batchB = await ai.loadFiles([fakeFile('pointer.json', crateJson([
    { 节点类型: 'C', extKey: 'p:c1', 父extKey: 'p', name: '浙江省赛', ownerSynth: 'synth:zj' }
]))]);
eq(batchB[0].plan.summary.synthNodes, 0, '没有合成节点要建/改');
eq(batchB[0].plan.summary.pointerSet, 1, '预览：设置成员指针 1');
eq(batchB[0].plan.summary.pointerRejected, 0, '树上指针空着 ⇒ 不产生拒绝');

const htmlB = serialize(renderPreview(batchB));
ok(/新建\/更新合成节点 0/.test(htmlB), '预览出现「新建/更新合成节点 0」');
ok(/设置成员指针 1/.test(htmlB), '预览出现「设置成员指针 1」');

const resB = await applyPlans({ state: AppState, items: [{ plan: batchB[0].plan, source: 'synth-smoke' }] });
eq(resB.ok, true, `执行成功：${resB.error || ''}`);
eq(resB.pointersSet, 1, '落地：设置成员指针 1');
eq(AppState.nodes.c1.ownerSynth, 'synth:zj', '指针写进字段了');
// ★ 来源层不留痕：ownerSynth 不是"某账户在某渠道看到的值"
eq(AppState.nodes.c1.values && AppState.nodes.c1.values.ownerSynth, undefined,
    '来源层里没有 ownerSynth（它是结构，不是字段来源）');
eq(AppState.nodes.c1.values && AppState.nodes.c1.values.synthKey, undefined,
    '来源层里也没有 synthKey');

// ③ 包想**改**树上已有的非空指针 → 单独一行报告，且不写
const batchC = await ai.loadFiles([fakeFile('pointer-change.json', crateJson([
    { 节点类型: 'C', extKey: 'p:c1', 父extKey: 'p', name: '浙江省赛', ownerSynth: 'synth:别的' }
]))]);
eq(batchC[0].plan.summary.pointerSet, 0, '树上已有非空指针 ⇒ 不写');
eq(batchC[0].plan.summary.pointerRejected, 1, '预览：被拒绝的指针改动 1');

const htmlC = serialize(renderPreview(batchC));
ok(/1 条成员指针改动被拒绝/.test(htmlC), `预览单独列出一行"被拒绝"：${htmlC.slice(0, 400)}`);

const resC = await applyPlans({ state: AppState, items: [{ plan: batchC[0].plan, source: 'synth-smoke' }] });
eq(resC.ok, true, '执行仍然成功（拒绝只是一条计数，不是事务失败）');
eq(resC.pointersSet, 0, '一条都没写');
eq(resC.pointersRejected, 1, '落地结果也是"被拒绝 1"');
eq(AppState.nodes.c1.ownerSynth, 'synth:zj', '★ 树上已有的指针没被覆盖');

// ===============================================================
group('导出 → 导入往返：合成节点与成员指针逐字段相等');
// ===============================================================
const before = snapshotSynth();
eq(before.synth.length, 1, '（前提）树上有 1 个合成节点');
eq(before.members.length, 1, '（前提）树上有 1 个成员指针');

// 模拟"落到文件再读回来"：JSON 序列化一轮，再整体导入
const payload = JSON.parse(JSON.stringify(buildExportData(AppState)));
await importState(payload);

const after = snapshotSynth();
deepEq(after.synth, before.synth, '★ 合成节点数量 / synthKey / 类型 / 名字逐字段相等');
deepEq(after.members, before.members, '★ 每个成员指针逐字段相等');

// 再走一次"导入同一份包"：应当全部跳过（幂等，且不产生新的悬空/拒绝）
const batchD = await ai.loadFiles([fakeFile('pointer.json', crateJson([
    { 节点类型: 'C', extKey: 'p:c1', 父extKey: 'p', name: '浙江省赛', ownerSynth: 'synth:zj' }
]))]);
eq(batchD[0].plan.summary.synthNodes, 0, '往返之后重导：不重建合成节点');
eq(batchD[0].plan.summary.pointerSet, 0, '往返之后重导：不重设指针（值相同）');
eq(batchD[0].plan.summary.pointerRejected, 0, '也不产生拒绝');
eq(batchD[0].plan.summary.pointerDangling, 0, '更不是悬空');

// ===============================================================
group('预览：指向不存在目标的指针 ⇒ 进"被拒绝"，落库后树上没有它');
// ===============================================================
// 写路径**拒绝**产生悬空指针（不会"照写 + 标黄"）。
// 历史存档里已有的悬空是另一回事 —— 那条读路径（判重页黄条 + 一键清理）不变。
// 补充（本次）：`父synthKey`（父是合成节点）在预览里也必须看得见 ——
// 解析不到时进"错误（这些条目不会执行）"，**绝不静默挂到根下**。
const batchE = await ai.loadFiles([fakeFile('dangling.json', crateJson([
    { 节点类型: 'C', extKey: 'p:c9', 父extKey: 'p', name: '孤儿原料', ownerSynth: 'synth:不存在' }
]))]);
eq(batchE[0].plan.summary.pointerSet, 0, '悬空指针不写（写路径不许产生悬空）');
eq(batchE[0].plan.summary.pointerRejected, 1, '进"被拒绝"那一项');
eq(batchE[0].plan.summary.pointerDangling, 1, '并被认成"目标不可解析"');

const htmlE = serialize(renderPreview(batchE));
ok(/1 条悬空\/非法的成员指针/.test(htmlE), `预览单独说清悬空被拒：${htmlE.slice(0, 400)}`);

const resE = await applyPlans({ state: AppState, items: [{ plan: batchE[0].plan, source: 'synth-smoke' }] });
eq(resE.ok, true, '执行仍然成功（拒绝只是一条计数，不是事务失败）');
eq(resE.pointersSet, 0, '一条指针都没写');
const c9 = Object.values(AppState.nodes).find(n => n && n.extKey === 'p:c9');
ok(!!c9, '节点照常在树上（被拒的是指针，不是节点）');
eq(c9.ownerSynth, '', '★ 树上没有这个指针（没落成单元素组）');

// ===============================================================
group('★ 父synthKey：合成节点挂到另一个合成节点下（预览 + 真实事务）');
// ===============================================================
// "合成节点在包里的位置"由脚本显式指定父容器。两种写法**恰好给一个**：
// `父extKey`（父是普通节点）/ `父synthKey`（父是合成节点）。
//
// ⚠️ 夹具用 `C 合成父 + P 合成子`：节点类型层级（`TYPE_CHILDREN_MAP`）与
//    "合成只在 C/P/R 上做"两条合起来，**只有这一种**父子组合成立
//    （C 父 + C 子会以"父节点类型 C 不允许添加 C"被拒；根是 O、放不了 C）。
//
// 这里验的是**真实装配**下的两件事：
//   ① 预览看得见（新合成节点那一行的父引用原样带出、没有错误计数）；
//   ② 走真实事务落库后，子合成节点**真的挂在父合成节点下**（不是挂在根下）。
{
    // 树上先有一个 C 容器，它本身是合成节点 `synth:onTree`
    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换成可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    const czj = createNode('czj', 'C', { name: '浙江省赛', extKey: 'p:czj', synthKey: 'synth:onTree' });
    AppState.nodes.czj = czj;
    AppState.childOrder.czj = [];
    AppState.childOrder.s1.push('czj');
    AppState.parentOf.czj = 's1';
    AppState.meta.idCounter += 1;

    const batchF = await ai.loadFiles([fakeFile('parent-synth.json', crateJson([
        { 节点类型: 'P', synthKey: 'synth:kid', 父synthKey: 'synth:onTree', name: '题目（合成）' }
    ]))]);
    eq(batchF[0].plan.summary.errors, 0,
        `预览无错误：${JSON.stringify(batchF[0].plan.errors)}`);
    eq(batchF[0].plan.summary.synthCreate, 1, '预览：新建合成节点 1');
    eq(batchF[0].plan.synth.nodes[0].parentSynthKey, 'synth:onTree',
        '★ 父引用原样带进执行清单（预览用的是同一份数据）');

    const htmlF = serialize(renderPreview(batchF));
    ok(/新建\/更新合成节点 1/.test(htmlF), `预览出现「新建/更新合成节点 1」：${htmlF.slice(0, 400)}`);

    const resF = await applyPlans({ state: AppState, items: [{ plan: batchF[0].plan, source: 'synth-smoke' }] });
    eq(resF.ok, true, `执行成功：${resF.error || ''}`);
    eq(resF.synthCreated, 1,
        `落地：新建合成节点 1（失败：${JSON.stringify(resF.perItem.flatMap(p => p.failures || []))}）`);
    const kid = Object.values(AppState.nodes).find(n => n && n.synthKey === 'synth:kid');
    ok(!!kid, '子合成节点真的进了树');
    eq(AppState.parentOf[kid.id], czj.id,
        '★ 它挂在**父合成节点**（synth:onTree）下，不是挂在根下');
    eq(AppState.parentOf[kid.id] === AppState.rootId, false, '★ 绝不是根');
}

// 解析不到 ⇒ 预览里进"错误（这些条目不会执行）"，执行后树上没有它
const batchG = await ai.loadFiles([fakeFile('parent-missing.json', crateJson([
    { 节点类型: 'P', synthKey: 'synth:orphan', 父synthKey: 'synth:404', name: '孤儿合成' }
]))]);
eq(batchG[0].plan.summary.synthNodes, 0, '父找不到 ⇒ 不建');
eq(batchG[0].plan.summary.errors, 1, '预览：错误 1 条');

const htmlG = serialize(renderPreview(batchG));
// ⚠️ 那一栏的标题现在**带计数**（统一模板：0 条也在、计数就是简要信息）⇒ 钉子跟着挪，
//    牙口没变松（写成 `1 条` 就是错的）。
ok(/错误 1 条（这些条目不会执行）/.test(htmlG), `预览里出现"错误"那一栏：${htmlG.slice(0, 500)}`);
ok(/parent-not-found/.test(htmlG) && /父synthKey/.test(htmlG),
    `★ 条目里点名是哪个父引用：${htmlG.slice(0, 800)}`);

const resG = await applyPlans({ state: AppState, items: [{ plan: batchG[0].plan, source: 'synth-smoke' }] });
eq(resG.ok, true, '执行仍然成功（拒绝只是一条计数，不是事务失败）');
eq(resG.synthCreated, 0, '一条都没建');
eq(Object.values(AppState.nodes).some(n => n && n.synthKey === 'synth:orphan'), false,
    '★ 树上没有它 —— 不许静默挂到根下');

// ===============================================================
group('★ 父容器预检：非法组合在预览里就进"错误"，不等到执行才失败');
// ===============================================================
// 合成节点"不给任何父引用"= 想挂真实根节点，而根是 O 类型、`TYPE_CHILDREN_MAP`
// 里 O 只允许 W / S，合成节点只能是 C/P/R ⇒ **合成节点在根下永远放不下**。
// 若只在执行时才发现，预览算"新建"、点执行后逐条失败 —— 预览与结果不符。计划阶段就拒。
// （普通记录不给父引用仍然照常挂根，没有被这条规则误伤 —— 见 Node 单测的反向锚。）
const batchH = await ai.loadFiles([fakeFile('bad-parent-type.json', crateJson([
    { 节点类型: 'C', synthKey: 'synth:atRoot', name: '想挂根' }
]))]);
eq(batchH[0].plan.summary.synthNodes, 0, '预览：不算新建（计划阶段就拒了）');
eq(batchH[0].plan.summary.errors, 1, '预览：错误 1 条');

const htmlH = serialize(renderPreview(batchH));
ok(/错误 1 条（这些条目不会执行）/.test(htmlH), '被拒的条目落在预览既有的"错误"那一栏');
ok(/synth-parent-required/.test(htmlH),
    `★ 预览里看得见这条拒绝（沿用既有呈现，没有新面板）：${htmlH.slice(0, 800)}`);

const resH = await applyPlans({ state: AppState, items: [{ plan: batchH[0].plan, source: 'synth-smoke' }] });
eq(resH.ok, true, '执行仍然成功（计划阶段就拒了，不是事务失败）');
eq(resH.synthCreated, 0, '一条都没建');
eq(Object.values(AppState.nodes).some(n => n && n.synthKey === 'synth:atRoot'), false,
    '★ 树上没有它 —— 预览说"不算新建"，结果也是没建（预览与结果一致）');

report('import-synth');
