// ================================================================
// AC 列表视图（含模式开关与统计视图）（ui/stats/ac/listView.js）
//
// 职责：列表/统计两种看法的切换与各自的渲染。
// ⚠️ `acListView*` 那七个 `let` 住在这里：它们由 `renderACListView` /
// `bindModeToggleEvents` 赋值（= 本文件），搬去别处就会变成跨模块赋值。
// ================================================================
import { getACTrackingPageSize } from './state.js';
import { renderNode } from '../../../view/index.js';
import { renderStatsChart } from '../statsCharts.js';
// ★「节点行」上的 🔎 / 📋 / 面包屑复用现成那三份（`ui/kit/nodeEntry.js`）——
//   本页是 `readonly`（不画按钮）且不在 `#tree-container` 里 ⇒ 不补就点不动（G1）
import { appendNodeEntries } from '../../kit/nodeEntry.js';

let acListViewMode = 'list';

let acListViewNodesCache = [];

let acListViewTitleCache = '';

let acListViewContainerIdCache = '';

let acListViewOnPageChangeCache = null;

let acListViewShowCloseBtnCache = false;

let acListViewCloseHandlerCache = null;

export function renderACListView({
    state,
    nodes,
    title,
    containerId,
    page,
    onPageChange,
    showCloseBtn = false,
    closeHandler = null
}) {
    acListViewNodesCache = nodes;
    acListViewTitleCache = title;
    acListViewContainerIdCache = containerId;
    acListViewOnPageChangeCache = onPageChange;
    acListViewShowCloseBtnCache = showCloseBtn;
    acListViewCloseHandlerCache = closeHandler;

    const container = document.getElementById(containerId);
    if (!container) return;

    const total = nodes.length;

    if (acListViewMode === 'stats') {
        renderACStatsView(state, container, title, total, nodes, showCloseBtn, closeHandler, containerId);
        return;
    }

    if (total === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:20px; text-align:center; color:#94a3b8; font-size:13px;">
                <p>📭 ${title}</p>
            </div>
        `;
        return;
    }

    const pageSize = getACTrackingPageSize();
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (page < 1) page = 1;
    if (page > pageCount) page = pageCount;

    const start = (page - 1) * pageSize;
    const end = Math.min(page * pageSize, total);
    const pageNodes = nodes.slice(start, end);

    let html = `
        <div style="margin-top:4px;">
            <div style="display:flex; align-items:center; gap:12px; margin-bottom:6px; flex-wrap:wrap;">
                <span style="font-weight:600; font-size:13px; color:#0f172a;">📅 ${title}</span>
                <span style="font-size:12px; color:#94a3b8;">(${total} 题)</span>
                <span style="font-size:11px; color:#94a3b8;">分页大小由"最近AC题目列表"中的分页大小控制</span>
                <span style="flex:1;"></span>
                ${renderModeToggleHTML()}
                ${pageCount > 1 ? `
                    <div style="display:flex; align-items:center; gap:6px; font-size:13px;">
                        <button class="btn ac-list-prev" style="padding:1px 8px; ${page <= 1 ? 'opacity:0.3;cursor:not-allowed;' : ''}" ${page <= 1 ? 'disabled' : ''}>◀</button>
                        <span>${page} / ${pageCount}</span>
                        <button class="btn ac-list-next" style="padding:1px 8px; ${page >= pageCount ? 'opacity:0.3;cursor:not-allowed;' : ''}" ${page >= pageCount ? 'disabled' : ''}>▶</button>
                    </div>
                ` : ''}
                ${showCloseBtn ? `<button class="btn ac-list-close" style="padding:1px 8px; font-size:12px;">✖ 关闭</button>` : ''}
            </div>
            <div class="ac-list-rows" style="display:flex; flex-direction:column; gap:2px; max-height:1000px; overflow-y:auto; padding:2px 0;">
    `;

    for (const node of pageNodes) {
        html += renderNode(state, node, 0, [], null, true, 'readonly');
    }

    html += `
            </div>
        </div>
    `;

    container.innerHTML = html;

    // ★ 每一行补上「🔎 跳到树上 / 📋 打开详页 / 面包屑」（G1）。
    //   这一处用的是 `readonly` ⇒ `view/helpers.js:buildActions` **一个按钮都不画**，
    //   `G_events` 那两条委托也只挂 `#tree-container` / `#folder-stats`
    //   ⇒ 不补的话这里点方框**什么都不发生**。
    //   ⚠️ 入口条复用现成那三份（`markGoto` / `btn-node-info` / `breadcrumbHtml`），
    //      见 `ui/kit/nodeEntry.js`；也**别**因此把这一页从 `readonly` 换成 `folder`
    //      （那会多出 ✏️➕⚙️✖⬆⬇ 这些在这一页根本没有委托接住的按钮）。
    appendNodeEntries(container, state, '.ac-list-rows');

    if (pageCount > 1) {
        const prevBtn = container.querySelector('.ac-list-prev');
        const nextBtn = container.querySelector('.ac-list-next');
        if (prevBtn) {
            prevBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                const newPage = page - 1;
                if (newPage >= 1) onPageChange(newPage);
            });
        }
        if (nextBtn) {
            nextBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                const newPage = page + 1;
                if (newPage <= pageCount) onPageChange(newPage);
            });
        }
    }

    if (showCloseBtn && closeHandler) {
        const closeBtn = container.querySelector('.ac-list-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                closeHandler();
            });
        }
    }

    bindModeToggleEvents(container, state);
}

function renderModeToggleHTML() {
    const isList = acListViewMode === 'list';
    return `
        <div style="display:flex; gap:2px; border:1px solid #d1d5db; border-radius:4px; overflow:hidden; font-size:12px;">
            <button class="ac-mode-btn ${isList ? 'active' : ''}" data-mode="list" style="padding:1px 8px; border:none; background:${isList ? '#2563eb' : 'transparent'}; color:${isList ? '#fff' : '#64748b'}; cursor:pointer; transition:all 0.15s;">📋 列表</button>
            <button class="ac-mode-btn ${!isList ? 'active' : ''}" data-mode="stats" style="padding:1px 8px; border:none; background:${!isList ? '#2563eb' : 'transparent'}; color:${!isList ? '#fff' : '#64748b'}; cursor:pointer; transition:all 0.15s;">📊 统计</button>
        </div>
    `;
}

function bindModeToggleEvents(container, state) {
    container.querySelectorAll('.ac-mode-btn').forEach(btn => {
        btn.addEventListener('click', function () {
            const mode = this.dataset.mode;
            if (mode && mode !== acListViewMode) {
                acListViewMode = mode;
                renderACListView({
                    state,
                    nodes: acListViewNodesCache,
                    title: acListViewTitleCache,
                    containerId: acListViewContainerIdCache,
                    page: 1,
                    onPageChange: acListViewOnPageChangeCache,
                    showCloseBtn: acListViewShowCloseBtnCache,
                    closeHandler: acListViewCloseHandlerCache
                });
            }
        });
    });
}

// ================================================================
// 统计视图渲染
// ================================================================

function renderACStatsView(state, container, title, total, nodes, showCloseBtn, closeHandler, containerId) {
    let headerHtml = `
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:8px; flex-wrap:wrap; margin-top:4px;">
            <span style="font-weight:600; font-size:13px; color:#0f172a;">📅 ${title}</span>
            <span style="font-size:12px; color:#94a3b8;">(${total} 题)</span>
            <span style="flex:1;"></span>
            ${renderModeToggleHTML()}
            ${showCloseBtn ? `<button class="btn ac-list-close" style="padding:1px 8px; font-size:12px;">✖ 关闭</button>` : ''}
        </div>
        <div style="margin-bottom:4px; font-size:12px; color:#94a3b8;">📊 难度分布统计（仅统计 AC 题目）</div>
    `;

    container.innerHTML = headerHtml;

    const statsContainerId = containerId + '-stats-inner';
    const statsDiv = document.createElement('div');
    statsDiv.id = statsContainerId;
    statsDiv.style.cssText = 'min-height:200px;';
    container.appendChild(statsDiv);

    renderStatsChart(state, null, 'xcpc', nodes, statsContainerId, true);

    if (showCloseBtn && closeHandler) {
        const closeBtn = container.querySelector('.ac-list-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                closeHandler();
            });
        }
    }

    bindModeToggleEvents(container, state);
}
