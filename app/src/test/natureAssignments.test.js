// ================================================================
// 回代 baseline 的导出（src/test/natureAssignments.test.js）
//
// 口径："手改的 nature 可以标为 M" + "可以开始做回代了"。
//
// `docs/manual-workflow.md`（回代三件套） 的 ③ = **对 crate 的增量**（`identity → 字段 → {值, 优先级, 规则id, 来源}`），
// 由应用导出、由脚本读来做 baseline（§466 的回代闭环）。这里钉四件事：
//   ① **只收人定过的**（`分类依据 == manual:set`）—— 规则产物不带（脚本重跑能复现）；
//   ② 形状 = `{format, version, generatedAt, registryVersion, count, fields, assignments[]}`，
//      每条 `{extKey|synthKey, type, name, fields:{字段:{v, priority, rule, src, at, account}}}`；
//   ③ 顺序稳定（按 extKey 排）—— 这份文件是给人看 diff 的；
//   ④ 跨语言的两份字面量（`manual:set` / 格式标识 / 版本）与 `scripts/nature-baseline.py` 一致。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ASSIGNMENTS_FORMAT,
    ASSIGNMENTS_VERSION,
    MANUAL_SRC,
    collectNatureAssignments,
    assignmentProblem,
    bindingProblem
} from '../core/natureAssignments.js';
import { MANUAL_RULE, MANUAL_LEVEL } from '../core/natureConfidence.js';
import { MANUAL_SRC as FIELD_VALUE_MANUAL_SRC } from '../core/fieldValue.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 造一个节点（只带导出用得上的字段） */
const N = (extra = {}) => ({
    id: 'n1', type: 'C', name: '甲站', extKey: 'xcpc:c:1',
    natureClass: '', natureYear: '', natureSeason: '', natureRegion: '',
    values: {},
    ...extra
});

test('回代导出：**只收人定过的**（`manual:set`），带值 / 优先级 / 规则 / 出处', () => {
    const state = {
        nodes: {
            a: N({
                id: 'a', extKey: 'xcpc:c:b',
                natureClass: 'xcpc/icpc/ec/regional/official', natureYear: '2025',
                // 两个字端都标了 manual；年份那条来源层里能找到"谁什么时候填的"
                分类依据: { natureClass: MANUAL_RULE, natureYear: MANUAL_RULE },
                values: {
                    natureYear: [
                        { v: '2024', src: 'some-script', at: '2026-09-01T00:00:00Z' },
                        { v: '2025', src: 'manual', at: '2026-10-01T10:00:00Z', account: 'k1' }
                    ]
                }
            }),
            // 规则判出来的（不是人定的）⇒ **不进** baseline
            b: N({
                id: 'b', extKey: 'xcpc:c:a',
                natureClass: 'qoj/ucup', natureYear: '无',
                分类依据: { natureClass: 'qoj:ucup-title' }
            }),
            // 没有任何 nature ⇒ 不进
            c: N({ id: 'c', extKey: 'xcpc:c:c' }),
            // ★ 早就手填好的值：没有 `分类依据` 那一列（老数据），
            //   但值级来源层里写着 `src: 'manual'` ⇒ 一样要收（否则第一次导出会全漏掉）
            d: N({
                id: 'd', extKey: 'xcpc:c:d',
                natureClass: 'xcpc/icpc/ec/pre/official',
                values: {
                    natureClass: [{ v: 'xcpc/icpc/ec/pre/official', src: 'manual', at: '2026-09-20T00:00:00Z' }]
                }
            })
        }
    };
    const out = collectNatureAssignments(state, { generatedAt: 'T', registryVersion: 7 });

    assert.equal(out.format, ASSIGNMENTS_FORMAT);
    assert.equal(out.version, ASSIGNMENTS_VERSION);
    assert.equal(out.generatedAt, 'T');
    assert.equal(out.registryVersion, 7);
    assert.equal(out.count, 2, '两个节点有"人定过的值"（一个带标记、一个只有来源层）');
    assert.equal(out.fields, 3, '三处（分类 + 年份 + 老数据那条分类）');

    const one = out.assignments.find(a => a.extKey === 'xcpc:c:b');
    assert.equal(one.type, 'C');
    assert.deepEqual(Object.keys(one.fields).sort(), ['natureClass', 'natureYear']);
    assert.deepEqual(one.fields.natureClass, {
        v: 'xcpc/icpc/ec/regional/official',
        priority: MANUAL_LEVEL,          // §10.3 的全序里 manual 最高
        rule: MANUAL_RULE,
        src: MANUAL_SRC,
        at: '',
        account: ''
    }, '分类那条：来源层里没有 manual 条目 ⇒ at/account 留空，但不是编一个');
    assert.equal(one.fields.natureYear.at, '2026-10-01T10:00:00Z', '★ 时间取自来源层里那条 manual');
    assert.equal(one.fields.natureYear.account, 'k1', '★ 账户也带上（值是谁填的）');
    assert.equal(one.fields.natureYear.v, '2025', '取的是**当前值**，不是历史值');
    assert.equal(assignmentProblem(one), '', '形状合法');

    // ★ 老数据（只有来源层那条 manual、没有 `分类依据` 标记）也要进
    const old = out.assignments.find(a => a.extKey === 'xcpc:c:d');
    assert.ok(old, '★ 手填但没标记的（老数据）也要收 —— 否则第一次导出会全漏掉');
    assert.equal(old.fields.natureClass.at, '2026-09-20T00:00:00Z', '出处同样带得上');
    assert.equal(old.fields.natureClass.rule, MANUAL_RULE, '导出去一律按"人工"记');
});

// ★ 判据：`docs/manual-values.md` 的「判据」第 4 条 ——「客观与本账户两条并存时，导出**带哪条**要写死并断言」。
//   这一条补的就是那句"未做"。**写死的口径 = 带"节点缓存字段里那个值"对应的那条**，也就是**屏上显示的那条**
//   （缓存字段是投影的物化结果，投影按优先级/时间选出"当前该显示的那个"）。
//   ⚠️ 所以它**跟着显示走**：换一条更晚写的、或换个查看账户，导出就会跟着变 —— **这是有意的**（导出与显示同源），
//      要的是"同一份 state + 同一个查看范围 ⇒ 同一份导出"，而不是"永远带客观那条"。
//      真要把口径改成"永远带客观那条" ＝ **改口径，先问人**（那会让导出与屏幕上看到的不是一回事）。
test('★ 导出稳定：两条手改并存时，带的是缓存那个值对应的那条（= 屏上显示的那条）', () => {
    const mk = cache => N({
        id: 'a', extKey: 'xcpc:c:both', natureYear: cache,
        values: { natureYear: [
            { v: '2023', src: 'manual', at: '2026-10-01T00:00:00Z', account: '' },     // 客观（早）
            { v: '2022', src: 'manual', at: '2026-10-02T00:00:00Z', account: 'k1' }    // 本账户（晚）
        ] }
    });
    const pick = cache => collectNatureAssignments({ nodes: { a: mk(cache) } })
        .assignments[0].fields.natureYear;

    // 缓存 = 客观那条 ⇒ 带客观那条（值、归属、时间都是它的）
    const obj = pick('2023');
    assert.equal(obj.v, '2023');
    assert.equal(obj.account, '', '带的是**客观那条**的归属（不是"反正都算 my"）');
    assert.equal(obj.at, '2026-10-01T00:00:00Z', '★ 时间必须与那条对得上');

    // 同一份数据、只是投影给了另一条 ⇒ 带的就是另一条（**同源**，不是随机）
    const mine = pick('2022');
    assert.equal(mine.v, '2022');
    assert.equal(mine.account, 'k1', '★ 值是谁填的一起带出去（脚本侧看得见，不是偷偷算成全体的）');
    assert.equal(mine.at, '2026-10-02T00:00:00Z');
    assert.equal(mine.priority, MANUAL_LEVEL, '两条的优先级都还是"人工"那一档');
});

test('回代导出：顺序按 extKey（稳定 ⇒ diff 干净）；空值 / 无 extKey 都兜得住', () => {
    const mk = (id, extKey, cls) => N({
        id, extKey, natureClass: cls, 分类依据: { natureClass: MANUAL_RULE }
    });
    const out = collectNatureAssignments({
        nodes: {
            y: mk('y', 'xcpc:c:zzz', 'xcpc/icpc'),
            x: mk('x', 'xcpc:c:aaa', 'xcpc/ccpc'),
            // ⚠️ **合成节点（组头）不进这份导出**（口径见 `core/natureAssignments.js` 循环开头）：
            //    它那四格是**按成员派生**的（`pickGroupNature`），导出它只会得到一堆"回声"；
            //    而组头一旦因信息补全改名，这些条目就变成"手填成了孤儿"（实测：陕西/浙江两条）。
            h: N({ id: 'synth-1', extKey: '', synthKey: 'synth:k', type: 'C',
                   natureClass: 'xcpc/ccpc/final/official',
                   分类依据: { natureClass: MANUAL_RULE } })
        }
    }, { generatedAt: '', registryVersion: 0 });
    assert.deepEqual(out.assignments.map(a => a.extKey || a.synthKey),
        ['xcpc:c:aaa', 'xcpc:c:zzz'], '按 extKey 排序（顺序稳定 ⇒ diff 干净）');
    assert.ok(!out.assignments.some(a => a.synthKey),
        '★ 组头不导出：它是派生量，导出只会得到回声（要改请改**成员**那一格）');

    // 标记还在、值却空 ⇒ 不算"定过"（标记与值应当同生共死）
    const empty = collectNatureAssignments({
        nodes: { a: N({ id: 'a', extKey: 'e', natureClass: '', 分类依据: { natureClass: MANUAL_RULE } }) }
    });
    assert.equal(empty.count, 0);
    assert.equal(empty.fields, 0);
});

test('回代导出的形状自检（`assignmentProblem`）', () => {
    assert.equal(assignmentProblem({ extKey: 'e', fields: { natureClass: { v: 'xcpc' } } }), '');
    assert.equal(assignmentProblem({ extKey: 'e', fields: { natureClass: 'xcpc' } }), '',
        '裸值也认（脚本侧同样两种都收）');
    assert.match(assignmentProblem({ fields: { natureClass: { v: 'xcpc' } } }), /认不出/);
    assert.match(assignmentProblem({ extKey: 'e', fields: {} }), /空的/);
    assert.match(assignmentProblem({ extKey: 'e', fields: { name: { v: 'x' } } }), /未知的性质字段/);
    assert.match(assignmentProblem({ extKey: 'e', fields: { natureClass: { v: ' ' } } }), /没有值/);
    assert.match(assignmentProblem({ extKey: 'e', fields: { natureClass: { v: 'x', rule: 'qoj:path-icpc' } } }),
        /不是人工标记/, '这个文件只装人的结论，规则 id 混进来要拦住');
    assert.match(assignmentProblem(null), /不是对象/);
});

test('★ 手工绑定的合成归属也要导出（`ownerSynth` 没有别的痕迹可查）', () => {
    // 判据 = 手改那条路留下的 `分类依据.ownerSynth = manual:set`（`ops/synth.js:applyOwnerSynth`）
    const bound = N({ id: 'c1', extKey: 'qoj:c:1', ownerSynth: 'synth:xcpc:2020ec_regional-银川' });
    bound['分类依据'] = { ownerSynth: MANUAL_RULE };
    const scripted = N({ id: 'c2', extKey: 'qoj:c:2', ownerSynth: 'synth:xcpc:2020ec_regional-银川' });
    scripted['分类依据'] = { natureClass: 'qoj:path-icpc' };        // 脚本产的 ⇒ 不带回去
    const payload = collectNatureAssignments({ nodes: { c1: bound, c2: scripted } }, { generatedAt: 'T' });
    assert.equal(payload.bindings, 1, '只收人绑的那条');
    assert.equal(payload.ownerBindings[0].extKey, 'qoj:c:1');
    assert.equal(payload.ownerBindings[0].ownerSynth, 'synth:xcpc:2020ec_regional-银川');
    assert.equal(payload.ownerBindings[0].rule, MANUAL_RULE, '带人工标记（脚本侧照它写 manual:set + 来源）');
    // ★ 没有那条标记的手工绑定：键不是脚本格式 ⇒ 一样要带回去（否则重出包就丢）
    const legacy = N({ id: 'c3', extKey: 'qoj:c:3', ownerSynth: 'synth:手工:一组' });
    const p2 = collectNatureAssignments({ nodes: { c3: legacy } }, { generatedAt: 'T' });
    assert.equal(p2.bindings, 1, '手工绑定（非脚本格式的键）也收');
    assert.equal(p2.ownerBindings[0].ownerSynth, 'synth:手工:一组');
    // 形状自检
    assert.equal(bindingProblem(payload.ownerBindings[0]), '');
    assert.match(bindingProblem({ extKey: 'x' }), /没有 ownerSynth/);
    assert.match(bindingProblem({ extKey: 'x', ownerSynth: 'k', rule: 'qoj:path-icpc' }), /不是人工标记/);
    assert.match(bindingProblem({ ownerSynth: 'k' }), /既没有 extKey 也没有 synthKey/);
});

/**
 * 取 `from <module> import …` 里**真正 import 进来的名字**集合（找不到那条 import ⇒ null）。
 *
 * 为什么要单独解析而不是"窗口正则在文件里搜一把"：窗口会罩到**函数体**里的同名调用，
 * 于是"把 import 删掉、只留一句 `load_baseline(...)` 调用"仍能骗过守卫
 * （变异测试实测如此）。这里只读 import 语句本身：
 * 括号多行与同一行多个名字都支持。
 */
function importedNames(text, module) {
    const at = new RegExp(`^from\\s+${module}\\s+import\\s+`, 'm').exec(text);
    if (!at) return null;
    const i = at.index + at[0].length;
    let body;
    if (text[i] === '(') {
        const end = text.indexOf(')', i);
        if (end < 0) return null;
        body = text.slice(i + 1, end);
    } else {
        const nl = text.indexOf('\n', i);
        body = text.slice(i, nl < 0 ? text.length : nl);
    }
    const names = body.split(',')
        .map(s => s.replace(/#.*$/, '').trim().split(/\s+as\s+/).pop().trim())
        .filter(Boolean);
    return new Set(names);
}

test('跨语言字面量：`manual:set` / 来源 id / 格式标识 / 版本，两边一致', () => {
    assert.equal(MANUAL_SRC, FIELD_VALUE_MANUAL_SRC, '来源层的"手填"id 与 fieldValue.js 同一份');
    // ★ 这两个字面量在 `scripts/nature_baseline_lib.py` 里
    //   （回代那条路 + 主脚本"直接写盘"那条路共用同一份读法），所以核对那个文件；
    //   入口 `nature-baseline.py` 只 import、不各写一遍 —— 这里连"有没有 import"一起钉住。
    const lib = fs.readFileSync(path.join(ROOT, 'scripts', 'nature_baseline_lib.py'), 'utf8');
    assert.match(lib, /BASELINE_RULE = "manual:set"/, 'Python 侧认同一个规则 id');
    assert.match(lib, new RegExp(`FORMAT = "${ASSIGNMENTS_FORMAT}"`), '格式标识一致');
    assert.match(lib, new RegExp(`SUPPORTED_VERSIONS = \\(${ASSIGNMENTS_VERSION},\\)`), '版本号一致');
    const entry = fs.readFileSync(path.join(ROOT, 'scripts', 'nature-baseline.py'), 'utf8');
    const names = importedNames(entry, 'nature_baseline_lib');
    assert.ok(names && names.has('load_baseline'),
        '入口必须**从 lib import `load_baseline`**（读法只有一份）——'
        + `实际 import 进来的是 ${names ? [...names].join('/') : '(找不到这条 import)'}`);
    // ★ 自检：正文里出现同名调用**不算** import（变异测试：单靠
    //   窗口正则 `/from … import[\s\S]{0,400}load_baseline/` 会被函数体里的
    //    `load_baseline(...)` 调用满足 ⇒ 删掉 import 那份也照样绿）
    assert.equal(importedNames('from nature_baseline_lib import BASELINE_RULE\n\nload_baseline(p)\n',
        'nature_baseline_lib').has('load_baseline'), false,
    '自检：删了 import、只留正文调用 ⇒ 必须抓不到');
    assert.equal(importedNames('from nature_baseline_lib import (\n    BASELINE_RULE,\n    load_baseline,\n)\n',
        'nature_baseline_lib').has('load_baseline'), true,
    '自检：括号多行 import 要认得');
    assert.equal(importedNames('from nature_baseline_lib import BASELINE_RULE, load_baseline\n',
        'nature_baseline_lib').has('load_baseline'), true,
    '自检：同一行两个名字要认得');
});

// ★ 数据驱动：**每一条手填都必须在包里逐格对上**
//   起因：手填有没有丢，只能**临时敲一个脚本**去数 18 条 ——
//   那说明缺一条守卫。手填是**最不可再生**的东西：脚本算得出年份，算不出"东北四省"
//   这种人为划定的地区（`natureRegion`）。这条挡住"导出 → 回代 → 产包"某一环静默丢手填，
//   以及"包里那条被后来的规则覆盖掉"。
test('★ 数据驱动：`nature-assignments.json` 里每一条手填都在包里逐格对上', () => {
    const naPath = path.join(ROOT, 'acm-data', 'nature-assignments.json');
    const pkgPath = path.join(ROOT, 'acm-data', 'nodes', 'all_nodes.json');
    if (!fs.existsSync(naPath) || !fs.existsSync(pkgPath)) {
        assert.ok(true, '（还没有包或还没有手填，跳过）');
        return;
    }
    const assignments = JSON.parse(fs.readFileSync(naPath, 'utf8')).assignments || [];
    const recs = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).records || [];
    // ⚠️ **两种身份都要认**（`extKey` 与 `synthKey`）：手填落在**合成节点**（组头）上时
    //    用的是 `synthKey`（那种节点没有 extKey）—— 只按 extKey 查会把它们全报成
    //    "`undefined`：这个节点不在包里（手填成了孤儿）"（实测：用户导出后这条守卫红了，
    //    报的是 5 条**连名字都没有**的孤儿，而其实只有 4 条是真的）。
    //    这与 `nature_baseline_lib.parse_baseline()` 的读法**同一口径**（那边也是 ext 优先、退回 synth）。
    const by = new Map();
    for (const r of recs) {
        if (r.extKey) by.set(String(r.extKey), r);
        if (r.synthKey) by.set(String(r.synthKey), r);
    }
    const bad = [];
    let cells = 0;
    for (const one of assignments) {
        const ident = String(one.extKey || one.synthKey || '(没有身份)');
        const rec = by.get(ident);
        if (!rec) { bad.push(`${ident}：这个节点不在包里（手填成了孤儿）`); continue; }
        for (const [field, cell] of Object.entries(one.fields || {})) {
            cells += 1;
            if (String(rec[field]) !== String(cell.v)) {
                bad.push(`${ident}.${field}：包里是 ${JSON.stringify(rec[field])}，手填是 ${JSON.stringify(cell.v)}`);
            }
        }
    }
    assert.ok(assignments.length > 0 && cells > 0,
        '手填文件里应该有内容（一条都没有 ⇒ 这条守卫是空的，说明它被清过或读错了文件）');
    assert.deepEqual(bad, [],
        `这些手填没有落进包里（手填算不出来、丢了就只能重填）：\n${bad.join('\n')}`);
});
