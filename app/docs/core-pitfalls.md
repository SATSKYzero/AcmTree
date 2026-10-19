# core 层的坑（从 `src/core/AGENTS.md` 搬来）

> ★ `src/core/AGENTS.md` 是**每次会话自动注入**的 ⇒ 那里只留"最常踩的几句 + 指针"，
> 症状 → 病根 → 判据全在这一篇。**动 core 之前先扫一眼这里。**

## 改这里的坑（都是实测踩过的）

- **节点对象是冻的**（`model/state.js` 的 `freezeNodes`）：事务外就地改节点**当场抛错**（这是刻意的守卫）。
  写状态的钩子只有两个：`replaceState`（加载/整包导入）与 `applyState`（每次事务/撤回）。
- **派生表增量复用"上一代的行"** ⇒ **要折的组头必须先在这一代重算它"自己那份"**
  （把要折的组头加进 `incremental.recompute`）。复用的行里躺的是上一代**折过组值**的结果，
  直接当 `A` 用会让组值**只涨不落**（成员从 AC 退回 WA、组头还显示通过）—— `v9.0.1` 修的正是这个。
- **增量名单**优先用写路径交来的那份（`derive.js` 的 `noteValueDelta`，**两代对得上才认**）；
  对不上就自己扫全表。**组划分动过（`ownerSynth`/`synthKey`）一律不接增量**（会静默错数）。
- **读派生表必须带与界面同形的 `scopeOpts`**：不然是另一个记忆化键，两张表互相顶掉
  （会被误判成"每次都在整份重算"—— 实测踩过）。
- **`plain`（默认）下不许触发任何聚合**；聚合只在去重模式、按**显示列**读（`viewDerivedDisplay`）。
- **按月分组的键是 `YYYY.MM`，不是 `YYYY.MM.DD`**（2026-10-13 真踩）：`core/trainingPlan.js` 的
  `daysInPeriod` 一开始只认"日键"，月粒度的期键解不出天数 ⇒ **每月目标折算成 0**（界面表现是"目标线贴着 0"）。
  同类坑：凡是"日期 → 期键"的解析，**先确认那个粒度的键长什么样**（日 `YYYY.MM.DD` / 周 = 周一那天 / 月 `YYYY.MM`）。
- ★ **按"组"去重时，字段值必须走显示口径（组那份），不能直读副本自己的字段**（2026-10-13）：
  训练计划的完成度用 `dedupRepresentatives` 一组留一条，而**代表只是"这条题"的代表** ——
  它的 `status2` 要是直读自己那份，就会出现"同一个组的另一条做完了、留下那条没做完 ⇒ 成绩被抹掉"。
  ⇒ 调用方一律传 `shownValue = viewDerivedDisplay(...) ?? viewValue(...)`（与统计页同一份）。
  判据：`src/test/trainingPlan.test.js` 里那条 dedup 用例（plain 算两次 / dedup 算一次，**但"做完"仍然算数**）。
- ★ **"值级投影"与"组值"是两条**独立的**轴 —— 改一条别以为治了另一条**（2026-10-16 真踩，用户报的）：
  同一个字段的"谁赢"有**两套规则、两处实现**：
  · **值级**（`core/trust.js:projectField`）= "同一个节点同一格的多个来源值"谁被采用；
  · **组值**（`core/groupValue.js:mergeField`）= "一个合成节点 + 它的成员"合出哪一份。
  症状：改了值级的来源优先级（`SOURCE_RANK`），用户看到的**还是旧的那个数** —— 因为他那格是**组值**
  （`0.77%` 来自某个成员，不是值级投影挑的）。查"这格到底走哪条"：有没有"成员：…（共 N）"那行
  （有 ⇒ 合成节点 ⇒ 组值）。
  判据：`ratio` / `xcpcDifficulty` 在**两条轴上都**按来源权威挑（`candidateScore` 只此一份，
  `mergeField` 里是 `agg.pick` 那一支）；口径 + 真包对拍（7396 组×字段 0 处不同）见
  `docs/field-rules.md` 的「4. 「优先级」：谁赢」一节。
- 改完**必须** `npm test`：里面有"增量 == 整份重算"的逐字段对拍（`src/test/deriveIncremental.test.js`）。

## 冻结白名单（`freezeTopLevel`）：已开 —— 守不变量，不是提速

> 2026-10-18 加、当天**打开**（用户："你该把操作-白名单用起来，那有利于以后的维护"）。
> ⚠️ **别把它当性能开关读**：三档实测都没有收益，留着的唯一理由是"事务外就地改顶层大字典当场炸"。

- **是什么**：`core/model/state.js` 的 `FROZEN_TOP_KEYS` + `freezeTopLevel(state)` —— 把 `childOrder` /
  `parentOf` / `pages`（以及每个副页的 `virtualIndex`）**只冻容器这一层**（值不冻 ⇒ 事务里照旧能写），
  在 `transaction/history.js:applyState` 末尾调用（= 每个事务的收尾，所以"换了就冻"是自动维持的）。
- **为什么留**：它把"**顶层大字典只在事务里换、不许就地改**"这条不变量变成**会当场抛错**的守卫
  （症状：`TypeError: Cannot add property x, object is not extensible`）。这条不变量本来就是真的，
  以前只靠人记着。
- **别指望它提速**：2026-10-18 实测三档（只冻 `parentOf` / ＋`childOrder` / ＋`pages`+`virtualIndex`）
  ⇒ `perf-bench` 的 `只 produce：updateP` 31 → **38–39ms**、`一次操作` 61 → **63–64ms**（变慢/持平）。
  ⇒ **"切页 produce 222ms" 的真病根不是深走**，是 `shell/executor.js` 在 produce 回调里跑
  `refreshAllVirtualStats`（切页已用 `skipVirtualStats: true` 治掉）。
- **写夹具的代价（踩过）**：凡"就地改这几张字典"的写法都炸。夹具侧统一用"**造状态前换可变副本**"：
  `AppState.childOrder = { ...AppState.childOrder }`（`parentOf`/`pages` 同理；页对象要**整个克隆**再改）。
  2026-10-18 已改过 6 个冒烟文件：`accounts` / `auto-import` / `import-synth` / `page-sync` / `ui-wiring` /
  `nodeinfo-target`（其中 `page-sync` 还有一处"收尾要重取 `AppState.pages` 里的活页对象，别用旧变量"）。
- **别把它当成"事务慢"的万能药**：`nodes` 那层的冻结是另一套（`freezeNodes` / `freezeNodeList`，一直开着）；
  这一套只管**顶层容器**。


## 事务、快照与派生索引（`parentOf`）—— 别把"派生"当成"可以不维护"

> 2026-10-18 差点踩：我看了一眼基准里"手动整拷 `{ ...parentOf }`"要 ~100ms，就提议
> "`parentOf` 别在事务里维护、改成按需派生" —— **那是错的，会砸掉撤回**。
> 用户一句"这些是为了可撤回必须在事务里维护的"才拦下来（原话："万一我不记得这件事就完蛋了"）。

- **哪些是真状态、哪些是派生**：快照只装 `SNAPSHOT_KEYS`（`transaction/history.js`），
  **`parentOf` 不在里面**（`src/test/history.test.js` 有一条"派生索引不进快照"的断言）。
- **`childOrder` 是真状态、必须留在事务里**：撤回 = 把快照按引用贴回去，`childOrder` 和 `nodes`
  一起被贴回 ⇒ **它既然在快照里，就不能改成"按需算"**。
- **`parentOf` 的维护点只有一处**：`applyState`（`transaction/history.js`）里
  `structChanged = snapshot.childOrder !== state.childOrder` 时才 `rebuildParentOf(childOrder)`
  （注释实测 ~9ms/次）⇒ 它**本来就是"结构变了才重建"**，不是每次事务整张拷。
- **想提速只能换形状、不能改归属**：`childOrder` 想便宜只能按父分桶（只 draft 一个桶）——
  分桶后**它仍然是快照里的状态**、撤回照旧；**别把任何真状态挪进"派生"**。
- **判据**：`src/test/history.test.js`（快照名单）+ `applyState` 的 `structChanged` 分支。
  ⚠️ 目前**没有**"结构改动之后撤回、`parentOf` 仍然对"的正面用例 —— 要动这块先补一条。
- ⚠️ **基准里的"手动整拷"不等于真实路径**：`perf-bench.mjs` 那两条 `{ ...childOrder }` /
  `{ ...parentOf }` 已分别标注"有代表性 / 仅参照"（`parentOf` 真实路径是 rebuild，~9ms）。
