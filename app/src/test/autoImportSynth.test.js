// ================================================================
// 导入导出：合成节点与成员指针（features/AutoImport）
//
// 依据：docs/manual-workflow.md（合成节点）· docs/auto-import.md（导入导出）
//   · 包格式能表达"这条记录是合成节点"（**没有 extKey**，身份是 synthKey）
//   · 两阶段解析：先建/更新合成节点，再落成员指针；**这一批才建的合成节点不算悬空**
//   · 预览两项计数（新建/更新合成节点 N、设置成员指针 M）+ 被拒绝的指针改动
//   · 树上已有的非空指针**不被包覆盖**（never 口径），差异出现在预览里
//   · 新字段默认 overwrite-if-changed：值相同不写、不碰 lastModified；值不同才写
//   · `synthKey`/`ownerSynth` **不进来源层**（它们是结构，不是"某账户看到的值"）
//
// 覆盖方式：parse → plan → apply（`apply.js` 事务体的**纯等价组合**：
// upsertRecord + applySynthPart）。全程纯 Node；需要 DOM 的那一段
// （导出存档 → 再导入）在 `scripts/smoke/import-synth.smoke.mjs`。
//
// ⚠️ 夹具的父子关系必须合法（`TYPE_CHILDREN_MAP`）：`O → S → C`（W 下不能直接放 C），
//    否则 `upsertRecord` 会以 `bad-parent-type` 拒绝，测的就不是本模块了。
// ================================================================
import { test } from 'node:test';
import { isExpanded } from '../core/model/viewState.js';
import assert from 'node:assert/strict';

import { parseCrate } from '../features/AutoImport/parse.js';
import { buildPlan } from '../features/AutoImport/plan.js';
import { applyFieldMap, RESERVED_KEYS } from '../features/AutoImport/fieldmap.js';
import { applySynthPart } from '../features/AutoImport/synthApply.js';
import { upsertRecord, buildExtKeyIndex, isWritableField } from '../core/ops/upsert.js';
import { findDanglingOwners } from '../core/ops/synth.js';
// ★ 2026-10-18 起**事务里不再写 `draft.parentOf`**（派生索引，提交时由 `applyState` 重建）
//   ⇒ 断言"挂在谁下面"走这条读口（与 ops 里同一份：`ops/_helpers.js:parentOfInDraft`）。
import { parentOfInDraft } from '../core/ops/_helpers.js';
import { WRITABLE_FIELDS } from '../features/AutoImport/constants.js';
import { createNode } from '../core/model/node.js';

const RESERVED = RESERVED_KEYS;   // `type` 已在其中（M11）
/** 与 plan.js 内部注入的实现一致（列名 → 内部字段名） */
const afm = (record, fieldMap) => applyFieldMap(record, fieldMap, { reservedKeys: RESERVED });

// ================================================================
// 造数据
// ================================================================

/** 只含根节点的 state/draft（plan 只读 nodes/childOrder/parentOf，apply 会写） */
function makeDraft() {
    return {
        rootId: 'o',
        nodes: { o: { id: 'o', type: 'O', name: '根', extKey: '', values: {} } },
        childOrder: { o: [] },
        parentOf: { o: null },
        view: { expanded: {} },   // 展开态（不在节点上）
        meta: { idCounter: 0 },
        sources: {},
        trust: { sources: {}, categoryRank: [], fieldPrefer: {}, groupPrefer: {} },
        accounts: {}
    };
}

/** 在 draft 里放一个节点（模拟"树上已有"） */
function put(draft, id, type, parentId, extra = {}) {
    const node = createNode(id, type, { name: extra.name !== undefined ? extra.name : id, ...extra });
    node.values = extra.values || {};
    draft.nodes[id] = node;
    if (!draft.childOrder[id]) draft.childOrder[id] = [];
    draft.childOrder[parentId].push(id);
    draft.parentOf[id] = parentId;
    return node;
}

/** 一个 S 容器（extKey `p`），下面挂 C —— 合法的最小骨架 */
function withContainer(draft) {
    return put(draft, 's1', 'S', 'o', { extKey: 'p', name: '系列' });
}

/**
 * 造一份 crate（列名 = 内部字段名，恒等 fieldMap）。
 * 合成节点记录**不给 extKey**，给 synthKey —— 这正是包格式要能表达的形态。
 */
function makeCrate(records, { source = { id: 'synth-fixture' }, fieldPolicies = {} } = {}) {
    const columns = new Set();
    for (const r of records) {
        for (const k of Object.keys(r.fields || {})) columns.add(k);
        if (r.synthKey) columns.add('synthKey');
    }
    const fieldMap = {};
    for (const c of columns) fieldMap[c] = c;

    const raw = records.map((r) => {
        const rec = { 节点类型: r.type };
        if (r.extKey) rec.extKey = r.extKey;
        if (r.synthKey) rec.synthKey = r.synthKey;
        if (r.parentExtKey) rec['父extKey'] = r.parentExtKey;
        // 父引用的**另一种写法** —— 父是合成节点时用它（身份是 synthKey）
        if (r.parentSynthKey) rec['父synthKey'] = r.parentSynthKey;
        for (const [k, v] of Object.entries(r.fields || {})) rec[k] = v;
        return rec;
    });

    // ⚠️ crate 的策略声明在 `defaults.fieldPolicies`（parse.js 从这里读，
    //    与 docs/auto-import.md 的包形状一致 —— 顶层 `fieldPolicies` 只有直连
    //    buildPlan 的测试才认）。
    return {
        crateVersion: 1,
        source,
        generatedAt: '',
        fieldMap,
        defaults: { fieldPolicies },
        records: raw
    };
}

/** 造计划（走真实 parse → buildPlan） */
function planOf(data, draft) {
    const parsed = parseCrate(data, { applyFieldMap: afm });
    assert.equal(parsed.ok, true, `crate 解析失败：${JSON.stringify(parsed.errors)}`);
    const plan = buildPlan({
        crate: parsed.crate,
        state: draft,
        keyIndex: buildExtKeyIndex(draft),
        applyFieldMap: afm
    });
    return { parsed, plan };
}

/** `apply.js` 事务体里的**纯等价组合**（普通记录 + 两阶段合成） */
function applyPlan(draft, plan) {
    const index = buildExtKeyIndex(draft);
    for (const rec of plan.records) {
        upsertRecord(draft, {
            type: rec.type,
            extKey: rec.extKey,
            parentExtKey: rec.parentExtKey,
            fields: rec.fields
        }, index, { allowedFields: WRITABLE_FIELDS });
    }
    return applySynthPart(draft, plan.synth, { index, rootId: draft.rootId });
}

const byExtKey = (draft, key) => Object.values(draft.nodes).find(n => n && n.extKey === key);
const bySynthKey = (draft, key) => Object.values(draft.nodes).find(n => n && n.synthKey === key);

/** 一个"系列 + 两个合成节点 + 一个带指针的成员"的最小包 */
function fullCrate() {
    return makeCrate([
        { type: 'S', extKey: 'p', fields: { name: '系列' } },
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '浙江省赛', ownerSynth: 'synth:zj' } },
        // 合成节点：**没有 extKey**
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '浙江省赛（合成）' } },
        { type: 'C', synthKey: 'synth:other', parentExtKey: 'p', fields: { name: '别的（合成）' } }
    ]);
}

// ================================================================
// 1. 入口：两个字段必须**不被** PROTECTED_NODE_KEYS 挡住
// ================================================================
test('synthKey / ownerSynth 是可导入字段（没有落进受保护名单）', () => {
    assert.equal(isWritableField('synthKey'), true,
        'synthKey 必须可由导入写入（它不在 structuralElements() 里）');
    assert.equal(isWritableField('ownerSynth'), true,
        'ownerSynth 必须可由导入写入（§四：包可以带成员指针）');
    assert.equal(WRITABLE_FIELDS.includes('synthKey'), true, 'synthKey 在可写白名单里');
    assert.equal(WRITABLE_FIELDS.includes('ownerSynth'), true, 'ownerSynth 在可写白名单里');
    // 对照：结构字段仍然被挡住（放行是有边界的，不是把闸门打开）
    assert.equal(isWritableField('extKey'), false, 'extKey 仍是受保护的结构字段');
    assert.equal(isWritableField('id'), false, 'id 仍是受保护的结构字段');
});

// ================================================================
// 2. 包格式：合成节点记录没有 extKey，但有 synthKey ⇒ 合法
// ================================================================
test('parse：没有 extKey 但有 synthKey 的记录是合法的合成节点记录', () => {
    const parsed = parseCrate(makeCrate([
        { type: 'C', synthKey: 'synth:k1', fields: { name: '合成' } }
    ]), { applyFieldMap: afm });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.errors.length, 0, `不该报错：${JSON.stringify(parsed.errors)}`);
    assert.equal(parsed.crate.records.length, 1, '合成节点记录被保留（不因缺 extKey 剔除）');
    assert.equal(parsed.crate.records[0].extKey, '', '它确实没有 extKey');
    assert.equal(parsed.crate.records[0].synthKey, 'synth:k1', '身份从 synthKey 读出');
});

test('parse：两个身份都没有 ⇒ 仍然逐条拒绝（4.4 不放宽）', () => {
    const parsed = parseCrate(makeCrate([
        { type: 'C', fields: { name: '既没有 extKey 也没有 synthKey' } }
    ]), { applyFieldMap: afm });

    assert.equal(parsed.crate.records.length, 0, '无身份键的记录不进 records');
    assert.equal(parsed.errors[0].code, 'missing-extkey');
});

test('plan：同时带 extKey 与 synthKey ⇒ 逐条报错、不导入（不猜用户想表达哪种）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c', synthKey: 'synth:bad', parentExtKey: 'p', fields: { name: '矛盾' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.records.some(r => r.extKey === 'p:c'), false, '矛盾的记录不进计划');
    assert.equal(plan.summary.synthNodes, 0, '也不当成合成节点');
    assert.ok(plan.errors.some(e => e.code === 'synthkey-with-extkey'),
        `应报 synthkey-with-extkey：${JSON.stringify(plan.errors)}`);
});

// ================================================================
// 3. 预览两项计数 + 两阶段解析（这一批新建的合成节点不算悬空）
// ================================================================
test('预览：出现「新建/更新合成节点 N」「设置成员指针 M」两项计数', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '浙江省赛', ownerSynth: 'synth:zj' } },
        { type: 'C', extKey: 'p:c2', parentExtKey: 'p', fields: { name: '浙江省赛（榜单）', ownerSynth: 'synth:zj' } },
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '浙江省赛（合成）' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthCreate, 1, '新建合成节点 1');
    assert.equal(plan.summary.synthUpdate, 0, '没有要更新的合成节点');
    assert.equal(plan.summary.synthNodes, 1, 'N = 新建/更新合成节点 1');
    assert.equal(plan.summary.pointerSet, 2, 'M = 设置成员指针 2');
    assert.equal(plan.summary.pointerRejected, 0, '没有因 never 被拒的指针改动');
    assert.equal(plan.summary.pointerDangling, 0, '包内新建的合成节点**不算悬空**');
    assert.equal(plan.synth.nodes[0].action, 'create', '合成节点进第一阶段清单');
    assert.equal(plan.synth.nodes[0].synthKey, 'synth:zj');
    assert.deepEqual(plan.synth.pointers.map(p => p.action), ['set', 'set'], '两条指针都待设置');
    assert.equal(plan.records.length, 2, '合成节点记录**不在** plan.records 里（走两阶段通道）');
});

test('落地：合成节点先建、指针后落（包内新建的目标不算悬空）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '浙江省赛', ownerSynth: 'synth:zj' } },
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '浙江省赛（合成）' } }
    ]);
    const { plan } = planOf(data, draft);
    const res = applyPlan(draft, plan);

    assert.equal(res.failed.length, 0, `不该有失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.created, 1, '合成节点建出来了');
    assert.equal(res.pointersSet, 1, '指针也落了');
    const synth = bySynthKey(draft, 'synth:zj');
    assert.ok(synth, '树上找得到它（按 synthKey）');
    assert.equal(draft.nodes[byExtKey(draft, 'p:c1').id].ownerSynth, 'synth:zj', '指针指向它');
});

test('★ 目标不存在 ⇒ 该条指针被拒绝：预览进计数，落库后树上没有这个指针', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:missing' } }
    ]);
    const { plan } = planOf(data, draft);

    // 写路径铁律：悬空指针不能由操作产生。
    assert.equal(plan.summary.pointerSet, 0, '不写（不落成单元素组）');
    assert.equal(plan.summary.pointerRejected, 1, '进预览"被拒绝"那一项');
    assert.equal(plan.summary.pointerDangling, 1, '并被认成"目标不可解析"');
    const entry = plan.synth.pointers[0];
    assert.equal(entry.action, 'reject', '与 same / set / reject 同构的状态');
    assert.equal(entry.dangling, true);
    assert.ok(/悬空/.test(entry.reason) && /synth:missing/.test(entry.reason),
        `预览文案要写清指向了哪个标识、为什么被拒：${entry.reason}`);
    // 历史坏数据的可见性由读路径负责 —— 导入这一步不产出 'dangling-owner' 警告
    assert.equal(plan.warnings.some(w => w.code === 'dangling-owner'), false,
        '写路径拒绝，不落"照常写入"的警告');

    const res = applyPlan(draft, plan);
    assert.equal(res.pointersSet, 0, '落地时也没写');
    assert.equal(res.pointersRejected, 1, '落地时同样算"被拒绝"');
    assert.equal(byExtKey(draft, 'p:c1').ownerSynth, '', '★ 树上没有这个指针（没落库）');
});

test('★ 指针写的是节点 id ⇒ 该条被拒绝，文案点名"要写 synthKey"', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'sx', 'C', s1.id, { synthKey: 'synth:zj', name: '已有合成' });

    const data = makeCrate([
        // ← 写的是**节点 id** `sx`，不是它的 synthKey
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'sx' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.pointerSet, 0);
    assert.equal(plan.summary.pointerRejected, 1);
    const entry = plan.synth.pointers[0];
    assert.equal(entry.action, 'reject');
    assert.ok(/节点 id/.test(entry.reason) && /synth:zj/.test(entry.reason),
        `文案要说清"写的是节点 id，应写 synth:zj"：${entry.reason}`);

    applyPlan(draft, plan);
    assert.equal(draft.nodes[byExtKey(draft, 'p:c1').id].ownerSynth, '', '树上一个字节都没写');
});

test('树上已有的合成节点也是已知目标（不误判悬空）', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'sx', 'C', s1.id, { synthKey: 'synth:exists', name: '已有的合成节点' });

    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:exists' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.pointerSet, 1);
    assert.equal(plan.summary.pointerDangling, 0, '树上已有的合成节点算已知目标');
});

// ================================================================
// 4. never 口径：树上已有的（非空）指针不被包覆盖 + 预览报告差异
// ================================================================
test('树上已有的非空指针不被覆盖，差异出现在预览里（pointerRejected）', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'sxA', 'C', s1.id, { synthKey: 'synth:old', name: '老合成' });
    put(draft, 'sxB', 'C', s1.id, { synthKey: 'synth:new', name: '新合成' });
    const member = put(draft, 'c1', 'C', s1.id, { extKey: 'p:c1', name: '甲', ownerSynth: 'synth:old' });
    member.lastModified = '2026-01-01 00:00';

    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:new' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.pointerSet, 0, '不设置（包不得覆盖已有指针）');
    assert.equal(plan.summary.pointerRejected, 1, '差异被单独计数');
    const entry = plan.synth.pointers[0];
    assert.equal(entry.action, 'reject');
    assert.equal(entry.current, 'synth:old', '预览里带上树上的现值');
    assert.equal(entry.synthKey, 'synth:new', '以及包里想改成的值');
    assert.ok(/never/.test(entry.reason), `理由要提到 never 口径：${entry.reason}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.pointersRejected, 1, '落地时同样算"被拒绝"');
    assert.equal(draft.nodes.c1.ownerSynth, 'synth:old', '★ 导入之后指针一个字节都没动');
    assert.equal(draft.nodes.c1.lastModified, '2026-01-01 00:00', '被拒绝的指针改动不碰 lastModified');
});

test('树上空着的指针会被包写上（否则"包能带指针"对已存在节点等于没用）', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'sx', 'C', s1.id, { synthKey: 'synth:zj', name: '合成' });
    put(draft, 'c1', 'C', s1.id, { extKey: 'p:c1', name: '甲', ownerSynth: '' });

    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:zj' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.pointerSet, 1, '空着的指针照写');
    assert.equal(plan.summary.pointerRejected, 0);
    const res = applyPlan(draft, plan);
    assert.equal(res.pointersSet, 1);
    assert.equal(draft.nodes.c1.ownerSynth, 'synth:zj');
});

// ================================================================
// 5. overwrite-if-changed：值相同不写、不碰 lastModified；值不同才写
// ================================================================
test('指针值相同 ⇒ 不动，且不碰 lastModified', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'sx', 'C', s1.id, { synthKey: 'synth:zj', name: '合成' });
    const c1 = put(draft, 'c1', 'C', s1.id, { extKey: 'p:c1', name: '甲', ownerSynth: 'synth:zj' });
    c1.lastModified = '2026-01-01 00:00';

    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:zj' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.synth.pointers[0].action, 'same', '值相同 → same');
    assert.equal(plan.summary.pointerSet, 0);
    const res = applyPlan(draft, plan);
    assert.equal(res.pointersSet, 0);
    assert.equal(draft.nodes.c1.ownerSynth, 'synth:zj');
    assert.equal(draft.nodes.c1.lastModified, '2026-01-01 00:00', '★ 没写就不碰 lastModified');
});

test('合成节点：值不同才写（overwrite-if-changed）；没变则跳过且不碰 lastModified', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    const sx = put(draft, 'sx', 'C', s1.id, { synthKey: 'synth:zj', name: '旧名字' });
    sx.lastModified = '2026-01-01 00:00';

    // C 节点上 name 的"已存在"默认策略是 fill-if-empty（存量保护），
    // 这里用包内声明把它显式改成 overwrite-if-changed —— 正是"值不同才写"那条口径。
    const renamed = makeCrate([
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '新名字' } }
    ], { fieldPolicies: { name: 'overwrite-if-changed' } });

    const p1 = planOf(renamed, draft).plan;
    assert.equal(p1.summary.synthUpdate, 1, '名字变了 → 更新');
    assert.equal(p1.synth.nodes[0].nodeId, 'sx', '按 synthKey 认人（不是 extKey）');
    applyPlan(draft, p1);
    assert.equal(draft.nodes.sx.name, '新名字', '新名字写进去了');
    assert.notEqual(draft.nodes.sx.lastModified, '2026-01-01 00:00', '写过了 → lastModified 更新');
    assert.equal(draft.nodes.sx.synthKey, 'synth:zj', '身份不变');

    draft.nodes.sx.lastModified = '2026-02-02 00:00';
    const p2 = planOf(renamed, draft).plan;
    assert.equal(p2.summary.synthNodes, 0, '值相同 → 跳过重建/更新');
    assert.equal(p2.summary.synthSkip, 1, '记一条"跳过合成"');
    const res = applyPlan(draft, p2);
    assert.equal(res.updated, 0);
    assert.equal(draft.nodes.sx.name, '新名字');
    assert.equal(draft.nodes.sx.lastModified, '2026-02-02 00:00', '★ 没写就不碰 lastModified');
});

test('同一份包导两次收敛：第二次没有任何写入', () => {
    const draft = makeDraft();
    const data = fullCrate();
    const { plan: p1 } = planOf(data, draft);
    const r1 = applyPlan(draft, p1);
    assert.equal(r1.failed.length, 0, `第一次不该有失败：${JSON.stringify(r1.failed)}`);
    assert.equal(r1.created, 2, '两个合成节点建出来了');

    const { plan: p2 } = planOf(data, draft);
    assert.equal(p2.summary.create, 0, '第二次不新建');
    assert.equal(p2.summary.synthNodes, 0, '第二次不建/不改合成节点');
    assert.equal(p2.summary.pointerSet, 0, '第二次不设指针');
    assert.equal(p2.summary.pointerRejected, 0, '也不产生被拒的指针改动');
    assert.equal(p2.summary.pointerDangling, 0);
    const r2 = applyPlan(draft, p2);
    assert.equal(r2.created + r2.updated + r2.pointersSet, 0, '第二次什么都没写');
});

test('★ 合成节点"这一轮不用建"时不许报失败（"失败 179"那种）', () => {
    // 病根：`applySynthPart` 阶段 1 那个多轮循环**只 splice `create` 条目**
    //   ⇒ update / skip 的条目会一直留在 `remaining` 里，然后被末尾那段"父合成节点不存在"的
    //   兜底逐个报成失败 —— 干活其实全干成了（下面的 update 分支照跑），
    //   导入摘要却写着"失败 179"（**重导一次必现**）。
    const draft = makeDraft();
    withContainer(draft);
    const data = fullCrate();
    const { plan: p1 } = planOf(data, draft);
    assert.equal(applyPlan(draft, p1).created, 2, '第一次建出两个合成节点');

    // 同一份包再导一次：合成节点这时"已经在树上、值也一样" ⇒ 计划里是 **skip** 条目
    const { plan: p2 } = planOf(data, draft);
    assert.equal(p2.synth.nodes.length, 2, '计划里仍然有这两条合成条目（只是不用建）');
    assert.deepEqual(p2.synth.nodes.map((e) => e.action), ['skip', 'skip'],
        '这一轮必须是 skip —— 不是 create 才测得到那条路');

    const r2 = applyPlan(draft, p2);
    assert.equal(r2.failed.length, 0,
        `不用建时不许报失败（幽灵「父合成节点不存在」）：${JSON.stringify(r2.failed.slice(0, 3))}`);
    assert.equal(r2.created + r2.updated + r2.pointersSet + r2.skipped, 2,
        '该跳过的照常跳过（不是"不报失败"就完事）');
});

// ================================================================
// 6. 落地：走 createSynthNode / setOwnerRaw，且来源层不留痕
// ================================================================
test('合成节点由 createSynthNode 建出：挂在父下、有 synthKey、**没有 extKey**', () => {
    const draft = makeDraft();
    withContainer(draft);
    const { plan } = planOf(fullCrate(), draft);
    const res = applyPlan(draft, plan);

    assert.equal(res.created, 2, '两个合成节点建出来了');
    const zj = bySynthKey(draft, 'synth:zj');
    assert.ok(zj, '合成节点已建出');
    // ⚠️ 断言"没有 extKey"用**假值**判据：`extKey: ''` 是插件迁移补的默认值
    //    （纯 Node 环境里没跑迁移，就是 undefined）—— 两种都不该有身份键。
    assert.ok(!zj.extKey, '★ 合成节点**没有** extKey');
    assert.equal(zj.type, 'C');
    assert.equal(zj.name, '浙江省赛（合成）');
    assert.equal(parentOfInDraft(draft, zj.id), byExtKey(draft, 'p').id, '挂在父容器（普通节点）下');
    assert.equal(res.pointersSet, 1, '成员指针 1 条');
    assert.equal(byExtKey(draft, 'p:c1').ownerSynth, 'synth:zj');
});

test('导入**不展开**父节点（与普通节点同一条铁律）', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    // 展开态在视图表里；不设 = 收起

    const { plan } = planOf(makeCrate([
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '合成' } }
    ]), draft);
    applyPlan(draft, plan);

    assert.equal(isExpanded(draft, 's1'), false,
        '★ 建合成节点也不许把父容器炸开（一次上百个节点会撞展开上限）');
});

test('★ 来源层不出现 synthKey / ownerSynth 的条目（既不记 manual，也不记导入来源）', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    // 树上已有的成员节点：来源层里本来只有 name 一条
    const c1 = put(draft, 'c1', 'C', s1.id, {
        extKey: 'p:c1', name: '甲', ownerSynth: '',
        values: { name: [{ v: '甲', src: 'manual' }] }
    });
    const snapshot = JSON.stringify(c1.values);

    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:zj' } },
        { type: 'C', synthKey: 'synth:zj', parentExtKey: 'p', fields: { name: '合成' } }
    ]);
    const { plan } = planOf(data, draft);

    // 计划层就把它们从"普通字段"里摘掉了 —— 拿不到 recordIncoming 那一路
    const rec = plan.records.find(r => r.extKey === 'p:c1');
    assert.equal('ownerSynth' in rec.fields, false, 'rec.fields 里没有 ownerSynth');
    assert.equal('ownerSynth' in rec.incoming, false, 'rec.incoming 里也没有（来源层只认 incoming）');
    assert.equal(JSON.stringify(plan.synth.nodes[0].fields).includes('synthKey'), false,
        '合成节点的待写字段里不含身份字段本身');

    applyPlan(draft, plan);

    const after = draft.nodes.c1;
    assert.equal(after.ownerSynth, 'synth:zj', '（前提）指针写进去了');
    assert.equal(JSON.stringify(after.values), snapshot, '★ 来源条目一个都没变');
    assert.equal('ownerSynth' in (after.values || {}), false, '来源层里没有 ownerSynth');
    const synth = bySynthKey(draft, 'synth:zj');
    assert.equal('synthKey' in (synth.values || {}), false, '来源层里没有 synthKey');
    assert.deepEqual(synth.values, {}, '新建的合成节点：来源层是空的（结构不进来源层）');
});

// ================================================================
// 7. 其他边角（不抛错、不丢节点）
// ================================================================
test('W/S 记录带 synthKey ⇒ 逐条报错（合成只在 C/P/R 上做）', () => {
    const draft = makeDraft();
    const data = makeCrate([
        { type: 'S', synthKey: 'synth:s', fields: { name: '系列（想合成）' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.synthNodes, 0);
    assert.ok(plan.errors.some(e => e.code === 'synth-bad-type'),
        `应报 synth-bad-type：${JSON.stringify(plan.errors)}`);
});

test('包内 synthKey 重复 ⇒ 全部拒绝（不整包报废，也不静默合并）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:dup', parentExtKey: 'p', fields: { name: 'A' } },
        { type: 'C', synthKey: 'synth:dup', parentExtKey: 'p', fields: { name: 'B' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.synthNodes, 0, '重复的两条都不建');
    assert.equal(plan.errors.filter(e => e.code === 'duplicate-synthkey').length, 2, '两条都报错');
});

test('合成节点上带「所属合成节点」⇒ 报错（成员名单不能嵌套）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:n', parentExtKey: 'p', fields: { name: '合成', ownerSynth: 'synth:n' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.synthNodes, 0);
    assert.ok(plan.errors.some(e => e.code === 'synth-node-with-owner'),
        `应报 synth-node-with-owner：${JSON.stringify(plan.errors)}`);
});

test('被拒绝的悬空指针不炸：节点照常在树上，只是指针没写', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: 'synth:ghost' } }
    ]);
    const { plan } = planOf(data, draft);
    const res = applyPlan(draft, plan);
    assert.equal(res.failed.length, 0, `"被拒绝"是正常结果，不是失败：${JSON.stringify(res.failed)}`);
    assert.ok(byExtKey(draft, 'p:c1'), '节点还在（没被丢弃）');
    assert.equal(byExtKey(draft, 'p:c1').ownerSynth, '', '★ 悬空指针一条都没写');
    assert.equal(findDanglingOwners(draft).length, 0, '树上因此没有新的悬空指针');
});

test('★ 解绑（包里写空）永远允许：被拒的是"指坏目标"，不是"清指针"', () => {
    const draft = makeDraft();
    const s1 = withContainer(draft);
    put(draft, 'c1', 'C', s1.id, { extKey: 'p:c1', name: '甲', ownerSynth: '' });
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentExtKey: 'p', fields: { name: '甲', ownerSynth: '' } }
    ]);
    const { plan } = planOf(data, draft);
    // 空值 = 没有指针诉求 ⇒ 不产生任何条目（更不会被当成悬空目标拒掉）
    assert.equal(plan.synth.pointers.length, 0);
    assert.equal(plan.summary.pointerRejected, 0);
});

test('导入带保留前缀的 synthKey 原样落地（包里的标识是别的机器自动生成的）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:1', parentExtKey: 'p', fields: { name: '外来合成节点' } }
    ]);
    const { plan } = planOf(data, draft);
    const res = applyPlan(draft, plan);
    assert.equal(res.created, 1, `带 synth: 前缀的标识必须能落地：${JSON.stringify(res.failed)}`);
    assert.ok(bySynthKey(draft, 'synth:1'), '按原样落成 synth:1');
});

// ================================================================
// 8. ★ `父synthKey`：合成节点挂到**另一个合成节点**之下
//
// "合成节点在包里的位置"可以由脚本显式指定父容器 —— 包格式给出两种写法：
//   · `父extKey`   父是普通节点
//   · `父synthKey` 父是合成节点
// **恰好给一个**（都空 = 挂根；两个都有 = 逐条拒绝）。
//
// ⚠️ 本节夹具用 `C 合成父 + P 合成子`。这不是随手挑的 ——
//    节点类型层级（`TYPE_CHILDREN_MAP`，`createSynthNode` 会校验）与
//    "合成只在 C/P/R 上做"两条合起来，**只有这一种**父子组合成立：
//      · S 自己不能是合成节点 ⇒ "S 父 + C 合成子"不是"合成挂合成"；
//      · C 合成父 + C 合成子 → `父节点类型 C 不允许添加 C`（被 core/ops/synth.js 拒）；
//      · 三层嵌套（C→C→C 之类）因此不可能。
//    （`S 父 + C 合成子` 那条另有用例，见下面的"普通父容器"用例。）
//
// 这一组钉住五件事（漏了任何一件都会**静默挂到根下**）：
//   ① 指向**树上已有**的合成节点 → 复用那个节点当父（不是挂在根下）；
//   ② 指向**同批新建**的合成节点（含"子写在父前面"的包）→ 两阶段时序成立；
//   ③ 父引用解析不到（两边都没有）→ **逐条拒绝**，不静默挂根；
//   ④ 两个父引用一起给 / 普通记录用 父synthKey → 逐条拒绝并说清原因；
//   ⑤ 父自己建不出来（类型不对、标识重复）→ 子也逐条拒绝（不静默挂根）。
// ================================================================

const bySynthKeyDraft = (draft, key) => Object.values(draft.nodes).find(n => n && n.synthKey === key);

/**
 * `C 合成父 + P 合成子` 的最小骨架：
 * 树上已有 C 容器 `p:c`，它自己就是合成节点 `synth:dad`（父是 S 容器，合法）。
 * 包里新建的 P 合成节点用 `parentSynthKey: 'synth:dad'` 挂到它下面。
 */
function withSynthParent(draft) {
    const s1 = withContainer(draft);
    const dad = put(draft, 'cdad', 'C', 's1', {
        extKey: 'p:c', synthKey: 'synth:dad', name: '比赛（合成）'
    });
    s1.extKey = 'p';
    return { s1, dad };
}

test('★ 父synthKey 指向树上已有的合成节点：挂在它下面（不是挂在根下）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:kid', parentSynthKey: 'synth:dad', fields: { name: '题目（合成）' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.errors, 0, `不该有错误：${JSON.stringify(plan.errors)}`);
    assert.equal(plan.summary.synthCreate, 1, '一个合成节点待建');
    assert.equal(plan.synth.nodes[0].parentSynthKey, 'synth:dad', '父引用原样带进执行清单');

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 1, `建出 1 个：${JSON.stringify(res.failed)}`);

    const kid = bySynthKeyDraft(draft, 'synth:kid');
    assert.ok(kid, '合成节点建出来了');
    assert.equal(parentOfInDraft(draft, kid.id), 'cdad', '★ 挂在**父合成节点**下');
});

test('★ 指向本包新建的合成节点 + 父写在后面：两阶段时序不能被包内顺序破坏', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        // 子在前、父在后 —— 单轮实现会把这种包判成"父找不到"（然后静默挂根）
        { type: 'P', synthKey: 'synth:kid2', parentSynthKey: 'synth:newC', fields: { name: '子题（合成）' } },
        // C 合成父：它的父容器是树上那个 C 节点（`p:c` 的**父** —— S 容器 `p`）
        { type: 'C', synthKey: 'synth:newC', parentExtKey: 'p', fields: { name: '新比赛（合成）' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.errors, 0, `不该有错误：${JSON.stringify(plan.errors)}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.failed.length, 0, `不该有失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.created, 2, '父子都建出来了');

    const newC = bySynthKeyDraft(draft, 'synth:newC');
    const kid2 = bySynthKeyDraft(draft, 'synth:kid2');
    assert.equal(parentOfInDraft(draft, kid2.id), newC.id, '★ 包装的是"父在后"，子照样挂在同批新建的父下');
});

test('父synthKey 指向树上**普通节点 id** ⇒ 拒绝（父引用是 synthKey，不是节点 id）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:x', parentSynthKey: 'cdad', fields: { name: '写成了节点 id' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.synthNodes, 0);
    const err = plan.errors[0];
    assert.equal(err.code, 'parent-not-found');
    assert.ok(/父synthKey/.test(err.message), `文案要点名父引用写法：${err.message}`);
});

test('★ 父synthKey 两边都没有 ⇒ 逐条拒绝（绝不静默挂到根下）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:orphan', parentSynthKey: 'synth:404', fields: { name: '孤儿合成' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '父找不到 ⇒ 这条不建');
    assert.equal(plan.summary.errors, 1, '逐条报错');
    const err = plan.errors[0];
    assert.equal(err.code, 'parent-not-found');
    assert.ok(/父synthKey/.test(err.message) && /synth:404/.test(err.message),
        `文案要点名是哪个父引用、指向了谁：${err.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0, '一条都没写');
    assert.equal(bySynthKeyDraft(draft, 'synth:orphan'), undefined,
        '★ 树上没有它（不许静默挂到根下）');
});

test('★ 父引用同时给 父extKey 与 父synthKey ⇒ 逐条拒绝（"父引用只能给一个"）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        {
            type: 'P', synthKey: 'synth:both',
            parentExtKey: 'p', parentSynthKey: 'synth:dad',
            fields: { name: '两个父' }
        }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '父引用不唯一 ⇒ 不建');
    assert.ok(plan.errors.some(e => e.code === 'parent-both'), `应报 parent-both：${JSON.stringify(plan.errors)}`);
    const err = plan.errors.find(e => e.code === 'parent-both');
    assert.ok(/只能给一个/.test(err.message), `文案要说清"只能给一个"：${err.message}`);
    assert.ok(/父extKey/.test(err.message) && /父synthKey/.test(err.message), '两个写法都要点名');

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(bySynthKeyDraft(draft, 'synth:both'), undefined, '两个父的那条一个字都没写');
});

test('★ 普通记录（有 extKey）用父synthKey ⇒ 逐条拒绝（合成节点不是父容器）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'C', extKey: 'p:c1', parentSynthKey: 'synth:dad', fields: { name: '原料' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.records.length, 0, '普通记录不进计划（不导入）');
    assert.ok(plan.errors.some(e => e.code === 'unsupported-parent-ref'),
        `应报 unsupported-parent-ref：${JSON.stringify(plan.errors)}`);
    const err = plan.errors.find(e => e.code === 'unsupported-parent-ref');
    assert.ok(/ownerSynth/.test(err.message), `文案要指出正确的写法是成员指针：${err.message}`);

    applyPlan(draft, plan);
    assert.equal(byExtKey(draft, 'p:c1'), undefined, '★ 那条记录没被导入（不猜它想说什么）');
});

test('包内 synthKey 重复 ⇒ 两条都拒绝，且指向它们的父引用不会被静默挑一条', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:dup', parentSynthKey: 'synth:dad', fields: { name: 'A' } },
        { type: 'P', synthKey: 'synth:dup', parentSynthKey: 'synth:dad', fields: { name: 'B' } },
        // 指向那个重复标识 ⇒ 父是谁说不清 ⇒ 拒绝（不是"随便挑一条挂上"）
        { type: 'P', synthKey: 'synth:kid', parentSynthKey: 'synth:dup', fields: { name: 'Kid' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.errors.filter(e => e.code === 'duplicate-synthkey').length, 2,
        `重复的两条各报一次：${JSON.stringify(plan.errors)}`);
    assert.equal(plan.summary.synthNodes, 0, '一条都不建');
    assert.ok(plan.errors.some(e => e.code === 'parent-not-found' && e.index === 2),
        `指向重复标识的那条（第 3 条）也要拒绝：${JSON.stringify(plan.errors)}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0, '一个都没建');
    assert.equal(bySynthKeyDraft(draft, 'synth:kid'), undefined, '★ 子也没被静默挂到根下');
});

test('父合成节点自己建不出来（类型不对）⇒ 子逐条拒绝，不静默挂根', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'W', synthKey: 'synth:bad', parentExtKey: 'p', fields: { name: 'W 不能合成' } },
        { type: 'P', synthKey: 'synth:kid', parentSynthKey: 'synth:bad', fields: { name: 'Kid' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.ok(plan.errors.some(e => e.code === 'synth-bad-type'), '父那条报类型不对');
    const kidErr = plan.errors.find(e => e.code === 'parent-not-found' && /synth:kid/.test(e.message));
    assert.ok(kidErr, `子那条要报"父建不出来"：${JSON.stringify(plan.errors)}`);
    assert.ok(/synth:bad/.test(kidErr.message), `要点名是哪条父：${kidErr.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(bySynthKeyDraft(draft, 'synth:kid'), undefined, '★ 子没有被挂到根下');
});

test('父synthKey 成环（指向自己）⇒ 拒绝该条', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:self', parentSynthKey: 'synth:self', fields: { name: '自指' } }
    ]);
    const { plan } = planOf(data, draft);
    assert.equal(plan.summary.synthNodes, 0);
    assert.ok(plan.errors.some(e => e.code === 'parent-cycle'), `应报 parent-cycle：${JSON.stringify(plan.errors)}`);
});

// ⚠️ **"挂根"这条组合对合成节点永远不成立**：
//    `TYPE_CHILDREN_MAP` 里 `O: ['W','S']`，而合成节点只能是 C/P/R（`SYNTH_TYPES`）
//    ⇒ "两种父引用都不给 = 挂在真实根下"（3.3）对**合成节点**一定是错的。
//    计划层看不见类型层级的话，会把它列成"新建合成节点 N"、点执行后逐条失败（预览与结果不符）。
//    所以 `planSynthNodes` 在**计划阶段**就按"合成节点必须有父容器"逐条拒绝 ——
//    预览就拒绝，不留到执行时才逐条失败。
//    类型层级是既有核心不变量，不放宽它：改的是**计划层的预检**，
//    不是 `TYPE_CHILDREN_MAP` 本身。
test('★ 合成节点不给父引用（想挂根）⇒ 计划阶段就拒绝（根 O 放不下 C/P/R）', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:root', fields: { name: '想挂根' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '预览就不算新建（不等执行时才失败）');
    const err = plan.errors.find(e => e.code === 'synth-parent-required');
    assert.ok(err, `应报 synth-parent-required：${JSON.stringify(plan.errors)}`);
    assert.ok(/TYPE_CHILDREN_MAP/.test(err.message), `文案要指出判据在哪：${err.message}`);
    assert.ok(/根/.test(err.message) && /O/.test(err.message) && /C/.test(err.message),
        `文案要说清"根是 O、放不下 C"：${err.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0, '执行时不会有"逐条失败"：计划阶段已经拒掉了');
    assert.equal(res.failed.length, 0, `没有任何失败条目：${JSON.stringify(res.failed)}`);
    assert.equal(bySynthKeyDraft(draft, 'synth:root'), undefined, '树上没有它');
});

// 反向锚：这条规则**只管合成节点** —— 普通记录不给父引用 = 挂真实根，仍然合法（3.3）。
test('★ 反向锚：普通记录（有 extKey）不给父引用 ⇒ 照常挂根，不被这条规则误伤', () => {
    const draft = makeDraft();
    const data = makeCrate([
        { type: 'S', extKey: 'p:root', fields: { name: '根下的系列' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.errors, 0, `普通记录挂根不该报错：${JSON.stringify(plan.errors)}`);
    assert.equal(plan.summary.create, 1, '预览：新增 1');
    assert.equal(plan.records[0].parentExtKey, '', '父引用为空');

    applyPlan(draft, plan);
    const node = byExtKey(draft, 'p:root');
    assert.ok(node, '建出来了');
    assert.equal(parentOfInDraft(draft, node.id), draft.rootId, '★ 就挂在真实根节点下（O 允许 S）');
});

// ================================================================
// 9. ★ 父容器**类型**预检：非法组合在**计划阶段**就进"被拒绝"
//
// 判据是唯一一份 `TYPE_CHILDREN_MAP`（core/model/constants.js）：
//   O:[W,S]  W:[S,W]  S:[C,S]  C:[P]  P:[R]  R:[]
// 合成节点只能是 C/P/R（SYNTH_TYPES），所以"合成挂合成"里合法的只有
// `C 合成父 + P 合成子`（以及 S 普通父 + C 合成子）。其余组合一律在计划阶段拒绝：
// 预览能看出来（进 `plan.errors` = 预览里"错误（这些条目不会执行）"那一栏），
// 执行后树上没有这条 —— 绝不留到执行时才逐条失败。
// ================================================================

test('★ 合法组合 C 合成父 + P 合成子：预览算"新建"且执行后真的建出来', () => {
    const draft = makeDraft();
    withSynthParent(draft);   // 树上已有 C 合成节点 synth:dad
    const data = makeCrate([
        { type: 'P', synthKey: 'synth:ok', parentSynthKey: 'synth:dad', fields: { name: '题目（合成）' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.errors, 0, `合法组合不该被拒：${JSON.stringify(plan.errors)}`);
    assert.equal(plan.summary.synthCreate, 1, '预览：新建合成节点 1');
    assert.equal(plan.synth.nodes.length, 1, '进执行清单');

    const res = applyPlan(draft, plan);
    assert.equal(res.failed.length, 0, `不该有失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.created, 1, '★ 预览说"新建"，执行后真的建出来了（预览与结果一致）');
    const kid = bySynthKeyDraft(draft, 'synth:ok');
    assert.ok(kid, '树上找得到它');
    assert.equal(parentOfInDraft(draft, kid.id), 'cdad', '挂在 C 合成父下');
});

test('★ C 合成父 + C 合成子（父在树上）⇒ 计划阶段拒绝，执行后树上没有这条', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:cc', parentSynthKey: 'synth:dad', fields: { name: 'C 挂 C' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '预览：不算新建');
    const err = plan.errors.find(e => e.code === 'synth-bad-parent-type');
    assert.ok(err, `应报 synth-bad-parent-type：${JSON.stringify(plan.errors)}`);
    assert.ok(/父synthKey/.test(err.message), `文案要点名是哪个父引用：${err.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(res.failed.length, 0, '执行时没有任何"逐条失败"');
    assert.equal(bySynthKeyDraft(draft, 'synth:cc'), undefined, '★ 树上没有这条');
});

test('★ 同批新建的 C 合成父 + C 合成子（子写在父前面）⇒ 预检用"父建成后的类型"', () => {
    const draft = makeDraft();
    withContainer(draft);
    const data = makeCrate([
        // 子在前、父在后：单趟实现会"父的类型还没登记 ⇒ 放行"，于是执行时失败
        { type: 'C', synthKey: 'synth:newKid', parentSynthKey: 'synth:newDad', fields: { name: '想挂新 C 下' } },
        { type: 'C', synthKey: 'synth:newDad', parentExtKey: 'p', fields: { name: '新 C 合成' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthCreate, 1, '父照建（S 父容器允许 C）');
    assert.equal(plan.summary.errors, 1, '子被拒 1 条（C 父不允许 C 子）');
    const err = plan.errors.find(e => e.code === 'synth-bad-parent-type');
    assert.ok(err && err.index === 0, `拒的必须是子那条（第 1 条）：${JSON.stringify(plan.errors)}`);
    assert.deepEqual(plan.synth.nodes.map(n => n.synthKey), ['synth:newDad'],
        '执行清单里只有父');

    const res = applyPlan(draft, plan);
    assert.equal(res.failed.length, 0, `不该有失败：${JSON.stringify(res.failed)}`);
    assert.equal(res.created, 1);
    assert.ok(bySynthKeyDraft(draft, 'synth:newDad'), '父建出来了');
    assert.equal(bySynthKeyDraft(draft, 'synth:newKid'), undefined, '★ 子没建（不是等到执行才失败）');
});

test('★ 父是 W（普通节点）⇒ 计划阶段拒绝 C 合成节点', () => {
    const draft = makeDraft();
    put(draft, 'w1', 'W', 'o', { extKey: 'w', name: '比赛' });
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:underW', parentExtKey: 'w', fields: { name: 'C 挂 W' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '预览：不算新建');
    const err = plan.errors.find(e => e.code === 'synth-bad-parent-type');
    assert.ok(err, `应报 synth-bad-parent-type：${JSON.stringify(plan.errors)}`);
    assert.ok(/父extKey/.test(err.message) && /W/.test(err.message),
        `文案要点名父引用与父类型：${err.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(bySynthKeyDraft(draft, 'synth:underW'), undefined, '树上没有这条');
});

test('★ R 合成节点挂在 C 合成节点下 ⇒ 计划阶段拒绝（C 只允许 P 子节点）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'R', synthKey: 'synth:underC', parentSynthKey: 'synth:dad', fields: { name: 'R 挂 C' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '预览：不算新建');
    const err = plan.errors.find(e => e.code === 'synth-bad-parent-type');
    assert.ok(err, `应报 synth-bad-parent-type：${JSON.stringify(plan.errors)}`);
    assert.ok(/R/.test(err.message) && /P/.test(err.message),
        `文案要点名子类型 R 与父允许的 P：${err.message}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(bySynthKeyDraft(draft, 'synth:underC'), undefined, '★ 树上没有这条');
});

test('★ 级联：父容器类型挂不上 ⇒ 挂在它下面的合成节点也不进执行清单', () => {
    const draft = makeDraft();
    put(draft, 'w1', 'W', 'o', { extKey: 'w', name: '比赛' });
    const data = makeCrate([
        // 父挂 W（W 只允许 S / W）⇒ 被类型预检拒；
        // 子 `P 挂 C` 单看是**合法**的（C 允许 P），但父建不出来 ⇒ 子也不许挂
        { type: 'C', synthKey: 'synth:badDad', parentExtKey: 'w', fields: { name: 'C 挂 W' } },
        { type: 'P', synthKey: 'synth:kid', parentSynthKey: 'synth:badDad', fields: { name: 'P 挂 C' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '预览：一个都不算新建（不是 2、也不是 1）');
    assert.ok(plan.errors.some(e => e.code === 'synth-bad-parent-type' && e.index === 0),
        `父那条报类型挂不上：${JSON.stringify(plan.errors)}`);
    assert.ok(plan.errors.some(e => e.code === 'parent-not-found' && /synth:badDad/.test(e.message)),
        `子那条报"父建不出来"，并点名是哪条父：${JSON.stringify(plan.errors)}`);

    const res = applyPlan(draft, plan);
    assert.equal(res.created, 0);
    assert.equal(res.failed.length, 0, `执行时没有任何"逐条失败"：${JSON.stringify(res.failed)}`);
    assert.equal(bySynthKeyDraft(draft, 'synth:badDad'), undefined, '父没建');
    assert.equal(bySynthKeyDraft(draft, 'synth:kid'), undefined, '★ 子也没建（不进执行清单）');
});

test('★ 指向被类型拒绝的合成节点的成员指针 ⇒ 预览判悬空（不假装能写）', () => {
    const draft = makeDraft();
    withSynthParent(draft);
    const data = makeCrate([
        { type: 'C', synthKey: 'synth:cc', parentSynthKey: 'synth:dad', fields: { name: 'C 挂 C（非法）' } },
        { type: 'C', extKey: 'p:c9', parentExtKey: 'p', fields: { name: '成员', ownerSynth: 'synth:cc' } }
    ]);
    const { plan } = planOf(data, draft);

    assert.equal(plan.summary.synthNodes, 0, '被拒的合成节点不算新建');
    assert.equal(plan.summary.pointerSet, 0, '指向它的指针不写');
    assert.equal(plan.summary.pointerDangling, 1, '并被认成"目标不可解析"（悬空）');

    const res = applyPlan(draft, plan);
    assert.equal(res.failed.length, 0, `预览与执行一致（没有逐条失败）：${JSON.stringify(res.failed)}`);
    assert.equal(byExtKey(draft, 'p:c9').ownerSynth, '', '★ 树上没有这个指针');
});
