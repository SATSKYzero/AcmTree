// ================================================================
// 内层计划页 · 「强度总账」「题目列表」「每期完成情况」几块（ui/plan/planBlocks.js）
//
// 用户 2026-10-13 第 1 轮改进：
//   ② 「题目列表要**可折叠/分页/可跳转/支持筛选**」
//   ④ 「每期完成情况要**可折叠/分页/看列表**，UI 参考热力图的范围筛选，并且**日期要加年份**」
//   ③ 「状态 × 难度的格式大可与统计页**完全相同**」（+ 标题别再写"与统计页同一份口径"）
//
// 用户 2026-10-13 第 2 轮（"功能充足"）：
//   · 范围筛选换成**热力图那一套**年/月/日三级下拉（`ui/kit/dateRangePicker.js`，一处实现）；
//   · 加「强度总账」：**已写 / 总训练强度**、**推荐训练强度**（有结束时间才算）、
//     **目标训练强度**（+ 按目标算**预计完成日期**）；
//   · 「每期完成情况」的范围 = **计划开始 → 现在**（core 那边定，见 `planProgressOf`）；
//     ⚠️ 用户在那一块按了「确定」之后，**区间就是期窗口本身**（表与两张图同一个窗口，见 `renderPeriodsBlock`）。
//
// ⚠️ **折叠 / 页码 / 筛选条件是"怎么看"** ⇒ 住视图态（`core/model/viewState.js` 的
//    `planSectionViewOf` / `setPlanSectionView`），不进 `state.plans`、不进包。
// ⚠️ 列表的每一行是**真元素**（要能点着跳转 ⇒ 冒烟也得点得到）；每期那张表与总账是只读的，用 innerHTML。
// ⚠️ "跳转"只有一条路：派发 `EVENTS.REVEAL_NODE`（`ui/revealNode.js` 接住）——别自己切页/滚屏。
// ⚠️ 网格**复用统计页那一份渲染**（`ui/stats/statusGridView.js`）—— 两边一模一样是结构保证的。
// ================================================================
import { AppState } from '../../shell/state.js';
import { el } from '../../utils/dom.js';
import { escapeHtml, getCfColor } from '../../utils/A_helpers.js';
import { EVENTS, STATUS2_LABELS, STATUS2_COLORS, XCPC_COLORS } from '../../A_constants.js';
import { XCPC_ORDER, XCPC_UNFILLED } from '../../utils/color.js';
import { renderStatusGrid } from '../stats/statusGridView.js';
// ★ 范围筛选用的是**热力图那一套**年/月/日三级下拉（用户第 2 轮："范围筛选用热力图那种"）
import { buildDateRangePicker } from '../kit/dateRangePicker.js';
// ★ 两张图挂在「每期完成情况」这一块里（第 5 轮合并）；本文件画它、数据由调用方给（`opts.dataOf`）
import { renderChartsBlock } from './planCharts.js';
import { planSectionViewOf, setPlanSectionView, scheduleViewSave } from '../../core/model/viewState.js';
// ★ 总账那三个数 + 预计完成日期（纯函数，`npm test` 里钉着）
import { planForecastOf, intensityTableById, dayKeyOf, periodsNewestFirst,
    xcpcPointTextOf, xcpcPointLabelOf, cfPointTextOf, intensityJoinLabelOf, CF_INTENSITY_TOP } from '../../core/trainingPlan.js';
// ★ 标签 / 平台 / 数值区间三维的判据**只有一份**（与"按条件挑题"弹窗共用）
// ★ 标签 / 平台 / 数值区间三维的判据**只有一份**（与"按条件挑题"弹窗共用）；
//   ⚠️ `tagsUnder` / `platformsUnder` 是"按子树根收"的口 —— 本块要的是"**这条计划的题集里**有什么"，
//      那是 `data.entries`（与用户正在筛的那一份**同一个来源**），所以在这儿按 entries 收。
import { matchesProblemFilter, tagNamesOf, platformOf } from '../../core/problemPick.js';
// ★ 行尾那一格 = 节点入口条（身份键 + 完整面包屑 + 📋）—— 用现成那一份（`docs/node-lists.md` 的「节点列表」一节）
//   用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"
import { nodeEntryLine } from '../kit/nodeEntry.js';
// ★ 关键字匹配与两处检索**同一份口径**（`hasText` / `norm`：包含匹配、不分大小写）；
//   排序也用它那份 `sortRecords`（稳定 + "空值垫底"）
import { hasText, norm, sortRecords } from '../../core/query/searchShared.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
// ★ 数字显示（最多一位小数）只有一份：`utils/num.js`
import { fmtAmount as fmt } from '../../utils/num.js';

const HINT = 'font-size:11px;color:#94a3b8;line-height:1.7;';
const INPUT = 'padding:3px 6px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;';
const TD = 'padding:3px 8px 3px 0;font-size:12px;color:#475569;';
const TH = 'text-align:left;padding:3px 8px 3px 0;font-size:11px;color:#94a3b8;font-weight:400;';

/** 改视图态 + 合并落盘 + 重画这一页（**唯一入口**：折叠/翻页/筛选都走它） */
function patchView(planId, patch, redraw) {
    setPlanSectionView(AppState, planId, patch);
    scheduleViewSave(AppState);
    redraw();
}

/** 小块的头：标题 + 折叠按钮（两块共用一份写法） */
function blockHead(key, title, open, onToggle) {
    const bar = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
    bar.appendChild(el('h3', 'margin:0;font-size:14px;font-weight:600;color:#334155;', title));
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.dataset.planAction = `${key}-toggle`;
    btn.textContent = open ? '▾ 收起' : '▸ 展开';
    btn.addEventListener('click', onToggle);
    bar.appendChild(btn);
    return bar;
}

/** 翻页条（两块的页码控件共用一份写法） */
function pager(key, page, pageCount, total, onGo) {
    const bar = el('div', 'display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:#64748b;');
    const prev = document.createElement('button');
    prev.className = 'btn';
    prev.dataset.planAction = `${key}-prev`;
    prev.textContent = '上一页';
    prev.disabled = page <= 1;
    prev.addEventListener('click', () => onGo(page - 1));
    const next = document.createElement('button');
    next.className = 'btn';
    next.dataset.planAction = `${key}-next`;
    next.textContent = '下一页';
    next.disabled = page >= pageCount;
    next.addEventListener('click', () => onGo(page + 1));
    bar.appendChild(prev);
    bar.appendChild(el('span', '', `第 ${page} / ${pageCount} 页（共 ${total} 条）`));
    bar.appendChild(next);
    return bar;
}

// ================================================================
// 第 2 轮 · 「强度总账」：已写 / 总训练强度 · 推荐训练强度 · 目标训练强度 + 预计完成日期
// ================================================================

/**
 * 画总账那一块（**只读**：数字全来自 `core/trainingPlan.js:planForecastOf`，现算）。
 * @param {Object} plan
 * @param {Object} data `planProgressOf` 的结果
 */
export function renderSummaryBlock(plan, data) {
    const f = planForecastOf(data);
    const card = el('div', 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;');
    card.dataset.planBlock = 'summary';
    card.appendChild(el('h3', 'margin:0 0 8px;font-size:14px;font-weight:600;color:#334155;', '💰 强度总账'));

    const row = (label, value, hint = '', hook = '') => {
        const line = el('div', 'display:flex;align-items:baseline;gap:8px;font-size:12px;color:#475569;margin-bottom:2px;');
        line.appendChild(el('span', 'flex:0 0 132px;color:#94a3b8;', label));
        const v = el('span', 'font-weight:600;color:#0f172a;', value);
        if (hook) v.dataset.planStat = hook;
        line.appendChild(v);
        if (hint) line.appendChild(el('span', HINT, hint));
        return line;
    };

    // ① 已写 / 总训练强度（**按强度算**，与目标口径无关 —— 用户要的就是这两个数）
    const pct = f.totalIntensity > 0 ? Math.round(f.doneRatio * 100) : 0;
    card.appendChild(row('已写 / 总训练强度',
        `${fmt(f.doneIntensity)} / ${fmt(f.totalIntensity)} 强度`,
        `（${pct}%${f.remainingIntensity > 0 ? `，还差 ${fmt(f.remainingIntensity)}` : '，已写完'}）`,
        'done-intensity'));
    card.appendChild(row('题数', `${data.doneCount} / ${data.totalCount} 题`,
        `（做完的定义 = 状态2 ∈ {${(plan.statuses || []).join(', ')}}）`, 'done-count'));

    // ② 目标训练强度（计划自己填的那份，折算到"每天"）
    const grainLabel = { day: '每天', week: '每周', month: '每月', all: '整段' }[data.goalBase] || data.goalBase;
    const goalValue = (plan.goal && plan.goal.value) || 0;
    const goalUnit = (data.goalMode === 'count') ? '题' : '强度';
    card.appendChild(row('目标训练强度',
        f.goalPerDay > 0 ? `${fmt(f.goalPerDay)} / 天` : '（没填）',
        f.goalPerDay > 0 ? `（计划填的是「${grainLabel} ${fmt(goalValue)} ${goalUnit}」，折算到每天）` : '（填了才能算预计完成日期）',
        'goal-per-day'));

    // ③ 推荐训练强度（用户："若有结束时间可算，以恰好按时完成计划为准"）
    if (f.leftDays === null) {
        card.appendChild(row('推荐训练强度', '—',
            '（计划没填结束时间 ⇒ 算不出"恰好按时完成"要多少）', 'recommend'));
    } else if (f.leftDays <= 0) {
        card.appendChild(row('推荐训练强度', '—', `（结束时间 ${f.planEndKey || ''} 已经过了）`, 'recommend'));
    } else {
        card.appendChild(row('推荐训练强度', `${fmt(f.recommendPerDay)} / 天`,
            `（还差 ${fmt(f.remainingIntensity)} 强度 ÷ 剩余 ${f.leftDays} 天 = 恰好按时完成）`, 'recommend'));
    }

    // ④ 预计完成日期（目标 > 0 才算）
    if (f.etaKey) {
        card.appendChild(row('预计完成（按目标）', f.etaKey,
            f.etaDays === 0 ? '（今天就能写完）' : `（从今天起还需 ${f.etaDays} 天）`, 'eta'));
    } else {
        card.appendChild(row('预计完成（按目标）', '—', '（目标没填 / 为 0 ⇒ 算不出）', 'eta'));
    }

    // ⑤ 计划窗口：开始 → 现在（第 2 轮口径）；还没开始就直说
    const todayKey = f.today;
    if (data.startKey && data.startKey > todayKey) {
        card.appendChild(el('div', 'font-size:12px;color:#b45309;margin-top:4px;',
            `⏳ 计划还没开始（${data.startKey}），所以还没有任何一期。`));
    } else {
        card.appendChild(el('div', HINT,
            `统计区间：${data.startKey || '（没填开始时间）'} → ${todayKey}（计划开始到现在；`
            + `结束时间 ${f.hasEnd ? f.planEndKey : '没填'}）`));
    }
    return card;
}

// ================================================================
// ② 题目列表：可折叠 / 分页 / 可跳转 / 筛选（第 3 轮"满血"：六维条件 + 排序 + 每页条数）
// ================================================================

/** 显示口径取值器（与树上/统计页同一份写法） */
const shownValue = (node, field) => viewDerivedDisplay(AppState, node, field) ?? viewValue(AppState, node, field);

/** 排序项（`value` 存进视图态；`compare` 决定顺序） */
export const LIST_SORTS = [
    { value: 'default', label: '默认（题单顺序）' },
    { value: 'ac-desc', label: 'AC 时间：新 → 旧' },
    { value: 'ac-asc', label: 'AC 时间：旧 → 新' },
    { value: 'intensity-desc', label: '强度：高 → 低' },
    { value: 'intensity-asc', label: '强度：低 → 高' },
    { value: 'level-desc', label: '难度：难 → 易' },
    { value: 'level-asc', label: '难度：易 → 难' },
    { value: 'pid', label: '题号 A → Z' }
];

/**
 * 按当前的筛选条件过一遍（**唯一一份**：列表与计数都用它）。
 * 六维：关键字 / 状态2 / 难度档 / **标签** / **平台** / **数值区间**；末了按 `sort` 排序。
 * ⚠️ 标签 / 平台 / 数值区间三维走的是 `core/problemPick.js:matchesProblemFilter`
 *    （与"按条件挑题"弹窗**同一份判据** —— 别在这儿另写一遍）。
 */
export function filterEntries(entries, view) {
    const q = view.q || '';
    const statuses = Array.isArray(view.statuses) ? view.statuses : [];
    const cond = {
        // ★ 难度档（多选）走**同一份判据**里的 levels 维：`matchesProblemFilter` 把"认不出的档位"
        //   算成哨兵 `XCPC_UNFILLED` ⇒ 勾「未填写」也有意义（`v9.1.37` 第 4 轮）
        levels: view.levels || [],
        tags: view.tags || [],
        platforms: view.platforms || [],
        cfMin: view.cfMin || '',
        cfMax: view.cfMax || ''
    };
    const kept = entries.filter((e) => {
        if (statuses.length && !statuses.includes(e.s2)) return false;
        const node = AppState.nodes[e.id];
        // 关键字：**与两处检索同一份口径**（`core/query/searchShared.js` 的 `hasText`/`norm`：
        //   空 = 不筛；包含匹配、不分大小写）—— 别在这儿手写 `toLowerCase().includes()`
        if (hasText(q)) {
            const hay = norm(`${(node && node.problemId) || ''} ${(node && node.name) || ''} ${e.id}`);
            if (!hay.includes(norm(q))) return false;
        }
        if (node && !matchesProblemFilter(node, cond, { shownValue }).ok) return false;
        return true;
    });
    return sortEntries(kept, view.sort);
}

/**
 * 排序（**唯一一份**；`default` = 题单顺序）。
 *
 * ★ 走仓里既有的稳定排序 `core/query/searchShared.js:sortRecords` —— 它已经定了两条口径：
 *   **稳定**（值相同保持传入顺序）与 **`isBlank` 命中的条目无论升序降序都垫底**。
 *   ⚠️ "没填难度"（不在 `XCPC_ORDER` 里）与"没有 AC 时间"（派生的 `acTime` 是占位符
 *      `----.--.-- --:--`，**不是空串**）都靠 `isBlank` 垫底 —— 别退回"自己写比较器"，
 *      那样两个方向会给出两种位置（`v9.1.36` 实测踩过：`ac-asc` 把"没有 AC"顶到最前）。
 */
export function sortEntries(entries, sort = 'default') {
    const nodeOf = (e) => AppState.nodes[e.id] || {};
    // ⚠️ `isBlank(v, rec)` 的**第一个参数是"排序键"、第二个才是那一条**（`sortRecords` 的契约）——
    //    写成 `(e) => e.time` 会拿到键（字符串）再取 `.time` ⇒ 拿到 `undefined` ⇒ **全判成垫底**，
    //    于是"垫底"这条规则整个失效、退回按字符串比（`v9.1.36` 实测踩过）。一律用第二个参数。
    const conf = {
        'ac-desc': { keyOf: (e) => String(e.time || ''), isBlank: (v, e) => !dayKeyOf(e.time), direction: 'desc' },
        'ac-asc': { keyOf: (e) => String(e.time || ''), isBlank: (v, e) => !dayKeyOf(e.time), direction: 'asc' },
        'intensity-desc': { keyOf: (e) => Number(e.intensity) || 0, direction: 'desc' },
        'intensity-asc': { keyOf: (e) => Number(e.intensity) || 0, direction: 'asc' },
        'level-desc': { keyOf: (e) => XCPC_ORDER.indexOf(e.level), isBlank: (v, e) => !XCPC_ORDER.includes(e.level), direction: 'desc' },
        'level-asc': { keyOf: (e) => XCPC_ORDER.indexOf(e.level), isBlank: (v, e) => !XCPC_ORDER.includes(e.level), direction: 'asc' },
        pid: { keyOf: (e) => String(nodeOf(e).problemId || ''), direction: 'asc' }
    }[sort];
    return conf ? sortRecords(entries, conf) : [...entries];
}

export function renderListBlock(plan, data, redraw) {
    const view = planSectionViewOf(AppState, plan.id).list;
    const card = el('div', 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;');
    card.dataset.planBlock = 'list';
    const shown = filterEntries(data.entries, view);
    card.appendChild(blockHead('list', `📋 题目列表（${shown.length}/${data.entries.length} 道）`, view.open,
        () => patchView(plan.id, { list: { open: !view.open } }, redraw)));
    if (!view.open) return card;

    // ---- 列表筛选条（关键字 / 状态2 多选 / 难度档）----
    // ⚠️ 名字里**必须带"列表"**：它是"你**现在怎么看**这张列表"（住视图态，不影响任何统计），
    //    与计划设置里的「**题集条件**」（`plan.pick`，进数据、要保存）是两件事 —— 见
    //    `docs/ui-conventions.md` 的「19. 语义查询：本仓里筛选一词有五种主语」一节。
    const bar = el('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:6px 0;');
    bar.appendChild(el('span', 'font-size:11px;color:#94a3b8;', '列表筛选：'));
    const q = document.createElement('input');
    q.type = 'text';
    q.placeholder = '题号 / 题名 / id';
    q.style.cssText = INPUT + 'width:150px;';
    q.dataset.planFilter = 'list-q';
    q.value = view.q;
    q.addEventListener('change', () => patchView(plan.id, { list: { q: q.value, page: 1 } }, redraw));
    bar.appendChild(q);

    for (let s2 = 0; s2 <= 5; s2++) {
        const lab = el('label', 'display:inline-flex;align-items:center;gap:3px;font-size:12px;color:#475569;cursor:pointer;');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.dataset.planFilter = `list-status-${s2}`;
        box.checked = view.statuses.includes(s2);
        box.addEventListener('change', () => {
            const next = view.statuses.includes(s2)
                ? view.statuses.filter((x) => x !== s2)
                : view.statuses.concat([s2]);
            patchView(plan.id, { list: { statuses: next, page: 1 } }, redraw);
        });
        lab.appendChild(box);
        lab.appendChild(el('span', '', `${s2} ${STATUS2_LABELS[s2]}`));
        bar.appendChild(lab);
    }

    // ---- 数值难度区间（与挑题弹窗同一个判据：设了区间 ⇒ 没填难度的题排除）----
    const cfMin = document.createElement('input');
    cfMin.type = 'number';
    cfMin.placeholder = '≥';
    cfMin.title = '数值难度下限（留空 = 不限）';
    cfMin.style.cssText = INPUT + 'width:76px;';
    cfMin.dataset.planFilter = 'list-cf-min';
    cfMin.value = view.cfMin || '';
    cfMin.addEventListener('change', () => patchView(plan.id, { list: { cfMin: cfMin.value, page: 1 } }, redraw));
    const cfMax = document.createElement('input');
    cfMax.type = 'number';
    cfMax.placeholder = '≤';
    cfMax.title = '数值难度上限（留空 = 不限）';
    cfMax.style.cssText = INPUT + 'width:76px;';
    cfMax.dataset.planFilter = 'list-cf-max';
    cfMax.value = view.cfMax || '';
    cfMax.addEventListener('change', () => patchView(plan.id, { list: { cfMax: cfMax.value, page: 1 } }, redraw));

    // ---- 标签 / 平台（多选芯片；名单从**这条计划的题集**里收）----
    const multiRow = (key, label, items, picked) => {
        const row = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0;');
        row.appendChild(el('span', 'font-size:11px;color:#94a3b8;', label));   // 前缀灰文本（三行同形）
        if (!items.length) {
            row.appendChild(el('span', HINT, '（题集里没有可选项）'));
        }
        for (const it of items) {
            const lab = el('label', 'display:inline-flex;align-items:center;gap:3px;font-size:12px;color:#475569;cursor:pointer;');
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.dataset.planFilter = `list-${key}:${it}`;   // 与其它列表筛选一致：`list-` 前缀
            box.checked = picked.includes(it);
            box.addEventListener('change', () => {
                const next = picked.includes(it) ? picked.filter((x) => x !== it) : picked.concat([it]);
                patchView(plan.id, { list: { [key]: next, page: 1 } }, redraw);
            });
            lab.appendChild(box);
            // ★ 第 16 轮（用户："xcpc难度的染色还漏了这个表的选择"）：**档名芯片也上色** ——
            //   色表仍是那一份 `XCPC_COLORS`（标签/平台不在表里 ⇒ 保持原来的灰）。
            const chipColor = XCPC_COLORS[it];
            lab.appendChild(el('span', chipColor ? `color:${chipColor};` : '', it));
            row.appendChild(lab);
        }
        return row;
    };
    const allNodes = data.entries.map((e) => AppState.nodes[e.id]).filter(Boolean);
    const tagPool = [];
    const platPool = [];
    for (const n of allNodes) {
        for (const t of tagNamesOf(shownValue(n, 'tags'))) if (!tagPool.includes(t)) tagPool.push(t);
        const plat = platformOf(shownValue(n, 'natureClass'));   // 口径只有一份：取 natureClass 第一段
        if (plat && !platPool.includes(plat)) platPool.push(plat);
    }
    // ★ **XCPC 难度 = 一行多选芯片**（用户第 4 轮"筛选请让 XCPC 难度也可以勾选（xcpc 一行，前缀灰文本）"；
    //   第 5 轮定序："应该全都易→难"）：
    //   档位名单**只许来自** `XCPC_ORDER`（易 → 难：签到 … 金牌 … R … C+），末了跟哨兵「未填写」。
    const levelChips = XCPC_ORDER.concat([XCPC_UNFILLED]);
    card.appendChild(multiRow('levels', 'XCPC 难度', levelChips, view.levels || []));
    // ★ **数值难度 = 一行：前缀灰文本 + 区间**（用户第 4 轮："再数值难度一行，前缀灰文本，后面是难度范围"）
    const numRow = el('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0;');
    numRow.appendChild(el('span', 'font-size:11px;color:#94a3b8;', '数值难度'));
    numRow.appendChild(cfMin);
    numRow.appendChild(cfMax);
    card.appendChild(numRow);
    card.appendChild(multiRow('tags', '标签', tagPool.sort(), view.tags || []));
    card.appendChild(multiRow('platforms', '平台/赛系', platPool.sort(), view.platforms || []));

    // ---- 排序 + 每页条数 ----
    const sortSel = document.createElement('select');
    sortSel.style.cssText = INPUT;
    sortSel.dataset.planFilter = 'list-sort';
    for (const s of LIST_SORTS) {
        const o = document.createElement('option');
        o.value = s.value;
        o.textContent = s.label;
        sortSel.appendChild(o);
    }
    sortSel.value = view.sort || 'default';
    sortSel.addEventListener('change', () => patchView(plan.id, { list: { sort: sortSel.value, page: 1 } }, redraw));
    bar.appendChild(sortSel);

    const sizeSel = document.createElement('select');
    sizeSel.style.cssText = INPUT;
    sizeSel.dataset.planFilter = 'list-page-size';
    // ⚠️ 名单里**必须有默认那一档**（`view.pageSize` 的默认 = 10），否则下拉会选不中、显示空白
    for (const n of [10, 20, 50, 100, 200]) {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = `每页 ${n}`;
        sizeSel.appendChild(o);
    }
    sizeSel.value = String(view.pageSize);
    sizeSel.addEventListener('change', () => patchView(plan.id, { list: { pageSize: Number(sizeSel.value), page: 1 } }, redraw));
    bar.appendChild(sizeSel);

    const clear = document.createElement('button');
    clear.className = 'btn';
    clear.dataset.planAction = 'list-clear';
    clear.textContent = '✖ 清列表筛选';
    clear.addEventListener('click', () => patchView(plan.id, {
        list: { q: '', statuses: [], levels: [], tags: [], platforms: [], cfMin: '', cfMax: '', sort: 'default', page: 1 }
    }, redraw));
    bar.appendChild(clear);
    card.appendChild(bar);

    if (!shown.length) {
        card.appendChild(el('div', HINT, '按现在的列表筛选一道题都没有。'));
        return card;
    }

    // ---- 表体：每行**真元素**（点一下 ⇒ 派发 REVEAL_NODE 跳到树上那个节点）----
    const pageCount = Math.max(1, Math.ceil(shown.length / view.pageSize));
    const page = Math.min(view.page, pageCount);
    const slice = shown.slice((page - 1) * view.pageSize, page * view.pageSize);

    card.appendChild(problemHead());
    for (const e of slice) card.appendChild(problemRow(e));
    card.appendChild(pager('list', page, pageCount, shown.length,
        (n) => patchView(plan.id, { list: { page: Math.min(Math.max(1, n), pageCount) } }, redraw)));
    return card;
}

/**
 * 题目列表的**表头**与**一行**（**唯一一份**：题目列表块与"某一期做了哪些题"共用）。
 * ⚠️ 一行是**真元素**：点一下派发 `EVENTS.REVEAL_NODE` 跳到树上那个节点（走既有的那一条路）。
 */
/**
 * 题目列表六列的**宽度**（表头与数据行**共用这一份** —— 各写一份必然对不齐）。
 *
 * ★ 第 14 轮（用户："题名所占的列太长了"）：题名从 `flex:1`（**吃满余下宽度** ⇒ 后面几列被推到最右、
 *   中间一大片空白）改成 **`flex:0 1 320px`**（最多 320px、窗口窄了才缩）⇒ 六列自己紧挨着排。
 *   ⚠️ 要调就改**这一个数**，表头与数据行一起变。
 */
const LIST_COLS = [
    ['题号', 'flex:0 0 54px;'],
    ['题名', 'flex:0 1 320px;'],
    ['难度', 'flex:0 0 70px;'],
    ['状态2', 'flex:0 0 110px;'],
    ['AC 时间', 'flex:0 0 130px;'],
    // ★ 第 25/26 轮：那一格的内容宽 = 数字格(54) + 间隙(4) + **说明文字**（「（没填难度）」实量 ≈70px）
    //   ⇒ 列宽 **132px** 才放得下（原来 60px ⇒ 靠右收时数字被挤出列外 20px）。
    //   ⚠️ 说明**不许改淡、不许缩写**（用户："改淡色绝对是错的"）—— 宽度不够就**加宽这一列**。
    ['强度', 'flex:0 0 132px;'],
    // ★ 用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"：
    //   题名那一列**一个字不动**，**另加一列**装 `ui/kit/nodeEntry.js:nodeEntryLine`（紧凑形态）——
    //   它一格里含三样：**身份键**（`extKey`）+ **完整面包屑**（含自己、整条蓝，本身就是 🔎）+ 📋。
    //   ⚠️ 这一列是**唯一吃剩余宽度**的（`flex:1 1 240px;min-width:0`）⇒ 前六列仍各就各位；
    //      别把它改成定宽（窗口窄了面包屑会被挤爆）。
    ['节点', 'flex:1 1 240px;min-width:0;']
];

/** 表头（导出是给**排版测量链**用的：`scripts/measure-layout.mjs` 要单独画这张表量列对齐） */
export function problemHead() {
    const head = el('div', 'display:flex;gap:8px;font-size:11px;color:#94a3b8;border-bottom:1px solid #eef2f6;padding-bottom:2px;');
    for (const [text, flex] of LIST_COLS) {
        if (text !== '强度') {
            head.appendChild(el('span', flex, text));
            continue;
        }
        // ★ 第 27 轮（用户："没改好！！"；量过：**数字右端全在 798**，问题在**表头「强度」贴着列最左**）：
        //   这一列的格子是"数字格 54 + 说明格"两条轨道 ⇒ 表头做成**同形的两条**：
        //   标题那一格定宽 54 + 右对齐 ⇒ 标题落在数字上方（说明那一条留空）。
        //   ⚠️ 用 **grid**（`54px 70px`）而不是 flex：flex 里只放一个孩子时那个 `gap` 会把这一格
        //   撑到"整列宽 − gap"，标题又被推到列右边缘（实测 876，还是不对）。
        const h = el('span', flex + 'display:grid;grid-template-columns:54px 70px;');
        h.appendChild(el('span', 'text-align:right;', text));
        head.appendChild(h);
    }
    return head;
}

/** 一行（导出理由同上：测量链要单独画这张表；⚠️ 它与「每期完成情况」**共用同一份行渲染**） */
export function problemRow(e) {
    const node = AppState.nodes[e.id] || {};
    const row = document.createElement('div');
    row.className = 'plan-list-row';
    row.dataset.planRow = e.id;
    // ⚠️ **整行一律垂直居中**（用户 2026-10-15："能不能**全部垂直居中**，别微调了"）：
    //    `align-items:center` ⇒ 每一格都按**自己内容的高度**居中 ⇒ 行高由最高的那格决定，
    //    其余各格自动落在同一条中线上 —— **不管哪一列更高都不会互相错位**。
    //    ⚠️ 居中只是"按各自的行盒居中"⇒ 还要**让各格的行盒一样高**：这里**不写 `line-height`**
    //    （用它缺省的 normal），入口条那边也**不写 font-size、不换字体**（见 `ui/kit/nodeEntry.js`）
    //    ⇒ 全行的行盒都是 12px×normal，居中的结果就是同一行字、同一层底色框。
    //    （曾试过 `flex-start`、`baseline`、以及给行定 `line-height:1.6`：前两个要逐格算行高、
    //      最后一个把行撑到 30px。就这条简单规则对。）
    row.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:12px;'
        + 'color:#475569;padding:3px 0;cursor:pointer;border-bottom:1px solid #f8fafc;';
    row.title = '点一下跳到树上这个节点';
    const w = (i) => LIST_COLS[i][1];
    row.appendChild(el('span', w(0), node.problemId || ''));
    row.appendChild(el('span', w(1) + 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', node.name || e.id));
    // ★ 第 14 轮：难度文本用**难度自己的颜色**（唯一色表 `XCPC_COLORS`，与树上那个方框同一份）；
    //   「未填写」不在那张表里 ⇒ 保持原来的灰。
    const lv = String(e.level || '');
    const lvColor = XCPC_COLORS[lv];
    row.appendChild(el('span', w(2) + (lvColor ? `color:${lvColor};` : ''), lv));
    const st = el('span', w(3) + 'display:flex;align-items:center;gap:4px;');
    const dot = el('span', 'width:8px;height:8px;border-radius:50%;display:inline-block;', '');
    dot.style.background = STATUS2_COLORS[e.s2] || '#e2e8f0';
    st.appendChild(dot);
    st.appendChild(el('span', '', `${e.s2} ${STATUS2_LABELS[e.s2] || ''}`));
    row.appendChild(st);
    row.appendChild(el('span', w(4), e.time || ''));
    // ★ 第 23 轮（用户："上面的强度还是没对齐"）：**"（没填难度）"这串字以前跟数字挤在同一格里**，
    //   格是 `text-align:right` ⇒ 它把数字**往左推**，于是这一列的数字跟别的行对不上一条竖线。
    //   现在**数字单独一格**（固定宽 + 右对齐 ⇒ 右端一条竖线），说明文字是**另一格**、排在它左边。
    //   ★ 第 12 轮的口径不变：没填难度的题**强度记 0**，只是不再让说明文字破坏对齐。
    // ★ 第 26 轮定稿（用户："改淡色绝对是错的" ⇒ 说明**原文保留**）：**数字那一格先摆**（定宽 54 + 右对齐，
    //   于是它的右端就是整格的右端），**说明跟在数字后面** ⇒ 那一行是**向左**长出去的，
    //   数字的右端不受影响（实测各行数字右端全相等）。列宽要能容下"数字格 54 + 间隙 4 + 说明 ≈70"
    //   ⇒ `LIST_COLS` 里那一列给 **132px**（原来 60px 装不下，靠右收时把数字挤出列外 20px）。
    const inten = el('div', w(5) + 'display:flex;align-items:baseline;gap:4px;');
    if (e.usedDefault) inten.title = '这道题没填难度 ⇒ 强度记 0，不计入训练强度的合计';
    inten.appendChild(el('span', 'flex:0 0 54px;text-align:right;', fmt(e.intensity)));
    if (e.usedDefault) inten.appendChild(el('span', '', '（没填难度）'));
    row.appendChild(inten);
    // ★ 节点那一列（用户 2026-10-15："还是题名和完整面包屑都有为好 —— 即**增加若干列**"）：
    //   题名留着（上面那一格），这里**另起一格**装 `nodeEntryLine` 的紧凑形态 ——
    //   身份键 + 完整面包屑（含自己、全蓝，**它自己就是 🔎**）+ 📋，三样都是现成那一份。
    const nodeCell = el('div', w(6) + 'display:flex;align-items:center;min-width:0;');
    // 树上真的没有这个节点 ⇒ **如实写一句**（不画假链接 —— 与 `nodeEntryLine` 同一条规矩）
    if (AppState.nodes[e.id]) nodeCell.appendChild(nodeEntryLine(AppState, node, { compact: true }));
    else nodeCell.textContent = '（树上没有这个节点）';
    row.appendChild(nodeCell);
    row.addEventListener('click', (ev) => {
        // ⚠️ 那一格里的面包屑（🔎）与 📋 自己就是交互 ⇒ 点它们**不许**再走"整行跳树"，
        //    否则一次点击要么派发**两颗** `REVEAL_NODE`、要么"跳树 + 开详页"一起发生。
        //    ⚠️ 判据只查**单类** `.node-entry`（列里的三格都在它里面）—— DOM 桩的 `closest`
        //       **不认逗号选择器**（`docs/ui-conventions.md` 的「8. 冒烟 / DOM 桩的边界」一节）。
        const t = ev && ev.target;
        if (t && typeof t.closest === 'function' && t.closest('.node-entry')) return;
        document.dispatchEvent(new CustomEvent(EVENTS.REVEAL_NODE, { detail: { nodeId: e.id } }));
    });
    return row;
}

// ================================================================
// ③ 状态 × 难度（与统计页**完全同一份渲染**）
// ================================================================

/** 这一份分档数据：`{ 难度档: { 状态2: 题数 } }`（与统计页柱子吃的是同一种形状） */
export function planGridDataOf(entries) {
    const data = {};
    for (const e of entries) {
        // ⚠️ `e.level` 已经是**分档后的名字**（`planPageDataOf` 走的就是统计页那份 `xcpcBucketOf`）
        //    ⇒ 别再映射一次（映射两次正是"点未填写那列筛出 0 条"的来头）
        const key = e.level || XCPC_UNFILLED;
        if (!data[key]) data[key] = {};
        data[key][e.s2] = (data[key][e.s2] || 0) + 1;
    }
    // 列序：按 `XCPC_ORDER`（**易 → 难**：签到最左 … C+ 最右），「未填写」殿后
    // —— 与统计页 `buildXcpcData` **同一套**（用户第 5 轮："应该全都易→难"）
    const ordered = {};
    for (const level of XCPC_ORDER) if (data[level]) ordered[level] = data[level];
    if (data[XCPC_UNFILLED]) ordered[XCPC_UNFILLED] = data[XCPC_UNFILLED];
    return ordered;
}

/**
 * 画那一块（网格本体交给 `ui/stats/statusGridView.js`）。
 * 点某一格 ⇒ **筛下面的题目列表**（列表块会跟着重画）。
 */
export function renderGridBlock(plan, data, redraw) {
    const card = el('div', 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;');
    card.dataset.planBlock = 'stats';
    card.appendChild(el('h3', 'margin:0 0 8px;font-size:14px;font-weight:600;color:#334155;', '📊 状态 × 难度'));
    const host = el('div', 'overflow-x:auto;');
    host.dataset.planBlock = 'stats-grid';
    const view = planSectionViewOf(AppState, plan.id).list;
    renderStatusGrid(host, planGridDataOf(data.entries), {
        barWidth: 40,
        showLevelNames: true,
        selectedLevel: (view.levels && view.levels.length === 1) ? view.levels[0] : '',
        selectedStatus: view.statuses.length === 1 ? view.statuses[0] : '',
        onSegmentClick: (level, s2) => {
            // 与统计页同一个手感：点格子 = 把这一批筛出来（这里筛的是**这条计划的题目列表**）
            // ⚠️ 难度档是**多选**（第 4 轮）⇒ 点格子 = 把选择**换成**这一档（只勾它一个）
            const patch = { list: { open: true, page: 1, q: '', levels: [level] } };
            patch.list.statuses = (s2 === 'all') ? [] : [Number(s2)];
            patchView(plan.id, patch, redraw);
        }
    });
    card.appendChild(host);
    return card;
}

// ================================================================
// 第 3 轮 · 「当前强度表」：这张计划用的是哪张表、每档多少强度（只读；要改去设置页）
// ================================================================

/**
 * 画「当前强度表」那一块（用户 2026-10-13 第 3 轮："强度表的数值在哪看?"）。
 *
 * 只读展示**这条计划实际在用的那张表**的数值：默认强度 + 每个档位 + 数值区间；
 * 「⚙️ 去设置里编辑」跳设置页那一栏（`setSettingsSection('intensity')`）。
 * ⚠️ 表本身只有一份（`settings.trainingIntensityTables`，空 = 内置那张）—— 这里**不改数据**。
 */
export function renderIntensityBlock(plan, data, redraw) {
    const view = planSectionViewOf(AppState, plan.id).intensity;
    const card = el('div', 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;');
    card.dataset.planBlock = 'intensity';
    const table = intensityTableById(AppState.settings.trainingIntensityTables, plan.intensityTableId);
    const isBuiltin = !plan.intensityTableId;
    const srcLabel = plan.intensitySource === 'cf' ? '数值难度' : 'XCPC 难度（按通过率）';
    card.appendChild(blockHead('intensity',
        `🏋️ 当前强度表：${table.name}${isBuiltin ? '（内置默认）' : ''}（按 ${srcLabel}）`,
        view.open, () => patchView(plan.id, { intensity: { open: !view.open } }, redraw)));
    if (!view.open) return card;

    const toSet = document.createElement('button');
    toSet.className = 'btn';
    toSet.dataset.planAction = 'intensity-edit';
    toSet.textContent = '⚙️ 去设置里编辑';
    toSet.title = '跳到「设置 → 🏋️ 训练强度」（改一张表，所有引用它的计划一起变）';
    toSet.addEventListener('click', () => {
        import('../settings/settingsPage.js').then(async (m) => {
            const tabs = await import('../tabs.js');
            tabs.switchTab('settings');
            m.setSettingsSection('intensity');
        });
    });
    card.appendChild(toSet);

    // ---- 通过率的控制点（第 5 轮：XCPC 侧改成"按通过率查表、点之间相接"）----
    // ★ 第 10 轮去掉"≤"（用户："'通过率 ≤ X' 的说法可以去掉了"）：这些点是**曲线上的点**
    //   （"通过率取它时强度是多少"），不是"不超过它就算这一档"的台阶 —— 老写法会让人以为点之间是跳变的。
    card.appendChild(el('div', 'font-size:11px;color:#94a3b8;margin-top:8px;',
        'XCPC 难度 → 强度（按「通过率」查表：每一点写"通过率取它时强度是多少"，通过率越低越重；'
        + `点之间${intensityJoinLabelOf(table.mode)}）`));
    const ratioRows = (table.byRatio || []).slice().reverse();
    // ★ 第 11 轮：**列优先**（一列读到底再换下一列）且**最多 3 列**（用户："表能不能按列连续 1~3列"）。
    //   行优先时 22 个点会横铺成 9 列，读完一行再折回来 —— 与"越往下越难"的直觉相反。
    const cols = Math.max(1, Math.min(3, ratioRows.length));
    const perCol = Math.max(1, Math.ceil(ratioRows.length / cols));
    // ★ 第 17 轮（用户："强度和数值没对齐" / "强度表中间太空了 而且应该是相对应的文本更靠近,而非分居两侧"）：
    //   每一对是**两列**（档名 / 强度值），行与行靠 CSS 网格对齐；对内只隔 6px（那个"小空"）。
    // ★ 第 21~22 轮（用户："文本左对齐。" ⇒ 收口）：**一个列 = 一个网格**，一个"网格"= 一对（标签 + 值），
    //   列里**所有对**共用同一组两条轨道 ⇒ **两条竖线同时成立**：
    //   · 标签列宽 = 本列**最长的档名**（列内统一）+ 标签 `justify-self:start` ⇒ **档名左端对齐**；
    //   · 值列宽 = 本列**最宽的强度值** + 值 `justify-self:end` + `text-align:right` ⇒ **值右端点对齐**；
    //   · 两条轨道之间的 `column-gap:6px` ⇒ 对内**恒为 6px**。
    //   ⚠️ 上一版（每条对各是一个网格）做不到"值右端点齐"：每条对的标签列宽各按自己那条算
    //      ⇒ 值列在列内不是同一个位置（档名长的把值推远）。**必须是"一个列一个网格"**。
    // ⚠️ `white-space:nowrap` 是**保命的**：窗口窄了宁可整块横向溢出，也**不许**把档名逐字折行
    //   （第 18 轮我在外层用过 `max-content` 而没有 nowrap ⇒ 整张表糊成一竖条，用户："xcpc难度也改得更坏了"）。
    //   ⚠️ 也别退回 `minmax(132px,220px)`：那正是"值被顶到列右边缘"的原因。
    const ratio = el('div', 'display:flex;align-items:flex-start;gap:18px;margin-top:4px;'
        + 'font-size:12px;color:#475569;');
    // 展示顺序 = **易 → 难**（通过率从高到低，用户第 5 轮："应该全都易→难"）；
    // ⚠️ 表里存的那一份必须是**升序**（`intensityAtPoints` 要按 max 升序插值）⇒ 这里只反着画。
    // 分列**列优先**（一列读到底再换下一列，用户第 11 轮："表能不能按列连续 1~3列"）。
    for (let ci = 0; ci < cols; ci++) {
        const colRows = ratioRows.slice(ci * perCol, (ci + 1) * perCol);
        const col = el('div', 'display:grid;grid-template-columns:max-content max-content;'
            + `grid-template-rows:repeat(${colRows.length},auto);justify-content:end;align-items:start;`
            + 'gap:4px 6px;max-width:max-content;white-space:nowrap;');
        for (const p of colRows) {
            const cell = el('div', 'display:contents;');
            cell.dataset.intensityRatio = String(p.max);
            // 左边那半句（档名 / 拐点 / 「0.031%及更小」）只有一份：`core/trainingPlan.js:xcpcPointTextOf`
            // ★ 第 14 轮：真档名那一格用**难度自己的颜色**（`XCPC_COLORS`）；「拐点」「到顶」「手加的点」
            //   不是档位 ⇒ 仍是灰的（`xcpcPointLabelOf` 给的旁注就是判据）。
            const tier = XCPC_COLORS[xcpcPointLabelOf(p.max)];
            // ★ 第 24 轮（**真浏览器量出来的**）：`display:contents` 的那一对里，两格是
            //   **inline 的 span** ⇒ `justify-self` 对它们**不起作用**（量到的"对内间隙"有 6~45px 好几种，
            //   就是标签各自被推到轨道中间了）。改成 `text-align`：span 默认 stretch 满轨道，
            //   左格 `text-align:left`、右格 `text-align:right` ⇒ 间隙恒为轨道间那 6px。
            //   ⚠️ 教训：**`display:contents` 的子元素别再依赖 `justify-self`/`align-self`**。
            cell.appendChild(el('span', `text-align:left;color:${tier || '#94a3b8'};`,
                xcpcPointTextOf(p.max)));
            cell.appendChild(el('span', 'text-align:right;font-weight:600;color:#0f172a;',
                fmt(p.value)));
            col.appendChild(cell);
        }
        ratio.appendChild(col);
    }
    card.appendChild(ratio);

    // ---- 数值侧的控制点 ----
    const cf = el('div', 'margin-top:8px;font-size:12px;color:#475569;');
    cf.dataset.intensityCf = '1';
    // ★ 第 12 轮去掉"≤"；第 11 轮上限那一点写「4000及以上」（同样是"这个值以及更高的"）
    // ★ 第 16 轮（用户："数值难度也要对应的颜色(cf)"）：**分值用 CF 的色**（`getCfColor`，
    //   与树里那个数值难度、统计页 CF 柱子同一份色表）；「（兜底）」没有分值 ⇒ 不上色。
    // ★ 第 17 轮（同上一块："强度和数值没对齐"）：**一行一对**，档名与强度值之间只有 6px，
    //   而"→ 强度"那一列在整块里**上下对齐**（网格列宽由最长的那句话定）。
    //   ⚠️ 这里是拼字符串（与"每期完成情况"那张表同一套写法）；左侧那个 `data-intensity-cf` 钩子还在**每对**上。
    // ⚠️⚠️ **别改这一段的排版**（第 18 轮试过 flex 换行版，是**倒退**）：用户 2026-10-13 明确说
    //   "**原来的数值难度很好,你怎么改了?**" ⇒ 这一段恢复成他看过并认可的那一版（`max-content` 三列 + 全角空格）。
    const rows = (table.byCf || []).map((r, i) => {
        const cf = (r.max === null || r.max === undefined || r.max === '') ? null : Number(r.max);
        const color = Number.isFinite(cf) ? getCfColor(cf) : '';
        return `<div data-intensity-cf="${i}" style="display:flex;gap:6px;">`
            + `<span style="text-align:right;${color ? `color:${color};` : ''}">${cfPointTextOf(r.max)}</span> → `
            + `<span style="text-align:left;font-weight:600;color:#0f172a;">${fmt(r.value)}</span></div>`;
    }).join('');
    cf.innerHTML = `<div style="font-size:11px;color:#94a3b8;">数值难度 → 强度（同样是控制点，`
        + `${intensityJoinLabelOf(table.mode)}；${CF_INTENSITY_TOP} 分封顶，末点上限留空 = 兜底）</div>`
        + `<div style="display:grid;grid-template-columns:max-content max-content max-content;`
        + 'justify-content:start;gap:4px 12px;margin-top:4px;">'
        + (rows || '<div>（没配控制点）</div>') + '</div>';
    card.appendChild(cf);
    // ★ 第 12 轮：没填难度的题**强度记 0**（不是"按默认强度算"）⇒ 这块不再写默认强度那个数
    const def = el('div', 'margin-top:6px;font-size:12px;color:#475569;');
    def.dataset.intensityDefault = '1';
    def.textContent = '没填难度的题强度记 0（不计入）';
    card.appendChild(def);
    // ⚠️ 界面文案里**不许写 Markdown 的 `**`**（用户报过"星号漏了"）—— 要强调就用「」或加粗元素，
    //    别靠"写完再 `.replace(/\*\*/g,'')` 擦掉"（那种写法只在字面量整串上成立，一拼接就失效）。
    card.appendChild(el('div', HINT, '这张表是规则：改它 ⇒ 所有引用它的计划一起变。'));
    return card;
}
// ================================================================
// ④ 每期完成情况：可折叠 / 分页 / 范围筛选（**年-月-日三级下拉，照热力图那套**）
// ================================================================

/** 这一期覆盖的**第一天 / 最后一天**（范围筛选按"期与区间有重叠"判，不按"起点落在区间里"） */
export function periodSpanOf(key, grain, planEndKey = '') {
    const g = String(grain || 'day');
    if (g === 'all') return { first: '', last: planEndKey || '' };
    if (g === 'month') {
        const m = /^(\d{4})\.(\d{2})$/.exec(String(key || ''));
        if (!m) return { first: '', last: '' };
        const days = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
        return { first: `${m[1]}.${m[2]}.01`, last: `${m[1]}.${m[2]}.${String(days).padStart(2, '0')}` };
    }
    if (g === 'week') {
        // 期键就是那一周的周一
        const p = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(String(key || ''));
        if (!p) return { first: '', last: '' };
        const t = Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3])) + 6 * 86400000;
        const last = new Date(t);
        return {
            first: String(key),
            last: `${last.getUTCFullYear()}.${String(last.getUTCMonth() + 1).padStart(2, '0')}.${String(last.getUTCDate()).padStart(2, '0')}`
        };
    }
    return { first: String(key || ''), last: String(key || '') };
}

/** 区间筛选（**唯一一份**：列表与计数都用它） */
export function filterPeriods(periods, { from = '', to = '' } = {}, grain = 'day', planEndKey = '') {
    return (periods || []).filter((p) => {
        const span = periodSpanOf(p.key, grain, planEndKey);
        if (from && span.last && span.last < from) return false;      // 整期都在起点之前
        if (to && span.first && span.first > to) return false;        // 整期都在终点之后
        return true;
    });
}

/**
 * 「📈 每期完成情况」**一整块**：范围筛选 + 期表 + 两张图（第 5 轮合成，用户：
 * "现在'每期完成情况'与两个图表你放在同一块，不妨让'每期完成情况'的时间区间对**这一整块**生效，
 * 这一整块要命名"）。
 *
 * @param {Object} plan
 * @param {Object} data 这张表用的那一份（按计划自己的执行粒度）
 * @param {Function} redraw
 * @param {{dataOf:(grain:string)=>Object}} opts `dataOf` 由调用方传（本文件不许 import `planPage.js` ——
 *        那边 import 本文件，硬引会成环）。**两张图必须用它**：它已经把区间卡进去了
 *        （见 `planPage.js:planPageDataOf(plan, grain, range)`）。
 */
export function renderPeriodsBlock(plan, data, redraw, opts = {}) {
    const view = planSectionViewOf(AppState, plan.id).periods;
    const card = el('div', 'border:1px solid #e2e8f0;border-radius:10px;padding:12px;background:#fff;margin-bottom:12px;');
    card.dataset.planBlock = 'periods';
    const grainLabel = { day: '日', week: '周', month: '月', all: '整段' }[data.grain] || data.grain;

    // 范围筛选（与热力图那一套同一个形状：起止各 年/月/日 + 「确定」+「全部」）
    const fromKey = view.from;
    const toKey = view.to;
    // ★ 第 13 轮（用户报的"**卡死在 2 条**"）：**区间一设，期表也跟着放宽** ——
    //   以前只有两张图走 `dataOf(grain)`（区间被当成 `planProgressOf` 的 `startKey`/`endKey`），
    //   而**表**只吃"计划开始 → 现在"那一份 + `filterPeriods`（只能往里**缩**）⇒
    //   计划刚建时（期只有 2 条）把区间拉大到 7 月也**永远只看到 2 条**。
    //   现在表与图用**同一个窗口**：`dataOf(data.grain)` 就是"带区间的那一份"，
    //   没设区间时它就是 `data` 本身（计划自己的范围）。
    const ranged = !!(fromKey || toKey) && typeof opts.dataOf === 'function';
    const windowData = ranged ? opts.dataOf(data.grain) : data;
    const all = windowData.periods;
    const kept = filterPeriods(all, { from: fromKey, to: toKey }, data.grain, windowData.planEndKey);
    // 这一块的**名字**（用户第 5 轮："这一整块要命名"）：表与两张图都在它下面
    card.appendChild(blockHead('periods',
        '📈 每期完成情况（这块的时间区间对「表 + 两张图」一起生效）', view.open,
        () => patchView(plan.id, { periods: { open: !view.open } }, redraw)));
    if (!view.open) return card;
    card.appendChild(el('div', HINT, `按${grainLabel}，${kept.length} 期`
        + (ranged ? `（只看 ${fromKey || '最早'} ~ ${toKey || '现在'}）` : '（计划开始 → 现在）')
        + '；表按计划自己的执行粒度，下面两张图各有各的查看粒度 —— 但都只用上面这段区间。'
        + '　点表里某一行或图上某一根/某一点 ⇒ 下面列出那一期做了哪些题。'));

    // ★ **点某一期 ⇒ 选中的那一期**（第 6 轮）：表与两张图点的是**同一个键**（视图态 `periods.pick`）。
    //   点击只在**这一块容器**上挂一条委托（真实浏览器里 SVG 里那些形状也会冒泡到这儿）；
    //   ⚠️ 别给表格行/图形各挂一个监听（那样两处实现、还会随重画叠加）。
    const pickedKey = String(view.pick || '');
    card.addEventListener('click', (ev) => {
        const hit = ev && ev.target && ev.target.closest ? ev.target.closest('[data-plan-period]') : null;
        if (!hit) return;
        const key = (hit.dataset && hit.dataset.planPeriod) || '';
        if (!key || key === pickedKey) return;
        patchView(plan.id, { periods: { pick: key } }, redraw);
    });

    const picker = buildDateRangePicker({
        startPrefix: 'plan-range-start',
        endPrefix: 'plan-range-end',
        from: fromKey,
        to: toKey,
        defaultFrom: data.startKey || '',
        defaultTo: data.endKey || '',
        applyAction: 'periods-apply',
        resetAction: 'periods-reset',
        onApply: (r) => patchView(plan.id, { periods: { from: r.from, to: r.to, page: 1, pick: '' } }, redraw),
        onReset: () => patchView(plan.id, { periods: { from: '', to: '', page: 1, pick: '' } }, redraw)
    });
    card.appendChild(picker);

    if (!kept.length) {
        card.appendChild(el('div', HINT, '这一段里没有期 —— 把范围放宽，或点「全部」。'));
        return card;
    }

    // ★ **越新的越靠前**（用户 2026-10-13 第 3 轮；第 4 轮外层栏也照这条）。只改**这张表**的顺序；
    //   ⚠️ 两张图**不能**倒过来（折线的 x 轴必须按时间正序），它们另走 `dataOf(grain)`。
    //   规则只有一份：`core/trainingPlan.js:periodsNewestFirst`（别在这儿 `reverse()`）
    const desc = periodsNewestFirst(kept);
    // ★ 第 15 轮（用户："这里的表 放3列 就可以一次看30条了"）：这张表按**3 列**排 ——
    //   **列优先**（一列读到底再换下一列；与他第 11 轮对强度表的要求同一条），
    //   每列 `view.pageSize` 条 ⇒ **一页 = 3 × pageSize 条**（改之前一页只有 pageSize 条）。
    //   ⚠️ 于是 `periods.pageSize` 的含义从"每页几条"变成"**每列**几条"（默认 12 ⇒ 一页 36 条；
    //      用户那 32 期**一次就全看见了**）。⚠️ 别指望改默认值能生效 —— 这个对象是**默认填满**再存进
    //      视图态的（`setPlanSectionView`），老浏览器里已经存着 12；所以这里的"每页"必须由列数乘出来。
    // ★ 就是这个常量在管"一页几条"的另一半（第 17 轮被问过一次，特此点名）：
    //   `PERIOD_COLS`(= 3) × `view.pageSize`(= 每列几条，默认 12) ⇒ **一页 36 条**。
    //   表就横排这么多张（下面按 `perCol` 切段）；要"一屏看得更多"改这两个数之一，别另开一份逻辑。
    const PERIOD_COLS = 3;
    const perPage = view.pageSize * PERIOD_COLS;
    const pageCount = Math.max(1, Math.ceil(desc.length / perPage));
    const page = Math.min(view.page, pageCount);
    const slice = desc.slice((page - 1) * perPage, page * perPage);
    const unit = data.goalMode === 'count' ? '题' : '强度';
    const perCol = Math.max(1, Math.ceil(slice.length / PERIOD_COLS));
    const chunks = [];
    for (let i = 0; i < slice.length; i += perCol) chunks.push(slice.slice(i, i + perCol));
    const body = el('div', 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;');
    body.dataset.planPeriodsTable = '1';       // 冒烟钩子（表体是拼 innerHTML 的，桩里只有字符串）
    // ★ 每行可点（第 6 轮："点击并呼出题目列表"）：`data-plan-period` 就是期键；
    //   点击由**本块容器**上那条委托接住（图表里那些 `<rect>`/`<circle>` 也带同一个属性 ⇒ 同一条路）
    const head = '<tr>'
        + `<th style="${TH}">期（${escapeHtml(grainLabel)}）</th><th style="${TH};text-align:right;">题数</th>`
        + `<th style="${TH};text-align:right;">Σ${unit}</th><th style="${TH};text-align:right;">目标</th>`
        + `<th style="${TH}">达标</th></tr>`;
    const rowOf = (p) => `<tr data-plan-period="${escapeHtml(p.key)}" title="点一下看这一期做了哪些题" `
        + `style="cursor:pointer;${p.key === pickedKey ? 'background:#eff6ff;' : ''}">`
        + `<td style="${TD}">${escapeHtml(p.label)}</td>`
        + `<td style="${TD};text-align:right;">${p.count}</td>`
        + `<td style="${TD};text-align:right;">${fmt(p.intensity)}</td>`
        + `<td style="${TD};text-align:right;">${fmt(p.goal)}</td>`
        + `<td style="${TD}">${p.reached === null ? '—' : (p.reached ? '✅' : '⬜')}</td></tr>`;
    body.innerHTML = chunks.map((c) => '<table style="border-collapse:collapse;">' + head
        + c.map(rowOf).join('') + '</table>').join('');
    card.appendChild(body);
    card.appendChild(pager('periods', page, pageCount, kept.length,
        (n) => patchView(plan.id, { periods: { page: Math.min(Math.max(1, n), pageCount) } }, redraw)));

    // 警示（⑰：没填难度的题按默认强度算）——由调用方算好传进来（本块只负责画在这一块里）
    const warns = Array.isArray(opts.warns) ? opts.warns : [];
    if (warns.length) {
        const w = el('div', 'font-size:12px;color:#b45309;margin-top:6px;', '⚠️ ' + warns.join('　'));
        w.dataset.planBlock = 'warn';
        card.appendChild(w);
    }

    // ---- 这一期做了哪些题（第 6 轮；用户："每期完成情况内还应有每期完成的题目列表，实现同训练强度追踪"）----
    //   数据来源就是同一份 `data.entries`（每一条都带 `periodKey` 与 `done`）——**不另算一遍**
    card.appendChild(renderPeriodProblems(plan, data, pickedKey, redraw));

    // ★ 两张图也画在**这一块里**（第 5 轮合并）；区间对它同样生效 —— 因为 `opts.dataOf` 已经把区间
    //   传给了 `planProgressOf`（这里只是"照它给的数据画"）。`pick` 传下去是为了高亮+点击同一期。
    if (typeof opts.dataOf === 'function') {
        card.appendChild(renderChartsBlock(plan, opts.dataOf, redraw, { pick: pickedKey }));
    }
    return card;
}

/**
 * 「这一期做了哪些题」那一小块（**只读 + 可跳转**；与题目列表**共用同一个行渲染器**）。
 *
 * @param {string} pickedKey 期键（'' = 没选 ⇒ 整块不画）
 */
function renderPeriodProblems(plan, data, pickedKey, redraw) {
    const box = el('div', '');
    box.dataset.planBlock = 'period-problems';
    if (!pickedKey) return box;
    const period = (data.periods || []).find((p) => p.key === pickedKey) || null;
    const all = (data.entries || []).filter((e) => e.periodKey === pickedKey);
    // "完成的" = 与表格那一列的"题数/Σ强度"同一口径（`done` 由计划选的那几个状态2 定）
    const done = all.filter((e) => e.done).sort((a, b) => String(b.time || '').localeCompare(String(a.time || '')));
    const head = el('div', 'display:flex;align-items:center;gap:8px;margin-top:8px;');
    head.appendChild(el('div', 'font-size:12px;font-weight:600;color:#334155;',
        `📋 ${period ? period.label : pickedKey} 做了哪些题（完成 ${done.length} 道${all.length > done.length ? `，共落了 ${all.length} 道` : ''}）`));
    const close = document.createElement('button');
    close.className = 'btn';
    close.style.cssText = 'padding:0 10px;font-size:11px;line-height:1.5;';
    close.dataset.planAction = 'period-pick-clear';
    close.textContent = '✖ 收起';
    close.addEventListener('click', () => patchView(plan.id, { periods: { pick: '' } }, redraw));
    head.appendChild(close);
    box.appendChild(head);
    if (!done.length) {
        box.appendChild(el('div', HINT, '这一期没有"算做完"的题（点上面表格/图里别的期看看）。'));
        return box;
    }
    box.appendChild(el('div', HINT, '点某一行跳到树上那个节点（与「题目列表」同一套行）。'));
    box.appendChild(problemHead());
    for (const e of done) box.appendChild(problemRow(e));
    return box;
}
