// ================================================================
// 判重整理页（ui/dedup/dedupPage.js）
//
// 位置：**主视图之前**的一个独立页（index.html 的静态分页按钮，见 ui/tabs.js）。
//
// 这一页做的是**归属**（不是"两边填同一个值 ⇒ 等价"那种对称判定）：
// 合成节点是树上一个**真节点**（身份「合成标识」`synthKey`），原料节点靠
// 「所属合成节点」`ownerSynth` 指向它。所以这一页的职责变成四件事：
//
//   ① **合成节点清单**：每个合成标识、标题、类型、成员数、成员列表；
//      操作 = 改名（同一事务里批量重写所有成员指针）/ 解绑成员 / 删除合成节点；
//   ② **可能重复**：**推荐**某个还没归属的原料"该归入哪个合成节点"
//      （或"和谁一起新建一个"）—— **只推荐，绝不判定、绝不自动写**；
//   ③ **性质待补**：**大类已标、小类 / 年份 / 地区还有空缺**的节点，
//      按「大类 + 年份」分组列出来，让人**勾选 + 一次性批量填**（口径在 `core/dedup.js`
//      的 `missingNatureKeysOf` / `collectNaturePendingItems` / `groupNaturePending`）；
//   ④ **概览**（页尾小结）：数一数有多少合成节点、多少原料归入了、多少还散着。
//
// ⚠️ **四块 = 四栏二级 tab**（四块同屏堆叠占版面略大、不好翻）
//    ⇒ 一次只画一栏（`sectionBar()`，栏名带条数）。
//    `viewState.section` 只决定"画哪块"；筛选范围 / 关键词 / 模式照旧留在 `viewState` 里，
//    **切栏不清条件**（切栏 = `redraw()`，与直接重画同一条路）。
//
// 判定规则**只有一条**（`core/dedup.js`）：`ownerSynth` 非空且相等 ⟺ 同一个组。
// 相似度只决定"说不说"，**不参与判定** —— 推荐你随时可以无视。
//
// ⚠️ **悬空指针**（指向不存在的合成标识）不炸、也不丢：单独一条黄条列出来，
//    配「一键清理」（`core/ops/synth.js` 的 `clearDanglingOwners`）。
//    ⚠️ 这类坏数据**只可能来自历史存档 / 坏包** —— 写路径（归入、新建、导入）
//    直接拒绝产生悬空指针；读路径只负责把它们**显示**出来。
//    ⚠️ **同一类**的坏数据（计数口径 `collectGroups` 报出的"`ownerSynth` 写成节点 id"、
//    "两个节点共用一个 `synthKey`"）也并进这**同一条黄条**（只列文字，没有写操作）——
//    不另造警告面板；已经在悬空那半句里的节点不重复列。
//
// ⚠️ **两万条也不能卡**：
//   · 三个清单都**分页**（每页 25 条），DOM 只画当前页；
//   · 计算结果**按数据变化缓存**（翻页不重算）；数据变了由 tabs.js 调
//     `invalidateDedupCache()` 明确作废 —— 不做玄学的过期时间；
//   · 重活（两两比相似度）在 `core/dedup.js` 里已被"分桶 + 分块 + 总量预算"挡住。
// ================================================================
import { AppState } from '../../shell/state.js';
import { EVENTS } from '../../A_constants.js';
import { execute } from '../../shell/executor.js';
import {
    createSynthNode,
    assignSynthKey,
    bindOwner,
    unbindOwner,
    clearDanglingOwners,
    findDanglingOwners,
    isSynthKeyTaken,
    findReusableSynthSibling,
    synthKeyOf
} from '../../core/ops/synth.js';
import { deleteNode } from '../../core/ops/tree.js';
import { ensureUniqueName } from '../../core/ops/_helpers.js';
import { updateP, updateWS, updateR } from '../../core/ops/node.js';
import {
    synthGroups,
    unownedMaterialIds,
    suggestMembers,
    emptyDedupFilter,
    collectDedupFacets,
    scopeNodeIds,
    collectNaturePendingItems,
    collectNatureItems,
    groupNaturePending,
    NATURE_NO_MAIN_LABEL,
    SUGGEST_REASON,
    DEDUP_SCOPE_KINDS,
    DEDUP_OWNED_VALUES
} from '../../core/dedup.js';
import {
    NATURE_FIELD_KEYS,
    CLASS_PATHS,
    classLabel,
    classMatches,
    classPathOf,
    classPathProblem,
    classRootOf,
    isCompleteClassPath,
    natureFieldOf,
    isNatureYear,
    isNatureSeason,
    natureInputSuggestions,
    NATURE_REGISTRY_VERSION
} from '../../core/natureFields.js';
import { collectGroups } from '../../core/query/groupCount.js';
import { escapeHtml } from '../../utils/html.js';
import { buildLinkBlock } from '../../view/linkChips.js';
import { suggestNatureYear, suggestNatureSeason, suggestNatureFields } from '../../core/natureSuggest.js';
import { collectNatureAssignments } from '../../core/natureAssignments.js';
import { RULE_LEVELS, MANUAL_LEVEL, levelLabel, levelRank, classLevelOf, classRuleOf } from '../../core/natureConfidence.js';
import { showToast } from '../G_modal/G_modals.js';
import { showPromptDialog, showDeleteConfirm, showFormDialog } from '../G_modal/G2_common.js';
import { mk } from '../../utils/dom.js';
import { viewState } from './state.js';
import { button, wireGotoLinks } from './kit.js';
import { computeModel, invalidateDedupCache } from './model.js';
import { synthSection } from './synthSection.js';
import { candidateSection } from './candidateSection.js';
import { naturePendingSection } from './naturePending.js';
import { summarySection } from './summary.js';
import { conflictSection } from './conflictSection.js';

// 公开面（`ui/tabs.js` 按这两个名字用）—— 实现分别在 model.js 与本文件，**别在这里再抄一份**
export { invalidateDedupCache } from './model.js';


export function renderDedupPage(containerId = 'tab-dedup') {
    const container = document.getElementById(containerId);
    if (!container) return null;

    const model = computeModel();

    container.innerHTML = '';
    const root = mk('div', 'dedup-page', 'padding:16px;');
    container.appendChild(root);

    const h = mk('h2', '', 'margin:0 0 4px;font-size:18px;');
    h.textContent = '🧩 判重整理';
    root.appendChild(h);

    const note = mk('div', '', 'font-size:12px;color:#64748b;line-height:1.7;margin-bottom:12px;');
    note.innerHTML = '各渠道各自产出自己的节点，互不改动。'
        + '<b>合成节点</b>是树上一个真节点（身份「合成标识」），原料节点靠<b>「所属合成节点」</b>指针归入它；'
        + '<b>清空指针即解绑</b>。'
        + '下面的推荐只是提示，<b>只有指针决定归属</b>。';
    root.appendChild(note);

    const redraw = () => { renderDedupPage(containerId); };
    wireGotoLinks(root);
    const sections = [
        { id: 'synth', label: '① 合成节点', count: model.groups.length, build: () => synthSection(model, redraw) },
        { id: 'dupes', label: '② 可能重复', count: model.candidates.length, build: () => candidateSection(model, redraw) },
        { id: 'nature', label: '③ 性质待补', count: (model.pendingItems || []).length, build: () => naturePendingSection(model, redraw) },
        { id: 'summary', label: '④ 概览', count: null, build: () => summarySection(model) },
        // ★ **⑤ 冲突**这一栏：应用实时算、单开一栏，
        //   数字 = **要人动的**那几样（年份警报 + 算不出键 + 该换键），见 `core/synthConflicts.js`。
        { id: 'conflict', label: '⑤ 冲突', count: ((model.conflicts || {}).summary || {}).alarms || 0,
          build: () => conflictSection(model, redraw) }
    ];
    // 记住选中的那一栏（换栏 = 只重画，筛选范围/关键词那些 viewState 一个字都不动）
    if (!sections.some(s => s.id === viewState.section)) viewState.section = 'synth';
    root.appendChild(sectionBar(sections, redraw));

    const active = sections.find(s => s.id === viewState.section);
    root.appendChild(active.build());

    return container;
}

/**
 * 二级 tab 栏 —— 四块内容**不同屏堆叠**（一次只画一栏）。
 *
 * * 每栏右上带**条数**（`model` 里现成的数字，不额外算一趟）——"哪一栏有活"一眼可见；
 * * 用 `dedup-subtab` 这个 class（**不挂 `.btn` / `.dedup-chip`**）：既有冒烟按 `.btn` 找
 *   操作按钮、按 `.dedup-chip` 找筛选芯片，别让 tab 混进去；
 * * 栏名带 ①②③④ 前缀，与页面注释、文档里的编号对齐（顺序就是文档里的顺序）。
 */

function sectionBar(sections, redraw) {
    const bar = mk('div', 'dedup-subtabs',
        'display:flex; flex-wrap:wrap; gap:4px; margin:0 0 12px; border-bottom:1px solid #e2e8f0; padding-bottom:8px;');
    for (const s of sections) {
        const on = s.id === viewState.section;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dedup-subtab' + (on ? ' dedup-subtab-on' : '');
        btn.dataset.section = s.id;
        btn.textContent = s.count === null ? s.label : `${s.label}（${s.count}）`;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.style.cssText = `font-size:13px; padding:4px 12px; cursor:pointer; background:${on ? '#2563eb' : '#f1f5f9'};`
            + ` color:${on ? '#fff' : '#334155'}; border:1px solid ${on ? '#2563eb' : '#d1d5db'};`
            + ' border-radius:6px 6px 0 0;';
        btn.addEventListener('click', () => {
            if (viewState.section === s.id) return;
            viewState.section = s.id;
            redraw();
        });
        bar.appendChild(btn);
    }
    return bar;
}

/**
 * 先把范围定下来（并**就地纠偏**）。
 *
 * 两条纠偏：选中的范围节点**已经不在树上**（被删 / 换了一份数据）⇒ 退回"整棵树"
 * （否则用户会盯着一张永远 0 条的页面，还以为是判重坏了）；只是被上面的
 * 「场次筛选」输入框滤掉了 ⇒ 自动落到第一条匹配项。
 */
