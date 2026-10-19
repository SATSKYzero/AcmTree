// ================================================================
// 「节点行」上的三个入口（ui/kit/nodeEntry.js）
//
// 给**非主树**的节点行（数据统计里的 AC 列表…）补上主树那一套里天然有的三件事：
//   · 🔎 跳到树上 —— 承载 = `data-reveal-node`（`ui/kit/actions.js:markGoto` 挂的**唯一一份**）；
//     接住它的是 `ui/nodeinfo/nodeGroupActions.js` 里那条**文档级**委托 ⇒ 调用方不用挂任何监听；
//   · 📋 打开详页 —— `btn-node-info[data-id]` + `ui/tabs.js:openNodeInfoTab`
//     （`ui/G_events.js` 的文档级委托接住，与树上那颗 📋 是同一件事）；
//   · 面包屑 —— `ui/nodeinfo/nodeGroup.js:breadcrumbHtml`（**一个入口、内部按归属分支**：
//     主树节点 ⇒ 主树祖先链；副页节点 ⇒ 页内祖先链 + `📄 页名` 前缀）。
//
// ⚠️ 本文件**不实现**上面任何一件事：只把现成那三份拼成一行。
//    别在这里、也别在新页面里另写跳转 / 详情 / 面包屑的第二份实现
//    （为什么：见 `docs/node-navigation.md` 的第 5 节，以及 `src/ui/AGENTS.md` 那条"三样都只有一份"）。
//
// ⚠️ **主树真实 id 与副页页内 id 两种都认**（`v9.0.19` 起 —— 前提变了：`v9.0.17` 起
//    `ui/revealNode.js:revealNode` 也认页内 id）：
//    · **主树节点** ⇒ 🔎 给主树真实 id（`mainTreeNodeIdOf`：`realNodeIdOf` 解析 + 要求树上真有），
//      面包屑走 `breadcrumbHtml` 的主树那一支；
//    · **副页节点**（`_virtual`，页内 id 在 `state.nodes` 里查不到）⇒ 🔎 给**页内 id**
//      （`revealNode` 会切到那一页再页内定位），📋 带树上那颗同样的**两个身份**
//      （`data-id` = 真节点 / `data-vid` + `data-page-id` = 页内自己 ⇒ 走"看哪个"选择器），
//      面包屑走同一个 `breadcrumbHtml` 的**页内**那一支（判 `_virtual`，调用方不用挑函数）。
//    · **解析不出就别画成可点**（假链接比纯文本更糟 —— `ui/kit/report.js:nodeOrText` 的文件头记着这条）。
// ================================================================
import { mk } from '../../utils/dom.js';
import { markGoto } from './actions.js';
// ★ 「解析成主树真实 id」只有一份（core/ops/page.js 的 `mainTreeNodeIdOf`）——
//   本文件只是按**节点对象**取一次它的 id 再转过去（插件 ContestOverview 那边是同一份）
import { mainTreeNodeIdOf, locateVirtualNode } from '../../core/ops/page.js';
// ★ 身份键（`extKey`，合成节点看 `synthKey`）也只有一份读口 —— `core/fieldRegistry.js:identityKeyOf`
import { identityKeyOf } from '../../core/fieldRegistry.js';
import { breadcrumbHtml } from '../nodeinfo/nodeGroup.js';
import { plain } from '../../utils/text.js';
// ★ 副页**页内 id** 拿展示节点的那一份现成投影（`_virtual / _virtualId / _refId / _pageId`）
import { getVirtualDisplayNode } from '../../view/dataAdapter.js';

/**
 * 这个节点在**主树**上的 id（能跳才给）。
 *
 * 副页节点先解析成它引用的真实节点（`mainTreeNodeIdOf` → `realNodeIdOf`，**唯一那一份**解析口）；
 * 副页根节点（不引用真实节点）/ 节点已删 ⇒ 空串 = **不可点**（调用方如实说，别画假链接）。
 *
 * @returns {string} 可跳的主树节点 id；空串 = 不能跳
 */
export function mainTreeJumpId(state, node) {
    return mainTreeNodeIdOf(state, (node && node.id) || '');
}

/**
 * 一行「入口条」：🔎 跳到树上 + 📋 打开详页 + 该节点的面包屑（可跳的都没有时如实写一句）。
 *
 * 两种形态（用户 2026-10-15："太臃肿了 **一条只占一行**"）：
 *   · 默认（**块状**）：🔎 / 📋 各一颗带字的按钮，面包屑另起一行 —— 适合"这一屏就一两个节点"的地方
 *     （AC 列表、详页里的组员表那种，`appendNodeEntries` 也用它）；
 *   · `{ compact: true }`（**一行一格，信息给全**）：**身份键**（`extKey`/`synthKey`，没有才退回 id）
 *     + **完整面包屑（含节点自己，一级不缺，整条蓝）**——面包屑自己就是 🔎 入口（`markGoto` 挂在它上面）
 *     + 📋 只留图标（`margin-left:auto` ⇒ 贴右端点）。
 *     适合"一行一个节点"的清单（副页仪表盘的屏蔽清单就是这么用的）。
 * ⚠️ 两种形态**共用下面那三份实现**（`markGoto` / `btn-node-info` / `breadcrumbHtml`）——
 *    别为了"紧凑"另写一套跳转/详情。
 *
 * @param {Object} state - `AppState`
 * @param {Object} node  - 节点（真实节点或副页投影节点）
 * @param {{compact?:boolean}} [opts]
 * @returns {HTMLElement}
 */
export function nodeEntryLine(state, node, opts = {}) {
    const compact = !!opts.compact;
    // 一行一格、**每一格都是一小块矩形**（用户 2026-10-15："每项都要假想装在矩形里，每个矩形合适间距"）
    // ⇒ 各段之间是同一个固定 `gap`（不是"靠 auto 撑开"），段内各有自己的小 padding。
    const wrap = mk('div', 'node-entry',
        // ⚠️ **一律垂直居中**（用户 2026-10-15："能不能**全部垂直居中**，别微调了"）：
        //    各格按**自己的行盒**居中；再配上"字号行高跟宿主"（见下面 `compact` 那支不写 font-size、
        //    面包屑走 `flat:true`）⇒ 各格行盒一样高，居中就是真的对齐，不用逐格微调。
        'display:flex;align-items:center;gap:8px;'
        + (compact
            // 一行：不换行（超长的那一段自己 `text-overflow:ellipsis`）。
            // ★ **`flex:1 1 auto`（要占满"剩下那点宽度"）**—— 宿主那一格/那一行多半是 flex，
            //   而 📋 靠的是**自己的 `margin-left:auto`**：只有这条入口条**吃下剩余宽度**，
            //   它右侧才有空白可吃、📋 才落在**右端点**上。以前写成 `flex:0 1 auto`（按内容收窄）
            //   ⇒ 剩余空白留在入口条**外面**，`auto` 无处可施 ⇒ 每一行的 📋 跟着面包屑长短左右乱跑
            //   （用户 2026-10-15 指着计划那张表："题目列表的详页按钮又没对齐了"）。
            //   ⚠️ 宿主不是 flex（`<td>` / 块级）时 `flex` 不生效 ⇒ 那里本来就是整格宽，照旧。
            ? 'flex:1 1 auto;min-width:0;flex-wrap:nowrap;overflow:hidden;color:#94a3b8;'
            : 'flex-wrap:wrap;margin:0 0 6px 6px;font-size:11px;color:#94a3b8;'));
    const id = String((node && node.id) || '');
    // 归属判据只有一份：`core/ops/page.js:locateVirtualNode`（"这个 id 在哪个副页里"）
    const vHit = (state && id) ? locateVirtualNode(state, id) : null;

    /**
     * 紧凑形态的**第一格：身份键**（`extKey`；合成节点看 `synthKey`；都没有才退回节点 id）。
     *
     * 用户 2026-10-15："应该在最前面放 id/extkey" + "总之信息给全，各列表都给全"。
     * ⚠️ 取法**只有一份**：`core/fieldRegistry.js:identityKeyOf`（别在这儿读 `node.extKey`）。
     * ⚠️ **副页的投影节点也有**（`view/dataAdapter.js` 是 `{...realNode}` 展开出来的）——
     *    但**页根**那种合成出来的节点没有真节点可摊 ⇒ 这一格退回页内 id（如实写，不编）。
     */
    const idChip = () => {
        const key = identityKeyOf(node) || id;
        if (!key) return null;
        const chip = mk('span', 'node-entry-id',
            'flex:0 0 auto;max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            // ⚠️ **上下不许有 padding**（用户 2026-10-15："全部垂直居中，别微调了"）：
            //    这一格是 **`align-items:center` 居中的"各自行盒"**——上下加 1px 就让它的行盒比同行
            //    别的格高 2px，居中之后文字必然差 2px（实测三次都是这个数）。要底色就**只给左右**。
            // ⚠️ **不许换字体**：这里原来是 `ui-monospace` 等宽 —— 同样行盒下等宽字体的**基线**
            //    比宿主那套字天生高 2px（实测：别的列 58.91 / 身份键 56.91），也就是"看着没对齐"。
            //    它的"身份"靠**底色 + 圆角**表达，不靠字体（用户 2026-10-15："全部垂直居中，别微调了"）。
            + 'padding:0 6px;border-radius:5px;background:#f1f5f9;color:#475569;');
        chip.textContent = key;
        chip.setAttribute('title', plain(`身份键：${key}`));
        return chip;
    };

    /**
     * 紧凑形态的**第二格**：**完整面包屑（含节点自己，一级不缺）**，整条蓝色，而且它就是 🔎 入口。
     *
     * 用户 2026-10-15："第一项用完整的面包屑替代，不要缺一级，全蓝；第三项（原有面包屑）删了"。
     * ⚠️ 面包屑**仍是 `breadcrumbHtml` 那一份**（只是传了 `{ includeSelf, color }`）——
     *    别在列表里另写一条"节点名 + 路径"的拼法。
     */
    const compactCrumbEntry = (jumpId, jumpTitle) => {
        const go = mk('span', 'node-entry-crumb',
            'flex:0 1 auto;min-width:0;max-width:40em;overflow:hidden;text-overflow:ellipsis;'
            + 'white-space:nowrap;color:#1d4ed8;');
        markGoto(go, jumpId, '#1d4ed8', jumpTitle || '跳到它的位置');
        // ⚠️ `treeTag: false` —— 入口条这一格左边已经有**身份键**（`extKey`）了，"来源树"那段
        //    就是它的第一段、而且**不是节点**（用户 2026-10-15："这个面包屑 **前两节好像不存在**啊"）
        //    ⇒ 这里只画**树上真实那条路径**（详页头部那条照旧带它，那一处缺省不传）。
        // ⚠️ `flat: true` —— 不套面包屑自带那层 11px/1.6 的 div：那一层会让这一格的行盒跟同行
        //    别的格不一样高，**flex 居中对的是各自的行盒** ⇒ 永远差 1~2px（实测）。摊平之后
        //    字号/行高**全跟宿主那行**，居中就是真的居中。
        go.innerHTML = breadcrumbHtml(state, node,
            { includeSelf: true, color: '#1d4ed8', treeTag: false, flat: true });
        if (!go.innerHTML) go.textContent = String((node && (node.name || node.problemId)) || id);
        return go;
    };
    /** 紧凑形态的前两格（身份键 + 完整面包屑）—— 两个分支（副页 / 主树）共用 */
    const compactHead = (jumpId, jumpTitle) => {
        const chip = idChip();
        if (chip) wrap.appendChild(chip);
        wrap.appendChild(compactCrumbEntry(jumpId, jumpTitle));
    };
    /** 紧凑形态下那颗 📋（只留图标；**`margin-left:auto` ⇒ 右端点取 max** —— 用户 2026-10-15 明确要的） */
    const infoBtn = (attrs, title) => {
        const info = mk('button', 'btn-icon btn-node-info',
            // ⚠️ 紧凑形态**不写 font-size**（跟宿主那行）—— 与上面"不写 font-size"同一条理由：
            //    写死一个字号就与同行的格不一样高，居中时对不齐。
            (compact ? '' : 'font-size:11px;')
            + 'padding:1px 6px;cursor:pointer;white-space:nowrap;flex:0 0 auto;'
            + (compact ? 'margin-left:auto;' : ''));
        info.setAttribute('type', 'button');
        for (const [k, v] of Object.entries(attrs)) info.setAttribute(k, v);
        info.setAttribute('title', plain(title));
        info.textContent = compact ? '📋' : '📋 打开详页';
        return info;
    };
    /**
     * 面包屑那一格（**块状形态**用：独占一整行 → `flex-basis:100%`）。
     *
     * ⚠️ 紧凑形态**不走这一格**（它的面包屑在 `compactCrumbEntry` 里，是那一行的第二格）；
     *    所以这里没有 `compact` 分支 —— 别再补一个"紧凑时的省略写法"，那会变成第二份拼法。
     */
    const crumb = (html) => {
        if (!html) return null;
        const box = mk('div', 'node-entry-crumb', 'flex-basis:100%;');
        box.innerHTML = html;
        return box;
    };

    // ============================================================
    // 副页节点（页内 id）：**页内**那三样（`v9.0.19`）
    //
    // 以前这里整条都不给（`state.nodes` 查不到 ⇒ 主树那份判据全部落空），
    // 于是副页的「📊 题目分布统计」筛出来的题目**既没有 🔎 也没有 📋、也没有面包屑**。
    // 现在 `revealNode` 认页内 id，所以三样各走现成的那一份：
    //   🔎 承载仍是 `markGoto` 挂的 `data-reveal-node`（值 = **页内 id**）；
    //   📋 仍是 `btn-node-info`，带树上那颗同样的两个身份（`data-id`/`data-vid`/`data-page-id`）；
    //   面包屑走 `breadcrumbHtml` 的**页内**那一支（它内部判 `_virtual`，调用方不挑函数）。
    // ============================================================
    if (vHit && vHit.vNode) {
        const vNode = vHit.vNode;
        const refId = String(vNode.refId || '');
        // 页内**根**节点：它就是这一页本身（那一页不画它的方框，也没有"页内位置"可跳）
        // ⇒ 与 `nodeInfoView.buildShell` 同一条判据（`type === 'O'`），整条如实留空。
        if (vNode.type !== 'O') {
            if (compact) {
                // 一行形态：**身份键 + 完整面包屑（含自己、全蓝）**，面包屑自己就是 🔎 入口
                compactHead(id, '跳到它所在那一页里的位置');
            } else {
                const go = mk('span', '', 'text-decoration:underline dotted;');
                // ★ 唯一承载：值给**页内 id**（`revealNode` 按归属分流：切到那一页再页内定位）
                //   标题也传自己的 —— 默认那句"在树上定位"在副页里是假话（提示要与行为一致）
                markGoto(go, id, '#1d4ed8', '跳到它所在那一页里的位置');
                go.textContent = '🔎 跳到这一页的位置';
                wrap.appendChild(go);
            }

            // 与树上/副页方框上那颗 📋 **同一套身份**：`data-id` = 所映射的真实节点，
            // `data-vid` + `data-page-id` = 这个页内节点自己 —— `ui/G_events.js` 那两条既有委托
            // 见到 `data-vid` 就先弹"看哪个"选择器，再由它 `openNodeInfoTab(..., { asVirtual, pageId })`。
            // ⚠️ **别在这里直接调 `openNodeInfoTab`**（会多出第二条开详页的路）。
            wrap.appendChild(infoBtn({ 'data-id': refId || id, 'data-vid': id, 'data-page-id': vHit.pageId },
                '打开它所在那一页的详页（与树上那个 📋 是同一件事）'));
        }

        // 紧凑形态**不再另起一格面包屑**（它已经在 `compactHead` 里、就是那一行的第二格 —— "第三项删了"）
        // ⚠️ 副页那一支**没有**"来源树"那段（页内链本来就不带 tag）⇒ 这里不用传 `treeTag`
        if (!compact) {
            const vCrumb = crumb(breadcrumbHtml(state, node));
            if (vCrumb) wrap.appendChild(vCrumb);
        }
        return wrap;
    }

    // ============================================================
    // 主树节点：**行为一个字没动**（`v9.0.19` 只加了上面那一支）
    // ============================================================
    const jumpId = mainTreeJumpId(state, node);

    if (jumpId) {
        if (compact) {
            // 一行形态：身份键 + 完整面包屑（含自己、全蓝；它自己就是 🔎）
            compactHead(jumpId, '跳到它的位置');
        } else {
            const go = mk('span', '', 'text-decoration:underline dotted;');
            // ★ 唯一承载：`markGoto` 挂 `data-reveal-node`（+ 兼容钩子）与观感，这里不自己写属性
            markGoto(go, jumpId);
            go.textContent = '🔎 跳到树上';
            wrap.appendChild(go);
        }
        wrap.appendChild(infoBtn({ 'data-id': jumpId },
            '打开这个节点的详页（与树上那个 📋 是同一件事）'));
    } else {
        // 解析不出 / 树上没有 ⇒ **如实**写，不画成可点（假链接比纯文本更糟）
        const no = mk('span');
        no.textContent = id ? '（树上没有这个节点，不能跳转）' : '（没有节点 id，不能跳转）';
        wrap.appendChild(no);
    }

    // 面包屑：上面**副页那一支已经返回了**（它走 `breadcrumbHtml` 的页内分支），
    // 走到这里的必是主树节点 —— `!node._virtual` 这条判据留着，免得哪天有人改了上面的分流。
    if (!compact && state && node && !node._virtual) {
        const box = crumb(breadcrumbHtml(state, node));
        if (box) wrap.appendChild(box);
    }
    return wrap;
}

/**
 * 给 `container` 里 `rowSelector` 那一段的**每个节点方框后面**插一行入口条（`nodeEntryLine`）。
 *
 * 为什么"插在方框后面"而不是塞进方框里：方框上的按钮是 `view/helpers.js:buildActions` 的
 * 那一份名单，而这两处用的是 `readonly`（**刻意一个按钮都不画**）——
 * 往方框里塞按钮会把"这一格有什么"变成两处口径（见 `docs/node-navigation.md` 的 G1）。
 *
 * ⚠️ 只在**真浏览器**里有效：冒烟用的 DOM 桩不解析 `innerHTML`
 *    （`scripts/smoke/dom.mjs` 的文件头），`renderNode` 出来的方框在桩里查不到
 *    ⇒ 这一支在冒烟里是空转。**别把"冒烟绿"当成"这一处铺上了"**。
 */
export function appendNodeEntries(container, state, rowSelector = '') {
    if (!container || typeof container.querySelectorAll !== 'function') return;
    const rows = rowSelector ? container.querySelector(rowSelector) : container;
    if (!rows || typeof rows.querySelectorAll !== 'function') return;
    for (const box of rows.querySelectorAll('.node-box[data-id]')) {
        const id = String(box.dataset.id || '');
        // 主树节点直接查表；**副页的页内 id 在 `state.nodes` 里查不到** ⇒ 走现成的副页投影
        // （`getVirtualDisplayNode`，与副页里画方框用的是同一份构造）。
        // ⚠️ 没有这一句，副页的方框会在这里被 `continue` 掉 ⇒ 整条入口条不出现
        //    （症状：副页「题目分布统计」筛出来的题目没有 🔎/📋/面包屑）。
        const node = (state && state.nodes ? state.nodes[id] : null) || virtualDisplayNode(state, id);
        if (!node) continue;
        const host = (typeof box.closest === 'function' && box.closest('.node-wrapper')) || box;
        const parent = host.parentNode;
        if (!parent || typeof parent.insertBefore !== 'function') continue;
        parent.insertBefore(nodeEntryLine(state, node), host.nextSibling || null);
    }
}

/** 页内 id → 副页展示节点（归属判据只有 `locateVirtualNode` 一份；认不出 ⇒ null） */
function virtualDisplayNode(state, id) {
    const hit = locateVirtualNode(state, id);
    return hit ? getVirtualDisplayNode(state, hit.pageId, id) : null;
}
