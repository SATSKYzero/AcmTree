// ================================================================
// 视图渲染器（view/viewRenderers.js）
// 职责：树形/文件夹两种视图的 HTML 填充
// 依赖：view/renderers.js, view/helpers.js
// ================================================================
import { renderNode } from './renderers.js';
// ★ 单行渲染成本的分段累加（纯诊断；见 `renderers.js` 文件头那段）
import { resetRenderSegments, renderSegmentsOf } from './renderers.js';
// ★ 副页容器行那几串的缓存命中情况（纯诊断：命中 0 说明烘热没跑到 / 键对不上）
import { virtualBucketStats, resetVirtualBucketStats } from './stats.js';
import { getChildNodes, isNodeExpanded } from './helpers.js';
// ★ 诊断日志的唯一开关（`localStorage.DSH_DIAG = '1'` + 刷新；见 `utils/diag.js` 文件头）
import { diag, diagOn, nowMs, msSince } from '../utils/diag.js';
// ★ 按页分槽的记忆表（副页统计 / 树 HTML / 计划栏共用一份实现）
import { createSlots } from '../utils/memoSlots.js';

// ================================================================
// 树形视图（递归展开）
// ================================================================
//: 主树那套 HTML 的**每页独立槽缓存**（2026-10-18）：只在调用方给 `cacheKey` 时生效，不给就完全照旧。
//: 键由调用方构造 —— **必须包含所有影响输出的东西**（`nodes` / 页 / 视图态 / 显示设置 / 账户与 trust…），
//: 少一个就会读到旧表（用户 2026-10-18："副页应有的内容会受主页改动而受影响"）。
//: ★ **每页一格、页没了那格自动回收**（`utils/memoSlots.js` 的 `WeakMap`，键 = **页对象**）：
//:   用户 2026-10-18 连点三次："怎么是共用槽位的" ⇒ 单槽时两个副页来回切每次都要重拼 20 万字符（实测 ~198ms）；
//:   "改成独立槽位" ⇒ 每页各一格；"为什么不收" ⇒ 键换成页对象本身，删页/整包导入后自动回收。
//:   槽里存 `{ key, html }`：键（`pageRenderKey`，含数据代/视图态/账户…）变了就只覆盖**这一页**的槽。
const treeHtmlSlots = createSlots();
/** 槽的键 = `pageRenderKey` 的第一段（就是页 id；日志里也一直按它打） */
const pageKeyOf = (cacheKey) => String(cacheKey).split('|')[0];

export function renderTreeView(state, data, containerId = 'tree-body', cacheKey = null) {
    const container = document.getElementById(containerId);
    if (!container) return;

    // 槽按**页对象**取（WeakMap 的键）—— `cacheKey` 里只有 id，页对象从 `state.pages` 现取。
    // 页已删 / 调用方不是按页渲染（主树那条路本来就不传 `cacheKey`）⇒ `page` 为空 ⇒ 这一趟不缓存。
    const page = (cacheKey && state && state.pages) ? state.pages[pageKeyOf(cacheKey)] : null;
    if (cacheKey && page) {
        treeHtmlSlots.prune(Object.keys(state.pages || {}));      // 顺手回收"已删掉的页"那些格
        const slot = treeHtmlSlots.get(page.id);
        if (slot && slot.key === cacheKey) {
            // 诊断（用户 2026-10-18 要求"先确定有触发"）：标一条**热**。开关在 `utils/diag.js`。
            diag('副页渲染', '热（命中缓存，直接把上次的 HTML 贴回）', { page: page.id });
            container.innerHTML = slot.html;
            return;
        }
    }
    // 计时起点只在"诊断开着"时取（关着就一个时间戳都不算，见 `utils/diag.js`）
    const t0 = diagOn() ? nowMs() : 0;

    const put = (html) => {
        if (cacheKey && page) treeHtmlSlots.set(page.id, { key: cacheKey, html });
        // 诊断（同上）：**冷** —— 这次真的重建了，报毫秒数与字符数（浏览器里贴 HTML 还会再花解析/布局）
        if (cacheKey && t0) {
            diag('副页渲染', '冷（重建）', {
                page: pageKeyOf(cacheKey),
                拼串: msSince(t0) + 'ms',
                字符: html.length
            });
        }
        container.innerHTML = html;
    };

    if (data.type === 'empty') {
        put(`<div class="empty-state"><p>暂无数据</p></div>`);
        return;
    }

    const { root, parentId } = data;
    const segOn = t0 !== 0;                       // 诊断开着才计时（关着零成本）
    if (segOn) { resetRenderSegments(); resetVirtualBucketStats(); }
    const tChild = segOn ? nowMs() : 0;
    const children = getChildNodes(state, root);
    const childMs = segOn ? msSince(tChild) : 0;

    let html = '';
    const tLoop = segOn ? nowMs() : 0;
    if (children.length) {
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            html += renderNode(state, child, i, children, parentId, !isNodeExpanded(state, child), 'full');
        }
    } else {
        html = `<div class="empty-state"><p>该节点下没有内容</p></div>`;
    }
    // 诊断（2026-10-18）：逐行那一段的账 —— 取子节点几毫秒、**逐行循环本身**几毫秒、
    //   **按类型**各几行几毫秒（用户那页是 `W/S 10行/360ms`，而同一趟 `拼串` 只有 194ms ⇒
    //   两个数对不上，所以这里把"循环自己花的钱"也打出来做交叉核对）、P 行内部再拆。
    if (segOn) {
        const seg = renderSegmentsOf();
        const vb = virtualBucketStats();
        const r = (x) => Math.round(x);
        const per = Object.keys(seg.nByType)
            .map((t) => `${t} ${seg.nByType[t]}行/${r(seg.byType[t] || 0)}ms`)
            .join(' + ') || '（没有行）';
        // 单行内部分段（按类型前缀，如 `W/S.标题`）：只打>0 的那几项，别把一行撑爆
        const parts = Object.keys(seg)
            .filter((k) => /\./.test(k) && seg[k] > 0.5)
            .sort((a, b) => seg[b] - seg[a])
            .map((k) => `${k} ${r(seg[k])}`)
            .join(' / ');
        diag('渲染行', `${children.length} 行 · 取子 ${childMs}ms · 逐行 ${msSince(tLoop)}ms · ${per}`
            + ` · 桶缓存 ${vb.hit}命中/${vb.miss}算/${r(vb.ms)}ms`
            + (parts ? ` · 分段：${parts}` : ''));
    }
    put(html);
}

// ================================================================
// 文件夹视图（单层，带分页）
// ================================================================
export function renderFolderView(state, data, containerId = 'tree-body') {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (data.type === 'empty' || !data.nodes || data.nodes.length === 0) {
        container.innerHTML = `<div class="empty-state"><div class="empty-icon">📂</div><p>该目录下没有内容</p></div>`;
        return;
    }

    const { nodes, parentId, pagination } = data;
    const { currentPage, total, pageCount, start, end } = pagination;

    let paginationHtml = '';
    if (pageCount > 1) {
        const startDisplay = start + 1;
        const endDisplay = end;
        paginationHtml = `
            <div class="pagination" style="display:flex; align-items:center; gap:8px; margin:0px 0 6px 26px; font-size:13px; color:#475569;">
                <button class="pagination-btn pagination-prev" data-id="${parentId}" data-page="${currentPage - 1}" ${currentPage <= 1 ? 'disabled' : ''} style="padding:2px 8px; border:1px solid #d1d5db; border-radius:4px; background:transparent; cursor:pointer; ${currentPage <= 1 ? 'opacity:0.3; cursor:not-allowed;' : ''}">◀</button>
                <span>${currentPage} / ${pageCount}</span>
                <button class="pagination-btn pagination-next" data-id="${parentId}" data-page="${currentPage + 1}" ${currentPage >= pageCount ? 'disabled' : ''} style="padding:2px 8px; border:1px solid #d1d5db; border-radius:4px; background:transparent; cursor:pointer; ${currentPage >= pageCount ? 'opacity:0.3; cursor:not-allowed;' : ''}">▶</button>
                <span style="color:#94a3b8; font-size:12px;">(${startDisplay}~${endDisplay} / ${total})</span>
            </div>
        `;
    }

    const pageNodes = nodes.slice(start, end);
    let listHtml = '';
    for (let i = 0; i < pageNodes.length; i++) {
        const child = pageNodes[i];
        listHtml += renderNode(state, child, start + i, nodes, parentId, true, 'folder', false, parentId);
    }

    container.innerHTML = paginationHtml + listHtml;
}