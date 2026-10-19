// ================================================================
// 账户管理界面（ui/G_modal/G8_accounts.js）
//
// 依据：账户维度与手改留痕
//
// 界面上只有两个概念，别的都别叫：
//   - **登录账户**（`currentAccountId`）：手改的值以谁的名义记（来源层 `account`）
//   - **在查看**（`viewingAccountId`）：投影/筛选用谁的眼睛
// 两者不同 ⇒ **只读**：手改全禁，导入不禁。
//
// 「不猜」在界面上的体现：映射表是**用户自己填的数据**（源:字段:值 →
// 账户），应用不认识任何平台字段。填重了（两个账户认领同一线索）会提示，
// 但**不自动改** —— 导入时那一批会被报成"线索没匹配上"，等着人来定。
//
// ⚠️ 两种形态，**同一份视图**（`mountAccountsView`）：
//      · **设置页**（常规入口：工具栏 👤 标记跳过去，与「🔑 名册/凭据」同栏）；
//      · **弹窗**（`showAccountsModal`，只留给"流程中途"的快捷入口 ——
//        导入摘要说"有线索认不出"，那时正开着导入弹窗）。
//
// 依赖：shell/state.js, shell/executor.js, core/ops/account.js,
//       G1_core.js, G1_toast.js, G2_common.js, utils/A_helpers.js
// 说明：本模块 import shell/，不进 Node 单测，由冒烟测试覆盖。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute } from '../../shell/executor.js';
import {
    LOCAL_ACCOUNT_ID,
    listAccountIds,
    accountName,
    childrenOf,
    parentsOf,
    candidateChildren,
    isAccountActive,
    isViewOnly,
    moveAccount,
    createAccount,
    saveAccount,
    removeAccount,
    setCurrentAccount,
    setViewingAccount,
    setAccountActive,
    findMappingConflicts
} from '../../core/ops/account.js';
import { escapeHtml } from '../../utils/html.js';
// 悬停提示也是给人看的字 ⇒ 统一去 Markdown 记号（实现只有一份）
import { plain } from '../../utils/text.js';
import {
    reattributeValues, describeReattribute, collectUnmatchedClues, clueText,
    purgeValuesByClue, describePurge
} from '../../core/ops/reattribute.js';
import { createModal } from './G1_core.js';
import { showToast } from './G1_toast.js';
import { showDeleteConfirm, showConfirmDialog } from './G2_common.js';
import { mappingWarnings } from '../../core/rosterMappings.js';

/** 性质标签的常用候选（自由文本，这几个只是省打字） */
const NATURE_PRESETS = [
    '本人唯一账号',
    '本人小号',
    '我的账户组',
    '队伍账号',
    '队伍集合'
];

const CARD_BORDER = '1px solid #e2e8f0';
const TITLE_STYLE = 'font-size:12px;font-weight:600;color:#334155;margin:10px 0 4px;';
const INPUT_STYLE = 'padding:4px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;';
// 「以它登录」/「查看它」的高亮与灰显（常驻 + 高亮，别让按钮跳位）
const BTN_LOGIN_ON = 'background:#2563eb;border-color:#2563eb;color:#fff;font-weight:600;';
const BTN_VIEW_ON = 'background:#dbeafe;border-color:#2563eb;color:#1d4ed8;font-weight:600;';
const BTN_DIM = 'opacity:.45;';

/** 账户列表现在停在哪一页（`'on'` 活跃 / `'off'` 已停用）。模块级 ⇒ 面板重画不丢 */
let listPage = 'on';

/** 切页（给自测/排错用） */
export function currentAccountsPage() { return listPage; }

/** 小按钮 */
function miniBtn(label, act, id, extra = '') {
    return `<button class="btn acc-act" data-act="${act}" data-id="${escapeHtml(id)}"
        style="padding:2px 8px;font-size:11px;${extra}">${label}</button>`;
}

/**
 * 「以它登录」/「查看它」那两个按钮（用**高亮**表示状态，以防排版跳来跳去）。
 *
 * 为什么不写成"不是当前才画"：那样点一下就**少一个按钮**，整行按钮跟着跳位 ——
 * 现在**两个按钮永远在**，当前那个只是**高亮 + 禁用**（点它本来就是空操作）。
 * 「停用的账户不能当登录/查看」这条语义靠 `disabled + title` 表达，行高与按钮位置不变。
 *
 * @param {Object} state
 * @param {string} id
 * @param {boolean} active - 停用的账户两个按钮都灰着（点不动，并说明原因）
 */
function identityButtons(state, id, active) {
    const isCurrent = id === state.currentAccountId;
    const isViewing = id === state.viewingAccountId;
    const one = (act, text, on, onTitle, onStyle) => {
        const dis = (on || !active) ? ' disabled' : '';
        const style = on ? onStyle : (active ? '' : BTN_DIM);
        const title = on
            ? ` title="${onTitle}"`
            : (active ? '' : ' title="账户已停用 —— 先启用它才能当登录/查看"');
        return `<button class="btn acc-act" data-act="${act}" data-id="${escapeHtml(id)}"${dis}${title}`
            + ` style="padding:2px 8px;font-size:11px;${style}">${text}</button>`;
    };
    return one('login', isCurrent ? '✅ 以它登录' : '以它登录', isCurrent,
        '这就是当前登录账户', BTN_LOGIN_ON)
        + one('view', isViewing ? '👁 查看它' : '查看它', isViewing,
            '这就是当前在查看的账户', BTN_VIEW_ON);
}

// ================================================================
// 顶栏上的那一小块：现在是谁（点开管理界面）
// ================================================================

/**
 * 刷新顶栏账户标记。
 *
 * 为什么要有它：`viewing ≠ current` 会**静默地**把整个应用变成只读 ——
 * 没有这个显式标记，用户只会觉得"怎么改都改不动"。
 */
export function renderAccountChip() {
    const el = document.getElementById('account-chip');
    if (!el) return;
    const cur = AppState.currentAccountId;
    const view = AppState.viewingAccountId;
    const viewOnly = isViewOnly(AppState);

    let text = `👤 ${accountName(AppState, cur)}`;
    if (viewOnly) text += ` ｜ 👁 ${accountName(AppState, view)}（只读）`;
    el.textContent = text;
    el.style.color = viewOnly ? '#b91c1c' : '#334155';
    // ⚠️ 账户名是**数据**（可能带 Markdown 记号）⇒ 悬停提示过 `plain`（去记号，不改字）
    el.title = plain(`登录账户：${accountName(AppState, cur)}\n在查看：${accountName(AppState, view)}`
        + (viewOnly ? '\n只读中：手改已禁用（导入不受影响）' : '')
        + '\n点击管理账户');
}

// ================================================================
// 主界面
// ================================================================

/** 单个账户卡片 */
function accountCard(state, id) {
    const acc = state.accounts[id] || {};
    const active = isAccountActive(state, id);
    const isCurrent = id === state.currentAccountId;
    const isViewing = id === state.viewingAccountId;
    const kids = childrenOf(state, id).map(c => accountName(state, c));
    const pars = parentsOf(state, id).map(p => accountName(state, p));
    const maps = Array.isArray(acc.mappings) ? acc.mappings : [];

    const tags = [];
    if (acc.isLocal) tags.push('<span style="font-size:11px;color:#7c3aed;background:#f5f3ff;border-radius:4px;padding:1px 5px;">默认</span>');
    if (acc.nature) tags.push(`<span style="font-size:11px;color:#0369a1;background:#f0f9ff;border-radius:4px;padding:1px 5px;">${escapeHtml(acc.nature)}</span>`);
    if (!active) tags.push('<span style="font-size:11px;color:#b91c1c;background:#fef2f2;border-radius:4px;padding:1px 5px;">🚫 已停用</span>');
    if (isCurrent) tags.push('<span style="font-size:11px;color:#15803d;font-weight:600;">✅ 登录中</span>');
    if (isViewing) tags.push('<span style="font-size:11px;color:#2563eb;font-weight:600;">👁 查看中</span>');
    if (isCurrent && isViewing) tags.push('<span style="font-size:11px;color:#94a3b8;">（同一个人）</span>');

    return `
        <div class="acc-card" style="border:${CARD_BORDER};border-radius:8px;padding:8px 10px;margin-bottom:8px;background:${isCurrent ? '#f8fafc' : '#fff'};${active ? '' : 'opacity:.72;'}">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <b style="font-size:13px;">${escapeHtml(acc.name || id)}</b>
                <span style="font-size:11px;color:#94a3b8;">#${escapeHtml(String(id).slice(-4))}</span>
                ${tags.join(' ')}
            </div>
            <div style="font-size:11px;color:#64748b;margin-top:3px;line-height:1.6;">
                ${kids.length ? `子账户：${escapeHtml(kids.join('、'))}<br>` : ''}
                ${pars.length ? `挂在：${escapeHtml(pars.join('、'))}<br>` : ''}
                映射：${maps.length
                    ? escapeHtml(maps.map(m => `${m.source}:${m.field}=${m.value}`).join('，'))
                    : '<span style="color:#b45309;">还没填（该账户的数据认不出来）</span>'}
            </div>
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
                ${identityButtons(state, id, active)}
                ${miniBtn('✏️ 编辑', 'edit', id)}
                ${id === LOCAL_ACCOUNT_ID
                    ? '<button class="btn" disabled style="padding:2px 8px;font-size:11px;opacity:.5;">默认账户不可删</button>'
                    : miniBtn(active ? '🚫 停用' : '↩️ 启用', active ? 'off' : 'on', id,
                        active ? '' : 'color:#15803d;')}
                ${id === LOCAL_ACCOUNT_ID
                    ? ''
                    : miniBtn('🗑 删除', 'del', id, 'color:#dc2626;')}
                ${orderButtons(state, id)}
            </div>
        </div>
    `;
}

/**
 * 顺序箭头（账户允许交换顺序）。
 *
 * ⚠️ 默认账户「本机」没有箭头（它恒第一，见 `listAccountIds`）；
 * 到头/到尾的那个箭头**画成灰的**（不是不画）—— 与上面那对按钮同一个理由：**别跳位**。
 */
function orderButtons(state, id) {
    if (id === LOCAL_ACCOUNT_ID) return '';
    const ids = listAccountIds(state);
    const i = ids.indexOf(id);
    const arrow = (act, label, disabled) =>
        `<button class="btn acc-act" data-act="${act}" data-id="${escapeHtml(id)}"${disabled ? ' disabled' : ''}`
        + ` title="${disabled ? '已经在头/尾了' : '和上/下一个账户交换位置'}"`
        + ` style="padding:2px 6px;font-size:11px;${disabled ? BTN_DIM : ''}">${label}</button>`;
    return arrow('up', '↑', i <= 1) + arrow('down', '↓', i < 0 || i >= ids.length - 1);
}

// ================================================================
// 「未认领的线索」
//
// 起因：导入摘要只说"2183 条线索没匹配上"，**不说是哪条**。
// 这里把所有认不出的线索按"源:字段=值"列出来（带条数），点一下就能补映射。
// ================================================================

/**
 * 未认领线索那一段的 HTML。
 *
 * @param {Object} state
 * @param {number} [top] 最多列几种
 */
function unmatchedSection(state, top = 12) {
    // 只扫一遍（这个函数会遍历全部值，别在模板里调多次）
    const all = collectUnmatchedClues(state, { top: 0 });
    const { total, kinds } = all;
    if (!total) {
        return `
            <div style="${TITLE_STYLE}">未认领的线索</div>
            <div style="font-size:12px;color:#15803d;padding:6px 10px;border-radius:6px;background:#f0fdf4;">
                ✅ 没有认不出的线索（带线索的值都能对上账户映射）。
            </div>
        `;
    }
    const rows = kinds.slice(0, top).map(k => {
        const txt = clueText(k);
        const badge = k.conflict
            ? `<span style="color:#b45309;">被 ${escapeHtml(k.accounts.join('、'))} 同时认领</span>`
            : `<button class="btn acc-act" data-act="map" data-id=""
                    data-source="${escapeHtml(k.source)}" data-field="${escapeHtml(k.field)}"
                    data-value="${escapeHtml(k.value)}"
                    style="padding:1px 8px;font-size:11px;">＋ 补映射</button>`
              // 清值：这条线索是**无主**的（认不出账户）⇒ 允许把它写下的那些值删掉。
              // 为什么要它：适配器写错过线索（杭电各年全写成同一个值），修好再导入只会**再叠一组**
              // （合并键里线索算身份）⇒ 每格两条一样的值，而这里永远挂着那几行。
              + ` <button class="btn acc-act" data-act="purge" data-id=""
                    data-source="${escapeHtml(k.source)}" data-field="${escapeHtml(k.field)}"
                    data-value="${escapeHtml(k.value)}"
                    title="删掉这条线索写下的那些值（只删认不出账户的）"
                    style="padding:1px 8px;font-size:11px;color:#b91c1c;">🗑 清值</button>`;
        const ex = k.examples.length ? `<div style="color:#94a3b8;">例：${escapeHtml(k.examples.join('；'))}</div>` : '';
        return `
            <div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px dashed #e2e8f0;font-size:12px;">
                <span style="color:#0f172a;font-weight:600;min-width:56px;">${k.count} 条</span>
                <span style="flex:1;line-height:1.5;">
                    <code>${escapeHtml(txt)}</code><br>${badge}${ex}
                </span>
            </div>
        `;
    }).join('');
    const more = kinds.length > top
        ? `<div style="font-size:11px;color:#94a3b8;margin-top:4px;">（只列了条数最多的 ${top} 种，共 ${kinds.length} 种；补完映射点「🔁 重跑归认」可再刷新）</div>`
        : '';
    return `
        <div style="${TITLE_STYLE}">未认领的线索（${total} 条 / ${kinds.length} 种）</div>
        <div style="font-size:11px;color:#475569;line-height:1.6;margin-bottom:4px;">
            这些值**填了线索但没对上任何账户映射**。照着补一条（源:字段=值 → 账户）即可认领；
            补完点下面的「🔁 用当前映射重跑归认」，<b>不用重新导入</b>。
        </div>
        <div style="border:${CARD_BORDER};border-radius:8px;padding:6px 10px;background:#fffbeb;">
            ${rows}${more}
        </div>
    `;
}

/**
 * 主界面 HTML
 *
 * ★ **「＋ 新建账户」那颗按钮住在这里**（2026-10-19，用户在新发布的副本里问"怎么新建账户?"）：
 *   它原来只写在 `showAccountsModal()` 的**弹窗页脚**里，而设置页用的是**同一个视图**
 *   （`mountAccountsView`）却没有页脚 ⇒ 设置页整栏没有任何新建入口（那里只有「📤 写进 me.json」，
 *   而 me.json 名册是**派生物**，改它长不出应用账户）。⇒ 入口跟着视图走；两种形态**只有这一颗**
 *   （页脚别再放一颗）。⚠️ 标记写成 `acc-act` + `data-act="new"` ⇒ 只读形态会自动把它一起禁用。
 */
function accountsHtml(state) {
    const ids = listAccountIds(state);
    const activeIds = ids.filter(id => isAccountActive(state, id));
    const offIds = ids.filter(id => !isAccountActive(state, id));
    const viewOnly = isViewOnly(state);
    // **停用的账户单独一页** ——
    // 一次只列一页；默认停在"活跃"，停用那页没人时才不画那个按钮
    if (listPage === 'off' && !offIds.length) listPage = 'on';
    const shown = listPage === 'off' ? offIds : activeIds;
    return `
        <div style="font-size:12px;color:#475569;line-height:1.7;">
            <b>登录账户</b>＝手改的值以谁的名义记；<b>在查看</b>＝现在用谁的眼睛看。<br>
            两者不同时，<b>手改会被禁用</b>（这样才不会把自己的修改混进别人的数据），
            但<b>导入不受影响</b>。<br>
            只有<b>活跃</b>账户能当登录/查看、参与归认、显示在字段来源里；
            <b>停用</b>只是"先收起来"——账户、映射、它名下的值都还在，随时可启用回来。
        </div>
        ${viewOnly ? `
        <div style="margin-top:8px;padding:6px 10px;border-radius:6px;background:#fef2f2;color:#b91c1c;font-size:12px;line-height:1.6;">
            ⚠️ 只读：正在查看「${escapeHtml(accountName(state, state.viewingAccountId))}」，
            登录账户是「${escapeHtml(accountName(state, state.currentAccountId))}」。手改会被拒绝。
        </div>` : ''}
        ${unmatchedSection(state)}
        <div style="${TITLE_STYLE}display:flex;align-items:center;gap:8px;">
            <span>账户（${ids.length}）</span>
            <button class="btn btn-primary acc-act" data-act="new" style="padding:2px 10px;font-size:11px;" title="新建一个应用账户（可撤回、随导出走）">＋ 新建账户</button>
        </div>
        ${listPageBar(activeIds.length, offIds.length)}
        <div id="acc-list" data-page="${listPage}">${shown.map(id => accountCard(state, id)).join('')}</div>
        ${shown.length ? '' : `<div style="font-size:12px;color:#94a3b8;padding:6px 10px;">这一页是空的。</div>`}
        <div style="font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6;">
            映射就是"这条线索算谁的"：源（如 <code>qoj</code>）:字段（如 <code>提交者</code>）＝值（如 <code>某用户名</code>）。
            导入时认不出来就会提示你来这里补一条，<b>不会自动新建账户</b>。
        </div>
    `;
}

/**
 * 「活跃 N / 停用 M」那一行。
 *
 * 用 `.acc-page`（不挂 `.btn`）：既有冒烟按 `.btn` / `.acc-act` 找操作按钮，
 * 别让分页按钮混进去（与判重页二级栏同一个理由）。
 */
function listPageBar(activeCount, offCount) {
    const one = (key, label, count) => {
        const on = listPage === key;
        return `<button class="acc-page${on ? ' acc-page-on' : ''}" data-page="${key}"`
            + ` aria-selected="${on ? 'true' : 'false'}"`
            + ` style="padding:2px 10px;font-size:11px;cursor:pointer;border-radius:10px;`
            + `border:1px solid ${on ? '#2563eb' : '#d1d5db'};background:${on ? '#2563eb' : '#fff'};`
            + `color:${on ? '#fff' : '#475569'};">${label}（${count}）</button>`;
    };
    return `<div style="display:flex;gap:6px;align-items:center;margin:2px 0 8px;">
        ${one('on', '活跃', activeCount)}
        ${one('off', '已停用', offCount)}
        <span style="font-size:11px;color:#94a3b8;">停用的账户收在另一页；它们不参与归认、也不出现在字段来源里。</span>
    </div>`;
}

/**
 * 把账户界面**画进任意宿主元素**（弹窗与设置页共用**同一个视图**）。
 *
 * 「账户」并进设置页、和「🔑 名册/凭据」同一栏。为了不写出第二套界面，
 * 这里把"画 + 接线"抽出来：
 *   - `showAccountsModal()`（导入摘要那条"直达账户面板"的快捷入口）继续用它；
 *   - 设置页的「🔑 账户/名册」那栏也用它。
 *
 * @param {HTMLElement} host - 画到哪儿（内容由它**整体重画**，DOM 就是这一屏的真源）
 * @param {{onChange?:Function}} [opts] - 每次重画后叫一下（宿主用来同步标记之类）
 * @returns {{redraw:Function}}
 */
export function mountAccountsView(host, opts = {}) {
    const redraw = () => {
        host.innerHTML = accountsHtml(AppState);
        if (opts.readOnly) {
            // 只读形态（设置页用）：真源是 me.json，编辑在那一份的表单/JSON 里做 ——
            // 这里再放一套写应用状态的按钮，改了会被下一次投影覆盖（用户会白改）。
            for (const btn of host.querySelectorAll('.acc-act')) btn.disabled = true;
            const note = document.createElement('div');
            note.style.cssText = 'font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6;';
            note.textContent = '这是只读视图（真源是下面的 me.json）：改账户请在下面的表单/JSON 里改。';
            host.appendChild(note);
        }
        if (typeof opts.onChange === 'function') opts.onChange();
    };
    if (!opts.readOnly) {
        host.addEventListener('click', async (e) => {
            // 分页按钮（`活跃 / 已停用`）—— 不挂 `.acc-act`，单独认
            const pageBtn = e.target.closest ? e.target.closest('.acc-page') : null;
            if (pageBtn) {
                if (listPage !== pageBtn.dataset.page) {
                    listPage = pageBtn.dataset.page;
                    redraw();
                }
                return;
            }
            const btn = e.target.closest('.acc-act');
            if (!btn) return;
            const id = btn.dataset.id;
            const act = btn.dataset.act;

            if (act === 'edit') { openAccountEditor(id, redraw); return; }
            // 「＋ 新建账户」（挂在视图里、两种形态共用 —— 见 `accountsHtml` 的说明）
            if (act === 'new') { openAccountEditor(null, redraw); return; }
            // 上移 / 下移一位（交换顺序；到头了那个箭头是禁用的，点不到）
            if (act === 'up' || act === 'down') {
                await runAccountWrite(
                    (draft) => moveAccount(draft, id, act === 'up' ? -1 : 1),
                    `已调整「${accountName(AppState, id)}」的顺序`
                );
                redraw();
                return;
            }
            // 「未认领的线索」那一行的「＋ 补映射」：**带着线索**打开新建账户，
            // 映射行已经填好（用户只需选/建账户）。
            if (act === 'map') {
                openAccountEditor(null, redraw, {
                    source: btn.dataset.source || '',
                    field: btn.dataset.field || '',
                    value: btn.dataset.value || ''
                });
                return;
            }
            // 同一行的「🗑 清值」：把这条**无主**线索写下的那些值删掉（见 `purgeValuesByClue`）。
            if (act === 'purge') {
                await purgeClueLine({
                    source: btn.dataset.source || '',
                    field: btn.dataset.field || '',
                    value: btn.dataset.value || ''
                }, redraw);
                return;
            }
            if (act === 'off' || act === 'on') {
                const on = act === 'on';
                await runAccountWrite(
                    (draft) => setAccountActive(draft, id, on),
                    on ? `已启用：${accountName(AppState, id)}` : `已停用：${accountName(AppState, id)}`
                );
                redraw();
                return;
            }
            if (act === 'login' || act === 'view') {
                await runAccountWrite(
                    (draft) => (act === 'login' ? setCurrentAccount(draft, id) : setViewingAccount(draft, id)),
                    act === 'login' ? `已切换登录账户：${accountName(AppState, id)}` : `改为查看：${accountName(AppState, id)}`
                );
                redraw();
                return;
            }
            if (act === 'del') {
                showDeleteConfirm(
                    '删除账户',
                    `确定删除「${accountName(AppState, id)}」？\n`
                    + '已经归到它名下的值**不会被删**，只会变成"没有账户"（可查、可重新指派）。',
                    async (ok) => {
                        if (!ok) return;
                        await runAccountWrite((draft) => removeAccount(draft, id), '账户已删除');
                        redraw();
                    }
                );
            }
        });
    }
    redraw();
    return { redraw };
}

/**
 * 打开账户管理界面（**弹窗形态**）。
 *
 * 两种形态都是**同一份视图**（`mountAccountsView`），入口各有各的位置：
 *   · **顶栏 👤 标记 → 弹窗**（`ui/buttons.js`；用户 2026-10-19："很久以前的版本 点顶部的账号按钮会弹窗，那样挺好的"）；
 *   · **设置页「🔑 账户/名册」那一栏 → 内嵌**（账户与 me.json 名册同屏）；
 *   · `EVENTS.SHOW_ACCOUNTS_DIALOG`（导入摘要"有线索认不出 → 去补映射"那条路，正开着导入弹窗，
 *     跳页签会把人甩出去）。
 * ⚠️ 两处都**不许各写一套界面** —— 加按钮/改口径只改 `accountsHtml`。
 */
export function showAccountsModal() {
    const host = document.createElement('div');
    let view = null;
    const redraw = () => { if (view) view.redraw(); };
    createModal({
        title: '👤 账户',
        content: host,
        maxWidth: '620px',
        maxHeight: '82vh',
        buttons: [
            {
                label: '🔁 用当前映射重跑归认',
                className: 'btn',
                callback: () => { rerunAttribution(redraw); return false; }
            },
            // ⚠️ 「＋ 新建账户」**不在这儿**：它住在视图里（`accountsHtml`），两种形态共用一颗。
            //   2026-10-19 之前它只在页脚 ⇒ 嵌进设置页的那份没有新建入口（用户问"怎么新建账户?"）。
            // 「关闭」不写回调：`createModal` 对"回调没返回 false"的按钮就是关闭
            { label: '关闭', className: 'btn', callback: () => {} }
        ]
    });
    view = mountAccountsView(host);
}

// ================================================================
// 账户编辑（新建 / 修改：名称、性质、子账户、映射表）
// ================================================================

/**
 * 子账户那一块的行（★ 2026-10-19 用户："已选子账户列表和项上下交换"）。
 *
 * 一次画**全部候选**，但**已选的排在前面**并按那个顺序存进 `acc.children`（数组顺序 = 数据真源）；
 * 已选的行才给 ↑ / ↓。顺序状态记在行上的 `data-on`（**不读 `checkbox.checked`**：
 * DOM 桩里 `checked` 属性与 property 不一定同步，判据要能读得回来）。
 */
function childrenRowsHtml(state, chosen, all) {
    const order = chosen.concat(all.filter((c) => !chosen.includes(c)));
    if (!order.length) return '<span style="color:#94a3b8;">没有可选的账户</span>';
    return order.map((c) => {
        const on = chosen.includes(c);
        const i = chosen.indexOf(c);
        const upDis = !on || i === 0 ? ' disabled' : '';
        const downDis = !on || i === chosen.length - 1 ? ' disabled' : '';
        return `<div class="acc-child-row" data-id="${escapeHtml(c)}" data-on="${on ? 1 : 0}"
                style="display:flex;align-items:center;gap:6px;line-height:1.9;">
            <input type="checkbox" class="acc-child" value="${escapeHtml(c)}"${on ? ' checked' : ''}>
            <span style="flex:1;">${escapeHtml(accountName(state, c))}
                <span style="color:#94a3b8;">#${escapeHtml(c.slice(-4))}</span></span>
            ${on ? `<button class="btn acc-child-up"${upDis} title="上移一位"
                        style="padding:1px 6px;font-size:11px;">↑</button>
                    <button class="btn acc-child-down"${downDis} title="下移一位"
                        style="padding:1px 6px;font-size:11px;">↓</button>` : ''}
        </div>`;
    }).join('');
}

/** 已选的子账户 id（**按界面上的顺序**；`data-on` 是唯一判据） */
function readChildIds(panel) {
    return [...panel.querySelectorAll('.acc-child-row')]
        .filter((r) => r.dataset.on === '1')
        .map((r) => r.dataset.id);
}

/** 界面上现有的全部候选（已选 + 未选，DOM 顺序） */
function allChildIds(panel) {
    return [...panel.querySelectorAll('.acc-child-row')].map((r) => r.dataset.id);
}

/** 重画子账户那一块（只动这一块，别的输入框一个字都不碰） */
function writeChildren(panel, chosen) {
    const box = panel.querySelector('#acc-children');
    if (box) box.innerHTML = childrenRowsHtml(AppState, chosen, allChildIds(panel));
}

/**
 * 一行映射（★ 带 ↑/↓：用户 2026-10-19："映射的项上下交换" —— 顺序就是这个数组的顺序，见 `readRows`）
 */
function mappingRow(m = {}) {
    return `
        <div class="acc-map-row" style="display:flex;gap:4px;margin-bottom:4px;">
            <input class="m-source" value="${escapeHtml(m.source || '')}" placeholder="源" style="${INPUT_STYLE}width:90px;">
            <input class="m-field" value="${escapeHtml(m.field || '')}" placeholder="字段" style="${INPUT_STYLE}width:100px;">
            <input class="m-value" value="${escapeHtml(m.value || '')}" placeholder="值" style="${INPUT_STYLE}flex:1;">
            <button class="btn acc-map-up" title="上移一位" style="padding:2px 7px;font-size:11px;">↑</button>
            <button class="btn acc-map-down" title="下移一位" style="padding:2px 7px;font-size:11px;">↓</button>
            <button class="btn acc-map-del" style="padding:2px 8px;font-size:11px;color:#dc2626;">✕</button>
        </div>
    `;
}

/** 读界面上的映射行（DOM 是唯一的真源，保存时不用另记一份状态） */
function readRows(panel) {
    return [...panel.querySelectorAll('.acc-map-row')].map(row => ({
        source: row.querySelector('.m-source').value,
        field: row.querySelector('.m-field').value,
        value: row.querySelector('.m-value').value
    }));
}

/** 重画映射行 */
function writeRows(panel, rows) {
    const box = panel.querySelector('#acc-map-rows');
    if (box) box.innerHTML = rows.map(mappingRow).join('');
}

/** 编辑界面 HTML */
function editorHtml(state, id) {
    const isNew = !id;
    const acc = isNew ? {} : (state.accounts[id] || {});
    const kids = isNew ? [] : childrenOf(state, id);
    const maps = isNew ? [] : (Array.isArray(acc.mappings) ? acc.mappings : []);
    // 候选子账户：排除自己与自己的祖先（选了会成环 → 由 core 再兜一次）
    const candidates = isNew ? listAccountIds(state) : candidateChildren(state, id);

    return `
        <label style="display:block;font-size:12px;color:#334155;">显示名（随便改，不影响任何数据）
            <input id="acc-name" value="${escapeHtml(acc.name || '')}" style="width:100%;${INPUT_STYLE}margin-top:3px;">
        </label>
        <label style="display:block;font-size:12px;color:#334155;margin-top:8px;">性质（只是给人看的标签，随便写）
            <input id="acc-nature" list="acc-nature-presets" value="${escapeHtml(acc.nature || '')}"
                style="width:100%;${INPUT_STYLE}margin-top:3px;">
            <datalist id="acc-nature-presets">
                ${NATURE_PRESETS.map(n => `<option value="${n}"></option>`).join('')}
            </datalist>
        </label>
        ${isNew ? '' : `
        <label style="display:block;font-size:12px;color:#334155;margin-top:8px;">
            <input type="checkbox" id="acc-active" ${isAccountActive(state, id) ? 'checked' : ''}>
            活跃（停用的账户：不能当登录/查看、不参与归认、字段来源里不显示它的信息）
        </label>`}
        ${isNew ? '' : `
        <div style="${TITLE_STYLE}">子账户（可多选：一个账户可以挂在多个父下面；<b>已选的可以上下排</b>）</div>
        <div id="acc-children" style="max-height:150px;overflow:auto;border:${CARD_BORDER};border-radius:6px;padding:5px 8px;font-size:12px;">
            ${childrenRowsHtml(state, kids, candidates)}
        </div>`}
        <div style="${TITLE_STYLE}">映射（这条线索算谁的）</div>
        <div id="acc-map-rows"></div>
        <button class="btn" id="acc-map-add" style="padding:2px 8px;font-size:11px;">＋ 添加映射</button>
        <div id="acc-map-warn" style="display:none;margin-top:6px;padding:6px 8px;border-radius:6px;
            background:#fffbeb;border:1px solid #fde68a;font-size:12px;color:#92400e;line-height:1.7;"></div>
        <div style="font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6;">
            例：源 <code>qoj</code> / 字段 <code>提交者</code> / 值 <code>某用户名</code>。<br>
            三者都要填；空行会被丢掉。填得跟别的账户一样时会提醒（导入时那种线索会被报成冲突，不认领）。<br>
            ⚠️ 带赛季的平台要写**冒号 + 四位年**：<code>nk:2023</code>（两位年的写法 <code>nk:23</code>、带空格的 <code>nk: 2023</code> 都认不上，下面会提醒）。
        </div>
    `;
}

/**
 * 把映射**写法**的问题显示出来（例：写 `nk:23` 而抓取侧发的是 `nk:2023` ——
 * 数据端统一成四位年）。
 *
 * ⚠️ **只提醒、不自动改**：匹配是三元组全等，改错了会把线索认到别人头上。
 * 界面上直接给出**正确的写法**，一键照抄。
 */
function warnMappingRows(panel) {
    const box = panel.querySelector('#acc-map-warn');
    if (!box) return;
    const warns = mappingWarnings(readRows(panel));
    if (!warns.length) {
        box.style.display = 'none';
        box.textContent = '';
        return;
    }
    box.style.display = 'block';
    box.innerHTML = `⚠️ 有 ${warns.length} 行**写法对不上**（认不上任何线索）：<br>`
        + warns.slice(0, 8).map((w) => `· <code>${escapeHtml(w.source)}</code> → 应该写 `
            + `<code>${escapeHtml(w.suggest)}</code>：${w.why}`).join('<br>')
        + (warns.length > 8 ? `<br>…还有 ${warns.length - 8} 行` : '')
        + '<br><span style="color:#a16207;">照「未认领的线索」里那条原样抄最稳（它读的就是数据里的写法）。</span>';
}

/**
 * 打开账户编辑界面
 *
 * ⚠️ 它总是**叠在**账户管理界面之上（`onSaved` 就是上面那个 `redraw`）。
 * 保存后不要自己去重开管理界面 —— 那会叠出第二个副本。
 *
 * @param {string|null} id - null = 新建
 * @param {Function} [onSaved] - 保存成功后的回调（让上层重画）
 * @param {{source?:string,field?:string,value?:string}} [prefill] - 预填一条映射
 *        （「未认领的线索」那行的「＋ 补映射」用它：用户只需选/建账户）
 */
function openAccountEditor(id, onSaved = null, prefill = null) {
    const isNew = !id;
    const acc = isNew ? {} : (AppState.accounts[id] || {});
    const initialRows = Array.isArray(acc.mappings) ? acc.mappings : [];
    if (prefill && (prefill.source || prefill.field || prefill.value)) {
        initialRows.push({ source: prefill.source || '', field: prefill.field || '', value: prefill.value || '' });
    }
    const { panel, close } = createModal({
        title: isNew ? (prefill ? '👤 新建账户（已预填一条映射）' : '👤 新建账户')
                     : `👤 编辑账户：${accountName(AppState, id)}`,
        content: editorHtml(AppState, id),
        maxWidth: '600px',
        maxHeight: '82vh',
        buttons: [
            { label: '取消', className: 'btn', callback: () => { close(); } },
            {
                label: '保存',
                className: 'btn btn-primary',
                callback: async () => {
                    const name = panel.querySelector('#acc-name').value.trim();
                    if (!name) { showToast('显示名不能为空', 'error'); return false; }

                    const children = readChildIds(panel);
                    const activeEl = panel.querySelector('#acc-active');
                    const active = activeEl ? !!activeEl.checked : true;
                    const mappings = readRows(panel)
                        .map(m => ({ ...m, current: true }));

                    let newId = id;
                    const conflicts = [];
                    await runAccountWrite((draft) => {
                        const patch = {
                            name,
                            nature: panel.querySelector('#acc-nature').value.trim(),
                            active,
                            children,
                            mappings
                        };
                        if (isNew) {
                            newId = createAccount(draft, { name, nature: patch.nature, active });
                            saveAccount(draft, newId, patch);
                        } else {
                            const dropped = saveAccount(draft, id, patch);
                            if (dropped.length) {
                                showToast(`有 ${dropped.length} 个子账户被忽略（会成环或已不存在）`, 'error');
                            }
                        }
                        // 冲突检查放在**写之前**算（写完之后两个账户都算"自己"）
                        for (const m of mappings) {
                            const c = findMappingConflicts(draft, m, newId);
                            if (c.length) conflicts.push(`${m.source}:${m.field}=${m.value}`);
                        }
                    }, isNew ? '账户已新建' : '账户已保存');

                    if (conflicts.length) {
                        showToast(`提示：${conflicts.length} 条映射与别的账户重复 —— 导入遇到会报冲突、不认领`, 'error');
                    }
                    // ⚠️ **写法**错只提醒、不拦（用户可能知道自己在写什么）；认不上线索时
                    //    回这个弹窗就能看见黄条（`warnMappingRows`）——
                    //    `nk:23`（应写 `nk:2023`）就属于这种
                    const badFormat = mappingWarnings(mappings);
                    if (badFormat.length) {
                        showToast(`提示：${badFormat.length} 行映射的写法对不上线索（`
                            + `${badFormat[0].source} 应写 ${badFormat[0].suggest}）—— 它们会一条都认不上`, 'error');
                    }
                    close();
                    if (typeof onSaved === 'function') onSaved();
                    return false;
                }
            }
        ]
    });
    panel.addEventListener('click', (e) => {
        // 行是**重画**出来的（不用 insertAdjacentHTML）：
        // 一份"界面上看到的行"就是这个弹窗的全部状态，读 DOM → 改 → 重画，
        // 逻辑只有一处，不受浏览器实现差异影响。
        if (e.target.closest('#acc-map-add')) {
            const rows = readRows(panel);
            rows.push({});
            writeRows(panel, rows);
            warnMappingRows(panel);
            return;
        }
        const del = e.target.closest('.acc-map-del');
        if (del) {
            const row = del.closest('.acc-map-row');
            const all = [...panel.querySelectorAll('.acc-map-row')];
            const rows = readRows(panel);
            rows.splice(all.indexOf(row), 1);
            writeRows(panel, rows);
        }
        // ★ 映射行**上下交换**（用户 2026-10-19）：顺序就是 `mappings` 数组的顺序 ⇒
        //   读 DOM → 换位置 → 写回（与"加行/删行"同一条路，逻辑只一处）。
        //   ⚠️ 别写成 `closest('.acc-map-up, .acc-map-down')`：冒烟测试的 DOM 桩**不支持逗号选择器**
        //   （会静默返回 null ⇒ 按钮看着在、点了没反应）。
        const mapUp = e.target.closest('.acc-map-up');
        const mapDn = mapUp ? null : e.target.closest('.acc-map-down');
        if (mapUp || mapDn) {
            const row = (mapUp || mapDn).closest('.acc-map-row');
            const all = [...panel.querySelectorAll('.acc-map-row')];
            const i = all.indexOf(row);
            const j = i + (mapUp ? -1 : 1);
            if (i >= 0 && j >= 0 && j < all.length) {
                const rows = readRows(panel);
                [rows[i], rows[j]] = [rows[j], rows[i]];
                writeRows(panel, rows);
            }
        }
        // ★ 子账户**上下交换**（用户 2026-10-19）：已选的按这个顺序存进 `children` 数组
        const cUp = e.target.closest('.acc-child-up');
        const cDn = cUp ? null : e.target.closest('.acc-child-down');
        if (cUp || cDn) {
            const ids = readChildIds(panel);
            const i = ids.indexOf((cUp || cDn).closest('.acc-child-row').dataset.id);
            const j = i + (cUp ? -1 : 1);
            if (i >= 0 && j >= 0 && j < ids.length) {
                [ids[i], ids[j]] = [ids[j], ids[i]];
                writeChildren(panel, ids);
            }
        }
        const cdel = e.target.closest('.acc-child-del');
        if (cdel) {
            const ids = readChildIds(panel).filter((id) => id !== cdel.closest('.acc-child-row').dataset.id);
            writeChildren(panel, ids);
        }
        warnMappingRows(panel);
    });
    // 改动映射行时也重新检查（写成 `nk:2023` 这种当场上黄条）
    panel.addEventListener('input', (e) => {
        if (e.target.closest && e.target.closest('.acc-map-row')) warnMappingRows(panel);
    });
    // 勾/取消子账户：**已选的往前排**（勾上 = 追加到末尾；取消 = 从序列里拿掉）
    panel.addEventListener('change', (e) => {
        const box = e.target.closest && e.target.closest('.acc-child');
        if (!box) return;
        const row = box.closest('.acc-child-row');
        const id = row.dataset.id;
        const chosen = readChildIds(panel);
        writeChildren(panel, row.dataset.on === '1'
            ? chosen.filter((c) => c !== id)
            : chosen.concat([id]));
    });
    writeRows(panel, initialRows);
    warnMappingRows(panel);
}

// ================================================================
// 用当前映射重跑归认
// ================================================================

/**
 * 把**已有的值**按当前映射表重算一遍归属。
 *
 * 为什么需要它：第一次导入时还没填映射 → 那些值记成"客观"；
 * 补上映射后重新导入若只会**再叠一条**（同来源同值、账户不同），
 * 历史值就修不回来。导入时会按"来源+值+线索"合并（改账户、不叠条），
 * 而这个按钮负责把**已经躺在数据里的**值一次性重算 —— 不用重新导入。
 *
 * 只改 `account`，不碰 `v / src / at`。先 dry-run 出预览，让用户确认后再落盘（可撤销）。
 */
async function rerunAttribution(onDone) {
    const preview = reattributeValues(AppState, { dryRun: true });
    if (preview.withClue === 0) {
        showToast('没有带账户线索的值（老数据或来源没给线索），没有可重算的', 'info');
        return;
    }
    if (preview.changed === 0) {
        showToast(`归属没变化（检查了 ${preview.withClue} 条带线索的值）`, 'success');
        return;
    }
    showConfirmDialog('重跑归认', `
        将按<b>当前</b>的账户映射重算这些值的归属：<br>
        · 带线索的值：<b>${preview.withClue}</b> 条<br>
        · 归属会改变：<b>${preview.changed}</b> 条<br>
        · 线索仍认不出：<b>${preview.unmatched}</b> 条${preview.conflicts ? `（其中 ${preview.conflicts} 条被多个账户认领 → 留作客观）` : ''}<br>
        <span style="font-size:12px;color:#6b7280;">只改"这是谁说的"，不动值本身；可以撤销。</span>
    `, async (ok) => {
        if (!ok) return;
        // ⚠️ 摘要只能在 mutator 跑完之后拿（参数是**先**求值的，写在外面会永远是空）
        let summary = null;
        await runAccountWrite((draft) => {
            summary = reattributeValues(draft, {});
            return summary;
        });
        if (summary) showToast(describeReattribute(summary), 'success');
        if (typeof onDone === 'function') onDone();
    });
}

/**
 * 「未认领的线索」那行的「🗑 清值」：把这条线索写下的那些**无主**的值删掉。
 *
 * 为什么需要：适配器写错过线索（杭电 2021/2023/2024/2025 全写成 `TEAM0/teamA`），
 * 修好之后重新导入只会再叠一组（合并键里线索算身份）⇒ 每格两条一样的值、
 * 这行提示永远挂着。补映射治不了它（那只会让两条都"有主"）。
 *
 * 安全边界在 core 里（`purgeValuesByClue`）：**只删认不出账户的**、只认"源+字段+值"全等、
 * 清空的字段一起撤掉。这里只负责"先给数字、再动手"。
 */
async function purgeClueLine(clue, onDone) {
    const preview = purgeValuesByClue(AppState, clue, { dryRun: true });
    if (!preview.removed) {
        const why = preview.skippedMapped
            ? `这条线索下的 ${preview.skippedMapped} 条值都已被映射认领了，不能按线索清`
            : '这条线索下没有可删的值';
        showToast(why, 'info');
        return;
    }
    showConfirmDialog('按线索清值', `
        将删掉线索 <b>${escapeHtml(clueText(clue))}</b> 写下的值：<br>
        · 要删：<b>${preview.removed}</b> 条<br>
        · 因此清空的字段：<b>${preview.fields}</b> 个<br>
        ${preview.skippedMapped ? `· 已被映射认领、<b>不会</b>删的：${preview.skippedMapped} 条<br>` : ''}
        <span style="font-size:12px;color:#b91c1c;">这个动作<strong>不能撤销</strong>（撤销栈里也不会有）。
        它们通常是"来源写错过线索"留下的那批值；删完后这条线索就从列表里消失。</span>
    `, async (ok) => {
        if (!ok) return;
        let summary = null;
        await runAccountWrite((draft) => {
            summary = purgeValuesByClue(draft, clue, {});
            return summary;
        });
        if (summary) showToast(describePurge(summary), 'success');
        if (typeof onDone === 'function') onDone();
    });
}

/** 走一次事务（账户是顶层数据，不影响树的展开上限，所以 validate:false） */
async function runAccountWrite(mutator, successMsg) {
    try {
        await execute(mutator, {
            validate: false,
            refreshParentId: null,
            onSuccess: () => {
                renderAccountChip();
                if (successMsg) showToast(successMsg, 'success');
            },
            onError: (err) => showToast('账户操作失败：' + err.message, 'error')
        });
    } catch (_) {
        // onError 已处理
    }
}
