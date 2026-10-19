// ================================================================
// 冒烟测试：添加节点那几条路上的「取消」（scripts/smoke/add-node-cancel.smoke.mjs）
//
// 用户 2026-10-13 报的："添加节点也是有这些问题的,在靠后的环节点取消,之前的步骤仍执行"。
// 那一摊的根因是**弹窗的"取消"没有统一语义**（`v9.3.4` 立的约定，见 `G2_common.js` 文件头）：
//   · 取消 ⇒ **一定回调一次**、且给 `null`；确定 ⇒ 给值（**空串照传**，别 `|| null`）。
//   · 于是调用方能分清：`null` = 取消（**整个操作中止**）、`''` = 确定但留空（可选字段的合法值）。
//
// 这一组钉四件事（四条都走**真按钮**，并用超时兜底把"Promise 永远悬着"也钉住）：
//   ① 添加根节点：类型 → 名字 → **链接弹窗点取消** ⇒ **不建节点**（改前会建）；
//   ② 添加根节点：类型 → 名字 → **链接留空 + 确定** ⇒ **建出节点**（"可选"仍然可选）；
//   ③ 添加根节点：**类型弹窗点取消** ⇒ Promise 会 settle（改前永远悬着）；
//   ④ 添加子节点(C)：名字 → **表单点取消** ⇒ 不建节点 + settle（改前永远悬着）。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
for (const id of ['toast', 'tree-body', 'tree-container', 'tab-main']) makeContainer(app, id);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { promptAddRoot, promptAddChild } = await import(mod('ui/G_modal/G4_add.js'));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const nextLoop = async () => { await tick(); await tick(); };

/** 造一棵树（照 `add-synth.smoke.mjs` 那份夹具的写法：节点必须走 `createNode`） */
function seed(list) {
    const base = createInitialState();
    const rootId = base.rootId;
    const nodes = { ...base.nodes };
    const childOrder = { ...base.childOrder };
    const parentOf = { ...base.parentOf };
    for (const item of list) {
        const { type, id, ...extra } = item;
        const parent = item.parent === 'root' ? rootId : item.parent;
        nodes[id] = { ...createNode(id, type, extra), ...extra, id, type };
        parentOf[id] = parent;
        if (!childOrder[parent]) childOrder[parent] = [];
        childOrder[parent].push(id);
        if (!childOrder[id]) childOrder[id] = [];
    }
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.nodes = nodes;
    AppState.childOrder = childOrder;
    AppState.parentOf = parentOf;
    AppState.rootId = rootId;
    AppState.currentTab = 'main';
    AppState.currentPageId = 'main';
}

const overlays = () => body.querySelectorAll('.modal-overlay');
const topOverlay = () => { const o = overlays(); return o[o.length - 1] || null; };
const findBtn = (label) => {
    const o = topOverlay();
    return o ? (o.querySelectorAll('.btn').find((b) => b.textContent === label) || null) : null;
};
const clickByLabel = (label) => { const b = findBtn(label); if (b) { b.click(); return true; } return false; };
const clickType = (type) => {
    const b = (topOverlay() || body).querySelectorAll('.type-btn').find((x) => x.dataset.type === type);
    if (b) b.click();
    return !!b;
};
const fillPrompt = (value) => {
    const el = document.getElementById('prompt-input');
    if (!el) return false;
    el.value = value;
    el.dispatchEvent({ type: 'input' });
    return clickByLabel('确定');
};
/** 往表单里的某个字段敲字（`showFormDialog` 的控件 id 是 `field-<key>`） */
const setField = (key, value) => {
    const el = document.getElementById(`field-${key}`);
    if (!el) return false;
    el.value = value;
    el.dispatchEvent({ type: 'input' });
    return true;
};
const nodeCount = () => Object.keys(AppState.nodes).length;
/** 等一个 Promise，但**超时就判失败**（用来抓"取消之后 Promise 永远悬着"） */
const settleOrTimeout = (p, ms = 800) => Promise.race([
    p.then((r) => ({ settled: true, result: r })),
    new Promise((r) => setTimeout(() => r({ settled: false }), ms))
]);

// ================================================================
group('① 添加根节点：名称与链接**已合并成一步**，在那一步点「取消」⇒ **不建节点**');
// ================================================================
{
    seed([]);
    const before = nodeCount();
    const p = promptAddRoot();
    await nextLoop();
    ok(clickType('W'), '（前提）类型选择器里有 W');
    await nextLoop();
    // ★ 合并的正面锁：这一步是**一个表单**，名称与链接都在里面；不再有"名称 prompt"
    ok(!document.getElementById('prompt-input'), '★★ 名称不再单独弹一步（原来是 prompt + prompt）');
    ok(!!document.getElementById('field-name'), '★★ 表单里有名称（`field-name`）');
    ok(!!document.getElementById('field-link'), '★★ 同一步里还有链接（`field-link`）');
    ok(clickByLabel('取消'), '点这一步的「取消」');

    const got = await settleOrTimeout(p);
    ok(got.settled, '★ 取消之后 Promise 要 settle（不许悬着）');
    eq(got.settled && got.result.success, false, '★ 结果是失败');
    eq(got.settled && got.result.error, '用户取消', '★ 原因是「用户取消」');
    eq(nodeCount(), before, '★★ **一个节点都没建**');
}

// ================================================================
group('② 添加根节点：同一步里填名字、链接**留空** ⇒ 建出节点（"可选"仍然是可选）');
// ================================================================
{
    seed([]);
    const before = nodeCount();
    const p = promptAddRoot();
    await nextLoop();
    clickType('W');
    await nextLoop();
    ok(setField('name', '测试平台'), '（前提）表单里有名称字段');
    ok(clickByLabel('确定'), '表单的「确定」（链接留空）');
    const got = await settleOrTimeout(p);
    ok(got.settled && got.result.success === true, '★ 留空确定 ⇒ 成功建出节点');
    eq(nodeCount(), before + 1, '★ 节点数 +1');
    const made = Object.values(AppState.nodes).find((n) => n.name === '测试平台');
    ok(!!made, '★ 名字用的是表单里填的那个');
    eq(made && (made.values && made.values.link ? made.values.link[0].v : ''), '', '★ 链接就是空的（没被写成 null/undefined）');
}

// ================================================================
group('③ 添加根节点：**类型弹窗**点取消 ⇒ Promise 会 settle（改前永远悬着）');
// ================================================================
{
    seed([]);
    const before = nodeCount();
    const p = promptAddRoot();
    await nextLoop();
    ok(clickByLabel('取消'), '类型弹窗点「取消」');
    const got = await settleOrTimeout(p);
    ok(got.settled, '★★ 类型那一步取消也要 settle（改前 `await promptAddRoot()` 永远挂住）');
    eq(got.settled && got.result.success, false, '★ 结果是失败');
    eq(nodeCount(), before, '★ 没建节点');
}

// ================================================================
group('④ 添加子节点(C)：名字那一步取消 / 表单那一步取消 —— 两条都要"不建节点 + settle"');
// ================================================================
// ================================================================
// ⚠️ C（比赛）这条路**以前是两步**（先 `showPromptDialog('添加比赛'…)` 问名字、再一个**也有 names 字段**的表单）
//    —— `v9.3.5` 已合并成**一个表单**（名称 / 链接 / 比赛时间）。这里钉合并后的行为：
//    ① 取消 ⇒ 不建节点 + settle；② 填名字 + 确定 ⇒ 建出 C（名字取自表单）。
{
    const seedC = () => seed([
        { parent: 'root', type: 'W', id: 'w1', name: 'XCPC' },
        { parent: 'w1', type: 'S', id: 's1', name: 'XCPC 2026' }
    ]);

    // ④a 同一步里点「取消」
    seedC();
    const beforeA = nodeCount();
    const pA = promptAddChild('s1', true);
    await nextLoop();
    ok(!document.getElementById('prompt-input'), '★★ 不再先弹「请输入比赛名称」那一步（已合并）');
    ok(!!document.getElementById('field-name'), '★★ 表单里有名称');
    ok(!!document.getElementById('field-contestTime'), '★★ 同一步里还有比赛时间');
    ok(clickByLabel('取消'), '这一步点「取消」');
    const gotA = await settleOrTimeout(pA);
    ok(gotA.settled, '★ 取消也要 settle');
    eq(gotA.settled && gotA.result.success, false, '★ 结果是失败');
    eq(nodeCount(), beforeA, '★ 没建节点');

    // ④b 填名字 ⇒ 建出 C
    seedC();
    const beforeB = nodeCount();
    const pB = promptAddChild('s1', true);
    await nextLoop();
    ok(setField('name', '2026 某场比赛'), '（前提）名称字段填好');
    ok(clickByLabel('确定'), '表单点「确定」');
    const gotB = await settleOrTimeout(pB);
    ok(gotB.settled && gotB.result.success === true, '★ 建出节点');
    eq(nodeCount(), beforeB + 1, '★ 节点数 +1');
    ok(Object.values(AppState.nodes).some((n) => n.name === '2026 某场比赛'), '★ 名字取自表单（不再经过中间那一步）');
    ok(!document.getElementById('field-name'), '（顺带）弹窗已关掉');
}

report();
