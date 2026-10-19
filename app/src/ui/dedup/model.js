// ================================================================
// 范围与模型（ui/dedup/model.js）
//
// 职责：筛选范围（整树/子树/单场 + 性质四维）解析、树序 id、
// `computeModel()`（把"要判哪些节点"算成一份模型给四块用）、以及那份
// **按数据引用缓存**的模型（`cache` + `invalidateDedupCache()`）。
// ⚠️ `cache` 是 `let` 且在这里被重新赋值 ⇒ 它只能住在这个模块（见 state.js 的说明）。
// ================================================================
import { pageState, viewState } from './state.js';
import { SCOPE_OPTION_CAP, TYPE_LABEL } from './kit.js';
import { collectDedupFacets, collectNatureItems, scopeNodeIds, suggestMembers, synthGroups, unownedMaterialIds } from '../../core/dedup.js';
import { findDanglingOwners } from '../../core/ops/synth.js';
import { collectGroups } from '../../core/query/groupCount.js';
import { synthConflicts } from '../../core/synthConflicts.js';
import { AppState } from '../../shell/state.js';

let cache = null;

/**
 * 作废缓存并把页码归零。
 * 由 `ui/tabs.js` 在 `UI_REFRESH_REQUIRED`（= 数据变了）时调用 —— **只在那里调**，
 * 因为"数据变了"这件事只有那一个信号，猜时间戳不如听它。
 */

export function invalidateDedupCache() {
    cache = null;
    pageState.groups = 1;
    pageState.candidates = 1;
    pageState.unowned = 1;
    pageState.pending = 1;
}

/** 造元素（与 nodeInfoView 同一套理由：DOM 构造，桩里查得到） *//** 一个节点的短标签（合成节点优先显示"合成标识"，那是它唯一的身份） */

function treeOrderIds() {
    const nodes = AppState.nodes || {};
    const childOrder = AppState.childOrder || {};
    const out = [];
    const seen = new Set();
    const stack = [AppState.rootId];
    while (stack.length) {
        const id = stack.pop();
        if (!id || seen.has(id) || !nodes[id]) continue;
        seen.add(id);
        out.push(id);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    for (const id of Object.keys(nodes)) {
        if (!seen.has(id)) { seen.add(id); out.push(id); }
    }
    return out;
}

/** 范围下拉的候选项（`contest` = C 容器，`subtree` = 平台 / 系列） */

export function scopeChoices(kind) {
    const nodes = AppState.nodes || {};
    const kw = viewState.scopeSearch.trim().toLowerCase();
    const out = [];
    for (const id of treeOrderIds()) {
        const node = nodes[id];
        if (!node) continue;
        if (kind === 'contest') {
            if (node.type !== 'C') continue;
            if (kw) {
                const hay = `${node.name || ''} ${node.extKey || ''}`.toLowerCase();
                if (!hay.includes(kw)) continue;
            }
        } else if (node.type !== 'W' && node.type !== 'S') {
            continue;                       // 整棵树的档已经覆盖根，这里只列平台 / 系列
        }
        out.push({
            value: id,
            label: `${TYPE_LABEL[node.type] || node.type} · ${node.name || id}`
                + (node.extKey ? `（${node.extKey}）` : '')
        });
        if (out.length >= SCOPE_OPTION_CAP) break;
    }
    return out;
}

/**
 * 条件变了：缓存作废（重算建议）+ 候选页回到第 1 页 + 重画。
 * ⚠️ 合成节点清单 / 概览也一起重画，但它们的数据与条件无关（只是顺带）。
 */

export function applyFilterChange(redraw) {
    cache = null;
    pageState.candidates = 1;
    redraw();
}

/** 分页条：只有一页时不出现 */

function resolveScope() {
    if (viewState.scopeKind === 'all') return { kind: 'all' };
    const nodes = AppState.nodes || {};
    if (viewState.scopeNodeId && !nodes[viewState.scopeNodeId]) {
        viewState.scopeKind = 'all';
        viewState.scopeNodeId = '';
        return { kind: 'all' };
    }
    const choices = scopeChoices(viewState.scopeKind);
    if (!viewState.scopeNodeId || !choices.some(c => c.value === viewState.scopeNodeId)) {
        viewState.scopeNodeId = choices.length ? choices[0].value : '';
    }
    return { kind: viewState.scopeKind, nodeId: viewState.scopeNodeId };
}

/** 范围的人话（页面上要写清楚"现在看的是哪儿"） */

function scopeLabelOf(scope, scopeIds) {
    if (!scope || scope.kind === 'all') return '整棵树';
    const node = (AppState.nodes || {})[scope.nodeId];
    const kind = scope.kind === 'contest' ? '单场比赛' : '子树';
    const n = scopeIds ? scopeIds.size : 0;
    if (!node) return `${kind}（没有匹配的节点）`;
    return `${kind}「${node.name || scope.nodeId}」（${n} 个节点）`;
}

/** 算一次（有缓存就复用） */

export function computeModel() {
    if (cache) return cache;
    const nodes = AppState.nodes || {};
    const scope = resolveScope();
    const scopeIds = scopeNodeIds(AppState, scope);
    const natureItems = collectNatureItems(AppState, { includeFilled: true });
    const scanned = suggestMembers(nodes, AppState.parentOf || {}, {
        mode: viewState.mode,
        filter: viewState.filter,
        scopeIds
    });
    cache = {
        nodes,
        scope,
        scopeIds,
        scopeLabel: scopeLabelOf(scope, scopeIds),
        facets: collectDedupFacets(nodes),
        groups: synthGroups(AppState),
        unowned: unownedMaterialIds(nodes),
        candidates: scanned.candidates,
        truncated: scanned.truncated,
        dangling: findDanglingOwners(AppState),
        // 「性质待补」的两摞（纯口径在 `core/dedup.js` 的 `collectNatureItems`）：
        // `pendingItems` = 缺字段的（**tab 上的条数只看它**）；
        // `filledItems` = 已填满的，只在 ③ 里开了「同时显示已填满」时才画。
        // ★ 「⑤ 冲突」那一栏的数据（年份警报 / 算不出键 / 该换键 / 低可信差异）。
        //   判据与产包侧 scripts/synth-bind.mjs **共用同一份**（core/synthPlan.js +
        //   core/natureConfidence.js），但**随树状态实时算** —— 人改完 nature 立刻能看到结果。
        //   ⚠️ 第二个参数是**父关系索引**（`AppState.parentOf`）：应用侧那颗树里，节点上**未必**
        //      带 `parent`（父子链的真源是这张索引）⇒ 题目绑定那一段要靠它才连得上
        //      （实测踩到：不带它 ⇒ 那一栏恒为「0 组 / 绑上 0 条」）。
        conflicts: synthConflicts(nodes, AppState),
        pendingItems: natureItems.pending,
        filledItems: natureItems.filled,
        // 计数口径（`collectGroups`）报出的**同一类**坏数据：节点 id 当标识写、
        // 两个节点共用一个标识。合并到下面那条黄条里列出 —— 不另造警告面板。
        warnings: collectGroups({ nodes }).warnings,
        total: Object.keys(nodes).length
    };
    return cache;
}

/** ① 合成节点清单 */
