# acm-data —— 数据流水线

这里放**应用代码之外的一切**：爬虫原始数据、转换脚本、产出的节点信息、合并结果。
应用本身（`src/`、`index.html` …）在上一层，两者互不干扰。

```
acm-data/
├── raw/          各平台**原始数据**（爬虫直接导出，不手工编辑）
├── scripts/      原始数据 → 节点信息的**转换脚本**（每个平台一个；有的整套放在 raw/<平台>/）
├── nodes/        产出包：**一个类一个包**（导入包 crate）+ 两个派生包
│                 （`mix_contain_xcpc.json` 混装 / `all_nodes.json` 全量）
├── merged/       **示例/临时**合并结果（`sample_*`、`tree.json`）
├── reports/      构建期**报告**：字段体检 / 原料需求（各一份机器可读 JSON + 一份人看的 md）
└── archive/      历史/废弃产出（可随时清空）
```

## 数据怎么流

```
 raw/             scripts/              nodes/                    merged/
 爬虫导出  ──→  转换脚本生成 crate  ──→  每类一份（11 份）  ──→  示例/临时合并
                                   ├─→  mix_contain_xcpc.json（混装，一次导入用）
                                   └─→  all_nodes.json（可选：再加上 atcoder / cf-contest / 牛客多校 / 杭电多校）

（合成节点不在上面这几份里：容器 + 组头 + 成员指针由链上 `synth-bind.mjs` **按 nature**
  建出来、直接写进最终包 `all_nodes.json` —— 不再有单独的"合成节点包"。）
```

三步命令（**在项目根目录用 PowerShell 跑**；PowerShell 不用 `\` 续行，要写成一行）：

```powershell
# ① 转换（每个平台一个脚本，自己写）
#    ⚠️ 示例产物写 merged/ 且以 sample_ 开头 —— nodes/ 里放的是**真包**，别覆盖
python acm-data/scripts/qoj_adapter.py problems acm-data/raw/qoj_problems.json -o acm-data/merged/sample_qoj_crate.json

# ② 合并 + 体检（多个产出汇成一份；路径带空格要加引号）
npm run crate:merge -- acm-data/merged/sample_qoj_crate.json -o acm-data/merged/tree.json

# ③ 用应用真实引擎离线试跑（只读，不写任何数据）
npm run crate:check -- acm-data/merged/tree.json
```

然后把 `merged/tree.json` 拖进应用的「📥 节点自动导入」。

> ⚠️ 上面第 ① 步只转**题目**。想把提交记录也转进来：模式写 `both`，第二个参数给**你自己的**提交导出
> （`qoj_submissions.json` 是个人数据，不随这份仓库），例如
> `python acm-data/scripts/qoj_adapter.py both acm-data/raw/qoj_problems.json <你的提交导出> -o acm-data/merged/sample_qoj_crate.json`。

> **生产包在 `nodes/`**：由各平台流水线产出，**一个类一个包**（`qoj.json`、`cf-gym.json`、
> `cf-contest.json`、`atcoder.json`、`xcpcio.json`、`rankland.json`、`pta.json`、`srk.json`、
> `nk-ranklist.json`、`nk-multi-university.json`、`hdu-multi-university.json`），
> 外加**两个派生包**：
> · **`mix_contain_xcpc.json`** —— **混装包**：7 个 XCPC 来源包（qoj / cf-gym / pta / rankland /
>   srk / xcpcio / nk-ranklist）。
>   **排除** `atcoder` 与 `cf-contest`（它们各是一棵独立的树）。⚠️ 名字照实叫"混装、但含 XCPC"——
>   qoj 与 cf gym 里也有大量非 XCPC 的内容，若叫 `xcpc.json` 会让人以为"只装 XCPC 赛系"。
> · **`all_nodes.json`**（**可选**，`--all-nodes`）—— 上面那份 + `atcoder` + `cf-contest` +
>   `nk-multi-university` + `hdu-multi-university`。**它自带全部祖先节点，可单独导入**。
>
> **合成节点（C 层的容器 + 组头 + 成员指针）不单独出包**：由链上 `synth-bind.mjs` 按 nature
> 建出来，直接写进最终包。最可靠的导入方式就是 `all_nodes.json`（**从空树起**只拖它一个文件）。
> 细节见 `raw/Scaper/05 xcpc/_usage.md`。

## 三个目录各自的要求

### `raw/` —— 只读

爬虫的原始导出，**不要手工编辑**（改了就没法重新生成）。
文件名建议 `<平台>_<内容>.json`，如 `qoj_problems.json`、`cf_submissions.json`。

### `scripts/` —— 转换脚本

每个平台一个，负责把 `raw/` 里的原生格式转成 crate。
写法的参考与清单见 **[../docs/scraper-guide.md](../docs/scraper-guide.md)**，
可直接复用 `../scripts/crate.py` 的 `Crate` 构造器（零依赖）。

> **但转换脚本不一定非放这里。** 如果某平台的"抓取脚本 + 适配器 + 说明"
> 天然是一套，就整套放在 `raw/<平台>/` 下，省得两边来回跳。
> 目前的两个例子：
> `raw/Scaper/01 nk/`（入口 `npm run crate:nk:browser`，出 `nk-browser.json`）与
> `raw/Scaper/02 hdu/`（入口 `npm run crate:hdu`），
> 说明都见各自目录的 `_usage.md`。

### `nodes/` —— 各脚本产出（**一个类一个包**）

一份一个文件，命名与**类**对应：`qoj.json`、`cf-gym.json`、`cf-contest.json`、`atcoder.json`、
`xcpcio.json`、`rankland.json`、`pta.json`、`srk.json`、`nk-ranklist.json`、
`nk-multi-university.json`、`hdu-multi-university.json`，外加：
`mix_contain_xcpc.json`（混装包，见上）、`all_nodes.json`（可选，全树一份 —— 合成节点在其中）。
**不要手工改**：它们随时能由流水线重新生成。
⚠️ 某个类**某次没产出时不会删旧产物**（旧产物可能是唯一能导入的一份），只落
`<类>.json.stale` 标记 + 运行末尾警告 ⇒ 见到它就说明"这份可能是过期数据"。

### `merged/` —— 示例/临时合并结果

合并器写的，主要用于**演示与离线体检**（`sample_*`、`tree.json`）。
失败时合并器**不会写文件**，所以这里出现的都是"体检通过"的结果。

> 生产包直接放在 `nodes/`
> （拖 `all_nodes.json` 一份、或拖 `mix_contain_xcpc.json`、或逐份拖类包，都行）。

### `reports/` —— 构建期报告（**同时随包发给应用**）

`field-coverage.py`（字段**体检**：每个「类型 × 字段」的应有 / 已有 / 缺 / 豁免）与
`material-needs.py`（**原料需求**：还差哪些原料、去跑哪条命令）各写一份 JSON + 一份 md。

⚠️ 这两份 JSON **还会被塞进包顶层 `reports`**（`scripts/embed-reports.py`，`build-all.py` 的**链尾一步**）——
应用里那个一级 Tab「🩺 体检 / 需求」读的就是包里这一节，不用回仓库翻文件。
顺序不能反：报告读的**就是**刚产出的这个包，所以只能"先出报告、再塞回包顶层"。

## `extKey` 由谁定

**由你在转换脚本之间对齐** —— 合并器与应用都不规定它。

唯一的要求（应用侧硬约束）：

- `extKey` **非空**、**全局唯一**
- 一旦定型**永不修改**（改了就是换身份，下次导入会新建节点）
- 建议用平台稳定 ID，不要用题号/标题（它们会变）

具体拼法各平台自由，但**同一个平台内部要统一**。

## 自带的示例

`raw/` 与 `merged/` 里的 `*qoj*` 是**仓库自带的示例**（`npm run crate:sample:qoj` 生成），
用来演示完整流程。你要清理时直接删掉即可，不影响任何东西。

**能真正跑通的完整例子**（抓取 → 解析 → 导入包 → 赛时通过率）：

| 平台 | 目录 | 一条命令 | 产出 | 说明 |
|---|---|---|---|---|
| HDU（杭电多校） | `raw/Scaper/02 hdu/` | `npm run crate:hdu`（= 本地原料→包；抓页面用 `crate:hdu:fetch`，纯解析用手存那条 `crate:hdu:browser`） | `nodes/hdu-multi-university.json` | 榜单是 HTML，逐格数队伍 |
| 牛客（多校） | `raw/Scaper/05 xcpc/nk_multi_fetch.py build`（浏览器手爬那条路在 `raw/Scaper/01 nk/`，出 `nk-browser.json`） | `npm run crate:nk` | `nodes/nk-multi-university.json`（**2358 条 / 40 场**） | 榜单是 JSON 接口，通过队伍数直接给 |

两者**通过率口径一致**（通过队伍数 ÷ 有效队伍数），所以难度可比。
