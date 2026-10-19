# 值 / 多来源投影（从 `src/core/AGENTS.md` 搬来）

> ★ 来源层、投影、范围、"组那份"怎么读 —— 这一层没有目录可挂，所以笔记集中在这一篇。
> "一个字段怎么取（模板 / 两列值 / 显示列）"另有一篇：`docs/field-rules.md` 的「11. 跨层机制：一个字段"怎么取"（模板 / 两列值 / 显示列）」一节。

## 值 / 多来源投影

- **三层**：真源 = 来源层 `node.values[字段]`（"谁说的什么值"）→ **投影**（按「在查看的账户」范围筛；
  判据 `core/trust.js:usableValues`：**带账户的值超出范围就排除，不带账户的"客观值"永远算**）
  → **缓存字段** `node.xxx`（只是某一回范围的物化结果，**别直读**）。
- **"组那份"的取值器 `query/countPass.js:readOwnRow` 的每一列都必须给"本范围投影过的那一份"**：
  派生列用这一趟自己算的数组（`vS1/vS2/vC1/vC2/vAc/vLst/vDiff`），来源层字段用本文件唯一的投影读口
  `read`（= `core/fieldValue.js:readField`）。**读缓存字段（`node[field]`）会让同一行的各列不同源** ——
  `v9.1.9` 修的就是这个：组那份 `acTime` 记住**别人**账户的 AC、而同一行 `status2` 是投影
  ⇒「时间范围 AC 列表」里混进当前范围根本没 AC 的题，网格那一格却记成「未使用/已提交未通过」。
- ⚠️ `core/` **不许反向 import `view/`**：`view/scope.js:ownColumnReader` 只是**语义上要对齐**的那一份
  （按需那条路的取值器），代码别依赖它 —— core 层的投影读法**只有 `readField` 这一份**。
- 判据：`src/test/readOwnRowProjection.test.js`（合成夹具，**改前红**）；
  真包对拍：`OWNROW_INJECT=1 node --import ./scripts/smoke/register.mjs scripts/ownrow-audit.mjs`
  ⇒ 界面口径下"组那份 status2 ∉{3,4}"：改前 **133**、改后 **0**（不注入两边都是 0 —— 静态包没有缓存字段）。
- ★ **同类之内的先后 = `SOURCE_RANK`（来源级等级覆盖，`v9.4.19`；`v9.4.20` 补齐三档）** —— `kind` 只有四档
  （`manual > board > script > derived`），而"权威榜单"里权威度并不一样，所以**同类之内**再分三档：
  **现场/官方榜**（xcpcio / pta / rankland-index / srk 的 board 角色）＞
  **榜但混非正式**（CF gym 榜混 VP、牛客榜是多校/重现）＞ **脚本/补充**（其余一切）。
  用户 2026-10-16 的话："按道理，xcpcio/rankland/pta 优先于 cf，因为基本就是前者现场、后者混非正式"；
  "没说要分"= **不新增类别**。
  `usableValues` 里 `rank = sourceRankOf(src, kind) ?? 注册表那份 rank ?? 0`。
  ⚠️ **必须放读侧**：来源注册表是**写一次的**（`AutoImport/apply.js` 只在某个 src 首次出现时写 kind/rank）
  ⇒ 改适配器里声明的 `kind` 对**已有库**是死代码；这类"某个来源低一档"只能写在投影这一侧。
  ⚠️ 覆盖表**只写偏离类别默认的那一档**；**别在脚本档内部再细分**（实测"同一格两个来源"= **0** ⇒ 细分没有收益）。
  判据：`src/test/trust.test.js`（三档两两对拍 + "表里只写偏离默认的档次"）+ 跨语言镜像
  `src/test/sourceReportRanks.test.js`（含"等级不许与类别序矛盾"）。口径在 `docs/field-rules.md` 的「4. 「优先级」：谁赢」一节。
  ⚠️ **这一节讲的都是「值级」那条轴**（同一个节点同一格的多个来源值）—— **组值是另一条轴**
  （合成节点 + 它的成员合出哪一份，`core/groupValue.js:mergeField`），同一个字段的"谁赢"在那边**另有一套**；
  两条轴互不影响（改一条别以为治了另一条，实测踩过）。跨轴那条坑记在 `docs/core-pitfalls.md`。
- **手改值的归属（客观 / 账户私有）**：判据只有 `ops/node.js:manualScopeOf(draft, field, opts)` 一处 ——
  `opts.scope`（编辑框那次的选择）> `settings.manualScope`（设置里的全局默认＝**上次的选择**，`''` = 未设置）
  > 按字段回落（nature 四格客观、其余账户）。`account: ''` 就是客观值；**清空按"这次编辑的归属"清**
  （别再按字段名单分流）。一键"转成所有人共用" = `ops/node.js:promoteManualToObjective`。设计稿见
  `docs/manual-values.md`（含残余：显示那条 ≠ 这次归属时会"清不掉"）。
- ⚠️ 附带一条**不是** bug 的规则：范围过滤只排除"**带账户且不在范围内**"的值，缺账户归属的提交对谁都算
  （真包导入时"线索没匹配上 9698 / 源没给线索 17710" ⇒ 这批量很大，看到"队友的题出现在我的统计里"先查这个）。
- **「查看范围」里的账户 = 本账户（+ 开关开着时的直接子账户）**（`v9.1.23`）：
  规则**唯一一份** `core/trust.js:scopeAccountsFor`（开关 `mergeChildrenOf(settings)` 读的是
  `settings.scopeMergeChildren`，**默认关 = 原逻辑**，用户 2026-10-13 定成"一个选项、与原逻辑并列"）。
  ⚠️ **它有两个构造口，必须都调这一份**：`resolveScope`（`viewingAccount` 那一支）与
  `view/scope.js:scopeOpts`（`scopeAccounts` 那一支 = **树 / 统计 / 显示路径唯一的构造口**）。
  ⚠️ **传 `viewingAccount` 的调用点必须把 `settings` 一起传下去**（`resolveScope` 从 `opts.settings` 读开关）——
  少一处就是"树上把子账户算进去了、值级面板不认"；`derive.js:scopeKey` 也要 `accounts` + `settings`，
  否则**记忆化键与实际读用的范围不同源**（两张不同口径的表互相顶掉 ⇒ "改了设置没反应"）。
  ⚠️ "**不递归**子孙"是用户明确定的（只看直接子账户）。判据：`src/test/viewScope.test.js`（三条，含默认关的回归锚）。
  ★ **"范围"这件事有三个构造点，全都要用同一份规则**（漏一个就是"勾了某一处没反应"）：
  `resolveScope`、`view/scope.js:scopeOpts`、**`core/groupCompute.js` 造 `scopeId` 那里** ——
  最后那个是 `v9.1.25` 修的真坑：它原来自己写 `[viewingAccountId]`，于是**去重模式下读「组那份」时开关被整个绕过**
  （症状：父账户勾了"带子账户"仍一条取不到；`plain` 不走组那份 ⇒ 所以只在去重下显形）。
  ⚠️ 顺带一条**它自己的记忆化键**也要带上范围（`hit.scope`）：`cache_countPassOf` 的键里有，但它上面那层没有。
  ★ **口径**（用户 2026-10-13）：**「节点组合并」与「账户合并」是交叉但互不影响复杂性的两件事** ——
  组那边只管"多份怎么合成一份"（`AGG_BUILDERS`/`mergeField`/三趟），账户那边只管"在哪些值里挑"
  （`usableValues` 的范围过滤）；**唯一的交叉点**是"组那份要先按范围投影出各成员的自己那份、再合"
  ⇒ `groupCompute` 只需要"范围"这一个**输入**，**不该自己造范围**。改它时别把两套口径焊在一起。
- **来源 id → 给人看的名字：唯一一份在 `core/sourceLabel.js`**（零依赖：`BACKFILL_SRC` / `BACKFILL_LABEL` /
  `srcLabel`；`local:v7` ⇒ 「默认值」）。消费点横跨三层（`trust.js` 的人话理由 `info.reason`、
  `view/linkChips.js` 的 tooltip、`ui/G_modal/sourcePanel.js` 三个渲染点）⇒ 这是**跨层机制**，别在调用点各写一份。
  ⚠️ **别把它放进 `fieldValue.js`**：那个文件 `import { projectField } from './trust.js'`，而 `trust.js`
  的文件头声明"**依赖：无**" ⇒ 标签放那边**成环**。改这里先看 `src/ui/AGENTS.md` 的「来源 id 的显示」那条。
  ⚠️ 从 `fieldValue.js` **转出** `BACKFILL_SRC` 时必须写成 `import` + `export { BACKFILL_SRC };`
  —— 写成 `export { BACKFILL_SRC } from './sourceLabel.js'` **只转发、不把名字引进本模块作用域**，
  而本文件自己要读它 ⇒ `ReferenceError: BACKFILL_SRC is not defined`（2026-10-13 真踩，3 个测试文件红）。
- ★ **写值的分组口径：每组替换，不合并**（`v9.4.16`；用户 2026-10-15 看着值级面板说的：
  "导入更新的逻辑应该是**每组替换**而非合并" + "**每组还要按账户分组**"）。落点：`core/fieldValue.js:addSourceValue`。
  · **一组 = 同来源 + 同线索 + 同账户**（`clueKeyOf` 那三件；线索为空时不算组 —— 那说明"是不是同一条记录"无从判断）；
  · 组内**只留一条**：值变了就地换掉、组里多余的（老实现叠出来的第二条）**一并收掉**、同值只刷新 `at`；
  · 账户不同 ⇒ **不同组**（各留各的，谁也不顶掉谁）；线索不同同理（一次榜单多队）。
  ⚠️ **为什么必须有**：同一条记录后来改了口（QOJ 相对时间 `00:31:01` → 绝对时刻、PD → AC…）时，
  老实现按"来源 + **值** + 线索"找 ⇒ 找不到 ⇒ **叠出第二条**；而投影在"类别 / rank / 优先表"全相同时
  只能比 `at`，**平手就是"先到者胜"**（`core/trust.js:isBetter` 刻意稳定）⇒ 旧值永远显示着；
  同时重导会报"跳过"（新值已在列表里 ⇒ 没有字段要写）⇒ **看着像"导入没识别到更新"**。
  ⚠️ 返回值只回答"**多没多一条**"：刷新与整组替换都是 `false`（新增才 `true`）—— 别拿它当"有没有变化"。
  ⚠️ **已经叠出来的**那些不用人肉修：重导时"跳过但记来源"那条路也会走 `addSourceValue`
  （`features/AutoImport/apply.js`），组里多余的会被收掉 ⇒ 显示跟着回到新值。
  判据：`src/test/fieldValue.test.js` 里三条（整组替换 + 投影采纳新值 / 按账户分组 / **重导收掉旧的第二条**；
  把新口径关掉 ⇒ 当场红）。
