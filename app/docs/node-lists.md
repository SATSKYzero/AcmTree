# 节点列表（一行一个节点的那种列表）

> 用户 2026-10-15（看着屏蔽清单那张图）："我觉得像这些列表，都该尽可能有详尽的信息与功能（面包屑、点击跳转、详页…）。
> 其他列表也是。各列表应该有若干处可以整合为一，尤其是**描述节点的列表**。"
>
> 结论先给一句：**"一行一个节点"的列表，入口那三件套（🔎 跳到树上 / 📋 详页 / 面包屑）都用现成的
> `ui/kit/nodeEntry.js:nodeEntryLine()`** —— 别在列表里手写第四种跳转/详情/面包屑。
> 本页只做两件事：**盘一遍现状**、**写清迁移顺序**（实现落在各列表自己那处，判据在这一页）。

## 节点列表

> ⚠️ 这一节的名字是**指针锚点**：`src/ui/AGENTS.md` 写的是"见 `docs/node-lists.md` 的「节点列表」一节"，
> `src/test/docAnchors.test.js` 会核这一节真在 ⇒ **别改标题**（要加内容就往下面加小节）。

### 1. 三件套各只有一份（别再造）

| 要素 | 唯一实现 | 承载 / 谁接住 |
|---|---|---|
| 🔎 跳到树上 | `ui/kit/actions.js:markGoto(el, nodeId)` 挂 `data-reveal-node` | `ui/nodeinfo/nodeGroupActions.js` 那条**文档级**委托（调用方**不用挂监听**） |
| 📋 打开详页 | `btn-node-info[data-id]`（+ `data-vid`/`data-page-id` 两个身份） | `ui/G_events.js` 的文档级委托 → `ui/tabs.js:openNodeInfoTab` |
| 面包屑 | `ui/nodeinfo/nodeGroup.js:breadcrumbHtml`（内部按归属分流：主树 / 副页） | 由 `nodeEntryLine` 调 |
| 拼在一起 | **`ui/kit/nodeEntry.js:nodeEntryLine(state, node)`** | 一行入口条（`div.node-entry`） |
| 只想要"名字可点" | `ui/kit/report.js:nodeOrText(parent, text, nodeId, href)` | 解析不出 ⇒ **如实不画成可点**（假链接比纯文本更糟） |
| "画成方框"的列表批量补 | `ui/kit/nodeEntry.js:appendNodeEntries(container, state, rowSelector)` | 在 `.node-box[data-id]` **后面**插一行入口条 |

⚠️ `nodeEntryLine` **两种 id 都认**：主树真实节点、副页页内 id（`_virtual`）—— 副页那种会走
"页内祖先链 + `📄 页名` 前缀"那支，调用方**不用挑函数**（判据在 `locateVirtualNode` 一处）。

### 2. 现状盘点（2026-10-15 实测扫的）

| 列表 | 文件 | 现在有 | 缺 |
|---|---|---|---|
| 屏蔽清单（副页仪表盘） | `ui/folder/pageDashboard.js` | 身份键 + 🔎（面包屑上挂 `data-reveal-node`） | ✅ `v9.4.15` 三件套齐（`nodeEntryLine` 的 **compact 一行**版） |
| 计划 · 题集两块表 | `ui/plan/planBlocks.js:problemRow` | 点整行跳树（`title` + 行点击） | ✅ `v9.4.15`：行尾**加了一列「节点」**（身份键 + 完整面包屑 + 📋），题名列一个字没动 |
| 题目检索结果表 | `features/ProblemSearch/index.js` | 点整行跳树（`REVEAL_NODE`） | ✅ `v9.4.15`：末列 `.ps-node-cell`（同上；渲染器由宿主注入） |
| 比赛检索结果表 | `features/ContestSearch/view.js` | 点整行跳树 | ✅ `v9.4.15`：末列 `.cs-node-cell`（与题目检索同一形状） |
| 每日列表（AC） | `ui/stats/ac/dailyList.js` | 走 `renderACListView` | ✅ 早就齐（`ui/stats/ac/listView.js:appendNodeEntries`，与时间段列表同一份渲染） |
| AC 列表 / 追踪 | `ui/stats/ac/listView.js`、`tracking.js` | ✅ `appendNodeEntries`（三件套齐） | — |
| 判重四件（待补 / 候选 / 冲突 / 合成） | `ui/dedup/naturePending.js`、`candidateSection.js`、`conflictSection.js`、`synthSection.js` | ✅ 有入口痕迹（2~4 处） | 逐个核"是不是都用 `nodeEntryLine`"（**复核项**） |
| 导入记录表 | `features/AutoImport/ui/recordTable.js` | ✅ 📋 / 🔎（`plan.records[*].nodeId`） | 面包屑（表很密，**可考虑不做**，见 §5） |
| 组员表 / 详情页里的列表 | `ui/nodeinfo/nodeGroup.js` | ✅ 三件套齐（面包屑的家） | — |

### 3. 三种形态，各自怎么接

1. **表格型**（检索结果、计划题表）：用户 2026-10-15 定稿 —— "**还是题名和完整面包屑都有为好，即增加若干列**"：
   **原来的列一个字不动，末尾另加一列"节点"**，里面放 `nodeEntryLine(state, node, { compact: true })`
   （身份键 + 完整面包屑 + 📋 三样全在这一格里）。行是 `innerHTML` 拼的 ⇒ 那一格要
   `document.createElement('td')` + `appendChild`（`planBlocks.problemRow` / 两张检索表都是这么做的）。
   ⚠️ **整行可点 + 行内有 📋** ⇒ 行 click 里先 `if (ev.target.closest('.node-entry')) return;`
   （**单类**：桩的 `closest` 不认逗号选择器），否则一次点击"跳树 + 开详页"一起发生。
   ⚠️ **插件那两张表不许 import `ui/`** ⇒ 渲染器走**宿主注入**的 `ctx.nodeEntry`（`ui/tabs.js` 注入、
   `features/Search/index.js` 转发）；细节见 `docs/node-navigation.md` 的「2.8 插件怎么拿到这份渲染器」一节。
2. **方框型**（AC 列表、组员表）：照 `appendNodeEntries(container, state, rowSelector)` 那一份。
3. **点整行跳**（计划题表、检索表）：保留行点击（那是"这一行的主操作"），
   但**跳转的实现要换成 `markGoto`**（现在各写一份 `REVEAL_NODE` 派发 ⇒ 迟早分叉）。

### 3.1 一行一个节点的"密集清单"：`{ compact: true }` + 分页

用户 2026-10-15 盯着屏蔽清单那块，**连着四轮**改出来的形状。⚠️ **只有最末一轮的口径算数**
（前几轮里"`width:fit-content` / 不占满版面"那两句**已被取代**，别再照它写）：

- 第一轮："**太臃肿了 一条只占一行**" ⇒ `nodeEntryLine(state, node, { compact: true })` + 外层那一行 `nowrap`；
  长清单要**分页**（"分页，默认 10"）：形状照 `view/builders.js:buildPaginationHtml`
  （◀ `1 / 3` ▶ + `(1~10 / 26)`），**页大小是这个清单自己的**（别与树/文件夹那个
  「每页条数」`settings.display.nodePerPage` 混成一个旋钮）。
- 第二轮："**记得换行**" ⇒ 装这些卡的容器是 **`flex-direction:column`** ——
  ⚠️ **不是 `flex-wrap:wrap`**：那会让几张短卡并排挤在一行里（用户上一张图里就是这样）。
- 第三轮："**每项都要假想装在矩形里，每个矩形合适间距**" ⇒
  · 卡是 `border:1px solid #eef2f6;border-radius:6px;background:#fbfdff` 的**圆角淡框**，
    清单位置与整个仪表盘也各套一层；
  · 卡**占满可用宽度**（`display:flex`，**不给 `width:fit-content`**），卡内各格之间是**同一个固定 `gap`**，
    卡与卡之间是容器的 `gap`；
  · 容器**不给 `align-items:flex-start`** —— 那会让卡片按内容收窄，卡内的 `margin-left:auto` 就没空白可吃。
- 第四轮（**当前的最终形状**）：
  · "**右端点取 max**" ⇒ 卡内那颗 📋 上 `margin-left:auto`（这正是"卡必须占满宽度"的理由）；
  · "**应该在最前面放 id/extkey**" + "信息给全" ⇒ **第一格 = 身份键**：
    `core/fieldRegistry.js:identityKeyOf`（`extKey`，合成节点看 `synthKey`；都没有才退回节点 id）。
    ⚠️ **副页投影节点也有 `extKey`**（`view/dataAdapter.js` 是 `{...realNode}` 摊出来的），
    但**页根**那种凭空造的没有 ⇒ 退回页内 id（如实写，不编）；
  · "**第一项用完整的面包屑替代，不要缺一级，全蓝**" + "第三项（原有面包屑）删了" ⇒
    **第二格 = 完整面包屑**：`breadcrumbHtml(state, node, { includeSelf: true, color: '#1d4ed8' })`，
    **它自己就是 🔎**（`markGoto` 挂在它上面）；紧凑形态**不再另起一格**面包屑。
  ⇒ 一行 = `身份键 | 完整蓝色面包屑（🔎）··············📋 | 这张表自己的操作`。
  ⚠️ **"右边那点空白"必须留在入口条里面**：入口条是 `flex:1 1 auto`（吃下宿主的剩余宽度），
    📋 才靠自己的 `margin-left:auto` 落到**右端点**上。写成 `flex:0 1 auto`（按内容收窄）时，
    空白留在入口条**外面**、`auto` 无处可施 ⇒ **每一行的 📋 跟着面包屑长短左右乱跑**
    （用户 2026-10-15 指着计划那张表："题目列表的**详页按钮又没对齐**了"——那是第 4 处、
    前 3 处（检索两张表 + 屏蔽清单）恰好因为宿主是 `<td>` / 行内有别的操作才没露出来）。
  ⚠️ 面包屑走 **`{ includeSelf: true, color: '#1d4ed8', treeTag: false }`**：**不画"来源树"那一段** ——
   它不是节点（是 extKey 第一段，也就是左边那枚身份键的前半截），用户当场指出"前两节好像不存在"。
   详见 `docs/node-navigation.md` 的「2.5 面包屑（**目录导航两份 + 节点祖先链一份**；节点那两份已合成一个入口）」一节。
- ★ **纵向对齐：一条规则 —— "全部垂直居中"**（用户 2026-10-15 连说两轮："怎么文本**忽上忽下**" →
  "能不能**全部垂直居中**，别微调了"）。做法（三处，缺一条就会差 1~2px）：
  · **宿主那一行** `align-items:center`（`planBlocks.problemRow`）—— `stretch`（flex 缺省）会让
    "格内自己再居中"的那几格跟着行高下沉；`flex-start` / `baseline` 都要逐格算行高，别用；
  · **入口条内部**也 `align-items:center`，而且**不许自己写 `font-size`、不许换字体**
    （`ui/kit/nodeEntry.js` 原来是 11px + `ui-monospace`：字号不同 ⇒ 行盒不同高；
    等宽字体 ⇒ 同样行盒下**基线**天生差 2px。身份键的"身份"靠**底色 + 圆角**表达，不靠字体）；
  · **面包屑那一段传 `{flat:true}`** —— 不套它自带那层 `font-size:11px;line-height:1.6;margin-top:1px`
    的 div，字号/行高**跟宿主那一行**；再配上**身份键上下不加 padding**（只给左右），各格行盒就一样高。
  量法（真浏览器、**不进 CI**）：`node scripts/measure-layout.mjs list` 量**每列文字基线**，
  12 个数据行全部 0~1px。⚠️ 两个"假判据"别再用：**文字顶边**（各格 line-height 不同，顶边差 3px
  可能基线是齐的）、**身份键那一段**（等宽字体，量它会得出"差 2px"的假结论——要量**面包屑**那一段）。

### 4. 迁移顺序（一处一改，各自带自己的冒烟）

| 档 | 做哪一处 | 为什么这个顺序 |
|---|---|---|
| P0 | ✅ 屏蔽清单（`ui/folder/pageDashboard.js`） | 用户当场看着的那张 |
| P1 | ✅ 计划 · 题集两块表（`planBlocks.problemRow` — 两块表**共用一份行渲染**，改一处两处受益） | 每天都看 |
| P1 | ✅ 两张检索结果表（`ProblemSearch/index.js`、`ContestSearch/view.js`） | 现在最"素"（连行点击都没有的那张） |
| P2 | ✅ 每日列表（`ui/stats/ac/dailyList.js`） | 原来盘点错了：它与时间段列表共用 `renderACListView`（`appendNodeEntries`）⇒ **早就齐了** |
| P3 | 判重四件复核 + 导入记录表（要不要面包屑） | 已经有入口，属于"核对口径"而不是"补功能"（用户 2026-10-15：**下次再说**） |

### 5. 不做的（免得以后当成"漏了"）

- ❌ **不堆按钮**：一行只给"名字（可点）+ 面包屑 + 🔎 + 📋"，其余按**那张列表自己的用途**加
  （例如屏蔽清单还要一颗「取消屏蔽」）。同一颗按钮在三张表上长三个样 = 又是两处口径。
- ❌ 不给**已经很密的表**（导入记录表：两万多行）强行塞面包屑 —— 那一栏会把行挤爆；
  它的 📋/🔎 已经够用。
- ❌ 不在每个列表里各写一套"点一下跳树"（那正是 §2 里三处各写一份的来源）。

### 6. 判据

- **三件套的"唯一一份"**：`docs/node-navigation.md` 的「2. 现成入口（唯一一份的那些）」一节 +
  `src/test/nodeGroup.test.js` 里那条"必须真的调 `appendNodeEntries`"的**源码级**断言（形状照它抄）。
- ⚠️ **`appendNodeEntries` 在冒烟里是空转的**（DOM 桩不解析 `innerHTML`，方框查不到 —— 见它的文件头）。
  ⇒ 想**真的**被冒烟钉住的新列表，优先走"`nodeEntryLine` 直接 `appendChild`"那条路
  （`nodeEntryLine` 用 `mk()` 造真元素，桩里看得见）。`page-sync.smoke.mjs` 就是这么钉的。
- ⚠️ **断言"面包屑里有某一类"别用 `serialize()` 找 class**：`serialize()` 遍历的是元素树、
  **不带 class 属性**（实测：`crumb-self` 那一段在输出里只剩文字）⇒ 用 `crumb.querySelector('.crumb-self')`。
  反过来，**也别用 `el.innerHTML` 判**（桩开了解析时那个 getter 是空串）——两条都会**空转**。
