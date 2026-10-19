# 怎么跑测试

## 一条命令

```
npm test            # 单元测试（纯逻辑：模型、查询、校验、注册表、难度轴、HTML 生成…）
npm run test:smoke  # 冒烟测试（UI 接线、插件、事务、定位、判重、自动导入…）
npm run test:all    # 两者都跑
```

两个运行器**结束时会打印实际文件数** —— 以它打印的为准（写死在这儿就会过期）。

单独重跑某个文件：

```
npm test contest          # 只跑文件名含 "contest" 的文件
node src/test/model.test.js
```

单跑不过时，直接 `node <文件>` 看完整报错。

---

## 为什么不用 `node --test`

`node --test` 在本项目的受限运行环境里**跑不起来**，而且报错很容易误读：

```
ℹ tests 12
ℹ fail 12
  Error: spawn EPERM
```

**根因**：`node --test` 会为每个测试文件 `spawn` 子进程，并用**管道**捕获其输出。
受限沙箱禁止打开命名管道，于是**所有测试文件都被报成"失败"**——但其实是**一个测试都没执行**。

（如果写成 `node --test src/test/`，Windows 下还会先报路径找不到，症状变成 `tests 0`，
所以很容易被误诊成"Windows 路径问题"。**不是路径问题**。）

**解法**：`scripts/run-tests.mjs` 仍然一个文件一个进程（保持模块状态隔离，与 `--test` 语义一致），
但用 `stdio: 'inherit'` 让子进程直接写终端——不经过管道，因此不受限制。

> 在不受限的普通终端或 CI 里，`node --test` 是能跑的，`npm run test:native` 保留了这个入口。
> 但 `npm test` 用的是自研运行器，两种环境都能跑。

---

## 测试放在哪、怎么分

| 类型 | 位置 | 运行方式 | 覆盖什么 |
| :--- | :--- | :--- | :--- |
| 单元测试 | `src/test/*.test.js` | `npm test` | 纯逻辑：模型、查询、校验、注册表、难度轴、HTML 生成 |
| 冒烟测试 | `scripts/smoke/*.smoke.mjs` | `npm run test:smoke` | UI 接线、DOM 装配、插件激活与端到端 |

### 写单元测试的一条硬规矩

**被测模块必须不依赖 `view/` 或 `shell/`。**

原因：这两个目录会牵出 `shell/state.js → immer`，而 `immer` 是**裸包名**——
浏览器靠 `index.html` 的 import map 解析，Node 没有 import map，会直接
`ERR_MODULE_NOT_FOUND: Cannot find package 'immer'`。

这个失败极其隐蔽：`node --test` 会把它算成"文件加载失败"，
而手工统计 `pass` 数时会显示成 **0 通过 0 失败**，看起来像"没有测试"而不是"测试挂了"。

所以插件/模块要按这个方式分层：

```
纯逻辑层（不 import view/ shell/）→ 进 src/test/，可单测
接线层  （import view/ shell/）   → 进冒烟测试，或由 scripts/smoke 覆盖
```

`src/features/ContestOverview/` 就是这么拆的：
`axis.js` / `collect.js` / `render.js` 是纯逻辑（有单测），
`filter.js` / `index.js` 是接线层（由冒烟测试覆盖）。

### 冒烟测试的运行前提

冒烟测试是普通脚本（不是 `node:test` 用例），因为必须在 **import 被测模块之前**
先装好 DOM 桩。它通过 `scripts/smoke/specifier-loader.mjs` 补上 Node 缺失的两处解析：

1. `immer` → `src/vendor/immer.mjs`
2. `/src/...`（`plugins.json` 里写的是浏览器语义的服务器根路径）→ 仓库的 `src/`

这两处都是**环境差异**，不是代码 bug。加断言用 `scripts/smoke/harness.mjs` 的
`group / ok / eq / report`；`report()` 会在有失败时以退出码 1 结束。

---

## 加新测试

- 纯逻辑 → 在 `src/test/` 建 `xxx.test.js`，`import { test } from 'node:test'`，自动被 `npm test` 收录
- 涉及 DOM / 插件接线 → 在 `scripts/smoke/` 建 `xxx.smoke.mjs`，用 harness 的断言，自动被 `test:smoke` 收录
