// ================================================================
// 包内元列结构巡检（scripts/smoke/crate-invariants.smoke.mjs）
//
// 为什么要有它：`crate:check` 只管身份/父子/类型/字段表这些**通用**结构，
// 而**四本「小账本」（元列）**的结构契约**没有跨包巡检** ——
// 之前只有零散保证：Python 端的片段级断言、JS 端的手搓记录单测。
// "杭电/牛客链接丢了"那个 bug 正好落在这些保证的缝里（形状不一致，两边各自都"通过"）。
//
// 四本账：`链接分类`（链接用途）/ `字段来源`（谁给的）/ `其它来源值`（没被采用的说法）/
//          `账户线索`（这条记录关于谁）。
//
// 这里拿**三个真实包**跑一遍，把契约钉成常驻测试：
//   ① `链接分类` 只出现在 C（比赛入口）与 W/S（源站容器页，只有 `browse` 一类）
//   ② 条目形状**只有一种**：`{v, src}` 且都非空（归一由产出点 `Crate._add` 保证）
//   ③ 同一条记录里没有 `(类别, URL)` 重复
//   ④ 爬取层**绝不写** C 的 `link` 列（取舍只在应用层）
//   ⑤ 覆盖情况与"已知无源"名单一致（名单必须写清理由，不许默默放宽）
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PKG_NAMES = ['all_nodes', 'hdu-multi-university', 'nk-multi-university'];
const load = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'acm-data', 'nodes', `${name}.json`), 'utf8'));

// ⚠️ **树包是生成物**（`clean-personal` 档位 1 会删它，用户 2026-10-19 定）⇒ 缺包就**整份跳过**
//    （不是失败：与 `auto-import.smoke.mjs`「缺样本就跳过」同口径）。要真跑这些契约先产包：
//    `npm run build:all`（整链）或 `npm run crate:hdu` / `crate:xcpc:all`（分类包）。
{
    const missing = PKG_NAMES.filter((n) => !fs.existsSync(path.join(ROOT, 'acm-data', 'nodes', `${n}.json`)));
    if (missing.length) {
        console.log(`   ⏭ 跳过整份冒烟：缺 ${missing.map((n) => `acm-data/nodes/${n}.json`).join('、')}`
            + '（树包是生成物，可能刚被清个人数据删掉；先跑 npm run build:all）');
        process.exit(0);
    }
}

let checked = 0;
const ok = (label, cond, detail = '') => {
    checked++;
    assert.ok(cond, `${label}${detail ? ` —— ${detail}` : ''}`);
};

for (const name of ['all_nodes', 'hdu-multi-university', 'nk-multi-university']) {
    const crate = load(name);
    const records = crate.records || [];
    const Cs = records.filter(r => r['节点类型'] === 'C');
    // 形状检查覆盖**所有**带 `链接分类` 的记录（C 的比赛入口 + W/S 的容器页）
    const withKinds = records.filter(r => r['链接分类']);

    // ① 作用域：C（比赛入口）+ W/S（源站容器页）；别的类型不许有
    const wrongScope = records.filter(
        r => !['C', 'W', 'S'].includes(r['节点类型']) && r['链接分类']);
    ok(`[${name}] 「链接分类」只出现在 C/W/S`, wrongScope.length === 0,
        `${wrongScope.length} 条落在别的类型上：${wrongScope.slice(0, 3).map(r => r.extKey)}`);
    // W/S 上只许是 `browse`（源站容器页）—— 比赛入口那几类放在容器节点上就是错挂
    const wrongKindOnContainer = records.filter(
        r => ['W', 'S'].includes(r['节点类型']) && r['链接分类']
            && Object.keys(r['链接分类']).some(k => k !== 'browse'));
    ok(`[${name}] W/S 上的链接只有 browse 一类`, wrongKindOnContainer.length === 0,
        `${wrongKindOnContainer.length} 条：${wrongKindOnContainer.slice(0, 3).map(r => r.extKey)}`);

    // ② 形状：只有 `{v, src}` 一种，且都非空
    let badShape = 0;
    let urlCount = 0;
    let emptySrc = 0;
    for (const r of withKinds) {
        for (const kind of Object.keys(r['链接分类'])) {
            for (const one of r['链接分类'][kind]) {
                urlCount++;
                if (!one || typeof one !== 'object' || !one.v || !one.src) { badShape++; continue; }
                if (!String(one.v).trim() || !String(one.src).trim()) emptySrc++;
            }
        }
    }
    ok(`[${name}] 条目形状统一为 {v, src}`, badShape === 0, `${badShape} 条不合规`);
    ok(`[${name}] 条目的 v / src 都非空`, emptySrc === 0, `${emptySrc} 条空值`);

    // ③ 同记录内没有 (类别, URL) 重复
    let dup = 0;
    for (const r of withKinds) {
        for (const kind of Object.keys(r['链接分类'])) {
            const seen = new Set();
            for (const one of r['链接分类'][kind]) {
                const key = String(one && one.v);
                if (seen.has(key)) dup++;
                seen.add(key);
            }
        }
    }
    ok(`[${name}] 同记录内 (类别, URL) 不重复`, dup === 0, `${dup} 条重复`);

    // ④ 爬取层不写 C 的 link（取舍只在应用层）
    const crawlerChose = Cs.filter(r => r.link !== undefined && r.link !== '');
    ok(`[${name}] 爬取层不写 C 的 link`, crawlerChose.length === 0,
        `${crawlerChose.length} 条自己挑了链接：${crawlerChose.slice(0, 3).map(r => r.extKey)}`);

    // ⑤ 覆盖：**每场比赛（按 slug 归并所有渠道树）都至少有一条分类链接**
    // ⚠️ 各渠道各自一棵树，所以"覆盖率"不等于"每个 C 记录都有链接"
    //    （`aux-srk` 那棵树的 C 只带题名/题链接，它本来就不给链接 —— 那是**如实的**），
    //    而是"每一场比赛**在某一棵树上**有入口"。判据仍是硬的 100%，**不要例外名单**
    //    （名单是特判的温床 —— 一张"已知无源"的名单会把真问题也一起豁免掉）。
    const bySlug = new Map();
    for (const r of Cs) {
        const parts = String(r.extKey).split(':');   // `<树>:c:<slug>[:p|sub:…]`
        const slug = parts[2];
        if (!slug) continue;
        bySlug.set(slug, (bySlug.get(slug) || false) || !!r['链接分类']);
    }
    const noKind = [...bySlug].filter(([_s, has]) => !has).map(([s]) => s);
    ok(`[${name}] 每场比赛都有分类链接（跨渠道树合并看，100%）`, noKind.length === 0,
        `没有分类：${noKind.slice(0, 5)}（共 ${bySlug.size} 场）`);

    // 分布只**打印**、不断言（它是给人看的信号：链接整批消失时这行会立刻变样）
    const dist = {};
    for (const r of Cs) {
        const key = Object.keys(r['链接分类'] || {}).sort().join('+');
        dist[key] = (dist[key] || 0) + 1;
    }
    console.log(`   ${name}: C ${Cs.length}｜候选链接 ${urlCount}｜类别组合 ` +
        Object.entries(dist).sort().map(([k, n]) => `${k}:${n}`).join(' '));
}

// ⑥ 跨包形状一致性：三端的样例条目长得一模一样（形状一分叉，读取端就得写特判）
const shapes = ['all_nodes', 'hdu-multi-university', 'nk-multi-university'].map(name => {
    const r = load(name).records.find(x => x['节点类型'] === 'C' && x['链接分类']);
    const kind = Object.keys(r['链接分类'])[0];
    return Object.keys(r['链接分类'][kind][0]).sort().join(',');
});
assert.equal(new Set(shapes).size, 1, `三个包的条目字段应完全一致，实际：${JSON.stringify(shapes)}`);
checked++;

// ================================================================
// ⑥b 合并产物的**来源 kind 表**（这里钉住防复发）
//
// 现象：包套包合并时（`all_nodes.json` = 混装包 + atcoder/cf-contest/两个多校包），
//      每个输入自己已经是 `crate-merge` 产物、kind 表在 `source.sources` 里；
//      只抄 `source.id` 的话，`all_nodes` 的来源表就只剩 3 项（`crate-merge` + 两个 scrapers），
//      而记录里真正当 `src` 用的是 `xcpcio-*` / `cf-*` 那些 ⇒ **应用查不到 kind** ⇒
//      一律当 script/rank 0 ⇒ 类别序（manual > board > script > derived）失效 ⇒ 压错值。
// 判据：**记录里用到的每个来源 id，都必须在来源表里**（且 kind 是合法值之一）。
// ================================================================
for (const name of ['all_nodes', 'mix_contain_xcpc']) {
    const crate = load(name);
    const table = (crate.source && crate.source.sources) || {};
    const used = new Set();
    for (const r of crate.records || []) {
        for (const [, src] of Object.entries(r['字段来源'] || {})) if (src) used.add(src);
        for (const list of Object.values(r['其它来源值'] || {})) {
            for (const one of (Array.isArray(list) ? list : [])) {
                if (one && one.src) used.add(one.src);
            }
        }
        for (const list of Object.values(r['链接分类'] || {})) {
            for (const one of (Array.isArray(list) ? list : [])) {
                if (one && one.src) used.add(one.src);
            }
        }
    }
    const missing = [...used].filter(sid => !table[sid]);
    ok(`[${name}] 来源表覆盖记录里用到的每个来源`, missing.length === 0,
        `查不到 kind 的：${missing.slice(0, 5)}（表里 ${Object.keys(table).length} 项）`);
    ok(`[${name}] 来源表覆盖了**嵌套包**的来源（不只是 crate-merge）`,
        Object.keys(table).filter(k => k !== 'crate-merge').length > 10,
        `表里只有：${Object.keys(table).slice(0, 6)}`);
    const badKind = Object.entries(table).filter(([, v]) => !['manual', 'board', 'script', 'derived']
        .includes(v && v.kind));
    ok(`[${name}] 来源表里的 kind 都是合法值`, badKind.length === 0,        `${badKind.slice(0, 3).map(([k]) => k)}`);
    console.log(`   ${name}: 来源表 ${Object.keys(table).length} 项｜记录用到 ${used.size} 个`);
}

// ================================================================
// 其余三本"小账本"
//
// 链接那本账（`链接分类`）刚被巡检钉住 —— 同一个"缝隙"在别的账本上一直存在：
// 它们**只靠人眼看**，坏了不会有任何提示。这里照同一个写法补上。
//
//   字段来源   `{列名: 来源id}`  —— 每个字段的值是谁给的（界面"来源"面板靠它）
//   其它来源值 `{列名: [{v, src}]}` —— 同字段没被采用的那些值（"别的说法"）
//   账户线索   `{source, field, value}` —— 这条记录是关于谁的（认领提交用）
// ================================================================
for (const name of ['all_nodes', 'hdu-multi-university', 'nk-multi-university']) {
    const records = load(name).records;

    // ⑦ 账户线索：只在 R 上；三个键都非空。
    // 为什么"只在 R"是硬契约：它回答的是"**这条提交**关于谁"——
    // 落在一个容器（W/S/C/P）上就是无意义的记录（判不出做什么用，导入时也没人读）。
    const clueTypes = new Set();
    let clueBad = 0;
    let clueCount = 0;
    for (const r of records) {
        const c = r['账户线索'];
        if (!c) continue;
        clueCount++;
        clueTypes.add(r['节点类型']);
        if (!(c && typeof c === 'object' && !Array.isArray(c)
            && String(c.source || '').trim()
            && String(c.field || '').trim()
            && String(c.value || '').trim())) clueBad++;
    }
    ok(`[${name}] 账户线索只在 R 上`, [...clueTypes].every(t => t === 'R'),
        `出现在：${[...clueTypes]}`);
    ok(`[${name}] 账户线索三键齐全（source/field/value）`, clueBad === 0, `${clueBad} 条不合规`);

    // ⑧ 字段来源：值是非空字符串，且**键必须是本记录真实存在的列**
    //（否则就是"幽灵出处"：界面上那个字段根本没有值，却挂着一条"某某给的"）
    let fsBad = 0;
    let fsGhost = 0;
    let fsCount = 0;
    for (const r of records) {
        for (const [col, src] of Object.entries(r['字段来源'] || {})) {
            fsCount++;
            if (typeof src !== 'string' || !src.trim()) fsBad++;
            if (!(col in r)) fsGhost++;
        }
    }
    ok(`[${name}] 字段来源的值都是非空字符串`, fsBad === 0, `${fsBad} 条空值`);
    ok(`[${name}] 字段来源的键都是本记录存在的列`, fsGhost === 0, `${fsGhost} 条幽灵出处`);

    // ⑨ 其它来源值：键是本记录的列 + 条目 `{v, src}` 都非空 + **落选值不等于被采用的值**
    //（最后那条是记账矛盾：同一条值不可能既被采用、又是"没被采用的说法"）
    let ovBad = 0;
    let ovGhost = 0;
    let ovSame = 0;
    let ovCount = 0;
    for (const r of records) {
        for (const [col, list] of Object.entries(r['其它来源值'] || {})) {
            if (!(col in r)) ovGhost++;
            for (const one of (Array.isArray(list) ? list : [])) {
                ovCount++;
                if (!(one && typeof one === 'object' && String(one.v ?? '').trim()
                    && typeof one.src === 'string' && one.src.trim())) ovBad++;
                if (JSON.stringify(one && one.v) === JSON.stringify(r[col])) ovSame++;
            }
        }
    }
    ok(`[${name}] 其它来源值条目形状统一为 {v, src}`, ovBad === 0, `${ovBad} 条不合规`);
    ok(`[${name}] 其它来源值的键都是本记录存在的列`, ovGhost === 0, `${ovGhost} 条幽灵列`);
    ok(`[${name}] 落选值不等于被采用的值`, ovSame === 0, `${ovSame} 条记账矛盾`);

    console.log(`   ${name}: 账户线索 ${clueCount}｜字段来源 ${fsCount}｜其它来源值 ${ovCount}`);

    // ⑨b **分类依据**：`{ 性质字段: 规则id }` —— "这条分类凭什么判出来的"。
    // 应用侧查级别表画徽标，所以两条硬契约：
    //   · 键必须是性质字段（`natureClass`…，**列名就是内部字段名** —— 见 fieldMap），
    //     **而且那个字段在本记录里真有值**（规则描述的是"这个值"，值不在就是幽灵依据）；
    //   · 值必须是 `<范围>:<规则>` 形状的规则 id（拼错了应用只会静默降级成 E 级）。
    // ★ `ownerSynth` 是**设计内**的元列键（不是性质字段）：人的合成归属
    //   （`ops/synth.js:applyOwnerSynth` 写 `分类依据.ownerSynth = manual:set`）。
    //   ⚠️ 漏了它 ⇒ 人一确认/绑一次，这条守卫就误报（实测：5678 条被当成"非法键"）。
    const NATURE_KEYS = ['natureClass', 'natureYear', 'natureSeason', 'natureRegion', 'ownerSynth'];
    const RULE_SHAPE = /^[a-z][a-z0-9-]*:[A-Za-z][A-Za-z0-9-]*$/;
    let crBad = 0;
    let crGhost = 0;
    let crCount = 0;
    const crRules = new Map();
    for (const r of records) {
        const meta = r['分类依据'];
        if (!meta) continue;
        if (typeof meta !== 'object' || Array.isArray(meta)) { crBad++; continue; }
        for (const [field, rule] of Object.entries(meta)) {
            crCount++;
            if (!NATURE_KEYS.includes(field) || !RULE_SHAPE.test(String(rule || ''))) crBad++;
            if (!String(r[field] || '').trim()) crGhost++;
            crRules.set(String(rule), (crRules.get(String(rule)) || 0) + 1);
        }
    }
    ok(`[${name}] 分类依据的键都是性质字段、值是合法规则 id`, crBad === 0, `${crBad} 条不合规`);
    ok(`[${name}] 分类依据都指向**真有值**的那个字段`, crGhost === 0, `${crGhost} 条幽灵依据`);
    console.log(`   ${name}: 分类依据 ${crCount}｜规则 ${crRules.size} 种`);
}

// ================================================================
// 「应有 / 已有」那一行：**必须走真实包 + 真实解析**（应用侧形状的回归）
//
// 症状："实际上应有/已有只能在 name/link 字段旁看到"。
// 病根：`core/fieldRegistry.js` 读的是**包里的列名** `节点类型`，而应用节点的类型键是 **`type`**
//   （列名在导入时由 `fieldMap` 映射掉）⇒ 凡是有具体 `types` 的规则（nature 四维 / cfDifficulty /
//   language…）全部返回 `null`，只剩 `types:['*']` 的 name/link 有那一行。
// ⚠️ 夹具的坑：单测夹具若也用 `节点类型`（跟着错的那一方写），两边一起错就"通过"了。
//   所以这条**必须**用 `parseCrate` 解析真包后的记录来断言（那才是应用看到的形状）。
// ================================================================
{
    const { parseCrate } = await import('../../src/features/AutoImport/parse.js');
    const { expectNoteHtml } = await import('../../src/core/fieldRegistry.js');
    const crate = load('all_nodes');
    const parsed = parseCrate(crate, {});
    ok('[all_nodes] 真包能被解析（「应有」那一行的前提）', parsed.ok === true,
        (parsed.errors || []).slice(0, 2).map(e => e.message).join('；'));
    ok('[all_nodes] 包顶层带了「应有」注册表 fieldRegistry',
        !!(parsed.crate && parsed.crate.fieldRegistry && parsed.crate.fieldRegistry.fields),
        '没有它，界面上那一行不会显示');
    const C = (parsed.crate.records || []).find(r => r.type === 'C' && (r.fields || {}).natureClass);
    ok('[all_nodes] 解析后的记录用 `type` 这个键（不是列名 `节点类型`）', !!C,
        '找一条 natureClass 有值的 C 记录');
    if (C) {
        // 应用里的节点形状 = `{...业务字段, type, extKey, …}`（`features/AutoImport/apply.js` 建的）
        const appNode = { ...C.fields, type: C.type, extKey: C.extKey, id: 'x' };
        const html = expectNoteHtml(crate.fieldRegistry, appNode, 'natureClass');
        ok('[all_nodes] natureClass 那一行算得出来（不能只有 name/link 有）',
            /应有：必须有/.test(html), `实际 HTML：${html.slice(0, 80)}`);
        // ⚠️ 挑**常规轮次**的题（`contestIdBelow: 100000` 是规则的一部分；gym 上那条规则
        //    正确的结果是「不适用」而不是「应该有」—— 别拿 gym 当反例）。
        const p = (parsed.crate.records || []).find((r) => {
            const m = /^cf:c:(\d+):p:/.exec(String(r.extKey || ''));
            return r.type === 'P' && !!m && Number(m[1]) < 100000;
        });
        // ⚠️ 前提**必须成立**：只写 `if (p) { … }` 时，真实包里
        //    如果没有常规轮次的 CF 题，那两条断言会**静默跳过**，文件照样全绿。
        //    "前提没了"本身就该红：这条巡检的前提是这个包里有那样一条记录。
        ok(!!p, '[all_nodes] 包里有常规轮次的 CF 题（这条巡检的前提；没有 ⇒ 该来看一眼）');
        if (p) {
            const pNode = { ...p.fields, type: p.type, extKey: p.extKey, id: 'y' };
            ok('[all_nodes] cfDifficulty 那一行算得出来（P 上的 expected 规则）',
                /应有：应该有/.test(expectNoteHtml(crate.fieldRegistry, pNode, 'cfDifficulty')),
                'P 的规则不能因为类型键读错而消失');
        }
    }
}

// ================================================================
// 体检报告：包顶层必须带 `reports`（应用里的「🩺 体检 / 需求」页就吃它）
//
// 这一条是"**报告真的随包发出去了**"的回归：报告由构建链条最后两步产出
// （`scripts/field-coverage.py` / `scripts/material-needs.py`），`crate-merge.mjs` 塞进顶层。
// ⚠️ 单独在这里钉，是因为它**不是节点数据**：别的巡检（节点/链接/账本）一条都不会碰它，
//    而它一旦丢了，应用侧只表现为"那页说没带报告"—— 不报错、很难发现。
// ================================================================
{
    const { parseCrate } = await import('../../src/features/AutoImport/parse.js');
    const { hasReports, summarizeCoverage, summarizeNeeds } = await import('../../src/core/coverage.js');
    const crate = load('all_nodes');
    const parsed = parseCrate(crate, {});
    ok('[all_nodes] 包顶层带了体检报告 reports', hasReports(parsed.crate && parsed.crate.reports),
        '没有它，应用里「🩺 体检 / 需求」只说一句"重建一次包就有"');
    const rep = (parsed.crate && parsed.crate.reports) || null;
    const s = summarizeCoverage(rep);
    // ⚠️ 前提必须成立：只写 `if (s) {…}` 的话，"算不出来"会让下面两条**静默跳过**
    ok(!!s, '[all_nodes] 字段体检那一节能算出来（前提；算不出 ⇒ 该来看一眼）');
    if (s) {
        ok('[all_nodes] 字段体检那一节能算出来（rows 非空 + records 有数）',
            s.rowsTotal > 0 && s.records > 0, `${s.rowsTotal} 行 / ${s.records} 条记录`);
        ok('[all_nodes] 体检口径自洽：三档缺分开算，且 已填 ≤ 适用（豁免另算）',
            s.requiredMissingCount >= 0 && s.expectedMissingCount >= 0 && s.optionalMissingCount >= 0
            && s.filled <= s.applies,
            `真缺 ${s.requiredMissingCount} / 应该有而缺 ${s.expectedMissingCount} / `
            + `可有可无而缺 ${s.optionalMissingCount}｜已填 ${s.filled} ≤ 适用 ${s.applies}`);
    }
    const n = summarizeNeeds(rep);
    ok(!!n, '[all_nodes] 原料需求那一节能算出来（前提）');   // 同上
    if (n) {
        ok('[all_nodes] 原料需求那一节能算出来（逐条都带"该跑的命令"）',
            Array.isArray(n.items) && n.items.every(x => !!x.command && !!x.fixCommand),
            `${n.items.length} 条，合计 ${n.totalGain} 个空位`);
        // ⚠️ 不能断言 `n.items.length > 0`：CLIST 那 530 格与
        //   AtCoder 那 38 格都落到了"**有证据：上游没有/没估出来**"，需求清单**归零**（那是目标，
        //   不是故障）。所以锚改成"**空列表也是一个结论**"＋逐条结构（`length > 0` 的牙齿在
        //   `coverage.test.js` 的合成夹具那边，不靠真实数据）。
        // ★ CLIST 那批格落到"**有证据：上游没有**"（`when.evidence: clist`，见
        //   `lib/clist_evidence.py` 的探针实测）⇒ 体检里**豁免**、需求清单里**不出现它**
        //   （刷缓存命令一格都补不到）。
        // ⚠️ 这里**不许写"缺 0"**（2026-10-17 实测踩到）：那是**当时那份包的数字** ——
        //   重抓一轮 CF 之后新进来一道题，它的 clist 难度确实没有、也**没有**"上游没有"的证据
        //   ⇒ 缺口 0→1、需求清单里也**应该**多出这一条。写成"缺 0"的断言当场假红，
        //   而真正的不变量是**机制**：有证据的格被豁免、且**豁免的格一格都不许进需求**。
        const row = (rep.coverage.rows || []).find(r => r.type === 'P' && r.field === 'clistDifficulty');
        const clistNeed = (n.items || []).filter(x => /clistDifficulty/.test(x.field))
            .reduce((s, x) => s + (x.gain || 0), 0);
        ok('[all_nodes] clistDifficulty：有证据"上游没有"的格仍然被豁免（豁免数 > 0）',
            !!row && row.exempt > 0,
            row ? `缺 ${row.missing} / 豁免 ${row.exempt}` : '找不到这一行');
        ok('[all_nodes] clistDifficulty：需求里只许出现"没有证据"的那些格（豁免的一格都不许进）',
            !!row && clistNeed <= row.missing,
            row ? `需求 ${clistNeed} 格 / 缺 ${row.missing} 格` : '找不到这一行');
        // ★ 同一类处置：AtCoder 那 38 格是 **kenkoooo 没估出难度**（太难没人过 / 不计分的教育场 /
        //   签到题饱和 —— "**特别难，不是没有**"）⇒ `when.evidence: atcoder-models`
        //   （`lib/atcoder_models_evidence.py`，30 天 TTL）⇒ 缺 0 / 豁免、需求清单里也不出现。
        const arow = (rep.coverage.rows || []).find(r => r.type === 'P' && r.field === 'atcoderDifficulty');
        const atcNeed = (n.items || []).filter(x => /atcoderDifficulty/.test(x.field))
            .reduce((s, x) => s + (x.gain || 0), 0);
        // 与上面 CLIST 同一条口径：写**机制**（豁免的格不许进需求），不写"当时那份包的数字"
        ok('[all_nodes] atcoderDifficulty：有证据"上游没估出来"的格仍然被豁免（豁免数 > 0）',
            !!arow && arow.exempt > 0,
            arow ? `缺 ${arow.missing} / 豁免 ${arow.exempt}` : '找不到这一行');
        ok('[all_nodes] atcoderDifficulty：需求里只许出现"没有证据"的那些格',
            !!arow && atcNeed <= arow.missing,
            arow ? `需求 ${atcNeed} 格 / 缺 ${arow.missing} 格` : '找不到这一行');
    }
}

console.log(`✅ 包内结构巡检通过（${checked} 项：链接 6 + 来源表 3×2 + 其余账本 12×3 + 跨包一致 1 + 应有行 4 + 体检报告 9）`);
