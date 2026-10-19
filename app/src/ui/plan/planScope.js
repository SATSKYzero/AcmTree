// ================================================================
// 计划侧"范围"的两个小工具（ui/plan/planScope.js）
//
// 干什么：把"当前标记"收成**范围根快照**（`selectionScopeOf`），以及题集来源那两句文本。
//
// ★ **计划侧没有"实时范围"这一层**（用户 2026-10-14："怎么还有实时和快照两个版本的…能不能稳定一点"）：
//   `v9.4.0`~`v9.4.8` 这里还挂着一条"按副页里的标记**实时**筛"的判定（`planEligibleOf` +
//   复用 `view/eligible.js:hasEligibleAncestor`），它与"取当前选中"做的是同一件事的两种版本
//   （实时 vs 快照）⇒ 两个旋钮互相打架，而且那颗 ○ 是**全局临时**的（主树/副页共用，
//   统计页那几个筛选模式也读它）⇒ 为别的事点两下 ○，计划的题集就变。
//   ⇒ **整条删掉**：范围只有一种 —— `plan.rootIds` 那份**快照**（空 = 超级根 = 整个副页）。
// ================================================================
import { AppState } from '../../shell/state.js';

/**
 * 「题集从哪来」的一句话（计划栏 / 计划页顶部共用这一份 —— 别在两处各写一句）。
 *
 * ⚠️ **两种来源都以副页为边界**（用户 2026-10-14："副页范围应该是默认的"）——
 *    所以两句话都以"副页里的题"开头，`range` 只是再说一句"在里头又按范围根缩了一道"。
 * @param {Object} progress `core/trainingPlan.js:planProgressOf` 的结果
 */
export function problemSourceTextOf(progress) {
    const links = progress ? progress.linkCount : 0;
    if ((progress && progress.problemsSource) === 'range') {
        const miss = (progress.missingRoots || []).length;
        return `副页里的题 ∩ 树上范围（${progress.rootCount} 个根${miss ? `，${miss} 个根已不存在` : ''}）`;
    }
    return `副页里的题（引用 ${links} 个节点）`;
}

/**
 * 题集"取不全"的警告（没有 ⇒ 空串）。三种：副页没了 / 范围根没了 / 根全不在这个副页里。
 * ⚠️ **"没选范围根"不是错误**（用户 2026-10-14："「就用这个副页里的题」就是无选中时自动选超级根
 *    节点的逻辑"）⇒ 那只是"整个副页"，别再报一句吓人。
 * ⚠️ 与"没填难度"那类警告**分开**：那是题集内部的数，这是**题集本身取不到**。
 */
export function planSourceWarnOf(progress) {
    if (!progress) return '';
    if (progress.missingPage) {
        return '⚠️ 题单页已删除 —— 这条计划算不出题集了（计划本身留着，重新选一个副页即可）。';
    }
    const miss = (progress.missingRoots || []).length;
    if (miss) return `⚠️ ${miss} 个范围根已不存在（这条计划的题集不完整）`;
    // ★ 副页是边界 ⇒ 根落在副页外就一道题都挑不出来，必须说清（不然只看到一个 0，不知道为什么）
    if (progress.rootCount && !progress.rootsInPage) {
        return '⚠️ 你选的范围根都不在这个副页里 —— 题集只从副页里取：先把它们放进这个副页，或改选副页里有的节点';
    }
    return '';
}

/**
 * 「取当前选中」：把**染了色的那几点**收成范围根，再取各点的子树。
 *
 * 只认**节点自己那颗 ○**（都是界面上真点得动、点了会变蓝的那些）：
 *   ① 主树节点的 `node.selected`（在主页上点的）；
 *   ② **当前副页里**被勾的虚拟节点（`.btn-select-toggle` 写的是 `vNode.selected`，页内 id 不在 `state.nodes` 里）
 *      ⇒ 用它自己的 `refId` 回到真实节点。
 * ⚠️ **只认当前那一个副页**（`state.currentPageId`）："取当前选中"就是"我现在看到的这些勾"。
 * ★ **范围根 = 染色点里"父节点没染色"的那些**，每个根取它整棵子树（用户 2026-10-14 原话：
 *    "取所有本身被染色而父节点不被染色的点集，再取各点的子树"）。
 *    父子都染色 ⇒ 只留父：子那棵子树已经在父里面，题集**一模一样**；而且"全选一大片"时能把
 *    N 次子树遍历收成 1 次（`planProblemsOf` 是**逐根**走子树的 ⇒ 1900 个根就是 O(n²)）。
 *    ⚠️ 代价是"你勾了两个，界面只写一个" ⇒ 返回值里有 `picked`/`absorbed`，
 *    调用方（`planPage.js`）**必须把合并说出来**。
 * ⚠️ **不算**"当前副页**整页**被勾"（页签上那颗 ○ ⇒ `page.selected`）——
 *    那是"**整页映射覆盖**"的意思（统计页那边的筛选模式读它），**不是**"我标记了这些节点"。
 *    `v9.4.2` 那一版把它混进来了 ⇒ 用户在副页里只标记了两个年份，
 *    "取当前选中"却收出**整页最上面那个**（"我没勾 XCPC 吧。这逻辑怎么看都不对"）。
 *    这里**不能用** `hasEligibleAncestor`（它问的是"祖先的 `node.selected`"，而 ② 来的节点在主树里
 *    根本没被标记）⇒ 对**标记点那一堆**自己走一遍 `parentOf`。
 * 仓里没有第二份"把选中收成一组根"的实现（`view/eligible.js` 只回答**单个**节点在不在范围内，
 *    `G2_selector.js:getSelectedNodeId` 是"列表里当前高亮那一条"）。
 *
 * @returns {{picked:string[], roots:string[], absorbed:string[], wholePage:boolean}}
 *          `picked` = 真正**自己染色**的那些节点（已去重）；
 *          `roots` = 其中"父没染色"的那些（**写进 `plan.rootIds` 的就是它**）；
 *          `absorbed` = 被合并掉的（父也在 `picked` 里）；
 *          `wholePage` = 当前副页**整页**勾着吗（只是给界面一句提示用，**不进范围根**）。
 *          插入序：主树键序 + 副页键序（稳定）。
 */
export function selectionScopeOf() {
    const nodes = AppState.nodes || {};
    const picked = new Set();
    for (const id in nodes) if (nodes[id] && nodes[id].selected) picked.add(id);

    const page = AppState.pages && AppState.pages[AppState.currentPageId];
    const index = (page && page.virtualIndex) || {};
    for (const vId in index) {
        const v = index[vId];
        if (!v || !v.refId || !nodes[v.refId]) continue;      // 页根/失效引用不算
        if (v.selected) picked.add(v.refId);                  // ★ 只看**这一格自己**染没染色
    }

    const roots = [];
    const absorbed = [];
    for (const id of picked) {
        let covered = false;
        let pid = AppState.parentOf ? AppState.parentOf[id] : null;
        while (pid) {
            if (picked.has(pid)) { covered = true; break; }   // 父也染色 ⇒ 这一条不用单列（子树已含在父里）
            pid = AppState.parentOf[pid] ?? null;
        }
        (covered ? absorbed : roots).push(id);
    }
    return { picked: [...picked], roots, absorbed, wholePage: !!(page && page.selected) };
}
