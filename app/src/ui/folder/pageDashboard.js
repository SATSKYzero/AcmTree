// ================================================================
// 副页仪表盘（`ui/folder/pageDashboard.js`）
//
// 用户 2026-10-15："副页需要一个仪表盘，用来装副页的全局操作"。
// 口径与边界写在 `docs/subpage-sync.md` §2③（那一篇是这一类东西的档案）。
//
// 它装什么：
//   · **概况**：这一页的 C/P 统计（现成的 `getVirtualGlobalStats`）、节点数、屏蔽数；
//   · **全局操作**：🔄 与主树对齐 · ⧉ 复制副页 · ✎ 重命名 · ✖ 删除副页；
//   · **🚫 屏蔽清单**：屏蔽的节点可能藏在折叠深处，没有清单就找不回来（点名字跳过去 / 一键取消）。
//
// ⚠️ 动作**不在这里实现**：复制 / 删除 / 重命名 / 对齐 / 取消屏蔽全都挂 `G_pageUI.js` 那条
//    **文档级委托**（本文件只画按钮，class + `data-*` 照它认的形状发）。
//    这样"副页的全局操作只有一处实现"，也符合"别新增第二条全局监听"的规矩。
// ⚠️ 只画**当前副页**的东西：主页（`main`）上必须隐藏并清空。
// ================================================================
import { AppState } from '../../shell/state.js';
import { escapeHtml } from '../../utils/html.js';
import { plain } from '../../utils/text.js';
import { getVirtualGlobalStats } from '../../view/stats.js';
// ★ 列表行的"三件套"（🔎 跳转 / 📋 详页 / 面包屑）用**现成的那一份**（`ui/kit/nodeEntry.js`）——
//   用户 2026-10-15："像这些列表，都该尽可能有详尽的信息与功能（面包屑、点击跳转、详页…）"。
//   ⚠️ 它是用 `mk()` 造**真元素**的（不是 innerHTML）⇒ 冒烟里看得见，这条能被真的钉住。
import { nodeEntryLine } from '../kit/nodeEntry.js';
import { getVirtualDisplayNode } from '../../view/dataAdapter.js';

//: 槽位 id（`ui/G_pageUI.js:renderPageTabs` 里建，紧跟在页签那一行下面）
export const PAGE_DASHBOARD_ID = 'page-dashboard';

const BTN = 'padding:3px 10px;font-size:12px;';
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.6;';

/**
 * 屏蔽清单**默认折叠**（用户 2026-10-15："屏蔽请默认折叠"——一屏几十条会顶掉别的东西）。
 *
 * ⚠️ 这是**界面上的临时状态**：住模块里、不进数据也不进 `state.view`
 *    （它不像"树展开/翻页"那样是逐节点的视图态；刷新页面回到"折叠"正是我们要的默认）。
 */
let blockedOpen = false;

/**
 * 屏蔽清单**每页几条**（用户 2026-10-15："分页，默认 10"）。
 *
 * ⚠️ 这是**这个清单自己的**页大小，与树/文件夹那个「每页条数」设置（`settings.display.nodePerPage`，
 * 默认 20，住在 `state.view.pages`）**不是一件事** —— 别把两者混成一个旋钮。
 */
const BLOCKED_PAGE_SIZE = 10;

/** 清单现在翻到第几页（同 `blockedOpen`：临时界面状态，不进数据） */
let blockedPage = 1;

/** 翻页（`delta` = ±1）；越界夹回，渲染时再夹一次 */
export function changeBlockedPage(delta) {
    blockedPage = Math.max(1, blockedPage + (delta < 0 ? -1 : 1));
    return renderPageDashboard();
}

/** 这一页里被屏蔽的节点（页内 id + 名字 + 它指的真实节点） */
function blockedRowsOf(page) {
    const out = [];
    for (const v of Object.values(page.virtualIndex || {})) {
        if (!v.syncBlocked) continue;
        const real = v.refId ? AppState.nodes[v.refId] : null;
        out.push({
            vid: v.id,
            refId: v.refId || '',
            type: v.type || '',
            name: (real && (real.name || real.problemId || real.time)) || v.refId || v.id
        });
    }
    return out;
}

/**
 * 折 / 展开"已屏蔽 N 处"那份清单（点仪表盘上那颗 `▸/▾`）。
 *
 * ⚠️ 清单很长（几十条），所以**默认折叠**；这里只翻界面状态 + 重画这一块，
 *    不碰任何数据（见上面 `blockedOpen` 的说明）。
 */
export function toggleBlockedList() {
    blockedOpen = !blockedOpen;
    return renderPageDashboard();
}

/** 给自测/排错看：清单现在是开着还是合着 */
export function isBlockedListOpen() {
    return blockedOpen;
}

/**
 * 屏蔽清单里的**一行**（DOM 造，不是 innerHTML —— `nodeEntryLine` 返回的是真元素）。
 *
 * 一行 = `🚫 名字` + **三件套**（`nodeEntryLine`：🔎 跳到这一页的位置 / 📋 详页 / 面包屑）+ 「取消屏蔽」。
 * ⚠️ 三件套**必须**用 `ui/kit/nodeEntry.js` 那一份：跳转/详情/面包屑在本仓各只有一份实现
 *    （`docs/node-navigation.md` §2、`docs/node-lists.md` 「节点列表」一节），别在这儿手写第四种。
 */
function buildBlockedRow(page, b) {
    const row = document.createElement('div');
    row.className = 'page-blocked-row';
    // ⚠️ **一行一个圆角淡框的小卡**（用户 2026-10-15："每项都要假想装在矩形里，每个矩形合适间距"）：
    //    ① 卡**占满可用宽度**（`display:flex`，不是 `inline-flex`/`fit-content`）—— 只有这样
    //       `nodeEntryLine` 里那颗 📋 的 `margin-left:auto` 才有空白可吃、操作才贴得到**右端点**；
    //    ② 卡内各格（🚫 / 身份键 / 面包屑 / 📋 / 取消屏蔽）之间就是同一个固定 `gap`，**间距一致**；
    //    ③ 卡与卡之间由容器给固定 `gap`（每条独占一行，见下面 `rowsHost` 的 `flex-direction:column`）。
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:nowrap;'
        + 'max-width:100%;min-width:0;padding:3px 8px;'
        + 'border:1px solid #eef2f6;border-radius:6px;background:#fbfdff;';
    const mark = document.createElement('span');
    mark.textContent = '🚫';
    mark.setAttribute('title', plain('已屏蔽：与主树对齐时不再往下递归（这一支已有的内容不增不减）'));
    mark.style.cssText = 'flex:0 0 auto;font-size:12px;';
    row.appendChild(mark);

    // 页内 id → **副页投影节点**（`_virtual / _virtualId / _refId / _pageId`）⇒ `nodeEntryLine` 走页内那一支
    const node = getVirtualDisplayNode(AppState, page.id, b.vid);
    if (node) row.appendChild(nodeEntryLine(AppState, node, { compact: true }));

    const btn = document.createElement('button');
    btn.className = 'btn page-unblock-btn';
    btn.dataset.pageId = page.id;
    btn.dataset.vid = b.vid;
    btn.style.cssText = `${BTN};flex:0 0 auto;`;
    btn.textContent = '取消屏蔽';
    row.appendChild(btn);
    return row;
}

/**
 * 画（或收起）副页仪表盘。**幂等**：每次重画整块 innerHTML，没有状态。
 *
 * @param {string} [pageId] - 画哪一页（默认当前页）；`'main'` ⇒ 收起
 * @returns {HTMLElement|null} 那个槽位（找不到槽位时 `null`）
 */
export function renderPageDashboard(pageId = AppState.currentPageId) {
    const host = document.getElementById(PAGE_DASHBOARD_ID);
    if (!host) return null;
    const page = (pageId && pageId !== 'main') ? (AppState.pages || {})[pageId] : null;
    if (!page) {
        host.style.display = 'none';
        host.innerHTML = '';
        return host;
    }

    const stats = getVirtualGlobalStats(AppState, page);
    const nodeCount = Object.keys(page.virtualIndex || {}).length - 1;   // 不含页根
    const blocked = blockedRowsOf(page);

    host.style.display = '';
    host.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:600;color:#334155;">📄 ${escapeHtml(page.name)}</span>
            <span style="font-size:12px;color:#475569;">${escapeHtml(stats.cStr)} · ${escapeHtml(stats.pStr)}
                · 节点 ${nodeCount}${blocked.length ? ` · 🚫 ${blocked.length}` : ''}</span>
            <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap;">
                <button class="btn page-sync-btn" data-page-id="${escapeHtml(page.id)}"
                    title="把这一页里已有的每一支补成主树现在的样子（只加不删、同级顺序也跟主树；屏蔽的支不往下补）">🔄 与主树对齐</button>
                <button class="btn page-copy-btn" data-page-id="${escapeHtml(page.id)}"
                    title="复制这个副页（按住 Ctrl 点 = 先给新页起名）">⧉ 复制副页</button>
                <button class="btn page-rename-btn" data-page-id="${escapeHtml(page.id)}"
                    title="改这一页的名字">✎ 重命名</button>
                <button class="btn page-del-btn" data-page-id="${escapeHtml(page.id)}"
                    title="按住 Ctrl 点才能删">✖ 删除副页</button>
            </span>
        </div>
        ${blocked.length ? `<div style="margin-top:6px;border:1px solid #eef2f6;border-radius:6px;
                padding:6px 8px;background:#fcfdff;">
            <button class="btn page-blocked-toggle" style="${BTN}">${blockedOpen ? '▾' : '▸'} 🚫 已屏蔽 ${blocked.length} 处</button>
            <span style="${HINT}">（对齐走到这里就停；这一支已有的内容不增不减；统计里也不算它们）</span>
            <div id="page-blocked-rows"></div></div>` : ''}
        <label style="display:flex;gap:5px;align-items:center;font-size:12px;color:#334155;margin-top:4px;">
            <input type="checkbox" class="page-hide-blocked" ${page.hideBlocked ? 'checked' : ''}>
            <span>不显示屏蔽的部分（勾上后屏蔽的那几支不画；统计里本来就不算它们）</span>
        </label>
        <div style="${HINT};margin-top:4px;">
            「与主树对齐」= 把这一页里已有的每一支补成主树现在的样子：只加不删、
            <b>同级顺序也按主树排</b>（主树里已经没有的那些留在末尾）—— 你手删过的后代「会回来」
            （页里没有的那几支则永远不进来）。
        </div>`;

    // 清单是**默认折叠**的（几十条会顶掉别的东西）⇒ 行只在折开时才建；
    // 行用 DOM 拼（`nodeEntryLine` 是真元素），所以放在 innerHTML 之后 append。
    const rowsHost = host.querySelector('#page-blocked-rows');
    if (rowsHost) {
        // ⚠️ **每条独占一行**（用户 2026-10-15："记得换行"）：容器是 `flex-direction:column`
        //    （不是 `flex-wrap:wrap` —— wrap 会让短卡片并排挤在一行里，就是那一轮被指出来的那个）；
        //    ⚠️ 这里**不给 `align-items:flex-start`** —— 那会让卡片按内容收窄，
        //    卡内的 `margin-left:auto` 就无处可施（操作贴不到右端点）。默认 `stretch` 才是要的。
        rowsHost.style.cssText = 'margin-top:4px;display:flex;flex-direction:column;gap:4px;';
    }
    if (rowsHost && blockedOpen) {
        // 分页（用户 2026-10-15："分页，默认 10"）：形状照现成的
        // `view/builders.js:buildPaginationHtml`（◀ `1 / 3` ▶ + `(1~10 / 26)`），别自创观感。
        const pageCount = Math.max(1, Math.ceil(blocked.length / BLOCKED_PAGE_SIZE));
        const pageNo = Math.min(Math.max(blockedPage, 1), pageCount);     // ⚠️ 别把 `page`（页对象）盖掉
        blockedPage = pageNo;
        const start = (pageNo - 1) * BLOCKED_PAGE_SIZE;
        const slice = blocked.slice(start, start + BLOCKED_PAGE_SIZE);
        for (const b of slice) rowsHost.appendChild(buildBlockedRow(page, b));
        if (blocked.length > BLOCKED_PAGE_SIZE) {
            const pager = document.createElement('div');
            pager.className = 'pagination page-blocked-pager';
            pager.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 2px;font-size:12px;color:#475569;';
            const mkBtn = (cls, label, disabled, delta) => {
                const btn = document.createElement('button');
                btn.className = `pagination-btn ${cls}`;
                btn.dataset.delta = String(delta);
                btn.disabled = !!disabled;
                btn.style.cssText = 'padding:2px 8px;border:1px solid #d1d5db;border-radius:4px;'
                    + `background:transparent;cursor:pointer;${disabled ? 'opacity:0.3;cursor:not-allowed;' : ''}`;
                btn.textContent = label;
                return btn;
            };
            pager.appendChild(mkBtn('page-blocked-prev', '◀', pageNo <= 1, -1));
            const at = document.createElement('span');
            at.textContent = `${pageNo} / ${pageCount}`;
            pager.appendChild(at);
            pager.appendChild(mkBtn('page-blocked-next', '▶', pageNo >= pageCount, 1));
            const range = document.createElement('span');
            range.style.cssText = 'color:#94a3b8;font-size:11px;';
            range.textContent = `(${start + 1}~${start + slice.length} / ${blocked.length})`;
            pager.appendChild(range);
            rowsHost.appendChild(pager);
        }
    }
    return host;
}
