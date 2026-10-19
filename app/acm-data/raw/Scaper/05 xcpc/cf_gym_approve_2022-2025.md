# CF gym 批准清单（2022–2025）· 终版

> 本文件**覆盖**上一轮那份 `cf_gym_approve_2022-2025.md`。
> 逐条判断过程见同目录 `cf_gym_judge_2022-2025.md`。
> 只读分析产物：**没有**改动 `xcpc_registry.json` / `xcpc_contests.json` / `gym_whitelist.json` / `acm-data/nodes/**`。

## 一、口径（沿用项目现行取舍，未改动）

| | 口径 |
|---|---|
| **收** | **ICPC EC 赛区**（`pre` / `regional` / `final`，含线上预选）｜**CCPC 系列**（分站 / 决赛 / 网络预选 / 女生专场）｜国内**省赛·市赛·邀请赛**（`provincial&invitational` 的省赛 / 邀请赛 / 省赛暨邀请赛） |
| **不收** | 非 EC 的 ICPC（`eu` / `na` / `la` / `ap`）；`ucup` / Universal Cup / 训练营 / camp；**热身赛 `warm-up`** 与 **`[Unofficial Mirror]`**；校赛·新生赛·企业冠名赛；OI / 中学赛；外国全国赛与外国校赛（叙利亚、埃及、孟加拉、俄罗斯、西班牙、巴西…）；训练性质的多校联训；判不出的 `cf/gyms/无归类` |

分类判据只有一份：`cf_board_adapter.gym_class_rule()`；本清单**没有**重写规则，只做逐条核对与补判。

## 二、总数

### 2.1 脚本视角（`approve --suggest --year 2022-2025` = 47 条，已 `--dry-run` 核对）

| 年 | 脚本会批 | ICPC-EC | CCPC | 省市赛·邀请赛 | 其中**建议剔除** |
|---|---|---|---|---|---|
| 2022 | 7 | 0 | 4 | 3 | `cf:103765`（校赛存疑） |
| 2023 | 10 | 2 | 1 | 7 | `cf:104791`（热身赛） |
| 2024 | 12 | 3 | 3 | 6 | — |
| 2025 | 18 | 3 | 1 | 14 | `cf:106184`（热身赛）、`cf:106714`（Unofficial Mirror） |
| **合计** | **47** | **8** | **9** | **30** | **4 条**（47 − 4 = **43 条可放心批**） |

### 2.2 本清单口径（= §2.1 去掉 4 条例外 + 补上脚本够不到的）

| 年 | ICPC-EC | CCPC | 省市赛·邀请赛 | **合计"收"** | 已在树 | 候选区内可批 | 白名单漏网（批不到） |
|---|---|---|---|---|---|---|---|
| 2022 | 1 | 4 | 3 | **8** | 6 | 1 | 1（`cf:104081`） |
| 2023 | 3 | 1 | 8 | **12** | 8 | 2 | 2（`cf:104611` `104725`） |
| 2024 | 3 | 4 | 6 | **13** | 10 | 3 | 0 |
| 2025 | 3 | 1 | 11 | **15** | 3 | 11 | 1（`cf:105851`） |
| **合计** | **10** | **10** | **28** | **48** | **27** | **17** | **4** |

> ✔ 竖着加：27 + 17 + 4 = 48。

> 说明：48 条"收"里，**27 条已经在树**（不用动）、**17 条**在候选区里且 `--suggest` 能批到、**4 条**脚本永远批不到（第四节，要先改白名单）。
> 账目核对：27（已在树）+ 17（候选区内可批）+ 4（白名单 `include:false`）= 48 ✔
> 也就是说，上一轮那 47 条候选里，**只有 34 条真正新增到树**，其余 13 条早就以别的路径在树里了（详见 2.3）。

### 2.3 本轮关键增量：14 条"上一轮那 47 条里没有的"

**判定口径**：本清单判为"收"的 48 个号 − `cf_gym_recommend.md` 那 47 个号，**去重后是 14 个**（47 条里只有 34 条出现在这 48 条中）：

| # | cf | 年 | 赛名 | 为什么上一轮清单里没有 | 现在要做什么 |
|---|---|---|---|---|---|
| 1 | `cf:104081` | 2022（硬） | 2022年中国大学生程序设计竞赛女生专场 | 白名单 `include:false`，不进候选区 | 改白名单 + `answer yes`（第四节） |
| 2 | `cf:104611` | 2023（rankland） | 2023湖南省赛 | 同上 | 改白名单 + `answer yes` |
| 3 | `cf:104725` | 2023（硬） | 2023年中国大学生程序设计竞赛女生专场 | 同上 | 改白名单 + `answer yes` |
| 4 | `cf:105851` | 2025（硬） | 2025年北京市大学生程序设计竞赛暨"小米杯"全国邀请赛 | 同上 | 改白名单 + `answer yes` |
| 5 | `cf:103861` | 2022（硬） | 2021 ICPC Asia East Continent Final | 已在树，但候选区条目是空壳（无 `year`/`cls`/`title`） | 无需动作 |
| 6 | `cf:104076` | 2022（硬） | 2022 International Collegiate Programming Contest, Jinan Site | 候选区里 `answer=yes` 已答，`year` 为空 → 不再进 `--suggest` | 无需动作 |
| 7 | `cf:104901` | 2023?（赛名） | The 2023 ICPC Asia Jinan Regional Contest (The 2nd UC. Stage 17) | 候选区空壳 + `year` 为空 | 无需动作 |
| 8 | `cf:105143` | 2024（硬） | 2024 ICPC National Invitational Collegiate Programming Contest, Wuhan Site | 白名单直批，候选区空壳 | 无需动作 |
| 9 | `cf:105173` | 2024（赛名，CF 时间戳落 2023） | The 2024 CCPC National Invitational Contest (Northeast), The 18th Northeast CPC | 白名单直批 + 候选区 `year` 为空 | 无需动作 |
| 10 | `cf:105385` | 2024（硬） | The 2024 CCPC Shandong Invitational Contest and Provincial CPC | 同上 | 无需动作 |
| 11 | `cf:105911` | 2025（硬） | 2025 ICPC Nanchang Invitational and Jiangxi Provincial CPC | 同上 | 无需动作 |
| 12 | `cf:105924` | 2025（硬） | The 2025 CCPC National Invitational Contest (Northeast), The 19th Northeast CPC | 同上 | 无需动作 |
| 13 | `cf:105945` | 2025（硬） | The 2025 Jiangsu CPC, The 2025 Guangdong Provincial CPC | 同上 | 无需动作 |
| 14 | `cf:104172` | 2023（硬） | The 2023 ICPC Asia Hong Kong Regional Programming Contest (The 1st UC. Stage 2) | 白名单直批，候选区空壳 | 无需动作 |

> **其中"靠号段位置 / 上下文 / 推定年份才找出来、且以前从未在任何清单或候选里出现"的是这 9 条**：
> `cf:104081` `104611` `104725` `105851`（白名单 `include:false` 漏网，**要动手改白名单**）
> + `cf:105173` `105385` `105911` `105924` `105945`（跨年段——赛名年份与 CF 时间戳年份不一致，被 `--year` 漏掉；**已在树，无需动作**）。
> 其余 5 条（`cf:103861` `104076` `104172` `104901` `105143`）属"早已在树、只是上一轮清单从未提过"。

> **其中"靠号段/上下文/推定年份才找出来、且以前从未在任何清单或候选里出现"的是这 10 条**：
> `cf:104081` `104611` `104725` `105851`（白名单漏网）+ `cf:105173` `105385` `105911` `105924` `105945`（跨年段被 `--year` 漏掉）
> ——这是本轮最实在的增量：**4 条要动手改白名单，5 条已经在树（无需动作）**。
> 其余 4 条（`cf:103861` `104076` `104901` `105143`）属"早已在树、只是清单从未提过"。
>
> 另有两处"看着像新发现、其实不该收"，见第六节：`cf:106268`（2025 横滨，与 `cf:105633` 名实不符 + ap 赛区）、
> 以及那 4 条例外里的 `cf:106184`（热身赛）。

## 三、批准命令

> ⚠️ 脚本必须在 **`acm-data/raw/Scaper/05 xcpc`** 目录下运行（也可以从仓库根目录跑，脚本按 `__file__` 定路径）。

```bat
cd /d "D:\Programming\AcmTree\Pre\Acm_Tree\acm-data\raw\Scaper\05 xcpc"

REM 0) 先预演（只打印，不写注册表）——预期 47 条
python -B xcpc_registry.py approve --suggest --year 2022-2025 --dry-run

REM 1) 分年批（更稳，推荐）
python -B xcpc_registry.py approve --suggest --year 2022 --dry-run
python -B xcpc_registry.py approve --suggest --year 2022      REM 7 条
python -B xcpc_registry.py approve --suggest --year 2023      REM 10 条
python -B xcpc_registry.py approve --suggest --year 2024      REM 12 条
python -B xcpc_registry.py approve --suggest --year 2025      REM 18 条

REM 2) 或一次批（确认预演无误后）
python -B xcpc_registry.py approve --suggest --year 2022-2025

REM 3) 若要去掉那 4 条例外（热身赛 / mirror / 校赛存疑），改用逐条精确批：
python -B xcpc_registry.py answer cf:103743,cf:103860,cf:103931,cf:104008,cf:104053,cf:104065 yes
python -B xcpc_registry.py answer cf:104354,cf:104366,cf:104385,cf:104417,cf:104459,cf:104461,cf:104976,cf:105184,cf:105471 yes
python -B xcpc_registry.py answer cf:105139,cf:105229,cf:105386,cf:105423,cf:105481,cf:105484,cf:105486,cf:105540,cf:105632,cf:105657,cf:106030,cf:106697 yes
python -B xcpc_registry.py answer cf:105887,cf:105891,cf:105909,cf:105922,cf:105930,cf:105941,cf:105949,cf:105977,cf:106072,cf:106139,cf:106161,cf:106252,cf:106380,cf:106707 yes

REM 4) 两处脚本 guess 需要修正（不影响"收"，只影响归到哪个 slug）
python -B xcpc_registry.py answer cf:105901 yes --slug icpc2025invitational-wuhan
python -B xcpc_registry.py answer cf:105992 yes --slug shcpc2025
```

**分年清单（= 脚本会批的 47 条，`★` = 建议剔除）**

| 年 | 条数 | 场次 |
|---|---|---|
| 2022（7） | 7 | `cf:103743` `cf:103765`★ `cf:103860` `cf:103931` `cf:104008` `cf:104053` `cf:104065` |
| 2023（10） | 10 | `cf:104354` `cf:104366` `cf:104385` `cf:104417` `cf:104459` `cf:104461` `cf:104791`★ `cf:104976` `cf:105184` `cf:105471` |
| 2024（12） | 12 | `cf:105139` `cf:105229` `cf:105386` `cf:105423` `cf:105481` `cf:105484` `cf:105486` `cf:105540` `cf:105632` `cf:105657` `cf:106030` `cf:106697` |
| 2025（18） | 18 | `cf:105887` `cf:105891` `cf:105901` `cf:105909` `cf:105922` `cf:105930` `cf:105941` `cf:105949` `cf:105977` `cf:105992` `cf:106072` `cf:106139` `cf:106161` `cf:106184`★ `cf:106252` `cf:106380` `cf:106707` `cf:106714`★ |

## 四、⚠️ 脚本批不到的 4 条（白名单 `include:false`）

这 4 条分类判**对**了（`gym_class_rule()` 给的是省赛 / CCPC / 邀请赛），但**不在候选区可批集里**：
`gym_whitelist.json` 里对应 gym 的 `include` 是 `false`（`why: 不确定（默认不导，你可以把 include 改成 true）`）。
**`approve` 批不到它们，必须先把白名单里那条的 `include` 改成 `true`**（改文件是用户的操作，本轮未改）：

| cf | 年 | 赛名 | 分类路径 | 白名单现状 | 要改什么 |
|---|---|---|---|---|---|
| `cf:104081` | 2022（硬，开赛 2022-11-27） | 2022年中国大学生程序设计竞赛女生专场 | `xcpc/ccpc/female/official` | `include:false`，slug `cf104081` | `include` → `true`，再 `answer cf:104081 yes` |
| `cf:104611` | 2023（rankland） | 2023湖南省赛 | `P&I/无/省赛/official` | `include:false`，slug `cf104611` | `include` → `true`，再 `answer cf:104611 yes` |
| `cf:104725` | 2023（硬，开赛 2023-10-21） | 2023年中国大学生程序设计竞赛女生专场 | `xcpc/ccpc/female/official` | `include:false`，slug `cf104725` | `include` → `true`，再 `answer cf:104725 yes` |
| `cf:105851` | 2025（硬，开赛 2025-04-20） | 2025年北京市大学生程序设计竞赛暨"小米杯"全国邀请赛 | `P&I/无/省赛暨邀请赛/official` | `include:false`，slug `cf105851` | `include` → `true`，再 `answer cf:105851 yes` |

手动改法（**一处一处改，别用脚本批量**）：在 `gym_whitelist.json` 的 `gyms` 数组里找到 `"id": 104081` 那条，
把 `"include": false` 改成 `"include": true`，其余字段（`slug` / `why` / `note`）不动。

## 五、已收但**不用**批准（已在树，共 23 条）

`cf:103729` `cf:103861` `cf:104023` `cf:104076` `cf:104077` `cf:104090` `cf:104128` `cf:104160` `cf:104172`
`cf:104337` `cf:104363` `cf:104369` `cf:104396` `cf:104901` `cf:105143` `cf:105158` `cf:105161` `cf:105163`
`cf:105170` `cf:105173` `cf:105222` `cf:105231` `cf:105257` `cf:105336` `cf:105358` `cf:105385` `cf:105459`
`cf:105487` `cf:105578` `cf:105588` `cf:105911` `cf:105924` `cf:105945`

> 共 33 个号，其中 10 个属"本该有个 `--suggest` 名额、但候选区里 `year` 为空所以没被算进 47"的
> （`cf:104901` `105143` `105173` `105385` `105911` `105924` `105945` 等）。
> 另有 `cf:104832` `cf:104849` `cf:105633` 在树里但属 **ap 赛区**，**不是**本口径的"收"。

## 六、⚠️ 不该一键批的例外

| cf | 年 | 赛名 | 为什么不该批 |
|---|---|---|---|
| `cf:104791` | 2023 | The 2023 CCPC (Qinhuangdao) Onsite Warmup | **热身赛**（`warm-up`），不是正赛；`--suggest` 会一起批。正赛 `cf:104787` 已在树 |
| `cf:106184` | 2025 | The 2025 China Collegiate Programming Contest (CCPC) Harbin Onsite Warmup | **热身赛**；哈尔滨站正赛在 CF gym 里没有 |
| `cf:106714` | 2025?（赛名） | [Unofficial Mirror] 2025 ICPC Shaanxi National Invitational Contest | **`[Unofficial Mirror]`** 非官方镜像；`--suggest` 会一起批 |
| `cf:103765` | 2022（硬，开赛 2022-05-29） | 2022 Collegiate Programming Contest of Xiangtan University | 分类按"含校名 → 省赛"收进来了，但很可能是**湘潭大学校赛**（同族的 `cf:103353`「2023 Xiangtan University Programming Contest」判不收）。**需人拍板** |
| `cf:106268` | 2025?（赛名） | The 2025 Asia Yokohama Regional Contest | 与已在树的 `cf:105633`（2024 横滨）**名实不符**，疑同一场重复 gym；横滨属 ap 赛区 ⇒ 不收（`--suggest` 本来也不批它，列出来是提醒别手滑） |

## 七、年份推定很弱、批之前最好留意

| cf | 推定年 | 依据 | 风险 |
|---|---|---|---|
| `cf:104417` | 2023 | 按 gym 号插值（邻居 104415） | 无开赛时间、赛名无年份；插值可能错一格 |
| `cf:104459` | 2023 | 按 gym 号插值（邻居 104455） | 同上（第 10 届山东省赛） |
| `cf:104461` | 2023 | 按 gym 号插值（邻居 104455） | 同上（第 14 届浙江省赛；树里 `zjcpc20th=2023`、`zjcpc21st=2024` 可佐证但不硬） |
| `cf:105891` | 2025 | 按 gym 号插值（邻居 105895） | 省赛正赛无疑，只有年份是插值 |
| `cf:105471` `cf:105484` `cf:105632` `cf:105657` | 2023 / 2024 | 赛名里的年份 | 比插值可靠；批量批时年份层会按这个落 |
| `cf:105173` | 2024（赛名） | 赛名写 2024，CF `startTimeSeconds` 落 2023-05-19 | 树里 `natureSeason=2024`、`natureYear=2023`——**赛季跨年**，按年查看容易看漏 |
| `cf:103860` | 2022（硬，开赛 2022-07-27） | 硬时间 | 名字是 **CCPC Finals 2021**（2021 赛季延期到 2022 办）；按"2021"筛会找不到 |
