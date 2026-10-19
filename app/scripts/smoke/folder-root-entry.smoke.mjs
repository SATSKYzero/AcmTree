// ================================================================
// 冒烟：**"根"那一格的详页入口**（scripts/smoke/folder-root-entry.smoke.mjs）
//
// 为什么有这一份（用户 2026-10-13 报："无法看到超级根节点的统计（总统计）；
// 超级根节点的详页入口放总览统计右侧吧"）：
//   根**在两种显示模式下都没有自己的方框** ——
//     · 树模式 `renderTreeView` 画的是它的**孩子**（`getChildNodes(state, root)`）；
//     · 文件夹模式停在根这一格只画总览统计。
//   ⇒ 它原来**一个详页入口都没有**，"根那一层的统计 / 字段"根本点不开。
//   修法 = 在总览统计右边补一颗 📋（`ui/folder/folderShared.js:rootInfoButton`）。
//
// ⚠️ **两种根的身份不一样**，这是本文件钉的重点（写成一份就会有一边点不开）：
//   · 主树超级根：`{ id }` ⇒ 只写 `data-id`；
//   · 副页根（页内 `v_root`，代表"这一页"）：`{ vid, pageId }` ⇒ **故意不给 `data-id`**
//     （它不引用任何主树节点）⇒ `G_events.js:openInfoFromButton` 算出 `refId === ''`
//     ⇒ "看哪个"里如实说"这是副页根节点…"。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

const body = installDom([], { parseHtml: true });
makeContainer(body, 'folder-stats');
// 树模式那条统计栏的三个格子（`index.html` 里就是这一串）
makeContainer(body, 'tree-stats');
makeContainer(body, 'tree-root-info-container');
makeContainer(body, 'mode-action-btn-container');
const { renderFolderStatsComponent, applyTreeLayout } = await import(mod('ui/folder/folderShared.js'));

const STATS = { cStr: 'C:01/02/03/04/05', pStr: 'P:06/07/08/09/10' };
/** 画一次"停在根"那一格，把 `#folder-stats` 交出来（`showAddBtn` 关掉：这颗按钮要 AppState，与本题无关） */
function paintRoot(rootInfo) {
    const el = document.getElementById('folder-stats');
    el.innerHTML = '';
    renderFolderStatsComponent({ state: { rootId: 'o' }, stats: STATS, isRoot: true, rootInfo });
    return el;
}

group('① 主树超级根：总览统计右边有一颗 📋，身份是主树 id');
{
    const el = paintRoot({ id: 'o', title: '超级根的详细节点信息' });
    const btn = el.querySelector('.btn-node-info');
    ok(!!btn, '★ 根那一格有 📋 了（改前一个入口都没有 ⇒ 详页永远打不开）');
    eq(btn.dataset.id, 'o', '★ 带的是**主树根节点 id**（`data-id` 那一份契约）');
    eq(btn.dataset.vid || '', '', '主树根**不该**带 data-vid（带了会去弹"看哪个"）');

    // 位置：**总览统计右边**（用户指的位置）—— 判据是它在 DOM 里的先后，不是靠肉眼
    const box = el.querySelector('.app-stats');
    const order = box.parentElement.children;
    ok(order.indexOf(box) < order.indexOf(btn), '★ 📋 排在总览统计**右边**（用户 2026-10-13 指的位置）');
}

group('② 副页根：身份是页内 v_root（不给 data-id）');
{
    const el = paintRoot({ vid: 'v_root', pageId: 'p1', title: '这个副页根节点的详细信息' });
    const btn = el.querySelector('.btn-node-info');
    ok(!!btn, '★ 副页根那一格也有 📋');
    eq(btn.dataset.vid, 'v_root', '带的是**页内 id**（走"看哪个"那一支）');
    eq(btn.dataset.pageId, 'p1', '带上 pageId（否则 `openInfoFromButton` 会退回"当前页"）');
    eq(btn.dataset.id || '', '', '★ 副页根**故意不给 data-id** —— 它不引用任何主树节点，'
        + '给了就会在"看哪个"里列一个假的主节点选项');
}

group('③ 老调用方不传 rootInfo ⇒ 与改前逐字相同（不显摆）');
{
    const el = paintRoot(null);
    eq(el.querySelectorAll('.btn-node-info').length, 0, '没传就不画（别的调用路径不受影响）');
    // ⚠️ 不断言那两串数字的**文字**：DOM 桩的 `textContent` 对 `innerHTML` 解析出来的子树算不出来
    //    （实测恒为空串），断言它只会得到一条假红。这里只钉"总览统计那一格照旧在"。
    ok(!!el.querySelector('.app-stats'), '总览统计那一格照旧在（只多了 📋，没替换掉它）');
}

// ================================================================
// 树模式那条统计栏（`#tree-stats`）—— **同一个规则、另一处渲染点**（`v9.1.19`）
//
// 为什么必须一起钉：树模式下根**也不画方框**（`renderTreeView` 画的是它的孩子）⇒
// 只补文件夹模式那一处，一切到树模式就又打不开了（这是本轮返工的原因，记在这儿别重犯）。
// ⚠️ 它**不复用** `#mode-action-btn-container`：那格装「添加根节点 / 清空选择」，
// 清空选择时会被清掉，📋 不该跟着消失。
// ================================================================
group('④ 树模式顶部那条：同一个规则、同一个位置（总览统计右边）');
{
    const slot = document.getElementById('tree-root-info-container');
    const paintTree = rootInfo => {
        slot.innerHTML = '';
        applyTreeLayout({ statsContent: '<span>C:x</span>', rootInfo });
        return slot;
    };

    const a = paintTree({ id: 'o', title: '超级根的详细节点信息' });
    eq(a.querySelector('.btn-node-info')?.dataset.id, 'o', '★ 树模式下超级根也有 📋（改前切过来就打不开）');

    const b = paintTree({ vid: 'v_root', pageId: 'p2', title: '这个副页根节点的详细信息' });
    eq(b.querySelector('.btn-node-info')?.dataset.vid, 'v_root', '副页树模式给页内 id');
    eq(b.querySelector('.btn-node-info')?.dataset.id || '', '', '同样**不给 data-id**（不给才不会列假的主节点选项）');

    const c = paintTree(null);
    eq(c.querySelectorAll('.btn-node-info').length, 0, '不传就不画');
    eq(c.style.display, 'none', '★ 不传时整格隐藏（否则那格在 flex 行里留一段空白）');

    // 位置：这一格在 `index.html` 里就夹在 `#tree-stats` 与 `#mode-action-btn-container` **之间**
    const stats = document.getElementById('tree-stats');
    const acts = document.getElementById('mode-action-btn-container');
    const row = stats.parentElement.children;
    ok(row.indexOf(stats) < row.indexOf(c) && row.indexOf(c) < row.indexOf(acts),
        '★ 📋 夹在「总览统计」与「添加根节点」之间 = 总览统计右边（与文件夹模式那条同一个位置）');
}

report('根那一格的详页入口');
