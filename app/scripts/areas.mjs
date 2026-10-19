// ================================================================
// 区域分类（**唯一一份**）—— "哪些源码区域已有就地规范、哪些明确暂缓、为什么"
//
// 粒度**两层**：区域（`src/core`、`scripts`…）+ **模块**（`src/features/` 下的一整块功能，
// 如"检索"= ProblemSearch + ContestSearch + Search）。模块那一层的判据在
// `src/features/AGENTS.md` 的 `覆盖：` 行里（这里只是读它，不另立名单）。
//
// 两个消费者（都读这一份，别各写一份）：
//   · `src/test/docAnchors.test.js` 的「区域清单」「模块清单」：没分类 / 四槽没写全 ⇒ **红**；
//   · `保存快照.bat`：每次保存把"这次动了哪些区域、哪个还没就地文档"**打印**一遍。
//
// 为什么要有它：给每个区域写"就地规范"（这层是什么 / 改这里的坑 / 先看什么）是**长期不断的工作**，
// 靠记性一定漏。所以把"漏"变成**会红**（守卫）+ **每次保存都念一遍**（保存脚本）。
//
// ⚠️ **别再用 git 钩子做这件事（实测：走不通）** —— 2026-10-12 试过两种写法，都失败：
//    · `pre-commit.bat`：Git for Windows **只找精确名字** `pre-commit`，`.bat` 后缀它根本不看（提交时毫无反应）；
//    · 精确名 `pre-commit` 里放批处理内容：git 用 MSYS 的 spawn 去起它 ⇒
//      `error: cannot spawn .githooks/pre-commit: No such file or directory`（没扩展名/没 shebang 起不来）；
//    · 那放 sh 脚本？sh.exe 要建**信号管道**，在受限环境（DSH 文件沙箱）直接
//      `fatal error - couldn't create signal pipe, Win32 error 5` ⇒ **把提交整个挡住**。
//    ⇒ 提醒放在"人一定会走的那一步"（保存脚本）里，比钩子可靠。
//
// 用法：
//   node scripts/areas.mjs --list                                   # 打印分类表（人看）
//   git diff --cached --name-only | node scripts/areas.mjs --remind  # 提交前（手跑）
//   git show --name-only --format= HEAD | node scripts/areas.mjs --remind   # 刚提交的这次（保存脚本用）
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { APP_ROOT, repoRoot } from './roots.mjs';

/** 已经有就地 `AGENTS.md` 的区域（那份文件必须真的在，守卫会核） */
export const AREA_WITH_DOC = ['src/core', 'src/ui', 'src/features', 'scripts', 'acm-data'];

/** 明确"**暂缓**"的区域：写一句为什么先不写（暂缓也是一等公民，不是欠账） */
export const AREA_DEFERRED = {
    'src/view': '口径薄，坑基本写在 `src/core/AGENTS.md` 与 `src/ui/AGENTS.md` 里',
    'src/handlers': '同上（快捷键与顶部动作很薄）',
    'src/transaction': '同上（事务链的机制写在 `core/derive.js` 与 `transaction/executor.js` 的文件头）',
    'src/persistence': '同上（落盘机制写在 `persistence/diff.js` / `index.js` 的文件头）',
    'src/shell': '同上（装配层，机制在 `shell/executor.js` 文件头）',
    'src/utils': '同上（小工具）',
    'src/test': '测试自己就是规范（守卫 + 对拍），不需要再配一份会漂的说明'
};

/** 不要求就地规范的路径（说明性材料 / 文件头本身就是规范的那种） */
const AREA_NOT_NEEDED = {
    '作者专用': '作者留档（待办 / 记录 / 深读材料），它们自己就是文档',
    docs: '面向使用者的文档（指南等），不是开发规范'
};

// ================================================================
// **模块级**：`src/features/` 下面是"一整块功能"（检索 / 自动导入 / …），
// 一个"区域暂缓"盖不住它们 —— 所以那一层用 `src/features/AGENTS.md` 的**一节一个模块**。
//
// ⚠️ "目录 → 模块名"的**唯一一份**在那份文档的 `覆盖：` 行里（这里只是读它）；
//    别在代码里再抄一份名单 —— 抄了就一定会跟文档分叉。
// ================================================================
const MODULES_DOC = 'src/features/AGENTS.md';
let _moduleMap = null;
let _deferredModules = null;

/**
 * 从模块文档读两张表（懒加载 + 记一次）：
 *   `目录 → 模块名`（`## 模块：X` 那节的 `覆盖：` 行）与 `目录 → 暂缓理由`（`## 暂缓的模块` 那节）。
 * ⚠️ 两份都**只在文档里**，这里不另立名单。
 */
export function moduleMap() {
    if (_moduleMap) return _moduleMap;
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', ...MODULES_DOC.split('/'));
    _moduleMap = new Map();
    _deferredModules = new Map();
    if (!fs.existsSync(p)) return _moduleMap;
    let cur = '';
    let inDeferred = false;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (/^##\s*暂缓的模块/.test(line)) { inDeferred = true; cur = ''; continue; }
        const h = /^##\s*模块：\s*(.+?)\s*$/.exec(line);
        if (h) { cur = h[1]; inDeferred = false; continue; }
        if (/^##\s/.test(line)) { cur = ''; inDeferred = false; continue; }
        if (inDeferred) {
            const d = /^-\s*\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(line);   // `- **AutoImport**：理由…`
            if (d) _deferredModules.set(d[1].trim(), d[2].trim());
            continue;
        }
        const c = /^覆盖：\s*(.+)$/.exec(line);
        if (c && cur) {
            for (const d of c[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean)) {
                _moduleMap.set(d, cur);
            }
        }
    }
    return _moduleMap;
}

/** `目录 → 暂缓理由`（与"建档"是同一份文档的两半） */
export function deferredModules() {
    if (!_deferredModules) moduleMap();
    return _deferredModules;
}

/**
 * 一个文件属于哪个"区域"，以及这一区该怎么处理。
 * @returns {{kind:'root'|'srcRoot'|'doc'|'deferred'|'n/a'|'unknown', area:string, doc?:string, why?:string}}
 */
export function classify(file) {
    // ⚠️ 机械层可能整目录搬（2026-10-17 搬进了 `app/`）⇒ 先把"机械层前缀"去掉再比：
    //    这里的区域名（`src/core`、`acm-data`…）都是**机械层相对**说的，
    //    而 `git show --name-only` 给的是**仓库相对**（`app/src/core/…`）。
    //    另：仓库根那层的文件（`docs/`、`作者专用/`、`README.md`）**本来就不带前缀**，照旧。
    const rel = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
    // 机械层前缀 = **实算** 仓库根 → 机械层根 的相对路径（两个根唯一的定义在 `roots.mjs`；
    // 2026-10-17 之前这里靠 `basename(dirname(...))` 猜目录名 —— 改名/换层级就会静默指错）。
    const machine = path.relative(repoRoot(), APP_ROOT).replace(/\\/g, '/');
    const parts = ((machine && rel.startsWith(`${machine}/`))
        ? rel.slice(machine.length + 1) : rel).split('/').filter(Boolean);
    if (parts.length <= 1) return { kind: 'root', area: '' };
    if (parts.length === 2 && parts[0] === 'src') return { kind: 'srcRoot', area: 'src' };
    // `src/features/<模块目录>/<文件>` ⇒ 报到**模块**一级（比"区域"细一层：那里才写得下意图与不变量）
    // ⚠️ 长度必须 ≥ 4：`src/features/AGENTS.md` 是**这一层自己的文档**，不是模块目录里的文件
    if (parts[0] === 'src' && parts[1] === 'features' && parts.length >= 4) {
        const mod = moduleMap().get(parts[2]);
        if (mod) return { kind: 'module', area: `src/features/${parts[2]}`, module: mod, doc: MODULES_DOC };
        const why = deferredModules().get(parts[2]);
        if (why) return { kind: 'deferredModule', area: `src/features/${parts[2]}`, why, doc: MODULES_DOC };
        return { kind: 'unknownModule', area: `src/features/${parts[2]}`, doc: MODULES_DOC };
    }
    // 从最深往浅找（最多两级：`src/core` / `acm-data`）—— 子目录继承上层那份文档
    for (let n = Math.min(parts.length - 1, 2); n >= 1; n--) {
        const a = parts.slice(0, n).join('/');
        if (AREA_WITH_DOC.includes(a)) return { kind: 'doc', area: a, doc: `${a}/AGENTS.md` };
        if (AREA_DEFERRED[a]) return { kind: 'deferred', area: a, why: AREA_DEFERRED[a] };
        if (AREA_NOT_NEEDED[a]) return { kind: 'n/a', area: a, why: AREA_NOT_NEEDED[a] };
    }
    return { kind: 'unknown', area: parts.slice(0, Math.min(2, parts.length)).join('/') };
}

/** 从一串文件路径算出"这次动了哪些区域"（去重，保序） */
export function areasOf(files) {
    const seen = new Map();
    for (const f of files) {
        const c = classify(f);
        const key = `${c.kind}:${c.area}`;
        if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()];
}

/** 保存/提交时的提醒文本（**只打印，永不阻断**） */
export function reminder(files) {
    const out = ['', '──── 这次动了这些区域（就近文档更新了吗？）────'];
    for (const c of areasOf(files)) {
        if (c.kind === 'root') {
            out.push('  · 仓库根           → 入口 AGENTS.md / README 要不要跟着改？');
        } else if (c.kind === 'srcRoot') {
            out.push('  · src/ 顶层文件     → 常量/入口，文件头注释就是它们的规范');
        } else if (c.kind === 'module') {
            out.push(`  · ${c.area}  ← 属于「${c.module}」模块（${c.doc}）：`);
            out.push('      那一节的**意图 / 不变量 / 坑**要不要补？补了就顺手改 `updated：`；');
            out.push('      改了一边记得看另一边（同一模块里形状必须一致）。');
        } else if (c.kind === 'deferredModule') {
            out.push(`  · ${c.area}  ← 这个模块**还没建档**（${c.doc} 的「暂缓的模块」）：${c.why || '（没写理由）'}`);
            out.push('      真踩到坑了，就顺手给它补一节（意图 / 不变量 / 坑 / updated）。');
        } else if (c.kind === 'unknownModule') {
            out.push(`  · ${c.area}  ← **没人管**：在 ${c.doc} 里给它补一节（意图 / 不变量 / 坑 / updated），`);
            out.push('      或放进「暂缓的模块」写一句理由（守卫会红）');
        } else if (c.kind === 'doc') {
            out.push(`  · ${c.area}  ← 有就地文档（${c.doc}）：这次的**新坑**写进去了吗？`);
            out.push('      （写症状 → 病根 → 判据；现状与精确数字别写）');
        } else if (c.kind === 'deferred') {
            out.push(`  · ${c.area}  ← 已明确暂缓（${c.why}）`);
        } else if (c.kind === 'n/a') {
            out.push(`  · ${c.area}  ← 不要求就地规范（${c.why}）`);
        } else {
            out.push(`  · ${c.area}  ← **没有分类**：给它写一份就地 AGENTS.md（这层是什么 / 改这里的坑 / 先看什么），`);
            out.push('      或在 scripts/areas.mjs 的 AREA_DEFERRED 里写一句为什么先不写（守卫会红）');
        }
    }
    out.push('  （见根 AGENTS.md 的"收工四步"第 3 步）', '────────────────────────────────────────', '');
    return out.join('\n');
}

// ---- CLI（保存脚本用；不引任何依赖）----
// ⚠️ 只在"被当脚本跑"时才输出：被 `import`（守卫测试）时**不许**往测试输出里掺东西。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const mode = isMain ? (process.argv[2] || '--list') : '';
if (mode === '--list') {
    console.log('已有就地文档：', AREA_WITH_DOC.join('、'));
    console.log('明确暂缓：');
    for (const [k, v] of Object.entries(AREA_DEFERRED)) console.log(`  ${k} —— ${v}`);
} else if (mode === '--remind') {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => {
        const files = buf.split('\n').map((s) => s.trim()).filter(Boolean);
        if (files.length) process.stdout.write(reminder(files) + '\n');
    });
}
