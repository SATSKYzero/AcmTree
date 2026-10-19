# Acm_Tree

个人 ACM 训练记录工具。用一棵树记录「平台 → 系列 → 比赛 → 题目 → 提交记录」，
在树上做补题追踪、难度分布分析与检索。

- **版本**：`v9.5.0`
- **形态**：纯前端、无构建步骤、无依赖安装。`app/index.html` + ES Module 直接跑
- **数据**：全部存在浏览器 IndexedDB，可导出为 JSON 文件

---

## 快速开始

双击**仓库根**的 `启动AcmTree.bat`，浏览器会打开 `http://localhost:8321/index.html`。
需要 **Python 3** 在 `PATH` 里（服务器就是 `app/scripts/dev-server.py`）；**还要 Node.js** ——
应用里那颗「🛠 重建总包并导入」走的产包链里有几步是 `.mjs`（用 `node` 跑），跑 `npm` 脚本和测试同样要它。
一条装完（PowerShell）：`winget install --id OpenJS.NodeJS.LTS -e`（或去 <https://nodejs.org/> 下 LTS）。
（**"能打开应用" ≠ "能重建包"**：缺 node 时那一步会明确报"PATH 里找不到 node"并给出上面这条命令；装完**重开主脚本**再试。）
⚠️ **别直接双击 `app/index.html`** —— ES 模块在 `file://` 下会被浏览器拦掉，必须经 bat（或别的本地服务器）打开。

第一次打开是空树。**想直接看到成品数据**：点顶栏的「📥 节点自动导入」，把
`app\acm-data\nodes\all_nodes.json` 拖进去 —— 那是全量包（各平台的分类包在同一个目录里）。
不想导入、想自己录，就用「➕ 添加根节点」一层层建（应用内「📖 指南」第一节有三步说明）。

数据本体在**浏览器**（IndexedDB）里，工作区里的 JSON 只是**导出包**。**保存 / 回溯**用
**`作者专用\保存快照.bat`**：先回应用里导出全量包（落到 `app\acm-data\nodes\all_nodes.json`），再双击它记一次
快照（只需装一次 **[Git](https://git-scm.com/download/win)**；凭据与抓取页面归档不进仓库）。
它一次记**两份**：本仓库（`.git`）只装**代码与规则**，另一份 `.git-full` 装**整个工作区**
（连抓取缓存与导出包一起，用来复原）—— 两份的差别只有 `.gitignore` 里那段说明，见那里的注释。

> 界面里每个按钮、每条口径、出问题按什么顺序查，都写在 **[app/docs/guide.html](app/docs/guide.html)**
> —— 它就是应用右上角「📖 指南」打开的那一份，离线可看。
> 里面还有一节讲**清除本机的个人数据**（凭据与抓取产物，三档可选）。

该脚本启动的是 `app/scripts/dev-server.py` 而**不是** `python -m http.server`，原因是后者
只发 `Last-Modified`、不发 `Cache-Control`，浏览器会按启发式规则缓存 ES 模块，导致
**"新文件 + 旧模块"的版本混合**——症状是某个新功能报 `xxx is not a function`，
极难排查。`dev-server.py` 对每个响应加 `no-store`，刷新即是最新代码。

> 顺带：这个服务器**就是"主脚本"** —— 原料处理链（注册表 → 分类规则 → 产包 → 离线试跑）
> 在它**进程内**跑（`app/scripts/build_chain.py`，与命令行 `app/scripts/build-all.py` 同一份步骤表），
> 应用里那个「🛠 重建总包并导入」按钮通过 `/api/ping` `/api/build` 指挥它，跑完把包**自动导入**。
> 纯前端页面自己没法执行本机脚本，所以这件事必须由本机进程接住；这个进程同时是
> 页面的服务器与处理链的拥有者。
> 不想要就加 `--no-build-api`（只影响应用里那个按钮；命令行跑 `app/scripts/build_chain.py` 照旧）。

> 改了 `app/src/` 下的文件后如果页面行为像旧代码，先 `Ctrl+Shift+R`（按钮会自己告诉你"页面是旧代码"）；
> 若反复出现，确认启动的是 `dev-server.py` 而不是 `python -m http.server`。
> **改过 `app/scripts/dev-server.py` 不用管**：它检测到自己被改动会**自动重启**；
> 再双击一次 `启动AcmTree.bat` 也是安全的（已在跑就只开浏览器，旧版本会被自动换掉）。

---

## 目录结构

仓库分**两段根**：给人用的东西在**仓库根**，跑应用的机械部分全在 **`app/`** 下
（本机服务器的静态根就是 `app/` ⇒ 页面是 `/index.html`、模块是 `/src/…`，**不是** `/app/index.html`）。

```
启动AcmTree.bat            启动脚本（必须留在仓库根：它按 %~dp0 找 app\scripts\dev-server.py）
package.json               脚本与测试入口（每条都带 app/ 前缀）
AGENTS.md / README.md      干活规范 / 本文件

个人数据/                  me.json（凭据）等本机个人数据（不进 git）
作者专用/                  保存快照.bat（保存/回溯，双击它；它自己 cd 到仓库根）
  └── docs/                规范与防遗忘机制.md、变更记录.md、待办.md…

app/                       ← 机械层根（服务器的静态根）
├── index.html             应用外壳：静态内置 Tab、各分页内容、全部 CSS
├── plugins.json           插件清单（启停与依赖声明）
│
├── src/
│   ├── I_app.js           应用入口：初始化顺序与事件注册
│   ├── A_constants.js     常量：APP_VERSION / EVENTS / 状态枚举 / 难度配色
│   ├── A_registry.js      数据注册表：每个字段的 persist / export / snapshot 三开关
│   │
│   ├── core/              领域核心（不依赖 UI）
│   │   ├── pluginRegistry.js  插件注册表 + 10 个注册 API + RENDER_SLOTS
│   │   ├── autoCompute.js     派生字段自动计算
│   │   ├── model/             状态、节点、副页、常量、会话信息、脏标记
│   │   ├── ops/               各类操作（节点/树/副页/标签/视图/批量/增量 upsert/虚拟统计/设置）
│   │   ├── query/             查询（节点、统计）
│   │   └── validate/          校验（重名冲突、展开上限、extKey 全局唯一）
│   │
│   ├── transaction/       事务层：Immer produce + 校验 + 提交/回滚 + 历史栈
│   ├── persistence/       持久化：IndexedDB 读写 + 状态差分 + 统一接口
│   ├── shell/             外壳：状态容器、统一事务入口、初始化、自动保存、插件引导
│   ├── view/              渲染层：节点渲染、HTML 构建、展示数据适配
│   ├── ui/                交互层：Tab、事件桥接、文件夹模式、统计图、模态框、定位
│   ├── handlers/          处理器：JSON 导入导出、批量导入、排序、导出格式
│   ├── features/          插件（见下）
│   ├── utils/             纯工具：转义、颜色、ID、时间、事件
│   ├── vendor/immer.mjs   随仓库自带的 immer（浏览器靠 importmap 解析裸包名 immer）
│   └── test/              单元测试
│
├── scripts/
│   ├── run-tests.mjs      单元测试运行器
│   ├── run-smoke.mjs      冒烟测试运行器
│   ├── dev-server.py      开发服务器（禁用缓存）
│   └── smoke/             冒烟测试：DOM 桩、IndexedDB 桩、断言工具、各用例
│
├── acm-data/              原料与导出包（不是数据真源）
└── docs/                  应用内「📖 指南」与各专题文档
```

---

## 插件

清单在 `app/plugins.json`，支持 `enabled: false` 停用与 `requires` 依赖排序。

| 插件 | 类型 | 作用 |
|---|---|---|
| **ContestOverview** | 文件夹节点视图 | 🏁 比赛补题概览：以比赛为单位、按难度轴横向铺开题目，点按状态着色 |
| **Search** | 一级 Tab | 🔍 检索：下分 **🏆 比赛检索**（C 节点：名称/时间/年代/性质/种类/地区/归属/题目数）+ **📝 题目检索**（P 节点：题号/题名/标签/比赛/平台/系列/状态/难度）；都能二次排序 + 点击跳转到树上 |
| **AutoImport** | 一级 Tab + 文件夹视图 | 📥 节点自动导入：把爬虫导出的 crate **增量合并**进主树，按 `extKey` 身份查重、逐字段策略保护手填数据、导两次零副作用 |

`app/src/features/TestnumOp/` 是**示例插件**（加 `testNum` 字段、求和派生字段、编辑扩展、渲染槽），
用来演示插件 API 的全部钩子，**不插在 `app/plugins.json` 里**（不给页面，用不到就当样例放着）。

写插件照 `app/plugins.json` 里那 3 个插件（`app/src/features/`）改即可 —— 注册 API、ctx 结构、
生命周期、错误隔离语义都能从它们身上读出来。

`AutoImport` 有独立设计文档：**[app/docs/auto-import.md](app/docs/auto-import.md)**
（含给爬虫作者的 crate 格式契约、`extKey` 拼法约定、查重与合并语义）。

---

## 测试

```
npm test            # 单元测试（纯逻辑：属性表/投影/派生/来源层/账户/历史…）
npm run test:smoke  # 冒烟测试（UI 接线、插件、事务、定位、判重、冻结不变量…）
npm run test:all    # 两者都跑
```

**只跑必要部分**（改了哪儿就跑哪儿，别整套重跑）：

```
npm test -- derive synth        # 跑文件名含 derive 或 synth 的（可给多个，命中任一就跑）
npm run test:smoke -- search    # 冒烟同理
node app/src/test/derive.test.js        # 就一个文件时直接跑它（⚠️ 别用 `node --test`，见下）
JOBS=1 npm test -- derive               # 怀疑"并行才红"时串行跑同一个
```

`npm test` 默认并行 `min(核数, 8)` 路，**几秒钟**量级；它"最慢的文件先发车"（按上次耗时排序，
缓存在系统临时目录，不进仓库）。想看汇总又不想被 PowerShell 的管道拖慢：

```
npm test *> "$env:TEMP\t.log"; Get-Content "$env:TEMP\t.log" -Tail 3
```

两个运行器**结束时会打印实际文件数与耗时** —— 这里不抄数字（抄了就会过期）。
**不要用 `node --test`** —— 它在受限环境下会为每个测试文件 spawn 子进程并用管道捕获输出，
被沙箱拒绝后报 `spawn EPERM`，表现成"12 个文件全部失败"，但实际一个测试都没执行。
细节（为什么自研运行器、怎么写新测试）见 [`app/docs/如何使用test.md`](app/docs/如何使用test.md) 与 `app/scripts/run-tests.mjs` 里的注释。

---

## 文档索引

**看 [app/docs/README.md](app/docs/README.md)** —— 那份是文档地图：每份管什么、我该读哪份、哪些是生成物（别手改）。

最常用的三份：

| 我想…… | 读 |
|---|---|
| 用起来（导入、补题、看统计、出问题怎么查） | **[app/docs/guide.html](app/docs/guide.html)**（应用内点右上角「📖 指南」） |
| 一口气讲清整个系统 | **[app/docs/架构一页.md](app/docs/架构一页.md)** |
| 跑测试 / 写测试 | `package.json` 的 scripts（`npm test` / `npm run test:smoke`） |

---

## 爬虫工具（给外部脚本用）

| 命令 | 作用 |
|---|---|
| `npm run crate:selftest` | 验证 `app/scripts/crate.py` 工具本身可用 |
| `npm run crate:sample:qoj` | 把 `app/acm-data/raw/qoj_problems.json` 转成导入包（15 条，写入 `app/acm-data/merged/`）—— 这是**教学用的最小适配器示例**，不是生产链路（生产那条在 `Scaper/05 xcpc/qoj_adapter.py`）。想连提交记录一起转，自己加参数：`python app/acm-data/scripts/qoj_adapter.py both <题目文件> <你的提交导出> -o <输出>` |
| `npm run crate:merge -- a.json b.json -o merged.json` | **合并多个数据脚本的产出 + 离线体检** |
| `npm run crate:check -- merged.json` | 用**应用真实引擎**离线试跑（只读，不写数据） |

**数据流水线放在 `app/acm-data/`**（原始数据 / 转换脚本 / 节点信息 / 合并结果），
与应用代码分开，互不干扰。

> ⚠️ 下面这几个 `crate:*` 流水线**要先有原料**（抓取缓存）。这份仓库里**没有缓存**：
> 想看它要什么，先加 `--dry-run`（只列清单、不抓不写，例如
> `python "app/acm-data/raw/Scaper/05 xcpc/xcpc_pipeline.py" --dry-run`）；
> 真要出包要么联网抓一轮（要自己的凭据，见各来源目录的 `_usage.md`），要么加 `--offline` —— 缺文件会当场点名报错。

`app/scripts/crate.py` 是零依赖的 Python 构造/校验器，可直接抄进你的爬虫项目。
`app/scripts/crate-merge.mjs` 是"主脚本"：把各平台数据脚本的产出合并成一份，
并检出跨包冲突（同 key 不同身份、字段值矛盾、断链、层级非法、成环）。
`app/scripts/crate-check.mjs` 复用应用同一套模块，因此试跑结论与浏览器里一致。
详见 [app/docs/scraper-guide.md](app/docs/scraper-guide.md)。
