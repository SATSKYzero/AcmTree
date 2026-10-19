// ================================================================
// 冒烟测试：「检索」页（scripts/smoke/search.smoke.mjs）
//
// 一级 tab「检索」之下分两个子页：
//   **比赛检索** / **题目检索**。
//
// 覆盖 Node 单测覆盖不到的部分：
//   - 插件激活并注册为一级 Tab（id `search`）
//   - 二级 tab 栏：默认停在「比赛检索」，切到「题目检索」真的换内容
//   - 比赛检索：控制栏 / 结果表真实装配、筛选真改变结果集、题目数数得对
//   - 题目检索：筛选交互可用
//   - 两个子页都走同一条跳转契约（EVENTS.REVEAL_NODE）
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

// ---- DOM 桩 ----
const body = installDom();
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'tab-main');

globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'))
});

// 还原 index.html 的静态一级 Tab（镜像当前的 index.html）
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

// ---- 被测模块 ----
const registry = await import(mod('core/pluginRegistry.js'));
const tabs = await import(mod('ui/tabs.js'));
const { bootstrapPlugins } = await import(mod('shell/bootstrap.js'));
const { AppState } = await import(mod('shell/state.js'));
const { EVENTS } = await import(mod('A_constants.js'));
const eventBridge = await import(mod('ui/eventBridge.js'));

// ---- 造数据：两棵树（cf / xcpcio），各一个 C；cf 那场下 3 道 P ----
const N = (id, type, extra = {}) => ({ id, type, name: extra.name || id, ...extra });
AppState.rootId = 'root';
AppState.nodes = {
    root: N('root', 'O', { name: '根' }),
    w1: N('w1', 'W', { name: 'Codeforces' }),
    s1: N('s1', 'S', { name: 'Div2' }),
    c1: N('c1', 'C', {
        name: 'Round 900', contestTime: '2024-05-01 10:00:00', kind: 'contest',
        natureClass: 'cf/contest/div2', natureYear: '2024', natureSeason: '2024',
        natureRegion: '无'
    }),
    w2: N('w2', 'W', { name: 'XCPCIO' }),
    s2: N('s2', 'S', { name: '省赛' }),
    c2: N('c2', 'C', {
        name: '2025 浙江省赛', contestTime: '2025-10-02 09:00:00',
        natureClass: 'xcpc/provincial&invitational/official', natureYear: '2025',
        natureSeason: '2025', natureRegion: '浙江'
    }),
    // ⚠️ `status1` / `status2` 是**手动覆盖** —— 值在**来源层**（`src:'manual'`），
    //    缓存字段只是物化投影；只写缓存不算数，必须写进来源层。
    p1: N('p1', 'P', {
        name: 'Two Sum', problemId: 'A', cfDifficulty: 800, xcpcDifficulty: '签到', ratio: '90',
        tags: [{ id: 't1', text: 'dp', color: '红' }],
        values: {
            status1: [{ v: '1', src: 'manual', at: 'T1' }],
            status2: [{ v: '4', src: 'manual', at: 'T1' }]
        }
    }),
    p2: N('p2', 'P', {
        name: 'Graph Walk', problemId: 'B', cfDifficulty: 1800, xcpcDifficulty: '银牌', ratio: '10',
        tags: [{ id: 't2', text: '图论', color: '蓝' }],
        values: { status2: [{ v: '1', src: 'manual', at: 'T1' }] }   // 待写
    }),
    p3: N('p3', 'P', { name: 'Hard One', problemId: 'C', cfDifficulty: 2600, xcpcDifficulty: 'C+', ratio: '3', tags: [] })
};
AppState.parentOf = { w1: 'root', s1: 'w1', c1: 's1', p1: 'c1', p2: 'c1', p3: 'c1',
    w2: 'root', s2: 'w2', c2: 's2' };
AppState.childOrder = { root: ['w1', 'w2'], w1: ['s1'], s1: ['c1'], c1: ['p1', 'p2', 'p3'],
    p1: [], p2: [], p3: [], w2: ['s2'], s2: ['c2'], c2: [] };
AppState.currentPageId = 'main';
AppState.currentTab = 'main';

// 注册事件桥（含 REVEAL_NODE 监听）
eventBridge.registerAllEvents();

// ===============================================================
group('插件激活与页签注册（一级 tab 是「检索」）');
// ===============================================================
const summary = await bootstrapPlugins();
ok(summary.activated.includes('Search'), 'Search 插件已激活');
eq(summary.failed.length, 0, '无激活失败');

AppState.currentTab = 'main';
tabs.setupTabs();
const searchTab = registry.getPluginTabs().find(t => t.id === 'search');
ok(!!searchTab, '注册了一级 Tab: search');
ok(/检索/.test(searchTab.label), `标签是「检索」（实际 ${searchTab.label}）`);
ok(!registry.getPluginTabs().some(t => t.id === 'problem-search'),
    '★ `problem-search` 不单独注册页签（入口只有「检索」一个）');

// ===============================================================
group('二级 tab 栏：默认「比赛检索」，可切「题目检索」');
// ===============================================================
tabs.switchTab('search');
const panel = document.getElementById('tab-search');
ok(!!panel, '插件页容器已创建');
eq(panel.classList.contains('active'), true, '插件页已激活');

const subtabs = panel.querySelectorAll('.search-subtab');
eq(subtabs.length, 2, '二级 tab 栏有且只有两个子页');
eq(subtabs.map(b => b.dataset.section).join(','), 'contest,problem', '顺序：比赛检索 → 题目检索');
eq(panel.querySelector('.search-subtab-on').dataset.section, 'contest', '默认停在「比赛检索」');
eq(panel.querySelector('.search-body').dataset.section, 'contest', '子页容器跟着切换');

// ===============================================================
group('比赛检索：装配 + 筛选 + 题目数');
// ===============================================================
const contestRows = () => panel.querySelectorAll('.cs-result-row');
eq(contestRows().length, 2, '默认列出全部 2 场比赛');
ok(/Round 900/.test(serialize(panel)) && /浙江省赛/.test(serialize(panel)), '两场的名字都画出来了');
ok(/命中 2 场比赛/.test(serialize(panel)), '显示命中数量');
ok(/Codeforces \/ Div2/.test(serialize(panel)), '归属列 = 平台 / 最近的系列');
ok(/cf\/contest\/div2/.test(serialize(panel)), '性质列画的是分类路径');
ok(contestRows().some(tr => /3/.test(tr.innerHTML)), '★ 题目数列数得对（c1 下 3 道 P）');

// 年份芯片：点 2025 ⇒ 只剩省赛
const yearChip = panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === '2025');
ok(!!yearChip, '年代维度渲染出 2025');
yearChip.click();
eq(contestRows().length, 1, '★ 按年代 2025 筛 ⇒ 只剩 1 场');
ok(/浙江省赛/.test(serialize(panel)), '剩下的是 2025 那场');
panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === '2025').click();
eq(contestRows().length, 2, '取消条件后恢复 2 场');

// 性质芯片：前缀匹配（`cf/contest` 不该命中 xcpc 那场）
const classChip = panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === 'cf/contest');
ok(!!classChip, '性质维度给的是分类路径前两段（cf/contest）');
classChip.click();
eq(contestRows().length, 1, '★ 性质按前缀匹配 ⇒ 只剩 cf 那场');
panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === 'cf/contest').click();

// ===============================================================
group('跳转契约：比赛行也派发 REVEAL_NODE');
// ===============================================================
const revealed = [];
document.addEventListener(EVENTS.REVEAL_NODE, e => revealed.push(e.detail && e.detail.nodeId));

const contestRow = contestRows()[0];
contestRow.click();
eq(revealed.length, 1, '点击比赛行派发了一次 REVEAL_NODE');
eq(revealed[0], contestRow.dataset.id, '事件携带正确的 nodeId');

// ===============================================================
group('题目检索：切过去仍是同一套');
// ===============================================================
panel.querySelectorAll('.search-subtab').find(b => b.dataset.section === 'problem').click();
eq(panel.querySelector('.search-subtab-on').dataset.section, 'problem', '已切到「题目检索」');
eq(panel.querySelector('.search-body').dataset.section, 'problem', '子页容器跟着换');
eq(panel.querySelectorAll('.ps-result-row').length, 3, '默认列出全部 3 道题');
ok(panel.querySelectorAll('.ps-chip').length > 0, '筛选芯片仍渲染');
ok(/题号/.test(serialize(panel)) && /题名/.test(serialize(panel)), '表头仍是题目那套');
ok(/命中 3 道题/.test(serialize(panel)), '显示命中数量');

// 状态2 = 1 ⇒ 只剩 p2
const statusChip = panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === '1');
ok(!!statusChip, '找到状态2=1 的筛选芯片');
statusChip.click();
eq(panel.querySelectorAll('.ps-result-row').length, 1, '筛选后只剩 1 道题');
panel.querySelectorAll('.ps-chip').find(c => c.dataset.value === '1').click();
eq(panel.querySelectorAll('.ps-result-row').length, 3, '取消条件后恢复 3 道题');

const problemRow = panel.querySelectorAll('.ps-result-row')[0];
problemRow.click();
eq(revealed.length, 2, '题目行同样派发 REVEAL_NODE');
eq(revealed[1], problemRow.dataset.id, '事件携带正确的 nodeId');

// 切回比赛检索：状态各自保留（子页的 viewState 是模块级的）
panel.querySelectorAll('.search-subtab').find(b => b.dataset.section === 'contest').click();
eq(panel.querySelectorAll('.cs-result-row').length, 2, '切回比赛检索仍是 2 场');

// ===============================================================
group('结果表新增的「节点」列：身份键 + 完整面包屑 + 📋（用户："还是题名和完整面包屑都有为好"）');
// ===============================================================
// ★ 那一格用的是**宿主注入**的 `ctx.nodeEntry`（`ui/tabs.js:mountPluginTab` →
//   `ui/kit/nodeEntry.js:nodeEntryLine`）：插件**不 import `ui/`**，所以这条也顺带钉住"注入真的送到了"。
{
    // ⚠️ 上一组结尾停在「比赛检索」⇒ 先切回题目检索（`.ps-result-row` 现在才在）
    panel.querySelectorAll('.search-subtab').find(b => b.dataset.section === 'problem').click();
    const pRow = panel.querySelectorAll('.ps-result-row')[0];
    const cell = pRow && pRow.querySelector('.ps-node-cell');
    ok(!!cell, '★ 题目行多了一格 `.ps-node-cell`（题名那一格一个字没动）');

    const chip = cell && cell.querySelector('.node-entry-id');
    ok(!!chip && String(chip.textContent).trim().length > 0,
        '★ 第一格是**身份键**（这组数据没填 extKey ⇒ 退回节点 id）',
        chip ? String(chip.textContent) : '（没有 id 芯片）');
    eq(chip ? String(chip.textContent).trim() : '', String(pRow.dataset.id),
        '★ 退回的 id 就是这一行那个节点（不是别的）');

    ok(!!(cell && cell.querySelector('.node-entry-crumb[data-reveal-node]')),
        '★ 面包屑在，而且**它自己就是 🔎**（`data-reveal-node` 挂在它上面）');
    ok(!!(cell && cell.querySelector('.btn-node-info')), '★ 📋 详页入口在');

    // ⚠️ 用户实测过的坑（`src/features/AGENTS.md` 的 AutoImport 那条）：整行可点 + 行内有 📋 ⇒
    //    点 📋 会**同时**跳树、开详页。判据：点 📋 **不准**再多派发一颗 REVEAL_NODE。
    //    ⚠️ 这一下会真的开详页并触发重画 ⇒ 放这一组的**最后**（后面的断言别再引用 `pRow`）。
    const before = revealed.length;
    cell.querySelector('.btn-node-info').click();
    eq(revealed.length, before, '★ 点行内那颗 📋 **不**触发整行跳树（一次点击只做一件事）');
}

{
    panel.querySelectorAll('.search-subtab').find(b => b.dataset.section === 'contest').click();
    const cRow = contestRows()[0];
    const cCell = cRow && cRow.querySelector('.cs-node-cell');
    ok(!!(cCell && cCell.querySelector('.node-entry-id')) && !!cCell.querySelector('.btn-node-info'),
        '★ 比赛检索那张表也补上了同一格（两个子页形状一致）');
    const cBefore = revealed.length;
    cCell.querySelector('.btn-node-info').click();
    eq(revealed.length, cBefore, '★ 比赛行同理：点 📋 不跳树');
}

report();
