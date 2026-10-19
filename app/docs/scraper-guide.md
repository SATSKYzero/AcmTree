# 爬虫接入指南（给写爬取脚本的人）

> 目标读者：**你**，或者任何要给 Acm_Tree 写爬虫的人。
> 应用侧的完整契约在 [auto-import.md](auto-import.md)；本文只讲"怎么把它跑起来"。

---

## 零、一分钟版

> 🐚 **所有命令都在项目根目录、用 PowerShell 跑**（本项目在 Windows）。
> ⚠️ **PowerShell 不用 `\` 续行**（那是 bash 语法）——写了会报
> `找不到参数 \`。要么写成一行，要么用反引号 `` ` `` 续行（行尾不能有空格）。
> 下面一律写成一行，可直接复制。
>
> 📌 文中的**绝对数**（多少条、多少场…）都是**本仓库那份数据**的实测，只用来说明依据；
> 你自己的数据会不一样。
>
> 📁 **数据都放在 `acm-data/`**，与应用代码分开：
> `raw/`(原始数据) → `scripts/`(转换脚本) → `nodes/`(产出包) → `merged/`(示例/临时合并结果)。

```powershell
# 1. 自测工具本身能跑（首次接入时做一次）
npm run crate:selftest

# 2. 把你爬到的数据转成节点信息
#    ⚠️ 示例产物一律写 merged/ 且以 sample_ 开头 —— nodes/ 里放的是**真包**，别覆盖
python acm-data/scripts/qoj_adapter.py problems acm-data/raw/qoj_problems.json -o acm-data/merged/sample_qoj_crate.json

# 3. 合并 + 体检
npm run crate:merge -- acm-data/merged/sample_qoj_crate.json -o acm-data/merged/tree.json

# 4. 用**应用真实引擎**离线试跑（不写任何数据，随便跑）
npm run crate:check -- acm-data/merged/tree.json

# 5. 把 acm-data/merged/tree.json 拖进应用的「📥 节点自动导入」
```

> 第 3 步可以传多个文件（用空格隔开），也可以写通配符（PowerShell 会自己展开）。
> ⚠️ **别把 `acm-data/nodes/*.json` 当示例的输入源**：那是生产包（`mix_contain_xcpc.json`、
> `all_nodes.json`、`qoj.json`…），
> 见 `05 xcpc/` 目录里的适配器与脚本（`xcpc_pipeline.py`、`qoj_adapter.py` 等）。

第 4 步是关键：它用的是应用**同一套模块**（不是复制一份逻辑），
所以结论与浏览器里完全一致，但**不用打开浏览器、不会写坏数据**。

---

## 一、目录里有哪些工具

| 文件 | 语言 | 作用 |
|---|---|---|
| `scripts/crate.py` | Python | **导入包构造器 + 校验器**（零依赖，可直接抄进你的爬虫项目） |
| `acm-data/scripts/qoj_adapter.py` | Python | qoj 的**参考适配器**（**教学模板，不是生产链路**，见文末）；把 qoj 原生导出转成节点信息 |
| `acm-data/raw/Scaper/02 hdu/` | Python+JS | HDU 的**完整范例**（榜单是 HTML，逐格数队伍）→ `nodes/hdu-multi-university.json`。三个入口：`npm run crate:hdu`（= 本地原料→包，**不联网**）、`crate:hdu:fetch`（去 HDU 抓页面，要 `me.json` 里按年的比赛口令）、`crate:hdu:browser`（只跑解析：人在浏览器手存的页面 → 包）。说明见该目录的 `_usage.md` 与适配器 |
| `acm-data/raw/Scaper/01 nk/` | Python+JS | 牛客的**浏览器手存路**（榜单是 JSON 接口），入口 `npm run crate:nk:browser` → `nodes/nk-browser.json`，说明见该目录里的适配器与脚本（⚠️ 别和 `npm run crate:nk` 混：那个跑的是 05 xcpc 的"往年牛客多校"，出 `nk-multi-university.json`） |
| **`acm-data/raw/Scaper/05 xcpc/`** | Python | XCPC 的**多来源范例**（一场比赛的数据分散在 PTA / rankland / CF / QOJ / xcpcio），入口 `npm run crate:xcpc`，说明见该目录里的适配器与脚本；**想学"多来源拼一场 + 来源降级"就看它**。v8.4 起它还带两个**单平台整树**渠道：CF 正式比赛（`cf_contest_adapter.py`）与 AtCoder（`atcoder_adapter.py`） |
| **`acm-data/raw/Scaper/lib/read_modes.py`** | Python | **通用读取层**（所有渠道共用）：页级归档 `Archive`、`should_refetch`、`retry_call`、统计，以及统一的 `--cache-mode/--retry-mode/--offline/--force` 四开关（`offline` = 一次也不联网、缺文件当场报错；`--offline` 也能用环境变量 `ACM_READ_OFFLINE=1` 传，见 `OFFLINE_ENV`）—— **写新爬虫请用它，别自己再写一套重试/缓存** |
| **`acm-data/raw/Scaper/lib/auth_state.py`** | Python | **登录态判据**（所有渠道共用，2026-10-03）：每平台"过期/被拦长什么样"的**唯一一张表** + `raise_if_bad/open_text/guard_body` 三种接法 + `--probe <平台>` 抓前探一次。过期 ⇒ `AuthError` ⇒ `read_page`/`retry_call` **当场停**并给出"去 me.json 改哪一份"那句话 —— 见 §8.1 |
| **`acm-data/raw/Scaper/lib/scope.py`** | Python | **抓取范围通用件**：`union_scope(*, explicit=None, mine=None, name='')`（**keyword-only**，按位传会 TypeError）= 指定范围 ∪ 有提交；`split_by_origin()` 做来源标注 |
| `scripts/crate-merge.mjs` | Node | **合并器（主脚本）**：合并多个数据包的产出 + 离线体检 |
| `scripts/crate-check.mjs` | Node | 用**应用真实引擎**离线试跑一份导入包 |

`crate.py` 与 `crate-merge.mjs` 是**应用自带的通用工具**（放在 `scripts/`）；
`qoj_adapter.py` 是**最小参考适配器**（放在 `acm-data/scripts/`）；
HDU / 牛客 / XCPC 那三套是**端到端范例**（连抓取脚本和赛时通过率一起）—— 想接新平台时，
先花十分钟看它们的适配器与脚本，比读抽象规范快得多。
三者的 `ratio` 口径**刻意统一**为「通过队伍数 ÷ 有效队伍数」，接新平台时请沿用。

> **多来源时的一条经验**（XCPC 学到的，代价是 155 个字段）：一个来源常常一次给好几样
> （榜单 + 题名 + 提交）。换掉其中一样（比如把榜单让给更权威的源）时，
> **要按"它原本还给什么"把它剩下的角色逐个留下** —— 只留一个，别的会静默消失，
> 而 `crate:check` 照样 0 错（它只查"能不能导入"，不查"该有的字段在不在"）。
> 详见 `acm-data/raw/Scaper/05 xcpc/` 里的多来源适配器与脚本。

### 数据流水线

```
acm-data/
├── raw/       各平台原始数据（爬虫直接导出，只读）
├── scripts/   原始数据 → 节点信息的转换脚本（每个平台一个）
├── nodes/     产出包：**一个类一个包**（qoj / cf-gym / cf-contest / atcoder / xcpcio / rankland /
│              pta / srk / nk-ranklist / nk-multi-university / nk-browser / hdu-multi-university）
│              + `mix_contain_xcpc.json`（混装包 = 7 个 XCPC 来源包；不含 atcoder/cf-contest）
│              + `all_nodes.json`（可选 `--all-nodes`：上面那份 + atcoder + cf-contest + 两个多校包）
│                ⚠️ **合成节点不单独出包**：容器/组头/成员指针由链上 `synth-bind.mjs` 按 nature
│                建出来、直接写进最终包（`all_nodes.json`）
├── merged/    示例/临时合并结果（`sample_*`、`tree.json`）
└── archive/   历史/废弃产出
```

> `nodes/` 里**没产出某个类时不会删旧产物**（它可能是唯一能导入的一份），
> 只落一个 `<类>.json.stale` 标记并在运行末尾警告 —— 见到它就说明"这份可能是过期数据"。

详细约定见本文上面的「目录里有哪些工具」与 §八 的适配器契约。

### 合并器刻意不做的事

- **不对账**。「哪些是新增/更新/跳过」是**应用预览**的权威结论——
  树状态在浏览器 IndexedDB 里，命令行读不到。
  合并器只保证"合并出来的包本身自洽"。
- **不规定 `extKey` 命名**。各数据脚本与骨架脚本之间自行对齐即可，
  主脚本不承担命名权威（否则各平台就没自由度了）。

### `crate.py` 的三个子命令

```bash
python scripts/crate.py selftest              # 用内置样本验证工具本身
python scripts/crate.py validate out.json     # 校验一份导入包
python scripts/crate.py validate out.json --tree my_export.json
                                              # ↑ 附带"父节点是否已在树上"的检查
python scripts/crate.py tree-keys my_export.json --out keys.txt
                                              # 从应用导出里抽出全部 extKey
```

`--tree` 传的是**应用导出的完整 JSON**（主视图 → 导出）。
不传也能校验，只是会假定树是空的，"容器是否已存在"判不准。

---

## 机制总览

> 这一节是**索引 + 判据**：每个渠道"抓什么、谁消费它、在不在自动链上"都**从代码里读出来**
> （每格点名 `文件:函数/字段`）。想动手改抓取，先读那一层的就地规范
> `acm-data/raw/Scaper/AGENTS.md`（动那个目录时会自动注入）。
>
> **"自动链" = `scripts/build_chain.py` 的 `steps_for()`**（**14 步**；离线档 **13 步** —— 第 2 步
> 那个抓取必然联网，整步不进表；命令行 `python -B scripts/build-all.py`、
> 应用里「🛠 重建总包并导入」共用同一份步骤表）。表里的 **❌ = 那一步不在链上**，
> 也就是说：**跑 `crate:all` 不会替你刷新它**，必须手动跑（清单见下一小节）。
> 判据随时可核：`python -B scripts/build-all.py --list`（打印 14 步）。

### 每个渠道一行

| 渠道 | 抓什么 | 入口脚本（抓） | 产物 | 缓存 / 水位线判据 | 认证 | 谁消费它 | 自动链 |
|---|---|---|---|---|---|---|---|
| **QOJ** | 场次页 · 分类树 · 全局/场次提交 · 题面归属 · 时间列 | `acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py`（`--fetch` / `--archive` / `--category` / `--list` / `--participation` / `--resolve-contests` / `--timefmt`） | 原料 `04 qoj/qoj_submissions.json`、`04 qoj/cache/{qoj_contest_titles,qoj_contest_problems,qoj_contest_categories,qoj_category_tree}.json`、页级归档 `04 qoj/cache/pages/<key>.<kind>.html`；片段 `05 xcpc/cache/crate_qoj_tree.json` | 页级走 `read_modes.Archive.page()`（`--force` ⇒ `Archive.has()` 一律 False）；**成列表读提交页** ⇒ `CACHE_STOP` + `read_modes.should_stop_on_no_new()`，水位线 = **整页都是已存提交 ID**（`fetch_pages(known=…)`）；活列表（场次列表/VP 名单/名册）就地 `CACHE_NONE` | `me.json` 的 `qoj.cookie`；"过期长什么样"只有一张表：`lib/auth_state.py` 的 `PLATFORMS['qoj']`（302 + `Location: //qoj.ac/login` + 0 字节） | `xcpc_pipeline.py` 的 `TREE_SOURCES['qoj']` → `05 xcpc/qoj_adapter.py` → `crate_qoj_tree.json` → `nodes/qoj.json` → `mix_contain_xcpc.json` → `all_nodes.json` | ✅ **第 2 步 `qoj-submits`：只跑 `--fetch`（按花名册逐人抓新提交）** —— 2026-10-15 起挂上链（用户："把 QOJ 的提交加到自动链上"）；同一个脚本的 `--list` / `--archive` / `--category` / `--participation` / `--timefmt` **仍然手动**（见下一小节）。⚠️ 没配 `qoj.cookie` ⇒ 友好跳过（exit 0）；**过期/被拦 ⇒ 当场停** |
| **PTA** | 榜单（board）· 本队逐条提交（R） | 无自动抓：人在浏览器 F12 存进 `03 PTA/`（要抓哪个响应见 `05 xcpc/pta_rankings_fetch.py` 文件头；它能顺手把结果落到 `--out-dir "acm-data/raw/Scaper/03 PTA"`） | `03 PTA/*.json`（如 `PTA_rankings.json` / `team_submissions.json`），路径写进注册表的 `board.file` / `submissions[].file` | **没有缓存层**（`_usage.md` §0.2：「`03 PTA` 全都是**读你手工存下来的 HTML/JSON**」）；`pta_rankings_fetch.py` 用 `should_refetch` + `--missing` 选择器 | 公开页即可；只有要登录的 API 才 401 + `USER_NOT_LOGGED_IN`（`auth_state.PLATFORMS['pta']`） | `ADAPTERS['pta']` → `05 xcpc/pta_adapter.py`（`analyze()`；**也吃牛客榜单形状**，`analyze_nk()`）、`ADAPTERS_BY_ROLE[('pta','submissions')]` → `pta_submissions_adapter.py` → `crate_<slug>_pta*.json` → `nodes/pta.json` | 适配器 ✅（链上第 3 步）；**抓取 ❌**（人手存） |
| **rankland（srk 榜单）** | 题名 · 题链接 · 必要时当权威榜单算 ratio | `05 xcpc/fetch_rankland_srk.py <slug>`；**缺失时 `srk_adapter.py` 会自己去抓**（`rankland_tree.fetch_repo_file`） | 原料 `05 xcpc/cache/<slug>.srk.json`；片段 `crate_<slug>_srk.json` | `read_modes.should_refetch`（`lib/rankland_tree.fetch_config_text()` 也认 `--force`/`--offline`，别自造缓存口径）；多路兜底在 `build_rankland_index._get_head()`（换镜像，**不是**重试） | 无（GitHub raw；`auth_state.PLATFORMS['rankland']` 只有 403/429） | `ADAPTERS['srk']` → `05 xcpc/srk_adapter.py`（`role=titles` 默认 / `role=board`）→ `crate_<slug>_srk.json` → `nodes/srk.json` | 适配器 ✅；`fetch_rankland_srk.py` ❌（但适配器能自愈） |
| **rankland（跨平台索引 / refs）** | 一场 ↔ 它在各平台的 id（gym 号 / QOJ 题号 / PTA 榜单 / 题目链接） | `05 xcpc/build_rankland_index.py` | `05 xcpc/cache/rankland_index.json`（`bySlug` / `byGym` / `byProblem`） | `should_refetch`（**已抓过的 slug 跳过**）；`--force` 才全量；HTTP Range 分档 `HEAD_TIERS` | 无 | `xcpc_registry.py`（拿它校验 slug，缺了它**第 1 步直接失败**）、`gen_gym_manifest.py`、`cf_adapter.py`（赛期）、`rankland_index_adapter.py` → `_rlidx`、`rankland_refs_adapter.py` → `_rlrefs`、`link_qoj_activity.py` | ❌（`build_chain.py` 只在自测夹具里提过它）；但 `--needs` 会经 `material-needs.py` 的 `CHANNELS['rankland']['refetch']` 跑它 |
| **xcpcio 榜单** | C 的赛名/时间 + 每题的 ratio（**最权威的 ratio 源**） | `05 xcpc/build_xcpcio_index.py`（索引）+ `xcpcio_adapter.py`（按需下 `run/team`） | `cache/xcpcio_tree.json`；每场 `cache/xcpcio/<仓库路径>/{config,run,team}.json` | `should_refetch`（`xcpcio_adapter.local_file()`，写前自检"像不像完整 JSON"、原子改名）；索引增量靠 **`configSha`**（blob sha 与目录树一致就不重下）；`fetch_raw()` 自带多路兜底（**fastly → gcore → cdn → raw**；顺序是实测定的：2026-10-15 同一份 838 KB 的 `run.json`，fastly 2.1 s，gcore/cdn 10054，raw 61 s 后重置 ⇒ 旧的"cdn → raw"两条在这台机器上一条都不通） | 无（公开 GitHub / board-data） | `ADAPTERS['xcpcio']` → `xcpcio_adapter.py` → `crate_<slug>_xcpcio.json` → `nodes/xcpcio.json`；`xcpc_registry.py xcpcio --write` | 适配器 ✅；`build_xcpcio_index.py` ❌（`--needs` 会跑） |
| **CF gym** | 提交（R）· 榜单（C+P+ratio）· 官网链接 | `cf_adapter.py`（R）· `cf_board_adapter.py`（board/website/titles） | `cache/cf_<gym>_<handle>.json`（新约定 `cache/cf/<gym>_<handle>.json`）· `cache/cf_standings_<gym>.json` · `cache/cf_gym_meta.json` · `cache/cf_gym_scope.json` | `cf_adapter --no-fetch`（只用本地）/ 删文件即重抓；`cf_board_adapter` 用 `read_modes` | `cf.apiKey/apiSecret`（**只有 gym 榜单 `contest.standings` 要**；提交是公开 API） | `ADAPTERS['cf']` / `ADAPTERS_BY_ROLE[('cf',…)]` → `crate_<slug>_cf*.json` → `nodes/cf-gym.json` | 适配器 ✅ |
| **CF 正式比赛（≠ gym）** | 我提交过的正式轮次整棵树 + 题池 + 难度证据 | `05 xcpc/cf_contest_adapter.py`（`TREE_SOURCES['cf-contest']`） | `cache/crate_cf_contest_tree.json`；`cache/cf_contest/{list.json,history_<handle>.json,problems.json,rated_list.json,page_difficulty.json,reuse.json,types.json,pages/<cid>.html}` | `contest.list` / `user.status` / `problemset.problems` 就地 `CACHE_NONE`（活数据，每次联网）；`user.status` 分页按 `from/count` 递增；`page_difficulty.json` 三态 + 30 天 TTL（`lib/cf_page_evidence.py`） | 无（公开 API；凭据只给 gym） | 自身 → `nodes/cf-contest.json` → `all_nodes.json`（**不进混装包**） | 适配器 ✅ |
| **AtCoder** | 我提交过的场次整棵树（公开 API + 官方题表页） | `05 xcpc/atcoder_adapter.py` | `cache/crate_atcoder_tree.json`；`cache/atcoder/{contests.json,problems.json,submissions_<handle>.json,pages/<cid>.tasks.html}` | **水位线在手**：`load_submissions()` 取缓存里最大 `epoch_second` + 1 续抓（`fetch_submissions()` 每页 500 条、`MAX_PAGES` 兜底）；资源文件是活数据 ⇒ 就地 `CACHE_NONE` | 无 | 自身 → `nodes/atcoder.json` → `all_nodes.json`（**不进混装包**） | 适配器 ✅ |
| **牛客多校（正式路）** | 往年暑期多校：赛名/题名/榜单/我的提交 | `05 xcpc/nk_multi_fetch.py`（`run --effective` / `run-submits` / `build`）；`npm run crate:nk` | 原料 `05 xcpc/cache/nk/nk_cid<cid>_{contest,problems,rank,rank_stats,submits}.json`；包 `nodes/nk-multi-university.json` | `build()` 只吃盘上已有的原料（`rank_stats` 缺了才现算）；榜单接口 `limit=0` **只给第一页**，必须自己翻页（`nk_rankings_fetch.api_url`） | 枚举要 `clist.apiKey`（经 `auth_state.open_text(platform='clist')`）；牛客接口公开 | 自身 `build()` → `01 nk/nk_adapter.py` 出包；清单里 `source: nk` 的 board 走 `pta_adapter.analyze_nk()` | ✅ **第 4 步**（`build`，本地出包、不联网；没原料就跳过）。它出的是 `all_nodes.json` 的输入，所以必须排在产包之前 |
| **牛客（浏览器手爬路）** | 单场题目/提交/榜单（往届补场用） | `01 nk/nk_pipeline.py --all`；`npm run crate:nk:browser` | 原料 `01 nk/**/nk_cid<CID>_{problems,submits,contest,rank_stats}.json`（源 HTML 解析后默认删）；包 `nodes/nk-browser.json` | 无网络缓存层（源是人在浏览器里存的）；`has_records()` 判"这份 JSON 真有数据吗" | 无 | `01 nk/nk_adapter.py` 出包 ⇒ `nodes/nk-browser.json` | ❌；**而且它也不进 `all_nodes.json`**（那份只并 `nk-multi-university.json`） |
| **杭电多校** | 题目/提交/榜单（榜单是 HTML，逐格数队伍） | 出包 `npm run crate:hdu`（= `02 hdu/hdu_multi_fetch.py build`，**本地、不联网**）；抓页面 `crate:hdu:fetch`（要 `me.json` 里按年的比赛口令）；只手存页面时 `crate:hdu:browser`（= `02 hdu/hdu_pipeline.py --all`） | 原料 `hdu_cid<CID>_{problems,submits,rank,submit}`、`hdu_contests.json`（"哪一场用哪个账号抓的"**不落文件**：出包侧按 cid 的年份读 `me.json` 的 `hdu.years.<年>.contestUser`）；包 `nodes/hdu-multi-university.json` | 无网络缓存层（页级归档在 `cache/hdu_cid<CID>_*.html` 的 bundle 里）；文件识别**只有一条规则**：`hdu_cid<CID>_<种类>`（`02 hdu/lib/hdu_common.py` 的 `identify()`） | 比赛口令按年一套（`hdu.years.<年>`） | `02 hdu/hdu_adapter.py` 出包；`nodes/hdu-multi-university.json` 由 `all_nodes.json` 合并 | ✅ **第 3 步**（`build`，本地出包、不联网；没原料就跳过）。以前是 ❌：链只**读**那棵树 ⇒ 忘了手动跑就静默少一整棵 |
| **CLIST 难度** | `clistDifficulty`（给包里**已有**的 P 补一格） | `scripts/clist-difficulty.py sync` | `05 xcpc/cache/clist/difficulty.json`（**直接改包**，不产 crate 片段 —— 与 `nature-baseline.py` 同形） | `should_refetch`；⚠️ **裸 `sync`（链上跑的就是它）在缓存已存在时「只回写、一次也不联网」**（`sync()` 的 `if not (force or refresh) and has_cache:` 那一支）—— 要补新题得 `sync --refresh`（只翻最新一页，`NEW_PAGES`），`sync --force` 才全量（`MAX_PAGES` 兜底）；限速 `SLEEP_SECONDS`（clist 官方 10 请求/分钟） | `clist.username + clist.apiKey`（**用户名也是凭据**：只给 key 一律 401）；没有 ⇒ 友好跳过 exit 0 | 链上第 10 步直接写 `all_nodes.json` 里 P 的 `clistDifficulty` | ✅ 第 10 步（`skip_offline=True`）；但**它默认不抓新数据**（见左） |
| **CF 难度证据（探数据）** | 场次 "Rated: Yes/No" 逐场列表 + 题目页实际有没有难度 | `cf_contest_adapter.py --fetch-rated-list` / `--fill-difficulty`（由 `material-needs.py --probe` 调） | `cache/cf_contest/rated_list.json`、`cache/cf_contest/page_difficulty.json` | 页面证据三态 + 30 天 TTL（`lib/cf_page_evidence.py:PAGE_NEG_TTL`）；默认只查 `unknown` | 默认无（页面公开） | `scripts/material-needs.py`、`scripts/field-coverage.py`（"上游没有"的判据，唯一一份） | ❌（只有 `--needs` 那条路会顺带跑） |
| **平台难度"上游有没有"证据** | CLIST 缺席 / kenkoooo 没估出 | 无独立入口（是缓存 + 判据） | `cache/clist/difficulty.json`、`cache/atcoder/problem-models.json` | 三态 + 否定证据 30 天保质期：`lib/clist_evidence.py:clist_state()`、`lib/atcoder_models_evidence.py:model_state()` | 无 | `scripts/material-needs.py`（`NEED_RULES[].exhausted`）、`scripts/field-coverage.py` | ❌ |
| **赛时时段回填** | 比赛的起止时间（判 R 的 `submitKind` 要用） | `01 nk/backfill_nk_contest_times.py` · `02 hdu/Hdu_contest_times.py` | `01 nk/**/nk_cid<CID>_contest.json` · `02 hdu/Hdu_contests.json` | `should_refetch` + `retry_call`（1 请求/场） | 无 | `01 nk/nk_adapter.py` · `02 hdu/hdu_adapter.py` | ❌ |

### 哪些要手动跑

> 判据：**在 `scripts/build_chain.py` 的 `steps_for()` 里找不到 = 不会自动跑**。
> 一条链跑完产出的 `all_nodes.json`，只是"盘上现有原料的重打包" —— 上面那些 ❌ 的渠道
> 一个字节新数据都不会有。命令都在**项目根目录**用 PowerShell 跑。

```powershell
# ── A. 每次都该补的「活数据」（不做的话链子只是重打包旧原料）────────────
# QOJ：场次名册 + 题号表 + 分类树（都归 04 qoj 独家维护）
#   ⚠️ **新提交不用手动跑了**（2026-10-15 起它在链上，第 2 步 `qoj-submits` 就是
#      `--fetch`）—— 下面这条只在"想单独刷新、不重建包"时才用：
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter a,b   # 新提交（默认读 me.json 花名册）
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --list                     # ← qoj_contest_titles.json
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --archive                  # ← 场次页归档（题名/题单/分类都从归档剥）
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --category 205,212,106,21  # ← qoj_category_tree.json（QOJ 包该有哪些场次）
# ⚠️ 别删上面那几个 JSON：它们是**积累**的，删了只有这轮路过的场会被填回

# ── B. 跨平台索引 / 难度证据（链子第 1 步读它们，但要人来刷）────────────
py "acm-data/raw/Scaper/05 xcpc/build_rankland_index.py"           # → cache/rankland_index.json（增量；--force 才全量）
py "acm-data/raw/Scaper/05 xcpc/build_xcpcio_index.py"             # → cache/xcpcio_tree.json（增量，小）
py "acm-data/raw/Scaper/05 xcpc/xcpc_registry.py" xcpcio --write   # 场次对到 xcpcio 目录（注册表是人写的）
py -B scripts/clist-difficulty.py sync --refresh                   # ← 只有这一条会去抓新题；链上那步是裸 `sync`，缓存已存在时**一次也不联网**

# ── C. 两个"包要单独出"的渠道（all_nodes 会读它们的产物，但链子不产）────
py "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" run --effective --from-year 2023   # 牛客多校榜单
py "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" run-submits --from-year 2023       # 牛客多校我的提交
py "acm-data/raw/Scaper/05 xcpc/nk_multi_fetch.py" build --from-year 2023             # → nodes/nk-multi-university.json
py "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all                                 # → nodes/hdu-multi-university.json（原料要先手工存）

# ── D. 补 ratio / 补单场（"某渠道缺 ratio"时按报告跑）────────────────────
py "acm-data/raw/Scaper/05 xcpc/missing_ratio_report.py"           # 先看缺哪些
py "acm-data/raw/Scaper/05 xcpc/pta_rankings_fetch.py" --missing   # PTA 榜（公开接口，不用登录）
py "acm-data/raw/Scaper/05 xcpc/nk_rankings_fetch.py" --missing    # 牛客榜
py "acm-data/raw/Scaper/05 xcpc/fetch_rankland_srk.py" <slug>      # 单场 srk（题名/链接）

# ── E. 白名单 / 清单这条"人工拍板"线（改了要重出清单）───────────────────
py "acm-data/raw/Scaper/05 xcpc/fetch_my_gyms.py" --handle <你的CF用户名>   # 我从打过哪些 gym → gym_whitelist.json
# 【唯一的判断】手改 gym_whitelist.json 的 include
py "acm-data/raw/Scaper/05 xcpc/gen_gym_manifest.py"                        # 白名单 → xcpc_contests.json
py "acm-data/raw/Scaper/05 xcpc/xcpc_registry.py" build                     # 注册表 → 清单（链上第 1 步也做，但注册表改了要先跑它）

# ── F. 认证过期时 ─────────────────────────────────────────────────────
py -B "acm-data/raw/Scaper/lib/auth_state.py" --probe qoj     # 1 个请求探一次（表里没有便宜探针的平台会明说）
py -B "acm-data/raw/Scaper/lib/auth_state.py" --list          # 打印整张表（每条的实测证据）
py "acm-data/raw/Scaper/lib/me.py" --check                    # 用 CF/QOJ 各打一发验证凭据
```

> ⚠️ **C 那两条（牛客/杭电多校）不是"可选步骤"**：`all_nodes.json` 的合并输入里就写着
> `nk-multi-university.json` / `hdu-multi-university.json`（`xcpc_pipeline.py` 的 `--all-nodes` 那一段），
> 缺了只会打印一句"缺这几个（没算进去）"然后**少两个包**继续跑。
> 所以"跑完 `crate:all` 就齐了"是**错的**。

### 同一件事有几份实现

> 这一节**只记不重构**（列出来是为了让你改的时候知道要改哪几处；真要收口得先问人）。
> 下面每一条都是"各平台各写一份"的实例 —— 本仓库的规矩是**同一件事只许一处**，
> 所以这些要么是历史遗留、要么是被明确允许的"场景标定"。

| 这件事 | 有几份 | 在哪 | 说明 |
|---|---|---|---|
| **增量水位线** | **3 份** | ① `read_modes.should_stop_on_no_new()`（页级 STOP：整页无新值就截断）② `04 qoj/QOJ_submissions_scraper.py:fetch_pages(known=…)`（整页命中已存提交 ID 就停）③ `05 xcpc/atcoder_adapter.py:load_submissions()`（最大 `epoch_second` + 1 续抓） | 三个渠道的"时间倒序列表"形状不同（页 / ID 集合 / epoch），所以没共用；**改任何一处都要单独看另外两处** |
| **翻页上限常量** | **5 份** | `04 qoj/QOJ_submissions_scraper.py` 的 `DEFAULT_MAX_PAGES` / `LIST_MAX_PAGES` / `CATEGORY_MAX_PAGES`、`atcoder_adapter.MAX_PAGES`、`scripts/clist-difficulty.py` 的 `MAX_PAGES` / `NEW_PAGES`、`cf_contest_adapter.fetch_types()` 里的 `page >= 40` | 每个渠道自己定"跑飞了就停"的兜底 |
| **重试 / 退避** | **2 套** | 通用层 `read_modes.retry_call`（`--retry-mode`）· 自带"重试或多路兜底"的 `lib/cf_api.call(retries=3)`、`xcpcio_adapter.fetch_raw`、`build_rankland_index._get_head()` | ⚠️ **不许叠**：`cf_contest_adapter` 传 `retries=0`、`cf_board_adapter` 干脆不套 —— 叠起来就是乘法（见 `read_modes.py` 文件头与 `_usage.md` §0.2 的"自带重试的"那张小表；`_get_head` 的注释还明说"换源才是常态，重试只会把时间浪费在挂起的连接上"） |
| **`me.json` 的 handle 列表** | **1 份（已收口）** | `lib/me.py:handles()` | ★ 2026-10-16（用户定的口径："② **干脆别兜底**"）：`01 nk/nk_pipeline.py:nk_handles()`、`01 nk/nk_adapter.py:handle_from_me()`、`02 hdu/hdu_pipeline.py:hdu_handles()`、`02 hdu/hdu_adapter.py:hdu_handles()` **四处只转发**它；`import` 不进来就**当场停**（原来那四处各自解析 `me.json` 当兜底 —— 而兜底只读单数键、**不认花名册**`team[].*` ⇒ 会**静默缩小认领范围**，实测本机 nk 的三个账号全来自花名册、兜底一个都拿不到）。判据：`src/test/meRosterSingleSource.test.js` |
| **ratio（通过率）口径** | **2 份** | `05 xcpc/pta_adapter.py`（按**有效队伍数**，与 HDU/牛客/srk/xcpcio 统一）· `03 PTA/PTA_problems.json` 的 `AC率`（由 `03 PTA/PTA_problem_scraper.py` 写死 `TEAM_COUNT` 算） | ⚠️ **后者不是生产链路**：`_usage.md` 明确说那个 `AC率` "更离谱"，**别拿它当 ratio 来源** |
| **QOJ 提交按 `提交ID` 合并** | **2 份** | `04 qoj/lib/qoj_common.py:merge_by_key()`（生产用，逐字段兜底空值）· `04 qoj/merge_qoj_cache.py`（自己写了一遍"旧+新"的合并循环） | 后者是历史上"旧备份 + 新抓"的一次性小工具，**不在任何链上** |
| **`_read_json` 小工具** | **3 份 + 1 份正式的** | `05 xcpc/lib/cf_page_evidence.py`、`lib/clist_evidence.py`、`lib/atcoder_models_evidence.py` 各一份私有 `_read_json()`；正式的那份是 `xcpc_common.read_json()` | 三个 evidence 模块要"能被 `scripts/` 按路径 import 且零依赖"，所以各自抄了一份 |
| **"同一场"认定** | **1 份（已收口）** | `05 xcpc/lib/match.py` | `gen_gym_manifest.py` / `link_qoj_activity.py` / `xcpc_registry.py` / `missing_qoj_report.py` 都调它 —— **这是好例子**：曾经各写一份，现在是唯一一份 |
| **来源优先级投影** | **2 份** | 真源 `src/core/trust.js`（`KIND_RANK` 类别 + `SOURCE_RANK` 同类之内的来源级覆盖 + `DEFAULT_TRUST.categoryRank`）· 镜像 `05 xcpc/source_report.py`（"只读小样"自己实现了一遍，含 `CATEGORY`/`SOURCE_RANK`/`CATEGORY_RANK`） | ⚠️ **改一处要改两处**，否则那个工具会**用另一套规则**告诉你"应用为什么选了这个值"（比没这个工具更坏）；守卫 `src/test/sourceReportRanks.test.js`（逐项对拍 + "等级不许与类别序矛盾"）。⚠️ 工具那份按**来源短名**分档 ⇒ 分不出 `cf-<slug>`(榜) 与 `cf-titles-<slug>`(题名) |
| **清个人数据 / 重试 / 缓存开关** | **1 份（已收口）** | `scripts/clean-personal.mjs`、`lib/read_modes.py`、`lib/auth_state.py` | 同上：写新爬虫**直接用**，别自己再写一套 |

---

## 二、写一个新平台的爬虫

整体分两步：**爬** 和 **转**。只有"转"这一步需要遵守契约。

### 2.1 用 `Crate` 构造导入包

```python
import sys
sys.path.insert(0, "path/to/Acm_Tree/scripts")
from crate import Crate

c = Crate(source_id="my-scraper", label="我的爬虫", platform="cf")

# 容器链：O → W → S → C → P → R
c.platform("cf", name="Codeforces")                       # W（父留空 = 挂根）
c.series("cf", "cf:div2", name="Div.2")                   # S（必需，见下）
c.contest("cf:div2", "cf:1920", name="Round 900")         # C
c.problem("cf:1920", "cf:1920.A", name="Two Sum",
          problem_id="A", link="https://codeforces.com/contest/1920/problem/A",
          cf_difficulty=800, tags=["dp", "math"])
c.submission("cf:1920.A", "cf:sub:123456789",
             status="AC", time="2026-09-13 22:06:07")

c.save("out_cf.json")
print(c.summary())     # 18 条记录（平台×1, 系列×1, …）
```

### 2.2 三条硬规则（写错了会被逐条拒绝）

**规则 1：每个节点都要有非空 `extKey`。**
它是身份。**用平台的稳定主键**，不要用题号或标题——它们会变，
一变就认不出来，于是**静默产生重复节点**（这是最难发现的一类故障）。

**规则 2：`父extKey` 必须能解析。**
要么在同包的 records 里，要么**已经在主树上**。
两边都没有 → 该条被拒。应用**不会**帮你隐式创建容器。

**规则 3：容器链必须合法。**

```
O → W/S      平台 / 系列
W → S/W      平台下只能是平台或系列
S → C/S      系列下是比赛或系列
C → P        比赛下是题目
P → R        题目下是提交记录
```

> ⚠️ **`W` 下不能直接放 `C`。** 比赛必须挂在系列（`S`）下。
> 没有"系列"概念的平台（如 qoj），要**插一层虚拟分组**：
>
> ```
> qoj → qoj:contest → qoj:4113 → 题目
>        ↑ 这一层只为满足层级约束
> ```

### 2.3 字段：只写能写的那几个

**可写**（写进 `problem()` / `contest()` / `submission()` 的参数即可）—— 以
`scripts/crate.py` 的 `WRITABLE_FIELDS` 为**唯一真源**（JS 那份由属性表派生，见
`core/model/elements.js`；这条一致性有**对拍**钉住：`npm run crate:selftest` 会拿 Python
那份与 JS 真模块逐字比）。

> **要当前清单，别抄文档**（抄本会烂）：
> `python -B scripts/crate.py fields`（一行一个，排序输出）。
> 共 24 个：常用 15 个（`name` / `problemId` / `cfDifficulty` / `ratio` / `link` / `tags` /
> `contestTime` / `kind` / `identityKey` / `time` / `status` / `submitKind` / `language` /
> `timeUsed` / `memoryUsed` / `codeLength`）＋ 数值难度字段组的另两员
> （`atcoderDifficulty` / `clistDifficulty`）＋ 合成那两格（`synthKey` / `ownerSynth`）＋
> 性质四字段（`natureClass` / `natureYear` / `natureSeason` / `natureRegion`，
> 取值走 `nature_fields()`，可空）。

> 为什么有 `synthKey`/`ownerSynth`：**合成节点**（把同题的多个来源并成一组）的身份与成员指针
> 也随包发布，但它们在导入时走**二阶段解析**，不按普通字段合并。

> `link`（**只适用 C**）：**所有链接都装在这里**，类别由元列 `链接分类` 给出；
> ⚠️ 爬虫不该再写链接字段本身 —— 改写元列 `链接分类`
> （`{board|problems|repo|browse|unknown: [{v, src}]}`，`scripts/crate.py` 的 `link_kinds()` 帮你拼），
> 而由**应用层**从分类里派生：判据/类别只有一个权威定义，见 `docs/auto-import.md` 7.4.2。
> `submitKind`（v8.1，**只适用 R**）= 提交**性质**（`赛时` / `VP` / `补题`）——
> 它决定 P 的 status2 是「4 赛时通过」还是「3 赛后补题」；**判不出就留空，不要写"未知"**。

**不可写（派生字段）**——写了也会被应用忽略：

```
status1  status2  acTime  lastSubmitTime  xcpcDifficulty  statusComplete1/2
```

> 🔑 **最重要的推论：爬虫不用管"是否通过"。**
> 把 **R（提交记录）** 导进去，应用的 `status2` / `acTime` / `lastSubmitTime`
> 会**自动推导**出来（`docs/auto-import.md` 7.6）。
> 你现有的 qoj 样本里那个 `是否通过` 列，可以完全不处理。

### 2.4 字段名用自己的命名？

`Crate` 构造器写入的列名**就是内部字段名**，应用直接采纳。
如果你的爬虫输出的是**自有列名**（中文或别的命名），两种做法：

```python
# 做法 A：在构造时用内部名（推荐，类型安全）
c.problem(..., name="两数之和", problem_id="A")

# 做法 B：声明映射，让应用去转换
c.map_column("题目名称", "name")
c.map_column("题目ID", None)      # 身份输入列 → 显式忽略
```

**没出现在 fieldMap 里的列 = 未使用字段**：应用只把**列名**记进"导入记录"
（不存值），方便你日后想加字段时，知道爬虫早就在给了。

---

## 三、换平台要改哪几行

`acm-data/scripts/qoj_adapter.py` 就是模板，整个文件末尾列了清单。要点：

1. **顶部常量**：`PLATFORM` / `PLATFORM_NAME` / `GROUP_KEY` / `LABEL`
2. **`*_key()` 函数**：定 extKey 拼法。三个要点：
   - 用**平台稳定主键**，不要用题号/标题
   - 层级前缀 = 父的 key + `:`（便于肉眼核对；这不是强制要求）
   - 提交段加 `sub:` 前缀，避免与纯数字的比赛 ID 撞
3. **`extract_*_id()`**：你的平台从哪个字段/链接取 ID
4. **`_is_submission()`**：怎么区分题目记录与提交记录
5. 平台**有**系列概念的，把 `GROUP_KEY` 换成真实系列，
   并在 `build()` 里按系列分组 —— 层级会更贴近语义

> `crate.py` **不校验 extKey 的拼法**——那是你的约定，应用也不解析它。
> 它只要求：**非空 + 全局唯一**。

---

## 四、工作流：为什么值得离线试跑

```
爬取 → crate.py 构造 → crate-check.mjs 试跑 → 拖进应用
                          ↑
                    这一步能提前看到
                    「新增/更新/跳过/警告/错误」
```

`crate-check.mjs` 报的每一类东西，含义与处理：

| 输出 | 含义 | 怎么办 |
|---|---|---|
| **新增 N** | 这些节点主树上还没有 | 正常 |
| **更新 M** | extKey 命中了已有节点，且策略允许改动 | 正常；内容没变时会是 0 |
| **跳过 K** | 命中已存在节点，但内容一致或无字段可写 | **正常**，这是幂等的表现 |
| **错误 E** | 这些条目会被拒绝，其余照常执行 | **必须修**：错误信息里带了可行动的原因 |
| **警告 W** | 不影响执行 | 看一眼；常见的"前缀漂移"可能是有意为之 |

**错误里最常见的三条**：

| 错误码 | 意思 |
|---|---|
| `parent-not-found` | 父节点两边都没有 → 补一条容器记录，或先导容器 |
| `missing-extkey` | 该条没算出身 extKey |
| `duplicate-extkey` | 包内同一个 extKey 出现多次（通常是爬虫 bug） |

---

## 五、完成的判据

一份导入包"合格"的标准，就是这两条同时成立：

```bash
npm run crate:check -- out.json     # 退出码 0，且「错误 0」
```

**幂等验收**（最重要的一条）：

```
第一次导入 → 新增 N
同一份再导 → 新增 0、更新 0、跳过 N
```

做到这一点，说明你的 extKey 是稳定的，之后就能放心地反复运行。

---

## 六、一场比赛有多个来源怎么办（XCPC 模式）

HDU / 牛客那两个平台是**单来源**：一个目录、一条命名规则（`平台_cid<CID>_<种类>`），
身份写在文件名里。**XCPC 不是这样**：一场比赛的榜单可能在 PTA，题名/链接在
rankland，提交在 CF 或 QOJ，而且**每场都不一样**。这时用"清单 + 适配器"这套：

```
05 xcpc/
├── xcpc_contests.json      ← 人写的清单：每场的数据来自哪些来源（唯一人工维护的东西）
├── xcpc_pipeline.py        ← 入口：读清单 → 调各来源适配器 → **按类各出一包** → 简单合并
├── pta_adapter.py / srk_adapter.py / cf_adapter.py / cf_board_adapter.py / qoj_adapter.py
├── cf_contest_adapter.py   ← CF **正式比赛**（≠ gym）：按"我提交过哪些场"整树出（不走清单）
├── atcoder_adapter.py      ← AtCoder：同上（公开 API + 官方题表页）
├── lib/xcpc_common.py      ← extKey 唯一一份 + 树的两张表 + 题号排序
├── cache/                  ← 抓来的原始文件 + 各来源片段（可随时删）
└── …（还有 20+ 个：rankland 索引 / PTA 提交 / 牛客多校 / 各来源的 fetch 与索引脚本）
```

> 上面只列了"你会改到的那几个"；`05 xcpc/` 里实际有二十多个 `.py`（`glob acm-data/raw/Scaper/05 xcpc/*.py` 看全）。

> ⚠️ **`pta_adapter.py` 现在吃两种榜单形状**（PTA 的 `xcpcRankings` 与牛客的 `problems`）：
> 两个 `analyze*()` 产出**同形的统计**（`ratios` / `board_link` / `label`），
> 所以 `build()` 里没有任何按平台的 if。想接第三种榜单，**照这个形状加一个 `analyze_x()` 就行**，
> 不要去写第二个适配器（来源名如实写成 `xcpc-<源>-<slug>` 即可）。

**两条通用的做法**（v8.4 起，写新渠道照这两条走；包名见 v8.5 的改动）：

1. **产出层：一个类一个包。** `xcpc_pipeline.py` 按**片段来源**分组、每类各跑一次
   `crate-merge` 出一包（`nodes/<类>.json`），最后把"含 XCPC 的那几类"合成
   `nodes/mix_contain_xcpc.json`（`--all-nodes` 再追加 atcoder / cf-contest / 两个多校包
   成 `all_nodes.json`）。片段→类的映射**一处声明**
   （`SUFFIX_CLASS`/`TREE_CLASS`）；出现**没匹配上的后缀**会大声警告并列出片段名；
   **本轮没产出的类不删旧产物**，只落 `<类>.json.stale` 标记 + 警告（旧产物可能是唯一能导入的一份）。
   以后要"由若干部分**组成** XCPC 类"，就在最后那一跳加料。
2. **抓取范围 = 指定范围 ∪ 有提交。** 用 `Scaper/lib/scope.py` 的
   `union_scope(explicit=…, mine=…, name=…)`：`explicit` 是"我显式指定/名单给的"
   （`--contest` / `--category` / 白名单 / 清单），`mine` 是"我有提交的"
   （提交文件 / `user.status` / API）。它返回并集并打一行"显式 N ∪ 提交 M = K 场（重叠 J）"；
   要标注"这条是从哪来的"就用 `split_by_origin()`。**渠道不许在这上面再加自己的取舍。**

三条要点（照抄这三条，新平台就不会歪）：

1. **"哪些文件属于同一场"是数据，不是算法。** 两个来源里同一场比赛的 ID
   毫无关系（PTA 的 `2097206296647036928` vs CF 的 `gym 106701`），
   没有任何规则能把它们对上 —— 所以清单里显式写 `slug` + 文件名。
2. **一个字段只有一个来源。** 清单里给每个来源一个角色：
   `board`（权威榜单 → 比赛名/时间 + ratio）、`sources[role=titles]`（只补题名/链接）、
   `submissions`（只出 R）。两边都出同一个字段 → 合并时会报"字段值不一致"。
   ⚠️ **榜单通常给不出题名**（PTA / 牛客只有题号，xcpcio 的 config 也只有 label）——
   换 board 时**别忘了把原来的题名来源降级保留**成 `titles`
   （`xcpc_registry.py` 的 `cmd_build` 里有现成规则，照抄即可）。
3. **合并用现成的 `scripts/crate-merge.mjs`**，不要自己写拼接：
   它按 extKey 去重、体检跨包冲突/断链，而且**有错就不写出文件**。

身份（extKey）就用**外部世界的稳定 ID**：XCPC 用 rankland 的 slug
（v8.3 起每个渠道各自一棵树，键形如 `aux-pta:c:icpc2026preliminary-2`），
层级照抄来源的树（icpc 下面是年份、provincial 下面是省份、ucup 只有两层
—— **层级不统一，别硬编码语义**）。
⚠️ **挂不挂"辅助节点"那层由渠道自己决定**：`xcpc_common.AUX_TREES` 里的渠道挂
`O → W 辅助节点 → W aux-<渠道>`；`PLATFORM_TREES` 里的（如 `atcoder`）直接挂
`O → W <渠道>`（"Atcoder 不应该在辅助节点里"）。

⚠️ **从"来源的目录名"反解 slug 时，两边都要去掉标点再比**：rankland 的 slug 里**允许 `-` / `_`**
（`icpc2023xi_an`、`icpc2024preliminary-1`、`ccpc2024invitational-jinan`…），而 xcpcio 的目录名是
`48th/xian` 这种——只把目录那侧归一化成 `icpc2023xian` 再拿去**逐字**比 slug，永远比不上 ⇒
表现为"这一场静默没进树"（实测：ICPC 48th 西安站整场因此缺席，`lib/match.py` 的 `xcpcio_hint` 已修）。

完整说明见 `acm-data/raw/Scaper/05 xcpc/` 里的适配器与脚本。

---

## 七、还没有现成适配器的平台

`luogu` **需要一份真实导出样本**才能写准映射；在拿到样本之前，任何"猜的"字段映射都大概率要重写。
请把样本放进 **`acm-data/raw/`**，然后在 `acm-data/scripts/` 里按第三节的清单接入。

已经有了的（写新平台时可直接抄）：
- `nowcoder`（牛客多校）—— `acm-data/raw/Scaper/01 nk/`；
- `hdu`（杭电多校）—— `acm-data/raw/Scaper/02 hdu/`；
- **`atcoder`** —— `acm-data/raw/Scaper/05 xcpc/atcoder_adapter.py`
  （AtCoder Problems 公开 API + **官方题表页**取题号，见该文件头）；
- **CF 正式比赛（≠ gym）** —— `acm-data/raw/Scaper/05 xcpc/cf_contest_adapter.py`；
- XCPC（多来源）—— 上面第六节。

---

## 八、写新爬虫必用的"通用读取层"（v8.4）

`acm-data/raw/Scaper/lib/read_modes.py` 是**所有渠道共用**的一层，**别自己再写一套重试/缓存**：

```python
from read_modes import Archive, add_cli_args, configure_from, should_refetch, retry_call, print_stats

ap = argparse.ArgumentParser(...)
add_cli_args(ap)                 # ① 挂上 --cache-mode/--retry-mode/--offline/--force
args = ap.parse_args(argv)
configure_from(args)             # ② 让它们对本次运行生效（要在第一次读之前）
ARC = Archive(os.path.join(HERE, 'cache', 'pages'))     # ③ 页级原料目录
html = ARC.page(key=cid, kind='contest', url=url, fetch=fetch_html,
                accept=lambda h: 'table-bordered' in h)  # 归档优先、没有才联网、好页才入库
if not ARC.has(cid, 'contest'):  # "还欠哪些"的判据 —— --force 时自动变"全部重抓"
    ...
print_stats('我的渠道')           # 一行统计：页/归档命中/联网次数/重试/失败/字节/秒
```

- **缓存维**：`none`（每次联网，抓到仍入库）／`keep`（有归档就用，无新值**不**截断）／
  `stop`（有归档就用，无新值**截断**）／**`offline`**（**一次也不联网**，缺文件当场报错 —— 与 `--offline` 同一个档）；
- **重试维**：`retry`（默认，失败再试 3 次、退避翻倍）／`once`（只试一次）；
- **`--force` 语义只有一条**：把归档/缓存当成不存在 ⇒ 读页时联网，且"还欠哪些"的判据也变成"全部重抓"；
- **先问一句"这页/这个缓存的内容会不会变？"**：会变（活数据：提交列表、VP 名单、场次列表、索引）
  ⇒ 日常读取**必须联网**（`NONE`），归档只当「原料 + 断了接着补（`KEEP`）」；
  不变（场次页、分类页、榜单、带 sha 的索引）⇒ `KEEP`，要刷新用 `--force`；
- **重试不要套两层**：某函数若自己已有重试/多路兜底（如 `cf_api.call`、xcpcio 的 `_get`），
  就**不要**再 `retry_call` 包一层，否则变成乘法。

> ★ **QOJ 的"提交"已于 2026-10-15 挂上自动链**（用户："把 QOJ 的提交加到自动链上"）：
> `steps_for()` 的 `qoj-submits`（第 2 步，排在**产包之前**）跑的就是
> `QOJ_submissions_scraper.py --fetch`，范围 = `me.json` 花名册（`active:false` 的账号不抓）。
> ⇒「🛠 重建总包并导入」**会顺手刷新新提交**，不用再记着手动跑。
> - 没配 `qoj.cookie` ⇒ **友好跳过（exit 0）**（与 `clist` 同一条口径：队友那台没 cookie 也要能出包）；
> - **过期/被拦** ⇒ 当场停（`read_page` 的 `SystemExit(2)`）—— 别静默出一份缺新提交的包
>   （那正是这条被挂上链之前反复踩的坑：链只重打包盘上那份旧 JSON，新提交一条都进不去）。
> - 同一脚本的 `--list` / `--archive` / `--category` / `--participation` / `--timefmt` **仍要手动**。
> 判据：`python -B scripts/build-all.py --list` 里第 2 步是 `qoj-submits`；
> 或看它末尾的「新增 N 条」；**N=0 不等于没新提交** —— 还要看这句上面有没有
> 「一页全是已有提交 → 到此为止」：有它才说明是"确实没有更新的"。

### 8.1 登录态：**过期是常态**，判据只有一处（2026-10-03）

`acm-data/raw/Scaper/lib/auth_state.py`（与 `read_modes` 同一层，各渠道共用）。

起因：**QOJ 的 cookie 过期后，抓取端只表现为"第 1 页没拿到（网络失败 / 登录页）"
+ 0 字节** —— 是**人眼看 HTTP 头**（`302 → //qoj.ac/login`）才定性成"cookie 过期"的。
而每个平台的"过期"长相都不一样 ⇒ 每个脚本各写一遍判断，等于都没写。

```python
import auth_state

# ① 不跟重定向的渠道（自己拿 http.client，QOJ 就是这一类）
resp = auth_state.from_http(status, url, location, body)
return auth_state.raise_if_bad('qoj', resp, where=url)     # 过期/被拦 ⇒ AuthError；好页 ⇒ 正文

# ② urllib 那类（一行接法：401/403/限流/登录页都过判据）
status, text = auth_state.open_text(req, platform='clist', where=url)

# ③ 只有正文的渠道（CF 把失败写在 JSON comment 里、状态码一律 400）
auth_state.guard_body('cf', body, where=url, status=e.code)
```

- **三态**：`ok` / `expired`（凭据过期 ⇒ 该去改 `me.json`）/ `blocked`（限流/验证页 ⇒ **不是凭据问题**，
  提示里明说"别去改 me.json"）；
- **判据是响应本身**，不是"内容像不像"：⚠️ 牛客的**正常页面**导航里就有 `login` 这个词 ——
  拿它当判据会把好页判成过期（自测里专门钉了这条反例）；
- **过期 ⇒ 当场停**：`AuthError` **不重试**。两种接法的收尾不同（别写错期望）：
  **`read_page`** 会打印那句可执行的话并 `SystemExit(2)`（与 `require_local()` 同一个态度）；
  **`retry_call`** 只把它**原样抛给调用方**（不打印、不退出）—— 由调用方自己决定怎么收场。
  **别让 20–75 页跑到一半才发现**；
- **抓前探一次**：`python -B "…/Scaper/lib/auth_state.py" --probe qoj`（1 个请求；表里没有便宜探针的
  平台会明说靠"第一发早失败"）；`--list` 打印整张表（含每条的实测证据）；
- **加一个新平台** = 在 `PLATFORMS` 加一行（`expired` / `blocked` 各是"任一子句成立"）+ 把**实测证据**
  写进 `note`。**别猜**：先拿真/假凭据各打一发，把 status / `Location` / 正文特征记下来。

| 平台 | 凭据 | 过期长什么样（实测 2026-10-03） |
|---|---|---|
| QOJ | `qoj.cookie` | **302** + `Location: //qoj.ac/login` + **0 字节**（真 cookie ⇒ 200 / 25 KB） |
| Codeforces | `cf.apiKey/apiSecret` | HTTP 400 + 正文 `Incorrect API key` / `Incorrect signature`（真凭据 ⇒ 200 + `"status":"OK"`） |
| CLIST | `clist.apiKey`（+`username`） | **401 + 0 字节**（用户名也是凭据的一部分：只给 key 一律 401） |
| PTA | （只用公开页） | 要登录的 API ⇒ 401 + `USER_NOT_LOGGED_IN`；榜单/题面页公开 |
| 牛客 / 杭电 / AtCoder / xcpcio / rankland | 无 | 没有"过期"这回事，只有被拦（403/429） |

> 归档（`cache/pages/`）只在**好页**时写 ⇒ 换完凭据**重跑同一条命令**，已抓的一条都不用重抓。

---

## 附：自带的示例

| 文件 | 说明 |
|---|---|
| `acm-data/raw/qoj_problems.json` | qoj 题目列表（12 道，中文列名）—— **"不成熟"格式**，缺 extKey/节点类型 |
| `acm-data/raw/qoj_submissions.json` | qoj 提交记录（3 条）。⚠️ 这是**作者的个人提交导出**，清理过的副本里**不随包**（自己抓一份就有；缺它时相应测试会自己 skip） |
| `acm-data/merged/sample_qoj_crate.json` | 示例导入包，可直接导入。⚠️ 那份 **18 条**是当年**连提交导出一起**跑出来的；现在 `npm run crate:sample:qoj` 只转题目（15 条），因为提交导出是个人的、不随这份仓库 |

> ⚠️ **`acm-data/scripts/qoj_adapter.py` 是"参考/教学模板"，不是生产链路**（2026-09-24 标注）。
> 它产出的 sample 包用的是**过期的 extKey 拼法**（`qoj:sub:<id>` 那套），
> 正式链路在 `acm-data/raw/Scaper/05 xcpc/`（`xcpc_pipeline.py` + 各适配器），
> 拼法是 `aux-pta:c:<slug>:sub:pta:<id>`（`<树>` 换成该渠道那棵）且带账户线索/运行信息/提交性质。
> 本文件之所以留着：① 写新平台时照抄它（文末有清单）；② 它就是下面这个最小样例的来源。

> 以 `sample_` 开头的都是**本仓库自带的示例**，可随时删；
> 不要与你自己的数据产出混用文件名。

`qoj_problems.json` 这类只有 `P`、没有 `C` 的包，**默认会被整批拒绝**——
因为树上还没有那个比赛。两条出路（`docs/auto-import.md` 2.3）：

1. **推荐**：让适配器**顺带输出容器记录**（`qoj_adapter.py` 就是这么做的）
2. 或先单独导一次比赛
