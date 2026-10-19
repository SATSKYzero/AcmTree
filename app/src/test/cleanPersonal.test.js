// ================================================================
// 「清除个人数据」的行为守卫（src/test/cleanPersonal.test.js）
//
// 为什么要有这条：那个工具**只有源码级守卫**（`crossLangTables.test.js` 钉的是"拿 personalDir()、
// 扫四处、导出包规则认得那两张名字"）—— 它红了只说明"接线还在"，**不说明报告的数字是真的**。
// 2026-10-19 审计时实测到两个"会说谎"的毛病（都是真的踩出来的，不是想出来的）：
//   ① **确认框少报**：第 1 级说"删除文件 1 个"、实际删了 6 个 —— 少报的正是 `me.json.bak`
//      与 `AcmTree_Full_*.json[.gz]` 这类**凭据复制品**（病根：`apply()` 与确认那行各算一遍）；
//   ② **删失败仍报成功**：用文件锁模拟"Chrome 正在跑"，打一行 `删除失败 …EPERM` 之后就接
//      `✅ 已清空凭据 2 个 ｜ 已删除 9 个文件`，**退出码 0** —— 而且 `rmSync` 会先把别的文件删掉、
//      最后活下来的恰好是 `Default/Network/Cookies`（第 1 级存在的唯一理由）。
//
// 判据（会红）：把 `apply()` 换回"两处各算一遍"或去掉 `process.exitCode` ⇒ 本文件当场红。
// 做法是**真的跑那个脚本**（拷一份到临时夹具里），不做源码匹配：
//   · 夹具是 `<tmp>/tree/`（放 `package.json` ⇒ `roots.mjs` 会把它认成仓库根），
//     探针的 stdin/stdout 放在 `<tmp>/`（**树之外**，否则会被当成待清文件算进数字）。
//   · ⚠️ 子进程的 stdio **只能用文件描述符或 inherit/ignore**：本机受限沙箱里 `'pipe'` 会 EPERM
//     （实测 `spawnSync(..., {input})` 与默认 `pipe` 都是 `EPERM`）⇒ 这里 `fs.openSync` 后传 fd。
//   · ⚠️ "删不掉"用**把 cwd 设进那个目录**来制造（Windows 不许删正在当 cwd 的目录，实测 EPERM），
//     不用 `chmod` 只读 —— 实测在 NTFS 上只读文件照样能被 `unlink`，那样造出来的红是假的。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_CLEAN = path.join(APP, 'scripts', 'clean-personal.mjs');
const SRC_ROOTS = path.join(APP, 'scripts', 'roots.mjs');

/** 空模板里必定有的那条说明（**不抄整份内容**：抄了就成第二份口径） */
const EMPTY_MARK = '_note';

/**
 * 造一份夹具：`<tmp>/tree/` 是被清的"仓库根"，`<tmp>/` 放 stdin/stdout 探针。
 * 里面刻意放齐四类：① 凭据与复制品（含 `nodes/` 里那份导出包）、①b 浏览器现场、①c 树包、②③、⛔ 该留的。
 */
function makeFixture({ chromeCookies = true } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acm-clean-'));
    const root = path.join(tmp, 'tree');
    const put = (rel, content = 'x\n') => {
        const p = path.join(root, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return p;
    };
    fs.mkdirSync(path.join(root, 'app', 'scripts'), { recursive: true });
    fs.copyFileSync(SRC_CLEAN, path.join(root, 'app', 'scripts', 'clean-personal.mjs'));
    fs.copyFileSync(SRC_ROOTS, path.join(root, 'app', 'scripts', 'roots.mjs'));
    put('package.json', '{}\n');
    // ① 凭据（本尊换空模板）与复制品/导出包（第 1 级直接删）
    put('个人数据/me.json', '{"cf":{"apiKey":"REALKEY"},"qoj":{"cookie":"REALCOOKIE"}}\n');
    put('个人数据/me.json.bak', '{"cf":{"apiKey":"REALKEY"}}\n');
    put('个人数据/AcmTree_Full_20260101_000000.json.gz', 'export\n');
    put('AcmTree_Full_20260102_000000.json', 'export\n');                      // 仓库根一层
    put('app/acm-data/nodes/AcmTree_Full_20260103_000000.json', 'export\n');   // nodes/ 里的导出包
    // ①-c 旧的身份痕迹（2026-10-19 起搬进 `me.json`；谁再生成出来就该在第 1 级被清掉）
    put('app/acm-data/raw/Scaper/02 hdu/hdu_contest_accounts.json', '{"984":"TEAM0/teamB"}\n');
    // ①b 浏览器现场（活登录态）
    fs.mkdirSync(path.join(root, '个人数据', '_chrome-profile', 'Default', 'Network'), { recursive: true });
    if (chromeCookies) put('个人数据/_chrome-profile/Default/Network/Cookies', 'cookies\n');
    // ②③（位置优先那条：`cache/` 里的一律算 ③）+ ⛔ 该留的
    put('app/acm-data/raw/Scaper/05 xcpc/cache/a.json');
    put('app/acm-data/raw/Scaper/05 xcpc/pages/b.html');
    put('app/acm-data/raw/Scaper/05 xcpc/qoj_submissions.json');
    put('app/acm-data/raw/Scaper/05 xcpc/xcpc_contests.json');
    put('app/acm-data/raw/Scaper/05 xcpc/notes.md');
    put('app/acm-data/nodes/all_nodes.json');
    return { tmp, root };
}

/** 树里所有**文件**（相对路径，正斜杠统一）—— 用来算"到底删了几个" */
function listFiles(dir) {
    const out = [];
    const walk = (d) => {
        for (const it of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, it.name);
            if (it.isDirectory()) walk(p);
            else out.push(path.relative(dir, p).replace(/\\/g, '/'));
        }
    };
    walk(dir);
    return out.sort();
}

/** 真跑一遍那个脚本（stdio 走文件描述符，见文件头） */
function run(fx, args, { stdin = null, cwd = null } = {}) {
    const inPath = path.join(fx.tmp, 'stdin.txt');
    const outPath = path.join(fx.tmp, 'stdout.txt');
    const errPath = path.join(fx.tmp, 'stderr.txt');
    let inFd = 'ignore';
    if (stdin !== null) {
        fs.writeFileSync(inPath, stdin);
        inFd = fs.openSync(inPath, 'r');
    }
    const outFd = fs.openSync(outPath, 'w');
    const errFd = fs.openSync(errPath, 'w');   // 失败清单走 stderr（`console.error`），得分两个文件
    let r;
    try {
        r = spawnSync(process.execPath,
            [path.join(fx.root, 'app', 'scripts', 'clean-personal.mjs'), ...args],
            { cwd: cwd || fx.root, stdio: [inFd, outFd, errFd] });
    } finally {
        if (inFd !== 'ignore') fs.closeSync(inFd);
        fs.closeSync(outFd);
        fs.closeSync(errFd);
    }
    return {
        status: r.status,
        out: fs.readFileSync(outPath, 'utf8'),
        err: fs.readFileSync(errPath, 'utf8')
    };
}

/** 跑完一定要把夹具删掉（临时目录，不进仓库） */
function cleanup(fx) {
    try { fs.rmSync(fx.tmp, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也不影响结论 */ }
}

test('清除个人数据：只报告（无参数）时一个字节都不动', () => {
    const fx = makeFixture();
    try {
        const before = listFiles(fx.root);
        const r = run(fx, []);
        assert.equal(r.status, 0, '只报告不该失败');
        assert.deepEqual(listFiles(fx.root), before, '报告模式必须**不写盘**（三问之前的承诺）');
        assert.match(r.out, /没动任何文件/);
        // 报告要把"扫了哪几处"打出来（这条曾经因为少扫一棵树而静默说谎）
        assert.match(r.out, /个人数据/, '报告里要出现个人数据目录');
        assert.match(r.out, /_chrome-profile/);
    } finally { cleanup(fx); }
});

test('★ 第 1 级：确认框报的删除数 == 真正删掉的文件数（复制品不许"不声不响地删"）', () => {
    const fx = makeFixture();
    try {
        const before = listFiles(fx.root);
        const r = run(fx, ['--interactive'], { stdin: 'go\n1\nyes\n' });
        assert.equal(r.status, 0, '--interactive 三问走完应当成功（输出：' + r.out + '）');
        const after = listFiles(fx.root);
        const deleted = before.filter((f) => !after.includes(f));
        // 夹具里第 1 级该删：5 份凭据复制品（含 `nodes/` 里那份导出包与旧的
        // `hdu_contest_accounts.json` 身份痕迹）+ Cookies 一个文件 + **树包** `all_nodes.json`
        assert.equal(deleted.length, 7, '夹具口径变了？第 1 级应当删 7 个文件，实际：' + deleted.join(', '));
        const m = /将要做：清空凭据 \d+ 个、删除文件 (\d+) 个/.exec(r.out);
        assert.ok(m, '确认框那行应当在（没匹配到说明措辞变了，改这边别改断言）');
        assert.equal(Number(m[1]), deleted.length,
            `确认框说删 ${m[1]} 个、实际删了 ${deleted.length} 个 —— 少报的多半是凭据复制品/导出包`);
    } finally { cleanup(fx); }
});

test('第 1 级：凭据换空模板、复制品与浏览器现场清掉，②③ 与注册表一个不动', () => {
    const fx = makeFixture();
    try {
        run(fx, ['--interactive'], { stdin: 'go\n1\nyes\n' });
        const me = fs.readFileSync(path.join(fx.root, '个人数据', 'me.json'), 'utf8');
        assert.ok(me.includes(EMPTY_MARK), 'me.json 应当被换成空模板');
        assert.ok(!me.includes('REALKEY'), '真凭据不许留下');
        for (const gone of ['个人数据/me.json.bak', '个人数据/AcmTree_Full_20260101_000000.json.gz',
            'AcmTree_Full_20260102_000000.json', 'app/acm-data/nodes/AcmTree_Full_20260103_000000.json',
            'app/acm-data/raw/Scaper/02 hdu/hdu_contest_accounts.json',
            // ★ 2026-10-19 用户定："树包是生成物，档位 1 就清" —— 它原来在 NEVER_DELETE 里
            'app/acm-data/nodes/all_nodes.json']) {
            assert.ok(!fs.existsSync(path.join(fx.root, gone)), `${gone} 应当被删（第 1 级）`);
        }
        assert.ok(!fs.existsSync(path.join(fx.root, '个人数据', '_chrome-profile')), '浏览器现场要整目录删');
        for (const kept of ['app/acm-data/raw/Scaper/05 xcpc/cache/a.json',
            'app/acm-data/raw/Scaper/05 xcpc/pages/b.html',
            'app/acm-data/raw/Scaper/05 xcpc/qoj_submissions.json',
            'app/acm-data/raw/Scaper/05 xcpc/xcpc_contests.json',
            'app/acm-data/raw/Scaper/05 xcpc/notes.md']) {
            assert.ok(fs.existsSync(path.join(fx.root, kept)), `${kept} 第 1 级**不该**动`);
        }
    } finally { cleanup(fx); }
});

test('第 2 级 / 第 3 级：② 与 ③ 的界线，以及"永不删"那几样', () => {
    const fx2 = makeFixture();
    try {
        run(fx2, ['--interactive'], { stdin: 'go\n2\nyes\n' });
        assert.ok(!fs.existsSync(path.join(fx2.root, 'app/acm-data/raw/Scaper/05 xcpc/qoj_submissions.json')),
            '第 2 级要删 ②（提交导出）');
        assert.ok(fs.existsSync(path.join(fx2.root, 'app/acm-data/raw/Scaper/05 xcpc/cache/a.json')),
            '第 2 级**不许**碰 ③（缓存）');
    } finally { cleanup(fx2); }

    const fx3 = makeFixture();
    try {
        const r = run(fx3, ['--yes']);
        assert.equal(r.status, 0, '--yes 正常应当成功');
        for (const gone of ['app/acm-data/raw/Scaper/05 xcpc/cache/a.json',
            'app/acm-data/raw/Scaper/05 xcpc/pages/b.html',
            'app/acm-data/raw/Scaper/05 xcpc/qoj_submissions.json',
            'app/acm-data/nodes/all_nodes.json']) {           // 树包属第 1 级，第 3 级自然也删
            assert.ok(!fs.existsSync(path.join(fx3.root, gone)), `${gone} 第 3 级要删`);
        }
        for (const kept of ['app/acm-data/raw/Scaper/05 xcpc/xcpc_contests.json',
            'app/acm-data/raw/Scaper/05 xcpc/notes.md']) {
            assert.ok(fs.existsSync(path.join(fx3.root, kept)), `${kept} 是"永不删"清单里的，第 3 级也不许动`);
        }
    } finally { cleanup(fx3); }
});

test('★ 有东西删不掉 ⇒ 逐条报出来 + 退出码非零（不许打完 ✅ 就 exit 0）', () => {
    const fx = makeFixture();
    try {
        // 把 cwd 放进 `_chrome-profile/` 里：Windows 不许删正在当 cwd 的目录 ⇒ 必然失败（实测 EPERM）
        const cwd = path.join(fx.root, '个人数据', '_chrome-profile', 'Default', 'Network');
        const r = run(fx, ['--yes'], { cwd });
        assert.notEqual(r.status, 0,
            '删不掉就必须以非零退出码结束 —— 否则"跑一次、成功才发出去"的脚本会带着活 cookie 发走');
        assert.match(r.err, /删除失败/, '要逐条打出来是哪个删不掉（走 stderr）');
        assert.match(r.err, /没清掉/, '收尾要有一段"还剩哪些"');
    } finally { cleanup(fx); }
});

test('★ `_chrome-profile` 里一个文件都没扫到，也要**整目录**删掉（门禁看"目录在不在"）', () => {
    const fx = makeFixture({ chromeCookies: false });
    try {
        const before = run(fx, []);
        assert.match(before.out, /目录在、但一个文件都没扫到/, '报告要说实话：目录在、只是没扫到文件');
        run(fx, ['--yes']);
        assert.ok(!fs.existsSync(path.join(fx.root, '个人数据', '_chrome-profile')),
            '空目录（或读不出内容的目录）也要删 —— 拿"扫到几个文件"当"要不要动手"会静默漏掉整棵现场');
    } finally { cleanup(fx); }
});
