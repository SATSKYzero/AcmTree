#!/usr/bin/env node
// ================================================================
// 准备公开发布：**建副本 → 删作者物 → 档位 3 清个人数据 → 验一遍**（scripts/publish-copy.mjs）
//
// 为什么要有它（用户 2026-10-19 定的两段口径）：
//   · **收件人**那一半：拿到文件夹后双击 `清除个人数据\…\清除个人数据.bat` 选档位 3（那是 `clean-personal.mjs`）。
//   · **作者**那一半（这一份）：上 GitHub 之前**先建副本**，在副本里清个人数据（档位 3）**并**删掉
//     `作者专用/` 与所有 git 相关物。⚠️ 原件一个字节都不动。
//
// 为什么 `.git` 不搬进 `作者专用/`（用户曾提过这个想法，这里记下结论，别重开）：
//   git 要求**工作树根**有 `.git`（否则每条命令都要 `--git-dir/--work-tree`），搬到子目录后
//   hooks / `.git-full` / VS Code / 我们脚本里的 `git log|grep` 都会**静默指错**（本仓踩过多次
//   "看起来没改过/提交到空仓库"那种事故）。所以改成**在副本里删掉它们**，并用下面的"验证"保证
//   **忘删 ⇒ 脚本拒绝报"可以上传"**（结论靠判据，不靠位置）。
//
// 用法（从仓库根跑；双击的是 `作者专用\准备公开发布.bat`）：
//   node app/scripts/publish-copy.mjs                          # 只报告（默认）：目标、体量、要删什么
//   node app/scripts/publish-copy.mjs --interactive            # 三问：go / 目标路径 / yes
//   node app/scripts/publish-copy.mjs --yes                    # 直接做（默认目标 `作者专用\AcmTree-<版本号>-release`）
//   node app/scripts/publish-copy.mjs --yes --target D:\pub\AcmTree      # 指定目标
//   node app/scripts/publish-copy.mjs --yes --source <夹具>    # 只为测试：换个"源仓库"
//
// 四步（每步都可核）
//   ① 复制：跳过 `.git` / `.git-full` / `个人数据` / `作者专用` / `.tmp-*`（其余原样，含 `清除个人数据/`）
//   ② 删：副本里若还有 `.git`、`.git-full`、`作者专用`、`.tmp-*`（比如从别处拷来的），一律删掉
//   ③ 清：在副本里跑 `node app/scripts/clean-personal.mjs --yes`（= **档位 3**）
//   ④ 验：① 0 个 / ①b 0 个 / ② 0 个 / ③ 0 个，且副本里找不到 `.git`、`个人数据`、`作者专用`、
//      `me.json` 本尊 —— 任一条不过就 `❌` + **非零退出码**（"跑一次、成功才发出去"）。
//   最后**只打印** `git init … push` 的命令（不自动推、不自动 init：第一次的 remote 得人自己定）。
//
// ⚠️ 目标必须**不在源里面**、且**不存在或为空**（宁可让人自己删，也不自动覆盖：那是唯一不可逆的动作）。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

import { repoRoot } from './roots.mjs';

const argv = process.argv.slice(2);
const INTERACTIVE = argv.includes('--interactive');
//: 全自动（用户 2026-10-19："双击 bat 就全自动完成"）：不问、直接按 `作者专用/发布配置.json` 跑到底
const AUTO = argv.includes('--auto');
/**
 * 读 `作者专用/发布配置.json`（`作者专用/` 整个目录不进副本 ⇒ 它不会随发布出去）。
 * 读不到 / 坏 JSON ⇒ 空对象（`remote` 为空时下面会明确拒绝，不会瞎推）。
 */
function readPublishConfig() {
    const p = path.join(SOURCE, '作者专用', '发布配置.json');
    try {
        const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
        return cfg && typeof cfg === 'object' ? cfg : {};
    } catch (err) {
        console.error(`⚠️ 读不了 ${p}：${err.message}`);
        return {};
    }
}
const APPLY = argv.includes('--yes') && !argv.includes('--dry-run');
const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
};

const SOURCE = path.resolve(argOf('--source') || repoRoot());

/**
 * 对外版本号 —— **从唯一真源读**（`app/src/A_constants.js` 的 `APP_VERSION`），不另抄一份。
 * 读不到就退回 `dev`（并打一句），绝不编一个像版本的字符串出来。
 */
function appVersion() {
    try {
        const src = fs.readFileSync(path.join(SOURCE, 'app', 'src', 'A_constants.js'), 'utf8');
        const m = /APP_VERSION\s*=\s*'([^']+)'/.exec(src);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}
const VERSION = appVersion();

//: 默认目标：**`<仓库根>\作者专用\AcmTree-<版本号>-release`**。
//: 用户 2026-10-19 三句话定的：① "希望命名为 Acm-(版本号)-release 或更专业的名字"；
//: ② "把副本放工作区内吧…上 github 也是在工作区内操作最方便"；③ "当然放作者专用里"。
//: ⚠️ 放 `作者专用/` 里还顺手解决了两个麻烦：① 它本来就在复制跳过名单里 ⇒ **不会自己套自己**；
//:    ② 它天然是"作者物"，收件人拿到的那份本来就不该有它（`.gitignore` 再加一条挡规则仓库）。
const RELEASE_PARENT = path.join(SOURCE, '作者专用');
const DEFAULT_TARGET = path.join(RELEASE_PARENT, `AcmTree-${VERSION || 'dev'}-release`);

//: 复制时**跳过**的东西（个人数据与作者物不进副本；git 元数据更不该进）
//: ★ 副本自己住在 `作者专用/` 里 ⇒ 这一条同时保证"不会自己套自己"，不需要再单列一个目录名。
//: ★ `__pycache__`（2026-10-19 实测漏进副本 5 个 `.pyc`）：`clean-personal` 的 ②③ **只扫
//:   `app/acm-data`**，而字节码住在 `app/scripts/**` ⇒ 它既不删也不报，验证里那句"③ 0"是
//:   "在它的扫描范围里为 0"。`.gitignore` 里有 `**/__pycache__/`（所以推 GitHub 不受影响），
//:   但**整份文件夹交给别人**时它们会跟着走（还带着作者机器上的源码路径字符串）⇒ 从源头就不复制。
const SKIP_DIRS = new Set(['.git', '.git-full', '个人数据', '作者专用', '__pycache__']);
const SKIP_PREFIX = ['.tmp-'];
const shouldSkip = (name) => SKIP_DIRS.has(name) || SKIP_PREFIX.some((p) => name.startsWith(p));

/** 按**完整路径**判断要不要跳过（名字层：目录 + **所有 `AGENTS.md`** + `*.pyc`） */
const shouldSkipPath = (full) => {
    const name = path.basename(full);
    // ★ 用户 2026-10-19："release 包里不应有 AGENTS.md" —— 那是**给 AI/贡献者看的操作规范**
    //   （每次会话自动注入的那种），不是给收件人用的说明；README / `app/docs/` 才是给人看的。
    //   按名字判 ⇒ 根目录与各层（`src/core`、`src/ui`、`src/features`、`scripts`、`acm-data`…）一起不带。
    if (name === 'AGENTS.md' || name === 'AGENTS.local.md') return true;
    if (name.endsWith('.pyc')) return true;          // 字节码（`__pycache__` 之外的散件也一起挡）
    return shouldSkip(name);
};
/** 递归数一遍"如果复制会带多少文件/字节"（跳过那些目录） */
function measure(dir) {
    let files = 0;
    let bytes = 0;
    const walk = (d) => {
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
            if (shouldSkip(it.name)) continue;
            const p = path.join(d, it.name);
            if (shouldSkipPath(p)) continue;
            if (it.isDirectory()) walk(p);
            else if (it.isFile()) {
                files++;
                try { bytes += fs.statSync(p).size; } catch { /* 读不到就不算，反正只是个数 */ }
            }
        }
    };
    walk(dir);
    return { files, bytes };
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/** 目标校验：**只放行"在 `<源>/作者专用/` 下"的源内目标**；其余源内路径一律拒（复制会自己套自己） */
function checkTarget(target) {
    const rel = path.relative(SOURCE, target);
    if (rel === '') return '目标就是源仓库本身';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        // 源内：只允许 `作者专用/` 下面 —— 那是发布副本的**家**，而它本来就在复制跳过名单里
        const relRel = path.relative(RELEASE_PARENT, target);
        const inRelease = relRel !== '' && !relRel.startsWith('..') && !path.isAbsolute(relRel);
        if (!inRelease) return '目标在源仓库**里面**且不在 `作者专用/` 下（复制会自己套自己）';
    }
    if (fs.existsSync(target)) {
        const items = fs.readdirSync(target);
        if (items.length) return `目标已存在且**非空**（${items.length} 项）—— 先自己删掉它`;
    }
    return '';
}

/** 复制（`fs.cpSync` + 过滤器；跳过集与 `measure()` 同一份） */
function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, {
        recursive: true,
        force: true,
        errorOnExist: false,
        filter: (from) => {
            if (from === src) return true;
            return !shouldSkipPath(from);
        }
    });
}

/** 副本里"作者物/git 元数据"的最后一道：有就删（复制时已跳过，这里防"从别处拷进来的"） */
function purgeForbidden(root) {
    const removed = [];
    const walk = (d) => {
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
            const p = path.join(d, it.name);
            if (it.isDirectory()) {
                if (shouldSkip(it.name)) {
                    fs.rmSync(p, { recursive: true, force: true });
                    removed.push(path.relative(root, p));
                    continue;
                }
                walk(p);
            }
        }
    };
    walk(root);
    return removed;
}

/** 把 `clean-personal` 的报告抓下来（**用文件当 stdout**：受限沙箱里管道会 EPERM，见其文件头） */
function cleanReport(target) {
    const outPath = path.join(os.tmpdir(), `acm-publish-${process.pid}.log`);
    const fd = fs.openSync(outPath, 'w');
    let res;
    try {
        res = spawnSync(process.execPath, [path.join(target, 'app', 'scripts', 'clean-personal.mjs')],
            { cwd: target, stdio: ['ignore', fd, fd] });
    } finally {
        fs.closeSync(fd);
    }
    const text = fs.readFileSync(outPath, 'utf8');
    try { fs.unlinkSync(outPath); } catch { /* 临时文件，删不掉不影响结论 */ }
    return { status: res.status, text };
}

/** 从报告里抠五个数字（**判据只有 `clean-personal` 那一份**；这里只是读它的结论） */
function readCounts(text) {
    const pick = (re) => {
        const m = re.exec(text);
        return m ? Number(m[1]) : null;
    };
    return {
        cred: pick(/① 凭据（me\.json \/ 导出包）\s+(\d+) 个/),
        chrome: pick(/①b 浏览器登录态[^\n]*?(\d+) 个/),
        // 树包（生成物）—— 2026-10-19 起档位 1 就删；副本里必须也是 0
        packs: pick(/①c 树包（acm-data\/nodes\/，生成物）\s+(\d+) 个/),
        submit: pick(/② 提交 \/ 榜单类导出\s+(\d+) 个/),
        cache: pick(/③ 抓取缓存 \/ 页面归档\s+(\d+) 个/)
    };
}

/** 验证：数字全 0 + 副本里没有作者物/git/凭据本尊 */
function verify(target) {
    const bad = [];
    const counts = readCounts(cleanReport(target).text);
    for (const [k, label] of Object.entries({
        cred: '① 凭据', chrome: '①b 浏览器登录态', packs: '①c 树包', submit: '② 提交导出', cache: '③ 缓存/页面'
    })) {
        if (counts[k] === null) bad.push(`${label}：报告里读不到数字（clean-personal 的措辞变了？）`);
        else if (counts[k] !== 0) bad.push(`${label}：还剩 ${counts[k]} 个`);
    }
    const walk = (d, depth) => {
        if (depth > 6) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
            const p = path.join(d, it.name);
            // ⚠️ 判据与"复制时跳过"**同一处**（`shouldSkipPath`）：这样"该跳过的东西漏进来了"
            //    自动被验出来（`.git` / `个人数据` / `作者专用` / `.tmp-*` / `AGENTS.md` / `__pycache__` / `*.pyc`），
            //    不用在这里再抄一张名单（抄一份就少一处、实测漏过）。
            if (shouldSkipPath(p)) { bad.push(`副本里还有该跳过的东西 ${path.relative(target, p)}`); continue; }
            if (it.isDirectory()) walk(p, depth + 1);
            else if (it.isFile() && (it.name === 'me.json' || it.name.startsWith('me.json.'))) {
                bad.push(`副本里还有凭据文件 ${path.relative(target, p)}`);
            }
        }
    };
    walk(target, 0);
    return { bad, counts };
}

console.log(`源仓库：${SOURCE}`);
console.log(`版本：  ${VERSION || '（读不到 APP_VERSION，退回 dev）'}`);
console.log(`目标：  ${DEFAULT_TARGET}${argOf('--target') ? '（本次用 --target 覆盖）' : '（默认；`作者专用/` 下）'}`);
const plan = measure(SOURCE);
console.log(`  将复制：${plan.files} 个文件 / ${mb(plan.bytes)} MB`
    + `（跳过 ${[...SKIP_DIRS].join(' / ')} 与 \`.tmp-*\` / \`*.pyc\` / \`AGENTS.md\`）`);
console.log('  副本里随后会：① 删 `.git` / `.git-full` / `作者专用` / `.tmp-*`（有才删）');
console.log('                ② 跑 `node app/scripts/clean-personal.mjs --yes`（= 档位 3：凭据/浏览器现场/树包/提交导出/缓存）');
console.log('                ③ 验一遍：① 0 ／ ①b 0 ／ ①c 树包 0 ／ ② 0 ／ ③ 0，且找不到任何"该跳过的东西"'
    + '（`.git`、`个人数据`、`作者专用`、`.tmp-*`、`AGENTS.md`、`__pycache__`／`*.pyc`）');
console.log('  原件**一个字节都不动**；最后只打印 `git init … push` 的命令，不自动推。');

async function run(target, opts = {}) {
    // ★ 全自动模式：目标已存在（上一轮发的副本）就**先删掉重建** —— 用户 2026-10-19 要的是
    //   "双击 bat 就完事"，不能因为"目标非空"停在那里。删的范围只有 `作者专用/AcmTree-*-release`。
    if (AUTO && fs.existsSync(target) && fs.readdirSync(target).length) {
        console.log(`\n[0/4] 目标已存在 ⇒ 先删掉旧的副本：${target}`);
        try {
            fs.rmSync(target, { recursive: true, force: true });
        } catch (err) {
            // ⚠️ 2026-10-19 实测：**有窗口/程序正开在那个副本里**（比如在里面敲过 cmd、或编辑器打开着）
            //    ⇒ Windows 回 `EPERM, Permission denied`（目录被当工作目录占着，删不动）。
            //    别让它变成一句栈：说清"关掉哪个窗口"，并**标清楚什么都没推**。
            console.error(`\n❌ 删不掉旧的副本：${err.code || ''} ${err.message}`);
            console.error('   多半是有窗口/程序正开在那个文件夹里（例如在里面敲过 cmd、或编辑器打开着）。');
            console.error('   ⇒ 关掉它，再双击一次 准备公开发布.bat。**什么都没推。**');
            process.exitCode = 1;
            return;
        }
    }
    const why = checkTarget(target);
    if (why) {
        console.error(`\n❌ ${why}`);
        process.exitCode = 1;
        return;
    }
    // ⚠️ 副本默认就住在**源仓库里的 `作者专用/` 下** ⇒ 不能直接 `cpSync(源 → 目标)`：
    //    Node 会直接拒（`Cannot copy … to a subdirectory of self`），而过滤器也救不了。
    //    ⇒ **先复制到系统临时目录，再整体搬进目标**（同盘 rename 是瞬时的；跨盘退回 cp+rm）。
    console.log(`\n[1/4] 复制 → ${target}`);
    const staging = path.join(os.tmpdir(), `acm-release-${process.pid}-${Date.now()}`);
    fs.rmSync(staging, { recursive: true, force: true });
    copyTree(SOURCE, staging);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
        fs.renameSync(staging, target);
    } catch {
        copyTree(staging, target);
        fs.rmSync(staging, { recursive: true, force: true });
    }

    console.log('[2/4] 删副本里的 git 元数据 / 作者物 / 临时目录');
    const removed = purgeForbidden(target);
    console.log(removed.length ? `      删掉：${removed.join('、')}` : '      （复制时已跳过，无需再删）');

    console.log('[3/4] 副本里清个人数据（档位 3）');
    const r = spawnSync(process.execPath, [path.join(target, 'app', 'scripts', 'clean-personal.mjs'), '--yes'],
        { cwd: target, stdio: 'inherit' });          // inherit：不接管它的输出（沙箱/管道都会出问题）
    if (r.status !== 0) {
        console.error('\n❌ 清个人数据那一步失败了（见上面的 ❌ 清单）—— 这份副本**不能发**');
        process.exitCode = 1;
        return;
    }

    // ★ 清完顺手把 `app/acm-data/nodes` 这个**空壳目录**删掉：`clean-personal` 删的是**文件**
    //   （唯一那份删除判据只管文件，别在那里加第二套"删目录"逻辑），而 git 不跟踪空目录 ⇒
    //   留着它只会让副本里看着像"还有 nodes/"（2026-10-19 排查发布时差点误判）。
    const nodesDir = path.join(target, 'app', 'acm-data', 'nodes');
    try {
        if (fs.existsSync(nodesDir) && fs.readdirSync(nodesDir).length === 0) fs.rmdirSync(nodesDir);
    } catch { /* 删不掉就算了：里面一个文件都没有，不影响发布 */ }

    console.log('[4/4] 验证');
    const { bad, counts } = verify(target);
    console.log(`      报告：① ${counts.cred} ｜ ①b ${counts.chrome} ｜ ①c ${counts.packs} ｜ ② ${counts.submit} ｜ ③ ${counts.cache}`);
    if (bad.length) {
        console.error('\n❌ 这份副本**还不能上传**：');
        for (const b of bad) console.error('     ' + b);
        process.exitCode = 1;
        return;
    }
    const size = measure(target);
    console.log(`\n✅ 可以上传：${size.files} 个文件 / ${mb(size.bytes)} MB（个人数据与作者物都已不在）`);
    // ---- 全自动（用户 2026-10-19："我要的效果是双击 bat 就全自动完成"）----
    // `--auto` ⇒ 读 `作者专用/发布配置.json`（remote / branch / commitMessage / push），
    // 复制→清→验**全过**后才跑：init → add → commit → remote → push，**一次都不问**。
    // ⚠️ 凭据不在这里：靠本机 git 已保存的那份（Git Credential Manager）。第一次 push 若弹授权窗口，
    //    授权一次之后就是静默的（那一窗口是 GitHub 的、不是我们的，脚本没法替你点）。
    if (AUTO) {
        const cfg = readPublishConfig();
        const branch = cfg.branch || 'main';
        const remote = cfg.remote || '';
        if (!remote) {
            console.error('\n❌ 没配 remote：请在 `作者专用/发布配置.json` 里写 "remote": "https://github.com/<你>/<仓库>.git"');
            process.exitCode = 1;
            return;
        }
        if (gitStep(target, ['init', '-b', branch], '初始化仓库') !== 0) return;
        // 关掉行尾转换（用户 2026-10-19："前面有大量 warning"）：本机 `core.autocrlf=true` 时
        // 每个文件都会打一条 `LF will be replaced by CRLF …`。设成 false ⇒ 盘上什么样就提交什么样，
        // 提示不再刷屏（内容一个字都不变，远端 blob 与之前完全相同）。
        if (gitQuiet(target, ['config', 'core.autocrlf', 'false']) !== 0) {
            console.log('   ⚠️ 没能关掉 core.autocrlf（不影响推送，只是行尾提示会继续出现）');
        }
        if (gitStep(target, ['add', '-A'], '把所有文件加进索引') !== 0) return;
        // ⚠️ **提交者身份必须显式给**（`-c user.name/-c user.email`）：本机全局 git 没配 user.email 时
        //    `git commit` 会报 `Author identity unknown / unable to auto-detect email address`（用户 2026-10-19
        //    双击后在「提交」这一步撞上，退出码 128）⇒ 从 `发布配置.json` 读，读不到用 GitHub 的 noreply。
        const who = [
            '-c', `user.name=${cfg.gitUser || 'someone'}`,
            '-c', `user.email=${cfg.gitEmail || 'someone@users.noreply.github.com'}`
        ];
        if (gitStep(target, [...who, 'commit', '-m', cfg.commitMessage || '首次公开：代码与规则'], '提交') !== 0) return;
        // 已经有 origin（重复发布）⇒ set-url；否则 add。
        // ⚠️ 探这一步**不许当失败**：`git remote get-url origin` 在没有 origin 时回**退出码 2**
        //   （2026-10-19 实测：整条自动流程就死在这句 `❌「读 origin」失败`、后面一步都没跑）。
        const hasOrigin = gitQuiet(target, ['remote', 'get-url', 'origin']) === 0;  // eslint-disable-line no-undef
        const r = hasOrigin
            ? gitStep(target, ['remote', 'set-url', 'origin', remote], '更新 remote')
            : gitStep(target, ['remote', 'add', 'origin', remote], '配置 remote');
        if (r !== 0) return;
        if (cfg.push === false) {
            console.log('   （配置里 push=false ⇒ 停在这里，没推）');
            return;
        }
        // ★ 推送顺序（用户 2026-10-19："希望裸连也能用；连不上时报告"）：
        //   ① **先试裸连**（不带任何代理）—— 能连上就直连，不碰代理；
        //   ② 裸连不通 ⇒ 现取系统代理再试（代理不写死，见 `detectProxy`）；
        //   ③ 两条都不通 ⇒ **明确报告**：哪条试过、错在哪、本地提交还在（不用重来）。
        const directOk = gitProbeDirect(target) === 0;
        console.log(directOk ? '   裸连 github.com 可用 ⇒ 直接推（不走代理）'
                             : '   裸连 github.com 不通 ⇒ 改用系统代理试试');
        const attempts = [];
        const tryPush = (proxyLabel, proxy) => {
            const args = proxy ? ['-c', `http.proxy=${proxy}`, '-c', `https.proxy=${proxy}`] : [];
            // ⚠️ **带 `--force`**：这个副本每次都是"重新 init 出来的全新历史"，而远端已经有上一版
            //    （2026-10-19 实测：不带就 `! [rejected] main -> main (fetch first)` / non-fast-forward）。
            //    这个仓库只有作者一个人推、内容就是这份副本 ⇒ 覆盖是**本意**，不是事故。
            const code = gitStep(target, [...args, 'push', '--force', '-u', 'origin', branch],
                proxyLabel ? `推送到 GitHub（经代理 ${proxy}）` : '推送到 GitHub（裸连）');
            attempts.push(`${proxyLabel || '裸连'}：${code === 0 ? '成功' : `失败（退出码 ${code}）`}`);
            return code === 0;
        };
        let ok = tryPush('裸连', '');
        if (!ok) {
            const proxy = detectProxy();
            if (proxy) ok = tryPush(`代理 ${proxy}`, proxy);
            else console.log('   也没检测到代理（环境变量 / Windows 系统代理都为空）');
        }
        if (ok) {
            console.log('\n🎉 推送完成（要发新的一版就再双击一次这个 .bat）。');
        } else {
            console.log('\n❌ 没能推上去。试过的路子：');
            for (const a of attempts) console.log('     · ' + a);
            console.log('   ⇒ 裸连与代理都不通时，先确认浏览器能不能开 https://github.com；');
            console.log('     能开就说明浏览器走了别的通道（把代理设成"系统代理"再双击一次）；');
            console.log('     **本地提交已经做好了**（在副本里），网络好了重跑这一份 .bat 或只 push 即可。');
            process.exitCode = 1;
        }
        return;
    }    if (opts.ask) {
        // 用户 2026-10-19："把你要我'自己敲'的部分放进 准备公开发布.bat" ⇒ 这一段由脚本代跑，
        // 但仍然**每一步都问**（remote 与 push 不可撤回，必须他点头）。
        // ⚠️ 中文/交互全部留在 Node 侧：那个 .bat 必须是纯 ASCII（cmd 会把 UTF-8 的中文行读碎）。
        const go = await opts.ask('\n要现在就在副本里 git init / add / commit 吗？（回车 = 跳过，自己敲）：');
        if (go === '') {
            console.log('   已跳过 git 那几步。要自己敲的命令在上面那段（cd / git init …）。');
            return;
        }
        if (gitStep(target, ['init', '-b', 'main'], '初始化仓库') !== 0) return;
        if (gitStep(target, ['add', '-A'], '把所有文件加进索引') !== 0) return;
        if (gitStep(target, ['commit', '-m', '首次公开：代码与规则'], '提交') !== 0) return;
        const url = await opts.ask('仓库地址（回车 = 先不配 remote）:');
        if (!url) {
            console.log('   没给 remote ⇒ 停在这里。之后自己敲：');
            console.log(`     cd "${target}"`);
            console.log(`     git remote add origin <你的仓库地址>`);
            console.log('     git push -u origin main');
            return;
        }
        if (gitStep(target, ['remote', 'add', 'origin', url], '配置 remote') !== 0) return;
        const push = await opts.ask('确认推送？要推到 GitHub 就敲 push（回车 = 先不推）：');
        if (push !== 'push') {
            console.log('   没推。之后自己敲：' + `\n     cd "${target}"\n     git push -u origin main`);
            return;
        }
        gitStep(target, ['push', '-u', 'origin', 'main'], '推送');
        return;
    }
    console.log('   下一步（自己确认 remote/账号后再敲）：');
    console.log(`     cd "${target}"`);
    console.log('     git init -b main');
    console.log('     git add -A');
    console.log('     git commit -m "首次公开：代码与规则"');
    console.log('     git remote add origin <你的仓库地址>');
    console.log('     git push -u origin main');
}

/**
 * 探"裸连"：真正问一次远端（`git ls-remote`，**显式清空代理变量**），只取退出码。
 *
 * ⚠️ 别用 TCP 连 443 判断（2026-10-19 实测：TCP 握手 118ms 就通，但 TLS 被拦 ⇒ `git push`
 *    照样 `Failed to connect … after 21107 ms`）。**能不能 push，只有 git 自己知道。**
 * @returns 退出码（0 = 裸连可用）
 */
function gitProbeDirect(cwd) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
    const r = spawnSync('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', 'ls-remote', '--heads', 'origin'],
        { cwd, stdio: 'ignore', timeout: 15000, env });
    return r.error ? -1 : (r.status || 0);
}

/**
 * 取"这份机器现在的代理"—— **不写死端口**（用户 2026-10-19："这个代理不稳定，有没有不写死代理的方法"）。
 *
 * 顺序：① 环境变量 `HTTPS_PROXY / https_proxy / HTTP_PROXY / http_proxy`（代理软件自己导的）
 *       ② **Windows 系统代理**（注册表 `Internet Settings` 的 `ProxyEnable` + `ProxyServer`）——
 *          代理软件一开就写、一关就清 ⇒ 跟着它走，不用改任何配置。
 *       ③ 都没有 ⇒ 空串（直连）。
 *
 * @returns {string} 形如 `http://127.0.0.1:7890`，或 `''`
 */
function detectProxy() {
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
        const v = process.env[k];
        if (v && String(v).trim()) return String(v).trim();
    }
    if (process.platform !== 'win32') return '';
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    // ⚠️ `reg query` 一次只认一个 `/v` ⇒ 分两次读（2026-10-19 实测："Invalid syntax"）
    const q = (name) => {
        const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8' });
        if (r.status !== 0) return '';
        const m = new RegExp(`\\s${name}\\s+REG_\\w+\\s+(\\S.*)$`, 'm').exec(String(r.stdout || ''));
        return m ? m[1].trim() : '';
    };
    const enable = q('ProxyEnable');
    const server = q('ProxyServer');
    if (enable !== '0x1' && enable !== '1') return '';
    if (!server) return '';
    const https = /(^|;)https=([^;]+)/.exec(server);
    const any = /(^|;)http=([^;]+)/.exec(server);
    const addr = (https && https[2]) || (any && any[2]) || server.split(';')[0];
    if (!addr) return '';
    return /^https?:\/\//.test(addr) ? addr : `http://${addr}`;
}

/**
 * 跑一条 git 命令但**不把它当失败**（只用来探状态，例如"有没有 origin"）。
 * ⚠️ 别用 `gitStep` 探：它非零就退出整条流程，而 `remote get-url` 在"没有 remote"时**正常地**回 2。
 *
 * @returns 退出码（跑不起来时 -1）
 */
function gitQuiet(cwd, args) {
    const r = spawnSync('git', args, { cwd, stdio: 'ignore' });
    return r.error ? -1 : (r.status || 0);
}

/**
 * 在副本里跑一条 git 命令（**stdio 走 inherit**：沙箱里抓子进程输出会 EPERM）。
 *
 * @returns 退出码（0 = 过）
 */
function gitStep(cwd, args, what) {
    const line = ['git', ...args.map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))].join(' ');
    console.log(`\n   $ ${line}`);
    const r = spawnSync('git', args, { cwd, stdio: 'inherit' });
    if (r.error) {
        console.error(`❌ 跑不起来 git（${what}）：${r.error.message} —— 装 Git 后重跑，或自己敲上面那条`);
        process.exitCode = 1;
        return 1;
    }
    if (r.status !== 0) {
        console.error(`❌「${what}」失败（退出码 ${r.status}）—— 停在这里，没往下走`);
        process.exitCode = 1;
        return r.status || 1;
    }
    return 0;
}

function makeAsk() {
    // 与 `clean-personal.mjs` 同一个写法（`rl.question` 在管道喂答案时会丢行）
    const rl = readline.createInterface({ input: process.stdin });
    const buffered = [];
    let waiter = null;
    let closed = false;
    rl.on('line', (line) => {
        const v = String(line).trim();
        if (waiter) { const w = waiter; waiter = null; w(v); } else buffered.push(v);
    });
    rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(''); } });
    const ask = async (q) => {
        process.stdout.write(q);
        if (buffered.length) return buffered.shift();
        if (closed) return '';
        return new Promise((resolve) => { waiter = resolve; });
    };
    return { ask, close: () => rl.close() };
}

async function main() {
    const target = path.resolve(argOf('--target') || DEFAULT_TARGET);
    if (!INTERACTIVE) {
        if (!APPLY) {
            console.log('\n（默认只报告，没复制也没删任何东西。真做：--yes；三问确认：--interactive）');
            return;
        }
        await run(target);
        return;
    }
    const { ask, close } = makeAsk();
    try {
        const a1 = await ask('\n第 1/3 步：确认要**复制一份并清空个人数据**（原件不动），请敲 go：');
        if (a1 !== 'go') { console.log('已取消，什么都没做。'); return; }
        const a2 = await ask(`第 2/3 步：副本放哪？（回车 = ${target}）：`);
        const finalTarget = a2 ? path.resolve(a2) : target;
        const why = checkTarget(finalTarget);
        if (why) { console.error(`\n❌ ${why}\n（没复制、没删任何东西）`); process.exitCode = 1; return; }
        const a3 = await ask(`第 3/3 步：确认复制到\n       ${finalTarget}\n     并清空个人数据（档位 3）？请敲 yes：`);
        if (a3 !== 'yes') { console.log('已取消，什么都没做。'); return; }
        if (argv.includes('--dry-run')) { console.log('\n（--dry-run：三问走完，但没复制也没删）'); return; }
        // 第 4 步（用户 2026-10-19："把'自己敲'的部分放进 准备公开发布.bat"）：复制/清理/验证**全过**之后，
        // 才问要不要接着 git init/add/commit/remote/push —— `run` 里一遇失败就 return，不会再问。
        await run(finalTarget, { ask });
    } finally {
        close();
    }
}

main().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
