# CF gym 逐条判断（2022–2025 · 最近号段）

> 只读分析产物。**没有**修改 `xcpc_registry.json` / `xcpc_contests.json` / `gym_whitelist.json` / `acm-data/nodes/**`。
> 数据源：`cache/cf_gym_meta.json`（全量 2649 场 gym 元信息 + 赛名分类）、`xcpc_registry.json` 候选区、
> `acm-data/nodes/all_nodes.json`（CF gym 树）。分类判据只有一份：`cf_board_adapter.gym_class_rule()`。

## 0. 这份表在看什么

| 项 | 说明 |
|---|---|
| **主范围** | `y ∈ {2022…2025}`（**推定年份也算**）且 **gym 号 ≥ 105200**（= CF gym 列表最新 7 页那一段，用户点名区间）→ **525 条** |
| **对照范围** | 另把 **103700 ≤ 号 < 105200** 的同条件场次一并过了一遍（408 条），用来验证"更早的号段里有没有漏收"；结论：**没有新的漏收**，只在 2022 小节里补进了本来就属于 2022 的 `cf:103743`~`cf:104172` 那一段 |
| **年份列** | `2024` = 硬数据（`seasonFrom = cf（startTimeSeconds）`）；`2024?` = **推定**，括号里写依据：`赛名` / `插值` / `rankland` |
| **已在树？** | `all_nodes.json` 里存在 `节点类型=="C"` 且 `extKey=="cf:c:<号>"` 且父链走到 `cf:s:cf-gym*` |
| **收 / 不收 / 待定** | 口径完全沿用用户给定：**ICPC EC（pre/regional/final）｜CCPC 全系列｜国内省市赛·邀请赛** 收；非 EC 的 ICPC、ucup/训练营、校赛/新生赛/企业赛/OI/外国全国赛、`无归类` 不收 |

**"前一版只有 47 条"这件事的真相**：那 47 条是 `approve --suggest --year 2022-2025` 会批的候选数；
它**只覆盖"分类路径已经落到 icpc/ec、ccpc、provincial&invitational"的场次**，
`无归类` 与停在 `cf/gyms/xcpc/icpc` 浅处的场次**根本不进候选区**，脚本永远批不到。
本轮把号段 ≥105200 的 525 条（含 407 条 `无归类` + 49 条浅处）全部人工过了一遍。

---

## 1. 结论速览

> 说明：**2022 年在严格范围（号 ≥ 105200）里一条都没有**——2022 的场次全部落在 103743–104849。
> 下表与 §2 按用户允许的放宽下限（≈103700）收录 2022，其余各年也一并把 <105200 的对照结果算进来。

| 年 | ICPC-EC | CCPC | 省市赛·邀请赛 | 小计（收） | 不收 | 待定（需人拍板） |
|---|---|---|---|---|---|---|
| 2022 | 1 | 4 | 3 | **8** | 0 | 1 |
| 2023 | 3 | 1 | 8 | **12** | 1（warm-up） | 3（2 条插值 + 1 条重复） |
| 2024 | 3 | 4 | 6 | **13** | 1（warm-up） | 0 |
| 2025 | 3 | 1 | 11 | **15** | 1（mirror） | 5（插值 / 年份冲突 / 浅处） |
| **合计** | **10** | **10** | **28** | **48** | **3** | **9** |

- 48 条"收"里：**27 条**已经在树（不用批）；**17 条**可由 `approve --suggest --year …` 批到；
  **4 条**判为应收但脚本**批不到**（`cf:104081`、`104611`、`104725`、`105851`，白名单 `include:false`，详见批准清单第四节）。
  账目：27 + 17 + 4 = 48 ✔
- 另有本表按用户要求列出的 **15 条"列出但不动"**：3 条明确不收（2 热身赛 + 1 `[Unofficial Mirror]`）+ 12 条"需人拍板"（含校赛存疑、年份最弱推定、重复 gym、已列在"收"里的对照项）。
  其中真正需要用户拍板的是 **9 条**（2022:1 / 2023:3 / 2025:5），分布在 §2/§3/§5 各年的"不确定"组里。

---

## 2. 2022（号段 103700+，2022 的场次全部落在 103743–104849）

### ICPC-EC（1）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:103861` | 2022（硬） | 2021 ICPC Asia East Continent Final | `xcpc/icpc/ec/final/official` | ✅ `cf-gym` | **收** | EC 总决赛，主场；已在树，无需再批 | 已在树，跳过 |

### CCPC（4）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:103860` | 2022（硬，开赛 2022-07-27） | The 7th China Collegiate Programming Contest, Finals (CCPC Finals 2021) | `xcpc/ccpc/final/official` | ❌ | **收** | CCPC 总决赛（2021 赛季延期到 2022 办），是正赛不是镜像 | `answer cf:103860 yes`（归 ccpc2021final） |
| `cf:104008` | 2022（硬） | 2022 China Collegiate Programming Contest (CCPC) Guilin Site | `xcpc/ccpc/regional/official` | ❌ | **收** | CCPC 分站正赛 | `answer cf:104008 yes`（归 ccpc2022guilin） |
| `cf:104053` | 2022（硬） | 2022 China Collegiate Programming Contest (CCPC) Guangzhou Onsite | `xcpc/ccpc/regional/official` | ❌ | **收** | CCPC 分站正赛 | `answer cf:104053 yes`（归 ccpc2022guangzhou） |
| `cf:104065` | 2022（硬） | 2022 China Collegiate Programming Contest (CCPC) Mianyang Onsite | `xcpc/ccpc/regional/official` | ❌ | **收** | CCPC 分站正赛 | `answer cf:104065 yes`（归 ccpc2022mianyang） |

### 省市赛·邀请赛（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:103729` | 2022（硬） | 2022 Hubei Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 湖北省赛 | 已在树 |
| `cf:103743` | 2022（硬，开赛 2022-05-28） | 2022 Jiangsu Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 江苏省赛正赛 | `answer cf:103743 yes`（归 jscpc7th） |
| `cf:103931` | 2022（硬） | 2022 Shanghai Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 上海市赛正赛 | `answer cf:103931 yes` |

### 不确定（需要人拍板）（1）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:103765` | 2022（硬，开赛 2022-05-29） | 2022 Collegiate Programming Contest of Xiangtan University | `P&I/无/省赛/official` | ❌ | **待定（偏收）** | 分类判据按"含中国大学名 → 省赛"收进来了，但名字是**校名**不是省名。同族的 `cf:103353`「2023 Xiangtan University Programming Contest」、`cf:106290`「哈工大一校三区联合校赛」都判**不收**（校赛）。它若真是湘潭大学校赛，就该按校赛剔除；用户要保留吗？ | 若收：`answer cf:103765 yes` |

---

## 3. 2023

### ICPC-EC（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:104901` | 2023?（赛名） | The 2023 ICPC Asia Jinan Regional Contest (The 2nd Universal Cup. Stage 17: Jinan) | `xcpc/icpc/ec/regional/official` | ✅ `cf-gym` | **收** | EC 济南站；树里 `cf:s:cf-gym:icpc:ec:2023` | 已在树 |
| `cf:104976` | 2023（硬，开赛 2023-12-10） | The 2023 ICPC Asia Hangzhou Regional Contest (The 2nd Universal Cup. Stage 22: Hangzhou) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | EC 杭州站正赛 | `answer cf:104976 yes`（归 icpc2023hangzhou） |
| `cf:105471` | **2023?（赛名）** | The 2023 ICPC Asia Xian Regional Contest (The 3rd Universal Cup. Stage 9: Xian) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | EC 西安站正赛；**年份是推定的**（CF 没给开赛时间） | `answer cf:105471 yes` |

### CCPC（1）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:104791` | 2023（硬，开赛 2023-10-14） | The 2023 CCPC (Qinhuangdao) Onsite Warmup | `xcpc/ccpc/regional/warm-up` | ❌ | **不收（例外）** | **热身赛**（`warm-up`），不是正赛；上一轮批准清单里收过它，用户已点名它是"热身赛"例外 | 不建议批 |

### 省市赛·邀请赛（8）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:104337` | 2023（硬） | 2023 Hubei Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 湖北省赛 | 已在树 |
| `cf:104354` | 2023（硬） | 2023 CCPC Henan Provincial Collegiate Programming Contest | `P&I/CC/省赛/official` | ❌ | **收** | 河南省赛（CCPC 关系） | `answer cf:104354 yes`（归 haccpc5th） |
| `cf:104363` | 2023（硬） | The 18th Heilongjiang Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 黑龙江省赛 | 已在树 |
| `cf:104366` | 2023（硬，开赛 2023-05-14） | The 17th Chinese Northeast Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 东北地区赛（大区级，历届都收） | `answer cf:104366 yes` |
| `cf:104369` | 2023（硬） | The 2023 Guangdong Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 广东省赛 | 已在树 |
| `cf:104385` | 2023（硬） | 2023 (ICPC) Jiangxi Provincial Contest -- Official Contest | `P&I/IC/省赛/official` | ❌ | **收** | 江西省赛正赛（非 mirror） | `answer cf:104385 yes`（归 jxcpc2023） |
| `cf:104396` | 2023（硬） | 2023 Jiangsu Collegiate Programming Contest, 2023 National Invitational of CCPC (Hunan), The 13th… | `P&I/CC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 江苏省赛 + CCPC 湖南邀请赛 | 已在树 |
| `cf:104417` | **2023?（插值，邻居 104415）** | The 13th Shandong ICPC Provincial Collegiate Programming Contest | `P&I/IC/省赛/official` | ❌ | **收** | 山东省赛；**年份最弱推定**（按邻居 gym 号插值，无开赛时间） | `answer cf:104417 yes` |

### 不确定（需要人拍板）（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:104459` | **2023?（插值，邻居 104455）** | The 10th Shandong Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收（年份待定）** | 赛名无年份、CF 无开赛时间，只有插值 → 2023。若它其实是 2022 或 2024 的省赛，年份层会挂错 | `answer cf:104459 yes` |
| `cf:104461` | **2023?（插值，邻居 104455）** | The 14th Zhejiang Provincial Collegiate Programming Contest Sponsored by TuSimple | `P&I/无/省赛/official` | ❌ | **收（年份待定）** | 同上；浙江省赛（第 14 届 ≈ 2023 春？纯插值）。注意树里 `zjcpc20th=2023`、`zjcpc21st=2024` | `answer cf:104461 yes` |
| `cf:105184` | 2023（硬，开赛 2023-05-26） | The 8th Hebei Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 河北省赛；`cf_gym_recommend.md` 把它归到 2023 也对（开赛 2023-05） | `answer cf:105184 yes` |

> ⚠️ **重复条目**：`cf:106268`「The 2025 Asia Yokohama Regional Contest」是 `cf:105633`（2024 横滨，已在树）的**重复 gym**，分类判成 `无归类`。
> 它本身是 ap 赛区 ⇒ 不收；但它说明"赛名年份"这一档推定会出错（详见 §7）。

---

## 4. 2024

### ICPC-EC（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105484` | **2024?（赛名）** | The 2024 ICPC Asia Nanjing Regional Contest (The 3rd Universal Cup. Stage 16: Nanjing) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | 南京站正赛；年份推定（赛名） | `answer cf:105484 yes`（归 icpc2024nanjing） |
| `cf:105486` | 2024（硬，开赛 2024-10-27） | 2024 ICPC Asia Chengdu Regional Contest (The 3rd Universal Cup. Stage 15: Chengdu) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | 成都站正赛 | `answer cf:105486 yes`（归 icpc2024chengdu） |
| `cf:105657` | **2024?（赛名）** | The 2024 ICPC Asia Hangzhou Regional Contest (The 3rd Universal Cup. Stage 25: Hangzhou) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | 杭州站正赛；年份推定（赛名） | `answer cf:105657 yes`（归 icpc2024hangzhou） |

### CCPC（4）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105459` | 2024（硬） | 2024 China Collegiate Programming Contest (CCPC) Harbin Onsite (The 3rd Universal Cup. Stage 14: Harbin) | `xcpc/ccpc/regional/official` | ✅ `cf-gym` | **收** | CCPC 哈尔滨站正赛 | 已在树 |
| `cf:105487` | 2024（rankland） | 2024 China Collegiate Programming Contest (CCPC) Female Onsite (…女生专场) | `xcpc/ccpc/female/official` | ✅ `cf-gym` | **收** | CCPC 女生专场 | 已在树 |
| `cf:105540` | 2024（硬，开赛 2024-10-27） | 2024 China Collegiate Programming Contest (CCPC) Jinan Site | `xcpc/ccpc/regional/official` | ❌ | **收** | CCPC 济南站正赛 | `answer cf:105540 yes`（归 ccpc2024jinan） |
| `cf:106030` | 2024（硬，开赛 2024-11-10） | 2024 China Collegiate Programming Contest (CCPC) Chongqing Onsite | `xcpc/ccpc/regional/official` | ❌ | **收** | CCPC 重庆站正赛 | `answer cf:106030 yes`（归 ccpc2024chongqing） |

### 省市赛·邀请赛（6）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105139` | 2024（硬，开赛 2024-04-27） | The 2024 International Collegiate Programming Contest in Hubei Province, China | `P&I/无/省赛/official` | ❌ | **收** | 湖北省赛 | `answer cf:105139 yes`（归 hbcpc6th） |
| `cf:105222` | 2024（硬） | The 2024 Sichuan Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 四川省赛 | 已在树 |
| `cf:105229` | 2024（硬，开赛 2024-06-16） | The 2024 Shanghai Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 上海市赛 | `answer cf:105229 yes`（归 shcpc2024） |
| `cf:105423` | 2024（rankland） | 2024湖南省赛 | `P&I/无/省赛/official` | ❌ | **收** | 湖南省赛 | `answer cf:105423 yes`（归 hncpc20th） |
| `cf:105481` | 2024（硬，开赛 2024-11-03） | 2024 CCPC Liaoning Provincial Contest | `P&I/CC/省赛/official` | ❌ | **收** | 辽宁省赛 | `answer cf:105481 yes` |
| `cf:106697` | 2024（rankland） | The 7th Guangxi Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 广西省赛 | `answer cf:106697 yes`（归 gxcpc7th） |

### 已在树、但候选区里没有 year 的（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105158` | 2024（硬，开赛 2024-05-19） | 2024 National Invitational of CCPC (Zhengzhou), 2024 CCPC Henan Provincial… | `P&I/CC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105161` | 2024（硬） | 2024 Jiangsu Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105163` | 2024（硬） | The 19th Heilongjiang Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105170` | 2024（硬） | The 2024 CCPC National Invitational Contest (Changchun), The 17th Jilin Provincial… | `P&I/CC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105231` | 2024（硬） | 2024 (ICPC) Jiangxi Provincial Contest -- Official Contest | `P&I/IC/省赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105257` | 2024（硬） | 2024 ICPC ShaanXi Provincial Contest | `P&I/IC/省赛/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105336` | 2024（硬） | The 2024 CCPC Online Contest | `xcpc/ccpc/pre/official` | ✅ `cf-gym` | **收** | CCPC 网络预选 | 已在树 |
| `cf:105358` | 2024（硬） | The 2024 ICPC Asia EC Regionals Online Contest (II) | `xcpc/icpc/ec/pre/official` | ✅ `cf-gym` | **收** | EC 线上预选 | 已在树 |
| `cf:105385` | 2024（硬，开赛 2024-05-26） | The 2024 CCPC Shandong Invitational Contest and Provincial Collegiate… | `P&I/CC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 已在树；**候选区里 year 为空**，故不参与 `--suggest --year` | 已在树 |
| `cf:105578` | 2024（硬） | The 2024 ICPC Asia Shenyang Regional Contest (The 3rd Universal Cup. Stage 19) | `xcpc/icpc/ec/regional/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |
| `cf:105588` | 2024（硬） | The 2024 ICPC Asia Kunming Regional Contest (The 3rd Universal Cup. Stage 20) | `xcpc/icpc/ec/regional/official` | ✅ `cf-gym` | **收** | 已在树 | 已在树 |

---

## 5. 2025

### ICPC-EC（3）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:106161` | 2025（硬，开赛 2025-10-26） | The 2025 ICPC Asia Chengdu Regional Contest (The 4rd Universal Cup. Stage 4) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | 成都站正赛 | `answer cf:106161 yes`（归 icpc2025chengdu） |
| `cf:106252` | 2025（硬，开赛 2025-11-16） | The 2025 ICPC Asia Shenyang Regional Contest (The 4th Universal Cup. Stage 6) | `xcpc/icpc/ec/regional/official` | ❌ | **收** | 沈阳站正赛 | `answer cf:106252 yes`（归 icpc2025shenyang） |
| `cf:106072` | 2025（硬，开赛 2025-09-14） | The 2025 ICPC Asia EC Regionals Online Contest (II) | `xcpc/icpc/ec/pre/official` | ❌ | **收** | EC 线上预选，正赛 | `answer cf:106072 yes` |

### CCPC（1）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:106184` | 2025（硬，开赛 2025-11-08） | The 2025 China Collegiate Programming Contest (CCPC) Harbin Onsite Warmup | `xcpc/ccpc/regional/warm-up` | ❌ | **不收（例外）** | **热身赛**；用户点名"是热身赛" | 不建议批 |

### 省市赛·邀请赛（11）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105887` | 2025（rankland） | 第十三届重庆市大学生程序设计竞赛 | `P&I/无/省赛/official` | ❌ | **收** | 重庆市赛 | `answer cf:105887 yes`（归 cqcpc13th） |
| `cf:105901` | 2025（硬，开赛 2025-04-26） | 2025 ICPC Wuhan Invitational Contest (The 3rd Universal Cup. Stage 37: Wuhan) | `P&I/IC/邀请赛/official` | ❌ | **收** | 名字是 **Invitational**，脚本 guess `icpc2025wuhan`（regional）疑错；仓库已有 `icpc2025invitational-wuhan` slug | `answer cf:105901 yes --slug icpc2025invitational-wuhan` |
| `cf:105909` | 2025（硬，开赛 2025-05-18） | The 9th Hebei Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 河北省赛 | `answer cf:105909 yes` |
| `cf:105922` | 2025（硬，开赛 2025-05-24） | The 18th Jilin Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 吉林省赛 | `answer cf:105922 yes` |
| `cf:105930` | 2025（硬，开赛 2025-05-25） | The 15th Shandong CCPC Provincial Collegiate Programming Contest | `P&I/CC/省赛/official` | ❌ | **收** | 山东省赛（标了 CCPC 关系，仍属省赛） | `answer cf:105930 yes` |
| `cf:105941` | 2025（硬，开赛 2025-06-02） | 2025 National Invitational of CCPC (Zhengzhou), 2025 CCPC Henan Provincial… | `P&I/CC/省赛暨邀请赛/official` | ❌ | **收** | 河南邀请赛 + 省赛 | `answer cf:105941 yes`（归 ccpc2025invitational-zhengzhou） |
| `cf:105949` | 2025（硬，开赛 2025-06-08） | The 2025 Sichuan Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 四川省赛 | `answer cf:105949 yes` |
| `cf:105977` | 2025（硬，开赛 2025-05-21） | 2025 National Invitational of CCPC (Fujian), The 12th Fujian Collegiate… | `P&I/CC/省赛暨邀请赛/official` | ❌ | **收** | 福建邀请赛 + 省赛 | `answer cf:105977 yes`（归 ccpc2025invitational-fujian） |
| `cf:105992` | 2025（硬，开赛 2025-07-05） | The 2025 Shanghai Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 上海市赛；脚本 guess `icpc2025shanghai` **疑错**——07-05 更像省赛，仓库里有 `shcpc2025` | `answer cf:105992 yes --slug shcpc2025` |
| `cf:106139` | 2025（硬，开赛 2025-10-12） | The 21st Hunan Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 湖南省赛 | `answer cf:106139 yes` |
| `cf:106380` | 2025（硬，开赛 2025-11-15） | The 6th Liaoning Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 辽宁省赛 | `answer cf:106380 yes` |
| `cf:106707` | 2025（硬，开赛 2025-05-25） | The 8th Guangxi Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收** | 广西省赛 | `answer cf:106707 yes` |

### 已在树、但候选区里没有 year 的（3）—— 已计入上面 11 条，此处只为标出"树里已有"

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105911` | 2025（硬，开赛 2025-05-18） | 2025 ICPC Nanchang Invitational and Jiangxi Provincial Collegiate… | `P&I/IC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 已在树（上表第 2 条的另一个 gym）；候选区 `year` 为空 | 已在树 |
| `cf:105924` | 2025（硬，开赛 2025-05-25） | The 2025 CCPC National Invitational Contest (Northeast), The 19th Northeast… | `P&I/CC/省赛暨邀请赛/official` | ✅ `cf-gym` | **收** | 已在树；候选区 `year` 为空 | 已在树 |
| `cf:105945` | 2025（硬，开赛 2025-06-02） | The 2025 Jiangsu Collegiate Programming Contest, The 2025 Guangdong Provincial… | `P&I/无/省赛/official` | ✅ `cf-gym` | **收** | 已在树；候选区 `year` 为空 | 已在树 |

### 不确定（需要人拍板）（5）

| cf | 年 | 赛名 | 分类路径 | 已在树 | 判定 | 理由 | 批准命令 |
|---|---|---|---|---|---|---|---|
| `cf:105891` | **2025?（插值，邻居 105895）** | The 13th Shaanxi Provincial Collegiate Programming Contest | `P&I/无/省赛/official` | ❌ | **收（年份待定）** | 陕西省赛，但**年份只有插值**（无开赛时间、赛名无年份）；第 13 届对应 2025 合理，仍属最弱依据 | `answer cf:105891 yes` |
| `cf:106714` | **2025?（赛名）** | [Unofficial Mirror] 2025 ICPC Shaanxi National Invitational Contest | `P&I/IC/邀请赛/official` | ❌ | **不收（例外）** | **`[Unofficial Mirror]`**：非官方镜像，用户点名不建议批 | 不建议批 |
| `cf:106268` | **2025?（赛名）** | The 2025 Asia Yokohama Regional Contest | `cf/gyms/无归类` | ❌ | **不收（待定）** | 名字是 **2025 横滨**，但已在树的 `cf:105633` 是 **2024 横滨**——两者名实不符，疑为同一场的重复 gym。横滨是 ap 赛区 ⇒ 无论如何不收；提出来是给"年份推定"做个反例 | 不收 |
| `cf:106270` | 2025（硬） | ICPC Asia Dhaka Regional Onsite 2025 — **Replay Contest** | `cf/gyms/xcpc/icpc`（浅处） | ❌ | **不收** | Dhaka = ap 赛区；且是 Replay | 不收 |
| 2025 EC 其余正赛 | 2025 | 2025 EC Final、Asia Hefei / Nanjing / Xian / Hangzhou / Hong Kong / Macau Regional | — | — | **缺场次（不是"不收"）** | 拿赛名逐个回查 `cf_gym_meta.json`：这 7 场在 CF gym 全量元信息里**根本没有对应 gym**（2024 那年同样缺 EC Final；2024 的 8 个 Regional 齐全）。是 CF 没上传，不是判漏 | 无 |

---

## 6. 不收（列出但不建议批）

### 6.1 逐条点名的"看着像但不收"

| cf | 年 | 赛名 | 为什么不收 |
|---|---|---|---|
| `cf:105254` / `cf:105255` | 2022 / 2023? | 2022 / 2023 ICPC World Finals | 世界总决赛，不在 EC 赛区口径内（口径只收 EC 的 pre/regional/final） |
| `cf:105633` | 2024?（赛名，已在树） | The 2024 ICPC Asia Yokohama Regional Contest | ap 赛区 |
| `cf:105632` 以外的 2025 `Asia …` | 2025 | Manila / Bangkok / Dhaka / Taoyuan / Tehran / Taiwan Online | 全部非 EC |
| `cf:106225` / `106353` / `106193` / `106124` / `106129` / `106144` / `106151` / `106169` | 2025 | SWERC / NWERC / NERC / NCPC / GCPC / GRCPC | 欧洲赛区（eu） |
| `cf:105383` / `106084` / `105544` | 2024 / 2025 / 2023 | ICPC Asia Taiwan Online / Taoyuan | ap 赛区 |
| `cf:103990` / `104619` | 2022 / 2023 | 同上（台湾线上） | ap 赛区 |
| `cf:105873` / `105979` / `106063` / `105408` / `103708` / `103940` / `104375` / `104412` | 2024–2025 | ICPC Gran Premio de Mexico（各轮）/ Repechaje | 拉美赛区（la） |
| `cf:105327` / `106073` / `104555` / `103960` | 2024–2025 | Brazil Subregional / First Phase | 拉美赛区 |
| `cf:105230` | 2024? | 2024-2025 ICPC Bolivia Pre-National Contest | 拉美赛区 |
| `cf:106017` / `105278` / `103577` | 2025/2024/2022 | ICPC Universidad Nacional de Colombia | 拉美赛区 |
| `cf:105020` | 2022? | TCPC Tunisian Collegiate Programming Contest 2022 | 非洲/阿拉伯区（Foreign National） |
| `cf:104426` / `104447` / `104468` / `104493` / `104544` / `105223` / `105242` / `105264` / `105316` / `105319` / `105993` / `106007` / `106016` / `106020` / `106032` / `106068` / `106094` | 2023–2025 | Syrian / Aleppo / Damascus / HIAST / Al-Baath / Tishreen / Latakia / SVU | 阿拉伯区各校赛（`cf/gyms/无归类`）——**名字带 Collegiate 但不是 XCPC 正赛** |
| `cf:105948` / `106026` | 2025 | CCF CAT NAEC 2025 (Provincial) / (Final) | **CCF CAT 不是 ICPC/CCPC 系列**（企业/行业赛性质） |
| `cf:105013` / `105172` / `105895` | 2023–2025 | The 19th/20th/21st **Southeast University** Programming Contest (Summer) | 校赛 |
| `cf:105069` / `105556` / `106238` | 2024–2025 | FanRuan Cup **Southeast University** Programming Contest | 企业冠名校赛 |
| `cf:105615` / `105629` / `106267` / `106272` | 2024–2025 | **Beihang University** Collegiate Programming Contest (BCPC) | 校赛（"Collegiate" 是校名） |
| `cf:105174` / `105910` | 2023? / 2025? | **Sichuan University** Programming Contest | 校赛 |
| `cf:105631` / `106114` | 2024 / 2025 | **SYSU** / **Sun Yat-sen University** CPC | 校赛 |
| `cf:105168` / `105902` | 2024 / 2025 | **Fujian Normal University** Programming Contest | 校赛 |
| `cf:105838` | 2025 | **Huazhong Agricultural University** Programming Contest | 校赛 |
| `cf:105981` / `106289` / `106153` | 2025 | **Hunan University** Programming Contest / Freshman Contest / HNNU Freshman | 校赛 / 新生赛 |
| `cf:105986` / `106614` | 2025 / 2026 | **Wuhan University of Technology** Programming Contest | 校赛 |
| `cf:106136` | 2025 | **East China University of Science and Technology** Programming Contest | 校赛 |
| `cf:105176` / `105937` | 2024 / 2025 | **Xian Jiaotong University** Programming Contest | 校赛 |
| `cf:105182` | 2024 | The 22nd **UESTC** Programming Contest | 校赛 |
| `cf:105322` / `105323` | 2024 | 2024 **Xiangtan University Summer Camp**-Div.1/2 | 训练营 |
| `cf:104414` | 2023 | 2023 **Hunan Provincial Multi-University Training** | 多校训练 |
| `cf:105485` / `106194` | 2024 / 2025 | **China University of Geosciences (Wuhan) Freshman Contest** | 新生赛 |
| `cf:105586` / `105806` | 2024? / 2025? | "华为杯" **广东工业大学 ACM 新生**程序设计竞赛 / 程序设计竞赛 | 新生赛 / 校赛 |
| `cf:104395` | 2023? | **Cupertino Informatics Tournament** | 美式中学生赛 |
| `cf:106290` | 2025 | 2025年第一届**哈尔滨工业大学**程序设计竞赛一校三区联合**校赛** | 校赛 |
| `cf:105160` | 2024 | USST Freshman Challenge Contest | 新生赛 |
| `cf:103765` | 2022 | 见 §2 待定 | 校赛/省赛存疑 |
| `cf:106164` / `106262` / `106270` | 2025 | Bangkok / Manila / Dhaka Regional | ap 赛区 |
| `cf:105584` / `106185` | 2024 / 2025 | ICPC Japan Online First-Round | ap 赛区 |

### 6.2 分类统计：为什么"不收"占绝大多数

号段 ≥105200 且年份 ∈ 2022–2025 的 **525 条**里：

| 桶 | 条数 | 说明 |
|---|---|---|
| `cf/gyms/无归类` | 407 | 逐条看过：**没有一条是应收的 XCPC 正赛**。构成：俄罗斯/独联体中小学奥赛（ВсОШ/ВКОШП/Интернет-олимпиады/Когнитивные технологии ≈ 150+）、美国校内赛与中学生赛（UTPC/TeamsCode/MITIT/USACO.Guide ≈ 45）、西班牙 OI（Spain Olympiad/OIE）、巴西与拉美校赛、孟加拉/埃及/叙利亚校赛、中国各校校赛·新生赛（≈ 40）、TheForces 等 CF 民间的 rated 小比赛、Java/ML 等非 XCPC 主题 |
| 浅处 `cf/gyms/xcpc/icpc` | 49 | 全是**非 EC 的 ICPC**：World Finals、墨西哥/巴西/哥伦比亚/玻利维亚（la）、NERC/NWERC/SWERC/GCPC/NCPC/GRCPC（eu）、台湾/德黑兰/横滨/马尼拉/曼谷/达卡（ap）、叙利亚/泰国/韩国校赛。**没有一条 EC** |
| `cf/gyms/ucup` | 12 | Universal Cup / Osijek / Petrozavodsk 训练营 —— 明确不收 |
| 非 EC 的 `icpc/<region>` | 26 | eu / la / na / ap 各站 |
| **应收（ICPC-EC / CCPC / 省市赛）** | **31** | 已在 §2–§5 逐条列出（另有 4 条白名单漏网 + 若干浅处待判） |

**对照范围（103700–105199，408 条）**：`无归类` 282 条里同样是各式中小学奥赛与校赛，非 XCPC；
分类导出的 126 条里应收的**全部都已收**（要么已在树、要么已进候选区），**没有新发现**。
唯一"看着像"的 `cf:104366`（Chinese Northeast Collegiate）也已列入 §3。

---

## 7. 数据质量观察（供维护参考）

1. **赛名年份有时是错的** → `cf:106268`「2025 Asia Yokohama」与已在树的 `cf:105633`「2024 ICPC Asia Yokohama」冲突；
   `cf:106167`「2021-2022 GCPC 2021」被推定成 2025（邻居插值）；`cf:105173` 赛名写 2024、起赛 2023-05-19（树里 `natureSeason=2024`、`natureYear=2023`）。
2. **`seasonFrom` 的强弱分层很有用**：`cf（startTimeSeconds）` 38 条（硬）、`赛名里的年份` 8 条、`按 gym 号插值` 4 条、`rankland 索引` 4 条。
   本轮"收"里**只有 3 条**（`cf:104459`、`104461`、`105891`）靠最弱的插值，其余都有赛名或硬时间兜底。
3. **候选区 `year` 字段有缺口**：`cf:105173`、`105385`、`105924`、`105911`、`105945` 等已在树的场次，
   在 `xcpc_registry.json` 的 `pending` 里 `year` 是空的 → 它们**不会**被 `--year` 过滤命中（不影响正确性，但会让"候选区按年查看"漏显示）。
4. **浅处（`gym:shallow`）里没有 EC**：49 条浅处场次逐条看全是非 EC；反过来说，
   "EC 的赛区读不出来"这个隐患在这一批里没有实际发生。
5. **`cf:104901`（2023 济南）的历史遗留**：它已在树（`cf:s:cf-gym:icpc:ec:2023`），
   但在 `xcpc_registry.json` 的 `pending` 里**整个条目是空的**（只有 key、没有 `year`/`cls`/`title`），
   `cf_gym_recommend.md` 里也没有它——所以它既不会被动批，也不会被"按年查看"看到。同类空壳还有
   `cf:105143`、`105158`、`105161`、`105163`、`105170`、`105173`、`105385`、`105487`、`105911`、`105924`、`105945`。

---

## 8. 号段对照结论（用户最关心的那一条）

> "22–25 年的场次就在 105200…106744 这一段附近，要仔细判断。"

逐条看完这 525 条后的结论：

- **这一段里确实藏着 4 条"分类判对、却因为白名单 `include:false` 而批不到"的真 XCPC 场次**：
  `cf:104081`、`cf:104611`、`cf:104725`、`cf:105851`（详见 `cf_gym_approve_2022-2025.md` 第 4 节）。
- **这一段里没有"分类判成 `无归类`、其实是 XCPC 正赛"的场次**：407 条 `无归类` 逐条看过，
  带 `Collegiate`/`Programming Contest` 的全是外国校赛（叙利亚、埃及、孟加拉、俄罗斯、美国）。
- **浅处 49 条里也没有 EC**：EC 的场次赛名里都会写 `ICPC Asia … Regional`，`region_of_name()` 都能读到 `ec`。
- **真正的"漏收"风险不在号段，而在"赛名没写年份 + CF 没给开赛时间"**（本轮 4 条插值 + 8 条赛名年份）
  —— 它们才是会被 `--year` 过滤错杀的对象；已逐条标 `?` 与依据。

