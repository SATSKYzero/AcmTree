// ================================================================
// 设置页（ui/settings/settingsPage.js）
//
// 设置是**一级 Tab**（`index.html` 里 `data-tab="settings"` + `#tab-settings`，
// 与「🧩 判重整理」同一套路：内容**运行时画**，见 `ui/tabs.js`）。
// 弹窗宽度就那么点：里面塞 5 栏 + 一个 me.json 编辑器根本放不下
//（JSON 视图更是完全塞不下）。
//
// "独占一页"带来的几条约定：
//   ① **没有「取消」**：保存就是保存，不保存就只是草稿。切栏 / 来回切页签
//      **都不会丢** —— 值统一从 `valuesOf()`（已保存状态 + 草稿覆盖）来，
//      me.json 编辑器实例也**缓存着**（连草稿一起活着）；
//   ② 排版按"一整页"来：卡片网格（`auto-fill, minmax(340px,1fr)`），控件占满一列；
//   ③ ⚠️ **两件事别混**：这一页上半部分是**应用设置**（进 `AppState.settings`、
//      可撤回、进导出），最右那栏「🔑 名册/凭据」改的是**磁盘上的 me.json**
//      （抓取脚本的配置，不进历史、不能撤回）。页头那句提示就是给这件事的。
// ================================================================
import { AppState } from '../../shell/state.js';
import { execute, undo } from '../../shell/executor.js';
import { captureState, resetHistory, getHistoryCount } from '../../transaction/history.js';
import { saveData, flushPendingSave } from '../../persistence/index.js';
import {
    EVENTS,
    DEFAULT_HISTORY_STEPS,
    MAX_HISTORY_STEPS,
    DEFAULT_BOX_DISPLAY_MODE,
    DEFAULT_EDIT_MODE,
    DEFAULT_NODE_PER_PAGE,
    DEFAULT_EXPANDED_NODE_WARNING_LIMIT,
    DEFAULT_EXPANDED_NODE_BLOCK_LIMIT
} from '../../A_constants.js';
import { showToast } from '../G_modal/G1_toast.js';
import { showOperationConfirmWithCountdown } from '../G_modal/G2_common.js';
import { setSetting } from '../../core/ops/settings.js';
import { resetPagination } from '../../core/model/viewState.js';
// 「去 Markdown 记号」只有一份实现（页面上的字与悬停提示共用它）
import { plain } from '../../utils/text.js';
import { resolveCountMode } from '../../core/query/countMode.js';
import { MODE_PLAIN, MODE_DEDUP } from '../../core/query/groupCount.js';
import { getCurrentRenderedCount } from '../../core/validate/expanded.js';
import { createMeEditor } from '../MeEditor/meEditor.js';
import { createNatureRegistryPanel } from './natureRegistryPanel.js';
import { mountAccountsView } from '../G_modal/G8_accounts.js';
import { el } from '../../utils/dom.js';
// ★ 逐字段"取哪一份"的设置项：字段名单**从模板派生**（`ELEMENTS` 里带 `take.agg` 的）
import { ELEMENTS } from '../../core/model/elements.js';
// ★ 训练强度映射表那一栏（⑮⑯⑰：全局若干张有名字的表）—— 自带增删改按钮，不走底部那个保存
import { intensityCards, resetIntensitySection } from './intensitySection.js';
// ★ 题目 AC 时间的规则（`v9.1.21`）：名单/标签/归一化**只有一份**（`core/acTimeRule.js`）
import { AC_TIME_RULES, AC_TIME_RULE_LABELS, DEFAULT_AC_TIME_RULE, normalizeAcTimeCutoff } from '../../core/acTimeRule.js';
// ★ 改了规则要**当场重算 P 的 `acTime` 缓存**，并丢掉派生表/计数缓存（见 `saveSettings`）
import { recomputeAcTime } from '../../core/autoCompute.js';
import { clearDerivedMemo } from '../../core/derive.js';

/** 画进哪个容器（index.html 里的静态 `#tab-settings`） */
export const SETTINGS_TAB_ID = 'settings';
export const SETTINGS_CONTAINER_ID = 'tab-settings';

// ---- 模块级小状态（见文件头 ①） ----
/** 当前看的那一栏（切栏只重画，不清草稿） */
let activeSection = 'display';
/**
 * 「🔑 账户/名册」那一栏里的**二级页**：
 * `accounts` = 应用账户（真源）/ `roster` = me.json（凭据 + 名册派生）。
 * 切它只重画，不清草稿。
 */
const ME_SUBS = [
    { id: 'accounts', label: '👤 账户' },
    { id: 'roster', label: '🔑 名册 / 凭据（me.json）' }
];
let activeMeSub = 'accounts';
/** 输入草稿：设置键 → 字符串值（用户敲过的才算） */
let draft = {};
/** 有任何未保存的改动吗（`tabs.js` 据此决定"数据变了要不要重画"，免得冲掉正在敲的字） */
let dirty = false;
/** me.json 编辑器的宿主元素与实例（**跨重画复用**，否则草稿会被重画清空） */
let meHost = null;
let meApi = null;
/**
 * 「🧬 性质注册表」那一栏的宿主与面板。
 *
 * ⚠️ 与 me 编辑器同一条理由：**实例跨重画复用** —— 每次重画都新建的话，
 * 用户改了一半的草稿会被清空。
 */
let nrHost = null;
let nrPanel = null;

const CARD = 'background:#fff;border:1px solid #eef2f6;border-radius:10px;padding:14px 16px;';
const FIELD = 'display:block;margin-bottom:14px;font-size:13px;color:#334155;';
const HINT = 'display:block;font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.6;';
const INPUT_W = 'width:100%;max-width:420px;padding:6px 9px;border:1px solid #d1d5db;border-radius:6px;'
    + 'font-size:13px;margin-top:4px;box-sizing:border-box;';
/** 选择框宽一点（选项文字长），但仍是"占满一列"的观感 */
const SELECT_W = INPUT_W.replace('max-width:420px', 'max-width:520px');
/**
 * 设置项的**当前值**：已保存的状态打底，用户敲过的草稿盖在上面。
 *
 * ⚠️ 这是"多栏一页"能成立的关键：保存时**不能**从 DOM 读值 ——
 *    用户可能改了「显示」那栏、切到「性能」再点保存，此时前者根本不在 DOM 里
 *    （实测会读成空串 ⇒ 一律报"要 1~120 之间的整数"）。所以值只有这一个来源。
 */
function valuesOf() {
    const s = AppState.settings;
    const base = {
        autoSaveInterval: s.autoSave.autoSaveInterval ?? 10,
        autoExportMode: s.autoSave.autoExportMode || 'full',
        treeDisplayMode: s.mode.treeDisplayMode || 'tree',
        editMode: s.mode.editMode || DEFAULT_EDIT_MODE,
        nodePerPage: s.display.nodePerPage ?? DEFAULT_NODE_PER_PAGE,
        boxCount: s.display.boxCount ?? 15,
        boxDisplayMode: s.display.boxDisplayMode || DEFAULT_BOX_DISPLAY_MODE,
        l1: s.performance.expandedNodeWarningLimit ?? DEFAULT_EXPANDED_NODE_WARNING_LIMIT,
        l2: s.performance.expandedNodeBlockLimit ?? DEFAULT_EXPANDED_NODE_BLOCK_LIMIT,
        historySteps: s.performance.historySteps ?? DEFAULT_HISTORY_STEPS,
        countMode: resolveCountMode(s),
        // ⚠️ 这里显示**存进去的原值**（不是 `acTimeRuleOf` 归一后的）——
        //    用户填坏了截断值时，下拉要还停在他选的那一项上，别悄悄跳回「取最早」让他以为改不成。
        acTimeRule: AC_TIME_RULES.includes(String(s.acTimeRule || '')) ? s.acTimeRule : DEFAULT_AC_TIME_RULE,
        acTimeCutoff: String(s.acTimeCutoff || ''),
        // 查看范围要不要带上直接子账户（默认 false = 原逻辑）
        scopeMergeChildren: !!s.scopeMergeChildren
    };
    // 逐字段"取哪一份"的覆盖（键 = `col_<字段>`；**只存偏离默认的项** ⇒ 没存的就是"自动"）
    for (const f of columnFields()) {
        const p = (s.display.fieldColumn || {})[f];
        if (p === 'own' || p === 'group') base['col_' + f] = p;
    }
    return Object.assign(base, draft);
}
// ================================================================
// 各栏的卡片
// ================================================================

/**
 * 有"组那份"的字段（= `ELEMENTS` 里带 `take.agg` 的那些）——
 * **名单从模板派生**（`core/model/elements.js`），这里不手写第二份；新增字段自动出现在设置里。
 */
function columnFields() {
    return Object.keys(ELEMENTS).filter((f) => ELEMENTS[f].take && ELEMENTS[f].take.agg);
}

/** 字段名的中文小注（**只是 UI 文案**；没有的就显示字段名本身） */
const COLUMN_GLOSS = {
    status1: '状态1（已处理）',
    status2: '状态2（补题档位）',
    statusComplete1: '整场是否处理完',
    statusComplete2: '整场是否全过',
    acTime: 'AC 时间',
    lastSubmitTime: '最新提交时间',
    contestTime: '开赛时间',
    cfDifficulty: 'CF 难度',
    atcoderDifficulty: 'AtCoder 难度',
    clistDifficulty: 'CLIST 难度',
    ratio: 'XCPC 通过率',
    xcpcDifficulty: 'XCPC 难度等级'
};

function displayCards() {
    const v = valuesOf();
    const mode = el('div', CARD);
    mode.innerHTML = `<label style="${FIELD}">主页渲染模式
        <select data-setting="treeDisplayMode" style="${SELECT_W}">
            <option value="tree">🌳 树形模式（递归展开/折叠）</option>
            <option value="folder">📁 文件夹模式（点击进入子节点）</option>
        </select>
        <span style="${HINT}">树形模式=一屏看多层（可折叠）；文件夹模式=一次只看一层，节点特别多时更清爽。</span>
    </label>
    <label style="${FIELD};margin-bottom:0;">编辑模式
        <select data-setting="editMode" style="${SELECT_W}">
            <option value="attribute">✏️ 属性编辑</option>
            <option value="selection">🎯 选中状态编辑</option>
        </select>
        <span style="${HINT}">属性编辑=点节点改字段；选中状态编辑=点节点只是选中（配合批量操作）。</span>
    </label>`;
    mode.querySelector('[data-setting="treeDisplayMode"]').value = v.treeDisplayMode;
    mode.querySelector('[data-setting="editMode"]').value = v.editMode;

    const pageCard = el('div', CARD);
    pageCard.innerHTML = `<label style="${FIELD}">展开分页大小（每页节点数）
        <input type="number" min="1" data-setting="nodePerPage" style="${INPUT_W}">
        <span style="${HINT}">⚠️ 改了它会把所有节点的当前页码重置到第 1 页（分页口径变了）。</span>
    </label>
    <label style="${FIELD};margin-bottom:0;">比赛节点方块显示数量（1~200）
        <input type="number" min="1" max="200" data-setting="boxCount" style="${INPUT_W}">
        <span style="${HINT}">比赛节点下面那排小方框最多显示几道题。</span>
    </label>`;
    pageCard.querySelector('[data-setting="nodePerPage"]').value = v.nodePerPage;
    pageCard.querySelector('[data-setting="boxCount"]').value = v.boxCount;

    const boxCard = el('div', CARD);
    boxCard.innerHTML = `<label style="${FIELD};margin-bottom:0;">题目预览方块显示内容
        <select data-setting="boxDisplayMode" style="${SELECT_W}">
            <option value="cf">CF难度</option>
            <option value="xcpc">XCPC难度</option>
        </select>
        <span style="${HINT}">只有小方框用这个口径；树上标题用的是「数值难度」字段组的当前偏好。</span>
    </label>`;
    boxCard.querySelector('[data-setting="boxDisplayMode"]').value = v.boxDisplayMode;

    // ★ 逐字段"取哪一份"（判重模式下才生效 —— 见 `view/scope.js` 的 `displayColumnOf`）
    const columnCard = el('div', CARD);
    columnCard.innerHTML = `<div style="${FIELD}">判重模式下：各字段读哪一份
        <span style="${HINT}">「自动」跟「计数模式」走（不判重 ⇒ 本份）。选「本份 / 合并那份」只在
        <b>判重模式</b>下生效 —— 不判重时一律读本份（否则每读这一格都要把整棵树的组值算一遍）。</span>
        ${columnFields().map((f) => `<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#475569;margin-top:6px;">
            <select data-setting="col_${f}" style="${SELECT_W};max-width:170px;margin-top:0;">
                <option value="auto">自动</option>
                <option value="own">本份</option>
                <option value="group">合并那份</option>
            </select>
            <span>${COLUMN_GLOSS[f] || '（未知字段）'} <code style="color:#94a3b8;">${f}</code></span>
        </label>`).join('')}
    </div>`;
    for (const f of columnFields()) {
        const cur = (AppState.settings.display.fieldColumn || {})[f];
        columnCard.querySelector(`[data-setting="col_${f}"]`).value =
            (cur === 'own' || cur === 'group') ? cur : 'auto';
    }

    return [mode, pageCard, boxCard, columnCard];
}

function saveCards(redraw) {
    const v = valuesOf();
    const hisCount = getHistoryCount();

    const card = el('div', CARD);
    card.innerHTML = `<label style="${FIELD}">自动保存间隔（分钟）
        <input type="number" min="1" max="120" data-setting="autoSaveInterval" style="${INPUT_W}">
        <span style="${HINT}">改动会在这个窗口内合并成一次写盘（点导出/导入会立刻落盘）。</span>
    </label>
    <label style="${FIELD};margin-bottom:0;">定时自动导出类型
        <select data-setting="autoExportMode" style="${SELECT_W}">
            <option value="main">仅主页</option>
            <option value="full">完整数据</option>
        </select>
    </label>`;
    card.querySelector('[data-setting="autoSaveInterval"]').value = v.autoSaveInterval;
    card.querySelector('[data-setting="autoExportMode"]').value = v.autoExportMode;

    const acts = el('div', CARD);
    acts.innerHTML = `<div style="font-size:13px;font-weight:600;color:#334155;margin-bottom:4px;">历史</div>
        <div style="${HINT};margin:0 0 10px;">撤回 = 回到上一个版本；清空历史 = 只留当前状态，之后不可再撤回。</div>`;
    const row = el('div', 'display:flex;gap:8px;flex-wrap:wrap;');
    const undoBtn = el('button', 'padding:6px 12px;font-size:13px;',
        `↩️ 撤回${hisCount > 0 ? `（${hisCount} 个可撤回版本）` : '（无可撤回版本）'}`);
    undoBtn.className = 'btn btn-warning';
    undoBtn.addEventListener('click', () => {
        if (getHistoryCount() <= 0) { showToast('没有可撤回的历史', 'error'); return; }
        showOperationConfirmWithCountdown(['撤回操作将撤销最近一次修改，回到之前的状态。'], async (confirmed) => {
            if (!confirmed) return;
            try {
                if (!await undo()) { showToast('撤回失败：无历史', 'error'); return; }
                document.dispatchEvent(new CustomEvent(EVENTS.PAGE_TABS_REFRESH_REQUIRED));
                showToast('已撤回', 'success');
                redraw();
            } catch (err) {
                showToast('撤回失败: ' + err.message, 'error');
            }
        });
    });
    const clearBtn = el('button', 'padding:6px 12px;font-size:13px;', '🗑️ 清空历史');
    clearBtn.className = 'btn btn-danger';
    clearBtn.addEventListener('click', () => {
        showOperationConfirmWithCountdown(
            ['清空历史将删除所有可撤回版本，仅保留当前状态。此操作不可撤销。'],
            async (confirmed) => {
                if (!confirmed) return;
                try {
                    resetHistory(captureState(AppState));
                    // 用户点的是"确定"，要真的落盘：先落掉挂着的合并写、再立刻写一次
                    await flushPendingSave(AppState);
                    await saveData(AppState);
                    document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED, { detail: { parentId: null } }));
                    showToast('已清空所有历史', 'success');
                    document.dispatchEvent(new CustomEvent('settings-saved'));
                    redraw();
                } catch (err) {
                    showToast('清空历史失败: ' + err.message, 'error');
                }
            }
        );
    });
    row.appendChild(undoBtn);
    row.appendChild(clearBtn);
    acts.appendChild(row);
    return [card, acts];
}

function performanceCards() {
    const v = valuesOf();
    let dataSizeMB = 0;
    try {
        const json = JSON.stringify({ nodes: AppState.nodes, childOrder: AppState.childOrder, pages: AppState.pages });
        dataSizeMB = new Blob([json]).size / 1024 / 1024;
    } catch (_) {
        dataSizeMB = 0;
    }
    const steps = Number(v.historySteps) || 0;

    const card = el('div', CARD);
    card.innerHTML = `<label style="${FIELD}">展开节点警告阈值（L1）
        <input type="number" min="1" data-setting="l1" style="${INPUT_W}">
        <span style="${HINT}">一屏要画的节点数超过它就提示一次（还能继续）。</span>
    </label>
    <label style="${FIELD}">展开节点禁止阈值（L2）
        <input type="number" min="1" data-setting="l2" style="${INPUT_W}">
        <span style="${HINT}">超过它就拒绝展开；不能小于根节点的直接子节点数。</span>
    </label>
    <label style="${FIELD};margin-bottom:0;">可撤回步数（1~${MAX_HISTORY_STEPS}，默认 ${DEFAULT_HISTORY_STEPS}）
        <input type="number" min="1" max="${MAX_HISTORY_STEPS}" data-setting="historySteps" style="${INPUT_W}">
        <span style="${HINT}">📊 当前数据量约 ${dataSizeMB.toFixed(1)} MB × ${steps} 步 ≈ 占用磁盘 ${(dataSizeMB * steps).toFixed(1)} MB</span>
    </label>`;
    card.querySelector('[data-setting="l1"]').value = v.l1;
    card.querySelector('[data-setting="l2"]').value = v.l2;
    card.querySelector('[data-setting="historySteps"]').value = v.historySteps;
    return [card];
}

function statsCards() {
    const current = valuesOf().countMode;
    const card = el('div', CARD);
    card.innerHTML = `<div style="font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;">计数模式（统计的单位 = 组）</div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:12px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="radio" name="count-mode" value="${MODE_PLAIN}" style="margin-top:3px;">
            <span>不去重（默认）<span style="${HINT}">与不去重口径一致：所有原料节点都算；合成节点只在它本次子树内<b>没有任何成员</b>时才计一次。</span></span>
        </label>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="radio" name="count-mode" value="${MODE_DEDUP}" style="margin-top:3px;">
            <span>去重（以组为单位）<span style="${HINT}">去重是 <b>scope-local</b>：同一个组<b>在这个子树内只算一次</b>（不是全局去重）；组的状态以合成节点为准。</span></span>
        </label>`;
    card.querySelectorAll('input[name="count-mode"]').forEach((r) => { r.checked = r.value === current; });

    // ★ **题目 AC 时间怎么挑**（用户 2026-10-13）——
    //   为什么需要它：同一道题被多次训练（间隔很久）时，"取最早"只让**第一次**进训练追踪，
    //   后面那几次在热力图 / AC 列表里整段看不见。
    //   ⚠️ 它是**唯一一条会改到"已物化缓存字段"**的设置 ⇒ 保存时要在同一个事务里重算 P 的 `acTime`
    //      （见 `saveSettings`），否则缓存与派生表两个答案。
    const acCard = el('div', CARD);
    acCard.innerHTML = `<div style="font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;">题目 AC 时间怎么取（影响树上「AC时间」与训练追踪）</div>
        <label style="${FIELD}">取值规则
            <select data-setting="acTimeRule" style="${SELECT_W}">
                ${AC_TIME_RULES.map(r => `<option value="${r}">${AC_TIME_RULE_LABELS[r]}</option>`).join('')}
            </select>
        </label>
        <label style="${FIELD};margin-bottom:0;">截断时间（只在选了<b>带截断</b>的那两种规则时用）
            <input type="text" data-setting="acTimeCutoff" placeholder="20260101 / 202601011200 / 20260101120000"
                style="${INPUT_W}">
            <span style="${HINT}">8 位 = 到天、12 位 = 到分、14 位 = 到秒（分隔符随便写）。<br>
            · 第 3 种（取截断之后的最早）："取<b>不早于它</b>的那些里<b>最早</b>的一条"；这条题一次都没有 ⇒ 取它<b>最后一次</b> AC。<br>
            · 第 4 种（并忽略截断前的所有提交）：<b>早于它的提交整体不算</b>（不算提交、不算 AC、也不算最新提交），
            树上那些行会<b>变淡</b>但仍在；截断后一条提交都没有 ⇒ 这题回到「未使用」—— 用于<b>重复利用训练资源</b>。</span>
        </label>`;
    acCard.querySelector('[data-setting="acTimeRule"]').value = valuesOf().acTimeRule;
    acCard.querySelector('[data-setting="acTimeCutoff"]').value = valuesOf().acTimeCutoff;

    // ★ **查看范围要不要带上直接子账户**（用户 2026-10-13："把账户的子账户机制用起来，
    //   status2 的 own 值取本账号与所有子账户的合并结果"，并定成**一个选项、与原逻辑并列**）。
    const scopeCard = el('div', CARD);
    scopeCard.innerHTML = `<div style="font-size:13px;font-weight:600;color:#334155;margin-bottom:8px;">查看范围（统计与显示共用）</div>
        <label style="display:flex;align-items:flex-start;gap:8px;font-size:13px;color:#334155;cursor:pointer;">
            <input type="checkbox" data-setting="scopeMergeChildren" style="margin-top:3px;">
            <span>把我的「子账户」也算进我这份<span style="${HINT}">
            勾上：查看某个账户时，<b>它的直接子账户</b>的提交也算进"我这份"（状态、树上显示、统计都跟着变）。
            ⚠️ 只看<b>直接</b>子账户，<b>不递归</b>到孙辈。不勾（默认）= 只看本账户 —— 老行为一字不变。</span></span>
        </label>`;
    scopeCard.querySelector('[data-setting="scopeMergeChildren"]').checked = valuesOf().scopeMergeChildren;
    return [card, acCard, scopeCard];
}

/**
 * 「🔑 账户/名册」那一栏：**两半放同一屏**（把「账户」并进设置页、
 * 和「🔑 名册/凭据」放一起）。
 *
 *   · 上半 = **应用账户**（登录/查看 + 账户/映射 + 未认领线索）—— 走 `mountAccountsView`，
 *     与弹窗**同一份视图**（不写第二套）；
 *   · 下半 = **me.json**（抓取脚本的名册/凭据）—— 表单 / JSON 双视图。
 *
 * ⚠️ 两半是**两套存储**，同屏只是"看得见"，不是"同一份数据"：
 *    应用账户进 `AppState`（可撤回、随导出走），me.json 是磁盘上的文件（不进历史）。
 *    所以两边各要有各自的映射/handle，谁都不会自动跟着另一边变。
 *
 * ⚠️ **实例跨重画复用**：me.json 编辑器若每次重画都新建，用户敲了一半的草稿
 *    （以及已经读回来的那份文档）会被清空 —— "切个栏回来就没了"在独占一页下太容易踩。
 *    所以宿主元素只建一次，之后都是**搬**到新位置（事件监听、闭包、草稿都还在）。
 *    账户视图是无状态的 HTML，每次重画就地重建即可（它自己会 `redraw()`）。
 */
/**
 * 把 me.json 的账户**投影**成应用账户表（映射与花名册合成一个东西）。
 *
 * ⚠️ 这份投影是**缓存**，不是第二份真源：
 *    · me.json 的 `accounts[]` 是唯一真源（账户 = 那个人，项上带着各平台账号 + 历年队名，
 *      映射由它们推出来 —— 见 `core/rosterAccounts.js`）；
 *    · 这里只把它落到 `AppState.accounts`，好让**离线**（没起主脚本）时导入/归认照常工作；
 *    · ⚠️ **不进历史**（不是用户的一次编辑，是"读文件"）：直接改状态 + 合并写盘，
 *      否则每开一次设置页就多一条可撤回版本。
 *    · ⚠️ **本机账户（`local`）不在 me.json 里**，投影时保留它 —— it 是"没有任何账户信息"的兜底身份。
 */
function meCard() {
    const out = [];

    // **账户 / 名册 分页**：一次只画一块（二级栏，与「检索」「判重」同一个做法）。
    const bar = el('div', 'display:flex;gap:6px;flex-wrap:wrap;grid-column:1/-1;margin-bottom:2px;');
    for (const sub of ME_SUBS) {
        const btn = el('button', 'padding:4px 12px;font-size:12px;', sub.label);
        btn.className = 'me-subtab' + (sub.id === activeMeSub ? ' me-subtab-on' : '');
        btn.dataset.sub = sub.id;
        btn.style.cssText += sub.id === activeMeSub
            ? 'background:#2563eb;border-color:#2563eb;color:#fff;' : '';
        btn.addEventListener('click', () => {
            if (activeMeSub === sub.id) return;
            activeMeSub = sub.id;
            renderSettingsPage();          // 切页**不清草稿**（草稿在 me 编辑器里）
        });
        bar.appendChild(btn);
    }
    out.push(bar);

    if (activeMeSub === 'roster') {
        const meSlot = el('div', 'grid-column:1/-1;');
        if (!meHost) {
            meHost = document.createElement('div');
            meHost.id = 'settings-tab-me';
            meHost.className = 'settings-tab-content';
            // 编辑器只用到 `panel.querySelector('#settings-tab-me')`，给个最小适配就够
            const fakePanel = { querySelector: (sel) => (String(sel).includes('settings-tab-me') ? meHost : null) };
            // ⚠️ 读 me.json **不动账户**：账户是绝对真源（在应用数据里），me.json 是它的派生；
            //    这一半留给"凭据 + 说明"（以及看一眼上次导出成什么样）—— 它不参与归认。
            meApi = createMeEditor(fakePanel, { toast: showToast });
        }
        meApi.activate();                 // 进这一页才去读（其余页一个字都不联网）
        meSlot.appendChild(meHost);
        out.push(meSlot);
        return out;
    }

    const accSlot = el('div', 'grid-column:1/-1;');
    accSlot.innerHTML = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
            <span style="font-size:13px;font-weight:600;color:#334155;">账户</span>
            <span style="font-weight:400;color:#94a3b8;font-size:11px;">（<b>这里是真源</b>：账户与映射都住在应用数据里，可撤回、随导出走）</span>
        </div>`;
    const expBtn = el('button', 'padding:5px 12px;font-size:12px;', '📤 写进 me.json（爬虫用）');
    expBtn.className = 'btn';
    expBtn.id = 'me-export-btn';
    expBtn.title = plain('把账户里的映射导成 me.json 的名册（team/byYear 那种形状）；凭据与说明原样保留');
    // ⚠️ 这一句是**可见文本**，`**派生**` 会原样漏出星号 ⇒ 过 `plain()`（去记号，不改字）
    const expHint = el('span', '', plain('me.json 是**派生**的：改了账户就再导一次。'));
    expHint.style.cssText = 'font-size:11px;color:#94a3b8;';
    const exportBar = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;');
    exportBar.appendChild(expBtn);
    exportBar.appendChild(expHint);
    accSlot.appendChild(exportBar);
    expBtn.addEventListener('click', async () => {
        const { openMeExport } = await import('./meExport.js');       // 懒加载：平时不拉这一块
        await openMeExport({ toast: showToast });
    });
    const accHost = document.createElement('div');
    accHost.id = 'settings-accounts-host';
    accSlot.appendChild(accHost);
    mountAccountsView(accHost);          // 编辑走应用数据（ops + 撤销），不写文件
    out.push(accSlot);

    return out;
}

// ================================================================
// 画页
// ================================================================

/**
 * 「🧬 性质注册表」那一栏：改的是磁盘上的 `acm-data/nature-registry.json`。
 *
 * 那是**规则文件**（`scripts/crate.py` 与 `core/natureFields.js` 都读它）——
 * 与 me.json 那一栏同一条边界：页面写不了磁盘 ⇒ 面板走本机主脚本的
 * `GET/PUT /api/nature-registry`，形状判据在服务器侧（`scripts/nature_registry_lib.py`）。
 *
 * ⚠️ 实例跨重画复用：草稿住在面板里，切到别的栏再回来**不该清空**（同 me 编辑器那条）。
 */
function natureRegistryCard() {
    const slot = el('div', 'grid-column:1/-1;');
    if (!nrHost) {
        nrHost = document.createElement('div');
        nrHost.id = 'settings-tab-nature';
        nrHost.className = 'settings-tab-content';
        nrPanel = createNatureRegistryPanel(nrHost, { toast: showToast });
    }
    nrPanel.activate();               // 进这一栏才去读（其余栏一个字都不联网）
    slot.appendChild(nrHost);
    return [slot];
}

/**
 * 「🧬 性质注册表」那一栏**先隐藏**。
 *
 * 用户 2026-10-15 看过之后："性质注册表(分类)基本是写死的 ⇒ 建议先隐藏"。
 * ⚠️ **代码一个都没删**：服务端（`GET/PUT /api/nature-registry` + `nature_registry_lib.py` 判据）、
 * 只读体检（`scripts/nature-registry-check.py`）、面板（`ui/settings/natureRegistryPanel.js`）
 * 与它的自测（`scripts/smoke/nature-registry.smoke.mjs`、`src/test/natureRegistryTree.test.js`）
 * 都还在 —— 分类词表真要动的时候，把这一个开关改回 `true` 就放出来了。
 */
const SHOW_NATURE_REGISTRY = false;

const SECTIONS = [
    { id: 'display', label: '🖥️ 显示' },
    { id: 'save', label: '💾 保存' },
    { id: 'performance', label: '⚡ 性能' },
    { id: 'stats', label: '📊 统计' },
    { id: 'intensity', label: '🏋️ 训练强度' },
    { id: 'me', label: '🔑 账户/名册' }
].concat(SHOW_NATURE_REGISTRY ? [{ id: 'nature', label: '🧬 性质注册表' }] : []);

/**
 * 切到设置页的某一栏（外部入口用：工具栏 👤 标记、导入摘要那条"直达账户面板"）。
 *
 * ⚠️ 调用方负责 `switchTab('settings')`：
 *    本模块**不 import tabs.js**（tabs.js 反过来 import 本模块，会成环）。
 *    顺序随便 —— 若本来不在这一页，`switchTab` 会按当前 `activeSection` 画；
 *    若已经在这一页，这里就已经画好了。
 */
export function setSettingsSection(sectionId, subId = '') {
    if (!SECTIONS.some((s) => s.id === sectionId)) return false;
    activeSection = sectionId;
    // 这一栏分「账户 / 名册」两页 —— 入口可以顺带指定停在哪一页
    if (sectionId === 'me' && ME_SUBS.some((s) => s.id === subId)) activeMeSub = subId;
    renderSettingsPage();
    return true;
}

/** 现在看的是「账户/名册」里的哪一页（给自测/排错用） */
export function currentMeSub() {
    return activeMeSub;
}

/** 现在看的是哪一栏（给自测/排错用） */
export function currentSettingsSection() {
    return activeSection;
}

/**
 * 画整个设置页。
 * @param {string} [containerId]
 * @returns {HTMLElement|null}
 */
export function renderSettingsPage(containerId = SETTINGS_CONTAINER_ID) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const redraw = () => { renderSettingsPage(containerId); };

    container.innerHTML = '';
    const page = el('div', 'padding:16px;');
    page.className = 'settings-page';
    container.appendChild(page);

    page.appendChild(el('h2', 'margin:0 0 4px;font-size:18px;', '⚙️ 设置'));
    const note = el('div', 'font-size:12px;color:#64748b;line-height:1.8;margin-bottom:12px;');
    note.innerHTML = '下面的都进<b>应用数据</b>（可撤回、会跟着导出走）；'
        + '<b>🔑 名册/凭据</b>那一栏改的是磁盘上的 <code>me.json</code>'
        + '（抓取脚本的配置，<b>不进历史、不能撤回</b>）。'
        + (SHOW_NATURE_REGISTRY
            ? '<br><b>🧬 性质注册表</b>那一栏改的是 <code>acm-data/nature-registry.json</code>'
              + '（抓取与产包侧读的<b>规则文件</b>，同样不进历史；它在 git 里 —— '
              + '改坏了 <code>git checkout</code> 能回来）。'
            : '');
    page.appendChild(note);

    // ---- 二级栏 ----
    const bar = el('div', 'display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid #eef2f6;padding-bottom:8px;margin-bottom:14px;');
    for (const sec of SECTIONS) {
        const btn = el('button', 'padding:5px 12px;font-size:13px;', sec.label);
        btn.className = sec.id === activeSection ? 'btn btn-primary' : 'btn';
        btn.dataset.section = sec.id;
        btn.addEventListener('click', () => {
            if (activeSection === sec.id) return;
            activeSection = sec.id;
            redraw();                       // 切栏**不清草稿**（草稿在 `draft` / me 编辑器里）
        });
        bar.appendChild(btn);
    }
    page.appendChild(bar);

    // ---- 当前那一栏 ----
    const body = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;align-items:start;');
    body.className = 'settings-body';
    let cards = [];
    if (activeSection === 'save') cards = saveCards(redraw);
    else if (activeSection === 'performance') cards = performanceCards();
    else if (activeSection === 'stats') cards = statsCards();
    else if (activeSection === 'intensity') cards = intensityCards(redraw);
    else if (activeSection === 'me') cards = meCard();
    else if (SHOW_NATURE_REGISTRY && activeSection === 'nature') cards = natureRegistryCard();
    else cards = displayCards();
    for (const c of cards) body.appendChild(c);
    page.appendChild(body);

    // ---- 底部 ----
    const foot = el('div', 'display:flex;gap:8px;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid #eef2f6;');
    const saveBtn = el('button', 'padding:7px 16px;font-size:13px;', '💾 保存设置');
    saveBtn.className = 'btn btn-primary';
    saveBtn.id = 'settings-save-btn';
    const resetBtn = el('button', 'padding:7px 16px;font-size:13px;', '↻ 放弃改动');
    resetBtn.className = 'btn';
    resetBtn.id = 'settings-reset-btn';
    const stateHint = el('span', 'font-size:12px;margin-left:auto;', dirty ? '⏳ 有未保存的改动' : '与已保存的一致');
    stateHint.id = 'settings-state-hint';
    stateHint.style.color = dirty ? '#b45309' : '#94a3b8';
    foot.appendChild(saveBtn);
    foot.appendChild(resetBtn);
    foot.appendChild(stateHint);
    page.appendChild(foot);

    // 输入 → 草稿（`data-setting` 就是草稿的键）
    const onInput = (ev) => {
        const t = ev.target;
        if (!t || !t.dataset) return;
        if (t.name === 'count-mode') draft.countMode = t.value;
        // ⚠️ 复选框读的是 `.checked`，不是 `.value`（`value` 恒为 `"on"`）——
        //    写成 `draft[x] = t.value` 会让"取消勾选"变成 `"on"`（存成真值），永远关不掉。
        else if (t.dataset.setting && t.type === 'checkbox') draft[t.dataset.setting] = !!t.checked;
        else if (t.dataset.setting) draft[t.dataset.setting] = t.value;
        else return;                        // me.json 编辑器里的控件不算（它自己记账）
        dirty = true;
        stateHint.textContent = '⏳ 有未保存的改动';
        stateHint.style.color = '#b45309';
    };
    body.addEventListener('input', onInput);
    body.addEventListener('change', onInput);

    resetBtn.addEventListener('click', () => {
        if (!dirty) { showToast('没有未保存的改动', 'success'); return; }
        draft = {};
        dirty = false;
        redraw();
        showToast('已放弃未保存的改动', 'success');
    });
    saveBtn.addEventListener('click', () => saveSettings(redraw));

    return page;
}

/** 这一页有未保存的东西吗（含 me.json 编辑器与性质注册表那两半）——`tabs.js` 靠它决定要不要重画 */
export function isSettingsDirty() {
    return dirty
        || !!(meApi && meApi.dirty && meApi.dirty())
        || !!(nrPanel && nrPanel.dirty && nrPanel.dirty());
}

/**
 * 用户正要离开这一页：磁盘文件那两半（me.json / 性质注册表）有草稿就提醒一句
 * （草稿仍留在内存里，重进还在）。
 */
export function warnSettingsLeave() {
    if (meApi && meApi.dropIfDirty) meApi.dropIfDirty();
    if (nrPanel && nrPanel.dirty && nrPanel.dirty()) {
        showToast('性质注册表的改动没保存（重新打开设置还在）', 'error');
    }
}

// ================================================================
// 保存
// ================================================================

/**
 * 校验 + 落库。
 *
 * ⚠️ 值只从 `valuesOf()` 来（**不读 DOM**）：用户可能改了「显示」栏、切到「性能」
 *    再点保存，那时前者压根不在 DOM 里。校验规则与弹窗时代逐条一致
 *    （它们管的是"这个值合不合法"，与壳子无关）。
 */
async function saveSettings(redraw) {
    const v = valuesOf();
    const num = (key) => parseInt(v[key], 10);

    const interval = num('autoSaveInterval');
    if (isNaN(interval) || interval < 1 || interval > 120) { showToast('自动保存间隔要 1~120 之间的整数', 'error'); return; }
    const boxCount = num('boxCount');
    if (isNaN(boxCount) || boxCount < 1 || boxCount > 200) { showToast('方块数量必须为 1~200 之间的整数', 'error'); return; }
    const nodePerPage = num('nodePerPage');
    if (isNaN(nodePerPage) || nodePerPage < 1) { showToast('每页节点数必须为正整数', 'error'); return; }
    const l1 = num('l1');
    const l2 = num('l2');
    if (isNaN(l1) || l1 < 1 || isNaN(l2) || l2 < 1) { showToast('L1 和 L2 必须为正整数', 'error'); return; }
    const root = AppState.nodes[AppState.rootId];
    const rootChildrenCount = root ? AppState.childOrder[root.id].length : 0;
    if (l2 < rootChildrenCount) {
        showToast(`L2 不能小于根节点直接子节点数（当前为 ${rootChildrenCount}）`, 'error');
        return;
    }
    const historySteps = num('historySteps');
    if (isNaN(historySteps) || historySteps < 1 || historySteps > MAX_HISTORY_STEPS) {
        showToast(`历史步数必须为 1~${MAX_HISTORY_STEPS} 之间的整数`, 'error');
        return;
    }
    /** 只认白名单里的值（枚举项传什么都不写脏数据） */
    const pick = (key, allowed, fallback) => (allowed.includes(v[key]) ? v[key] : fallback);

    // ★ **AC 时间规则**（`v9.1.21`；`v9.1.26` 起多第 4 种 `cutoffIgnore`）：选了**带截断**的规则
    //   就必须给一个 8/12/14 位的截断值。
    //   这里**报错、不静默退回**（`acTimeRuleOf` 那份兜底是给"存档里就是坏值"用的，
    //   不该把"用户忘了填"也变成悄悄换成另一条规则）。
    const acRule = pick('acTimeRule', AC_TIME_RULES, DEFAULT_AC_TIME_RULE);
    const acCutoffRaw = String(v.acTimeCutoff || '').trim();
    const acCutoff = normalizeAcTimeCutoff(acCutoffRaw);
    // ⚠️ "要不要截断值"只有这一处判据：**两个带截断的规则**都要（别只写 `cutoff`，
    //    第 4 种同样靠它 —— 漏了就会把没填值的规则悄悄存进去）
    const acNeedsCutoff = (acRule === 'cutoff' || acRule === 'cutoffIgnore');
    if (acNeedsCutoff && !acCutoff) {
        showToast('选了「截断时间」就要填一个 8 / 12 / 14 位的数字（例：20260101）', 'error');
        return;
    }
    // 规则/截断值真的变了吗？（变了才重算缓存 —— 见下面 draft 里那段）
    const acRuleChanged = acRule !== (AC_TIME_RULES.includes(String(AppState.settings.acTimeRule || ''))
            ? AppState.settings.acTimeRule : DEFAULT_AC_TIME_RULE)
        || (acNeedsCutoff && acCutoff !== normalizeAcTimeCutoff(AppState.settings.acTimeCutoff));

    try {
        await execute(
            (draftState) => {
                draftState.settings.autoSave.autoSaveInterval = interval;
                draftState.settings.display.boxCount = boxCount;
                draftState.settings.display.nodePerPage = nodePerPage;
                draftState.settings.performance.expandedNodeWarningLimit = l1;
                draftState.settings.performance.expandedNodeBlockLimit = l2;
                draftState.settings.performance.historySteps = historySteps;
                draftState.settings.autoSave.autoExportMode =
                    pick('autoExportMode', ['main', 'full'], AppState.settings.autoSave.autoExportMode || 'full');
                draftState.settings.mode.treeDisplayMode =
                    pick('treeDisplayMode', ['tree', 'folder'], AppState.settings.mode.treeDisplayMode || 'tree');
                draftState.settings.mode.editMode =
                    pick('editMode', ['attribute', 'selection'], AppState.settings.mode.editMode || DEFAULT_EDIT_MODE);
                draftState.settings.display.boxDisplayMode =
                    pick('boxDisplayMode', ['cf', 'xcpc'], AppState.settings.display.boxDisplayMode || DEFAULT_BOX_DISPLAY_MODE);
                setSetting(draftState, 'stats.countMode',
                    pick('countMode', [MODE_PLAIN, MODE_DEDUP], resolveCountMode(AppState.settings)));

                // ★ **题目 AC 时间规则**（`v9.1.21`）—— 它是**唯一一条会改到"已物化缓存字段"**的设置：
                //   `node.acTime` 是 `autoCompute` 按规则写下来的缓存值，改了规则不重算的话
                //   缓存与派生表就是**两个答案**（仓里反复踩过这个坑）。
                //   ⇒ 在**同一个事务**里重算（这样只有一步撤销、也不会出现中间态）。
                //   代价：只扫 P 一层（不是 `fullAutoUpdate` 那种整棵树全字段重算）。
                setSetting(draftState, 'acTimeRule', acRule);
                // ★ 截断值**照存**，即使当前规则用不到它（用户 2026-10-13："希望截断时间不要随模式切换丢失"）：
                //   原来写的是 `acNeedsCutoff ? acCutoffRaw : ''` ⇒ 切到"取最早/取最晚"一存就把截断值抹了，
                //   再切回带截断的规则时得重填一遍（实测症状：截断值"消失"）。
                //   ⚠️ 留着没有副作用：`acTimeRuleOf` 对不带截断的规则**根本不读它**（只读 `rule`），
                //   而"选了带截断的规则却没填"照样在上面报错不落库。
                setSetting(draftState, 'acTimeCutoff', acCutoffRaw);
                if (acRuleChanged) recomputeAcTime(draftState);

                // ★ 查看范围要不要带上直接子账户（默认关 = 原逻辑）。**不用重算任何缓存**：
                //   它只影响"取哪一份"，两张表都按范围/账户记忆化（改了这个设置 ⇒ `scopeOpts` 的
                //   记忆化键里就有 `settings` 与 `accounts`，自然作废）。
                setSetting(draftState, 'scopeMergeChildren', !!v.scopeMergeChildren);

                // ★ 逐字段"取哪一份"（**只存偏离默认的项**；收法甲：覆盖只在判重模式下生效）
                const fieldColumn = {};
                for (const f of columnFields()) {
                    const p = v['col_' + f];
                    if (p === 'own' || p === 'group') fieldColumn[f] = p;
                }
                draftState.settings.display.fieldColumn = fieldColumn;

                // nodePerPage 变了 ⇒ 所有节点的当前页码重置（分页口径跟着变）
                const oldNodePerPage = AppState.settings.display.nodePerPage ?? DEFAULT_NODE_PER_PAGE;
                if (nodePerPage !== oldNodePerPage) {
                    resetPagination(draftState);
                    for (const pid in draftState.pages) {
                        const pageObj = draftState.pages[pid];
                        for (const vId in pageObj.virtualIndex) pageObj.virtualIndex[vId].currentPage = 1;
                    }
                }
                // L2 调小到低于"现在要画的节点数" ⇒ 全折叠（否则画出来就超限）
                const currentRenderCount = getCurrentRenderedCount(draftState, nodePerPage);
                if (l2 < currentRenderCount) {
                    // 全折叠 = 稀疏表清空（视图态不住在节点上）
                    draftState.view = { ...(draftState.view || {}), expanded: {} };
                }
            },
            {
                validate: false,
                refreshParentId: null,
                onSuccess: () => {
                    draft = {};
                    dirty = false;
                    // ★ AC 时间规则变了 ⇒ 把派生表 / 计数缓存也丢掉（`clearDerivedMemo` 会连计数一起清）。
                    //   正常路径上事务换了 `nodes` 引用、缓存本来就会自然作废；这里是**保险**：
                    //   "设置变了但数据没变"的那一类改动最容易被缓存漏掉（症状是"改了没反应"）。
                    if (acRuleChanged) {
                        try { clearDerivedMemo(); } catch (_) { /* 缓存清理失败不该挡保存 */ }
                    }
                    showToast('设置已保存', 'success');
                    document.dispatchEvent(new CustomEvent('settings-saved'));
                    redraw();
                },
                onError: (err) => { showToast('保存设置失败: ' + err.message, 'error'); }
            }
        );
    } catch (_) {
        // onError 已处理
    }
}

/**
 * 只给自测/排错用：把模块级小状态清干净。
 *
 * 这一页的状态活在模块作用域里（草稿 / 当前栏 / me 编辑器实例），
 * 同一个进程里跑两遍用例会互相串味 —— 测试需要它，生产代码不调。
 */
export function __resetSettingsPageState() {
    activeSection = 'display';
    resetIntensitySection();
    activeMeSub = 'accounts';
    draft = {};
    dirty = false;
    meHost = null;
    meApi = null;
}
