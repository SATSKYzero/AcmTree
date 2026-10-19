// ================================================================
// 体检 / 需求页（ui/coverage/coveragePage.js）
//
// **体检报告能在应用里看**（不必去 `acm-data/reports/` 读 JSON/MD）。
//
// 数据来源 = **包顶层 `reports`**（`scripts/crate-merge.mjs` 把两份报告塞进 `all_nodes.json`，
// 导入时 `features/AutoImport/{parse,apply}.js` 存进 `AppState.reports`，`persistence/` 持久化）。
// ⇒ 这一页**不联网、不跑脚本、只读状态**。
//
// 位置：一级 Tab（`index.html` 的静态按钮 + `#tab-coverage`，与「🧩 判重整理」「⚙️ 设置」
// 同一套路：内容运行时画，见 `ui/tabs.js` 的 `refreshCoveragePage`）。
//
// 四栏（一次只画一栏；栏名带条数）：
//   ① 🩺 小结   —— 页头那句结论 + 与上次比（deltas）+ 缺得最多的几行 + 最划算的几条需求；
//   ② 📋 原料需求 —— 每条 = 一张卡片（**联网**动作 + 命令 + 为什么 + 样例）；
//   ③ ✅ 字段体检 —— 每行 = 一个「类型 × 字段」：应有 / 适用 / 已填 / **缺** / **豁免** /
//      **多半拿不到**（与前三档并列，**不算缺**）+ 理由；可切"只看缺"。
//   ④ 🔁 同组不一致 —— 同一场比赛里有的题填了、有的没填的组（**分页 25 组**，DOM 只画当前页）。
//
// ⚠️ 报告**可能没有**（老包 / 裁剪包 / 还没导入过带报告的包）：整页换成一句"重建一次包就有"，
//    **不报错、不假装空表**（空表会被读成"一个都不缺"，那是另一种错）。
//
// ⚠️ 口径只有一份：判定在 `scripts/field-coverage.py` / `scripts/material-needs.py` 里，
//    这一页照着念；`core/coverage.js` 只负责排序/分页/小结（纯函数，有单测）。
// ================================================================
import { AppState } from '../../shell/state.js';
import {
    hasReports,
    summarizeCoverage,
    summarizeNeeds,
    groupNeedsByFix,
    uniqueProse,
    pageGroups,
    coverageVerdict,
    expectLabel,
    expectColor,
    plainProse,
    fmtNum,
    GROUP_PAGE_SIZE,
    NEED_SAMPLE_LIMIT
} from '../../core/coverage.js';
import { showToast } from '../G_modal/G1_toast.js';
import { num } from '../../utils/guards.js';
import { mk } from '../../utils/dom.js';
import { escapeHtml as escHtml } from '../../utils/html.js';
// ★ 异常报告走**统一模板**（与判重整理 ⑤、节点自动导入同一套）
import { renderSections, setStageOpen, isStageOpen } from '../kit/report.js';

/** 画进哪个容器（index.html 里的静态 `#tab-coverage`） */
export const COVERAGE_TAB_ID = 'coverage';
export const COVERAGE_CONTAINER_ID = 'tab-coverage';

// ---- 模块级小状态（翻页只重画，不清筛选） ----
//: 最后打开过的一栏（四栏都能折叠了，这个只给自测/排错答"最后打开的是哪个"）
let lastSection = 'summary';
let groupPage = 1;
/** 字段体检表：只看缺的行吗（默认看全部 —— 29 行本来就看得完，"全绿"这件事也要能看见） */
let fieldsOnlyMissing = false;

const CARD = 'background:#fff;border:1px solid #eef2f6;border-radius:10px;padding:14px 16px;';
const HINT = 'font-size:11px;color:#94a3b8;line-height:1.6;';
const TABLE = 'width:100%;border-collapse:collapse;font-size:12px;';
// ⚠️ 表头与那几个短列都要 `nowrap`：不然窄列会把两字词**逐字换行**（"可有可无"竖成四行、
//    "类型"竖成两行）—— 不 nowrap 就是这样，看着像坏了。
const TH = 'text-align:left;padding:5px 8px;border-bottom:1px solid #e2e8f0;color:#475569;'
    + 'font-weight:600;background:#f8fafc;position:sticky;top:0;white-space:nowrap;';
const TD = 'padding:5px 8px;border-bottom:1px solid #f1f5f9;color:#334155;vertical-align:top;';
/** 短列（类型/字段/档位/数字）不许换行 —— 只给"为什么这么定"那种长文本留换行 */
const TD_NOWRAP = TD + 'white-space:nowrap;';
/** 把一段文本复制到剪贴板（命令要能直接粘到终端里；失败就退回"手动选中"） */
async function copyText(text, okMsg = '已复制') {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showToast(okMsg, 'success');
            return true;
        }
    } catch (_) { /* 落到下面的兜底 */ }
    // ⚠️ 兜底那半在 DOM 桩里跑不动（没有 `execCommand`）：这是**预期**的 ——
    //    冒烟测试只断言"命令显示出来了、点了不炸"，不断言真能进剪贴板。
    if (typeof document.execCommand !== 'function') {
        showToast('这个环境不能自动复制，请手动选中命令', 'error');
        return false;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    showToast(ok ? okMsg : '复制失败，请手动选中文本', ok ? 'success' : 'error');
    return ok;
}

/** 一条"命令 + 复制"的行（需求卡片与小结里都要用，别写两遍） */
function commandRow(command, okMsg = '已复制') {
    const row = mk('div', 'cov-command', 'display:flex;gap:6px;align-items:flex-start;margin-top:6px;');
    const code = mk('code', '', 'flex:1;min-width:0;background:#0f172a;color:#e2e8f0;padding:6px 8px;'
        + 'border-radius:6px;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;', command);
    row.appendChild(code);
    const btn = mk('button', 'btn cov-copy-btn', 'padding:4px 10px;font-size:11px;flex:0 0 auto;', '📋 复制');
    btn.addEventListener('click', () => copyText(command, okMsg));
    row.appendChild(btn);
    return row;
}

// ================================================================
// ① 小结
// ================================================================

function summarySection(rep) {
    const s = summarizeCoverage(rep);
    const n = summarizeNeeds(rep);
    const box = mk('div', 'cov-summary');

    // ---- 页头那句结论（"一眼看到底"，与页头重复一次是有意的：切栏回来也看得见）----
    const line = mk('div', CARD, 'font-size:13px;color:#334155;line-height:1.9;');
    // ⚠️ 这句是**构建侧写的散文**（带 `**` 强调记号）⇒ 落界面前必须去记号：
    //    以前只有"小结那一栏是当前栏"时才画它，漏出来没人发现；四栏改成折叠之后
    //    **四栏的内容一直在 DOM 里**，它就露到页面上了（冒烟里那条"不许漏 `**`"逮到的）。
    line.innerHTML = `<b style="font-size:14px;">结论</b><br>${plainProse(coverageVerdict(rep))}`;
    box.appendChild(line);

    // ---- 与上次比（构建侧的 `deltas`：同一份注册表下变差/变好）----
    if (s) {
        const d = mk('div', CARD, 'margin-top:10px;font-size:12px;color:#334155;line-height:1.9;');
        const worse = s.deltas.worse.length;
        const better = s.deltas.better.length;
        d.innerHTML = `<b>与上次体检比</b>：`
            + (worse ? `<span style="color:#b91c1c;">变差 ${worse} 项</span>` : '<span style="color:#15803d;">没有变差</span>')
            + ' · '
            + (better ? `<span style="color:#15803d;">变好 ${better} 项</span>` : '没有变好');
        // ⚠️ 这句里有反引号（是**给开发者看的字段名**）⇒ 落界面前要过 `plainProse`：
        //    以前只有"小结那一栏是当前栏"时才画它，所以漏出来没人发现；
        //    四栏改成折叠之后**四栏的内容一直在 DOM 里**，它就露到页面上了。
        if (!worse && !better) d.appendChild(mk('div', '', HINT, plainProse('（`deltas` 为空：上没有可比的上一次，或这一轮没有变化。）')));
        if (worse) d.appendChild(listOfItems(s.deltas.worse, '#b91c1c'));
        if (better) d.appendChild(listOfItems(s.deltas.better, '#15803d'));
        const meta = mk('div', '', HINT + 'margin-top:6px;');
        meta.textContent = `包：${s.package || '—'} · 记录 ${fmtNum(s.records)} 个 · `
            + `注册表版本 ${s.registryVersion === null ? '—' : s.registryVersion} · 体检 ${s.rowsTotal} 行 · `
            + `豁免 ${fmtNum(s.exempt)} 格（"本来就不适用"，不是缺）`;
        d.appendChild(meta);
        box.appendChild(d);
    }

    // ---- 缺得最多的几行 ----
    if (s && s.missingRows.length) {
        const c = mk('div', CARD, 'margin-top:10px;');
        const head = mk('div', '', 'font-size:13px;font-weight:600;color:#334155;margin-bottom:2px;');
        head.textContent = `该看哪些行（前 ${Math.min(6, s.missingRows.length)} 行 / 共 ${s.missingRows.length} 行有缺）`;
        c.appendChild(head);
        // ⚠️ 排序是「真缺 → 应该有 → 可有可无」，同档内按缺得多少 ——
        //    否则 tags/ratio 那种"可有可无"的大数会把该补的 clistDifficulty 挤出去。
        c.appendChild(mk('div', '', HINT + 'margin-bottom:6px;',
            `排序：必须有 → 应该有 → 可有可无（同档按缺得多少）。`
            + `上面那句小结里的"真缺 / 应该有而缺"才是待办，"可有可无而缺"只是记账。`));
        const table = mk('table', 'cov-table', TABLE);
        table.innerHTML = `<thead><tr><th style="${TH}">类型 · 字段</th><th style="${TH}">应有</th>`
            + `<th style="${TH}">缺</th><th style="${TH}">占适用</th></tr></thead>`;
        const tb = mk('tbody');
        for (const r of s.missingRows.slice(0, 6)) {
            const tr = mk('tr');
            tr.innerHTML = `<td style="${TD_NOWRAP}"><b>${r.type}</b> · ${r.field}</td>`
                + `<td style="${TD_NOWRAP};color:${expectColor(r.expect)};">${expectLabel(r.expect)}</td>`
                + `<td style="${TD_NOWRAP};color:#b91c1c;">${fmtNum(r.missing)}</td>`
                + `<td style="${TD_NOWRAP};color:#94a3b8;">${r.applies ? Math.round(num(r.missing) / num(r.applies) * 100) : 0}%</td>`;
            tb.appendChild(tr);
        }
        table.appendChild(tb);
        c.appendChild(table);
        const go = mk('button', 'btn', 'margin-top:8px;padding:4px 10px;font-size:12px;', '✅ 去「字段体检」看全部 29 行');
        go.addEventListener('click', () => { openSection('fields'); });
        c.appendChild(go);
        box.appendChild(c);
    } else if (s) {
        box.appendChild(mk('div', CARD, 'margin-top:10px;font-size:13px;color:#15803d;', '✅ 没有一行缺格。'));
    }

    // ---- 最划算的几条需求（**按命令合并**后念，别把"跑一次就够"说成三件事）----
    if (n && n.items.length) {
        const groups = groupNeedsByFix(n);
        const card = mk('div', CARD, 'margin-top:10px;');
        card.appendChild(mk('div', '', 'font-size:13px;font-weight:600;color:#334155;margin-bottom:6px;',
            `原料需求 ${n.items.length} 条 → 只需跑 ${groups.length} 条命令`
            + `（合计 ${fmtNum(n.totalGain)} 个空位；按"能补几个"排）`));
        for (const g of groups) {
            const row = mk('div', 'cov-need-brief', 'font-size:12px;color:#334155;line-height:1.9;'
                + 'border-top:1px solid #f1f5f9;padding-top:6px;');
            row.innerHTML = `<b>+${fmtNum(g.gain)}</b> 格 · ${g.channels.join(' + ') || '—'}`
                + ` · ${g.fields.map((f) => `<code>${f}</code>`).join(' ')}`
                + ` · <span style="color:#b45309;">${g.kindLabel}</span>`
                + (g.items.length > 1 ? ` · <span style="color:#94a3b8;">${g.items.length} 条需求共用这一条命令</span>` : '');
            card.appendChild(row);
        }
        const go = mk('button', 'btn', 'margin-top:8px;padding:4px 10px;font-size:12px;', '📋 去「原料需求」看命令');
        go.addEventListener('click', () => { openSection('needs'); });
        card.appendChild(go);
        box.appendChild(card);
    }

    return box;
}
/** deltas 里的项：可能是一段文字（"P.clistDifficulty: -12"），也可能是对象 —— 都念得出来 */
function listOfItems(list, color) {
    const box = mk('div', '', `margin-top:4px;font-size:11px;color:${color};line-height:1.8;`);
    for (const it of list) {
        const line = mk('div', '', '', typeof it === 'string' ? it : (it && (it.label || it.text)
            || `${it && it.type ? it.type + ' · ' : ''}${(it && (it.field || it.id)) || JSON.stringify(it)}`
            + (it && it.delta !== undefined ? ` Δ${it.delta}` : '') + (it && it.missing !== undefined ? ` 缺 ${it.missing}` : '')));
        box.appendChild(line);
    }
    return box;
}

// ================================================================
// ② 原料需求（卡片）
// ================================================================

function needsSection(rep) {
    const n = summarizeNeeds(rep);
    const box = mk('div', 'cov-needs');
    if (!n || !n.items.length) {
        box.appendChild(mk('div', CARD, 'font-size:13px;color:#475569;', '这一轮没有"去跑点什么就有"的需求。'));
        return box;
    }
    // ⚠️ **按"该跑的命令"合并**：报告是按渠道派需求的，
    //    而 CLIST 难度的三条需求命令一模一样 —— 不合并就会摆三张看着要跑三次的卡。
    const groups = groupNeedsByFix(n);

    const head = mk('div', CARD, 'font-size:12px;color:#334155;line-height:1.9;margin-bottom:10px;');
    head.innerHTML = `共 <b>${n.items.length}</b> 条需求、合计 <b>${fmtNum(n.totalGain)}</b> 个空位，`
        + (groups.length < n.items.length
            ? `但它们只需要跑 <b>${groups.length} 条命令</b>（相同的命令已合并成一张卡）。`
            : `对应 <b>${groups.length} 条命令</b>。`)
        + '<br>⚠️ 这些都是<b>联网</b>动作（限速、耗流量），要不要跑你自己定 —— '
        + '跑完把包重建一次，这一页就跟着变。';
    if (n.exhaustedCount) {
        const ex = mk('div', '', HINT + 'margin-top:4px;color:#b45309;');
        ex.textContent = `其中 ${n.exhaustedCount} 格是"上游就没有"（试过、拿不到）：再跑也是白跑，除非上游补上。`;
        head.appendChild(ex);
    }
    box.appendChild(head);

    for (const g of groups) {
        box.appendChild(needCard(g));
    }
    return box;
}

/**
 * 一组"共用同一条命令"的需求 → 一张卡。
 *
 * 卡片三块：① 合计（+N 格 / 涉及哪些渠道与字段 / 几条需求）；② 为什么 + 怎么做（去重后念一遍）；
 * ③ **✅ 该跑的命令**（可复制）+ 小字"另一件事（重跑这个来源）"。
 */
function needCard(g) {
    const card = mk('div', CARD + ' cov-need-card', 'margin-bottom:10px;');
    card.dataset.fix = g.fixCommand;
    card.dataset.needs = String(g.items.length);

    const title = mk('div', '', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    title.appendChild(mk('span', '', 'font-size:14px;font-weight:600;color:#0f172a;',
        g.channels.join(' + ') || '（没署名渠道）'));
    for (const field of g.fields) {
        title.appendChild(mk('code', '', 'background:#f1f5f9;padding:2px 6px;border-radius:5px;font-size:11px;', field));
    }
    title.appendChild(mk('span', '', 'background:#fef2f2;color:#b91c1c;border-radius:999px;padding:2px 9px;'
        + 'font-size:11px;font-weight:600;', `+${fmtNum(g.gain)} 格`));
    title.appendChild(mk('span', '', 'background:#fffbeb;color:#b45309;border-radius:999px;padding:2px 9px;'
        + 'font-size:11px;', g.kindLabel));
    if (g.groups) title.appendChild(mk('span', '', HINT, `涉及 ${g.groups} 组`));
    card.appendChild(title);

    // 合并了什么：逐条列出来（合并 ≠ 藏起来 —— 每条补多少、哪些渠道，一眼看全）
    if (g.items.length > 1) {
        const list = mk('div', 'cov-need-parts', HINT + 'margin-top:6px;');
        list.textContent = '这一条命令能一次补上：'
            + g.items.map((it) => `${it.channelLabel} ${it.field} +${fmtNum(it.gain)} 格`).join('　·　');
        card.appendChild(list);
    }

    for (const text of uniqueProse(g.items, 'why')) {
        card.appendChild(mk('div', '', 'font-size:12px;color:#475569;line-height:1.9;margin-top:6px;', text));
    }
    for (const text of uniqueProse(g.items, 'action')) {
        card.appendChild(mk('div', '', 'font-size:12px;color:#334155;line-height:1.9;', `怎么做：${text}`));
    }

    // ★ **该跑的命令**（可复制的那条）—— 与"重跑这个来源"**不是一件事**
    card.appendChild(mk('div', '', 'font-size:12px;color:#166534;font-weight:600;margin-top:8px;',
        g.items.length > 1 ? '✅ 该跑的命令（上面几条共用这一条）' : '✅ 该跑的命令'));
    card.appendChild(commandRow(g.fixCommand, '✅ 该跑的命令已复制'));

    const others = [];
    for (const it of g.items) {
        if (it.command && it.command !== g.fixCommand && !others.includes(it.command)) others.push(it.command);
    }
    if (others.length) {
        card.appendChild(mk('div', '', HINT + 'margin-top:8px;',
            '另一件事（重跑这个来源 —— 未必补得上这些格，别当上面那条用）：'));
        for (const cmd of others) card.appendChild(commandRow(cmd, '重跑来源的命令已复制'));
    }

    if (g.exhausted) {
        card.appendChild(mk('div', '', HINT + 'margin-top:6px;color:#b45309;',
            `其中 ${fmtNum(g.exhausted)} 格是"上游就没有"（试过、拿不到）—— 命令跑了也不会有。`));
    }
    // ---- 半填的组 + 样例（合并后按条列，仍各自带自己的样例）----
    for (const it of g.items) {
        const partial = Object.keys(it.partialGroups);
        if (partial.length) {
            const pg = Object.entries(it.partialGroups).slice(0, 8)
                .map(([k, v]) => `${k}（${v.filled}/${v.total}）`).join('、');
            card.appendChild(mk('div', '', HINT + 'margin-top:4px;',
                `${it.channelLabel} 半填的组（前 8）：${pg}`));
        }
        if (it.sample.length) {
            const s = it.sample.slice(0, NEED_SAMPLE_LIMIT).join('、');
            card.appendChild(mk('div', '', HINT + 'margin-top:4px;word-break:break-all;',
                `${it.channelLabel} 样例题号（前 ${Math.min(it.sample.length, NEED_SAMPLE_LIMIT)} / ${it.sample.length}）：${s}`));
        }
    }
    return card;
}

// ================================================================
// ③ 字段体检（29 行表）
// ================================================================

function fieldsSection(rep) {
    const s = summarizeCoverage(rep);
    const box = mk('div', 'cov-fields');
    if (!s) {
        box.appendChild(mk('div', CARD, 'font-size:13px;color:#475569;', '这一包没有字段体检那一段。'));
        return box;
    }

    const cov = rep.coverage;
    let rows = (cov.rows || []).filter((r) => r && typeof r === 'object');
    if (fieldsOnlyMissing) rows = rows.filter((r) => num(r.missing) > 0);

    const bar = mk('div', '', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;');
    const btn = mk('button', 'btn cov-fields-filter', 'padding:4px 10px;font-size:12px;',
        fieldsOnlyMissing ? '只看有缺的行' : '看全部行');
    btn.addEventListener('click', () => { fieldsOnlyMissing = !fieldsOnlyMissing; renderCoveragePage(); });
    bar.appendChild(btn);
    const sum = mk('span', '', HINT);
    sum.textContent = `${fieldsOnlyMissing ? '只看有缺的' : '全部'} ${rows.length} 行 · `
        + `真缺 ${fmtNum(s.requiredMissingCount)} 格 / 应该有而缺 ${fmtNum(s.expectedMissingCount)} 格 / `
        + `可有可无而缺 ${fmtNum(s.optionalMissingCount)} 格 · `
        + `豁免 ${fmtNum(s.exempt)} 格（"本来就不适用"，不算缺）`;
    bar.appendChild(sum);
    box.appendChild(bar);

    const wrap = mk('div', CARD, 'padding:0;max-height:62vh;overflow:auto;');
    const table = mk('table', 'cov-table', TABLE);
    table.innerHTML = `<thead><tr>
        <th style="${TH}">类型</th><th style="${TH}">字段</th><th style="${TH}">应有</th>
        <th style="${TH}">适用</th><th style="${TH}">已填</th><th style="${TH}">缺</th>
        <th style="${TH}">豁免</th><th style="${TH}">多半拿不到</th>
        <th style="${TH}">为什么这么定</th></tr></thead>`;
    const tb = mk('tbody');
    for (const r of rows) {
        const tr = mk('tr', r.missing > 0 ? 'cov-row-missing' : 'cov-row-ok');
        const color = expectColor(r.expect);
        // ★ **先看并列档 `missingLow`**（多半拿不到**不算缺**，它就是这一档的格数）；
        //   老报告没有这一节时退回 `pursueCounts.low`（里面含"缺"的那些）。
        //   ⚠️ 不能用 `low / missing` 那种写法：`missing` 是 **0**（那些格不算缺）
        //   ⇒ 会显示成「171/0」（实测见过）。
        const low = num(r.missingLow) || num((r.pursueCounts || {}).low);
        const high = num((r.pursueCounts || {}).high);
        // 「追值」：对**不能确定能不能爬到**的东西也引入优先级：
        //   ⏬ = 多半永远拿不到（**与"豁免"并列的一档，不算缺**）；⏫ = 值得优先追；普通的不显摆
        // ★ 与『已填/缺/豁免』**并列的那一列**就是**数字列**，
        //   与「豁免」同一形态 —— 光有页头一句 + 行里的徽标**不算加**。
        //   ⏫「值得追」只是附在这个数后面的小记号（另一个方向的人判断，不单独占列）。
        const pursue = `<span style="color:#64748b;white-space:nowrap;">${fmtNum(low)}</span>`
            + (high
                ? ` <span style="color:#b45309;white-space:nowrap;" title="追值 high：值得优先追">⏫</span>`
                : '');
        tr.innerHTML = `<td style="${TD_NOWRAP}"><b>${r.type}</b></td>`
            + `<td style="${TD_NOWRAP}"><code>${r.field}</code></td>`
            + `<td style="${TD_NOWRAP};color:${color};font-weight:600;">${expectLabel(r.expect)}</td>`
            + `<td style="${TD_NOWRAP};color:#64748b;">${fmtNum(r.applies)}</td>`
            + `<td style="${TD_NOWRAP};color:#64748b;">${fmtNum(r.filled)}</td>`
            + `<td style="${TD_NOWRAP};color:${r.missing ? '#b91c1c' : '#94a3b8'};font-weight:${r.missing ? 600 : 400};">${fmtNum(r.missing)}</td>`
            + `<td style="${TD_NOWRAP};color:#94a3b8;">${fmtNum(r.exempt)}</td>`
            + `<td style="${TD_NOWRAP};">${pursue}</td>`
            + `<td style="${TD};color:#64748b;line-height:1.7;">${escapeHtml(r.why || '')}</td>`;
        tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);
    box.appendChild(wrap);
    return box;
}

// ================================================================
// ④ 同组不一致（分页）
// ================================================================

function groupsSection(rep) {
    const box = mk('div', 'cov-groups');
    const s = summarizeCoverage(rep);
    if (!s) {
        box.appendChild(mk('div', CARD, 'font-size:13px;color:#475569;', '这一包没有字段体检那一段。'));
        return box;
    }
    const pg = pageGroups(rep, groupPage);
    groupPage = pg.page;                     // 夹回来的页码记下来（否则点上一页会跳）

    const head = mk('div', CARD, 'font-size:12px;color:#334155;line-height:1.9;margin-bottom:10px;');
    head.innerHTML = `<b>同组不一致</b>：同一场比赛里<b>有的题填了、有的没填</b>的组，共 `
        + `<b>${pg.total}</b> 组（涉及 ${fmtNum(s.inconsistentMissingCount)} 格）。`
        + '<br>⚠️ 这<b>不是</b>"整场都没有"（那是另一种情况，算在上面两类缺里）—— '
        + '它回答的是"这一场我是不是漏了几道题"，所以按<b>组</b>看。';
    box.appendChild(head);

    if (!pg.total) {
        box.appendChild(mk('div', CARD, 'font-size:13px;color:#15803d;', '✅ 没有半填的组。'));
        return box;
    }

    const wrap = mk('div', CARD, 'padding:0;overflow:auto;');
    const table = mk('table', 'cov-table', TABLE);
    table.innerHTML = `<thead><tr>
        <th style="${TH}">类型 · 字段</th><th style="${TH}">组（比赛）</th>
        <th style="${TH}">组内</th><th style="${TH}">没填的题</th></tr></thead>`;
    const tb = mk('tbody');
    for (const g of pg.items) {
        const keys = Array.isArray(g.missing_keys) ? g.missing_keys : [];
        const shown = keys.slice(0, 6).map((k) => String(k).split(':p:').pop() || k).join('、');
        const tr = mk('tr');
        tr.innerHTML = `<td style="${TD_NOWRAP}"><b>${g.type}</b> · <code>${g.field}</code></td>`
            + `<td style="${TD};word-break:break-all;">${g.parent}</td>`
            + `<td style="${TD_NOWRAP};color:#64748b;">${fmtNum(g.filled)} / ${fmtNum(g.total)}</td>`
            + `<td style="${TD};color:#b91c1c;word-break:break-all;">${shown}`
            + (keys.length > 6 ? ` …等 ${keys.length} 个` : '') + '</td>';
        tb.appendChild(tr);
    }
    table.appendChild(tb);
    wrap.appendChild(table);
    box.appendChild(wrap);

    // ---- 翻页 ----
    const pager = mk('div', 'cov-pager', 'display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;');
    const prev = mk('button', 'btn cov-prev', 'padding:4px 10px;font-size:12px;', '← 上一页');
    const next = mk('button', 'btn cov-next', 'padding:4px 10px;font-size:12px;', '下一页 →');
    prev.disabled = pg.page <= 1;
    next.disabled = pg.page >= pg.pageCount;
    prev.addEventListener('click', () => { groupPage = pg.page - 1; renderCoveragePage(); });
    next.addEventListener('click', () => { groupPage = pg.page + 1; renderCoveragePage(); });
    pager.appendChild(prev);
    pager.appendChild(mk('span', 'cov-page-label', '', `第 ${pg.page} / ${pg.pageCount} 页（每页 ${GROUP_PAGE_SIZE} 组）`));
    pager.appendChild(next);
    box.appendChild(pager);
    return box;
}

// ================================================================
// 画页
// ================================================================

//: 四栏（**顺序 = 页面上从上到下**）。`key` 也当 DOM 的 `data-stage`
//  ⚠️ 以前这里是**标签切换**（一次看一栏）：计数在标签上，但"这一栏没有"与
//     "这一栏根本没算"分不开，而且一屏看不见"一共有几类"。现在与判重整理 ⑤、
//     节点自动导入**同一套模板**：每栏都在（0 条也在，灰的）、**默认折叠**
//     （标题就是简要报告）、点标题展开才是**完整表格**／完整卡片。
const COV_STAGES = [
    {
        key: 'cov-summary', tone: 'note',
        count: (rep) => (summarizeCoverage(rep) ? summarizeCoverage(rep).rowsTotal : 0),
        title: (n, rep) => {
            const s = summarizeCoverage(rep);
            return s ? `🩺 小结（${fmtNum(s.records)} 个节点 · ${s.rowsTotal} 行体检）` : '🩺 小结';
        },
        body: (box, rep) => box.appendChild(summarySection(rep))
    },
    {
        key: 'cov-needs', tone: 'warn',
        items: (rep) => {
            const n = summarizeNeeds(rep);
            return (n && n.items) || [];
        },
        title: (n, rep) => {
            const got = summarizeNeeds(rep);
            if (!got || !got.items.length) return '📋 原料需求（0 条）';
            const g = groupNeedsByFix(got).length;
            return g < got.items.length
                ? `📋 原料需求（${got.items.length} 条 / ${g} 条命令）`
                : `📋 原料需求（${got.items.length}）`;
        },
        body: (box, rep) => box.appendChild(needsSection(rep))
    },
    {
        key: 'cov-fields', tone: 'note',
        count: (rep) => (summarizeCoverage(rep) ? summarizeCoverage(rep).rowsTotal : 0),
        title: (n, rep) => {
            const s = summarizeCoverage(rep);
            if (!s) return '✅ 字段体检（这一包没有那一段）';
            // ★ **三档缺分开念**：混成一句"可疑 N"会把该动手的那一档淹掉
            return `✅ 字段体检（${s.rowsTotal} 行 · 真缺 ${s.requiredMissingCount} 格`
                + ` / 应该有而缺 ${s.expectedMissingCount} 格）`;
        },
        body: (box, rep) => box.appendChild(fieldsSection(rep))
    },
    {
        key: 'cov-groups', tone: 'note',
        count: (rep) => {
            const s = summarizeCoverage(rep);
            return (s && s.inconsistentTotal) || 0;
        },
        title: (n, rep) => {
            const s = summarizeCoverage(rep);
            return `🔁 同组不一致${s && s.inconsistentTotal ? `（${s.inconsistentTotal} 组）` : '（0 组）'}`;
        },
        body: (box, rep) => box.appendChild(groupsSection(rep))
    }
];

/** 节点数（页头小结要念；没有报告时给 0） */
function nodesOf(rep) {
    return (rep && rep.coverage && rep.coverage.records) || 0;
}

/** 没带报告时整页就这一张卡：说清"报告从哪来 / 怎么才有"，**不假装是空表** */
function emptyCard() {
    const card = mk('div', CARD, 'font-size:13px;color:#334155;line-height:1.9;max-width:820px;');
    card.innerHTML = '<b>这个包没带体检报告。</b><br>'
        + '体检报告是<b>重建包</b>时顺带塞进包顶层的（构建链条最后三步），而且<b>只跟着总包</b> ——'
        + ' `all_nodes.json` 带，单独的类包 / 混装包 `mix_contain_xcpc.json` 不带：'
        + '<br>· 字段体检 ← <code>scripts/field-coverage.py</code>'
        + '<br>· 原料需求 ← <code>scripts/material-needs.py</code>'
        + '<br>· 报告随包 ← <code>scripts/embed-reports.py</code>'
        + '<br>所以：<b>重建一次包，导入 <code>all_nodes.json</code></b>，这一页就有内容了'
        + '（老包 / 裁剪过的包本来就不带）。'
        + '<br><span style="color:#94a3b8;">（也可以在「📥 节点自动导入」页点重建；报告进的是应用数据，随导出走、可撤回。）</span>';
    return card;
}

/** 画整个体检页 */
export function renderCoveragePage(containerId = COVERAGE_CONTAINER_ID) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const rep = AppState.reports;
    const redraw = () => { renderCoveragePage(containerId); };

    container.innerHTML = '';
    const page = mk('div', 'coverage-page', 'padding:16px;');
    container.appendChild(page);

    page.appendChild(mk('h2', '', 'margin:0 0 4px;font-size:18px;', '🩺 体检 / 需求'));
    const note = mk('div', '', 'font-size:12px;color:#64748b;line-height:1.8;margin-bottom:12px;max-width:900px;');
    note.innerHTML = '这一页读的是<b>包顶层带的体检报告</b>（导入时随包存进应用数据）：'
        + '字段体检 = 每个「类型 × 字段」<b>应有 / 已有 / 缺 / 豁免</b>，原料需求 = 还差哪些原料、去跑哪条命令。'
        + '<br>⚠️ 这里<b>不联网、不跑脚本</b> —— 它只是把构建侧算好的结论念给你听。';
    page.appendChild(note);

    if (!hasReports(rep)) {
        page.appendChild(emptyCard());
        return page;
    }

    // ---- 四栏：**同一套模板**（与判重整理 ⑤、节点自动导入一样）----
    //   每一栏都在、默认折叠（**标题就是简要报告**），点标题展开才是**完整表格／完整卡片**。
    //   ⚠️ 折叠只是 `display`：内容一直画在 DOM 里（断言与"复制命令"都不用先展开）。
    renderSections(page, [{ stages: COV_STAGES }], rep, {});

    // ---- 页脚：这一页的"唯一真相"在哪 ----
    const foot = mk('div', '', 'margin-top:16px;padding-top:10px;border-top:1px solid #eef2f6;font-size:11px;color:#94a3b8;');
    foot.textContent = '判定口径来自构建侧脚本（field-coverage.py / material-needs.py）；'
        + '这一页只排序、分页、念结论。想更新 ⇒ 重建包 + 重新导入。';
    page.appendChild(foot);

    return page;
}

/** 只给自测/排错用：把模块级小状态清干净（同 `__resetSettingsPageState` 的理由） */
export function __resetCoveragePageState() {
    lastSection = 'summary';
    for (const st of COV_STAGES) setStageOpen(st.key, false);
    groupPage = 1;
    fieldsOnlyMissing = false;
}

/**
 * 现在展开的是哪一栏（给自测/排错用）。
 *
 * ⚠️ 四栏改成**折叠**之后就没有"当前栏"了（可以同时展开好几栏）——
 *    这个函数回答的是"**最后打开的是哪个**"（没打开过就报 `summary`），
 *    保留它是为了"自测里那几条断言照样说得通"，不是新的状态。
 */
export function currentCoverageSection() {
    for (const st of COV_STAGES) if (isStageOpen(st.key)) return st.key.replace('cov-', '');
    return lastSection;
}

/** 打开某一栏（"去某栏看"那两个按钮用） */
function openSection(id) {
    lastSection = id;
    setStageOpen(`cov-${id}`, true);
    renderCoveragePage();
}

/** 报告里的 `why` 是 Markdown 散文（带 `**` 与反引号）：先去记号、再按 HTML 转义 */
function escapeHtml(str) {
    return escHtml(plainProse(str));
}
