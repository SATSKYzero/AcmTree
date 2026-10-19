// ================================================================
// 统计页的二级 tab 与事件接线（ui/stats/ac/tabs.js）
//
// 职责：二级 tab 的读写（`statsTab`）与两个 setup。
// ================================================================
import { acTrackingCachedNodes, acTrackingCurrentPage, getACTrackingPageSize, setACTrackingCurrentPage, setACTrackingPageSize } from './state.js';
import { renderACTracking } from './tracking.js';
// ★ 训练强度追踪那条分支要重画热力图（`v9.1.8`）—— 它与"里面展示的那一段列表"同属一个子页；
//   热力图那边会顺带 `refreshActiveACList()` 把列表按当前范围重算
import { renderTrainingHeatmap } from './heatmap.js';
import { execute } from '../../../shell/executor.js';
import { AppState } from '../../../shell/state.js';
import { getCurrentTab } from '../../tabs.js';
import { renderAccountCompareTab } from '../compare.js';

let statsTab = 'training';  // 'training' | 'ac-tracking' | 'compare'

/** 合法的二级页签名（加新页签只改这一处 + index.html + renderStatsTabContent） */

const STATS_TABS = ['training', 'ac-tracking', 'compare'];

export function getStatsTab() {
    const saved = AppState.settings.stats.statsTab;
    if (saved === 'unused') {
        execute(
            (draft) => { draft.settings.stats.statsTab = 'training'; },
            { skipHistory: true, validate: false }
        ).catch(() => {});
        statsTab = 'training';
        return 'training';
    }
    statsTab = STATS_TABS.includes(saved) ? saved : 'training';
    return statsTab;
}

export function setStatsTab(tab) {
    if (!STATS_TABS.includes(tab)) return;
    statsTab = tab;
    execute(
        (draft) => { draft.settings.stats.statsTab = tab; },
        { skipHistory: true, validate: false }
    ).catch(() => {});
    renderStatsTabContent(tab);
}

// ================================================================
// 收集所有 AC 题
// ================================================================

export function renderStatsTabContent(tab = null) {
    if (tab) {
        if (!STATS_TABS.includes(tab)) return;
        statsTab = tab;
        execute(
            (draft) => { draft.settings.stats.statsTab = tab; },
            { skipHistory: true, validate: false }
        ).catch(() => {});
    }
    const currentTab = getStatsTab();

    document.querySelectorAll('#data-stats-sub-tabs .sub-tab-btn').forEach(btn => {
        const btnSubtab = btn.dataset.subtab;
        let internalVal;
        if (btnSubtab === 'data-training') internalVal = 'training';
        else if (btnSubtab === 'data-ac-tracking') internalVal = 'ac-tracking';
        else if (btnSubtab === 'data-compare') internalVal = 'compare';
        else internalVal = btnSubtab;
        btn.classList.toggle('active', internalVal === currentTab);
    });

    const trainingContainer = document.getElementById('subtab-data-training');
    const acContainer = document.getElementById('subtab-data-ac-tracking');
    const compareContainer = document.getElementById('subtab-data-compare');

    if (trainingContainer) {
        trainingContainer.style.display = (currentTab === 'training') ? 'block' : 'none';
    }
    if (acContainer) {
        acContainer.style.display = (currentTab === 'ac-tracking') ? 'block' : 'none';
    }
    if (compareContainer) {
        compareContainer.style.display = (currentTab === 'compare') ? 'block' : 'none';
    }

    if (currentTab === 'ac-tracking') {
        renderACTracking();
    }
    if (currentTab === 'compare') {
        renderAccountCompareTab();
    }
}

// ================================================================
// 绑定 AC 追踪事件
// ================================================================

export function setupACTrackingEvents() {
    const pageSizeInput = document.getElementById('ac-page-size');
    if (pageSizeInput) {
        pageSizeInput.value = getACTrackingPageSize();
        pageSizeInput.addEventListener('change', function () {
            let val = parseInt(this.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 100) val = 100;
            this.value = val;
            setACTrackingPageSize(val);
            setACTrackingCurrentPage(1);
            renderACTracking();
        });
    }

    const prevBtn = document.getElementById('ac-prev');
    const nextBtn = document.getElementById('ac-next');
    if (prevBtn) {
        prevBtn.addEventListener('click', function () {
            if (acTrackingCurrentPage > 1) {
                setACTrackingCurrentPage(acTrackingCurrentPage - 1);
                renderACTracking();
            }
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', function () {
            const pageCount = Math.max(1, Math.ceil(acTrackingCachedNodes.length / getACTrackingPageSize()));
            if (acTrackingCurrentPage < pageCount) {
                setACTrackingCurrentPage(acTrackingCurrentPage + 1);
                renderACTracking();
            }
        });
    }

    document.addEventListener('click', function (e) {
        const btn = e.target.closest('#data-stats-sub-tabs .sub-tab-btn');
        if (!btn) return;
        const subtab = btn.dataset.subtab;
        let internal;
        if (subtab === 'data-training') internal = 'training';
        else if (subtab === 'data-ac-tracking') internal = 'ac-tracking';
        else if (subtab === 'data-compare') internal = 'compare';
        else internal = subtab;
        if (internal && internal !== getStatsTab()) {
            renderStatsTabContent(internal);
        }
    });
}

// ================================================================
// AC 追踪自动刷新
// ================================================================

export function setupACTrackingAutoRefresh() {
    document.addEventListener('acmtree:db-modified', () => {
        if (getCurrentTab() === 'stats') {
            const activeSubTab = document.querySelector('#data-stats-sub-tabs .sub-tab-btn.active');
            if (activeSubTab) {
                const btnSubtab = activeSubTab.dataset.subtab;
                let internal;
                if (btnSubtab === 'data-training') internal = 'training';
                else if (btnSubtab === 'data-ac-tracking') internal = 'ac-tracking';
                if (internal === 'ac-tracking') {
                    renderACTracking();
                } else if (internal === 'training') {
                    // ★ 训练强度追踪也要跟着数据/范围变（`v9.1.8`）：换「查看账户」走的是
                    //   `execute(core/ops/account.js:setViewingAccount)` ⇒ 会发 `db-modified`。
                    //   不重画的话：热力图与里面**正在展示的那一段列表**还是旧口径，
                    //   而它下面的统计按新范围读 ⇒ 症状"AC 列表里出现未使用/已提交未通过"
                    //   （用户 2026-10-13 实测：登 SAT 看 Pia 时，列表里 166 道 Pia 根本没提交的题也在）。
                    //   ⚠️ 只监听 `db-modified`、**别加 `ui-refresh-required`**：后者被各种渲染反复派发，
                    //   加进来会把这条链变成自激循环。
                    renderTrainingHeatmap();
                }
            }
        }
    });
}

// ================================================================
// 每日 AC 题目列表
// ================================================================
