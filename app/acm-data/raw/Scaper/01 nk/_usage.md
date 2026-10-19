# 牛客（Nowcoder）→ Acm_Tree 使用说明

这个目录里的东西只做一件事：
**把牛客比赛的数据变成一份可以拖进应用的导入包（crate）。**

```
浏览器里存页面  →  npm run crate:nk:browser  →  拖进应用
（collect-*.js / fetch-nk-rank.js）   （解析 + 合成都在里面）   (📥 节点自动导入)
```

> 本目录与 `02 hdu/` 是**同一套机制**（命名规则、自动解析、自动删源、
> 榜单统计旁边落地）。两边的差异只有平台本身：牛客页面是前端渲染的、
> 榜单有 JSON 接口。看不懂某一步时，对照 `02 hdu/_usage.md` 看同一件事。

---

## 0. 最快路径

```powershell
# ⓪ 一次就好：在 acm-data/raw/Scaper/me.json 里写一行你在牛客上的用户名
#    "nk": { "handle": "再_努_力_一_点" }
#    作用：只有"用户名与它相同"的提交会带线索（这条提交是谁的）。
#    不写也照常出包，只是提交都算客观值、「账户对比」里看不到你。

# ① 浏览器里：粘对应的收集脚本
#    题目页 → collect-nk-problems.js      产出 nk_cid<CID>_problems_source.html
#    提交页 → collect-nk-submit.js        产出 nk_cid<CID>_submit.html
#    榜单页 → fetch-nk-rank.js            产出 nk_cid<CID>_rank.json
#    （都自动下载，名字已经规范，不用剪贴板、不用改名）
# ② 把它丢进本目录（哪个子目录、多深都行）
# ③ 项目根目录执行：
npm run crate:nk:browser
```

**就这两步。** 剩下的都在 `crate:nk:browser` 里自动完成：

1. **把源 HTML 解析成 JSON**（`nk_cid<CID>*_source.html` → `nk_cid<CID>_problems.json`，
   写在源 HTML 旁边；产出比源新就跳过，重复跑不白干活）；
2. 扫描本目录（递归），按 cid 认出每场有什么；
3. 对每场有完整榜单的，算出 `nk_cid<CID>_rank_stats.json`（赛时统计，ratio 的来源）；
4. 合成**一个**导入包 `acm-data/nodes/nk-browser.json`（每条提交带
   **语言 / 耗时 / 内存 / 代码长度** 与**账户线索**，见 §2.2.1–2.2.2）。

生成后先离线自查（这一步不写任何东西，只试算）：

```powershell
npm run crate:check -- acm-data/nodes/nk-browser.json
```

没有报错，就把它拖进应用的「📥 节点自动导入」——
**导入前先删掉应用里那棵牛客子树**（导入是加法，更新过包会重复）。
导入后到**账户管理**配一条映射 `nk:2026 : 用户名 = 再_努_力_一_点`
（⚠️ **带赛季**、**四位年**：`nk:2026`；写成两位（`nk:26`）或漏赛季都绑不上 → 提交会被当成客观值），再点一次「🔁 用当前映射重跑归认」，
「👥 账户对比」里就能看到自己。

只想处理某一场 / 先看它要干什么：

```powershell
python "acm-data/raw/Scaper/01 nk/nk_pipeline.py" 133877
python "acm-data/raw/Scaper/01 nk/nk_pipeline.py" --all --dry-run
```

> ⚠️ 一定要用 PowerShell 一行写完。PowerShell **不支持** bash 的 `\` 续行。
> 路径带空格（`01 nk`）时必须加引号 —— 本目录名字里就有空格。

---

## 1. 它认哪些输入文件（**只有一条命名规则**）

```
nk_cid<CID>_<种类>.json / .html          种类 = problems | submits | contest | rank_stats | rank | submit
```

就这一条。**文件放在哪都行** —— 递归扫描到任意深度，目录名不参与识别，
因为身份写在名字里：

| 文件 | 是什么 |
|---|---|
| `nk_cid133877_problems.json` | 某场题目（**比赛 ID 的来源**：题目链接里带 cid） |
| `nk_cid133877_submits.json` | 某场提交 |
| `nk_cid133877_contest.json` | 比赛身份旁挂（比赛名 / 真实 URL），题目爬虫**顺带生成** |
| `nk_cid133877_rank.json` | 某场完整榜单（`fetch-nk-rank.js` 的产出） |
| `nk_cid133877_rank_stats.json` | 榜单算出的赛时统计（**ratio 的唯一来源**，别手工改） |
| `nk_cid133877_submit.html` | 提交页原件（`collect-nk-submit.js` 的多页包） |
| `nk_cid133877_problems_source.html` | 源 HTML：它产出 `nk_cid133877_problems.json` |
| `nk_cid133877_submits_source.html` | 源 HTML：它产出 `nk_cid133877_submits.json` |

抓取/解析脚本都**直接产出规范名**，不用手工改：

```powershell
python "…/Nowcoder_prob_scraper.py"   -i "…/nk_cid133877_problems_source.html"
python "…/Nowcoder_submit_scraper.py" -i "…/nk_cid133877_submit.html"
# 不给 -o 时，输出就是输入旁边的 nk_cid<CID>_problems.json / _submits.json
```

### 文件都写到哪（一张表说清）

| 你做什么 | 产出 | 落在哪 |
|---|---|---|
| `collect-nk-problems.js` | `nk_cid<CID>_problems_source.html` | **浏览器的下载目录** —— 你自己挪进 `01 nk/` |
| `collect-nk-submit.js` | `nk_cid<CID>_submit.html` | 同上 |
| `fetch-nk-rank.js` | `nk_cid<CID>_rank.json` | 同上 |
| `Nowcoder_prob_scraper.py -i <源.html>` | `nk_cid<CID>_problems.json` + `_contest.json` | **输入 HTML 的同一个目录** |
| `Nowcoder_submit_scraper.py -i <源.html>` | `nk_cid<CID>_submits.json` | 同上 |
| （上面两个加 `-o 路径`） | 你指定的路径 | 想放哪就放哪 |
| `npm run crate:nk:browser`（先把源解析掉） | `nk_cid<CID>_problems.json` 等 | **源 HTML 的同一个目录** |
| `npm run crate:nk:browser`（有完整榜单的场次） | `nk_cid<CID>_rank_stats.json` | **榜单 JSON 的同一个目录** |
| `npm run crate:nk:browser` | `acm-data/nodes/nk-browser.json` | 仓库的 `acm-data/nodes/` |

> 一句话：**凡是"由某个文件派生出来的 JSON"，都写在那个文件旁边；
> 名字也走同一条规范。** 每个脚本跑完都会把完整路径打印出来 —— 不用猜。
>
> 所以一场比赛的东西（源 HTML + 题目/提交 JSON + 榜单 + 榜单统计）**全在一个目录里**，
> 连目录一起搬走/删掉都不会漏。只有最终交付物 `acm-data/nodes/nk-browser.json`
> 在仓库的固定位置（那是给 `crate:check` 和导入用的）。
>
> 常规流程：源文件扔进 `01 nk/` → `npm run crate:nk:browser`
> （源被自动解析、榜单统计写在榜单旁、导入包落在 `acm-data/nodes/`）。
> 下面那几个爬虫命令是"想单独重跑某一步"时才用。

### 容错与取舍

- **浏览器重复下载的后缀会被剥掉**：`xxx (1).html`、`xxx（2）.html`、
  `xxx - 副本.html`、`xxx copy.html`，叠起来也认（`xxx（2） (1).html`）。
- **同一场有多份同类文件**时按序选一个，并在输出里明确告诉你用了哪份：
  1. **有内容的**优先（残留的空 JSON 不会把真数据顶掉）；
  2. **名字干净的**优先（没有 `(1)` 后缀）；
  3. 还平手取**更新**的。
- 名字不符合规范的文件只在"**看起来本来该给流水线用**"时才提示
  （`.json` 且名字含 problems/submits/rank/contest）。

---

## 2. 数据是怎么抓的（这一步手动）

三个浏览器脚本的分工（都是**只读**，粘到控制台就行）：

| 脚本 | 用在哪一页 | 产出 | 会翻页吗 |
|---|---|---|---|
| `collect-nk-problems.js` | 比赛**题目列表页** | `nk_cid<CID>_problems_source.html`（比赛名 + 题目表） | ❌ 只有一页 |
| `collect-nk-submit.js` | 比赛 **Status 页** | `nk_cid<CID>_submit.html`（多页拼接） | ✅ 自动点「下一页」 |
| `fetch-nk-rank.js` | 比赛 **Rank 页** | `nk_cid<CID>_rank.json`（走 JSON 接口） | ✅ 自动翻完 |

**怎么选**：

- 题目页 → `collect-nk-problems.js`；
- 提交页 → 分页且分页器是 JS 驱动的，**必须**用 `collect-nk-submit.js`；
- 榜单页 → 有独立 JSON 接口，**必须**用 `fetch-nk-rank.js`
  （单页只有 50 队，手动存等于只拿一小撮）。

> **为什么不像 HDU 那样直接 `fetch(location.href)`**：牛客的比赛页是
> **SPA 客户端渲染**的，直接请求只会拿到"加载中…"的空壳
> （`/acm/contest/status?contestId=…` 更是 404）。
> 所以题目/提交只能**就地读已经渲染好的 DOM**；只有榜单能走接口。
> 剪贴板那条路仍然不通（`NotAllowedError: Document is not focused`）——
> 本目录的三个脚本都**直接下载文件**，不碰剪贴板。

> **下面每条最后那步"解析"其实可以不敲** —— `npm run crate:nk:browser` 会自动做
> （它扫出 `*_source.html` 并解析到旁边，解析完还会删掉源）。
> 这里写出来是为了让你知道**哪份产出由谁生成**，也方便单独重跑某一步。

### 2.1 题目列表（每场必做，不然这一场进不去）

1. 打开该场比赛的**题目列表页**（能看到题号/标题/通过率）
2. F12 → Console → 粘 `collect-nk-problems.js` 整段 → 回车
3. 自动下载 `nk_cid<ID>_problems_source.html`（cid 从当前网址自动读）
4. 丢进本目录（`01 nk/`，**不用管放哪个子目录**）

（想单独解析：）

```powershell
python "acm-data/raw/Scaper/01 nk/Nowcoder_prob_scraper.py" -i "acm-data/raw/Scaper/01 nk/2026nk2/nk_cid133877_problems_source.html"
# → 同目录的 nk_cid133877_problems.json + nk_cid133877_contest.json
```

解析时顺便把**比赛名**从页面 `<h1>` 里抠出来写进旁挂文件 ——
牛客的 `<title>` 是模板化的（"牛客竞赛_ACM/NOI/…_牛客竞赛OJ"），拿不到是哪一场。

### 2.2 提交记录

牛客的 Status 页**分页**（实测每页 20 条），分页器还是 JS 驱动的：

```html
<li class="active"><a href="javascript:void(0);">1</a></li>
<li><a href="javascript:void(0);">2</a></li>   ← 链接里根本没有页码
```

所以用 `collect-nk-submit.js`：在**你已经打开的 Status 页**上读表格，
然后**自动点「下一页」**并等表格真的换页，逐页收集：

1. 打开 Status 页（先登录；需要筛选就先在页面上筛好）
2. F12 → Console → 粘 `collect-nk-submit.js` 整段 → 回车
3. **别碰页面**，让它自己翻页
4. 自动下载 `nk_cid<ID>_submit.html`
5. 解析成 JSON（也可以交给 `npm run crate:nk:browser` 自动做）：

```powershell
python "acm-data/raw/Scaper/01 nk/Nowcoder_submit_scraper.py" -i "acm-data/raw/Scaper/01 nk/2026nk2/nk_cid133877_submit.html"
# → 同目录的 nk_cid133877_submits.json
```

> ✅ **更省事的路子（推荐）**：提交其实**有 JSON 接口** ——
> `GET /acm-heavy/acm/contest/status-list?id=<cid>&page=N&searchUserName=<用户名>`
> （404 的是**页面** URL `/acm/contest/status`，不是接口）。
> 带上 `searchUserName` 就**只回你自己的**（~6 KB/页、一场 1–3 页）⇒ 往年多校那种
> 几十场的活，用脚本一把抓完，不必在浏览器里逐场跑：
>
> ```powershell
> python "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" run-submits --from-year 2023
> ```
>
> 它按 `me.json` 里**那一年的队名**（账户的 `byYear`）筛，产物就是上面那种 `nk_cid<CID>_submits.json`
> （中文键、`提交时间` 按 UTC+8）。**下面的浏览器脚本仍是兜底**：接口挂了、或要抓"某个人"时用。

收集脚本只负责"把 N 页搬回本地"，输出的是**原始 HTML**（多页用 `<!-- PAGE n -->` 分隔）；
解析永远是 `Nowcoder_submit_scraper.py` 的事 —— 页面结构变了 HTML 还在，随时能重解析。

> ⚠️ 解析端**按运行ID 去重**：多页拼接难免重叠，而重复的 extKey 会让
> `crate.py` 直接抛错（包内 extKey 必须唯一）。所以别绕过这一步手工拼。

> 提交记录只包含**你自己账号看得到的那部分**，天生不全。
> 应用里题目的通过状态由 R（提交记录）推导，所以"少了提交" = "少了状态"，
> 不会算错别的。

### 2.2.1 提交里能带出来的信息

`Nowcoder_submit_scraper.py` 解析出来的字段里，有**四样**会写进 R 节点
（牛客是三个平台里给得最全的 —— HDU 有前三样、QOJ 有后三样）：

| JSON 字段 | 包字段 | 口径 / 说明 |
|---|---|---|
| `使用语言` | `language` | 原样（`C++` / `Python3`…） |
| `运行时间(ms)` | `timeUsed` | **毫秒**（与 CF/QOJ/HDU 同口径） |
| `使用内存(KB)` | `memoryUsed` | 牛客给 **KB**，适配器 **×1024** 转字节 |
| `代码长度` | `codeLength` | **字节**（HDU 的 Status 表里没有这一列，QOJ 有） |
| 提交时间 + 比赛起止 | `submitKind` | **提交性质**：落在比赛时段内 → `赛时`，否则 `补题`；判不出 → **留空**。⚠️ **不能只按"提交日 == 比赛日"判**（当天补题非常常见，按日期判会误判）。起止时间来自旁挂 `nk_cid*_contest.json` 的 `startTime`/`endTime`（`Nowcoder_prob_scraper.py` 从比赛页 `window.pageInfo` 存下来；已有的场用 `backfill_nk_contest_times.py` 回填 —— 实测 9 场 12:00~17:00、**133880 是 12:00~17:15**）。完全拿不到才退回假设 12:00~17:00。10 场实测：赛时 138 / 补题 163 |

出包后对一眼：10 场 301 条 R，**301 条都有这四样**（`submitKind` 另有 301 条全覆盖）。

### 2.2.2 账户线索（"这条提交是谁的"）

牛客与 HDU 不同的一点：**提交记录里自带「用户名」**（`用户名` + `用户主页` 链接），
所以线索不用猜。但一个 Status 页里**可能有别人的提交**，所以约定是：

```jsonc
// acm-data/raw/Scaper/me.json
"nk": { "handle": "再_努_力_一_点" }      // 只给"用户名 == 它"的提交打线索
```

打了线索的 R 长这样：

```json
"账户线索": { "source": "nk:2026", "field": "用户名", "value": "再_努_力_一_点" }
```

- **只给用户名与 `nk.handle` 相同的那几条**：别的队伍/同学的提交照常导入（当客观值），
  但不会被认成你的。
- **source 带赛季（**四位年份**，`nk:2026`）**：应用按 `(source, field, value)` 三元组**全等**匹配，
  两条映射声明同一三元组会判成冲突、谁都不认领；届与届之间队友会换，得分开。
  （`hdu` 也是同一口径：`hdu:2026`。⚠️ **必须是四位年**：写成两位（`nk:26`）绑不上。）
- 不声明 `nk.handle` 就**一条线索都不打**，包照常出。
- 导入后在**账户管理**里配一条一样的映射（`nk : 用户名 = 再_努_力_一_点`），
  再点「🔁 用当前映射重跑归认」——已经导进来的值也会被认领，不用重导入。

#### 多人（队友 / 多队）

牛客是**最省事**的一个平台：**一页提交本来就带所有人**（`用户名` 列 + 用户主页链接），
所以多人不需要多抓任何东西，只要告诉适配器"哪些用户名要认领"：

```jsonc
// me.json（**账户**一人一项；这就是应用里的那套账户/映射）
"accounts": [
  { "name": "我",   "nature": "member", "nk": "再_努_力_一_点" },
  { "name": "队友", "nature": "member", "nk": "队友的用户名" }
]
```

- 之后 `npm run crate:nk:browser` 会**默认**把在册用户名的那几条提交都打上线索
  （`nk:2026 : 用户名 = <各自的名字>`），其余人的提交照常导入、但不会被认成你的。
- 也可以临时指定：`python "…/01 nk/nk_adapter.py" … --handle "名字A,名字B"`。
- 应用侧**不用手配**：账户里的映射是绝对真源，改完点设置页「🔑 账户/名册 → 📤 写进 me.json」
  就会把它导成上面这份名册（然后重导一次包即可）。

### 2.3 完整榜单（想要赛时通过率就必做）
榜单走独立的 JSON 接口，分页（每页 50 队，一场 1600+ 队就是 33 页）。
用 `fetch-nk-rank.js`：

1. 浏览器里打开该场比赛的 **Rank（榜单）** 页（要先登录、能看到榜单）
2. F12 → Console → 把 `fetch-nk-rank.js` 整段粘进去 → 回车
3. 会自动下载 `nk_cid<ID>_rank.json`
4. 把它放到本目录（`01 nk/`）—— 丢哪都行

脚本会先试一个大 `pageSize` 一次装下全部，不行再按 `page` 逐页抓（每页校验
"首行名次是否正好接上一页"，带重试）。

**当前用的接口**（脚本里已内置）：

```
GET /acm-heavy/acm/contest/real-time-rank-data
    ?token=&id=<比赛ID>&limit=<条数>&pageSize=<每页>&page=<页码>&_=<时间戳>
```

### ⚠️ 这个接口有三个坑（都实测过）

| 现象 | 真相 |
|---|---|
| `limit=2000` 仍只回 50 条 | `limit` 是**上限**，默认 50，超了就被钳回去 |
| `limit=3` 时 `rankCount` 变成 3 | 带正数 `limit` 时 `rankCount` **不是总数**，是返回行数 |
| `limit=3&page=2` 返回**空数组**，但 `pageCurrent` 回显 2 | 不是"page 无效"，而是结果集先被 `limit` 截成 3 条、第 2 页落在 3 条之外 |

结论：

- **总数只能从 `limit=0` 且不传 `pageSize` 的那一次拿到**（实测 1644 队 / 33 页）。
- 分页参数是 **`page`（1 基）+ `pageSize`**，两者都被服务端接受：
  实测 `limit=0&pageSize=2&page=2` → 返回**第 3、4 名**，`pageCount: 822 = ⌈1644/2⌉`。
- **判据一定要用行里的 `ranking`，不要用响应里的 `pageCurrent`** —— 回显会骗人。

响应结构（这份 JSON 就是 `lib/nk_rank_stats.py` 的输入）：

```json
{ "msg": "OK", "code": 0, "data": {
    "basicInfo":   { "contestId": 133877, "rankCount": 1644, "pageSize": 50,
                     "pageCount": 33, "pageCurrent": 1,
                     "contestBeginTime": 1784692800000, "contestEndTime": 1784710800000 },
    "problemData": [ { "name": "A", "problemId": 319252,
                       "acceptedCount": 36, "submitCount": 91 } ],
    "rankData":    [ { "ranking": 1, "userName": "…", "acceptedCount": 14,
                       "scoreList": [ { "problemId": 319252, "accepted": true,
                                        "acceptedTime": 1784703038000, "failedCount": 0 } ] } ]
} }
```

### 2.4 源文件会被自动删掉

**源文件只是中间物**：解析成 JSON 之后就没用了。而榜单 JSON 一份 **9.4MB**。
所以流水线在**解析成功后自动删除源**：

```
📥 自动解析源文件（2 个）：
   nk_cid133885_problems_source.html  →  nk_cid133885_problems.json
   🗑  已删除 …_problems_source.html（37 KB）—— 已解析成 nk_cid133885_problems.json
   🗑  已删除 …_submits_source.html（44 KB）—— 产出已是最新
```

**开关只有两档，默认全删：**

| 命令 | 行为 |
|---|---|
| `npm run crate:nk:browser` | **全删**（默认） |
| `npm run crate:nk:keep` | **全不删**（保留所有源文件） |
| `python "…/nk_pipeline.py" --all --keep-source` | 同上，等价写法 |

安全阀（**不会静默丢东西**）：

- 只在**产出确实有数据**时才删；解析失败、产出为空 → **保留**并提示；
- 每次都打印"删了什么、多大、为什么"。

⚠️ 删了就**只能重新抓**（榜单要一整轮分页请求，题目/提交页要重新打开）。
所以如果你正打算改解析器、需要反复调，用 `crate:nk:keep`。

> **统计 JSON 必须留下来**：榜单 JSON 删掉之后，`nk_cid<CID>_rank_stats.json`
> 就是 ratio 的唯一来源，流水线会直接用它（打印"榜单：已删除；用现成的 …"）。
> 这一条是"删源"能成立的前提 —— 少了它，删榜单就等于把 ratio 一起丢了。

---

## 3. 通过率的口径（重要）

应用里 `ratio` = **通过队伍数 ÷ 有效队伍数 × 100**（保留 2 位小数）。
**和 HDU 完全同一口径**，这样两个平台的难度才可比。

- **通过队伍数** = 榜单接口 `problemData[].acceptedCount`（直接就是我们要的）
- **有效队伍数** = 赛时至少解出 1 题的队伍数 = 榜单里 `acceptedCount > 0` 的队数

### 两个陷阱

1. **题目页那个「通过率」不要用。** 它长这样：

   ```
   A   Annoying Traffic   36/54
                         ↑  分子是"通过队伍数"（与榜单一致）
                            分母 54 的口径说不清（不是队伍数，榜单里是 91 次提交）
   ```

   所以适配器默认**不用**它（要强行启用就把 `nk_adapter.py` 顶部的
   `EXPORT_PAGE_RATIO` 改成 `True`，风险自负）。

2. **榜单必须完整。** 只有几页时分母偏小 → **ratio 会整体偏大**，
   这比没有 ratio 更糟。所以 `lib/nk_rank_stats.py` 在检测到
   `pagesCollected < pagesExpected` 时**拒绝产出 ratio**，适配器也会打印
   一条明确提示，而不是静默给你一个偏大的数。

   已核对：133877 的榜单是 `rankCount=1644 / pageSize=50 / pageCount=33`，
   有效队伍 **1612**，14 道题全部带上 ratio。

---

## 4. 节点树长什么样 / extKey 约定

```
O  真实根节点（应用自带，导入包不写它）
└─ W  牛客                              extKey: nk
   └─ S  牛客暑期多校                    extKey: nk:series:summer
      └─ S  2026                        extKey: nk:series:summer:2026
         └─ C  2026牛客暑期多校训练营2    extKey: nk:c:133877
            ├─ P  Annoying Traffic  A   extKey: nk:c:133877:p:A
            └─ R  （提交记录）           extKey: nk:c:133877:sub:84353200
```

树形与 HDU 保持一致：**W → S → S(年份) → C → P → R**（应用不允许 W 下直接放 C）。

- **提交的 extKey 带 cid**（`nk:c:<cid>:sub:<rid>`）：牛客的「运行ID」换场会重号，
  必须带上 cid 才能在多场包里保持唯一 —— 与 HDU 的 `hdu:c:<cid>:sub:<rid>` 是同一套。
- 系列由 `nk_adapter.py` 顶部的 `SERIES_RULES` 按比赛名归类
  （牛客暑期多校 / 牛客练习赛·周赛 / 其他），改那几行正则即可。
- 年份层由 `GROUP_BY_YEAR` 控制：年份先从**比赛名**里认（`20xx`），
  认不出再看开始时间，都认不出就直接挂系列下（合法，会提示一句）。
- 题目 extKey 用**字母**（牛客题目列表本来就是字母，不需要换算）。
- `contestTime` 取自榜单接口的 `contestBeginTime`（毫秒时间戳，脚本会转成
  `YYYY.MM.DD HH:MM`）。**没有榜单就没有比赛时间** ——
  133885 的 C 节点时间就是空的，不是 bug。
- **链接**：C 节点带比赛地址、W 节点带比赛列表页
  （`https://ac.nowcoder.com/acm/contest/vip-index`）—— 应用里这两级都会渲染
  `🔗 链接`，点一下就跳过去。
  比赛地址**优先用采集时记下的真实地址**：`collect-nk-problems.js` 会把当前页的
  `location.href` 写进源文件头，爬虫再落到 `nk_cid<CID>_contest.json` 的 `contestUrl`；
  没有记录时才退回模板 `https://ac.nowcoder.com/acm/contest/<cid>`
  （模板在 `nk_adapter.py` 顶部的 `CONTEST_URL` / `PLATFORM_URL`）。
  节点缺链接时 —— **重导一次就会补上**（`link` 是 `fill-if-empty`：
  空才填，你手填过的绝不动）。
- **链接按类别写进元列 `链接分类`**。本平台的 C 带两类：
  * `problems` —— 比赛页（题目列表）：`https://ac.nowcoder.com/acm/contest/<cid>`
  * `board` —— 排行榜页：`https://ac.nowcoder.com/acm/contest/<cid>#rank`（⚠️ 是 **`#rank` 锚点**；`/rank` 这个路由牛客**没有**，实测回 404 壳），
    树上渲染成 **🏆 榜单**。
  ⚠️ 排行榜**只在这场真有榜单统计（`nk_cid<cid>_rank_stats.json`）时才写** ——
  没抓过榜单的场次给一个空榜页就是假信息，宁可空着。
  应用层会把 `problems` 那条派生进 `link`。
- **提交 extKey**：`nk:c:<cid>:sub:<运行ID>` —— **带 `cid`**（牛客的运行 ID 换场会重号，
  不带 cid 会在多场包里撞号）。适配器另有**重复守卫**（与 hdu 同一套）：同一包里撞号就
  **跳过该条并明确告警**，不会让 `crate.py` 抛"extKey 重复"崩溃。
- extKey 一旦导入就**不能改**（改了 = 新身份 = 下次导入变成重复节点）。

---

## 5. 本目录文件清单

| 文件 | 干什么 |
|---|---|
| `nk_pipeline.py` | **入口**：发现输入 → 自动解析源 → 依次调下面几个 → 合成一个导入包 |
| `nk_adapter.py` | `nk_cid*.json` → crate（导入包）。**顶部配置块是唯一需要改的地方** |
| `collect-nk-problems.js` | 浏览器控制台脚本：从**已渲染的题目页**抠出比赛名 + 题目表（SPA，只能就地取） |
| `collect-nk-submit.js` | 浏览器控制台脚本：读已渲染的提交页 + 自动点「下一页」，逐页收集 |
| `fetch-nk-rank.js` | 浏览器控制台脚本：把分页榜单全量抓成一个 JSON（**走接口**） |
| `Nowcoder_prob_scraper.py` | 题目页 HTML → `nk_cid<CID>_problems.json` **+** `_contest.json` |
| `Nowcoder_submit_scraper.py` | Status 页 HTML → `nk_cid<CID>_submits.json`（按运行ID去重） |
| `nk_cid*_*_source.html` | 抓下来的原始证据（**解析成功后会自动删除**，见 2.4） |
| `nk_cid*_submit.html` | 提交页原件（多页包；**解析成功后会自动删除**） |
| `nk_cid*_rank.json` | 完整榜单原始证据（9.4MB 一份；**算出统计后自动删除**） |
| `nk_cid*_rank_stats.json` | 榜单算出来的赛时统计（**ratio 的来源**，别手工改） |
| `2026/2026nk<N>/` | 按场次分的中间产物（题目/提交/统计）—— 目录名不参与识别，纯为好看 |
| **`lib/nk_common.py`** | **公共工具**：链接解析 / 比赛名提取 / 文件名识别 / 读写 JSON —— **全项目只有这一份** |
| **`lib/`** | 其余内部脚本，你不需要直接跑（流水线自己调）： |
| └ `lib/nk_rank_stats.py` | 榜单 JSON → `nk_cid<CID>_rank_stats.json`（**写在榜单旁边**），**ratio 的来源** |
| `.vscode/` | 与本流程无关（解题的 C++ 构建任务），可忽略 |

### 5.1 一次性手工工具（**不是生产链路**）

下面两个脚本是**当年手跑的一次性工具**（实测：全仓代码里**零引用**，流水线也不调），留着只为
"凑不上自动化时能单独特判一份文件"。**别拿它们当入口**：

| 脚本 | 干什么 | 现在该用什么 |
|---|---|---|
| `Nowcoder_prob_scraper.py` | 题目页 HTML → `nk_cid<CID>_problems.json` + `_contest.json` | `npm run crate:nk:browser`（`nk_pipeline.py` 自己会解析 `*_source.html`） |
| `Nowcoder_submit_scraper.py` | Status 页 HTML → `hdu`-同形的提交 JSON | 同上；**自动路**（`npm run crate:nk`）用 JSON 接口，压根不需要它 |
| `backfill_nk_contest_times.py` | 补比赛时间 | 自动路的 `contest.json` 里就带时间 |

（`collect-*.js` / `fetch-nk-rank.js` **不是**这一类：它们是浏览器手存路的手，见 `§2`。）

当前数据状态（2026 暑期多校 **10 场全部搬完**，`2026/2026nk1…nk10/`）：

| 目录 | 比赛 | 题目 | 提交 | 榜单 | 有效队伍 |
|---|---|---|---|---|---|
| `2026nk1/` | 133876 训练营1 | 12 | 暂无 | ✅ 34/34 页 | 1586 |
| `2026nk2/` | 133877 训练营2 | 14 | ✅ | ✅ 33/33 页 | 1612 |
| `2026nk3/` | 133878 训练营3 | 13 | ✅ | ✅ 33/33 页 | 1576 |
| `2026nk4/` | 133879 训练营4 | 12 | ✅ | ✅ 30/30 页 | 1311 |
| `2026nk5/` | 133880 训练营5 | 14 | ✅ | ✅ 32/32 页 | 1530 |
| `2026nk6/` | 133881 训练营6 | 12 | ✅ | ✅ 32/32 页 | 1495 |
| `2026nk7/` | 133882 训练营7 | 13 | ✅ | ✅ 30/30 页 | 1426 |
| `2026nk8/` | 133883 训练营8 | 13 | ✅ | ✅ 30/30 页 | 1405 |
| `2026nk9/` | 133884 训练营9 | 12 | ✅ | ✅ 30/30 页 | 1442 |
| `2026nk10/` | 133885 训练营10 | 13 | ✅ | ✅ 27/27 页 | 1203 |

这个脚本（浏览器手爬那条路）出的包是 `acm-data/nodes/nk-browser.json`：**442 个节点**
（W1 / S2 / C10 / P128 / R301），**128 道题全部带 ratio 和链接**、10 场比赛全部带比赛时间和真实链接。

> ⚠️ **正式包 `nk-multi-university.json` 不在这里出**：
> 它由 **`python -B "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" build --from-year 2023`**
> （`npm run crate:nk`）出 —— **40 场 / 2358 节点**，原料在 `05 xcpc/cache/nk/`，走牛客的 JSON 接口。
> 两条路**不能写同一个文件名**：后跑的会把先跑的**静默缩小**（把 2358 条覆盖成 442 条）；
> 所以这一条写 `nk-browser.json`（`npm run crate:nk:browser`）。

> **提交列写"暂无"就只是"现在还没有"，不代表以后没有。** 提交记录随时可以补：
> 在牛客上打开那场的 Status 页，跑一次 `collect-nk-submit.js`，把文件丢进本目录
> 再 `npm run crate:nk:browser` 即可 —— 只会补上这一场的提交，不动别的（`提交 : (无)`
> 同理，那是中性提示，不是让你去补的报错）。
>
> 提交只影响题目的**做题状态**（status1/status2 由 R 推导）；
> ratio / 难度等级来自榜单，没有提交也照常有。

源文件（题目页/提交页/榜单 JSON）**都已经在解析成功后自动删掉了**，
所以现在只剩下 JSON；`01 nk/` 总共不到 0.5 MB（源文件在的时候是几十 MB）。

> 明年（2027 暑期多校）加新场次的流程一模一样：题目页跑 `collect-nk-problems.js`、
> 提交页跑 `collect-nk-submit.js`、榜单页跑 `fetch-nk-rank.js`，
> 三份文件丢进本目录 → `npm run crate:nk:browser` → 拖进应用。
> 新场次会自己长在「牛客暑期多校 → 2027」下面（年份层从比赛名里认）。

---

## 6. 常见问题

**Q：`fetch` 抓牛客页面拿不到内容（只有"加载中…"）**
A：牛客的比赛页是 **SPA 客户端路由**，服务端只返回空壳；
`/acm/contest/status?contestId=…` 直接请求更是 404。
所以题目/提交只能用 `collect-*.js`（就地取已渲染的 DOM），
**只有榜单能走接口**（`fetch-nk-rank.js`，那是独立的 JSON API）。

**Q：流水线显示某场 `提交 : (无)`**
A：那只是"这一场目前没有提交数据"（有些比赛确实一直没有，也可能过一阵才放开）。
不影响别的：ratio / 难度来自榜单，照常有，少的只是做题状态。
**想补随时可以补** —— Status 页跑一次 `collect-nk-submit.js`，
文件丢进本目录再 `npm run crate:nk:browser`，只会更新这一场。

**Q：报"没找到任何输入"**
A：检查文件名是不是 `nk_cid<CID>_problems.json`（规范只有这一条）。
流水线会把"像输入但名字不对"的 json/html 列出来。

**Q：`ratio` 全是空的**
A：两种可能：① 这场没有榜单文件；② 榜单不完整（脚本会明说页数）。
完整榜单请用 `fetch-nk-rank.js` 重抓。

**Q：比赛节点叫"比赛 133877"**
A：缺 `nk_cid<CID>_contest.json`。它由题目爬虫顺带生成，和题目 JSON 放在
同一目录即可 —— **没它就认不出系列**，会和"带名字那次导入"长出两棵树。

**Q：`crate.py` 报 `extKey 重复（包内必须唯一）`**
A：两份提交记录撞了同一个运行ID —— 多半是手工拼多页 HTML 造成的。
用 `collect-nk-submit.js` 重抓（它按运行ID去重），解析端也会再去一次重。

**Q：「账户对比」里看不到我 / 提示"归认 0 条"**
A：两条都要满足：① `me.json` 里写了 `nk.handle`（写了才会给用户名相符的提交打线索，
见 §2.2.2）；② 应用**账户管理**里配了一条**一模一样**的映射 `nk : 用户名 = <你的用户名>`。
配完点「🔁 用当前映射重跑归认」——已导入的值也会被认领，不用重导入。
如果显示"冲突、谁都不认领"，说明两个账户声明了同一个三元组
（比如队友也用了同一个用户名）——那就把 `source` 改细一点（如按场次 `nk:<cid>`）。

**Q：为什么我的提交带了线索、别人的没带？**
A：这是**故意的**：适配器只给"用户名 == `me.json` 的 `nk.handle`"的那几条打线索。
别人的提交照常导入（当客观值），但不会被算到你头上。

**Q：`fetch-nk-rank.js` 说"接口请求失败 / 结构不对"**
A：牛客改了接口。在 Network 面板找到那个返回榜单 JSON 的请求 → 右键 →
Copy → Copy URL → 发我，我把它换进脚本；或者你自己把脚本里的 `PATH`
改成新路径（`limit` 的语义要先按 2.3 那张表确认）。

**Q：改了代码，页面上却"没变化"**
A：先确认浏览器跑的是不是新代码 —— 控制台敲 `__ACM_BUILD__`。
它不是最新那个值，就说明是**缓存**，不是代码没改对（清缓存顺序：关掉该
origin 的所有标签页 → 硬刷新 → 换端口）。

---

## 7. 别人要接一个新平台，照抄什么

1. 本目录 `nk_adapter.py` 顶部**配置块**（平台名、extKey 模板、系列规则、字段开关）
2. `02 hdu/hdu_adapter.py` —— 同一套模式的另一个例子（HTML 榜单 + 字母题号换算）
3. `scripts/crate.py` —— crate 格式与构造器（平台无关，可直接复用）
4. `docs/auto-import.md` —— 导入/查重/合并的完整设计
5. `docs/scraper-guide.md` —— 接入新平台的清单
