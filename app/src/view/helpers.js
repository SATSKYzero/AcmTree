// ================================================================
// 渲染辅助（view/helpers.js）
// 职责：通用辅助函数，不依赖高层渲染
// 依赖：utils/A_helpers.js, A_constants.js
// ================================================================
import { escapeHtml } from '../utils/html.js';
import { DEFAULT_NODE_PER_PAGE } from '../A_constants.js';
import { renderSlots, RENDER_SLOTS } from '../core/pluginRegistry.js';
import { viewValue } from './scope.js';
// ★ 方框上的"计划强度角标"展示位（只读；文案由计划侧注入 —— 本文件不认识"计划"）
import { nodeBadgeOf } from './nodeBadge.js';
// 方框上**区分原料节点 / 合成节点**的标记类（判定口径 = `isSynthesis`：
// 有非空 `synthKey` ⇒ 合成节点）。这里只**多挂一个 class**，方框的 DOM 结构、
// `data-id`、计数、折叠、拖拽一律不动 —— 花纹本身写在 `index.html` 的样式块里。
import { isSynthesis } from '../core/ops/synth.js';
// ★ 按住 Ctrl 时那一格 nature：「缺哪一格」的判据与「③ 性质待补」**同一份**（`missingNatureKeysOf`）
import { missingNatureKeysOf } from '../core/dedup.js';
import { NATURE_FIELD_KEYS, natureFieldOf } from '../core/natureFields.js';
import { isExpanded, pageOf } from '../core/model/viewState.js';
// ---- 取子节点对象数组（统一真实节点/虚拟节点） ----
// 真实节点：state.childOrder[node.id] 是 id 数组 → 转对象数组
// 虚拟节点：node.children 直接是对象数组
export function getChildNodes(state, node) {
    if (node._virtual) {
        return node.children || [];
    }
    const childIds = state.childOrder[node.id];
    if (!childIds) return [];
    const out = [];
    for (const cid of childIds) {
        const c = state.nodes[cid];
        if (c) out.push(c);
    }
    return out;
}

/**
 * 这一格展开着吗（**渲染侧的唯一入口**）。
 *
 * · **真实节点** ⇒ 读视图态 `state.view.expanded`（`core/model/viewState.js` 的
 *   `isExpanded`）—— 展开**不在节点字段上**（见那个文件头：住在 `nodes` 里会让折叠
 *   换掉 `nodes` 引用、把按引用失效的缓存整片作废）；
 * · **虚拟节点**（副页投影出来的那些）⇒ 读投影里自带的那一格（`dataAdapter` 填的）。
 */
export function isNodeExpanded(state, node) {
    if (!node) return false;
    if (node._virtual) return !!node.expanded;
    return isExpanded(state, node.id);
}

// ---- 每页节点数 ----
export function getNodePerPage(settings) {
    const val = settings.display.nodePerPage;
    if (val !== undefined && val !== null && val > 0) {
        return val;
    }
    return DEFAULT_NODE_PER_PAGE;
}

/**
 * 这个容器现在该显示哪一页（**只算不写**）。
 *
 * 渲染路径**不许改 state**：把夹紧后的页码**写回** `node.currentPage` 不会抛错
 * （autoFreeze 关着），而 `persistence/diff.js` 只按节点**引用**判脏，
 * 于是写入既不入历史也不落盘 → 内存与盘上静默不一致（刷新后又回旧值再夹一次）。
 *
 * 由调用方拿返回值渲染；真正要改页码只有一条路：`core/ops/view.js` 的
 * `setNodeCurrentPage`（在事务里，会落盘、可撤回）。
 *
 * @returns {number} 夹紧到 `[1, pageCount]` 的页码
 */
export function ensureCurrentPage(state, node) {
    if (!node) return 1;
    const nodePerPage = getNodePerPage(state.settings);
    const total = getChildNodes(state, node).length;
    const pageCount = Math.ceil(total / nodePerPage) || 1;
    // 页码住在视图态里（真实节点）；副页的虚拟节点是投影，自带这一格
    const cur = node._virtual ? node.currentPage : pageOf(state, node.id);
    if (cur === undefined || cur === null || cur < 1) return 1;
    if (cur > pageCount) return pageCount;
    return cur;
}

// ---- P 节点提交摘要 ----
// R 的 status / time 是**带账户**的值 → 摘要也得按视图范围现算，
// 否则"我的第几次提交 AC"会和树上显示的结果对不上。
export function getSubmitSummary(state, node) {
    if (node.type !== 'P') return { text: '', color: '#9ca3af' };
    const children = getChildNodes(state, node);
    const rNodes = [];
    for (const c of children) {
        if (c && c.type === 'R') rNodes.push(c);
    }
    if (rNodes.length === 0) return { text: '--', color: '#9ca3af' };
    const sorted = [...rNodes].sort((a, b) => {
        const timeA = viewValue(state, a, 'time') || '----.--.-- --:--';
        const timeB = viewValue(state, b, 'time') || '----.--.-- --:--';
        return String(timeA).localeCompare(String(timeB));
    });
    let firstACIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
        if (viewValue(state, sorted[i], 'status') === 'AC') {
            firstACIndex = i;
            break;
        }
    }
    if (firstACIndex === -1) {
        return { text: `-${sorted.length}`, color: '#ef4444' };
    }
    const x = firstACIndex;
    if (x === 0) {
        return { text: '-0', color: '#16a34a' };
    }
    return { text: `-${x}`, color: '#22c55e' };
}

// ---- 节点是否已渲染到 DOM ----
export function isNodeRendered(node) {
    if (!node || node.type === 'O') return false;
    return document.getElementById(`node-${node.id}`) !== null;
}

// ---- 节点外壳 HTML ----
/**
 * 方框上的**计划强度角标**（`剩 X / 共 Y`）—— 按住 Ctrl 才看得见（CSS 那条 `body.ctrl-held`）。
 *
 * ⚠️ 文案是**计划侧注入**的（`ui/plan/pageBadges.js` 调 `setNodeBadges`）——
 *    本文件**不认识"计划"**，只问"这一格有没有角标要画"（`view/nodeBadge.js`）。
 * ⚠️ DOM 位置在 **nature 那个 inline `<span>` 内部**（用户 2026-10-15："位置移到 nature 后面"），
 *    但**样式上是悬浮的**（`position:absolute`，钉在 `.node-meta` 的右下角）⇒
 *    **完全不参与排版**（用户 2026-10-15 第二条："用悬浮的语法放入该元素，以完全不影响其他元素的排版"）。
 *    实测踩过：**在流里**时 `.node-meta` 是 `flex-wrap` 容器 ⇒ 这一行满了角标会被挤到**下一行**
 *    ⇒ 每个方框高一点，展开的子树一累加，靠下的节点就整体往下漂。
 * ⚠️ 默认 `display:none`（见 `index.html` 那条 `.node-badge`）：不按 Ctrl 时它是**零噪声**的。
 */
function planBadgeHtmlOf(node) {
    const text = nodeBadgeOf(node && node.id);
    if (!text) return '';
    return `<span class="node-badge" title="${escapeHtml('这条计划在这一支里还差多少强度 / 一共多少强度（按住 Ctrl 显示）')}">${escapeHtml(text)}</span>`;
}

export function renderNodeBox({
    node,
    titleHtml,
    metaHtml,
    colorBarColor,
    statusBarClass = '',
    badgeText = '',
    toggleBtnHtml = '',
    actionsHtml = '',
    childrenHtml = '',
    dimmed = false
}) {
    // ★ 合成节点方框多挂一个类（`isSynthesis` 是唯一判定口径）。纯表现：不改任何
    //   `data-*`、不改 DOM 结构、不改子节点 HTML。原料节点仍然是
    //   `class="node-box"` —— 于是"方框带不带这个类"就是两类节点的**唯一**差别。
    // ★ `dimmed`（`v9.1.26`）：**被忽略的提交**（题目 AC 时间第 4 种规则下早于截断的那些）——
    //   整体变淡（`.node-ignored`，见 `index.html` 那条注释）。与斜纹**可以同时挂**。
    const boxClass = ['node-box',
        isSynthesis(node) ? 'synth-box-pattern' : '',
        dimmed ? 'node-ignored' : ''
    ].filter(Boolean).join(' ');
    return `
        <div id="node-${node.id}" class="node-wrapper">
            <div class="${boxClass}" data-id="${node.id}">
                <div class="color-bar" style="background-color:${colorBarColor};"></div>
                <div class="status-bar ${statusBarClass}"></div>
                <span class="node-type-badge">${badgeText}</span>
                <div class="node-row">
                    ${toggleBtnHtml}
                    <div class="node-main">
                        ${titleHtml}
                        ${metaHtml}
                    </div>
                    <div class="node-actions">${actionsHtml}</div>
                </div>
                ${childrenHtml}
            </div>
        </div>
    `;
}

// ---- 展开/折叠按钮 ----
export function buildToggleButton(state, node, mode) {
    if (mode === 'selector' || mode === 'readonly' || mode === 'folder' || mode === 'folder-header') return '';
    const children = getChildNodes(state, node);
    if (children.length > 0) {
        const open = isNodeExpanded(state, node);
        return `<button class="toggle-btn" data-id="${node.id}" title="${open ? '收起' : '展开'}">${open ? '▼' : '▶'}</button>`;
    }
    return `<button class="toggle-btn" disabled style="opacity:0.2;">▶</button>`;
}

// ---- 时间标签 ----
export function buildTimeTags(state, node) {
    return `<span class="tag">创建: ${escapeHtml(node.createdAt)}</span><span class="tag">修改: ${escapeHtml(node.lastModified)}</span>`
        + naturePeekHtml(state, node);
}

/**
 * 「按住 Ctrl 时显示的 nature」—— 就在**「修改」后面那一格**（用户 2026-10-08 指定）。
 *
 * 为什么要有它：整理 nature 时要在**树上**一眼看出"哪一条缺哪一格"，而不是逐条点开详页。
 *
 * ⚠️ **副页（虚拟节点）显示的是它"所映射主节点"的 nature**（用户 2026-10-08 要求）：
 *    虚拟节点自己那四格是空的（值都在主树那条上）—— 照它自己显示就会满屏"分类 空 年份 空…"，
 *    而人在副页上问的问题正是"这一条 nature 填了没有"。
 *
 * ⚠️ 这里**只出内容、不写 `display`**：隐藏/显示那一条规则**只写在 `index.html` 的样式块**里
 *    （`.node-nature` + `body[data-nature-peek]`）。这样"谁在管显示"只有一处，
 *    而且**重画出来的新方框自动跟着走**（散着设 `style.display` 的话，
 *    按住 Ctrl 时滚动/展开新画出来的那些会是隐藏的，得再按一次键才亮）。
 *
 * ⚠️ "缺哪一格"的判据不是"值为空"，而是 `missingNatureKeysOf`（`core/dedup.js`）——
 *    与**「③ 性质待补」同一份**（分类没细到 Trie 的叶子**也算缺**）；
 *    非空但判为缺的那个值照原样显示、只把它标成琥珀色（比印一个"空"字信息多）。
 */
export function naturePeekHtml(state, node) {
    if (!node || node.type === 'O') return '';
    // ★ 副页节点：读**它所映射的主节点**（`_refId` 是投影时挂上的，见 `view/dataAdapter.js`）
    const real = node._refId && state && state.nodes ? state.nodes[node._refId] : null;
    const src = real || node;
    const missing = new Set(missingNatureKeysOf(src));
    const parts = NATURE_FIELD_KEYS.map((key) => {
        const label = (natureFieldOf(key) || {}).label || key;
        const raw = src[key];
        const v = String(raw === undefined || raw === null ? '' : raw).trim();
        if (!missing.has(key) && v) return `${escapeHtml(label)} ${escapeHtml(v)}`;
        const text = v || '空';
        return `${escapeHtml(label)} <b class="node-nature-miss">${escapeHtml(text)}</b>`;
    });
    // ★ 计划强度角标**挂在 nature 那个 inline `<span>` 内部**（用户 2026-10-15："位置移到
    //   nature 后面" → 当天第二条："用**悬浮**的语法放入该元素，以完全不影响其他元素的排版"）：
    //   DOM 位置在 span 里，但**样式**是 `position:absolute`（钉 `.node-meta` 右下角，见
    //   `index.html`）⇒ **一个字都不参与排版**。⚠️ 观感上它是**右对齐到 `.node-meta` 的右缘**，
    //   **不是**紧贴 nature 芯片（用户 2026-10-15 看过实物："强度的位置变了，本来紧挨 nature
    //   右侧的，但也能接受，就这样吧" ⇒ 这就是定稿口径，别再"修回"紧跟 nature）。
    //   ⚠️ 这就是它**不能**写成"在流里跟着 nature 走"的原因：`.node-meta` 是 `flex-wrap`
    //      容器，满行时角标会把话题挤到下一行、方框随之变高（实测踩过）。
    //   ⚠️ 两处显示条件是同一个 Ctrl（`.node-nature` 看 `body[data-nature-peek]`、
    //      角标看 `body.ctrl-held`）⇒ 观感一致；哪天要"角标不跟 nature 一起显隐"再拆出来。
    return `<span class="node-nature">${parts.join(' <span class="node-nature-sep">·</span> ')}${planBadgeHtmlOf(node)}</span>`;
}

// ---- 资格判定（副页投影 / 祖先链 / 子树计数）----
// ⚠️ 实现在 `./eligible.js`（**纯模块**：只读 state 形状、不碰渲染）。
//    本文件 import 了 `core/pluginRegistry.js`（取 renderSlots），
//    那条链会拉进 `shell/state.js` → `immer` ⇒ **任何** import 本文件的模块都没法进纯 Node 单测。
//    单独成文件之后 `view/filterMode.js` 才是可单测的。
export { getProjected, hasEligibleAncestor, countEligibleSubtree } from './eligible.js';
import { getProjected, hasEligibleAncestor, countEligibleSubtree } from './eligible.js';

// ---- 操作按钮 ----
/**
 * 副页节点上那颗「屏蔽 / 取消屏蔽」（**只有副页节点有**）。
 *
 * 语义（用户 2026-10-15 + `docs/subpage-sync.md`）：**「与主树对齐」走到这里就不再往下递归** ——
 * 这一支已有的内容**不增不减**（不是删除、也不是隐藏）。
 * ⚠️ 状态就画在这颗按钮上（`🚫` = 已屏蔽 / `○` = 未屏蔽），别只在别处写一句话。
 * ⚠️ 两个虚拟分支（文件夹模式 / 分页视图）**共用这一份**：各写一遍迟早分叉。
 */
function blockedButtonHtml(node) {
    const on = !!node.syncBlocked;
    // ⚠️ 文案里不许出现字面 Markdown 记号（`docHygiene.test.js` 会红）⇒ 一个反引号都不加
    const title = on
        ? '已屏蔽：与主树对齐时不再往下递归（点一下取消）'
        : '屏蔽：与主树对齐时不再往下递归（这一支已有的内容不动）';
    return '<button class="btn-icon btn-toggle-blocked" data-id="' + node.id + '" title="' + title + '">'
        + (on ? '🚫' : '○') + '</button>';
}

export function buildActions(state, node, index, parentArray, isVirtual, mode, disabled = false, currentFolderId = null) {
    if (mode === 'selector') {
        return `<input type="radio" name="tree-selector-radio" value="${node.id}" ${disabled ? 'disabled' : ''} style="margin:0; width:18px; height:18px; flex-shrink:0; cursor:pointer;">`;
    }
    if (mode === 'readonly' || mode === 'folder-header') {
        return '';
    }

    const editMode = state.settings.mode.editMode || 'attribute';

    // ---- 选中状态编辑模式 ----
    if (editMode === 'selection') {
        const hasAncestor = hasEligibleAncestor(state, node, true, false);
        const subCount = countEligibleSubtree(state, node, true, false);
        const hasSPAnc = hasEligibleAncestor(state, node, true, true);
        const spSubCnt = countEligibleSubtree(state, node, true, true);

        let displayText1 = '';
        let fontSize1 = '14px';
        if (subCount === 0) { displayText1 = ''; }
        else if (subCount < 10) { displayText1 = String(subCount); fontSize1 = '14px'; }
        else if (subCount < 100) { displayText1 = String(subCount); fontSize1 = '11px'; }
        else { displayText1 = '∞'; fontSize1 = '14px'; }
        const bgColor1 = hasAncestor ? '#d1fae5' : '#f1f5f9';
        const boxHtml1 = `<span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; background:${bgColor1}; border:2px solid #000; border-radius:4px; font-size:${fontSize1}; font-weight:700; color:#1e293b; margin-right:4px;">${displayText1}</span>`;

        let displayText2 = '';
        let fontSize2 = '14px';
        if (spSubCnt === 0) { displayText2 = ''; }
        else if (spSubCnt < 10) { displayText2 = String(spSubCnt); fontSize2 = '14px'; }
        else if (spSubCnt < 100) { displayText2 = String(spSubCnt); fontSize2 = '11px'; }
        else { displayText2 = '∞'; fontSize2 = '14px'; }
        const bgColor2 = hasSPAnc ? '#dbeafe' : '#f1f5f9';
        const boxHtml2 = `<span style="display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; background:${bgColor2}; border:2px solid #000; border-radius:4px; font-size:${fontSize2}; font-weight:700; color:#1e293b; margin-right:4px;">${displayText2}</span>`;

        const isSelected = node._virtual
            ? (state.pages[node._pageId]?.virtualIndex[node._virtualId]?.selected || false)
            : (node.selected || false);
        const dotHtml = `<button class="btn-icon btn-select-toggle" data-id="${node.id}" title="切换选中状态" style="width:20px; height:20px; border-radius:50%; border:2px solid ${isSelected ? '#2563eb' : '#94a3b8'}; background:${isSelected ? '#2563eb' : 'transparent'}; cursor:pointer; padding:0; transition:all 0.15s; flex-shrink:0; margin-right:4px;"></button>`;

        const toggleChildrenHtml = `<button class="btn-icon btn-toggle-children" data-id="${node.id}" title="翻转所有直接子节点的选中状态" style="width:20px; height:20px; border-radius:50%; border:2px solid #94a3b8; background:transparent; cursor:pointer; padding:0; transition:all 0.15s; flex-shrink:0; font-size:16px; color:#64748b; margin-right:4px; display:flex; align-items:center; justify-content:center;"><span style="display:inline-block; transform:translateY(-1px);">↕</span></button>`;

        const canMoveUp = index > 0;
        const canMoveDown = index < parentArray.length - 1;
        const upHtml = `<button class="btn-icon btn-move-up" data-id="${node.id}" title="上移" ${canMoveUp ? '' : 'disabled'} style="${canMoveUp ? '' : 'opacity:0.3;cursor:not-allowed;'} ">⬆</button>`;
        const downHtml = `<button class="btn-icon btn-move-down" data-id="${node.id}" title="下移" ${canMoveDown ? '' : 'disabled'} style="${canMoveDown ? '' : 'opacity:0.3;cursor:not-allowed;'}">⬇</button>`;

        // ★ 渲染槽：选择圆点之前（槽 id 以 core/pluginRegistry.js 的 RENDER_SLOTS 为唯一真源）
        const pageId = node._virtual ? node._pageId : 'main';
        const slotHtml = renderSlots(RENDER_SLOTS.NODE_SELECT_DOT_BEFORE, state, {
            node,
            mode,
            isVirtual,
            pageId
        });

        return slotHtml + dotHtml + toggleChildrenHtml + boxHtml1 + boxHtml2 + upHtml + downHtml;
    }

    // ---- 文件夹模式 ----
    if (mode === 'folder') {
        const isCurrentFolder = (node.id === currentFolderId);
        const canMoveUp = index > 0;
        const canMoveDown = index < parentArray.length - 1;

        // 副页（虚拟节点）在文件夹模式下：**只给真正能用的那几个**。
        // 📋 同时带**两个身份**：`data-id` = 所映射的真实节点
        //（直接打开真节点的信息）、`data-vid`/`data-page-id` = 这个虚拟节点自己 ——
        // 点它会先弹"查看哪个"（主节点 / 副页节点本身），见 G_events 与 G7 的选择器。
        // 编辑/加子节点/更多操作在副页里一律是被拒的（见 G_events），所以**不画**——
        // 画出来再弹"副页不支持"比不画更糟。✖ 与 ⬆⬇ 是**页内**操作，用虚拟 id。
        if (isVirtual) {
            return `
            <button class="btn-icon btn-node-info" data-id="${node._refId || node.id}" data-vid="${node._virtualId || node.id}" data-page-id="${node._pageId || ''}" title="详细节点信息（可选看主节点 / 副页节点）">📋</button>
            ${blockedButtonHtml(node)}
            <button class="btn-icon btn-danger btn-delete" data-id="${node.id}" title="从副页移除（按住Ctrl）">✖</button>
            ${isCurrentFolder ? '' : `<button class="btn-icon btn-move-up" data-id="${node.id}" title="上移" ${canMoveUp ? '' : 'disabled'}>⬆</button>`}
            ${isCurrentFolder ? '' : `<button class="btn-icon btn-move-down" data-id="${node.id}" title="下移" ${canMoveDown ? '' : 'disabled'}>⬇</button>`}
        `;
        }

        return `
            <button class="btn-icon btn-node-info" data-id="${node.id}" title="详细节点信息">📋</button>
            <button class="btn-icon btn-edit" data-id="${node.id}" title="编辑节点（Ctrl+单击）">✏️</button>
            <button class="btn-icon btn-add-child" data-id="${node.id}" title="添加子节点">➕</button>
            <button class="btn-icon btn-more" data-id="${node.id}" title="更多操作">⚙️</button>
            <button class="btn-icon btn-danger btn-delete" data-id="${node.id}" title="删除（按住Ctrl）">✖</button>
            ${isCurrentFolder ? '' : `<button class="btn-icon btn-move-up" data-id="${node.id}" title="上移" ${canMoveUp ? '' : 'disabled'}>⬆</button>`}
            ${isCurrentFolder ? '' : `<button class="btn-icon btn-move-down" data-id="${node.id}" title="下移" ${canMoveDown ? '' : 'disabled'}>⬇</button>`}
        `;
    }

    if (mode !== 'full') return '';

    const canMoveUp = index > 0;
    const canMoveDown = index < parentArray.length - 1;

    if (isVirtual) {
        // 副页（虚拟节点）在**分页视图**下也一样：📋 同时带真节点 id 与虚拟 id（见上面文件夹模式那段），
        // ✖/⬆⬇ 是页内操作、用虚拟 id；🚫 是「与主树对齐时不再往下递归」（`docs/subpage-sync.md`）。
        return `
            <button class="btn-icon btn-node-info" data-id="${node._refId || node.id}" data-vid="${node._virtualId || node.id}" data-page-id="${node._pageId || ''}" title="详细节点信息（可选看主节点 / 副页节点）">📋</button>
            ${blockedButtonHtml(node)}
            <button class="btn-icon btn-danger btn-delete" data-id="${node.id}" title="从副页移除（按住Ctrl）">✖</button>
            <button class="btn-icon btn-move-up" data-id="${node.id}" title="上移" ${canMoveUp ? '' : 'disabled'}>⬆</button>
            <button class="btn-icon btn-move-down" data-id="${node.id}" title="下移" ${canMoveDown ? '' : 'disabled'}>⬇</button>
        `;
    }

    return `
        <button class="btn-icon btn-node-info" data-id="${node.id}" title="详细节点信息">📋</button>
        <button class="btn-icon btn-edit" data-id="${node.id}" title="编辑属性">✏️</button>
        <button class="btn-icon btn-add-child" data-id="${node.id}" title="添加子节点">➕</button>
        <button class="btn-icon btn-more" data-id="${node.id}" title="更多操作">⚙️</button>
        <button class="btn-icon btn-danger btn-delete" data-id="${node.id}" title="删除（按住Ctrl）">✖</button>
        <button class="btn-icon btn-move-up" data-id="${node.id}" title="上移" ${canMoveUp ? '' : 'disabled'}>⬆</button>
        <button class="btn-icon btn-move-down" data-id="${node.id}" title="下移" ${canMoveDown ? '' : 'disabled'}>⬇</button>
    `;
}