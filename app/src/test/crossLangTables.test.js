// ================================================================
// 跨语言表对拍（`src/test/crossLangTables.test.js`）
//
// 病根：本仓有几张**跨语言手抄**的表，
// 每一张的注释都写着"必须同步"，但**没有一条测试真的把两边对起来读** ——
// 改 Python 那边一个字节都不红（`linkKinds` / `submitKind` / `sourceReportRanks` /
// `clueFields` 都已经有对拍了，这里补上剩下三张）：
//
//   ① 判题结果词表 `STATUS_OPTIONS`（JS `A_constants.js` ↔ Python `scripts/crate.py`）
//   ② "应有"谓词的键（JS `core/fieldRegistry.js` ↔ Python `scripts/field-coverage.py`）
//   ③ 依据级别（JS `core/natureConfidence.js` 的 `CLASS_RULE_LEVEL` ↔ 包里真实出现的
//      `分类依据`）—— ③ 是**数据驱动**的：界面上"依据强度徽标"要靠它；
//      出现一个**两张表都查不到**的规则 id ⇒ 那个字段条画不出徽标（静默降级成"无依据"）。
//      ⚠️ 必须问解算器 `levelOfClassRule()`（先查逐条表、再按**后缀**查
//      `NATURE_VALUE_RULE_LEVEL`）—— 只查第一张表会**假红**（`qoj:season-path` 这类
//      本来就是按后缀登记的）。
//   ④ 个人数据目录名 `PERSONAL_DIRNAME`（JS `scripts/roots.mjs` ↔ Python `devserver/roots.py`）
//      ＋ `clean-personal.mjs` 必须**找得到**凭据（2026-10-17：它只扫 acm-data 那棵树 ⇒
//      凭据搬走后报告"① 凭据 0 个"，清了个寂寞，见那条测试的来由）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { STATUS_OPTIONS } from '../A_constants.js';
import { CLASS_NONE, CLASS_PENDING, CLASS_UPSTREAM } from '../core/natureFields.js';
import { levelOfClassRule } from '../core/natureConfidence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

test('跨语言对拍：CF 的登录态探针（界面说"有" ⇒ 后端必须真有）', () => {
    // 来由（2026-10-17，用户："cf 怎么能因为贵就不探"）：后端 `auth_state.py` 当时把 CF 的 `probe`
    // 留空（"没有**便宜的**探针 ⇒ 靠抓取时第一发"），而界面照样给了那颗「🔎 探活」按钮
    // ⇒ 按下去只会打出"没有便宜的探针"。两边**必须一致**：界面说有，后端就得真有一个。
    const panel = read('src/ui/MeEditor/authPanel.js');
    const m = /id: 'cf'[\s\S]{0,600}?probe:\s*(true|false)/.exec(panel);
    assert.ok(m, "`authPanel.js` 里应该有 cf 那一条（`id: 'cf'` … `probe:`）");
    const py = read('acm-data/raw/Scaper/lib/auth_state.py');
    // 后端"要签名的探针"是函数，注册在 `SIGNED_PROBES` 里（表 `PLATFORMS` 保持纯数据）
    const backendHas = /SIGNED_PROBES[^\n]*\{[^}]*'cf'/.test(py);
    assert.equal(m[1] === 'true', backendHas,
        `界面说 CF 探针 = ${m[1]}，而后端 SIGNED_PROBES 里${backendHas ? '有' : '没有'} cf —— `
        + '两边必须一致（界面给按钮、后端不探 = 按下去只会打一句"没有探针"）');
});

test('跨语言对拍：杭电的比赛口令两条点分路径（界面填的 ↔ 抓取侧读的）', () => {
    // 来由（2026-10-17，用户看着「🔐 登录态」那块问"补哪"）：那块面板原来写着
    // "牛客/杭电/PTA/AtCoder 都没有登录态 —— 不用找它们的 cookie"，而 `02 hdu/hdu_multi_fetch.py`
    // 需要的是**另一件事**：赛内页的比赛口令（`POST /contest/login`）。
    // ⇒ 界面给两格输入框，抓取侧在 `Scaper/lib/me.py` 用**同名**点分路径读。
    // 这一条钉的是"两边名字一样"：**改一边不改另一边 ⇒ 界面填了也没人读**（静默失效，
    // 用户会以为口令不对）。
    const panel = read('src/ui/MeEditor/authPanel.js');
    const hdu = /id: 'hdu'[\s\S]{0,900}?fields:\s*\[([\s\S]*?)\]/.exec(panel);
    assert.ok(hdu, "`authPanel.js` 里应该有杭电那一条（`id: 'hdu'` … 两格 `fields`）");
    const paths = Array.from(hdu[1].matchAll(/path:\s*'([^']+)'/g)).map(m => m[1]);
    assert.deepEqual(paths, ['hdu.contestUser', 'hdu.contestPassword'],
        '界面填的必须是这两条点分路径（抓取侧按同名读）');
    const py = read('acm-data/raw/Scaper/lib/me.py');
    for (const p of paths) {
        assert.ok(py.includes(`get('${p}')`),
            `Scaper/lib/me.py 里必须用 ${p} 读它（否则界面填了也没人读）`);
    }
});

test('跨语言对拍：判题结果词表 `STATUS_OPTIONS`（JS ↔ crate.py）', () => {
    const m = /^STATUS_OPTIONS\s*=\s*\(([^)]*)\)/m.exec(read('scripts/crate.py'));
    assert.ok(m, 'crate.py 里应该有一行 `STATUS_OPTIONS = (...)`');
    const py = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual(STATUS_OPTIONS, py,
        '两边的判题结果词表必须逐字相同（JS 在 A_constants.js，Python 在 crate.py）');
});

test('跨语言对拍：分类树的特殊叶子（natureFields.js ↔ nature_registry_lib.py）', () => {
    const m = /^CLASS_SPECIAL\s*=\s*\(([^)]*)\)/m.exec(read('scripts/nature_registry_lib.py'));
    assert.ok(m, 'nature_registry_lib.py 里应该有一行 `CLASS_SPECIAL = (...)`');
    const py = m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    assert.deepEqual([CLASS_NONE, CLASS_PENDING, CLASS_UPSTREAM], py,
        '三片特殊叶子两边必须逐字相同：JS 拿它们跟**节点值**比（少一片就有值判不出来），'
        + 'Python 那份还要用它做**写盘校验**（少一片就拒绝保存）');
});

/** JS 侧谓词键：`when.notStatus` / `when['notStatus']` / `when?.notStatus` 都算 */
function jsPredicateKeys(text) {
    const out = new Set();
    for (const m of text.matchAll(/when\s*\??\.\s*([A-Za-z]+)/g)) out.add(m[1]);
    for (const m of text.matchAll(/when\s*\??\.?\s*\[\s*['"]([A-Za-z]+)['"]\s*\]/g)) out.add(m[1]);
    return out;
}

/**
 * Python 侧谓词键：`when.get('X')` / `when["X"]` / `when['X']` 都要认。
 *
 * ⚠️ 只写死 `when\.get\('([A-Za-z]+)'\)`（只用单引号 + 只用 `.get`）不够 ——
 * `when["notStatus"]` 这种等价写法会让抓取侧"少一个键"，而**恰好**在两边都少 ⇒
 * 对拍照样绿。下面配自检。
 */
function pyPredicateKeys(text) {
    const out = new Set();
    for (const m of text.matchAll(/when\s*\.\s*get\(\s*['"]([A-Za-z]+)['"]/g)) out.add(m[1]);
    for (const m of text.matchAll(/when\s*\[\s*['"]([A-Za-z]+)['"]\s*\]/g)) out.add(m[1]);
    return out;
}

test('跨语言对拍："应有"谓词的键（fieldRegistry.js ↔ field-coverage.py）', () => {
    const jsKeys = jsPredicateKeys(read('src/core/fieldRegistry.js'));
    const pyKeys = pyPredicateKeys(read('scripts/field-coverage.py'));
    assert.ok(jsKeys.size > 0 && pyKeys.size > 0, '两边都该读得出谓词键');
    assert.deepEqual([...jsKeys].sort(), [...pyKeys].sort(),
        '谓词键集合必须一样（加一个键只在一边 ⇒ 那一边的豁免静默不生效）');
    // ⚠️ 这条对拍只管"键集合漂没漂"；**键是不是真的还在生效**（比如被写成
    //    `if False and not_status:`）由 `field-coverage.py --selftest` 的**行为断言**兜
    //    （第 848 行起：CE/TLE 不进统计、WA 照旧算缺）⇒ 那条自测现在由
    //    `pythonSelftests.test.js` 保证 `npm test` 会跑。
});

test('★ 上面取键的两条自己会咬（换个等价写法也得认出来）', () => {
    assert.deepEqual([...pyPredicateKeys("when.get('notStatus')")], ['notStatus']);
    assert.deepEqual([...pyPredicateKeys('when.get("notStatus")')], ['notStatus'], '双引号');
    assert.deepEqual([...pyPredicateKeys('when["notStatus"]')], ['notStatus'], '下标写法');
    assert.deepEqual([...pyPredicateKeys("when['notStatus']")], ['notStatus'], '下标 + 单引号');
    assert.deepEqual([...jsPredicateKeys('when.notStatus')], ['notStatus']);
    assert.deepEqual([...jsPredicateKeys("when['notStatus']")], ['notStatus'], 'JS 下标写法');
    assert.deepEqual([...jsPredicateKeys('when?.notStatus')], ['notStatus'], '可选链');
    assert.deepEqual([...pyPredicateKeys('# when.get(\'notStatus\') 以前是这样')], ['notStatus'],
        '（取键不剥注释：注释里出现同名字符串不会改变集合，无需在这层处理）');
});

test('★ 数据驱动：包里用到的每个 `分类依据` 都要有级别（否则界面画不出"依据强度"）', () => {
    const pkg = path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');
    if (!fs.existsSync(pkg)) {
        assert.ok(true, '（还没有包，跳过）');
        return;
    }
    const doc = JSON.parse(fs.readFileSync(pkg, 'utf8'));
    const unknown = new Map();
    const kinds = new Map();
    for (const rec of doc.records || []) {
        for (const v of Object.values(rec['分类依据'] || {})) {
            const id = String(v);
            const kind = id.split(':')[0];
            kinds.set(kind, (kinds.get(kind) || 0) + 1);
            // ⚠️ 问解算器（两张表都查），别只查 `CLASS_RULE_LEVEL`
            if (!levelOfClassRule(id)) unknown.set(id, (unknown.get(id) || 0) + 1);
        }
    }
    assert.ok(kinds.size > 0, '包里应该有 `分类依据`');
    assert.deepEqual([...unknown.keys()].sort(),
        [], `这些规则 id **两张表都查不到**（界面会静默显示"无依据"）：\n`
        + [...unknown.keys()].sort().join('\n'));
});

// ================================================================
// 凭据（`个人数据/`）这一层：**位置**也必须只有一份口径
// ================================================================

test('跨语言对拍：个人数据目录名 `PERSONAL_DIRNAME`（JS roots.mjs ↔ Python roots.py）', () => {
    // 为什么要有这条：目录名两边各写了一遍（JS 给测试/工具用、Python 给服务器用），
    // 改了一边不红 ⇒ 服务器把凭据写进 `个人数据/`、而工具去别的目录找 ⇒ 又一次静默失效。
    const js = /PERSONAL_DIRNAME\s*=\s*'([^']+)'/.exec(read('scripts/roots.mjs'));
    const py = /PERSONAL_DIRNAME\s*=\s*'([^']+)'/.exec(read('scripts/devserver/roots.py'));
    assert.ok(js, '`scripts/roots.mjs` 里应该有 `PERSONAL_DIRNAME`');
    assert.ok(py, '`scripts/devserver/roots.py` 里应该有 `PERSONAL_DIRNAME`');
    assert.equal(js[1], py[1], `JS 写的是「${js[1]}」、Python 写的是「${py[1]}」—— 必须同值`);
});

test('★ 清个人数据必须**找得到凭据**（"只走一棵树"与"导出包带 me 却不认"两次静默失效）', () => {
    // 来由（2026-10-17 实测）：
    //   ① 凭据从 `acm-data/…/me.json` 搬成了**仓库根**的 `个人数据/me.json`，而 `clean-personal.mjs`
    //      只 `walk(acm-data)` ⇒ 报告照旧打「① 凭据 0 个」，于是"发出仓库之前清一次"会**把真凭据原样带走**；
    //   ② 「完整数据导出」自 2026-10-17 起**带 `me` 块**（用户："me.json 应该进（主脚本）导出包"）
    //      ⇒ 一份 `AcmTree_Full_*.json[.gz]` 落在仓库里就是**凭据复制品**，而按老名字判据它谁也不像。
    // 守卫钉四条：位置只来自 `roots.mjs`、真的去扫那两处、导出包的规则**认得那两张名字且不误伤普通包**。
    const src = read('scripts/clean-personal.mjs');
    assert.match(src, /import\s*\{[^}]*personalDir[^}]*\}\s*from\s*'\.\/roots\.mjs'/,
        '`clean-personal.mjs` 必须从 `./roots.mjs` 拿凭据目录（那是"两个根 + 个人数据目录"的唯一一份定义）');
    assert.match(src, /personalDir\s*\(/, '必须真的调用 `personalDir()`');
    assert.match(src, /walk\(PERSONAL\)/, '必须真的扫 `个人数据/` 那棵树（只扫 acm-data ⇒ 看不见凭据）');
    assert.match(src, /topLevelFiles\(ROOT\)/, '还要扫**仓库根一层**（导出包常被随手扔在那儿）');
    const m = /ME_EXPORT_RE\s*=\s*\/(.+?)\/([a-z]*);/.exec(src);
    assert.ok(m, '`ME_EXPORT_RE` 应当在（导出包 = 凭据复制品 ⇒ 第 1 级就删）');
    const re = new RegExp(m[1], m[2]);
    assert.ok(re.test('AcmTree_Full_20261017_021530.json'), '要认 `.json` 导出包');
    assert.ok(re.test('AcmTree_Full_20261017_021530.json.gz'), '要认 `.json.gz` 导出包');
    assert.ok(!re.test('all_nodes.json'), '别把普通的树包也当成凭据');
    assert.ok(!re.test('nodes/all_nodes.json'), '别按路径误伤');
    // ④ 浏览器登录态（`_chrome-profile/`，里面有 `Default/Network/Cookies`）**整个目录**属于第 1 级 ——
    //    它在 `.gitignore` 里被忽略，但**盘上还在** ⇒ "发副本之前清一次"必须清掉它。
    assert.match(src, /_chrome-profile/, '`clean-personal.mjs` 必须管 `_chrome-profile/`（活的登录 cookie）');
    assert.match(src, /rmSync\(CHROME/, '那个目录要**整目录**删（逐个 unlink 只会剩一堆空壳）');
    assert.match(src, /CHROME = path\.join\(personalDir\(\)/,
        '它的位置也要从 `personalDir()` 拿（2026-10-17 起它住 `个人数据/` 里，仓库根不再放它）');
});
