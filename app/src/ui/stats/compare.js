// ================================================================
// 账户对比视图（ui/stats/compare.js）
//
// 放在「📊 数据统计」页的子页签里（与「训练强度追踪 / 最近AC题目列表」并列）。
// 数据全部来自 `core/query/compare.js` 的纯函数；这里只负责画表格与交互。
//
// 看到的层次：
//   ① 首屏 = 比赛 × 账户 的**完成状态**（"哪场谁还没补完"）
//   ② 展开一场 = 题目 × 账户 的**状态2**（"哪道题谁没过"）
//   ③ 顶部汇总 = 每人"通过 / 处理"合计
//
// ⚠️ 这里**只读**：点格子只是打开那道题的编辑弹窗（不切换全局"在查看"，避免副作用）。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import { buildCompareMatrix, rowMatches } from '../../core/query/compare.js';
import { listActiveAccountIds, accountName } from '../../core/ops/account.js';
import { STATUS2_COLORS, STATUS2_LABELS, STATUS2_ICONS } from '../../A_constants.js';
import { escapeHtml, displayTime } from '../../utils/A_helpers.js';
import { showToast } from '../G_modal/G_modals.js';

// ---- 视图状态（会话级：刷新后回到默认，不进存档） ----
let compareAccounts = null;      // string[] | null（null = 用默认：登录账户 + 它的子账户）
let compareOnly = 'diff';        // 'diff'（默认：有人过、有人没过）| 'undone' | '' | 账户 id
let compareSearch = '';
const expanded = new Set();      // 展开的比赛 id

const MAX_COLUMNS = 6;

/** 状态的短标记：图标表住在 `A_constants.js`（与 `STATUS2_LABELS` 同序，加档一起长） */
/** 容器完成状态的短文案（0 未动 / 1 有接触 / 2 全部处理 / 3 AK / 4 忽略） */
const CONTAINER_TEXT = ['未动', '有接触', '已处理', 'AK', '忽略'];
const CONTAINER_COLORS = { 0: '#f8fafc', 1: '#bfdbfe', 2: '#d1fae5', 3: '#00db00', 4: '#e5e7eb' };

function statusCellHtml(v) {
    const s = (v === undefined) ? 0 : Number(v);
    const bg = STATUS2_COLORS[s] || '#ffffff';
    const icon = STATUS2_ICONS[s] || '';
    const label = STATUS2_LABELS[s] || String(v);
    return `<td style="background:${bg}; text-align:center; white-space:nowrap;"
        title="${escapeHtml(label)}"><span style="font-size:13px;">${icon}</span></td>`;
}

function containerCellHtml(v) {
    const s = (v === undefined) ? 0 : Number(v);
    const bg = CONTAINER_COLORS[s] || '#ffffff';
    const text = CONTAINER_TEXT[s] || String(v);
    return `<td style="background:${bg}; text-align:center; white-space:nowrap;">${escapeHtml(text)}</td>`;
}

/**
 * 默认对比对象：**登录账户 + 它的直接子账户**（"一队 3 人"在数据上就是这种父子关系），
 * 不够就补上其余活跃账户，最多 6 列。
 */
function defaultAccounts(state) {
    const current = state.currentAccountId || 'local';
    const kids = (state.accounts[current] && Array.isArray(state.accounts[current].children))
        ? state.accounts[current].children : [];
    const out = [];
    for (const id of [current, ...kids, ...listActiveAccountIds(state)]) {
        if (!id || out.includes(id)) continue;
        const acc = state.accounts[id];
        if (!acc || acc.active === false) continue;
        out.push(id);
        if (out.length >= MAX_COLUMNS) break;
    }
    return out;
}

/** 当前要对比的账户（用户勾选优先，否则默认） */
function currentAccounts(state) {
    const wanted = Array.isArray(compareAccounts) && compareAccounts.length
        ? compareAccounts : defaultAccounts(state);
    return wanted;
}

// ================================================================
// 渲染
// ================================================================
export function renderAccountCompare(host) {
    if (!host) return;
    const state = AppState;

    const ids = currentAccounts(state);
    const matrix = buildCompareMatrix(state, { accounts: ids });

    if (matrix.accounts.length === 0) {
        host.innerHTML = `<div class="empty-state" style="padding:40px 20px; text-align:center; color:#94a3b8;">
            <div style="font-size:40px; margin-bottom:12px; opacity:.5;">👥</div>
            <div>还没有可对比的账户</div>
            <div style="font-size:13px; margin-top:8px;">先在顶栏 <strong>👤</strong> 里建两个账户，再回来这里勾选。</div>
        </div>`;
        return;
    }

    const cols = matrix.accounts.map(a => a.id);

    // ---- 顶部控制条 ----
    const allActive = listActiveAccountIds(state);
    const accountToggles = allActive.map(id => {
        const on = cols.includes(id);
        const dropped = matrix.dropped.includes(id);
        return `<label style="display:inline-flex; align-items:center; gap:4px; font-size:13px;
            padding:2px 8px; border:1px solid ${on ? '#93c5fd' : '#d1d5db'}; border-radius:999px;
            background:${on ? '#eff6ff' : '#fff'}; cursor:pointer;"
            title="${dropped ? '超出一行能放下的人数了（最多 ' + MAX_COLUMNS + ' 个）' : ''}">
            <input type="checkbox" class="compare-account-toggle" data-account="${escapeHtml(id)}" ${on ? 'checked' : ''}>
            ${escapeHtml(accountName(state, id) || id)}${dropped ? '（超上限）' : ''}
        </label>`;
    }).join('');

    const onlyOptions = [
        ['diff', '只看差异（有人过、有人没过）'],
        ['undone', '只看有人没过的'],
        ['', '全部']
    ].map(([v, label]) =>
        `<option value="${v}" ${compareOnly === v ? 'selected' : ''}>${label}</option>`).join('')
        + matrix.accounts.map(a =>
            `<option value="${escapeHtml(a.id)}" ${compareOnly === a.id ? 'selected' : ''}>只看「${escapeHtml(a.name)}」没过的</option>`
        ).join('');

    const summaryChips = matrix.accounts.map(a => {
        const s = matrix.summary[a.id] || { total: 0, passed: 0 };
        return `<span style="font-size:12px; color:#475569; padding:2px 8px; background:#f1f5f9; border-radius:999px;">
            ${escapeHtml(a.name)}：通过 <strong>${s.passed}</strong>/${s.total}</span>`;
    }).join(' ');

    host.innerHTML = `
        <div style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin-bottom:10px;">
            <span style="font-size:13px; color:#64748b;">👥 对比谁</span>
            ${accountToggles}
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin-bottom:10px;">
            <select id="compare-only" class="btn" style="padding:4px 8px; font-size:13px;">${onlyOptions}</select>
            <input id="compare-search" type="text" placeholder="搜题号 / 名称 / 比赛"
                value="${escapeHtml(compareSearch)}"
                style="padding:4px 8px; border:1px solid #d1d5db; border-radius:6px; font-size:13px; width:200px;">
            <span style="flex:1;"></span>
            ${summaryChips}
        </div>
        <div id="compare-table-host"></div>
    `;

    renderTable(host.querySelector('#compare-table-host'), state, matrix, cols);
    bindEvents(host);
}

function renderTable(host, state, matrix, cols) {
    const rows = [];
    for (const g of matrix.groups) {
        const problems = g.problems.filter(p => rowMatches(p, { accounts: cols, only: compareOnly, search: compareSearch }));
        const groupShown = rowMatches(g, { accounts: cols, only: compareOnly, search: compareSearch })
            || problems.length > 0;
        if (!groupShown) continue;
        const isOpen = expanded.has(g.id);
        rows.push({
            kind: 'group', group: g, problems, open: isOpen
        });
    }

    if (rows.length === 0) {
        host.innerHTML = `<div style="padding:24px; text-align:center; color:#94a3b8; font-size:13px;">
            当前筛选下没有要比的题目（试试把筛选改成「全部」）</div>`;
        return;
    }

    let html = '<table style="width:100%; border-collapse:collapse; font-size:13px;">';
    html += '<thead><tr>'
        + '<th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">比赛 / 题目</th>'
        + matrix.accounts.map(a => `<th style="text-align:center; padding:6px 8px; border-bottom:1px solid #e2e8f0; white-space:nowrap;">
            ${escapeHtml(a.name)}<div style="font-weight:400; font-size:11px; color:#94a3b8;">${escapeHtml(a.id)}</div></th>`).join('')
        + '</tr></thead><tbody>';

    for (const r of rows) {
        const g = r.group;
        const caret = r.open ? '▾' : '▸';
        const time = g.contestTime
            ? `<span style="color:#94a3b8; font-size:12px;"> · ${escapeHtml(displayTime(g.contestTime))}</span>`
            : '';
        html += `<tr class="compare-group" data-group="${escapeHtml(g.id)}" style="cursor:pointer; background:#f8fafc;">
            <td style="text-align:left; padding:6px 8px; border-bottom:1px solid #eef2f6;">
                <span style="color:#64748b;">${caret}</span>
                <strong>${escapeHtml(g.name || g.id)}</strong>${time}
                <span style="color:#94a3b8; font-size:12px;">（${g.problems.length} 题）</span>
            </td>
            ${cols.map(id => containerCellHtml(g.cells[id])).join('')}
        </tr>`;

        if (!r.open) continue;
        for (const p of r.problems) {
            html += `<tr class="compare-problem" data-problem="${escapeHtml(p.id)}" style="cursor:pointer;">
                <td style="text-align:left; padding:4px 8px 4px 26px; border-bottom:1px solid #f8fafc;">
                    <span style="color:#64748b;">${escapeHtml(p.problemId || '')}</span>
                    ${escapeHtml(p.name || '')}
                </td>
                ${cols.map(id => statusCellHtml(p.cells[id])).join('')}
            </tr>`;
        }
        if (r.open && r.problems.length === 0) {
            html += `<tr><td colspan="${cols.length + 1}" style="padding:6px 26px; color:#94a3b8; font-size:12px;">
                这场比赛在当前筛选下没有题目</td></tr>`;
        }
    }

    html += '</tbody></table>';
    host.innerHTML = html;

    // 点行：组头 = 展开/收起；题目行 = 打开那道题的编辑弹窗
    host.querySelectorAll('.compare-group').forEach(tr => {
        tr.addEventListener('click', () => {
            const id = tr.dataset.group;
            if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
            // ⚠️ **只重画表格**，不许调 `renderAccountCompare`（面板渲染器）：
            //    这里的 `host` 是 `#compare-table-host`（表格那一格），不是整个面板
            //    ⇒ 那样写会把整条控制条（"👥 对比谁" + 筛选 + 汇总）**再画进表格格子里**，
            //    于是顶部就多出一份；再点一次又在里面多一份（用户 2026-10-13 报的
            //    "每点击一次折叠就多一个"）。展开态不影响矩阵与汇总 ⇒ 用同一份 matrix 重画即可。
            renderTable(host, state, matrix, cols);
        });
    });
    host.querySelectorAll('.compare-problem').forEach(tr => {
        tr.addEventListener('click', async () => {
            const id = tr.dataset.problem;
            if (!id || !AppState.nodes[id]) return;
            try {
                const { editNode } = await import('../G_modal/G4_edit.js');
                editNode(id);
            } catch (err) {
                showToast('打不开编辑面板：' + (err && err.message ? err.message : err), 'error');
            }
        });
    });
}

function bindEvents(host) {
    host.querySelectorAll('.compare-account-toggle').forEach(box => {
        box.addEventListener('change', () => {
            const id = box.dataset.account;
            const set = new Set(currentAccounts(AppState));
            if (box.checked) set.add(id); else set.delete(id);
            const list = [...set];
            if (list.length === 0) {
                showToast('至少要留一个账户来对比', 'error');
                renderAccountCompare(host);
                return;
            }
            compareAccounts = list;
            renderAccountCompare(host);
        });
    });
    const only = host.querySelector('#compare-only');
    if (only) {
        only.addEventListener('change', () => {
            compareOnly = only.value;
            renderAccountCompare(host);
        });
    }
    const search = host.querySelector('#compare-search');
    if (search) {
        search.addEventListener('input', () => {
            compareSearch = search.value;
            // 只重画表格，避免输入框失焦
            const state = AppState;
            const matrix = buildCompareMatrix(state, { accounts: currentAccounts(state) });
            const tableHost = host.querySelector('#compare-table-host');
            if (tableHost) renderTable(tableHost, state, matrix, matrix.accounts.map(a => a.id));
        });
    }
}

// ================================================================
// 两个入口（同一份渲染，只是容器不同）
//   ① 数据统计页的「👥 账户对比」子页签 → `renderAccountCompareTab()`
//   ② 文件夹面板的「👥 账户对比」栏（内置视图，与「📊 题目分布统计」同级）
//      → `ui/folder/folderMode.js` 的 `mountCompareView(ctx)`
// ================================================================

/** 供数据统计页调用：数据变化且**正停在这个子页签**时刷新一次（与"训练强度追踪"一致） */
export function setupCompareView() {
    document.addEventListener('acmtree:db-modified', () => {
        const host = document.getElementById('subtab-data-compare');
        if (host && host.style.display !== 'none') renderAccountCompare(host);
    });
}

/** 数据统计页的「👥 账户对比」子页签被切到时调它 */
export function renderAccountCompareTab() {
    renderAccountCompare(document.getElementById('subtab-data-compare'));
}

