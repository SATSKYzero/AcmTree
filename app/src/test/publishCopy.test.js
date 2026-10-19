// ================================================================
// 「准备公开发布」的行为守卫（src/test/publishCopy.test.js）
//
// 来由（用户 2026-10-19 定的两段口径）：收件人那一半是 `清除个人数据.bat` 选档位 3；
// **作者那一半**是"建副本 → 副本里清个人数据（档位 3）→ 删掉 `作者专用/` 与 git 相关物"，
// 然后才把这个副本推上 GitHub。`scripts/publish-copy.mjs` 就是那四步（复制 / 删 / 清 / 验）。
//
// 这条守卫钉的是"**忘删 / 漏清 ⇒ 拒绝报成功**"这条底线（它是唯一会把东西送出去的动作）：
//   ① 复制时跳过 `.git`、`.git-full`、`个人数据/`、`作者专用/`、`.tmp-*` —— 副本里一个都不许有；
//   ② 副本里跑一次 `clean-personal --yes`（真跑，档位 3）⇒ ②③ 被清、注册表/包留着；
//   ③ 目标**不许在源里面**、**不许非空**（宁可报错，也不悄悄覆盖别人的东西）；
//   ④ 全过才打印"✅ 可以上传"。
//
// 做法：造一个**小夹具仓库**（自己带一份 `app/scripts/` 三件套）真跑一遍，不碰真实工作区。
// ⚠️ 子进程 stdio 用**文件描述符**（受限沙箱里 `pipe` / `input` 都会 EPERM，见 `cleanPersonal.test.js` 文件头）。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = path.join(APP, 'scripts');
const COPIED_SCRIPTS = ['publish-copy.mjs', 'clean-personal.mjs', 'roots.mjs'];

/** 小夹具：一个"像这个仓库"的源（自带 app/scripts 三件套 + 四类文件 + 该被跳过的东西） */
function makeFixture() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-pub-'));
    const src = path.join(tmp, 'src');
    const put = (rel, content = 'x\n') => {
        const p = path.join(src, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return p;
    };
    fs.mkdirSync(path.join(src, 'app', 'scripts'), { recursive: true });
    for (const f of COPIED_SCRIPTS) fs.copyFileSync(path.join(SCRIPTS, f), path.join(src, 'app', 'scripts', f));
    put('package.json', '{}\n');
    // 该被跳过的四类
    put('个人数据/me.json', '{"cf":{"apiKey":"REAL-CF-KEY"}}\n');
    put('个人数据/_chrome-profile/Default/Network/Cookies', 'cookies\n');
    put('作者专用/docs/变更记录.md', '# 作者内情\n');
    put('.git/config', '[core]\n');
    put('.git-full/HEAD', 'ref: refs/heads/main\n');
    put('.tmp-prune-test/junk.txt', 'junk\n');
    // 该被跳过的第五类：**`AGENTS.md`**（给 AI/贡献者看的操作规范；release 包里不该有）
    put('AGENTS.md', '# agent rules\n');
    put('app/src/core/AGENTS.md', '# core rules\n');
    // 该被跳过的第六类：**Python 字节码**（2026-10-19 实测副本里带了 5 个 `.pyc` ——
    //   `clean-personal` 的 ②③ 只扫 `app/acm-data`，而它们住在 `app/scripts/**`）
    put('app/scripts/__pycache__/crate.cpython-314.pyc', 'bytecode\n');
    put('app/scripts/__pycache__/selftest_kit.cpython-314.pyc', 'bytecode\n');
    put('app/scripts/loose.cpython-314.pyc', 'bytecode\n');      // `__pycache__` 之外的散件
    put('README.md', '# 给用户看的说明\n');       // 这个要留
    // 该被档位 3 清掉的（②③），以及该留的
    put('app/acm-data/raw/X/qoj_submissions.json', '{"r":[]}\n');
    put('app/acm-data/raw/X/cache/a.json', '{}\n');
    put('app/acm-data/raw/X/pages/b.html', '<html></html>\n');
    put('app/acm-data/raw/X/xcpc_contests.json', '{"contests":[]}\n');
    put('app/acm-data/nodes/all_nodes.json', '{"records":[]}\n');
    return { tmp, src };
}

/** 真跑一遍发布脚本（stdio 走文件描述符） */
function run(fx, args) {
    const outPath = path.join(fx.tmp, 'out.log');
    const fd = fs.openSync(outPath, 'w');
    let r;
    try {
        r = spawnSync(process.execPath, [path.join(fx.src, 'app', 'scripts', 'publish-copy.mjs'), ...args],
            { cwd: fx.tmp, stdio: ['ignore', fd, fd] });
    } finally {
        fs.closeSync(fd);
    }
    return { status: r.status, out: fs.readFileSync(outPath, 'utf8') };
}

function cleanup(fx) {
    try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉不影响结论 */ }
}

const exists = (root, rel) => fs.existsSync(path.join(root, rel));

test('★ 公开发布：副本里没有 .git / 个人数据 / 作者专用，②③ 被清、注册表与包留着', () => {
    const fx = makeFixture();
    try {
        const dst = path.join(fx.tmp, '公开');
        const r = run(fx, ['--yes', '--source', fx.src, '--target', dst]);
        assert.equal(r.status, 0, '顺利走完应当 exit 0（输出：' + r.out.slice(-800) + '）');
        assert.match(r.out, /✅ 可以上传/, '全过才允许说"可以上传"');
        for (const gone of ['.git', '.git-full', '个人数据', '作者专用', '.tmp-prune-test']) {
            assert.ok(!exists(dst, gone), `副本里不许有 ${gone}`);
        }
        for (const gone of ['app/acm-data/raw/X/qoj_submissions.json', 'app/acm-data/raw/X/cache/a.json',
            'app/acm-data/raw/X/pages/b.html',
            // 树包 = 生成物，档位 1 就删（2026-10-19 口径）⇒ 副本里也不该有
            'app/acm-data/nodes/all_nodes.json',
            // ★ 用户 2026-10-19："release 包里不应有 AGENTS.md"（根目录与各层都不带）
            'AGENTS.md', 'app/src/core/AGENTS.md',
            // ★ 字节码一律不进副本（`clean-personal` 的扫描范围不覆盖 `app/scripts`，所以只能在这里挡）
            'app/scripts/__pycache__', 'app/scripts/__pycache__/crate.cpython-314.pyc',
            'app/scripts/loose.cpython-314.pyc']) {
            assert.ok(!exists(dst, gone), `${gone} 不该出现在副本里（②③／①c 树包／AI 规范）`);
        }
        for (const kept of ['package.json', 'app/scripts/publish-copy.mjs',
            'app/acm-data/raw/X/xcpc_contests.json', 'README.md']) {
            assert.ok(exists(dst, kept), `${kept} 该留着（"永不删"清单 + 应用本体 + 给用户看的说明）`);
        }
    } finally { cleanup(fx); }
});

test('★ 目标在源里面**且不在 dist/ 下** / 非空 ⇒ 直接拒绝，且什么都不写', () => {
    const fx = makeFixture();
    try {
        const inside = path.join(fx.src, 'inside');
        const r1 = run(fx, ['--yes', '--source', fx.src, '--target', inside]);
        assert.notEqual(r1.status, 0, '目标在源里面必须非零退出');
        assert.match(r1.out, /作者专用/, '要说清"源内只有 `作者专用/` 下能放"');
        assert.ok(!fs.existsSync(inside), '拒绝时一个字节都不该写');

        const busy = path.join(fx.tmp, 'already');
        fs.mkdirSync(busy, { recursive: true });
        fs.writeFileSync(path.join(busy, '别人的东西.txt'), '别动我\n');
        const r2 = run(fx, ['--yes', '--source', fx.src, '--target', busy]);
        assert.notEqual(r2.status, 0, '目标非空必须非零退出');
        assert.match(r2.out, /非空/, '要说清"目标已存在且非空"');
        assert.ok(fs.existsSync(path.join(busy, '别人的东西.txt')), '拒绝时原样不动别人的文件');
    } finally { cleanup(fx); }
});

test('只报告（无参数）不复制、不删（三问之前的承诺）', () => {
    const fx = makeFixture();
    try {
        const dst = path.join(fx.tmp, '不该出现');
        const r = run(fx, ['--source', fx.src, '--target', dst]);
        assert.equal(r.status, 0, '只报告不该失败');
        assert.match(r.out, /只报告/, '要说清这次没动盘');
        assert.ok(!fs.existsSync(dst), '报告模式不许创建目标目录');
    } finally { cleanup(fx); }
});

test('★ 默认目标在**工作区内的 `作者专用/`** 下，名字带版本号，而且真的能跑（源内只放行这一类）', () => {
    // 用户 2026-10-19 三句话："希望命名为 Acm-(版本号)-release 或更专业的名字" +
    //   "把副本放工作区内吧…上 github 也是在工作区内操作最方便" + "当然放作者专用里"
    //   ⇒ `<源>/作者专用/AcmTree-<APP_VERSION>-release`。
    // 放 `作者专用/` 还顺手解决"自己套自己"：那个目录本来就在复制跳过名单里。
    const fx = makeFixture();
    try {
        // 夹具里放一个带版本号的 A_constants.js（版本号读的就是它，别在脚本里另抄一份）
        fs.mkdirSync(path.join(fx.src, 'app', 'src'), { recursive: true });
        fs.writeFileSync(path.join(fx.src, 'app', 'src', 'A_constants.js'),
            "export const APP_VERSION = 'v9.9.9';\n");
        const dry = run(fx, ['--source', fx.src]);
        assert.match(dry.out, /AcmTree-v9\.9\.9-release/, '默认目标名要带 `APP_VERSION`（此处 v9.9.9）');
        assert.match(dry.out, /作者专用/, '默认目标要在 `作者专用/` 下（工作区内）');

        // 显式给 `作者专用/` 下的目标 ⇒ 放行（以前"在源里面"一律拒，现在只放行这一类）
        const dst = path.join(fx.src, '作者专用', 'AcmTree-v9.9.9-release');
        const r = run(fx, ['--yes', '--source', fx.src, '--target', dst]);
        assert.equal(r.status, 0, '`作者专用/` 下的目标应当放行（输出：' + r.out.slice(-500) + '）');
        assert.ok(fs.existsSync(path.join(dst, 'package.json')), '副本要真的建出来');
        assert.ok(!fs.existsSync(path.join(dst, '作者专用')), '★ 副本里不许再出现 `作者专用/`（自己套自己）');
    } finally { cleanup(fx); }
});

test('★ 树包（`app/acm-data/nodes/`）由 `clean-personal` **档位 1** 删掉，副本里不该再有它', () => {
    // 口径变更（2026-10-19，用户："既然是生成所需的，应在档位 1 就清除"）：
    //   树包原来在 `NEVER_DELETE` 里；但它是**生成物**（跑一趟产包链就有），而里面写着
    //   "这条提交属于谁"（实测 `all_nodes.json` 7850 处真账号）⇒ 第 1 级就删。
    //   ⇒ 发布脚本不再需要任何"删树包"的开关，第 4 步的验证里 ①c 必须是 0。
    const fx = makeFixture();
    try {
        const dst = path.join(fx.tmp, '树包');
        const r = run(fx, ['--yes', '--source', fx.src, '--target', dst]);
        assert.equal(r.status, 0, '走完应当 exit 0（输出：' + r.out.slice(-600) + '）');
        // 目录可能留着（删的是文件，不是目录）—— 只要里面一个文件都没有就对了
        const nodesDir = path.join(dst, 'app/acm-data/nodes');
        const left = fs.existsSync(nodesDir) ? fs.readdirSync(nodesDir) : [];
        assert.deepEqual(left, [], '★ 副本里树包必须一个文件都不剩');
        assert.ok(fs.existsSync(path.join(dst, 'app/acm-data/raw/X/xcpc_contests.json')),
            '注册表/清单照旧留着（它们不是树包）');
        assert.match(r.out, /报告：[^\n]*①c 0(?![0-9])/, '④ 的验证要报 ①c = 0（否则"可以上传"没意义）');
    } finally { cleanup(fx); }
});
