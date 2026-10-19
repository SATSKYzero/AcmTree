// ================================================================
// 记录表（features/AutoImport/ui/recordTable.js）
//
// 逐条记录的预览表（动作/类型/标识/标题/变化/操作）。
// ================================================================
import { titleOf, shortValue } from './kit.js';
import { natureDiffOf } from './summary.js';
import { ACTION } from '../plan.js';
import { escapeHtml as esc } from '../../../utils/html.js';

/**
 * 「操作」那一格：🔎 跳到树上 + 📋 打开详页。
 *
 * ★ **树上 id 是 plan 里现成的**：`rec.nodeId` / `s.nodeId` = `existing ? existing.id : null`
 *   （`plan.js` / `plan/synthNodes.js`）—— 不新查、不新造。
 *   **新增行（树上还没有这个节点）拿到的是 `null` ⇒ 这一格只有一个「—」**：
 *   画成可点就是"点了没反应的假链接"，比纯文字更糟。
 *
 * ⚠️ 插件**不 import `ui/`**（`src/features/AGENTS.md` 的不变量）⇒ 这里只**写属性**：
 *    · `data-reveal-node` 由 `ui/nodeinfo/nodeGroupActions.js` 的**文档级**委托接住；
 *    · `btn-node-info[data-id]` 由 `ui/G_events.js` 的**文档级**委托接住 `openNodeInfoTab`。
 *   两者都只有一份实现，见 `docs/node-navigation.md` 第 5 节。
 *   ⚠️ 「文档级委托接得住」是有前提的（`v9.0.15` 修）：这张表在**文件夹视图**里会被挂进
 *      `#tree-container`，而那条委托原先用 `closest('#tree-container')` 把整个树容器拒收了 ——
 *      于是行上的 📋 只剩容器上 `onActionClick` 那条接（它认逗号选择器，DOM 桩不解析）⇒ 桩里点了没反应。
 *      现在那条排除只留 `.node-box` **自己那颗**。
 * ⚠️ 属性挂在**这一格里的元素**上，别挂到整行：那颗 📋 也在行内，挂整行会让点 📋
 *    同时触发"跳树"（两条文档级委托都会命中）。
 */
function entryCellHtml(nodeId) {
    const id = String(nodeId || '').trim();
    if (!id) return '<td style="padding:5px 8px; color:#cbd5e1;">—</td>';
    return '<td class="ai-record-entry" style="padding:5px 8px; white-space:nowrap;">'
        + `<a class="ai-record-goto" data-reveal-node="${esc(id)}" href="#" `
        + 'title="在树上定位并高亮这个节点" '
        + 'style="margin-right:6px; color:#1d4ed8; text-decoration:underline;">🔎</a>'
        + `<button type="button" class="btn-icon btn-node-info ai-record-info" data-id="${esc(id)}" `
        + 'title="打开这个节点的详页（与树上那个 📋 是同一件事）" '
        + 'style="font-size:12px; padding:0 6px; cursor:pointer;">📋</button>'
        + '</td>';
}

// ================================================================
// ★ 默认只画前 N 行（`v9.0.18`）
//
// 为什么：一次导入动辄两万多条记录（真包 27408 条），全量铺满时
//   HTML 是**十几 MB**、标签**十几万个**（用户报的实测：30.6MB / 49.3 万；
//   本机探针用真实 crate 记录在同一把尺子下量到 17.5MB / 19.2 万 —— 差异来自记录样本），
//   而外面那层框只有 `max-height:420px` ⇒ 绝大多数行**永远不会被看到**，
//   却要在每次渲染时全部建出来。
// 做法照仓里已有的先例 `features/AutoImport/ui/failures.js`（`list.slice(0, LIMIT)`
//   + 一句"还有 N 条"），这里多给一个**显式**的「显示全部」按钮（点了才付那笔开销）。
//
// N = 250 的理由：默认视口 420px / 每行约 27px ≈ 能看 15 行，250 行已是**十几屏**
//   （够覆盖"我这一包到底动了什么"的抽查），同时把开销压到 **1/100** 量级
//   （实测 27408 行 → 250 行：HTML 17.5MB → 0.2MB、标签 19.2 万 → 1759）；
//   再往上就只是把用户看不见的行重新铺一遍。
// ⚠️ 这是**纯显示**上限：计数、`view.natureOnly`、要写入的内容一个字不变。
// ================================================================
export const AI_RECORD_LIMIT = 250;

/** 是否已经点过「显示全部」（跨重画保留；换一个包时由 `resetRecordTableLimit()` 复位） */
let showAllRecords = false;

/** 换包 / 重新载入时复位（「显示全部」是一次性的动作，不该悄悄跨批次留着） */
export function resetRecordTableLimit() {
    showAllRecords = false;
}

export function renderRecordTable(container, plan, opts = {}) {
    const onlyNature = !!opts.natureOnly;
    const synthRowsAll = (plan.synth && plan.synth.nodes) || [];
    const rowsAll = plan.records || [];
    // 「只看性质不一致」：只影响**画出来的行**（计数、执行内容一个字不变 —— 这不是筛选导入范围）
    // ⚠️ 两处都 **`.slice()`**：`onlyNature` 为假时那两条就是 `plan.records` / `plan.synth.nodes`
    //    本体，直接 sort 会**就地打乱 plan**（执行顺序跟着变）—— 一定先拷一份。
    const recRows = (onlyNature ? rowsAll.filter(r => (r.natureDiff || []).length) : rowsAll).slice();
    const synthRows = (onlyNature ? synthRowsAll.filter(r => (r.natureDiff || []).length) : synthRowsAll).slice();
    // ★ **跳过的行一律排到最后**（`Array.prototype.sort` 稳定：同组内保持原来的顺序）。
    //   为什么：这张表是"这一包会动什么"的清单，而实测一次导入是 **24712 条跳过 + 0 条新增**，
    //   跳过的排在前面 ⇒ 真正要看的那几行被埋在几万行里（用户："希望底下的列表把跳过放最后"）。
    //   ⚠️ 只改**画出来的顺序**，不碰 `plan` 本身（执行内容、计数一个字不变）。
    const lastIfSkip = (a, b) => (a.action === ACTION.SKIP ? 1 : 0) - (b.action === ACTION.SKIP ? 1 : 0);
    recRows.sort(lastIfSkip);
    synthRows.sort(lastIfSkip);
    if (!recRows.length && !synthRows.length) {
        if (onlyNature) {
            const none = document.createElement('div');
            none.className = 'ai-nature-only-empty';
            none.style.cssText = 'margin-top:8px; font-size:12px; color:#94a3b8;';
            none.textContent = '没有"性质不一致"的记录。';
            container.appendChild(none);
        }
        return;
    }

    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px; max-height:420px; overflow:auto;';

    const table = document.createElement('table');
    table.style.cssText = 'width:100%; border-collapse:collapse; font-size:13px;';
    table.innerHTML = `<thead><tr style="background:#f8fafc; color:#475569; font-size:12px; position:sticky; top:0;">
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">动作</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">类型</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">extKey</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">名称</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">将写入字段</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">性质</th>
        <th style="text-align:left; padding:6px 8px; border-bottom:1px solid #e2e8f0;">操作</th>
    </tr></thead>`;

    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    // 先插表、再填行：下面 `renderRows()` 会把「还有 N 行」那一句接在**表下面**
    wrap.appendChild(table);

    // ---- 按「画出来的顺序」把两段拼成**一条**清单的下标空间：[普通记录…] + [合成节点行…] ----
    // 合成节点记录**不在** `plan.records` 里（它们没有 extKey，走两阶段通道），
    // 但它们是这次导入要建/要改的真节点 —— 不列出来，用户就得靠猜。
    // ★ 两段必须是**一条**清单再切前 N 行：否则"限 250 行"会变成"两处各限 250 行"。
    // ★ 而且**先切、再建**（2026-10-13 真包实测后改的）：以前是 `recRows.map(recordRow)`
    //   先把**所有**行 `createElement` 出来、再 `slice` 前 N 行挂上去 —— 限行只省了"挂"，
    //   建行那一段照付。真包实测（`scripts/recordtable-bench.mjs`）：27408 行全量建 ≈72ms，
    //   而"只有 250 行"的对照 ≈0ms ⇒ **99% 的钱花在"建"上**。
    //   现在只有要显示的那几行会被建；点「显示全部」时才把剩下的建出来。
    const recCount = recRows.length;
    const total = recCount + synthRows.length;
    /** 第 i 行（0 起）：先普通记录、后合成节点 —— 两段共用同一个下标空间 */
    const rowAt = (i) => (i < recCount ? recordRow(recRows[i]) : synthRow(synthRows[i - recCount]));

    function renderRows() {
        tbody.innerHTML = '';
        const shownCount = showAllRecords ? total : Math.min(AI_RECORD_LIMIT, total);
        for (let i = 0; i < shownCount; i++) tbody.appendChild(rowAt(i));

        if (foot) foot.remove();
        const hidden = total - shownCount;
        if (hidden > 0) {
            foot = document.createElement('div');
            foot.className = 'ai-record-foot';
            foot.style.cssText = 'margin:6px 2px; font-size:12px; color:#94a3b8; display:flex; align-items:center; gap:10px;';
            const note = document.createElement('span');
            note.textContent = `还有 ${hidden} 行未显示（默认只画前 ${AI_RECORD_LIMIT} 行；共 ${total} 行）`;
            foot.appendChild(note);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn ai-record-show-all';
            btn.textContent = `显示全部 ${total} 行（行数多时页面会卡）`;
            btn.addEventListener('click', () => {
                showAllRecords = true;
                renderRows();
            });
            foot.appendChild(btn);
            wrap.appendChild(foot);
        } else {
            foot = null;
        }
    }

    let foot = null;
    renderRows();
    container.appendChild(wrap);
}

/** 动作 → 文案/颜色（普通记录） */
const ACTION_STYLE = {
    [ACTION.CREATE]: { text: '＋ 新增', color: '#16a34a' },
    [ACTION.UPDATE]: { text: '↻ 更新', color: '#2563eb' },
    [ACTION.SKIP]: { text: '＝ 跳过', color: '#94a3b8' }
};

/** 动作 → 文案/颜色（合成节点） */
const SYNTH_STYLE = {
    create: { text: '＋ 新建合成', color: '#7c3aed' },
    update: { text: '↻ 更新合成', color: '#7c3aed' },
    skip: { text: '＝ 跳过合成', color: '#94a3b8' }
};

/** 一条普通记录行 */
function recordRow(rec) {
    const base = ACTION_STYLE[rec.action] || { text: rec.action, color: '#475569' };
    // 「会换父」的行加个 🔀（悬停看从哪到哪）—— 结构改动不该藏在"更新"里看不出来
    const style = rec.move
        ? {
            text: `${base.text} 🔀`,
            color: base.color,
            title: `换父：${rec.move.fromName || rec.move.from} → ${rec.move.toName || rec.move.to}`
        }
        : base;
    const tr = document.createElement('tr');
    tr.className = 'ai-record-row';
    tr.dataset.extkey = rec.extKey;
    tr.dataset.action = rec.action;
    if (rec.move) tr.dataset.move = '1';

    const fieldNames = Object.keys(rec.fields || {});
    const fieldText = fieldNames.length === 0
        ? '—'
        : fieldNames.map(f => `${f}=${shortValue(rec.fields[f])}`).join(', ');

    const diff = natureDiffOf(rec);
    if (diff) tr.dataset.naturediff = '1';

    tr.innerHTML = `
        <td style="padding:5px 8px; color:${style.color}; white-space:nowrap; font-weight:600;"
            ${style.title ? `title="${esc(style.title)}"` : ''}>${esc(style.text)}</td>
        <td style="padding:5px 8px; color:#475569;">${esc(rec.type)}</td>
        <td style="padding:5px 8px; color:#64748b; font-family:monospace; font-size:12px;">${esc(rec.extKey)}</td>
        <td style="padding:5px 8px; color:#334155;">${esc(titleOf(rec))}</td>
        <td style="padding:5px 8px; color:#64748b;">${esc(fieldText)}</td>
        <td class="ai-record-nature" style="padding:5px 8px; white-space:nowrap; color:${diff ? '#b45309' : '#cbd5e1'};"
            ${diff ? `title="${esc(diff.title)}"` : ''}>${diff ? `⚠️ ${esc(diff.short)}` : '—'}</td>
        ${entryCellHtml(rec.nodeId)}
    `;
    return tr;
}

/** 一条合成节点行 */
function synthRow(s) {
    const style = SYNTH_STYLE[s.action] || { text: s.action, color: '#475569' };
    const tr = document.createElement('tr');
    tr.className = 'ai-record-row ai-synth-row';
    tr.dataset.synthkey = s.synthKey;
    tr.dataset.action = s.action;

    const fieldNames = Object.keys(s.fields || {});
    const fieldText = fieldNames.length === 0
        ? '—'
        : fieldNames.map(f => `${f}=${shortValue(s.fields[f])}`).join(', ');

    const diff = natureDiffOf(s);
    if (diff) tr.dataset.naturediff = '1';

    tr.innerHTML = `
        <td style="padding:5px 8px; color:${style.color}; white-space:nowrap; font-weight:600;">${esc(style.text)}</td>
        <td style="padding:5px 8px; color:#475569;">${esc(s.type)}</td>
        <td style="padding:5px 8px; color:#7c3aed; font-family:monospace; font-size:12px;">${esc(s.synthKey)}</td>
        <td style="padding:5px 8px; color:#334155;">（合成节点）</td>
        <td style="padding:5px 8px; color:#64748b;">${esc(fieldText)}</td>
        <td class="ai-record-nature" style="padding:5px 8px; white-space:nowrap; color:${diff ? '#b45309' : '#cbd5e1'};"
            ${diff ? `title="${esc(diff.title)}"` : ''}>${diff ? `⚠️ ${esc(diff.short)}` : '—'}</td>
        ${entryCellHtml(s.nodeId)}
    `;
    return tr;
}
