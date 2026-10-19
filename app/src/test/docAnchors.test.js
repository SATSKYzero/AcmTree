// ================================================================
// 锚点守卫（两类"说出来的话"）：**文档点了名就得在 / 规则只许一处实现**
//
// 病根（2026-10-12 实测，四处都是同一类）：
//   · 给新对话的交接文档把 `changedNodeIdsOf` / `noteValueDelta` 当成**现状**在描述，
//     而代码里**根本不存在**（那把名字是我照着一份"打算这么写"的稿子干的）；
//   · 它点名了 `ancestorIds`（真名是 `getAncestorsRootFirst`）、`childrenOfNode`
//     （真名是 `getChildIds`/`getChildren`）；
//   · 它还引用了一份 `同一份规则-唯一实现.md` —— **那个文件不存在**；
//     而"某条规则只有一处实现"这件事，全仓当时只有 1 处测试提过。
//   ⇒ 没人能发现这些话已经假了，下一个会话照着它干活就走偏。
//
// 所以这里钉两类**会静默变假**的话（只这两类，别加第三类）：
//   ① 文档点名的符号/路径**真的存在**（`AGENTS.md` 与深读材料那份总览）；
//   ② 列举的那些"唯一实现"规则**真的只有一处定义**（多一处就是平行名单/第二份口径）。
//
// ⚠️ **它故意很小**：别把它扩成"对所有文档做 lint"。给文档配测试会变成双份维护，
//    本项目踩过"测试叠测试"的坑。
// ⚠️ **红了怎么修**：不是改这条守卫，而是**改文档 / 删掉多出来的那一处实现**，
//    或者（若口径确实变了）把那份名单更新并说明理由。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 区域分类（**唯一一份**，见该文件头）：`保存快照.bat` 每次保存打印用的也是它
import { AREA_WITH_DOC, AREA_DEFERRED } from '../../scripts/areas.mjs';
import { repoRoot } from '../../scripts/roots.mjs';

// ⚠️ 两个根别混：`REPO` 是**机械层根**（`src/`、`scripts/` 在这层，`..`、`..` 就是它），
//    `ROOT` 是**仓库根**（`AGENTS.md`、`作者专用/` 在这层）。机械层整目录搬过（2026-10-17 进 `app/`），
//    所以仓库根**只能**向上找 `package.json`，不许手推级数。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = repoRoot(REPO);

// ⚠️ 这份测试的锚点**大头在 `作者专用/docs/` 与各层 `AGENTS.md`**（`项目总览-给新对话.md`、`变更记录.md`、
//    `src/core/AGENTS.md`…）。而 `作者专用/` 是**作者的**、`AGENTS.md` 是**给 AI/贡献者看的操作规范**
//    —— 用户 2026-10-19 定"release 包里不应有 AGENTS.md" ⇒ 公开发布副本里这两样都没有，
//    这份测试**没法跑**（它验的是"我们自己的文档链接"，不是收件人那份东西）⇒ 整份 skip、打印原因。
//    判据不变：作者的工作区里（有 `作者专用/` 与 `AGENTS.md`）它照旧全量跑。
if (!fs.existsSync(path.join(ROOT, '作者专用')) || !fs.existsSync(path.join(ROOT, 'AGENTS.md'))) {
    console.log('   ⏭ 跳过整份测试：没有 `作者专用/` 或 `AGENTS.md`'
        + '（公开发布副本按设计不带作者物与 AI 规范，锚点文档也一起没了）');
    process.exit(0);
}

/** 会被核的两份文档：`AGENTS.md`（每次会话自动注入）与深读材料那份总览 */
const DOCS = ['AGENTS.md', '作者专用/docs/项目总览-给新对话.md'];

/** "这些已经都有了"那一句的锚点 —— 两份文档用的是同一句话，靠它定位名单 */
const TOOLS_ANCHOR = '要用到的都已经有了';

const read = (rel) => {
    // 文档点名的路径**两种写法都认**：仓库相对（`AGENTS.md`、`作者专用/…`）与机械层相对（`src/core/AGENTS.md`）
    const parts = rel.split('/');
    const p = [path.join(ROOT, ...parts), path.join(REPO, ...parts)].find((x) => fs.existsSync(x));
    assert.ok(p, `${rel} 不存在（改过路径就要同步这条守卫）`);
    return fs.readFileSync(p, 'utf8');
};

/** 从锚点那句往后取一条 bullet 的整段（含缩进续行） */
function anchorBullet(doc, anchor) {
    const lines = doc.split('\n');
    const start = lines.findIndex((l) => l.includes(anchor));
    assert.ok(start >= 0, `文档里找不到锚点「${anchor}」—— 守卫别空转`);
    const out = [lines[start]];
    for (let i = start + 1; i < lines.length; i++) {
        if (!/^\s{2,}\S/.test(lines[i])) break;      // 续行都是缩进的；遇到下一条 bullet 就停
        out.push(lines[i]);
    }
    return out.join('\n');
}

/** 从一段文字里取出反引号里的标识符（按 `/`、`、` 拆开，只留像 JS 名字的） */
function namedSymbols(seg) {
    return [...seg.matchAll(/`([^`]+)`/g)]
        .flatMap((m) => m[1].split(/[/、]/))
        .map((s) => s.trim())
        .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

/** src/ 下的源码（排除 `vendor/`：那是第三方，不算"本仓库已有的那一份"） */
function srcSources() {
    const out = [];
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
            if (/\.(js|mjs)$/.test(e.name)) out.push([p, fs.readFileSync(p, 'utf8')]);
        }
    };
    walk(path.join(REPO, 'src'));
    return out;
}

/** 这个名字在 src/ 里的定义处（`function` / `const` / `let` / `class`，带不带 export 都算） */
function definitionSites(sources, name) {
    const re = new RegExp(`^\\s*(export\\s+)?(async\\s+)?(function|const|let|class)\\s+${name}\\b`, 'm');
    return sources.filter(([, s]) => re.test(s)).map(([p]) => path.relative(REPO, p).replace(/\\/g, '/'));
}

/** 仓库里所有文件名（跳过 .git 与缓存/归档目录）—— 裸文件名也照样核 */
function repoBasenames() {
    const names = new Set();
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (['.git', 'cache', 'pages', '__pycache__', 'node_modules'].includes(e.name)) continue;
                walk(path.join(dir, e.name));
                continue;
            }
            names.add(e.name);
        }
    };
    // ⚠️ 从**仓库根**走：文档里常写裸文件名（`变更记录.md`、`待办.md`），它们住在 `作者专用/docs/`
    //    ⇒ 只走机械层（`REPO` = `app/`）会漏掉它们（2026-10-17 搬进 `app/` 之后就是这个症状）。
    walk(ROOT);
    return names;
}

/**
 * 文档里那个名字解析得到吗？**三路**都试（文档里既写过 `src/...`，也写过相对 `src/` 的 `view/scope.js`）：
 *   ① 相对仓库根 ② 相对 `src/` ③ 叫这个名字的文件**仓库里存在**（裸名字）
 * 三路都不中就说明它哪儿都不在 —— 那正是坑过我的那种"文档点名、东西不在"。
 */
function resolves(tok, basenames) {
    const rel = tok.replace(/\/$/, '');
    if (fs.existsSync(path.join(ROOT, ...rel.split('/')))) return true;      // 仓库相对（docs/、作者专用/）
    if (fs.existsSync(path.join(REPO, ...rel.split('/')))) return true;      // 机械层相对（scripts/、acm-data/）
    if (fs.existsSync(path.join(REPO, 'src', ...rel.split('/')))) return true;
    return basenames.has(rel.split('/').pop());
}

test('两份文档"已经都有了"那句点名的工具函数，src/ 里必须真的找得到定义', () => {
    const sources = srcSources();
    const missing = [];
    for (const rel of DOCS) {
        const names = namedSymbols(anchorBullet(read(rel), TOOLS_ANCHOR));
        assert.ok(names.length >= 8,
            `${rel} 那句里只认出 ${names.length} 个名字 —— 写法变了就要同步这条守卫（别让它空转）`);
        for (const n of names) if (!definitionSites(sources, n).length) missing.push(`${rel}: ${n}`);
    }
    assert.deepEqual(missing, [],
        '文档点名了、src/ 里却没有定义（`ancestorIds` / `childrenOfNode` 就是这么漂的）—— 改文档，别改守卫');
});

test('两份文档里出现的文件/目录名，必须真的存在', () => {
    const missing = [];
    const names = repoBasenames();
    for (const rel of DOCS) {
        const toks = [...read(rel).matchAll(/`([^`]+)`/g)]
            .map((m) => m[1].trim())
            // 只认两种形状：**带扩展名的文件名**（允许中文名 —— 坑过我的 `同一份规则-唯一实现.md` 就是这种）
            // 与 **ASCII 形状的目录**。别放宽：文档里反引号一错配，就会抽出 `（根）/` 这种中文片段来。
            .filter((t) => /^[^\s*`]+\.(md|js|mjs|py|bat|json|html|css|txt)$/.test(t)
                || /^[A-Za-z0-9_.\-/]+\/$/.test(t))
            // 裸扩展名（`.js` 这种"指某一类文件"的写法）不是路径承诺；`.gitignore` 这种点文件要照核
            .filter((t) => !/^\.(js|mjs|py|md|json|html|css|txt|bat)$/.test(t));
        for (const t of toks) if (!resolves(t, names)) missing.push(`${rel}: ${t}`);
    }
    assert.deepEqual(missing, [], '文档点名了不存在的文件/目录 —— 改文档');
});

// ================================================================
// ② 「唯一实现」：这些规则**全仓只许一处定义**
//
// 名单是**实测**出来的（每个都恰好 1 处，2026-10-12 核过）—— 它们都是
// "同一份规则只许一处实现"那种：身份键、显示列、去重代表、字段组口径、两种投影读口、
// 子节点来源、聚合规则与物化名单、P/C 单位、组值读口…
//
// ⚠️ 故意**不含** `norm` 这类：全仓有 5 处**同名但各自私有**的局部 helper（不是同一份规则），
//    钉它只会天天误报。加名字之前先量一遍定义处，别凭印象。
// ⚠️ 红了：多半是有人加了"第二份平行实现" —— 改回去，而不是加进这张名单。
// ================================================================
const SINGLE_SOURCE = [
    'identityKeyOf', 'pickInGroup',
    'viewDerivedDisplay', 'displayColumnOf', 'displayDerivedReader', 'groupTableFor', 'viewValue',
    'readField', 'derivedOf',
    'dedupRepresentatives', 'collectByType', 'getChildIds', 'changedNodeIdsOf',
    'groupValueOf', 'groupValueOnDemand', 'groupAggregateOf', 'hasGroupAgg', 'mergeField',
    'AGG_BUILDERS', 'GROUP_FIELDS',
    'problemUnitsOf', 'contestUnitsOf',
    'synthKeyOf', 'isSynthesis', 'hasText',
    // `v9.1.36`：数字显示（最多一位小数）—— 曾在 `ui/plan/` 下抄了四份（计划栏 / 计划页 / 各块 / 两张图）
    'fmtAmount',
    // `v9.1.43`：通过率显示（最多三位小数）—— 一位小数会把 0.11 与 0.03125 显示成同一串
    'fmtPercent'
];

test('「唯一实现」：名单里的规则全仓只许一处定义（多一处就是平行名单）', () => {
    const sources = srcSources();
    const bad = [];
    for (const n of SINGLE_SOURCE) {
        const sites = definitionSites(sources, n);
        if (sites.length !== 1) bad.push(`${n} → ${sites.length} 处${sites.length ? '：' + sites.join('、') : ''}`);
    }
    assert.deepEqual(bad, [],
        '这些规则只许一处实现（身份键 / 显示列 / 聚合规则…）—— 出现两处就是"两套口径会分叉"，改回去');
});

test('「唯一实现」：数字显示那条式子也只许一处（`Math.round(Number(v) * 10) / 10`）', () => {
    // 为什么连**式子**也要管：光看名字 (`fmtAmount`) 抓不住"换了个名字又抄一遍"的平行实现 ——
    // 实测（2026-10-13）`ui/plan/` 下四个文件各写了一份一模一样的 `const fmt = (n) => …`，
    // 名字各自私有、谁都看不出来。判据就是这条式子在 `src/` 下**只许出现一次**（`utils/num.js`）。
    const hits = srcSources()
        // ⚠️ 排掉 `src/test/`：**本守卫自己的正则**就长这样，不排会自己命中自己（假红）
        .filter(([p]) => !/^src[\\/]test[\\/]/.test(path.relative(REPO, p)))
        .filter(([, s]) => /Math\.round\(Number\([^)]*\)\s*\*\s*10\)\s*\/\s*10/.test(s))
        .map(([p]) => path.relative(REPO, p).replace(/\\/g, '/'));
    assert.deepEqual(hits, ['src/utils/num.js'],
        '数字显示（最多一位小数）只许有一处实现：`src/utils/num.js:fmtAmount` —— 别在调用点再抄一遍式子');
});

test('「唯一实现」：通过率显示那条式子也只许一处（`Math.round(Number(v) * 1000) / 1000`）', () => {
    const hits = srcSources()
        .filter(([p]) => !/^src[\\/]test[\\/]/.test(path.relative(REPO, p)))
        .filter(([, s]) => /Math\.round\(Number\([^)]*\)\s*\*\s*1000\)\s*\/\s*1000/.test(s))
        .map(([p]) => path.relative(REPO, p).replace(/\\/g, '/'));
    assert.deepEqual(hits, ['src/utils/num.js'],
        '通过率显示（最多三位小数）只许有一处实现：`src/utils/num.js:fmtPercent`');
});

// ================================================================
// ③ 「区域清单」：**新出现的区域必须被分类**（建档 / 明确暂缓）
//
// 为什么要有这一条：给每个区域写一份"就地规范"（这层是什么 / 改这里的坑 / 先看什么）是**长期不断的工作**，
// 靠记性一定会漏。所以把"漏"变成**会红**：`src/` 下每多一个目录，就必须在两张名单里选一边。
//
// ⚠️ 分类的**唯一一份**在 `scripts/areas.mjs`（`保存快照.bat` 每次保存打印的也是它）——
//    本文件只是它的一位消费者，**别在这里另立名单**。
// ⚠️ 这是**覆盖检查，不是质量检查**；也别为了消红去建空文档 —— 那正是"看起来规范"的堆料。
//    **暂缓也是一等公民**（写清理由即可），而且它**只在新目录出现时**才会红。
// ================================================================
test('「区域清单」：src/ 下的每个区域都必须"建档"或"明确暂缓"', () => {
    const dirs = fs.readdirSync(path.join(REPO, 'src'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== 'vendor')     // vendor = 第三方，不算"我们的区域"
        .map((e) => `src/${e.name}`);
    dirs.push('scripts', 'acm-data');
    const unclassified = dirs
        .filter((d) => !AREA_WITH_DOC.includes(d) && !AREA_DEFERRED[d]);
    assert.deepEqual(unclassified, [],
        '新区域没人管：给它写一份就地 AGENTS.md（这层是什么 / 改这里的坑 / 先看什么），'
        + '或在 scripts/areas.mjs 的 AREA_DEFERRED 里加一行"为什么先不写" —— 别靠记性');
    // 声明"有文档"的，那份文件必须真的在
    const declaredButMissing = AREA_WITH_DOC
        .filter((d) => !fs.existsSync(path.join(REPO, ...`${d}/AGENTS.md`.split('/'))));
    assert.deepEqual(declaredButMissing, [], '名单里写着"有就地文档"，但那份文件不在 —— 改名单或补文件');
});

// ================================================================
// ④ 「模块清单」：**`src/features/` 下一整块功能**也要被管住（比"区域"细一层）
//
// 为什么：一个"src/features 暂缓"盖得住 30 个文件、6 个模块 —— 实测它的暂缓理由
// （"各自读 core/ui 那两份"）**对"检索"是错的**（检索的关键口径不在那两份里），而没有任何机制发现。
// 所以模块那一层改成：**一节一个模块，四槽写全**（意图 / 不变量 / 坑 / updated）+ 覆盖目录。
//
// ⚠️ 这一层只查**结构与覆盖**（四槽非空、目录不漏不重）—— "写得好不好"机器判不了，靠人。
// ⚠️ 名单与解析的唯一一份在 `src/features/AGENTS.md`（`scripts/areas.mjs` 读的是同一份）。
// ================================================================
function parseModuleDoc(doc) {
    const sections = [];
    const deferred = [];
    let cur = null;
    let inDeferred = false;
    for (const line of doc.split('\n')) {
        if (/^##\s*暂缓的模块/.test(line)) { inDeferred = true; cur = null; continue; }
        const h = /^##\s*模块：\s*(.+?)\s*$/.exec(line);
        if (h) { cur = { name: h[1], cover: [], slots: {} }; sections.push(cur); inDeferred = false; continue; }
        if (/^##\s/.test(line)) { cur = null; inDeferred = false; continue; }
        if (inDeferred) {
            const d = /^-\s*\*\*(.+?)\*\*/.exec(line);
            if (d) deferred.push(d[1].trim());
            continue;
        }
        if (!cur) continue;
        const cov = /^覆盖：\s*(.+)$/.exec(line);
        if (cov) { cur.cover = cov[1].split(/[、,，]/).map((s) => s.trim()).filter(Boolean); continue; }
        const slot = /^(意图|不变量|坑|updated)：\s*(.*)$/.exec(line);
        if (slot) { cur.slots[slot[1]] = [slot[2]]; cur._last = slot[1]; continue; }
        if (cur._last) cur.slots[cur._last].push(line);
    }
    for (const s of sections) {
        for (const k of Object.keys(s.slots)) s.slots[k] = s.slots[k].join('\n').trim();
    }
    return { sections, deferred };
}

test('「模块清单」：src/features 下每个模块都要被覆盖，且四槽写全', () => {
    const { sections, deferred } = parseModuleDoc(read('src/features/AGENTS.md'));
    assert.ok(sections.length >= 1, '一个模块节都没有 —— 守卫别空转');
    const covered = new Map();
    const dup = [];
    for (const s of sections) {
        for (const d of s.cover) {
            if (covered.has(d)) dup.push(d);
            covered.set(d, s.name);
        }
    }
    const dirs = fs.readdirSync(path.join(REPO, 'src', 'features'), { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name);
    const unmanaged = dirs.filter((d) => !covered.has(d) && !deferred.includes(d));
    assert.deepEqual(unmanaged, [],
        '这些模块目录没人管：在 src/features/AGENTS.md 里给它一节（意图 / 不变量 / 坑 / updated），'
        + '或放进「暂缓的模块」写一句理由 —— 别让"一整块功能"只被一句笼统的暂缓盖住');
    const incomplete = [];
    for (const s of sections) {
        if (!s.cover.length) incomplete.push(`${s.name} 没写「覆盖：」`);
        for (const k of ['意图', '不变量', '坑', 'updated']) if (!s.slots[k]) incomplete.push(`${s.name} 缺「${k}」`);
    }
    assert.deepEqual(incomplete, [], '模块节必须**四槽写全**（意图 / 不变量 / 坑 / updated）+ 覆盖目录');
    assert.deepEqual(dup, [], '同一个目录被两节覆盖 —— 两份口径会分叉');
});

// ================================================================
// ⑤ 「跨层机制清单」：`src/core/AGENTS.md` 的机制清单**只能指到真有的小节**
//
// 为什么：跨层机制（字段 / 值 / 事务 / 缓存 / 显示列）**没有目录可挂** ⇒ 自动加载管不到它们
// （自动注入只认目录里的 `AGENTS.md`）。所以它们在 `src/core/AGENTS.md` 里有一张**清单 + 占位**：
//   · 已写的 → `- **字段** → 见下面「字段」一节`（守卫核那一节真的在）；
//   · 没写的 → `- **事务** →（还没写 —— 谁动到就顺手补）`（**允许**：占位就是提醒你还欠着）。
// 这条守卫防的正是"清单指向一个不存在的小节"——那种"看起来记了、其实空的"。
//
// ⚠️ 它**不**强制你把还没写的补上（那会变成天天红的欠债表）；它只保证**清单不说谎**。
// ================================================================

/**
 * 取 `## <name>` 那一节：**到下一个 `## ` 或字符串末尾**为止。
 *
 * ⚠️ 收尾**别写 `\Z`**：**JS 里没有 `\Z`** —— 它被当成**字面字母 Z**。踩过两次（`v9.1.50` 实测）：
 *   ① 「跨层机制」成了文件**最后一节** ⇒ 永远取不到 ⇒ 守卫误报"必须有「跨层机制」一节"；
 *   ② 那一节正文里**出现一个字母 Z**（连"解释这个坑"的话里都会带上）⇒ 取到的那段在 `Z` 处**被截断**。
 * 正确写法是 `$(?![\s\S])`（`m` 下的 `$` 会匹配每个行尾，所以还要断言"后面真的没东西了"）。
 */
function sectionText(doc, name) {
    const m = new RegExp(`^##\\s*${name}[\\s\\S]*?(?=^##\\s|$(?![\\s\\S]))`, 'm').exec(doc);
    return m ? m[0] : null;
}

test('★ 「取 ## 小节」那个正则：**最后一节**与"正文里有字母 Z"都要取得到（`v9.1.50` 的两个真坑）', () => {
    // 这条守着**守卫自己**：改回 `\Z` 收尾 ⇒ 下面两条当场红
    const lastSection = '## A\n\n- x\n\n## 跨层机制\n\n- **字段** → 见「字段」一节\n';
    const withLetterZ = '## 跨层机制\n\n- 正文里提到字母 Z 也会踩坑\n\n- **字段** → 见「字段」一节\n\n## B\n\n- y\n';
    const itemsOf = (t) => [...(t || '').matchAll(/^-\s*\*\*(.+?)\*\*\s*→\s*(.+)$/gm)].length;
    assert.equal(itemsOf(sectionText(lastSection, '跨层机制')), 1, '最后一节也要取到（别用 `\\Z` 收尾）');
    assert.equal(itemsOf(sectionText(withLetterZ, '跨层机制')), 1, '正文里有字母也不许截断');
    assert.equal(sectionText('## 别的\n\n- y\n', '跨层机制'), null, '没有那一节 ⇒ null（调用方据此报错）');
});

test('「跨层机制清单」：src/core/AGENTS.md 的机制清单只能指到真有的小节', () => {
    const doc = read('src/core/AGENTS.md');
    const sec = sectionText(doc, '跨层机制');
    assert.ok(sec, 'src/core/AGENTS.md 必须有「跨层机制」一节 —— 跨层机制没有目录可挂，全靠它');
    const items = [...sec.matchAll(/^-\s*\*\*(.+?)\*\*\s*→\s*(.+)$/gm)]
        .map((m) => ({ name: m[1].trim(), to: m[2].trim() }));
    assert.ok(items.length >= 3, `机制清单只剩 ${items.length} 条 —— 删空了就失去提醒作用`);
    const bad = [];
    for (const it of items) {
        if (/还没写|暂缓/.test(it.to)) continue;                  // 占位合法（那正是"欠着"的可见标记）
        const m = /「(.+?)」/.exec(it.to);
        if (!m) { bad.push(`${it.name}：指向写法看不懂（要「见下面「X」一节」或标「还没写」）`); continue; }
        // ⚠️ 允许**跨文件**指（长文搬去 `docs/**.md` 后，AGENTS 里只留一句话 + 指针）：
        //    `见 docs/field-rules.md 的「X」一节` ⇒ 核**那个文件里**有没有 `## X`
        const fileM = /`([^`]+\.md)`/.exec(it.to);
        const inFile = fileM ? fileM[1] : 'src/core/AGENTS.md';
        const target = inFile === 'src/core/AGENTS.md' ? doc : read(inFile);
        if (!target) { bad.push(`${it.name}：指向的文件 \`${inFile}\` 不存在`); continue; }
        if (!new RegExp(`^#{2,}\\s*${m[1]}\\s*$`, 'm').test(target)) {
            bad.push(`${it.name}：指向的小节「${m[1]}」在 \`${inFile}\` 里不存在`);
        }
    }
    assert.deepEqual(bad, [], '跨层机制清单指向了不存在的小节 —— 改清单或补那一节（别让它看起来记了、其实空的）');
});

// ================================================================
// ⑥ AGENTS.md 里的**文档互指**（2026-10-12 立）
//
// 为什么：各层 `AGENTS.md` 会被**自动注入**，长文塞进去 ⇒ 每次会话都背一遍、且只会越来越长。
// 规矩：**"动手前必须知道的"（一句话 + 判据 + 守卫名）留在 AGENTS.md，细节搬到旁文档、用链接指过去**。
//
// ⚠️ 链接**不会被自动读取**（注入的只有 AGENTS.md）⇒ 指针必须**可核**：否则"搬走了没人看"
//    与"根本没写"是同一件事。这条守卫抓两样：
//    · AGENTS.md 里点名的 `docs/**.md` / `作者专用/docs/**.md` —— **文件必须真在**；
//    · 写成"见 `某文件` 的「X」一节"的 —— **那个文件里必须有 `## X`**。
// ================================================================
test('★ AGENTS.md 的文档链接必须指到真有的文件与真有的小节', () => {
    const roots = ['AGENTS.md', 'src/core/AGENTS.md', 'src/ui/AGENTS.md', 'src/features/AGENTS.md',
        'scripts/AGENTS.md', 'acm-data/AGENTS.md'];
    const bad = [];
    let links = 0;
    for (const rel of roots) {
        const doc = read(rel);
        assert.ok(doc, `${rel} 应该存在（这份守卫的名单别写错）`);
        for (const m of doc.matchAll(/`((?:作者专用\/)?docs\/[^`]+\.md)`/g)) {
            links++;
            if (!read(m[1])) bad.push(`${rel}：指向的文档 \`${m[1]}\` 不存在`);
        }
        for (const m of doc.matchAll(/见\s*`([^`]+\.md)`\s*的「([^」]+)」一节/g)) {
            const target = read(m[1]);
            if (!target) { bad.push(`${rel}：指向的文档 \`${m[1]}\` 不存在`); continue; }
            if (!new RegExp(`^#{2,}\\s*${m[2]}\\s*$`, 'm').test(target)) {
                bad.push(`${rel}：\`${m[1]}\` 里没有「${m[2]}」那一节`);
            }
        }
    }
    assert.deepEqual(bad, [], bad.join('\n'));
});

