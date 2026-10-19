# 副页与主树对齐（对齐 / 屏蔽 / 仪表盘）

> 用户 2026-10-15：「新爬的比赛/题目/提交进不了副页。在副页需要剔除若干子树（比如我只保留了 22~26 年）时显得更棘手」
> 补充一：「副页节点增加可编辑的『屏蔽』字段；与主树对齐时，走到屏蔽的节点就不会递归」
> 补充二：「副页需要一个仪表盘，用来装副页的全局操作」
> 补充三（看过实物之后 2026-10-15）：「1. 屏蔽请默认折叠；2. 屏蔽的部分**不参与任何统计**；
> 3. 副页增加『**不显示屏蔽的部分**』字段，选中时屏蔽的部分**不渲染**」
>
> ✅ **已实现**（`v9.4.13` / 三条补充在 `v9.4.14`；**子节点顺序纳入"与主树一致"在 `v9.4.18`**，用户 2026-10-16）：口径以本文为准，实现落 `core/ops/page.js`
> （`syncPageWithTree` / `setVNodeBlocked` / `setPageHideBlocked`）+ `core/model/page.js:childVNodesOf`
> （"屏蔽"的**唯一判据**：统计无条件跳过、渲染看 `page.hideBlocked`）+ `view/helpers.js:blockedButtonHtml`
> （节点上那颗 🚫）+ `ui/folder/pageDashboard.js`（仪表盘 + 默认折叠的清单）+ `ui/G_pageUI.js`（文档级委托）。

## 副页对齐

> ⚠️ 这一节的名字是**指针锚点**：`src/ui/AGENTS.md` 写的是"见 `docs/subpage-sync.md` 的「副页对齐」一节"，
> `src/test/docAnchors.test.js` 会核这一节真在 ⇒ **别改标题**（要加内容就往下面加小节）。
> 结论先给一句：**副页是快照；"对齐"是一个显式动作（只加不删），"屏蔽"是这条支上的停止标记**。

### 1. 现状：副页是快照，主树长了它不知道（有据，别猜）

| 事实 | 证据 |
|---|---|
| 副页 = 一棵**快照树**：`page.virtualIndex`（vNode）+ `children`（顺序）+ `refId`（指回主树真实节点） | `core/model/page.js:createPage/createVNode` |
| **显示/统计只走快照**：顺着 `vNode.children` 递归，**从不读主树的 `childOrder`** | `view/dataAdapter.js:188-247`（`buildVirtualNodeRealData`） |
| 只有**两个手工入口**写副页：复制节点（"递归复制子节点"默认勾）、挑题加入（同样默认勾） | `ui/G_modal/G4_copy.js`、`ui/G_modal/G5_todoSheet.js` → `core/ops/page.js:copyRealNodeToPage/batchCopyToPage` |
| **导入 / 爬取那边一个字都不碰副页** | 全仓 grep：`copyRealNodeToPage` 只被那两个 UI 调；AutoImport / upsert 不 import 它 |
| 下游代价：**训练计划的题集 = 副页池子 ∩ …** ⇒ 副页不更新，计划也看不到新题 | `core/trainingPlan.js:706-713`（池子 = 副页里引用到的全部真实 P） |
| ⚠️ 另一个形状（与"新爬的"无关）：**合成节点在副页里没有成员** | `view/dataAdapter.js:143-146`："成员引用**不算子节点**" |

⇒ 「新节点进不了副页」**不是 bug，是这套模型的必然**：副页是那天拍下的照片。

### 2. 三件东西

#### ① 🔄 与主树对齐（`core/ops/page.js:syncPageWithTree(draft, pageId)`）

**规则（唯一一处判据）**：从页根往下走**页里已有的每个 vNode**；走到哪就把它"主树里还有、页里还没有"的**孩子整棵**补进来；
**只加不删**；**同级顺序按主树的 `childOrder` 排**（用户 2026-10-16：「与主树一致」要**纳入子节点顺序**）；
**幂等**；新补进来的节点**默认不屏蔽**（继续正常往下补）。
⚠️ 顺序的判据（唯一一处见 `core/ops/page.js:syncPageWithTree` 里的 `orderByTree`）：
- ① 先找这一层共同的**主树父**：普通 vNode ⇒ 它自己的 `refId`；**页根（`type === 'O'`）**⇒ 孩子的
  `parentOf` 必须**只有一个值**（混了不同父 ⇒ 没有"主树顺序"可对 ⇒ 不排）；
- ② 有父就**排**：按那个父的 `childOrder` 的**相对顺序**；主树里**已经没有**的（对齐**只加不删**
  所以还留着它）**垫到末尾**，彼此的相对顺序不变；
- ③ 顺序也**幂等**。
- ⚠️ **不要**再加"必须是主树那层的子集才排"那道门 —— 试过（用户 2026-10-16 同时看过两版）：
  页里只要有一个主树已经不认识的节点，那一层就**整层不排** ⇒ 生效范围明显变窄；
  用户定稿："**之前那版生效范围最广，要那版**"。

```
walk(vId):
  v = page.virtualIndex[vId]
  if v.type !== 'O' and v.syncBlocked: return          # ★ 屏蔽：这一支到此为止（已有的一个字不动）
  if v.type === 'O': for cid of v.children: walk(cid); orderByTree(v); return
  if !v.refId: return
  for cid of draft.childOrder[v.refId] || []:
      kid = 页里已有的、refId === cid 的那个孩子
      if kid: walk(kid.id)                             # ★ 已有的孩子**继续往下走**（否则已有的 P 下面新 R 补不进来）
      else:   id = 递归复制那一棵（复制进 vId 下、追加在末尾）；added += 数；walk(id)  # 新支继续走（新节点不屏蔽）
  orderByTree(v)                                       # ★ 补完**再排**：这一层按上面 ①②③ 摆正
返回 { added, blocked, visited, reordered, nodeCount } # blocked/reordered 都只为报数（谁也不按它们分支）
```

- 过只读守卫 `assertManualEditAllowed(draft, '与主树对齐')`（与 `copyRealNodeToPage` 对称）；
- 页面级**不需要**再来一个"跟随主树"开关：**对齐这个动作本身就是"要不要跟"**，范围 = 页里已有的节点 − 屏蔽以下。
- 语义要写在界面上：**"对齐 = 让这些支与主树一致（只加不删、同级顺序也跟主树）—— 你手删过的后代会回来"**（像 `pull` 把你删掉的文件带回来）。

#### ② 🚫 屏蔽（vNode 上的一个可编辑字段）

- 字段：`vNode.syncBlocked`（缺省 `false` ⇒ 老数据与今天的行为**一个字节不变**）。
  ⚠️ 名字取 `syncBlocked` 是因为**它只管对齐**（不是"不显示"、也不是"删除"）。
- 语义（**一句话**）：**对齐走到这里就不再往下递归**；这一支**已有的内容不增不减**。
- **★ 屏蔽的支不参与任何统计**（用户 2026-10-15："屏蔽的部分不参与任何统计"）：判据**只有一处** ——
  `core/model/page.js:childVNodesOf(page, vNode, 'stats')`（默认那档**无条件**跳过被屏蔽的支）。
  两个消费者都改用它：`view/stats.js:virtualSubtree`（副页总览统计 / 详页分布 / 插件那一侧）
  与 `core/trainingPlan.js:walkVirtual`（**计划题集**的池子）。⇒ 屏蔽一支 = 那几道题既不进统计、也不进题集。
- 可编辑的入口：**副页节点框上那颗按钮**（只对副页节点出现）。
  ⚠️ 节点框按钮的**唯一实现**是 `view/helpers.js:buildActions(state, node, index, parentArray, isVirtual, mode, disabled, currentFolderId)`
  —— 它已经收 `isVirtual` ⇒ 加一颗"只在 `isVirtual` 且非根"出现的按钮，**不新增第二套渲染**。
  按钮本身就是状态：`🚫` = 已屏蔽 / `○` = 未屏蔽（title 写清"对齐时不再往下"）。
- **仪表盘上的清单默认折叠**（用户 2026-10-15："屏蔽请默认折叠"）：`▸ 🚫 已屏蔽 N 处`，
  点开才列（折叠状态住在 `pageDashboard.js` 的模块变量里 —— 它是临时界面状态，不进数据、不进 `state.view`）。
- 落点（新字段必须同步的三处）：`core/model/page.js:createVNode` 给缺省、`core/ops/page.js:duplicatePage`
  逐字段搬运那一圈（`expanded/currentPage/selected` 旁边）加一行、`pluginRegistry` 的 vNode 迁移可给老数据兜底。

#### ③ 🎛 副页仪表盘（全局操作的家 + 「不显示屏蔽的部分」）

- **位置**：副页**页头一块常驻**（像计划栏那样**只在副页出现**，不是弹窗；弹窗留给出错/确认）。
- **装什么**：
  - 概况：这一页的 C/P 计数（现成的 `getVirtualGlobalStats`，**已按"屏蔽不参与统计"算**）、节点数、屏蔽数；
  - 全局操作：**🔄 与主树对齐** · ⧉ 复制副页 · ✎ 重命名 · ✖ 删除副页；
  - 屏蔽：**默认折叠**的 `🚫 已屏蔽 N 处` 清单（点开能**跳过去** / 一键取消屏蔽）；
  - **「不显示屏蔽的部分」勾选框**（页级字段 `page.hideBlocked`，用户 2026-10-15）：
    勾上 ⇒ 被屏蔽的支**不渲染**（`view/dataAdapter.js` 走 `childVNodesOf(..., 'render')`）；
    ⚠️ 它**只管渲染** —— 统计那半边是**无条件**排除的，与这个开关无关；`page.hideBlocked` 缺省 `false`。
  - 一句口径提示（"对齐只加不删"）。
- ⚠️ **与 tab 上那两颗 `⧉`/`✖` 的关系**：**收进仪表盘**（tab 上不再留）——
  同一件事两处入口正是 `v9.4.9` 删掉的那类问题。`scripts/smoke/page-duplicate.smoke.mjs`（17 项）跟着改口径。

### 3. 边界

1. **只读**（"只看别人"）时：对齐与屏蔽按钮**不给**（过不了守卫就别画成能点）。
2. 页不存在 / 页里没有可走的节点 ⇒ 如实报（别静默成功）。
3. 单次补进来的节点数**要报数**（两万多节点的一次错误对齐要看得出来）；真要做上限保护，也在这一层。
4. **不动** `copyRealNodeToPage` / `batchCopyToPage` 的语义：**复制与挑题不认屏蔽**（人是显式要拷的）。

### 4. 不做的（写下来免得以后当成"漏了"）

- ❌ **不自动对齐**（导入/爬取后不碰副页）：导入是"数据进来"，副页是"你的工作范围"；自动一次就会把手删的补回来。
- ❌ **不把副页改成规则型**（`page.rule = {roots, excludes}`、渲染时现算）：那要推翻 vNode/refId/顺序/复制/计划这一整套，
  你手排的顺序也会失去意义。
- ❌ **对齐不删**：主树那边"没了"（多半是重出包换了 id）**不动**你的副页。
- ❌ 屏蔽 ≠ 隐藏 ≠ 删除（一个字段一个意思）。

### 5. 判据（要能红的）

**单测** `src/test/pageSync.test.js`：
1. 只加不删：对齐前后**已有的 vNode id 集合不变**（一个都没被删/换）；
2. **同级顺序跟主树**：有**共同主树父**就按主树 `childOrder` 摆正（页根那层要求孩子来自同一个
   主树父）；主树里**已经没有**的**垫到末尾**；再对齐一次 `reordered === 0`；
3. 幂等：连对两次，第二次 `added === 0`（且 `reordered === 0`）；
4. **屏蔽生效**：屏蔽一个中间 vNode ⇒ 它下面**不再补**（而同层别的支照补）；
5. 屏蔽**不吃已有的**：屏蔽前后那一支的 vNode 集合逐个相同；
6. 老数据缺 `syncBlocked` ⇒ 读作 `false`（行为与今天一致）；
7. `duplicatePage` 把 `syncBlocked` 一起搬；
8. 只读时抛（`assertManualEditAllowed`）；
9. 已有的中间节点也会往下补（"已有的 P 下面的新 R 补得进来" —— 这条最容易写错）。

**冒烟** `scripts/smoke/page-sync.smoke.mjs`：
10. 仪表盘在副页出现、在主页不出现（与计划栏同一条规矩）；
11. 点「🔄 与主树对齐」⇒ 报"补进 N 个"（桩里数 `virtualIndex` 增量）；
12. 点节点上那颗 `🚫` ⇒ 状态翻转、写进数据；再点对齐 ⇒ 那一支不补；
13. 只读模式下两颗按钮不给（画成灰的或干脆不画 —— 与既有条一致）。

### 6. 待拍板（✅ 全部按"建议默认"拍板了，`v9.4.13`）

| # | 问题 | 结论 |
|---|---|---|
| ⑴ | 「屏蔽」是"只停对齐的递归"还是"连显示也藏" | ✅ **只停对齐**（"藏起来"是另一件事，没做） |
| ⑵ | 字段名 | ✅ **`vNode.syncBlocked`** |
| ⑶ | 仪表盘与 tab 上 `⧉`/`✖` 的关系 | ✅ **收进仪表盘**；tab 上**不再有**那两颗（`page-duplicate.smoke.mjs` 已改口径） |
| ⑷ | 仪表盘是常驻一块还是弹窗 | ✅ **常驻一块**（`#page-dashboard`，`renderPageTabs` 建槽、`refreshCurrentPage` 填；主页隐藏并清空） |
| ⑸ | 屏蔽清单要不要给"跳过去" | ✅ **要**（名字上挂 `data-reveal-node`，走现成的 `REVEAL_NODE`） |

### 7. 实现时踩到 / 顺手修掉的四处

1. **`copyRealNodeToPage` 递归时 `draft.childOrder[real.id]` 没有 `|| []`** ⇒ 一个缺条目的节点会让
   **整趟对齐回滚**（`undefined is not iterable`）。缺条目 = 没有子节点，不是错误 ⇒ 已补 `|| []`。
2. **页根 `type === 'O'` 没有 `refId`** ⇒ `walk` 必须在根上"顺着已有的孩子走"（这也是
   "页里没有的那几支永远不进来"的判据 —— 第一版就是在这里返回早了，一个都没补）。
3. **节点按钮那条委托用的是逗号选择器**（`.btn-icon, .toggle-btn, .pagination-btn`）⇒ DOM 桩不解析
   ⇒ "点 🚫"在冒烟里**永远不触发**（断言会空绿）。已按本仓既有约定**拆成三次 `closest`**
   （`G_pageUI.js` 那三颗小按钮同一条规矩），现在 `page-sync.smoke.mjs` 能真点到它。
4. **槽位只建不删 ⇒ 仪表盘一层摞一层**（用户 2026-10-15 看图："渲染触发多次"：页面上叠了 4 块）：
   `renderPageTabs()` 每次都会建一个 `#page-dashboard`，而它只 `remove()` 了 `#page-tabs`。
   判据：`page-sync.smoke.mjs` 的「重画多少次都只有一块」（连着重画两次，`.page-sync-btn` 只许有 1 个）。
