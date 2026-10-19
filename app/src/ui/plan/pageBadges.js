// ================================================================
// 副页方框上的「计划强度角标」（`ui/plan/pageBadges.js`）—— **算 + 注入**那一半
//
// 口径（`docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节）：
//   · 只在**副页**上算（主页没有"计划绑的页"）；
//   · 文案 = `剩 X / 共 Y`（用户："显示 A/B（剩余/总）"）；
//   · 数字 = `core/trainingPlan.js:planSubtreeIntensityOf(page, entries)`（**纯函数、有单测**）；
//   · `entries` = `planProgressOf(AppState, plan, { shownValue }).entries` —— **不另算强度**。
//
// ⚠️ `view/` 不许 import 计划模块 ⇒ 本文件把算好的**文案**注入 `view/nodeBadge.js`。
// ⚠️ 什么时候调：**树画之前**（`ui/plan/planBar.js:renderPlanBar` 里，那条栏正好在树前面画）；
//    Ctrl 的显隐是**纯 CSS**（`body.ctrl-held`）⇒ 按键不需要重画。
// ================================================================
import { AppState } from '../../shell/state.js';
import { viewDerivedDisplay, viewValue } from '../../view/scope.js';
import { planProgressOf, planSubtreeIntensityOf } from '../../core/trainingPlan.js';
import { planOfPage } from '../../core/ops/plan.js';
import { setNodeBadges } from '../../view/nodeBadge.js';
// ★ 结构签名（折叠不该让角标重算 —— 见下面 `badgeMemo` 那段）
import { structureSignatureOf } from '../../core/model/page.js';

/** 强度那两个数：最多两位小数，去掉尾零（`14` 不写成 `14.00`） */
function fmtNum(n) {
    const v = Number(n) || 0;
    return String(Math.round(v * 100) / 100);
}

//: 角标那份记忆化：`planSubtreeIntensityOf` 要**扫一遍这一页的子树**（真包实测 ~6ms/趟），
//: 而它的输入只有两样 —— 计划那份进度（`progress`）与页结构（结构签名）。
//: ⇒ 折叠/展开不会把它打掉（折叠不动结构），切页/改数据会。
let badgeMemo = null;

/**
 * 重算当前副页的角标并注入（幂等、只读）。
 *
 * @param {Object} state
 * @param {Object|null} progressIn 已经算过的 `planProgressOf` 结果（**同一次渲染里别算第二遍**）。
 *        计划栏那条路会把它传进来（它自己要画的摘要用的是同一份）；不传就自己算（单测/别处调用）。
 * @returns {boolean} 有没有注入（主页 / 没计划 / 没题集 ⇒ false，并把角标清掉）
 */
export function refreshPageBadges(state = AppState, progressIn = null) {
    const pageId = (state && state.currentPageId) || 'main';
    const page = (pageId && pageId !== 'main' && state.pages) ? state.pages[pageId] : null;
    const plan = page ? planOfPage(state, pageId) : null;
    if (!page || !plan) {
        setNodeBadges(null);
        return false;
    }
    // ⚠️ 显示读值一律按"显示列"读（与计划栏/内层页同一份口径，别直读节点字段）
    const shownValue = (n, f) => viewDerivedDisplay(state, n, f) ?? viewValue(state, n, f);
    const progress = progressIn || planProgressOf(state, plan, {
        shownValue,
        tables: (state.settings && state.settings.trainingIntensityTables) || []
    });
    // ★ 命中：同一页同一结构、同一份进度 ⇒ 直接贴上次那套文案（折叠/展开都会走到这里）
    const sig = structureSignatureOf(page);
    if (badgeMemo && badgeMemo.pageId === pageId && badgeMemo.sig === sig
        && badgeMemo.progress === progress) {
        setNodeBadges(badgeMemo.out);
        return badgeMemo.hasAny;
    }
    const perNode = planSubtreeIntensityOf(page, progress.entries);
    const out = {};
    for (const vid of Object.keys(perNode)) {
        const b = perNode[vid];
        // 一道题都不在这一支里 ⇒ 不画角标（"剩 0 / 共 0"是噪声）
        if (!b || !b.total) continue;
        out[vid] = `剩 ${fmtNum(b.remaining)} / 共 ${fmtNum(b.total)}`;
    }
    const hasAny = !!Object.keys(out).length;
    badgeMemo = { pageId, sig, progress, out, hasAny };
    setNodeBadges(out);
    return hasAny;
}
