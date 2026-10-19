// ================================================================
// 冒烟测试：导入包合并器（scripts/smoke/crate-merge.smoke.mjs）
//
// 为什么用冒烟而不是单测：
//   crate-merge.mjs 是**命令行工具**——真正的契约是"输入文件 → 输出文件 + 退出码"，
//   所以这里直接**跑它**，验证产物与退出码，而不是 import 它的内部函数。
//
// 为什么要它：
//   合并器是"主脚本"，各平台数据脚本都往它这儿汇。它坏了会静默产出
//   带病的导入包（比如同一 extKey 两种类型），而那种错误只在导入时
//   才暴露、且症状难懂。这条用例把"该报的错都报、不该写的不写"钉死。
//
// 运行：npm run test:smoke
// ================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MERGE = path.join(ROOT, 'scripts', 'crate-merge.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crate-merge-test-'));

/** 写一个 crate 文件（无 BOM） */
function writeCrate(name, obj) {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, JSON.stringify(obj), 'utf8');
    return p;
}

/**
 * 跑合并器
 * 注意 stdio 用 'inherit'：受限沙箱禁止管道捕获子进程输出
 * （见 如何使用test.md 里 node --test 的 EPERM 说明）。
 */
function runMerge(args) {
    const res = spawnSync(process.execPath, [MERGE, ...args], { stdio: 'inherit', cwd: ROOT });
    return res.status;
}

const N = (type, extKey, parentExtKey, extra = {}) => {
    const r = { 节点类型: type, extKey };
    if (parentExtKey) r['父extKey'] = parentExtKey;
    return { ...r, ...extra };
};

// 注意层级必须合法：W 下不能直接放 C/P，必须经 S（docs/auto-import.md 2.5）
const skeleton = () => ({
    crateVersion: 1,
    source: { id: 'skeleton' },
    fieldMap: { name: 'name', 题号: 'problemId' },
    records: [
        N('W', 'cf', '', { name: 'Codeforces' }),
        N('S', 'cf:div2', 'cf', { name: 'Div.2' }),
        N('C', 'cf:div2:1900', 'cf:div2', { name: 'Round 900' })
    ]
});

const problemsA = () => ({
    crateVersion: 1,
    source: { id: 'script-A' },
    fieldMap: { name: 'name', 题号: 'problemId' },
    records: [
        N('W', 'cf', '', { name: 'Codeforces' }),
        N('S', 'cf:div2', 'cf', { name: 'Div.2' }),
        N('C', 'cf:div2:1900', 'cf:div2', { name: 'Round 900' }),
        N('P', 'cf:div2:1900:A', 'cf:div2:1900', { name: 'Two Sum', problemId: 'A' })
    ]
});

// ===============================================================
group('合并器：正常合并（共享骨架应去重，不报冲突）');
// ===============================================================
{
    const a = writeCrate('a.json', problemsA());
    const b = writeCrate('b.json', {
        ...problemsA(),
        source: { id: 'script-B' },
        records: [
            ...problemsA().records.slice(0, 3),
            N('P', 'cf:div2:1900:B', 'cf:div2:1900', { name: 'Bread', problemId: 'B' })
        ]
    });
    const out = path.join(tmp, 'ok-merged.json');

    const code = runMerge([a, b, '-o', out]);
    eq(code, 0, '无冲突时退出码 0');
    ok(fs.existsSync(out), '写出了合并产物');

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    // 3 个共享骨架去重 + 2 道题 = 5
    eq(merged.records.length, 5, '共享骨架被去重（4+4 → 5 条）');
    // 产物是 **crate 格式**：用 `节点类型` 而不是归一化后的 `type`
    eq(merged.records.filter(r => r.节点类型 === 'P').length, 2, '两道题都在');
    ok(!!merged.records.find(r => r.extKey === 'cf'), '骨架 W 保留');

    // ★ 产物必须带业务字段（否则输出的是归一化对象，字段全丢）
    const pA = merged.records.find(r => r.extKey === 'cf:div2:1900:A');
    eq(pA.name, 'Two Sum', '题名写回 crate 格式（不是归一化对象）');
    // 注意：产物用的是**声明过的列名** `题号`（fieldMap 里 题号→problemId），
    // 而不是内部名 `problemId`。判据是"能否解析回内部字段"，不是列名长什么样。
    eq(pA['题号'], 'A', '题号写回 crate 格式（用声明过的列名）');
    ok(!('fields' in pA), '产物里不应出现归一化中间字段 `fields`');
    ok(!('type' in pA), '产物里不应出现归一化中间字段 `type`');

    // fieldMap 应自描述：既保留上游声明，也为内部字段名补恒等映射
    eq(merged.fieldMap['题号'], 'problemId', '保留上游的列名声明');
    eq(merged.fieldMap.problemId, 'problemId', '为内部字段名补恒等映射（自描述）');

    eq(merged.source.id, 'crate-merge', '来源标记为合并产物');
    eq(merged.source.mergedFrom.join(','), 'script-A,script-B', '记录了来源脚本');

    // 端到端：合并产物必须能被**应用真实引擎**接受
    const { parseCrate } = await import(
        'file://' + path.join(ROOT, 'src', 'features', 'AutoImport', 'parse.js').replace(/\\/g, '/')
    );
    const reparsed = parseCrate(merged);
    eq(reparsed.ok, true, '合并产物能被应用解析');
    eq(reparsed.crate.records.length, 5, '解析后仍是 5 条（没有记录被静默丢弃）');
    const rp = reparsed.crate.records.find(r => r.extKey === 'cf:div2:1900:A');
    eq(rp.fields.name, 'Two Sum', '**业务字段在往返后仍在**（这是最关键的回归点）');
    eq(rp.fields.problemId, 'A', '题号在往返后仍在');
}

// ===============================================================
group('合并器：分类依据（元列 `分类依据`）—— 搬下来、且应用侧认它');
// ===============================================================
// `分类依据` = "这条分类凭什么判出来的"（`{ natureClass: 'qoj:path-icpc' }`），
// 应用查级别表画依据强度徽标（`core/natureConfidence.js`）。它是**元列**：
//   · 合并时不能被当业务字段"先到先得"吃掉（否则一进合并产物就没了）；
//   · 应用侧既不能把它当业务字段写进节点，也不能报成"未使用列"。
{
    const mk = (srcId, rule) => ({
        crateVersion: 1,
        source: { id: srcId },
        fieldMap: { name: 'name' },
        records: [
            N('W', 'qoj', '', { name: 'QOJ' }),
            N('S', 'qoj:s', 'qoj', { name: '某系列' }),
            N('C', 'qoj:c:1', 'qoj:s', {
                name: '某场',
                natureClass: 'qoj/xcpc/icpc/ec/pre/official',
                natureYear: '2024',
                '分类依据': { natureClass: rule }
            })
        ]
    });
    const a = writeCrate('rule-a.json', mk('src-A', 'qoj:path-icpc'));
    const b = writeCrate('rule-b.json', mk('src-B', 'qoj:path-icpc'));
    const out = path.join(tmp, 'rule-merged.json');

    eq(runMerge([a, b, '-o', out]), 0, '两个来源说同一条规则 ⇒ 不报冲突');
    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const c = merged.records.find(r => r.extKey === 'qoj:c:1');
    eq(JSON.stringify(c['分类依据']), JSON.stringify({ natureClass: 'qoj:path-icpc' }),
        '★ 分类依据原样搬进合并产物（元列没被业务字段那条路吃掉）');

    const { parseCrate } = await import(
        'file://' + path.join(ROOT, 'src', 'features', 'AutoImport', 'parse.js').replace(/\\/g, '/')
    );
    const reparsed = parseCrate(merged);
    eq(reparsed.ok, true, '合并产物能被应用解析');
    const rec = reparsed.crate.records.find(r => r.extKey === 'qoj:c:1');
    eq(rec.fields['分类依据'], undefined, '元列**不进业务字段**（它不是节点的业务值）');
    eq(JSON.stringify(rec.raw['分类依据']), JSON.stringify({ natureClass: 'qoj:path-icpc' }),
        '★ 元列留在 raw 里 —— `plan.js` 就是从这里读给界面的');
    ok(!reparsed.warnings.some(w => w.code === 'unmapped-column' && /分类依据/.test(w.message)),
        '不报「未使用列」（它已经**被用掉**了：进了依据徽标那条路）');
}

// ===============================================================
group('合并器：extKey 类型冲突 → 报错且不写产物');
// ===============================================================
{
    const a = writeCrate('t-a.json', skeleton());
    const b = writeCrate('t-b.json', {
        crateVersion: 1,
        source: { id: 'bad' },
        fieldMap: {},
        records: [N('C', 'cf', '', { name: '把平台写成比赛' })]
    });
    const out = path.join(tmp, 'type-conflict.json');

    const code = runMerge([a, b, '-o', out]);
    eq(code, 1, '有错误时退出码 1');
    ok(!fs.existsSync(out), '**有错误时不写产物**（避免带病文件被误导入）');
}

// ===============================================================
group('合并器：父引用冲突 / W 下直接放 C / 断链');
// ===============================================================
{
    const a = writeCrate('p-a.json', skeleton());
    const b = writeCrate('p-b.json', {
        crateVersion: 1,
        source: { id: 'bad2' },
        fieldMap: {},
        records: [
            N('S', 'cf:div2', 'cf:edu', { name: '父改成别的' }),   // 父冲突
            N('C', 'cf:1', 'cf', { name: 'W 下直接放 C' }),        // 类型非法
            N('P', 'orphan:1', '不存在', { name: '断链' })         // 父不在包内
        ]
    });
    const out = path.join(tmp, 'parent-conflict.json');

    const code = runMerge([a, b, '-o', out, '--report', path.join(tmp, 'report.json')]);
    eq(code, 1, '有错误时退出码 1');
    ok(!fs.existsSync(out), '不写产物');

    const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'report.json'), 'utf8'));
    const codes = rep.problems.map(p => p.code);
    ok(codes.includes('extkey-parent-conflict'), '检出父引用冲突');
    ok(codes.includes('bad-parent-type'), '检出 W 下直接放 C');
    // ⚠️ 原因码改用**应用侧那一个**（`parent-not-found`，见 `features/AutoImport/resolve.js`
    //    与 `core/ops/upsert.js`）：同一件事两边只能有一个叫法，否则爬虫作者在
    //    「合并」与「试跑」两个脚本上会看到两个词。
    ok(codes.includes('parent-not-found'), '检出断链（作为提示，因为可能已在树上）');

    const warnCodes = rep.problems.filter(p => p.level === 'warn').map(p => p.code);
    ok(warnCodes.includes('parent-not-found'), '断链是"提示"而非"错误"（只看这几份包、看不见主树）');
}

// ===============================================================
group('合并器：字段值冲突 → 提示（保留先到的）但不阻断');
// ===============================================================
{
    const a = writeCrate('f-a.json', {
        crateVersion: 1, source: { id: 'A' }, fieldMap: {},
        records: [N('W', 'cf', '', { name: 'Codeforces' })]
    });
    const b = writeCrate('f-b.json', {
        crateVersion: 1, source: { id: 'B' }, fieldMap: {},
        records: [N('W', 'cf', '', { name: 'CF 改了个名' })]
    });
    const out = path.join(tmp, 'field-conflict.json');

    const code = runMerge([a, b, '-o', out]);
    eq(code, 0, '字段值不一致只提示，不阻断（退出码 0）');
    ok(fs.existsSync(out), '仍然写出产物');

    const merged = JSON.parse(fs.readFileSync(out, 'utf8'));
    const cf = merged.records.find(r => r.extKey === 'cf');
    eq(cf.name, 'Codeforces', '保留**先到的**值（后面的包不覆盖）');
}

// ===============================================================
group('合并器：跨包 fieldMap 映射冲突 → 报错');
// ===============================================================
{
    const a = writeCrate('m-a.json', {
        crateVersion: 1, source: { id: 'A' },
        fieldMap: { 题号: 'problemId' },
        records: [N('W', 'cf', '', { name: 'CF' })]
    });
    const b = writeCrate('m-b.json', {
        crateVersion: 1, source: { id: 'B' },
        fieldMap: { 题号: 'link' },              // 同名列映射到不同内部字段
        records: [N('W', 'lg', '', { name: 'LG' })]
    });
    const out = path.join(tmp, 'fieldmap-conflict.json');

    const code = runMerge([a, b, '-o', out, '--report', path.join(tmp, 'fm-report.json')]);
    eq(code, 1, 'fieldMap 冲突 → 退出码 1');
    const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'fm-report.json'), 'utf8'));
    ok(rep.problems.some(p => p.code === 'fieldmap-conflict'), '检出 fieldMap 冲突');
}

// ===============================================================
group('合并器：成环 / 自引用 / BOM');
// ===============================================================
{
    const a = writeCrate('c-a.json', {
        crateVersion: 1, source: { id: 'cycle' }, fieldMap: {},
        records: [
            N('S', 'x', 'y', { name: 'X' }),
            N('S', 'y', 'x', { name: 'Y' })
        ]
    });
    const out = path.join(tmp, 'cycle.json');
    const code = runMerge([a, '-o', out, '--report', path.join(tmp, 'cycle-report.json')]);
    eq(code, 1, '成环 → 退出码 1');
    const rep = JSON.parse(fs.readFileSync(path.join(tmp, 'cycle-report.json'), 'utf8'));
    ok(rep.problems.some(p => p.code === 'parent-cycle'), '检出父引用成环');

    // 带 BOM 的文件应当能正常读（Windows 工具常写 BOM）
    const bomPath = path.join(tmp, 'bom.json');
    fs.writeFileSync(bomPath, '\uFEFF' + JSON.stringify({
        crateVersion: 1, source: { id: 'bom' }, fieldMap: {},
        records: [N('W', 'cf', '', { name: '带 BOM' })]
    }), 'utf8');
    const bomOut = path.join(tmp, 'bom-merged.json');
    const bomCode = runMerge([bomPath, '-o', bomOut]);
    eq(bomCode, 0, '带 BOM 的文件能正常读取（不报 Unexpected token）');
}

// ===============================================================
group('合并器：命令行保护的边界');
// ===============================================================
{
    const a = writeCrate('g-a.json', problemsA());
    eq(runMerge([a, '-o', a]), 2, '拒绝"输出覆盖输入"（退出码 2）');
    eq(runMerge([a]), 2, '缺少 -o → 退出码 2');
    eq(runMerge([]), 2, '没有输入文件 → 退出码 2');
}

// ===============================================================
group('合并器：产物必须**原子写**（别留半截 JSON 给下一轮当输入）');
// ===============================================================
{
    // ★ 2026-10-16（审计翻出来的）：包原来用裸 `fs.writeFileSync(outFile, …)` —— 写到一半被打断
    //   （Ctrl-C / 盘满）会留下**半个 JSON**，而下一轮 `crate-merge` 会把它当**正常输入**读进来
    //   （症状："合并莫名其妙少了一截"）。`crate.py:save` 与三个 devserver store 早就是
    //   "临时文件 + replace" 了，只有这里漏着。
    // 判据走**源码级**（原子性没法在桩里"拔电"验证，但"走没走那条唯一的路"可以钉死 ——
    // 与 `build_chain --selftest` 里那条"源码级顺序"同一姿态）+ 端到端"不留垃圾"。
    const src = fs.readFileSync(MERGE, 'utf8');
    ok(/function writeFileAtomic\(/.test(src), '有一处原子写实现（临时文件 + rename）');
    ok(!/fs\.writeFileSync\((outFile|reportFile)/.test(src),
       '★ 包与报告都不许再裸写 —— 只能走 `writeFileAtomic()`');
    ok(/fs\.renameSync\(/.test(src), '原子那一步用的是 `renameSync`（同目录 ⇒ 原子）');

    const a2 = writeCrate('atomic-a.json', problemsA());
    const out2 = path.join(tmp, 'atomic-merged.json');
    eq(runMerge([a2, '-o', out2]), 0, '正常合并退出码 0（原子写这条路真跑得通）');
    ok(fs.existsSync(out2) && fs.statSync(out2).size > 0, '产物写出来了');
    ok(!fs.existsSync(out2 + '.tmp-write'), '跑完不留 `.tmp-write` 垃圾（与三个 store 同一约定）');
}

fs.rmSync(tmp, { recursive: true, force: true });
report();
