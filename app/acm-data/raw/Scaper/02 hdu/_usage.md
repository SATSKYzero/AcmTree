# HDU → Acm_Tree 使用说明

这个目录里的东西只做一件事：
**把杭电（HDU）的比赛数据变成一份可以拖进应用的导入包（crate）。**

```
浏览器里存页面  →  npm run crate:hdu  →  拖进应用
（save-hdu-page.js）   （解析 + 合成都在里面）   (📥 节点自动导入)
```

---

## ★ 首选：全自动（不用逐场手存）

用户 2026-10-17："nk/hdu 多校的爬取能否不每场比赛手动" ⇒ HDU 这条已经有了：

```powershell
# ⓪ 一次就好：在 acm-data/raw/Scaper/me.json 的 hdu 段写**按年**一套账密
#    "hdu": { "years": { "2026": { "contestUser": "teamA", "contestPassword": "…" },
#                        "2025": { … } } }
#    ⚠️ contestUser 是**比赛登录页那个用户名**，不是提交页上的 `TEAM0/teamA`
#      （2026-10-17 实测：写成 `TEAM0/teamA` 会被 HDU 回 "Invalid username or password"）。
#      顶层那对 `contestUser/contestPassword` 是兜底（老写法）；临时跑一次也可用环境变量
#      HDU_CONTEST_USER / HDU_CONTEST_PASSWORD。界面上也有两格：「设置 → 🔐 登录态 → 杭电（赛内页）」。
# ① 抓原料：**默认每年那 10 场多校**（往年从 HDU 的比赛归档页枚举，不看本地那份当季清单）
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" fetch            # 全部年份（有账密的才抓得动）
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" fetch --year 2026
# ② 出包（会把要抓的往年的元信息补进 hdu_contests.json，再交给下面的流水线）
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" build
```

**"每年那 10 场"是怎么认出来的**：赛名里的 `暑期联赛` / `超级联赛` / `Multi-University`（名字随年份变过：
2026/2025 暑期联赛、2024/2023 超级联赛、2022 杭电杯、2021 MINIEYE 杯、2020/2019 Multi-University）。
cid 从 `https://acm.hdu.edu.cn/contests/contest_list.php?page=N`（**GBK 编码**）翻出来，缓存在
`02 hdu/cache/hdu_contests_all.json`（`--refresh-archive` 才重翻）。
⚠️ 本地 `hdu_contests.json` 只有**当季**那 20 场（与 `/contests` 一字不差），往年根本不在里面 ——
所以"往年场次"只能靠归档页枚举，别指望那份清单。

★ **归档枚举是"要么整份、要么没有"**（2026-10-17 踩到）：它曾经"某个页拿不到就跳过"，
于是**半份清单与整份长得一模一样** —— 缓存被写成一截，而"每年 10 场"少了几年
**在清单上完全看不出来**（排得整整齐齐）。现在：

- **任一页重试 3 次仍拿不到 ⇒ 当场退出（退出码 1）、缓存一个字节不动**；
- **到末尾**靠"连续两页没有新 cid"认定（HDU 翻过头不报错、会把最后一页重复给你，
  空页和重复页都算"没有新 cid"）⇒ **不需要预先知道总共几页**；
- ⚠️ 别用"这次比上次少就别写"当判据：那要被"今年真少了 4 场"推翻（同一个形状的两个答案，
  说法不唯一 ⇒ 不是判据）。判据只看**抓取事件**，不看行数。
- 判据（能红的那条）：`hdu_multi_fetch.py --selftest` 的第 ④ 组 —— 假 urlopen 让它"半路断"，
  必须抛"整次枚举作废"**且**缓存字节不变；另一条验"翻过头靠重复页停下、场次一场不少"。
- 核法：`python -B -c "import hdu_multi_fetch as m; print(len(m.enumerate_archive()))"`（在那个目录里跑）
  —— 这个数应该等于**归档页翻到底的场次数**（千级）；明显偏小就说明页没翻完。

**对拍过**（2026-10-17，2026 暑期 10 场）：用自动抓的原料重出包，与手存那批出的包 **653 条逐条相同**
（extKey 交集 653 ｜ 只在新的 0 ｜ 只在旧的 0 ｜ 同 key 内容不同 0）。

★ **"这一场是用哪个账号抓的"由 `me.json` 提供，不许落成仓库里的文件**（2026-10-19 用户：
"TEAM0/teamA 等所有个人信息理应由 me.json 提供，且不留痕迹"）：
各年的比赛口令不同（2021 teamB / 2023 teamC / 2024 teamD / 2025 teamE / 2026 teamA），
而 HDU 的提交表里**没有提交者列** ⇒ 账户线索只能来自"这份原料是谁抓的"。抓取时记、
出包时 `hdu_adapter` 按 cid 读。⚠️ 2026-10-17 用户看着导入预览说"不可能全是 teamA，而且不可能全是 TEAM0"——
那就是因为出包侧当时只有一个全局 `--handle`，把 50 场全盖成同一个值。现在优先顺序：
`--file-handle`（人显式绑定）> `me.json` 的 `hdu.years.<年份>.contestUser`（**按 cid 查出年份**）> `--handle`（兜底）；
⚠️ **不替它编队名**：`me.json` 里声明过 `队名/账号` 这种同账号的 handle 就用声明的那一个，没声明就原样写账号。
核法：出包日志里"账户线索（按抓取账号）"一节逐文件列出 `文件（N 条）→ 账号`；
判据 `hdu_multi_fetch.py --selftest` 第 ⑥ 组（两场不同账号 ⇒ 必须出两个 clue）。

★ **"哪一场算多校"的词表只有一份**：`lib/hdu_common.py` 的 `MULTI_WORDS`
（`暑期联赛`/`超级联赛`/`Multi-University`/`多校`）—— 抓取侧（默认抓哪几场）与出包侧
（挂「杭电多校」还是「其他比赛」，`hdu_adapter.SERIES_RULES` 用 `multi_re()` 生成）**读同一份**。
⚠️ 2026-10-17 踩到：出包侧自己另写了一版只认 `钉耙编程|暑期联赛|多校` ⇒ 2021「MINIEYE杯…超级联赛」
跑进「其他比赛」、2022「杭电杯…超级联赛」还会先撞"杭电"那条跑进「杭电校赛」。

`list` 看有哪些场、每场已经有什么；`--cid 1229,1238` 只抓几场；`--skip-rank` 不抓榜单。

**为什么能自动**：HDU 赛内页是服务端渲染的普通 HTML（`fetch-hdu-rank.js` 的注释里写着同一件事）
⇒ 过了那道门，Python 拉到的与浏览器里是同一份。三道门/四个 URL：

| 打哪 | 得到 |
|---|---|
| `POST /contest/login?cid=<CID>`（表单 `username` + `password`） | 该场的比赛会话 |
| `GET /contest/problems?cid=<CID>` | → `hdu_cid<CID>_problems_source.html` |
| `GET /contest/status?cid=<CID>&status=&page=<1..>` | → `hdu_cid<CID>_submit.html`（**1 基**分页） |
| `GET /contest/rank?cid=<CID>&page=<0..>` | → `hdu_cid<CID>_rank.html`（**0 基**分页） |

⚠️ **没登录/没输口令时这三个 URL 也是 HTTP 200，正文却是 `<title>Contest Login</title>`**
（实测都是 11247 字节的同一页）⇒ **判据只能看正文**。脚本一遇到它就**当场停**（退出码 2）：
口令不对时继续跑下一场只会白刷登录失败。
⚠️ 每页都走 `Scaper/lib/read_modes.py` 的 `Archive.page(...)` ⇒ `--force` / `--offline` /
`--cache-mode` / 重试 / 记账全部与别的渠道一致；**登录页不入库**（好页才入库）。
页级归档就是这个 bundle 文件本身（`<!-- PAGE n -->` 是页号）。
⚠️ **两个"会把数字数错"的坑**（2026-10-17 都实测踩到，`--selftest` 里钉住了）：
① **行的身份 = `tr.page-card-row` 第一格的文字**（与 `fetch-hdu-submit.js:extract()` 同口径）——
别拿"链接里的 uid/pid"当身份：Status 表的行里没有那种链接 ⇒ 每页都算"没有标识" ⇒ 翻两页就误判到末尾；
② HDU **翻过头不报错、照样渲染最后一页**，相邻页还会重复 ⇒ 只存**带来新行**的页，
否则同一支队/同一条提交会被**数两遍**（榜单的过队数直接算错）。
顺带：页数上限 `MAX_PAGE = 200`（60 会截断 —— 实测一场 1102 支队要 22 页、列表更长时更多；收尾靠"连续两页没新行"）；
`--force` 会**先清掉旧 bundle** 再抓（不清的话新页会被旧内容判成重复 ⇒ 文件被覆盖成只剩一两页）。

下面那套"浏览器手存"**仍然可用**（口令我这边过期时就是它兜底）：

---

## 0. 最快路径

```powershell
# ⓪ 一次就好：在 acm-data/raw/Scaper/me.json 里写一行你自己的 HDU 用户名
#    "hdu": { "handle": "TEAM0/teamA" }
#    作用：R 会带上"这条提交是谁的"（账户线索）。不写也照常出包，只是认不出人。
#    为什么用"队名/个人账号"这种组合值：见 §2.2.2。

# ① 浏览器里：打开比赛的 Problems / Status 页，F12 控制台粘 save-hdu-page.js
#    → 自动下载一个名字已经规范的文件（不用剪贴板、不用改名）
# ② 把它丢进本目录（哪个子目录、多深都行）
# ③ 项目根目录执行：
npm run crate:hdu
```

**就这两步。** 剩下的都在 `crate:hdu` 里自动完成：

> ★ **`crate:hdu` 到底是哪条命令**（2026-10-17 统一，与 `crate:nk` 同形）：
> `crate:hdu` = `hdu_multi_fetch.py build`（**本地原料 → 包，不联网**；顺带把归档缓存里的往年元信息
> 补进 `hdu_contests.json`）｜ `crate:hdu:fetch` = 真去 HDU 抓页面（要按年的比赛口令）｜
> `crate:hdu:browser` = 只跑解析（= `hdu_pipeline.py --all`，就是下面 1–4 那四件事，不碰元信息）。
> 浏览器手存那条路照旧能用：三个入口最终都会走到同一份 `hdu_pipeline.py`。

1. **把源 HTML 解析成 JSON**（`*_source.html` → `hdu_cid<CID>_*.json`，
   写在源 HTML 旁边；产出比源新就跳过，重复跑不白干活）；
2. 扫描本目录（递归），按 cid 认出每场有什么；
3. 对每场有完整榜单的，算出 `hdu_cid<CID>_rank_stats.json`（赛时统计，ratio 的来源）；
4. 合成**一个**导入包 `acm-data/nodes/hdu-multi-university.json`（含每条提交的
   **语言 / 耗时 / 内存** 与**账户线索**，见 §2.2.1–2.2.2）。

生成后先离线自查（这一步不写任何东西，只试算）：

```powershell
npm run crate:check -- acm-data/nodes/hdu-multi-university.json
```

没有报错，就把它拖进应用的「📥 节点自动导入」——
**导入前先删掉应用里那棵 HDU 子树**（导入是加法，更新过包会重复）。
导入后到**账户管理**配一条映射 `hdu : handle = TEAM0/teamA`，再点一次「🔁 用当前映射重跑归认」，
「👥 账户对比」里就能看到自己。

只想处理某一场 / 先看它要干什么：

```powershell
python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" 1231
python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all --dry-run
```

> ⚠️ 一定要用 PowerShell 一行写完。PowerShell **不支持** bash 的 `\` 续行。
> 路径带空格（`02 hdu`）时必须加引号 —— 本目录名字里就有空格。

---

## 1. 它认哪些输入文件（**只有一条命名规则**）

```
hdu_cid<CID>_<种类>.json / .html          种类 = problems | submits | rank | submit
hdu_contests.json                         ← 比赛列表（一份列表，本身没有 cid）
```

就这一条。**文件放在哪都行** —— 递归扫描到任意深度，目录名不参与识别，
因为身份写在名字里：

| 文件 | 是什么 |
|---|---|
| `hdu_cid1231_problems.json` | 某场题目 |
| `hdu_cid1231_submits.json` | 某场提交 |
| `hdu_cid1231_rank.html` | 某场完整榜单（`fetch-hdu-rank.js` 的产出） |
| `hdu_cid1231_submit.html` | 某场提交页原件（`fetch-hdu-submit.js` 的产出） |
| `hdu_contests.json` | 比赛列表 |
| `hdu_cid1231_problems_source.html` | 源 HTML：它产出 `hdu_cid1231_problems.json` |
| `hdu_cid1231_submits_source.html` | 源 HTML：它产出 `hdu_cid1231_submits.json` |

抓取/解析脚本都**直接产出规范名**，不用手工改：

```powershell
python "…/Hdu_prob_scraper.py"   -i "…/hdu_cid1231_problems_source.html"
python "…/Hdu_submit_scraper.py" -i "…/hdu_cid1230_submit.html"
# 不给 -o 时，输出就是输入旁边的 hdu_cid<CID>_problems.json / _submits.json
```

### 文件都写到哪（一张表说清）

| 你做什么 | 产出 | 落在哪 |
|---|---|---|
| 存页面（`save-hdu-page.js`，或控制台复制整页） | `hdu_cid<CID>_*_source.html` | **浏览器的下载目录** —— 你自己挪进 `02 hdu/` |
| `Hdu_prob_scraper.py -i <源.html>` | `hdu_cid<CID>_problems.json` | **输入 HTML 的同一个目录** |
| `Hdu_submit_scraper.py -i <源.html>` | `hdu_cid<CID>_submits.json` | 同上 |
| `Hdu_contest_list_scraper.py -i <源.html>` | `hdu_contests.json` | 同上 |
| （上面三个加 `-o 路径`） | 你指定的路径 | 想放哪就放哪 |
| `fetch-hdu-rank.js` | `hdu_cid<CID>_rank.html` | 浏览器下载目录 |
| `fetch-hdu-submit.js` | `hdu_cid<CID>_submit.html` | 浏览器下载目录 |
| `npm run crate:hdu`（先把 `*_source.html` 解析掉） | `hdu_cid<CID>_problems.json` 等 | **源 HTML 的同一个目录** |
| `npm run crate:hdu`（有榜单的场次） | `hdu_cid<CID>_rank_stats.json` | **榜单 HTML 的同一个目录** |
| `npm run crate:hdu` | `acm-data/nodes/hdu-multi-university.json` | 仓库的 `acm-data/nodes/` |

> 一句话：**凡是"由某个 HTML 派生出来的 JSON"，都写在那个 HTML 旁边；
> 名字也走同一条规范。** 每个脚本跑完都会把完整路径打印出来 —— 不用猜。
>
> 所以一场比赛的东西（源 HTML + 题目/提交 JSON + 榜单 + 榜单统计）**全在一个目录里**，
> 连目录一起搬走/删掉都不会漏。只有最终交付物 `acm-data/nodes/hdu-multi-university.json`
> 在仓库的固定位置（那是给 `crate:check` 和导入用的）。
>
> 常规流程：源 HTML 扔进 `02 hdu/` → `npm run crate:hdu`
> （源被自动解析、榜单统计写在榜单旁、导入包落在 `acm-data/nodes/`）。
>
> **不用记路径、不用敲 `-i`** —— 源 HTML 的名字是 `save-hdu-page.js` 按规范起好的，
> 流水线照着名字就能把活干完。下面那几个爬虫命令是"想单独重跑某一步"时才用。

### ⚠️ 剪贴板报 `NotAllowedError: Document is not focused`

`navigator.clipboard.writeText(...)` **要求页面获得焦点**，而你在 DevTools
控制台里操作时焦点通常在 DevTools 上，所以它拒绝 —— 不是你写错了。
三种解法，从好到糙：

1. **别用剪贴板**（推荐）：用 `save-hdu-page.js`。HDU 的题目/提交/比赛列表页都是
   **服务端渲染**的，所以它在页面里 `fetch(location.href)` 就能拿到同一份 HTML，
   并**按规范名**直接下载（页面 → 文件名 的对应关系它自己判断）。
2. `copy(document.documentElement.outerHTML)` —— 这是 **DevTools 自带的** `copy()`，
   不经过页面焦点那条限制。
3. 延迟一下再手动点回页面：`setTimeout(() => navigator.clipboard.writeText(document.documentElement.outerHTML), 3000)`，
   回车后**马上点一下页面空白处**。

### 容错与取舍

- **浏览器重复下载的后缀会被剥掉**：`xxx (1).html`、`xxx（2）.html`、
  `xxx - 副本.html`、`xxx copy.html`，叠起来也认（`xxx（2） (1).html`）。
- **同一场有多份同类文件**时按序选一个，并在输出里明确告诉你用了哪份：
  1. **有内容的**优先（残留的空 JSON 不会把真数据顶掉）；
  2. **名字干净的**优先（没有 `(1)` 后缀）；
  3. 还平手取**更新**的。
- 名字不符合规范的文件只在"**看起来本来该给流水线用**"时才提示
  （`.json` 且名字含 problems/submits/rank/contest，或带我们抓取脚本的 bundle 标记）。
  **你自己存的页面 HTML 叫什么名字都不会被念** —— 它用 `-i` 传给爬虫。

### 其他

- **场次的身份是 cid，不是目录名。** `26hdu1` 还是 `abc` 都行；一层套一层也行。
- 榜单可以没有。少了它这一场就没有 `ratio`（**不是错误**，只是少一列）。
- `hdu_contests.json` 里通常有十几场比赛，只有真有题目的才会被建出来
  （`--only-used-contests`；流水线默认开）。
- 提交包（HTML 原件）**必须先用 `Hdu_submit_scraper.py` 解析**才会被使用 ——
  流水线发现未解析的包时会把该跑的命令直接打给你。

---

## 2. 数据是怎么抓的（这一步手动）

三个浏览器脚本的分工（都是**只读**，粘到控制台就行）：

| 脚本 | 用在哪一页 | 产出 | 会翻页吗 |
|---|---|---|---|
| `save-hdu-page.js` | 题目 / 提交 / **比赛列表** / 榜单 | 你打开的**那一页**存成规范名的源 HTML | ❌ 只存当前页 |
| `fetch-hdu-submit.js` | 比赛 Status 页 | `hdu_cid<CID>_submit.html`（多页用 `<!-- PAGE n -->` 拼接） | ✅ 自动翻完 |
| `fetch-hdu-rank.js` | 比赛 Rank 页 | `hdu_cid<CID>_rank.html`（40 页一份） | ✅ 自动翻完 |

**怎么选**：

- 题目页、比赛列表页 → 只有一页，用 `save-hdu-page.js`；
- 提交页 → 分页，用 `fetch-hdu-submit.js`（`save-hdu-page.js` 只会存你看到的那一页）；
- 榜单页 → 分页且每页只 50 队，**必须**用 `fetch-hdu-rank.js`。

> 为什么不是 `navigator.clipboard`：它要求**页面获得焦点**，在 DevTools 里常报
> `NotAllowedError: Document is not focused`。而 HDU 这些页是**服务端渲染**的，
> 所以脚本直接 `fetch(location.href)` 就能拿到同一份 HTML —— 连剪贴板都不用碰。

> **下面每条最后那步"解析"其实可以不敲** —— `npm run crate:hdu` 会自动做
> （它扫出 `*_source.html` 并解析到旁边，解析完还会删掉源）。
> 这里写出来是为了让你知道**哪份产出由谁生成**，也方便单独重跑某一步。

HDU 榜单/题目/提交**需要登录**才看得到，而且：

- **CSV 导出是坏的** —— 字段会串在一起，不能用；
- 榜单页是**服务端渲染**的，HTML 里直接有表格。

所以三份原始数据都是"浏览器里取 HTML，Python 解析"。

### 2.1 比赛列表（一次就够，很少变）

1. 打开 HDU 比赛列表页
2. F12 → Console → 粘 `save-hdu-page.js` → 回车
   （它直接下载 `hdu_contests_source.html`，**不需要剪贴板**）
3. 解析（输出落在源 HTML 旁边）：

```powershell
python "acm-data/raw/Scaper/02 hdu/Hdu_contest_list_scraper.py" -i "acm-data/raw/Scaper/02 hdu/hdu_contests_source.html"
# → hdu_contests.json
```

### 2.2 某场比赛的题目 / 提交

**题目**：打开比赛的 **Problems** 页 → 粘 `save-hdu-page.js` → 得到
`hdu_cid<CID>_problems_source.html`，然后：

```powershell
python "acm-data/raw/Scaper/02 hdu/Hdu_prob_scraper.py" -i "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_problems_source.html"
# → 同目录的 hdu_cid1231_problems.json
```

**提交**：Status 页**分页**，一页几十条 —— **不要手动翻页拼**（漏页/重页都是这么来的）。
用 `fetch-hdu-submit.js` 一次性抓完：

1. 浏览器里打开该场比赛的 **Status** 页（先登录；需要筛选就先在页面上筛好）
2. F12 → Console → 粘 `fetch-hdu-submit.js` 整段 → 回车
3. 自动翻页 + 按**运行ID 去重**，下载 `hdu_cid<ID>_submit.html`
4. 解析成 JSON：

```powershell
python "acm-data/raw/Scaper/02 hdu/Hdu_submit_scraper.py" -i "acm-data/raw/Scaper/02 hdu/26hdu/26hdu3/hdu_cid1231_submit.html"
# → 同目录的 hdu_cid1231_submits.json
```

脚本只负责"把 N 页搬回本地"，输出的是**原始 HTML**（多页用 `<!-- PAGE n -->` 分隔）；
解析永远是 `Hdu_submit_scraper.py` 的事 ——页面结构变了 HTML 还在，随时能重解析。

> **为什么抓取脚本不直接输出 JSON**：解析规则一旦写错就丢信息；
> 而 HTML 是原始证据，可以反复重解析。榜单那套也是同一个道理。

> 提交记录只包含**你自己账号看得到的那部分**，天生不全。
> 应用里题目的通过状态由 R（提交记录）推导，所以"少了提交"= "少了状态"，
> 不会算错别的。

> ⚠️ HDU 的 Status 页**不显示总数**，也没有服务端渲染的分页器，
> 所以脚本靠"空表/连续两页无新增"判断结束。分页是 **1 基**，
> 且"不带 `page`"就等于 `page=1`（三份实测 URL 见脚本顶部注释）。
> 如果它提示"没能确认分页基准"，手动点一次"下一页"把 URL 发我即可。

### 2.2.1 提交里能带出来的信息

`Hdu_submit_scraper.py` 解析出来的字段，**其中三个**会写进 R 节点：

| JSON 字段 | 包字段 | 口径 / 说明 |
|---|---|---|
| `使用语言` | `language` | 原样（`G++` / `C++` / `Java`…） |
| `运行时间(ms)` | `timeUsed` | **毫秒**（与 CF/QOJ 同一口径） |
| `使用内存(KB)` | `memoryUsed` | HDU 给的是 **KB**，适配器 **×1024** 转成字节（应用侧口径） |
| — | ~~`codeLength`~~ | **没有**（**已核实**：10 场源文件的列名里都没有"代码长度"，只有 运行ID/提交链接/题号/题目链接/运行结果/…/运行时间(ms)/使用内存(KB)/使用语言/提交时间）。"点进提交详情才有"是推测、未验证，且要逐条请求，不值得 |
| 提交时间 + 比赛起止 | `submitKind` | **提交性质**：落在比赛时段内 → `赛时`，否则 `补题`；判不出 → **留空**。⚠️ **不能只按"提交日 == 比赛日"判**（当天补题非常常见；按日期判会把 246 条当天补题误判成赛时）。起止时间来自 `Hdu_contests.json` 的 `start_time`/`end_time` —— 列表页只有 Start，**`Hdu_contest_times.py` 从单场页那行 `const contest = {"start":…,"end":…}` 抓**（免登录，20 场实测：春季联赛 18:30~22:30、暑期 12:00~17:00）。完全拿不到才退回假设 12:00~17:00。10 场实测：赛时 273 / 补题 246 |

出包后对一眼：10 场 519 条 R，**519 条都有这三样**。

### 2.2.2 账户线索（"这条提交是谁的"）

> HDU 的 Status 表格里**没有"提交者"列**（`fetch-hdu-submit.js` 只是把你浏览器里
> 筛好的那页搬回来），榜单也只到"队伍"级 —— 所以**只能由你自己声明**。

**取一份真实存档（`hdu_cid1229_submit.html`）核对，三处都没有身份信息**：

| 可能藏身份的地方 | 实测 |
|---|---|
| bundle 头（`fetch-hdu-submit.js` 写的注释块） | 只有 `cid` / **`base=/contest/status?cid=1229`** / `pages` / `rows` / `fetchedAt` —— **URL 里没有 `user=` 之类的筛选参数**（那份存档是你登录后"只看自己"的视图，筛选发生在浏览器里） |
| 页面表格 | 表头是 `Run ID / Submit Time / Problem ID / Time / Memory / Language / Judge Status` —— **界面压根没有提交者列**（对比：牛客的提交**自带「用户名」**，所以那边能从数据认人） |
| 解析后的 `hdu_cid*_submits.json` | 纯数组，没有文件头、没有账号元数据 |

所以"这条提交是谁的"**只能由你声明**，而声明必须**落到具体文件上**：

```jsonc
"hdu": {
  "handle": "TEAM0/teamA",          // 只有一个账号时：所有提交都归他（最常见）
  // 多人时：**显式绑定**哪个文件是谁抓的（推荐写这里，长期生效）
  "files": {
    "hdu_cid1229_submits.json": "我",
    "hdu_cid1230_submits.json": "队友A"
  }
}
```

命令行等价写法（临时用）：`--file-handle "hdu_cid1229_submits.json=我"`（可重复）。

**规则（刻意做得严格）**：

| 情况 | 行为 |
|---|---|
| **只有一个** handle | 所有提交都归他（不用绑定） |
| **多个** handle + 已绑定 | 按绑定归属，并把实际配对打印出来让你核对 |
| **多个** handle + 某文件没绑定 | 那个文件**一条线索都不打** + 告警列出没绑定的是哪几份 |
| 绑定的文件名匹配不到 / 格式不对 | **告警并忽略该条**，绝不猜 |

⚠️ **归属不按"提交文件顺序"zip**。原因：那个"顺序" =
输入文件顺序 = 走流水线时的 **cid 数字升序**，而 `--handles` 的顺序是**你 `me.json` 账户里的顺序**
——两者毫无关系，数量碰巧相等时会**静默错认**（把队友的提交记到你名下）。
`--handles` 现在只表示"有哪些账号"，**归属一律靠绑定**。

匹配方式宽容：`完整路径` → `子路径后缀` → `文件名`，取**唯一**命中（多份同名会报"匹配不到唯一的提交文件"）。

> **多人最稳的做法**：**每人一个目录各抓一份、各出一个包**。HDU 的提交页登录后
> **只显示自己的**，所以"一个文件 = 一个人"本来就很自然 —— 这样连绑定都不用写。

在 `acm-data/raw/Scaper/me.json` 里加一节（**推荐组合值**）：

```jsonc
"hdu": { "handle": "TEAM0/teamA" }     // 队名/个人账号；整体唯一
```

写完重跑 `npm run crate:hdu`，每条 R 会带：

```json
"账户线索": { "source": "hdu:2026", "field": "handle", "value": "TEAM0/teamA" }
```

- **为什么是组合值**：`teamA` 和 `TEAM0` 各自都会跨届重复（每年都这么叫），
  而应用是按 `(source, field, value)` 三元组**全等**匹配账户的 ——
  两个账户声明同一个三元组会判成冲突、**谁都不认领**。组合值整体唯一。
- **为什么 source 带赛季**：同一个人在**不同届**是不同账户（队友换人），
  `hdu:2026` 正好是"一届一个命名空间"的粒度；要更细就一次只导一场、手工传 `--handle`。
  ⚠️ **赛季必须是四位年**（`hdu:2026`）。写成两位（`hdu:26`）会**一条都认不上** ——
  两边按三元组**全等**匹配。
  ⚠️⚠️ **别手打这串** —— 应用里「未认领的线索」列的就是**逐字**的 `source:field=value`，
  照抄它；写错一个字符映射就绑不上、提交被当成客观值。
- 不声明 handle 也**照常出包**，只是提交都算"客观值"，
  「👥 账户对比」里看不到你（以后随时可补：加 `me.json` → 重跑一条命令）。
- 导入后要在应用里配一条**三元组完全一样**的映射
  （账户管理 → `hdu:2026 : handle = TEAM0/teamA`；⚠️ **带赛季**，漏了就绑不上），
  再点「🔁 用当前映射重跑归认」——已经导进来的值也会被认领。

### 2.2.3 多人（队友 / 多队）

HDU 的数据里**没有"提交者"列**，所以多人只能靠**"这份文件是谁抓的"**来定归属：

1. 在 `me.json` 的**账户**（一人一项）里给每个人填 `hdu`（或写 `hdu.handles` 列表）：

   ```jsonc
   "accounts": [
     { "name": "我",   "nature": "member", "hdu": "TEAM0/teamA" },
     { "name": "队友", "nature": "member", "hdu": "TEAM0/team0021" }
   ]
   ```

2. **每人各抓一份提交**：在浏览器里把 Status 页按那个用户名**筛好**再跑
   `fetch-hdu-submit.js`（脚本会保留你页面上的筛选），得到每人一份
   `hdu_cid<CID>_submits.json`（放同目录时**文件名要能区分**，比如放进不同子目录）。
3. 出包时**每人一条 `--file-handle <文件>=<账号>` 显式绑定**（多人**必须**显式绑定）：

   ```powershell
   python "…/02 hdu/hdu_adapter.py" <contests> <每人一份 submits…> -o acm-data/nodes/hdu-multi-university.json --file-handle "hdu_cid1229_submits.json=TEAM0/teamA" --file-handle "hdu_cid1230_submits.json=TEAM0/team0021"
   ```

   - 给了**一个** handle → 每条提交都归他（适合"这份文件全是我的"）；
   - 给了**多个** → `--handles` 只表示"有哪些账号"，**归属一律靠 `--file-handle` 绑定**；
     没绑定的那份**一条线索都不打**并告警列出是哪几份
     （宁可没有线索，也不能把队友的提交认到你头上）。
   - `hdu_pipeline.py --all` 目前只传一个 handle（自动读账户里第一个人）；
     多人请用上面的 `hdu_adapter.py` 直连命令。

4. 应用里给**每人**配一条映射（`hdu : handle = …`），再点「🔁 用当前映射重跑归认」。


### 2.3 完整榜单（想要赛时通过率就必做）

榜单页分页，**单页只有 50 队**，直接复制那一页等于只拿了一小撮。
用 `fetch-hdu-rank.js` 把所有页搬下来：

1. 浏览器里打开该场比赛的 **Rank** 页（要先登录、能看到榜单）
2. F12 → Console → 把 `fetch-hdu-rank.js` 整段粘进去 → 回车
3. 会自动下载 `hdu_cid<ID>_rank.html`（cid 从当前网址自动读，不用手填）
4. 把它放到本目录（`02 hdu/`）—— 丢哪都行

单页快速验证也行（用 `save-hdu-page.js`，但**单页数据不完整**，脚本会打印警告）；
真要算通过率就用上面那个全量抓取。

### 2.4 源 HTML 会被自动删掉

**HTML 只是中间物**：解析成 JSON 之后就没用了。而榜单 HTML 一份 **7MB**
（10 场就 70MB）。所以流水线在**解析成功后自动删除源 HTML**：

```
📥 自动解析源 HTML（2 个）：
   hdu_cid1231_problems_source.html  →  hdu_cid1231_problems.json
   🗑  已删除 …problems_source.html（19 KB）—— 已解析成 hdu_cid1231_problems.json
🗑  已删除 …hdu_cid1229_rank.html（7.1 MB）—— 已算出赛时统计
```

**开关只有两档，默认全删：**

| 命令 | 行为 |
|---|---|
| `npm run crate:hdu` | **全删**（默认） |
| `npm run crate:hdu:keep` | **全不删**（保留所有源 HTML） |
| `python "…/hdu_pipeline.py" --all --keep-source` | 同上，等价写法 |

安全阀（**不会静默丢东西**）：

- 只在**产出确实有数据**时才删；解析失败、产出为空 → **保留**并提示；
- 每次都打印"删了什么、多大、为什么"。

⚠️ 删了就**只能重新抓**（榜单还要登录，题目/提交页要重新打开）。
所以如果你正打算改解析器、需要反复调，用 `crate:hdu:keep`。

> **统计 JSON 必须留下来**：榜单 HTML 删掉之后，`hdu_cid<CID>_rank_stats.json`
> 就是 ratio 的唯一来源，流水线会直接用它（打印"榜单：已删除；用现成的 …"）。
> 这一条是"删源"能成立的前提 —— 少了它，删 HTML 就等于把 ratio 一起丢了。

---

## 3. 通过率的口径（重要，容易搞错）

应用里 `ratio` = **通过队伍数 ÷ 有效队伍数 × 100**（保留 2 位小数）。

- **有效队伍数** = 赛时至少解出 1 题的队伍数（不是榜上总队伍数）。
- **通过队伍数** = 有 AC 时刻的**不同队伍**数 —— 由 `hdu_rank_stats.py`
  逐格数出来。

### 三个陷阱

1. **榜单表头那个数字不要用。** 表头写着：

   ```
   1001  1169 / 2864
   ```

   它看着像"1169 队通过 / 2864 次提交"，但**和表格里逐格数出来的数据对不上**。
   实测 1229 场：

   | 题号 | 表头 submitted | 逐格累加出的提交次数 |
   |---|---|---|
   | 1001 | 2864 | 1874 |
   | 1004 | 2745 | 1265 |
   | 1008 | 1940 | 594 |

   表头**总是更大**且每题比例不同，说明它数的不是同一件事
   （很可能是"所有运行次数"，含通过之后的提交）。

   结论：`hdu_rank_parser.py` 会打印表头，但标注"勿用作通过率"；
   真正用的 `solvedTeams` 由 `hdu_rank_stats.py` 逐格数出。

2. **题目页上的 `ratio` / `accepted` / `submitted` 是全站历史数据**，
   跟"这场比赛打得怎么样"完全无关。所以适配器默认**不导出**它们
   （开关是 `hdu_adapter.py` 顶部的 `EXPORT_RATIO = False`）。

3. **不要用 class 名判断是否通过。** `rank-status-solved` 有时表示
   "试过但没通过"；判据是**格子里有没有时刻**。解析结果里每条都带显式的
   `passed` 布尔值，请用它。

已核对过的两场（可作回归基准）：

| cid | 有效队伍 | 榜上队伍 | A 题通过 | A 题 ratio |
|---|---|---|---|---|
| 1229 | 791 | 1080 | 787 | 99.49 |
| 1231 | 699 | 1080 | 12 | 1.72 |

（1231 的字母顺序与难度**反相关**：A 最难、J 最易，属正常现象，别当成 bug。）

---

## 4. 节点树长什么样 / extKey 约定

```
O  真实根节点（应用自带，导入包不写它）
└─ W  杭电                              extKey: hdu
   └─ S  杭电多校                        extKey: hdu:series:summer
      └─ S  2026                        extKey: hdu:series:summer:2026
         └─ C  2026“钉耙编程”…联赛（3）   extKey: hdu:c:1231
            ├─ P  runs          题号 A    extKey: hdu:c:1231:p:A
            └─ R  （提交记录）             extKey: hdu:c:1231:sub:7753
```

- **提交的 extKey 必须带 cid**：HDU 的「运行ID」是**每场重新编号**的
  （实测 1238 场是 158~9041、1231 场是 76~7753；10 场里有 5 个 rid 跨场重复）。
  写成 `hdu:sub:<rid>` 会让两场的同号提交撞成同一个 extKey，
  而 crate 要求包内 extKey 唯一 —— 整份包直接报错出不来（见 6 节 FAQ）。

- **W → S → S → C → P → R**：应用不允许 `W` 下直接放 `C`，所以比赛一定要有
  系列 `S`；而 `S` 下既可以放 `C` 也可以再套 `S`，年份层就是这么来的。
- **年份层为什么加**：一个系列年年都有比赛，直接铺满一层 `C` 会越来越长。
  年份层由 `GROUP_BY_YEAR` 控制（默认开）：
  - 年份先从**比赛名**里认（`20xx`），认不出再看开始时间；
  - 都认不出就**直接挂在系列下**（合法，只是少了年份分组），并打印一条提示；
  - 年份节点的 extKey 直接续在系列后面：`hdu:series:summer:2026`，
    一眼能看出从属关系。
- 平台/系列/年份都只是容器，**名字随便改**（不影响查重，查重只看 extKey）。
- **链接**：C 节点带 `https://acm.hdu.edu.cn/contest/problems?cid=<cid>`（题目列表页），
  W 节点带比赛列表页。应用里这两级都会渲染 `🔗 链接`，点一下就跳过去。
  模板在 `hdu_adapter.py` 顶部的 `CONTEST_URL` / `PLATFORM_URL`。
- **链接按类别写进元列 `链接分类`**。本平台的 C 带两类：
  * `problems` —— 比赛页（题目列表）：`https://acm.hdu.edu.cn/contest/problems?cid=<cid>`
  * `board` —— 排行榜页：`https://acm.hdu.edu.cn/contest/rank?cid=<cid>`，
    树上渲染成 **🏆 榜单**。
  ⚠️ 排行榜**只在这场真有榜单统计（`hdu_cid<CID>_rank_stats.json`）时才写** ——
  没抓过榜单的场次给一个空排行榜页就是假信息，宁可空着。
  应用层会把 `problems` 那条派生进 `link`。
  `link` 是 `fill-if-empty`：
  空才填，你手填过的绝不动）。
- 系列由 `hdu_adapter.py` 顶部的 `SERIES_RULES` 按比赛名归类，
  都不命中就用 `SERIES_FALLBACK = ('other', '其他比赛')`。
  想改分类，改那几行正则即可，**不用改代码逻辑**。
- 题目 extKey 用**字母**（`p:A`）而不是数字 1001：
  树上人认的是"这场 A 题"，而 1001 只是"同场连续编号"。
  数字→字母的映射有边界检查：`1001..1020` → `A..T`，越界只警告，不瞎算字符
  （`chr(ord('A') + (pid-1001))` 在 pid=1000 会给出 `@`、1027 给 `[`）。
  上限取 **20**（近十年实测至多 15 题），它**只定义一次** ——
  `02 hdu/lib/hdu_common.py` 的 `LETTER_MAX`；其余脚本一律
  `from hdu_common import letter_of`，**改就改那一个**，否则会出现"爬虫算出了字母、
  适配器却说算不出"这种自相矛盾。
- extKey 一旦发布就**不能改**（改了 = 新身份 = 下次导入变成重复节点）。
  **所以年份层、系列名这类结构调整，要在第一次导入之前定好** —— 现在正是时候。

---

## 5. 本目录文件清单

| 文件 | 干什么 |
|---|---|
| `hdu_pipeline.py` | **入口（手存路）**：发现输入 → 依次调下面几个 → 合成一个导入包 |
| `hdu_multi_fetch.py` | **入口（自动路）**：登录 → 逐页抓 → 原料；`build` = 本地出包（= `crate:hdu`） |
| `..\..\..\..\个人数据\me.json` 的 `hdu.years.<年份>.contestUser` | **哪一场是用哪个账号抓的** —— 出包时按 cid 查出年份再取那一格写账户线索（仓库里**不落文件**） |
| `hdu_adapter.py` | `hdu_cid*.json` → crate（导入包）。**顶部配置块是唯一需要改的地方** |
| `fetch-hdu-rank.js` | 浏览器控制台脚本：把分页**榜单**全量抓成一个 HTML（7MB，解析完会自动删） |
| `fetch-hdu-submit.js` | 浏览器控制台脚本：把分页**提交记录**全量抓成一个 HTML（按运行ID去重） |
| `save-hdu-page.js` | 浏览器控制台脚本：**一键存当前页的源 HTML**（不用剪贴板；按规范名下载） |
| `Hdu_contest_list_scraper.py` | 比赛列表 HTML → `hdu_contests.json` |
| `Hdu_prob_scraper.py` | 题目页 HTML → `hdu_cid<CID>_problems.json` |
| `Hdu_submit_scraper.py` | Status 页 HTML → `hdu_cid<CID>_submits.json` |
| `hdu_cid*_*_source.html` | 抓下来的原始证据（**解析成功后会自动删除**，见 2.4） |
| `hdu_cid*_rank.html` | 完整榜单原始证据（7MB 一份；**算出统计后自动删除**） |
| `hdu_cid*_rank_stats.json` | 榜单算出来的赛时统计（**ratio 的来源**，别手工改） |
| `26hdu/26hdu<N>/` | 按场次分的中间产物（题目/提交/统计）—— 目录名不参与识别，纯为好看 |
| **`lib/hdu_common.py`** | **公共工具**：字母表 / cid 提取 / 文件名识别 / 读写 JSON —— **全项目只有这一份** |
| **`lib/`** | 其余内部脚本，你不需要直接跑（流水线自己调）： |
| └ `hdu_rank_parser.py` | 榜单 HTML → 每队每题明细。**诊断用**（流水线只借它打印交叉校验，不落盘；要存明细自己加 `-o`） |
| └ `hdu_rank_stats.py` | 榜单 HTML → `hdu_cid<CID>_rank_stats.json`（**写在榜单 HTML 旁边**），**ratio 的来源** |
| └ `rank_probe.py` | 榜单 HTML 的**结构探查**（把 300KB 压成几百行摘要；页面改版、要重写解析器时才用） |

### 5.1 一次性手工工具（**不是生产链路**，生产是 `hdu_multi_fetch.py`）

下面三个脚本是**当年手跑的一次性工具**（实测：全仓代码里**零引用**，链上也不调），留着只因为
"页面结构万一变了，还能拿它们单独特判一份文件"。**别拿它们当入口**：

| 脚本 | 干什么 | 现在该用什么 |
|---|---|---|
| `Hdu_contest_list_scraper.py` | 比赛列表 HTML → `hdu_contests.json` | `hdu_multi_fetch.py fetch --refresh-archive`（翻归档页，全自动） |
| `Hdu_prob_scraper.py` | 题目页 HTML → `hdu_cid<CID>_problems.json` | `hdu_pipeline.py` 会自己解析 `*_source.html`（`build` 里已包含） |
| `Hdu_contest_times.py` | 补比赛时间 | 归档页里就有 `start`，`build` 会补进清单 |

（`Hdu_submit_scraper.py` 与三个 `.js` **不是**这一类：前者是流水线解析 Status 页的实际调用者，
后者是浏览器手存那条路的手；见 `§2`。）

---

## 6. 常见问题

**Q：报"没找到任何输入"**
A：检查文件名是不是 `hdu_cid<CID>_problems.json`（规范只有这一条）。
流水线会把"像输入但名字不对"的 json/html 列出来。

**Q：`ratio` 全是空的**
A：这场没提供榜单。放一份 `hdu_cid<CID>_rank.html`（用 `fetch-hdu-rank.js`）再跑。

**Q：警告说"榜单的 cid=xxxx 不在本次比赛的集合里"**
A：你把 A 场的榜单和 B 场的题目配在一起了。crate 里 ratio 仍按 cid 匹配，
不会串场，但基本等于白给。

**Q：`crate:check` 报"包内第 N 条与第 M 条高度相似"**
A：这是**提醒**不是错误。比赛节点名字天然相似（"…联赛(1)/(2)/(3)"），
只要 extKey 不同就是不同节点。真正要警惕的是**同一道题出现两个 key**。

**Q：我想让某一场不按年份分组 / 换个年份名字**
A：`GROUP_BY_YEAR = False` 就整棵退回"系列 → 比赛"两层；
只想改年份显示名，改 `ensure_year` 传进去的名字即可。
**但注意**：年份节点的 extKey（`hdu:series:summer:2026`）一旦导入就固定了。

**Q：改了 extKey 规则后重新导入，会不会全变成重复节点？**
A：会。extKey 是身份，不是标签。要么别改，要么**把旧节点删掉再重导**。
手动改名只适合零星几个，
上百个节点用「补身份键 / 更换 key」一个个点不现实。

**Q：`crate.py` 报 `extKey 重复（包内必须唯一）：'hdu:sub:xxxx'`**
A：这是**包内 extKey 撞车**。HDU 的「运行ID」是**每场重新编号**的
（10 场实测有 5 个 rid 跨场重复），写成 `hdu:sub:<rid>` 会少掉比赛 ID，
于是两场的同号提交撞车，整份包都出不来。
正确的 key 是 `hdu:c:<cid>:sub:<rid>`。
**处理办法**：把用错 key 导入的那批 HDU 节点删掉，重新导入新的 `hdu.json`
（适配器遇到同场 rid 重复时会**跳过并提示**，不抛异常）。

**Q：改了代码，页面上却"没变化"**
A：先确认浏览器跑的是不是新代码 —— 控制台敲 `__ACM_BUILD__`。
它不是最新那个值，就说明是**缓存**，不是代码没改对（清缓存顺序：关掉该
origin 的所有标签页 → 硬刷新 → 换端口）。

**Q：为什么提交记录那么少？**
A：Status 页只给你账号看得见的部分。这是 HDU 的限制，不是解析 bug。

**Q：「账户对比」里看不到我 / 提示"归认 0 条"**
A：两条都要满足：① `me.json` 里写了 `hdu.handle`（写了才会给每条 R 打账户线索，见 §2.2.2）；
② 应用**账户管理**里配了一条**一模一样**的映射 `hdu : handle = <你的值>`。
配完点「🔁 用当前映射重跑归认」——已经导进来的值也会被认领，不用重导入。
如果显示"冲突、谁都不认领"，说明两个账户声明了同一个三元组（比如都写了 `TEAM0`）——
换成组合值（`TEAM0/teamA`）就分开了。

**Q：R 上没有 `codeLength` 吗？**
A：没有，**HDU 的 Status 表格里没有这一列**（语言/时间/内存都有）。
只有点进每条提交详情页才有代码，那是逐条请求、不值得 —— 宁可不给。

---

## 7. 别人要接一个新平台，照抄什么

按这个顺序读，就知道每一层为什么这么设计：

1. `hdu_adapter.py` 顶部**配置块**（平台名、extKey 模板、系列规则、字段开关）
2. `scripts/crate.py` —— crate 格式与构造器（平台无关，可直接复用）
3. `docs/auto-import.md` —— 导入/查重/合并的完整设计
4. `docs/scraper-guide.md` —— 接入新平台的清单

---

## 8. 榜单的"页数 / 行数"**都不是队数**（2026-10-18 实测，回答"每页多出多少行"那个疑问）

**症状**：看抓下来的榜单 HTML 会得到三个互相不搭的数 —— "页段 22 个、每页 54 个 `<tr>`、
`teamCount` 1047" ⇒ 很容易怀疑"解析把非队伍行也算进去了"或"teamCount 虚高"。**实测结论：都不是。**

拿 cid 984（2021 多校 #1）重抓一次核的（`hdu_multi_fetch.py fetch --cid 984`，核完把源 HTML 按正常流程删掉）：

| 量 | 实测值 | 怎么解释 |
|---|---|---|
| `<!-- PAGE n -->` 段数 | **22** | 21 页 + **开头那一段空的**（页内容都在标记之后）⇒ 22 是**页段数**，与行数无关 |
| 每页 `<tr>` | **54** | 表头 1 + 空行 1 + **本队置顶行 1** + 主表排名行 **51**（末页 48） |
| 每页 `page-card-table` | 4 | HDU 把表头 / 本队行各自渲染成独立的表；`parse_html` 只取**榜单本体**那一张 |
| 逐页队伍数相加 | 20×51+48 = **1068** | 中间有**页边界重复**：共 21 处 |
| `parse_pages` 去重后 | **1047** | == `rank_stats.teamCount`，**一致** |
| 本队（teamB）置顶行 | `rank 789 / solved 0` | 主表里**本来就有**同一条（rank 789）⇒ 置顶是重复渲染，丢掉它**是对的** |

⇒ **判据**：榜单的队数只看 `parse_pages()` 合并去重后的 `len(teams)`；
`页数`、`<tr>` 数、逐页相加**都不是队数**（HDU 的分页是含边界的，每处边界重复 1 行）。

守卫（会红）：`hdu_multi_fetch.py --selftest` 第 ⑦ 组 **2 条** —— 两页共 4 行、3 支不同的队
（B 在两页都出现）⇒ 合并后必须**3 支且 B 只算一次**，且 B 的 `results` 是**并集**（后一页补前一页缺的格）。
反向验过：把 `parse_pages` 的去重键改成"每行都算新的"，这 2 条当场红
（实测 `['team0001','team0002','team0002','team0003']`）。
⚠️ 同一个坑的另一半：**每页前面必须有自己的 `<!-- PAGE n -->`** —— 第一个标记**之前**的那段会被整段跳过
（写夹具时踩到，见 `hdu_rank_parser.split_pages`）。
