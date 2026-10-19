#!/usr/bin/env node
// ================================================================
// 清除个人数据（scripts/clean-personal.mjs）
//
// 用途：把"看得出是谁的"东西清掉 —— **发出仓库之前**清一次；收件人想清掉自己的东西再转手，同理。
// 形状是"**双击 .bat 也不写盘**"——
// 仓根往下三层那个纯 ASCII 的 `清除个人数据\...\清除个人数据.bat` 双击后转到这里，
// 由**三问**决定要不要真清：
//     ① 在这里敲 go     ② 选级别 1/2/3     ③ 敲 yes
// 最后那个 yes 之前，**一个字节都不写**。本文件沿用这个形状（--interactive）。
//
// 用法（**从仓库根跑**；文件住在机械层的 `app/scripts/` 下）：
//   node app/scripts/clean-personal.mjs                      # 只报告（默认，不写盘）
//   node app/scripts/clean-personal.mjs --interactive        # 三问确认（.bat 走这条）
//   node app/scripts/clean-personal.mjs --yes                # 直接清（脚本/CI 用）
//   node app/scripts/clean-personal.mjs --interactive --dry-run   # 走完三问也只报告
//   node app/scripts/clean-personal.mjs --yes --keep-me      # 只删产物、不动凭据
//
// ★ **失败会报出来**：清不掉的文件（多半是 Chrome / 编辑器占着）逐条打 `删除失败 …`，
//   并在最后打一段 `❌ 有 N 项没清掉` + **退出码 1** —— "跑一次、成功才发出去"的自动化
//   不会因为"删失败却 exit 0"把带活 cookie 的文件夹发走（2026-10-19 修，见 `apply()` 上的注释）。
//
// 三个级别（--interactive 里选）：
//   1 = 凭据（`个人数据/me.json*`、**带 `me` 块的导出包** `AcmTree_Full_*.json[.gz]`、
//       `个人数据/_chrome-profile/` —— 浏览器现场，里面有 `Default/Network/Cookies` = 活的登录 cookie）
//       ＋ **树包**（`app/acm-data/nodes/**` —— **生成物**：产包链几十分钟就能再造一份，
//         而里面写着"这条提交属于谁"（实测 `all_nodes.json` 7850 处真账号）⇒ 它属于"看得出是谁"的东西。
//         用户 2026-10-19："既然是生成所需的，应在档位 1 就清除"）
//   2 = 上面的 ＋ **提交 / 榜单类导出**
//   3 = 全部 = 2 + **抓取缓存与页面归档**（cache/ pages/ __pycache__/ *.html *.log *.png *.bak *.pyc）
//
// ⚠️ **它扫四处**（2026-10-17 定）：`<机械层>/acm-data`（出 ②③）、仓库根的 `个人数据/`（含里面的
//    `_chrome-profile/`，整个目录属于第 1 级）、以及**仓库根一层**（导出包常被随手扔在那儿）。
//    后两处里"仓库根一层"**只认凭据名字**（`me.json*` / `AcmTree_Full_*.json[.gz]`），不做 ②③ 分类。
//
// ⚠️ **不留底**：清 `me.json` 就是直接换成空模板，不另存 `*.bak-before-clean`。
//    理由：想留着凭据的人会先把整个文件夹复制一份、在**副本**上清 —— 原版那份 me.json 还在，
//    工具再留一份"同名 + 后缀"的明文副本只会被一起发出去（旧版本留的底遇到就当凭据删掉）。
//
// ⚠️ 判据**只有这一份**（`SUBMIT_RE` / `CACHE_DIR_RE` / `CACHE_NAME_RE` / `KEEP_RE` / `ME_EXPORT_RE`）：
//    改口径就改这里，别在别处再抄一遍正则。
// ⚠️ 永不删除的东西见下面的 `NEVER_DELETE`（运行时也会打印出来给人核对）。
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { APP_ROOT, repoRoot, personalDir } from './roots.mjs';

// ⚠️ **两个层别混**（定义见 `roots.mjs`）：`ROOT` = **仓库根**（给人看的那一层，`个人数据/` 住这儿），
//    `ACM` = **机械层**的 `app/acm-data`（抓取产物与注册表住这儿）。
//    ★ 2026-10-17 真踩到：凭据从 `acm-data/…/me.json` 搬成了**仓库根**的 `个人数据/me.json`，
//      而这里原来 `ROOT` 当机械层用、只 `walk(ACM)` ⇒ **看不见凭据了**：
//      报告照旧打"① 凭据 0 个"，于是"发出仓库前清一次"会**把真凭据原样带走**（静默失效）。
//      修法：两棵树都扫（凭据那棵只按名字认 `me.json*`），并把扫的范围**打印出来**。
const ROOT = repoRoot();
const ACM = path.join(APP_ROOT, 'acm-data');
const RAW = path.join(ACM, 'raw');
//: **树包**（`all_nodes.json` + 各平台分类包）＝ **生成物**：档位 1 就删（理由见文件头的三个级别）。
//: ⚠️ 2026-10-19 改口径：它原来在 `NEVER_DELETE` 里（"导入用"），但里面写着"这条提交属于谁"
//:    （实测 7850 处真账号），而且**产包链随时能再造**（幂等）⇒ 留在"只清凭据"那一级等于把账号漏出去。
const NODES = path.join(ACM, 'nodes');
const PERSONAL = personalDir();
//: 浏览器现场（`Default/Network/Cookies`、`Trust Tokens` = **活的登录态**）。`.gitignore` 里忽略它，
//: 但**盘上还在** ⇒ 把工作区副本发给别人之前必须清掉（第 1 级"只清凭据"一起处理）。
//: ⚠️ 2026-10-17 起它住 `个人数据/` 里（仓库根只留"给人看的东西"）—— 位置**只**从 `personalDir()` 拿。
const CHROME = path.join(personalDir(), '_chrome-profile');

const argv = process.argv.slice(2);
const INTERACTIVE = argv.includes('--interactive');
const APPLY = argv.includes('--yes') && !argv.includes('--dry-run');
const KEEP_ME = argv.includes('--keep-me');

/** 空凭据模板（写进每个 `me.json*` 的占位内容） */
const EMPTY_ME = '{"_note":"此处原为个人凭据，已清空","cf":{},"qoj":{},"clist":{},"accounts":[],"current":""}';

//: ①-b **从应用里导出的整份数据**（`AcmTree_Full_<时间戳>.json[.gz]`）—— 它**带 `me` 块**
//:   （用户 2026-10-17："me.json 应该进（主脚本）导出包 —— 它对应完整数据导出，不上 GitHub"）
//:   ⇒ 它本身就是**凭据复制品**，档位与 `me.json.bak` 一样：**第 1 级就删**
//:   （"只清凭据"那一级却把它留下 ＝ 凭据照旧被带走）。名字见 `handlers/H1_jsonIO.js` 的下载名。
//:   ⚠️ 只认名字：导出后**改过名**的认不出来 ⇒ 发出之前别把导出包留在仓库里（这条写在 `作者专用/发出去之前.md`）。
const ME_EXPORT_RE = /^AcmTree_Full_.*\.json(\.gz)?$/;

//: ①-c **"这一场是用哪个账号抓的"这类旧痕迹**（`{cid: 账号}`，里面是 `TEAM0/teamA` 这种队名/账号）。
//:   用户 2026-10-19："TEAM0/teamA 等所有个人信息理应由 me.json 提供，且不留痕迹" ⇒ 那份文件
//:   已从仓库删掉、抓取侧也不再生成它（事实搬进 `me.json` 的 `hdu.years.<年份>.contestUser`，
//:   出包侧按 cid 的年份直接读）。这里留一条判据：**谁要是又生成出一份**，第 1 级当凭据复本清掉
//:   （`.gitignore` 里另有一条兜底，`hdu_multi_fetch --selftest` 第 ⑥ 组见到它就红）。
const OLD_IDENTITY_FILE_RE = /^hdu_contest_accounts\.json$/;

//: ② 提交 / 榜单类导出（提交记录与榜单统计的缓存/导出文件）
const SUBMIT_RE = new RegExp([
    '^(qoj_submissions|submitter-)',
    '_submits\\.json$',
    '_rank_stats\\.json$',
    '_standings_.*\\.json$',
    '\\.srk\\.json$',
    '^PTA_rankings\\.json$',
    // 队级提交导出。⚠️ **不能加 `^`**：前缀可有可无 —— 实测漏过
    // `ec2_teamsubmissions.json`（前缀 `ec2_`，里面是队名 + 三个真名），
    // 以及 `PTA_team_submissions_with_label.json`（手工加 label 的那份）。
    'team_?submissions.*\\.json$',
    // CF 的**整份个人提交历史**（`user.status` 抓下来的，`cache/cf_contest/history_<handle>.json`
    // ≥1MB/人、含 handle 与每一条提交）。⚠️ 它住在 `cache/` 里 ⇒ 只靠 `CACHE_DIR_RE` 的话
    // **级别 2 会漏**（那份文件正是"提交类导出"）⇒ 这里按**名字**也认一遍（2026-10-15 实测补）。
    '^history_.*\\.json$',
    '^2\\.json$'
].join('|'));
//: ③ 抓取缓存 / 页面归档（提交页、榜单页、题面页的原始归档）
// ⚠️ **位置优先于名字**：`cache/` `pages/` `__pycache__/` 里的一律算第 3 级 —— 哪怕它叫
//    `*_problems.json` / `*.tasks.html`（那是**抓来的题单/题面缓存**，不是"题库清单"）。
//    实测踩到：148 个这种文件靠 `KEEP_RE` 逃过了一级（`nk_*_problems.json` 51、
//    AtCoder `*.tasks.html` 44、`crate_*_rlrefs_problems.json` 35、
//    `qoj_vp_contests.json`【含用户名】、`contests.p1.html`【含用户名 + token】、
//    `xcpc_contests.json.bak`【旧清单，含队名】）。判据顺序见下面的收集循环。
const CACHE_DIR_RE = /\\(cache|pages|__pycache__)\\|\/(cache|pages|__pycache__)\//;
// ⚠️ `.html$` 而不是只认 `*.contest.html`：实测漏过 `04 qoj/qoj_contest.html`
//    （下划线命名，是 `QOJ_problems_scraper.py` 的输入页面，**登录态存下来的** ——
//     里面有用户名和 `/logout?_token=…`）。页面归档一律按第 3 级清。
// ⚠️ `.pyc$`：`__pycache__` 里的旧字节码（`sys.dont_write_bytecode` 之前留下的）
//    会把**改之前**的源码字符串留在里面 —— 实测有一份还带着人名。
const CACHE_NAME_RE = /\.html$|\.log$|\.png$|\.bak$|\.pyc$/;
//: 但**位于 cache/pages 之外**、名字里含"规则与注册表"的必须留（题库清单、注册表、白名单）
const KEEP_RE = /problems|registry|contests|whitelist|tasks/;
//: 源码/文档**显式**永不删（`NEVER_DELETE` 第一条）。今天实测 cache 里一个都没有，
//: 但"位置优先"那条规则会把 cache 里的东西一律算第 3 级 —— 万一谁往缓存目录里放了脚本，
//: 这里兜一层，别让"源码一份不删"变成空话。
const SOURCE_KEEP_RE = /\.(py|js|mjs|md|bat|css|ts)$/i;

//: **无论如何都不会被删的东西**（三个级别都一样；改这里之前先想清楚：删了就重建不出来）
const NEVER_DELETE = [
    '所有 `*.py` / `*.js` / `*.mjs` / `*.md` / `*.bat` —— 源码、脚本、文档一份不删',
    '注册表与题库比赛清单（`raw/` 里、**cache/ 之外**的）：名字含 problems / registry / contests / whitelist / tasks 的一律不动',
    '  （`acm-data/field-registry.json`、`nature-registry.json`、`synth-registry.json`、`nature-assignments.json`、',
    '   `raw/Scaper/05 xcpc/xcpc_registry.json`、`xcpc_contests.json`、`gym_whitelist.json`、各 `*_problems.json` / `*_contests.json`）',
    '`acm-data/merged/` 的示例产物、`reports/` 的报告',
    '`acm-data/raw` 之外的一切（`src/`、`docs/`、`scripts/`、根目录 md/bat）',
    '仓库外的任何文件（脚本只走四处：机械层的 `app/acm-data/`，仓库根的 `个人数据/` 与**仓库根一层**'
    + '（后两处**只认凭据名字**：`me.json*` / `AcmTree_Full_*.json[.gz]`），以及 `个人数据/_chrome-profile/`'
    + '—— 那一个**整个目录**删，见下面的级别说明）'
];

function* walk(dir) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
        const p = path.join(dir, it.name);
        if (it.isDirectory()) yield* walk(p);
        else if (it.isFile()) yield p;
    }
}

/** 仓库根**一层**的文件（**不递归**：`.git/` 几万个文件；而且"凭据被塞进子目录"不是这个工具该猜的事） */
function* topLevelFiles(dir) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) if (it.isFile()) yield path.join(dir, it.name);
}

/**
 * 认出"凭据类"文件 —— **两棵树共用这一处判据**（别写两遍、别各自演化）。
 *
 * @returns `'stale'`（旧版留的底，删）｜`'me'`（本尊，换空模板）｜`'copy'`（复制品/导出包，删）｜`null`
 */
function credentialKind(name) {
    if (name.endsWith('.bak-before-clean')) return 'stale';
    if (name === 'me.json') return 'me';
    // `me.json.bak` / `me.json.bak2` … 与**带 `me` 块的导出包**（`.json[.gz]`）都是凭据复制品；
    // `hdu_contest_accounts.json` 这类"旧身份痕迹"同属第 1 级（见上面 `OLD_IDENTITY_FILE_RE`）。
    if (name.startsWith('me.json') || ME_EXPORT_RE.test(name) || OLD_IDENTITY_FILE_RE.test(name)) return 'copy';
    return null;
}

const meFiles = [];
const meCopies = [];   //: `me.json` 之外的凭据复制品（`me.json.bak`、`AcmTree_Full_*.json`…）—— 级别 1 直接删
//: 树包（`acm-data/nodes/**`，**生成物**）—— 级别 1 直接删（口径见文件头三个级别）
const packs = [];
const submits = [];
const caches = [];
//: 旧版本留的底（`*.bak-before-clean`，**明文真凭据**）—— 现在**不留底**了（见下面的说明），
//  遇到旧的就当凭据清掉，别让它躺在要发出去的文件夹里。
const staleBaks = [];

// ---- ① 凭据类：`个人数据/`（递归）＋ **仓库根一层**（导出包最常被随手扔在仓库根）----
// ⚠️ 这两棵树**只认凭据名字**，绝不做 ②③ 分类 —— 否则仓库根上随便一张 `.png`/`.html`
//    都会被第 3 级删掉（那不在"抓取归档"的语义里）。
for (const f of [...walk(PERSONAL), ...topLevelFiles(ROOT)]) {
    const kind = credentialKind(path.basename(f));
    if (kind === 'stale') staleBaks.push(f);
    else if (kind === 'me') meFiles.push(f);
    else if (kind === 'copy') meCopies.push(f);
}

// ---- ①b 浏览器登录态：`_chrome-profile/`（整个目录）----
// 为什么算第 1 级：里面的 `Default/Network/Cookies` 与 `Trust Tokens` 就是**登录 cookie** ——
// 和 `me.json` 是同一类东西（"拿着它就能登进去"），只是换了个容器。清完要重新登录一次，代价明确。
// ⚠️ 两个变量分工要拧清：`CHROME_EXISTS` 决定**要不要动手**，`chromeFiles` 只用来**报体积/个数**。
//    2026-10-19 修：原来只有 `chromeFiles`，而删不删是靠 `if (t.chrome.length)` ——
//    目录存在但一个文件都读不出来（空目录 / 权限 / 被占）时**连试都不试**，报告还打「0 个」
//    （与 2026-10-17 那次「① 凭据 0 个」是同一形态：拿"扫到几个"当"有没有"）。
const CHROME_EXISTS = fs.existsSync(CHROME);
const chromeFiles = CHROME_EXISTS ? [...walk(CHROME)] : [];

// ---- ②③：只在**抓取产物那一棵树**里认（位置优先 + 名字）----
for (const f of walk(ACM)) {
    const name = path.basename(f);
    // ⚠️ **不留底**：想留着凭据就先复制整个文件夹、在**副本**上清 —— 原版那份 me.json 还在，
    //    不需要工具再给一份"同名 + 后缀"的明文副本（那反而容易被一起发出去）。
    //    （机械层里理论上不该再有凭据了，但老版本可能留过副本 ⇒ 这条判据照旧认它。）
    const kind = credentialKind(name);
    if (kind === 'stale') { staleBaks.push(f); continue; }
    if (kind === 'me') { meFiles.push(f); continue; }
    if (kind === 'copy') { meCopies.push(f); continue; }
    // ---- ①c 树包：**生成物**（重建一份就是跑一趟产包链），里面写着"这条提交属于谁" ----
    // ⚠️ 2026-10-19 用户定："既然是生成所需的，应在档位 1 就清除"。
    //    它原来在 `NEVER_DELETE` 里；实测 `all_nodes.json` 有 7850 处真账号 ⇒ 留在"只清凭据"那一级
    //    等于把账号原样带走（和 2026-10-17 那次「凭据 0 个」是同一类"报告说清了、其实没清"）。
    if (f.startsWith(NODES)) { packs.push(f); continue; }
    if (!f.startsWith(RAW)) continue;
    const rel = path.relative(ROOT, f);
    // ⚠️ **位置优先于名字**：`cache/` `pages/` `__pycache__/` 里的一律算第 3 级 —— 哪怕它叫
    //    `*_problems.json` / `*.tasks.html`（那是**抓来的题单/题面缓存**，不是"题库清单"）。
    //    `KEEP_RE` 只在**这些位置之外**生效；②（提交/榜单导出）的口径与顺序保持原样不变
    //    （否则会像实测那样：level 2 从 485 个掉到 46 个）。
    const inCache = CACHE_DIR_RE.test(rel) || CACHE_NAME_RE.test(name);
    if (SOURCE_KEEP_RE.test(name)) continue;                  // 源码/文档：显式永不删
    if (!inCache && KEEP_RE.test(name)) continue;
    if (SUBMIT_RE.test(name)) submits.push(f);
    else if (inCache) caches.push(f);
}

//: 体积统计要**容错**、而且**必须在删之前算**：删完再 stat 会 ENOENT
//  （"真删"路径正是崩在这里 —— 文件都删掉了，收尾却去 stat 它们）。
const sizeMbSafe = (list) => list.reduce((s, f) => {
    try { return s + (fs.statSync(f).size || 0); } catch { return s; }
}, 0) / 1048576;
const mb = (list) => sizeMbSafe(list).toFixed(1);
const rel = (f) => path.relative(ROOT, f);       // 相对**仓库根**（`app/acm-data/…` 或 `个人数据/me.json`）

/**
 * **这一级的唯一一份计划**（确认框与执行都只认它）。
 *
 * ⚠️ 2026-10-19 修：原来有两份 —— `targetOf()` 里算了 `staleBaks/meCopies`（并真的删了），
 *    而交互确认那行自己手写 `t.submit.length + t.cache.length + t.chrome.length`
 *    ⇒ **确认框少报**：实测"第 1 级说删除文件 1 个、实际删了 6 个"（少报的正是 `me.json.bak`
 *    与 `AcmTree_Full_*.json[.gz]` 这类凭据复制品）。判据：**数字只许从 `planCounts()` 出**。
 */
function targetOf(level) {
    const credLevel = level >= 1 && !KEEP_ME;
    return {
        me: credLevel ? meFiles : [],
        // 凭据复制品/导出包：直接删（与 `me.json` 同属第 1 级 —— 见文件头的"不留底"）
        cred: credLevel ? [...staleBaks, ...meCopies] : [],
        chrome: credLevel ? chromeFiles : [],
        // 删不删看"目录在不在"，不是"扫到几个文件"（见上面 `CHROME_EXISTS` 的注释）
        chromeDir: credLevel && CHROME_EXISTS,
        // 树包（`acm-data/nodes/**`）：**生成物**，第 1 级就删（口径见文件头）
        packs: credLevel ? packs : [],
        submit: level >= 2 ? submits : [],
        cache: level >= 3 ? caches : []
    };
}

/** 这一级**要删哪些文件、共多少体积** —— 确认框与执行同源（少报的病根是两处各算一遍） */
function planCounts(t) {
    const files = [...t.cred, ...t.packs, ...t.submit, ...t.cache];
    return { files, mb: sizeMbSafe([...files, ...t.chrome]) };
}

console.log(`仓库：${ROOT}`);
// 把**扫了哪几处**打出来：这条"0 个"曾经因为少扫一棵树而静默说谎（见文件头的 2026-10-17 事故）
console.log(`  扫描：${path.relative(ROOT, ACM)}（①c 树包＋②③）＋ ${path.relative(ROOT, PERSONAL)} 与仓库根一层`
    + `（① 只认凭据名字）＋ ${path.relative(ROOT, CHROME)}（①b 浏览器登录态）`);
console.log(`  ① 凭据（me.json / 导出包）      ${meFiles.length} 个（换成空模板）`
    + (meCopies.length + staleBaks.length
        ? `＋复制品 ${meCopies.length + staleBaks.length} 份（直接删）` : ''));
console.log(`  ①b 浏览器登录态（_chrome-profile/） ${chromeFiles.length} 个 / ${mb(chromeFiles)} MB`
    + (chromeFiles.length ? '（第 1 级**整个目录**删掉：那里面有 `Default/Network/Cookies`）'
        : (CHROME_EXISTS ? '（⚠️ 目录在、但一个文件都没扫到 —— 第 1 级仍**整目录**删）' : '')));
console.log(`  ①c 树包（acm-data/nodes/，生成物） ${packs.length} 个 / ${mb(packs)} MB（第 1 级就删，重建=跑一遍产包链）`);
console.log(`  ② 提交 / 榜单类导出            ${submits.length} 个 / ${mb(submits)} MB`);
console.log(`  ③ 抓取缓存 / 页面归档          ${caches.length} 个 / ${mb(caches)} MB`);
console.log('     （三个级别：1 = ①+①b+①c｜2 = 1+②｜3 = 2+③）');
console.log('     （清凭据**不留底**：想留着就先把整个文件夹复制一份、在副本上清）');
console.log('  ⛔ 无论哪一级都不会删：');
for (const line of NEVER_DELETE) console.log('       ' + line);

/**
 * 真清。**失败必须能被外面看见**：逐条打出来 + 退出码 1（见下面的 `failed`）。
 *
 * ⚠️ 2026-10-19 修：原来两处 `catch` 只 `console.error` 就继续，末尾照打 `✅ 已删除 N 个文件`，
 *    而且 `main()` 永远 exit 0。实测（用文件锁模拟"Chrome 正在跑"）：
 *    `删除失败 …EPERM` 之后就接一句 `✅ 已清空凭据 2 个 ｜ 已删除 9 个文件`，**退出码 0** ——
 *    而且 `rmSync` 是先把别的文件删掉、**最后活下来的恰好是 `Default/Network/Cookies`**。
 *    "发出之前跑一次、成功才发"的自动化会带着活 cookie 把文件夹发走。
 */
function apply(level) {
    const t = targetOf(level);
    const plan = planCounts(t);
    const failed = [];
    let nMe = 0;
    let nDel = 0;
    for (const f of t.me) {
        // **不留底**：直接换成空模板（想留着凭据就先复制整个文件夹、在副本上清）。
        try {
            fs.writeFileSync(f, EMPTY_ME + '\n', 'utf8');
            nMe++;
        } catch (e) {
            failed.push(rel(f));
            console.error(`清空失败 ${rel(f)}：${e.message}`);
        }
    }
    // 浏览器现场：**整目录删**（里面有子目录与 SQLite 之类的附属文件，逐个 unlink 只会剩下空壳）
    if (t.chromeDir) {
        try { fs.rmSync(CHROME, { recursive: true, force: true }); nDel += t.chrome.length; }
        catch (e) {
            failed.push(rel(CHROME));
            console.error(`删除失败 ${rel(CHROME)}：${e.message}`
                + `\n  ⚠️ 那里面 \`Default/Network/Cookies\` 是**活的登录态** —— 关掉 Chrome / 编辑器再跑一次`);
        }
    }
    for (const f of plan.files) {
        try { fs.unlinkSync(f); nDel++; } catch (e) {
            failed.push(rel(f));
            console.error(`删除失败 ${rel(f)}：${e.message}`);
        }
    }
    console.log(`\n${failed.length ? '⚠️' : '✅'} 已清空凭据 ${nMe} 个 ｜ 已删除 ${nDel} 个文件（约 ${plan.mb.toFixed(1)} MB）`);
    console.log('   （**不留底**：想留着凭据就先复制整个文件夹、在副本上清 —— 原版那份 me.json 还在。）');
    console.log('   注册表、题库比赛清单与所有源码/文档一个都没动（见上面那份"不会删"清单）。'
        + (t.packs.length ? '树包已按第 1 级删掉 —— 要恢复就跑一遍产包链（`npm run build:all` 或应用里的「🛠 重建总包」）。' : ''));
    if (failed.length) {
        console.error(`\n❌ 有 ${failed.length} 项没清掉（多半是进程占着）：`);
        for (const f of failed) console.error('     ' + f);
        console.error('   ⚠️ 这份文件夹**还不能发出去** —— 修掉上面那些再跑一次。');
        process.exitCode = 1;
    }
}

/**
 * 自己的行读器（不用 `rl.question`）：`rl.question` 在**管道喂答案**时会丢行 ——
 * 第二问注册之前，第二行可能已经到了、直接被丢掉（实测 `go / 2 / yes` 会卡在第一问之后）。
 * 这里把到达的行先攒起来，问的时候再取，于是"人工敲"和"管道喂"都能用。
 * stdin 提前结束（EOF / Ctrl+C）⇒ 后续问题一律收到空答案 = 取消。
 */
function makeAsk() {
    const rl = readline.createInterface({ input: process.stdin });
    const buffered = [];
    let waiter = null;
    let closed = false;
    rl.on('line', (line) => {
        const v = String(line).trim();
        if (waiter) { const w = waiter; waiter = null; w(v); } else buffered.push(v);
    });
    rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w(''); } });
    const ask = async (question) => {
        process.stdout.write(question);
        if (buffered.length) return buffered.shift();
        if (closed) return '';
        return new Promise((resolve) => { waiter = resolve; });
    };
    return { ask, close: () => rl.close() };
}

async function main() {
    if (!INTERACTIVE) {
        if (!APPLY) {
            console.log('\n（默认只报告，没动任何文件。真删：--yes；三问确认：--interactive）');
            return;
        }
        apply(3);
        return;
    }
    const { ask, close } = makeAsk();
    try {
        const a1 = await ask('\n第 1/3 步：确认要在**这个仓库**里清个人数据，请敲 go（其它任何输入 = 什么都不做）：');
        if (a1 !== 'go') { console.log('已取消，没动任何文件。'); return; }
        const a2 = await ask('第 2/3 步：清到哪一级？1 = 只凭据｜2 = 凭据+提交导出｜3 = 全部（含缓存/页面）：');
        const level = Number(a2);
        if (![1, 2, 3].includes(level)) { console.log('级别不是 1/2/3，已取消，没动任何文件。'); return; }
        const t = targetOf(level);
        const plan = planCounts(t);          // ★ 数字只从这个计划出（见 `targetOf` 上的注释）
        console.log(`\n将要做：清空凭据 ${t.me.length} 个、删除文件 ${plan.files.length + t.chrome.length} 个`
            + `（约 ${plan.mb.toFixed(1)} MB）`
            + (t.cred.length ? `，其中**备份/导出包** ${t.cred.length} 份（直接删）` : '')
            + (t.chromeDir
                ? `，并**整个** \`_chrome-profile/\` 目录（${t.chrome.length} 个文件，要重新登录）` : ''));
        const a3 = await ask('第 3/3 步：确认执行请敲 yes（其它任何输入 = 什么都不做）：');
        if (a3 !== 'yes') { console.log('已取消，没动任何文件。'); return; }
        if (argv.includes('--dry-run')) { console.log('\n（--dry-run：三问走完，但没写盘）'); return; }
        apply(level);
    } finally {
        close();
    }
}

main().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
