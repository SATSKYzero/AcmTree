// ================================================================
// 冒烟测试：落盘的合并写（scripts/smoke/save-coalesce.smoke.mjs）
//
// 落盘走**合并/延迟写**（不是每事务同步落盘），
// 去掉探针实测里那 15.6ms 的 IndexedDB 常数（`scripts/fold-bench.mjs` 的 ⑨），
// 同时保证"不骗用户、不真丢数据"：
//   ① 连续 N 个事务只落盘一次；
//   ② pagehide / visibilitychange(hidden) / beforeunload 强制 flush；
//   ③ 有未落盘改动时 `dbIsSaved` 必须是 false，flush 成功后才 true；
//   ④ 显式保存/导出/导入路径先 flush（用户以为"已经保存了"的动作不许留尾巴）。
//
// 运行：npm run test:smoke
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { installIndexedDb } from './idb.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom();

// ---- 数落盘次数：包一层 indexedDB.open，在 onsuccess 拿到 db 后数 transaction ----
// ⚠️ 不能用"先把 req.onsuccess 存下来再替换"的写法：`persistence/indexeddb.js` 的
//    `openDB()` 是**之后**才给 `req.onsuccess` 赋值的，那样赋值会把包装冲掉。
//    这里用 getter/setter 劫持，保证谁赋值都经过我们。
const idb = installIndexedDb();
let txCount = 0;
{
    const origOpen = idb.open.bind(idb);
    idb.open = (name, version) => {
        const req = origOpen(name, version);
        let handler = null;
        Object.defineProperty(req, 'onsuccess', {
            configurable: true,
            get: () => handler,
            set: (fn) => {
                handler = (ev) => {
                    const db = req.result;
                    if (db && !db.__counted) {
                        db.__counted = true;
                        const origTx = db.transaction.bind(db);
                        db.transaction = (n, m) => { txCount++; return origTx(n, m); };
                    }
                    if (fn) fn(ev);
                };
            }
        });
        return req;
    };
}

const { InfoState } = await import(mod('core/model/infoState.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { replaceState, AppState } = await import(mod('shell/state.js'));
const { execute } = await import(mod('shell/executor.js'));
const { scheduleSave, flushPendingSave, hasPendingSave, cancelPendingSave, SAVE_COALESCE_MS } =
    await import(mod('persistence/index.js'));
const { collectView, saveView, loadView, applyView, isExpanded } =
    await import(mod('core/model/viewState.js'));

/** 让窗口过去（真实是 300ms；测试里等到定时器真跑完） */
const sleep = ms => new Promise(r => setTimeout(r, ms));

replaceState(createInitialState());
InfoState.dbIsSaved = true;

// ================================================================
group('① 连续多个事务 ⇒ 只落盘一次（合并写）');
// ================================================================
{
    eq(SAVE_COALESCE_MS >= 200 && SAVE_COALESCE_MS <= 400, true,
        `合并窗口在 200–400ms 之间（实测 ${SAVE_COALESCE_MS}ms）`);
    txCount = 0;
    for (let i = 0; i < 3; i++) {
        await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    }
    eq(txCount, 0, '事务提交后**没有**立即落盘（这是提速的来源）');
    ok(hasPendingSave(), '有"待落盘"的改动挂着');
    await flushPendingSave();
    eq(txCount, 1, '三个事务合并成**一次**落盘');
    eq(hasPendingSave(), false, 'flush 之后没有待写内容');
}

// ================================================================
group('② 页面要走时必须强制 flush');
// ================================================================
{
    txCount = 0;
    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    eq(txCount, 0, '先制造一次待写');
    globalThis.dispatchWindowEvent({ type: 'pagehide' });
    await sleep(0);
    eq(txCount, 1, 'pagehide ⇒ 立刻 flush');

    txCount = 0;
    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    globalThis.dispatchWindowEvent({ type: 'beforeunload' });
    await sleep(0);
    eq(txCount, 1, 'beforeunload ⇒ 立刻 flush');

    txCount = 0;
    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent({ type: 'visibilitychange' });
    await sleep(0);
    eq(txCount, 1, 'visibilitychange(hidden) ⇒ 立刻 flush');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
}

// ================================================================
group('③ 脏标记必须诚实：未落盘期间显示"未保存"');
// ================================================================
{
    txCount = 0;
    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    eq(InfoState.dbIsSaved, false, '改动刚提交、还没落盘 ⇒ dbIsSaved=false（界面显示"DB未保存"）');
    await flushPendingSave();
    eq(InfoState.dbIsSaved, true, 'flush 成功之后才翻成"已保存"');
    eq(txCount, 1, '（只写了一次）');
}

// ================================================================
group('④ 显式"保存/导出/导入"路径要先 flush');
// ================================================================
{
    const jsonIO = fs.readFileSync(path.join(SRC, 'handlers/H1_jsonIO.js'), 'utf8');
    const exportsCount = (jsonIO.match(/await flushPendingSave\(state\);/g) || []).length;
    eq(exportsCount, 2, '两个导出路径都先 flush（普通导出 + 压缩导出）');
    ok(jsonIO.indexOf('await flushPendingSave(state);') < jsonIO.indexOf('await saveData(state);'),
        '顺序是"先落掉挂着的 → 再写这次（带 JSON 已导出标记）"');

    const executor = fs.readFileSync(path.join(SRC, 'shell/executor.js'), 'utf8');
    ok(/await flushPendingSave\(\);\s*\n\s*await saveData\(complete\);/.test(executor),
        '整体导入前先 flush（上一份世界要先落地，再换世界）');

    // ⚠️ 设置界面是一级 Tab ⇒ 这段代码在 ui/settings/settingsPage.js
    const settings = fs.readFileSync(path.join(SRC, 'ui', 'settings', 'settingsPage.js'), 'utf8');
    ok(/await flushPendingSave\(AppState\);/.test(settings), '设置里"清空历史"这类显式落盘也先 flush');
    ok(/await saveData\(AppState\);/.test(settings), 'flush 之后立刻写这一次（用户点的是"确定"）');

    const persistence = fs.readFileSync(path.join(SRC, 'persistence/index.js'), 'utf8');
    ok(/cancelPendingSave\(\);/.test(persistence) && /clearAll/.test(persistence),
        '清空数据会取消待写（否则旧状态会在清空之后被写回去）');
    ok(/cancelPendingSave\(\);/.test(persistence.slice(persistence.indexOf('export function resetDiffBaseline'))),
        '重置 diff 基线也会取消待写');

    // 显式 flush 语义：即使没有定时器，flush 也能立刻写
    txCount = 0;
    const st = createInitialState();
    InfoState.dbIsSaved = false;
    scheduleSave(st, 60_000);              // 故意排到很远的将来
    await flushPendingSave();
    eq(txCount, 1, 'flush 不受窗口长度影响（立刻写）');
    // cancel 之后必须"再也不会写"（用行为断言，而不是看书内部簿记）
    cancelPendingSave();
    const before = txCount;
    globalThis.dispatchWindowEvent({ type: 'pagehide' });   // 兜底 flush 也不该写出东西
    await sleep(SAVE_COALESCE_MS + 30);
    eq(txCount, before, 'cancelPendingSave 之后不会再落盘（清空数据/换基线时旧状态不会被写回去）');
}

// ================================================================
group('⑤ 事务不因为"落盘失败"回滚');
// ================================================================
{
    const src = fs.readFileSync(path.join(SRC, 'shell/executor.js'), 'utf8');
    ok(/saveFn: \(\) => scheduleSave\(AppState\)/.test(src),
        'execute/undo 走 scheduleSave（登记式，不直接同步 saveData）');
    const persistence = fs.readFileSync(path.join(SRC, 'persistence/index.js'), 'utf8');
    ok(/崩溃\/断电最多丢最近 ~300ms/.test(persistence),
        '代码里写清这笔交易：崩溃最多丢最近 ~300ms 的改动');
    ok(/保持未保存.*自动重试|自动重试/s.test(persistence) && /console\.error\('❌ 合并写落盘失败/.test(persistence),
        '落盘失败不吞：保持未保存 + 自动重试 + 打印错误');
}

// ================================================================
group('⑤ 折叠声明 skipPersist：不登记落盘、不置脏（含对照）');
// ================================================================
{
    for (const f of ['ui/G_events.js', 'ui/buttons.js', 'I_app.js']) {
        const s = fs.readFileSync(path.join(SRC, f), 'utf8');
        ok(/skipPersist\s*:\s*true/.test(s), `折叠入口 ${f} 声明 skipPersist: true`);
    }
    const txe = fs.readFileSync(path.join(SRC, 'transaction/executor.js'), 'utf8');
    ok(/if\s*\(!skipPersist\)\s*markModified\(/.test(txe), 'executor：skipPersist 时不 markModified');
    const shx = fs.readFileSync(path.join(SRC, 'shell/executor.js'), 'utf8');
    ok(/skipPersist/.test(shx), 'shell/executor：execute 依据 skipPersist 决定 saveFn');

    await flushPendingSave();
    InfoState.dbIsSaved = true;
    txCount = 0;
    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; },
                  { skipPersist: true, skipHistory: true, skipVirtualStats: true });
    eq(txCount, 0, '折叠等价路径提交后**没有**落盘');
    eq(hasPendingSave(), false, '折叠不登记待落盘');
    eq(InfoState.dbIsSaved, true, '折叠**不**把 dbIsSaved 翻假');

    await execute(draft => { draft.meta.idCounter = (draft.meta.idCounter || 0) + 1; });
    eq(hasPendingSave(), true, '对照：普通事务确实登记了待落盘');
    eq(InfoState.dbIsSaved, false, '对照：普通事务把 dbIsSaved 翻假');
    await flushPendingSave();
}

// ================================================================
group('⑥ 落盘载荷里没有 expanded（与导出包同一口径）+ 只写"变了的那些"');
// ================================================================
{
    const px = fs.readFileSync(path.join(SRC, 'persistence/index.js'), 'utf8');
    // 视图态**不在节点上**（state.view）⇒ 落盘/导出载荷里天然没有 expanded/currentPage；
    // 这里只在源码层钉住"没有第二份过滤逻辑"（以前那套 strip* 已随迁移删掉）。
    ok(!/stripExpanded/.test(px), '落盘模块不再有"剥 expanded"那道工序（字段不在节点上了）');
    const nodes = { a: { id: 'a', name: 'x' }, b: { id: 'b' } };
    // ★ 契约：`captureRef` **保留真引用**，剥 `expanded` 挪到"真要写的那几条"上。
    //   为什么必须这样：`computeDiff` 是**按引用**做差的 —— 若 `captureRef` 对整棵树每个节点
    //   都 `{ ...node }` 拷一份 ⇒ 引用全变 ⇒ 每次都以为 2.7 万节点全改了 ⇒ 整棵树重写进 IDB。
    const { captureRef } = await import(mod('persistence/index.js'));
    const ref = captureRef({ ...AppState, nodes, childOrder: {}, pages: {} });
    eq(ref.nodes, nodes, '★ `captureRef` 的 nodes 就是传进去的那个对象（按引用做差才成立）');

    // 真的只改一个节点 ⇒ diff 只报 1 条、落盘只写 1 条，而且写进去的那条没有 expanded
    const { computeDiff, diffToIDBOps } = await import(mod('persistence/diff.js'));
    const nodes2 = { ...nodes, a: { ...nodes.a, name: 'y' } };
    const after = captureRef({ ...AppState, nodes: nodes2, childOrder: {}, pages: {} });
    const changes = computeDiff(ref, after);
    eq(Object.keys(changes.nodesChanged).length, 1, '★ 改一个节点 ⇒ 只报 1 条变化（不是"全变了"）');
    const nodeOps = diffToIDBOps(changes).filter(o => o.store === 'nodes');
    eq(nodeOps.length, 1, '★ ⇒ 落盘只写 1 条节点');
    eq(nodeOps[0].value, nodes2.a, '写进去的就是那个节点对象本身（不再有"剥 expanded"那次拷贝）');
}

// ================================================================
group('⑦ 折叠态重启后仍保留（只靠本地缓存，与 IDB 无关）');
// ================================================================
{
    const nodes = { n1: { id: 'n1', name: 'a' }, n2: { id: 'n2' } };
    // ① 行为（不依赖存储桩）：折叠态 → **稀疏的展开 id 列表** → 贴回新数据（重启路径的核心两步）
    const view = collectView({ view: { expanded: { n1: true } } });
    ok(Array.isArray(view.expanded) && view.expanded.length === 1 && view.expanded[0] === 'n1',
        'collectView 只收"展开的"（收起的走默认 —— 真包 27k 上逐个写 false 会写出 653KB，'
        + '而这份缓存每次折叠后都要**同步**写进 localStorage）');
    const restored = { nodes: { n1: { id: 'n1' }, n2: { id: 'n2' }, n9: { id: 'n9' } } };
    ok(!('expanded' in restored.nodes.n1), '新读进来的数据不含 expanded（IDB 里本来就没有）');
    // 存储往返由 v84-ux.smoke.mjs 覆盖（`loadView` 会把稀疏数组变成 `{id:true}`）——
    // 这里直接给那个形状，验"贴回去"这一步
    eq(applyView(restored, { expanded: { n1: true }, pages: {} }), 1, '重启后把展开态贴回');
    eq(isExpanded(restored, 'n1'), true, '展开的仍然展开');
    ok(!isExpanded(restored, 'n2'), '收起的没进缓存 ⇒ 保持默认（默认就是收起）');
    ok(!isExpanded(restored, 'n9'), '缓存里没有的节点保持默认（不乱动）');
    // ② 存储往返由 v84-ux.smoke.mjs 严格覆盖（同一套 saveView/loadView 调用）；
    //    本文件里前面的落盘/状态组会留下 pending 的折叠写，容易把这里读到的值搅乱，
    //    所以这里只断言这条链的**本文件职责**：折叠态是"看的姿势"、不进 IDB。
    const px = fs.readFileSync(path.join(SRC, 'persistence/index.js'), 'utf8');
    ok(!/stripExpanded/.test(px), '折叠态不进 IDB（它压根不在节点上，见 ⑥）');
}

// ================================================================
group('⑧ 只改 expanded 的节点在 diff 里不产生数据变更');
// ================================================================
{
    const { computeDiff } = await import(mod('persistence/diff.js'));
    const nodes = { n1: { id: 'n1', name: 'a' } };
    const before = { nodes, childOrder: {}, pages: {} };
    // 折叠只动 state.view ⇒ **节点引用不变** ⇒ diff 里一条数据变更都没有
    const afterFold = { nodes, childOrder: {}, pages: {} };
    eq(Object.keys(computeDiff(before, afterFold).nodesChanged).length, 0,
        '折叠不产生数据变更（它压根不在节点上）');
    const afterReal = { nodes: { n1: { id: 'n1', name: 'b' } }, childOrder: {}, pages: {} };
    eq(Object.keys(computeDiff(before, afterReal).nodesChanged).length, 1,
        '对照：真改了字段仍然看得出差异（上一条不是恒真）');
}

report();
