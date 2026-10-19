// ================================================================
// 导入计划测试（features/AutoImport/plan.js）
// 依据：docs/auto-import.md 2.3 / 2.5 / 4.2 / 4.6 / 4.7 / 5 / 6.2 / 6.3 / 9.2
//
// 本文件是**第一批的集成测试**：把 parse→resolve→match→merge→fingerprint
// 串起来，验证「导两次结果收敛」这条硬性验收标准（12.3）。
//
// 重要：测试必须走**真实路径**——记录用爬虫列名（中文），由 fieldMap 映射成
// 内部字段名，而不是预先映射好再喂进来。否则测不到 7.3 那座桥。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan, ACTION } from '../features/AutoImport/plan.js';
import { applyFieldMap, RESERVED_KEYS } from '../features/AutoImport/fieldmap.js';
import { parseCrate } from '../features/AutoImport/parse.js';
import { toCrate as qojToCrate } from '../features/AutoImport/adapters/qoj.js';
import { buildExtKeyIndex } from '../core/ops/upsert.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 样本数据统一放在 acm-data/raw/（见 acm-data/readme.md）
const readSample = name => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'acm-data', 'raw', name), 'utf8')
);
// ⚠️ `qoj_submissions.json` 是**个人提交导出**：**发出去之前**会用 `scripts/clean-personal.mjs`
//    清掉（级别 2 起），所以这里按"它可能不在"来写。缺样本时让用例 skip（不是红）——
//    谁拿到这份仓库跑 `npm test`，都不该因为这行红而以为仓库坏了。
const hasSample = name => fs.existsSync(path.join(ROOT, 'acm-data', 'raw', name));

/** 结构键黑名单（与 plan.js 内部的一致）：身份列不是业务字段 */
const RESERVED = RESERVED_KEYS;   // `type` 已在其中（M11）

// ================================================================
// 造数据
// ================================================================

// 包顶层带的「**应有**」注册表（`fieldRegistry`）：每个字段条都有
//   『是否应有』『是否已有』『来源』『优先级』。前两样只在构建期算，得**随包**到应用。
test('⭐ 注入 applyFieldMap 与走兜底路，字段表形状必须一样（M10 那一族）', () => {
    // 病根：注入路把注入者返回的 `{fields, ignored, unmapped}`
    // **整个外壳**当成了字段表 ⇒ 只由 fieldMap 给出身份的记录（如 `合成标识 → synthKey`）
    // 会**静默丢**（后面读不到 `fields.synthKey` ⇒ `missing-extkey`），而兜底路是对的。
    // 两条路必须给同一个形状 —— 这里用"身份只能由 fieldMap 给出"的合成记录钉住。
    const crate = {
        crateVersion: 1, source: { id: 's1' },
        fieldMap: { 节点类型: 'type', 合成标识: 'synthKey', 名字: 'name' },
        records: [{ 节点类型: 'P', 合成标识: 'g1', 名字: '一道题' }]
    };
    const viaFallback = parseCrate(crate);                       // 不注入 ⇒ 走共用件
    let injected = 0;                                            // ⚠️ 记一下注入的**真被调了**
    const viaInject = parseCrate(crate, {                        // 注入 ⇒ 走注入者（返回外壳）
        applyFieldMap: (r, fm, o) => { injected++; return applyFieldMap(r, fm, o); }
    });
    assert.equal(injected, 1,
        '注入的实现必须真的被调用一次 —— 否则"两条路形状一样"测的是同一条路');
    assert.deepEqual(viaInject.crate.records, viaFallback.crate.records,
        '两条路必须解析出同一批记录（形状不同 ⇒ 注入路会静默丢记录）');
    assert.deepEqual(viaInject.errors, viaFallback.errors);
    assert.equal(viaFallback.crate.records.length, 1, '这份记录只靠 fieldMap 给身份，也必须留下');
});

test('fieldRegistry：包顶层带的「应有」注册表被解析出来（带则带、不带则 null，都不报错）', () => {
    const withReg = {
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey', 名字: 'name' },
        fieldRegistry: { registryVersion: 1, fields: { name: { expect: 'required' } } },
        records: [{ 比赛: 'cf:c:1', 名字: '一场' }]
    };
    const got = parseCrate(withReg, {});
    assert.equal(got.ok, true);
    assert.equal(got.crate.fieldRegistry.fields.name.expect, 'required', '随包带过来');

    const without = parseCrate({
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey' },
        records: [{ 比赛: 'cf:c:1' }]
    }, {});
    assert.equal(without.crate.fieldRegistry, null, '没有这一节 ⇒ null（不是错误）');
    // ⚠️ 这里只看"有没有因为注册表而报警"：这份极简记录本身缺列（节点类型…），
    //    报别的错是正常的 —— 断言别写成"一条错都没有"。
    assert.equal(without.errors.filter(e => /fieldRegistry|注册表/.test(String(e.message || e))).length,
        0, '不带注册表**不许**为它报警');
});

// 包顶层带的**体检报告**（`reports`）—— 体检报告应该能在应用里看。
//   与 fieldRegistry 同一套路：随包发布、可选、缺了不许报错。
test('reports：包顶层带的体检报告被解析出来（带则带、不带则 null，都不报错）', () => {
    const withRep = {
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey', 名字: 'name' },
        reports: {
            coverage: { package: 'acm-data/nodes/all_nodes.json', records: 3, rows: [{ type: 'C', field: 'name', expect: 'required', missing: 0 }] },
            needs: { package: 'acm-data/reports/material-needs.json', needs: [{ id: 'cf:x', gain: 3 }] }
        },
        records: [{ 比赛: 'cf:c:1', 名字: '一场' }]
    };
    const got = parseCrate(withRep, {});
    assert.equal(got.ok, true);
    assert.equal(got.crate.reports.coverage.rows.length, 1, '随包带过来');
    assert.equal(got.crate.reports.needs.needs[0].gain, 3);

    // ★ `reports.baseline`（回代核对）也要放行 —— 这里是一份**白名单**，
    //   新加一节忘了放行 ⇒ 静默丢掉（症状：包里明明有，③ 却说"还没有脚本端的核对"）。
    const withBase = parseCrate({
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey' },
        reports: { baseline: { sameAsAuto: 1, sameAsAutoItems: [{ key: 'x', field: 'natureRegion', value: '浙江' }] } },
        records: [{ 比赛: 'cf:c:1' }]
    }, {});
    assert.equal(withBase.crate.reports.baseline.sameAsAuto, 1, '★ 回代核对随包带过来');
    assert.deepEqual(Object.keys(withBase.crate.reports), ['baseline'], '只有 baseline 就只带 baseline');

    // 只有一半也算带（两节各自可选）：界面会缺哪节说哪节
    const half = parseCrate({
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey' },
        reports: { coverage: { rows: [] } },
        records: [{ 比赛: 'cf:c:1' }]
    }, {});
    assert.deepEqual(Object.keys(half.crate.reports), ['coverage'], '只有 coverage 就只带 coverage');

    const without = parseCrate({
        crateVersion: 1, source: { id: 's1' }, fieldMap: { 比赛: 'extKey' },
        records: [{ 比赛: 'cf:c:1' }]
    }, {});
    assert.equal(without.crate.reports, null, '没有这一节 ⇒ null（不是错误）');
    assert.equal(without.errors.filter(e => /reports|体检/.test(String(e.message || e))).length,
        0, '不带报告**不许**为它报警');
});

/** 造一个只含根节点的 state（plan 只读 nodes / childOrder / parentOf） */
function makeState() {
    return {
        rootId: 'o',
        nodes: { o: { id: 'o', type: 'O', name: '根' } },
        childOrder: { o: [] },
        parentOf: { o: null }
    };
}

/** 把一条记录放进 state（模拟"树上已有"） */
function putNode(state, id, type, parentId, extra = {}) {
    const node = {
        id,
        type,
        name: extra.name !== undefined ? extra.name : id,
        extKey: extra.extKey || '',
        problemId: extra.problemId || '',
        expanded: false,
        currentPage: 1,
        selected: false,
        ...extra
    };
    state.nodes[id] = node;
    if (!state.childOrder[id]) state.childOrder[id] = [];
    state.childOrder[parentId].push(id);
    state.parentOf[id] = parentId;
    return node;
}

/**
 * 造一份 crate。
 *
 * `fields` 用**内部字段名**——本函数把最外层的字段名当作"爬虫列名"，
 * 并自动生成一张**恒等 fieldMap**，于是 7.3 那座桥（列名 → 内部字段）真实经过。
 * 想看中文列名的映射，就显式传 `fieldMap`（如 `{ 题目名称: 'name' }`），
 * 此时 raw 的键会是 `题目名称`。
 *
 * @param {Array<Object>} records - `{ type, extKey, parentExtKey, fields }`
 * @param {Object} opts
 * @param {Object} [opts.fieldMap] - 覆盖自动生成的恒等映射
 */
function makeCrate(records, { fieldMap, fieldPolicies = {}, source = { id: 'test' } } = {}) {
    const explicitMap = fieldMap && Object.keys(fieldMap).length > 0 ? fieldMap : null;

    // 自动恒等映射：字段名即列名（覆盖所有记录里出现过的字段）
    const autoMap = {};
    for (const r of records) {
        for (const internal of Object.keys(r.fields || {})) autoMap[internal] = internal;
    }
    const map = explicitMap || autoMap;

    return {
        crateVersion: 1,
        source,
        generatedAt: '',
        fieldMap: map,
        fieldPolicies,
        records: records.map((r, i) => {
            const raw = { extKey: r.extKey };
            if (r.parentExtKey) raw['父extKey'] = r.parentExtKey;
            // 业务字段：按 fieldMap 反查回爬虫列名，让 applyFieldMap 能映射回来。
            // 显式 fieldMap 里没提到的字段，保留内部名作为列名（并自动成为恒等项）。
            for (const [internal, value] of Object.entries(r.fields || {})) {
                const column = Object.keys(map).find(k => map[k] === internal) || internal;
                raw[column] = value;
                if (!explicitMap && map[column] === undefined) map[column] = column;
            }
            // **元列**（`分类依据` / `链接分类` / `字段来源` …）：不该当业务字段，直接塞进 raw。
            // 用 `Object.assign` 而不是展开在业务字段**之前** —— 元列与业务字段不同名，
            // 顺序无所谓，但放最后更直观："先写字段，再把元列盖上去"。
            Object.assign(raw, r.raw || {});
            return {
                index: i,
                type: r.type,
                extKey: r.extKey,
                parentExtKey: r.parentExtKey || '',
                raw
            };
        })
    };
}

const plan = (crate, state, opts = {}) => buildPlan({
    crate,
    state,
    keyIndex: buildExtKeyIndex(state),
    applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, { reservedKeys: RESERVED }),
    ...opts
});

// ================================================================
// 基本路径：全新建
// ================================================================

test('buildPlan 全新 crate → 全部 create，顺序父先子后', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } },
        { type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'QOJ Contest' } },
        { type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest', fields: { name: 'Round 4113' } },
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.total, 4);
    assert.equal(p.summary.create, 4);
    assert.equal(p.summary.update, 0);
    assert.equal(p.summary.skip, 0);
    assert.equal(p.summary.errors, 0);
    assert.deepEqual(p.records.map(r => r.type), ['W', 'S', 'C', 'P'], '拓扑序 W→S→C→P');
});

test('buildPlan 不改动 state（dry-run）', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    plan(makeCrate([{ type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } }]), state);
    assert.equal(JSON.stringify(state), before, 'dry-run 必须只读');
});

// ================================================================
// 幂等（第五节 / 12.3 的硬性验收）
// ================================================================

/** 把一份计划"落地"到 state，并按需污染指纹 */
function applyPlanToState(state, planner, { staleFingerprint = false } = {}) {
    for (const rec of planner.records) {
        const parentId = rec.parentExtKey
            ? Object.values(state.nodes).find(n => n.extKey === rec.parentExtKey).id
            : state.rootId;
        putNode(state, `n_${rec.extKey}`, rec.type, parentId, {
            extKey: rec.extKey,
            importFingerprint: staleFingerprint ? 'fnv1a:stale' : rec.fingerprint,
            ...rec.fields
        });
    }
}

test('同一 crate 导两次 → 第二次全部 skip（收敛）', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } },
        { type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'QOJ Contest' } },
        { type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest', fields: { name: 'Round 4113' } },
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A' } },
        { type: 'P', extKey: 'qoj:4113:B', parentExtKey: 'qoj:4113', fields: { name: 'B' } }
    ]);

    const first = plan(crate, state);
    assert.equal(first.summary.create, 5);

    applyPlanToState(state, first);

    const second = plan(crate, state);
    assert.equal(second.summary.create, 0, '第二次不应再新建');
    assert.equal(second.summary.update, 0, '第二次不应更新');
    assert.equal(second.summary.skip, 5, '第二次应全部跳过');
});

test('指纹落后但无可写变化 → 仍判 skip', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } },
        { type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'QOJ Contest' } },
        { type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest', fields: { name: 'Round 4113' } },
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A' } }
    ]);
    const first = plan(crate, state);
    applyPlanToState(state, first, { staleFingerprint: true });

    const second = plan(crate, state);
    assert.equal(second.summary.create, 0, '不应新建');
    assert.equal(second.summary.update, 0, '内容一致，没有可写变化');
    assert.equal(second.summary.skip, 4);
});

// ================================================================
// 逐条拒绝（9.2 粒度）
// ================================================================

test('父节点两边都没有 → 该条 error，其余仍可执行', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'All Closed' } },
        { type: 'P', extKey: 'qoj:4113:B', parentExtKey: 'qoj:4113', fields: { name: 'Bread' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.errors, 2);
    assert.equal(p.summary.create, 0);
    assert.ok(p.errors.every(e => e.code === 'parent-not-found'));
});

test('同一 crate 内混合：可执行的照常执行，坏的单独报错', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } },
        { type: 'P', extKey: 'BAD:1', parentExtKey: 'nope', fields: { name: 'X' } },
        { type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'C' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.create, 2, 'W 与 S 应可执行');
    assert.equal(p.summary.errors, 1);
    assert.equal(p.errors[0].code, 'parent-not-found');
    assert.equal(p.errors[0].index, 1, '错误应指回原记录下标');
});

test('包内 extKey 重复 → 参与的两条都 error，且不重复计数', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'A' } },
        { type: 'W', extKey: 'qoj', fields: { name: 'B' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.errors, 2, '恰好两条，不能翻倍');
    assert.ok(p.errors.every(e => e.code === 'duplicate-extkey'));
});

test('父记录被拒 → 其子也逐条被拒（不产生悬挂节点）', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'S', extKey: 'gone', parentExtKey: 'nope', fields: { name: 'X' } },
        { type: 'C', extKey: 'qoj:1', parentExtKey: 'gone', fields: { name: 'Y' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.create, 0);
    assert.equal(p.summary.errors, 2, '父与子都应被拒');
});

// ================================================================
// 容器链约束（2.5）—— W 下不能直接放 C
// ================================================================

test('W 下直接放 C → **plan 阶段就拦下来**（预览与落地同一套判据）', () => {
    // ⚠️ 口径改了（2026-10-06）：以前这里写着"plan 不做父子类型校验（那是 upsert 的事）"，
    //    并把"plan 放行、落地才拒"当成**职责边界**钉住 —— 那不是边界，是**缺口**：
    //    预览报"错误 0、可写入 2"，点执行却逐条失败；`crate-check` 退出码 0 ⇒
    //    链上「0 错误才自动导入」那道闸门形同虚设（同一个判据在两处各判一次、结论相反）。
    //    现在 plan 用**同一份** `TYPE_CHILDREN_MAP` 预检，预览说几条就几条。
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } },
        { type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj', fields: { name: 'Round' } }
    ]);
    const p = plan(crate, state);
    assert.equal(p.summary.create, 1, 'W 照建；C 那条被预检拦下（父容器类型不允许）');
    assert.equal(p.summary.errors, 1);
    assert.equal(p.errors[0].code, 'bad-parent-type');
});

// ================================================================
// 相似度警告（4.6）—— 只提示，不判定
// ================================================================

test('key 不一致但题名相似 → 警告，且仍然 create', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });
    putNode(state, 'p1', 'P', 'c1', { extKey: 'qoj:4113:OLD', name: 'Two Sum', problemId: 'A' });

    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:NEW', parentExtKey: 'qoj:4113', fields: { name: 'Two Sums', problemId: 'B' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.summary.create, 1, '相似度绝不合并');
    const w = p.warnings.find(x => x.code === 'similar-title' || x.code === 'similar-key-conflict');
    assert.ok(w, `应产生相似度警告，实际警告：${JSON.stringify(p.warnings)}`);
    assert.ok(w.score >= 0.7, `相似度应过阈值，实际 ${w.score}`);
});

test('key 一致 + 内容相同 → skip，且无相似度噪音', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });

    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'Two Sum' } }
    ]);
    const probe = plan(crate, state);
    putNode(state, 'p1', 'P', 'c1', {
        extKey: 'qoj:4113:A',
        importFingerprint: probe.records[0].fingerprint,
        name: 'Two Sum'
    });

    const p = plan(crate, state);
    assert.equal(p.summary.skip, 1);
    assert.equal(p.summary.create, 0);
    assert.equal(p.warnings.filter(w => w.code.startsWith('similar')).length, 0);
});

// ================================================================
// 包内近似重复（4.7）
// ================================================================

test('同场近名但**题号不同**的两道题 → 不警告（真包 3362 条几乎全是这类误报）', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });

    // ⚠️ 这两条只是"名字像"：同一个父里**题号不同**就是两道题（`arc120 F` vs `F2`、
    //    `nk … p:I` vs `p:J` 那种形态）—— 按相似度报的话，实测 3216 条全是它。
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:X', parentExtKey: 'qoj:4113', fields: { name: 'Two Sum', problemId: 'F' } },
        { type: 'P', extKey: 'qoj:4113:Y', parentExtKey: 'qoj:4113', fields: { name: 'Two Sums', problemId: 'F2' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `题号不同 = 两道题，不该报，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.create, 2, '两道题照常新建');
});

test('★ 真信号一：同父 + **题号相同** 但 extKey 不同 → 警告（同一场里一个题号两个 key）', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:c1:X', parentExtKey: 'qoj:c1', fields: { name: 'Two Sum', problemId: 'A' } },
        { type: 'P', extKey: 'qoj:c1:X2', parentExtKey: 'qoj:c1', fields: { name: 'Two Sum', problemId: 'A' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.ok(p.warnings.find(w => w.code === 'intra-batch-duplicate'),
        `同一场里同一个题号出来两个 key —— 正是"爬虫 key 不稳定"，必须报，实际：${JSON.stringify(p.warnings)}`);
});

test('★ 同名不同题（`Wine Thief` F / F2 那种重发题刻意除外）→ 不警告，只计数', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    // AtCoder 的 `F` 与 `F2` **都叫 `Wine Thief`**（重发题）——实测真包剩的 3 条全是这种，
    // 合法 ⇒ "同名"不是信号，只有"同一个题号两个 key"才是。
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:c1:X', parentExtKey: 'qoj:c1', fields: { name: 'Wine Thief', problemId: 'F' } },
        { type: 'P', extKey: 'qoj:c1:Y', parentExtKey: 'qoj:c1', fields: { name: 'Wine Thief', problemId: 'F2' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `同名但题号不同 = 两道题（重发题），不该报，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 1, '压掉的配对数要计数，不能悄悄丢');
});

// ---- "只差序号"不报（编号系列的误报）----

/** W → S 骨架（C 必须挂在 S 下，W 下不能直接放 C） */
function putSkeleton(state, opts = {}) {
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:series', name: '系列' });
    if (opts.withContest) {
        putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:c1', name: opts.contestName || '联赛（1）' });
    }
}

test('包内只差序号的标题（联赛(1)/(2)）→ 不警告，只计数', () => {
    const state = makeState();
    putSkeleton(state);
    const crate = makeCrate([
        { type: 'C', extKey: 'qoj:c1', parentExtKey: 'qoj:series', fields: { name: '2026 暑期联赛（1）' } },
        { type: 'C', extKey: 'qoj:c2', parentExtKey: 'qoj:series', fields: { name: '2026 暑期联赛（2）' } },
        { type: 'C', extKey: 'qoj:c3', parentExtKey: 'qoj:series', fields: { name: '2026 暑期联赛（10）' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `只差序号不该刷屏，实际：${JSON.stringify(p.warnings)}`);
    // 3 场两两配对 = 3 对，全部被"只差序号"过滤
    assert.equal(p.summary.similaritySuppressed, 3, '被忽略的配对数要计数，不能悄悄丢');
    assert.equal(p.summary.create, 3, '仍然照常新建');
});

test('"多一个序号"也算只差序号（Slot Machine / Slot Machine 2）→ 不警告', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    const crate = makeCrate([
        { type: 'P', extKey: 'nk:c1:B', parentExtKey: 'qoj:c1', fields: { name: 'Slot Machine' } },
        { type: 'P', extKey: 'nk:c1:C', parentExtKey: 'qoj:c1', fields: { name: 'Slot Machine 2' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `续作只差一个序号，不该刷屏，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 1);
});

test('跨类型的相似不算包内重复（XCPC 的 W「XCPC」vs S「ICPC」）', () => {
    const state = makeState();
    const crate = makeCrate([
        { type: 'W', extKey: 'xcpc', fields: { name: 'XCPC' } },
        { type: 'S', extKey: 'xcpc:s:icpc', parentExtKey: 'xcpc', fields: { name: 'ICPC' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `平台与系列之间的相似是噪声，不该报，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 0, '不是"只差序号"压掉的，是跨类型不比');
});

test('★ 性质差异：包里判出来的与树上已有的不一致 ⇒ **报出来**，但不覆盖', () => {
    // 导入数据要能判断 nature 的差异。
    // 性质四字段的导入策略是 fill-if-empty（人手填过的值不该被一次重导冲掉）⇒
    // "包里判成 xcpc/icpc/ec/regional、树上写着 xcpc/icpc"这种事**悄悄地不发生**。
    // 这条钉住：① 差异逐字段报出来（带包里那条分类的依据规则）；② 树上空 / 包里空都不算差异；
    // ③ 报归报，**不覆盖**（fill-if-empty 一个字节都不写）。
    const state = makeState();
    putNode(state, 'c1', 'C', 'o', {
        extKey: 'xcpc:c:1', natureClass: 'xcpc/icpc', natureYear: '2023', natureRegion: '成都'
    });
    const crate = makeCrate([
        {
            type: 'C',
            extKey: 'xcpc:c:1',
            fields: {
                name: '甲站',
                natureClass: 'xcpc/icpc/ec/regional/official',
                natureYear: '2024',
                natureRegion: '成都',            // 一致 ⇒ 不算差异
                natureSeason: '2024'             // 树上空、包里判出来了 ⇒ **正常补全**，不算差异
            },
            raw: { 分类依据: { natureClass: 'qoj:path-icpc' } }
        }
    ]);
    const p = plan(crate, state);
    const rec = p.records.find(r => r.extKey === 'xcpc:c:1');

    assert.deepEqual(rec.natureDiff.map(d => d.field), ['natureClass', 'natureYear'],
        `只报"两边都非空且不同"的：${JSON.stringify(rec.natureDiff)}`);
    assert.deepEqual(rec.natureDiff[0],
        { field: 'natureClass', oldValue: 'xcpc/icpc', newValue: 'xcpc/icpc/ec/regional/official', rule: 'qoj:path-icpc' },
        '旧值 / 新值 / 依据规则都带上');
    assert.equal(p.summary.natureChanged, 1, '汇总里数一遍（预览那句"性质不一致 N 条"用它）');
    assert.equal('natureClass' in rec.fields, false, '★ 不覆盖：fill-if-empty 没写分类');
    assert.equal('natureYear' in rec.fields, false, '★ 不覆盖：年份也是 fill-if-empty');
    assert.equal(rec.fields.natureSeason, '2024', '★ 树上空的那个照常补上（差异 ≠ 补全）');

    // 树上没有这个节点 ⇒ 没有"差异"可言（全是新建）
    const fresh = plan(crate, makeState());
    assert.equal(fresh.summary.natureChanged, 0, '新建节点没有"与树上不一致"这回事');
    assert.deepEqual(fresh.records[0].natureDiff, [], '空数组（不是 undefined）');
});

test('★ 性质差异：分类只差**镜像前缀**不算不同，去掉前缀仍不同才报（口径只有 `sameNatureValue` 一份）', () => {
    // 病根：`plan/prepare.js` 的 `natureDiffOf` 自己写了一份**裸串比**（`before === after`），
    // 而"分类只差镜像前缀（`cf/gyms/…` / `qoj/…`）不算不同"这条口径在仓里**另有三处**
    // 都用 `core/synthPlan.js` 的 `sameNatureValue`（`synthConflicts` 的「组头待同步」、
    // `ops/synth.js` 的 `syncHeadNature`、产包侧 `synth-bind.mjs`）⇒ 只有这一处口径分叉：
    // 真包 27408 条 dry-run 里 50 处 / 50 个组头被报成不一致，**全部是 `natureClass`
    // 且去前缀后逐字相同** ⇒ 预览那句「🧬 性质不一致 N 条」大半是噪声。
    const state = makeState();
    // ① 树上带镜像前缀、包里不带（去前缀后逐字相同）⇒ **不算**差异
    putNode(state, 'c1', 'C', 'o', {
        extKey: 'cf:c:1', natureClass: 'cf/gyms/xcpc/ccpc/female/official'
    });
    // ② 真差异：去前缀后仍然不同 ⇒ **仍然算**
    putNode(state, 'c2', 'C', 'o', {
        extKey: 'xcpc:c:2', natureClass: 'xcpc/icpc'
    });
    const crate = makeCrate([
        {
            type: 'C', extKey: 'cf:c:1',
            fields: { name: '甲站', natureClass: 'xcpc/ccpc/female/official' }
        },
        {
            type: 'C', extKey: 'xcpc:c:2',
            fields: { name: '乙站', natureClass: 'cf/contest/div2' }
        }
    ]);
    const p = plan(crate, state);
    const mirror = p.records.find(r => r.extKey === 'cf:c:1');
    const real = p.records.find(r => r.extKey === 'xcpc:c:2');

    assert.deepEqual(mirror.natureDiff, [],
        `只差镜像前缀不算不同，实际：${JSON.stringify(mirror.natureDiff)}`);
    assert.equal(p.summary.natureChanged, 1,
        '★ 汇总里只该数"真差异"那一条（预览那句「性质不一致 N 条」用它）');
    assert.deepEqual(real.natureDiff.map(d => d.field), ['natureClass'],
        `去前缀后仍不同 ⇒ 照旧报出来：${JSON.stringify(real.natureDiff)}`);
    assert.deepEqual(real.natureDiff[0],
        { field: 'natureClass', oldValue: 'xcpc/icpc', newValue: 'cf/contest/div2', rule: '' },
        '报出来的还是**原始值**（旧值 / 新值都不做前缀裁剪，界面照着展示）');

    // 「以包里为准」也只覆盖**真差异**：镜像前缀那条不该产生任何写入
    const on = plan(crate, state, { forceNature: true });
    assert.equal(on.summary.natureForced, 1, '只有真差异那一处会被覆盖');
    const mirrorOn = on.records.find(r => r.extKey === 'cf:c:1');
    assert.equal('natureClass' in mirrorOn.fields, false, '★ 只差前缀 ⇒ 不覆盖（不把语义相同的串换掉）');
    assert.equal(mirrorOn.action, ACTION.SKIP, '没有别的要写 ⇒ skip');
});

test('性质差异用的字段名单 == `core/natureFields.js` 的 `NATURE_FIELD_KEYS`（plan 那层有意抄了一份）', () => {
    // plan 那层手抄那四个名字是为了能**不联网**在纯 Node 单测里跑（natureFields 顶部 await 读注册表）。
    // 两份不许漂：漏一个字段 = 那个字段的差异永远不会被报出来（静默）。
    // ⚠️ 这份名单在 `plan/prepare.js`（不在 `plan.js`）
    //    —— 测试盯的必须是它实际所在的那个文件。
    return import('../core/natureFields.js').then(({ NATURE_FIELD_KEYS }) => {
        const src = fs.readFileSync(
            path.join(ROOT, 'src', 'features', 'AutoImport', 'plan', 'prepare.js'), 'utf8');
        const m = src.match(/const NATURE_DIFF_KEYS = Object\.freeze\(\[([^\]]+)\]\)/);
        assert.ok(m, 'plan/prepare.js 里要能找到那份名单（改名了就把这条测试一起改）');
        const keys = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
        assert.deepEqual(keys, [...NATURE_FIELD_KEYS], '两份名单必须逐字相等（含顺序）');
    });
});

test('★ 「以包里为准」（forceNature）：**勾了才覆盖**，空值一律不碰，指纹不许吃掉它', () => {
    // 开关：默认只报不改；勾上 = 这一次导入用**包里的性质**覆盖树上的。
    const state = makeState();
    putNode(state, 'c1', 'C', 'o', {
        extKey: 'xcpc:c:1',
        natureClass: 'xcpc/icpc',
        natureYear: '2023',
        natureRegion: '成都'                      // 包里给的是空串 ⇒ **绝不能被抹掉**
    });
    const crate = makeCrate([
        {
            type: 'C',
            extKey: 'xcpc:c:1',
            fields: {
                name: '甲站',
                natureClass: 'xcpc/icpc/ec/regional/official',
                natureYear: '2024',
                natureRegion: ''
            }
        }
    ]);

    // ---- ① 默认（不勾）：只报不改 ----
    const off = plan(crate, state);
    const recOff = off.records.find(r => r.extKey === 'xcpc:c:1');
    assert.equal(recOff.natureDiff.length, 2, `报了分类与年份两处不同：${JSON.stringify(recOff.natureDiff)}`);
    assert.equal('natureClass' in recOff.fields, false, '默认不覆盖');
    assert.equal('natureRegion' in off.records[0].fields, false, '包里的空值本来就不算差异');
    assert.equal(off.summary.natureForced, 0, '没勾 ⇒ 0 处覆盖');
    assert.equal(off.records[0].action, ACTION.SKIP, '什么都没有要写 ⇒ skip');

    // ---- ② 勾上：差异里的**非空**值真的写进去，决策痕迹跟着改 ----
    const on = plan(crate, state, { forceNature: true });
    const recOn = on.records.find(r => r.extKey === 'xcpc:c:1');
    assert.equal(recOn.fields.natureClass, 'xcpc/icpc/ec/regional/official', '★ 分类被覆盖');
    assert.equal(recOn.fields.natureYear, '2024', '★ 年份被覆盖');
    assert.equal('natureRegion' in recOn.fields, false, '★ 空值不覆盖（不会把树上的地区抹掉）');
    assert.equal(on.summary.natureForced, 2, '汇总：2 处会被覆盖（界面那句话用它）');
    assert.deepEqual(recOn.natureDiff.map(d => d.forced === true), [true, true],
        '差异条目上带 `forced` 标记（界面的 tooltip 靠它说"本次会覆盖"）');
    assert.equal(recOn.action, ACTION.UPDATE, '有东西要写 ⇒ update');
    const dec = recOn.decisions.find(x => x.field === 'natureClass');
    assert.equal(dec.applied, true, '决策痕迹要跟着改（否则界面上写着"不覆盖"、字段却写进去了）');
    assert.match(dec.reason, /以包里为准/);

    // ---- ③ 指纹豁免：重导同一个包（指纹相同）时，勾上仍然要写 ----
    const state2 = makeState();
    putNode(state2, 'c1', 'C', 'o', {
        extKey: 'xcpc:c:1',
        natureClass: 'xcpc/icpc',
        importFingerprint: recOff.fingerprint        // = 这个包上次导进来的指纹
    });
    const skip = plan(crate, state2);
    assert.equal(skip.records[0].action, ACTION.SKIP, '（前提）指纹相同 ⇒ 整条 skip');
    const forced = plan(crate, state2, { forceNature: true });
    assert.equal(forced.records[0].action, ACTION.UPDATE,
        '★ 勾了「以包里为准」⇒ 指纹不许把它吃掉（"树上的值被人改过、包里没变"正是它要处理的事）');
    assert.equal(forced.records[0].fields.natureClass, 'xcpc/icpc/ec/regional/official', '确实写进去');
});

test('字段来源 是元列：不进业务字段，也不算「未使用字段」', () => {
    // 合成包（crate-merge）会写 `字段来源: {列名: 来源id}`。它**已经被用掉了**
    // （进了来源层），所以既不能当业务字段，也不能报"未使用字段"刷屏。
    const rec = {
        节点类型: 'P', extKey: 'x', name: 'A', ratio: '4.61',
        字段来源: { name: 'src-A', ratio: 'src-B' }
    };
    const mapped = applyFieldMap(rec, { name: 'name', ratio: 'ratio' },
        { reservedKeys: RESERVED_KEYS });

    assert.equal(Object.prototype.hasOwnProperty.call(mapped.fields, '字段来源'), false,
        '元列不能进业务字段');
    assert.equal((mapped.unmapped || []).includes('字段来源'), false,
        '元列不能算「未使用字段」');
    // 对照：真正没声明的列仍然要报（否则"未使用字段"这条功能就废了）
    const mapped2 = applyFieldMap({ name: 'A', 得分: '100' }, { name: 'name' },
        { reservedKeys: RESERVED_KEYS });
    assert.equal((mapped2.unmapped || []).includes('得分'), true, '未声明的业务列仍要报');
});

test('归认预览：**导入之前**计划里就能看到这批会认到谁', () => {
    // 为什么要在计划阶段算：映射没填对时，用户该在**点导入之前**就知道，
    // 而不是导完之后对着一堆不认识账户的值发呆。
    const state = makeState();
    state.accounts = {
        local: { id: 'local', name: '本机', mappings: [] },
        k1: { id: 'k1', name: '主号', mappings: [{ source: 'cf', field: 'handle', value: 'alice' }] }
    };
    const clueCrate = {
        crateVersion: 1, source: { id: 'cf' }, generatedAt: '', fieldMap: {}, fieldPolicies: {},
        records: [
            { 节点类型: 'W', extKey: 'w', name: 'W' },
            { 节点类型: 'S', extKey: 'w:s', 父extKey: 'w', name: 'S' },
            { 节点类型: 'C', extKey: 'w:s:c', 父extKey: 'w:s', name: 'C' },
            { 节点类型: 'P', extKey: 'w:s:c:A', 父extKey: 'w:s:c', name: 'A' },
            { 节点类型: 'R', extKey: 'w:s:c:A:r1', 父extKey: 'w:s:c:A', status: 'AC', time: 'T',
              账户线索: { source: 'cf', field: 'handle', value: 'alice' } },
            { 节点类型: 'R', extKey: 'w:s:c:A:r2', 父extKey: 'w:s:c:A', status: 'WA', time: 'T',
              账户线索: { source: 'cf', field: 'handle', value: '没登记过的号' } },
            { 节点类型: 'R', extKey: 'w:s:c:A:r3', 父extKey: 'w:s:c:A', status: 'TLE', time: 'T' }
        ]
    };

    const parsed = parseCrate(clueCrate);
    assert.equal(parsed.ok, true, `解析应成功：${JSON.stringify(parsed.errors)}`);

    const p = plan(parsed.crate, state);
    assert.equal(p.summary.accounts.matched, 1, '认出 1 条');
    assert.equal(p.summary.accounts.unmatched, 1, '填了但没匹配上 1 条');
    assert.equal(p.summary.accounts.noClue, 5,
        '「源没给线索」是逐记录数的：4 个容器（W/S/C/P）+ 1 条没线索的提交');
    assert.equal(p.records.find(r => r.extKey === 'w:s:c:A:r1').accountId, 'k1');
    assert.equal(p.records.find(r => r.extKey === 'w:s:c:A:r2').accountId, '', '认不出 → 空（客观）');
    assert.equal(p.records.find(r => r.extKey === 'w:s:c:A:r3').accountId, '');

    // 两个账户认领同一线索 → **不猜**，报冲突
    state.accounts.k2 = { id: 'k2', name: '小号', mappings: [{ source: 'cf', field: 'handle', value: 'alice' }] };
    const p2 = plan(parsed.crate, state);
    assert.equal(p2.summary.accounts.matched, 0);
    assert.equal(p2.summary.accounts.conflicts.length, 1);
    assert.deepEqual(p2.summary.accounts.conflicts[0].accounts.sort(), ['k1', 'k2']);
    assert.equal(p2.records.find(r => r.extKey === 'w:s:c:A:r1').accountId, '',
        '冲突时不认领（报出来，不猜）');
});

test('同场近名但题号不同（phi master / gcd master）→ **不**警告（相似度判据的误报形态）', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    // 差在字母上的相似会被相似度判据报出来；但它们**题号不同、题名也不同** ⇒ 就是同场里的两道题。
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:c1:X', parentExtKey: 'qoj:c1', fields: { name: 'phi master', problemId: 'C' } },
        { type: 'P', extKey: 'qoj:c1:Y', parentExtKey: 'qoj:c1', fields: { name: 'gcd master', problemId: 'F' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'intra-batch-duplicate').length, 0,
        `题号不同 = 两道题，不该报，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 1, '不是"只差序号"压掉的，是题号不同 ⇒ 计入压掉的配对');
});

test('与树上已有节点的相似（4.6）同样遵守"只差序号"规则', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    // 4.6 只比对 **P**（collectSiblingMap 只看题名），所以要造一道同场已有的题
    putNode(state, 'p1', 'P', 'c1', { extKey: 'qoj:c1:P1', name: '数组操作 1' });

    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:c1:P2', parentExtKey: 'qoj:c1', fields: { name: '数组操作 2' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.errors.length, 0, `不该有错误：${JSON.stringify(p.errors)}`);
    assert.equal(p.warnings.filter(w => w.code === 'similar-title'
        || w.code === 'similar-key-conflict').length, 0,
        `树上已有「数组操作 1」时，导入「数组操作 2」不该报相似，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 1);
});

test('与树上已有节点**只差字母**时仍然报（4.6 没有被一起放过）', () => {
    const state = makeState();
    putSkeleton(state, { withContest: true, contestName: '某场比赛' });
    putNode(state, 'p1', 'P', 'c1', { extKey: 'qoj:c1:P1', name: 'phi master' });

    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:c1:P2', parentExtKey: 'qoj:c1', fields: { name: 'gcd master' } }
    ]);
    const p = plan(crate, state);

    assert.ok(p.warnings.find(w => w.code === 'similar-title' || w.code === 'similar-key-conflict'),
        `差在字母上仍应提醒，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.similaritySuppressed, 0);
});

// ================================================================
// 未使用字段（决策 14）
// ================================================================

test('未映射的列名进 summary.unusedColumns（只记名）', () => {
    const state = makeState();
    // 手工构 raw：一条记录里既有已映射列，也有爬虫多给的未映射列
    const crate = {
        crateVersion: 1,
        source: { id: 'test' },
        generatedAt: '',
        fieldMap: { 题目名称: 'name' },
        fieldPolicies: {},
        records: [{
            index: 0,
            type: 'W',
            extKey: 'qoj',
            parentExtKey: '',
            raw: {
                extKey: 'qoj',
                题目名称: 'QOJ',
                得分: '100',
                内存: '40416kb',
                是否通过: false
            }
        }]
    };

    const p = plan(crate, state);
    assert.deepEqual(p.summary.unusedColumns, ['内存', '得分', '是否通过']);
    assert.equal(p.records[0].unusedColumns.length, 3);
    assert.equal(p.records[0].fields.name, 'QOJ', '已映射列仍要生效');
});

test('显式映射为 null 的列进 ignoredColumns，不进 unusedColumns', () => {
    const state = makeState();
    const crate = {
        crateVersion: 1,
        source: { id: 'test' },
        generatedAt: '',
        fieldMap: { 题目名称: 'name', 题目ID: null },
        fieldPolicies: {},
        records: [{
            index: 0,
            type: 'P',
            extKey: 'qoj:4113:20236',
            parentExtKey: '',
            raw: { extKey: 'qoj:4113:20236', 题目名称: 'All Closed', 题目ID: '20236' }
        }]
    };

    const p = plan(crate, state);
    assert.deepEqual(p.records[0].ignoredColumns, ['题目ID']);
    assert.deepEqual(p.summary.unusedColumns, []);
    assert.equal(p.records[0].fields.name, 'All Closed');
});

test('结构键不会被误记成未使用字段', () => {
    const state = makeState();
    const crate = makeCrate([{ type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } }]);
    const p = plan(crate, state);
    assert.ok(!p.summary.unusedColumns.includes('节点类型'));
    assert.ok(!p.summary.unusedColumns.includes('父extKey'));
    assert.ok(!p.summary.unusedColumns.includes('extKey'));
});

// ================================================================
// 策略生效（6.2 / 6.3）
// ================================================================

test('已存在节点的 link / tags / remark 不被写入', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });
    putNode(state, 'p1', 'P', 'c1', {
        extKey: 'qoj:4113:A', name: 'Two Sum', link: 'old-link', tags: ['mine'], remark: '我的题解'
    });

    const crate = makeCrate([
        {
            type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113',
            fields: { name: 'Two Sum New', link: 'new-link', tags: ['theirs'], remark: '爬虫的话' }
        }
    ]);
    const p = plan(crate, state);
    const rec = p.records[0];

    assert.equal(rec.fields.link, undefined, 'link 是 fill-if-empty，原值非空 ⇒ 不覆盖');
    assert.equal(rec.fields.tags, undefined, 'tags 对已存在节点是 never');
    assert.equal(rec.fields.remark, undefined, 'remark 永远不写');
    assert.equal(rec.fields.name, undefined, 'name 是 fill-if-empty，原值非空 ⇒ 不覆盖');
    assert.equal(rec.action, ACTION.SKIP, '没有可写变化 ⇒ skip');
});

test('已存在节点**链接为空**时，link 会被补上（fill-if-empty）', () => {
    // 背景：早期导入的比赛节点没有链接（适配器那时不写 link）。
    // 若 link 是 never，重导也补不上，只能逐个手贴或删了重导。
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113', link: '' });

    const crate = makeCrate([
        {
            type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest',
            fields: { name: 'Round 4113', link: 'https://qoj.ac/contest/4113' }
        }
    ]);
    const p = plan(crate, state);
    const rec = p.records[0];

    assert.equal(rec.action, ACTION.UPDATE);
    assert.equal(rec.fields.link, 'https://qoj.ac/contest/4113', '空链接应被补上');
});

test('新节点则按 CREATE 表写入（含 tags/remark 之外的字段）', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });

    const crate = makeCrate([
        {
            type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113',
            fields: { name: 'Two Sum', link: 'u', tags: ['dp'], remark: '不该被写' }
        }
    ]);
    const p = plan(crate, state);
    const rec = p.records[0];

    assert.equal(rec.action, ACTION.CREATE);
    assert.equal(rec.fields.name, 'Two Sum');
    assert.equal(rec.fields.link, 'u', '新建时 link 用 CREATE 表');
    assert.deepEqual(rec.fields.tags, ['dp'], '新建时 tags 用 CREATE 表');
    assert.equal(rec.fields.remark, undefined, 'remark 新建时也不写');
});

test('缺失字段绝不写空（6.3）', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round 4113' });
    putNode(state, 'p1', 'P', 'c1', {
        extKey: 'qoj:4113:A', name: 'Two Sum', problemId: 'A', cfDifficulty: 1500, link: 'keep-me'
    });

    // 记录里只有题号且为空串——绝不能因此清空已有值
    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { problemId: '' } }
    ]);
    const p = plan(crate, state);
    const rec = p.records[0];

    assert.equal(rec.fields.cfDifficulty, undefined, '缺失字段不应出现');
    assert.equal(rec.fields.link, undefined, '缺失字段不应出现');
    assert.equal(rec.fields.problemId, undefined, 'fill-if-empty 遇到非空原值不覆盖');
});

// ================================================================
// 真实样本（qoj_problems.json / qoj_submissions.json）
// ================================================================

test('真实样本 qoj_problems.json 经适配+解析后可全部执行', () => {
    const sample = readSample('qoj_problems.json');
    assert.ok(Array.isArray(sample), '样本应为数组');
    assert.equal(sample.length, 12, '样本应有 12 道题');

    // 真实路径：adapter 归一结构 → parseCrate 归一记录
    const converted = qojToCrate(sample);
    assert.equal(converted.ok, true, `适配应成功：${JSON.stringify(converted.errors)}`);
    const parsed = parseCrate(converted.crate);
    assert.equal(parsed.ok, true, `解析应成功：${JSON.stringify(parsed.errors)}`);

    const state = makeState();
    const p = plan(parsed.crate, state);

    assert.equal(p.summary.errors, 0, `不应有错误：${JSON.stringify(p.errors)}`);
    // W + S(比赛分组) + C + 12 P
    assert.equal(p.summary.create, 15, 'W + S + C + 12 道题');
    assert.equal(p.records.filter(r => r.type === 'P').length, 12);

    const first = p.records.find(r => r.extKey === 'qoj:4113:20236');
    assert.ok(first, '应产出 qoj:4113:20236');
    assert.equal(first.fields.name, 'All Closed');
    assert.equal(first.fields.problemId, 'A');
    assert.equal(first.fields.link, 'https://qoj.ac/contest/4113/problem/20236');

    // 比赛分组必须存在，否则 W→C 非法（2.5）
    assert.ok(p.records.some(r => r.type === 'S' && r.extKey === 'qoj:contest'), '必须有 S 层');
    assert.equal(p.records.find(r => r.extKey === 'qoj:4113').parentExtKey, 'qoj:contest');
    assert.equal(p.records.find(r => r.extKey === 'qoj:4113:20236').parentExtKey, 'qoj:4113');
});

test('真实样本 qoj_problems.json 导两次 → 收敛', () => {
    const parsed = parseCrate(qojToCrate(readSample('qoj_problems.json')).crate);
    const state = makeState();

    const first = plan(parsed.crate, state);
    applyPlanToState(state, first);

    const second = plan(parsed.crate, state);
    assert.equal(second.summary.create, 0);
    assert.equal(second.summary.update, 0);
    assert.equal(second.summary.skip, first.summary.create);
});

test('回归：合法的扁平 extKey 约定不产生 key-* 警告', () => {
    // 背景：本设计**从不要求前缀嵌套**（3.4 的推荐拼法本身就是扁平的），
    // 要求"子 key 必须以 父key+':' 开头"就会在完全正确的 qoj 数据上大量误报：
    //     qoj:4113        父 qoj:contest
    //     qoj:sub:2951241 父 qoj:4113:20244
    // 这条用例把"不误报"钉死。
    const parsed = parseCrate(qojToCrate(readSample('qoj_problems.json')).crate);
    assert.equal(parsed.ok, true);

    const p = plan(parsed.crate, makeState());
    const keyWarnings = p.warnings.filter(w => String(w.code).startsWith('key-'));
    assert.deepEqual(keyWarnings, [],
        `合法数据不应产生 key-* 警告，实际：${JSON.stringify(keyWarnings)}`);
});

test('前缀写法漂移仍会被提示（但只是提示，不影响执行）', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 'c1', 'C', 'w1', { extKey: 'qoj:4113', name: 'Round' });

    const crate = makeCrate([
        { type: 'P', extKey: 'qoj:4113:20236', parentExtKey: 'qoj:4113', fields: { name: 'A' } },
        { type: 'P', extKey: 'qoj:prob:20237', parentExtKey: 'qoj:4113', fields: { name: 'B' } }
    ]);
    const p = plan(crate, state);

    const drift = p.warnings.find(w => w.code === 'key-mixed-prefix');
    assert.ok(drift, `应提示前缀漂移，实际：${JSON.stringify(p.warnings)}`);
    assert.equal(p.summary.create, 2, '提示不影响执行');
    assert.equal(p.summary.errors, 0);
});

test('真实样本 qoj_submissions.json 的提交可挂到题目下', (t) => {
    if (!hasSample('qoj_submissions.json')) {
        t.skip('acm-data/raw/qoj_submissions.json 不在（个人提交导出 —— 发出去之前会清掉，这里 skip 不是红）');
        return;
    }
    const sample = readSample('qoj_submissions.json');
    assert.ok(Array.isArray(sample));
    assert.equal(sample.length, 3);

    const converted = qojToCrate(sample);
    assert.equal(converted.ok, true, `适配应成功：${JSON.stringify(converted.errors)}`);
    const parsed = parseCrate(converted.crate);
    assert.equal(parsed.ok, true, `解析应成功：${JSON.stringify(parsed.errors)}`);

    const state = makeState();
    const p = plan(parsed.crate, state);

    assert.equal(p.summary.errors, 0, `不应有错误：${JSON.stringify(p.errors)}`);
    const rs = p.records.filter(x => x.type === 'R');
    assert.equal(rs.length, 3);

    const ac = rs.find(x => x.extKey === 'qoj:sub:2951241');
    assert.ok(ac, '应产出 qoj:sub:2951241');
    assert.equal(ac.fields.status, 'AC');
    assert.equal(ac.parentExtKey, 'qoj:4113:20244', '提交应挂到题目下');
    assert.equal(rs.find(x => x.extKey === 'qoj:sub:2951231').fields.status, 'WA');
    assert.equal(rs.find(x => x.extKey === 'qoj:sub:2951230').fields.status, 'TLE');

    // 提交的父题目必须由适配器补齐，否则整条会被拒（2.3）
    assert.ok(p.records.some(x => x.type === 'P' && x.extKey === 'qoj:4113:20244'), '应补出父题目');

    // 账户线索：`提交者` 是元列（不是"未使用字段"），随记录进计划
    // （值取自样本自己 —— 样本是个人提交导出，里面写的是谁就是谁）
    const src = sample.find(x => x['提交ID'] === '2951241') || sample[0];
    assert.deepEqual(ac.accountClue, { source: 'qoj', field: '提交者', value: src['提交者'] },
        '提交者应写成账户线索元列');
    assert.equal(Object.prototype.hasOwnProperty.call(ac.fields, '提交者'), false,
        '提交者不是业务字段');
    assert.equal((ac.unusedColumns || []).includes('提交者'), false,
        '提交者已被用掉 → 不该报「未使用字段」');
    assert.equal(p.summary.unusedColumns.includes('提交者'), false, '整包摘要里也不该有它');
});

test('R 的 status 能从 PD 更新为 AC（6.2 的 R 例外）', () => {
    const state = makeState();
    putNode(state, 'w1', 'W', 'o', { extKey: 'qoj', name: 'QOJ' });
    putNode(state, 's1', 'S', 'w1', { extKey: 'qoj:contest', name: 'Contest' });
    putNode(state, 'c1', 'C', 's1', { extKey: 'qoj:4113', name: 'Round' });
    putNode(state, 'p1', 'P', 'c1', { extKey: 'qoj:4113:20244', name: 'Island' });
    putNode(state, 'r1', 'R', 'p1', { extKey: 'qoj:sub:1', status: 'PD', time: '2026.09.13 22:06' });

    const crate = makeCrate([
        { type: 'R', extKey: 'qoj:sub:1', parentExtKey: 'qoj:4113:20244', fields: { status: 'AC' } }
    ]);
    const p = plan(crate, state);

    assert.equal(p.records[0].action, ACTION.UPDATE);
    assert.equal(p.records[0].fields.status, 'AC', 'PD → AC 必须能更新');
});
