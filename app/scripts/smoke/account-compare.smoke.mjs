// ================================================================
// 冒烟测试：账户对比视图（scripts/smoke/account-compare.smoke.mjs）
//
// 一屏里看 3 个人各自的补题情况。
// 入口**只有数据统计页的「👥 账户对比」子页签**。
// （不按 `ctx.nodeId` 筛子树、永远比全树的那种"栏"容易误导 ——
//   子树那一层交给「筛选模式」代偿。）
// 走**真实路径**：装 DOM → 切到那个子页签 → 真的渲染表格 → 展开比赛 →
// 看同一道题上不同账户的格子 → 筛选 → 点题目打开编辑弹窗。
//
// 为什么单测不够：`core/query/compare.js` 保证"算对了"，
// 但"点了页签有没有东西出来、格子是不是真的按人不同"必须端到端看一遍。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';
import { STATUS2_ICONS } from '../../src/A_constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
makeContainer(body, 'toast');

// ---- 数据统计页的子页签骨架（与 index.html 同构） ----
// 注意：这里用 makeContainer 建"要按 id 找"的容器（DOM 桩的 getElementById 只认注册过的 id），
// 应用代码正是靠 `document.getElementById('subtab-data-compare')` 找它的。
const stats = makeContainer(body, 'tab-stats');
const bar = makeContainer(stats, 'data-stats-sub-tabs');
bar.innerHTML = `
  <button class="sub-tab-btn" data-subtab="data-training">📊 训练强度追踪</button>
  <button class="sub-tab-btn" data-subtab="data-ac-tracking">📈 最近AC题目列表</button>
  <button class="sub-tab-btn" data-subtab="data-compare">👥 账户对比</button>
`;
makeContainer(stats, 'subtab-data-training');
makeContainer(stats, 'subtab-data-ac-tracking');
const compareHost = makeContainer(stats, 'subtab-data-compare');

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { createNode } = await import(mod('core/model/node.js'));
const { createAccount, saveAccount } = await import(mod('core/ops/account.js'));
const { renderStatsTabContent } = await import(mod('ui/stats/acTracking.js'));

// ---------------------------------------------------------------
// 夹具：本机 + 两个账户（主号 k1 / 队友 k2）；一场比赛 3 道题
//   A 题：k1 赛时通过   → k1 ✅ / k2 ⬜
//   B 题：k2 提交没过   → k1 ⬜ / k2 🔴
//   C 题：谁都没碰      → 两人都 ⬜
// ---------------------------------------------------------------
function seed() {
    const base = createInitialState();
    for (const key of Object.keys(base)) AppState[key] = base[key];
    const put = (id, type, parentId, extra = {}) => {
        AppState.nodes[id] = createNode(id, type, extra);
        AppState.childOrder[id] = [];
        AppState.parentOf[id] = parentId;
        if (parentId) AppState.childOrder[parentId].push(id);
    };
    put('c1', 'C', AppState.rootId, { name: '第一场', contestTime: '2026.09.01 10:00' });
    put('pa', 'P', 'c1', { name: 'A 题', problemId: 'A' });
    put('pb', 'P', 'c1', { name: 'B 题', problemId: 'B' });
    put('pc', 'P', 'c1', { name: 'C 题', problemId: 'C' });
    put('ra', 'R', 'pa', { name: '提交A', status: 'AC', time: '2026.09.01 10:10' });
    put('rb', 'R', 'pb', { name: '提交B', status: 'WA', time: '2026.09.01 10:20' });
    AppState.nodes.ra.values = { status: [{ v: 'AC', src: 'qoj:x', at: 'T1', account: 'k1' }] };
    AppState.nodes.rb.values = { status: [{ v: 'WA', src: 'qoj:x', at: 'T1', account: 'k2' }] };

    createAccount(AppState, { id: 'k1', name: '主号' });
    createAccount(AppState, { id: 'k2', name: '队友' });
    AppState.currentAccountId = 'k1';
    AppState.viewingAccountId = 'k1';
    // 把 k2 挂到 k1 底下：这就是"一队"在数据上的样子
    saveAccount(AppState, 'k1', { children: ['k2'] });
}

// ===============================================================
group('账户对比：数据统计页的子页签（唯一入口）');
// ===============================================================
seed();
renderStatsTabContent('compare');

const btn = document.querySelector('#data-stats-sub-tabs [data-subtab="data-compare"]');
ok(btn && btn.classList.contains('active'), '子页签按钮变成激活状态');
eq(getComputedDisplay('subtab-data-compare'), 'block', '对比容器显示出来了');
eq(getComputedDisplay('subtab-data-ac-tracking'), 'none', '其它子页签被隐藏');

const html = serialize(compareHost);
ok(/第一场/.test(html), '首屏列出了比赛');
ok(/主号/.test(html) && /队友/.test(html), '两列分别是两个账户');
ok(/通过 <strong>\d+<\/strong>/.test(html) || /通过/.test(html), '列头有"通过 x/y"汇总');

// 默认只显示"有人没过"：A 题（k1 过了、k2 没碰）算有人没过 → 应该出现在展开里
// 首屏是折叠的，先展开第一场
const groupRow = compareHost.querySelector('.compare-group');
ok(!!groupRow, '有可展开的比赛行');
groupRow.click();

// ===============================================================
group('账户对比：同一道题上，不同账户的格子必须不同');
// ===============================================================
const rows = compareHost.querySelectorAll('.compare-problem');
eq(rows.length >= 1, true, `展开后列出了题目行（${rows.length} 行）`);

const rowOf = (pid) => [...compareHost.querySelectorAll('.compare-problem')]
    .find(tr => tr.dataset.problem === pid);

// 默认筛选 = 「只看差异（有人过、有人没过）」：
//   A 题：k1 有 AC、k2 没碰 → 差异 → 显示
//   B 题：两人都没过（一个 WA、一个没碰）→ 不是差异 → 不显示
//   C 题：谁都没碰 → 不显示
const rowA = rowOf('pa');
ok(!!rowA, 'A 题在列表里（一人过、一人没碰 → 差异）');
const cellsA = rowA.querySelectorAll('td');
// td[0] 是题目名，之后按列顺序
// ⚠️ 图标从 `STATUS2_ICONS` 取（不在冒烟里硬编 🟢/⬜/🔴 —— 那是同一张表）
ok(serialize(cellsA[1]).includes(STATUS2_ICONS[3]),
   `A 题上主号是"赛后补题（有 AC）"：${serialize(cellsA[1]).slice(0, 60)}`);
ok(serialize(cellsA[2]).includes(STATUS2_ICONS[0]),
   `A 题上队友是"未使用"（他没碰过）：${serialize(cellsA[2]).slice(0, 60)}`);
ok(!rowOf('pc'), 'C 题（谁都没碰）在默认筛选下不显示');

// ===============================================================
group('账户对比：筛选与搜索');
// ===============================================================
const only = compareHost.querySelector('#compare-only');
ok(!!only, '有筛选下拉');
only.value = '';
only.dispatchEvent({ type: 'change' });
ok(!!rowOf('pc'), '切到「全部」后，谁都没碰的 C 题也出现了');

const rowB = rowOf('pb');
ok(!!rowB, 'B 题也出现了');
const cellsB = rowB.querySelectorAll('td');
ok(serialize(cellsB[1]).includes(STATUS2_ICONS[0]), 'B 题上主号是"未使用"');
ok(serialize(cellsB[2]).includes(STATUS2_ICONS[2]), 'B 题上队友是"已提交未通过"');

const only2 = compareHost.querySelector('#compare-only');
only2.value = 'k1';
only2.dispatchEvent({ type: 'change' });
ok(!rowOf('pa'), '「只看主号没过的」：A 题被排除（主号过了）');
ok(!!rowOf('pb'), 'B 题留着（主号没碰）');

const only3 = compareHost.querySelector('#compare-only');
only3.value = 'undone';
only3.dispatchEvent({ type: 'change' });
const search = compareHost.querySelector('#compare-search');
search.value = 'B 题';
search.dispatchEvent({ type: 'input' });
ok(!!rowOf('pb'), '搜索"B 题"能命中');
ok(!rowOf('pa'), '搜索时其它题不显示');

// ===============================================================
group('账户对比：勾选对比对象');
// ===============================================================
search.value = '';
search.dispatchEvent({ type: 'input' });
const toggles = compareHost.querySelectorAll('.compare-account-toggle');
ok(toggles.length >= 2, `有账户勾选（${toggles.length} 个）`);
// 取消队友 → 表头里不该再有他（列 = 标签 + 主号 + 本机）
const k2Box = [...toggles].find(t => t.dataset.account === 'k2');
k2Box.checked = false;
k2Box.dispatchEvent({ type: 'change' });
const heads = compareHost.querySelectorAll('thead th');
eq(heads.length, 3, `列数 = 标签 + 主号 + 本机（实际 ${heads.length}）`);
ok(!/队友/.test(serialize(heads)), '取消勾选后"队友"这一列没了');

// ===============================================================
group('账户对比：点题目打开编辑弹窗（只读，不改全局"在查看"）');
// ===============================================================
{
    const before = AppState.viewingAccountId;
    const row = rowOf('pa') || rowOf('pb');
    ok(!!row, '（前提）有可点的题目行');
    row.click();
    await new Promise(r => setTimeout(r, 60));
    const panel = body.querySelectorAll('.modal-panel');
    ok(panel.length > 0, '点题目后弹出了编辑面板');
    eq(AppState.viewingAccountId, before, '对比视图不会偷偷切换"在查看"');
}

report();

function getComputedDisplay(id) {
    const el = document.getElementById(id);
    return el ? (el.style.display || '') : '(缺失)';
}
