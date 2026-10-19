// ================================================================
// 两份 git：规则那份不许装数据、全量那份必须装住数据（`src/test/snapshotRepos.test.js`）
//
// 为什么要有这条（用户 2026-10-17 定的形状）：仓库分成两份 ——
//   · **规则仓库** = 现在这个（代码 + 规则 + 手存原料）；
//   · **全量仓库** = 仓根里的 `.git-full`（连 `cache/` 与导出包一起，用来复原）。
// 两边只有 `作者专用/保存快照.bat` 那三行不一样（强制加 + 摘掉登录态痕迹）。**它会静默失效**：
//   · 谁把 `.gitignore` 里那段删了 ⇒ 规则仓库又被几百个缓存刷屏（肉眼才发现）；
//   · 谁在保存脚本里漏掉 `-f` ⇒ 全量那份从此**不再收缓存**，而它看起来照常"提交成功"
//     —— 这种"备份悄悄少了东西"只有等真要复原时才知道，所以必须钉住。
//
// ⚠️ 为什么走"shell 重定向到临时文件"这条绕路：本机的受限沙箱里
//    `spawnSync` 抓子进程输出（`stdio: 'pipe'`）会 EPERM（同 `pythonSelftests.test.js` 那条注释）。
//    把输出落到工作区内的 `.tmp-*/`（已在 `.gitignore` 里）再读，两边都能跑。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { repoRoot } from '../../scripts/roots.mjs';

const ROOT = repoRoot();
const FULL_GIT_DIR = path.join(ROOT, '.git-full');
const TMP_DIR = path.join(ROOT, '.tmp-snapshot-repos');

// ⚠️ 这份测试守的是**作者本机的"两份 git"备份**（`规则仓库` + `.git-full`）。
//    而 `clean-personal` / `publish-copy` 造出来的**公开发布副本里没有 `.git`**（按设计删掉了）
//    ⇒ 那里面"规则仓库的索引"根本不存在，这些断言无从成立。缺 `.git` 就 **skip**（不是红）：
//    它守的是作者的工作区形状，不是收件人拿到的那份东西。
if (!fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('   ⏭ 跳过整份测试：这个目录里没有 `.git`'
        + '（公开发布副本按设计不带 git 元数据）');
    process.exit(0);
}

/** 跑一条 git 命令，把输出读回来（见文件头那条沙箱注意事项） */
function gitLines(args) {
    const out = path.join(TMP_DIR, 'out.txt');
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.rmSync(out, { force: true });
    const line = 'git ' + args.map(a => (/[\s"^&|<>]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a)).join(' ')
        + ' > "' + out + '" 2>&1';
    const res = spawnSync(line, { cwd: ROOT, shell: true, stdio: 'inherit' });
    if (res.error) return null;
    if (!fs.existsSync(out)) return null;
    const text = fs.readFileSync(out, 'utf8');
    fs.rmSync(out, { force: true });
    return text.split(/\r?\n/).filter(Boolean);
}

function checkIgnore(target) {
    const lines = gitLines(['check-ignore', '-v', '--no-index', '--', target]);
    return lines === null ? null : lines.some(l => l.trim().endsWith(target) || l.includes(target));
}

// ⚠️ `check-ignore` **默认不认已跟踪的文件**（它跳掉它们）⇒ 必须 `--no-index`：
//    漏了那个开关，这条守卫在"文件已经被跟踪"时会假绿。
test('两份 git：规则仓库的忽略规则（该命中 / 不误伤）', (t) => {
    if (!fs.existsSync(path.join(ROOT, '.git'))) return t.skip('这不是一份 git 工作区');
    if (checkIgnore('app/scripts/build_chain.py') === null) return t.skip('这台机器上跑不了 git（或沙箱不让）');

    const mustHit = [
        'app/acm-data/nodes/all_nodes.json',
        'app/acm-data/raw/Scaper/05 xcpc/cache/cf_1_me.json',
        'app/acm-data/raw/Scaper/04 qoj/cache/qoj_contest_titles.json',
        '.git-full/config'
    ];
    for (const p of mustHit) {
        assert.equal(checkIgnore(p), true,
            `${p} 应当被忽略（它是"数据"那份的东西）—— 查 .gitignore 里"两份 git"那一段`);
    }
    const mustStay = [
        'app/scripts/build_chain.py',
        'app/src/A_constants.js',
        'app/docs/field-rules.md',
        'app/acm-data/raw/Scaper/05 xcpc/gym_whitelist.json',
        'app/acm-data/reports/field-coverage.json',
        '作者专用/保存快照.bat'
    ];
    for (const p of mustStay) {
        assert.equal(checkIgnore(p), false,
            `${p} 不该被忽略（它是"规则"那份的东西）—— 别把规则误伤进数据那一边`);
    }
});

test('两份 git：规则仓库的索引里不许再有 cache/ 与导出包', (t) => {
    const files = gitLines(['ls-files']);
    if (files === null) return t.skip('这台机器上跑不了 git（或沙箱不让）');
    const leaked = files.filter(f => f.includes('/cache/') || f.startsWith('app/acm-data/nodes/'));
    assert.equal(leaked.length, 0,
        `规则仓库又跟踪了 ${leaked.length} 个数据文件（头一个：${leaked[0]}）`
        + ' —— 它们是"全量那份"的东西（`.gitignore` 那两条 + `保存快照.bat` 的 `-f`）');
});

test('两份 git：全量那份真的收住了数据（漏了 -f 就会静默少东西）', (t) => {
    const cfg = path.join(FULL_GIT_DIR, 'config');
    if (!fs.existsSync(cfg)) return t.skip('这台机器上还没有全量那份（第一次跑 保存快照.bat 时建）');

    const text = fs.readFileSync(cfg, 'utf8');
    const want = ROOT.replace(/\\/g, '/');
    const got = (text.match(/^\s*worktree\s*=\s*(.+)$/m) || [])[1] || '';
    assert.equal(got.trim().replace(/\\/g, '/'), want,
        `全量那份的 core.worktree 指着别处（${got.trim()}）⇒ 保存脚本会把快照写到别的工作区去`);
    assert.match(text, /^\s*bare\s*=\s*false\s*$/m,
        '全量那份必须是 core.bare=false（否则 `--work-tree` 的提交用不了）');

    const files = gitLines(['--git-dir=.git-full', 'ls-files']);
    if (files === null) return t.skip('这台机器上跑不了 git（或沙箱不让）');
    // ⚠️ 2026-10-19：**导出包是生成物**（`clean-personal` 档位 1 会删它，用户定的）⇒
    //    盘上没有的时候，全量那份自然也没有 ⇒ 这条不能无条件要求它在（否则"清了包"就假红）。
    //    只在盘上**确实有包**时要求全量那份收住它（那才是"`add -A -f` 还在"的证据）。
    // ⚠️⚠️ 2026-10-19 第二轮（实测踩到）：**"包在盘上、快照还没跑"是正常状态**（一键重建 4:47 产了
    //    新包，`保存快照.bat` 还没跑）—— 那时候全量那份当然还没有它。判据要看**先后**：
    //    只有"包比最后一次快照**还旧**、却仍没被收进去"才是 `-f` 掉了。
    const pkg = path.join(ROOT, 'app', 'acm-data', 'nodes', 'all_nodes.json');
    const pkgOnDisk = fs.existsSync(pkg);
    if (pkgOnDisk) {
        const lastCommit = (gitLines(['--git-dir=.git-full', 'log', '-1', '--format=%ct']) || [])[0] || '';
        const commitSec = Number(lastCommit.trim()) || 0;
        const pkgSec = Math.floor(fs.statSync(pkg).mtimeMs / 1000);
        if (files.includes('app/acm-data/nodes/all_nodes.json')) {
            // 已经在里面：最好的情况，什么都不用说
        } else if (commitSec && pkgSec > commitSec) {
            console.log('   ⏭ 导出包比最后一次快照新（重建过还没保存）⇒ 跳过"全量那份收住导出包"这一条');
        } else {
            assert.fail('全量那份里没有导出包 —— 保存脚本那行 `add -A -f` 是不是被删了？'
                + `（包 mtime ${pkgSec} / 最后一次快照 ${commitSec || '读不到'}）`);
        }
    } else {
        console.log('   ⏭ 盘上没有导出包（生成物被清掉了）⇒ 跳过"全量那份收住导出包"这一条');
    }
    assert.ok(files.some(f => f.includes('/cache/')), '全量那份里一个缓存都没有 —— 同上');
    assert.ok(files.includes('app/src/A_constants.js'), '全量那份里连代码都没有？');
    const sensitive = files.filter(f => /(^|\/)me\.json$/.test(f)
        || f.includes('_chrome-profile/') || f.endsWith('.bak')
        || (f.includes('/cache/') && f.endsWith('.html')));
    assert.equal(sensitive.length, 0,
        `全量那份里有 ${sensitive.length} 个登录态痕迹（${sensitive[0]}）—— `
        + '它是本地复原用的，但仍然按 `.gitignore` 那三条口径排除');
});
