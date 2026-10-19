// ================================================================
// 冒烟测试：界面三件（scripts/smoke/v84-ux.smoke.mjs）
//
// 优化项：
//   #1 「节点自动导入」要显示**正在导入/已导入的包文件名**；
//   #2 大范围导入要**进度条 + 预计时间**（先拿到总数再逐项推进、分片让出主线程）；
//   #3 折叠状态改为**只进本地缓存**（不进快照、不进导入导出包，关闭再启动保留）；
//   #4 一级 tab 栏把「🧩 判重整理」移到**最后一位**（「📥 节点自动导入」右侧）。
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

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
makeContainer(app, 'tab-bar');
makeContainer(app, 'toast');

// 内存版 localStorage（桩默认是空实现；折叠缓存要真的读写）
const mem = new Map();
globalThis.localStorage = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k)
};

// ---- #4 tab 顺序 ----
// ⚠️ 一级栏最后三位 = 「⚙️ 设置」→「🩺 体检 / 需求」（设置是一级 Tab、
//    体检报告也在应用里，见 `ui/settings/settingsPage.js` /
//    `ui/coverage/coveragePage.js`）。这条钉的意图是"判重整理排在插件页右侧"，
//    它现在是**内置页里的倒数第三位**。
group('#4 一级 tab：「判重整理」排在插件页右侧（设置/体检之前）');
{
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const bar = html.slice(html.indexOf('id="tab-bar"'), html.indexOf('id="tab-dedup"'));
    const btns = [...bar.matchAll(/data-tab="([^"]+)"(?:[^>]*data-order="(\d+)")?/g)]
        .map(m => ({ id: m[1], order: m[2] || '' }));
    ok(btns.length >= 4, 'index.html 的 #tab-bar 里有内置按钮', `(${btns.map(b => b.id).join(', ')})`);
    eq(btns[btns.length - 1].id, 'coverage', '「🩺 体检 / 需求」是 HTML 里的最后一个内置按钮');
    eq(btns[btns.length - 2].id, 'settings', '设置排在它前一位');
    eq(btns[btns.length - 3].id, 'dedup', '判重整理在设置之前');
    eq(btns[btns.length - 3].order, '1500', '判重整理带 data-order=1500');

    const { readBuiltinTabs } = await import(mod('ui/tabs.js'));
    const { resolveTabs } = await import(mod('ui/tabRegistry.js'));
    const barEl = document.getElementById('tab-bar');
    for (const b of btns) {
        const el = document.createElement('button');
        el.className = 'tab-btn';
        el.dataset.tab = b.id;
        if (b.order) el.dataset.order = b.order;
        barEl.appendChild(el);
    }
    const builtins = readBuiltinTabs();
    eq(builtins.find(t => t.id === 'dedup').order, 1500, 'readBuiltinTabs 认 data-order');
    const merged = resolveTabs(builtins, [
        { id: 'auto-import', label: '📥 节点自动导入', order: 1400 }
    ]).map(t => t.id);
    eq(merged[merged.length - 3], 'dedup', '合并插件页后判重整理仍在设置之前、插件页之后');
    ok(merged.indexOf('auto-import') < merged.indexOf('dedup'),
        '判重整理在「节点自动导入」右侧', `(${merged.join(' → ')})`);
}

// ---- #1 包文件名 ----
group('#1 导入页显示包文件名');
{
    const { renderPanel } = await import(mod('features/AutoImport/index.js'));
    const box = makeContainer(app, 'ai-test-1');
    // 用"解析失败"的批次：这条分支不需要完整 plan，最有代表性（一眼看出导的是哪份）
    renderPanel(box, {
        kind: 'tab', forcedParentId: '', selected: 0,
        batches: [{ file: 'xcpc.json', source: '', plan: null, error: '测试用：故意失败' }]
    });
    const line = box.querySelector('.ai-files');
    ok(!!line, '渲染出「已载入的包」那一行');
    eq(line.dataset.files, 'xcpc.json', '文件名写进 data-files（便于断言/排查）');
    ok(serialize(line).includes('xcpc.json'), '文件名真的显示在界面上');
    ok(serialize(box).includes('xcpc.json'), '文件名在整块面板里可见');
}

// ---- #2 进度与预计时间 ----
group('#2 进度条 + 预计时间（先拿总数、再逐项推进）');
{
    const { readAllFiles } = await import(mod('features/AutoImport/files.js'));
    const calls = [];
    // 桩环境没有 FileReader：读取会失败，但**进度回调必须照报**（它只依赖文件名/总数）
    await readAllFiles([{ name: 'a.json', size: 1024 }, { name: 'b.json', size: 2048 }],
        { onProgress: (info) => calls.push(info) });
    eq(calls.length, 2, '每个文件读完都回调一次');
    eq(calls[0].total, 2, '第一次回调就知道总数（不是边跑边猜）');
    eq(calls[1].done, 2, '推进到 2/2');
    eq(calls[1].file, 'b.json', '回调带着当前文件名');

    const { makeProgress } = await import(mod('features/AutoImport/index.js'));
    const wrap = makeContainer(app, 'ai-test-2');
    const p = makeProgress(wrap);
    p.set({ phase: '解析与出计划', done: 3, total: 10 });
    eq(p.el.dataset.phase, '解析与出计划', '进度元素带 data-phase');
    eq(p.el.dataset.done, '3', 'data-done 跟着推进');
    eq(p.el.dataset.total, '10', 'data-total = 总数');
    ok(/预计还需/.test(serialize(p.el)), '给出了"预计还需"', `(${serialize(p.el).slice(0, 40)}…)`);
    ok(serialize(p.el).includes('30%'), '百分比算出来了');
    p.spin('写入节点', '一次事务');
    eq(p.el.dataset.phase, '写入节点', '不可分片的阶段换阶段名');
    ok(/不可分片/.test(serialize(p.el)), '写入阶段如实说明"不可分片"，不假装有百分比');
}

// ---- #3 折叠状态只进本地缓存 ----
group('#3 折叠状态：本地缓存，不进快照/导出包');
{
    const { saveView, loadView, applyView, isExpanded, pageOf, VIEW_CACHE_KEY } =
        await import(mod('core/model/viewState.js'));
    const nodes = {
        n1: { id: 'n1', name: 'a' },
        n2: { id: 'n2', name: 'b' },
        n3: { id: 'n3', name: 'c' }
    };
    // 视图态**不住在 nodes 里**（state.view）⇒ 这份 nodes 与折叠无关
    eq(nodes.n1.name, 'a', '节点字段照旧');

    saveView({ view: { expanded: { n2: true } } });
    {
        const saved = JSON.parse(mem.get(VIEW_CACHE_KEY));
        ok(saved && Array.isArray(saved.expanded) && saved.expanded.includes('n2') && !saved.expanded.includes('n1'),
            'localStorage 里存的是**稀疏数组**（只列展开的 id —— 全表逐个写 boolean 是 653KB，'
            + '每次折叠后都要同步写一次）');
    }
    const restored = { nodes: { n1: { id: 'n1' }, n2: { id: 'n2' }, n9: { id: 'n9' } } };
    eq(applyView(restored), 1, '贴回展开的那一个');
    eq(isExpanded(restored, 'n2'), true, '展开的贴回来还是展开');
    ok(!isExpanded(restored, 'n1'), '收起的没进缓存 ⇒ 默认就是收起');
    ok(!isExpanded(restored, 'n9'), '缓存里没有的节点保持默认（不乱动）');
    eq(loadView().expanded.n2, true, 'loadView 把稀疏表读回 `{expanded:{id:true}}`');

    const { buildExportData } = await import(mod('persistence/index.js'));
    const data = buildExportData({
        rootId: 'n1', nodes, childOrder: {}, pages: {}, settings: {},
        meta: { idCounter: 1 }, currentPageId: 'main'
    });
    ok(!('view' in data) && !('expanded' in data.nodes.n1), '导出包里既没有 view 层、也没有 expanded（折叠/页码不进包）');
}
// 折叠那条链：折叠**不入历史快照**（skipHistory）+ 折叠后写缓存
{
    const src = fs.readFileSync(path.join(SRC, 'ui/G_events.js'), 'utf8');
    const block = src.slice(src.indexOf('async function toggleNodeExpanded'), src.indexOf('// 翻页'));
    ok(/skipHistory: true/.test(block), '折叠走 skipHistory（不进历史快照）');
    ok(/skipVirtualStats: true/.test(block),
        '折叠跳过副页统计重算（探针实测：immer 里重算 ≈17ms，而折叠不改任何取值）');
    ok(/scheduleViewSave\(AppState\)/.test(block), '折叠后**合并写入**本地缓存（连点只落盘一次）');
    ok(!/dispatchEvent\(new CustomEvent\(EVENTS\.UI_REFRESH_REQUIRED/.test(block),
        '折叠不重复派发刷新（execute 的 refreshFn 已派发一次 ⇒ 只渲染 1 遍）');
    const cache = fs.readFileSync(path.join(SRC, 'core/model/viewState.js'), 'utf8');
    ok(/VIEW_CACHE_KEY/.test(cache), '折叠缓存有唯一键名');
}

group('#3b 折叠缓存：合并写入 + 强制 flush');
{
    const { scheduleViewSave, flushViewSave, VIEW_CACHE_KEY } =
        await import(mod('core/model/viewState.js'));
    const map = new Map();
    globalThis.localStorage = {
        getItem: k => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: k => map.delete(k)
    };
    map.clear();
    const st = { view: { expanded: { a: true } } };
    scheduleViewSave(st, 50);
    ok(map.size === 0, 'scheduleViewSave：**不立即**写盘（合并写入）');
    const wrote = flushViewSave();
    ok(wrote && map.size === 1, 'flushViewSave：强制落盘');
    const v = JSON.parse(map.get(VIEW_CACHE_KEY));
    ok(v && Array.isArray(v.expanded) && v.expanded.includes('a'), '落盘内容正确（稀疏：a 是展开的）');
}


// ---- 包名占位 / 执行条位置 / 悬浮件可见性 ----
// ⚠️ 面板那段在 `features/AutoImport/ui/`（拆分是纯搬家）——
//    这几个源码锚**跟着文件走**：占位行与"统计 → 执行条 → 记录表"的顺序都在 `ui/panel.js`，
//    执行条的**定义**在 `ui/batchTabs.js`。锚盯别的文件会假红（实测就是这么发现的）。
const AI_PANEL_SRC = fs.readFileSync(
    path.join(SRC, 'features', 'AutoImport', 'ui', 'panel.js'), 'utf8');
const AI_BATCHTABS_SRC = fs.readFileSync(
    path.join(SRC, 'features', 'AutoImport', 'ui', 'batchTabs.js'), 'utf8');

group('#1b 未载入时也留一行「包名」占位');
{
    const src = AI_PANEL_SRC;
    ok(/未载入包/.test(src), '空态也渲染一行包名占位（不是整行不存在）');
    ok(/filesEmpty\.dataset\.files = ''/.test(src), '占位行带 data-files=""（便于断言/排查）');
}

group('#2 执行条紧跟「新增/更新」统计栏');
{
    const src = AI_PANEL_SRC;
    const i = src.indexOf('renderSummary(wrap, plan, {');
    // ⚠️ 窗口别掐太死：这两段之间只有"算要写多少 / 能不能执行"的几行（还有
    //    合成计数、随包元数据两处判据）—— 掐到 900 字符会误报"不相邻"。
    const after = src.slice(i, i + 2500);
    ok(i > 0 && /renderExecuteBar\(wrap, \{/.test(after), '执行条就在统计栏之后（相邻）');
    // 定义在 batchTabs.js、调用在 panel.js ⇒ 两处合起来正好 2 个（没有留在页尾的第二处调用）
    const calls = [...src.matchAll(/renderExecuteBar\(/g)].length
        + [...AI_BATCHTABS_SRC.matchAll(/renderExecuteBar\(/g)].length;
    eq(calls, 2, '执行条只有「定义 + 这一处调用」（没有留在页尾的第二处）');
    ok(src.indexOf('renderRecordTable(wrap, plan, {') > src.indexOf('renderExecuteBar(wrap, {'),
       '顺序 = 统计 → 执行条 → … → 记录表（执行条不留在页尾）');
}

group('#3 悬浮件只在主视图显示（节点信息页/插件页不显示）+ **按住 Ctrl 才显示**');
{
    const src = fs.readFileSync(path.join(SRC, 'ui/floaters.js'), 'utf8');
    ok(/updateFloaterVisibility/.test(src), '有可见性判据函数');
    ok(/getCurrentTab\(\)/.test(src) && /DEFAULT_TAB_ID/.test(src), '判据基于「当前 tab」而不是「有没有建过」');
    ok(/isNodeInfo/.test(src), '显式排除节点信息页');
    ok(/style\.display = show \? '' : 'none'/.test(src), '切走时真的隐藏（不是靠 z-index 之类的补丁）');
    ok(/closest\('#tab-bar, #nodeinfo-tab-bar'\)/.test(src), '点标签栏后重判（事件委托，不反向依赖 tabs.js）');
    // ★ 悬浮的按钮与展开节点计数：ctrl 才显示（按 Ctrl 开、松开关）
    ok(/onMain && ctrlHeld/.test(src), '★ 两个条件同时满足才显示：主视图 ∧ 按住 Ctrl');
    ok(/addEventListener\('keydown'/.test(src) && /addEventListener\('keyup'/.test(src),
        '★ 按住 Ctrl 开、松开 Ctrl 关（keydown / keyup 都接了）');
    ok(/e\.key === 'Control'/.test(src), '★ 认的是 Ctrl 本身（不是"任何组合键"）');
    ok(/addEventListener\('blur'/.test(src) && /visibilitychange/.test(src),
        '★ 窗口失焦/切后台时当松开（否则那三块会一直挂着）');
    ok(/setupCtrlHold/.test(src) && /setupCtrlHold\(\);/.test(src), '开关在 setupFloaters 里接上');
}

report();
