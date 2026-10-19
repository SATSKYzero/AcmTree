# 往年牛客多校：手爬标准

> ⚠️ 里面"现在已有几场"这类**完成状态是快照**，会随抓取变 —— 判据部分不受影响。

> 目的：把 **2025 及更早的多校**补成一个来源包，和现在那 10 场（2026 多校 1–10，`nk:c:133876…133885`）并列。
> 你负责**取数**，我负责**接线**（`nk_adapter` + clist 难度 + 体检/需求会自动认）。
> 判据/形状照下面来 —— **形状对了，我这边一行代码都不用改**。

## 一、要哪些场次

| 项 | 口径 |
|---|---|
| **范围** | 牛客「**暑期多校**」系列（`ac.nowcoder.com/acm/contest/<id>`），**2025 及更早**，年份越多越好 |
| **不要** | 牛客上的其它比赛（练习赛 / 小白月赛 / 高校联赛…）—— 那些不属于这个系列，混进来会污染分类 |
| **不确定的** | 拿不准算不算多校的，**先都抓下来但单独列一行备注**（"疑似"），我按链接判断 |

## 二、每场要什么（最小可用）

1. **题目表**：`题号`（A/B/C… 或题目页上的字母）+ `题名` + `题目链接`；
2. **比赛链接**：`https://ac.nowcoder.com/acm/contest/<id>`（**这个最重要**：identity、题号、clist 难度全靠它）；
3. **可选但有用**：`开赛时间`（用于年份/赛季判定）、`通过率/过题人数`（我这边 `ratio` 字段）、`榜单链接`。

⚠️ **不要**把"提交记录"混进来（那是另一个来源），也不要手改题名 —— 原样即可。

## 三、怎么抓（**三步全自动**，2026-10-02 研究确认）

| 步骤 | 用什么 | 实测 |
|---|---|---|
| ① **枚举往年多校** | **clist**：`contest/?resource=ac.nowcoder.com&order_by=-id&limit=1000` → 赛名含「多校/暑期」的挑出来 | ✅ **51 场**，年份分布 **2022:11 / 2023:10 / 2024:10 / 2025:10 / 2026:10**（`nk_multi_fetch.py` 的 `FROM_YEAR = 2022`，2018–2021 本就被排除）；每行给 `event`（赛名）+ `start`（开赛时间）+ `href`（`…/acm/contest/<id>`，**id 就在里面**） |
| ② **题目表** | **nowcoder 的 JSON 接口**：`https://ac.nowcoder.com/acm-heavy/acm/contest/problem-list?id=<cid>` | ✅ 一次拿全：`index`（题号）/`title`（题名）/`problemId`/`acceptedCount`/`submitPersonCount`/`submitCount`/`avgAcSubmitCount`；**链接可拼** `…/acm/contest/<cid>/<index>` |
| ③ **榜单**（ratio 的分母） | `…/acm-heavy/acm/contest/real-time-rank-data?id=<cid>&limit=0&page=N`；**从最后一页往回扫**找"有解出题的最后一名"（有效队伍一定是一段前缀） | ✅ 实测 **2–6 页/场**（不是 30+ 页）；每页都带 `basicInfo` + `problemData`，所以第 1 页不用单独抓；命令见 §七（`nk_multi_fetch.py run --effective`） |
| ④ **提交**（R + 账户线索） | `…/acm-heavy/acm/contest/status-list?id=<cid>&page=N&searchUserName=<用户名>` | ✅ **2026-10-03 实测发现**（以前记的"没有 JSON 接口"是错的：404 的是**页面** URL `/acm/contest/status`）。带上 `searchUserName` 只回你自己的 ⇒ **1–3 页/场、~6 KB/页**，实测 **38 场 / 1158.1 KB**，出包时 **38 场都有 R 入包**（只有 `133876`、`81602` 缺）（对比：浏览器脚本 `collect-nk-submit.js` 逐场手工跑）。命令：`nk_multi_fetch.py run-submits` |
| ⑤ 难度 | **clist**：`problem/?resource=ac.nowcoder.com` | ✅ 已经接好（`scripts/clist-difficulty.py`，按 `ac.nowcoder.com\|<场次>\|<题号>` 匹配） |

⇒ **手爬（F12 粘脚本）降级为兜底**：只有接口挂了、或要"某队逐条提交"时才用
（`collect-nk-problems.js` 题目列表 / `fetch-nk-rank.js` 榜单 / `collect-nk-submit.js` 提交；
说明见 `acm-data/raw/Scaper/05 xcpc/_usage.md`）。

⚠️ **一个已知的坑**：clist 上牛客的**难度**现在每场只有 2 个不同值（场级估计，2026 多校实测），
**往年多半也一样** —— 数据是那个来源的口径，我们如实照抄（保留、不清洗）。

> **现状（2026-10-03）**：①→④ 已经全自动化跑完，包也出了（40 场 / 2358 节点
> = W1 + S5 + C40 + P480 + R1832）——
> **本节留下的命令只当"重跑手册"**，进度与流量账见 §七。



## 四、我这边会怎么认（你不用管，但知道标准有好处）

| 你的输入 | 我这边 |
|---|---|
| `contest_url` / 文件名里的 id | `nk:c:<id>`（比赛节点），`nk:c:<id>:p:<题号>`（题目节点） |
| 题号 | `problemId`，也是题目的身份之一 |
| 题名 / 链接 | `name` / `link` |
| 开赛时间 | `natureYear` / `natureSeason` 的判据之一 |
| 题目链接 | **clist 难度**按 `ac.nowcoder.com\|<场次>\|<题号>` 自动匹配（`--refresh` 一次） |

**质检**（我跑）：`crate-check` 0 硬错误、体检 `真缺 0`、需求清单里会自己冒出"还缺难度/题名"的条目。

## 五、你可以自己先做一次体检（可选）

```powershell
# 1) 只跑牛客这一个来源（其余片段沿用缓存）
npm run crate:nk            # = python -B "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" build --from-year 2023
#    ⚠️ `scripts/build-all.py` **没有** --only-source 这个开关（它只有 --offline/--list/--needs/--pursue/--probe-all/--dry-run）
# 2) 看结论（三行）
python -B scripts/field-coverage.py --quiet
python -B scripts/material-needs.py
```

## 六、常见坑

- **别用"年份"筛场次**：牛客的多校场次 id 不连续，年份只在赛名/开赛时间里 —— 按**赛名含"多校"**筛最准；
- **题号有的是 `A`、有的是 `1`/`1001`**：原样抄，别自作主张转字母；
- **粘脚本要在对的页面上**：题目列表页用 `collect-nk-problems.js`、榜单页用 `fetch-nk-rank.js`、
  Status 页用 `collect-nk-submit.js` —— 页面不对脚本会抓空（它只读当前页的 DOM/接口）；
- **一场抓失败不要紧**：我这边按场次独立，缺哪场就少哪场，体检会报出来。

## 七、进度：**已完成**（2026-10-03）

**已出包**：`acm-data/nodes/nk-multi-university.json` = **40 场（2023–2026）/ 2358 节点**
（C 40 / P 480 / **R 1832**）/ `crate-check` **0 错**；每场的 ratio 走
`cache/nk/nk_cid<CID>_rank_stats.json`。
⚠️ **2022 不做**（没有 2022 的账号）—— 早期抓的 2022 片段留在缓存里，
**不进包**（所以是 40 场，不是 51）。

**提交（R）与账户线索**（2026-10-03 补上）：`run-submits` 按**那一年的队名**
（`me.json` 的 `nk.byYear`；今年那条由 `me.by_year` 兜底）逐场抓 —— 实测 **38 场有提交、
共 1158.1 KB**（只有 `133876`、`81602` 缺）；包里 **1603 条 R 带账户线索**
（`nk:2023` 523 / `nk:2024` 350 / `nk:2025` 429 / `nk:2026` 301，值 = 选手甲 / 选手乙 / TEAM1 /
再_努_力_一_点）。剩下 229 条没有线索的是**别人**的提交（`searchUserName` 是**前缀匹配**：
搜 `TEAM1` 也会带回 `TEAM18` 那种队）⇒ 按"客观值"照常导入，不认领，正合口径。

> ⚠️ 抓提交时会踩到的坑（已修）：`me.handles('nk')` 以前只看账户上的**裸** `nk`，
> 而 v2 里队名可以只写在 `byYear` 里 ⇒ 返回空 ⇒ **1832 条 R、线索 0 条**。
> 现在 `handles()` 把 `byYear` 的历年值也算"要抓的账号"（`lib/me.py`）。

| 文件 | 覆盖 | 内容 |
|---|---|---|
| `cache/nk/multi_contests.json` | 51 | 枚举清单（cid / 赛名 / 开赛时间 / 年份）——含 2022 |
| `cache/nk/nk_cid<CID>_contest.json` | 全 | 比赛身份（`contestId` / `contestName` / `startTime` 毫秒，**UTC**） |
| `cache/nk/nk_cid<CID>_problems.json` | 全 | 题目表（**中文键** `题号` / `标题` / `题目链接`） |
| `cache/nk/nk_cid<CID>_rank_stats.json` | 40 | **逐场 ratio 的唯一来源**（`effectiveTeams` + 每题过题队数） |
| `cache/nk/nk_cid<CID>_submits.json` | 38 | **你自己的提交**（适配器的中文键形状；`提交时间` 用 UTC+8） |

**你的三支队**（`searchUserName=<队名>` 逐个查过）：2023 `选手甲` 10/10、2024 `选手乙` 9/10
（`81602` 没参加）、2025 `TEAM1` 10/10 —— 学校都是 浙江工业大学。

### 7.1 怎么抓的（**比原计划省得多**："倒着爬会快得多"）

不用翻完 30+ 页。**"有效队伍数" = 赛时至少解出 1 题的队数**，而榜单按解出题数排序 ⇒
**有效队伍一定是一段前缀**，从**最后一页**往回扫、找到"有解出题的最后一名"就能截出这个数：

```powershell
python -B "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" run --effective --from-year 2023
python -B "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" run-submits --from-year 2023   # ← 你自己的提交（实测 38 场 / 1158.1 KB）
python -B "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" build --from-year 2023   # 出 rank_stats + 包（有 submits 就一起进包）
```

实测 **2–6 页/场**（不是 30+），并且：
- 第 1 页**不需要单独抓**（`--effective` 从最后一页取，`real-time-rank-data` 每页都带
  `basicInfo` + `problemData`）；
- 每场还顺手探一次 `rankCountOfficial`（**裸查询**：抓多少算多少）—— 与 `effectiveTeams`
  **两个分母都留着**，当前 ratio 用的是**有效队伍数**；
- `nk_rank_stats.py` 据此信 `effectiveTeams` + `complete == 'boundary'`（不再要求页数齐）；
- **打星**：牛客多校榜单没有打星这回事（`onlyContestRank=true` 只是过滤掉 rank=0 的队）。

### 7.2 流量（"只有流量，有点贵"）

按需回退的三档，从省到贵：

1. **边界法（默认，实测用这个）**：`run --effective` —— 约 **0.5–1 MB/场**（2–6 页 × 200 KB）；
2. **全榜**：`run --full-ranks` —— 一场 1400~1650 队 = 30~33 页 ≈ **5–7 MB/场**（51 场约 300 MB）；
3. **兜底重抓**：`run --effective --force`（忽略已有缓存）。

`--from-year` / `--to-year` / `--limit` 都能切范围；**只对命中你队名的场次**抓也行。
2025 场次实测：`108307` 有效队伍 **1340**，ratio 例如 A `0.30%` / D `99.63%`，`complete: true`
（**通过率是对的**）。

### 7.3 还差的一步：**应用侧的账户映射**（不用重爬，已经有一键入口）

适配器给 R 打线索的形状是 `nk:<四位年> : 用户名 = <me.json 里该账户的 nk / byYear 值>`，
而你的队名一年一个（2023 `选手甲` / 2024 `选手乙` / 2025 `TEAM1`）⇒ 应用里要按赛季各配一条
（source 带赛季、判据是三元组**全等**）：

```text
nk:2023 : 用户名 = 选手甲
nk:2024 : 用户名 = 选手乙
nk:2025 : 用户名 = TEAM1
nk:2026 : 用户名 = 再_努_力_一_点
```

> ⚠️⚠️ **源写 `nk:<四位年>`**（如 `nk:2023`）：**冒号 + 四位年**（2026-10-03 起统一）。
> 旧写法是两位年（`nk:23`），两边全等匹配会**一条都认不上**（实测 10120 条值成"未认领"）；
> 现在 `crate.season_of` 不再截断，账户里照写四位即可。同类还有 `hdu:<四位年>`；
> PTA 不一样（赛季是命名空间 `pta:icpc2026`）；`cf`/`qoj` **不带赛季**（就写 `cf` / `qoj`）。
>
> **最省事的写法**：别手打 —— 在账户面板的「未认领的线索」那一栏点 **「＋ 补映射」**，
> 它会把你**从数据里读到的原样 source** 填进映射行，天生长对。

**做法（2026-10-03 起不用手填）**：设置 →「🔑 账户/名册」→「📤 写进 me.json（爬虫用）」——
**账户（映射）是绝对真源**（在应用数据里），这一下把它**导成** `me.json` 的 `accounts[]`：
项上的 `cf`/`qoj` 来自 `cf : handle = …`、`nk`/`hdu` 的历年队名来自 `nk:2026 : 用户名 = …`
（写成 `byYear: {"nk": {"2026": "再_努_力_一_点"}}`）。凭据、说明、`current` **一个字都不动**。
⚠️ 推不出来的（`pta:icpc2026` 那种命名空间赛季）**原样留在 `mappings` 里**，一条不丢。
改完账户再导一次即可（没有"同步"这件事 —— me.json 就是它的一次派生）。



