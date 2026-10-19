// ================================================================
// 把 **Python 那几套 selftest** 挂进 `npm test`
//
// 为什么要有这一条（实测踩到）：
//   `scripts/devserver/selftest.py` 的入口写的是 `sys.exit(main())`，而那个文件**没有
//   `main`**（入口叫 `_selftest`）⇒ 一跑就是 `NameError`，**那 89 项断言从来没执行过**。
//   没有任何东西会发现这件事 —— `npm test` 只跑 JS，那几套 selftest 全靠人记得手打。
//   （本仓同类教训记过两次：没人 import 的 `.py` 里的 SyntaxError、以及"0 断言也 exit 0"。）
//
// 所以**别靠人记得**：这里把 11 套 selftest 逐个真跑一遍，退出码非 0 就红。
// 一共约 4s，`npm test` 从 3.3s 变 ~7s，换掉整整一类"静默烂掉的自测"，值。
//
// ⚠️ 路径带空格（`05 xcpc`）也没关系：这里用 `spawnSync` + **参数数组**，不过 shell。
// ⚠️ `stdio: 'inherit'` 是刻意的（同 `pythonSyntax.test.js`）：受限沙箱里"管着子进程的
//    输出"= EPERM；inherit 让 Python 自己把失败清单打到测试输出里。
// ⚠️ 有的 selftest 依赖**个人样本**（如 `04 qoj/qoj_submissions.json`，那是个人提交导出，
//    这份仓库里已经清掉）⇒ 这类用第 4 个参数 `requires` 声明前置文件，缺了就 **skip**（不是红）。
//    别改成 assert：那样任何一份清过个人数据的仓库都会一跑测试就红。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 跑 python 子进程的环境：**强制 UTF-8 的 stdio**。
 *
 * 为什么（2026-10-18 实测）：子进程的 stdout 一旦不是真控制台（管道 / 重定向到文件），
 * Python 就按 `locale.getpreferredencoding()` 编码 —— 也就是**系统 ANSI 代码页**。
 * UTF-8 Beta 关掉时它从 65001 变回 936(GBK)，而 GBK 里没有 `✅❌⚠️✔✘ℹ↳⟨⟩` 这些字符
 * ⇒ selftest 打第一行符号就 `UnicodeEncodeError`（实测 8 套全崩）。这里把它钉成 utf-8，
 * 于是"跑测试"与系统区域设置**脱钩**。
 */
function pyEnv(extra = {}) {
    return { ...process.env, PYTHONIOENCODING: 'utf-8', ...extra };
}

/** 跑一套 selftest；退出码非 0 ⇒ 报红并把它的输出留在测试日志里
 *  @param requires 必须存在的前置文件（仓库相对路径）；缺任一个就 skip 这条 */
function runSelftest(name, args, cwd = ROOT, requires = []) {
    test(`自测：${name}`, (t) => {
        const missing = requires.filter(rel => !fs.existsSync(path.join(ROOT, rel)));
        if (missing.length) {
            t.skip(`缺前置样本 ${missing.join('、')}（个人样本，这份仓库里已清掉，属预期）`);
            return;
        }
        const res = spawnSync('python', ['-B', ...args], { cwd, stdio: 'inherit', env: pyEnv() });
        if (res.error) {
            assert.fail(`起不来 python：${res.error.message}（机器上没有 python 时这条会红，`
                + '请让 CI/本机装一个，或把这条守卫挪到有 python 的环境）');
        }
        assert.equal(res.status, 0, `${name} 自测没过 —— 上面那份 ❌ 清单就是原因`);
    });
}

// ⚠️ 加一套 selftest 时**必须往这里添一行**（这就是"别靠人记得"的那一步）。
//    清单就是下面这些（规矩就是这些 selftest 每次都要跑）。
// ⚠️ 其中 4 套要读**树包** `acm-data/nodes/all_nodes.json`，而树包是**生成物**
//    （`clean-personal` 档位 1 会删它，用户 2026-10-19 定："既然是生成所需的，应在档位 1 就清除"）
//    ⇒ 缺包就 **skip 并打印原因**（不是红）。这也是"公开发布副本里 `npm test` 能全绿"的前提。
const PKG = ['acm-data/nodes/all_nodes.json'];
runSelftest('判题结果词表（crate.py selftest）', ['scripts/crate.py', 'selftest'], ROOT, PKG);
// QOJ 下载器：「提交时间」列**分列**（相对时间不许进 `提交时间`）+ 合并时绝对优先。
// ⚠️ 这个 bug（相对时间当 AC 时间）**不会有任何别的东西红** —— 值非空、体检只说"有值"，
//    要等用户看见树上写着 `00:31:01`。所以它必须自己钉在源码这一层（`--selftest`，不联网）。
runSelftest('QOJ 提交时间分列（04 qoj 提交下载器 selftest）',
    ['acm-data/raw/Scaper/04 qoj/QOJ_submissions_scraper.py', '--selftest']);
// ⚠️ 这一份是**已停用的老建组方案**（链上跑的是 `synth-bind.mjs`）——留着它只为"别烂"；
//    它一旦被谁复活，链上就会同时有两个建组器（`build_chain.py` 的自测里有守卫挡这一步）。
runSelftest('分类规则（nature_rules.py · 已停用的老方案，selftest）',
    ['scripts/nature_rules.py', 'selftest']);
runSelftest('XCPC 抓取链（05 xcpc selftest）', ['acm-data/raw/Scaper/05 xcpc/selftest.py'],
    ROOT, ['acm-data/raw/Scaper/04 qoj/qoj_submissions.json']);
runSelftest('nature 回代（nature-baseline selftest）', ['scripts/nature-baseline.py', 'selftest'], ROOT, PKG);
runSelftest('字段体检（field-coverage）', ['scripts/field-coverage.py', '--selftest'], ROOT, PKG);
runSelftest('原料需求（material-needs）', ['scripts/material-needs.py', '--selftest'], ROOT, PKG);
runSelftest('处理链（build_chain）', ['scripts/build_chain.py', '--selftest']);
runSelftest('随包报告（embed-reports）', ['scripts/embed-reports.py', '--selftest']);
runSelftest('clist 难度（clist-difficulty selftest）', ['scripts/clist-difficulty.py', 'selftest']);
// HDU 多校的自动抓取（2026-10-17 新）：只测**纯逻辑**那部分（行身份 / bundle 去重 / `--force` 语义），
// 不联网、不动真原料 —— 那两个坑（拿链接里的 uid 当身份、把重复页存两遍）会把队数**静默数两遍**。
runSelftest('HDU 多抓（hdu_multi_fetch selftest）',
    ['acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py', '--selftest']);
// 性质注册表的**形状判据**（主脚本 `PUT /api/nature-registry` 与只读体检共用同一份）
runSelftest('性质注册表校验（nature-registry-check）', ['scripts/nature-registry-check.py', '--selftest']);
// ⚠️ 这一套必须在 `scripts/` 下用 `-m` 跑（相对 import + `selftest_kit` 都要那个 cwd）。
//    这里**刻意只挂这一个入口**：`dev-server.py --selftest` 调的是同一个 `_selftest()`，
//    跑两遍是白花 1s；而**最容易烂的正是这个模块入口**（`__main__` 写成 `sys.exit(main())` 就一跑即炸）。
runSelftest('本地服务器（devserver）', ['-m', 'devserver.selftest'], path.join(ROOT, 'scripts'));

// ★ 上面那条 `env: pyEnv()` 必须真的在（2026-10-18 加）：源码级钉住 ——
//   UTF-8 Beta 关掉时，管道的默认编码会变成 GBK，`print('✅')` 当场 UnicodeEncodeError，
//   8 套 selftest 全崩。去掉 pyEnv 之后**本地是绿的**（本机 ACP 还是 65001）⇒ 只有源码级钉得住。
test('★ 跑 python 自测时强制 utf-8 stdio（与系统代码页脱钩）', () => {
    assert.equal(pyEnv().PYTHONIOENCODING, 'utf-8', 'pyEnv 必须把 PYTHONIOENCODING 钉成 utf-8');
    const src = fs.readFileSync(path.join(ROOT, 'src', 'test', 'pythonSelftests.test.js'), 'utf8');
    assert.match(src, /spawnSync\('python',\s*\['-B',\s*\.\.\.args\],\s*\{[^}]*env:\s*pyEnv\(\)/s,
        'spawnSync 必须带上 `env: pyEnv()` —— 少了它，UTF-8 Beta 一关这套测试全红');
    // 启动器那条也要在：`set PYTHONUTF8=1` 让 dev-server **自己**（以及它 spawn 的一切）
    // 走 UTF-8 模式 —— 它 spawn 的构建子进程还有另一道保险（`build_chain._run_cmd_step` 的 env）。
    const bat = fs.readFileSync(path.join(ROOT, '..', '启动AcmTree.bat'), 'utf8');
    assert.match(bat, /^\s*set\s+PYTHONUTF8=1\s*$/m,
        '启动器里必须有 `set PYTHONUTF8=1`（否则 UTF-8 Beta 关掉时控制台里的 python 会按 GBK 打符号）');
});
