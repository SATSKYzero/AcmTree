# 题目 AC 时间的计算规则（可配置）

> **状态：设计稿（未实现）**。用户 2026-10-13 提出；**动手前先把下面「4. 待确认」拍掉**。
> 本文只给设计与判据；实现进度在末尾滚动更新。

---

## 1. 现状（代码事实，带行号）

「题目 AC 时间」= 派生字段 **`acTime`**，规则 = **取最早**，而且**三处实现必须同义**（文档里就这么写的）：

| 在哪 | 干什么 | 关键行 |
|---|---|---|
| `core/derive.js:79` | `derivePacTime`：派生表那条路 | `acTimes.sort(); return acTimes[0];` |
| `core/derive.js:118` | `derivePtriple`：把 `status2`/`acTime`/`lastSubmitTime` 合并成**一趟**（性能） | `minAc` 逐个取小 |
| `core/autoComputeRules.js:67` | `computePacTime`：**写缓存字段**那条路 | `acTimes.sort(); return acTimes[0];` |
| `core/groupValue.js:190` | `AGG_BUILDERS.acTime`：判重模式下「组那份」 | `combine: (a,b) => a < b ? a : b`（取最早） |

- **值的形状**：`'YYYY.MM.DD HH:mm[:ss]'`（占位符 `TIME_PLACEHOLDER = '----.--.-- --:--'`，`core/model/node.js:58`）。
- **比较一律是字符串比较**：格式本身可字典序排序；`utils/time.js` 的头注写着"存储/比较一律带秒（同分钟内多条提交才排得对，`acTime` 才准）"。
- **谁在读它**：树上 `view/builders.js:198`；训练追踪三视图 `ui/stats/ac/{tracking,heatmap,dailyList}.js`
  （⚠️ 这三处**故意读"本份"**，口径见 `src/test/dedupDisplay.test.js` 的 `DIRECT_READ_OK` 说明 —— 那是"**我**什么时候过的"）。
- **持久化**：`acTime` 是派生字段，**导入不覆盖**（`autoImportUpsert.test.js` 钉着）⇒ 规则一改就在本地重算，不会和包里的旧值打架。

---

## 2. 缺口（用户原话）

> "在实际训练过程中，同一题可能被用于训练多次且间隔很久，而由于题目 Ac 时间**取最早**，
> 除了第一次都不被计入训练追踪。"

根因不在训练追踪那三个视图 —— 它们读得没错；**是 `acTime` 这个字段本身只表达"第一次 AC"**：

- 热力图按 `acTime.split(' ')[0]` 分桶、AC 列表按 `acTime` 排序 ⇒ **一道题只贡献一个日期**；
- 同一题 2023 年 AC 过一次、2026 年重训又 AC 一次 ⇒ 2026 那次**整段看不见**（数量、日期都丢）。

---

## 3. 方案：把"怎么挑"收成一个可配置的纯函数

### 3.1 设置项（住 `state.settings`，与 `manualScope` 同级）

| 键 | 取值 | 含义 |
|---|---|---|
| `settings.acTimeRule` | `'earliest'`（**默认 = 现状**）\| `'latest'` \| `'cutoff'` | 从这题的 AC 里挑哪一条 |
| `settings.acTimeCutoff` | `''` 或 8/12/14 位数字 | 只有 `'cutoff'` 用得上 |

### 3.2 三种规则

1. **`earliest`**（默认）：全部 AC 里**最早**的那条 —— **与改前逐字相同**（回归锚）。
2. **`latest`**：全部 AC 里**最晚**的那条。
3. **`cutoff`**（用户原话："取一个截断时间，取截断后的最早时间（截断后没有就取最晚的）"）：
   1. 把每条 AC 时间规范化成 **14 位数字比较键**（`YYYYMMDDHHmmss`，分/秒缺的补 `0`）；
   2. 取 `key >= cutoffKey` 的那些里**最早**的一条；
   3. **一条都没有**（这题的 AC 全在截断之前）⇒ 取**全部里最晚**的那条（= 截断前最后一条）。
4. ★ **`cutoffIgnore`**（`v9.1.26`，用户 2026-10-13 追加的第 4 种）：
   **"截断后取最早，忽略截断前的所有提交"**，用途是**重复利用训练资源**。
   与第 3 种的分水岭：第 3 种只改"**显示哪一条** `acTime`"；第 4 种改的是
   **"哪些提交算存在"** —— 早于截断的那些（`key < cutoff`）**不算提交、不算 AC、也不算最新提交**
   ⇒ `status2` / `acTime` / `lastSubmitTime` 三格一起跟着变；截断后一条提交都没有 ⇒ 这题回「未使用」。
   ⚠️ **闭区间那两侧是互补的**：入选 `key >= cutoff`、忽略 `key < cutoff`（恰好等于截断 ⇒ **不**忽略）。
   ⚠️ **不写任何字段**（用户方向原话："提交**不存更多字段**，只是**按条件判断**（提交是否忽略）"）——
   纯函数 `isSubmissionIgnored(time, rule)`；R 行只按它**整体变淡**（`.node-ignored`，`index.html` 里那条 CSS）。

### 3.3 实现落点（**"怎么挑"只有一份**）

新建 `core/acTimeRule.js`（**零依赖纯函数**，与 `core/sourceLabel.js` 同一个套路）：

```js
pickAcTime(values, rule)   // values = ['2023.01.01 10:00:00', ...]（已滤掉占位符/空）
                           // rule = { rule: 'earliest'|'latest'|'cutoff', cutoff: '202601010000' }
```

上面 **4 个**消费点全部调它 —— 别各写一份（这正是现在"三处必须同义"那条注释存在的理由）。

---

## 4. 待确认 → **已拍板**（用户 2026-10-13）

1. ✅ **粒度 = 全局一个设置**（`settings.acTimeRule` / `settings.acTimeCutoff`，与 `countMode`/`manualScope` 同级；
   不进节点字段、不进导出包）。
2. ✅ **生效范围 = 改 `acTime` 的计算本身**（树 / 训练追踪 / 组那份 / 缓存**全跟着一致**）。
3. ✅ **12/14 位 = 按位数判精度**：8 位 `YYYYMMDD`（到天）、12 位 `YYYYMMDDHHmm`（到分）、
   14 位 `YYYYMMDDHHmmss`（到秒）。分隔符随便写（只数数字）。
4. ✅ **判重模式的「组那份」同口径**：`groupAggregateOf` / 三趟物化都把 `state` 透传给
   `AGG_BUILDERS` 的工厂（多一个可选入参 `ctx`），`combine` 就是"对这两个值再挑一次"。

---

## 5. 判据（实现后必须能红的）

- `pickAcTime` 纯函数单测：三种规则 × 边界（空表 / 全早于截断 / 恰好等于截断 / 秒级同分 / 8·12·14 位截断值）。
- **多个 AC 的题**：改规则后，那道题在热力图 / AC 列表里落到**另一个日期**（改前红）。
- **口径一致（对拍）**：`derivePacTime` / `derivePtriple` / `computePacTime` 三处对同一夹具**逐字同值**。
- **默认不回归**：`acTimeRule = 'earliest'` ⇒ 与改前**逐字相同**；真包对拍用
  `node --import ./scripts/smoke/register.mjs scripts/two-column-audit.mjs` 那一套的口径（或新增一个诊断）。
- `plain`（默认）下**不新增任何聚合**（硬规矩）。

---

## 6. 落点清单

| 文件 | 改什么 |
|---|---|
| `core/acTimeRule.js`（**新**） | `pickAcTime` + 规范化 14 位键 + 解析 8/12/14 位截断值 |
| `core/derive.js` | `derivePacTime` / `derivePtriple` 换用它（规则从 `state.settings` 取） |
| `core/autoComputeRules.js` | `computePacTime` 同上（规则从 `draft.settings` 取） |
| `core/groupValue.js` | `AGG_BUILDERS.acTime` 收规则；`groupAggregateOf` / `mergeField` 把 `state` 透传给工厂 |
| `core/model/state.js` | `settings.acTimeRule` / `settings.acTimeCutoff` 的默认值 |
| `ui/settings/settingsPage.js` | 一个下拉（三选一）+ 一个输入框（12/14 位；非 `cutoff` 时禁用） |
| `src/test/` | picker 单测 + 三处对拍 + "`earliest` 不回归"锚 |

---

## 7. 风险 / 要小心的地方

- **派生表缓存要跟着失效**：规则/截断值变了，`derive` 的记忆化键必须变（与 `settings.stats.countMode` 同一条路，
  别只改计算不改失效 ⇒ 会出现"改了设置没反应"）。
- **别给 `earliest`/`latest` 添开销**：规范化成 14 位数字只在 `cutoff` 规则下做；
  前两种仍用现成的字符串比较（真包 P 有一万五千多个，每格都规范化是白付）。
- **`derivePtriple` 是"一趟算齐"的性能路径**：改它时**不许**退回"三个函数各扫一遍"
  （文件头写着那一趟省 ~20~40ms）；picker 要能吃"已经收好的候选数组"。

---

## 8. 实现进度与残余（滚动更新）

- ✅ **已实现**（`v9.1.21`，2026-10-13）：`core/acTimeRule.js`（`pickAcTime` / `acTimeKey` /
  `normalizeAcTimeCutoff` / `acTimeRuleOf`）+ 四处消费点全部换用它 + 设置页两个控件 +
  改规则时**当场重算 P 的 `acTime` 缓存**（`autoCompute.js:recomputeAcTime`）。
- ✅ **判据**：`src/test/acTimeRule.test.js`（10 条：归一化边界 / 三种规则 / **三家同义** / 单次 AC 回归锚）+
  `scripts/smoke/settings-page.smoke.mjs` 的 ④″ 组（真设置页保存 → 落库 + 缓存跟着变 + 缺截断值不落库）。
  "重算缓存"那条**先红后绿都跑过**（把 `recomputeAcTime` 那行改成 `if (false)` ⇒ 实测红）。
- ✅ **性能对拍**（真包，`perf-bench.mjs` 的「F 派生表（冷）buildDerivedTable」）：
  改前 **122ms / 最小 105ms** → 改后 **116ms / 最小 106ms** ⇒ **无回归**
  （多的是"每个 AC 子节点一次 push"，省掉的是原来的 `sort()`）。
- ✅ **切规则的代价**（新引入的一笔，用户点一次「保存设置」付一次）：
  `recomputeAcTime` 实测 **45ms**（合成夹具：15390 个 P × 3 条 R；**纯 JS**）。
  ⚠️ 事务里那层 Immer 开销**没量**（要量得在真包上跑一次设置保存）—— 数字只会更大，别当成总额。
- ⚠️ **残余（已知、未治）**：`acTime` 是**物化缓存**，所以改规则要重算 —— 只扫了 P 一层。
  若哪天 P 的 `acTime` 还被别的物化结构（比如某个导出快照）抄了一份，那条也得跟着重算。
  目前 `grep '\.acTime\b'` 只看到 `derive.js` 的派生表（自己会按规则重算）与测试 ⇒ 没有别的抄本。

### 第 4 种规则（`cutoffIgnore`）已实现（`v9.1.26`）

- ✅ **一套纯函数**：`core/acTimeRule.js` 的 `isSubmissionIgnored(time, rule)`（**不写任何字段**）+
  `pickAcTime` 里 `cutoffIgnore` 那支（**先滤再取最早**；"截断后没有"就是**没有**，不再取最晚）。
- ✅ **过滤点（全都要过这一条）**：
  · `core/derive.js:derivePtriple`（**整个 R 跳过** ⇒ status2 / acTime / lastSubmitTime 一起跟着变）
  · `core/derive.js:derivePacTime`
  · `core/autoComputeRules.js:computePacTime` / `computePlastSubmitTime` / `computePstatus2`（写缓存那条路）
  · `view/renderers.js:renderRNode`（**整体变淡** `.node-ignored`，纯观感）
- ✅ **改规则时的重算**：`autoCompute.js:recomputeAcTime` 从"只算 `acTime`"扩成**三格一起算**
  （第 4 种会改 `status2` / `lastSubmitTime`，只算 `acTime` 会留下两个答案）。
- ✅ **判据**：`src/test/acTimeRule.test.js` 的 `isSubmissionIgnored` 那条 + **端到端**那条
  （截断前的 AC 不算 ⇒ status2 = 2、acTime = 占位、最新提交 = 截断后那发；全早于截断 ⇒ 回「未使用」）+
  `scripts/smoke/ignored-submission.smoke.mjs`（9 项：三种老规则不变淡 / 早于截断变淡 / 恰好等于不变淡 /
  仍画出来）+ `settings-page.smoke.mjs` 的 ④⁗ 组（下拉有它、缺截断值不落库、缓存三格一起重算）。
  两处**先红后绿都跑过**（去掉 `||` 过滤 ⇒ 端到端那条红；`recomputeAcTime` 只算 acTime ⇒ ④⁗ 红）。

## 9. 一句话口径（改这里的唯一入口）

**"题目 AC 时间怎么挑"只有一份实现：`core/acTimeRule.js` 的 `pickAcTime(values, rule)`，
规则由 `acTimeRuleOf(settings)` 归一（坏值/没设一律退回 `earliest`）。**
四处消费点都必须调它，别再各写一遍"排序取 `[0]`"：

| 消费点 | 在哪 |
|---|---|
| 派生表·单条 | `core/derive.js:derivePacTime` |
| 派生表·合并一趟 | `core/derive.js:derivePtriple` |
| 写缓存字段 | `core/autoComputeRules.js:computePacTime` / `computePlastSubmitTime` / `computePstatus2` |
| 判重模式「组那份」 | `core/groupValue.js:AGG_BUILDERS.acTime`（规则经 `ctx` 传进来） |
| R 行的**观感**（变淡） | `view/renderers.js:renderRNode`（`isSubmissionIgnored`，与上面**同一个函数**） |

★ **第 4 种规则（`cutoffIgnore`，"忽略截断前的提交"）再记住一条**："哪些提交不算"也只有**一份实现** ——
`core/acTimeRule.js:isSubmissionIgnored(time, rule)`；**算数**与**变淡**必须调同一个它，
否则会出现"看着算进去了、其实没算"（树上一半算了、另一半没算，正是这个仓库最恨的那种分叉）。

⚠️ **改规则要连带三件事**：① 派生表的记忆化键里要有规则（`derive.js:scopeKey` 已经加了 `|A<rule>:<cutoff>`）；
② **三个缓存字段**（`acTime` / `lastSubmitTime` / `status2`）要重算
（`autoCompute.js:recomputeAcTime`，设置页保存时在**同一事务**里调）；
③ 派生表 / 计数缓存要丢（`clearDerivedMemo()`，设置页 `onSuccess` 里调）。
少了任何一条，症状都是"改了设置没反应"或"缓存与派生表两个答案"。

★ **截断值（`settings.acTimeCutoff`）不与规则绑定 —— 一律照存**（`v9.1.28`，用户 2026-10-13：
"希望截断时间不要随模式切换丢失"）：设置页保存时写的是**输入框里那一份**，**不因为"当前规则用不到它"就清空**。
`v9.1.21`~`v9.1.27` 写的是 `acNeedsCutoff ? acCutoffRaw : ''` ⇒ 切到「取最早/取最晚」一存就把截断值抹了，
切回带截断的规则时**值没了、保存还会被"缺截断值"拦住**（用户看到的就是"丢失"）。
⚠️ 校验口径**没变**：只有"选了带截断的规则"才要求填（`acNeedsCutoff` 仍是那一处唯一判据），
"用不到也留着"不会让坏值参与计算 —— `acTimeRuleOf` 对不带截断的规则**只读 `rule`**。
判据：`scripts/smoke/settings-page.smoke.mjs` 的 ④⁵ 组（切走保存后 `acTimeCutoff` 一个字不少、切回来直接能存）。

## 10. 原料侧：`time` 只许是**绝对时刻**（QOJ 相对时间那件事）

**症状**（用户 2026-10-15："qoj 的 Ac 时间有问题"）：树上 P 的「AC时间」显示成 `00:31:01` ——
那是**比赛内的相对时间**（开赛后第 31 分钟），不是时刻。

**证据**（实测，别猜）：真包 `acm-data/raw/Scaper/04 qoj/qoj_submissions.json` 1116 条里，
**12 条**的 `提交时间` 是 `HH:MM:SS`（都是 contest 1873 那次 VP）——
场次页 `/contest/<id>/submissions` 对**参与窗口内**的提交给相对时间，
窗口外的补题给绝对时间（`qoj_adapter.py` 的文件头早就记着这条，但它只用来判 `submitKind`）。

**判据（两处，各管一件事，都是可执行的）**
| 谁 | 判什么 | 在哪 |
|---|---|---|
| `scripts/crate.py:_ONLY_TIME_RE` | **能不能当 `time` 用**（只有时间没有日期 ⇒ `''`） | `normalize_time()`；判据在 `crate_selftest.py` 的 ④′（4 条 + 3 条反向锚） |
| `04 qoj/QOJ_submissions_scraper.py:_REL_TIME` | **这一列的值属于哪一类**（相对 ⇒ 归档到 `相对提交时间`） | `split_submit_time()`；判据 = 该脚本 `--selftest`（10 项，挂在 `npm test`） |

**为什么两处都改（分别是治什么）**
- **`normalize_time` 那一刀**治"已经抓下来的原料"：12 条旧原料里 `提交时间` 就是相对值，
  重跑适配器**不会再联网抓一次**，所以必须在"能不能当时刻"这一关挡住 ⇒ 树上不再出现 `00:31:01`。
- **`split_submit_time` 那一刀**治"下一次抓"：两页的同一条提交按 `提交ID` 合并
  （`04 qoj/lib/qoj_common.py:merge_by_key`，规则是"新记录的非空字段覆盖旧的"），
  相对时间只要还在 `提交时间` 里，**谁后抓谁赢** ⇒ 按人抓一次全局列表页补上的绝对时间会被
  下一次场次页抓取**抹掉**。分列之后合并是**数据驱动**的：相对那份的 `提交时间` 是空的
  ⇒ 绝对那份永远留得住，且相对值当证据留在 `相对提交时间` 里。

**"只有相对时间就当没有"—— 落到哪几处（用户 2026-10-15 定的口径）**
1. **值那一关**：`normalize_time` 把 `HH:MM` / `HH:MM:SS` 判成**没有时刻**（`''`）。
2. **原料那一关**：`04 qoj` 下载器把相对值分到 `相对提交时间`（`提交时间` 只放绝对时刻）
   ⇒ 合并"空不覆盖非空" ⇒ 不管两页谁先谁后抓，绝对那份都留得住。
3. **包那一关（定稿口径）**：**拿不到绝对时刻的提交 —— 丢弃 + 警告**，不是"留个空 `time`"
   （用户 2026-10-15："这种应该是**丢弃提交并警告**，而不是整包建不了"）。
   落点：`05 xcpc/qoj_adapter.py:_add_contest_records` 里"没有绝对时刻就 `continue`"，
   并在 `warns` 里说清**几条、什么原因、去哪补**（命令写在里面）。
   ⚠️ **"空着 + 放行"这条路试过、走不通**（同一天）：写个空 `time` 留在包里 ⇒ `time` 在
   `field-registry.json` 里是 `required` ⇒ 体检判**真缺** ⇒ `field-coverage.py` 非零退出
   ⇒ **整条链停在体检那一步、树一动不动**（实测：`❌ 真缺：R.time 缺 12`）。
   给校验加 `allow_missing_time` 白名单也没用 —— 卡住的是**体检**，不是 crate 校验。
   ⇒ 所以 `validate_crate` 那条"R 必须有 time"**一个字没放宽**（进包的 R 一定有时间）。
4. ⚠️ **这只是兜底**（用户 2026-10-15："qoj 理应不会只能拿到 vp 时刻而拿不到绝对时间"）：
   正常状态是**按人抓过全局列表页**、绝对时刻都在 ⇒ 一条都不会丢。
   2026-10-15 实测：跑一次
   `py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter someone --cache-mode none`
   （60 页 / 600 条 / 52s）之后，那份原料里相对时间 **12 → 0**，QOJ 适配器 1116 条提交**一条没丢**。

**这一轮的判据（都能红）**
- `scripts/crate_selftest.py` ④′：`normalize_time` 那 7 条（**先红后绿验过**）。
- `04 qoj/QOJ_submissions_scraper.py --selftest`：10 项（分列 6 + **双向合并对拍** 4；先红后绿验过），
  已挂进 `src/test/pythonSelftests.test.js`。
- `05 xcpc/selftest.py`：夹具里加了"只有相对时间"的那条 ⇒ ① 它**没有进包**（丢弃）；
  ② 警告里说了原因与补法；③ 其余照旧 0 硬错误（`test_validate` **没有**放行名单）。
