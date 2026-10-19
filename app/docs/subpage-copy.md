# 副页复制（整个副页复制一份）

> 用户 2026-10-13：「新的任务:副页复制 / 整个副页复制」。
> 这一篇是**动手前的设计稿**：先写清"复制一份副页"到底复制哪些字节、哪些不复制、以及为什么。
> 口径定了以后，实现放 `core/ops/page.js:duplicatePage`（写）+ `ui/G_pageUI.js`（入口）。

## 副页复制

> ⚠️ 这一节的名字是**指针锚点**：`src/ui/AGENTS.md` 里写的是"见 `docs/subpage-copy.md` 的「副页复制」一节"，
> `src/test/docAnchors.test.js` 会核这一节真在 ⇒ **别改标题**（要加内容就往下面加小节）。
> 结论先给一句：**复制 = 同一批题（`refId` 原样）+ 一份新的排布（页内 id 全部重发）**；
> 计划不跟着复制；复制完自动切到新页。

### 0.1 实现与判据（一眼看）

| 在哪 | 是什么 |
|---|---|
| `core/ops/page.js:duplicatePage(draft, sourcePageId, newName)` | 唯一一份实现（只读守卫 / `MAX_PAGES` / 命名 / id 重发都在里面） |
| `core/ops/_helpers.js:nextPageId` / `nextVirtualRootId` | ⚠️ 带**自增序号**（同一毫秒连建两页不许撞 id —— 这是老 bug，复制让它容易触发） |
| `ui/G_pageUI.js` | tab 上 `⧉`：普通点击直接复制；**Ctrl+点击**先问新名字 |
| `src/test/pageDuplicate.test.js`（7 条） | 字节级口径（结构 / id / 视图态 / 源页不动 / 命名 / 边界 / 守卫） |
| `scripts/smoke/page-duplicate.smoke.mjs`（17 项） | UI 接线（入口 / 切换 / 零重合 / 只读不崩） |

## 1. 现成的东西（先核名字，别自造）

| 要做的事 | 现成的那一份 |
|---|---|
| 副页形状 | `core/model/page.js:createPage(id, name, rootId, timestamp)` → `{ id, name, rootId, virtualIndex, vNodeStats, createdAt, lastModified, selected }` |
| 虚拟节点形状 | `core/model/page.js:createVNode(id, refId, type, parentId)` → `{ id, refId, type, children, parentId, expanded, currentPage, selected }` |
| 新 id | `core/ops/_helpers.js`：`nextPageId()` / `nextVirtualRootId()` / `nextVirtualId()` |
| 只读守卫 | `core/ops/account.js:assertManualEditAllowed(draft, '…')`（**每个改结构的入口都要过**） |
| 重名规避 | `core/ops/_helpers.js:ensureUniqueName(draft, parentId, name)`（那是**主树同级**的重名；副页名是全局唯一，规则见 §4） |
| 上限 | `A_constants.js:MAX_PAGES = 50`（**新建副页**那条路在 UI 里判；复制也算新建，必须同样判） |
| 复制真实节点进副页 | `core/ops/page.js:batchCopyToPage` —— ⚠️ **不是这个任务的工具**：它复制的是"**真实节点**"（另一个维度），本任务复制的是**副页自身** |
| 入口位置 | `ui/G_pageUI.js:renderPageTabs()`（tab 上的 ✖ 就在那儿）+ `setupPageTabsEvents()`（✖ 的委托在那儿，复制照它的形状写） |
| 删除的确认框 | `ui/G_modal/G_modals.js:showDeleteConfirm` / `showToast` |

**一句话**：本任务要新增的只有 **① `duplicatePage`（core，纯函数式改写 draft）** 与 **② 两个入口**（tab 上的按钮 + 事件委托）。

## 2. 复制哪些字节（定稿）

设源副页 `P`（`P.virtualIndex` 里以 `P.rootId` 为根的一棵树），复制出的新副页 `Q`：

| 源 | 目标 | 说明 |
|---|---|---|
| `P.name` | `Q.name` | 走 §4 的命名规则（不是原样搬） |
| `P.virtualIndex` 的**整棵树**（含根） | `Q.virtualIndex` | **结构逐字保留**：父子关系、`children` 顺序、`refId`、`type` |
| 每个 vNode 的 `expanded` / `currentPage` / `selected` | 同名字段 | 「整个副页复制」= **内容 + 看它的状态**一起搬（展开哪几层、翻到第几页、圈了哪几圈）。⚠️ 若只想要"内容一样、状态归零"，那是一个**开关**（见 §5 ⑵） |
| `P.selected`（tab 上的圆圈） | `Q.selected` | 同上 |
| `P.vNodeStats` | `Q.vNodeStats` | 派生缓存，复制（复制后第一帧就不必重算） |
| `P.createdAt` | `Q.createdAt` | **不搬**：新页的 createdAt 就是现在（它是"这一页什么时候建的"） |
| `P.lastModified` | `Q.lastModified` | 现在 |

**所有 id 都要重发**：
- `Q.id = nextPageId()`、`Q.rootId = nextVirtualRootId()`；
- **页内每个 `v_xxx` 都要换新**（`nextVirtualId()`）—— 靠一张 `oldId → newId` 的映射表一次成型**建第二遍**，
  父子关系按映射重连（**不许复用旧 id**：`locateVirtualNode` 按"全局唯一"找页，复用会让两页互相认领）。
- `refId`（指向**主树真实节点**的指针）**原样保留**：复制副页**不复制真实节点**，
  两页于是指向**同一批题**（这正是"复制题单"想要的效果；要"另存一份题"是另一个任务）。

**不搬的**：
- 视图态 `view.pages[id]`（每页翻到第几页那份，`core/model/viewState.js`）；
- UI 运行态 `virtualFolderState[pageId]`（`ui/folder/virtualFolderMode.js` 的
  `currentId/path/view/currentPage`，仅内存）—— 新页从"根目录、第 1 页"开看；
- **训练计划（`state.plans`）不复制**：计划与副页是"多对一"（`plan.pageId`），复制副页**不动**任何计划
  （删副页也是这个口径：计划留着并提示）。要做"连计划一起复制"= 另开一条路（§5 ⑶）。

## 3. 边界与守卫

1. **只读守卫**：`assertManualEditAllowed(draft, '复制副页')`（与 add/delete/rename 完全对称）。
2. **上限**：`Object.keys(draft.pages).length >= MAX_PAGES` ⇒ 抛 `副页数量已达上限（N个）`（**与新建同一条**）。
3. **源页必须存在**：不存在 ⇒ 抛 `副页不存在`。
4. **空副页**（只有根）也允许复制（得到另一个空页）—— 不特殊拦（如实复制）。
5. 返回值：新副页对象（UI 拿 `page.id` 去 `draft.currentPageId = page.id` 并刷新），
   **顺带回报一句人话**（复制了几个节点）给 toast 用。

## 4. 名字怎么起

- 默认 = 原名 + `副本`（`我的题单` → `我的题单副本`；已是副本 ⇒ `我的题单副本副本`，**不猜**"副本2"这类语义）。
- 重名（副页名**全局唯一**，见 `addPage` 的检查）⇒ 依次试 `…副本2`、`…副本3`……直到空闲（与
  `ensureUniqueName` 同一个"数字往后找"的形状，但那是主树同级的规则，**别硬套**，这里只借形状）。
- UI 上允许改名（按 **Ctrl+点击复制按钮** ⇒ 先弹一个"新副页名"输入框；普通点击 = 直接用默认名）。
  ⚠️ 与 ✖ 删除的"必须按 Ctrl"**不是同一件事**：删除的 Ctrl 是**防误删**，复制的 Ctrl 是**要改名**。
  为免混淆：普通点击复制也**要确认一下**（不是破坏性操作，一句 toast 即可，不弹框）。

## 5. 待拍板（我给建议默认；你只挑不同意的说）

| # | 问题 | 我的建议默认 |
|---|---|---|
| ⑴ | 复制后**自动切到新副页**还是留在原页 | **自动切过去**（复制出来就是为了用它；与"新建副页"一致） |
| ⑵ | 展开态 / 页码 / 圈选 这**三样视图态**要不要一起复制 | **一起复制**（"整个副页复制"字面就是全都要）；要"归零"就改成不复制这三样 |
| ⑶ | 绑在这个副页上的**训练计划**要不要一起复制 | **不复制**（与"删副页不动计划"同一口径）；要复制得先答"计划名怎么起、目标要不要跟着" |
| ⑷ | 复制按钮放哪 | tab 上 ✖ 的**左边**（`⧉`），只在**属性编辑模式**下出现（与 ✖ 同条件，别在浏览态堆按钮）；Ctrl+点击 = 改名复制 |

## 6. 判据（要能红的）

### 单测（新文件 `src/test/pageDuplicate.test.js`）
1. 结构逐字：源页有 N 个 vNode ⇒ 新页 N 个；**父子关系与 `children` 顺序**逐条相同（按映射比对）。
2. **id 全换新**：新旧 `virtualIndex` 的 key 集合**无交集**；`rootId` 也换；
   但 `refId` 集合**完全相同**（指向同一批真实节点）。
3. 视图态三样（`expanded`/`currentPage`/`selected`）按 §5 ⑵ 的决定逐条比对。
4. `P` 一个字没动（复制是**只读源**）：深比较源页前后。
5. 名字：`A` ⇒ `A副本`；已有 `A副本` ⇒ `A副本2`。
6. 边界：源页不存在 ⇒ 抛；到 `MAX_PAGES` ⇒ 抛；空副页也能复制。

### 冒烟（`scripts/smoke/page-duplicate.smoke.mjs`，新文件）
7. tab 上出现复制按钮（属性模式），点击 ⇒ 新副页出现、tab 数 +1、**新页里节点数与源页一致**、
   且 **`draft.pages[源].virtualIndex` 里的 id 一个都没出现在新页**（防"复用 id"回归）。
8. 普通点击不弹框；Ctrl+点击 ⇒ 弹"新副页名"输入框（桩里断言弹窗被调起 + 名字生效）。

## 7. 不做的（写下来免得以后当成"漏了"）

- ❌ **不复制真实节点**（两页指向同一批题）。
- ❌ **不复制训练计划**（§5 ⑶）。
- ❌ **不复制"另一个副页的引用"**：副页里的 vNode 只指向真实节点，副页套副页在本仓**不存在**这种形状。
- ❌ **不改删除/新建的既有行为**（复制只是多一个入口，别顺手重构那一摊）。
