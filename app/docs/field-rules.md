# 字段信息的规则（应有 / 已有 / 来源 / 优先级）

> 一句话：**每一格都要回答四个问题** —— 它**该不该有**（应有）、**现在有没有**（已有）、
> **谁给的**（来源）、**多个说法谁赢**（优先级）。
> 本文是这四样的**规则总表**；
> 一次维护的步骤看 `scraper-guide.md` 第四节，改字段要动哪几处看本文 §8。

四样各自的**真源**只有一份，改规则**只改真源**，别在别处再写一遍：

| 问题 | 真源 | 谁读它 |
|---|---|---|
| **应有** | `acm-data/field-registry.json`（21 条规则 + `groups` 段） | 构建侧 `scripts/field-coverage.py`；应用侧 `src/core/fieldRegistry.js`（**随包发布**，见 §7） |
| **已有** | 就是那一格的值（口径见 §2） | 体检报告 / 字段条 |
| **来源** | 包里每条记录的元列 `字段来源`（`{字段: 来源id}`） | 导入侧 `src/core/fieldValue.js`（写进来源层） |
| **优先级** | `src/core/trust.js` 的 `KIND_RANK`（类别）+ `SOURCE_RANK`（同类之内的来源级覆盖）+ `state.trust` | 投影 `projectField` / 界面 |

---

## 1. 「应有」：注册表三档 + 谓词

`expect` 三档，**后果不同**（这是它唯一的作用：决定"缺"要不要报、报多重）：

| 档位 | 缺了算 | 后果 | 例子 |
|---|---|---|---|
| `required` | **真缺** | 体检**非零退出**（链条/CI 当失败）；字段条上**红色** | `name` / `problemId` / `time` / `status` / `natureClass` |
| `expected` | **可疑** | 只提示、不失败；字段条上**琥珀色** | `cfDifficulty` / `natureYear`·`Season`·`Region` |
| `optional` | **允许** | 不报；字段条上缺了只说「无」 | `link` / `ratio` / `tags` / `contestTime` / 来源类字段 / **`language`** |

⚠️ **档位要照实写**，别一律 `required`：`ratio` 缺 82% 其实大部分题**本来就不在任何带通过率的渠道里**
—— 一律 required 只会天天喊狼来了（`v8.5-plan` §34.3）。

★ **需求清单也认这个档**（2026-10-15）：`material-needs.py` 只给 `required` / `expected` 派需求；
`optional` 字段**默认不派** —— 要连它一起抓，必须在注册表那条上**显式**写 `pursue` / `pursueByPrefix`
（`link` / `contestTime` 就是这么办的：`{'aux-rankland:': 'low'}` ⇒ 只在 `--pursue low` 时才进清单）。
病根实例：`language` 是 `optional`，而 QOJ **场次页根本没有"语言"那一列**（只有全局列表页
`/submissions?submitter=` 有）⇒ 那条需求写着"重跑该渠道的提交适配器"，**永远补不上**、还每轮重建报一次。

### 1.1 `when` 谓词（"这条规则管哪些记录"）

谓词**不成立** ⇒ 这条规则当"不适用"：既不报真缺、也不报可疑，字段条上显示「应有：不适用」。

| 谓词 | 含义 | 例子 |
|---|---|---|
| `extKeyPrefix` | 身份键以它开头（可给数组 = 任一） | `cf:c:` 只判 CF 正式轮次 |
| `notExtKeyPrefix` | 以它开头就**豁免** | `aux-`（辅助树占位题没有题名）、`aux-pta:`（PTA 没有语言字段 / 不返回耗时与内存）、`cf:`·`hdu:`·`atcoder:`（接口不返回代码长度）、`qoj:`（名册里 3506 场只有 107 场带真日期 ⇒ 结构性没有开赛时间）、`synth:`（合成节点是**组头**，不重复携带成员的值） |
| `contestIdBelow` | 身份键里的比赛号 < N（用来排除"另一种东西"） | `100000` ⇒ 排除 gym（CF 不给 gym 题难度分）；也用于 `contestTime`：**CF 号 ≥10 万的那些根本不在 `contest.list` 里**（名字与时间都是 `None`）⇒ 上游没有时间 |
| `parentKind` | 父记录的节点类型 | `C` 下的题、`R` 挂在 `P` 下 |
| `notStatus` | **这几种判定本来就没有这项数据**（2026-10-03 加） | `memoryUsed`: `[CE, TLE, JF, PD, JG]`（牛客 TLE 只给时间不给内存、CE 程序没跑起来、判题机出错/还在判更不会有）；`timeUsed`: `[CE, MLE, JF, PD, JG]` |

> ⚠️ 规则里还有一个 `when.evidence`（如 `cf-page`），但它**不是谓词** ——
> 谓词函数（Python `predicate_holds()` / JS `predicateHolds()`）**不读它**；
> 它由 `field-coverage.py` 的 `evidence_says_none()` 消费，作用是"这一格的**实际有**另有参考源"（见 §6）。

⚠️ **只认认识的键**（多写的键不参与判定，构建侧与应用侧一致）；加新谓词要**两边同时加**
（Python `predicate_holds()` + JS `predicateHolds()`），并各补一条单测。

#### 1.1.1 `coverage: false`：整个字段**不参与体检**（2026-10-03）

有些字段**有能力填、但决定不填** —— 它们不该一直挂在"可有可无而缺"里当噪声。
规则上加一行 `"coverage": false` 即可：构建侧 `rules_for()` 直接跳过（**连行都不出现**），
应用侧字段条显示「应有：**不查**」（`expectOf()` 的 `noCoverage`），理由写在规则的 `why` 里。

现行有两条：**`tags`**（"**都不填，只声明**" —— CF 的
`api/problemset.problems` 里 `tags` 现成、零额外请求，但决定不要）
与 **`submitKind`**（它的 `why` 早就写着"**判不出就留空是正常状态**" ⇒ 留空不该报成缺口）。
⚠️ 字段本身照旧可用（标签管理器 / 题目检索的 facet / 导出都吃 `tags`；提交性质那枚小标签照旧显示），
只是内容靠人填或由其他判据给。

> 2026-10-03 两轮收紧（"减少缺" → "处理其他缺失"）：**可选而缺 36,942 → 1,109 → 179**。
> 剩下的 179 只有两行，且都实测过是**上游没有**：`aux-rankland` 的 171 道题链接
> （rankland 索引与 refs 片段里对那些**0 命中**）与 8 场开赛时间。

#### 1.1.2 `pursue`：「**追值**」—— 值不值得追（2026-10-03）

> 📌 下面这些**绝对数**都是**本仓库那份包**的实测，拿来交代"当时为什么这么定"。
> 换成你自己的数据，**绝对数会变、口径不变** —— 要看你自己的，跑
> `python -B scripts/field-coverage.py` / `scripts/material-needs.py` 看它的输出。

"**有证据实际没有**"（§6 的 `when.evidence` ⇒ 豁免）与"**没证据的缺**"之间原来是个空档：
有些缺口**没查过、也查不到**，但我们**估计它多半永远拿不到**。`pursue` 就是给这种"不确定能不能爬到"
的缺口一个优先级 —— ⚠️ 它是**人的判断，不是证据**（证据那套说"查过了没有"，它说"我估计没有"）。

| 档 | 含义 | 界面 |
|---|---|---|
| `high` | **值得优先追**（明确能爬到） | 表里 ⏫ 值得追 |
| `normal` | 默认 | —（不显摆，不占注意） |
| `low` | **多半永远拿不到** ⇒ 只记账、别花力气追 | 表里 ⏬ 多半拿不到 |

- 写在规则的 `pursue` 上（整字段一档），或 **按来源覆盖**：`"pursueByPrefix": {"aux-rankland:": "low"}`。
- 一行里缺的那些格**取最高的一档**（有值得追的部分，这一行就值得看），各档计数在 `pursueCounts`。
- 现行：`link` 与 `contestTime` 的 **`aux-rankland:`** 都是 `low`（"rankland 当然是没有题目链接的"、
  "开赛时间如果没有，那很可能永远不会有"）⇒ 这批格子页头直说"**别花力气追**"。
- ⚠️ `low` 仍然是"**缺**"（没证据），只是优先级低 —— **别和"豁免"混**。

**建包时怎么选**（"让重爬优先级可在指令/主脚本建包中选择"）——
门槛决定"**标了 `low` 的格子算不算这一轮的需求**"：

| 在哪选 | 怎么给 | 效果 |
|---|---|---|
| 指令 | `material-needs.py --pursue high\|normal\|low`（默认 `normal`） | 低于这一档的缺口**不进需求清单**，只报一句"另有 N 格被门槛挡下" |
| 主脚本建包 | `build-all.py --needs --pursue <档>` | 透传给上面那条（**探数据与清单一起**）；不带 `--needs` 时它只管链尾那步「原料需求」报告 |
| 链尾那步 | `build_chain.steps_for(..., pursue=...)` | 与建包脚本**共用同一份步骤表**；`build-all.py --list` 里看得见 `⟨--pursue low⟩` |
| **应用里那个按钮** | 工具栏「档位」下拉框（"主脚本建包不能手输指令，给个选项"） | **6 个写死的预设**（**顺序 = 越轻越前**），每个预设**同时**定下两个轴：**① 离线重建**（= `--offline`，一次不联网、只用本地原料，**不更新数据**）/ **② 标准重建**（默认选中，= 老行为：用现有原料、缺的才抓）/ **③ 按需求补抓**（`--needs`）/ **④ 补抓 + 连 low 一起**（`--needs --pursue low`）/ **⑤ 兜底重探**（`--needs --probe-all`：忘掉"拿不到"的旧结论）/ **⑥ 全删重爬**（`--purge`：先 `prune-raw.py --apply` 再去整份重抓）。⚠️ **"离线"与"补抓"互斥**（`--offline` 与联网那几档互斥）⇒ 它们必须各自是一整档，不能拼成一个组合。页面仍只能传"一个布尔 + 一个枚举名" |
| ★ **原料分三档、删除只在一处** | `prune-raw.py --apply`（判定在 `acm-data/raw/Scaper/lib/material.py`） | 用户 2026-10-17 定的两条口径：**"其他档位不应有任何删除，只有增量合并"** ＋ **原料分三档「进包 / 不进包但保留 / 不保留」**（档决定产包该不该读，不是读了什么反推档）。只有「全删重爬」那一档会跑 prune、也只有它 `--force` 整份重抓，而且 **prune 只删第三档**；其余档位缺的才抓、抓不到就保留旧文件 |

- `normal`（默认）= **跳过 `low`**（"多半拿不到"就别花力气追）；`low` = 连它们一起抓（**这才会有卡**）；
  `high` = 只抓明确值得追的（比默认更省）。
- ⚠️ **门槛只改"这一轮抓不抓"，不改"这一格算不算缺"**：被挡下的格不是"缺"，而是**单独一档**
  `missingLow`（页头那句"另有 N 格被门槛挡下"数的就是它；自测钉住）——
  与"豁免（有证据"实际没有"）"仍是三件不同的事：**豁免 / 多半拿不到 / 真缺**。
- **现行效果**（实测）：默认与 `high` 档下，标了 `low` 的格子全被门槛挡下 ⇒ 可能**一条需求都不派**
  （页头报"另有 N 格被门槛挡下"，N 是当轮实算）；`--pursue low`（或应用里选「补抓 + 连"多半拿不到"
  一起」）才出那两张卡 —— RankLand 的**题链接**与**开赛时间**，正是标了 `pursue: low` 的那批。
  ⚠️ 那两条 `NEED_RULES` 是**专为 `low` 档加的**（默认档一条都不派），否则这个选项"选了也没东西"。
- ⚠️ 加/改档位要动**三处**：`scripts/build_chain.py` 的 `BUILD_MODES`（键是契约）+
  `src/features/AutoImport/buildApi.js` 的 `BUILD_MODES`（页面下拉框的标签）+ 这张表；
  键名对不上 ⇒ 服务器 `mode_of()` 认不出、按默认档跑（**不会跑错东西**，但选项像没生效）。

### 1.2 现行 21 条规则（速查）

| 字段 | 档位 | 类型 | 谓词 / 备注 |
|---|---|---|---|
| `natureClass` | required | C | 分类路径是骨架；**全库没有一格空着**（要自己核就跑 `python -B scripts/field-coverage.py`，看「真缺」是不是 0） |
| `natureYear` / `natureSeason` | expected | C | 合法值只有 `^(20\d{2}\|无\|待同步\|不确定\|上游异常)$` —— 这些都**算有值**（是结论，不是空缺） |
| `natureRegion` | expected | C | 自由文本（无 pattern）；`无`/`不需要`/`待填写`/`不知道` **都算有值**（其中 `待填写`/`不需要`/`不知道` **只有这一格收**） |
| `name` | required | 除 R 外的所有 | 豁免 `aux-`（占位题的题名由主树那份给） |
| `problemId` | required | P | 题号是身份之一 |
| `time` / `status` | required | R | 提交没时间/没判定就没有意义 |
| `cfDifficulty` | expected | P | `extKeyPrefix: cf:c:` + `contestIdBelow: 100000` + `evidence: cf-page` |
| `atcoderDifficulty` / `clistDifficulty` | expected | P | `extKeyPrefix: atcoder:` / `clist` + `evidence: atcoder-models` / `clist`（三员同组，见 §5.3） |
| `language` | **optional** | R | "language 直接标可有可无"；`aux-pta:` 豁免 |
| `kind` / `contestTime` / `link` / `ratio` / `tags` | optional | C / C / * / P / P | 各渠道给不给不一致 |
| `timeUsed` / `memoryUsed` / `codeLength` / `submitKind` | optional | R | 运行信息，拿不到就算了 |

⚠️ **没进注册表的列**（`identityKey` / `ownerSynth`）在字段条上**不显示"应有"那一行** ——
那是有意的：它们是元列/派生列，没有"该不该有"的口径。

---

## 2. 「已有」的口径

`is_filled`（构建侧 `scripts/field-coverage.py`，应用侧 `isFilledValue`，**必须一致**）：

- `null` / `undefined` / 空串 / 全是空白 ⇒ **没有**
- `[]` / `{}` ⇒ **没有**
- **`0` ⇒ 有**（时间 0 秒、内存 0 KB 都是真实数据）
- 特殊值算有：`无` / `待填写` / `不需要` / `不确定` / `待同步`（那是**结论**，不是空缺）

⚠️ **应用里那一行问的是"界面上那个值"**（投影值 `viewValue`：按优先级/账户/失效标记算出来的），
不是缓存字段 `node[field]` —— 否则会出现"输入框里有值，那行却说缺"。

---

### 2.1 体检的「四档」：已有 / 缺 / 豁免 / **多半拿不到**

**「多半拿不到」与「已填」「缺」「豁免」并列，不算缺**。所以每个「类型 × 字段」
的两个数之外，还有**四档**（`scripts/field-coverage.py` → 报告 → 应用「🩺 体检 / 需求」页）：

| 档 | 判据 | 算缺吗 |
|---|---|---|
| **已有** | `is_filled`（上面那几条） | — |
| **豁免** | **有证据"实际没有"**（CF 题目页面 / clist 缓存 / AtCoder 模型说它确实没有） | **不算** |
| **多半拿不到** | 注册表标了 `pursue: low`（人已判断"追也多半追不到"）—— 新 `missingLow` | **不算** |
| **缺** | 剩下那些**该有却没有** ⇒ 真缺（`required`）/ 可疑（`expected`）/ 同组不一致 的判据**只看它** | ✅ |

⚠️ **与此前口径相反的正是这一条**：老注释写着"`pursue` 是人的判断、不改体检结论" ⇒ 那些标了
`pursue: low` 的格子在体检里一直算"缺"。现在它们有自己那一档，**不计入缺**。

⚠️ 但"**追值**"这套**没有被删**：`pursueCounts` / `lowPursueCount` 仍然把 `pursue: low` 的格子算进去 ——
那是**抓取计划**（`material-needs.py --pursue low` 靠它列出"该追哪些格子"），与"算不算缺"是**两件事**。

---

## 3. 「来源」：每格都记，合并**不丢**

- **包里**：元列 `字段来源` = `{字段: 来源id}`（`crate-merge` 逐字段写、有字段才写；缺这一列时
  应用回落到"整条记录一个来源 id"，见 `core/fieldValue.js`）。
- **应用里**：`node.values[字段]` 是**每个来源一条**的数组（`{v, src, at, account?, clue?, linkKind?}`）。
- **合并（构建侧 `scripts/crate-merge.mjs`）**：
  - 身份冲突（同 extKey 类型/父不同）⇒ 报错并丢弃该条；
  - ⚠️ 丢记录**只有这两类**：上面这条，以及解析层剔除"根本不是一条记录"的条目
    （`bad-record` / `bad-type` / `missing-extkey`，逐条报出来，见 `features/AutoImport/parse.js`）。
    其余冲突一律"保留先到 + 落选值进 `其它来源值`"，**不丢**；
  - 同字段不同来源给了不同值 ⇒ **保留先到**，落选值写进元列 `其它来源值`（带自己的 src），
    导入时按**各自来源**写进来源层 ⇒ **不丢**（条目形状 `{v, src}`、"键是本记录的列"、
    "落选值不等于被采用的那份"由 `scripts/smoke/crate-invariants.smoke.mjs` 巡检）；
  - 先到没这个字段 ⇒ 补上（信息更全）；
  - 输入自带 `字段来源` 时**逐字段沿用**（否则第二层合并会把每格都盖成 `crate-merge`）。
- **合并（应用侧）**：同来源 + 同值 + 同线索 ⇒ 合并；**同来源不同值 ⇒ 追加**，绝不覆盖。
- ⚠️ 三处**有意**的例外：① 身份冲突那条（报错）；② **手改**同账户只留最新一条（"我现在要什么"）；
  ③ 每字段最多 **12** 条来源值（`MAX_VALUES_PER_FIELD`），超限丢**最旧**的。

---

## 4. 「优先级」：谁赢

- **类别序**（`KIND_RANK`）：`manual` 100 > `board` 30（权威榜单）> `script` 20（脚本/爬虫）> `derived` 10（派生）。
  真源只有 `core/trust.js` 一处（以前 `apply.js` / `state.js` / `fieldValue.js` 各有一份，改一处另两处不知道 ⇒ 静默压错值）。
  ⚠️ 另有一份**故意不同**：`fieldValue.js` 里"v7 迁移带入、不知原始出处"的那档是 **rank 90** —— 要低于手改、高于任何抓来的。
- ★ **同类之内还会再排**（`SOURCE_RANK`，同一个 `core/trust.js`；`v9.4.19` 起）：`kind` 只有四档，
  而"权威榜单"里权威度并不一样（用户 2026-10-16："按道理，xcpcio/rankland/pta 优先于 cf，
  因为基本就是前者现场、后者混非正式"；"没说要分"= **不新增类别**）。全表**三档**：
  · **现场/官方榜**（`xcpcio` / `pta` / `rankland-index` / `srk` 的 **board** 角色）；
  · **榜但混了非正式**（`cf-*` 的 board = CF gym 混 VP；`nk-*` 的 board = 牛客多校/重现）；
  · **脚本/补充**（其余一切：`cf-titles`/`cf-web`/`cf-contest`、`qoj`、`atcoder`、`nk-scraper`、
    `hdu-scraper`、`rankland-refs`、`rankland-index`/`srk` 的 titles 角色、`synth`…）。
  ⚠️ **覆盖表里只写"偏离类别默认"的那一档**（写了 30/20 档就是第二份真源）；
  **别在脚本档内部再分先后** —— 脚本之间几乎从不撞同一格（不同树 + 包内每格只有一个来源）。
  · 判据 `sourceRankOf(src, kind)`：命中覆盖表就**压过**注册表里那份 `rank`，没命中就沿用（回落 `KIND_RANK[kind]`）；
  · **必须放读侧**：来源注册表是**写一次的**（`AutoImport/apply.js` 只在某个 src 首次出现时写 kind/rank）
    ⇒ 已有库里那些来源**重导包也不会更新** ⇒ 改适配器里声明的 kind 对老数据是死代码；
  · 硬约束：**不许与类别序矛盾**（任何 board 的等级 > 任何 script 的等级），守卫
    `src/test/sourceReportRanks.test.js` 正反各验一遍（含跨语言那份 `source_report.py` 的镜像表）。
- **用户可改**：`fieldPrefer`（**这个字段**以后听谁的）、`groupPrefer`（这一组显示哪一员）。
  ⚠️ 别写 `state.trust.sourceRank` —— 仓里**没有**这个键、也没有任何界面写它（`rank` 由上面两处算出来）。
- ★ **组值里的「通过率 + 它的档」也按来源权威挑**（`v9.4.21`；`core/groupValue.js` 的 `mergeField`，
  标记是 `AGG_BUILDERS` 里的 `pick`）—— 组值那条路原先是"**组头自己那份 → 成员按树序先到者**"，
  **完全不看来源**。而"成员之间谁对"这件事分两种：难度数值**无序**（1200 vs 1500 无从比较 ⇒ 仍按先到者，
  用户 2026-10-16 之前的口径不变），**通过率有对错** —— 这一场的权威榜说了算
  （用户的实例：xcpcio 榜 `0.19%` 被某个成员身上**残留的** cf `0.77%` 压住了，而导入**只加不删**）。
  · 判据 `candidateScore`（**与值级投影同一份**：手改 > 字段偏好 > 类别序 > 来源等级），**平手仍按老顺序**；
  · "说不出出处"（值层里没有对应来源条目 = 缓存 / 上一层倒推 / 纯派生）⇒ 排**最后**；
    **两边都没出处** ⇒ 平手 ⇒ 行为与旧版一字不差（老数据不会因此变化）；
  · `xcpcDifficulty` 是 `ratio` 的纯函数（`derive.js`）⇒ `pick: 'ratio'`：跟**该成员 ratio 那份值的出处**走，
    否则会显示成 `0.19%(R)` 这种自相矛盾；
  · 对拍（真包 A/B：改后 vs **把信任表清空**（= 所有候选都"说不出出处" ⇒ 平手 ⇒ 先到者 = 改前））：
    **7396 组×字段，0 处不同**（包里成员之间从不打架）；判据 `src/test/groupValue.test.js` 那 4 条。
- **级别徽标**（`M/A/B/C/D`，`src/core/fieldLevel.js`）：人改 `M`、权威榜单 `A`、脚本 `B`、派生 `C`、
  旧回填 `D`；**nature 字段有规则 id 时以规则为准**（更精确）。认不出来源 ⇒ 空（不瞎猜）。
- ⚠️ **级别 ≠ 优先级**：优先级决定"谁的值胜出"，级别回答"这一格有多硬"。
- ⚠️ **来源表必须覆盖记录里用到的每个 id**（含 `manual`）：表里查不到 kind 的 id 只能当"未知 ⇒ script"，
  级别就错了（`crate-invariants` 冒烟测试常驻盯着这条）。

---

## 5. 判「应该有没有」的**两条别混**的判据

| 问题 | 判据 | 落在哪 |
|---|---|---|
| 这格**应该**有吗 | **场次计不计分**（官网「Past contests filter → Rated: Yes/No」） | `cache/cf_contest/rated_list.json`，判在 `scripts/material-needs.py` |
| 这格**实际**有吗 | **CF 题目页面上写没写 `Difficulty`**（参考 `https://codeforces.com/problemset`） | `cache/cf_contest/page_difficulty.json`，三态判据在 `lib/cf_page_evidence.py` |
| 我们**手上**有吗 | 包里那一格的值 | 体检 / 字段条 |

页面证据三态：`has`（实际有 ⇒ 补值）/ `none`（查过、页面没写、证据新鲜 ⇒ **本来就没有**，可豁免）/
`unknown`（没查过或证据过期 ⇒ **去查一次**）。否定证据带 **30 天保质期**（新题打完分能自己补上）。

⚠️ **被推翻的路**（别再走）：用"这轮计不计分"推"这题有没有难度"（663/664/1345 都在 Rated: No 里，
题目页面上却有难度 —— 那是"实际有"，与"应该有 = 否"**同时成立**）；用题池那条 `rating: null` 判
"要不要抓"（那只是 **API** 没给，而且新题还没打分也是 null）；用赛名 / `types.json` 标签判（都不干净）。


### 5.1 三档开关：**防重爬 / 不断试爬 / 兜底全重爬**

"能否对旧题的误判（所属比赛说有 rating、实际无）**自动作出措施以防以后不停重爬**，
又能**不断试爬新题**的 rating，同时又有**选项可以兜底全部重爬**？"

| 档 | 怎么开 | 行为 | 请求量 |
|---|---|---|---|
| **① 防重爬（默认，自动）** | 什么都不用做 | 有结论的格子**一次也不联网**：`has`（页面有）和 `none`（查过、页面没写、**证据还新鲜**）都算结论 | 0 |
| **② 不断试爬（默认，自动）** | 什么都不用做 | 否定证据 **30 天保质期**（`PAGE_NEG_TTL`）⇒ 过期自动变回"没结论"、再去试一次；**新场次天然是"没结论"** ⇒ 第一次就会试 | 每 30 天一轮、只试"缺的" |
| **③ 兜底全部重爬（显式）** | `cf_contest_adapter.py --fill-difficulty --all`<br>或 `material-needs.py --probe --probe-all`<br>`build-all.py --needs --probe-all`（2026-10-03 才真的接上，见下） | **忽略已记下的结论**，把所有缺难度的题全部重查一遍 | 本轮 25 道 |
| （微调）保质期 | `--fill-difficulty --neg-ttl-days N`<br>`0` = 每次重查、`30` = 默认、调大 = 更少重爬 | 只改 ② 的窗口 | — |
| （配）**重爬优先级**<br>= 哪些缺口**值得抓** | `material-needs.py --pursue high\|normal\|low`（默认 `normal`）<br>`build-all.py --needs --pursue <档>` | 见 §1.1.2：`low` 档 = "多半拿不到"，**默认不追**；`low` 档的格子只在 `--pursue low` 时进需求清单 | 只改清单，不改请求次数 |

⚠️ **两处探数据档位的一处旧账**（2026-10-03 还上）：`build-all.py` 以前**没有** `--probe-all`
（它写死第②档），文档却一直写着 `--needs --probe-all` ⇒ 现在补上了，`--needs` 开跑前会明说
自己在**第②档还是第③档**。

**规则一句话**：**判定**决定"要不要碰网络"（有结论就不碰、过期才碰），
**`--all`** 是那条判定的**逃生门**（显式要求时才忽略结论）。

⚠️ 两处都**只查"缺"的题**：已经有值的题重查没有收益 —— 要重抓**题池**（API）本身用
`--force`；`build-all.py --needs` 会按需求丢掉对应渠道的缓存再重建。

⚠️ **试爬失败不改已有结论**：请求失败只是跳过那一题（`continue`），旧的 `none` 仍然有效
（单测钉住）—— 否则一次网络抖动就会把 25 个结论全抹掉，变成"每次都重爬"。


### 5.2 字段组：同一类信息、各来源各写各的字段（2026-10-02 第二十五轮）

"现在 cf 就有本身难度 & clist 难度两个，所以是时候让**数值难度也成为字段组**了"
+ "注意数值难度可能有需要**快捷切换所查看系列**的需求"。

**组**回答的是"这一类信息到底有没有、我现在看哪个"；**成员字段**回答"这个来源给没给"。
两者**并存、不互相替代** —— 只看成员会把"CF 有、AtCoder 没有"报成缺口（那是正常的）。

| 概念 | 定义在哪 | 语义 |
|---|---|---|
| 组 | 注册表 `groups` 段（**随包发布**） | `{组名: {fields, expect, anyOf, types, why}}`；`anyOf: true` = **任一成员有值 ⇒ 组有值** |
| 组级统计 | `scripts/field-coverage.py` 的 `group_rows()` | 组级 applies/filled/missing（成员全缺才算组缺）+ 同组不一致照报 |
| 组级显示 | `src/core/fieldRegistry.js` | `groupOfField` / `groupValues` / `pickInGroup` / `groupNoteHtml` |
| 组偏好 | `state.trust.groupPrefer = {组名: 成员字段}` | "这一组以后显示哪个成员"（**显示口径**，不改任何来源的值） |

**现行组**：`数值难度 = [cfDifficulty, atcoderDifficulty, clistDifficulty]`（`expect: expected`）。
⚠️ **成员顺序 = 界面默认显示哪一员**（越靠前越「原厂」：CF 官方 > AtCoder > clist）；用户可以在字段条上快捷切换（存 `trust.groupPrefer`）。

**组那一行长什么样**（字段条上，成员字段旁边都有）：

```
数值难度：cf 1200        切到 atcoder 300        取消偏好
数值难度：atcoder 300（你选的）
数值难度：缺（cf / atcoder 都没有）      ← 琥珀（expected）
```

**选择规则只有一条**（`pickInGroup`，别在别处再写一遍）：
① `trust.groupPrefer` 指定的成员**有值**就用它；② 否则按注册表成员顺序取第一个有值的
（顺序 = 优先级声明：`cfDifficulty` 在 `atcoderDifficulty` 前）；③ 都没有 ⇒ 组缺。

⚠️ **两件事别混**：`fieldPrefer` 管"同一个字段的多个**来源**值谁赢"；
`groupPrefer` 管"这一**组**里显示哪一个**字段**"。
⚠️ `normalizeTrust` 是白名单式构造 ⇒ **加一个 trust 子键要同时改 `core/trust.js`**，
否则用户设完偏好刷新就没了（`fieldPrefer` 当年就是这么踩的，`groupPrefer` 这轮差点重蹈）。

### 5.3 数值难度：现在有哪几员、谁写谁

| 字段 | 来源 | 数据形状 | 判据 |
|---|---|---|---|
| `cfDifficulty` | CF 官方 `api/problemset.problems` + 题目页面兜底 | 正数（如 `2000`） | **应该有** = 场次计分；**实际有** = 题目页面（§5） |
| `atcoderDifficulty` | AtCoder **kenkoooo** `problem-models.json`（公开无 key，5148 条） | **可正可负**（如 `abc138_a = -848`） | 缺 = kenkoooo 还没估分（**不写负结论**）⇒ 重跑适配器即可 |
| `clistDifficulty` | **CLIST** `clist.by/api/v4/problem/` 的 `rating`（需 apiKey） | 正数（如 `2120`） | 缺 = clist 也没算出来（**不写负结论**）⇒ 跑一次 `--force` 兜底 |

⚠️ 还没估出难度的**新题不写那个字段**（缺失 ≠ 0）；体检里它表现为「可疑」，
需求清单会给出一条"重跑 AtCoder 适配器"，下次跑就自己补上。

**CLIST 那一员的三档**（「可以认为 clist 给出的难度**几乎不会更改**」）：

| 档 | 命令 | 行为 |
|---|---|---|
| 默认（链子里跑的） | `scripts/clist-difficulty.py sync` | 缓存**在** ⇒ **只回写、一次也不联网**；缓存**不在** ⇒ 抓一次 |
| 只补新题 | `... sync --refresh`（或 `fetch`） | 按 `id` **倒序**翻每个 judge 最新的一页（1000 条），合并进缓存 |
| **兜底全部重爬** | `... sync --force` | 忽略缓存，全量重抓每个 judge |

**clist 到底覆盖什么**（2026-10-02 实测，`limit=1000` 抽样）：

| judge | clist 有没有 | 我们这边 |
|---|---|---|
| Codeforces **正式轮次** | ✅ 11317 条带难度 | 3620 匹配里的大头 |
| AtCoder | ✅ 7905 条 | 252/306 有 |
| 牛客（多校） | ✅ 1000 条里 **889** 带 rating | **78/128** 有 |
| CF **gym** | ❌ 832/832 全缺（与 CF 自己不给是同一件事） | 用 `{cf:c: : 100000}` 按前缀排除 |
| 杭电 | ❌ `acm.hdu.edu.cn` 0 题；`bestcoder.hdu.edu.cn` 624 题但 **0** 带 rating | 0/121 |
| **QOJ** | ❌ **根本没有这个 resource** | 0/4429（链接形状也对不上） |

⚠️ **牛客那一员的 clist 值明显退化、但有意保留**（"保留，留着总没坏处"）：实测 2026 多校 6 场，**每场只有 2 个不同值**（133877 是 `651×12 + 1674×2`、133879 是 `1388×9 + 2411×3`、133880 是 `2869×9 + 1846×5`…），像 clist 按**场级**估计后摊到每题；对照 **CF 517 场里"同场 ≥60% 同值"的有 0 场** ⇒ 是牛客这个 judge 特有，不是我们映射错。**处置：保留原值、不清洗、不排除** —— 它是"那一份来源的口径"，将来爬往年多校时还会遇到（数据是 clist 给的，我们只是如实照抄）。⚠️ 想要"同场几乎全同 ⇒ 不可信"的告警，**现在故意没做**（先保留；要做的话接在体检里，与"同组不一致"并列即可 —— 判据是"同一父节点下 ≥60% 同一个值"）。

⚠️ `contestIdBelow` 支持**按前缀分设**（`{前缀: 上界}`）：CF gym 是 10 万+、牛客多校是 13 万+，**同一个数字界分不开**（实测踩到）。
⚠️ clist **限速 10 请求/分钟**（脚本自己睡 6.5s/请求，429 等 60s 重试），所以「每次构建都抓」不可取 —— 这正是默认档不联网的原因。
⚠️ **别拿 URL 字符串比身份**：同一个平台有 `/contest/`、`/gym/`、`/problemset/`、`?locale=` 等多种写法，匹配用归一化的 `judge|cid|题号`（`normalize_url()`，7 种写法有单测钉住）。

---

## 6. 界面上长什么样

字段条最上面一行由 `src/core/fieldRegistry.js` 的 `expectNoteHtml()` 生成：

```
应有：必须有 · 已有：缺          ← required 缺 ⇒ 红（#b91c1c）
应有：应该有 · 已有：缺          ← expected 缺 ⇒ 琥珀（#b45309）
应有：可有可无 · 已有：无        ← optional 缺 ⇒ 灰，说"无"不说"缺"
应有：不适用                     ← 谓词不成立 ⇒ 明说，不猜
应有：必须有 · 已有：有          ← 有值 ⇒ 灰
```

- 下面紧跟着的是**原来那两样**：`来源：xxx`（+ 级别徽标）与多来源可展开列表（含 `优先`/`不用`/`真删`）。
- **包不带注册表 ⇒ 这一行不显示**（老包/裁剪包），其余 HTML 与以前逐字相同。

### 6.1 值级面板上那几个按钮：给谁 / 点完怎么重画

> 这两条都**横跨 core 与 ui**（判据在 `sourcePanel.js`，动作与重画在 `sourceActions.js`），
> 而且各踩过一次真坑（`v9.1.17`），所以写在这儿。

**① `优先` / `不用` / `恢复` / `真删` / `转成所有人共用` 分别给谁**（唯一实现 `ui/G_modal/sourcePanel.js`）：

| 按钮 | 给谁 | 为什么 |
|---|---|---|
| `优先` / `不用` | 除最后一条可用值外的每条 | `不用` 只是标记（可恢复），"最后一个留在场上的值不许被踢掉" |
| `恢复` | 已标 `invalid` 的那条 | 把它放回来 |
| **`真删`** | **手改值**：`src === 'manual'` 且（`account === 本账户` **或** `account === ''`） | `account === ''` 就是**客观值 /「所有人共用」**（含 `promoteManualToObjective` 产出的那条）。它不属于"别人"，而且「转成所有人共用」的提示写着"（撤销可还原）"——不给真删就只剩 `Ctrl+Z`。⚠️ **别人账户的手改值仍然不给**（不该删队友的）；⚠️ **老数据里没有账户键的手改值走同一支**（同样算我的） |
| `转成所有人共用` | 只对 `ops/node.js:OBJECTIVE_PROMOTABLE_FIELDS` 名单里的字段，且那一格**确实有按账户的手改** | 破坏性动作，**先弹确认框**（`sourceActions.js:confirmPromote`），取哪条/清哪些全在 `promoteManualToObjective` |

判据：`src/test/sourcePanel.test.js` 那条「★ 客观手改值也给「真删」」（本账户 / 客观 / 队友 / 单来源四条断言）；
`scripts/smoke/manual-scope-ui.smoke.mjs` 的 ②③ 组。

**② 点完按钮重画时，取"新面板"必须按类名取那一格**（`sourceActions.js:refreshPanel`）：

`buildSourcePanelHtml` 的返回值是 **`expectLine + 面板`** —— `expectLine`（`<div class="src-expect">`，
就是上面那条「应有/已有 / 字段组」）**排在面板前面**，而且**只要有注册表就非空**。
所以**不许**用 `holder.firstElementChild` 取面板（取到的是那一行说明，`replaceChild` 会把
来源面板换成它的副本 ⇒ **说明行 ×2、面板整块消失**，症状就是用户说的"字段块两份"）。
`.src-note` 与 `.src-details` **分两次查**，⚠️ **不许合写成逗号选择器** —— `scripts/smoke/dom.mjs`
不解析逗号选择器（合写时桩里恒 `null`、`if (fresh)` 直接跳过 ⇒ 改坏了也测不出来）。

> ★ **"复现不出来"的教训**（这条比 bug 本身值钱）：前两轮都没复现，唯一原因是**夹具没传 `registry`**
> ⇒ `expectLine` 为空 ⇒ `firstElementChild` **正好**是面板。真弹窗**就是传了 registry 的**。
> ⇒ 判据夹具必须按真弹窗喂参数（详见 `scripts/smoke/manual-scope-ui.smoke.mjs` ④ 组，
> 它现在会先断言"HTML 的第一个元素确实是那一行"，夹具前提假了也当场红）。

⚠️ **节点类型键：应用用 `type`，包/构建侧用 `节点类型`**（列名，导入时由 `fieldMap` 映射）。
`nodeTypeOf()` 两个都认 —— 只读列名会让**除 `name`/`link`（`types: ['*']`）以外的规则全部失效**
（2026-10-02 真踩到，见 `v8.5-plan` §36.8；单测夹具也因此改成应用真形状，并补了走真包的冒烟断言）。

---

## 7. 「应有」注册表怎么到应用里

1. 构建：`scripts/crate-merge.mjs` 把 `acm-data/field-registry.json` **原样**放进包顶层 `fieldRegistry`
   （文件不在就不带）；
2. 导入：`features/AutoImport/parse.js` → `apply.js` → `state.fieldRegistry`（不带 ⇒ `null`，**不报警**）；
3. 持久化：白名单**只有一处真源** = `src/A_registry.js` 的 `USER_FIELDS`；`persistence/diff.js` 与 `index.js`
   的 `captureRef` / `loadData` / `emptyRef` 全部从它派生
   —— 以前三处各抄一份，漏一处就是"刷新一次那行就没了"（真踩到）；
4. 显示：`registry` + `shownValue` + `parentOf` 这三样必须传对。`sourcePanelOpts()` **只在 `editForm.js` 里定义**
   （该文件 3 处调用）；`sourceActions.js` 与 `nodeinfo/nodeFields.js` **各自内联构造同一份 opts**，共 5 处调用点
   —— **口径必须一致**，否则点一下按钮那行就没了/算错。
   ✅ **这句已经应验过一次**（`v9.1.17`）：`refreshPanel` 重画时 `registry` 是传对的，
   但**取"新面板"那一格取错了**（`holder.firstElementChild`）⇒ 点一下按钮**说明行变两份、来源面板整块消失**
   —— 细节与判据见 §6.1 ②。教训：这条链上的"传参一致"与"取对元素"是**两件事**，都得有夹具钉住。

### 7.1 体检报告也走同一条路（「🩺 体检 / 需求」页）

体检（`field-coverage.py`）与原料需求（`material-needs.py`）的 JSON **也随包发布**，应用里那个
一级 Tab 读的就是它（"体检报告应该能在应用里看"）：

1. 构建：`crate-merge.mjs` 把两份 JSON 原样放进包顶层 `reports`；⚠️ 但报告读的**就是**刚产出的包
   ⇒ 只能"先出报告、再塞回包顶层"：链尾多一步 `scripts/embed-reports.py`（只加一节、幂等、原子写）；
2. 导入/持久化：与 `fieldRegistry` **逐处对应**（`parse.js` / `apply.js` / `state.js` / `diff.js` / `index.js` 三处）；
3. 显示：`ui/coverage/coveragePage.js`（四栏：小结 / 原料需求 / 字段体检 / 同组不一致）；
   纯计算在 `src/core/coverage.js`（**只排序、分页、小结，不做判定**）；
4. ⚠️ 包不带 `reports` ⇒ 那一页换成"重建一次包就有"，**绝不画空表**（空表会被读成"一个都不缺"）。

---

## 8. 改一个字段时要动的几处（自查清单）

1. `acm-data/field-registry.json`：加/改规则（档位 + 谓词 + `why` 写人话）；
2. 若用了**新谓词**：`scripts/field-coverage.py` 的 `predicate_holds()` **和**
   `src/core/fieldRegistry.js` 的 `predicateHolds()` 各加一个分支 + 各一条单测；
3. 若是**新的"实际有"参考源**：在注册表规则里加 `when.evidence: <值>`，并在
   `field-coverage.py` 的 `evidence_says_none()` 里加一个分支（**判据本体放 `acm-data/raw/Scaper/05 xcpc/lib/`**，
   别写进 coverage —— 这三个模块都在那儿，`field-coverage.py` 按绝对路径懒加载；
   现在三个源：`cf-page` = `cf_page_evidence.py`（题目页面写没写 `Difficulty`）、
   `clist` = `clist_evidence.py`（全量缓存里**有别的题、就是没有这一条** ⇒ 上游没算）、
   `atcoder-models` = `atcoder_models_evidence.py`（kenkoooo 模型里**那一条在、就是没有 `difficulty`**
   ⇒ 太难/不计分/签到题饱和，重跑也补不到）；
   ⚠️ 否定证据一律**带保质期**（各 30 天）—— 新题过一阵子可能就有值了，过期后要重新算缺；
   ⚠️ `has`（表里**有**）与 `absent`（真没有）要分开：前者是"**我们没写进去**"（bug），
   不许洗成"上游没有"；
   顺带在 `material-needs.py` 的 `NEED_RULES` 里给这条规则加 `exhausted: '<值>'`，
   否则**需求清单会继续派一条永远补不上的命令**；
4. 干跑一遍看结论：`python -B scripts/field-coverage.py`（期望 `真缺 0 / 可疑 0`）+
   `python -B scripts/build-all.py`（注册表随包发布，包要重导）；
5. 界面确认：刷新页面 → 打开任一节点 → 那一行的档位/颜色对不对；
6. 回归：`npm test`、`npm run test:smoke`、`node scripts/crate-check.mjs acm-data/nodes/all_nodes.json`。

**若动的是「判据 / 口径」而不是新字段**（不走 9c 那套建字段流程，但**同样两处同步**，漏一处两边就打架）：

| 加的东西 | Python 侧 | JS 侧 | 钉住它的自测 |
|---|---|---|---|
| 新谓词（如 `notStatus`） | `field-coverage.py` 的 `predicate_holds()` | `fieldRegistry.js` 的 `predicateHolds()` | `field-coverage --selftest` + `src/test/fieldRegistry.test.js` |
| `coverage: false`（整个字段不体检） | `rules_for()` 里直接跳过这条规则 | `expectOf()` 返回 `noCoverage` ⇒ `expectNoteHtml()` 写「应有：不查」 | 同上（正反各一条） |
| `pursue` / `pursueByPrefix`（**追值**：值不值得追） | `pursue_of()`（规则档 + 前缀覆盖；⚠️ 函数名叫 `pursue_worst`，行为却是**取最高那档** —— 一行里只要有一部分值得追，这行就该显出来） | `core/coverage.js` 的 `summarizeCoverage()` 数 `lowPursueCount`/`highPursueCount` + `coveragePage.js` 的「追值」列 | `field-coverage --selftest`（含"规则给 `normal`、前缀给 `low` ⇒ `low` 赢"与"整行取**最高**档"两条） |

⚠️ `pursue` 是**人的判断，不是证据**：标了 `low` 的格子进**单独一档**（`missingLow`，`field-coverage.py` 里与 `missing` 并列、**不算缺**，页头单独报一行），只是在提醒"别花力气追"。别把它当豁免用 —— 豁免要写 `when.notExtKeyPrefix` 并给依据。
⚠️ 改了谁的 `pursue` 档，**建包时的门槛立刻跟着变**（`material-needs.py --pursue` / `build-all.py --needs --pursue` / 链尾那步，见 §1.1.2）；并记得给"只有 `low` 档才会出现"的字段配一条 `NEED_RULES`，否则那个档位选了等于没选。

**若动的是判定词表（`status`）** —— **四处必须同时改**，否则新值会静默变空或变黑：

| 处 | 角色 |
|---|---|
| `scripts/crate.py` 的 `STATUS_OPTIONS` + `normalize_status()`（认中文/长词 → 缩写；`_abbrev_status()` 兜底） | **真源**：校验器与各适配器都调它 |
| `src/A_constants.js` 的 `STATUS_OPTIONS` | 界面下拉 / 筛选的合法值 |
| `src/A_constants.js` 的 `RESULT_COLORS` | 每档颜色；**认不出但非空** ⇒ `RESULT_COLOR_UNKNOWN`（淡灰） |
| `G_modal/G2_common.js` + `G7_vNodeEdit.js` 的下拉 | 手动编辑时把**当前值并进选项**（不然非枚举值会被静默清空） |

⚠️ 加一条词表要**同时给颜色**；`RESULT_COLORS` 在白底上同时当文字色用 ⇒ 别用纯黄（`CE` 取深金黄 `#ca8a04`）。
⚠️ `normalize_status()` 对**非空输入永不返回 `-`**（认不出就走 `_abbrev_status()`）—— `-` 只代表"确实是空的"。

**常驻测试**（忘了上面哪一步就红）：

| 测试 | 钉住什么 |
|---|---|
| `src/test/fieldRegistry.test.js` | 档位/谓词/空值口径/配色/`type` 与 `节点类型` 两个名字 |
| `src/test/persistenceMeta.test.js` | "哪些顶层 meta 字段必须持久化"（漏一个就丢） |
| `scripts/smoke/crate-invariants.smoke.mjs` | 来源表覆盖每个用到的 id；**走真包**验证"应有"那一行算得出来 |
| `scripts/field-coverage.py --selftest` | 真缺/可疑/允许/同组不一致/证据豁免/过期重报；**三个证据源的三态 + 两条护栏各有反例**；谓词 `notStatus`、`coverage:false`、`pursue`（含取最高档）（42 项） |
| `scripts/material-needs.py --selftest` | 两个判据六个分支（应该有 × 实际有）+ CLIST"上游没有"（含"表里有 ⇒ 反向锚"与两条护栏，31 项） |
| `scripts/clist-difficulty.py selftest` | `normalize_url` 的归一化（那份实现现在在 `lib/clist_evidence.py`）+ 回写幂等 + 没凭据友好跳过 |
| `scripts/embed-reports.py --selftest` | 报告随包：只加一节 / 幂等 / 原子写 / **坏报告不写包**（不抹掉已有那节） |
| `scripts/smoke/coverage-page.smoke.mjs` | 那一页的四栏、分页夹页码、**没报告时说清"重建一次包"** |
| `scripts/nature-baseline.py selftest` | 回代写**值 + 依据 + 来源**三样、幂等、来源表登记 `manual` |

---

## 9. 一页速记（口径 → 规则）

| 口径 | 落成的规则 |
|---|---|
| "引入『哪些字段应有』的记录字段，默认规则和注册表" | `acm-data/field-registry.json`（唯一真源）+ 体检 |
| "字段来源的可信优先级设定从 nature 分类扩展到所有字段" | `字段来源` 逐格 + `fieldLevel.js` 的 `M/A/B/C/D` |
| "最好可以让抓取部分知道该抓哪些原料" | `scripts/material-needs.py`（需求清单） |
| "不能看逐题的 rating！不然新题怎么办？" | 不拿单题值判缺口；否定证据带 30 天保质期 |
| "应不应该有就是按场次的 Rated: Yes/No 判的，你幻觉严重" | 「应该有」= 场次计分；页面只答「实际有」 |
| "特殊情况只能兜底" | 没有权威源时**去把参考取回来**（按题查页面），不猜 |
| "language 直接标可有可无" | `language` → `optional` |
| "每个字段条都有『是否应有』『是否已有』『来源』『优先级』" | 注册表随包发布 + 字段条那一行（§6） |
| "然后再合并但完全不丢失" | 保留先到 + 落选值进 `其它来源值`；三条有意的例外（§3） |

---

## 10. 合成（`synthKey` / `ownerSynth`）的格式与「谁定」规范（2026-10-03，41c）

两条前提：
**"现有的 O 下 xcpc 树似乎是骨架，重在绑定"** + **"不推谁绑定谁，只推使用的 `ownerSynth`，
让应该绑定的比赛间自动推出相同的 `ownerSynth`"** + **"别用不稳定的方案，不稳定的东西都最终由用户决定"**。

### 10.1 两样东西（唯一的判定规则）

- **合成节点** = 树上一个**真节点**，身份 `synthKey`（前缀 `synth:`，全局唯一）；
- **原料节点** = 普通节点，`ownerSynth` 指着某个 `synthKey`。
- **`ownerSynth` 非空且相等 ⟺ 同一个组**（判定只有这一条，见 `core/dedup.js`）。

### 10.2 格式（写死在下面，脚本与应用都照这个来）

| 项 | 规定 |
|---|---|
| `synthKey`（脚本生成的） | **`synth:xcpc:<赛季><分类段>[-地点][-限定词]`** —— 由纯函数 `planKeyOf()` 从 nature 算出（**不读清单 slug**），稳定、可复现、跨源一致 |
| `synthKey`（人在应用里新建的） | `synth:<自己起的>`（`core/ops/synth.js` 只校验前缀与唯一性） |
| 合成节点记录 | `{节点类型:'C', synthKey, 父extKey:'xcpc:s:…:<赛季>', name, natureClass/Year/Season/Region}` —— **它自己带 nature**（否则会挂在 ③ 性质待补里） |
| 成员记录 | `{节点类型:'C', extKey, ownerSynth}` —— **只写这两样**（不写 name：免得把树上已有的名字覆盖掉） |
| 容器 | `xcpc` → `synth-<分支>[:<赛区>]` → `<赛季>`；合成节点**直接挂赛季层**（`scripts/synth-bind.mjs` 一处铺） |
| 组名 | 由 `planKeyOf()` 按 **赛季 + 地点 + 类型** 算出（与组键同一条口径）—— **不是**清单名、也不是某个成员的名字 |
| 范围 | **暂时只做国内**：`icpc/ec`、`ccpc`、`省赛与邀请赛`（`natureClass` 去掉镜像前缀后看前两段） |

### 10.3 「谁定」：客观证据 → 脚本；其余 → 用户

| 情形 | 谁给 `ownerSynth` | 判据（客观） |
|---|---|---|
| 清单里**同一个 slug** 在 **≥2 棵树**上出 C | ~~老的清单 slug 方案~~（**已停用**：现在国内场次一律走下面那条 nature 口径；实测清单 186 场全是国内口径的场次、非国内从来没有 ≥2 棵树出 C 的） | 历史判据是 `xcpc_pipeline.fragments_of()` + 注册表 |
| 没绑的场次，**各来源各自算出的键相同** ⇒ 同组 | **脚本**（`scripts/synth-bind.mjs`，链子里一步） | **没有"签名"判据**：各来源各自用 `planKeyOf()` 算键，**键相同即同组**（键从 nature 来：分类 + 赛季 + 地点；**地点读 `natureRegion` 字段** —— **不从赛名猜**） |
| 骨架里没有这一场 / 同签名对应**多个**组 / 地点不是真地点 / 名字写法不同 | **用户**（应用「① 合成节点 / ② 可能重复」里绑，随「人工填写」导出→回代） | —— |

`synth-bind` 的实测（2026-10-03，国内范围 C 561 条）：**挂上 65 条**（258 → 323，
抽查全对：`qoj:c:1093` 与 `cf:c:104128` 都进了 `synth:xcpc:icpc2022nanjing`）；
**留给用户 238 条**（骨架里没有这一场 132 / 地点不是真地点 103 / 同签名多个组 3 ——
歧义那 3 条正是"同年同地多场"：南昌邀请赛的 ccpc/icpc 两个组、河南省赛的 `haicpc17th`
与 `haccpc8th`）。重跑幂等（只**填空白**，已绑的不动）。

⚠️ **为什么不做"按 `(分类 + 赛季 + 地区)` 自动绑"**（实测过，结论：不稳定，所以不做）：

- 只按 **分类 + 赛季**：一个赛季一个赛区里有 7 场区域赛 ⇒ 会被并成一团
  （实测 2020 济南/澳门/南京/上海**全被绑到** `icpc2020yinchuan`）；
- 只按**赛名里读出的地点**：同一场在不同来源的赛名写法不同，算出来的"地点"可能不一样
  （河北 vs 秦皇岛；`qoj:c:3756`「The 2026 **Jiangsu** Collegiate」的赛名读作江苏、
  而它自己的 `natureRegion` 是广东）；
- ⇒ 这些都属于**不稳定**：脚本**只保证"确定的那些自动一致"**，剩下的**留空**并如实报出来，
  由用户在应用里定（`synth-bind` 每次构建都会打印那三个计数）。

### 10.3b 「哪些节点**不该**算合成键」：注册表 `acm-data/synth-registry.json`（2026-10-04）

"引入『有些节点不该算合成键』的逻辑与注册表" + "**节点级白名单 + 分类白名单**，是**不同层的属性叠加**"，
例子："**比如平壤**"（`qoj:c:2180` = The 2016 ICPC Asia Pyongyang Regional Contest：分类是
`qoj/xcpc/icpc/ec/regional/official`（EC 赛区），但**场地在中国境外** —— 我们的合成只做国内，
而"国内"是按**分类分支**判的，地理上管不住它）。

| 层 | 字段 | 怎么匹配 |
|---|---|---|
| **分类白名单** | `classRules[].match` | 按 `natureClass`；**先去镜像前缀**再比（`qoj/xcpc/…` / `cf/gyms/xcpc/…` 与 `xcpc/…` 是同一件事），**精确或前缀**都算命中（写 `xcpc/icpc/ec` 一处覆盖它下面所有子路径） |
| **节点白名单** | `nodeRules[].extKey`（也认 `synthKey`） | 按节点**点名** —— "同一分类里大部分该合、个别不该"只能靠它 |

命中之后（三个消费者必须一致 —— 判据只有一份：`src/core/synthRegistry.js`）：

1. **不参与合成**：`synth-bind` 不再给它算键/绑组；
2. **解绑**（"已绑的怎么办" ⇒ "解绑"）：已绑着**脚本格式**键的会被清掉，**空掉的组**以及
   "因它空掉的容器（赛季层 → 分支层，级联）"一起收掉 —— 这条**删除路径**以前只覆盖"旧格式的组"，
   当前格式的空组是**收不掉**的（"其实我们现有的实现有许多地方没有考虑怎么删除"）；
   ⚠️ **人工绑的键一个字不动**，只报出来请人核；**人手建的空组**也不许被误删（只收"本轮解绑而清空"的那些）；
3. **⑤ 只记账**：不算"算不出"（那是**结论**，不是欠账）⇒ 单独一行「⛔ 注册表排除 N 条」，
   **不进 tab 数字**；注册表里点名、树里却没有的条目也会报（写错 extKey / 那场没了都属"不符"）。

⚠️ **灰色的分类值（`无归类` / `上游异常`）不必写进注册表** —— 它们本来就按"确定不用"处理；
这张表是给"**分类不灰、但这场本来就不该合成**"用的。

⚠️ **分类白名单暂时故意空着**（"**境内/境外很难分，算了，先只用节点**"）：
机制留着（判据 `classRuleHit()` 有单测钉住），但**先只按 `nodeRules` 点名**。
真要成类地排除时先想清粒度 —— 分类层是**前缀**语义，写 `xcpc/icpc/ec` 会把**整个 EC 支
（含国内区域赛）**都排除；"境内/境外"这种维度目前**没有字段可依**（那是另一件事，别硬凑）。

### 10.4 用户定了之后怎么留住（**回代**）

应用里绑的 `ownerSynth` 要跟 nature 一样**进「人工填写」的导出、并由产包那一步回代** ——
**已落地**（待办 #5）：

- 人绑/改/解绑时（`core/ops/synth.js:applyOwnerSynth`）写/清 `分类依据.ownerSynth = manual:set`（M）；
- 导出多一节 `ownerBindings`（`core/natureAssignments.js`），**两个信号**：那条标记，**或**键不是脚本格式
  （救"改版之前就绑好的"那些）；
- `nature_baseline_lib.parse_baseline` 校验它（**可选节** ⇒ 老文件照读），`rows_of` 把绑定当伪字段
  `ownerSynth` ⇒ **缩水拒绝**那道闸门也管它；`nature-baseline.py` 回代时值 + 依据 + 来源三样一起写；
- `synth-bind.mjs` 的 `isHumanBound()`：**人绑的指针一个字不动**（不看键格式 —— 人也能绑脚本格式的现成组）。

⚠️ 改版**之前**绑的、且键恰好是脚本格式的，**认不出来**（当时没有痕迹）⇒ 想保住就在应用里重新绑一次。

### 10.5 键与显示名的映射

> "对于 icpc ec 赛区：我们通常用『**2022 IC杭州**』『**2022 IC杭州热身赛**』『**2023 EC-Final**』
> 『**2024 IC网络赛1/2**』这 4 种称呼覆盖所有的比赛，那么如何用 nature 映射比赛很简单；
> **ccpc 一样**。对于省赛，最常见的是『**2025 浙江省赛**』『**2025 西安邀请赛**』，可能能分为
> 『**省赛暨邀请赛**』『**省赛**』『**IC邀请赛**』『**CC邀请赛**』『**邀请赛**』5 种，
> **筛选顺序从前至后**。"

> ★ **那"5 类"不正交 —— 正交化成 3 × 4**。"省赛/邀请赛分支，
> 可能得**正交分为 4*3 类**：`IC`/`CC`/`IC&CC`/`(无)` ／ `省赛`/`邀请赛`/`省赛暨邀请赛`"，
> 并"**先判 IC&CC**"。
> 起因是一个真 bug：**河南 2026** 那组把「第 8 届 CCPC 河南省赛」与「第 17 届 ICPC 河南省赛」
> 并成了一场 —— 两场的 `natureClass` **逐字相同**（旧 `省赛` 那一类不记录主办、赛季与地点又一样），
> `planKeyOf()` 就必然算出**同一个键**。全库这样的组实测 **7 个**（河南 2024/2026、四川 2024/2025/2026、
> 江西 2025/2026）。旧的 `IC邀请赛` / `CC邀请赛` 两个类型**已删**（它们是"邀请赛 × 主办"的两个特例）。

| 分支 | 情形（看 `natureClass` 里那个阶段段） | 显示名 | **分类段**（进键） |
|---|---|---|---|
| icpc-ec | `regional`（+ `warm-up`） | `<赛季> IC<地点>`（`…热身赛`） | `ec_regional` |
| icpc-ec | `final`（+ `warm-up`） | `<赛季> EC-Final`（`…热身赛`） | `ecfinal` |
| icpc-ec | `pre` | `<赛季> IC网络赛<N>` | `ec_pre<N>` |
| ccpc | `regional`（+ `warm-up`） | `<赛季> CC<地点>`（`…热身赛`） | `cc_regional` |
| ccpc | `final`（+ `warm-up`） | `<赛季> CC-Final`（`…热身赛`） | `ccpcf` |
| ccpc | `pre` | `<赛季> CC网络赛<N>` | `cc_pre<N>` |
| ccpc | `female` / `vocational` | `<赛季> CC女生赛` / `<赛季> CC高职赛` | `ccpc`（限定词另接） |
| 省赛与邀请赛 | 类型轴 3 类**从前至后**取第一个命中的；主办是**另一轴**（两者正交） | `<赛季> <地点>[<主办>]<类型>` | 见下面 12 条词表 |

- **键怎么拼**（固定格式）：**`synth:xcpc:` + `<赛季><分类段>[-地点][-限定词]`**，
  那个串叫**场次标识**。例：`synth:xcpc:2024provincial-jilin`、`synth:xcpc:2021ecfinal`、
  `synth:xcpc:2024ccpc-female`、`synth:xcpc:2025ec_regional-chengdu-warmup`。
  - "最好统一为『**赛季 + [icpc/ccpc/省赛区域赛细分] + 地点**』"；
    "**当基本需要地名才能区分不同比赛时**…分类的中间那一部分**对应分类，分类是什么就填什么**"；
    "**不需要地名就能唯一定位时**：`20xxecfinal`、`20xxccpcf`、`20xxccpc female`、`20xxccpc vocational` 等"；
    末尾限定词用 `-` 连接（"可能 `-` 确实更好"）。
  - ⚠️ **场次标识不存**（"**让每个来源算，完全不存**"）：它是**纯函数**
    （分类 + 赛季 + 地点），谁用谁算。**匹配的原理就是各来源的 nature 高度一致** ——
    一致 ⇒ 算出同一个标识 ⇒ 自动成组；不一致 ⇒ 两个标识 ⇒ **两组**（看得见、改得动：
    去改那个节点的分类，下次构建自己并回来）。存一份反而会跟 nature 脱钩成假真源。
  - ⚠️ 判"是不是本步格式的键"的**唯一判据** = 前缀之后**紧跟赛季**（`20xx` 或 `年份未知`）。
    41c 那代（`synth:xcpc:<分支>:<赛季>:<键尾>`）与更早的清单 slug 方案都算**旧格式**，
    这一步会把它们**换掉**（2026-10-04 实测：287 个组键一次性全换、旧格式残留 0）。
- **地点** = `natureRegion` **字段**（直接读，不猜）。
- **网络赛序号 `N`** = 赛名里的 `(I)` / `(II)` / `(1)` / `（二）`、`第 X 场`，或紧跟「网络赛」
  的编号（`…网络赛2`）；三种写法都认（阿拉伯数字 / 中文 / 罗马数字，清单 slug 里也有
  `preliminary-1` / `-2`）。**认不出 ⇒ 照旧建键**（键就是 `…ec_pre`，不猜序号）——
  同赛季真有两场都没序号时它们会算出同一个键，⑤ 会把那种组报出来交给人。
- **类型轴（3 类，有序，命中即止）**：
  ① 名字里同时提到省赛与邀请（"…暨…省赛" / "…省赛暨邀请赛"）⇒ `省赛暨邀请赛`
  ② 省赛（`省赛` / `省大学生程序设计竞赛` / 市赛同族）⇒ `省赛`
  ③ 其余邀请赛（`邀请` / `invitational`）⇒ `邀请赛`
  一条都不命中 ⇒ `未归类`（**不建键**，交给人）。
- **主办轴（4 档，**独立**判，与类型无关）**：只认品牌词 ——
  `ICPC` / `IC` / `国际` 命中 ⇒ `IC`；`CCPC` / `CC` / `中国` 命中 ⇒ `CC`；
  **两者都中 ⇒ `IC&CC`（先判它）**；都不中 ⇒ `无`（"这个名字里没提主办"，是**结论**不是欠账）。
  - ⚠️ **英文 `China` 不算 `CC`**：`The 2026 ICPC China Sichuan Provincial Programming Contest`
    既含 `ICPC` 又含 `China`，认了就成 `IC&CC`（实测踩到）。只认中文 `中国`。
  - ⚠️ `\b` 必须有：`\bIC\b` 不许命中 `ICPC` 里那几个字符。
- **省赛那 12 个分类段**（`(主办, 类型)` → 词表，固定写法）：

  | 主办 | 省赛 | 省赛暨邀请赛 | 邀请赛 |
  |---|---|---|---|
  | `无` | `provincial` | `prov&invi` | `invitational` |
  | `IC` | `ic_provincial` | `ic_prov&invi` | `ic_invitational` |
  | `CC` | `cc_provincial` | `cc_prov&invi` | `cc_invitational` |
  | `IC&CC` | `ic&cc_provincial` | `ic&cc_prov&invi` | `ic&cc_invitational` |

- **缺一件就不建键**（不猜）；⚠️ 显示名里 **`无` 不写出来**（写了会读成「2026 河南无省赛」），
  但**标识里有**（要唯一）。

#### 10.5.1 这两轴**都已经进分类**（2026-10-03 "细分应直接放到分类里"；2026-10-04 正交化）

省赛不再是"一个叶子"，而是**分类的最后两段就是（主办，类型）**：

```
xcpc/provincial&invitational/<IC&CC|IC|CC|无>/<省赛暨邀请赛|省赛|邀请赛>/<official|warm-up>
qoj/xcpc/…            同上（镜像）
cf/gyms/xcpc/…        同上（镜像）
类型读不出 ⇒ xcpc/provincial&invitational/未归类   （如实报出来，不硬塞；**不补主办、不补 phase**）
```

- 共 **4 × 3 = 12** 个叶子 × 2 个 phase = 24 条；`PHASED_LEAVES` 里那 12 条由
  `PROVINCIAL_ORGS` × `PROVINCIAL_TYPES` 生成（`crate.py selftest` 拿 Trie 逐条对拍）。
- **谁判**：`xcpc_common.provincial_type_of(赛名)` 与 `provincial_org_of(赛名)` **两个函数**，
  判据真源是 `PROVINCIAL_TYPE_PATTERNS`（**有序**，命中即止）与 `PROVINCIAL_ORG_PATTERNS`（两轴正交）；
  QOJ / CF gym / 骨架三条路都调它俩。应用侧只读 `src/core/synthPlan.js` 的
  `PROVINCIAL_TYPES` / `PROVINCIAL_ORGS` 两份名单（**逐字一致**）。
- 📌 **分类判定的完整实现口径**（各渠道怎么判、`filterTypes`、8 个 ICPC 赛区缩写、镜像规则、
  gym 子树优先级、规则 id 的后缀含义）目前**只写在 `guide.html` 第四节**（"分类（不定层路径 + Trie）"
  下面那几条，开头有 📌 提示）—— 那是给使用者看的文档里最靠实现的一块，
  维护者按那个顺序读即可；要挪到本文是另一件事，别两边各抄一份。

- **类型轴按列表顺序判**（①→③），所以 ① 必须排最前；
  实测踩过的坑：把 QOJ 的**分类文本**也喂进去 ⇒ 全省赛都变成 `省赛暨邀请赛`；只喂**赛名**才对。
- ⚠️ **② 里那条"没有省/市字面词"的别名不能吞掉 ③**（2026-10-03 实测）：
  `第 49 届 ICPC 国际大学生程序设计竞赛邀请赛昆明站`、`2026 CCPC 中国大学生程序设计竞赛全国邀请赛（南昌）`
  这类**邀请赛**的名字里必然带着「大学生程序设计竞赛」⇒ 旧写法被 ② 一口吞成 `省赛`，
  ③ 那条**一个都命中不了**（实测 `CC邀请赛` 0 条、`邀请赛` 0 条）。
  ⇒ 拆成 ②a（有"省/市"字面词或 `provincial`/`province`/`collegiate`）与
  ②b（靠"大学生程序设计竞赛/大赛"，**但名字里带邀请/`invitational` 的不算**）。
  ★ 2026-10-04 之后 ③ 是**唯一的邀请赛出口**（旧的 `IC邀请赛`/`CC邀请赛` 已删）⇒ 这一条更不能松。
- ⚠️ **① 的窗口（2026-10-03 第二次放宽，实测漏判 5 条之后）**：① 要认全"同一场既办省赛又办邀请赛"的写法：
  - 中文：`省/市` ↔ `邀请` **同一小句内**（不许跨 `，。；`），窗口 24/30 → **40 字**
    （`…广东省大学生程序设计竞赛暨"汇丰科技（中国）"中国大学生程序设计竞赛邀请赛…` 隔 26 字）；
  - 英文：`provincial`/`province`/`collegiate` ↔ `invitational` **跨逗号也认**，窗口 → **80 字符**。
    CF gym 那种"逗号拼两套赛名"的标题正是 ①：`The 2024 CCPC National Invitational Contest (Changchun),
    The 17th Jilin Provincial Collegiate Programming Contest`（同一场：长春 CCPC 邀请赛 = 吉林省赛）；
  - 既无"省/市"字面词、又**无 `CCPC`/`ICPC`/`中国`/`国际`** 的：靠「大学生程序设计竞赛/大赛」+「邀请」
    （`第八届广西大学生程序设计大赛暨2025邀请赛`）；**带品牌词的排除**，那是 ③ 的活。
  - ⚠️ **`collegiate` 是两义的，必须排除「Invitational Collegiate」**（2026-10-03 复盘异常时逮到）：
    "某地区 Collegiate Programming Contest" = 省/地区赛（信号 ✓），而 IC/CC 官方英文名里的
    `… National Invitational Collegiate Programming Contest` 不是（那是 ③）。
    判据 = 紧跟 `invitational` 的那个 `collegiate` 不算（后顾 `(?<!invitational )`，①② **两处都要改**）。
    实测 `2024 ICPC National Invitational Collegiate Programming Contest, Wuhan Site` 以前被 ① 抢成
    `省赛暨邀请赛`，现在归 ③，并与「第 49 届 ICPC … 邀请赛武汉站」那两条**并到同一个组**。
  - 复核后分布（**旧 5 类时期**的历史数字）：
    `省赛 267 / 省赛暨邀请赛 57 / IC邀请赛 24 / CC邀请赛 10 / 无归类 4`（共 362）；
    正交化之后按 `<主办>/<类型>` 重新分布（那是脚本导出物）。
- **热身赛/正赛**仍是**最后一**段（`PHASED_LEAVES` 对 12 个 `(主办,类型)` 各建 `official`/`warm-up`）。
- ⚠️ **已知的不稳定点（如实记下，不藏）—— 2026-10-04 正交化后**：
  - ★ **已解决**：以前"同年同地 IC 场 vs CC 场"会被并成一场（河南/四川/江西那 7 组）；
    现在主办是**独立一段**、进了键，两边算出两个不同的键。这正是正交化的目的。
  - ⚠️ **仍在**：**类型**仍是按赛名判的，同一场比赛不同来源可能用不同品牌名 ——
    `The 2024 CCPC Shandong Invitational Contest and Provincial Collegiate Programming Contest`
    判 `省赛暨邀请赛`（有 `Provincial Collegiate`），截短的 `The 2024 CCPC Shandong Invitational Contest`
    只判到 ③ ⇒ `邀请赛`；
  - ⚠️ 于是仍会有「同赛季 + 同地点 + 同主办、却是两个**类型**」的组（例：`2026 福建` = `福建省赛` +
    `福建省赛暨邀请赛`；`2026 南昌` = `省赛暨邀请赛` + `邀请赛`），**大部分确实是同一场**（来源各叫各的名字）
    ⇒ 会被拆成两个合成节点。2026-10-03 复查时**故意没有**把这两类合到同一个键上：
    `synth:xcpc:…:<赛季>:<地点><主办><类型>` 里那个类型是**身份的一部分**。宁可**少并**、由人来并。
- **怎么修**：⚠️ **改 `natureClass` 本身不会并组** —— 脚本对"已经是本步格式的 `ownerSynth`"
  一律**一个字不动**（见 `synth-bind` 的 `drift`：它会报「已绑但按现在的 nature 该是另一个键」，
  但**不擅自搬**）。要并组得在应用 **① 合成节点 / ② 可能重复** 里把成员挪进同一个组
  （人的绑定优先，脚本不会撤销）。**这就是"绑定归人"的代价**：脚本只管它还确信的那些场次。
- 📌 **组内一致性口径**（"**赛季一致年份不一致是更大的异常**"）：组键里本来就带**赛季**
  ⇒ 组内赛季必然相同，所以"赛季一致、年份不一致"是**真信号**（多半某个来源把年份填错了；已登记的例外
  只有**跨年**那几类：EC-Final / CC-Final 与疫情延期的区域赛）。落地：`synth-bind` 把这类冲突标
  `severity:'high'` 并在日志里**全量列出**（`2020 银川`/`2021 澳门`/`2022 香港`/`2019 东北`/`2025 CC-Final`…，
  实测 8 处）；**组头的年份照旧取第一个成员的真年份，一个字不改**（用户选项）；其余（分类/地区）不一致
  仍报，但只列前 5。⚠️ **等用户重填这些年份**（脚本不猜）。
- 📌 **可信度（依据强度）现在四个 nature 都有**（"将『待同步』和 qoj 年份的
  可信度都标为『不高』；UI 中另 3 个 nature 没显示可信度，补上"）：
  - **以前只有 `natureClass` / `natureRegion` 写 `分类依据`**，年份/赛季一条依据都没写
    ⇒ 界面那两格永远没有徽标。**现在四个字段都写**（`class_rules` 四处调用点 + 7 个适配器）。
  - 规则 id（**后缀决定级别**，与范围 `xcpc`/`qoj`/`gym`/`cf-contest`/`atcoder`/`nk`/`hdu` 无关）：
    | 后缀 | 例 | 级别 |
    |---|---|---|
    | `…:year-time` / `…:season-time` | 拿得到**开赛时间** | **A** |
    | `…:season-key` / `…:season-same` / `…:season-none` / `…:year-none` | 清单 `mid`·层 id 的年份；多校"一年一届"；各种"不适用" | **B** |
    | `…:season-path` | QOJ 分类链路口名里的 20xx | **A** |
    | `…:year-name` / `…:season-name` | **赛名里写的 20xx** | **C（不高）** |
    | `…:year-season` | **赛季年顶出来的**（QOJ 那些年份、rankland 没日期时） | **D（不高）** |
    | `…:year-tbd` | **`待同步`**（总决赛没日期） | **D（不高）** |
    唯一真源在 `src/core/natureConfidence.js` 的 `NATURE_VALUE_RULE_LEVEL`（按后缀；逐范围登记要
    40+ 行）+ `levelOfClassRule()` 的三步查找（表 → 后缀 → 前缀兜底）。
  - ⚠️ **年份这一维 `C` 不算高**：赛名里的年份常常是**赛季年**（EC-Final 2023 是 2024 办的）。
  - ⚠️ **2026-10-03 起 `…:year-season`（用赛季年顶）不再产出**：旧口径已推翻
    （"QOJ 分类链路口名的 20xx 也是按赛季划的…那**与年份完全无关**" ⇒ 选"**不再用赛季顶年份**"），
    并且"**QOJ 你年份全部自动填 `待同步` 啊…怎么缺了呢**" ⇒ **判不出就写 `待同步`**（不是留空：
    空是"还没判"，而我们判过了、只是手里没有日期，`待同步` 正好是这个意思；它还让应用算"填过了"、
    且**永远不会被推荐**）。`held_year_of()` 因此缩成一行 `return year_in_text(held_time)`，
    缺口的填补改由 `xcpc_nature` / `qoj_adapter` 写 `待同步`（`…:year-tbd`，D）——
    实测 `qoj:year-tbd 235 · xcpc:year-tbd 0 · rankland:year-tbd 8`（会随包变，以
    `acm-data/nodes/all_nodes.json` 为准），**全库没有一格"有分类却没年份"**，
    体检 真缺/可疑/同组不一致 全 **0**。
  - ⚠️ **`crate-merge` 新增一条：年份/赛季"真 `20xx` 优先于占位"**（2026-10-03 实测踩到）：
    同一个 extKey 的两份记录，一份手里有**开赛时间**、另一份只会写 `待同步`，而合并是"**先到先得**"
    ⇒ refs 那份先到就把真年份挡掉了（`aux-rankland:c:ccpc2019qinhuangdao`：2019-09-22 的日期在
    `--role time` 那份里、却被 refs 的 `待同步` 盖住）。修法 = 占位不是"另一个答案"、只是
    "我这儿没有" ⇒ 遇到真值**让位**（反过来不动），而且**依据（`分类依据`）要跟着值一起换**
    （那一列的合并也是先到先得、跑在字段合并之前 ⇒ 不改就会出现"值是 2019、依据却是 `year-tbd`"，
    徽标会显示 D、报警门槛也会把它当低可信）。
  - **「高可信」= M 人工 / A 权威 / B 结构**（`HIGH_LEVELS`，`isHighLevel()`）。
  - ★ **「日期 / 年份」按来源分档**（政策："对于 xcpc，xcpcio/pta/nk
    的可信度最高(A)，srk 你判断，rankland 次之(C)，cf gym/qoj 如果有、可信度差强人意(D)；
    对于 cf contest/atc，当然是 A"）：
    | 来源 | 级别 | 说明 |
    |---|---|---|
    | `xcpcio` / `pta` / `nk` | **A** | xcpc 侧最高档（都是"这场真的什么时候办"的第一手） |
    | `cf-contest` / `atcoder` | **A** | 各自平台自己的官方时间 |
    | `rankland` | **C** | 次档：它的日期是"**赛程原定**"那一版（2019 两场总决赛它写 2019、实际延到 2021） |
    | `srk` | **C** | ⚠️ **我判的**：`srk_adapter.py` 文件头写着"rankland（srk）榜单" ⇒ 它就是 rankland 那份数据的另一种形状，与 rankland 同级 |
    | `gym`（cf gym）/ `qoj` | **D** | "差强人意"：gym 的日期/赛名年份、QOJ 那个镜像/重跑时间 |
    ⇒ **落地**：`xcpc_common.xcpc_nature()` 把**渠道写进规则 id**（`xcpcio:year-time` /
    `rankland:year-time` / `…:season-key`；`RULE_CHANNELS` 之外的一律落回 `xcpc:` 前缀 =
    "来源不明 = 次档"）；级别表加在 `core/natureConfidence.js` 的 `CLASS_RULE_LEVEL`（查表先命中），
    `NATURE_VALUE_RULE_LEVEL` 里那条 `year-time` 兜底**降成 C**（绝不冒充 A）。
    ⚠️ **赛季这一维不动**（"赛季问题不大"）。
    **实测效果**：年份警报 **4 → 0 处** —— 那 4 处全是"xcpcio(A) vs rankland(C)/gym(D)"，
    按新政策它们**不算警报**，改列进 `ⓘ` 低可信差异（5 处，含 `待同步` 的）。
- 📌 **报警门槛（"同赛季不同年份**只有高可信度冲突时才报警**"）**：
  `synth-bind` 里年份**单独一遍算** —— 只看**成员**（组头那格是第一个成员的副本、它自己没有依据），
  把 `realYear` 且 `isHighLevel` 的值分桶：**≥2 个不同的高可信值 ⇒ 警报（⚠️⚠️ 全量列出）**；
  高/低不一致（如 `xcpcio` 给 2022、`rankland`/QOJ 写 `待同步`）⇒ **不算警报**，
  只在 `ⓘ` 那一行记账；**空值什么都不算**（那是"还没填"，归 ③；值相同也不记 —— 否则账本会被淹）。
  实测（2026-10-03 按上面那套**按来源分档**重出包后）：**警报 0 处**（以前那 4 处
  `2019 东北`/`2019 CC-Final`/`2019 EC-Final`/`2022 EC-Final` 全是 "xcpcio(A) vs rankland(C)/gym(D)"
  ⇒ 按政策**不算警报**），改列 `ⓘ` **低可信差异 5 处**（**在应用里实时看**：判重整理页 ⑤ 冲突栏）。
  ⚠️ **这些值等用户重填**（脚本一个字不改）。
  ⚠️ 同一条口径也用在 ⑤ 的"**算不出合成键**"上（`core/synthConflicts.js`）：**灰值**
  （`上游异常` / `…/无归类`）是**结论**、不进那份待办 —— 实测 **7 → 6 条**（`qoj:c:2624` 退出）。
- 📌 **「无归类」与「未归类」是两个值**（"区分『无归类』和『未归类』，仅来自自动的
  『未归类』是**填写不完全（蓝）**，…的『**无归类**』是**特殊已填（灰）**"）：
  | 值 | 谁写 | 应用里 | 含义 |
  |---|---|---|---|
  | `…/未归类` | **分类器**（**只有省赛那一支的类型失配**写它） | **蓝** = 填写不完全 ⇒ 挂 ③、被「（分类不完全）」筛出来 | "**还没判出来**，等人补"（补完 + 回代就正常） |
  | `…/无归类` | **分类器**的其它一切"判不出"（cf/atcoder/qoj/gym/nk/hdu 的失配）**或人**（回代） | **灰** = 特殊已填 ⇒ **算填好**，但判冲突时**当作没有主张** | "**判过了**，这一支里没有它可归的一项" |
  ⚠️ "`cf/contest/others` 失配时自动未归类改为自动**无归类**；`atcoder` 也是；
  `qoj/xcpc/icpc/eu/…` 也是 —— 『**未归类**』**暂时只在省赛的失配中出现**，其他都是默认 `无归类`"。
  ⇒ Trie 里 `未归类` **只在省赛那三支镜像**（`xcpc` / `qoj/xcpc` / `cf/gyms/xcpc` 的
  `provincial&invitational` 下），其余 37 处已删；`PHASED_LEAVES` 两个都不收
  （"再分正式/热身没有意义"）。实测（当前包）：**0 条 `未归类`**（原先那 3 场 ACM-HK 已改判成
  `…/无/省赛/official`）· **19 条 `无归类`**。（会随包变，以 `acm-data/nodes/all_nodes.json` 为准。）
- 📌 **第三个灰值：「上游异常」**（"像『获取数据失败』这种上游异常的情况，nature
  可以用『上游异常』（灰）补充"）。**谁写**：**只有 `qoj_adapter`** —— 那一页根本没抓到
  （标题空 + 题目名空 ⇒ `name` 已经是「获取数据失败」）时，把分类末段从"判不出"那两个值换成它
  （`qoj/ucup` 那种正常分类一个字不动）；年份/赛季/地区的白名单也认它。
  **它为什么不能写成 `未归类`**：那是**蓝**、等人补 —— 而这一格**根本补不出来**（上游坏了）。
  **它进不进"算不出键、留给人"**：**不进**（`core/synthConflicts.js` 里与 `…/无归类` 一起按
  灰值跳过）—— 灰值都是**结论**（判不了 / 判过了），不是欠账；要补的只有蓝的 `未归类`。
  实测：`qoj:c:2624`「获取数据失败」= `qoj/xcpc/provincial&invitational/上游异常`；
  ⑤ 的"算不出"因此 **7 → 6 条**（tab 数字 7 → 6）。Trie 里 `上游异常` 在**每个 `无归类` 旁边**
  （40 处，与 `未归类` 同层同父母）。
- 📌 **如果哪天想把这 12 处里的"省赛 ↔ 省赛暨邀请赛"自动并掉**：**已不必**（2026-10-04 换代后
  这条路变了）—— 场次标识里那一格就是**分类段本身**（`provincial` vs `prov&invi`），
  要并就得**改分类**；而按"不稳定的东西交给人"的口径，脚本不该单方面定身份。
  现在的做法：**拆着就拆着**，由 ⑤ 的「疑似被拆开的组」把它们列出来
  （判据 `synthPlan.isSuspectSplit`：同赛季 + 同地点 + 同类型、一边写了主办一边没写），
  人判完去改那几个节点的分类，下次构建自己并回来。

## 11. 跨层机制：一个字段"怎么取"（模板 / 两列值 / 显示列）

> **这一节的由来**：这些规矩**横跨好几个文件**（`elements.js` / `groupValue.js` / `derive.js` /
> `fieldRegistry.js` / `view/scope.js`），**没有目录可挂** ⇒ 自动注入管不到。
> 长文放这儿，`src/core/AGENTS.md` 只留"一句话 + 判据 + 守卫名 + 指针"（2026-10-12 立的规矩）。

### 11.1 一个字段是一份"取法说明书"

真源是**来源层**：`node.values[字段] = [{ v, src, at, account?, clue?, linkKind?, invalid? }]`
（"谁说的什么值"）；写来源层的口是 `addSourceValue` / `recordIncoming`（别自己 push）。
节点上的 `node.name` 那类**只是缓存字段**（投影的物化结果），不是真源。

**三种读法别混**：`readField`（严格：不属于本次范围的值不算数；聚合/统计/筛选用它）、
`viewValue`（显示：范围内没有就退缓存，由 `viewBorrowed` 标注"别人的值"）、
`derivedOf` / `viewDerived`（派生列）。

**一个字段"怎么取"只写在 `ELEMENTS` 一行上**（`core/model/elements.js`）：
`nature`（性质）/ `types` / `importable` / `manual` / `shape` + ★`take: { agg, materialize }`：
`agg` = 聚合器名（`AGG_BUILDERS` 的键；没有 ⇒ 这格没有"组那份"）；
`materialize: true` ⇒ 进 `GROUP_FIELDS`（逐层物化的"回代覆盖表"，**由它派生**，不再是手写清单）。
⚠️ **刻意不塞进模板的两件事**："读本份走哪条"由 `nature` 定（唯一分流 `view/scope.js` 的
`ownColumnReader`）；"取哪一份"是**按调用点**定的显示列口径，不是字段的属性。

### 11.2 「该读哪一份」：两列值

- **靠前那份**（`own`）= 这个节点自己（这一份副本）的值，按范围投影；
- **靠后那份**（`group`）= 同组各副本**合并**出来的那一份（规则 `AGG_BUILDERS`，合并 `mergeField`）。

判据**只有一处**：`view/scope.js` 的 `displayColumnOf`（`plain` ⇒ 靠前、`dedup` ⇒ 靠后）。
要"跟屏幕一致"就调 `viewDerivedDisplay(...)`（来源层字段再 `?? viewValue(...)`）或
`displayDerivedReader(...)`，**别在调用点自己判断模式**。
⚠️ **那个 `?? viewValue(...)` 不能省**：`viewDerived` 对**来源层字段**给的是 `undefined`（它只算派生列）
—— 只写 `viewDerivedDisplay(...)` 会把来源层字段读成空。（这条原来是写在 `src/core/AGENTS.md` 的，
`v9.1.50` 把长文搬到了这儿。）

- ★ **还能逐字段覆盖**：设置页「显示」栏 → `settings.display.fieldColumn = { 字段: 'own'|'group' }`
  （只存**偏离默认**的项）。**收法甲：覆盖只在判重模式下生效**，不判重一律本份 ——
  不判重却按组读 ⇒ 每次读那格都要算一整趟组值（真包 ~750ms），而"`plain` 下不许触发任何聚合"
  是硬规矩（`perfGuards.test.js` ⑦）。
- **两份在任何模式下都算得出来**（组值与模式无关）；没有合成节点时靠后 ≡ 靠前（回归锚）；
  节点不在组里时 `groupValueOf` 给 `undefined`（调用方退回）。
- **`viewValue` / `viewDerived` / `groupValueOf` 是底层口**，"读靠前那份"是**例外**，仓里只三类：
  ① 编辑表单默认值（填进去就写成靠前那份 ⇒ 污染数据）；② 导出（导出的是数据，不随显示开关变）；
  ③ 喂聚合的读取器（合并两次 + 会被当输入喂回派生表 ⇒ 震荡）。
  守卫：`src/test/dedupDisplay.test.js` 的 `DIRECT_READ_OK` 名单（名单外读底层口就红、名单烂了也红）。
- **"故意读本份"已拍板**（2026-10-12）：检索（`ProblemSearch` / `ContestSearch` 的 `value`）写死读 own；
  AC 三视图（`ui/stats/ac/*`）的 `acTime` = "**我**什么时候过的"（本份），不是"这题什么时候被过"。
  改这些口径 = **先问人**。
- 量法（判重下两份差多少）：`node --import ./scripts/smoke/register.mjs scripts/two-column-audit.mjs`。

### 11.3 与它配套的登记处（别在别处另开一份）

| 是什么 | 唯一登记处 |
|---|---|
| 字段的性质 / 类型 / 形状 / **取法模板** | `core/model/elements.js` 的 `ELEMENTS` |
| 聚合器（"组那份"怎么算） | `core/groupValue.js` 的 `AGG_BUILDERS`；回代名单 `GROUP_FIELDS`（**由模板派生**） |
| 派生字段的算法 | `core/derive.js`（读口 `derivedOf` / `viewDerived`）——**来源层字段不走它** |
| 应有档位 + 字段组 | `acm-data/field-registry.json`（**随包发布、Python 也读** ⇒ 别并进 `ELEMENTS`） |
| 顶层字段 | `A_registry.js` 的 `USER_FIELDS` |

守卫：`src/test/elementTake.test.js`（`take.agg` ⟺ `hasGroupAgg` 双向、`GROUP_FIELDS` 逐项派生、
注册表里的字段名都在 `ELEMENTS` 里）。

