// ================================================================
// 「检索」一级 tab（features/Search/index.js）
//
// 本插件只做一件事：挂一级 Tab「🔍 检索」+ 一条**二级 tab 栏**，
// 把两块内容分给两个子页（一次只画一块，与「判重整理」四栏同一个做法）：
//
//     🏆 比赛检索 → `features/ContestSearch/view.js`（C 节点）
//     📝 题目检索 → `features/ProblemSearch/index.js`（P 节点）
//
// 为什么由本文件当插件入口：
//   一个 tab 只能有一个 owner ⇒ 与其让"题目"那个模块去挂"比赛"的子页，不如让壳这一层
//   （本文件）挂两边的 `mount*()`。两个子页的**共用控件**在 `./kit.js`。
//
// ⚠️ tab id 用 `search`：存档里的 `currentTab` 若写着别的 id（如 `problem-search`），
//    `tabs.js` 会当成不认识的页签并回落主视图（不是崩溃）。
// ================================================================
import { mountContestSearch } from '../ContestSearch/view.js';
import { mountProblemSearch } from '../ProblemSearch/index.js';

const TAB_ID = 'search';
const TAB_LABEL = '🔍 检索';
/** 内置 Tab 占 0~999，本插件默认排在它们之后 */
const TAB_ORDER = 1200;

/** 两个子页：比赛检索在前 */
const VIEWS = [
    { id: 'contest', label: '🏆 比赛检索', icon: '🏆', mount: mountContestSearch },
    { id: 'problem', label: '📝 题目检索', icon: '📝', mount: mountProblemSearch }
];

/** 记住选中的子页（跨挂载保留；**不持久化** —— 与 `ProblemSearch` 的条件同一态度） */
const viewState = { section: 'contest' };

/** 二级 tab 栏（class 用 `search-subtab`：既有冒烟按 `.ps-chip` 找芯片，别让 tab 混进去） */
function sectionBar(redraw) {
    const bar = document.createElement('div');
    bar.className = 'search-subtabs';
    bar.style.cssText = 'display:flex; flex-wrap:wrap; gap:4px; margin:0 0 12px; border-bottom:1px solid #e2e8f0; padding-bottom:8px;';
    for (const view of VIEWS) {
        const on = view.id === viewState.section;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-subtab' + (on ? ' search-subtab-on' : '');
        btn.dataset.section = view.id;
        btn.textContent = view.label;
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.style.cssText = `font-size:13px; padding:4px 12px; cursor:pointer; background:${on ? '#2563eb' : '#f1f5f9'};`
            + ` color:${on ? '#fff' : '#334155'}; border:1px solid ${on ? '#2563eb' : '#d1d5db'};`
            + ' border-radius:6px 6px 0 0;';
        btn.addEventListener('click', () => {
            if (viewState.section === view.id) return;
            viewState.section = view.id;
            redraw();
        });
        bar.appendChild(btn);
    }
    return bar;
}

function mountSearch(ctx) {
    const container = ctx.container;
    if (!container) return;

    function render() {
        const active = VIEWS.find(v => v.id === viewState.section) || VIEWS[0];
        container.innerHTML = '';
        container.appendChild(sectionBar(render));

        // 子页自己那一块（各自负责画完、各自管自己的翻页/重画）
        const body = document.createElement('div');
        body.className = 'search-body';
        body.dataset.section = active.id;
        container.appendChild(body);

        try {
            active.mount({
                state: ctx.state,
                tabId: ctx.tabId,
                container: body,
                // ★ 宿主注入的"节点入口条"（`ui/tabs.js:mountPluginTab` 给的）**原样转发**给子页：
                //   子页要用它画"身份键 + 完整面包屑 + 📋"那一格，而**插件不许 import `ui/`** ⇒
                //   只能由宿主传进来（照 `features/ContestOverview` 注入 `jumpId` 的先例）。
                //   ⚠️ 转发**引用**、不要在这里包一层（换了实现两边会分叉）。
                nodeEntry: ctx.nodeEntry,
                // ⚠️ 子页会把 `ctx.redraw` 换掉（它自己那套）⇒ 我们给的是一个**新对象**，
                //    这样"切子页"与"子页内部重画"两条路互不干扰。
                refresh: () => render()
            });
        } catch (err) {
            body.innerHTML = `<div class="empty-tab"><div class="icon">🧩</div>`
                + `<div class="title">${active.label} 加载失败</div>`
                + `<div class="desc">${err && err.message ? err.message : err}</div></div>`;
        }
    }

    ctx.redraw = render;
    render();
}

export function activateSearch(api) {
    api.registerTab({
        id: TAB_ID,
        label: TAB_LABEL,
        order: TAB_ORDER,
        mount: mountSearch
    });
}
