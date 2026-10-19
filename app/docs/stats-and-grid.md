# 统计图 / 网格 / 热力图 / 对比表（从 `src/ui/AGENTS.md` 搬来）

> ★ 同上：AGENTS.md 里只留一句性质 + 指针，细节在这儿。
> ⚠️ 这几块**共用**统计那一层（`ui/stats/…`），改动往往一次影响好几处 —— 先看「1. 分档口径」。


## 1. 统计柱状图：分档口径只有一份

- **统计柱状图的"分档口径"只有一份**（`v9.0.18`，`ui/stats/statsCharts.js:xcpcBucketOf` / `cfBucketOf`）：
  算图的键、柱高、以及"点柱筛出那一批"**都从这两个函数取**。在别处（尤其明细、检索、概览）
  再算一遍"这一档有哪些题"必然分叉（图上 137、点进去 139，两边都不报错）。
  ⚠️ 点柱是**看**（不筛数据、不改 `pNodes`）；**没有**"带条件切到检索页"的通道，别在统计里再写一套筛选。

## 3. 训练强度热力图

- **训练强度热力图：当前选中范围外变淡**（`v9.1.5` 加、`v9.1.6` 改成淡化、`v9.1.7` 接上单日与账户同步）：
  **选中范围外的格子调淡**（`opacity:0.28`）、范围内**一格不动**。要点：
  · ⚠️ **别再改回"给范围内加醒目装饰"**：`v9.1.5` 先做的是"范围内加 3px 淡蓝描边"，
    用户看过之后原话 **"看着很糊…不要高亮了，要不让范围外的变淡？"** ⇒ 定稿是**淡化范围外**；
    smoke 里钉了"不许再有 `box-shadow:0 0 0 3px`"这条。
  · 用 `opacity`（不是套一层 div）：**不改变布局**（格子仍 18×18、间距 3px）。
  · **"当前选中的是哪一段"只有一处状态**：`ui/stats/ac/dailyList.js` 的 `activeSelection`
    （只有 `setActiveSelection(start, end, kind)` 能写：**单日** ⇒ `[那天, 那天]`、**时间范围** ⇒ `[起, 止]`），
    热力图读 `getHeatmapHighlightRange()`。⚠️ **别改回只认 `getTimeRangeResult()`**（那只是"按下确定的那段"，
    单日选中会漏）。⚠️ 也**别去读 `#tr-start-*` 下拉框**（上面可能有"改了还没按确定"的值）。
  · **闭区间**（`>=` / `<=`）：用户明确"点框也算在时间段内"；单日选中同理。
  · 重画走**回调**：`dailyList.js:setSelectionRepaint(fn)`（`heatmap.js` 注册 `renderTrainingHeatmap`）——
    只在**真的换段**时通知（翻页不重画）。⚠️ 别让 `dailyList` 反过来 import `heatmap`（会成环）。
    首屏那次不用额外补刀：`setTimeout(50)` 建出默认范围时会回调过来重画一次。
  · ⚠️ **列表必须跟「查看账户」同步**（`v9.1.7` 修的真坑）：列表只在**按下确定/点某天**时建一次，
    换了账户范围后**旧列表留着**而下面的统计按**新**范围读 ⇒ 症状是"**AC 列表里却有未使用/已提交未通过**"
    （用户实测：那条 AC 是队友 `teammate_b` 提交的）。修法 = `dailyList.js:refreshActiveACList()`
    （按当前范围重算此刻展示的那一段，单日/范围两条分支都覆盖），由热力图**每次重画**时调用。
    ⚠️ 顺带记清一条**不是** bug 的规则：范围过滤只排除**带账户**且不在范围内的值，
    **不带账户的"客观值"永远算**（`core/trust.js:usableValues` 的注释）—— 真包导入时大批提交没有账户归属。
  判据：`scripts/smoke/ui-wiring.smoke.mjs` 的热力图那组（喂手工 `acMap` + 范围，断言 `serialize()` 出的 HTML：
  起点/终点都不淡、区间外有 `opacity`、没有描边、没范围谁都不淡、单日只有那天不淡；外加"接线还在"的三条源码锚）。
  ⚠️ 格子是 `innerHTML` 拼的、桩不解析 DOM ⇒ 只能这样断言；真浏览器里的观感（淡到什么程度）要看一眼。
- **热力图那个"每天每组一条"的自定义 `keyOf`：必须把节点 id 拼进兜底**（`v9.1.24` 真踩）：
  `heatmap.js` 的 `keyOf` 返回 **带前缀**的串（`"<日期>|" + groupKeyOf`），而
  `core/query/countMode.js` 的"没有组键 ⇒ 自成一组"兜底是 `raw || '#' + id` —— **只在返回空串时生效**
  ⇒ 拼了前缀就永不触发 ⇒ **那一天所有"没有组"的题（散题 / 没进组的比赛下的题）共用一键、只留一条**
  ⇒ 症状是"**热力图上一天最多 1**"，而 AC 列表（走默认 `groupKeyOf`）一个都不少（用户 2026-10-13 实测）。
  ⇒ 拼前缀时写成 `groupKeyOf(x) || '#' + x.id`。判据：`src/test/dedupDisplay.test.js` 那条（含反证）。
  ⚠️ **只影响判重模式**（`plain` 下 `dedupRepresentatives` 原样返回）。

## 2. 「状态 × 难度」网格表

- **图**上/下**那张「网格表」**（`v9.1.1` 加、`v9.1.2` 调）：行 = 状态2、列 = 难度档、格内 = 题数、
  每行最右 = 该状态2的合计。四条不变量：
  · **位置：表在柱状图上面、图例在最后**（`v9.1.2` 按用户"表格与柱状图交换位置"对调）；
    两块仍**同处一个横向滚动区** ⇒ 横滚时列一起动（改顺序时别把这一条拆了）。
  · **数据只算一份**：`ui/stats/statusGrid.js:statusGridOf`（**纯函数**，只吃画图那一份 `data`）——
    列序 = `data` 的键序、行序 = 同文件的 `STATUS2_ORDER`（**正序**：`未使用` 在最上）。
    ⚠️ 用户先说"行序与柱状图相反"、**随后明确"还是别反了"** ⇒ 正序是定稿，别"顺手"改回倒序。
  · **列与柱子对齐靠三件同一把尺子**（`statsCharts.js` 顶部的 `COL_GAP` / `AREA_PAD_LEFT` / `ROW_LABEL_W`）：
    同样的左留白（柱子那一行左边还有一格与「状态2」标签列**同宽**的空位）、同样的列宽 `config.barWidth`
    + `flex:0 0`、**同一个横向滚动区**（`.stats-chart-scroll` 装柱子和网格）——
    少了滚动区那条，图能横滚、表不动，列就白对了。
  · **格底染色取同一份色表**（`v9.1.2`）：`STATUS2_COLORS[row.s2]`，与柱段/图例**逐字一致**（别另调一套浅色）；
    零格文字用**半透明深色** `rgba(15,23,42,.35)`（`赛时通过` 那行底色是亮绿，写浅灰数字看不清）。
  · **网格的 dataset 一律加 `grid` 前缀**（`data-grid-level` / `data-grid-status2`）：
    `data-level` / `data-status2` 是**柱段**的测试钩子（冒烟按 `[data-level]` 数柱段）⇒ 借用会污染它。
  · **表底那行「合计」+ 最右「总数」**（`v9.1.3`）：每档合计 `colTotals` 与全部题数 `grand` 都由
    `statusGridOf` 从**同一份 `rows`** 求和给出（别再去数一遍 `data` —— 两条路必然分叉）；
    ★ **柱子上面那行数字已经撤掉**（搬到这里），别再往柱区加第二份；这一行与其它行**同一套格子**
    （只不染状态2的色），用户明确"不用加框" ⇒ 别加外框/别换样式。
  · **格子可点、且与柱段同一条路**（`v9.1.4`）：格子的 click 直接调**柱子那一份** `onSegmentClick(level, s2)`
    （`renderStatusGrid` 里的 `bindCell`）⇒ "效果与柱相同"是结构保证，**别在格子这边另写一套筛选**；
    也带上同款 `title`（"点一下把这一批列在图表下面"，可发现性）。
  · **点表底「合计」那一格 ⇒ 这一档"所有状态"的题**：传哨兵 `ui/stats/statusGrid.js:ALL_STATUS2`
    （`'all'`）。⚠️ **别拿 `''` 兼职** —— 空串在 `statsCharts.js` 里已经是"没选中任何柱段"的意思；
    `recomputeBatch(level, status2)` 只在哨兵时跳过状态2 过滤，明细标题相应写「全部状态」。
    ⚠️ **`0` 格也能点，而且是**刻意的**（用户 2026-10-13："符合意图"）** —— 点了列出一个 0 题的空明细；
    别"顺手"把它改成不可点。
  判据：`src/test/statusGrid.test.js`（数据/行序/合计，纯逻辑）+
  `scripts/smoke/ui-wiring.smoke.mjs` 的统计那一组（顺序、列序同柱子、格宽 = 柱宽、行序、格底颜色、合计与柱段对得上）。
  ✅ **浏览器实测（2026-10-13，用户"效果满意"）**：列与柱子对齐看着没问题；列宽 34px **够用**
    （5 位数也不挤）⇒ **别为"数字放不下"去调 `config.barWidth`**（真要调是"柱+格一起变宽、仍对齐"）。
  ⚠️ 桩不做布局 ⇒ 别的新铺入口/表格仍要在真浏览器里看一眼（这一条只覆盖本表）。

## 5. 来源 id 的显示（`local:v7` ⇒ 「默认值」）

- **来源 id 的显示**（`v9.1.15` 起，`v9.1.16` 补完第 4 处）：`local:v7`（"这条值不知道原始出处"）
  **显示成「默认值」** —— 映射**只有一处**：零依赖模块 `core/sourceLabel.js` 的 `srcLabel`（`BACKFILL_SRC` 也住那儿）。
  四个渲染点：值级面板的来源行 / `←` 行 / 「当前用」、`view/linkChips.js` 的链接 tooltip，
  **外加 `core/trust.js:projectField` 拼的那句人话理由**（`info.reason` —— 摘要行的「另有 X 说 Y（未采用）」就是它）。
  ⚠️ **`data-src="..."` 属性必须保持原始 id**（"优先/不用/真删"靠它认来源），别把它也换成标签。
  ⚠️ **为什么定义在 `core/sourceLabel.js` 而不是 `core/fieldValue.js`**：`trust.js` 的文件头声明"依赖：无"，
  而 `fieldValue.js` 反过来 `import { projectField } from './trust.js'` ⇒ 标签放那边**成环**。
  ⚠️ **这里真踩过两次，都只在"真加载这个模块"时才炸**（当时 `npm test` / `test:smoke` 都是绿的）：
  ① 给 `sourcePanel.js` "补 import"时把 `isEmptyFieldValue` 加成**重复声明**（`Identifier ... has already been declared`）；
  ② **用正则删它那段的局部 `srcLabel` 时，把紧挨着的 `actionBtn` 整个函数一起删了** ⇒
     凡是要画按钮的值级面板一律 `actionBtn is not defined`。
  ⇒ 判据：`scripts/smoke/src-label.smoke.mjs` **真的 import 一次**那个模块，并**端到端**钉住
  `info.reason` 也不露原始 id（两来源夹具）；**教训**：改 import / 删函数**别用正则**。

## 4. 账户对比表：行事件只许重画那一格

- **账户对比表：行事件只许重画那一格**（`v9.1.16`，用户报"每点一次折叠就多一个"）：
  `ui/stats/compare.js:renderTable` 的 `host` 是 `#compare-table-host`（**表格那一格**，不是面板）——
  组头 click 原来调**面板渲染器** `renderAccountCompare` ⇒ 整条控制条被画进表格格子里，
  顶部多一份、再点一次又多一份。⇒ 展开/收起只改 `expanded` 集，用**同一份 `matrix`** 调
  `renderTable(host, state, matrix, cols)`。守卫：`src/test/compare.test.js` 尾部的**源码级**锚
  （`renderTable` 正文里出现那个调用就红）—— 只能源码级：`scripts/smoke/dom.mjs` 不解析 `innerHTML`
  ⇒ `.compare-group` 恒空、click 永远绑不上。
