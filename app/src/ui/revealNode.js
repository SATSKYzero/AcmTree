// ================================================================
// 节点定位（ui/revealNode.js）
// 职责：把某个节点在界面上"显示出来"——切分页 / 切页面 / 切显示模式 /
//       展开祖先 / 翻到正确页 / 滚动并高亮
// 依赖：shell/, view/helpers.js, ui/tabs.js, ui/folder/folderMode.js,
//       ui/folder/virtualFolderMode.js（副页那一半）
//
// 为什么独立成模块：
//   插件（如「题目检索」）需要"点结果跳到树上"，但插件不该 import ui 层。
//   因此这里实现能力，插件通过派发 EVENTS.REVEAL_NODE 事件使用它
//   —— 与本项目既有的 EDIT_NODE / SWITCH_PAGE 等事件模式一致。
//
// ★ **两种 id 都认，但"跳到哪"按 id 归属分**（`v9.0.17` 起）：
//   · **主树真实 id**（`AppState.nodes` 里有）⇒ 老行为：切回主页面 + 主树定位；
//   · **副页的页内 id**（`v_xxx`，`AppState.nodes` 里查不到、只在某个
//     `state.pages[pageId].virtualIndex` 里）⇒ **切到它所属的那个副页，并在那一页里定位**
//     （进它的父文件夹 / 展开页内祖先 / 翻到它的页 / 滚动高亮）。
//   为什么要有后者：副页节点详页头部**已经**有一颗「🔎 跳到它引用的主节点」，
//   那串蓝 id 再跳主节点就是"同一件事两个入口"（用户 2026-10-13 指出的语义冲突）。
//   归属判据用**现成的** `core/ops/page.js:locateVirtualNode`（副页 id → `{pageId, vNode}`），
//   不在这里解析 id 字符串。
// ================================================================
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { getNodePerPage } from '../view/helpers.js';
import { isExpanded, setExpanded, pageOf, setNodePage } from '../core/model/viewState.js';
// 副页 id 的**唯一归属判据**（"这个 id 在哪个副页的 virtualIndex 里"）——
// 主树的真实节点在这一支必然落空，于是"是不是副页 id"只有一份答案
import { locateVirtualNode, nodeAncestorsOf } from '../core/ops/page.js';
// 页内展开 / 翻页的**唯一写口**（`state.pages[pageId].virtualIndex[v].expanded / currentPage`）
import { setVirtualNodeExpanded, setVirtualNodeCurrentPage } from '../core/ops/view.js';
// ★ **精确页码**要用**文件夹真正展示的那份列表**算 ——
//   `getDisplayData()` 返回的 `nodes` 就是那一页要画的东西（**未分页的完整列表** + `pagination`），
//   与"拿 `childOrder` 猜一页、找不到再逐页扫"相比，一次就对。判据也只有这一份（不另算一套顺序）。
import { getDisplayData } from '../view/dataAdapter.js';
// 祖先链**唯一入口** `core/ops/page.js:nodeAncestorsOf`（按归属分流到主树 / 页内两棵树，
// 各只有一份实现；根在前、不含自身、断链/成环都有兜底）——
// 别在这里（或别处）再手写一遍 `parentOf` 循环，也别自己挑"该用哪棵树那份"
import { EVENTS } from '../A_constants.js';
import { switchTab } from './tabs.js';
import {
    getTreeDisplayMode,
    enterFolder,
    goToRootFolder,
    switchFolderView,
    setFolderCurrentPage,
    folderView
} from './folder/folderMode.js';
// 副页那一半：进页内文件夹 / 回副页根 / 读页内视图态（`currentId / currentPage / view`）。
// ⚠️ 这一支的**导航动作只有它那一份**（`virtualFolderMode.js`）—— 本文件只按它的契约调用，
//    不自己写第二份"进哪个文件夹、看第几页"（那正是这个文件头反对的"自造第二套"）。
import { getVirtualState, enterVirtualFolder, goToVirtualRoot, switchVirtualView } from './folder/virtualFolderMode.js';

/** 高亮持续时长（毫秒） */
const HIGHLIGHT_MS = 2600;

/** 高亮类与样式表 id */
const HIGHLIGHT_CLASS = 'node-revealed';
const HIGHLIGHT_STYLE_ID = 'reveal-node-highlight-style';

/** 轮询等待节点方框出现的上限次数与间隔 */
const WAIT_TRIES = 25;
const WAIT_INTERVAL_MS = 20;

/** 高亮看护的轮询间隔 */
const WATCH_INTERVAL_MS = 80;

// ================================================================
// 工具
// ================================================================

/** 取节点在父节点下的序号（找不到返回 -1） */
function indexInParent(nodeId) {
    const parentId = AppState.parentOf[nodeId];
    if (!parentId) return { parentId: null, index: -1, perPage: 1 };
    const siblings = AppState.childOrder[parentId] || [];
    const perPage = Math.max(1, getNodePerPage(AppState.settings) || 1);
    return { parentId, index: siblings.indexOf(nodeId), perPage };
}

/**
 * 节点方框只可能住在这两个容器里（**唯一一份名单**）：
 *   · `#tree-body`    —— 树模式的整棵树 / 文件夹模式的子节点列表；
 *   · `#folder-stats` —— 文件夹模式顶部"当前节点"那一格（它在 `#tree-container` 之外）。
 * 两处都只画**当前页**的内容 —— 主页面画主树、副页画那一页的页内 id（**同一对容器复用**）。
 */
const MAIN_TREE_BOX_CONTAINERS = ['tree-body', 'folder-stats'];

/**
 * 查节点方框。
 *
 * ⚠️ **不许用 `document.querySelector` 全文档找**（G11，实测过的病根）：
 *   `class="node-box" data-id="…"` 在别处**也存在** —— 节点详页头部那一格、
 *   数据统计的只读 AC 列表、选节点弹窗（`G2_selector.js`）、文件夹模式"当前节点"格
 *   （后两个不在下面这两个容器里）。全文档找必然取到**第一个**命中，
 *   而 `#tab-main` 恰好排在 `#tab-stats` / 详页面板**之前** ⇒ 平时看着是对的，
 *   一旦"目标不在当前页 / 祖先没展开 / 当前不是主视图"，就会滚到一个**看不见的副本**
 *   上、还 `return true` **误报成功**（`nodeGroup.js:stripTreeWiring` 的文件头记的是同一件事）。
 *
 * ★ **搜索顺序（`v9.0.17` 起）**：
 *   ① **先查那两个容器**，且（给了 `target` 时）**要求 id 属于目标那一页** —— 主页面
 *      （`pageId === 'main'`）只认主树真实 id；副页（`pageId` 是副页 id）只认**那一页**
 *      `virtualIndex` 里的页内 id。两页的方框住的是**同一对容器**
 *      （`renderFolderView` / `renderTreeView` 都往 `#tree-body` 写），
 *      所以"在不在这一页里"必须靠**归属**判，不能靠容器。
 *   ② 目标不在目标那一页 ⇒ **返回 null**：交给调用方先切页面，切完再回来查一次
 *      （`revealNode` 里就是这么排的：先 `switchPageTo`，再 `waitForNodeBox`）。
 *      ⚠️ **别在这一步退化成"全文档找一遍兜底"** —— 那是 G11 的病根，会静默滚到副本上。
 *
 * @param {string} nodeId
 * @param {{pageId:string, virtual:boolean}|null} [target] - 目标归属；缺省 = 按主页面查（老调用点）
 */
function findNodeBox(nodeId, target = null) {
    // 归属复核（防"id 看着像主树、其实住在副页"这类同名）：判据只有一份 —— `locateVirtualNode`
    // ⚠️ 只给了 `target` 时才复核：**没给 target 的老调用点（`markHighlighted` / `watchHighlight`
    //    的既有用法）保持原来的语义**（只认"在主页面"，不查 id 在不在 `state.nodes` 里）——
    //    否则那些"只摆方框、不摆数据"的调用（冒烟里的高亮用例）会静默失效。
    if (target) {
        const pageIdOfTarget = target.pageId;
        if (AppState.currentPageId !== pageIdOfTarget) return null;
        const page = (AppState.pages || {})[pageIdOfTarget];
        const inThisPage = target.virtual
            ? !!(page && page.virtualIndex && page.virtualIndex[nodeId])
            : !!AppState.nodes[nodeId];
        if (!inThisPage) return null;
    } else if (AppState.currentPageId !== 'main') {
        return null;                      // 没给归属 ⇒ 只看主页面（老行为）
    }
    const sel = `.node-box[data-id="${nodeId}"]`;
    for (const id of MAIN_TREE_BOX_CONTAINERS) {
        const root = document.getElementById(id);
        if (!root || typeof root.querySelector !== 'function') continue;
        const el = root.querySelector(sel);
        if (el) return el;
    }
    return null;
}

/**
 * 等待节点方框出现（渲染可能是异步的）
 * @param {string} nodeId
 * @param {number} tries
 * @param {{pageId:string, virtual:boolean}|null} [target] - 目标归属（见 `findNodeBox`）
 * @returns {Promise<HTMLElement|null>}
 */
function waitForNodeBox(nodeId, tries = WAIT_TRIES, target = null) {
    return new Promise(resolve => {
        let left = tries;
        const tick = () => {
            const el = findNodeBox(nodeId, target);
            if (el) return resolve(el);
            if (--left <= 0) return resolve(null);
            setTimeout(tick, WAIT_INTERVAL_MS);
        };
        tick();
    });
}

/** 滚动到节点（高亮由 watchHighlight 负责） */
function focusNodeBox(el) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
}

// ================================================================
// 高亮
//
// 不用"一次性给某个元素设 inline outline"的做法，因为渲染会**替换** DOM 元素：
// 树形模式下定位只渲染一次，所以那样能用；文件夹模式会连续触发
// enterFolder / setFolderCurrentPage 两次重渲染，元素若在聚焦后再被替换，
// 高亮就会连同旧元素一起消失。
//
// 做法：在持续时间内按 id 反复确保"当前那个方框"带高亮类 —— 既容得下元素被替换，
// 也容得下目标出现得比首次查找更晚。
// ================================================================

/** 注入高亮样式（只需一次） */
function ensureHighlightStyle() {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    // 用 !important 避免被后续内联样式或组件样式覆盖
    style.textContent = `.${HIGHLIGHT_CLASS} { outline: 2px solid #f97316 !important; outline-offset: 2px; }`;
    const host = document.head || document.body;
    if (host) host.appendChild(style);
}

/**
 * 给"当前"的目标方框打上高亮类
 * @param {string} nodeId
 * @param {{pageId:string, virtual:boolean}|null} [target] - 目标归属（见 `findNodeBox`）
 * @returns {boolean} 是否找到了元素
 */
export function markHighlighted(nodeId, target = null) {
    const el = findNodeBox(nodeId, target);
    if (!el) return false;
    ensureHighlightStyle();
    if (!el.classList.contains(HIGHLIGHT_CLASS)) {
        el.classList.add(HIGHLIGHT_CLASS);
    }
    return true;
}

/**
 * 在持续时间内反复确保目标方框带高亮，结束时移除
 * @param {string} nodeId
 * @param {number} [durationMs]
 * @param {number} [intervalMs]
 * @param {{pageId:string, virtual:boolean}|null} [target] - 目标归属（见 `findNodeBox`）
 * @returns {{stop: Function, everFound: Function}}
 */
export function watchHighlight(nodeId, durationMs = HIGHLIGHT_MS, intervalMs = WATCH_INTERVAL_MS, target = null) {
    let elapsed = 0;
    let found = false;

    const apply = () => {
        if (markHighlighted(nodeId, target)) found = true;
    };
    apply();

    const timer = setInterval(() => {
        elapsed += intervalMs;
        apply();
        if (elapsed >= durationMs) {
            clearInterval(timer);
            const el = findNodeBox(nodeId, target);
            if (el) el.classList.remove(HIGHLIGHT_CLASS);
        }
    }, intervalMs);

    return {
        stop: () => {
            clearInterval(timer);
            const el = findNodeBox(nodeId, target);
            if (el) el.classList.remove(HIGHLIGHT_CLASS);
        },
        everFound: () => found
    };
}

// ================================================================
// 分页定位
// ================================================================

/**
 * 文件夹模式：进入目标所在目录，并翻到包含目标的页
 * @param {string} nodeId
 * @returns {Promise<boolean>}
 */
async function revealInFolderMode(nodeId) {
    const { parentId, index, perPage } = indexInParent(nodeId);
    if (!parentId) return false;

    // 视图页必须是「子节点」，否则看不到列表
    if (folderView !== 'children') switchFolderView('children');

    const parentNode = AppState.nodes[parentId];
    if (parentNode && parentNode.type === 'O') goToRootFolder();
    else enterFolder(parentId);

    // ★ **精确页码**：按文件夹**真正展示的那份列表**算（`getDisplayData` 给的是完整 `nodes`），
    //   而不是拿 `childOrder` 猜一页再逐页扫 —— 逐页扫是深目录里"跳得慢"的大头。
    const guessed = exactFolderPageOf(parentId, nodeId, index, perPage);
    setFolderCurrentPage(guessed);
    if (await waitForNodeBox(nodeId, 8)) return true;

    // 兜底：万一展示顺序与我们算的不一致（被筛选/折叠藏了、或父节点还没画完）⇒ 才逐页扫一遍
    const siblingCount = (AppState.childOrder[parentId] || []).length;
    const pageCount = Math.max(1, Math.ceil(siblingCount / perPage));
    for (let page = 1; page <= pageCount; page++) {
        if (page === guessed) continue;
        setFolderCurrentPage(page);
        if (await waitForNodeBox(nodeId, 4)) return true;
    }
    return false;
}

/**
 * 目标在文件夹模式下**该翻到第几页**（拿"文件夹真正展示的那份列表"算，一次就对）。
 *
 * ⚠️ 算不出（节点不在当前展示里 / 抛错）⇒ 退回 `childOrder` 推算的老办法（调用方还有兜底）。
 */
function exactFolderPageOf(parentId, nodeId, index, perPage) {
    const fallback = index >= 0 ? Math.floor(index / perPage) + 1 : 1;
    try {
        const data = getDisplayData(AppState, {
            mode: 'folder', pageId: 'main', folderCurrentId: parentId, folderCurrentPage: 1
        });
        const list = (data && data.nodes) || [];
        const i = list.findIndex((n) => n && n.id === nodeId);
        if (i < 0) return fallback;
        const per = (data.pagination && data.pagination.pageSize) || perPage;
        return Math.floor(i / Math.max(1, per)) + 1;
    } catch (err) {
        return fallback;
    }
}

/**
 * 树模式：展开所有祖先，并把父节点翻到包含目标的页
 * @param {string} nodeId
 * @returns {Promise<boolean>}
 */
async function revealInTreeMode(nodeId) {
    const { parentId, index, perPage } = indexInParent(nodeId);

    // 收集祖先链（由根到父）—— **只有一份实现**：`core/ops/page.js:nodeAncestorsOf` 分流到
    // `core/query/nodes.js:getAncestorsRootFirst`（G10：以前这里手写了一遍 `parentOf` 循环，
    // 与 `nodeGroup.breadcrumbOf` 各一份，迟早分叉）
    const chain = nodeAncestorsOf(AppState, nodeId).map(n => n.id);

    const needExpand = chain.filter(id => !isExpanded(AppState, id));
    const targetPage = (parentId && index >= 0) ? Math.floor(index / perPage) + 1 : 1;
    const needPage = parentId && pageOf(AppState, parentId) !== targetPage;

    if (needExpand.length === 0 && !needPage) return true;

    try {
        await execute(
            (draft) => {
                for (const id of needExpand) {
                    if (AppState.nodes[id]) setExpanded(draft, id, true);
                }
                if (parentId && AppState.nodes[parentId] && targetPage >= 1) {
                    setNodePage(draft, parentId, targetPage);
                }
            },
            { validate: false, refreshParentId: null }
        );
    } catch (err) {
        console.error('[revealNode] 展开祖先失败:', err);
        return false;
    }
    return true;
}

// ================================================================
// 页内定位（副页 `v_xxx`）
//
// 与上面那两支（主树）的分工：**页内导航动作全部走 `virtualFolderMode.js` 那几份**
// （`getVirtualState` 读页内视图态、`enterVirtualFolder` / `goToVirtualRoot` 进文件夹），
// 页内展开/翻页走 `core/ops/view.js` 的两个写口 —— 本文件只负责"按顺序把它们串起来"。
//
// ⚠️ 这一支**只认页内 id**（`locateVirtualNode` 已经在 `revealNode` 里判过了）：
//    页内 id 在主树 `childOrder` / `parentOf` 里查不到，所以上面那两支一行都不能复用。
// ================================================================

/**
 * 页内祖先链（由根到父）—— 走**唯一入口** `core/ops/page.js:nodeAncestorsOf`（它按归属分流到
 * 页内那份 `virtualAncestorsOf`：页内 id 在主树的 `parentOf` 上查不到，所以两棵树各有一份实现）。
 * 这里只把节点对象取成页内 id（本文件下游要的是 id）。
 */
function virtualAncestorIdsOf(vId) {
    return nodeAncestorsOf(AppState, vId).map((v) => v.id);
}

/**
 * 目标在**副页文件夹模式**下该翻到第几页（拿那一页真正展示的那份列表算，与主树那一支同一口径）。
 *
 * ⚠️ 判据只有一份：`view/dataAdapter.js:getDisplayData({mode:'folder', pageId, folderCurrentId})`
 *    —— 别在这里自己按 `children` 数一遍（那会与渲染顺序分叉）。
 */
function exactVirtualFolderPageOf(pageId, parentVId, nodeId, perPage) {
    try {
        const data = getDisplayData(AppState, {
            mode: 'folder', pageId, folderCurrentId: parentVId, folderCurrentPage: 1
        });
        const list = (data && data.nodes) || [];
        const i = list.findIndex((n) => n && n.id === nodeId);
        if (i < 0) return 1;
        const per = (data.pagination && data.pagination.pageSize) || perPage;
        return Math.floor(i / Math.max(1, per)) + 1;
    } catch (err) {
        return 1;
    }
}

/**
 * 副页文件夹模式：进目标所在的**页内**文件夹，并翻到包含目标的页。
 * @returns {Promise<boolean>} 是否已在预期时间内把方框摆出来
 */
async function revealInVirtualFolderMode(pageId, nodeId) {
    const page = AppState.pages[pageId];
    const vNode = page && page.virtualIndex ? page.virtualIndex[nodeId] : null;
    if (!vNode) return false;

    const vState = getVirtualState(pageId);
    // 视图页必须是「子节点」，否则那一页画的是统计图，一个方框都没有。
    // ⚠️ 切视图走 `switchVirtualView`（它自己派发刷新）—— 那是**那一份模块的**视图态，
    //    本文件不直接改 `virtualFolderState`（私有状态，只能过它的入口）。
    if (vState.view !== 'children') switchVirtualView(pageId, 'children');

    const parentVId = vNode.parentId || null;
    const rootId = page.rootId;
    // 父就是副页根（或没有父）⇒ 回副页根目录；否则进那个页内文件夹
    // ⚠️ **只在真的需要切的时候切**：这两个入口各自会派发一次 `UI_REFRESH_REQUIRED`
    //    （整页重画一次）。目标已经在那里时再切一遍纯属白画，而且会把 DOM 换掉
    //    （高亮看护本来就是为"元素被换掉"设计的，但那不该由我们主动制造）。
    if (!parentVId || parentVId === rootId) {
        if (vState.currentId) goToVirtualRoot(pageId);
    } else if (vState.currentId !== parentVId) {
        enterVirtualFolder(parentVId, pageId);
    }

    const perPage = Math.max(1, getNodePerPage(AppState.settings) || 1);
    const guessed = exactVirtualFolderPageOf(pageId, parentVId || rootId, nodeId, perPage);
    // ⚠️ 页码也只在需要时写：不动就不派发刷新（理由同上）
    if (vState.currentPage !== guessed) {
        getVirtualState(pageId).currentPage = guessed;
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
    }
    if (await waitForVirtualNodeBox(pageId, nodeId, 8)) return true;

    // 兜底（与主树那一支对称）：展示顺序与我们算的不一致 ⇒ 才逐页扫一遍
    const parentChildren = parentVId && page.virtualIndex[parentVId]
        ? (page.virtualIndex[parentVId].children || [])
        : (page.virtualIndex[rootId] ? (page.virtualIndex[rootId].children || []) : []);
    const pageCount = Math.max(1, Math.ceil(parentChildren.length / perPage));
    for (let p = 1; p <= pageCount; p++) {
        if (p === guessed) continue;
        getVirtualState(pageId).currentPage = p;
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
        if (await waitForVirtualNodeBox(pageId, nodeId, 4)) return true;
    }
    // 扫完都没找到 ⇒ **把页码放回算出来的那一页**（别把页面停在最后一页那种随机位置）
    if (getVirtualState(pageId).currentPage !== guessed) {
        getVirtualState(pageId).currentPage = guessed;
        document.dispatchEvent(new CustomEvent(EVENTS.UI_REFRESH_REQUIRED));
    }
    return false;
}

/**
 * 副页树模式：展开页内所有祖先，并把父节点翻到包含目标的页。
 *
 * ⚠️ 页内展开/翻页**不在 `state.view` 上**（那是主树的），而在
 *    `state.pages[pageId].virtualIndex[v].expanded / currentPage` ⇒ 写口只有
 *    `core/ops/view.js` 的 `setVirtualNodeExpanded` / `setVirtualNodeCurrentPage`（走事务）。
 */
async function revealInVirtualTreeMode(pageId, nodeId) {
    const page = AppState.pages[pageId];
    const vNode = page && page.virtualIndex ? page.virtualIndex[nodeId] : null;
    if (!vNode) return;

    const chain = virtualAncestorIdsOf(nodeId);
    const needExpand = chain.filter((id) => {
        const v = page.virtualIndex[id];
        return v && !v.expanded;
    });
    const parentVId = vNode.parentId || null;
    const perPage = Math.max(1, getNodePerPage(AppState.settings) || 1);
    const parentChildren = (parentVId && page.virtualIndex[parentVId])
        ? (page.virtualIndex[parentVId].children || []) : [];
    const perPageCount = Math.max(1, Math.ceil(parentChildren.length / perPage));
    const targetPage = parentVId
        ? Math.min(perPageCount, Math.floor(Math.max(0, parentChildren.indexOf(nodeId)) / perPage) + 1)
        : 1;
    const parentV = parentVId ? page.virtualIndex[parentVId] : null;
    const needPage = !!(parentV && (parentV.currentPage || 1) !== targetPage);

    if (needExpand.length === 0 && !needPage) return;

    try {
        await execute(
            (draft) => {
                for (const id of needExpand) setVirtualNodeExpanded(draft, id, pageId, true);
                if (parentV && targetPage >= 1) {
                    setVirtualNodeCurrentPage(draft, parentV.id, pageId, targetPage);
                }
            },
            // 与 `ui/G_events.js` 的折叠同一套取舍：这几次只改"看的姿势"（`expanded` / `currentPage`），
            // 页内统计不可能变 ⇒ 省掉那趟 17ms 的 `refreshAllVirtualStats`。
            { validate: false, refreshParentId: null, skipVirtualStats: true }
        );
    } catch (err) {
        console.error('[revealNode] 展开页内祖先失败:', err);
    }
}

/** 副页里等方框（归属固定是"这个副页"）—— 与 `waitForNodeBox` 同一个查找器，只是带上归属 */
function waitForVirtualNodeBox(pageId, nodeId, tries) {
    return waitForNodeBox(nodeId, tries, { pageId, virtual: true });
}

/** 把当前页切到 `pageId`（切完前不往下走一步 —— 在旧页上继续跑等于每步都落空） */
async function switchPageTo(pageId) {
    if (AppState.currentPageId === pageId) return;
    document.dispatchEvent(new CustomEvent(EVENTS.SWITCH_PAGE, { detail: { pageId } }));
    // 与老实现同一套：**等它真的切完**（`SWITCH_PAGE` 走事务，是异步的），不干等固定毫秒
    await waitFor(() => AppState.currentPageId === pageId, 40, 10);
}

// ================================================================
// 对外入口
// ================================================================

/** 轮询等一个条件成立（最多 `tries`×`intervalMs`）—— 用来替代"固定等一会儿"的写法 */
function waitFor(cond, tries, intervalMs) {
    return new Promise((resolve) => {
        let left = tries;
        const tick = () => {
            if (cond() || --left <= 0) return resolve();
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}

/**
 * 在界面上定位到某个节点
 *
 * ★ **入参两种都认**（`v9.0.17`）：
 *   · 主树真实 id（`AppState.nodes` 里有）⇒ 切回主页面、在主树里定位；
 *   · 副页页内 id（`v_xxx`）⇒ 切到**它所属的那个副页**、在那一页里定位（页内文件夹/展开/翻页）。
 *   归属判据只有一份：`core/ops/page.js:locateVirtualNode`。
 *
 * @param {string} nodeId
 * @returns {Promise<boolean>} 是否成功定位
 */
export async function revealNode(nodeId) {
    const id = String(nodeId || '').trim();
    if (!id) return false;
    // 归属：**先主树真实 id，再副页页内 id** —— 与 `findNodeBox` 的判据**同序**（用户 2026-10-13
    // 定的顺序：先主树那两格；主树里找不到、且该 id 属于某个副页 ⇒ 才切到那个副页）。
    // ⚠️ 同名（`AppState.nodes` 里有、某个副页 `virtualIndex` 里也有）时**主树赢** ——
    //    与"先查主树那两个容器"那条一致；页内 id 与主树 id 在真数据里不同源，同名属异常数据。
    // ⚠️ 反过来说：**别把这条判据写成"只问副页"** —— 那样一个主树 id 只要在某页里恰好撞名，
    //    就会被劫持到副页去（症状：该跳主树的链接把页面切走了）。
    const vHit = AppState.nodes[id] ? null : locateVirtualNode(AppState, id);
    if (!AppState.nodes[id] && !vHit) return false;
    const target = vHit ? { pageId: vHit.pageId, virtual: true } : { pageId: 'main', virtual: false };

    // 1. 主视图分页（副页的页内节点也在主视图那几格里画，所以两条路都要先回「🏠 主视图」这个 tab）
    if (AppState.currentTab !== 'main') switchTab('main');

    // 2. 切到目标所属的那一页（主树 ⇒ 主页面；副页 ⇒ 那个副页）
    await switchPageTo(target.pageId);
    // 切不过去（副页被删了之类）⇒ 如实失败，别在错的那一页上假装成功
    if (AppState.currentPageId !== target.pageId) return false;

    // 3. 按显示模式定位
    const mode = getTreeDisplayMode();
    if (target.virtual) {
        if (mode === 'folder') await revealInVirtualFolderMode(target.pageId, id);
        else await revealInVirtualTreeMode(target.pageId, id);
    } else if (mode === 'folder') {
        await revealInFolderMode(id);
    } else {
        await revealInTreeMode(id);
    }

    // 4. 滚动 + 高亮
    const el = await waitForNodeBox(id, WAIT_TRIES, target);
    if (el) {
        focusNodeBox(el);
        watchHighlight(id, HIGHLIGHT_MS, WATCH_INTERVAL_MS, target);
        return true;
    }

    // 没在预期时间内找到：仍启动高亮看护，万一是渲染更晚到达
    watchHighlight(id, HIGHLIGHT_MS, WATCH_INTERVAL_MS, target);
    console.warn(`[revealNode] 未能在预期时间内找到节点 ${id} 的方框，已转为持续等待高亮时机`);
    return false;
}

/**
 * 注册 REVEAL_NODE 事件监听（由 eventBridge 调用）
 */
export function setupRevealNodeEvents() {
    document.addEventListener(EVENTS.REVEAL_NODE, (e) => {
        const nodeId = e.detail && e.detail.nodeId;
        if (!nodeId) return;
        revealNode(nodeId).catch(err => {
            console.error('[revealNode] 定位失败:', err);
        });
    });
}
