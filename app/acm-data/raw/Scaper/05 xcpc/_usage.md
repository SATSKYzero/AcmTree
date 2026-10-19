# XCPC（ICPC / CCPC / 省赛 / 邀请赛…）→ Acm_Tree 使用说明

这个目录里的东西只做一件事：
**把 XCPC 的比赛数据变成一份可以拖进应用的导入包（crate）。**

```
注册表（人写：身份 / 分类 / 来源 / xcpcio 指派）
        ↓  xcpc_registry.py build
场次清单（派生产物：这场的数据在哪）
        ↓
PTA / rankland(srk) / CF gym / CF 正式比赛 / QOJ / xcpcio / AtCoder   各来源适配器 → crate 片段
        ↓  scripts/crate-merge.mjs（先**按类各出一包**，再简单合并）
acm-data/nodes/<类>.json（12 份，见 §0.2.2）  →  逐份或合并那份拖进应用
```

**和 HDU / 牛客最大的不同：一场比赛的数据来自多个来源，而且每场都不一样。**
所以这里多了一层"清单"——**哪些文件属于同一场，是数据，不是算法能猜出来的**
（两个来源里同一场比赛的 ID 毫无关系）。

> **状态**：产出**一个类一个包** ——
> `qoj 5032｜cf-gym 2447｜cf-contest 8656（527 场 / P 3693）｜atcoder 529｜nk-ranklist 31｜
> xcpcio 1551｜rankland 1958｜pta 233｜srk 32`，再加三份派生包：
> · **`mix_contain_xcpc.json` 12293** = 7 个 XCPC 来源包（qoj / cf-gym / pta / rankland / srk /
>   xcpcio / nk-ranklist）。**排除** `atcoder` 与 `cf-contest`（各是一棵独立的树）。
> · **`all_nodes.json` 26921**（**可选**，`--all-nodes`）= 上面那份 + `atcoder` + `cf-contest` +
>   `nk-multi-university` + `hdu-multi-university`。**自带全部祖先节点，可单独导入**。
> ⚠️ **合成节点不单独出包**：容器 + 组头 + 成员指针由链上 `scripts/synth-bind.mjs` 按 nature
>   建出来、直接写进最终包（`all_nodes.json`）。老的清单 slug 方案（`scripts/nature_rules.py build`
>   产 `xcpc-synth.json`）**已停用** —— 它是第二个建组器；它独有的顶层 W / icpc 中间层容器 /
>   指针来源痕已补进 `synth-bind`（实测清单见 `scripts/nature_rules.py` 文件头）。
> `crate:check` 13 份全 **0 错**。没有产出的类**只标注 `.stale` 不删**（见 §0.2.2）。
>
> ⚠️ **C 有一列元信息 `分类依据`**（`{ natureClass: 'qoj:path-icpc' }`）：
> "这条分类是**哪条规则**判出来的"（适配器发的稳定 id，记的是**最弱的那一环** ——
> 值的可信度由最弱证据决定）。应用侧拿它查级别表（`src/core/natureConfidence.js` 的
> `CLASS_RULE_LEVEL`）画**依据强度**徽标、按"依据 ≤ X"筛出该复核的那些。
> ⚠️ 别在 Python 里再写一份级别：**这边只写 id**，级别是"读法"（改分级不用重跑数据）。
> 新增判据时记得两处都登记（`crate.py` 的 `class_rules()` 调用点 + JS 那张表；
> `xcpc selftest` 的 `test_class_rule_ids()` 会交叉核对）。
>
> ⚠️ **回代（③）**：人在应用里改过/接受过的 nature 会标成 `M`（`manual:set`）——
> 它们进 `acm-data/nature-assignments.json`（应用「判重整理 · ③」的「📤 导出人工填写」：
> 点一下就直接写进那个文件；缩水时先拒绝、要人确认）。
> **产包时会自动回代**（`xcpc_pipeline.py` 末尾那一步）：重出包是从零生成的 ⇒ 不回代就把
> 人的结论丢了，所以并进了产包。
> 没有那份文件时**友好跳过**；想故意不要回代就加 `--no-baseline`；单独跑用 `npm run crate:baseline`。
>
> ⚠️ **「哪些节点不该算合成键」另有一份注册表**：
> `acm-data/synth-registry.json`（**分类白名单** `classRules` + **节点白名单** `nodeRules`，两层叠加；
> 每条都要写 `why`）—— 命中的节点：`synth-bind` 不给它算键/绑组、已绑的**脚本格式**键会被解绑
> （空组/空容器跟着收掉；**人工绑的键一个字不动**），应用 ⑤ 里只记一行"注册表排除 N 条"。
> 判据只有一份：`src/core/synthRegistry.js`（应用与脚本共用）。
>
> **一条龙建总包**：`npm run crate:all`（注册表 → `xcpc_pipeline --force --all-nodes` → 自动回代
> → 合成归属/题目绑定/补回代/落位 → `crate:check` → 报告）；不想联网重建用 `npm run crate:all:offline`。
>
> 📖 **给人看的一轮维护流程**（谁自动谁手动、做完怎么核对、出岔子怎么办）在
> **`docs/manual-workflow.md`** —— 这一份是爬虫侧的细节，那份是操作手册。
>
> ⚠️ **合成节点只有两种**：① **XCPC 的比赛**（`scripts/synth-bind.mjs`，
> `synth:xcpc:<赛季><分类段>…`，按 nature 算键）；② **CF/AtCoder 的复用题**（`xcpc_common.problem_reuse_groups()` +
> `emit_problem_synths()`，`synth:problem:<老家 P>`，CF 那边由 `reuse.json` 驱动）。
> **cf/atc 的 C 一律不合成。**
>
> ⚠️ **两类合成节点的落点与名字**：
> · **名字**：复用题的合成节点与老家那道 P **同父同名**（都叫 `Row GCD`）⇒ 加前缀
>   **`[Merged] `**（`xcpc_common.MERGED_SYNTH_NAME_PREFIX`；只加在合成节点上，
>   成员两份 P 的题名一个字符不动 —— 分组判据要它们的原样题名）。
> · **位置**：CF 的 51 个复用题合成节点挂**辅助树 `aux → aux-cf-contest`**下：
>   `aux-cf-contest:c:<老家场次>`（25 场镜像 C，名字/性质/链接**照抄**真树那份）→ 合成节点。
> · ⚠️ **两处的 `cf-contest` 系列都多了一层年份**：
>   真树 `cf:s:cf-contest` → `cf:s:cf-contest:<年份>` → C；辅助树同理
>   `aux-cf-contest:s:cf-contest:<年份>` → C。取不到年份落 `年份未知`（`xcpc_common.YEAR_FALLBACK`）。
>
> ⚠️ **地区（`natureRegion`）自动填**：`xcpc_common.place_of_name()` 从赛名读
> **中文城市/省名**（`Nanjing` → 南京、`澳門` → 澳门），**网络赛写 `无`**（没有场地），
> **UC 各站（含拿不到变体名的镜像）与总决赛 / 女生·高职专场写 `待填写`**（这一维暂时由人填，
> 但**判定层面算填过**），**本身是英文写法的国外地名/赛区名写 `不需要`**，**读不出留空**（不猜）。
> 三个写入点：`xcpc_nature()` / `cf_nature()` / QOJ 的两份读法。空地区 835 → 3。

---

## 0. 从头跑一遍（**新用户视角**：你只有 CF 账号，别的什么都没有）

给新用户（比如你换台机器重来一遍）：下面这几步能从零产出 `acm-data/nodes/` 下的**各类包**
（以及混装包 `mix_contain_xcpc.json` / 可选的全量包 `all_nodes.json`，见 §0.2.2）。
只有第 ④ 步需要你的判断（改 `include`），其余全自动。预计 25 分钟，绝大部分是第 ② 步的网络时间。

```powershell
cd <项目根目录>

# ⓪ 前置：填一次**个人信息文件** acm-data/raw/Scaper/me.json（全项目只此一处）
#    cf.handle      你的 CF 用户名（提交只导这个人的）
#    cf.apiKey/Secret   CF → Settings → API 生成（只有 gym 榜单需要；提交是公开 API）
#    qoj.cookie     QOJ 登录后的 Cookie 整行（填了就能自动抓提交，不用再 Ctrl+S）
#    pta.teamName   PTA 上的队名
#    看当前配置：python "acm-data/raw/Scaper/lib/me.py" --show     （原样显示）
#    联网验证：  python "acm-data/raw/Scaper/lib/me.py" --check
#    ⚠️ 里面有密钥与登录态，别外传、别整目录发给别人。

# ① 我从打过哪些 gym（公开 API，不用凭据）→ 白名单
python "acm-data/raw/Scaper/05 xcpc/fetch_my_gyms.py" --handle <你的CF用户名>
#    → gym_whitelist.json：每个 gym 一行，include 是真假由脚本按名字给**默认建议**

# ② 跨平台对照表：gym 号 / QOJ 题号 ↔ rankland slug（394 场，约 12 分钟，可 Ctrl+C 续抓）
python "acm-data/raw/Scaper/05 xcpc/build_rankland_index.py"
#    → cache/rankland_index.json        （**跳过这步也能跑**，只是每场都用 cf<gym> 身份）

# ③ QOJ 官方赛名（1 次请求；05 侧的注册表/缺场报告靠它核对"是不是同一场"）
python "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --list
#    → 04 qoj/cache/qoj_contest_titles.json（**归 04 独家维护**；形状见 §0.2.2）

# ④ 【唯一的判断】打开 gym_whitelist.json，把要导的场次改成 "include": true
#    脚本的默认建议：ICPC Asia / CCPC / 省赛 / 邀请赛 = true；其它大洲与训练赛 = false

# ⑤ 白名单 → 场次清单（自动做跨平台整合）
python "acm-data/raw/Scaper/05 xcpc/gen_gym_manifest.py"
#    看输出：整合了多少条 / 哪些没对上 / 题目名匹配明细（有疑问就核对名字）

# ⑥ 出包（每场两个请求：gym 榜单 + 我自己的提交；有缓存就跳过）
npm run crate:xcpc -- --check
#    → **按类各出一包**：acm-data/nodes/{qoj, cf-gym, cf-contest, atcoder, xcpcio, rankland,
#       pta, srk, nk-ranklist}.json，再合成**混装包** acm-data/nodes/mix_contain_xcpc.json
#       （= 7 个 XCPC 来源包；不含 atcoder / cf-contest）
#       想一次导全树：-- --all-nodes → 再追加 atcoder / cf-contest / 牛客多校 / 杭电多校
#    ⚠️ **合成节点不在这条路上**：容器/组头/成员指针由链上 `synth-bind.mjs` 按 nature 建、
#       直接写进最终包；`npm run crate:xcpc` 只管抓数出片段。

# ⑦ 拖进应用：📥 节点自动导入 → 选 acm-data/nodes/all_nodes.json（一份到位，**合成节点在其中**）
#    （没生成它就用 mix_contain_xcpc.json；不过那一份**不带合成节点** —— 想要合成节点就走整条链
#      `npm run crate:all`。`hdu`/`nk` 多校是**另外两个包**，见各自 _usage.md）
```

**要自己加"非 gym 的比赛"（PTA 上打的网络赛、牛客多校…）**：见 §0.1 —— 那类比赛
每个来源的文件都得你从浏览器里存下来（PTA 榜单、本队提交），所以只能一场一场手写清单条目。
第 ⑥ 步会保留这些手工条目不动（`gen_gym_manifest.py` 只覆盖它自己生成的那些）。

> **现实里多走一步：注册表**。上面这套（白名单 → 清单）是"首次从零建"的路径；
> 实际在用的是**注册表**（`xcpc_registry.json`：身份/分类/来源 + `pending` 候选区），
> 清单是它 `build` 出来的派生产物。已有清单可以 `xcpc_registry.py seed` 一次性迁进去。
> **想让场次有权威难度档，再加两步 xcpcio**（见 §2.1）：
>
> ```powershell
> python "…/05 xcpc/build_xcpcio_index.py"            # ① xcpcio 索引（约 1.4 MB，2–3 分钟，增量）
> python "…/05 xcpc/xcpc_registry.py" xcpcio --write  # ② 场次对到目录（先不带 --write 看报告）
> python "…/05 xcpc/xcpc_registry.py" build           # ③ 注册表 → 清单
> python "…/05 xcpc/xcpc_pipeline.py" --check         # ④ 出包 + 体检
> ```

> **重复导入会重复**：应用导入是**加法**。改过身份（如 `cf104813` → `ccpc2023harbin`）
> 或想彻底重来时，**先把应用里那棵 XCPC 子树删掉**（或从空数据导入），再拖新包。

---

## 0.1 完整流程（以 PTA 上的一场为例，端到端）

**① 抓原始数据**（PTA 页面上，浏览器 F12 → Network）

| 要什么 | 找哪个响应 | 存成 |
|---|---|---|
| 权威榜单 | 返回 `xcpcRankings` / `competitionBasicInfo` 的那个 | `acm-data/raw/Scaper/03 PTA/<自己取名>.json` |
| 本队逐条提交 | 返回 `{total, submissions, teamInfo}` 的那个 | 同上目录（如 `ec2_teamsubmissions.json`） |
| 题名 + 链接 | 不用抓：rankland 的 srk | `python "…/05 xcpc/fetch_rankland_srk.py" <slug>` → `05 xcpc/cache/<slug>.srk.json` |
| 每题难度（ratio） | 不用抓：xcpcio（若它收录了这场） | `python "…/05 xcpc/build_xcpcio_index.py"` + `xcpc_registry.py xcpcio --write` |

⚠️ 提交响应是**某一个队**的（PTA 没有公开的"某人全部提交"接口，要登录态）。
要哪一队的，就在那个队的提交记录页面上抓。

**② 登记场次**：在**注册表** `xcpc_registry.json` 的 `contests` 里加一条
（`board` = 榜单、`sources` = 题名/时间、`submissions` = 提交，见第 1 节与 §4.4）。
**③ 出清单 + 跑流水线**
```powershell
python "…/05 xcpc/xcpc_registry.py" build      # 注册表 → 清单
python "…/05 xcpc/xcpc_pipeline.py" --only <slug,slug>   # **只重跑这几场**、但合并全部已有片段（秒级；清单没改时用它）
python "…/05 xcpc/xcpc_registry.py" build --dry-run   # 只预演：谁进树、谁出树
npm run crate:xcpc -- --list                  # 确认清单读到了
npm run crate:xcpc                            # → acm-data/nodes/mix_contain_xcpc.json（+ 各类包）
```

**④ 体检**
```powershell
npm run crate:check -- acm-data/nodes/mix_contain_xcpc.json
```
记录数对得上、**错误 0** 就可以用。警告里"标题高度相似"多半是"第一场/第二场"这种，无害。

**⑤ 应用里导入**：📥 节点自动导入 → 选 `acm-data/nodes/mix_contain_xcpc.json` → 执行。
（要一次导全树、**并且带上合成节点**，就选 `all_nodes.json` —— 合成节点由链上 `synth-bind.mjs` 直接写进它。）
提示里会写「归认：认出 N 条」——**0 条说明账户映射还没填**。
⚠️ **导入是加法**：更新过包（换榜、补字段、加场次）之后要**先删掉应用里那棵 XCPC 子树**再导，
否则旧节点会重复。

**⑥ 账户与归认（PTA 这条链的关键一步）**
1. 账户管理 → 新建账户（例如「TEAM0-2026」）；
2. 填映射：`pta:icpc2026 : 队伍 = TEAM0`（`source` 带赛季，见下方「队名重名怎么办」）；
3. 点 **「🔁 用当前映射重跑归认」** → **已经导进来的**值也会被认领。

> 映射是"先有数据后补"也能救的：导入完发现认不出，补映射 → 重跑归认即可，不用重导入。

**⑦ 验证**
- 树上：题目状态（有 R 才推得出"过了/没过"）；
- 编辑弹窗里每个字段的来源行（ⓘ）：看得到 `← 来源 · 👤账户名`；
- 📊 数据统计 → **👥 账户对比**：勾选账户并排看各自的补题情况。

### 0.2 六个来源：各自给什么、怎么拿、自动化到哪一步

| 来源 | 给什么 | 怎么拿 | 自动化 |
|---|---|---|---|
| **rankland(srk)** | P 的**题名 + 链接**（+ 身份键），也能当榜单算 ratio（`--role board`） | `npm run crate:xcpc:tree` 拿 slug；`fetch_rankland_srk.py <slug>` 下载 | ✅ **全自动**（GitHub 拉，`cache/<slug>.srk.json`） |
| **PTA** | 权威**榜单**（本题通过队伍数）+ 本队**逐条提交** | `pta_rankings_fetch.py --slug <slug>`（**公开接口，不用登录**；slug 得自己知道） | ✅ **全自动**（榜单）；本队提交仍需 F12 存页面 |
| **牛客** | 权威**榜单**（XCPC 赛制：每题过队数、有人数分母）—— 省赛/邀请赛偶尔挂在牛客上 | `nk_rankings_fetch.py --slug <slug>`（**公开接口**，会自己翻完所有页） | ✅ **全自动** |
| **QOJ** | **个人**提交（含"提交者"，能认到人）**+ 题面链接/题名** | `--fetch` 用 cookie 自动抓；没 cookie 就存页面 → `04 qoj/QOJ_submissions_scraper.py` 解析 | ✅ **全自动**（me.json 填了 `qoj.cookie`；**`--fetch` 2026-10-15 起挂在重建链第 2 步**，见 `docs/scraper-guide.md`）/ ◐ 没 cookie 时手动存页面 |
| **CF** | 三种角色：<br>①`board` = **gym 的题单 + 通过率**（需登录）<br>②`titles` = 只出**题名/题链接**（xcpcio 当榜单时用）<br>③`submissions` = **你个人的提交**（公开） | 公开 API + `me.json` 里的 `cf.apiKey/apiSecret` | ✅ **全自动**（凭据配好之后） |
| **xcpcio** | **每题 ratio**（权威）+ 赛名/开赛时间/题号表（**没有题名**） | `build_xcpcio_index.py` 建索引；`xcpc_registry.py xcpcio` 把场次对到目录；榜单明细按需下 | ✅ **全自动**（公开仓库，无需凭据）—— 见 §2.1 |

> **个人信息全在 `acm-data/raw/Scaper/me.json` 一个文件里**（CF handle/密钥、QOJ cookie、
> PTA 队名）。脚本一律先读它，
> 环境变量（`CF_API_KEY`/`CF_HANDLE`/`QOJ_COOKIE`/`PTA_TEAM`）可以临时覆盖。
> `python "acm-data/raw/Scaper/lib/me.py" --show` 原样查看、`--check` 联网验证。
> **它等同于你账号的权限，别外传、别同步到公开目录。**
> 只有 `contest.standings`（gym 榜单）需要 CF 密钥；提交（`contest.status`）不需要。
>
> **CF 通过率的口径**：`ratio = 通过队伍数 ÷ 有效队伍数`（与 PTA/HDU 同一算法），
> 但 gym 的榜**含虚拟参赛**，人数比现场赛多，算出来会**偏低** —— 与官方榜不同源，
> 这一点写在产出条目的 note 里，不假装同源。

**怎么判断一场该挂哪些来源**（看 srk 里每道题的 `link`）：
- `codeforces.com/gym/<号>/problem/<X>` → 这场在 **CF gym** 上：挂 `cf`（`gym` 号就是它），身份键自动是 `cf:gym:<号>:<X>`；
  ⚠️ 必须给 `handle`（`me.json` 的 `cf.handle`）—— 整场 gym 上万条，全导会让树上挂满 R；
- `qoj.ac/problem/<pid>` → 这场在 **QOJ** 上：提交从 QOJ 拿，身份键自动是 `qoj:<pid>`；
- 原始**榜单**在谁那儿：srk 的 `refLinks` 写着（如 `pintia.cn/rankings/...` → PTA）；找不到就用 srk 自己当 board；
- **想不想要权威难度档**：先在 xcpcio 里找这场（`xcpc_registry.py xcpcio`）——
  对上就把 `board` 交给 xcpcio（另一份榜单降级成补充来源，见 §2.1/§4.4）；
- **PTA 的提交是"按队"的**（只有队名），CF/QOJ 是"按人"的 → 要区分队友只能靠后两者。

**QOJ 那条链**：
```powershell
# ① 自动抓（推荐）：me.json 里有 qoj.cookie 就行
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --contest 4113
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --all   # 清单里所有挂 qoj 的场次
#    没 cookie 的老办法：浏览器 Ctrl+S 存页面，然后不带 --fetch 跑同一个脚本。

# ①b 按人抓（**多人 / 队友 / 任意账号**）—— 推荐用这个，别用上面的 --contest
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter "someone,kongcheng_lige"
#    走全局列表页 /submissions?submitter=<用户名>：**一份我自己的 cookie 就能看任何人的全历史**，
#    而且**比场次页多一列"语言"**。不给 --submitter 时用 me.json 花名册里的 qoj 账号。
#    ⚠️ 这个页面**不认 `contest=`** ⇒ 按人抓就是**全量**（场次归属由列表里的 /contest/<id> 链接决定），
#       `--contest/--all` 与 `--submitter` 同给时**不过滤**（脚本会明说）。

# ①c 全局列表页给的题目链接是**全局题号**（`/problem/<pid>`，不含场次）⇒ 那批提交认不出场次。
#    补场次号：去**题面页**看 "The problem was used in the following contests:"（公开页、不用 cookie），
#    把**第一场**写进记录的 `场次号`（全部候选留在 cache/qoj_problem_contests.json，页面也归档）
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --resolve-contests
#    实测 23 条 × 12 题全部认出来了（22 条落到已收录的场次，1 条带出一个新场次 1365）

# ①d 读取的**两维模式**（`acm-data/raw/Scaper/lib/read_modes.py`）：
#    缓存：none（不缓存，每次联网，抓到仍入库）/ keep（缓存；无新值**不**截断）/ stop（缓存；无新值**截断**）
#    重试：retry（默认，失败再试 3 次、退避翻倍）/ once（只试一次）
#    每个读取点已有默认值（见该模块文件头的索引表）；临时翻转用这两个开关：
#      --cache-mode keep   # 例：把提交列表**翻到底**，顺便把每页原料都归档
#      --retry-mode once   # 例：只想知道现在通不通
#    ⚠️ **全局提交列表是"活列表"**（内容随新提交变），所以它的三个模式**各有明确用途**：
#      --cache-mode stop   #（默认）**联网**取最新，一页全是旧提交就停 —— 日常增量（通常 1 个请求）
#      --cache-mode keep   # 有归档用归档、没有才联网，不截断 —— **补归档 / 断了接着补**（已抓的不重抓）
#      --cache-mode none   # 联网且不读归档，不截断 —— 强制刷新
#    它**不能**拿"读归档"当日常增量：第 1 页的归档是**上次的快照**，读它就会永远判"已是最新"。

# ①e 补全球局提交列表的**原料归档**（someone 75 页 / kongcheng_lige 18 页 / teammate_b 8 页 = 101 页）
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter "someone,kongcheng_lige,teammate_b" --max-pages 150 --cache-mode keep
#    每页入库 cache/pages/submitter-<名字>[.pN].submissions.html。QOJ 连翻十几页后会掐连接
#    （RemoteDisconnected / SSL / 读超时），所以多半要**再跑一遍接着补** —— keep 会把已归档的页
#    读本地、只补缺口，很便宜（实测第二轮 1 个请求就确认到底）。
#    它同时会把新提交并进 qoj_submissions.json（**千万别加 --replace**）；数据变了要重出片段：
#      npm run crate:xcpc:qoj   →  npm run crate:check -- acm-data\nodes\mix_contain_xcpc.json
#    （场次列表页 contests.p<N>.html **不用补**：实测 /contests?tab=all 不分页，p1 就是全部 3506 场）

# ② 解析成 JSON（默认**合并**：一份文件装多场；同 提交ID 覆盖、新的追加）
py "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py"
#    可选：-i 某场.html -o 我的提交.json ｜ --replace 覆盖写 ｜ --dry-run 只看解析
#    跑完会打印「比赛号分布」—— 清单里的 contest 号就照它填

# ②.5 题号字母（**全局提交列表只给题目数字 id**，而应用里 R 的父节点是 p:<字母>）
#     `--fetch` 会顺手补；`--archive`/`--category` 那条**解析归档**的路也会补。
#     补法 = 抓 `https://qoj.ac/contest/<id>`（比赛题目列表页，1 个请求列全场题目）。
#     ⚠️ **只有一份缓存** `04 qoj/cache/qoj_contest_problems.json`
#     （题目清单本身：{ 比赛号: { 题目id: {letter, name, link} } }），`qoj_adapter.py`
#     自动读它。
#     不补的话，那些记录的父题目定位不到，适配器会跳过并提示。
```

> ⚠️ **三条实测踩过的坑**（`04 qoj/QOJ_submissions_scraper.py` 文件头也写了）：
> 1. `/contest/<id>/submissions` **只列登录者自己的提交**，`?submitter=<别人>` 会被**忽略**
>    （拿队友名字去查，回来的还是我自己的记录）→ 想看别人的**只能用全局列表页**；
> 2. **没有 cookie 一条都拿不到**：匿名访问一律回一个 12 KB 的占位/登录页（不是 403）；
> 3. 全局列表**时间倒序**、翻不到早年底 → **多人抓取千万不要加 `--replace`**
>    （实测把旧 706 条历史抹成了 250 条）。想强制翻到底就把 `-o` 指到一个**空文件**，
>    再用 `python "acm-data/raw/Scaper/04 qoj/merge_qoj_cache.py"` 按 `提交ID` 求并集合并回来
>    （它会用新记录的 `使用语言` 回填旧记录）。
>    ⚠️ **这条救援要先有一份旧缓存**：用它 `--old <旧文件>` 指过去 —— 仓库里**不带**这种备份
>    ⇒ 想以后能救，抓之前自己留一份。

```powershell# ③ 清单里挂上（同一个文件里混着多场也能按 contest 分开）：
#    { "source":"qoj", "role":"submissions", "file":"…/qoj_submissions.json", "contest":"4113" }
```
题目列表同理：`QOJ_problems_scraper.py`（默认读 `qoj_contest.html`、合并写 `qoj_problems.json`）。

> ⚠️ **存了新页面一定要重跑脚本**：不然 `qoj_submissions.json` 会落后于页面，
> 页面里有的**赛后补题**记录根本没进树，"补题情况"就会少显示。
> 合并是幂等的：内容没变会直接说"未重写文件"。

**CF gym 那条链**：
```jsonc
// 清单里只需要 gym 号（handle 从 me.json 的 cf.handle 来，生成器会写进 defaults.cfHandle）
"submissions": [ { "source": "cf", "role": "submissions", "gym": "106701",
                   "file": "acm-data/raw/Scaper/05 xcpc/cache/cf_106701_<handle>.json" } ]
```
跑流水线时自动查 API 并缓存；**0 条是正常结果**（不产出片段，如 2026 第二场打在 PTA 上）。
想重抓就删缓存文件或 `--handle X`；离线用 `--no-fetch`。

**CF 正式比赛那条链**（**≠ gym**，也不走清单）：

```powershell
# 一句命令出整棵树（一个片段）——me.json 里有 cf.handle（或花名册 team[].cf）就行
py "acm-data/raw/Scaper/05 xcpc/cf_contest_adapter.py"
#    → cache/crate_cf_contest_tree.json（TREE_SOURCES 里的 'cf-contest'）
py "…/05 xcpc/cf_contest_adapter.py" --force            # 重抓比赛页 + 刷新 API 缓存
py "…/05 xcpc/cf_contest_adapter.py" --max-contests 12  # 调试：只出最近 12 场
py "…/05 xcpc/cf_contest_adapter.py" --handle a,b       # 临时指定账号（可逗号分隔；默认问**花名册里所有** CF 账号）
```

- **范围**＝"我提交过哪些正式比赛" ∪ 同轮伙伴场（`scope.py` 的 `union_scope`；判"同轮"用开赛时刻相同 + 去 `(Div. N)` 后赛名相同）⇒ **不需要人维护清单**；
  ⚠️ "我"是**花名册里每个 CF 账号的并集**（逐个 `user.status`）—— 只问第一个人会把队友一个人打过的场次**整场漏掉**（2026-10-15 修）；
- **原料**都在 `cache/cf_contest/`：比赛页 `pages/<cid>.html`（KEEP，约 530 页 ≈ 44 MB）、
  题池 `problems.json`、比赛表 `list.json`、我的提交 `history_<handle>.json`；缺口明细 `incomplete.json`、
  共用题对应关系 `reuse.json`（见下）；
- **每场题单以比赛页为准**（`https://codeforces.com/contest/<cid>`：一个大 `<tr>` 里每 4 个 `<td>` 一组，
  `td[0]` 是题号锚、`td[1]` 才是**同一个 href 的真题名**）；抓不到就退回题池并**明确警告**
  —— 公开 API 拿不到"某场完整题单"（`contest.standings` 对非 gym 是 **admin-only**、比赛页曾整段反爬）；
- **共用题**（例：2268B 和 2269D 本质是同一道题，但在链接上看不出）：
  CF 公开 API 里**没有 polygon 源题 id**（`Problem` 只有 8 个字段）、Polygon 无权限 ⇒ 判据只能是
  **同一轮 + 官方题名相等**，且"题池里拥有该名字的那场"算**老家**。**每场出自己完整的题单**
  （两边各留一份 P：`cf:c:2268:p:B` 与 `cf:c:2269:p:D`），对应关系写 `cache/cf_contest/reuse.json`
  （形状 `{"2269:D": "2268:B", …}`），留给以后判重 / AC 统计用；R 挂**我实际参赛那场**的 P；
- **题序**：`xcpc_common.letter_sort()` —— 只有 `EX` 垫底（`EX/EX2/EX10` 一组），其余**自然序**
  ⇒ `E < E1 < E2 < E10 < F < F2`，纯数字题号按数值 `1 < 2 < 10`；
- **难度**：`cfDifficulty` 取题池 `rating`；本场条目没有就按"同轮 + 同名"到**老家**借
  ⇒ 实测覆盖 3648/3693。⚠️ **缺失不是负结论**（不写空串、不缓存"这题没难度"），下次 `--force` 自然再试。

**AtCoder 那条链**（同样不走清单）：

```powershell
py "acm-data/raw/Scaper/05 xcpc/atcoder_adapter.py"
#    → cache/crate_atcoder_tree.json（TREE_SOURCES 里的 'atcoder'）
py "…/05 xcpc/atcoder_adapter.py" --no-official-tasks   # 跳过官方题表页，离线快跑
```

- 前置：`me.json` 里加一行 `"atcoder": { "handle": "…" }`（没 handle 时**出一个空片段、不连累整包**）；
  多账号可写 `"handles": ["a", "b"]` / 花名册 `team[].atcoder` —— 逐个抓（各自一份
  `submissions_<handle>.json`），提交的线索写**它自己的 `user_id`**；
- **数据源**（AtCoder Problems 公开 API，无需登录）：`resources/contests.json`（6494 条）、
  `resources/problems.json`（9605 条）、`user/submissions?user=<handle>&from_second=`（**每页 500 条**，增量按水位线续抓）；
  缓存都在 `cache/atcoder/`；
- **题号以官方题表页为准**：`https://atcoder.jp/contests/<cid>/tasks`（KEEP 归档在 `cache/atcoder/pages/<cid>.tasks.html`）。
  ⚠️ **为什么不能只看 `problems.json`**：它会把老题的**老家改挂到配对场** —— 实测 `arc070_a/b` 的
  `contest_id` 成了 `abc056`、`problem_index` 成了 C/D，于是 ARC 070 的题号会出成 `A,B,E,F`
  （真值 **C,D,E,F**）。抓不到官方题表时就退回推断，并**逐条警告 + 一行汇总 + 明细
  `cache/atcoder/letter_warnings.json`**；
- 树：**顶层** `O ─(W)atcoder`（`xcpc_common.PLATFORM_TREES`；**AtCoder 不挂在辅助节点里**），
  层为 `S=系列(abc/arc/agc/ahc/other，按 contest id 前缀客观分类) → C → P → R`；
- 题序同上（`EX` 垫底）；P 出该场**全部**题目。

### 0.2.1 QOJ 原料一览（抓什么 / 什么模式 / 谁在用）

两层：**页级原始归档**（`04 qoj/cache/pages/`，现 543 页 ≈ 10.4 MB）＋ **解析出的 JSON 缓存**。
网页怎么变都不用再碰网络 —— 网络的边界就停在归档这一层。

**表 A：页级读取点**（全部走 `Scaper/lib/read_modes.py` 的 `read_page`，唯一入口）

| # | 原料（网址） | 缓存×重试 | 归档名 | cookie | 入口命令 | 停法 / 判据 |
|---|---|---|---|---|---|---|
| 1 | 场次页 `/contest/<id>` | KEEP×RETRY | `<id>.contest.html` | 带 | `--archive`（`--category` 走同一条路）；补字母/时间格式时按需 | accept = 不是登录页；题单偶有增补 ⇒ `--force` |
| 2 | 场次提交页 `/contest/<id>/submissions` | **列表读 STOP**；单页原料 KEEP；判时间列 NONE | `<id>[.pN].submissions.html` | **必须** | `--archive`（只抓"我提交过"的场次）、`--fetch --contest`、`--timefmt` | 时间倒序 ⇒ **整页已知就截断**；页里只有我自己的行。⚠️ 判"赛时/补题"时必须联网 |
| 3 | 分类页 `/category/<id>` | KEEP×RETRY | `category.<id>.html` | 公开（显式不带） | `--category`（BFS 遍历整系列，≤500 页） | 无 `Location:` 面包屑会拒 |
| 4 | 场次列表页 `/contests?tab=all[&page=N]` | **NONE**×RETRY | `contests.p<N>.html` | 公开（顺手带） | `--list` | 主站 `qoj.ac` → 镜像 `huang.lt` → `jiang.ly`；accept = **认得出场次**；**活列表**（QOJ 天天加场）⇒ 每次联网，只 1 个请求 |
| 5 | 题面页 `/problem/<pid>` | KEEP×RETRY | `<pid>.problem.html` | 公开 | `--resolve-contests` | accept = 登录页；归属取**第一场** ⇒ 后被镜像再用不影响 |
| 6 | 用户主页 `/user/profile/<u>` | **NONE**×RETRY | `<u>.user.html` | 带 | `--participation` | **活页**（VP 只增不减）⇒ 每次联网，3 个请求 |
| 7 | 全局提交列表 `/submissions?submitter=<u>`（⚠️ **不认 `contest=`**：带上也只是同一份全量列表） | **活列表**：`stop` 联网+一页全旧就截断（默认）／`keep` 归档优先+不截断／`none` 联网+不截断 | `submitter-<u>[.pN].submissions.html` | **必须** | `--fetch` + `--submitter/--url/--contest/--all`（后两个与 `--submitter` 同给时**不过滤**） | 时间倒序；页码越界会**重复末页** ⇒ "本页无新提交"必须早于"空页"判 |

> **判据只有一条：这页/这个缓存的内容会不会变？**
> 会变（活数据：提交列表、VP 名单、场次列表、QOJ 索引）⇒ **日常读取必须联网**（`NONE`），
> 归档只是「原料」＋「断了接着补（`KEEP`）」；不变（场次页、分类页、题面页、榜单、索引里的 sha）
> ⇒ `KEEP`，要刷新时用 `--force`。

> 重试维处处都是 `RETRY_RETRY`（3 次、退避翻倍），临时翻转 `--retry-mode once`。
> #7 是唯一例外：**日常增量必须联网**，第 1 页归档是上次的快照，当缓存读就永远看不到新提交。
> `--fetch --contest <c>` 走的是 #7 同一个函数，只是网址换成 `/contest/<c>/submissions`、key 就是场次号。

**表 B：JSON 缓存**（谁产、谁读）

| 缓存 | 来自 | 消费者 |
|---|---|---|
| `qoj_submissions.json`（993 条） | #7 / #2，按 `提交ID` **合并**（多人抓取**禁用 `--replace`**） | `05 xcpc/qoj_adapter.py` |
| `qoj_contest_problems.json`（3687 题 / 299 场） | #1 场次页（pid → 字母/题名/题面链接） | 适配器（P 的字母、R 的父节点） |
| `qoj_contest_titles.json`（3506） | #4 列表页 + #1 场次页（**零额外请求**） | 适配器（C 的名字） |
| `qoj_contest_categories.json` | #1 场次页 `Location:` 面包屑 | 适配器（S 路径） |
| `qoj_category_tree.json`（300 场 / 81 分类） | #3 分类遍历（比赛集合 = 并集 + 分类归属） | 适配器（**QOJ 包的比赛集合**） |
| `qoj_vp_contests.json` | #6 用户主页 | 适配器（判 VP / 赛时） |
| `qoj_contest_timefmt.json`（37 场） | #2 场次提交页「提交时间」列格式 | 适配器（赛时 / 补题） |
| `qoj_problem_contests.json`（12 题） | #5 题面页 `used in the following contests` | **只有 04 自己**（`contest_of_record` 认场次） |

> 这三层（模式 × 归档 × 强制）全在**通用区** `acm-data/raw/Scaper/lib/read_modes.py`：
> `Archive`（页级原料目录）＋ `add_cli_args(ap)`（挂上 `--cache-mode/--retry-mode/--offline/--force`）
> ＋ `configure_from(args)`（让它们对本次运行生效），自己管 JSON 缓存的渠道用
> `should_refetch(本地有吗)` / `retry_call(抓一次的函数, …)`。**任何渠道照文件头那三段抄就能接**。
>
> **`--offline`**：一次也不联网、只用本地缓存/归档，**缺文件当场报错**
> （`require_local()`，绝不静默出一份缺数据的包）；与 `--force` **互斥**。
> 流水线那种"父进程跑一堆子进程"的场景用环境变量 `ACM_READ_OFFLINE=1` 传（子适配器的
> argparse 五花八门，逐个拼命令行必然漏）。实测 `xcpc_pipeline.py --all-nodes`
> **110s → 92s** —— 省的是联网那几笔，**大头是 518 个子进程（~80s），离线省不掉**。
>
> **已经接上的渠道**（`--force` / `--cache-mode` / `--retry-mode` / `--offline` 到处是同一个词）：
>
> | 渠道 | 形状 | 开关 | 备注 |
> |---|---|---|---|
> | `04 qoj/QOJ_submissions_scraper.py` | 页级归档 `cache/pages/` | 通用三件 | —（本来就是它定的） |
> | `05 xcpc/build_xcpcio_index.py` | 每场 `config.json` + sha | 通用三件 | — |
> | `05 xcpc/build_rankland_index.py` | 一个 JSON（自己的产物） | 通用三件 | — |
> | `05 xcpc/xcpcio_adapter.py` | 每场 `{config,run,team}.json` | 通用三件 | — |
> | `05 xcpc/cf_board_adapter.py` | 每场 `cf_standings_<gym>.json` | 通用三件 | — |
> | `05 xcpc/fetch_rankland_srk.py` | 每场 `<slug>.srk.json` | 通用三件 | — |
> | `05 xcpc/pta_rankings_fetch.py` / `nk_rankings_fetch.py` | 每场榜单 JSON | 通用三件 | —（只有 `--missing` 选择器） |
> | `05 xcpc/xcpc_registry.py` | `cache/qoj_categories.json` | **例外**：`scan --refresh-categories` | 它自己的 `--force` 是"重建注册表"，不能重名 |
> | `05 xcpc/cf_contest_adapter.py` | 每场比赛页 `cache/cf_contest/pages/<cid>.html` + 题池 JSON | 通用三件 | — |
> | `05 xcpc/atcoder_adapter.py` | 每场官方题表页 `cache/atcoder/pages/<cid>.tasks.html` + 三份 JSON | 通用三件 | — |
> | `05 xcpc/cf_adapter.py` | 白名单勾选 / rankland / **全量元信息里判得出 XCPC 的** / 我的提交 | 通用三件 | —（`--scope-report` 顺手报告范围；`--gym-meta` 刷全量元信息） |
> | `01 nk/backfill_nk_contest_times.py` / `02 hdu/Hdu_contest_times.py` | 每场窗口 `cache/<平台>_contest_times/<cid>.json` | 通用三件 | — |
>
> **不需要接的**：`01 nk` / `02 hdu` 的 `*_scraper.py` 与 `03 PTA` 全都是**读你手工存下来的
> HTML/JSON**（没有网络缓存这一层）。
> **自带重试的**（不套 `retry_call`，免得变成乘法）：`cf_api.call`、`xcpcio` 的 `_get`、
> `rankland` 的 `_get_head` 与 `fetch_config_text`、`fetch_raw`。

**想强制重爬？** 用通用层的 `--force`（**语义只有一条：把归档当成不存在**）——
读页时联网，而且那些"还欠哪些"的判据（`ARCHIVE.has`）**也自动变成"全部重抓"**，所以
"重爬某一类"和"重爬类里某几个值"是同一个开关，只是范围选择器不同：

```powershell
py "…/04 qoj/QOJ_submissions_scraper.py" --archive --contest 4071,1303 --force   # 这一类里的这两个值
py "…/04 qoj/QOJ_submissions_scraper.py" --archive --force                        # 这一类全部（299 场次页 + 46 提交页）
py "…/04 qoj/QOJ_submissions_scraper.py" --resolve-contests --force               # 题面页归属整类重查
py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter someone --cache-mode none   # 活列表：联网取最新
```

`--cache-mode {none,keep,stop,offline}` / `--retry-mode {once,retry}` 也一起被铺到**所有**读取点：
不给就按各读取点自己声明的默认（见 `read_modes.py` 的表），给了就**盖过所有默认**。
（`--force` 与"删归档"效果等价；能一条命令说清就别去动文件 —— 手删容易删错。
`offline` = **只用本地、绝不联网**，缺文件当场报错 —— 用在"反复重跑加工、不想再抓一遍"时。）

| 要重爬的东西 | 怎么做 |
|---|---|
| 整类页 | `--force` 加该类命令：场次页/提交页 `--archive`（可配 `--contest a,b` 或 `--category 205`）、分类页 `--category --force`、列表页 `--list --force`、题面页 `--resolve-contests --force`、用户主页 `--participation --force`、时间列 `--timefmt --force` |
| 类里某几个值 | 同一个命令加 `--contest 4071,1303`（或 `--submitter 某人`） |
| 全局提交列表（活列表） | `--fetch --cache-mode none`（联网、不读归档）；要翻到底再加 `--max-pages 150`（`keep` = 归档优先，用来接着补） |
| 05 侧的片段（不是重爬页） | `xcpc_pipeline.py --force`（重跑已有片段）、`fetch_rankland_srk.py --force`、`xcpc_registry.py --force`；或 `npm run crate:xcpc` 全量 |
| **不联网重跑**（缓存都齐了，只想重新加工） | `xcpc_pipeline.py --all-nodes --offline`（110s → **92s**；缺文件会当场报错，不会出缺数据的包） |
| ⚠️ **别删** | `qoj_submissions.json`（993 条积累，删了要重爬全部历史）；`qoj_contest_titles.json` / `qoj_contest_problems.json` 同样是**积累**的 —— 删整个文件只有这轮路过的场会被填回，其余场次的名字/题号会丢。要重算就加 `--force`，别删 JSON |

### 0.2.2 产出层：**一个类一个包**

`xcpc_pipeline.py` 的产出方式是：
**按片段来源分组 → 每类各跑一次 `crate-merge` 出一包 → 最后把"含 XCPC 的那几类"
合成 `mix_contain_xcpc.json`**（`--all-nodes` 再追加 atcoder / cf-contest / 牛客多校 / 杭电多校
成 `all_nodes.json`）。**以后要"组成 XCPC 类"就在这一跳加料**。
（**合成节点不在这一跳**：它们由链上后面的 `synth-bind.mjs` 按 nature 建、直接写进最终包。）

> ⚠️ **`mix_contain_xcpc.json` 的含义**：qoj 与 cf gym 里也有大量**非 XCPC** 的内容，
> 所以名字不叫 `xcpc`；它**排除** `atcoder` 与 `cf-contest`（各自是独立的树）。

| 包（都在 `acm-data/nodes/`） | 内容 | 实测条数 |
|---|---|---|
| `qoj.json` | QOJ 整棵树（`crate_qoj_tree.json`） | 5032 |
| `cf-gym.json` | CF gym（各场 `_cf_submissions/_cf_titles/_cf_board/_cf_website` 片段） | 2447 |
| `cf-contest.json` | CF **正式比赛**（`crate_cf_contest_tree.json`） | 8656 |
| `atcoder.json` | AtCoder（`crate_atcoder_tree.json`；树挂**顶层** `atcoder`） | 529 |
| `xcpcio.json` | xcpcio 各场片段（树 `aux → aux-xcpcio`） | 1551 |
| `rankland.json` | rankland 索引 + refs（树 `aux → aux-rankland`） | 1958 |
| `pta.json` | PTA 榜单（树 `aux → aux-pta`） | 233 |
| `srk.json` | srk（树 `aux → aux-srk`） | 32 |
| `nk-ranklist.json` | 牛客**榜单**（当 ratio 源；树 `aux → aux-nk`） | 31 |
| **`mix_contain_xcpc.json`** | 7 个 XCPC 来源包（**不含合成节点**） | 12293 |
| **`all_nodes.json`** | 上面那份 + `atcoder` + `cf-contest` + 两个多校包（`--all-nodes`，**可选**；**合成节点在其中**） | 26921 |

- **合成节点（容器 + 组头 + 成员指针）没有单独的包**：链上 `scripts/synth-bind.mjs` 按 nature
  建出来、直接写进最终包 `all_nodes.json`（`ownerSynth` 指向的 C 也在同一份里 ⇒ 一次导入即可）。
  规则与重跑条件见 `docs/field-rules.md` 与 `scripts/synth-bind.mjs` 的文件头；
- 片段 → 类 的映射**一处声明**（`xcpc_pipeline.py` 的 `SUFFIX_CLASS` / `TREE_CLASS`）；
  出现**没匹配上的后缀**会**大声警告**并列名；
- **本轮没产出的类不删**（旧产物可能是唯一能导入的一份）⇒ 打印「⚠️ 本轮没有产出 X 类 —— 旧产物
  `nodes/X.json` 仍在，**可能是过期数据**」并落一个 `X.json.stale` 标记；`other` 那种"根本不是类"的
  遗留才允许清；
- **`hdu` / `nk` 多校是另外两个包**（`hdu-multi-university.json` / `nk-multi-university.json`，
  各由自己的流水线出，见各自 `_usage.md`）—— 它们不在 `xcpc_pipeline` 的类集合里；
- ⚠️ **要合成节点就得走整条链**（`npm run crate:all`）：`mix_contain_xcpc.json` 只是抓数出来的
  混装包，**不带**合成节点；`all_nodes.json` 由整条链产出时才有它们；
- 逐份拖（+ 最后拖 `all_nodes.json`）or 直接拖 `all_nodes.json`，**最终效果一致**。

### 0.2.3 抓取范围 = **指定范围 ∪ 有提交**（通用件）

**各渠道的爬取范围都可以套入"指定范围与有提交取并集"的逻辑**，并把这个逻辑用代码具现化。
实现落在**通用区** `acm-data/raw/Scaper/lib/scope.py`：

```python
union_scope(*, explicit=None, mine=None, name='') -> set   # 并集 + 一行"显式 N ∪ 提交 M = K 场（重叠 J）"
split_by_origin(*, explicit=None, mine=None) -> dict      # {k: both|only_explicit|only_mine}，给"要标注来源"的渠道
```

- **已接**：`cf_contest_adapter.py`（explicit=同轮伙伴场，mine=我打过提交的正式比赛）、
  `atcoder_adapter.py`（只有 mine）、`04 qoj/QOJ_submissions_scraper.py`（explicit=`--category` 收来的系列场次，
  mine=提交文件里出现过的场次）、`cf_adapter.py`（explicit=白名单勾选 ∪ rankland 标的 gym 号
  ∪ **全量元信息里判得出 XCPC/UCup 的 gym**，mine=我提交过的 gym）；
- **有意不接**：`xcpc_registry.py`、`pta_rankings_fetch.py` / `nk_rankings_fetch.py`
  —— 它们的"选场"不是一张场次集合（注册表是候选/待决模型；两个抓取脚本选的是"本渠道还没有 ratio 的"）；
- **gym 的来源标注**：`py "…/05 xcpc/cf_adapter.py" --scope-report` 会打
  「候选 N 场 → 实际进包 M 场」并写 `cache/cf_gym_scope.json`
  （`{gym: whitelist/rankland/按分类/我的提交/组合}`），还**显式打印"其中 N 场我没有任何提交"**
  （那些是**名单带来**的：白名单勾选 / rankland 标的 gym 号 / 按分类收进来的）。
  ⚠️ **范围大 ≠ 进包多**：进包还受**清单**过滤（`cf_adapter.py` 的"实际进包 = 清单里被任何 cf 来源
  引到的 gym"）—— 两道闸门，缺一不可。
- **全量 gym 元信息（`cache/cf_gym_meta.json`）**：`py "…/05 xcpc/cf_adapter.py" --gym-meta` 产出
  ——`contest.list?gym=true`（**公开、一次调用**）给全 `id/赛名/开赛时间/时长/phase`，再顺手用
  `cf_board_adapter.gym_class_rule()` 存一份**赛名分类**。几百 KB，覆盖 CF 上全部 gym。
  它是"**按分类筛范围**"与"**候选区吃全量**"的数据源：`cf_adapter.py --scope-report` 和
  `xcpc_registry.py scan` 都读它（没有这份文件时两者退回旧口径，不会报错）。
  ⚠️ **只是元信息**：题目与每题过题数（ratio）要 `contest.standings`（需登录、每场一请求），
  仍然按场次抓，不在这里、也不全量抓。
- **CF gym 的「推荐 → 人批准」**：`py "…/05 xcpc/xcpc_registry.py" scan` 把**判得出分类**的 gym
  全提成候选（分类就来自上面那份元信息），`suggest_of()` 再标出**建议收**的
  （`cf/gyms/xcpc/icpc/ec/…` EC 赛区 / `cf/gyms/xcpc/ccpc/…` CCPC 系列 /
  `cf/gyms/xcpc/provincial&invitational/…` 省赛·邀请赛那 3 类），**脚本不自己拍板**：
  · **搜**：`xcpc_registry.py find --suggest`（可加关键词 / `--year` / `--cls` / `--source`；
    `--limit 0` 看全部；默认只看未决的，`--answered` 把答过的也带上）
  · **批**：`xcpc_registry.py approve --suggest`（`--dry-run` 先预演）—— 归不到 rankland 的
    按**自造身份** `cf<gym>` 建条目并挂 cf 榜单（否则它们永远只能是"不导"）
  · **提醒在主脚本**：`build`（构建链第 1 步）会打「候选区还有 N 条建议收没拍板」+ 上面两条命令。
  · **这一轮的结论落哪儿**（2026-10-19 用户："这些也属于注册表，请尝试收纳"）：写进 **`05 xcpc/`**
    的 `cf_gym_recommend.md`（建议收）／`cf_gym_approve_2022-2025.md`（批准清单）／
    `cf_gym_judge_2022-2025.md`（逐条判断过程），与 `_usage.md` / `_rankland_slugs.md` 并排。
    ⚠️ **别写进 `cache/`**：`.gitignore` 把 `app/acm-data/raw/**/cache/` 整段忽略，而
    `clean-personal` 又会把 `.md` 当"文档永不删"留在发布副本里 ⇒ 结果是**副本里有、推上去的仓库里没有**
    （实测那一轮：副本 678 文件、`git add -A` 只暂存 675）。守卫：
    `selftest.py:test_no_docs_in_cache()`（`cache/` 里出现任何 `.md` ⇒ 红）。

### 0.2.4 难度（三个来源）与几条环境事实

| 来源 | 状态 | 怎么拿 |
|---|---|---|
| **CF 自带 rating** | ✅ 已接（`cfDifficulty`，实测覆盖 **3648/3693** 个 P） | 题池 `problemset.problems` 的 `rating`；本场没有就按"同轮 + 同名"到老家借（见 §0.2 的 CF 正式比赛那条链） |
| **kenkoooo 难度** | ⏳ 待办（等网络 + 定字段） | `https://kenkoooo.com/atcoder/resources/problem-models.json`（每题一个 `difficulty`） |
| **clist 难度** | ⏳ 待办（要 apiKey，且站点时好时坏） | clist.by；与 kenkoooo 是否同源**未核实** |

> ⚠️ **难度的共同性质**：**不一定有**，而且**出现时间乱序** ——
> CF 难度常在该题出现很久之后才补上，补的顺序也与出题时间无关。
> ⇒ 判据只能是"**每次重查还缺的那些**"，**缺失不许写成负结论**（不写空串、不缓存"这题没难度"），
> 下次 `--force` 自然再试。接 kenkoooo / clist 时也照这条来。

**环境事实**（排查时先看这里，别怀疑自己的改动）：
- **CF 公开 API 可能整段 404**（`contest.list`/`user.status`/`problemset.problems` 一起 404，
  与本地改动无关）—— 这时用**同源缓存**重建即可；恢复后跑一次
  `cf_contest_adapter.py --force` 补齐缺的难度与题单；
- **Polygon 源题 id 拿不到**：CF 公开 API 的 `Problem` 对象**没有**该字段（只有
  `contestId/problemsetName/index/name/type/points/rating/tags`），Polygon 又是登录态、无权限
  ⇒ 共用题只能按"同轮 + 官方题名相等"判（见 §0.2 的 CF 正式比赛那条链）。

### 0.3 批量导入"我的全部 CF gym 场次"

**命令就是 §0 的 ① → ② → ③ → ④ → ⑤ → ⑥**（那里已经是这条路的完整版，不再重复）。这里只留三点提醒：

- **白名单是你的判断落点**：`include: true/false` 决定导哪些；脚本只给默认建议，
  而它**尊重你的手改** —— 再跑 `fetch_my_gyms.py` 只刷新名字/年份/提交数，不动你的 include。
- **首次耗时**：每场 gym 两个请求（榜单 + 提交），脚本内置 0.7s 限速与限流退避。
  榜单只缓存"每题通过数 + 有效队伍数"的摘要（原始矩阵几十 MB，丢掉）。
- **产出**：每场 gym = C（比赛）+ P（完整题单 + 通过率）+ R（**只导你自己**的提交，带 `cf:handle` 线索）。

**注意两件事**：
- **身份**：批量生成的 gym 场次默认用 `cf<gym号>` 当 slug；跑过跨平台索引（下节 0.3.1）后
  会换成 rankland 的 slug，**同一场比赛不会两种身份都导**。
- **首次耗时**：57 场 × (榜单 + 提交) 两个请求，脚本内置了 0.7s 限速与限流退避；
  榜单只缓存"每题通过数 + 有效队伍数"的摘要（原始矩阵几十 MB，丢掉）。

---

### 0.3.1 跨平台整合：让同一场只留一条 ⭐

同一场比赛在四个平台各有一个号：CF 是 `gym/104813`，rankland 是 `ccpc2023harbin`，
QOJ 是 `contest/3799`，PTA 是 `pintia.cn/rankings/<id>`。它们之间没有任何算法能推出来的关系 ——
**rankland 的 srk 文件就是那张现成的对照表**（每题的 `link` + `refLinks`），
所以先把它抓成索引（= §0 的 ②③），再重生成清单（= §0 的 ⑤）：

```powershell
python "acm-data/raw/Scaper/05 xcpc/build_rankland_index.py"   # → cache/rankland_index.json
python "acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py" --list   # → 04 qoj/cache/qoj_contest_titles.json
python "acm-data/raw/Scaper/05 xcpc/gen_gym_manifest.py"       # 这一步才会用上索引
```

> `build_rankland_index.py` 394 场、每场只取文件头部 200KB（`problems` 在最前面）。
> **实测约 16 分钟（2.8–3.0s/场，0 失败）**：raw.githubusercontent 会被重置，
> 所以走 fastly.jsdelivr.net。**可随时 Ctrl+C** —— 每 25 场落一次盘，重跑自动增量续抓。
> 索引产物：`bySlug` / **`byGym`（gym号 → slug）** / `byProblem`（QOJ题号 → slug）。

有了索引，`gen_gym_manifest.py` 会把 gym 场次**换成 rankland 身份并整合来源**：

| 项 | 没有索引 | 有索引 |
|---|---|---|
| slug | `cf104813` | `ccpc2023harbin`（外部稳定身份，跨平台唯一） |
| 赛名 | CF 的英文名 | rankland 的**中文名**（英文名存进 `aliases.cf`，没丢） |
| 系列 / 年份 | 按英文名猜（邀请赛会另起一个"邀请赛"系列） | rankland 的层级（邀请赛归在 ICPC 年份下，与网络赛同层） |
| 榜单 / 链接 | CF gym（ratio 口径不变，C 链接 = gym 页） | 同左（一个字段一个来源：榜单给 ratio 与链接） |
| 提交 | CF 自己的 | CF 自己的 **+ QOJ 补题记录**（rankland 认出唯一 QOJ 比赛号时才挂） |
| 备注 | — | 条目的 `rankland` 里记着 rankland 的 refLinks（官方榜/公示）与层级路径 |

整合分两级，**只翻译、不猜**：

1. **gym 号**（索引的 `byGym`）—— rankland 里的题目链接直接指向 CF gym，最可靠。
2. **题目名集合** —— 索引里没有这个 gym 号时，拿 CF 榜单缓存里的题名与各场 rankland 题名比对
   （两边都是官方英文题名）。门槛：**重合率 ≥50% 且至少 5 题**，年份还要对得上（±1 年）。
   实测 11 个候选里 9 个是 100% 重合、2 个 8% 被拒 —— 拒掉的那两个会打印出来给你看。

规则：
- 索引里没有的 gym（老场次 / rankland 未收录）→ 完全退回兜底行为（`cf<gym>` + 英文名猜系列）；
- 与手工条目撞名的（如 gym 106701 = 网络赛第二场）→ **保持手工**，不会被覆盖；
- 跑完打印 `gym → slug → QOJ 比赛号 → QOJ 官方赛名` 对照表 + 题目名匹配明细。

> **典型结果**（白名单 57 个 gym）：40 个拿到 rankland 身份
> （31 个靠 gym 号 + 9 个靠题目名），17 个保持 `cf<gym>`（rankland 没收录的老场次：
> 2017/2018 ECL、Tsukuba、Yokohama、Macau、各省省赛等）。
> 那 17 个加 `--qoj-candidates` 会打印 QOJ 候选场次（**只是建议**：
> `EC Online Contest` 与 `EC-Final` 只差一个词，机器分不出来，宁可让你看一眼）。

> QOJ 的公开面只有"场次列表 + 分类树"两页：`/contest/<id>` 与 `/submissions` 未登录只回登录页，
> 所以提交仍然只能靠你 Ctrl+S 存下来（见 §0.2）。

### 0.3.2 把 QOJ 上的补题记录接到场次上 ⭐

`04 qoj/QOJ_submissions_scraper.py --fetch` 抓下来的是一份**跨比赛**的文件
（实测 706 条 / 41 场）。它自己不知道"这条属于清单里的哪一场"，但每条记录都带
`/contest/<id>/problem/<pid>`，而 rankland 索引里有 `题目id → slug` —— 于是可以自动接：

```powershell
python "acm-data/raw/Scaper/05 xcpc/link_qoj_activity.py" --dry-run   # 先看会改什么
python "acm-data/raw/Scaper/05 xcpc/link_qoj_activity.py"             # 真写清单
npm run crate:xcpc -- --check                                        # 重新出包
```

⚠️ **它是"旁路"，不是持久的那条路**（2026-10-15 实测踩到）：
**清单是注册表的渲染物** —— 构建链第 1 步 `xcpc_registry.py build` 会**整份重出**
`xcpc_contests.json`，从这里写进去的那几条**会被冲掉**（实测：清单里的 qoj 引用 35 → 写进 39 →
跑一次 `npm run crate:all` 又回到 35）。所以：

| 你要的 | 走哪条 |
|---|---|
| **这次出包就认下**（一次性） | 本脚本 + `npm run crate:xcpc`（**它不碰清单** —— 上面那条命令给的就是它，别换成 `crate:all`） |
| **永久接上**（要经得起重建） | 注册表那条正门：`xcpc_registry.py scan` → `answer qoj:<场次号> yes --slug <slug>`（**人的批准**）→ 再 `build` |

它做两件事（都幂等，重跑只更新自己动过的部分，**不动手工条目、也不动 gym 白名单生成的条目**）：

| 情况 | 处理 |
|---|---|
| 清单里**已有**这场（同一个 slug，比如 CF gym 整合出来的 `ccpc2023harbin`） | 给它补一条 `{source: qoj, role: submissions, contest: <id>}` |
| 清单里**没有**这场 | 新建条目：赛名/系列/年份/题单取自 rankland 索引（`rankland-index` 当 board，**不写 ratio**），提交挂 QOJ，带 `fromQojActivity: true` 标记 |
| 题目 id 对不上 | 退一步**按赛名**匹配（≥2 个特征词重合 + 年份不冲突 + 不并列才认） |

> **典型结果**：706 条 / 40 场 → 接上 **27 场**（6 场补到已有场次、21 场新建），
> 12 场是 rankland 没收录的（UCup 分站、NWERC、CCPC Online 2025…）。
> 包：**2749 条**（C 80 / P 1001 / R 1636；其中 QOJ 提交 460 条），`crate:check` 错误 0。
> 新建的那 21 场没有榜单文件，所以它们的题**没有 ratio**（应用里显示不出难度档）——
> 想要就得补一份真榜单（PTA 存页面，或 srk 整份当 board）。

---

### 0.4 常踩的坑

| 坑 | 症状 | 怎么办 |
|---|---|---|
| **时间差 8 小时** | 提交时间比实际早 8 小时 | 用**原始响应**（`submitAt` 是 UTC，适配器会换算）；别用手工产出的 `*_with_label.json`（它把 +08 又标成 Z） |
| **队名重名** | 往届数据一进来就"线索冲突、谁都不认领" | `source` 带赛季（`pta:<mid>`，如 `pta:icpc2026`），每届一个账户 —— 见下 |
| **只导榜单不导提交** | 一场比赛全是"未使用" | `submissions` 里挂上本队提交文件 |
| **忘了身份键** | 跨场聚合没反应 | CF gym → `cf:gym:106701:A`；QOJ → `qoj:20016`（适配器自动取，取不到就不写） |
| **降级一个来源只留了一个角色** | 包照样 0 错，但**某个字段整场悄悄没了** | 一个来源可以一次给好几样，降级时要**逐样留**（见 §4.4）。实测：xcpcio 抢走 board 后只给 CF 留 `submissions`，14 场的 155 个题名 + 155 个链接静默消失 |

### 0.5 只想重新出包（清单已经维护好了）

```powershell
npm run crate:xcpc                 # 清单里所有场次 → acm-data/nodes/mix_contain_xcpc.json（纯本地，约 70 秒）
npm run crate:xcpc -- --list       # 先看看清单里有哪些场次
npm run crate:xcpc -- --check      # 跑完顺手用应用引擎试算

python "acm-data/raw/Scaper/05 xcpc/xcpc_pipeline.py" icpc2026preliminary-2   # 只做某一场
npm run crate:xcpc:tree            # → _rankland_slugs.md（394 场 slug + 中文名）
npm run crate:xcpc:selftest        # 各适配器的离线自测（项数以运行器打印的为准，不联网）
```

> ⚠️ PowerShell 里 `--` 后面才是传给脚本的参数（`npm run crate:xcpc -- --check`）。
> 缓存都在时**不会联网**；只有新增场次、删了 `cache/`、或跑爬取脚本才需要网络。

---

## 1. 场次清单：`xcpc_contests.json`（**派生产物，只读**）

⚠️ 这份清单**不要手改**（每次 `build` 都会覆盖，覆盖前留 `.bak`）：
要改的是**注册表** `xcpc_registry.json`，改完 `python xcpc_registry.py build` 重新生成。
（本节讲它的形状，是因为流水线与各适配器都按它分发。）

```jsonc
{
  "defaults": { "cfHandle": "someone_2025target_LGM" },   // CF 只导自己的提交
  "contests": [{
    "slug": "icpc2026preliminary-2",                     // 身份（extKey 用它）
    "series": { "id": "icpc",     "name": "ICPC" },       // 第一层容器
    "mid":    { "id": "icpc2026", "name": "ICPC 2026 (51st)" },   // 第二层（可省略）
    "board":  { "source": "pta", "file": "…/PTA_rankings.json" }, // 权威榜单
    "sources":[ { "source": "srk", "role": "titles",  "file": "…/cache/xxx.srk.json" } ],
    "submissions": [
      { "source": "qoj", "file": "…/qoj_submissions.json", "contest": "4113" },
      { "source": "cf",  "gym": "106701" }
    ]
  }]
}
```

三种角色，**一个字段只有一个来源**：

| 角色 | 谁来做 | 出什么 |
|---|---|---|
| `board`（**必须有且只有一个**） | `pta` / `nk` / `srk` / **`xcpcio`** / `cf`（gym）/ `rankland-index` | C 的名字/时间/链接 + P 的 **ratio**（`rankland-index` 只给题单，不出 ratio） |
| `sources`（`role` 见 §4.4） | `srk` / `cf` / `qoj` / `rankland-index` / `rankland-refs` | 题名、题链接、官网链接、开赛时间…（**不动 ratio**） |
| `submissions` | `pta` / `qoj` / `cf` | **R**（提交记录） |

⚠️ **一个来源可以担两个角色**（PTA 既是权威榜单、又能出本队逐条提交；
CF gym 榜单还能同时出题名与本队提交）。这时片段文件名会带角色后缀
（`crate_<slug>_pta_board.json` / `…_pta_submissions.json`），
不带后缀会**互相覆盖**。
**降级/换榜时尤其要注意**：详见 §4.4 的教训。

> ⚠️ **`board` 给不出题名时，必须留一个 `titles` 来源**。PTA / 牛客的榜单**只有题号**，
> xcpcio 的 config 也只有 label —— 换 board 时把题名来源整个挪走，
> **题名/题链接会整场静默消失**（包照样 0 错）。实测踩过：接 PTA 榜时丢了 132 个题名。
> `xcpc_registry.py` 的 `cmd_build` 现在有现成规则（`pta`/`nk` 当 board 时自动挂
> `rankland-index` 的 `titles` 角色），照抄即可 —— **不要逐场手改**。

### 账户线索（"这条提交是谁的"）

应用里 `status2`（过没过）由 **R 子节点**推导，而 R 要能归到某个人名下，
导入时才会写进"谁说的"。**没有线索 = 全部算客观**，"各自的补题情况"就是空的。

各来源的线索字段（适配器只负责**如实搬运**，映射表由用户在应用里维护）：

| 来源 | 线索 | 从哪来 |
|---|---|---|
| `qoj` | `{source:'qoj', field:'提交者', value:<提交者>}` | 提交页面里的"提交者"列 |
| `pta` | `{source:'pta', field:'队伍', value:<队名>}` | **队名**优先取你声明的（`xcpc_pipeline.py --team`，逗号分隔算多支；`PTA_TEAM` 同义），否则自动认：`me.json` 账户里声明的**所有** `pta:<赛季> : 队伍`（本场赛季的排前，一个都不吞；就是应用「设置 → 🔑 账户/名册」里那些）→ `pta.teamName`／账户的 `pta` 字段 → 提交响应里的 `teamInfo.teamName`（榜单/提交数据里**没有**"提交者"列，队名是唯一能认出"是谁"的东西） |
| `cf` | `{source:'cf', field:'handle', value:<handle>}` | 提交里的 `author.members[]`（优先取清单里那个 handle） |

导入后在应用里加对应映射（`pta : 队伍 = TEAM0`），再点一次
**「🔁 用当前映射重跑归认」**，已经导进来的值也会被认领。

**队友的真名也走映射**（`pta : 成员 = <队名>/<真名>`，一人一条）：PTA 原文里唯一带真名的是
提交文件的 `teamInfo.memberNames`（那是**抓的时候那支队**的人，别人的名字不该由仓库里的数据文件决定）。
**队名要写进值里** —— 同一赛季可能有两支队（`TEAM0` / `ZJUT2`），只写真名就分不清谁是谁家的
（`source` 只到赛季，塞不下队名）。在应用「设置 → 🔑 账户/名册」里给队伍账户加几条
`field = 成员` 的映射，适配器就以你的为准（只认**这份文件那支队**的名单；文件里的那份只用来核对，
不一致会说一句）；成员**不进包** —— crate 里没有"真名"这个字段，队友在包里的身份是他自己的平台账号。

**PTA 的逐条提交怎么拿**：浏览器 F12 → Network 里那次"提交记录"请求 → 存成
`03 PTA/team_submissions.json`（形如 `{total, submissions, teamInfo}`）；
或者用榜单文件自己切一份：`py "03 PTA/PTA_team_submissions.py" --team <队名>`
（也支持 `--rank <名次>`；**不给就报错，不替你选队**）。
榜单（`xcpcRankings`）只给"某队某题是否通过"，**没有逐条提交**；只导榜单不带提交的话，
一场比赛打完树上是全"未使用"（清单里只有 QOJ 补题记录时就是这样）。

时间口径：`submitAt` 是 **UTC**，适配器统一换算到 +08:00。
别用 `PTA_team_submissions_with_label.json` 这种手工产出的文件（它把 +08 的时间又标成了 Z，会偏 8 小时）。

### 队名重名怎么办（"TEAM0" 每届都用）⭐

**问题**：应用侧是按 **`(source, field, value)` 三元组全等**匹配线索的
（`core/accounts.js` 的 `resolveAccount`）。两条映射声明同一个三元组 → 判成
**冲突、谁都不认领**。而队名会年复一年重用（`TEAM0` 打了 3 届、队友换了两批），
原始数据里又只有队名（PTA 没有"提交者"列）—— 直接用 `pta : 队伍 = TEAM0`
到第二届就撞了。

**正解：把"区分维度"放进 `source`，`value` 保持原值**（便于和原始数据核对）：

```
source = pta:<赛季>        ← 赛季层（清单里的 mid.id），如 pta:icpc2026 / pta:icpc2025
field  = 队伍
value  = TEAM0             ← 原样搬运
```

- 适配器的默认值就是 `pta:<mid.id>`：**同一个赛季共用同一条映射**
  （一年之内的 TEAM0 = 同一批人），跨赛季天然互不干扰；
- 想更细（同一赛季里换个队名也要分开）就把 `source` 写成 slug：
  `"accountClue": { "source": "pta:icpc2026preliminary-2", "field": "队伍", "value": "TEAM0" }`
  —— 一场一条映射；
- 清单里的 `accountClue` 支持两种写法：**字符串** = 只换队名（source 仍按赛季推导）、
  **对象** = 完整指定 `{source, field, value}`。队名本身先算成一份**名单**（全取，不挑一条）：
  **主脚本输入**（`--team`，逗号分隔算多支）> **账户映射**（所有账户声明的 `pta:<赛季> : 队伍`，
  本场赛季的排前）> `pta.teamName`／账户的 `pta` 字段；再拿这份名单去核对**这份文件是哪支队**：
  文件里的队名在名单里就照它写、文件没写队名就取名单第一支（多支时提示）、
  文件里的队名不在名单里就照文件写并警告一句（"这份文件是不是别人的？"）；
  清单里的 `accountClue` 与提交文件里的 `teamInfo.teamName` 是最后两档兜底。

对应到应用里，就是**每届建一个账户**（如「TEAM0-2024」「TEAM0-2025」「TEAM0-2026」），
各自填一条该赛季的映射；你自己的 QOJ/CF 这种**个人**平台仍用个人账户
（`qoj : 提交者 = someone`），两者可以并存 —— 一个 R 只认一个账户，不存在重复归属。

⚠️ PTA 数据的固有上限：它只按**队**记提交，认不到"是哪位队友打的"。
要区分队友只能靠个人平台（QOJ/CF）的提交。

`slug` 从哪来：**用 RankLand 的**（`_rankland_slugs.md` 里挑，或用 `--list`/网站
`rl.algoux.cn/collection/official`）。它自带系列+年份、被社区长期维护，
比我们自己编号可靠。清单里的 `slugFrom` 就写它的出处。

### extKey 规则（**已定，导入后不可改**）

⚠️ **没有"合并树"**：每个渠道各自一棵，收在 W `aux`（辅助节点）下；
CF / QOJ 各自那棵直接挂在根上（`cf` / `qoj`）。下面以 PTA 那棵为例：

```
aux                                     辅助节点（所有渠道树的共同父）
aux-pta                                 渠道树（PTA）  ← 键**不带冒号**：第一段就是"树身份"
aux-pta:s:icpc                          系列
aux-pta:s:icpc:icpc2026                 年份 / 省份（照抄 rankland 的树，层级不统一）
aux-pta:c:icpc2026preliminary-2         比赛（slug）
aux-pta:c:<slug>:p:A                    题目（字母）
aux-pta:c:<slug>:sub:pta:2098713069631770624   提交（来源 + 该来源的提交 ID）
```

渠道 → 树：`pta`→`aux-pta`、`nk`→`aux-nk`、`xcpcio`→`aux-xcpcio`、
`rankland-index`/`rankland-refs`→`aux-rankland`（两者**合成一棵**）、`srk`→`aux-srk`、
`cf-contest`→**`aux-cf-contest`**（**只装 CF 正式比赛的复用题合成节点**，
不是把 CF 那棵树搬进来 —— 真树还是 `cf`）。
⚠️ **`atcoder` 是例外**：它挂**顶层** `O ─(W)atcoder`（`xcpc_common.PLATFORM_TREES`）——
**AtCoder 不挂在辅助节点里**。**挂不挂 `aux` 由各渠道自己决定**，
两条链分别在 `AUX_TREES` 与 `PLATFORM_TREES` 里声明，`open_tree()` 两张表都认。

`aux-cf-contest` 那棵的层次（与 CF 真树**同形**，只是下面挂的是合成节点）：

```
aux-cf-contest                          辅助树（W）
aux-cf-contest:s:cf-contest             系列（与真树 `cf:s:cf-contest` 同名同构）
aux-cf-contest:s:cf-contest:2022        年份层（比赛时间所在年份；取不到 → 年份未知）
aux-cf-contest:c:1753                   场次镜像 C（名字/性质/链接**照抄**真树那份，只建有复用题的那些）
synth:problem:cf:c:1753:p:A1            P 合成节点（名字带 `[Merged] ` 前缀；身份是 synthKey）
```

真树那边同样多了一层年份：`cf:s:cf-contest` → `cf:s:cf-contest:<年份>` → `cf:c:<场次>`。

为什么键写成 `aux-pta` 而不是 `aux:pta`：`src/utils/similarity.js` 判"是不是同一棵树"
只看 extKey 的**第一段**（跨树重复**故意跳过** —— 同一场比赛在各渠道树里各有一份是预期）。
写成 `aux:pta` 会让五棵树第一段都是 `aux`，于是全被判成"包内重复"。

为什么这么定：
- **不自己编号**：XCPC 各场没有统一编号，而外部世界已经有稳定 slug；
- **层级照抄来源**：icpc 下面是年份、provincial 下面是省份（`bj`/`ah`…）、
  ucup 只有两层 —— 我们不发明层级，直接跟着树走；
- **提交带来源**：cf / qoj / pta 的提交 ID 空间互不相干，混在一起会撞；
  带 slug 还能保住"这条提交属于哪场"的语义；
- **各渠道各出各的**：同一场比赛在五棵树里各有一份，应用侧靠「判重（`映射元素值`）」
  绑定 + 信息交换/倾斜决定显示谁 —— 爬取层不做任何取舍。

---

## 2. 数据是怎么来的（各来源一份）

| 来源 | 拿到什么 | 怎么拿 |
|---|---|---|
| `rankland`（srk） | 场次树（slug + 中文名）、题名、每题 CF gym / QOJ 链接、refLinks、（可选）榜单 | `fetch_rankland_tree.py` / `fetch_rankland_srk.py <slug>` / **`build_rankland_index.py`（跨平台对照）** |
| `PTA` | 完整榜单（`competitionBasicInfo` + 每队每题明细） | 浏览器打开榜单页 → F12 Network 里那份 JSON 存下来 |
| `CF` | 提交（含 verdict / 时间 / 题号） | `cf_adapter.py` **直接调公开 API**，不用登录 |
| `CF`（**正式比赛 ≠ gym**） | **花名册里每个 CF 账号**打过的正式比赛：C+P+R 整棵树（**每场完整题单 + 正确题号**） | `cf_contest_adapter.py`（公开 API + **比赛页**；不用清单、不用凭据）—— 见 §0.2 的来源与那两条链 |
| `AtCoder` | **花名册里每个 AtCoder 账号**打过提交的场次：C+P+R 整棵树 | `atcoder_adapter.py`（AtCoder Problems 公开 API + **官方题表页**）—— 见 §0.2 的来源与那两条链 |
| `QOJ` | 提交（补题）；官方赛名/分类 | 提交与赛名都在 **`04 qoj`**：`qoj_submissions.json` / `--list` 出的 `qoj_contest_titles.json` |
| **`xcpcio`** | **每题 ratio（权威）** + 赛名 / 开赛时间 / 题号表 | `build_xcpcio_index.py`（索引）+ `xcpcio_adapter.py`（按需下榜单） |

```powershell
# rankland：394 场的 slug 清单 / 某一场的榜单
python "…/05 xcpc/fetch_rankland_tree.py"
python "…/05 xcpc/fetch_rankland_srk.py" icpc2026preliminary-2     # → cache/<slug>.srk.json
python "…/05 xcpc/fetch_rankland_srk.py" --list icpc2026           # 列出某年的场次
```

### 2.1 xcpcio：**权威 ratio 源**

> xcpcio 是"最权威的 ratio 源"（分正式/打星），PTA 其次。

```powershell
# ① 索引：目录树 + 每场 config（448 场，约 1.4 MB，2–3 分钟；增量，只下变了的）
python "…/05 xcpc/build_xcpcio_index.py"
# ② 把场次对到 xcpcio 目录（写进注册表顶层 `xcpcio`）—— 先看报告再 --write
python "…/05 xcpc/xcpc_registry.py" xcpcio
python "…/05 xcpc/xcpc_registry.py" xcpcio --write
# ③ 出包时 xcpcio 自动当 board（流水线按清单里的 board.source 分发）
python "…/05 xcpc/xcpc_registry.py" build
python "…/05 xcpc/xcpc_pipeline.py" --check
```

对上的场次：**112/165**（其余 53 场：50 场 xcpcio 根本没收录、3 场与别的场次抢同一份目录，
都继续用各自的榜单来源、照旧没有 ratio）。

- **口径**：`ratio = 过题队伍数 ÷ 至少过一题的有效队伍数`，与 HDU / 牛客 / PTA / srk 一致；
  **正式 + 打星同算**，xcpcio 的 `group` 只用来标注。
- **去重**：按 `(队伍, 题目)` 去重后才计数 —— 同一队同一题可能有多条 `CORRECT`
  （实测 CCPC 2025 郑州不去重会算出 101% 的 ratio）。
- **它给不出题名**：`config.json` 的 `problems[]` 只有 `label`（A…M）与气球颜色，
  题名只能靠 srk / rankland 索引 / **CF gym 榜单** / QOJ。所以 xcpcio 当 board 时，
  别的榜单会**降级成 `sources` 里的补充来源**，并且**它给几样就留几样**：
  CF 榜留 `titles`（题名/题链接）**和** `submissions`（本队提交），rankland 索引留 `titles`
  —— 少留一个就有字段整场消失（详见 §4.4）。
- **匹配算法**在 `xcpcio_adapter.py` 的 `match_entry()`（系列 + 年份/届次 + 站点词 +
  邀请赛/区域赛、河南省赛的 icpc/ccpc 之分）。**宁可某场不给 ratio，也不猜**：
  并列候选直接报出来让人看。
- **缓存**：`cache/xcpcio/<路径>/{config,run,team}.json`（可删，删了重下；全仓 417 MB，
  我们只下对上的那 112 场 ≈ 110 MB）。**下过一次就不会再下**
  （`local_file()` 会自检缓存完整性；**`--force` 是重下开关**（通用读取层），流水线从不传它。
  ⚠️ 这里别用 `--cache-mode none` —— 那等于"每场都重下 run/team"，全量 368 MB）。

> **文件不在时不用手工抓**：`srk_adapter.py` 发现 `cache/<slug>.srk.json` 不存在，
> 会自己按 slug 去 rankland 下载（`--no-fetch` 可以关掉）。
> 清单里那个 `file` 只是"放哪儿/先读哪儿"。

> `srk` 文件的 `problems[].link` 常常直接指向 **Codeforces gym** ——
> "这场提交在哪"就是这么自动认出来的（本例是 gym 106701）。

> CF 的 handle 写在 `acm-data/raw/Scaper/me.json` 的 `cf.handle`；**默认只导自己的提交**：
> 整场 gym 有一万多条，全导进来会让树上挂满 R 节点。
> **想连队友一起导**：在 `me.json` 的**账户**里给每个人填 `cf` 字段（一人一项，
> 见下节），
> 之后 `npm run crate:xcpc` **默认就会带上所有人**；单场调试用
> `python "…/05 xcpc/cf_adapter.py" <slug> --handles a,b`（`--team` 同义）。
> 每人提交会带各自的线索 `cf : handle = <他>`，应用里各配一条映射即可。
> 一条提交的 `author.members` 有多个目标 handle 时（队伍提交），按**账户里的顺序**取第一个命中的。

### 2.0 多人（多账号）取数一览（账户就是名册）

一条命令抓多个人，靠的是 `me.json` 的**账户** `accounts`（登记一次，各平台共用）：

```jsonc
"accounts": [
  { "name": "我",   "nature": "member", "cf": "someone_2025target_LGM", "qoj": "someone",
    "nk": "再_努_力_一_点", "hdu": "TEAM0/teamA" },
  { "name": "队友", "nature": "member", "cf": "mate_handle", "qoj": "mate" }
]
```

> ⚠️ 这份名册是**从应用里的账户映射派生**的 —— 在应用里改完账户，
> 点设置页「🔑 账户/名册 → 📤 写进 me.json」就会写成上面这样（凭据与说明不动）。

```powershell
python "acm-data/raw/Scaper/lib/me.py" --team      # 看账户整理结果 + 各平台实际会抓哪些账号
```

| 平台 | 多人怎么生效 | 命令 | 备注 |
|---|---|---|---|
| **CF** | ✅ 全自动 | `npm run crate:xcpc`（默认带账户里所有 CF 账号） | 逐人查 API、按 handle 分文件缓存；合并后按提交 ID 去重 |
| **QOJ** | ✅ 全自动 | `QOJ_submissions_scraper.py --fetch --submitter a,b`（**重建链第 2 步会自动跑这条**，不给 `--submitter` 就用花名册） | 走全局列表页 `/submissions?submitter=`（**顺带拿到"语言"列**）；它**不认 `contest=`**（带上也是同一份全量）⇒ 脚本不再拼它，抓完按列表里的 `/contest/<id>` 链接分场次 |
| **牛客** | ✅（一页本来就带所有人） | `npm run crate:nk` | 只是"线索打给谁"从单人变多人；别人的提交照常导入当客观值 |
| **HDU** | ⚠️ 需逐人筛页面 | 每人筛一次 Status 页各抓一份，然后 `hdu_pipeline.py --all --handles a,b` | HDU 表里**没有提交者列** → 只能靠"这份文件是谁抓的"；`--handles` 与**提交文件顺序一一对应**，数量不等就一条线索都不打 |
| **PTA** | ⚠️ 只到"队" | 每队存一份提交 JSON | PTA 只有队名、没有个人账号（`memberNames` 是真名） |

**账户线索（CF / QOJ 不带赛季）**：

| 平台 | 线索 | 说明 |
|---|---|---|
| CF | `cf : handle = <handle>` | **CF 账号长期不变**，所以用常量 `cf`（不带赛季） |
| QOJ | `qoj : 提交者 = <用户名>` | 同上（QOJ 账号也长期不变） |
| HDU | `hdu:2026 : handle = <handle>` | 仍带赛季：HDU 数据里没有提交者，靠"文件↔handle"绑定，赛季用来区分届 |
| 牛客 | `nk:2026 : 用户名 = <用户名>` | 仍带赛季：牛客用户名可能是**队名**（每年换），要分开 |
| PTA | `pta:<mid> : 队伍 = <队名>` | 仍带赛季：队名（`TEAM0`）年年重用，不分届会认错人 |

> **线索一律逐字符全等**：应用侧**不做**任何"去赛季"的推断（见 `core/accounts.js`
> 的 `resolveAccount`）—— 所以线索格式对不上就认不出，
> **删掉旧子树重导一次**即可；映射用平台级（`cf` / `qoj`）。
> 这样比"靠推断把值安到别人头上"更安全：要换格式就显式重来一次。


---

## 3. ratio 的口径（**三个已经踩到的坑**）

`ratio = 通过队伍数 ÷ 有效队伍数 × 100`（与 HDU / 牛客同一口径）：
- **通过队伍数** = 该题过了的队伍数；
- **有效队伍数** = 至少解出 1 题的队伍数。

1. **PTA 页面上那个"通过率"不要用**：它长这样 `115/1216`（= 通过数/提交数），
   分母不是队伍数。`03 PTA/PTA_problems.json` 里的 `AC率` 更离谱 ——
   分母是脚本里**手写的 `TEAM_COUNT = 2486`**。
   本流水线一律逐格数，并和 PTA 自己的 `acceptCount` 对账（实测 12/12 全中）。
2. **分子分母必须来自同一份榜单**。实测这场：PTA 榜 2494 支有效队伍；
   rankland 的 `rows` 只有 2622 行（2480 支），逐格数每题**少 1** ——
   而 rankland 自己的 `statistics.accepted` 与 PTA 完全一致。
   所以 `srk` 在 `role=titles` 时只出题名/链接，**不算 ratio**。
3. **判"这题过了"看 `acceptTime >= 0`**（PTA 的字段），不是 `status == "AC"`
   （那个字段不存在）；`score` 也不可靠（榜首队的 `totalScore` 居然是 0）。

---

## 4. 节点树长什么样

```
W  XCPC                                       xcpc
└ S ICPC                                      xcpc:s:icpc
  └ S ICPC 2026 (51st)                        xcpc:s:icpc:icpc2026
    └ C 2026 ICPC Asia EC网络预选赛 - 第二场     xcpc:c:icpc2026preliminary-2
      ├ P All Closed   A  ratio 4.61%  🔗 CF gym 106701
      ├ P Island       I  ratio 2.33%
      └ R AC  2026.09.13 22:06                 xcpc:c:…:sub:qoj:2951241
└ S CCPC                                      xcpc:s:ccpc
  └ S CCPC 2023 (9th)                         xcpc:s:ccpc:ccpc2023      ← gym 场次整合后也归到年份层
    └ C 第 9 届 CCPC 中国大学生程序设计竞赛 哈尔滨站   xcpc:c:ccpc2023harbin   ← 名字来自 rankland
      ├ P Go go Baron Bunny!  A  ratio 1.30%  🔗 CF gym 104813/problem/A
      └ R AC  2024.11.05 19:15                 xcpc:c:…:sub:cf:290057906
```

### 4.1 时间与链接

- **比赛时间**换算成北京时间（`+08:00`）后写成 `YYYY.MM.DD HH:MM`；
  PTA 的 `startAt` 是 UTC，适配器会转（否则会差 8 小时）。
- **题目链接**由**榜单来源**给（CF gym 场次 = gym 页，PTA 场次 = PTA 榜页）；
  落选值不会丢，进 `其它来源值`，应用按来源分别显示。
- **C 的链接按类别记账**（口径：数据爬取部分不应该有"存在多值时排除
  一些值"的逻辑）：爬取层只写元列 **`链接分类`**（`{类别: [{v, src}]}`，**全量、不取舍**），
  类别只有 4 种 —— **榜单 `board` / 补题 `problems` / 仓库 `repo` / 其它 `unknown`**。
  两个标量字段由**应用层**派生，规则只在 `src/features/AutoImport/plan.js` 一处：
    * `link` = 第一条**补题**候选（它**不是**"主链接"，与榜单**没有主次关系**；没有就空着）；
    * 其余候选（仓库/其它/同类的第二条…）**一条都不丢**，写进来源层（带 `linkKind`），
      树上按类别分组显示（**「仓库」与「未知」非空也显示**）。
  ⚠️ 类别由**产出它的适配器声明**（它手上有 `title` 等上下文），`crate.classify_link()`
  只按 URL 兜底 —— 牛客比赛页就是"既是榜单又是题面"的例子，光看 URL 分不出来。
>  `link` 现在**爬取层一处都不写**（`grep -n "link=" *.py` 剩下的全是 **P/R** 的链接）。
- **R 的提交性质**是字段 `submitKind`：`赛时` / `VP` / `补题`，**判不出留空**。
  它决定父题目 `status2` 是「4 赛时通过」还是「3 赛后补题」（**有一发赛时的 AC 就算赛时通过**）。
  各来源的判法见 §4.6。
- **时间精度**：`time` / `contestTime` **存储与显示都用 14 位（带秒）**。
  为什么：同一分钟内多条提交靠秒才排得对（`acTime` 才准），显示带秒才看得出先后。
  UI 统一走 `displayTime`（`src/utils/time.js`）。
  ⚠️ 适配器**不要自己把秒截掉** —— `crate.normalize_time` 已经会保留秒。

### 4.2 C 节点名字

PTA 的 `name`、rankland 的 `title.zh-CN`、CF 的英文名、xcpcio 的 `contest_name`
四者按"谁当榜单"决定；整合过的 gym 场次取 rankland 的中文名（英文名留在 `aliases.cf`）。

### 4.3 同一场是多个来源拼出来的

`source_report.py <slug>` 能逐字段看"谁给的、选中谁、谁落选"，排查字段丢失就靠它：

```powershell
python "…/05 xcpc/source_report.py" ccpc2025zhengzhou
#   C 名字        ← rankland/xcpcio（2 个来源一致）
#   C 链接        ★ qoj ｜ rankland ｜ xcpcio（选中 qoj，其余记进其它来源值）
#   P.A 通过率    ← xcpcio（唯一来源）
#   P.A 名字      ← rankland（唯一来源）
```

### 4.4 来源的角色（一个来源可以同时担好几个，别只留一个）

适配器按 **(来源, 角色)** 分发，清单里的 `board`/`sources`/`submissions` 各带 `role`。
同一个来源**一次能给好几样**，所以"谁当榜单"变了，**其余的照要留全**：

| 来源 | 能担的角色 | 给什么 |
|---|---|---|
| `pta` | `board` / `submissions` | 完整榜（C 名字/时间 + P.ratio，**给不出题名**）／本队逐条提交 |
| `nk` | `board` | 牛客公开榜（C 的榜单链接 + P.ratio，**给不出题名**）—— **和 `pta` 共用 `pta_adapter.py`**（它自动认形状），见 §4.5 |
| `srk` | `board` / `titles` | 榜（ratio 逐格数）／只补题名与题链接 |
| `cf`（gym） | `board` / `titles` / `submissions` / `website` | 榜（题单+ratio，含虚拟参赛口径）／**题名+题链接**／本队提交／官网链接备选 |
| `qoj` | `submissions` / `titles` | 补题提交／**题面链接+题名**（QOJ 这一侧） |
| `rankland-index` | `board` / `titles` / `time` | 题单（无 ratio）／题名+链接／只补开赛时间 |
| `rankland-refs` | `links` | 该场**全部**入口链接，按用途分类写进 C 的「链接分类」（榜单/补题/仓库/其它），**一条都不丢** |
| `xcpcio` | `board` | **每题 ratio** + C 的名字/时间/榜单链接（**给不出题名**，见 §2.1） |

> ★ **角色还决定"类别"（kind）**：`board`（"这场以它为准"）声明成**权威榜单**，其余角色一律 `script`
> （补充来源）—— 应用**按类别排优先级**，声明错了就是**静默压错值**。
> 判据：`selftest.py` 的 `test_rankland_index_role_kind()` 正反各验一遍。
> ⚠️ 踩过（2026-10-16）：流水线原先把 `rankland-index` 的 `titles` **折成** `--role board`
> ⇒ 实测包里 **134** 个 `rankland-index-*` 全是 board，而清单里只有 **13** 场真拿它当 board。

⚠️ **实测过的教训**：xcpcio 接上后把 CF 榜降级成 `submissions`，**题名/题链接就没人给了** ——
14 场里 155 个题名 + 155 个链接静默消失（包照样 0 错，不报任何警告）。
所以 `xcpc_registry.py build` 现在给 CF 榜**同时留 `titles` 和 `submissions`**。
反过来只留 `titles` 也不行：本队提交会没了，而 R 指向的题号（如 `ccpc2024ladies` 的 M 题）
在主树上不存在 → **整场导入被拒**。

> 检查手法：包每次都能通过 `crate:check`，所以**字段覆盖数字才是这种故障的唯一信号**。
> 出包后对一眼（下面是参考基线，数字随重建变，只看量级）：
> `P 2071｜有 ratio 2031｜有题名 2037｜有链接 2050`。

### 4.5 牛客也能当 XCPC 的 `board`（省赛/邀请赛）

**牛客自己那条链路（`01 nk/`）与 XCPC 完全不交**，别把它们混起来 ——
这里说的只是"**某几场省赛/邀请赛的榜单恰好挂在牛客上**"，于是把那份榜单当一个数据源用。

做法：**不写第二个适配器**，让 `pta_adapter.py` **自动认榜单形状**：

| 形状 | 判据 | 谁算 ratio |
|---|---|---|
| PTA | 有 `xcpcRankings` | 适配器**逐格数**通过队伍数（`analyze`） |
| 牛客 | 有 `problems[]`（`nk_rank_stats.json`） | **牛客已经算好了**，适配器只搬运（`analyze_nk`）；`complete != true` 时**一道都不给** |

两个 `analyze*()` 产出**同形的统计**（`ratios` / `board_link` / `label`），
所以 `build()` 里没有一句按平台的 if。**想接第三种榜单就照这个形状加一个 `analyze_x()`。**

```powershell
python "…/05 xcpc/nk_rankings_fetch.py" --slug gxcpc9th   # 公开接口，自动翻完所有页 → …/cache/nk/nk_cid<cid>_rank.json
python "…/01 nk/lib/nk_rank_stats.py" -i "…/cache/nk/nk_cid<cid>_rank.json" -o "…/cache/nk/nk_cid<cid>_rank_stats.json"
# 然后把注册表里这场的 board 改成 {"source": "nk", "file": "…/cache/nk/nk_cid<cid>_rank_stats.json"}
python "…/05 xcpc/xcpc_registry.py" build && python "…/05 xcpc/xcpc_pipeline.py" --check
```

- 来源名会如实写成 **`nk-<slug>`**（来源面板里一眼看得出这场的 ratio 是哪来的）。
- **牛客比赛页记成 `board` 类别**（它既是榜单页又是题面页，光看 URL 分不出来 —— 所以类别由
  **产出它的适配器声明**，`crate.classify_link()` 只当兜底）。
- ⚠️ **牛客没有独立的榜单路由**（实测 `/acm/contest/rank/single/<cid>` 等一律 404 壳），
  榜单是比赛页上的**前端标签** → `boardLink` 给 `https://ac.nowcoder.com/acm/contest/<cid>`。

### 4.6 R 的 `submitKind`（赛时 / VP / 补题）怎么判的

它决定父题目 `status2` 是「4 赛时通过」还是「3 赛后补题」，所以判错会直接反映到树上。
**判不出就留空**（不写"未知"）。

**CF**：以**官方比赛时段**为准（`cf_adapter.py` 的 `gym_window`）——
提交落在 `[开赛, 开赛+时长]` 内 = `赛时`，之后 = `VP`（官方类型是 VIRTUAL/CONTESTANT）
或 `补题`。开赛时间三级兜底（实测覆盖率）：**rankland 索引 `startAt`（391/394）** →
CF `standings` 缓存的 `startTimeSeconds`（gym 常是 None）→ 白名单 `startAt`（53/95）。
57 场里 **51 场**能拿到时段。
⚠️ **不要用 `participantType` 判**：实测真实参赛的 `zjcpc` 系列被 CF 标成
`PRACTICE` + `INT_MAX`，照它判会把 **324 条真实提交**说成"补题"（踩过）。
剩 6 场没时段，只用相对时间判（`INT_MAX` 的留空）。
⚠️ **重放的时间戳必然在开赛窗口之后**，所以这条规则同时解决了"现场赛 vs 后来重放"的歧义。

**QOJ**：看**用户主页的 VP 名单**（`Virtual Participations：N contests`）——
在名单里 = `VP`，有提交但不在 = `赛时`。
缓存：`python "…/04 qoj/QOJ_submissions_scraper.py" --participation`
→ `04 qoj/cache/qoj_vp_contests.json`（1 请求/人，实测 someone 11 / kongcheng_lige 3 / teammate_b 5）。
⚠️ QOJ **不公布比赛起止时间**（比赛页只有 `Contest Ended`；`standings` 里的 `4:00:00`
是封榜时刻的默认值，不是时长），所以**区分不了 `补题`** —— 没人手填就不写。

**HDU / 牛客**：**比赛时段**（精确起止优先）。
⚠️ **绝不能按"提交日 == 比赛日"判** —— **当天补题非常常见**。
按日期判会把 HDU 的 **246 条当天补题**误判成赛时、牛客 65 条。
- HDU：`02 hdu/Hdu_contest_times.py` 抓单场页里那行
  `const contest = {"start":…,"end":…}`（**免登录**）→ 写进 `Hdu_contests.json` 的 `end_time`；
  实测 20 场：春季联赛 18:30~22:30、暑期 12:00~17:00（**时长不统一**）。
- 牛客：比赛页 `window.pageInfo` 的 `startTime`/`endTime` → 旁挂 `nk_cid*_contest.json`；
  已有的场用 `01 nk/backfill_nk_contest_times.py` 回填（实测 9 场 12:00~17:00，
  **cid 133880 是 12:00~17:15**）。
  ⚠️ **这两个脚本套在通用读取层上**：有 `--cache-mode/--retry-mode/--force` 三开关，
  抓到的窗口按 cid 缓存（`01 nk/cache/nk_contest_times/<cid>.json`、
  `02 hdu/cache/hdu_contest_times/<cid>.json`），**命中就不联网**；产物格式与路径不变，
  要刷新用 `--force`。
- 完全拿不到精确时段时才用**兜底假设**：开赛日 12:00~17:00。

**PTA**：**不用判 —— 它一定是赛时**。
数据来自榜单里"本队逐条提交"，而**榜单只收录比赛时段内的提交**（赛后补题不进榜），
所以 `pta_submissions_adapter.py` 直接写 `submitKind='赛时'`。

**QOJ 的第二个信号**（比 VP 名单更直接）：
场次页的「提交时间」列**参与过就显示相对时间**（`03:09:00`）、**没参与过显示绝对时间**
（`2026-09-20 21:08:19`）；同一场里两种会并存，所以是**逐条**信号。
采集：`QOJ_submissions_scraper.py --timefmt` → `cache/qoj_contest_timefmt.json`。
（全局列表页永远是绝对时间，判这个必须用场次页。）

---

## 5. 本目录文件清单

| 文件 | 干什么 |
|---|---|
| `xcpc_contests.json` | **场次清单**（派生产物：`xcpc_registry.py build` 出、别手改） |
| `xcpc_registry.json` | **人写注册表**：身份/分类/来源 + `xcpcio` 指派 + `pending` 候选区 |
| `xcpc_registry.py` | 注册表工具：`seed`/`scan`/`status`/`answer`/`classify`/`add-catalog`/`xcpcio`/`build` |
| `xcpc_pipeline.py` | **入口**：读清单 → 调各来源适配器 → **按类各出一包** → 合成 `mix_contain_xcpc.json`（`--all-nodes` 再出 `all_nodes.json`，见 §0.2.2） |
| `pta_adapter.py` | **榜单适配器**：PTA 榜（`xcpcRankings`）→ C+P+ratio；**也吃牛客榜**（`problems`，形状自动识别，见 §4.5） |
| `pta_submissions_adapter.py` | PTA 本队**逐条提交** → R（`submitKind` 一律 `赛时`：榜单只收比赛时段内的提交） |
| `srk_adapter.py` | rankland 榜单 → 题名/链接（`--role board` 时也出 ratio） |
| `cf_adapter.py` | CF（含 gym）提交 → R（**直接调 API**，只要自己的）；`--scope-report` 打"候选 N → 进包 M"并写 `cache/cf_gym_scope.json`；`--gym-meta` 把**全量 gym 元信息**（`contest.list?gym=true`，含赛名分类）写进 `cache/cf_gym_meta.json`（见 §0.2.3） |
| `cf_contest_adapter.py` | **CF 正式比赛（≠ gym）** → 整棵树一个片段（`cf:s:cf-contest`，**系列下多一层年份** `…:<年份>`）：按"**花名册里每个 CF 账号**提交过哪些场 ∪ 同轮伙伴场"选场（逐个 `user.status`，线索 = 这条提交从谁的名单里拿到）、**每场题单以比赛页为准**、`cfDifficulty` 从题池借老家、题序 `letter_sort`；`reuse.json`/`incomplete.json` 落在 `cache/cf_contest/`。**同一趟还出辅助树 `aux-cf-contest`**（复用题合成节点：25 场镜像 C + 51 个 `[Merged]` P，见 §0.2.2） |
| `atcoder_adapter.py` | **AtCoder** → 整棵树一个片段（顶层 `atcoder`）：AtCoder Problems 公开 API + **官方题表页**取题号；逐账号抓（线索 = 提交自己的 `user_id`）；`cache/atcoder/` |
| `cf_board_adapter.py` | CF gym 榜单 → C+P+ratio（`--role titles` 只出题名/链接、`--role website` 只出官网链接） |
| `qoj_adapter.py` | QOJ 提交 → R，**并出题面链接/题名**（不写 ratio） |
| **`xcpcio_adapter.py`** | **xcpcio 榜单 → 每题 ratio**（权威 ratio 源；含场次匹配 `match_entry`） |
| **`build_xcpcio_index.py`** | 建 xcpcio 索引：目录树 + 每场 `config.json`（赛名/时间/题号，增量下载） |
| `fetch_rankland_tree.py` | 拉 rankland 场次树 → `_rankland_slugs.md`（394 场） |
| `fetch_rankland_srk.py` | 按 slug 下载某场榜单 → `cache/<slug>.srk.json` |
| **`build_rankland_index.py`** | 建**跨平台索引**：gym 号 / QOJ 题号 ↔ rankland slug（只取头部，可增量续抓） |
| `gen_gym_manifest.py` | 白名单 → 清单条目（**有索引时自动换成 rankland 身份并整合来源**） |
| **`link_qoj_activity.py`** | 把 QOJ 提交接到清单里对应的场次（题目 id → 赛名两级匹配，可新建条目） |
| **`rankland_index_adapter.py`** | 只用索引出 C+P（赛名/题单），**不下 srk、不算 ratio**（`--letters` 可补空壳 P） |
| `fetch_my_gyms.py` | 从我的 CF 提交反推打过哪些 gym → `gym_whitelist.json` |
| `pta_rankings_fetch.py` | 抓 PTA **公开榜单** → `cache/pta/pta_<slug>.json`（`--missing` 只抓还没有 ratio 的场次） |
| `nk_rankings_fetch.py` | 抓牛客**公开榜单** → `cache/nk/nk_cid<cid>_rank.json`（**会自己翻完所有页**，`limit=0` 只给第一页）；要 ratio 还得再喂 `01 nk/lib/nk_rank_stats.py` 出 `_rank_stats.json` |
| `missing_qoj_report.py` | 列"**没有补题链接、但 QOJ 里有**"的场次（读 `04 qoj/cache/qoj_contest_titles.json` 的赛名 + `match.py` 的年份守卫）；只读体检 |
| `missing_ratio_report.py` |
| `source_report.py` | 某场逐字段看"谁给的、选中谁、谁落选"（排查字段丢失用） |
| `selftest.py` | 各适配器的**离线自测**（项数以它打印的为准；改适配器后先跑它，`npm run crate:xcpc:selftest`） |
| **`lib/xcpc_common.py`** | 公共工具：**extKey 唯一一份** / ratio / 路径 / 清单读取；树的两张表（`AUX_TREES` 挂辅助节点、`PLATFORM_TREES` 挂顶层）与**题号排序 `letter_sort`**（唯一一份：只有 `EX` 垫底、其余自然序） |
| **`lib/match.py`** | "同一场认定"的**唯一实现**（平台号/题目id/题名/CJK bigram/分类/xcpcio 提示） |
| **`lib/rankland_tree.py`** | rankland 目录树的解析与抓取（唯一一份） |
| **`../me.json`** | **你的个人信息（全项目唯一一处）**：CF handle/密钥、QOJ cookie、PTA 队名 |
| **`../lib/me.py`** | 读 `me.json` 的唯一实现：`--show` 原样看、`--check` 联网验、`--migrate` 从旧位置搬 |
| **`../lib/read_modes.py`** | **通用读取层**（所有渠道共用）：`Archive`（页级原料）/ `should_refetch(default=)` / `retry_call` / `require_local()` / `stats` / `--cache-mode/--retry-mode/--offline/--force` 四开关（见 §0.2.1 索引表） |
| **`../lib/scope.py`** | **抓取范围通用件**：`union_scope(explicit, mine, name)` = 指定范围 ∪ 有提交；`split_by_origin()` 做来源标注（见 §0.2.3） |
| `cache/` | 下游抓来的原始文件 + 各来源片段（**中间产物，可随时删**）；各渠道另有自己的子目录：`cache/cf_contest/`（比赛页 + 题池 + `reuse.json`/`incomplete.json`）、`cache/atcoder/`（`pages/` 官方题表页 + 三份 JSON + `letter_warnings.json`）、`cache/xcpcio/`、`cache/pta/`、`cache/nk/` |
| `_rankland_slugs.md` | 394 场 slug 清单（由 `fetch_rankland_tree.py` 生成） |

数据来源与许可：榜单数据来自 [srk-collection](https://github.com/algoux/srk-collection)
（**AGPL-3.0**）。按其 README 要求：使用时应标注来源，二次加工产生的衍生数据
应按相同协议开源。要公开发布本项目的导入包时请注意这一条。

**xcpcio 的榜单是另一份许可**：[xcpcio/board-data](https://github.com/xcpcio/board-data) 是
**MIT**（2020–至今）—— 与 AGPL 的 rankland 数据互不影响，但发布时两份许可都要带到。
xcpcio 那边只取"目录树 + config（赛名/时间/题号）+ run/team"，**没有题名**。

---

## 6. 常见问题

**Q：`❌ 不知道你的 CF handle`**
A：CF 只导自己的提交（整场 gym 一万多条）。在 `acm-data/raw/Scaper/me.json` 的
`cf.handle` 里填你的 CF 用户名即可；某场用别的账号就在那场清单条目的 `handle` 里单独写。

**Q：QOJ 抓不到 / 提示"返回的是登录页"**
A：`me.json` 的 `qoj.cookie` 没填或过期了。重新登录 QOJ → F12 → Network → 任一 qoj.ac
请求 → Request Headers 的 `Cookie:` 整行粘进去。不想折腾 cookie 就还按老办法：浏览器
Ctrl+S 存提交列表页面，然后不带 `--fetch` 跑 `QOJ_submissions_scraper.py`。

**Q：CF 那边显示"属于 XXX 的 0 条"**
A：这个账号在该 gym 里确实没有提交 —— **是正常结果，不是错误**（流水线会跳过
这个来源）。本例就是如此：比赛打在 PTA 上，补题在 QOJ。

**Q：某场的 slug 是什么？**
A：`python fetch_rankland_tree.py` 生成 `_rankland_slugs.md` 查；
或 `fetch_rankland_srk.py --list <前缀>`。榜单里没有的场次（非 ICPC/CCPC 系列）
才需要自己按同样风格起一个，并在 `slugFrom` 里写清来路。

**Q：`crate-merge` 报"字段值不一致"**
A：同一个字段被两个来源写成了不同的值。检查是不是把 `role` 搞错了
（例如让 srk 也出 ratio）。合并**保留先到的**（`board` 排在最前）。

**Q：某场为什么没有 ratio / 题名？**
A：**先看这场的 `board` 是谁**（`npm run crate:xcpc -- --list` 一眼能看到）：

| 情况 | 结论 |
|---|---|
| `board` 不是 `xcpcio` **也不是 `pta`/`cf`/`nk`** | xcpcio 没收录这场、PTA/牛客上也没有它的榜 → **没有 ratio 源**。全树只剩 3 场是这种（`missing_ratio_report.py` 一条命令列出来）。想要难度就去 `xcpc_registry.py xcpcio --slug <slug>` 看能不能人工指一份 |
| `board` 是 `xcpcio` / `pta` / `nk` 但个别题没难度 | 那道题榜单里没人过 / 数据缺失 —— **宁可不给，也不给一个错数**（`fmt_ratio` 分母为 0 时返回空） |
| 没题名 | 该场所有来源都没有题名：rankland 索引里那些题号的 `title` 本身就是空串（实测 `gdcpc19th` 整场 13 道、`ccpc2025preliminary` 9 道），CF 榜单里没有题信息、QOJ 也没记录 → **无源可得**（全树只剩 34 道） |

**Q：包明明 0 错误，怎么还会丢字段？**
A：`crate:check` 只查"能不能导入"，**不查"该有的字段在不在"**。所以出包后对一眼覆盖数字
（参考基线：`P 2071｜ratio 2031｜题名 2037｜链接 2050`；数字随重建变），
或用 `python source_report.py <slug>` 看单场逐字段的来源与落选值。
症状往往是"某个来源被降级了、但它的角色没留全"（§4.4）。

**Q：为什么 R 上有的没有 `language`？**
A：**只有 PTA 没有**（33 条）。CF 的提交全有；**QOJ 也有** —— 但必须走**全局列表页**
`/submissions?submitter=<用户名>`（那一页多一列"语言"），场次页 `/contest/<id>/submissions`
**没有**这一列。走全局页抓的 `qoj_submissions.json` 948 条**全部带语言**
（条数随数据变）。
PTA 是数据源本身的限制（`xcpcRankings` 只有"某队某题是否通过"），不是适配器漏取。

**Q：怎么加一场新的？**
A：① 在 `_rankland_slugs.md` 找到 slug（或让 `link_qoj_activity.py` 帮你建）；
② 在**注册表** `xcpc_registry.json` 的 `contests` 里加一条（`board` 选 `srk` 就是"整棵树自动"那条路）；
③ `xcpc_registry.py build` + `npm run crate:xcpc -- --check`；
④ 想让这场有权威难度：`xcpc_registry.py xcpcio --slug <slug>`（对不上就人工在注册表顶层
`xcpcio` 里写死路径），再 `build` 一次。

**Q：改了 extKey 规则会怎样？**
A：**变了就是新身份** —— 旧节点会变成重复。extKey 一旦导入就不能改
（与 HDU / 牛客同一条铁律）。

**Q：拖哪个包进应用？**
A：图省事就拖 `acm-data/nodes/all_nodes.json`（**全树一份**、自带祖先节点，**合成节点也在里面**）；
只想要爬虫抓出来的那部分就拖 `mix_contain_xcpc.json`（混装 XCPC 来源，**不含合成节点**）；
想细粒度就按类逐份拖（合成节点要另走整条链 `npm run crate:all`）。⚠️ **`hdu` / `nk` 多校是另外两个包**
（`hdu-multi-university.json` / `nk-multi-university.json`，名字带 `-multi-university`）。

**Q：为什么 CF 正式比赛里，同一道题在两场各有一个 P？**
A：那是 **Div1/Div2 共用题**（例：2268B 和 2269D 本质是同一道题）。**每场出自己
完整的题单**（题号、题名都以该场自己的比赛页为准），所以两边各留一份；对应关系记在
`cache/cf_contest/reuse.json`（`{"2269:D": "2268:B", …}`），留给判重 / AC 统计用。
判据是"**同一轮 + 官方题名相等**"，老家 = 题池里拥有该名字的那场（CF 公开 API 没有 polygon 源题 id，
Polygon 又无权限 ⇒ 只能这样判）。

**Q：为什么某道题没有 `cfDifficulty`？**
A：**难度不一定有、而且出现时间乱序**（CF 常在该题出现很久之后才补，补的顺序也与出题时间无关）
⇒ **缺失不是错误**、也不缓存"这题没难度"；`cf_contest_adapter.py --force` 重刷题池即可再试
（实测当前覆盖 3648/3693 个 P）。

**Q：`⚠️ 本轮没有产出 X 类 —— 旧产物仍在` 是什么意思？**
A：那一次运行没有产出 X 这个类（例如某来源 fail-soft、或分类映射没命中）。**旧产物没被删**
（它可能是唯一能导入的一份）⇒ 只落一个 `nodes/X.json.stale` 标记提醒你"这份可能是过期数据"。
要么重跑补齐，要么就用旧的那份（内容是否过期自己判断）。`other.json` 这种"根本不是类"的遗留可删。
