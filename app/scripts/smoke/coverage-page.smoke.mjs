// ================================================================
// 冒烟测试：体检 / 需求页（scripts/smoke/coverage-page.smoke.mjs）
//
// 口径：**体检报告应该能在应用里看**。
//
// 这一页是**纯读**：数据只有 `AppState.reports` 一个来源（包顶层带的 `reports`，
// 导入时存进来 —— 见 `features/AutoImport/{parse,apply}.js`）。所以这里钉的是：
//   ① 一级栏里有这一页，切过去就画（**冷启动停在它上面**也要画，与判重整理同一个坑）；
//   ② 四栏（小结 / 原料需求 / 字段体检 / 同组不一致）都在，栏名带条数；
//   ③ **没有报告**时不许画出一张空表（"一个都不缺"是另一种错）—— 要说清"重建一次包就有"；
//   ④ 同组不一致**分页**：翻到最后一页、页码越界夹回来（115 组在真数据里就是这么多）；
//   ⑤ 数据一变（重新导入带报告的包）这一页跟着变，且**页面上不许漏 undefined/NaN**（报告字段多，
//      这是最容易漏的地方）。
// 不联网、不跑脚本；`AppState.reports` 直接塞。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer, serialize } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ① DOM 桩（镜像 index.html：`#tab-bar` 里四个内置按钮 + `#tab-coverage`）
const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
makeContainer(app, 'nodeinfo-tab-bar');
makeContainer(app, 'toast');       // ★ 复制失败要能从 toast 里看出来（T2）
const covPane = document.createElement('div');
covPane.id = 'tab-coverage';
covPane.className = 'tab-content';
app.appendChild(covPane);
for (const id of ['main', 'settings', 'dedup']) {
    const pane = document.createElement('div');
    pane.id = `tab-${id}`;
    pane.className = 'tab-content';
    app.appendChild(pane);
}
makeContainer(app, 'toast');
for (const [id, label, order] of [['main', '🏠 主视图', ''], ['stats', '📊 数据统计', ''],
    ['dedup', '🧩 判重整理', '1500'], ['settings', '⚙️ 设置', '1600'],
    ['coverage', '🩺 体检 / 需求', '1700']]) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = id;
    if (order) btn.dataset.order = order;
    btn.innerHTML = label;
    tabBar.appendChild(btn);
}

// ② 一份"最小但完整"的报告（形状与 `acm-data/reports/*.json` 一致）
function makeReports(nGroups = 60) {
    const rows = [
        { type: 'C', field: 'natureClass', expect: 'required', applies: 1456, filled: 1456, missing: 0, exempt: 0, why: '分类路径是骨架' },
        { type: 'P', field: 'clistDifficulty', expect: 'expected', applies: 20000, filled: 19470, missing: 530, exempt: 0, why: 'CLIST 里 rating 还没算出来' },
        { type: 'P', field: 'tags', expect: 'optional', applies: 20000, filled: 6671, missing: 13329, exempt: 0, why: '可选' },
    // ★ 并列的第四档 —— **不算缺**
    { type: 'P', field: 'link', expect: 'optional', applies: 13640, filled: 13469, missing: 0,
      missingLow: 171, missingLowSample: ['rankland:x'], exempt: 0, why: '多半拿不到' },
        { type: 'R', field: 'submissionId', expect: 'required', applies: 22922, filled: 22922, missing: 0, exempt: 0, why: '' },
        { type: 'P', field: 'cfDifficulty', expect: 'required', applies: 6000, filled: 5975, missing: 0, exempt: 25, why: 'gym 题不适用' }
    ];
    const inconsistent = Array.from({ length: nGroups }, (_, i) => ({
        type: 'P', field: 'clistDifficulty', parent: `cf:c:${2202 - i}`, total: 9, filled: 3,
        missing_keys: ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    }));
    return {
        coverage: {
            package: 'acm-data/nodes/all_nodes.json', registryVersion: 1,
            records: 24528, rows, inconsistent, deltas: { worse: [], better: [] }
        },
        needs: {
            package: 'acm-data/reports/material-needs.json',
            needs: [
                // ① 「该跑的命令」与「重跑这个来源」**不是一件事**（CLIST 难度是跨 judge 的缓存）
                { id: 'cf:clistDifficulty', channel: 'cf', channelLabel: 'Codeforces', field: 'P.clistDifficulty',
                  kind: 'refresh-cache', action: '刷 CLIST 难度缓存：`python -B scripts/clist-difficulty.py fetch --force`',
                  why: 'CLIST（clist.by）里这道题的 `rating` 为 null（**它还没算出来**）',
                  command: 'python -B "acm-data\\raw\\Scaper\\05 xcpc\\cf_contest_adapter.py" -o <临时文件>',
                  fixCommand: 'python -B scripts/clist-difficulty.py fetch --force',
                  caches: ['acm-data\\cache\\clist'],
                  gain: 426, exhausted: 0, groups: 90, sample: ['cf:c:1:p:A', 'cf:c:1:p:B'], partialGroups: {} },
                // ② 两条命令**相同**时不重复画（少一块就等于少一处"该看哪个"的犹豫）
                { id: 'atcoder:atcoderDifficulty', channel: 'atcoder', channelLabel: 'AtCoder', field: 'P.atcoderDifficulty',
                  kind: 'rerun-source', action: '重跑 atcoder 适配器', why: '上游没有难度估计',
                  command: 'python -B scripts/build-all.py --only-source atcoder',
                  fixCommand: 'python -B scripts/build-all.py --only-source atcoder',
                  caches: [], gain: 38, exhausted: 12, groups: 10, sample: ['atcoder:c:abc217:p:A'],
                  partialGroups: { 'atcoder:c:abc217': { total: 8, filled: 4 } } },
                // ③ 与 ① **共用同一条命令**（CLIST 是跨 judge 的缓存）⇒ 两张卡要并成一张
                { id: 'nk:clistDifficulty', channel: 'nk', channelLabel: '牛客', field: 'P.clistDifficulty',
                  kind: 'refresh-cache', action: '刷 CLIST 难度缓存：`python -B scripts/clist-difficulty.py fetch --force`',
                  why: 'CLIST（clist.by）里这道题的 `rating` 为 null（**它还没算出来**）',
                  command: 'python -B scripts/build-all.py --only-source nk',
                  fixCommand: 'python -B scripts/clist-difficulty.py fetch --force',
                  caches: [], gain: 50, exhausted: 0, groups: 12, sample: ['nk:c:1:p:A'], partialGroups: {} }
            ]
        }
    };
}

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const { renderCoveragePage, __resetCoveragePageState, currentCoverageSection } =
    await import(mod('ui/coverage/coveragePage.js'));
const { setupTabs, switchTab, getCurrentTab } = await import(mod('ui/tabs.js'));

function seed(reports) {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.reports = reports;
    __resetCoveragePageState();
}

const pane = () => document.getElementById('tab-coverage');
/** ⚠️ 文本要 `serialize()`（DOM 桩开了解析后，文本在子文本节点里，`textContent` 是空的） */
const text = () => serialize(pane());
/** ⚠️ 四栏现在走**统一模板**（可折叠的异常报告）：标识挂在 `data-stage` 上，
 *  由栏名那一行（可点）承载 —— 不再是标签按钮。 */
const section = (id) => pane().querySelector(`[data-stage="cov-${id}"]`);

// ================================================================
group('① 一级 Tab：分页栏里有「🩺 体检 / 需求」，切过去就有内容');
seed(makeReports());
setupTabs();
const tabBtn = tabBar.querySelectorAll('.tab-btn').find((b) => b.dataset.tab === 'coverage');
ok(!!tabBtn, '分页栏里有「🩺 体检 / 需求」按钮');
eq(tabBar.querySelectorAll('.tab-btn').map((b) => b.dataset.tab).slice(-1)[0], 'coverage',
    '它排在内置页最后（order 1700）');

switchTab('coverage');
await tick();
eq(getCurrentTab(), 'coverage', '切到了体检页');
ok(/🩺 体检 \/ 需求/.test(text()), '页面画出来了');
ok(!!section('summary') && !!section('needs') && !!section('fields') && !!section('groups'),
    '四栏都在（小结 / 原料需求 / 字段体检 / 同组不一致）');
ok(/24,528 个节点/.test(text()), '页头小结念了节点数（千分位）');
ok(/原料需求 3 条 → 2 条命令/.test(text()), '★ 页头小结里就说清了"只需跑 2 条命令"（别让人以为要跑 3 次）');
ok(/2 条需求共用这一条命令/.test(text()), '★ 小结那块也按命令合并着念');
ok(!/undefined|NaN/.test(text()), '⚠️ 页面上没有 undefined / NaN 漏出来');

// ================================================================
group('② 冷启动就停在体检页：也要画（与判重整理同一个坑）');
seed(makeReports());
document.getElementById('tab-coverage').innerHTML = '';
AppState.currentTab = 'coverage';
setupTabs();
await tick();
ok(/🩺 体检 \/ 需求/.test(text()), '冷启动（持久化的 currentTab）也把内容画出来了');

// ================================================================
group('③ 栏名带条数 + 切栏不丢筛选/页码');
seed(makeReports());
renderCoveragePage();
ok(/原料需求（3 条 \/ 2 条命令）/.test(text()), '需求栏名带"几条需求 / 几条命令"');
// ⚠️ 栏名现在就是**简要报告**（统一模板：折叠态只说结论，展开才是完整表格）⇒
//    标题里除了行数还带着三档缺，钉子跟着写全（不是放宽：数字写错照样红）。
ok(/字段体检（6 行 · 真缺 0 格 \/ 应该有而缺 530 格）/.test(text()), '字段体检栏名带行数（夹具 6 行，含并列的「多半拿不到」那一行）');
ok(/同组不一致（60 组）/.test(text()), '同组不一致栏名带组数');

section('groups').dispatchEvent({ type: 'click' });
ok(currentCoverageSection() === 'groups', '切到「同组不一致」栏');
ok(/第 1 \/ 3 页/.test(text()), '分页器显示第 1 / 3 页（每页 25 组）');
const next = pane().querySelector('.cov-next');
next.dispatchEvent({ type: 'click' });
ok(/第 2 \/ 3 页/.test(text()), '点「下一页 →」翻到第 2 页');
ok(/cf:c:2177/.test(text()), '第 2 页画的是第 26 组之后（不是又从第 1 组开始）');

// 切栏**不清**页码：去「小结」再回来还在第 2 页
section('summary').dispatchEvent({ type: 'click' });
section('groups').dispatchEvent({ type: 'click' });
ok(/第 2 \/ 3 页/.test(text()), '切栏回来页码还在（模块状态没被重画清掉）');

// ================================================================
group('④ 字段体检：29 行表 + "只看有缺"开关 + 三档缺分开念');
seed(makeReports());
renderCoveragePage();
section('fields').dispatchEvent({ type: 'click' });
ok(/必须有/.test(text()) && /应该有/.test(text()) && /可有可无/.test(text()),
    '档位名照念（必须有 / 应该有 / 可有可无）');
ok(/真缺 0 格 \/ 应该有而缺 530 格 \/ 可有可无而缺 13,329 格/.test(text()),
    '★ 三档缺**分开**写（混成一句"可疑 13,859"会把该动手的 530 淹掉）');
ok(/cfDifficulty/.test(text()), '豁免那行（cfDifficulty 25 格）也在表里');
// ★ 并列的那一列：直接钉**表头的列名**与**那一格的数字**，
//   而不是“页面上出现过这个词”（页头小结里也有这个词 ⇒ 光查文本是假绿）。
{
    // ⚠️ 这张表是 `table.innerHTML = ...` 画的：档里的元素 `textContent` 是**空**，
    //   只能用本文件的 `serialize()` 读（实测踩到：读 textContent 得到一串 `/`）。
    // ⚠️ 四栏改成折叠之后**所有栏的内容都在 DOM 里**（折叠只是 display）⇒
    //   不能再拿"最后一张 table"当字段体检那张（后面还有同组不一致的表）。按栏找。
    const table = pane().querySelector('.stage-body-cov-fields table');
    ok(/多半拿不到/.test(serialize(table.querySelector('thead'))),
        '★ 表头里就有「多半拿不到」这一列（与 已填/缺/豁免 并排）');
    const tr = [...table.querySelectorAll('tbody tr')]
        .find((r) => /`link`|link/.test(serialize(r.children[1])));
    ok(!!tr, '找到 `link` 那一行');
    ok(/171/.test(serialize(tr.children[7])),
        `★ 「多半拿不到」那一格就是数字（实际：${serialize(tr.children[7])}）`);
    ok(!/171/.test(serialize(tr.children[6])), '「豁免」那一格不是它（两档不混）');
}
ok(!/⏬ 多半拿不到 171/.test(text()), '不再是᠌徽标，而是与「豁免」同形态的**数字列**');
ok(!/171\/0/.test(text()), '★ 不会出现「171/0」那种显示');
const filter = pane().querySelector('.cov-fields-filter');
filter.dispatchEvent({ type: 'click' });
ok(!/natureClass/.test(text()), '「只看有缺」把没缺的行隐掉了（natureClass 不再出现）');
ok(/clistDifficulty/.test(text()) && /tags/.test(text()), '有缺的行还在');

// ================================================================
group('⑤ 原料需求：该跑的命令 + 合并同命令的卡 + "联网"标签 + 上游拿不到要说明');
seed(makeReports());
renderCoveragePage();
section('needs').dispatchEvent({ type: 'click' });
ok(/刷缓存（联网）/.test(text()), '联网那件事写在卡片上（kindLabel）');
ok(/✅ 该跑的命令/.test(text()), '★ 可复制的那条标成「该跑的命令」');
ok(/clist-difficulty\.py fetch --force/.test(text()), '命令原文在卡片里（要能直接复制到终端）');
ok(/另一件事（重跑这个来源/.test(text()),
    '★ 两条命令不同时，把"重跑来源"单列并说明它未必补得上（复制错了等于白跑）');
// ★ 合并：两个 fixture 需求共用同一条 clist 命令 ⇒ 一张卡（不是两张）
eq(pane().querySelectorAll('.cov-need-card').length, 2, '★ 同一条命令的两条需求合并成一张卡（1 张合并 + 1 张独立）');
eq(pane().querySelector('.cov-need-card').dataset.needs, '2', '卡上记着"这一条命令覆盖几条需求"');
ok(/这一条命令能一次补上：Codeforces P\.clistDifficulty \+426 格　·　牛客 P\.clistDifficulty \+50 格/.test(text()),
    '合并了哪几条要列出来（合并 ≠ 藏起来）');
ok(/该跑的命令（上面几条共用这一条）/.test(text()), '卡上写明"几条共用"');
eq(pane().querySelectorAll('.cov-command').length, 4, '1 条共用命令 + 2 条"重跑来源" + 1 条 atcoder 自己的命令');
ok(!!pane().querySelector('.cov-copy-btn'), '有「📋 复制」按钮');
pane().querySelector('.cov-copy-btn').dispatchEvent({ type: 'click' });
await tick(10);
// ★ `ok(true, '…不炸')` 是**永不失败的假绿** —— 这里必须断**可观察的结果**：
//   桩里没有剪贴板 ⇒ 必须走"手动选中"兜底并**说给人听**。
{
    const toastText = String(document.getElementById('toast').textContent);
    ok(/不能自动复制|复制失败|已复制/.test(toastText),
        `点「复制」要么复制成功、要么明说走手动选中（实际 toast：${toastText.slice(0, 40)}）`);
}
ok(/上游就没有/.test(text()), 'exhausted > 0 时说明"再跑也是白跑"');
ok(/atcoder:c:abc217（4\/8）/.test(text()), '半填的组也念出来了');
ok(/只需要跑 2 条命令/.test(text()), '★ 页头说清"只需跑几条命令"');
// ⚠️ 报告里的散文带 Markdown 记号，页面上必须**看不到**星号和反引号（漏出来就是 bug）
ok(!/\*\*/.test(text()), '★ 没有漏出 `**`（why/action 里的强调记号被去掉）');
ok(!/`/.test(text()), '★ 没有漏出反引号（`rating`、`problem-models.json` 那些）');

// ================================================================
group('⑥ 没有报告：说清"重建一次包就有"，**不画空表**');
seed(null);
renderCoveragePage();
ok(/这个包没带体检报告/.test(text()), '整页换成一句说明');
ok(/重建一次包/.test(text()) && /field-coverage\.py/.test(text()), '说明了报告是哪一步产出的');
ok(!section('fields'), '⚠️ 没有报告时**没有**「字段体检」栏（空表会被读成"一个都不缺"）');
ok(!/undefined|NaN/.test(text()), '这句说明里也没有 undefined/NaN');

seed({ coverage: null, needs: null });
renderCoveragePage();
ok(/这个包没带体检报告/.test(text()), '报告在、但两节都是空的 ⇒ 同一条路（不是崩溃）');

// ================================================================
group('⑦ 数据一变（重新导入带报告的包）这一页跟着变');
seed(null);
setupTabs();
AppState.currentTab = 'coverage';
document.getElementById('tab-coverage').innerHTML = '';
renderCoveragePage();
ok(/这个包没带体检报告/.test(text()), '先是"没带报告"');
AppState.reports = makeReports();            // ← 导入完成
switchTab('main');
switchTab('coverage');
await tick();
ok(/24,528 个节点/.test(text()), '切回来就是新报告的内容');

report();
