# 节点导航：节点方框 / 节点行的入口盘点与统一方案

> **给谁看**：要动"点一下节点跳到主树 / 加面包屑 / 加详情入口 / 加复制键"这类需求的人（含下一个会话的我）。
> **什么时候读**：① 给某个页面加"跳转 / 面包屑 / 详情 / 复制"入口之前；② 想在别处再写一份"跳到树上"的
> 接线之前（**先读第 2 节：仓里已经有两套，别再造第三套**）；③ 排查"点了没反应 / 跳到了看不见的地方"时。
>
> **这份文档是一张施工图**：第 3 节是盘点表（谁在画节点方框/节点行、点了会怎样），
> 第 4 节是缺口（逐条点名），第 5 节是一个统一方案，第 6 节是建议做/不做的功能与成本。
> ⚠️ 表里**刻意不写条数与"现在有多少处"这类数字**（会漂）——只写"在哪个文件哪个函数、行为是什么"，
> 数字要用时**自己跑第 1 节的命令数**。
>
> **改动横跨 `src/view/` + `src/ui/` + `src/features/`**：`src/view/`（`renderers.js` / `helpers.js` /
> `viewRenderers.js`）才是"画方框"的主战场，但**那个目录没有就地 `AGENTS.md`**
> （在 `scripts/areas.mjs` 的 `AREA_DEFERRED` 里，理由写的是"口径薄"）。
> ⇒ 本次笔记落在 `src/ui/AGENTS.md`（已经在那边加了指针），**不擅自改 `areas.mjs` 的分类**。

---

## 1. 怎么找全的（可重跑，别靠记性）

盘点靠"符号穷举"而不是"看着像"，下面每条都能直接重跑（在原仓库根执行）：

| 找什么 | 命令（PowerShell） |
|---|---|
| **谁在产出节点方框 HTML** | `Select-String -Path src\view\*.js,src\ui\*\*.js,src\features\*\*.js -Pattern "renderNode\(|renderNodeBox"` |
| **谁是方框的 DOM 契约**（`class="node-box"` + `data-id`） | `Select-String -Path src -Pattern "node-box" -Recurse` |
| **已有的"跳树"入口** | `Select-String -Path src -Pattern "REVEAL_NODE\|revealNode\|markGoto\|wireGotoLinks\|data-reveal-node\|data-goto" -Recurse` |
| **点得动的地方**（委托/直接监听/内联属性） | `Select-String -Path src -Pattern "addEventListener\('click'\|onclick=" -Recurse` |
| **面包屑** | `Select-String -Path . -Pattern "breadcrumb" -Recurse`（`index.html` 那个 `#folder-breadcrumb` 容器是关键锚点） |
| **祖先链** | `Select-String -Path src -Pattern "getAncestors\|parentOf\[" -Recurse` |
| **详情入口** | `Select-String -Path src -Pattern "openNodeInfoTab\|btn-node-info" -Recurse` |
| **副页投影** | `Select-String -Path src -Pattern "_virtual\|_refId\|realNodeIdOf" -Recurse` |

判据（这三条交叉一遍才算找全）：
1. **凡是 `view/helpers.js:renderNodeBox()` 产出的 HTML，都带 `class="node-box"` 与 `data-id`** ——
   所以"`node-box` 出现在哪"就是"方框出现在哪"的**唯一一份**清单（除了 `nodeGroup.js` 的
   `stripTreeWiring()` 会**故意摘掉** `data-id`）。
2. **凡是要"跳到树上"的地方，最终都必须落到 `EVENTS.REVEAL_NODE`**（唯一实现 `ui/revealNode.js`）——
   grep 不到 `REVEAL_NODE` 又确实在跳树的，就是自造的第二份。
3. **凡是要"打开详页"的地方，最终都必须落到 `openNodeInfoTab`**（`ui/tabs.js`），由
   `G_events.js` 的文档级委托按 `.btn-node-info[data-id]` 接住。

---

## 2. 现成入口（唯一一份的那些）

### 2.1 `ui/revealNode.js` —— 跳转/定位的**家**

- **对外能力**：`revealNode(nodeId) → Promise<boolean>`；事件 `EVENTS.REVEAL_NODE`（`A_constants.js`），
  由 `setupRevealNodeEvents()` 注册（**只被 `ui/eventBridge.js:registerAllEvents()` 调用一次**）。
- **契约（这是重点，写代码前照抄）**：
  - 入参**两种都认**（`v9.0.17` 起），按**归属**分叉，判据只有一份（`core/ops/page.js:locateVirtualNode`）：
    · **主树真实 id**（`AppState.nodes` 里有）⇒ 切回主页面 + 主树定位（老行为）；
    · **副页页内 id**（`v_xxx`，只在某个 `state.pages[pageId].virtualIndex` 里）⇒ **切到它所属的那个副页**，
      再在那一页里定位（进页内文件夹 / 展开页内祖先 / 翻到它那一页 / 滚动高亮）。
    ⚠️ 顺序是"**先主树、再副页**"，与 `findNodeBox` 的搜索顺序**同序**：同名时主树赢
    （反过来写会让"副页里恰好有个同名 vNode"把本该跳主树的定位劫持走）。
  - 它做的事**全包**：切一级 tab（`switchTab('main')`）→ 切页面（派发 `EVENTS.SWITCH_PAGE`，并
    **等 `AppState.currentPageId` 真的变成目标页**，不是干等固定毫秒）→ 按显示模式
    （`getTreeDisplayMode()`）分别 `revealInFolderMode` / `revealInTreeMode`（副页则是对应的两支
    虚拟版）→ 滚动 + 高亮。
  - **高亮靠"轮询式看护"而不是给元素设一次 inline 样式**（`watchHighlight`）：因为重画会**替换 DOM 元素**，
    folder 模式会连着重渲染两次。⇒ 后来加功能时**别改成"设一次 outline"**，那正是文件头记着的病根。
  - folder 模式的**精确页码**用 `view/dataAdapter.js:getDisplayData()` 的那份 `nodes` 算
    （`exactFolderPageOf` / `exactVirtualFolderPageOf`），拿 `childOrder` 猜页只是兜底。⇒ 别在别处再算一套"第几页"。
  - **副页那一半的页内导航动作全部复用现成的**：`ui/folder/virtualFolderMode.js` 的 `enterVirtualFolder` /
    `goToVirtualRoot` / `getVirtualState`（页内视图态），页内展开/翻页走 `core/ops/view.js` 的
    `setVirtualNodeExpanded` / `setVirtualNodeCurrentPage`（页内 `expanded/currentPage` 在
    `state.pages[pageId].virtualIndex[v]` 上，**不在** `state.view`）。**别在这里再写一套页内导航。**
    ⚠️ 只在**真要切**时才切：那两个入口各自会派发一次整页重画，白画一遍会让 DOM 被换掉
    （判据：已在正确位置时只滚动 + 高亮，方框不被替换）。
- **谁能用**：任何模块**都能**（只要它在 `document` 上派发事件）。**插件（`src/features/`）不该 import `ui/`**
  （见 `src/features/AGENTS.md` 的不变量），所以插件只能派发事件。
- **副页节点怎么办**：`revealNode` **两种 id 都认**（见上）。入口那一侧要不要给"蓝字/🔎"，
  判据各有唯一一份：**副页页内 id** ⇒ `locateVirtualNode`（页内根 `type === 'O'` 除外 —— 那一页不画它的方框）；
  **跳主树** ⇒ `mainTreeNodeIdOf`（`realNodeIdOf` 解析 + 要求树上真有）。
- **已知的精度缺陷（`v9.0.13` 已修）**：`findNodeBox()` 以前用 `document.querySelector(...)` 取**第一个**，
  而 `.node-box[data-id]` 在别处也存在（见缺口 G11）⇒ 会滚到看不见的副本上还报成功。
  现在只查主视图那两格（`#tree-body` / `#folder-stats`），且不在主页面时直接放弃（如实返回 false）；
  `v9.0.17` 起把这两格**复用**给副页（副页的方框也画在同一对容器里），所以判据从"在不在主页面"
  变成"**这个 id 属不属于目标那一页**"。

### 2.2 `EVENTS.REVEAL_NODE` —— 谁派发、谁监听

| 角色 | 位置 |
|---|---|
| **唯一监听** | `ui/revealNode.js:setupRevealNodeEvents()`（由 `ui/eventBridge.js:registerAllEvents()` 装配） |
| **唯一"派发那一句"** | `ui/kit/actions.js:revealNodeById()`（`nodeGroupActions` / `wireGotoLinks` 都转发到它） |
| 派发（检索-题目） | `features/ProblemSearch/index.js`（结果行 `tr` 的 click） |
| 派发（检索-比赛） | `features/ContestSearch/view.js`（同上形状） |
| 派发（判重整理全页） | `ui/dedup/kit.js:wireGotoLinks()`（**薄兼容**：页面根一条，转发给 `revealNodeById`） |
| 派发（自动导入-指针异常） | `features/AutoImport/ui/summary.js:appendPointerIssues()`（只写 `data-reveal-node`，靠**文档级**那条接住） |
| 派发（节点详页/所在组） | `ui/nodeinfo/nodeGroupActions.js`（**文档级** `data-reveal-node` 委托，转发给 `revealNodeById()`） |
| 便捷壳 | `features/AutoImport/index.js` 的 `revealNode()` / `revealNodeByExtKey()`（按身份键找节点再派发） |
| 便捷壳（ui 侧） | `ui/kit/nodeEntry.js:nodeEntryLine()`（🔎 + 📋 + 面包屑，给非主树的节点行用；**只组合现成那三份**）；⚠️ **主树 / 副页两种节点都认**（`v9.0.19` 起）：主树 ⇒ 真实 id + `breadcrumbHtml`；副页 ⇒ **页内 id** + 同一个 `breadcrumbHtml` 的**页内分支**（见 2.5） |

⚠️ **同一句"跳到树上"的接线已经收敛（v9.0.13）**：承载 = `data-reveal-node`（`markGoto` 唯一一份），
委托 = `nodeGroupActions.js` 的**文档级**那一条；`data-goto` / `dedup-goto` / `wireGotoLinks` 只是**薄兼容**
（判重页冒烟按它们断言）。**新增入口一律用 `data-reveal-node`，不要再派生第三种。**

### 2.3 `data-reveal-node` + `ui/nodeinfo/nodeGroupActions.js`（**推荐**）

- 任何元素带 `data-reveal-node="<主树节点 id>"`，就会被 `nodeGroupActions.js` 里那条
  **文档级** click 委托接住（`preventDefault` + `revealNodeById`）。**不需要调用方挂任何监听。**
- 已有使用者：`ui/nodeinfo/nodeGroup.js`（`breadcrumbHtml()`、`nodeRow()`）、
  `ui/nodeinfo/nodeInfoView.js`（`buildShell()` 的「🔎 跳到树上」）、`features/AutoImport/ui/summary.js`、
  `features/AutoImport/extKeyPanel.js`（每行 🔎）、`features/ContestOverview/render.js`（点/题号/比赛名）、
  `ui/dedup/*`（经 `markGoto`）、`ui/kit/nodeEntry.js`（🔎 + 📋 + 面包屑的组合件）。
- 这是**跨页面最省事的一份** —— 数据统计 / 检索 / 判重 / 概览都该用它（**插件也能用**：它只是属性，
  委托是全局的，插件什么都不用挂）。

### 2.4 `markGoto` / `wireGotoLinks`（判重页那套，现已退成**薄兼容**）

- 实现：`ui/kit/actions.js:markGoto(el, nodeId, color, title)`（**唯一一份**承载；`ui/dedup/kit.js` 只是
  `export { markGoto, runWrite, revealNodeById } from '../kit/actions.js'` 的**原样再导出**）。
  它给元素挂 **`data-reveal-node`（承载）**，并**保留** `class="dedup-goto"` + `data-goto="<id>"`（兼容钩子：
  判重页的冒烟按它们断言 —— 用户拍板**不动那份断言**），再加 `title`、`cursor:pointer`。
  ⚠️ `title` 默认是"在树上定位这个节点"（`v9.0.19` 起可传第 4 个参数）：**副页页内定位要传自己的**
  （提示与实际行为必须一致 —— 页内定位说成"树上"就是假话，但**别为此另写一个挂载函数**）。
- 委托：`ui/dedup/kit.js:wireGotoLinks(root)` —— **在 `ui/dedup/dedupPage.js` 里对判重页根挂一次**。
  它现在**只转发**（转发到 `revealNodeById`，唯一那句派发），留着是因为 ③ 的行是 `<label>`
  （点名字必须 `preventDefault` 才不会被顺带勾上勾选框）以及老的 `data-goto` 标记还要能点；
  它必须 `stopPropagation` —— 不拦会同一次点击**再冒泡到 document** 上那条文档级委托 ⇒ 派发两颗。
- ⇒ 新页面**不要**再用 `markGoto`+`wireGotoLinks` 这套（那要自己挂委托）：直接用 `data-reveal-node`
  （`markGoto` 挂属性即可，委托是**文档级**的，插件也白拿）。
- ⚠️ `dedup-goto` / `data-goto` 是**行为钩子**（兼容委托按它找、冒烟按它断言）—— 别删，
  也别把它们当新代码的约定。

### 2.5 面包屑（**目录导航两份 + 节点祖先链一份**；节点那两份已合成一个入口）

| 哪一份 | 位置 | 语义 | 落在哪个容器 |
|---|---|---|---|
| **文件夹导航面包屑** | `ui/folder/folderMode.js:renderFolderBreadcrumb()` + `ui/folder/folderShared.js:buildBreadcrumbHTML()/bindBreadcrumbEvents()` | "我现在在哪个**目录**里"，点一段 = **进那个文件夹**（`enterFolder` / `goToRootFolder`），不是 `revealNode` | `index.html` 的 `#folder-breadcrumb` |
| **副页（虚拟）面包屑** | `ui/folder/virtualFolderMode.js:renderVirtualBreadcrumb()`（复用同一份 `buildBreadcrumbHTML`） | 同上，但走**页内 id**（`state.path` / `virtualIndex`），带 `prefixLabel = 📄 页名` | **同一个** `#folder-breadcrumb` |
| **节点祖先链面包屑**（只读，**一个入口、内部按归属分支**） | `ui/nodeinfo/nodeGroup.js:breadcrumbHtml(state, node, opts)`（纯函数、有单测） | 主树节点 ⇒ "这个**节点**在树上哪"（来源树 + 根→父的路径；`{treeTag:false}` ⇒ 只画树上那条真实路径）；副页节点（`node._virtual`）⇒ "它在**那一页**的哪一层"（`📄 页名` + 根→父的**页内**路径）。点一段 = `data-reveal-node` 跳树 / 页内定位 | 节点详页头部（`nodeInfoView.buildShell`，**带**来源树）；非主树的节点行（`ui/kit/nodeEntry.js:nodeEntryLine`，**不带** —— 那一格左边已有身份键） |

- ⚠️ **主副页已合并成同一个 `breadcrumbHtml(state, node)`**（2026-10-13 合并，用户拍板：
  "这三样的函数应该主副页合并，函数内部根据主副页实现不同"）——调用方**不再自己挑函数**，
  函数内部按 `node._virtual` 分支：主树走 `parentOf` 链 + 来源树前缀（类 `nig-crumb`），
  副页走 `virtualIndex[*].parentId` 链 + `📄 页名` 前缀（类 `vnode-crumb`）。
  两套 HTML / 类名 / 属性**逐字未改**，只是收进一个函数。
- ⚠️ **副页那一支不能拿主树那条链去渲染**：页内 id（`v_xxx`）在 `state.parentOf` 里根本不存在
  ⇒ 硬渲染只会印"（就在根下）"这种假话（`nodeInfoView.buildShell` 早就用 `if (!isVirtual)` 挡住了）。
  页内祖先链的真源只有 `core/ops/page.js:virtualAncestorsOf`。

- `#folder-breadcrumb` 的显示/隐藏与清空由 **`ui/folder/folderShared.js:resetViewContainers()` /
  `applyFolderLayout()`** 统一管（树模式隐藏、folder 模式显示）。
- ⚠️ `nodeGroup.breadcrumbHtml()` 用 `escapeHtml` 且**每个可点段都带 `data-reveal-node`** —— 这是
  "别的地方要加节点面包屑"时**唯一该复用的渲染器**（纯函数、有单测 `src/test/nodeGroup.test.js`）；
  **主树 / 副页都由它内部分流**，别再按宿主各调一份。
- ⚠️ 它**不画**副页那两种（判据写死在函数里）：页内**根**（`type === 'O'`，它就是这一页本身）、
  归属解析不出 / 祖先链断开 ⇒ 返回**空串**（宁可没有，也不印假链）。
- ★ **那两段"看着不像节点"的**（用户 2026-10-15 指着列表那一格："这个面包屑 **前两节好像不存在**啊"）：
  拿真包（`acm-data/nodes/cf-contest.json`）走一遍就清楚了 —— `cf:c:2269:p:A` 那条链是
  `cf`（**W 节点「Codeforces」**，它的 extKey 就是 `cf`）→ `CF contest` → `2026` → 比赛 → 题，
  而界面上印出来的是 `cf › （未命名） › Codeforces › …`。两段各有各的病根：
  · **第一段不是节点**：它是 `treeTagOf(node)` 出来的**来源树标签**（= extKey 第一段），
    与链上那个 W 节点**是同一个东西** ⇒ 看着像"一个点不动的节点"。
    修法：`breadcrumbHtml(..., { treeTag: false })` —— **入口条**（`ui/kit/nodeEntry.js`）用它，
    因为那一格左边已经有**身份键**（标签就在键里）；**详页头部照旧带它**（缺省 `true` = 老行为）。
  · **第二段是应用自己造的根节点**：`core/model/state.js:createInitialState` 建 `type:'O'` 的根时
    **不给名字**，而文件夹导航 / 副页面包屑 / 树上都叫它「🏠 根目录」，只有这条链印「（未命名）」
    ⇒ 同一个节点两处两个名字。修法：`breadcrumbOf` 只在**真的没名字且 `type === 'O'`** 时兜底成
    「🏠 根目录」；数据里确实无名的普通节点照旧「（未命名）」（**不编**）。
  ⚠️ 别把这条"兜底"推广成"凡是空名都当成根"：`type === 'O'` 才是判据。

### 2.6 祖先链：入口 `core/ops/page.js:nodeAncestorsOf`（内部分流到主树 / 页内两棵树）

- **祖先链的唯一入口是 `core/ops/page.js:nodeAncestorsOf(state, id)`**（2026-10-13 合并时收的，
  用户"主副页合并、内部分支"那一条）：按**归属**分流 ——
  · 主树 id（`state.nodes` 里真有）⇒ `getAncestorsRootFirst(state, id)`（走 `parentOf`，返回**节点对象**）；
  · 别的（副页页内 id `v_xxx`）⇒ `virtualAncestorsOf(state, id)`（走 `virtualIndex[*].parentId`，返回 vNode）。
  顺序与 `ui/revealNode.js:revealNode` / `findNodeBox` 一致：**先主树、再副页**（同名时主树赢）。
- **两棵树的实现仍各自只有一份**（`nodeAncestorsOf` 只是分流，**不是第三份祖先链**）：
  `core/query/nodes.js:getAncestorsRootFirst`（根在前，`getAncestors` 是它的反序、只差顺序）
  与 `core/ops/page.js:virtualAncestorsOf`（`v9.0.19` 加，与 `locateVirtualNode` 同住）。
  数据源不同（`parentOf` ↔ `virtualIndex[*].parentId`）⇒ **别把两份实现合并成一份循环**
  （依赖方向：`core/ops` 引 `core/query` 可以，反过来会绕；`core/query/nodes.js` 本身零依赖）。
  ⚠️ **名字为什么带 `node` 前缀**：同一个 `core/ops/` 层里 `account.js` 已经有一个**同名不同义**的
  `ancestorsOf`（账户树的祖先，返回账户 id 字符串）⇒ 这里只能叫 `nodeAncestorsOf`。**别改名回去。**
  用的地方：`ui/revealNode.js`（主树展开 / 页内展开）、`ui/nodeinfo/nodeGroup.js:breadcrumbOf`。
- 容错：`state` 为 `null`、链断开、成环（深度上限 1000）都有兜底，见 `src/test/searchShared.test.js`
  （主树那条）与 `src/test/virtualLocate.test.js`（页内那条）。
- **检索页的归属读的是主树那一份**：`features/ProblemSearch/collect.js` 与 `features/ContestSearch/collect.js`
  都以 `getAncestorsRootFirst as collectAncestorChain` 导入（`src/test/contestSearch.test.js` 还钉了
  "就是 `core/query` 的那一个"）—— 两处只处理主树 id，**不改**。

### 2.7 切页 / 切 Tab / 副页 id 映射

| 能力 | 位置 | 契约 |
|---|---|---|
| 切一级 tab | `ui/tabs.js:switchTab(tabId)` | 不认识 / 相同 ⇒ 直接 return；会按需 `ensureTabContent` + 画页面内容 |
| 打开节点详页 | `ui/tabs.js:openNodeInfoTab(nodeId, {asVirtual, pageId, activate})` | **已经开着就只切过去**（不重复开）；`asVirtual` 时**故意不解析**成 `_refId`；非 `asVirtual` 时用 `realNodeIdOf` 解析；`activate:false`（`v9.0.18`）= 建页签但不切过去 |
| **"📋 点下去干什么"** | `ui/G_events.js:openInfoFromButton(btn, activate)` | **唯一一份**：带 `data-vid` ⇒ 先弹"看哪个"（`showInfoTargetSelector`）再 `openNodeInfoTab(..., {asVirtual, pageId})`；否则直接开。**两条既有委托**（文档级 `installNodeInfoDelegate` + 容器级 `onActionClick`）各转发到它 —— **别抄第二份**（`v9.0.19` 收的） |
| 关详页 | `ui/tabs.js:closeNodeInfoTab(tabId)` | 关掉的正是当前那个 ⇒ 回主视图 |
| 详页 tab 的 id | `ui/tabs.js:nodeInfoTabId(nodeId)` → `node-<nodeId>` | 与内置/插件页 id 不撞 |
| **副页 → 真实节点** | `core/ops/page.js:realNodeIdOf(state, id)` | **唯一一份**；`openNodeInfoTab` 与 `nodeGroup.jumpTargetOf` 都走它 |
| **"这个 id 能不能跳"** | `core/ops/page.js:mainTreeNodeIdOf(state, id)` | **唯一一份**判据 = `realNodeIdOf` 解析 **+ 要求 `state.nodes` 里真有**，否则 `''`。入口条、比赛概览注入的 `jumpId`、`jumpTargetOf` 三处共用（插件 import core 允许、import `ui/` 不允许 ⇒ 它只能住 core）。**别在各页自己写这一步** —— 少查一次 `state.nodes` 就会画出"点了没反应的假链接" |
| 副页投影字段 | `view/dataAdapter.js`（`buildSyntheticNode` / `buildVirtualNodeRealData`） | `_virtual / _virtualId / _refId / _pageId`；`getVirtualDisplayNode(state,pageId,vId)` 取单个 |
| 副页 id 归属（"在哪个副页里"） | `core/ops/page.js:locateVirtualNode(state, id)` | **唯一一份**：`ui/G_events.js`、`ui/revealNode.js`（`v9.0.17` 起）、`ui/nodeinfo/nodeInfoView.js` 的蓝字判据、`ui/kit/nodeEntry.js` 的入口条都走它 |
| **祖先链（主树 + 页内，一个入口）** | `core/ops/page.js:nodeAncestorsOf(state, id)` | **唯一入口**（2026-10-13 合并）：按归属分流 —— 主树 id ⇒ `getAncestorsRootFirst`（`parentOf`）、页内 id ⇒ `virtualAncestorsOf`（`virtualIndex[*].parentId`）。两份**实现**仍各只有一份。`ui/revealNode.js`、`ui/nodeinfo/nodeGroup.js:breadcrumbOf` 共用 |
| **页内祖先链**（两份实现里的页内那一份） | `core/ops/page.js:virtualAncestorsOf(state, id)` | **唯一一份**（`v9.0.19` 加，与 `locateVirtualNode` 同住）：走 `pages[pid].virtualIndex[*].parentId`，返回**根在前、不含自己**的 vNode 数组。**不是** `getAncestorsRootFirst` 的翻版（那份走主树 `parentOf`）—— 数据源不同，所以两份实现不合并，只由 `nodeAncestorsOf` 分流 |
| 副页页内定位 | `ui/revealNode.js:revealNode`（`revealInVirtualFolderMode` / `revealInVirtualTreeMode`）+ `ui/folder/virtualFolderMode.js:enterVirtualFolder/goToVirtualRoot/getVirtualState` + `core/ops/view.js:setVirtualNodeExpanded/setVirtualNodeCurrentPage` | `v9.0.17` 起：`revealNode` 认页内 id ⇒ 切到那一页再页内定位；**页内导航只有 `virtualFolderMode` 那一份**，别再造 |

**副页节点的正确姿势（五句话）**：
① **要跳主树** ⇒ `jumpTargetOf` 的路子：`realNodeIdOf` 解析 → `data-reveal-node=<真实 id>`；
解析不出（副页根节点）⇒ **不给入口**，如实说明。
② **要跳到该副页内的对应位置**（`v9.0.17` 起，用户 2026-10-13 定的）⇒ 承载**同样**是 `data-reveal-node`，
但值给**页内 id**（`revealNode` 会切到那一页再页内定位）。判据 = `locateVirtualNode` 命中且不是页内根。
**别为此造第二种标记 / 第二种委托。** 现状：节点详页头部那串蓝字走这条；那颗「🔎」按钮仍走 ①
（两者各管一件事，**别合并**）。
③ **要看详页** ⇒ `openNodeInfoTab(realId)` 看主节点，或 `openNodeInfoTab(vId, {asVirtual:true, pageId})`
看副页节点自己（`ui/G_modal/G7_editTarget.js:showInfoTargetSelector()` 就是"两个都能看"的选择器）。
**"📋 点下去干什么"只有 `ui/G_events.js:openInfoFromButton` 一份**（`data-vid` 那一支）；要挂 📋 的地方
只需带 `data-id` / `data-vid` / `data-page-id` 三个属性，**别自己调 `openNodeInfoTab`**。
④ **方框上的按钮**：副页方框的 `📋` 同时带 `data-id`（真实）+ `data-vid` + `data-page-id`
（`view/helpers.js:buildActions()`），**编辑/加子/更多操作在副页一律不画**（画出来再弹"不支持"更糟）。
⑤ **非主树的副页节点行**（统计明细 / AC 列表那种"方框后面一行入口条"）⇒ 走
`ui/kit/nodeEntry.js:nodeEntryLine` 的副页那一支（`v9.0.19` 起）：🔎 给**页内 id**、📋 带上面那三个属性、
面包屑走 `breadcrumbHtml` 的**页内**那一支（一个入口、函数内判 `_virtual`）。⚠️ 判据是"`locateVirtualNode` 命中且不是页内根"；
页内根 / 解析不出 ⇒ 如实留空（别画假链接，也别印"（就在根下）"）。

### 2.8 插件怎么拿到这份渲染器

（`ctx.nodeEntry` —— **宿主注入**；⚠️ 标题必须**逐字**是这样，`src/test/docAnchors.test.js` 按它核指针。）

`src/features/**`（插件）**不许 import `ui/`**（`src/features/AGENTS.md` 的不变量）⇒ 它们要画
"身份键 + 完整面包屑 + 📋"那一格时，**不能** import `ui/kit/nodeEntry.js`。破法不是"在插件里再写一份"，
而是**宿主把函数注进 ctx**（照 `features/ContestOverview` 注入 `jumpId` 的先例）：

| 环节 | 在哪 | 干什么 |
|---|---|---|
| 注入 | `ui/tabs.js:mountPluginTab` | 给插件 `mount(ctx)` 的 ctx 加 `nodeEntry(node, opts)` = `ui/kit/nodeEntry.js:nodeEntryLine` |
| 转发 | `features/Search/index.js:mountSearch` | 子页拿到的是**另一个新对象** ⇒ `ctx.nodeEntry` 要**原样转发**（别在这里包一层） |
| 使用 | `features/ProblemSearch/index.js`、`features/ContestSearch/view.js` | 结果行末尾那格：`ctx.nodeEntry(node, { compact: true })`；没注入（单测直接调 mount）就如实写「—」 |

⚠️ 注入的是**函数**、不是渲染好的 DOM：列表每次重画都重新调一次，拿到的才是当前 state。
⚠️ **整行可点 + 行内 📋** ⇒ 行点击要先 `if (ev.target.closest('.node-entry')) return;` 再派发
`REVEAL_NODE`，否则一次点击会"跳树 + 开详页"一起发生（`src/features/AGENTS.md` 的 AutoImport 记过同一个坑）。
⚠️ 判据只查**单类** `.node-entry`：DOM 桩的 `closest` **不认逗号选择器**
（`docs/ui-conventions.md` 的「8. 冒烟 / DOM 桩的边界」一节）。

---

## 3. 盘点表：谁在画节点方框 / 节点行

字段含义：**跳转** = 有没有"跳到主树并定位"；**面包屑** = 有没有"它在树上哪"；
**详情** = 有没有"打开节点详页（📋）"；**其它** = 复制键 / 源站链接 / 勾选 / 内联动作。

### 3.1 主树与文件夹模式（`src/view/**` + `ui/folder/**`）

| 位置（file:function） | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `view/viewRenderers.js:renderTreeView` → `view/renderers.js:renderNode` → `view/helpers.js:renderNodeBox` | **主树节点方框**（`.`node-box[data-id]`，递归 + 分页） | `ui/G_events.js:onBoxClick`：**双击**编辑（选择模式除外）；按钮走 `onActionClick` 委托 | 它就是主树 | ❌（树模式**没有**面包屑） | ✅ 📋 `btn-node-info[data-id]` | ✏️➕⚙️✖⬆⬇；`buildToggleButton` 折叠；`naturePeekHtml` 按住 Ctrl 显示四格 nature；合成节点多挂 `synth-box-pattern` |
| `view/tree.js:insertNodeAt/updateNode` | 同上（**增量补丁**，不新增入口） | 同左 | — | — | — | ⚠️ 浅展开时只换 `innerHTML`+`className`，**别在这条路上挂监听/内联状态**（会被 `innerHTML` 冲掉） |
| `ui/folder/folderMode.js:mountChildrenView` → `view/viewRenderers.js:renderFolderView` | **文件夹模式的子节点列表**（每行一个方框 + 分页） | `ui/folder/folderMode.js:folderClickHandler`：R 节点弹 toast、O 节点回根、其余 `enterFolder(id)`；**`e.ctrlKey` 直接 return**（让给编辑） | —（它就是主视图） | ✅ 2.5 那份**文件夹导航**面包屑 | ✅ 📋 | ✏️➕⚙️✖⬆⬇（`buildActions(mode:'folder')`，`isCurrentFolder` 时摘掉 ⬆⬇） |
| `ui/folder/folderShared.js:renderFolderStatsComponent` | 文件夹模式**顶部"当前节点"那一格**（`mode:'folder'`，与子节点同一套） | **单击什么都不会发生**（进文件夹的处理器只挂在 `#tree-body` 上，而这一格在 `#folder-stats`）；按钮靠 `G_events` 补挂的那条委托 | ❌（它就在主视图里） | ✅（同一个面包屑在它上方） | ✅ 📋 | 与子节点**按钮完全一致**（用户 2026-10-07 指定） |
| `view/helpers.js:buildActions` | 各模式下的**按钮组**（`selector` / `readonly` / `folder-header` 只出很少或不出） | — | — | — | `readonly` / `folder-header` **不画任何按钮** | ★ 这是"方框上有什么入口"的**唯一一份**名单 |

### 3.2 副页（虚拟节点 `_virtual`，`ui/folder/virtualFolderMode.js`）

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `virtualFolderMode.js:mountVirtualChildrenView` → `renderFolderView` | 副页的**虚拟节点方框**（页内 id） | `virtualClickHandler`：O 节点回副页根、其余 `enterVirtualFolder`；`e.ctrlKey` return | ❌（方框本身不给跳转入口；"跳到该页内位置"走详页头部那串蓝字，见 3.7） | ✅ 副页面包屑（带 `📄 页名` 前缀） | ✅ 📋（带 `data-id` 真实 + `data-vid` + `data-page-id`，点击先弹"看哪个"） | ✖ 从副页移除、⬆⬇；**编辑/加子/更多操作不画** |
| `virtualFolderMode.js:renderVirtualStatsComponent` | 副页顶部"当前节点"格（`mode:'folder-header'`） | 无 | ❌ | ✅ | ❌（`folder-header` 不画按钮） | — |
| `virtualFolderMode.js:mountVirtualStatsView` → `ui/stats/statsCharts.js:renderSegmentDetail` → `ui/kit/nodeEntry.js:appendNodeEntries` | 副页自己那一页的「📊 题目分布统计」；点柱段后**那一批题**（只读方框 `renderNode(...,'readonly')` + 入口条） | 方框本身无 click（`readonly` 不画按钮）；**方框后面**一行入口条 | ✅（入口条上的 🔎 = **页内 id**，`v9.0.19` 起） | ✅（`breadcrumbHtml` 的**页内**分支） | ✅（入口条上的 📋，带 `data-vid`+`data-page-id`） | ⚠️ 与「节点详页里的同一个视图」是**同一份实现**（见 3.7 与 §6.4(a)） |

### 3.3 数据统计（`ui/stats/**`）——**用户最初问的就是这一片**

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `ui/stats/statsCharts.js:renderBarChart`（`renderStatsChart` 调） | **题目分布柱状图**：一档难度一根柱，柱内按 `status2` 堆叠；只有图例 | **柱段可点**（`v9.0.18` 起）：带 `dataset.level` / `dataset.status2` + `title`（"哪一档 · 什么状态：N 题 —— 点一下把这一批列在图表下面"）；点一下 ⇒ 那一批按**只读节点行**列在图表下面，再点同一段收起 | ❌ | ❌ | ❌（明细行里**有** 📋 入口条，靠全局委托） | 分档口径 `xcpcBucketOf` / `cfBucketOf`（**唯一一份**，图与明细共用） |
| `ui/stats/statsCharts.js:renderSegmentDetail` → `ui/kit/nodeEntry.js:appendNodeEntries` | **点柱段筛出来的那一批题**（只读方框 + 一行入口条） | 方框本身无 click（`readonly` 不画按钮）；**方框后面**的入口条：🔎 / 📋 / 面包屑（`v9.0.18` 主页那处；`v9.0.19` 起**副页那处也有**） | ✅ | ✅（主树节点 / **副页节点** 都由 `breadcrumbHtml` 内部分流） | ✅ | ⚠️ **主页面与副页走的是同一个 `renderSegmentDetail`** ⇒ 判据只能是"归属"（`state.nodes` 里有没有 / `locateVirtualNode` 命中不命中），别按宿主分叉 |
| `ui/stats/ac/heatmap.js:renderHeatmapForYear` | **AC 热力图**：一格一天；带 `title="日期 · N 题"` | 有题的那格：**内联** `onclick="window.renderDailyACList('<日期>')"`（全仓唯一一处内联事件 + `window` 全局挂载，见 `ui/stats/ac/dailyList.js` 末尾 `window.renderDailyACList = …`） | ❌ | ❌ | ❌ | 点格 = 展开那一天的题列表 |
| `ui/stats/ac/dailyList.js:renderDailyACList` / `renderTimeRangeACList` → `ui/stats/ac/listView.js:renderACListView` | **每日 / 时间范围的 AC 题目列表** = **真的节点方框**（`renderNode(..., 'readonly')`，带 `data-id`） | 方框本身仍无 click（`readonly` 不画按钮）；**方框后面**有一行入口条：🔎 / 📋 / 面包屑（`v9.0.13` 起） | ✅（入口条上的 🔎） | ✅（复用 `breadcrumbHtml`） | ✅（入口条上的 📋） | 分页、列表/统计切换、✖ 关闭 |
| `ui/stats/ac/listView.js:renderACStatsView` | 上面那个"统计"看法：把这一批题丢给 `renderStatsChart` | 同 `renderBarChart`：无 | ❌ | ❌ | ❌ | 列表/统计切换 |
| `ui/stats/ac/tracking.js:renderACTracking` → `#ac-tracking-list` | **最近 AC 题目列表**（`renderNode(..., 'readonly')`，真方框） | 同 AC 列表：方框本身无 click，**方框后面**一行入口条（🔎 / 📋 / 面包屑，`v9.0.13` 起） | ✅ | ✅ | ✅ | 分页（`ui/stats/ac/tabs.js`） |
| `ui/stats/compare.js:renderTable` | **账户对比表**：`<tr class="compare-group">`（比赛行）+ `<tr class="compare-problem">`（题目行） | 比赛行 = **展开/收起**；题目行 = **打开编辑弹窗**（动态 `import('../G_modal/G4_edit.js').editNode(id)`） | ❌ | ❌ | ❌（是**编辑弹窗**，不是详页） | 账户勾选、只看某档、搜索框 |

### 3.4 检索（`src/features/{ProblemSearch,ContestSearch}`）

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `features/ProblemSearch/index.js:buildResults` | 结果表 `<tr class="ps-result-row" data-id>`（题号/题名/难度/状态2/标签/归属 + **末列「节点」**） | **整行 click ⇒ 派发 `EVENTS.REVEAL_NODE`**；行内那格自己也是交互（面包屑 = 🔎、📋 = 详页）⇒ 行点击**先判 `.node-entry`** | ✅ | ✅（末列） | ✅（末列） | 行上写了"点击任意一行跳到树上"；分页。末列 = 宿主注入的 `ctx.nodeEntry`（§2.8） |
| `features/ContestSearch/view.js` | 比赛结果表（同形状，末列同样是「节点」） | 同上（**同一颗事件、同一套形状**，见 `src/features/AGENTS.md` 的不变量） | ✅ | ✅（末列） | ✅（末列） | 同上 |
| `features/Search/kit.js` | **只有九个控件**（不是节点行） | — | — | — | — | 条件栏与结果表**平级**（别在 `render()` 里重建条件栏，会丢焦点） |

### 3.5 判重整理（`ui/dedup/**`，五栏）

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `ui/dedup/synthSection.js:synthSection`（① 合成节点） | 每个合成组一张卡：组名 + 每个成员一行 | 组名 / 成员名 `markGoto` ⇒ `data-goto` 委托 | ✅ | ❌ | ❌ | nature 芯片（可点改）、`linkBlockOf`（源站链接）、改名/改键/删组/解绑 |
| `ui/dedup/candidateSection.js:candidateSection`（② 可能重复） | 每对候选一张卡：A、B **各一行** | 两行名字 `markGoto` | ✅ | ❌ | ❌ | nature 芯片、链接块、归入/新建并入 |
| `ui/dedup/naturePending.js:naturePendingSection`（③ 性质待补） | 勾选列表 + 每行名字 + nature 芯片 | 名字 `markGoto`（颜色 = 填满与否） | ✅ | ❌ | ❌ | 勾选 + 批量填、依据下拉 |
| `ui/dedup/summary.js:summarySection`（④ 概览） | 一句统计 + **"还没归入的原料"清单** + 计数模式开关 | 清单里每一项 `markGoto` ⇒ 点名字跳树（`v9.0.13` 起；节点已不在树上则如实当纯文本） | ✅ | ❌ | ❌ | `[不判重 / 判重]` 一键开关（写的是**统计那边同一个设置键**） |
| `ui/dedup/conflictSection.js:conflictSection`（⑤ 冲突） | 分类节 → 按场的行；`valueLine()` / `goto()` / `appendNodeLink()` | 全部 `markGoto`；`nodeOrText()` 在**换算不到节点 id** 时**老老实实当纯文本**（别渲染假链接） | ✅（多数行） | ❌ | ❌ | 「✓ 确认这一场」、「➡️ 改到该键」（`pruneStages.js:retargetButton`）、题面外链 |
| `ui/dedup/pruneStages.js`（⑤ 的"可清理"环节） | 「🧹 可清理」各条 | `markGoto` | ✅ | ❌ | ❌ | 一键清理悬空指针等 |
| `ui/dedup/dedupPage.js:renderDedupPage` | 页头 + 五栏二级 tab | **`wireGotoLinks(root)` 在这里挂一次**（全页 `data-goto` 的唯一委托） | — | — | — | 切栏只重画、**不清筛选条件** |

### 3.6 比赛补题概览（`features/ContestOverview`）

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `features/ContestOverview/render.js:buildRowHTML` | `.co-dot`（**一点一题**，按 `status2` 着色、`status1=1` 加圈）+ 点下方 `.co-pid` 题号 | **点/题号带 `data-reveal-node`**（`v9.0.13` 起；解析不出主树 id 就不画成可点）⇒ 点一下跳树；`title` 仍是"比赛 · 题号 · 状态 · 难度" | ✅ | ❌ | ❌ | `read` 取值器由 `index.js:mountOverview` 注入（**显示列**口径）；`jumpId` 解析器同 |
| `features/ContestOverview/render.js:buildNamesHTML` | 左侧比赛名栏（与 canvas 逐行对齐） | 名字那一截带 `data-reveal-node` + 一颗 📋（`btn-node-info`，`v9.0.13` 起） | ✅ | ❌ | ✅（比赛节点） | — |
| `features/ContestOverview/index.js:buildControls` | 筛选模式 / 显示特殊项 / 难度类型切换 | 三个控件各有 `change` / `click` | — | — | — | 设置写的是 `settings.stats.*`（与内置统计**同一份键**） |

### 3.7 节点详页（`ui/nodeinfo/**`）——**目前入口最全的一处，照它抄**

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `ui/nodeinfo/nodeInfoView.js:buildShell` | 头部：**节点方框本身**（`renderNodeBoxHtml` = `renderNode(...,'folder-header')`）+ id 一行 + 「🔎 跳到树上」+ 面包屑 | 「🔎」= `data-reveal-node`（目标由 `jumpTargetOf` 解析：**副页给的是它引用的主节点**）；**id 那一串也是可点入口**（`v9.0.16` 起；`v9.0.17` 起**按归属分流**）：**主树节点** ⇒ 跳主树（`mainTreeNodeIdOf`）；**副页页内节点** ⇒ 跳**该副页内的对应位置**（判据 `locateVirtualNode` 命中且不是页内根），承载仍是同一种 `data-reveal-node`；**解析不出 ⇒ 保持灰的纯文本**，别留假链接 | ✅（两条各管一件事：蓝字按归属、按钮一律跳主节点；副页根两样都不出现） | ✅ `nodeGroup.breadcrumbHtml`（**`isVirtual` 时不给**） | 它自己就是详页 | 子 tab 栏 = `folderViewRegistry` 的**同一份视图清单**（「📥 导入/同步」就挂在这下面 ⇒ 用户会把这整块叫"导入目标头部"）；⚠️ 头部这个方框**没摘 `data-id`**（见 G11） |
| `ui/nodeinfo/nodeGroup.js:nodeRow` | 「所在组」里**每一行 = 只读节点框** | 外层 `data-reveal-node`（**跳树**） | ✅ | ✅ 每行都带 `breadcrumbHtml` | ✅ `📋 打开详页`（**同一套接线**：`btn-node-info[data-id]`） | `stripTreeWiring()` 摘掉 `id="node-x"` 与 `.node-box` 的 `data-id`；显示 id 与角色标签；`confirmRowHtml` 的「取消确认」 |
| `ui/nodeinfo/nodeGroupActions.js` | （无渲染）**动作与委托** | 文档级 `[data-reveal-node]` → `revealNodeById()`；另一条 `[data-unconfirm-*]` | — | — | — | ⚠️ **不许 import `ui/tabs.js`**（会与 `tabs → nodeInfoView` 绕成环）——这条已被 `src/test/nodeGroup.test.js` 钉住 |

- ⚠️ **详页里的子视图也是"非主树的一片"**：`ui/nodeinfo/nodeInfoView.js:renderNodeInfoPanel` 用的是
  `ui/folder/folderMode.js:getFolderViews()` 那份**视图清单**，副页节点详页的「📊 题目分布统计」
  因此和副页自己那一页走的是**同一个** `ui/stats/statsCharts.js:renderSegmentDetail`
  ⇒ 那里的节点行入口由 `ui/kit/nodeEntry.js:appendNodeEntries` 统一补（`v9.0.19` 起副页也认，
  见 §3.2 / §3.3）。**别再给某个宿主单独写一份入口条。**

### 3.8 自动导入（`features/AutoImport/**`）

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `features/AutoImport/ui/recordTable.js:renderRecordTable` | **逐条记录预览表**（动作/类型/extKey/名称/将写入字段/性质/操作）+ 合成节点行 | 「操作」那一格：**树上真有这个节点**（`plan.records[*].nodeId`，`existing ? existing.id : null`）才画 🔎（`data-reveal-node`）与 📋（`btn-node-info[data-id]`）；**新增行树上还没有 ⇒ 只有一个「—」**（`v9.0.14` 起）。属性挂在**格内元素**上、不挂整行（挂整行会让点 📋 同时触发跳树） | ✅ | ❌ | ✅ | 「只看性质不一致」只影响**画出来的行**；跳过的行排最后；`dataset.extkey/action/move/naturediff/synthkey` 供冒烟用 |
| `features/AutoImport/ui/summary.js:appendPointerIssues` | 指针异常（被拒 / 悬空）逐条一行 | `data-reveal-node` ⇒ 靠**文档级**那条委托接住（`v9.0.13` 起：**不再自带局部委托**，G8） | ✅（有 `nodeId` 时） | ❌ | ❌ | 没有 id 时如实写"树上没有这个节点（只能在包里核对）" |
| `features/AutoImport/extKeyPanel.js:renderExtKeyPanel` | **extKey 清单表**（名称/类型/题号/现值/建议值/操作） | 行上 `tr.dataset.node` 仍在；**操作列多了 🔎 与 📋**（`v9.0.13` 起；插件只写 `data-reveal-node` / `btn-node-info[data-id]` 属性，靠全局委托） | ✅ | ❌ | ✅ | `parseAssignmentTable` / `matchAssignments` 的粘贴匹配、行内「更换」。⚠️ **它是由 folder 视图宿主挂进 `#tree-container` 的** ⇒ `v9.0.15` 之前那颗 📋 被文档级委托拒收、只剩容器级那条接（那一条认逗号选择器，DOM 桩不解析 ⇒ 桩里点了没反应，见 §4 G5） |
| `features/AutoImport/index.js` | （无渲染）对外的 `revealNode(nodeId)` / `revealNodeByExtKey(extKey)` | 派发 `EVENTS.REVEAL_NODE` | ✅ | ❌ | ❌ | **插件不 import `ui/`** 的正例 |
| `features/AutoImport/ui/panel.js` `buildBox.js` `batchTabs.js` `failures.js` `progress.js` | 面板/折叠盒/批 tab/失败清单/进度 | 各自的按钮 | — | — | — | 都不是节点行（`failures.js` 需按同一判据复核） |

### 3.9 弹窗（`ui/G_modal/**`）——**别忘了这里也在画方框**

| 位置 | 渲染的是什么 | 现在点击是什么行为 | 跳转 | 面包屑 | 详情 | 其它 |
|---|---|---|---|---|---|---|
| `ui/G_modal/G2_selector.js:renderTreeNodes` | **选节点弹窗里的树** = `renderNode(...,'selector')` ⇒ **带 `.node-box[data-id]` 的真方框** | 方框里是 `<input type="radio" name="tree-selector-radio">`（选中） | ❌（选完才用） | ❌ | ❌ | 折叠按钮 `tree-toggle-btn`、搜索、禁用态 |
| `ui/G_modal/G7_editTarget.js:showInfoTargetSelector` | 「查看哪个」选择器（主节点 / 合成 / 副页节点） | 选择后由 `onPick` 决定（`G_events` 里调 `openNodeInfoTab`） | ❌ | ❌ | ✅（它就是"开哪个详页"的选择器） | 副页 `refId` 是合成节点时**如实写"这是合成节点"** |
| `ui/G_modal/G7_vNodeEdit.js` | 副页节点编辑 | 编辑动作 | — | — | — | — |

### 3.10 查过、**确认不需要**的地方（免得下次再翻一遍）

- `ui/coverage/coveragePage.js`（🩺 体检 / 需求）：报告是**字段 × 类型行**级别（`missingRows` / 覆盖行），
  **不是节点级** ⇒ 没有"某个节点"可跳，**本就不该有跳转入口**（别为了"统一"硬加）。
- `features/TestnumOp/**`：插件示例，`plugins.json` 里**没有它**（平时不生效），只注册了一个渲染槽。
- `ui/settings/**`、`ui/MeEditor/**`、`ui/G_modal/G8_accounts.js`：账户与设置，与节点行无关。

---

## 4. 缺口

每条都给"症状 → 判据（怎么核）"。

> **状态（`v9.0.13`，逐条对齐现实 —— 下面每条的症状写的是"修之前"的样子）**
>
> | 缺口 | 状态 | 落到哪 |
> |---|---|---|
> | G1 AC 列表没入口 | ✅ **已铺**（每日 AC 列表 + 最近 AC 列表两处） | `ui/kit/nodeEntry.js` 的入口条（🔎 + 📋 + 面包屑） |
> | G2 柱状图不可交互 | ✅ **已做**（`v9.0.18`；落点 = **列在图表下面**，见 6.4） | `ui/stats/statsCharts.js`（`xcpcBucketOf`/`cfBucketOf` + `renderSegmentDetail`） |
> | G3 账户对比题目行=编辑 | ❌ **仍未做**（会改掉既有语义，属产品决定） | — |
> | G4 概览的点点不动 | ✅ **已铺** | `features/ContestOverview/render.js`（点/题号/比赛名带 `data-reveal-node` + 📋），解析函数由 `index.js:mountOverview` 注入（`v9.0.14` 起直接用 `core/ops/page.js:mainTreeNodeIdOf`） |
> | G5 导入两张表点不动 | ✅ **已铺**（`v9.0.14` 补齐记录表这后半；`v9.0.15` 修好"extKey 表那颗 📋 接错了委托"） | `features/AutoImport/extKeyPanel.js`（每行 🔎/📋）、`features/AutoImport/ui/recordTable.js`（「操作」格，用 plan 里现成的 `rec.nodeId`；新增行不画） |
> | G6 ④ 概览清单是纯文本 | ✅ **已铺** | `ui/dedup/summary.js:summarySection`（`markGoto`） |
> | G7 两套跳转标记 | ✅ **已收敛**：承载 = `data-reveal-node`（`markGoto` 唯一一份）；`data-goto` / `wireGotoLinks` 退成**薄兼容**（只转发给 `revealNodeById`） | `ui/kit/actions.js` |
> | G8 `data-reveal-node` 双派发 | ✅ **已修**（删掉 `appendPointerIssues` 那份局部委托） | `features/AutoImport/ui/summary.js` |
> | G9 面包屑分布不均 | 🟡 **大部分已铺**（`v9.4.15`）：AC 列表、`v9.0.19` 起副页统计明细、**2026-10-15 起计划题表 + 两张检索结果表**（"题名留着、另加一列节点入口条"）；**仍未做**：统计其它子页、判重五栏、比赛概览（判重五栏逐行加会显著变重）。★ 插件那一半靠**宿主注入** `ctx.nodeEntry` 破的（见下面「插件怎么拿到这份渲染器」） | `ui/kit/nodeEntry.js`、`ui/tabs.js` |
> | G10 祖先链三份实现 | ✅ **已收敛**（两处手写都改成 `getAncestorsRootFirst`）。⚠️ `v9.0.19` 补记：**页内**祖先链是**另一棵树**，只有 `core/ops/page.js:virtualAncestorsOf` 一份（`ui/revealNode.js` 那个私有实现已改成转发到它）——不是"第四份"。2026-10-13 合并时再收一层：**对外只剩 `core/ops/page.js:nodeAncestorsOf` 一个入口**（按归属分流，两份实现都留着） | `ui/revealNode.js`、`ui/nodeinfo/nodeGroup.js`、`core/ops/page.js` |
> | G11 命中副本方框 | ✅ **已修**（`findNodeBox` 收窄到 `#tree-body` / `#folder-stats`；详页头部那一格也 `stripTreeWiring`）。`v9.0.17` 起这两格**复用**给副页（副页方框也画在那里）⇒ 判据从"在不在主页面"变成"这个 id 属不属于目标那一页"，**仍然没有退回全文档 `querySelector`** | `ui/revealNode.js`、`ui/nodeinfo/nodeInfoView.js` |
> | G12 热力图内联 `onclick` | ✅ **已做**（2026-10-13 合并）：改成容器上的**事件委托**（格子带 `data-ac-date`），不再拼 `onclick="window.…"`；`window.renderDailyACList` 留着（兼容，不再是唯一通道） | `ui/stats/ac/heatmap.js` |
> | G13 可点元素不可聚焦 | ⛔ **不做**（用户 2026-10-13 拍板）—— 见下面那条 | — |
> | G14 复制键 | ❌ **本轮不做**（仓里**已有一份**私有实现 `ui/coverage/coveragePage.js:copyText`，G14 原来那句"全仓没有"已经不成立）；要铺得先把它提成通用件 + 定"复制入口放哪"（产品决定） | — |
> | G15 副页的节点行整条入口都没有 | ✅ **已铺**（`v9.0.19`；当初是**刻意**跳过的，理由与"现在为什么能做了"见下面那条） | `ui/kit/nodeEntry.js`（+ `core/ops/page.js:virtualAncestorsOf`、`ui/nodeinfo/nodeGroup.js:breadcrumbHtml` 的页内分支、`ui/G_events.js:openInfoFromButton`） |
>
> 验收判据与"红过一次"的证据在 `作者专用/docs/变更记录.md` 的 `v9.0.13` 那一段。
> `G2` 的落点、红绿证据与残余在 `v9.0.18` 那一段。
> `G15` 的红绿证据与残留在 `v9.0.19` 那一段。
> `G12` 的改法与残余在 `作者专用/docs/变更记录.md` 的「2026-10-13 合并那轮」那一段。

- **G1｜AC 列表里的节点方框完全没有入口。**
  位置：`ui/stats/ac/listView.js:renderACListView`、`ui/stats/ac/tracking.js:renderACTracking`
  （都走 `renderNode(..., 'readonly')`）。
  症状：在"最近 AC 题目列表 / 每日 AC 列表"里点方框，**什么都不发生**（也没有 📋、没有右键）。
  判据：`view/helpers.js:buildActions` 在 `mode === 'readonly'` 时 `return ''`，而 `G_events` 的两条委托
  只挂在 `#tree-container`、`#folder-stats` 上 —— 这三处一读就明白。

- **G2｜统计图（柱状图）不可交互，信息也不够。**
  位置：`ui/stats/statsCharts.js:renderBarChart`。
  症状：柱段既不能点、也没有 `title`（只有底部图例）⇒ 看不出"这一段是多少、什么状态、对应哪些题"。
  判据：那段循环里只设 `style.cssText`，**没有** `dataset.*` / `title` / `addEventListener`。
  ✅ **`v9.0.18` 已做，落点 = 6.4**：柱段带 `dataset.level` / `dataset.status2` + `title`
  （写明"点一下把这一批列在图表下面"），点一下把那一批画在图表下面（复用只读方框 + 入口条）；
  **分档口径收成 `xcpcBucketOf` / `cfBucketOf` 一份**（图与明细共用）—— 别在别处再算一遍"这一档有哪些题"。

- **G3｜同类"点一下"在不同页面语义相反。**
  位置：`ui/stats/compare.js:renderTable` 的 `.compare-problem` 行 ⇒ **打开编辑弹窗**；
  而 `features/ProblemSearch/index.js:buildResults` 的 `.ps-result-row` ⇒ **跳主树**。
  症状：用户记住的"点行跳树"在账户对比里变成"弹出编辑框"（**有写风险**的动作）。
  判据：两边各自的 click 回调对比；弹窗那条要先 `await import('../G_modal/G4_edit.js')`。

- **G4｜比赛补题概览的"一点一题"点不动。**
  位置：`features/ContestOverview/render.js:buildRowHTML`（`.co-dot` / `.co-pid`）、`buildNamesHTML`。
  症状：整页只能看；想知道"这个点到底是哪道题、树上在哪"必须自己去检索。
  判据：`buildOverviewHTML()` 出的 HTML 里**没有一个 `data-*`**（`render.js` 声明自己"只产出 HTML 字符串、
  **不碰 DOM**" ⇒ 要加交互**只能在 `index.js:mountOverview` 里加委托**，别破坏它那份纯净）。

- **G5｜自动导入的两张表有身份键却点不动。**
  位置：`features/AutoImport/ui/recordTable.js:renderRecordTable`（有 `extKey` / `synthKey`）、
  `features/AutoImport/extKeyPanel.js:renderExtKeyPanel`（有 `tr.dataset.node`）。
  症状：预览表里"这条记录对应树上哪个节点"要人肉去搜；`extKey` 也不能一键复制。
  判据：`recordTable.js` 里唯一的 `dataset.*` 是给冒烟断言用的（`extkey`/`action`/`move`/`naturediff`），
  **没有** `nodeId`；`extKeyPanel` 有 `dataset.node` 但行上没有 click。
  ✅ **`v9.0.14` 已铺完**：记录表**不用新查** —— `plan.records[*].nodeId` / `plan.synth.nodes[*].nodeId`
  本来就是 `existing ? existing.id : null`（`plan.js` / `plan/synthNodes.js`）；
  那一格只在 `nodeId` 非空时画 🔎 + 📋，**新增行（树上还没有这个节点）只有一个「—」**。
  ⚠️ **`v9.0.15`：extKey 表那颗 📋 原先接的是"另一份局部委托"**（用户实测"点不动"）。
  病根 = `ui/G_events.js:installNodeInfoDelegate` 用 `closest('#tree-container')` 把**整个树容器**
  里的 `.btn-node-info` 拒收，而**插件页恰恰就挂在 `#tree-container` 里**
  （`ui/folder/folderViewHost.js:ensurePluginPanel` 的默认宿主）⇒ 那颗 📋 只剩
  `#tree-container` 上的 `onActionClick` 接，而它认的是**逗号选择器**
  `.btn-icon, .toggle-btn, .pagination-btn` —— DOM 桩**不解析逗号选择器** ⇒ 这条路径在 CI 里
  **恒为空转**，症状就是"面板点不动，而 `npm test` + `npm run test:smoke` 全绿"。
  修法：排除收窄成**只留 `.node-box` 自己那颗**（容器那条会 `stopPropagation`，不重复开）。
  判据：`scripts/smoke/auto-import.smoke.mjs` 的「★ extKey 面板的入口必须接在**文档级那一条**委托上」
  （把面板按真实位置摆进 `#tree-container` 再点 📋；改回 `closest('#tree-container')` 当场红）。

- **G6｜判重整理 ④ 概览的"还没归入的原料"是纯文本。**
  位置：`ui/dedup/summary.js:summarySection`（`nodeLabel(model.nodes[id])` 直接塞进 `<span>`）。
  症状：同一页 ①②③⑤ 点名字都能跳树，④ 这一栏点了没反应。
  判据：`summary.js` 里**没有** `markGoto` 的 import（`grep -n "markGoto" src/ui/dedup/summary.js`）。

- **G7｜"跳转标记"两套并存，新页面很容易选错。**
  `data-reveal-node`（文档级委托，`nodeGroupActions.js`）vs `data-goto`（页面级委托，
  `ui/dedup/dedupPage.js` 里对判重页根挂一次）。
  症状：把 `markGoto` 复制到别的页面 ⇒ **可点、有 title、但点了没反应**（委托不在这个 DOM 子树里）。
  判据：`wireGotoLinks` 全仓只有**一个调用点**。

- **G8｜`data-reveal-node` 有一份重复委托 ⇒ 双派发。**
  位置：`features/AutoImport/ui/summary.js:appendPointerIssues`（局部 `wrapEl.addEventListener`）**+**
  `ui/nodeinfo/nodeGroupActions.js`（`document` 级）。一次点击两颗 `REVEAL_NODE` ⇒ `revealNode` 跑两趟
  （两套 `watchHighlight` 定时器、下游可能双刷新）。
  判据：两个监听都在冒泡路径上，且都不 `stopPropagation`。

- **G9｜面包屑分布不均。**
  有的：folder 模式（`folderMode.renderFolderBreadcrumb` / `virtualFolderMode.renderVirtualBreadcrumb`）、
  节点详页头部（`nodeInfoView.buildShell`）。
  没有的：**数据统计全部子页、检索结果、判重整理五栏、比赛概览、AC 列表**。
  症状：从这些页面看到一个节点，判断不了"它在树的哪一层"（只能跳过去再看）。

- **G10｜祖先链有三份实现（一份正式 + 两份手写）。**
  正式：`core/query/nodes.js:getAncestorsRootFirst` / `getAncestors`。
  手写：`ui/revealNode.js:revealInTreeMode`（收集 `chain`）、`ui/nodeinfo/nodeGroup.js:breadcrumbOf`。
  判据：后两处都是 `while (cur && guard++ < 1000)` 的同一走法 —— 三份迟早分叉（例如哪天要处理"环"或
  "父节点缺失"的新口径，只会改一处）。
  ✅ **2026-10-13 合并后现状**：两处手写早改成走正式那份；对外只剩**一个入口**
  `core/ops/page.js:nodeAncestorsOf(state, id)`（按归属分流到主树 `getAncestorsRootFirst` 与
  页内 `virtualAncestorsOf` —— 两份**实现**都留着，因为数据源不同）。

- **G11｜`findNodeBox()` 可能命中外面的"副本方框"。**
  位置：`ui/revealNode.js:findNodeBox` 用 `document.querySelector('.node-box[data-id="…"]')` 取**第一个**。
  而 `class="node-box" data-id="…"` 还出现在：`ui/nodeinfo/nodeInfoView.js:buildShell`（`renderNodeBoxHtml`
  **没有** `stripTreeWiring`）、`ui/stats/ac/*` 的 readonly 列表、`ui/G_modal/G2_selector.js:renderTreeNodes`、
  文件夹模式"当前节点"格。
  症状：平时命中主树那份（`#tab-main` 在 DOM 里**排在** `#tab-stats` / 详页面板之前），但
  **目标不在当前文件夹页 / 祖先没展开 / 当前页不是主视图**时会命中外面的副本 ⇒ `focusNodeBox` 滚到一个
  看不见的元素、`revealNode` **误报成功**（`return true`）。
  判据：`nodeGroup.js:stripTreeWiring()` 的文件头已经把这个坑写清楚了（它只为「所在组」那几行解决了）；
  把 `findNodeBox` 收窄到主树容器（`#tree-body` / `#folder-stats`，**按 `AppState.currentPageId` 选**）
  是**一处修、全部受益**的做法。
  ⚠️ 注意 `src/test/nodeGroup.test.js` 里有**反向锚**断言（详页副本不能带 `data-id`）—— 改完先跑它。

- **G12｜热力图用内联 `onclick` + `window` 全局挂载。** ✅ **2026-10-13 合并时已做**
  位置：`ui/stats/ac/heatmap.js:renderHeatmapForYear`（原先是拼 `onclick="window.renderDailyACList && …"`），
  而 `window.renderDailyACList = renderDailyACList` 写在 `ui/stats/ac/dailyList.js` 末尾。
  症状：改成"事件委托"或"模块化"时，这条链接**静默失效**（字符串里的 `window.` 前缀没人拦得住）。
  判据：全仓 `onclick=` 只此一处。
  ✅ **改法**：有题的那一格改成带 `data-ac-date="<日期>"`，点击由**容器上的一次性委托**接住
  （`container.__acDailyBound` 防重复挂；`container.innerHTML` 只换子元素 ⇒ 重画不用重挂）。
  `window.renderDailyACList` **留着**（兼容，不再是唯一通道）。⚠️ 残余：这一处**没有自动断言**
  （`scripts/smoke/` 里没有热力图的夹具）⇒ 真浏览器里点一格仍要人工验一次。

- **G13｜可点元素基本不是 `<a>` / `<button>`。** ⛔ **不做（用户 2026-10-13 拍板）**
  `markGoto` 加在 `<span>` 上、`nodeRow` 的方框外层是 `<div>`、`.co-dot` 也是 `<div>`
  ⇒ **Tab 聚焦不到、回车点不动**（键盘用户与"复制链接"都受影响）。
  判据：`markGoto` 里只有 `cursor` / `color` / `title`，没有 `tabindex` / `role` / `href`。
  ⚠️ **不要再"顺手"补它**：§6 第 8 条那份"一处改、全仓受益"的估算是照 `markGoto` 写的，
  但改的是**全仓所有跳转点**的语义（`role="link"` vs `<button>`）且要补 Enter 断言的冒烟 ——
  用户明确说不做，本轮**代码里一个字都没动**。

- **G14｜"复制键/链接"完全没有。** ❌ **本轮不做**（原判据已经过时）
  ⚠️ 原判据（`grep -rn "clipboard\|execCommand('copy')" src/` 为空）**不成立**了：仓里**已经有一份**
  剪贴板实现 —— `ui/coverage/coveragePage.js:copyText()`（`navigator.clipboard` + `execCommand` 兜底 +
  `showToast` 提示），只是它是**该页私有**的、没导出，节点行 / 详页确实还没有复制入口。
  为什么不做：要铺就得先把它提成通用件（`ui/kit/actions.js`，与 `markGoto` 同层），
  再决定"复制入口放哪"（节点行？详页头部？复制 id / extKey / 还是 `#node-<id>` 锚？）——
  那是**产品决定**，而且"跳转 URL"目前没有路由（见 §6 第 4 条）。
  最小替代方案（下次要做的第一步）：把 `copyText`/`commandRow` 从 `coveragePage.js` 提到
  `ui/kit/actions.js` 导出（纯搬运、不改行为），再由需要的地方挂一颗 `📋 复制`，
  **别新写第二份剪贴板兜底**。

- **G15｜副页的节点行**（统计明细 / AC 列表那种）**整条入口都没有** —— ✅ `v9.0.19` 已铺。
  位置：`ui/kit/nodeEntry.js:appendNodeEntries`（副页方框的 `data-id` 是**页内 id**，
  它却按 `state.nodes[...]` 查 ⇒ 每一行都被 `continue`）。
  症状（用户实测）：副页节点详页的「📊 题目分布统计」点柱筛出来的题目**没有面包屑、也没有 📋**
  （主页同一处有 —— 用户要的就是两边一致）。
  判据：`grep -n "breadcrumbHtml\|getVirtualDisplayNode" src/ui/kit/nodeEntry.js`。
  ⚠️ **当初为什么不做**（`v9.0.13` 那轮是**刻意**跳过的，别把它当成"忘了"）：那时
  `revealNode` 只认主树真实 id，副页页内 id 解析不出归属 ⇒ 按"认不出就别画成可点"只能整条不给；
  面包屑也一样（`breadcrumbHtml` 走主树 `parentOf`，页内 id 会印「（就在根下）」）。
  **现在为什么能做了**：`v9.0.17` 起 `revealNode` **两种 id 都认**（页内 id ⇒ 切到所属副页再页内定位），
  于是 🔎 可以挂页内 id；📋 本来就有"看哪个"选择器那条现成的路；面包屑补一份**页内**链即可
  （G10 那条"祖先链只留一份"的规矩照样守：页内那一份住 `core/ops/page.js:virtualAncestorsOf`）。

---

## 5. 统一方案（建议）

### 5.1 一句话

**能力只有一份（`EVENTS.REVEAL_NODE` → `ui/revealNode.js`），承载只有一份（`ui/kit/actions.js:markGoto`），
委托只有一份（`ui/nodeinfo/nodeGroupActions.js` 的文档级 `[data-reveal-node]`）；面包屑只有一个入口
`nodeGroup.js:breadcrumbHtml`（**内部**按归属分支：主树 / 页内），祖先链只有一个入口
`core/ops/page.js:nodeAncestorsOf`（同样内部分流）与 `ui/tabs.js:openNodeInfoTab`
（"点下去干什么"只有 `ui/G_events.js:openInfoFromButton` 一份）。
谁都不许再展开一遍祖先、不许再算一遍页码。**入参两种 id 都认**（主树真实 id / 副页页内 id），
按 `core/ops/page.js:locateVirtualNode` 的归属分流 —— 这是 `v9.0.17` 之后**副页也能铺入口**的前提。**

### 5.2 形状与边界（契约）

```
跳转（唯一的"标记 + 委托"）
  元素：<span data-reveal-node="<目标 id>">…</span>
  生成：ui/kit/actions.js 的 markGoto(el, nodeId, color?)      ← 唯一一份
          · 加 data-reveal-node（承载）+ 观感（class/title/cursor/color）、返回 el
          · **同时保留** data-goto / `dedup-goto`（兼容钩子，见 5.4；别删）
  派发：ui/kit/actions.js 的 revealNodeById(nodeId)             ← 唯一一句"派发"
  委托：ui/nodeinfo/nodeGroupActions.js 的 document click       ← 唯一一份，全局
        （判重页那份 `wireGotoLinks` 只是**薄兼容**：转发给 revealNodeById + 给 `<label>` 兜 preventDefault）
  入参：**两种 id 都认**（`v9.0.17` 起），按归属分叉（判据只有 `core/ops/page.js:locateVirtualNode`）：
          · 主树真实 id（`AppState.nodes` 里有）⇒ 切回主页面 + 主树定位
          · 副页页内 id ⇒ 切到它所属的那个副页 + **页内**定位（进页内文件夹 / 展开页内祖先 / 翻页）
             —— 页内导航动作全部复用 `ui/folder/virtualFolderMode.js` 那几份 + `core/ops/view.js` 的两个写口
          · 顺序是"**先主树、再副页**"，与 `findNodeBox` 同序（同名时主树赢）
          · 哪个 id 都认不出（节点已删 / 副页根没有页内位置）⇒ **不要渲染成可点**（当纯文本，
            照 `ui/kit/report.js:nodeOrText` 的做法）

节点详情（唯一入口）
  元素：<button class="btn-icon btn-node-info" data-id="<id>">📋</button>
        （副页节点再带 data-vid + data-page-id —— 与树上那颗**同一套身份**）
  接住：ui/G_events.js 的**两条既有委托**（文档级 installNodeInfoDelegate +
        #tree-container/#folder-stats 上的 onActionClick）都转发到**同一份**
        ui/G_events.js:openInfoFromButton(btn, activate)   ← 唯一一份"点下去干什么"
          · 带 data-vid ⇒ 先弹"看哪个"（showInfoTargetSelector）再
            openNodeInfoTab(vId, {asVirtual:true, pageId})
          · 否则 openNodeInfoTab(nodeId, {activate})
          · 已经开着 ⇒ 只切过去（已经是行为，白拿）
          · ⚠️ 唯一被排除的是**树方框自己那颗**（`btn.closest('.node-box')`）—— 它由
            `#tree-container` 上的 `onActionClick` 接，而那条会 `stopPropagation`（不重复开）。
            **别把排除写宽成"在 `#tree-container` 里就跳过"**：插件页/概览页就挂在那个容器里
            （`ui/folder/folderViewHost.js:ensurePluginPanel`），写宽了它们的 📋 就掉到
            容器级那条上——那一条认**逗号选择器**，DOM 桩不解析 ⇒ **CI 看不见、点了没反应**
            （`v9.0.15` 修的就是这个）。
        ⚠️ **别在调用点自己调 `openNodeInfoTab`**（那就是第二条开详页的路）。

面包屑（**一个入口、内部按归属分支**）
  ui/nodeinfo/nodeGroup.js:breadcrumbHtml(state, node)   ← 纯函数、每段带 `data-reveal-node`、有单测
        · 主树节点（`!node._virtual`）⇒ "这个节点在树上哪"（来源树前缀 + `breadcrumbOf` 的 `parentOf` 链，类 `nig-crumb`）
        · 副页节点（`node._virtual`）⇒ "它在**这一页**的哪一层"（`📄 页名` 前缀 + 页内链，类 `vnode-crumb`）
        · 副页那一支走 core/ops/page.js:nodeAncestorsOf（分流到 `virtualAncestorsOf` 的页内 parentId）
        · ⚠️ 调用方**只给节点对象**，别再自己挑名字 —— 判据（`_virtual`）写在函数里
  folder 模式那份（folderShared.buildBreadcrumbHTML）**保持不动**：它是"目录导航"，
  点一段 = enterFolder，不是 revealNode —— 语义与上面那份不同，**不要合并**
```

**祖先链（一个入口）**：
```
core/ops/page.js:nodeAncestorsOf(state, id)     ← 唯一入口（2026-10-13 合并）
      · 主树 id（state.nodes 里真有）⇒ core/query/nodes.js:getAncestorsRootFirst（parentOf）
      · 别的（页内 id v_xxx）      ⇒ core/ops/page.js:virtualAncestorsOf（virtualIndex[*].parentId）
      · 顺序"先主树、再副页"（与 revealNode / findNodeBox 同序）
      · ⚠️ 两份**实现**都留着（数据源不同），这里只是分流 —— 别把两棵树合成一个循环
      · 依赖方向：core/ops 引 core/query 可以（nodes.js 零依赖），反过来会绕
```

**边界（新入口一律照这四条）**：
1. **按归属给 id**：要跳主树就给主树真实 id（副页先 `realNodeIdOf` 解析）；
   要跳"该副页内的位置"就给**页内 id**（`v9.0.17` 起 `revealNode` 认它）。**别为此造第二种标记/委托。**
2. **认不出就别画成链接**（假链接比纯文本更糟 —— `nodeOrText` 的文件头记着这条）。
3. **不在渲染函数里 import `ui/tabs.js` / `ui/folder/folderMode.js`**（会绕成环，且 `revealNode` 那套
   展开/翻页/高亮会漂成第二份）；`src/test/nodeGroup.test.js` 已经为此钉了源码级断言。
4. **插件（`src/features/`）只派发事件**，不 import `ui/`（`src/features/AGENTS.md` 的不变量）。
   需要"标记 + 委托"就地可用时，用 `data-reveal-node`（文档级那份**已经**在全局生效，插件什么都不用挂）。

### 5.3 缺口 → 用哪一份现成实现（施工对照）

| 缺口 | 用什么（**不许自造**） | 落点 |
|---|---|---|
| G1 AC 列表 / 最近 AC 列表 | `markGoto` 改名为通用件（见 5.4）+ `📋` `btn-node-info`（`openNodeInfoTab` 白拿） | `ui/stats/ac/listView.js`、`ui/stats/ac/tracking.js`（**注意 `readonly` 模式不画按钮** ⇒ 要么在 `buildActions` 之外单挂一个 `📋`，要么把这两处从 `readonly` 换成 `folder`——前者更小） |
| G2 柱状图 | 先在 `renderBarChart` 给柱段挂 `dataset.level / dataset.status2 / title`；"点一下干什么"见 6.4 | `ui/stats/statsCharts.js:renderBarChart` |
| G3 账户对比题目行 | 行 click 改成 `markGoto` 那套（跳树）；**编辑另行给一个显式按钮**（现在"点行=编辑"是危险默认） | `ui/stats/compare.js:renderTable` |
| G4 比赛概览的点 | `data-node-id` 挂到 `.co-dot` / `.co-pid` / `.co-name-row`，**委托加在 `index.js:mountOverview` 的 `panel` 上**（`render.js` 必须保持纯） | `features/ContestOverview/{render,index}.js` |
| G5 导入预览表 / extKey 表 | 每行加 `📋`（`btn-node-info`）+「🔎」`data-reveal-node`；extKey 用**行已有的** `dataset.node`（它已经是节点 id）；记录表用 plan 里**现成的** `rec.nodeId`（`existing ? existing.id : null`）——**没有 id 的行（新增）如实写「—」** | `features/AutoImport/ui/recordTable.js`、`extKeyPanel.js` |
| G6 ④ 概览清单 | `markGoto`（同页其它栏的做法） | `ui/dedup/summary.js:summarySection` |
| G7 两套标记 | 把 `markGoto` 收敛成"只挂 `data-reveal-node`"，`wireGotoLinks` 变兼容空壳（或删调用点） | `ui/kit/actions.js`、`ui/dedup/{kit,dedupPage}.js` + 冒烟断言 |
| G8 双派发 | 删掉 `appendPointerIssues` 那份局部委托（全局那份**已经**覆盖它） | `features/AutoImport/ui/summary.js` |
| G9 面包屑 | `breadcrumbHtml`（详页那套"祖先链"，不是 folder 那套"目录导航"） | 统计 / 检索 / 判重 / 概览各页头 |
| G10 三份祖先链 | `core/ops/page.js:nodeAncestorsOf`（唯一入口，内部分流到 `getAncestorsRootFirst` / `virtualAncestorsOf`）；`breadcrumbOf` 改成"取名字"的薄包装 | `core/ops/page.js`、`ui/nodeinfo/nodeGroup.js`、`ui/revealNode.js` |
| G11 命中副本 | `findNodeBox` 收窄到主树容器（`#tree-body` + `#folder-stats`，按 `currentPageId` 选）；顺带把 `nodeInfoView.buildShell` 的方框也 `stripTreeWiring` | `ui/revealNode.js`、`ui/nodeinfo/nodeInfoView.js` |
| G12 内联 onclick | 委托（挂在 `#training-heatmap`）；`window.renderDailyACList` 可以留（冒烟可能用），但**不再是唯一通道** | `ui/stats/ac/heatmap.js` |
| G13 键盘可达 | ⛔ **不做**（用户 2026-10-13 拍板）—— 原方案是 `markGoto` 里补 `tabindex="0"` + `role="link"`、委托里加 `Enter` 分支 | — |
| G14 复制键 | ❌ **本轮不做**：仓里**已有一份**私有的 `ui/coverage/coveragePage.js:copyText`（原判据"仓里没有"已过时）。要铺先把它提到 `ui/kit/actions.js` 导出，再定入口位置（产品决定） | `ui/kit/actions.js`（下一步） |
| G15 副页的节点行 | 入口条那一份照旧（`ui/kit/nodeEntry.js`），但**两边都要认**：主树 ⇒ `mainTreeNodeIdOf` + `breadcrumbHtml`；副页 ⇒ 🔎 给**页内 id**、📋 带 `data-vid`/`data-page-id`、面包屑用**同一个** `breadcrumbHtml` 的页内分支（页内祖先链的真源 `core/ops/page.js:nodeAncestorsOf` → `virtualAncestorsOf`）。**别按宿主分叉、别新增标记/委托** | `ui/kit/nodeEntry.js`（+ `core/ops/page.js`、`ui/nodeinfo/nodeGroup.js`、`ui/G_events.js:openInfoFromButton`） |

### 5.4 ⚠️ `markGoto` 收敛的那一刀（`v9.0.13` 已按 (a) 落刀）

`data-goto` / `dedup-goto` 是**行为钩子**：`ui/dedup/kit.js:wireGotoLinks` 按它找、
`scripts/smoke/dedup-synth.smoke.mjs` 按它断言。当时有两条路：
- (a) **保守方案**：`markGoto` 同时挂 `data-goto` **和** `data-reveal-node`，`wireGotoLinks` 只转发
  —— 两类断言都还绿；
- (b) **干净方案**：只挂 `data-reveal-node`，删 `wireGotoLinks` 的调用点，**同时**改冒烟断言。

**用户 2026-10-13 拍板走 (a)**（"不要去改判重页那份冒烟断言"），已落地。
⚠️ 因此 `wireGotoLinks` **必须 `stopPropagation`** —— 不拦会同一次点击再冒泡到 document 上那条
文档级委托，**派发两颗** `REVEAL_NODE`。

### 5.5 落位说明（为什么不把笔记放进 `view/`）

- 真正的"画方框"代码在 `src/view/`（`renderers.js` / `helpers.js` / `viewRenderers.js` / `tree.js`），
  但 `src/view/` **没有** `AGENTS.md`，在 `scripts/areas.mjs` 里被归为 `AREA_DEFERRED`
  （理由："口径薄，坑基本写在 `src/core/AGENTS.md` 与 `src/ui/AGENTS.md` 里"）。
- 本次改动**横跨 `view/` + `ui/` + `features/`**，而"跳转/面包屑/详情"这套入口的**接线全在 `ui/`**
  （`revealNode.js` / `nodeGroupActions.js` / `kit/actions.js` / `tabs.js`）⇒ 指针落在 `src/ui/AGENTS.md`。
- **不擅自改 `areas.mjs` 的分类**：若将来 `view/` 真的攒够了独立的坑，那时再给它建档。

---

## 6. 建议做的功能（含成本 / 风险）

| # | 功能 | 成本 | 风险 / 注意 |
|---|---|---|---|
| 1 | **"打开节点详情"（📋）铺到所有节点行** | **极低**（接线现成：`btn-node-info` + `data-id`，`G_events` 的文档级委托接住） | 无数据风险；只影响布局密度（窄列里按钮会挤，`nodeGroup.nodeRow` 已踩过"按钮被压成竖排"⇒ 给它 `flex:0 0 auto` + `white-space:nowrap`） |
| 2 | **"在树中显示并高亮"（🔎）铺到所有节点行** | **低**（`data-reveal-node` 现成） | 无；但**必须先修 G11**，否则在 folder 模式/非主视图上会"滚到看不见的副本还报成功" |
| 3 | **面包屑铺到统计/检索/判重/概览** | **低**（`breadcrumbHtml` 是纯函数、已有单测） | 深链（qoj 那种）会撑爆一行 —— 已有"保留最前 1 段 + 最后 3 段"的省略逻辑，照用；⚠️ 主副页**都交给同一个函数**（它内部按 `_virtual` 分支），别自己挑 |
| 4 | **复制键 / 复制链接**（节点 id、`extKey`、`synthKey`、跳转 URL） | **低-中** | ❌ **本轮不做**（见 G14）：仓里**已有**一份私有实现 `ui/coverage/coveragePage.js:copyText`（含兜底与 `showToast`）—— 别新写第二份；第一步是把它提成通用件再定入口。跳转 URL 目前**没有**路由（`#tab-main` 之类没做），"复制链接"只能给节点 id 或 `#node-<id>` 这种**自定义**锚 —— 要真做深链是**另一个需求**（成本中-高） |
| 5 | **统计图上点一个柱/点一格 ⇒ 筛出那一批题** | **中**（`v9.0.18` 已做，下见 6.4） | ✅ **落点已定 = 6.4（列在图表下面）**。分档口径必须**只有一份**（`xcpcBucketOf`/`cfBucketOf`）—— 图与"筛出来那一批"各算一遍就一定会分叉（图上 137、点进去 139）。⚠️ **跨 feature 传查询条件仍然没有通道**（`viewState` 是各页私有的）⇒ 想做成"点柱切到检索页"要先定一条通道，**别在统计里偷偷再写一套筛选**（成本高，且会碰 `features/Search` 的不变量） |
| 6 | **比赛概览：点一下题目 ⇒ 跳树 / 开详页** | **低**（委托 + `data-*`） | `render.js` 不碰 DOM（那是它的不变量）⇒ 委托必须加在 `index.js:mountOverview` 的 `panel` 上；`.co-dot` 只有 11px，**点中面积**要放大（给透明 padding 或用行内整列代理） |
| 7 | **导入预览表：行 ⇒ 跳树 / 复制 extKey** | **低** | 表可能几万行 ⇒ **用委托**（别逐行 `addEventListener`，判重页已经为此踩过）；`plan.records` 里的行**树上可能还没有**（新增）⇒ 没有 `nodeId` 时**如实说**，别画假链接 |
| 8 | **键盘可达（Tab/Enter）** | — | ⛔ **不做**（用户 2026-10-13 拍板）。原方案是 `markGoto` 一处加 `tabindex`+`role`+Enter 分支，但改的是全仓所有跳转点的语义（`role="link"` vs `<button>`）且要补 Enter 的冒烟断言 —— 别"顺手"补 |
| 9 | **修饰键（新 Tab / 当前 Tab）** | **低**（`v9.0.18` 已做，见 6.4） | ✅ **落点已定 = 只挂在 📋 这一颗上**：按住 `Ctrl` 点 📋 ⇒ `openNodeInfoTab(id, { activate:false })`（开页签、**当前页不动**），普通点击行为不变。⚠️ **`e.ctrlKey` 在树上已被占用**（多选 / 编辑 / 显示 nature、`folderClickHandler` 里 `if (e.ctrlKey) return`）⇒ **判据只在"接 📋 的那两条既有委托内部"加**，一律不许全局劫持。⚠️ 副页那颗 📋 走的是"看哪个"选择器，**选择器没有"激活/不激活"这个概念** ⇒ 走选择器那一支仍会切过去（残余，见 8） |
| 10 | **不做的**：树模式方框的**单击**改成跳转 | — | 单击/双击已被"进文件夹 / 编辑"占用（`ui/folder/folderMode.js:folderClickHandler`、`ui/G_events.js:onBoxClick`），且**副页/主树/选择器弹窗共用同一套方框渲染**（`view/helpers.js:renderNodeBox`）⇒ 改单击会同时改变弹窗与副页的行为。**别动** |

### 6.4 ✅ 已定的落点（`v9.0.18`）——第 5 条的"点柱"与第 9 条的"修饰键"

这两条原先都卡在"落点未定"，现在**定了**，照它做、别另起一套：

**（a）点柱段 ⇒ 把那一批列在图表下面**（`ui/stats/statsCharts.js`）

```
分档口径（唯一一份，图与明细共用）：
  xcpcBucketOf(state, p) → '签到' / … / '未填写'      // 与 buildXcpcData 同口径
  cfBucketOf(state, p)   → '800-899' / '其他（<800）'  // 与 buildCfData 同口径
柱段：<div data-level="<档>" data-status2="<0..5>" title="<档> · <状态>：N 题 —— 点一下把这一批列在图表下面">
点一下：renderSegmentDetail(container, state, 那一批, label)
        · 那一批 = filteredPNodes 里 bucketOf(p)===档 && status2===那个状态的题（**与柱段同源**）
        · 行 = 树上那套只读方框 renderNode(...,'readonly') + ui/kit/nodeEntry.js:appendNodeEntries
          ⚠️ `v9.0.19` 起**副页那一批也在这里**（同一个 `renderSegmentDetail`）：方框的 `data-id`
          是**页内 id** ⇒ `appendNodeEntries` 必须能解析副页节点（`locateVirtualNode` +
          `getVirtualDisplayNode`），入口条按归属给 🔎/📋/面包屑（主树那份 / 页内那份）。
        · 再点同一段 = 收起；✖ 收起按钮也能收
```
- ⚠️ **不筛数据、不改 pNodes、不新增第二种筛选器**：这是"看"，不是"过滤"。
- ⚠️ **不走"切到检索页"**：跨 feature 传查询条件**没有通道**（`viewState` 是各页私有的），
  要在统计里偷偷再写一套筛选就违反"分档口径只有一份"。要真做那条路，先定通道。

**（b）`Ctrl` + 点 📋 ⇒ 开而不激活**（`ui/tabs.js` + `ui/G_events.js`）

```
契约：openNodeInfoTab(nodeId, { asVirtual?, pageId?, activate? })   // activate 默认 true（行为不变）
      activate:false ⇒ 建页签 + renderTabBar() + ensureTabContent(tabId)，**不** switchTab
挂哪：只在**接 📋 的那两条既有委托内部** 判 e.ctrlKey ——
      · ui/G_events.js:installNodeInfoDelegate（文档级，管非树方框的 📋）
      · ui/G_events.js:setupEventDelegation 的 onActionClick（树方框那颗，会被它 stopPropagation 拦下）
      **不许新增监听、不许全局劫持 Ctrl**（树上多选/编辑/nature 照旧）
残余：副页那颗 📋（带 data-vid）走的是"看哪个"选择器，选择器没有"激活/不激活" ⇒ 那一支仍会切过去
```
⚠️ `v9.0.19` 起这段逻辑收成**一份**：`ui/G_events.js:openInfoFromButton(btn, activate)`
（上面那两条既有委托各转发一次）。**别在任一条里再抄一遍** —— 抄了下次改语义必只改一处。

---

## 7. 落地顺序（建议）与验收判据

**顺序**（每步都能单独验收、都能回退）：

1. **先修"地基"**：G11（`findNodeBox` 收窄）+ G8（删重复委托）+ G10（祖先链收敛）。
   这三条是"其它功能做了也不可靠"的前提。
   → 验收：`npm test`（`src/test/nodeGroup.test.js` 的反向锚会盯着副本方框）+ `npm run test:smoke`
   （`scripts/smoke/reveal-node.smoke.mjs`）。
   ✅ **`v9.0.13` 已做完**（验收：96 文件 + 32 文件全绿；`reveal-node.smoke.mjs` 新增两条见证）。
   ✅ **2026-10-13 合并时再收一层**：G10 的对外只剩 `core/ops/page.js:nodeAncestorsOf` 一个入口；
   同时把"面包屑"的主副页两份**合成同一个 `breadcrumbHtml`**（纯重构，行为逐字不变）。
2. **再统一约定**：G7（`markGoto` 收敛）+ G13（键盘可达）+ G14（复制键）。
   → 验收：`scripts/smoke/dedup-synth.smoke.mjs` 里的 `data-goto` 断言仍绿（或按选定的方案一起改）。
   🟡 **只做了 G7**（按用户的裁决：`markGoto` 唯一承载 + `data-goto`/`wireGotoLinks` 薄兼容，
   **不动那份冒烟断言**）；**G13 用户已拍板不做**；**G14 本轮判为不做**（见 §4 G14 的"为什么 + 最小替代"）。
3. **然后铺入口**（便宜且立刻可感）：G1（📋 + 🔎）、G6、G9（面包屑）、G4、G5。
   → 验收：`npm test` + `npm run test:smoke`；再手动在浏览器里把数据统计 / 概览 / 导入各点一遍。
   🟡 **`v9.0.13` 做了**：G1（两处 AC 列表）、G6、G4、G5 的 extKey 表、G9 的 AC 列表那一段；
   **`v9.0.14` 补上 G5 的记录表**（树上 id 用 `plan.records[*].nodeId`，新增行不画）；
   **仍未做**：G9 的统计其它子页 / 检索结果 / 判重五栏 / 比赛概览。
   ⚠️ AC 列表那一处**冒烟测不到**（DOM 桩不解析 `innerHTML`）⇒ 必须在浏览器里点一次才算数；
   `v9.0.14` 起这一类的**接线**由源码级守卫兜着（`src/test/nodeGroup.test.js` 的三条「源码级」源码锚：
   生成处要有承载 + 📋 入口、`ui/kit/nodeEntry.js` 只许用 `markGoto` 挂承载、
   AC 列表两处必须真的调 `appendNodeEntries`）—— 那只保证"接线还在"，**不保证"渲染出来真可点"**。
4. **最后做交互增强**：G2/G3（点柱/点行）+ 第 6 节第 5、9 条。
   ✅ **`v9.0.18` 做了第 5 条与第 9 条**（落点见 6.4：点柱 ⇒ 列在图表下面；`Ctrl`+📋 ⇒ 开而不激活），
   两处各有会红的冒烟断言（`ui-wiring.smoke.mjs`），红证见 `变更记录.md` 的 `v9.0.18` 那一段。
   ❌ **G3（账户对比的题目行 = 打开编辑弹窗）仍未做** —— 那会改掉既有语义，属产品决定。

**验收判据（不写数字，只写怎么核）**：
- `npm test` / `npm run test:smoke` 全绿（含 `src/test/docAnchors.test.js` ⑥ 对本文档指针的核对）。
- 手动核对清单（每加一处入口就跑一遍）：
  · 在**树模式**、**folder 模式**、**非主视图（如数据统计）**、**副页**四种情形下各点一次，看是否
    "切回主树 + 展开祖先 + 翻到正确页 + 滚到并高亮"；
  · 目标**被删 / 不存在**时，是"点了没反应"还是**没有渲染成可点**（后者才对）；
  · 副页节点行点 🔎 ⇒ 应**切到它所属的那个副页、再在页内定位**（`v9.0.17` 起；
    `v9.0.13` 写的"跳到它引用的主节点"是**旧行为**）；详页头部那颗「🔎 跳到它引用的主节点」仍跳主树。
    两种情况都**不能**出现"（就在根下）"这种假面包屑。
- `git status --short`：只多出你打算改的文件（**别把探针留下**）。

---

## 8. 残余与不确定项

- ★ **真浏览器实测的销账（2026-10-13，用户回报"良好"）**：下面这些以前写着"仍要人工点一次"的条目
  **已经点过、结果良好**，别再当未验项重复怀疑 / 重复做：**折叠全部**（文件夹模式 + `Ctrl` ⇒ 所有页回根，
  只闪一次）、点柱筛出来的那一批、`Ctrl` + 点击 📋（开而不激活）、热力图点格、记录表限行、
  副页节点行的 🔎 / 📋 / 面包屑、详页头部那串 id 蓝字。
  ⚠️ **本条不覆盖**（仍然没验）：`v9.0.15` 那处（extKey 面板两颗入口在浏览器里的响应）、
  G11 的"命中副本方框"严重程度复现、`v9.0.19` 的 ②（副页树模式专门夹具）、
  以及 `v9.0.18` 那条残余（副页 📋 走选择器时没有 `Ctrl` 语义 —— 那是**产品决定**，不是"没验"）。

- **`data-goto` → `data-reveal-node` 的收敛要不要动冒烟断言**：`v9.0.13` **已拍板走 (a) 兼容方案**——
  `markGoto` 同时挂 `data-reveal-node`（承载）与 `data-goto` / `dedup-goto`（兼容钩子），
  `wireGotoLinks` 退成只转发的薄兼容，**判重页那份冒烟断言一个字没动**。
- **"点柱筛出那一批"的落点已定（`v9.0.18`）：列在图表下面**，分档口径收成
  `ui/stats/statsCharts.js` 的 `xcpcBucketOf` / `cfBucketOf` **一份**（图与明细共用）。
  ⚠️ **它没有落到「题目检索」页**：跨层"带条件打开检索"没有通道（`viewState` 是 `features/ProblemSearch`
  模块私有的，而统计侧是 `ui/`、反向 import 插件是错的方向）⇒ 要那条路得先定通道，
  **别在 `statsCharts.js` 里再写一套筛选**。残余：明细里的题是 `innerHTML` 渲染的，冒烟桩里
  只验得到"容器 + 条数"（"行真的画出来"要人工在浏览器点一次）。
  ✅ 2026-10-13 用户已实测"点柱 ⇒ 那一批列出来"（见本节开头销账）。
- **`Ctrl+点击` 的语义已定（`v9.0.18`）：只在 📋 那一颗上判，`Ctrl`+点击 = 开而不激活**。
  ⚠️ **残余（✅ 用户 2026-10-13 明确：已知道、是对的、不必再提）**：副页节点那颗 📋 走的是"看哪个"
  选择器（`showInfoTargetSelector`），选择器本身没有"激活 / 不激活"这个概念 ⇒ 走选择器那一支
  （含"看副页节点自己"）**仍会切过去**；只有 `refId` 直接命中那一支带 Ctrl 语义。
  要改就得先给选择器定一个"选完之后激活不激活"的参数（产品决定）—— **这条到此为止，别再当待办汇报**。
- **⚠️ 新增的"限行"类默认值要跟着冒烟里那个字面量一起改**（`v9.0.18`）：
  `features/AutoImport/ui/recordTable.js` 的 `AI_RECORD_LIMIT`（默认 250）与
  `scripts/smoke/auto-import.smoke.mjs` 里那个**写死的 250** 是成对的 —— 断言故意不复用常量
  （复用的话"把上限改大"这条会跟着变绿，实测过是假守卫）。改上限 = 改两处，这是**刻意的手续**。
- **G11 的"真浏览器复现"——判定为「不做」，账已结**（用户 2026-10-13 授权由我判断）：
  · **已有可执行证据（且验过会红）**：`scripts/smoke/reveal-node.smoke.mjs` 的 G11 那组 ——
    桩上把同 id 的副本方框放进**非主树容器**，要求 `revealNode` 返回 `false` **且副本不许被高亮**；
    `变更记录.md` 里记着红证（把 `findNodeBox` 回退成全文档 `querySelector` ⇒ 当场红，`期望 false，实际 true`）。
  · **为什么不再补真机复现**：判据现在是**结构性的**（只查 `#tree-body` / `#folder-stats` 两格 + 要求
    归属属于目标那一页）⇒ **副本在别处就取不到**，不是"概率小了"；真机复现只能通过**先把代码改回旧写法
    来演示旧病**（那是在重新引入病根，不是验证修复），而它能多提供的信息仅剩"浏览器滚的是哪个元素"，
    这一点已由"只查两格"决定，没有分歧空间。
  · ⇒ **不要**为它加夹具、也不要再把它列成欠账；要回归就直接跑那条冒烟（它红了 = 有人把范围放宽了）。
- **`ui/G_modal/G2_selector.js` 的选择器方框**与主树方框**共用 `renderNodeBox`**：以后任何"给方框加交互"
  的改动都会**同时**作用在这里 ⇒ 落地时要专门回归一次选节点弹窗（本次只做盘点，没改）。
- **`features/AutoImport/ui/failures.js` / `progress.js`** 按判据（第 1 节）不属于"节点行"，
  但没有逐个函数细读，**若其中有节点级条目，第 3.8 节的表要补一行**。
- **内联入口条的守卫只到"源码"这一层**（`v9.0.14` 加）：`src/test/nodeGroup.test.js` 的三条源码级断言
  钉的是"生成处还有没有那份接线 + 调用点还在不在"—— **它不是"渲染出来真的可点"的证据**
  （DOM 桩不解析 `innerHTML`，那正是它存在的理由）。新铺一处入口条，仍要**在浏览器里点一次**才算数。
- **DOM 桩不解析"逗号选择器"**（`v9.0.15` 记）：`scripts/smoke/dom.mjs` 的 `closest`
  把 `.a, .b` 当成"同时有这两个类" ⇒ 恒 null。**任何"只被容器上某条逗号选择器委托接住"的接线，
  在冒烟里都是空转**（`ui/G_events.js:onActionClick` 就是这种）。⇒ 新入口**必须接在
  `closest` 能认的选择器上**（单类 / `[data-*]`），否则"点了没反应"不会有断言会红
  （`v9.0.15` 的 extKey 面板就是这么漏过去的）。
- **本轮的修法没能在真浏览器里复核**（`v9.0.15`）：本机沙箱起不来 Chromium
  （Chrome / Edge 都崩在 `mojo\...\platform_channel.cc: Check failed: 拒绝访问 (0x5)`，
  `--single-process` 同样），可执行证据只有 DOM 桩里的新断言 ⇒
  "extKey 面板那两样在浏览器里到底响不响应"**仍要人工点一次**。
- **记录表的两个新入口没在真包上量过开销**（`v9.0.14`）：那一页在真包上可能几万行
  （实测一次导入 24712 条跳过），每行多两个元素是**增量**成本；桩上的耗时不算界面性能，
  要核就得在真包 + 真浏览器里量「载入预览」那一步。
  📏 **2026-10-13 已量（真包，`scripts/recordtable-bench.mjs`）**：这两颗入口的**增量**成本量不出差别
  （真包量级的行数下，铺表这段本来就是几十毫秒级），于是顺手量出下面这条**更值钱**的结论 ——
  **"限行"原先只省挂行、没省建行**：`renderRecordTable` 先把全部行 `createElement` 出来再 `slice`
  ⇒ 只摆 250 行的对照 ≈ 0ms，全量那一遍 ≈ 75ms（**建行占 99%**）；"显示全部"在桩里只要 1~2ms
  （桩的 `appendChild` 只是 push），真代价是 **2.7 万元素 / 十几~二十几 MB** 的浏览器布局绘制。
  ✅ **当天已改成"先切、再建"**：默认限行 **75ms → 2ms**，"显示全部"那一次才付 ~71ms；
  守卫口径 = bench 打出的「默认限行/对照」比值（改前 75×、改后 ≈1×）。机制笔记在
  `src/features/AGENTS.md` 的 AutoImport 那节，跑法与口径在 `scripts/recordtable-bench.mjs` 文件头。
  **仍未量**：真浏览器里的解析/布局/绘制 —— ✅ *2026-10-13 用户实测：「显示全部」在真包量级下**极快***，这一项不必再量。
- **详页头部那串节点 id 现在也是入口**（`v9.0.16`）：`ui/nodeinfo/nodeInfoView.js:buildShell` 里
  `.nodeinfo-node-id` 那一格，`mainTreeNodeIdOf` 解析得出就画成蓝链接（`#1d4ed8` + 下划线，
  `markGoto` 挂的唯一承载），解析不出（副页根 / 节点已删）**保持灰的纯文本**。
  可执行证据是 `ui-wiring.smoke.mjs`（正：真实节点 `cA`）与 `nodeinfo-target.smoke.mjs`
  （反：副页根 `v_root`）里的那几条 —— 但**"点了真的滚过去"仍没在真浏览器里点过**
  （沙箱起不来 Chromium，同 `v9.0.15` 那条）。
  ✅ 2026-10-13：用户已实测"蓝字可点、点了会跳"（见本节开头销账）。
- **副页的节点行入口**（`v9.0.19`，G15）的残余：
  ① **真浏览器没点过**（同 `v9.0.15` / `v9.0.16` 那两条）：冒烟里那一行入口条是**手工摆的同形元素**
     （明细里的方框来自 `renderNode(...,'readonly')` 的 `innerHTML`，桩不解析）⇒
     "在真包、真浏览器里点一次副页统计明细的 🔎/📋/面包屑"仍要人工做。
     判据（浏览器里）：点 🔎 ⇒ 切到那个副页并高亮那道题；点 📋 ⇒ 先弹"看哪个"、选"副页节点本身"
     ⇒ 开出 `🔍 副页节点：…` 那个页签；面包屑第一段是「🏠 根目录」。
     ✅ 2026-10-13：用户已实测这三样（见本节开头销账）。
  ② **副页树模式**（`virtualFolderMode` 的 tree 模式）走的是同一条 `renderSegmentDetail`
     ⇒ 已一并修好，但**没有专门夹具**；页内**多级**祖先链（>2 段）只有纯 Node 那两条用例。
  ③ 副页那一支的 📋 走"看哪个"选择器 ⇒ **`Ctrl`+点击在那里没有"开而不激活"的语义**
     （与 `v9.0.18` 记的同一条残余，本次没改）。
  ④ `core/ops/page.js:virtualAncestorsOf` 是**新加的口**（不在 `docAnchors` 的「唯一实现」名单里）：
     它现在只有一处定义（`ui/revealNode.js` 里那个私有的已改成转发）。要不要把它加进
     `src/test/docAnchors.test.js` 的 `SINGLE_SOURCE` 是**另一个决定**（本次没加，避免叠测试）。
- **主副页合并成同一个函数的残余**（2026-10-13 合并，**纯重构、行为逐字不变**）：
  ① **证据来自既有断言**（没有新加断言）：**主树那一支** ⇒ `scripts/smoke/nodeinfo-target.smoke.mjs` 的
     「★ 主树节点那条入口条**逐字不变**」（整串 HTML 逐字比对，含 `nig-crumb` / `data-reveal-node`）；
     **副页那一支** ⇒ 同一份冒烟的 ③（`vnode-crumb`、不含 `nig-crumb`、`📄 页名`、首段是页内根）
     与 `src/test/nodeGroup.test.js` 里那两条（页内 id 链 / 页内根·认不出·断链 ⇒ 不画）。
  ② **`nodeAncestorsOf` 不进 `docAnchors` 的「唯一实现」名单**：它是**分流入口**，两棵树各有一份实现，
     按那份名单"全仓只许一处定义"的口径**加进去会误报**。
  ③ **G12 的热力图委托没有自动断言**（见 §4 G12）：`scripts/smoke/` 里没有热力图的夹具，
     "点一格还能把那天列出来"仍要人工在浏览器里点一次。
     ✅ 2026-10-13：用户已实测（见本节开头销账）。
- **`jumpTargetOf` 的"树上真有"这半条是 `v9.0.14` 才与另两处对齐的**：改前它对"树上已没这个节点"的 id
  也会 `canJump: true`（能走到它的路径上节点必然在树上，所以实际打不到）。若哪天有人要在
  "节点刚被删、详页还开着"的场景给入口，这里的行为是"不给"（那是刻意的）。
