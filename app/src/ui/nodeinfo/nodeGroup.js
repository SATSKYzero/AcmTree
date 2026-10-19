// ================================================================
// 节点详页 →「🔗 所在组」（ui/nodeinfo/nodeGroup.js）
//
// 回答两件事：
//   · 这个节点**属于哪一个合成组**、组里**还有谁**；
//   · 点名单里任意一个（或组头），**跳到它在树上的位置**。
//
// 数据全部来自既有的唯一一份：`core/dedup.js` 的 `synthGroups(state)`
// （组 = 有 `synthKey` 的节点；成员 = `ownerSynth === 那个组` 的**原料**）
// 与 `isSynthesisNode()`。**不新增字段、不新增语义。**
//
// ⚠️ 本文件是**纯的**（只出 HTML 字符串，不碰 document）—— 和 `sourcePanel.js` /
//    `sourceActions.js` 同一套分工：动作与委托监听在 `nodeGroupActions.js`。
//    这样 `renderNodeGroupHtml` 能在纯 Node 里单测。
//
// ⚠️ 一个原料**同时只属于一个组**（`ownerSynth` 是单值）—— "一个原料挂多个 ownerSynth"
//    那条还没做，所以这里按**单组**渲染。
// ⚠️ `ownerSynth` 指向一个**不存在的组**时是"悬空指针"：那是 `core/ops/synth.js` 的
//    `findDanglingOwners` / `clearDanglingOwners` 管的事，这里只**如实说**、不修数据。
// ================================================================
import { escapeHtml } from '../../utils/html.js';
import { synthGroups, isSynthesisNode, SYNTH_KEY_FIELD, OWNER_FIELD } from '../../core/dedup.js';
// ★ 「这个 id 能不能跳 / 跳到哪个主树节点」只有一份判据（`mainTreeNodeIdOf`：
//   `realNodeIdOf` 解析 + 要求 `state.nodes` 里真有）—— 入口条那边用的是同一份
import { mainTreeNodeIdOf, locateVirtualNode, nodeAncestorsOf } from '../../core/ops/page.js';
// 祖先链**唯一入口** `nodeAncestorsOf`（按归属分流到主树 / 页内两棵树，各只有一份实现）——
// 本文件只把它取名字（G10：这里以前手写了一份 `parentOf` 循环）
// ⚠️ `CONFIRM_FIELD`（「已确认」）与产包侧读的是**同一个**字段名（唯一定义在 `core/synthPlan.js`）——
//    这里不写中文字面量，免得两边哪天分叉。
//    「这一场的题目组」也按**键**算（`confirmedProblemKeys`，core/ops/synth.js）：键是纯函数。
import { extTreeOf, CONFIRM_FIELD, KEY_PREFIX, PROBLEM_SYNTH_PREFIX } from '../../core/synthPlan.js';
import { confirmedProblemKeys } from '../../core/ops/synth.js';

/**
 * 「🔎 跳到树上」这一格**该指向谁**（纯函数，好自检 —— 副页那个坑就靠它钉住）。
 *
 * 副页节点拿到的是**页内虚拟 id**（`v_xxx`），主视图里根本没有它 ⇒ 必须解析成
 * 它引用的**真实节点**，并确认树上真有（`mainTreeNodeIdOf`，那一份判据是唯一的 ——
 * `ui/kit/nodeEntry.js` 的入口条与插件 ContestOverview 注入的 `jumpId` 都走它）。
 * 副页**根节点**不引用真实节点（它代表那一页本身）⇒ 没得跳，这一格不出现。
 *
 * @returns {{id:string, canJump:boolean, label:string}}
 */
export function jumpTargetOf(state, nodeId, isVirtual) {
    const id = String(nodeId || '').trim();
    if (!id) return { id: '', canJump: false, label: '' };
    const realId = mainTreeNodeIdOf(state, id);
    if (!realId || (isVirtual && realId === id)) return { id: '', canJump: false, label: '' };
    return {
        id: realId,
        canJump: true,
        label: isVirtual ? '🔎 跳到它引用的主节点' : '🔎 跳到树上'
    };
}

/**
 * 它在哪棵树上：`extKey` 的第一段（`aux-xcpcio:c:x` → `aux-xcpcio`、`qoj:c:1` → `qoj`）。
 *
 * 判据与 `utils/similarity.js` 判"是不是同一棵树"**同一套**（都只看第一段）。
 * 合成节点没有 `extKey`，就用它的合成标识（那本来就是"组"的身份）。
 */
export function treeTagOf(node) {
    const tree = extTreeOf(node);                 // 判据在 `core/synthPlan.js`（"只看第一段"只有一份）
    if (tree) return tree;
    const sk = String((node && node[SYNTH_KEY_FIELD]) || '').trim();
    return sk ? `组 ${sk}` : '';
}

/**
 * 把方框 HTML 里**与树上那一个重名**的接线摘掉：`id="node-<id>"` 与 `.node-box` 上的 `data-id`。
 *
 * 为什么必须摘（不是洁癖）：
 *   · `id` 重复 ⇒ `document.getElementById('node-x')` 可能拿到**详页里这一份**，
 *     `view/helpers.js` 的 `isNodeRendered()` 就会误判"已经在树上画出来了"；
 *   · `data-id` ⇐ `ui/revealNode.js` 的 `findNodeBox()` 用 `document.querySelector` 取**第一个**
 *     ⇒ 它会滚到详页里这一份、而不是树上的那一份，"点框跳过去"当场失灵。
 * 摘掉之后方框就只剩外观：跳转由外面那层 `data-reveal-node` 负责（**跳树只有这一条路**）。
 */
export function stripTreeWiring(html) {
    return String(html || '')
        .replace(/\sid="node-[^"]*"/g, '')
        .replace(/(class="[^"]*\bnode-box\b[^"]*")\s+data-id="[^"]*"/g, '$1');
}

/** 这一行在组里的身份：组头 / 原料，是不是正在看的这个节点 */
function roleTagOf(id, selfId, headId) {
    const parts = [id === headId ? '组头' : '原料'];
    if (id === selfId) parts.push('本节点');
    return parts.join(' · ');
}

/**
 * **只读面包屑**：从根一路到**这个节点的父**（不含自己）的名字串。
 *
 * 祖先链的真源**只有一个入口**：`core/ops/page.js:nodeAncestorsOf`（按归属分流：主树 id ⇒
 * `getAncestorsRootFirst` 走 `parentOf`；页内 id ⇒ `virtualAncestorsOf` 走 `virtualIndex[*].parentId`）
 * —— 这里只负责把名字取出来（**薄包装**；G10：以前这里手写了一遍 `parentOf` 循环）。
 * **纯函数** ⇒ 能在纯 Node 里单测。
 *
 * @returns {Array<{id:string, name:string}>} 由根到父
 */
export function breadcrumbOf(state, nodeId) {
    return nodeAncestorsOf(state, nodeId).map((n) => {
        // ⚠️ 名字**不能只读 `n.name`**：应用侧很多节点的显示名在 `values.name[0].v` 里
        //    （实测踩到：面包屑里好几段显示成「（未命名）」，而树上明明有名字）。
        const raw = n.name !== undefined && String(n.name).trim()
            ? n.name
            : ((n.values && n.values.name && n.values.name[0] && n.values.name[0].v) || '');
        const name = String(raw || '').trim();
        if (name) return { id: n.id, name };
        // ★ **根节点（`type === 'O'`）在库里本来就没有名字**（`core/model/state.js:createInitialState`
        //   建它时只给类型）—— 以前这里一律印「（未命名）」，于是**同一个节点两处两个名字**：
        //   文件夹导航 / 副页面包屑 / 树上都叫它「🏠 根目录」，只有这条链叫它「（未命名）」。
        //   用户 2026-10-15 看着列表那一格："这个面包屑 **前两节好像不存在**啊"——第二节就是它。
        //   ⚠️ 只在**真的没有名字**时兜底；别的空名节点（数据里确实无名的）照旧「（未命名）」，不编。
        if (n.type === 'O') return { id: n.id, name: '🏠 根目录' };
        return { id: n.id, name: '（未命名）' };
    });
}

/**
 * 面包屑的 HTML —— **一个入口，内部分支**（用户 2026-10-13 拍板：主副页合并成同一个函数）：
 *   · **主树节点**（`!node._virtual`）：**来源树 + 祖先路径**，每段 `data-reveal-node=<主树 id>`；
 *   · **副页（页内）节点**（`node._virtual`）：`📄 页名` 前缀 + **页内**祖先路径，
 *     每段 `data-reveal-node=<页内 id>`（`revealNode` 按归属分流 ⇒ 切到那一页再页内定位）。
 *
 * ⚠️ **判据是归属（`node._virtual` / `locateVirtualNode`），调用方不再自己挑函数**：
 *    页内 id（`v_xxx`）在主树的 `state.parentOf` 里根本不存在 ⇒ 拿主树那条链去渲染只会印
 *    「（就在根下）」这种**假话**（`nodeInfoView.buildShell` 早为此用 `if (!isVirtual)` 挡住）。
 *    两套 HTML / 类名（`nig-crumb` ↔ `vnode-crumb`）**逐字未改**，只是收进同一个函数。
 *
 * 主树那一支：
 * - **来源树**那一段 = `treeTagOf(node)`（`extKey` 第一段，与"哪棵树"同一口径）——
 *   它**不在** `parentOf` 链上（那是"记录从哪来"，不是树上的父）；
 *   ⚠️ **它不是节点**（实测：`cf:c:2269:p:A` 那条链的 `cf` 就是 W 节点「Codeforces」的 extKey，
 *   与链上第三段**同一个东西**）⇒ 要"只画树上真实那条路径"的地方传 `{ treeTag: false }`
 *   （`ui/kit/nodeEntry.js` 的入口条就这么用：那一格左边已经有**身份键**了，标签就在里面）。
 * - **祖先路径** = `breadcrumbOf()`（根那一段没有名字时印「🏠 根目录」——它本来就是根节点）；
 *   太长的**省略中间**（保留最前 1 段 + 最后 3 段），否则 qoj 那种深链（分类好几层）会把整行撑爆。
 *
 * ⚠️ 主树那一支渲染出来的位置**只有一个**：节点详页的**头部**（`nodeInfoView.buildShell`）——
 *    每个子视图都看得到"正在看的这个节点在树上哪"（本文件是纯的 ⇒ 这段判据能在纯 Node 里单测）。
 *
 * 副页那一支**不画**的两种情形（判据写死在这里，调用方别各判一遍）：
 *   · 页内**根**节点（`type === 'O'`）：它就是这一页本身，印一条只有自己的链没有意义；
 *   · 归属解析不出 / 祖先链断开：宁可没有，也不印"（就在根下）"那种假链。
 *
 * @param {Object} state - `AppState`
 * @param {Object} node  - 节点（真实节点，或副页展示节点 `_virtual`、`id` 是**页内 id**）
 * @param {{includeSelf?:boolean, color?:string, treeTag?:boolean, flat?:boolean}} [opts]
 *        `includeSelf`：**把节点自己也作为最后一段**（用户 2026-10-15："不要缺一级"）；
 *        `color`：整条（含分隔符与每一段）用这个颜色 —— 紧凑清单里要求"**全蓝**"；
 *        `treeTag`：要不要**来源树**那一段（缺省 `true` = 老行为，详页头部那条不变）；
 *        传 `false` ⇒ 只画**树上真实那条路径**（列表那种"每一段都得是个节点"的地方用它）；
 *        `flat`：**不套外层那个 11px / line-height 1.6 的 div**，只给「段 › 段 › 段」
 *        （要与宿主同一套字号行高的地方用 —— 表格里的入口条；`color` 由调用方那层给）。
 *        ⚠️ 四个都是**可选**且缺省 = 老行为。
 * @returns {string} HTML；副页那一支不该画时返回**空串**
 */
export function breadcrumbHtml(state, node, opts = {}) {
    const id = String((node && node.id) || '');
    const includeSelf = !!opts.includeSelf;
    const includeTag = opts.treeTag !== false;
    const color = String(opts.color || '');
    const sep = color
        ? ` <span style="color:${color};">›</span> `
        : ' <span style="color:#cbd5e1;">›</span> ';
    const selfName = String((node && (node.name || node.problemId)) || id);

    // ★ `flat`（用户 2026-10-15："能不能**全部垂直居中**，别微调了"）：不套外层那个
    //   `<div style="font-size:11px;line-height:1.6;margin-top:1px">`，只返回「段 › 段 › 段」——
    //   给**要跟宿主同一套字号/行高**的地方（表格里的入口条：套了那层就比同行别的格矮/高 1~2px，
    //   而 flex 居中对的是**各自的行盒**，行盒不一样高就永远差一点）。
    //   ⚠️ 颜色改由调用方那层给（段自己没有 color），分隔符仍按 `color` 上色。
    const wrapFlat = (html, cls) => (opts.flat ? html : '<div class="' + cls + '" style="font-size:11px;color:'
        + (color || '#94a3b8') + ';line-height:1.6;word-break:break-all;margin-top:1px;">' + html + '</div>');

    // ---- 副页（页内 id）：走 `nodeAncestorsOf` 分流出来的**页内**链 ----
    if (node && node._virtual) {
        const hit = locateVirtualNode(state, id);
        if (!hit) return '';
        if (hit.vNode && hit.vNode.type === 'O') return '';
        const trail = nodeAncestorsOf(state, id);
        if (!trail.length) return '';
        const page = (state && state.pages && state.pages[hit.pageId]) || {};
        const parts = [];
        const pageLabel = String(page.name || '').trim();
        // 前缀写明"这是哪一页"——与副页目录导航面包屑的 `📄 页名` 同一形状（免得与主树那条认错）
        if (pageLabel) parts.push(`<span>${escapeHtml(`📄 ${pageLabel}`)}</span>`);
        const shown = clampMiddle(trail);
        for (const v of shown) {
            parts.push(v.id
                ? `<span class="vnode-crumb" data-reveal-node="${escapeHtml(v.id)}" `
                  + 'style="cursor:pointer;text-decoration:underline dotted;">'
                  + escapeHtml(vNodeNameOf(state, v)) + '</span>'
                : `<span>${escapeHtml(vNodeNameOf(state, v))}</span>`);
        }
        // ★ 最后一段 = **节点自己**（`includeSelf`）——用户 2026-10-15："不要缺一级"
        if (includeSelf) parts.push(`<span class="crumb-self">${escapeHtml(selfName)}</span>`);
        return wrapFlat(parts.join(sep), 'vnode-crumb');
    }

    // ---- 主树：来源树 + 祖先路径（行为与类名逐字未变）----
    const trail = breadcrumbOf(state, id);
    const tag = treeTagOf(node);
    const parts = [];
    if (includeTag && tag && !tag.startsWith('组 ')) parts.push(`<span>${escapeHtml(tag)}</span>`);
    const shown = clampMiddle(trail);
    for (const c of shown) {
        parts.push(c.id
            ? `<span class="nig-crumb" data-reveal-node="${escapeHtml(c.id)}" `
              + 'style="cursor:pointer;text-decoration:underline dotted;">' + escapeHtml(c.name) + '</span>'
            : `<span>${escapeHtml(c.name)}</span>`);
    }
    if (!parts.length) parts.push('<span>（就在根下）</span>');
    if (includeSelf) parts.push(`<span class="crumb-self">${escapeHtml(selfName)}</span>`);
    return wrapFlat(parts.join(sep), 'nig-crumb');
}

/**
 * 太长省略中间：保留最前 1 段 + 最后 3 段（主树 / 页内**同一条规则**，两处本来逐字一样）。
 * @param {Array<{id:string}>} trail
 */
function clampMiddle(trail) {
    const max = 5;
    return trail.length <= max ? trail
        : [trail[0], { id: '', name: '…' },
           trail[trail.length - 3], trail[trail.length - 2], trail[trail.length - 1]];
}

/**
 * 一个**页内**虚拟节点在这条链里叫什么（纯展示：只取名字，不改任何状态）。
 *
 * ⚠️ 不共用 `ui/folder/virtualFolderMode.js:rebuildVirtualPath` 那个 `getDisplayName`：
 *    那一份是**目录导航**（点一段 = 进那个文件夹），这里是**只读祖先链**（点一段 = 跳到那一层），
 *    两份语义不同（见 `docs/node-navigation.md` §2.5）。
 */
function vNodeNameOf(state, vNode) {
    if (!vNode) return '（未命名）';
    if (vNode.type === 'O') return '🏠 根目录';
    const refId = String(vNode.refId || '');
    const real = (refId && state && state.nodes) ? state.nodes[refId] : null;
    // 与 `breadcrumbOf` 同一口径：名字可能在 `values.name[0].v` 里（实测踩过"满屏（未命名）"）
    const fromValues = real && real.values && real.values.name && real.values.name[0]
        ? real.values.name[0].v : '';
    const raw = (real && real.name) || fromValues || vNode.id || '';
    return String(raw).trim() || '（未命名）';
}

/**
 * 一行 = **只读节点框**（**点框可跳转**）。
 *
 * 方框由调用方注入（`renderBox(node)`）：真正那一套渲染在 `view/renderers.js`，
 * 它拉进 immer ⇒ 纯 Node 里 import 不了，注入进来才保得住本文件的"能在单测里跑"。
 */
function nodeRow(node, renderBox, headId, selfId, state) {
    const id = String((node && node.id) || '');
    const tag = treeTagOf(node);
    const isHead = id === headId;
    // ★ 一条 = **一张卡片** ——
    //   左边一条**竖色条**（组头蓝、原料灰）+ **角色标签提到框上面**当小标题 +
    //   条目之间**虚线分隔**。角色那行夹在框和面包屑中间时，一眼看不出条目从哪开始。
    return '<div class="nig-row" style="margin:0 0 12px;padding:2px 0 10px 10px;'
        + `border-left:3px solid ${isHead ? '#0ea5e9' : '#cbd5e1'};border-bottom:1px dashed #e2e8f0;">`
        + `<div class="nig-role" style="font-size:11px;font-weight:600;margin-bottom:4px;`
        + `color:${isHead ? '#0284c7' : '#64748b'};">`
        + escapeHtml(roleTagOf(id, selfId, headId))
        + (tag ? ` <span style="font-weight:400;color:#94a3b8;">· ${escapeHtml(tag)}</span>` : '')
        + ' <span style="font-weight:400;color:#cbd5e1;">· 点框跳过去</span></div>'
        + `<div class="nig-box" data-reveal-node="${escapeHtml(id)}" style="cursor:pointer;" `
        + 'title="点一下跳到它在树上的位置">'
        + stripTreeWiring(renderBox(node)) + '</div>'
        // ★ **每一行都带 id + 「📋 打开详页」**（"每个节点+id，打开详页按钮"）：
        //   · id 直接显示（排查/对照时靠它认人，方框上只有名字）；
        //   · 按钮就是树上那个 📋 —— **同一套接线**（class `btn-node-info` + `data-id`，
        //     由 `ui/G_events.js` 的文档级委托接住 `openNodeInfoTab`）⇒ 这里不另写跳转。
        + '<div class="nig-meta" style="font-size:11px;color:#94a3b8;margin-top:3px;display:flex;'
        + 'align-items:center;gap:8px;flex-wrap:wrap;">'
        // ⚠️ id 那一段要能**自己折行**（`min-width:0` + `word-break`）：节点 id 很长
        //    （`n_1880056_muy3glyl`），而 flex 项默认 `min-width:auto` ⇒ 它不肯收缩，
        //    于是**按钮被挤成一列字**（实测踩到：「打开详页」四个字竖着排）。
        + `<code style="font-size:11px;min-width:0;word-break:break-all;">${escapeHtml(id)}</code>`
        + `<button class="btn-icon btn-node-info" data-id="${escapeHtml(id)}"`
        + ' title="打开这个节点的详页（与树上那个 📋 是同一件事）"'
        // ⚠️ 按钮**不参与收缩、文字不折行**：宁可它整颗换到下一行（`flex-wrap:wrap`），
        //    也不许被压成竖排。
        + ' style="font-size:11px;padding:1px 8px;cursor:pointer;white-space:nowrap;'
        + 'flex:0 0 auto;">📋 打开详页</button>'
        + '</div>'
        // ★ **只读面包屑**（来源树 + 祖先路径，每段可点跳转）
        + (state ? breadcrumbHtml(state, node) : '')
        + '</div>';
}

/** **[组头, …所有原料]** 一起列（去重、保持给定顺序）—— 合成页与原料页用的是同一份 */
function groupRowsHtml(ids, nodes, renderBox, headId, selfId, state) {
    const seen = new Set();
    const rows = [];
    for (const id of ids || []) {
        const key = String(id || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const n = nodes[key];
        if (n) rows.push(nodeRow(n, renderBox, headId, selfId, state));
    }
    return rows.join('');
}

const HINT = 'color:#64748b;font-size:12px;line-height:1.7;';

/**
 * 「确认标记」那一行（**纯函数**，只出 HTML 字符串 —— 动作在 `nodeGroupActions.js`，
 * 同 `data-reveal-node` 的分工）。
 *
 * 为什么要有这一行：`已确认` 是**组级标记**（"人看过这一组、认为题名/绑定对"），
 * 它是随包走的人结论（产包侧 `problem-bind` 见到它就不再动这一组的题名）。
 * 打了标记之后要**撤销**，就得在**看得到这一组**的地方有个明确的动作 ——
 * 让人去字段表里手动改那一格是不行的：那不是"一次动作"，没有撤销的语义。
 *
 * ⚠️ **两个宿主、同一份判据、同一句话**（`confirmInfoHtml`）：组头页与原料页（"它归入的组"）
 *    都印 —— 原料页**不印**的话，人从"题"那一页点进来就是**一片空白**，看不出这一组确认没有
 *    （实测：用户连问两次"有确认的反而没东西""原料节点还是没有信息"）。
 *
 * 四种情形（键决定前两种还是后两种）：
 *   · **题目组**（`synth:problem:…`）⇒ 说这一组；打过 ⇒ `[取消确认标记]`；
 *   · **场次**（`synth:xcpc:…`）⇒ 说**这一场有几个**题目组已确认，打过 ⇒ `[取消这一场全部确认]`
 *     （人当初就是**按场**确认的：⑤ 那个按钮写的是「✓ 确认这一场」）；
 *   · 别的合成键 ⇒ 一个字都不出。
 *
 * @param {string} groupKey - 组的键（原料页传的是 `ownerSynth`，即**组头**的键）
 * @param {Object} headNode - 那一组的**组头节点**（不在树上 ⇒ `null`：只能报状态、给不出按钮）
 */
function confirmInfoHtml(groupKey, headNode, state) {
    const key = String(groupKey || '').trim();
    if (!key) return '';
    // ⚠️ 按钮打的是**组头的节点 id**（不是键）：动作那边按 id 找节点，再认它的 `synthKey`
    const id = escapeHtml(String((headNode && headNode.id) || ''));
    const marked = (r) => !!(r && (r[CONFIRM_FIELD] === true || r[CONFIRM_FIELD] === '是'));
    const HINT = 'font-size:12px;color:#94a3b8;line-height:1.9;margin-bottom:8px;';

    if (key.startsWith(PROBLEM_SYNTH_PREFIX)) {
        if (!marked(headNode)) {
            return `<div class="nig-confirm-hint" style="${HINT}">`
                + '这一组没有确认标记（在「判重整理 → ⑤」点那一场的「✓ 确认这一场」才会打上）。</div>';
        }
        return '<div class="nig-confirm-row" style="font-size:12px;color:#0f766e;line-height:1.9;margin-bottom:8px;">'
            + '✅ 这一组<b>已确认</b>（脚本不再动这一组的题名 / 绑定；这个标记随包走、重建不丢）'
            + (id
                ? `<button class="btn nig-unconfirm" data-unconfirm-head="${id}" `
                  + 'title="撤掉这一组的「已确认」标记 —— 不改任何绑定、也不删任何节点；'
                  + '重新建包后，脚本不再为这一组保住你手改的题名（题名会按来源重新算）" '
                  + 'style="margin-left:8px;font-size:11px;padding:0 6px;">取消确认标记</button>'
                : '')
            + '</div>';
    }

    if (!key.startsWith(KEY_PREFIX)) return '';
    const keys = confirmedProblemKeys(state, key);
    if (!keys.length) {
        return `<div class="nig-confirm-hint" style="${HINT}">`
            + '这一场没有已确认的题目组（在「判重整理 → ⑤」点「✓ 确认这一场」才会打上）。</div>';
    }
    return '<div class="nig-confirm-row" style="font-size:12px;color:#0f766e;line-height:1.9;margin-bottom:8px;">'
        + `✅ 这一场有 <b>${keys.length}</b> 个题目组<b>已确认</b>（脚本不再动它们的题名；`
        + '这个标记随包走、重建不丢）'
        + (id
            ? `<button class="btn nig-unconfirm" data-unconfirm-contest="${id}" `
              + 'title="把这一场所有题目组的「已确认」标记一次撤掉 —— 不改任何绑定、也不删任何节点；'
              + '重新建包后，脚本不再为它们保住你手改的题名" '
              + 'style="margin-left:8px;font-size:11px;padding:0 6px;">取消这一场全部确认</button>'
            : '')
        + '</div>';
}

/**
 * 「确认标记」那一行（**组头页与原料页共用**，纯函数、只出 HTML 字符串 —— 动作在
 * `nodeGroupActions.js`，同 `data-reveal-node` 的分工）。
 *
 * @param {string} groupKey - 组的键（组头页给组头自己的 `synthKey`；原料页给 `ownerSynth`）
 * @param {Object} headNode - 那一组的组头节点（组头页就是它自己）
 */
export function confirmRowHtml(groupKey, headNode, state) {
    return confirmInfoHtml(groupKey, headNode, state);
}

/**
 * 「所在组」的 HTML（**纯函数**，便于断言）。
 *
 * ⚠️ **合成节点页与原料节点页都列同一份东西：[组头合成节点 + 所有原料节点]**
 *    差别只在开头那句话说的是"它是组头"还是"它归入的组"——
 *    所以列表构造只有一份（`groupRowsHtml`），不分两套。
 *
 * 三种身份分别说清：
 *   · **合成节点**（组头）⇒ 列 [自己 + 所有原料]；
 *   · **原料**且属于某个组 ⇒ 列 [组头 + 所有原料（含自己）]；
 *   · **原料**但 `ownerSynth` 为空 / 指向不存在的组 ⇒ 照实说，并指到该去哪处理。
 *
 * @param {Object} node  - 节点（真实节点；副页虚拟节点的"组"属于它引用的真实节点）
 * @param {Object} state - `AppState`
 * @param {Function} renderBox - `(node) => 只读节点框 HTML`（**必传**，理由见 `nodeRow`）
 * @returns {string}
 */
export function renderNodeGroupHtml(node, state, renderBox) {
    if (!node) return '<div style="padding:12px 16px;color:#94a3b8;">(节点不存在)</div>';
    const groups = synthGroups(state);
    const byKey = new Map(groups.map(g => [g.key, g]));
    const key = String(node[SYNTH_KEY_FIELD] || '').trim();
    const owner = String(node[OWNER_FIELD] || '').trim();
    const nodes = (state && state.nodes) || {};

    const head = '<div style="font-size:12px;color:#64748b;font-weight:600;margin-bottom:6px;">'
        + '🔗 所在组</div>';
    // ⚠️ 「正在看的这个节点在树上哪」那条**面包屑不在这里** —— 它挂在**详页头部**
    //    （`nodeInfoView.buildShell`，每个子视图都看得到；渲染用的还是本文件这个纯函数）。
    //    这里只留「所在组」这一栏自己的标题。
    const wrap = body => `<div class="nodeinfo-group" style="padding:12px 16px;">${head}${body}</div>`;

    if (isSynthesisNode(node)) {
        const g = byKey.get(key) || null;
        if (!g || g.nodeId !== node.id) {
            return wrap(`<div style="${HINT}">它的合成标识 <code>${escapeHtml(key)}</code> `
                + '被另一个节点占用了（同一标识只能有一个组头）⇒ 这个组不完整，去「判重整理」看一眼。</div>');
        }
        const ids = [node.id].concat(g.memberIds || []);
        const rows = groupRowsHtml(ids, nodes, renderBox, node.id, node.id, state);
        return wrap(`<div style="${HINT}">它是这个组的<b>组头</b>（合成节点）。`
            + `下面是<b>组头 + 所有原料</b>（${ids.length} 个）：</div>`
            // ★ 组头那一行（打了标记给撤销入口；没打说明状态 —— 场次组头给的是"这一场全部撤销"）
            + confirmRowHtml(key, node, state)
            + (rows || `<div style="${HINT}">还没有任何原料归入它。</div>`)
            + (g.danglingCount
                ? `<div style="color:#b45309;font-size:12px;margin-top:6px;">⚠️ 另有 ${g.danglingCount} 条成员是<b>悬空指针</b>（指向的组不存在 / 类型对不上），去「判重整理」的悬空那一条处理。</div>`
                : ''));
    }

    if (!owner) {
        return wrap(`<div style="${HINT}">它是<b>原料</b>，没有归入任何合成组（<code>${escapeHtml(OWNER_FIELD)}</code> 为空）。<br>`
            + '要归入，去「判重整理」页把它归到某个组（或与另一条一起新建一个组）。</div>');
    }

    const g = byKey.get(owner) || null;
    if (!g) {
        return wrap(`<div style="${HINT}">它写着归属于 <code>${escapeHtml(owner)}</code>，但那个组不存在`
            + '（悬空指针）。<br>去「判重整理」页用悬空那一条一键清理，或把它归到一个真的组上。</div>');
    }

    const ids = [g.nodeId].concat(g.memberIds || []);
    // ★ **原料页也报这一组的确认状态**（与组头页同一句话、同一个按钮）——
    //   人是从"题"那一页看这一组的：不印的话那一栏就是一片空白，看不出这一组确认没有
    //   （实测：用户 2026-10-08 连问两次"有确认的反而没东西""原料节点还是没有信息"）。
    return wrap(`<div style="${HINT}">它归入的组（<b>组头 + 所有原料</b>，${ids.length} 个）：</div>`
        + confirmRowHtml(owner, nodes[g.nodeId] || null, state)
        + groupRowsHtml(ids, nodes, renderBox, g.nodeId, node.id, state));
}

/**
 * 跳到某个节点在树上的位置。
 *
 * ⚠️ **跳树只有这一条路**：派发 `EVENTS.REVEAL_NODE`，由 `ui/revealNode.js` 负责
 * 切分页 / 切显示模式 / 展开祖先 / 翻页 / 滚动高亮。这里不自己写展开逻辑
 * （也不 import `ui/tabs.js`，免得和 `tabs → nodeInfoView` 绕成环）。
 *
 * ⚠️ 本文件是纯的 ⇒ 这个函数住在 `nodeGroupActions.js`，那里才 import。
 */
