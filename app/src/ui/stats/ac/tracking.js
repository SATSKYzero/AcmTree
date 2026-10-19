// ================================================================
// AC 追踪列表（ui/stats/ac/tracking.js）
//
// 职责：收集 AC 节点 + 那一页的分页列表。
// ================================================================
import { acTrackingCurrentPage, getACTrackingPageSize, setACTrackingCachedNodes, setACTrackingCurrentPage } from './state.js';
import { isPassed } from '../../../core/model/status.js';
import { AppState } from '../../../shell/state.js';
import { filterByMode } from '../../../view/filterMode.js';
import { renderNode } from '../../../view/index.js';
// ★「节点行」上的 🔎 / 📋 / 面包屑复用现成那三份（`ui/kit/nodeEntry.js`）——
//   本列表是 `readonly`（不画按钮）且不在 `#tree-container` 里 ⇒ 不补就点不动（G1）
import { appendNodeEntries } from '../../kit/nodeEntry.js';
// ★「合并显示」：判重模式下 ① 状态读「组那份」（同组有一个副本过了就算过）；
//   ② 列表**每组只留一条代表**（同一道题的多个来源副本不该在"共 N 条"里各算一次）。
// ⚠️ 但 **`acTime` 一律读「靠前那份」（本份）** —— 这个列表答的是"**我**什么时候过的"，
//    不是"这道题什么时候被过"（用户 2026-10-12 拍板：规则保留现状）。
//    ⇒ 本文件与 `heatmap.js` / `dailyList.js` 读底层口是**故意的**，见 `src/core/AGENTS.md`
//      的「显示列（plain / dedup）」一节（名单 `DIRECT_READ_OK` 里标着理由）。
import { viewDerived, viewDerivedDisplay } from '../../../view/scope.js';
import { dedupRepresentatives } from '../../../core/query/countMode.js';

//: AC 列表的**一次收集**缓存（2026-10-18）：`collectACNodes` 要**走一遍全树**（真包 27k 节点、4719 条 AC
//: 实测 **18ms**），而它同时被热力图与 AC 追溯列表读 —— 同一份数据切来切去不该重算。
//: 键 = 数据代（`nodes` / `childOrder`）+ 显示口径（`accounts` / `trust` / 计数模式 / 两个身份指针）。
//: ⚠️ 判重模式下"算不算过"读的是**组那份** ⇒ 计数模式与 trust 必须进键，否则会给陈旧结果。
const acNodesMemo = { nodes: null, childOrder: null, accounts: null, trust: null, mode: null, va: null, ca: null, out: null };

export function collectACNodes(state) {
    const mode = (state.settings && state.settings.stats && state.settings.stats.countMode) || '';
    const hit = acNodesMemo;
    if (hit.out && hit.nodes === state.nodes && hit.childOrder === state.childOrder
        && hit.accounts === state.accounts && hit.trust === state.trust
        && hit.mode === mode
        && hit.va === state.viewingAccountId && hit.ca === state.currentAccountId) {
        return hit.out;
    }
    const out = collectACNodesRaw(state);
    acNodesMemo.nodes = state.nodes;
    acNodesMemo.childOrder = state.childOrder;
    acNodesMemo.accounts = state.accounts;
    acNodesMemo.trust = state.trust;
    acNodesMemo.mode = mode;
    acNodesMemo.va = state.viewingAccountId;
    acNodesMemo.ca = state.currentAccountId;
    acNodesMemo.out = out;
    return out;
}

function collectACNodesRaw(state) {
    const result = [];
    if (!state.rootId) return result;

    (function walk(id) {
        const n = state.nodes[id];
        if (!n) return;
        if (n.type === 'P') {
            // status2 按**当前查看范围**算（"我的补题情况"）
            // "算不算过题"统一问 `isPassed`，别在这里裸比较 3/4
            // ★ 走**显示口径**（判重 ⇒ 组那份；不去重 ⇒ 原样返回）
            if (isPassed(viewDerivedDisplay(state, n, 'status2'))) result.push(n);
        }
        for (const cid of state.childOrder[id]) {
            walk(cid);
        }
    })(state.rootId);

    return result;
}

// ================================================================
// 按筛选模式过滤
// ================================================================
// 判据在 `view/filterMode.js`（**唯一一份**，统计图 / 热力图 / 比赛概览共用）。
// 自己写一份容易分叉：模式认不出时会把**所有题都滤掉**（另两处是原样返回）——
// 同一规则抄三份就会出现这种分歧。

// ================================================================
// 分页大小
// ================================================================

export function renderACTracking() {
    const container = document.getElementById('ac-tracking-list');
    if (!container) return;

    const state = AppState;
    let nodes = collectACNodes(state);
    nodes.sort((a, b) => {
        const timeA = viewDerived(state, a, 'acTime') || '----.--.-- --:--';
        const timeB = viewDerived(state, b, 'acTime') || '----.--.-- --:--';
        return timeB.localeCompare(timeA);
    });

    nodes = filterByMode(state, nodes);
    // ★ 判重模式下**每组只留一条**（"共 N 条"= 不同的题；代表优先挑有 `acTime` 的那条）
    nodes = dedupRepresentatives(state, nodes, {
        hasValue: (n) => {
            const t = viewDerived(state, n, 'acTime');
            return !!t && t !== '----.--.-- --:--';
        }
    });

    if (nodes.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:48px 20px; text-align:center; color:#94a3b8;">
                <div style="font-size:48px; margin-bottom:12px; opacity:0.5;">🔍</div>
                <p>当前筛选条件下没有AC题目</p>
            </div>
        `;
        return;
    }

    setACTrackingCachedNodes(nodes);

    const total = nodes.length;
    const pageSize = getACTrackingPageSize();
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    let currentPage = acTrackingCurrentPage;
    if (currentPage < 1) currentPage = 1;
    if (currentPage > pageCount) currentPage = pageCount;
    setACTrackingCurrentPage(currentPage);

    const start = (currentPage - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const pageNodes = nodes.slice(start, end);

    const totalEl = document.getElementById('ac-total-count');
    if (totalEl) totalEl.textContent = `共 ${total} 条`;

    const pageInfoEl = document.getElementById('ac-page-info');
    if (pageInfoEl) pageInfoEl.textContent = `${pageCount > 0 ? currentPage : 0} / ${pageCount}`;

    const prevBtn = document.getElementById('ac-prev');
    const nextBtn = document.getElementById('ac-next');
    if (prevBtn) prevBtn.disabled = currentPage <= 1;
    if (nextBtn) nextBtn.disabled = currentPage >= pageCount;

    let html = '';
    for (let i = 0; i < pageNodes.length; i++) {
        const node = pageNodes[i];
        html += renderNode(state, node, i, [], null, true, 'readonly');
    }
    container.innerHTML = html;

    // ★ 每一行补上「🔎 跳到树上 / 📋 打开详页 / 面包屑」（G1）—— 理由与做法同
    //   `ui/stats/ac/listView.js` 那一处（`readonly` 不画按钮、也不在树的委托范围内）。
    //   ⚠️ 入口条复用现成那三份，别在这里另写一套（`docs/node-navigation.md` 第 5 节）。
    //   `#ac-tracking-list` 里就是这些方框（没有夹一层列表 div）⇒ 不传 `rowSelector`，
    //   直接在容器里找。
    appendNodeEntries(container, state);
}

// ================================================================
// 训练强度热力图
// ================================================================
