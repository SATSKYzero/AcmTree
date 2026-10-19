// ================================================================
// 冒烟测试：UI 接线（scripts/smoke/ui-wiring.smoke.mjs）
// 覆盖 Node 单测无法覆盖的部分：文件夹视图宿主、一级 Tab、插件激活、插件端到端
//
// 为什么是独立的一套：
//   这些被测模块 import 了 view/ shell/，会牵出 `immer`（裸包名，浏览器靠
//   import map 解析）。本套件通过 scripts/smoke/immer-loader.mjs 提供映射，
//   并需要在本文件**动态 import 被测模块之前**先装好 DOM 桩。
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

// ---------------------------------------------------------------
// 1. 先装 DOM 桩与全局变量（必须在 import 被测模块之前）
// ---------------------------------------------------------------
const body = installDom();
const app = makeContainer(body, 'app');
const tabBar = makeContainer(app, 'tab-bar');
// 节点信息层：独立于内置分页栏的一条栏（镜像 index.html）
const niBar = makeContainer(app, 'nodeinfo-tab-bar');
makeContainer(app, 'tree-container');
makeContainer(app, 'tree-body');
makeContainer(app, 'stats-chart-container');
makeContainer(app, 'folder-view-tabs');
makeContainer(app, 'tab-main');
makeContainer(app, 'tab-dedup');

globalThis.fetch = async () => ({
    ok: true,
    json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'))
});

// 还原 index.html 的静态一级 Tab 结构（镜像当前的 index.html）
const STATIC_TABS = [
    ['dedup', '🧩 判重整理'],
    ['main', '🏠 主视图'],
    ['stats', '📊 数据统计 <span class="tab-badge">AC追踪</span>']
];
for (const [id, label] of STATIC_TABS) {
    const btn = document.createElement('button');
    btn.className = 'tab-btn';
    btn.dataset.tab = id;
    btn.innerHTML = label;
    tabBar.appendChild(btn);
}
for (const id of ['dedup', 'main', 'stats']) {
    const pane = document.createElement('div');
    pane.className = 'tab-content';
    pane.id = `tab-${id}`;
    app.appendChild(pane);
}

// ---------------------------------------------------------------
// 2. 动态 import 被测模块
// ---------------------------------------------------------------
const registry = await import(`file://${path.join(SRC, 'core/pluginRegistry.js').replace(/\\/g, '/')}`);
const host = await import(`file://${path.join(SRC, 'ui/folder/folderViewHost.js').replace(/\\/g, '/')}`);
const tabs = await import(`file://${path.join(SRC, 'ui/tabs.js').replace(/\\/g, '/')}`);
const { bootstrapPlugins } = await import(`file://${path.join(SRC, 'shell/bootstrap.js').replace(/\\/g, '/')}`);
const { AppState } = await import(`file://${path.join(SRC, 'shell/state.js').replace(/\\/g, '/')}`);

const BUILTIN_VIEWS = [
    { id: 'children', label: '📂 子节点', order: 0, mount() {} },
    { id: 'stats', label: '📊 题目分布统计', order: 10, mount() {} }
];

// ===============================================================
group('统计模块加载（XCPC 档序迁移回归）');
// ===============================================================
// statsCharts / acTracking 目前没有其他自动化覆盖；它们引用 utils/color.js 的
// 唯一真源（20 档 XCPC 顺序）。这里至少要保证模块仍能正常加载
// （导入路径写错会在此暴露）。
const statsCharts = await import(`file://${path.join(SRC, 'ui/stats/statsCharts.js').replace(/\\/g, '/')}`);
const acTracking = await import(`file://${path.join(SRC, 'ui/stats/acTracking.js').replace(/\\/g, '/')}`);
const colorUtils = await import(`file://${path.join(SRC, 'utils/color.js').replace(/\\/g, '/')}`);

ok(typeof statsCharts.renderStatsChart === 'function', 'statsCharts 可加载并导出 renderStatsChart');
ok(typeof statsCharts.initStatsCharts === 'function', 'statsCharts 导出 initStatsCharts');
ok(typeof acTracking.renderTrainingHeatmap === 'function', 'acTracking 可加载并导出 renderTrainingHeatmap');
ok(typeof acTracking.getStatsTab === 'function', 'acTracking 导出 getStatsTab');

// 共享真源本身可用，且档序为 20 档、由易到难
eq(colorUtils.XCPC_ORDER.length, 20, '共享 XCPC_ORDER 为 20 档');
eq(colorUtils.XCPC_ORDER[0], '签到', '首档为最容易的「签到」');
eq(colorUtils.XCPC_ORDER[19], 'C+', '末档为最难的「C+」');
eq(colorUtils.getXcpcLevelIndex('签到'), 0, '等级下标：签到 → 0');
eq(colorUtils.getXcpcLevelIndex('未填写'), -1, '未知等级 → -1');

// ---- ★ 点柱段 ⇒ 把这一批题列在图表下面（`v9.0.18`）----
// 口径：「分档只有一份」—— `xcpcBucketOf` / `cfBucketOf`（`statsCharts.js` 导出）
// 既是算图那一步用的键，也是"点柱筛出来那一批"用的键。这里正反两面都钉：
//   ① 分档函数本身对得上树上那套派生（ratio → 档位）；
//   ② 点一段⇒ 明细里的**条数**等于那一段柱上的数字（同源），且那一档**别的状态**不混进来。
{
    const { renderStatsChart, xcpcBucketOf, cfBucketOf } = statsCharts;
    const { viewDerivedDisplay } = await import(`file://${path.join(SRC, 'view/scope.js').replace(/\\/g, '/')}`);
    const N = (id, type, extra = {}) => ({ id, type, name: extra.name || id, ...extra });
    // ⚠️ `xcpcDifficulty` / `status2` 都是**派生**（`core/derive.js`）：夹具要给**输入**。
    //    经验证（本机探针）：只写 `values.status2` **不算数**（`status2` 是"用户按下的覆盖"，
    //    推导要连 `status1` 一起、且与实际提交一致）⇒ 这里给 stP2 挂一条 AC 提交 R，
    //    让它**真推导出**"赛时通过(2)"。写派生字段或塞 values 都验不出来（那是假夹具）。
    const statState = {
        rootId: 'stC', parentOf: {}, viewingAccountId: '',
        settings: { stats: {} },
        nodes: {
            stC: N('stC', 'C', { name: '统计用比赛' }),
            stP1: N('stP1', 'P', { name: '签到未做', ratio: '90', cfDifficulty: 800 }),
            stP2: N('stP2', 'P', { name: '签到赛时过', ratio: '90', cfDifficulty: 800 }),
            stR2: N('stR2', 'R', { time: '2024.05.01 10:00', submitKind: '赛时', values: { status: [{ v: 'AC', src: 'qoj-scraper', at: 'T1' }] } }),
            stP3: N('stP3', 'P', { name: '银牌未做', ratio: '10', cfDifficulty: 2600 })
        },
        childOrder: { stC: ['stP1', 'stP2', 'stP3'], stP1: [], stP2: ['stR2'], stP3: [], stR2: [] }
    };
    for (const id of ['stP1', 'stP2', 'stP3']) statState.parentOf[id] = 'stC';
    statState.parentOf.stR2 = 'stP2';

    // ① 分档口径：图上每一档 = 树上"这一批"的键（**同一个函数**算出来的）
    eq(xcpcBucketOf(statState, statState.nodes.stP1), '签到', 'ratio 90 ⇒ 签到档（树上同一套派生）');
    eq(xcpcBucketOf(statState, statState.nodes.stP3), '银牌', 'ratio 10 ⇒ 银牌档（档位表在 A_constants.XCPC_THRESHOLDS）');
    eq(cfBucketOf(statState, statState.nodes.stP1), '800-899', 'CF 800 ⇒ 800-899 那一桶');
    eq(cfBucketOf(statState, statState.nodes.stP3), '2600-2699', 'CF 2600 ⇒ 2600-2699 那一桶');
    eq(viewDerivedDisplay(statState, statState.nodes.stP2, 'status2'), 4,
        '（前提）stP2 那条 AC 提交**真的**推导出「赛时通过(4)」（R 带 submitKind=赛时，判据在 core/model/status.js）—— 否则下面测的是"两段并成一段"');

    const statHost = makeContainer(app, 'stats-chart-probe');
    const pList = ['stP1', 'stP2', 'stP3'].map(id => statState.nodes[id]);
    renderStatsChart(statState, null, 'xcpc', pList, 'stats-chart-probe', true);

    const segsOf = () => document.getElementById('stats-chart-probe').querySelectorAll('[data-level]');
    const seg = (level, s2) => segsOf().find(s => s.dataset.level === level && s.dataset.status2 === String(s2));
    eq(segsOf().length, 3, '（前提）三段落：签到一根里两段（未使用 / 赛时通过）+ 银牌一根里一段');
    ok(!!seg('签到', 0) && !!seg('签到', 4) && !!seg('银牌', 0), '★ 柱段带 dataset.level / dataset.status2');
    ok(/点一下把这一批列在图表下面/.test(seg('签到', 4).title),
        '★ title 里写明"点了会做什么"（可发现性）');
    ok(/签到 · 赛时通过：1 题/.test(seg('签到', 4).title), 'title 里也带这一段自己的题数');
    eq(document.getElementById('stats-chart-probe').querySelectorAll('.stats-segment-detail').length, 0,
        '（前提）没点之前没有明细块');

    seg('签到', 4).dispatchEvent({ type: 'click', target: seg('签到', 4) });
    const detail = () => document.getElementById('stats-chart-probe').querySelectorAll('.stats-segment-detail');
    eq(detail().length, 1, '★ 点一下柱段 ⇒ 图表下面出现那一批');
    const detailHtml = serialize(detail()[0]);
    ok(/📌 签到 · 赛时通过：1 题/.test(detailHtml), '★ 明细里的条数 = 那一段柱上的数字（同源）');
    ok(/stP2/.test(detailHtml), '★ 列的就是这一档 × 这一状态的那一道题');
    ok(!/stP1/.test(detailHtml) && !/stP3/.test(detailHtml),
        '★ 同一根柱里**别的状态**（stP1）和别的档（stP3）都不混进来');
    ok(!!detail()[0].querySelector('.stats-segment-rows'), '明细里的题用现成的只读节点行承载');
    ok(!!detail()[0].querySelector('.stats-segment-close'), '有一个收起按钮（不必去找同一个柱段再点一次）');

    // 换一段：明细跟着换（不是叠加）
    seg('银牌', 0).dispatchEvent({ type: 'click', target: seg('银牌', 0) });
    eq(detail().length, 1, '换一段 ⇒ 仍然只有一块明细');
    ok(/银牌 · 未使用：1 题/.test(serialize(detail()[0])), '明细换成了银牌那一批');
    ok(/stP3/.test(serialize(detail()[0])), '列的是银牌那道题');

    // 再点同一段 = 收起
    seg('银牌', 0).dispatchEvent({ type: 'click', target: seg('银牌', 0) });
    eq(detail().length, 0, '★ 再点同一段 ⇒ 收起（同一次点击不会越点越多）');
    eq(pList.length, 3, '★ 纯看：点柱不筛数据、不改 pNodes');

    // ---- ★ 图表下面那张「网格表」（用户 2026-10-13 要的）----
    // 行 = 状态2、列 = 难度档、格内 = 题数、每行最右 = 该状态2的合计；
    // **列必须与柱子逐列对齐**（靠"同一把尺子 + 同一个横向滚动区"，见 `renderStatusGrid` 文件头）。
    const root = () => document.getElementById('stats-chart-probe');
    const cells = () => [...root().querySelectorAll('.ssg-cell')];
    const rowsEls = () => [...root().querySelectorAll('.ssg-row')];
    const cellOf = (s2, lv) => cells().find(c => c.dataset.gridStatus2 === String(s2) && c.dataset.gridLevel === lv);
    const totalOf = (s2) => [...root().querySelectorAll('.ssg-total')]
        .find(t => t.dataset.gridStatus2 === String(s2));

    eq(root().querySelectorAll('.stats-status-grid').length, 1, '★ 图下面有网格表（`.stats-status-grid`）');
    eq(rowsEls().length, 6, '★ 六行 = 六种状态2');
    eq(rowsEls().map(r => r.dataset.gridStatus2).join(','), '0,1,2,3,4,5',
        '★ 行序 = `STATUS2_ORDER` **正序**（未使用在最上）—— 用户 2026-10-13 定稿："还是别反了"');
    // 列序 = 柱子那一份难度序（同一次分档结果的键序，不是另算一遍）
    const chartLevels = [...new Set(segsOf().map(s => s.dataset.level))];
    const gridLevels = [...new Set(cells().map(c => c.dataset.gridLevel))];
    eq(gridLevels.join('|'), chartLevels.join('|'), '★ 网格列序 = 柱子列序（同一次分档）');
    ok(rowsEls().every(r => [...r.querySelectorAll('.ssg-cell')].length === chartLevels.length),
        '★ 每行恰好 N 格（与档数相等）');

    eq(cellOf(4, '签到') && cellOf(4, '签到').textContent, '1',
        '★ 格内 = 签到 × 赛时通过 的题数（与那一段柱上的数字同一个）');
    eq(cellOf(4, '银牌') && cellOf(4, '银牌').textContent, '0', '★ 没有题的格子写 0（不是空白/undefined）');
    eq(totalOf(0) && totalOf(0).textContent, '2', '★ 最右「合计」= 未使用那一行跨档求和（签到 1 + 银牌 1）');
    eq(totalOf(4) && totalOf(4).textContent, '1', '★ 赛时通过那一行合计 = 1');
    eq(totalOf(3) && totalOf(3).textContent, '0', '一格都没有的状态2，合计也是 0');
    // 两条路必须同一个数：**柱段自己的题数**加起来 = 网格那一行的合计。
    // ⚠️ 柱段的题数只在它的 `title` 里（`：N 题`）—— 格子里的 `countLabel` 是**整根柱的合计**，
    //    不是某一段的（别拿它当"这一段有几题"）。
    const segSumOf = (s2) => segsOf().filter(s => Number(s.dataset.status2) === s2)
        .reduce((a, s) => a + Number((s.title.match(/：(\d+) 题/) || [0, '0'])[1]), 0);
    eq(segSumOf(0), Number(totalOf(0).textContent), '★ 柱段加起来 = 网格该行合计（同源，不是两套计数）');
    eq(segSumOf(4), Number(totalOf(4).textContent), '★ 赛时通过那一行同样对得上');

    // 对齐的**机制**（桩不做布局，"完全对齐"只能钉这三条）
    const gutter = root().querySelector('.stats-bar-gutter');
    ok(!!gutter && /width:58px/.test(gutter.style.cssText),
        '★ 柱子那一行左侧留了与网格标签列**同宽**的空位（列才从同一处开始）');
    const barRow = root().querySelector('.stats-bar-row');
    const barW = (barRow.children[1].style.cssText.match(/width:\s*(\d+)px/) || [])[1];
    ok(!!barW && cellOf(0, '签到').style.cssText.includes(`width:${barW}px`),
        '★ 网格格宽 = 柱宽（同一把尺子，改一边就红）');
    // ⚠️ 比间距要先**去掉空白**：柱那一行是模板串（`gap: 8px`），网格是拼串（`gap:8px`）
    const tight = (s) => String(s || '').replace(/\s+/g, '');
    ok(tight(barRow.style.cssText).includes('gap:8px') && tight(rowsEls()[0].style.cssText).includes('gap:8px'),
        '★ 列间距同一值（柱子那一行与网格行都用 gap:8px）');
    ok(!!root().querySelector('.stats-chart-scroll'),
        '★ 柱子与网格在**同一个横向滚动区**（否则图能横滚、表不动，列就白对了）');
    ok(!/overflow-x/.test(barRow.style.cssText), '★ 柱子那一行自己不再单独横滚（已交给那个滚动区）');
    // 位置：**表格在上、柱状图在下**（用户 2026-10-13："表格与柱状图交换位置"）
    const scroller = root().querySelector('.stats-chart-scroll');
    eq(scroller.children.map(c => c.className).join(','), 'stats-status-grid,stats-bar-row',
        '★ 顺序 = 网格表 → 柱状图（对调过；两块仍在同一滚动区里 ⇒ 列照旧一起动）');
    // 背景染色（用户 2026-10-13："每个方格背景染色"）——取的是与柱段同一份 `STATUS2_COLORS`
    ok(cellOf(4, '签到').style.cssText.includes('#00db00'),
        '★ 格底色 = 该状态2的颜色（赛时通过 ⇒ 亮绿，与柱段/图例同一个值）');
    ok(cellOf(0, '签到').style.cssText.includes('#ffffff'), '★ 未使用那行底色白（同一份色表，不是另配一套）');
    ok(/rgba\(15,23,42,0\.35\)/.test(cellOf(4, '银牌').style.cssText),
        '★ 零格文字是半透明深色（亮绿底上也读得出，不必为每行挑文字色）');
    ok(totalOf(4).style.cssText.includes('#00db00'), '★ 合计格也跟这一行染色（只加粗加框以示区别）');

    // ---- 表底那行「合计」（用户 2026-10-13：把柱子上面那行数字搬进表格）----
    const sumRow = root().querySelector('.ssg-sum-row');
    ok(!!sumRow, '★ 表底有一行「合计」');
    eq(sumRow && sumRow.children[0].textContent, '合计', '左侧文本是「合计」');
    const sumCells = [...root().querySelectorAll('.ssg-col-total')];
    eq(sumCells.map(c => c.dataset.gridLevel).join('|'), chartLevels.join('|'),
        '每档一格，列序与柱子一致');
    eq(sumCells.map(c => c.textContent).join(','), '2,1',
        '★ 每档合计 = 2 / 1（= 原先画在柱子上面那行数字，同一份求和）');
    // 同源核对：各档柱段的题数（取每段 title 里的 `：N 题`）加起来 = 这一档的合计
    eq(chartLevels.map(lv => segsOf().filter(s => s.dataset.level === lv)
        .reduce((a, s) => a + Number((s.title.match(/：(\d+) 题/) || [0, '0'])[1]), 0)).join(','),
    sumCells.map(c => c.textContent).join(','), '★ 柱段加起来 = 「合计」行（两条路同一个数）');
    eq(root().querySelector('.ssg-grand-total').textContent, String(pList.length),
        '★ 最右再加一格 = **总数**（图上题目总数）');
    ok(!/\d/.test(serialize(barRow)),
        '★ 柱子上面那行数字**已撤掉**（搬进表格；柱区只剩难度名与色块）');

    // ---- ★ 格子可点（`v9.1.4`，用户："能不能让格子也可点? 效果与柱相同"）----
    // 判据不是"看起来能点"，而是**两条路出来的明细逐字相同**（都走同一个 `onSegmentClick`）。
    // ⚠️ 每次点击都会重画整块图 ⇒ 点完之后**必须重新查元素**（手里那个已经不在文档里了）。
    const detailText = () => (detail().length ? serialize(detail()[0]) : '');
    const clickCell = (el) => el.dispatchEvent({ type: 'click', target: el });
    const colTotalOf = (lv) => [...root().querySelectorAll('.ssg-col-total')]
        .find(c => c.dataset.gridLevel === lv);

    // ① 点某一格（签到 × 赛时通过）
    clickCell(cellOf(4, '签到'));
    const byCell = detailText();
    ok(/签到 · 赛时通过：1 题/.test(byCell), '★ 点格子 ⇒ 把这一批列在图表下面（与点柱段同一件事）');
    ok(/stP2/.test(byCell) && !/stP1/.test(byCell) && !/stP3/.test(byCell),
        '★ 列的就是这一格那一批（别的状态、别的档都不混进来）');
    clickCell(cellOf(4, '签到'));
    eq(detail().length, 0, '再点同一格 = 收起（与柱段同一条规则）');

    // ② 点柱段，与①**逐字对比**
    seg('签到', 4).dispatchEvent({ type: 'click', target: seg('签到', 4) });
    const bySeg = detailText();
    // ⚠️ 这里用 `ok` 不用 `eq`：明细是一大串 HTML，`eq` 成功时也会把两串全文打出来（刷屏）
    ok(byCell === bySeg && byCell.length > 0,
        `★ 两条路（格子 / 柱段）出来的明细**逐字相同** —— "效果与柱相同"是结构保证的（${byCell.length} 字符）`);
    seg('签到', 4).dispatchEvent({ type: 'click', target: seg('签到', 4) });
    eq(detail().length, 0, '（前提）先收起，好接着测合计格');

    // ③ 点表底「合计」那一格 ⇒ 这一档**所有状态2**的题（用户："合计格的列表包含所有 stat2"）
    clickCell(colTotalOf('签到'));
    const bySum = detailText();
    ok(/签到 · 全部状态：2 题/.test(bySum), '★ 点合计格 ⇒ 标题写「全部状态」、条数 = 该档合计（2 题）');
    ok(/stP1/.test(bySum) && /stP2/.test(bySum),
        '★ 未使用(0) 与 赛时通过(4) **都在**这一批里 —— 这就是"包含所有 stat2"');
    ok(!/stP3/.test(bySum), '别的档（银牌）仍不混进来');
    ok(/outline:2px solid #1d4ed8/.test(colTotalOf('签到').style.cssText),
        '★ 选中的合计格有高亮（与柱段选中框同款式；重画后重新查过元素）');
    clickCell(colTotalOf('签到'));
    eq(detail().length, 0, '再点同一格 = 收起');
}

// ===============================================================
group('★ 热力图：时间范围外的格子变淡（用户 2026-10-13 改口："不要高亮了"）');
// ===============================================================
// 需求演变：先说"区间内的格子白边换成淡蓝"，看过之后说 **"看着很糊…不要高亮了，要不让范围外的变淡？"**
// ⇒ 定稿 = **区间外调淡**（`opacity`），区间内一格不动。闭区间（"点框也算在时间段内"）。
// ⚠️ 格子是 `innerHTML` 拼出来的 ⇒ 桩不解析 DOM ⇒ 这里断言的是 `serialize()` 出去的 **HTML 串**；
//    所以直接喂一份手工 `acMap` + 范围给 `renderHeatmapForYear`（它为此导出）。
{
    const heatmap = await import(`file://${path.join(SRC, 'ui/stats/ac/heatmap.js').replace(/\\/g, '/')}`);
    AppState.settings.stats.heatmapMode = 'count';
    const acMap = new Map([
        ['2026.01.10', { count: 2, maxCf: 800, maxXcpc: '签到' }],
        ['2026.01.11', { count: 1, maxCf: 800, maxXcpc: '签到' }],
        ['2026.03.05', { count: 3, maxCf: 900, maxXcpc: '签到+' }]
    ]);
    const box = document.createElement('div');
    heatmap.renderHeatmapForYear(box, acMap, 2026,
        { startDate: new Date(2026, 0, 10), endDate: new Date(2026, 0, 11) });
    const html = serialize(box);
    /** 取出某个日期那一格的开始标签（`data-ac-date` 只在有题的格上有） */
    const cellTag = (key) => (html.match(new RegExp(`<div[^>]*data-ac-date="${key}"[^>]*>`)) || [''])[0];
    ok(cellTag('2026.01.10') !== '', '（前提）2026.01.10 那一格画出来了');
    ok(!cellTag('2026.01.10').includes('opacity'),
        '★ 起点那天（区间左端）**不淡** —— 闭区间，它是"范围内"的');
    ok(!cellTag('2026.01.11').includes('opacity'),
        '★ 终点那天也不淡（"点框也算在时间段内"）');
    ok(cellTag('2026.03.05').includes('opacity'),
        '★ 区间外的格子**调淡**（这就是"范围外变淡"）');
    ok(!html.includes('box-shadow:0 0 0 3px'),
        '★ 已经没有淡蓝描边了（用户明确"不要高亮了" —— 别把高亮再加回来）');

    // 没给范围（＝还没按过确定）⇒ 谁都不淡
    const box2 = document.createElement('div');
    heatmap.renderHeatmapForYear(box2, acMap, 2026, null);
    ok(!serialize(box2).includes('opacity'),
        '★ 没有已应用的范围 ⇒ 一格都不淡（别把下拉框里的临时值当范围）');

    // ★ **单日选中也走同一条规则**（用户："我想选中单点时也这样：只有这一个不淡化，即套入该天为始终"）
    const box3 = document.createElement('div');
    const only = new Date(2026, 0, 11);
    heatmap.renderHeatmapForYear(box3, acMap, 2026, { startDate: only, endDate: only, kind: 'day' });
    const html3 = serialize(box3);
    const tag3 = (key) => (html3.match(new RegExp(`<div[^>]*data-ac-date="${key}"[^>]*>`)) || [''])[0];
    ok(!tag3('2026.01.11').includes('opacity'), '★ 单日选中：**那一天不淡**');
    ok(tag3('2026.01.10').includes('opacity') && tag3('2026.03.05').includes('opacity'),
        '★ 单日选中：别的天全淡（= 把那天当成起止同一天的范围）');

    // 接线（`refreshActiveACList`）：列表只在"按确定/点格子"时建一次 ⇒ 换账户后必须按新范围重算。
    // ⚠️ 这一条只能**读源码**钉"接线还在"（要真跑它得有整页夹具：`#time-range-view` / `#daily-ac-view` …），
    //    与 `src/test/nodeGroup.test.js` 那几条源码锚同性质。
    const dailySrc = fs.readFileSync(path.join(SRC, 'ui/stats/ac/dailyList.js'), 'utf8');
    const heatSrc = fs.readFileSync(path.join(SRC, 'ui/stats/ac/heatmap.js'), 'utf8');
    ok(/export function refreshActiveACList\(\)/.test(dailySrc),
        '★ 有 `refreshActiveACList()`（按当前范围重算"此刻展示的那一段"）');
    ok(/refreshActiveACList\(\)/.test(heatSrc),
        '★ 热力图每次重画都调它 —— 换「查看账户」后列表与统计才同口径');
    ok(/renderDailyACList\(currentDailyDate, dailyACPage\)/.test(dailySrc)
        && /renderTimeRangeACList\(timeRangePage\)/.test(dailySrc),
        '★ 单日 / 时间范围两条分支都重算（别只重算一条）');
}

// ===============================================================
group('文件夹节点视图宿主');
// ===============================================================
let mountCtx = null;
let unmountCount = 0;
registry.__resetRegistryForTest();
registry.registerFolderView({
    id: 'demo', label: 'DEMO 插件页', order: 50,
    mount(ctx) { mountCtx = ctx; ctx.panel.innerHTML = '<p>插件内容</p>'; },
    unmount() { unmountCount++; }
});

const views = host.resolveFolderViews(BUILTIN_VIEWS);
eq(views.map(v => v.id).join(' -> '), 'children -> stats -> demo', '插件视图排在末尾');
eq(views[2].isPlugin, true, '插件项被标记 isPlugin');

host.renderViewTabs({ currentView: 'demo', views, onSwitch: () => {} });
host.mountFolderView({ views, viewId: 'demo', ctx: { state: {} } });
const pluginPanel = document.getElementById('folder-view-panel-demo');
ok(pluginPanel && pluginPanel.style.display === 'block', '插件面板已创建并可见');
ok(!!(mountCtx && mountCtx.panel), 'mount 收到专属面板');
eq(serialize(pluginPanel), '<p>插件内容</p>', '面板内容正确');
eq(document.getElementById('tree-body').style.display, 'none', '插件页激活时内置容器让位');

host.mountFolderView({ views, viewId: 'children', ctx: { state: {} } });
eq(pluginPanel.style.display, 'none', '切走后面板隐藏');
eq(unmountCount, 0, '未提供 unmount 的内置视图不会报错');

// 插件 mount 抛错应被隔离
registry.registerFolderView({ id: 'boom', label: '会炸', mount() { throw new Error('插件内部错误'); } });
const views2 = host.resolveFolderViews(BUILTIN_VIEWS);
const origErr = console.error;
console.error = () => {};
host.mountFolderView({ views: views2, viewId: 'boom', ctx: {} });
console.error = origErr;
ok(/加载失败/.test(serialize(document.getElementById('folder-view-panel-boom'))), '插件 mount 抛错被兜住并写入错误面板');

// ===============================================================
group('一级 Tab 栏');
// ===============================================================
let tabMountCtx = null;
let tabUnmount = 0;
registry.__resetRegistryForTest();
registry.registerTab({
    id: 'demoTab', label: '🧩 DEMO 插件页',
    mount(ctx) { tabMountCtx = ctx; ctx.container.innerHTML = '<p>Tab 内容</p>'; },
    unmount() { tabUnmount++; }
});

AppState.currentTab = 'main';
tabs.setupTabs();

const tabBtns = () => document.getElementById('tab-bar').querySelectorAll('.tab-btn');
const niBtnsBar = () => document.getElementById('nodeinfo-tab-bar').querySelectorAll('.tab-btn');
const allBtns = () => tabBtns().concat(niBtnsBar());
const activeBtn = () => { const b = allBtns().find(x => x.classList.contains('active')); return b ? b.dataset.tab : null; };
const activePane = () => { const p = document.querySelectorAll('.tab-content').find(x => x.classList.contains('active')); return p ? p.id : null; };

/**
 * 字符串里有没有"缺 `>`"的标签（如 `...;"<div class="x"<div>`）。
 *
 * 为什么要有它：本套件的 DOM 桩默认**不解析 innerHTML**，所以
 * `panel.querySelectorAll('.co-band')` 这种"查嵌套"的断言**恒真**——是假覆盖。
 * 缺一个 `>` 就会让浏览器把后面的元素吞成子节点 —— 那正是这里的真 bug。
 * 这是纯字符串检查，只认"`<` 之后先遇到 `<` 而不是 `>`"这一种情况。
 */
function hasUnclosedTag(html) {
    for (let i = html.indexOf('<'); i >= 0; i = html.indexOf('<', i + 1)) {
        const gt = html.indexOf('>', i);
        const lt = html.indexOf('<', i + 1);
        if (lt >= 0 && (gt < 0 || lt < gt)) return true;
    }
    return false;
}

eq(tabBtns().length, 4, '按钮数 = 3 内置 + 1 插件');
eq(tabBtns().map(b => b.dataset.tab).join(' -> '), 'dedup -> main -> stats -> demoTab', '按钮顺序');
eq(tabBtns().find(b => b.dataset.tab === 'demoTab').dataset.pluginTab, '1', '插件按钮带标记（供内置读取时区分）');
eq(activeBtn(), 'main', '初始激活内置页');
eq(activePane(), 'tab-main', '初始激活对应面板');

tabs.switchTab('demoTab');
eq(activeBtn(), 'demoTab', '切到插件页');
eq(activePane(), 'tab-demoTab', '插件面板激活');
ok(!!document.getElementById('tab-demoTab'), '插件面板容器按需创建');
eq(tabMountCtx && tabMountCtx.container.id, 'tab-demoTab', 'mount 收到正确容器');
eq(AppState.currentTab, 'demoTab', '状态已提交');

tabs.switchTab('stats');
eq(activeBtn(), 'stats', '切回内置页');
eq(tabUnmount, 1, '离开插件页触发 unmount');

tabs.switchTab('ghost');
eq(activeBtn(), 'stats', '未知 tab id 被忽略');

tabs.renderTabBar();
eq(tabs.readBuiltinTabs().map(t => `${t.id}:${t.order}`).join(' '), 'dedup:0 main:10 stats:20', '重渲染后内置项 order 不漂移');

registry.__resetRegistryForTest();
AppState.currentTab = 'demoTab';
tabs.setupTabs();
eq(activeBtn(), 'main', '持久化指向已移除的插件页 → 回落到主视图');
eq(tabBtns().length, 3, '插件页移除后按钮数回落');

// ===============================================================
group('插件激活（bootstrap）');
// ===============================================================
registry.__resetRegistryForTest();
const summary = await bootstrapPlugins();
// 用成员判断而非精确字符串：以后新增插件不应让这条断言失败
ok(summary.activated.includes('ContestOverview'), 'ContestOverview 已激活');
eq(summary.failed.length, 0, '没有激活失败');

const again = await bootstrapPlugins();
eq(again.activated.length, 0, '重复 bootstrap 不会重复激活');

// ===============================================================
group('比赛补题概览（端到端）');
// ===============================================================
const N = (id, type, extra = {}) => ({ id, type, name: extra.name || id, ...extra });
const state = {
    rootId: 'root', parentOf: {}, settings: { stats: {} },
    nodes: {
        root: N('root', 'O', { name: '根' }),
        c1: N('c1', 'C', { name: '2024 省赛' }),
        c2: N('c2', 'C', { name: 'CF Round 900' }),
        c3: N('c3', 'C', { name: '没题目的比赛' }),
        // ⚠️ `status2` 是**按范围算出来的**：
        //    "赛时通过（4）"只有在**确实有 AC 提交**时才成立（v7 的规则也是这样，
        //    `updateP` 还会拒绝不一致的设置）。所以这里给 p1 补上它的 AC 提交 ——
        //    否则那是"缓存与数据自相矛盾"的假数据。
        // ⚠️ `status1` / `status2` 是**用户按下的覆盖** —— 值在**来源层**
        //    （`src:'manual'`），缓存字段只是物化投影。夹具里没有"老数据"这一层，
        //    所以只写缓存字段不算数。
        p1: N('p1', 'P', {
            problemId: 'A', xcpcDifficulty: '签到', ratio: '90', cfDifficulty: 800,
            values: {
                status1: [{ v: '1', src: 'manual', at: 'T1' }],
                status2: [{ v: '4', src: 'manual', at: 'T1' }]
            }
        }),
        r1: N('r1', 'R', {
            time: '2024.05.01 10:00',
            values: { status: [{ v: 'AC', src: 'qoj-scraper', at: 'T1' }] }
        }),
        p2: N('p2', 'P', { problemId: 'B', xcpcDifficulty: '银牌', ratio: '10', cfDifficulty: 1800 }),
        p3: N('p3', 'P', { problemId: 'C', xcpcDifficulty: 'C+', ratio: '3', cfDifficulty: 2600 }),
        p4: N('p4', 'P', {
            problemId: 'D', xcpcDifficulty: '-', ratio: '', cfDifficulty: 0,
            values: { status2: [{ v: '5', src: 'manual', at: 'T1' }] }   // 忽略
        })
    },
    childOrder: { root: ['c1', 'c2', 'c3'], c1: ['p1', 'p2'], c2: ['p3', 'p4'], c3: [], p1: ['r1'], p2: [], p3: [], p4: [], r1: [] }
};

const pluginViews = host.resolveFolderViews(BUILTIN_VIEWS);
// 插件文件夹视图清单：随 plugins.json 增长，这里按 id 断言"包含"而不是钉死顺序串
const pluginViewIds = pluginViews.map(v => v.id);
ok(pluginViewIds[0] === 'children' && pluginViewIds[1] === 'stats', '内置视图仍排在最前');
ok(pluginViewIds.includes('contest-overview'), 'ContestOverview 已注册到视图列表');
ok(pluginViewIds.includes('auto-import-sync'), 'AutoImport 已注册到视图列表');
eq(pluginViews.find(v => v.id === 'contest-overview').label, '🏁 比赛补题概览', '页签文案');

host.renderViewTabs({ currentView: 'contest-overview', views: pluginViews, onSwitch: () => {} });
host.mountFolderView({ views: pluginViews, viewId: 'contest-overview', ctx: { state, nodeId: 'root' } });
const coPanel = document.getElementById('folder-view-panel-contest-overview');
const html = serialize(coPanel);

ok(/筛选模式/.test(html), '渲染出筛选模式控件');
ok(/XCPC难度/.test(html) && /CF难度/.test(html), '渲染出难度切换按钮');
eq((html.match(/class="co-row"/g) || []).length, 2, '比赛行数 = 2（不含题目的比赛被忽略）');
eq((html.match(/class="co-dot"/g) || []).length, 4, '点数 = 4（一题一点）');
eq((html.match(/class="co-line"/g) || []).length, 2, '每行一条居中横线');
ok(/background:#00db00/.test(html), '点按 status2 着色');
ok(/box-shadow:0 0 0 2px #f97316/.test(html), 'status1=1 的点带橙色外圈');
eq((html.match(/class="co-band"/g) || []).length, 21, 'XCPC 竖向难度带 = 20 档 + 特殊带');

// 结构完整性：难度带 / 比赛行**都不能互相嵌套**。
// 为什么单钉这一条：这几个标签若写成 `...;"<div>`（少一个 `>`），
// 浏览器就把后面的 `<div>` 当成**前一个元素的子节点** —— 于是百分比宽度相对前一条算，
// 整排矩形挤在最左侧（症状：**横向压扁**）。
//
// ⚠️ 这里**不能**用 `coPanel.querySelectorAll('.co-band')` 去查嵌套：本套件的 DOM 桩
//    默认**不解析 innerHTML**（`installDom()` 没开 parseHtml），面板内容是一整段字符串，
//    查什么都返回空 —— 那种断言恒真，是**假覆盖**。
//    所以直接查字符串里的标签有没有闭合的 `>`：少一个 `>` 正是这里的真 bug。
ok(!hasUnclosedTag(html), '没有写成 `...<div` 这种缺 `>` 的标签（浏览器会把后面的元素吞成子节点）');
ok(/2024 省赛/.test(html) && /CF Round 900/.test(html), '比赛名已渲染');
ok(/left:4\.000%/.test(html), '未填写题落在特殊带中心（4%）');

// 交互：切到 CF
const cfBtn = coPanel.querySelectorAll('.co-chart-btn').find(b => b.dataset.chart === 'cf');
ok(!!cfBtn, '找到 CF 切换按钮');
cfBtn.click();
const htmlCf = serialize(coPanel);
eq((htmlCf.match(/class="co-band"/g) || []).length, 9, '切到 CF 后难度带 = 8 档 + 特殊带');
eq((htmlCf.match(/class="co-row"/g) || []).length, 2, '切换难度不影响行数');
ok(/其他（&lt;800）|其他（<800）/.test(htmlCf), '特殊带标签随难度类型变化');

// ===============================================================
group('多界面：节点信息 tab（浏览器式，带 ✕，可同时开多个，独立成层）');
// ===============================================================
// 它属于**第三类 tab**：不在 index.html 里、不经插件注册，运行时按需打开，
// 并且**不混在内置分页栏里** —— 它走 `#nodeinfo-tab-bar` 那条独立的栏。
// ⚠️ 放在最后：这一组会换掉 `AppState.nodes`（面板要显示节点名）。
AppState.nodes = {
    root: { id: 'root', type: 'O', name: '根', values: {}, extKey: '' },
    cA: { id: 'cA', type: 'C', name: '2024 省赛', values: { name: [{ v: '2024 省赛', src: 'x', at: 'T1' }] }, extKey: 'xcpc:c:cA' },
    p1: { id: 'p1', type: 'P', name: 'All Closed', values: {}, problemId: 'A' }
};
AppState.childOrder = { root: ['cA'], cA: ['p1'], p1: [] };
AppState.rootId = 'root';      // 大界面按"把该节点当文件夹打开"取子节点，得从根走
// 副页（虚拟节点）：`v_cA` 是页内 id，`refId` 指向真实节点 `cA` ——
// B1 修的就是"副页里点 📋 传了页内 id"这件事（见下面那组断言）。
AppState.pages = {
    page_1: {
        id: 'page_1', name: '副页', rootId: 'v_root',
        virtualIndex: {
            v_root: { id: 'v_root', refId: null, type: 'O', parentId: null, children: ['v_cA'] },
            v_cA: { id: 'v_cA', refId: 'cA', type: 'C', parentId: 'v_root', children: [] }
        }
    }
};

const niBtns = () => niBtnsBar();
const niBtn = id => niBtnsBar().find(b => b.dataset.tab === id);

// ---- 入口：节点框上那个「📋」按钮 ----
// `buildActions` 是纯函数（只读 node 的 id），所以这里给个最小 state 就能验。
// ⚠️ 它只钉"按钮在"；"点了会开 tab"由下面那串 openNodeInfoTab 的断言覆盖
//    （点击派发在 `ui/G_events.js`，要真渲染一棵树才能端到端跑）。
const { buildActions } = await import(`file://${path.join(SRC, 'view/helpers.js').replace(/\\/g, '/')}`);
const actionsHtml = buildActions(
    { settings: { mode: { editMode: 'attribute' } } }, { id: 'cA' }, 0, [{}], false, 'full');
ok(/btn-node-info/.test(actionsHtml), '节点框上有「📋 详细节点信息」入口');
ok(/data-id="cA"/.test(actionsHtml), '入口带节点 id');
const folderActionsHtml = buildActions(
    { settings: { mode: { editMode: 'attribute' } } }, { id: 'cA' }, 0, [{}], false, 'folder', false, null);
ok(/btn-node-info/.test(folderActionsHtml), '**文件夹模式**的按钮排里也有它');

// ---- 副页（虚拟节点）：📋 必须带**真实节点 id**，且不画那些在副页里注定被拒的按钮 ----
const vNode = { id: 'v_cA', _virtual: true, _virtualId: 'v_cA', _refId: 'cA', type: 'C' };
const vFolder = buildActions(
    { settings: { mode: { editMode: 'attribute' } } }, vNode, 0, [{}, {}], true, 'folder', false, null);
ok(/btn-node-info/.test(vFolder), '副页文件夹模式下也有 📋');
ok(/btn-node-info" data-id="cA"/.test(vFolder), '📋 带的是**真实节点 id**（不是页内 id）');
ok(!/data-id="v_cA"[^>]*>📋/.test(vFolder), '📋 上**没有**页内 id');
ok(!/btn-edit|btn-add-child|btn-more/.test(vFolder),
    '副页里不画"编辑/加子节点/更多操作"（它们一律被拒，画出来只会弹提示）');
ok(/btn-delete" data-id="v_cA"/.test(vFolder), '✖ 是**页内**操作 → 用页内 id');
const vFull = buildActions(
    { settings: { mode: { editMode: 'attribute' } } }, vNode, 0, [{}, {}], true, 'full', false, null);
ok(/btn-node-info" data-id="cA"/.test(vFull), '分页视图下的副页节点同理（📋 指真实节点）');
ok(!/btn-edit|btn-add-child/.test(vFull), '分页视图下也不画注定被拒的按钮');

// ⚠️ 别拿 DOM 上的按钮数当基线：`renderTabBar()` 会把**注册表**（含后来注册的插件页）
//    一次性落到 DOM 上，所以它本身就会改变按钮数。要断言"回到原样"，是对**注册表**断言。
eq(tabs.getNodeInfoTabs().length, 0, '（前提）此刻没有节点信息 tab');
eq(niBtns().length, 0, '（前提）节点信息层是空的');
eq(document.getElementById('nodeinfo-tab-bar').style.display, 'none', '没开任何界面时整条层收起');

tabs.openNodeInfoTab('cA');
eq(niBtns().length, 1, '开一个节点信息界面');
ok(!!niBtn('node-cA'), '按钮 id 带 `node-` 前缀');
eq(niBtn('node-cA').dataset.nodeinfoTab, '1', '带 nodeinfo 标记');
ok(!!niBtn('node-cA').querySelector('.tab-close'), '带 ✕');
ok(/2024 省赛/.test(serialize(niBtn('node-cA'))), '按钮文字是节点名');
ok(document.getElementById('nodeinfo-tab-bar').style.display !== 'none', '开了就显示这一层');
ok(!tabBtns().some(b => b.dataset.tab === 'node-cA'),
    '**不混进内置分页栏**（它自己有更高一层）');
eq(activeBtn(), 'node-cA', '打开后立刻切过去');
eq(activePane(), 'tab-node-cA', '面板激活且按需创建');

// ---- 大界面：顶部节点框 + 「文件夹模式那层 tab 栏」（字段表排最左）+ 自己的子视图容器 ----
// ⚠️ 外壳是**用 DOM 造的真实元素**（不是拼 innerHTML 字符串）—— 所以桩里查得到；
//    字段表与子 tab 栏的内容仍是 HTML 字符串，用 serialize 断言。
const niPane = document.getElementById('tab-node-cA');
ok(!!niPane.querySelector('.nodeinfo-view'), '大界面外壳存在（DOM 构造，桩里查得到）');

const niBox = niPane.querySelector('.nodeinfo-nodebox');
ok(!!niBox, '顶部是**节点框**的位置（不是另写一行标题）');
ok(/class="node-box/.test(serialize(niBox)), '直接渲染树上那个节点方框');
const niIdTag = niPane.querySelector('.nodeinfo-node-id');
eq(serialize(niIdTag), 'cA', '节点框旁边带 id');
ok(!niBox.contains(niIdTag), 'id **不在**节点框里面（不会被框的宽度挤位置）');
const niHead = niPane.querySelector('.nodeinfo-head');
eq(niHead.children.length, 4, '顶部四块：节点框 + id + 「跳到树上」按钮 + 面包屑');
eq(String(niHead.children[1].className), 'nodeinfo-node-id',
    'id 是**另起一行**的那一块（顶部不是 flex 横排）');
// ★ 那串 id 现在是**可点入口**（用户 2026-10-13：把它改成超链接样式的蓝）——
//   蓝 = 链接 ⇒ 蓝了就必须真能点：承载 = `data-reveal-node`（`markGoto` 挂的**唯一一份**），
//   由 `ui/nodeinfo/nodeGroupActions.js` 的**文档级**委托接住（这里没有挂任何监听）。
//   ⚠️ 可点的只是里面那个 span；外层的 `.nodeinfo-node-id` 一点没动（上面那两条就是证据）。
const niIdLink = niIdTag.querySelector('.nodeinfo-node-id-link');
ok(!!niIdLink, 'id 那一行里有一个可点的链接元素');
eq(niIdLink && niIdLink.dataset.revealNode, 'cA', '承载是**主树真实 id**（不是页内 id）');
ok(/color:#1d4ed8/.test(String(niIdLink && niIdLink.style.cssText)),
    '用的是仓里既有的链接蓝 #1d4ed8（不自造色值）');
ok(/text-decoration:underline/.test(String(niIdLink && niIdLink.style.cssText)),
    '带下划线（超链接默认观感）');
eq(serialize(niIdLink), 'cA', '显示的仍是那串 id 本身（改的是观感与接线，不是文案）');
ok(niIdTag.contains(niIdLink), '链接就在原来那一格里（id 仍然另起一行）');
// 「🔎 跳到树上」：带的是**真实节点 id**，点击由 nodeGroup.js 的委托接住
const niJump = niHead.children[2];
eq(String(niJump.className), 'btn nodeinfo-jump', '第三块就是那个跳转按钮（面包屑排在它后面）');
eq(String(niHead.children[3].className), 'nodeinfo-crumb', '第四块是「所选节点面包屑」');
ok(/nig-crumb/.test(serialize(niHead.children[3])), '面包屑真的渲染进去了（来源树 + 祖先路径）');
eq(niJump.getAttribute('data-reveal-node'), 'cA', '它带的是**真实节点 id**（不是页内虚拟 id）');
eq(niJump.textContent, '🔎 跳到树上', '真实节点页的文案');
ok(!/display:flex/.test(String(niHead.style.cssText || '')), '顶部容器不再横向排（否则又挤在框旁边）');
ok(!/nodeinfo-fields-host/.test(serialize(niPane)), '字段表不再单独占用 tab 栏上方');

const niTabsBar = document.getElementById('ni-tabs-cA');
ok(!!niTabsBar, '子 tab 栏在自己的容器里');
const niBarHtml = serialize(niTabsBar);
ok(/folder-view-tab-btn/.test(niBarHtml), '子 tab 用的是文件夹模式那套按钮');
ok(niBarHtml.indexOf('完整字段表') >= 0
    && niBarHtml.indexOf('完整字段表') < niBarHtml.indexOf('子节点'),
    '**完整字段表排在子节点左侧**（二级 tab 栏开头）');
ok(/题目分布统计/.test(niBarHtml), '文件夹模式的内置页**全搬过来了**');
ok(!!document.getElementById('ni-tree-cA'), '子视图容器按宿主作用域命名（不抢主视图的 #tree-body）');

// 默认停在字段表那一页
const niFieldsHost = document.getElementById('ni-fields-cA');
ok(!!niFieldsHost, '字段表有自己那一个子视图容器');
ok(niFieldsHost.style.display !== 'none', '默认显示的就是字段表页');
ok(/完整字段表/.test(serialize(niFieldsHost)), '字段表标题在');
ok(/extKey/.test(serialize(niFieldsHost)), '字段表把结构字段也列出来（完整）');
ok(/来源：默认值|来源：自动计算/.test(serialize(niFieldsHost)), '没有来源值的字段也出一行（不静默省略）');
ok(!/All Closed/.test(serialize(document.getElementById('ni-tree-cA'))), '没选子节点页时它不画');

// 切到「子节点」页：走的是子 tab 栏点击那条路径
// （桩不解析 innerHTML ⇒ 那几个按钮在桩里不存在，点不了，只能从这个入口进）
const niView = await import(`file://${path.join(SRC, 'ui/nodeinfo/nodeInfoView.js').replace(/\\/g, '/')}`);
eq(niView.getNodeView('node-cA'), 'node-fields', '默认子视图 = 完整字段表');
niView.switchNodeView({ id: 'node-cA', nodeId: 'cA' }, 'children');
ok(/All Closed/.test(serialize(document.getElementById('ni-tree-cA'))),
    '切到子节点页 → 画在**自己的**容器里');
eq(document.getElementById('ni-fields-cA').style.display, 'none', '切走后字段表收起');
niView.switchNodeView({ id: 'node-cA', nodeId: 'cA' }, 'node-fields');
ok(/完整字段表/.test(serialize(document.getElementById('ni-fields-cA'))), '切回字段表页');

// 「🔗 所在组」：子 tab 栏里有它、有自己的容器、切过去真的渲染。
// ⚠️ 内容那几种身份（组头 / 成员 / 没归入 / 悬空）由 `src/test/nodeGroup.test.js` 钉死；
//    这里只验**接线**：位置、容器、宿主收放、切过去画在哪儿。
ok(/所在组/.test(niBarHtml), '「🔗 所在组」进了子 tab 栏');
ok(niBarHtml.indexOf('所在组') < niBarHtml.indexOf('✏️ 编辑'),
    '它排在「编辑」左边（观察在编辑之前）');
const niGroupHost = document.getElementById('ni-group-cA');
ok(!!niGroupHost, '「所在组」有自己的子视图容器');
eq(String(niGroupHost.style.display || ''), 'none', '没选中它时是收起的（宿主统一收放，不叠在字段表上）');
niView.switchNodeView({ id: 'node-cA', nodeId: 'cA' }, 'node-group');
eq(niView.getNodeView('node-cA'), 'node-group', '当前子视图切到了它');
// ⚠️ 每次重画都**整块重建** DOM ⇒ 必须**重新取**元素，别用切换前那一份（否则验的是已摘下来的旧节点）
ok(/所在组/.test(serialize(document.getElementById('ni-group-cA'))),
    '切到「所在组」→ 画在**自己的**容器里');
// 内容也真的渲染了：`cA` 没有 `ownerSynth` ⇒ 这一栏该照实说"没归入"并指到判重整理页。
// （有组时的名单渲染由 `src/test/nodeGroup.test.js` 钉；那边能注入假方框，这里不能。）
const niGroupHtml = serialize(document.getElementById('ni-group-cA'));
ok(/没有归入任何合成组/.test(niGroupHtml), '内容由 renderNodeGroupHtml 画出来（不是空容器）');
ok(/判重整理/.test(niGroupHtml), '没归入时指到该去哪处理');
eq(String(document.getElementById('ni-fields-cA').style.display || ''), 'none', '切走后字段表收起');
niView.switchNodeView({ id: 'node-cA', nodeId: 'cA' }, 'node-fields');

ok(!/All Closed/.test(serialize(document.getElementById('tree-body'))),
    '主视图的 #tree-body 完全没被动过（开关它不影响别的页）');

eq(activePane(), 'tab-node-cA', '面板激活且按需创建（大界面渲染后不变）');

tabs.openNodeInfoTab('root');
eq(niBtns().length, 2, '**可以同时开两个**（这就是"多界面"）');
eq(activeBtn(), 'node-root', '切到新开的那个');
ok(!!document.getElementById('tab-node-cA'), '前一个面板还在（开关它不影响别的）');

tabs.openNodeInfoTab('cA');
eq(niBtns().length, 2, '同一个节点重复打开 → 只切过去，不重复开');
eq(activeBtn(), 'node-cA', '切回已开的那个');

// ---- 副页里点 📋：传进来的是**页内 id**，开的必须是**真实节点**那个界面 ----
tabs.openNodeInfoTab('v_cA');
eq(niBtns().length, 2, '副页节点指向的**同一个真实节点** → 复用已开的面板，不再开一个');
ok(!niBtn('node-v_cA'), '**不会**开出 `node-v_cA`（页内 id 既不是节点、也没有字段）');
ok(!!niBtn('node-cA'), '开的是真实节点 `cA`');
eq(activeBtn(), 'node-cA', '切到它');

tabs.closeNodeInfoTab('node-root');
eq(niBtns().length, 1, '关掉一个');
ok(!document.getElementById('tab-node-root'), '被关的面板也移除了');
eq(activeBtn(), 'node-cA', '关掉的不是当前那个 → 当前不变');

tabs.closeNodeInfoTab('node-cA');
eq(niBtns().length, 0, '全部关掉');
eq(document.getElementById('nodeinfo-tab-bar').style.display, 'none', '全关掉后这一层又收起');
eq(allBtns().length, tabs.getTabs().length, '两条栏的按钮数合起来 = 注册表里的 tab 数');
eq(activeBtn(), 'main', '关掉当前那个 → 回主视图');
eq(tabs.readBuiltinTabs().map(t => t.id).join(','), 'dedup,main,stats',
    '内置页清单就是 index.html 里那三个（重渲染不会越滚越多）');

// ---- ★ 按住 Ctrl 点 📋 = 新开一个详页页签，**当前页不变**（`v9.0.18`）----
// 用户拍板：「别中键，就 Ctrl」，语义照浏览器。
// 这一段走的是**真实委托**（`ui/G_events.js` 那条文档级 click）与**真实点击事件对象**
// （`ctrlKey`），不是直接调 `openNodeInfoTab` —— 否则测不到"Ctrl 有没有被认出来"。
// ⚠️ 节点用**这一节里没有过的新 id**：`openNodeInfoTab` 的资料（`nodeInfoTabs`）是
//    会话级、跨用例留着的，复用 `cA` 会让"新开一个"变成"切到已开的那个"。
{
    const { AppState } = await import(`file://${path.join(SRC, 'shell/state.js').replace(/\\/g, '/')}`);
    // ★ 那条文档级委托要**真的装上**才测得到（`setupEventDelegation` 只注册一次，重复调无副作用）
    const gevents = await import(`file://${path.join(SRC, 'ui/G_events.js').replace(/\\/g, '/')}`);
    gevents.setupEventDelegation();
    AppState.nodes.ctrlA = { id: 'ctrlA', type: 'C', name: 'Ctrl 甲', values: {}, extKey: 'x:ctrlA' };
    AppState.nodes.ctrlB = { id: 'ctrlB', type: 'C', name: 'Ctrl 乙', values: {}, extKey: 'x:ctrlB' };
    // ⚠️ 2026-10-18：顶层大字典会被**冻结**（`freezeTopLevel` 白名单）⇒ 换整张字典，别就地改一格
    AppState.childOrder = {
        ...AppState.childOrder,
        ctrlA: [],
        ctrlB: [],
        root: [...(AppState.childOrder.root || []), 'ctrlA', 'ctrlB']
    };
    AppState.parentOf = { ...AppState.parentOf, ctrlA: 'root', ctrlB: 'root' };

    // 造两个「AC 列表那一行」的 📋：**不在** `.node-box` 里 ⇒ 正好落在文档级那条委托上
    const host = document.createElement('div');
    document.body.appendChild(host);
    const mkInfoBtn = (id) => {
        const b = document.createElement('button');
        b.className = 'btn-icon btn-node-info ai-record-info';
        b.dataset.id = id;
        host.appendChild(b);
        return b;
    };
    const infoA = mkInfoBtn('ctrlA');
    const infoB = mkInfoBtn('ctrlB');
    const clickWith = (el, ctrlKey) =>
        el.dispatchEvent({ type: 'click', target: el, ctrlKey, preventDefault() {}, stopPropagation() {} });

    eq(tabs.getCurrentTab(), 'main', '（前提）此刻停在主视图');
    eq(tabs.getNodeInfoTabs().length, 0, '（前提）此刻没有详页签');

    clickWith(infoA, true);
    eq(tabs.getNodeInfoTabs().length, 1, '★ Ctrl+点击 📋 ⇒ 多出一个详页页签');
    eq(tabs.getNodeInfoTabs()[0].id, 'node-ctrlA', '开的就是这个节点那一页');
    eq(tabs.getCurrentTab(), 'main', '★ **不切走**：当前页仍是主视图（"像浏览器那样"）');
    eq(activeBtn(), 'main', '激活态也还在主视图上（新页签是"未激活"的）');
    eq(niBtns().length, 1, '节点信息层上出现了那一个按钮');
    ok(!niBtn('node-ctrlA').classList.contains('active'),
        '★ 新开的那颗页签按钮**没有** active（"开而不激活"在按钮上也看得出来）');
    ok(!!document.getElementById('tab-node-ctrlA'),
        '未激活的详页也**已经建好容器**（否则点过去是一片空白）');
    ok(document.getElementById('nodeinfo-tab-bar').style.display !== 'none',
        '开了页签 ⇒ 那条层要显示（不然用户看不见它被开出来了）');

    // 反面对照：**普通点击**行为一个字不变（开 + 切过去）
    clickWith(infoB, false);
    eq(tabs.getNodeInfoTabs().length, 2, '普通点击照旧开一个');
    eq(tabs.getCurrentTab(), 'node-ctrlB', '★ 普通点击仍然**切过去**（行为不变）');

    // Ctrl 再点已经开着的那一个 ⇒ 不重复开、也不把它切到前台
    clickWith(infoA, true);
    eq(tabs.getNodeInfoTabs().length, 2, 'Ctrl 点已开着的 ⇒ 不重复开（沿用它）');
    eq(tabs.getCurrentTab(), 'node-ctrlB', '也不把当前页换掉（"开而不激活"两次落点一致）');

    host.remove();
}

// ===============================================================
group('节点详页里的节点方框也能点：委托挂到了详页容器上');
// ===============================================================
// 病根（`v9.1.27`，用户 2026-10-13 实测："节点详页子节点的各按钮点不了了"）：
// 「方框按钮」的那条委托 `onActionClick` 只挂在 `#tree-container` / `#folder-stats` 上，
// 而详页的容器 `tab-node-<节点id>` **不在**那两个容器里（它是 `tabs.js:ensureTabContent` 建的）
// ⇒ 详页里 `renderNode` 出来的每一个 `.node-box`（头部那一格 + 「子节点」那一栏）
//   上的 📋/✏️/➕/⚙️/⬆/⬇ 全都没反应。
// 修法 = 用**同一个** `onActionClick`，把详页容器也接上（`bindActionDelegation`，
// 与 `#folder-stats` 那次同一个口子 —— **不是**第二份实现、也不挂 `document`，
// 因为容器级这条与 `#tree-container` 那条天然互斥，挂 `document` 会"开两个弹窗"）。
//
// ⚠️ 这条**只能验到"接上的是同一份委托"**：`onActionClick` 里认按钮用的是**逗号选择器**
// （`.btn-icon, .toggle-btn, .pagination-btn`），而 DOM 桩（`scripts/smoke/dom.mjs`）
// 不解析逗号选择器 ⇒ 桩里任何点击都会在那行 `return`。所以"点下去真开页"要在浏览器里点一次，
// 这里钉住的是**接线本身**（这一页坏过的就是接线）。
{
    const gevents2 = await import(`file://${path.join(SRC, 'ui/G_events.js').replace(/\\/g, '/')}`);
    const niView2 = await import(`file://${path.join(SRC, 'ui/nodeinfo/nodeInfoView.js').replace(/\\/g, '/')}`);
    const handlers = el => (el && el._handlers && el._handlers.click) || [];

    const treeRoot = document.getElementById('tree-container');
    const treeClick = handlers(treeRoot);
    ok(treeClick.length > 0, '（前提）树上那条方框按钮委托已经装着（`setupEventDelegation` 跑过了）');

    // ⚠️ 2026-10-18：顶层大字典可能被冻结（`freezeTopLevel`）⇒ 造状态前换可变副本
    AppState.childOrder = { ...AppState.childOrder };
    AppState.parentOf = { ...AppState.parentOf };
    AppState.nodes.niBox = { id: 'niBox', type: 'C', name: '详页容器用例', values: {}, extKey: 'x:niBox' };
    AppState.childOrder.niBox = [];
    AppState.parentOf.niBox = 'root';
    AppState.childOrder.root.push('niBox');

    tabs.openNodeInfoTab('niBox');
    const pane = document.getElementById('tab-node-niBox');
    ok(!!pane, '详页容器建好了（`tab-node-<id>`）');

    ok(handlers(pane).some(h => treeClick.includes(h)),
        '★ 详页容器上挂的是**同一份** `onActionClick`（删掉 `bindActionDelegation(container)` 当场红）');
    eq(String(pane.dataset && pane.dataset.delegated), '1', '接线标记落在详页容器上（幂等靠它）');

    // 幂等：详页每次重画都会再调一次（`renderNodeInfoPanel` 末尾），不许叠出第二份监听
    const before = handlers(pane).length;
    niView2.renderNodeInfoPanel({ id: 'node-niBox', nodeId: 'niBox' });
    eq(handlers(pane).length, before, '重画详页不叠加第二份（幂等）');
    ok(handlers(pane).some(h => treeClick.includes(h)), '重画之后仍是同一份委托');

    tabs.closeNodeInfoTab('node-niBox');
}

// ===============================================================
group('节点信息大界面：插件面板按宿主隔离（同一视图被两个宿主挂载）');
// ===============================================================
// 主视图的文件夹页与节点信息大界面用的是**同一份视图定义**，而插件面板是按 id 单例的
// DOM 节点 —— 不按宿主分作用域，两边就会互相覆盖（症状：看过节点页的概览之后，
// 回主视图文件夹页看到的是那个节点页的内容）。这里钉的就是那条作用域。
const niHost = makeContainer(app, 'ni-test-host');
const demoViews = [{
    id: 'demo-panel', label: '演示', order: 300, isPlugin: true,
    mount(ctx) { if (ctx.panel) ctx.panel.innerHTML = '示例'; }
}];
host.mountFolderView({
    views: demoViews, viewId: 'demo-panel', ctx: {},
    hostContainerId: 'ni-test-host', scope: 'ni-node-cA'
});
ok(!!document.getElementById('folder-view-panel-ni-node-cA-demo-panel'),
    '节点信息宿主的面板带 scope 前缀');
ok(!document.getElementById('folder-view-panel-demo-panel'),
    '没有占用主视图那个面板 id');
host.mountFolderView({
    views: demoViews, viewId: 'demo-panel', ctx: {},
    hostContainerId: 'tree-container'
});
ok(!!document.getElementById('folder-view-panel-demo-panel'), '主视图宿主照旧用不带 scope 的 id');
ok(!!document.getElementById('folder-view-panel-ni-node-cA-demo-panel'),
    '两个宿主的面板**同时存在**，谁也不覆盖谁');
eq(serialize(document.getElementById('folder-view-panel-ni-node-cA-demo-panel')), '示例',
    '内容挂在各自的面板里');

// ===============================================================
group('判重整理页（主视图之前那一页：合成节点清单 + 推荐成员）');
// ===============================================================
// ⚠️ 这一页的**判定规则**在 core/dedup.js 里由单测钉死（`ownerSynth` 相等成组、
//    合成节点不进候选、W/S 不参与…）。这里只钉"页面把三块画出来了、按钮接上了"。
//    "点按钮真的写数据"由 `scripts/smoke/dedup-synth.smoke.mjs` 单独钉（那边走真实点击 + 事务）。
// ⚠️ **不要逐块改 `AppState.nodes` 再改 `AppState.childOrder`**：Immer 会缓存它见过的
//    基础对象，下一次事务的 draft 看不到后改的那一块（实测会在校验阶段炸）。
//    整块换掉（下面的 `useState`）才安全。
const useState = (state) => { for (const k of Object.keys(state)) AppState[k] = state[k]; };
AppState.settings = AppState.settings || { performance: {}, display: {}, mode: {} };
AppState.settings.performance = AppState.settings.performance || {};
AppState.settings.display = AppState.settings.display || {};

const DEDUP_NODES = {
    c1: { id: 'c1', type: 'C', name: '2026 浙江省赛', extKey: 'xcpc:c:zjcpc-2026', ownerSynth: 'synth:k1' },
    c2: { id: 'c2', type: 'C', name: '2026 浙江省赛（榜单）', extKey: 'qoj:c:999', ownerSynth: 'synth:k1' },
    c3: { id: 'c3', type: 'C', name: '2026 浙江省赛 补题', extKey: '', ownerSynth: '' },
    // ⚠️ 判重建议默认走**硬门槛**（题号相同 / 标题完全相同）⇒ 夹具要用**完全相同**的
    //    名字；`2026 浙江省赛 补题（榜单）` 那种**只是像**的名字是要藏起来的噪声。
    c4: { id: 'c4', type: 'C', name: '2026 浙江省赛 补题', extKey: '', ownerSynth: '' }
};
useState({
    nodes: DEDUP_NODES,
    parentOf: { c1: 'S1', c2: 'S1', c3: 'S1', c4: 'S1' },
    childOrder: { S1: ['c1', 'c2', 'c3', 'c4'] },
    rootId: 'S1'
});

const dedupPage = await import(`file://${path.join(SRC, 'ui/dedup/dedupPage.js').replace(/\\/g, '/')}`);
const dedupPane = document.getElementById('tab-dedup');
/** 二级 tab：四块改成四栏，切栏 = 点真按钮 */
const showDedupTab = id => {
    const b = dedupPane.querySelectorAll('.dedup-subtab').find(x => x.dataset.section === id);
    if (b) b.click();
    return !!b;
};
ok(!!dedupPage.renderDedupPage(), '整理页能画出来');
let dedupHtml = serialize(dedupPane);
ok(/判重整理/.test(dedupHtml), '标题在');
ok(/① 合成节点：0 个/.test(dedupHtml), '第一块：合成节点清单（还没有合成节点）');
showDedupTab('dupes');
dedupHtml = serialize(dedupPane);
ok(/② 可能重复：1 条建议/.test(dedupHtml), '第二块：推荐候选');
ok((dedupHtml.match(/2026 浙江省赛 补题/g) || []).length >= 2, '候选行列出这一对的两个节点');
showDedupTab('synth');
ok(/2026 浙江省赛/.test(serialize(dedupPane)) && /（榜单）/.test(serialize(dedupPane)),
    '① 那边列着还没归属的原料（含带「（榜单）」的那条）');
// 分组回归锚：分组读的是 `ownerSynth`（合成标识），不是 `mappingElementValue`
ok(!/mappingElementValue/.test(serialize(document.body)), 'UI 里不出现 `mappingElementValue`');
// **必须写明依据**（"凭什么"别让用户猜），不能只写"相似度 x.xx"。
ok(/依据：标题完全相同/.test(dedupHtml), '候选行写明依据（本题：标题完全相同）');
ok(/新建合成节点并归入/.test(dedupHtml), '候选行有「新建合成节点并归入」（两个都没归属）');

// 造一个**真的**合成节点：清单里要能列出它的标识、成员数、成员行
useState({
    nodes: {
        syn: { id: 'syn', type: 'C', name: '2026 浙江省赛（合成）', synthKey: 'synth:k1' },
        ...DEDUP_NODES
    },
    parentOf: { syn: 'S1', c1: 'S1', c2: 'S1', c3: 'S1', c4: 'S1' },
    childOrder: { S1: ['syn', 'c1', 'c2', 'c3', 'c4'] },
    rootId: 'S1'
});
dedupPage.invalidateDedupCache();
dedupPage.renderDedupPage();
showDedupTab('synth');
dedupHtml = serialize(dedupPane);
ok(/① 合成节点：1 个/.test(dedupHtml), '第一块：合成节点清单（1 个）');
ok(/synth:k1/.test(dedupHtml), '分组键 = ownerSynth 的值（synth: 前缀）');
ok(/成员 2/.test(dedupHtml), '成员数按指针算');
ok(/2026 浙江省赛（合成）/.test(dedupHtml), '合成节点的标题在');
showDedupTab('summary');
ok(/节点共 5 个：合成节点 1 个、已归入的原料 2 个/.test(serialize(dedupPane)), '第四块：概览（在它自己那一栏）');
showDedupTab('synth');

// 解绑按钮接的是写操作（点了会走 core/ops 的只读闸门 + 写来源层）；
// 这里只验"按钮在、点了不抛" —— 真的写盘由 readonly-boundary 那套冒烟保证。
const unbindBtn = dedupPane.querySelectorAll('.btn').find(b => b.textContent === '解绑');
ok(!!unbindBtn, '合成节点卡的成员行上有「解绑」');
ok(typeof unbindBtn.click === 'function', '按钮是真实元素（DOM 构造）');
ok(dedupPane.querySelectorAll('.btn').some(b => b.textContent === '删除合成节点'), '有「删除合成节点」');

// ---- 分页：两万条不能靠"一次画完" ----
// 30 个合成节点（各 2 个成员）→ 每页 25 个 → 必然两页
const bigNodes = { S1: { id: 'S1', type: 'S', name: '系列' } };
const bigParents = { S1: null };
const bigChildOrder = { S1: [] };
for (let i = 0; i < 30; i++) {
    const sid = `syn${i}`;
    bigNodes[sid] = { id: sid, type: 'C', name: `合成 ${i}`, synthKey: `synth:key-${i}` };
    bigParents[sid] = 'S1';
    bigChildOrder.sid = [];
    bigChildOrder.S1.push(sid);
    for (const side of ['a', 'b']) {
        const id = `g${i}${side}`;
        bigNodes[id] = {
            id, type: 'C', name: `比赛 ${i} ${side}`, extKey: `x:${i}`,
            ownerSynth: `synth:key-${i}`
        };
        bigParents[id] = 'S1';
        bigChildOrder[id] = [];
        bigChildOrder.S1.push(id);
    }
}
useState({ nodes: bigNodes, parentOf: bigParents, childOrder: bigChildOrder, rootId: 'S1' });
dedupPage.invalidateDedupCache();
dedupPage.renderDedupPage();
// 每张合成节点卡的第一行就是它的标识（见 dedupPage 的 synthSection）
const groupKeys = () => dedupPane.querySelectorAll('.dedup-synth')
    .map(c => (c.children[0] && c.children[0].children[0] ? c.children[0].children[0].textContent : ''));
const page1 = serialize(dedupPane);
ok(/① 合成节点：30 个/.test(page1), '30 个合成节点都算出来了（只是不一次画完）');
ok(/第 1 \/ 2 页（共 30 条）/.test(page1), '第一页的分页条在');
const keys1 = groupKeys();
eq(keys1.length, 25, 'DOM 里只画当前页的 25 个合成节点');

const nextBtn = dedupPane.querySelectorAll('.btn').find(b => b.textContent === '下一页 ▶');
ok(!!nextBtn, '有「下一页」');
nextBtn.click();
const page2 = serialize(dedupPane);
ok(/第 2 \/ 2 页（共 30 条）/.test(page2), '翻到第二页');
const keys2 = groupKeys();
eq(keys2.length, 5, '第二页只剩 5 个');
eq(keys1.filter(k => keys2.includes(k)).length, 0, '两页不重叠（按 key 字符串排序切页）');
eq(new Set([...keys1, ...keys2]).size, 30, '两页合起来正好覆盖全部 30 个合成节点');
showDedupTab('summary');
ok(/已归入的原料 60 个/.test(serialize(dedupPane)), '翻页不动数据（60 个成员照旧，在概览那一栏里对）');

report();
