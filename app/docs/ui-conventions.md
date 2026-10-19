# UI 层的约定与坑（从 `src/ui/AGENTS.md` 搬来）

> ★ `src/ui/AGENTS.md` 是**每次会话自动注入**的 ⇒ 那里只留"**链接 + 一句性质**"；
> 细节（症状 → 病根 → 判据）全在这一篇。**改到哪一节，先看那一节**。
> 这些条目都是当时真踩过才写的，**别删**。

## 1. 重画走哪条入口


- **重画走既有入口**：`G_pageUI.js` 的 `refreshCurrentPage`；判重页是 `tabs.js` 的 `scheduleDedupRefresh`
  （**延迟一拍**、60ms 合并）。**别自己再派发一遍刷新**（那才是"刷新跑两遍"的老毛病）。

## 2. 视图态住 `state.view`（展开 / 页码 / 折叠全部）


- **视图态（展开 / 页码）住 `state.view`，不许放回 `nodes`**：折叠/翻页一旦换了 `nodes` 引用，
  所有"按代"缓存整片作废（`viewState.js` 的真源是 localStorage）。
- **「折叠全部」的范围语义**（`v9.0.20`）：**不带 Ctrl = 只折当前页**（`AppState.currentPageId`，`'main'` = 主树）、
  **带 Ctrl = 所有页**；⚠️ **副页的展开态不在 `view.expanded`**，走 `core/ops/view.js:setVirtualNodeExpanded`。
  ⚠️ **回根 = 一次刷新，别按页循环**（`v9.0.20` 补）：`ui/folder/virtualFolderMode.js` 的
  `goToVirtualRoot(pageId)` **每调一次派发一次** `UI_REFRESH_REQUIRED` ⇒ 循环 N 个副页就是 N 次重画。
  批量的唯一入口是同一个文件的 `goToAllVirtualRoots(pageIds)`（内部逐个写、末尾**只**派发一次）；
  单个要静默就传 `{ refresh: false }`（主树回根 `folder/folderMode.js:goToRootFolder` 同样收了 `{refresh}`）。
  判据：「折叠全部 + Ctrl」在文件夹模式下**只看见 1 次重画**，与页数无关（改前是 1 + N 次）。
  ⚠️ 顺序要紧：**先静默写状态（主树 + 各页）、末尾才由批量口派发那唯一一次** —— 反过来就又变成两次。
  ✅ **守卫**（两个文件合起来才是"这颗按钮全覆盖"，别在其中一个里重抄另一份）：
  `scripts/smoke/collapse-all.smoke.mjs` 管**文件夹模式分支 + 刷新次数**（数 `UI_REFRESH_REQUIRED`，
  改回循环逐个回根 ⇒ 实际 3 ⇒ 当场红）；`scripts/smoke/settings-page.smoke.mjs` 的 ⑬ 组管**树模式分支**
  （清 `view.expanded` / `virtualIndex[*].expanded`、不动页码）。⚠️ 只被某一分支用到的 import 漏了，
  另一分支的守卫**抓不到**（`v9.0.20` 的 `goToVirtualRoot` 就是这么活下来的）—— 加分支就要加点击。
  现在这颗按钮的**四条分支**（树模式 ± Ctrl、文件夹模式 ± Ctrl）各有一条断言真的点过它。
  ✅ **浏览器已实测（2026-10-13，用户回报"良好"）**：文件夹模式 + `Ctrl` ⇒ 所有页回根、只闪一次。

## 3. 视图是"同一份清单"（`folderViewRegistry` 契约）


- **视图是"同一份清单"**：`folder/folderViewRegistry.js` 的 `{ id, label, order?, mount(ctx), unmount?(ctx) }`，
  主视图文件夹页与**节点详页**共用；插件视图独占 `#folder-view-panel-<id>-<scope>`。改契约要两边一起想。

## 4. 副页节点是投影（`_virtual`）


- 副页节点是**投影**（`_virtual`）：页内 id 在 `state.nodes` 里**查不到**，凡"按 id 查表"的口在副页都失效。

## 5. 判重页两栏筛选：能力对等、范围刻意不共享


- **判重页（`dedup/`）两栏筛选：能力对等，但范围刻意不共享**（2026-10-12 定的）——
  ② 可能重复筛的是"**哪一对**候选"，③ 性质待补筛的是"**哪一族**待补"，所以 ③ **不接** ② 的
  范围 / 关键词 / 相似度（共用会让"补性质"被筛掉一半）。两边**共用**的是：
  · **哨兵值唯一一份在 `core/dedup.js`**（`NO_CLASS` / `PARTIAL_CLASS` / `NO_VALUE` / `HAS_VALUE`，
    别再在 UI 里抄字面量）；哨兵**永远列**（乙：不看数据有没有分歧）；
  · 四维都是**多选**（空选 = 全部；维度内"或"、维度之间"与"）；**「依据」是有意保留的单选门槛**；
  · 选中态看 `chipGroup` 加在芯片上的 **`dedup-chip-on`** 类（别去读内联样式）。
  ⚠️ 改筛选控件要一起看 `scripts/smoke/dedup-synth.smoke.mjs`：那份冒烟按"**替换成一个值**"驱动
  （适配器把芯片伪装成 `<select>`）——加能力时**补断言**，别删。

## 6. 账户归属是"值级"的（没有"节点级"读口）


- **账户归属是"值级"的，没有"节点级"读口**：一条提交归认到谁 = `node.values[字段][i].account`
  （写入口 `addSourceValue` / `recordIncoming`），**不是节点字段**（`node.account` 不存在）。
  逐条的归一化只有 `core/fieldValue.js` 的 `accountOfEntry`，显示名只有 `core/ops/account.js` 的
  `accountLabel` —— **别读 `state.accounts[id].name`、别自己拼标签**。要在树上显示"这个节点是谁的"
  （例：`builders.js` 的 R 行「提交者」）就得自己扫 `Object.keys(node.values)` 取第一条非空 `account`
  （插入序，不是"最新的"）。⚠️ 断言"不出现某段文案"时**别把同一字眼写进 `title`**：负向断言会被自己的
  tooltip 命中（`assert_not_contains(html, '提交者')` 就是这么挂的）。

## 7. 范围口径的开关要一路传到底


- **范围口径的开关要一路传到底**（`v9.1.23`：「查看范围」带不带直接子账户）：`resolveScope` 从
  `opts.settings` 读它 ⇒ **把 `viewingAccount` 传出去的每一处都要把 `settings` 一起传**
  （`editForm.js:sourcePanelOpts` / `sourceActions.js:refreshPanel` / `nodeFields.js` 各一处）——
  少一处就是"树上把子账户算进去了、值级面板不认"。口径与两个构造口见 `src/core/AGENTS.md` 的「值 / 多来源投影」。

## 8. 冒烟 / DOM 桩的边界（写断言前先看这一节）


- **冒烟测的是 DOM 桩**（`scripts/smoke/dom.mjs`，`innerHTML` 不解析）：断言只覆盖"遍历 + 拼字符串"，
  真实浏览器的解析/布局/绘制量不到 —— 别把桩上的数字当界面性能。
- ★ **冒烟里别用逗号选择器 —— 它会让断言"空转地通过"**（`v9.1.32` 真踩）：
  `querySelectorAll('[data-a="x"], [data-a="y"]')` 在 `scripts/smoke/dom.mjs` 里**恒为空数组**
  ⇒ 两边都空 ⇒ `'' === ''` **假通过**（那个"⇅ 换序真的对调了吗"的断言就这么绿了一次）。
  ⇒ 要么分开查、要么遍历 `children` 按 `dataset` 过滤，并**先断言前提**（取到的东西非空/符合预期）。
  （与"别改桩解析 innerHTML""别拿提交去改检查"同族：**先问"它红了我要做什么"，再问"它会不会永远绿"**。）
- ★ **`installDom({ parseHtml: true })` 之下，`el.innerHTML` 这个 getter 是空的**（`v9.4.15` 真踩）：
  桩把 `innerHTML` **建成元素树**，不再留原串 ⇒
  · `ok(/crumb-self/.test(el.innerHTML))` 恒红（而且看不出为什么，因为 `serialize()` 打出来是对的）；
  · 反过来，`serialize(el)` **遍历元素树、不输出 class 属性** ⇒ `ok(/crumb-self/.test(serialize(el)))` 恒绿。
  ⇒ **判"某个 class 在不在"一律用 `el.querySelector('.那个 class')`**（它跟的是同一棵树）；
  要用原串判，只能用在**没开解析**的那些冒烟文件里（例如 `page-sync.smoke.mjs` 里那句按 `innerHTML` 找
  `.node-entry-id` 的注释已经改成 class 查询了）。

## 9. 界面文案里不许漏字面 Markdown 记号


- ★ **界面文案里不许漏字面 Markdown 记号**（`v9.1.36`，用户："星号漏了"）：`**强调**` 与反引号在界面上
  会**原样显示**。两条规矩：① 文案要么**字面干净**（强调就用「」、术语不加记号），要么**过 `utils/text.js:plain()`** ——
  `textContent` / `title` / `innerHTML` 一视同仁（悬停提示漏过一大片）；
  ② **别写"生成后再 `.replace(/\*\*/g, '')` 擦掉"**：那个替换只对**紧挨着它的那一个字面量**生效，
  一旦后面还有 `+` 拼接就只擦到最后一段（计划页当初漏的正是这种写法）。
  判据：`src/test/docHygiene.test.js` 的第二条（**没用 `plain` 的文件里，字符串位置不许有 `**`；
  单/双引号里不许有反引号，模板串里转义的反引号也算漏**）—— 加它时**红着列出 40 行**，清扫完才转绿。

## 10. 设置页表单：复选框读 `.checked`


- **设置页的复选框要读 `.checked`，不是 `.value`**（`v9.1.23` 真踩）：`input.value` 恒为 `"on"`，
  `onInput` 里写成 `draft[x] = t.value` ⇒ **取消勾选也存成真值**（那个选项永远关不掉）。
  已按 `t.type === 'checkbox'` 分流；判据 `settings-page.smoke.mjs` 的 ④‴ 组（**必须有"取消勾选 ⇒ `false`"那条**）。
  ⚠️ 配套坑：`scripts/smoke/dom.mjs` 的属性表**原来不解析 `type`** ⇒ `t.type === 'checkbox'` 在桩里恒为
  `undefined`、这条分支**测不到**（先是假红）。已给桩补 `type`（补齐**已有**属性表 ——
  那条"别改桩解析 innerHTML"的禁令说的是另一件事）。

## 11. `nodeInfoView.js` 里的 `mk` 是另一个壳


- ⚠️ **`nodeInfoView.js` 自带的 `mk` 是 `(tag, id, cls, style)`，与 `utils/dom.js` 的 `mk(tag, cls, css)`
  签名不同**（同名的两个壳）⇒ 在这个文件里照抄别处的 `mk('span', 'x-link', 'color:…')` 会把**样式串塞进
  `className`**、元素也查不到（`querySelector('.x-link')` 恒 null，而 `style.cssText` 是空的）。
  判据：`v9.0.16` 铺"详页头部那串节点 id 做成链接"时就这么错过一次 —— 写完在冒烟里**按 class 查一次**。

## 12. 跳转 / 面包屑 / 详情：三样都只有一份实现


- **"跳到主树 / 面包屑 / 打开详情"——三样都只有一份实现，别造第二份**（`v9.0.13` 收敛过一次，现状如下）：
  · **跳转**唯一一条路是派发 `EVENTS.REVEAL_NODE`（实现全在 `revealNode.js`；**主树真实 id 与副页页内 id
    两种都认** —— `v9.0.17` 起：主树 id ⇒ 切回主页面在主树定位；页内 id ⇒ **切到它所属的那个副页、再页内定位**。
    归属判据只有 `core/ops/page.js:locateVirtualNode`，**顺序是先主树、再副页**（与 `findNodeBox` 同序，同名时主树赢）。
    页内导航动作只有 `ui/folder/virtualFolderMode.js` 那几份 + `core/ops/view.js` 的两个写口，别再造一套）。
    "这个 id 能不能当主树入口"那一步只有 `core/ops/page.js:mainTreeNodeIdOf` 一份，
    别在各页自己写；解析不出就**别画成可点**）。派发那一句只有一份：
    `ui/kit/actions.js:revealNodeById`。
  · **可点标记只有一种约定**：`data-reveal-node`（唯一承载，由 `ui/kit/actions.js:markGoto` 挂）——
    值既可以是主树真实 id，也可以是副页页内 id（由 `revealNode` 按归属分流）。**别为"页内定位"另造
    `data-reveal-virtual` 之类第二套标记**。
    接住它的**唯一一条委托**是 `ui/nodeinfo/nodeGroupActions.js` 的**文档级** click —— 调用方（含插件）
    **什么都不用挂**。`data-goto` / `dedup-goto` / `wireGotoLinks` 只是**薄兼容**（判重页那份冒烟按它们断言，
    别删、也别再往新地方用）；`wireGotoLinks` 只**转发**给 `revealNodeById`，并且必须 `stopPropagation`
    （不拦就会与文档级那条**各派发一次**）。`ui/revealNode.js:findNodeBox` 只查主视图那两格
    （`#tree-body` / `#folder-stats`）——**别改回 `document.querySelector`**，否则会滚到别处那个看不见的
    副本方框上还 `return true`（G11）。⚠️ 那两格**副页也复用**（副页方框也画在那里）⇒ 判据是
    "**这个 id 属不属于目标那一页**"，不是"在不在主页面"。
  · **详情**只有 `openNodeInfoTab` 一个入口（`📋 btn-node-info[data-id]`，`ui/G_events.js` 的文档级委托接住）。
    ★ **"点下去干什么"只有 `ui/G_events.js:openInfoFromButton(btn, activate)` 一份**（`v9.0.19` 收的）：
    带 `data-vid` ⇒ 先弹"看哪个"（`showInfoTargetSelector`）再 `openNodeInfoTab(vId, {asVirtual, pageId})`；
    否则直接开。**两条既有委托**（文档级 `installNodeInfoDelegate` + `#tree-container` 上那条 `onActionClick`）
    各转发一次 —— **别在任一条里再抄一遍**（抄了下次改语义必只改一处）。挂 📋 的地方只写
    `data-id` / `data-vid` / `data-page-id` 三个属性，**别自己调 `openNodeInfoTab`**。
    ★ **插件要"三件套一整格"时不要另写一份**（`v9.4.15`）：插件**不许 import `ui/`** ⇒ 由宿主
    **注入** `ctx.nodeEntry`（`ui/tabs.js:mountPluginTab` 给的是 `ui/kit/nodeEntry.js:nodeEntryLine`，
    `features/Search/index.js` 原样转发给子页）；细节见 `docs/node-navigation.md`
    的「2.8 插件怎么拿到这份渲染器」一节。
    ⚠️ 那条委托**只排除树方框自己那颗**（`btn.closest('.node-box')`，交给 `#tree-container` 上的
    `onActionClick`，它会 `stopPropagation`）——**别把排除写宽成"在 `#tree-container` 里就跳过"**：
    插件页就挂在那个容器里（`ui/folder/folderViewHost.js:ensurePluginPanel` 的默认宿主），写宽了它们的
    📋 就掉到容器级那条上，而**那条认逗号选择器**、DOM 桩不解析 ⇒ **CI 里恒为空转、点了没反应**
    （`v9.0.15` 修的 extKey 面板就是；判据在 `scripts/smoke/auto-import.smoke.mjs`）。
  · ★ **「方框上那排按钮」的委托要挂到"每一个画方框的容器"上**（`v9.1.27` 真踩，用户：
    "**节点详页子节点的各按钮点不了了**"）：`renderNode` 出来的 `.node-box` **不止在树上** ——
    树模式在 `#tree-container`、文件夹模式"当前节点"那格在 `#folder-stats`、
    **详页在它自己的 `tab-node-<节点id>`**（`tabs.js:ensureTabContent` 懒建，**不在**前两者之内）。
    而 `onActionClick` 只 `addEventListener` 到自己挂的那个根 ⇒ 详页整页的 📋/✏️/➕/⚙️/⬆⬇ **全是死的**
    （文档级那条**明确跳过 `".node-box"`**，注释写的前提"交给容器上那条"在详页里根本不成立）。
    ⇒ 加渲染点就加一次 `ui/G_events.js:bindActionDelegation(root)`（**幂等**靠 `root.dataset.delegated`，
    用的是**同一份** `onActionClick`，不是第二份实现）。
    ⚠️ **不许图省事改挂 `document`**：`onActionClick` 的各分支**不是全都** `stopPropagation`
    ⇒ 会与容器那条各跑一次（症状：开两个弹窗）。容器级与树那条天然互斥（一次点击只经过一条链）。
    判据：`scripts/smoke/ui-wiring.smoke.mjs`「节点详页里的节点方框也能点」那组
    （身份比对"详页容器与 `#tree-container` 挂的是同一批 handler" + 重画不叠加；删掉接线当场红）。
    ⚠️ 那一组**只验得到接线**：`onActionClick` 认按钮用**逗号选择器**，桩不解析 ⇒
    "点下去真开页"仍要在浏览器里点一次（这是**刻意的**：给桩加逗号支持会让别处一批本来死着的点击突然生效）。
  · **面包屑**：`ui/nodeinfo/nodeGroup.js:breadcrumbHtml(state, node)` —— **一个入口、内部按归属分支**
    （2026-10-13 合并，用户拍板）：**主树节点**（`!node._virtual`）走主树祖先链（`nig-crumb`）；
    **副页节点**（`node._virtual`）走**页内**祖先链 + `📄 页名` 前缀（`vnode-crumb`）。
    **调用方只给节点对象、别再自己挑函数**；两套 HTML / 类名逐字未改。
    组合件都是 `ui/kit/nodeEntry.js`（🔎 + 📋 + 面包屑，**主树 / 副页两种节点都认**：
    副页给**页内 id** + `data-vid`，靠 `revealNode` 的归属分流）。
    folder 模式那份 `folderShared.buildBreadcrumbHTML` 是**目录导航**（点一段 = 进那个文件夹），
    语义不同、**不要合并**；**副页节点别拿主树那条链去渲染**（会印「（就在根下）」这种假话）。
  · **祖先链**：对外只有**一个入口** `core/ops/page.js:nodeAncestorsOf(state, id)`（2026-10-13 合并时收的），
    它按归属分流 —— 主树 id ⇒ `core/query/nodes.js:getAncestorsRootFirst`（走 `parentOf`）、
    页内 id ⇒ `core/ops/page.js:virtualAncestorsOf`（走 `virtualIndex[*].parentId`）。
    两棵树的**实现各只有一份**（数据源不同，**别合成一个循环**；`core/ops` 引 `core/query` 可以，反过来会绕）。
    别自己 walk `parentOf`。
  盘点表 / 缺口 / 统一方案见 `docs/node-navigation.md` 的「4. 缺口」「5. 统一方案」。
  ⚠️ 画方框的代码其实在 `src/view/`（`renderers.js`/`helpers.js`），但**那个目录没有就地 `AGENTS.md`**
  （`scripts/areas.mjs` 里是 `AREA_DEFERRED`）⇒ 横跨 `view/` + `ui/` 的改动，笔记落在本文件，**别去改那份分类**。
  ⚠️ 插在 <code>innerHTML</code> 字符串边上的入口条（如统计的 AC 列表）**冒烟测不到**：DOM 桩不解析 `innerHTML`
  ⇒ "冒烟绿"不等于"铺上了"，这类改动要手动在浏览器里点一次。
  ✅ `v9.0.14` 起这类入口条的**接线**由**源码级守卫**兜着（`src/test/nodeGroup.test.js` 三条源码锚：
  生成处必须同时给出承载 + `btn-node-info`、`ui/kit/nodeEntry.js` 只许用 `markGoto` 挂承载、
  `ui/stats/ac/{listView,tracking}.js` 必须真的调 `appendNodeEntries`）—— 但它只管"接线还在"，
  **不保证渲染出来真可点**（新铺一处仍要在浏览器里点一次）。**别为了让它可测去改 DOM 桩解析 `innerHTML`**。

## 13. `Ctrl` 加点击 📋：开而不激活


- **`Ctrl` + 点击 📋 = 开而不激活**（`v9.0.18`，`ui/tabs.js:openNodeInfoTab(nodeId, { activate:false })`）：
  它**只**在接 📋 的那两条既有委托内部判（`ui/G_events.js` 的文档级 `installNodeInfoDelegate` +
  `onActionClick` 里 `.btn-node-info` 那一支）—— **别新增监听、别全局劫持 `Ctrl`**
  （树上多选 / `folderClickHandler` / `naturePeek` 都吃它）。`activate:false` 也必须 `ensureTabContent`
  （否则页签按钮在、点过去是空白）。判据：`ui-wiring.smoke.mjs` 的那组（去掉 Ctrl 分支或忽略 `activate` 都当场红）。
  ⚠️ 走"看哪个"选择器那一支（副页 `data-vid`）**没有**这个概念 ⇒ 仍会切过去
  （残余，见 `docs/node-navigation.md` §8）—— ✅ **用户 2026-10-13 明确：已知道、是对的、不必再提**，
  别再把它当待办汇报。

## 14. 设置页里"会改到物化缓存"的那类设置


- **设置页里"会改到物化缓存"的那类设置：保存时必须在**同一个事务**里重算缓存**（`v9.1.21` 起）：
  `settings.acTimeRule`（题目 AC 时间怎么取）是**第一条**这种设置 —— `node.acTime` 是 `autoCompute`
  写下来的缓存值，光改设置不重算 ⇒ 缓存与派生表**两个答案**。
  ⚠️ **`v9.1.26` 起受影响的字段从 1 格涨到 3 格**：第 4 种规则（`cutoffIgnore`，"忽略截断前的所有提交"）
  会同时改 `status2` / `acTime` / `lastSubmitTime` ⇒ `autoCompute.js:recomputeAcTime` 是三格一起重算，
  **别再改回"只算 acTime"**（那条只够前三种规则）。
  所以 `settingsPage.js:saveSettings` 里"写设置 + `recomputeAcTime(draftState)`"同在一个 `execute` 回调里
  （只有一步撤销、也不会出现中间态），`onSuccess` 里再 `clearDerivedMemo()`（连计数缓存一起丢）。
  ⚠️ 以后再加同类设置（改了会影响缓存字段的），照这三步做：**写设置 → 同事务重算 → 丢派生/计数缓存**。
  口径与全部消费点见 `docs/ac-time-rule.md` 的「9. 一句话口径（改这里的唯一入口）」一节。
  判据：`scripts/smoke/settings-page.smoke.mjs` 的 ④″（第 1~3 种）与 ④⁗（第 4 种，含"三格一起重算"）。
  ⚠️ **同一个保存里，`acTimeCutoff` 一律照存**（`v9.1.28`，用户 2026-10-13："希望截断时间不要随模式切换丢失"）：
  别再写成 `acNeedsCutoff ? acCutoffRaw : ''` —— 那会在"切到用不到截断值的规则"时把它抹掉，
  切回来值没了、保存还被"缺截断值"拦住（症状像"切不回带截断的规则"）。
  **校验口径不变**（只有带截断的规则才要求填；`acTimeRuleOf` 对别的规则根本不读这个值）。
  判据：`settings-page.smoke.mjs` 的 ④⁵ 组（**那条断言是"反转"来的** —— ④″③ 原来钉的是"清掉"，别再翻回去）。

## 15. 「根」那一格的详页入口


- **「根」那一格的详页入口**（`v9.1.18` 加、`v9.1.19` 补齐树模式）：**根在任何显示模式下都不画方框**
  （树模式 `renderTreeView` 画的是 `getChildNodes(state, root)`、文件夹模式停在根只画总览统计）
  ⇒ 它的详页**一个入口都没有**。规则就一条：**凡是有「总览统计」的地方，右边就有一颗 📋** ——
  两处渲染点：`folder/folderShared.js` 的 `renderFolderStatsComponent`（文件夹模式）与 `applyTreeLayout`（树模式，
  槽位是 `index.html` 的 `#tree-root-info-container`，**不复用** `#mode-action-btn-container` ——
  那格会被"清空选择"清掉）。构造**唯一一处** `rootInfoButton(rootInfo)`，调用方各给身份：
  · **主树**（`folderMode.js`）：`{ id: state.rootId }` ⇒ 只写 `data-id`；
  · **副页根**（`virtualFolderMode.js`）：`{ vid: page.rootId, pageId }` ⇒ 写 `data-vid`/`data-page-id`、
    ★ **故意不给 `data-id`**（页内 `v_root` 不引用主树节点 ⇒ 不给才会走"看哪个"里那句
    "这是副页根节点…"；给了就会列一个**假的主节点**选项）。
  ⚠️ **别自己调 `openNodeInfoTab`**（接住它的只有 `G_events.js` 那条文档级委托）。
  ⚠️ **同一个规则的多处渲染点一次做完** —— 先只改文件夹模式那一处，结果"切到树模式又打不开"，白返工一次。
  判据：`scripts/smoke/folder-root-entry.smoke.mjs`（含"📋 排在总览统计右边"的 DOM 顺序断言，两种模式都钉）。

## 16. 值级面板：点完按钮重画时取"新面板"


- **值级面板：点完按钮重画时，取"新面板"必须按类名取那一格**（`v9.1.17`，用户报的"字段块两份"就是它）：
  `sourceActions.js:refreshPanel` 原来用 `holder.firstElementChild`，而 `buildSourcePanelHtml` 返回的是
  **`应有/已有那一行 + 面板`** ⇒ 取到的是那一行说明，`replaceChild` 把面板换成了它的副本
  （**说明行 ×2、面板整块消失**）。改成 `.src-note` / `.src-details` **分两次查** ——
  ⚠️ **不许合写成逗号选择器**：`scripts/smoke/dom.mjs` 不解析逗号选择器，合写时桩里恒 `null`、
  `if (fresh)` 直接跳过 ⇒ **改坏了也测不出来**。判据（会红的那个夹具，前提也要断言）
  见 `scripts/smoke/manual-scope-ui.smoke.mjs` ④ 组；按钮给谁（含「真删」的判据）
  与"复现不出来"的教训见 `docs/field-rules.md` 的「6.1 值级面板上那几个按钮：给谁 / 点完怎么重画」一节。

## 17. 显示读值一律按"显示列"读（缓存字段别直读）


- **显示读值一律按显示列读**（`viewDerivedDisplay`），别直读缓存字段（`node.xxx`）：缓存只表达一个范围，
  多账户/多口径同屏时会串。来源层字段（`cfDifficulty`/`ratio`/`contestTime`…）要 `viewDerivedDisplay(...) ?? viewValue(...)`。

## 18. 弹窗的「取消」语义：`null`，而且**一定回调一次**

- ★ **约定**（`v9.3.4` 立；用户报"添加节点在靠后的环节点取消、之前的步骤仍执行"之后统一的）：
  三类弹窗在**取消**时都要**回调一次**、并给 `null`；**确定**时给值（**空串也照传**）：
  · `G2_common.js:showPromptDialog` ⇒ 取消 `callback(null)` / 确定 `callback(值字符串)`；
  · `G2_common.js:showFormDialog` ⇒ 取消 `callback(null)` / 确定 `callback(values)`；
  · `G2_selector.js:showTypeSelector` ⇒ 取消 `callback(null)` / 选中 `callback(type)`。
- **为什么两条都重要**：
  ① **不回调**（以前 `showFormDialog` / `showTypeSelector` 的取消只 `close()`）⇒ 调用方 `await` 的 Promise
     **永远悬着**：用户点了取消，界面既不提示、也不再有任何反应（`eventBridge.js` 那两处 `await promptAddRoot()` 就是这样）；
  ② **取消与"确定但留空"不分**（以前 `showPromptDialog` 两种情况都给 `null`）⇒ 调用方把"取消"当成"留空"，
     **后面的提交照做** —— "链接（可选）"那一步点取消，节点照样被建出来。
- **调用方怎么写**（照 `G4_add.js` / `G5_actions.js` 那几处）：
  · 必填字段：`if (!name || !name.trim()) return;`（取消与空名都拦，行为不变）；
  · **可选字段**：`if (link === null) { resolve({ success:false, error:'用户取消' }); return; }`，之后 `link || ''` 才是"没填"；
  · 表单：`if (!res) { …用户取消…; return; }`（`null` = 取消；`values` 对象 = 确定）。
- **判据**：`scripts/smoke/add-node-cancel.smoke.mjs`（**29** 项）—— 四条路都走**真按钮**，
  并用 `Promise.race` 超时兜底把"Promise 永远悬着"也钉住（改前那四条里三条红）。

## 19. 语义查询：本仓里筛选一词有五种主语

> 为什么要写下来：这个词在界面上到处出现，但**筛的是什么**从来不一样 ——
> 用户 2026-10-14 在计划设置里问"'筛选'确实要先看看具体语义"，就是因为同一个词在两处筛两样东西。
> ⚠️ 以后要在界面上新加一个"筛选"，先照这张表认一下**主语**，别把两种主语混成一个词。

| 界面上叫什么 | **筛的是什么（主语）** | 判据的唯一一份 | 住哪 / 影响什么 |
|---|---|---|---|
| **「筛选模式」**（统计页 / 训练强度热力图 / 比赛补题概览） | **主树节点**：这个节点在不在"你的圈"里（自身或祖先被**选中**，或被**副页映射**覆盖） | `view/filterMode.js:FILTER_MODE_CHECKS` → `view/eligible.js:hasEligibleAncestor`（四档，认不出当"无限制"） | 设置键 `settings.stats.statsFilterMode`；**只影响这批题的取子集**，不改任何值 |
| **「条件」**（计划的题集） / 挑题弹窗的同名块 / 计划详细页「题目列表」的筛选 | **题自己的字段**：XCPC 档位 / 数值区间 / 标签 / 平台（挑题弹窗另有"状态2"那一维） | `core/problemPick.js:matchesProblemFilter`（**唯一一份**，四个消费者共用） | 计划侧：`plan.pick` **进数据**（改了题集就变 ⇒ 强度/达成/图表全变，**要保存**）；列表侧：`view.list` **住视图态**（进 `viewState`，只看这一屏，不影响任何统计） |
| 判重页的「筛选范围 + 性质四维」 | **候选节点**：范围（整树/子树/单场）+ 分类前缀 / 年份 / 赛季 / 地区（+ 依据强度） | `core/dedup.js`（`emptyDedupFilter` / 节点级筛选 / `scopeNodeIds`） | ② 与 ③ **刻意不共享**（见本文件第 5 节）；只影响"建议哪些配对" |
| 两个检索页（题目检索 / 比赛检索）的 facet + 关键字 | **索引里的记录**（P / C） | `core/query/searchShared.js`（`norm` / `hasText` / `hasList`：**空 = 不筛**）+ 各页 `query.js` 的筛选+排序 | 纯查询，不写状态 |
| 计划页「每期完成情况」的**范围筛选** / 各处的"纯显示筛选" | **期**（日期区间）；「只看性质不一致」「只看有人没过」这类是**画出来的行** | `ui/plan/planBlocks.js:filterPeriods`（按"期与区间**有重叠**"，不是"起点落在区间里"）；纯显示那几处**刻意不动计数、不动要写的内容** | 视图态 / 只影响这一屏 |

**最容易被当成一件事的两处 —— 名字已定（`v9.4.10`）**：
- **计划设置的「题集条件」**（`plan.pick`）："这份题集**怎么来的**" ⇒ **进数据、进包、要保存**；
  改它 ⇒ 题集变 ⇒ 强度/达成/两张图**全变**。界面上那块标签写着「题集条件（改它 ⇒ 题集跟着变，记得保存）」。
- **详细页「📋 题目列表」那一栏的「列表筛选」**（`view.list`）："你**现在怎么看**这张列表" ⇒
  **住视图态、不进包、不影响任何统计**；那一栏开头写「列表筛选：」，清空按钮叫「✖ 清列表筛选」。
- 两处**判据同一份**（`matchesProblemFilter`）、维度也高度重叠，但**名字必须分开**
  （用户 2026-10-14 定："语义修改就按你说的来"）。⚠️ 以后在这附近加东西，先看这三条再起名。

---

## 20. me.json 表单：对象数组的列类型看整列（布尔列给勾选框，缺键别写成 false）

`me.json` 编辑器（`ui/MeEditor/`）的表单是**按值长什么样**选控件的（不认键名）；对象数组
（`accounts[]`）渲染成"一行一条、一列一个字段"的表（`meForm.js` 的 `KIND.RECORDS`）。三条判据：

- **列的类型看整列**：`jsonKeys` / `boolKeys` / `numKeys` 都按**整列**算，而且**留在节点上**
  （`node.jsonKeys` …）—— 「＋ 加一条」也要照它给控件。只看"这一格自己"的话，新加的那行会把
  `byYear` 变成文本框、`active` 得手打（而 `"false"` ≠ `false`）。
- **标量列按原类型存回去**：每条字段带 `valueType`，收集时走**与顶层 TEXT 同一个** `typedValue()`。
  病根（实测）：`accounts[].active: false` 过一趟表单变 `"false"` ⇒
  `core/rosterAccounts.js:accountOf()` 判的是 `active === false` ⇒ **"停用"静默失效、爬虫照抓**；
  `note: 3` 同理变成 `"3"`。⚠️ 类型要取自**列**（`active` 这一列是布尔）—— 只看 `typeof raw`
  时，"本来没这个键、用户刚取消勾"那一格会拿到 `'undefined'`、于是又存成字符串。
- **布尔列渲染成勾选框**：读 `.checked`（`value` 永远是 `"on"` —— 见本文件第 10 节），语义是
  「**启用**」。⚠️ **没写这个键 = 活跃**（缺省启用）⇒ 那一格要**勾上**；同步回模型时
  "没这个键 + 勾着"必须**保持不写**（写成 `false` 等于替人把账号停用了）。
- ★ **"这一列永远在"要靠补列**（`meForm.js:ensureRecordColumn()` + `applyColumnSpecs()`，
  由 `meEditor.js:modelOf()` 在"文档 → 表单模型"这**唯一入口**上调用）：表的列 = 各条键名的**并集**
  ⇒ 文件里从来没人写过的那一列**根本不存在**，用户就没地方改（实测：那份 me.json 4 条账户、
  `active` 一格都没有 ⇒ 点了「💾 保存到 me.json」也看不到任何变化）。补出来的格子是**空的**
  （`wasPresent: false`）⇒ **没动过的行一个字都不写**；补的列**插在 `name` 后面**（追加到末尾会被
  那几个 JSON 框挡在后面，等于"有但看不见"）。要"缺省也写出来"，就传 `{fill:'true'}` 那种规格。

判据：`scripts/smoke/me-editor.smoke.mjs` 的「账户表：布尔列给勾选框」那一组（三态 + 新行各一条）、
`src/test/meForm.test.js` 的布尔/数字往返那两条。

> 性质：**改 `ui/MeEditor/meForm.js` / `meEditor.js`，或给 `me.json` 加"对象数组 + 标量列"的字段**时看它。

## 21. me.json 表单：新建字段走「待定行」（值贴 JSON 才成对象；类型不许猜）

用户 2026-10-19 实测："表单没法填对象名"—— `＋ 新字段` 原来直接 `nodeOf('', '', {keyEditable:true})`，
也就是一个 **`TEXT` 节点** ⇒ 键名能改、值只能是字符串 ⇒ **表单里造不出一个新的对象**
（给 `hdu.years` 加 `2026 = {contestUser, contestPassword}` 只能切去 JSON 视图改）。
现在 `＋ 新字段` 推的是 `meForm.js:pendingEntry()`（`KIND.ENTRY`）：**键名一格 + 值一格 + 类型下拉**，
点「✓ 建」才变成真节点。四条判据：

- **定型规则（`nodeFromEntry()`）**：值以 `{`/`[` 开头 ⇒ 必须 `JSON.parse` 成功 ⇒ 对象/数组
  （对象就是一个可展开的分组，**一步就能建好整棵嵌套结构**）；其余**一律字符串**。
  ★ **类型下拉里有一档「对象（嵌套）」**（`ENTRY_TYPES` 的 `object`，用户 2026-10-19："应增加嵌套选项"）：
  选它 + 值**留空** ⇒ 直接建 `{}` 空对象（先建壳、再往里「＋ 新字段」）；填了 `{…}` 就照 JSON 建；
  填裸文本 ⇒ 报错。
  ⚠️ **不许猜数字/布尔**：`me.json` 里 `contestPassword: "123456"` 就是数字形式的字符串（值纯属示例），
  猜成数字后 JSON 里就没引号了 —— 与 §20 那个 `false ⇒ "false"` 是同一个坑的两头。
  真要数字/布尔，走那个类型下拉**显式**选（`ENTRY_TYPES`：`auto/string/number/boolean/object`）。
- **出错就地红字、不重画**：`{a:1}` 这种半个 JSON 要报"不是合法 JSON"并**不建**
  （不许悄悄当字符串存下去）；重画会丢掉刚打的字。
- **不点 ✓ 也不会静默丢**：`collectNode(ENTRY)` 走同一个 `nodeFromEntry()` ⇒ 两格都空当没加、
  填了内容没名字就报错（`collectGroup` 那句"有一项新字段没填名字"）。
- **建完键名仍可改**（`built.keyEditable = true`，与"新加的字段名可编辑"一致）。

判据：`src/test/meForm.test.js` 的两条「待定行」（对象/数组/`123456` 是字符串/坏 JSON 抛错 +
"没点 ✓ 也按同一套规则收"）、`scripts/smoke/me-editor.smoke.mjs` 的
「待定行：两格 → ✓ 建 → 嵌套对象」那一组（坏 JSON 不建 + 就地红字 + 收回嵌套对象 + 可展开）。

> 性质：**改 `ui/MeEditor/` 的新增字段/新增记录那几条路**、或想"顺手把新字段默认成对象"时看它。
