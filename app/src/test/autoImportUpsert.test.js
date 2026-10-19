// ================================================================
// 增量 upsert 测试（core/ops/upsert.js）
// 依据：docs/auto-import.md 2.3 / 2.4 / 3.3 / 4.2 / 4.4 / 6.2 / 8.5
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpanded } from '../core/model/viewState.js';
// ★ 2026-10-18 起**事务里不再写 `draft.parentOf`**（它是派生索引，提交时由 `applyState` 整张重建）
//   ⇒ 断言"挂在谁下面"要走这条读口（与 ops 里同一份：`ops/_helpers.js:parentOfInDraft`）。
import { parentOfInDraft } from '../core/ops/_helpers.js';

import {
    upsertRecord,
    buildExtKeyIndex,
    cleanNodeFields,
    assignExtKey,
    isWritableField
} from '../core/ops/upsert.js';

// ---- 造一份最小 draft ----
function makeDraft() {
    const draft = {
        rootId: 'o',
        nodes: {
            o: { id: 'o', type: 'O', name: '根', extKey: '', selected: false }
        },
        childOrder: { o: [] },
        parentOf: { o: null },
        // 视图态（展开）**不在节点上**：`view.expanded` 才是它住的地方
        view: { expanded: {} },
        meta: { idCounter: 0, version: 'v7.0.0' }
    };
    return draft;
}

/** 直接放一个节点到 draft（模拟"树上已有"） */
function put(draft, id, type, parentId, extra = {}) {
    draft.nodes[id] = { id, type, name: id, extKey: '', selected: false, ...extra };
    draft.childOrder[id] = [];
    draft.childOrder[parentId].push(id);
    draft.parentOf[id] = parentId;
    return draft.nodes[id];
}

/**
 * 带一个合法容器链的 draft：O → W(平台) → S(系列)
 *
 * 注意 TYPE_CHILDREN_MAP 的真实约束（core/model/constants.js）：
 *   O → W/S，W → S/W，S → C/S，C → P，P → R
 * 也就是说 **W 下不能直接放 C**，比赛必须挂在系列（S）下。
 */
function makeDraftWithPlatform() {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const w = upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } }, idx);
    const s = upsertRecord(d, {
        type: 'S', extKey: 'qoj:contest', parentExtKey: 'qoj', fields: { name: 'Contest' }
    }, idx);
    return { draft: d, index: idx, platformId: w.nodeId, seriesId: s.nodeId };
}

/** 在 makeDraftWithPlatform 基础上再建一个比赛 */
function makeDraftWithContest() {
    const base = makeDraftWithPlatform();
    const c = upsertRecord(base.draft, {
        type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest', fields: { name: 'Round 4113' }
    }, base.index);
    return { ...base, contestId: c.nodeId, contestResult: c };
}

// ================================================================
// buildExtKeyIndex
// ================================================================

test('buildExtKeyIndex 收录非空 extKey，跳过空值', () => {
    const d = makeDraft();
    put(d, 'w1', 'W', 'o', { extKey: 'qoj' });
    put(d, 'w2', 'W', 'o', { extKey: '' });
    put(d, 'w3', 'W', 'o');
    const idx = buildExtKeyIndex(d);
    assert.deepEqual(idx, { qoj: 'w1' });
});

test('buildExtKeyIndex 对重复 extKey 保留最先遇到的', () => {
    const d = makeDraft();
    put(d, 'w1', 'W', 'o', { extKey: 'dup' });
    put(d, 'w2', 'W', 'o', { extKey: 'dup' });
    const idx = buildExtKeyIndex(d);
    assert.equal(idx.dup, 'w1');
});

test('buildExtKeyIndex 对无效输入返回空表', () => {
    assert.deepEqual(buildExtKeyIndex(null), {});
    assert.deepEqual(buildExtKeyIndex({}), {});
});

// ================================================================
// 新建
// ================================================================

test('upsertRecord 新建：写入节点、childOrder、parentOf 并登记索引', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, {
        type: 'W',
        extKey: 'qoj',
        fields: { name: 'QOJ' }
    }, idx);

    assert.equal(res.ok, true);
    assert.equal(res.action, 'created');
    assert.equal(res.created, true);
    assert.ok(res.nodeId);

    const node = d.nodes[res.nodeId];
    assert.equal(node.type, 'W');
    assert.equal(node.extKey, 'qoj');
    assert.equal(node.name, 'QOJ');
    assert.equal(parentOfInDraft(d, res.nodeId), 'o');
    assert.deepEqual(d.childOrder.o, [res.nodeId]);
    assert.deepEqual(d.childOrder[res.nodeId], []);
    assert.equal(idx.qoj, res.nodeId);
});

test('upsertRecord 新建时**不**展开父节点（避免整棵树被导入炸开）', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } }, idx);
    assert.equal(d.nodes.o.expanded, undefined, '`expanded` 不是节点字段');
    assert.equal(isExpanded(d, 'o'), false, '新建时**不**展开父节点（避免整棵树被导入炸开）');
});

test('upsertRecord 父引用留空即挂根（3.3）', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, { type: 'W', extKey: 'qoj', parentExtKey: '', fields: { name: 'QOJ' } }, idx);
    assert.equal(res.ok, true);
    assert.equal(parentOfInDraft(d, res.nodeId), 'o');
});

test('upsertRecord 父引用为 null / undefined 也挂根', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const a = upsertRecord(d, { type: 'W', extKey: 'a', parentExtKey: null, fields: { name: 'A' } }, idx);
    const b = upsertRecord(d, { type: 'W', extKey: 'b', fields: { name: 'B' } }, idx);
    assert.equal(parentOfInDraft(d, a.nodeId), 'o');
    assert.equal(parentOfInDraft(d, b.nodeId), 'o');
});

// ================================================================
// 合并
// ================================================================

test('upsertRecord key 精确相等 → 合并，不新建', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const first = upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } }, idx);
    const before = Object.keys(d.nodes).length;

    const second = upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'QOJ New' } }, idx);

    assert.equal(second.action, 'updated');
    assert.equal(second.created, false);
    assert.equal(second.nodeId, first.nodeId);
    assert.equal(Object.keys(d.nodes).length, before, '不应新增节点');
    assert.equal(d.nodes[first.nodeId].name, 'QOJ New');
    assert.deepEqual(second.changedFields, ['name']);
});

test('upsertRecord 内容相同 → changedFields 为空', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const r = { type: 'W', extKey: 'qoj', fields: { name: 'QOJ' } };
    upsertRecord(d, r, idx);
    const again = upsertRecord(d, r, idx);
    assert.equal(again.action, 'updated');
    assert.deepEqual(again.changedFields, []);
});

test('upsertRecord 数组字段按值比较（tags）', () => {
    // `tags` 在属性表里声明为 `types: ['P']`（列表型元素只属于题目）——
    // 所以夹具必须是 P 节点：用 W 测数组比较会先被类型适用性校验拦下（那是另一条规则）
    const { draft: d, index: idx, contestId } = makeDraftWithContest();
    const p = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A' }
    }, idx);
    assert.equal(p.ok, true);
    assert.equal(parentOfInDraft(d, p.nodeId), contestId);

    const same = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { tags: ['a', 'b'] }
    }, idx);
    assert.deepEqual(same.changedFields, ['tags']);

    const again = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { tags: ['a', 'b'] }
    }, idx);
    assert.deepEqual(again.changedFields, [], '同值数组不应记作变化');

    const diff = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { tags: ['a'] }
    }, idx);
    assert.deepEqual(diff.changedFields, ['tags']);
});

// ================================================================
// 字段类型适用性（属性表的 types）
// ================================================================

// ================================================================
// 缓存字段的形状
// ================================================================

test('导入 tags：写进缓存字段的形状是 `[{id,text,color}]`，不是字符串数组', () => {
    // 来源层要的是字符串数组（值级来源按内容比较），缓存字段要的是对象数组
    // （标签管理器按 `tag.id` 增删移）。少转这一步 → 管理器空白行、删不掉。
    const { draft: d, index: idx } = makeDraftWithContest();
    const res = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113',
        fields: { name: 'A', tags: ['dp', 'math'] }
    }, idx);
    assert.equal(res.ok, true);
    const tags = d.nodes[res.nodeId].tags;
    assert.equal(Array.isArray(tags), true);
    assert.deepEqual(tags.map(t => t.text), ['dp', 'math'], '文字与顺序保留');
    for (const t of tags) {
        assert.equal(typeof t.id, 'string', '每个标签都有 id（标签管理器要按它操作）');
        assert.equal(t.id.length > 0, true);
        assert.equal(typeof t.color, 'string', '颜色有默认值');
    }
});

test('导入 tags：重复导入同一份标签 → 缓存对象稳定（id 不换）', () => {
    const { draft: d, index: idx } = makeDraftWithContest();
    const rec = { type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A', tags: ['dp'] } };
    const first = upsertRecord(d, rec, idx);
    const ids1 = d.nodes[first.nodeId].tags.map(t => t.id);
    // 第二次带同一个值 → 不该记作变化，id 也不该变
    const again = upsertRecord(d, rec, idx);
    assert.deepEqual(again.changedFields, []);
    assert.deepEqual(d.nodes[first.nodeId].tags.map(t => t.id), ids1);
});

test('upsertRecord 拒绝"字段不适用于该节点类型"的记录', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, {
        type: 'W', extKey: 'qoj', fields: { name: 'QOJ', ratio: '4.61' }   // ratio 是 P 专有
    }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'field-not-applicable');
    assert.match(res.reason, /ratio/);
    assert.equal(Object.keys(d.nodes).length, 1, '没写进任何节点');
});

test('upsertRecord 拒绝"extKey 撞上别的类型"的记录', () => {
    const { draft: d, index: idx, platformId } = makeDraftWithContest();
    const res = upsertRecord(d, {
        type: 'P', extKey: 'qoj', parentExtKey: 'qoj:4113',   // extKey 指向 W 节点
        fields: { name: '其实是个平台' }
    }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'type-mismatch');
    assert.equal(d.nodes[platformId].type, 'W', '原节点类型没变');
    assert.equal(d.nodes[platformId].name, 'QOJ', '字段没被合并进去');
});

test('upsertRecord key 不同 → 新建（绝不模糊匹配）', () => {
    const { draft: d, index: idx, contestId, contestResult } = makeDraftWithContest();
    assert.equal(contestResult.ok, true);

    const a = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'Two Sum' }
    }, idx);
    const b = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:B', parentExtKey: 'qoj:4113', fields: { name: 'Two Sum' }
    }, idx);

    assert.equal(a.action, 'created');
    assert.equal(b.action, 'created');
    assert.notEqual(a.nodeId, b.nodeId, '同名但 key 不同必须各建一个');
    assert.equal(parentOfInDraft(d, a.nodeId), contestId);
    assert.equal(parentOfInDraft(d, b.nodeId), contestId);
});

test('upsertRecord key 仅有空白差异时视为不同（只 trim，不折叠）', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const a = upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'A' } }, idx);
    const b = upsertRecord(d, { type: 'W', extKey: ' qoj ', fields: { name: 'B' } }, idx);
    assert.equal(b.nodeId, a.nodeId, '前后空白应被 trim 后视为同一 key');
});

test('upsertRecord 大小写不同视为不同 key', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const a = upsertRecord(d, { type: 'W', extKey: 'qoj', fields: { name: 'A' } }, idx);
    const b = upsertRecord(d, { type: 'W', extKey: 'QOJ', fields: { name: 'B' } }, idx);
    assert.notEqual(b.nodeId, a.nodeId);
});

// ================================================================
// 拒绝路径（4.4 / 2.3）
// ================================================================

test('upsertRecord 缺 extKey → 拒绝', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, { type: 'W', fields: { name: 'X' } }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'missing-extkey');
    assert.equal(Object.keys(d.nodes).length, 1, '不应创建节点');
});

test('upsertRecord extKey 为纯空白 → 拒绝', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, { type: 'W', extKey: '   ', fields: { name: 'X' } }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'missing-extkey');
});

test('upsertRecord 未知节点类型 → 拒绝', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, { type: 'Z', extKey: 'x', fields: {} }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad-type');
});

test('upsertRecord 父节点两边都没有 → 拒绝（2.3）', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, { type: 'P', extKey: 'qoj:1:A', parentExtKey: 'qoj:1', fields: { name: 'X' } }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'parent-not-found');
    assert.match(res.reason, /qoj:1/);
    assert.equal(Object.keys(d.nodes).length, 1, '不应创建节点');
});

test('upsertRecord 父节点在树上 → 复用（不要求出现在包里）', () => {
    const d = makeDraft();
    put(d, 'c1', 'C', 'o', { extKey: 'qoj:4113' });
    const idx = buildExtKeyIndex(d);
    const res = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:20236', parentExtKey: 'qoj:4113', fields: { name: 'All Closed' }
    }, idx);
    assert.equal(res.ok, true);
    assert.equal(parentOfInDraft(d, res.nodeId), 'c1');
});

test('upsertRecord 父节点在包内（同批先前创建的） → 复用', () => {
    const { draft: d, index: idx, platformId, seriesId } = makeDraftWithPlatform();

    const c = upsertRecord(d, {
        type: 'C', extKey: 'qoj:4113', parentExtKey: 'qoj:contest', fields: { name: 'R900' }
    }, idx);
    assert.equal(c.ok, true);
    assert.equal(parentOfInDraft(d, seriesId), platformId, 'S 应挂在同批创建的 W 下');
    assert.equal(parentOfInDraft(d, c.nodeId), seriesId, 'C 应挂在同批创建的 S 下');

    const p = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:1', parentExtKey: 'qoj:4113', fields: { name: 'A' }
    }, idx);
    assert.equal(p.ok, true);
    assert.equal(parentOfInDraft(d, p.nodeId), c.nodeId, 'P 应挂在同批创建的 C 下');

    const r = upsertRecord(d, {
        type: 'R', extKey: 'qoj:sub:1', parentExtKey: 'qoj:4113:1', fields: { status: 'AC' }
    }, idx);
    assert.equal(r.ok, true);
    assert.equal(parentOfInDraft(d, r.nodeId), p.nodeId, 'R 应挂在同批创建的 P 下');
});

test('upsertRecord 父子类型约束：W 下不能直接放 C（必须经 S）', () => {
    const { draft: d, index: idx, platformId } = makeDraftWithPlatform();
    const bad = upsertRecord(d, {
        type: 'C', extKey: 'qoj:9999', parentExtKey: 'qoj', fields: { name: 'X' }
    }, idx);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad-parent-type');
    assert.match(bad.reason, /W/);
    assert.equal(parentOfInDraft(d, 'qoj:9999'), null, '不存在的 id ⇒ null（读口语义：null = 不在树上）');
    assert.ok(platformId);
});

test('upsertRecord 父节点引用不存在的容器 → 拒绝（P 不能直接挂根）', () => {
    const d = makeDraft();
    const idx = buildExtKeyIndex(d);
    // O 的子类型只有 W/S，P 挂根会被父类型约束拦下
    const res = upsertRecord(d, { type: 'P', extKey: 'p', fields: { name: 'A' } }, idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'bad-parent-type');
    assert.equal(Object.keys(d.nodes).length, 1);
});

test('upsertRecord 父子类型约束：P 下不允许 C', () => {
    const { draft: d, index: idx } = makeDraftWithContest();
    const p = upsertRecord(d, {
        type: 'P', extKey: 'qoj:4113:A', parentExtKey: 'qoj:4113', fields: { name: 'A' }
    }, idx);
    assert.equal(p.ok, true);

    const bad = upsertRecord(d, {
        type: 'C', extKey: 'bad', parentExtKey: 'qoj:4113:A', fields: { name: 'X' }
    }, idx);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad-parent-type');
});

test('upsertRecord 父子类型约束：R 只能挂 P', () => {
    const { draft: d, index: idx } = makeDraftWithContest();
    const bad = upsertRecord(d, {
        type: 'R', extKey: 'qoj:sub:1', parentExtKey: 'qoj:4113', fields: { status: 'AC' }
    }, idx);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad-parent-type');
});

// ================================================================
// 字段保护（6.2）
// ================================================================

test('upsertRecord 不写入结构字段与派生字段', () => {
    const { draft: d, index: idx } = makeDraftWithContest();

    const res = upsertRecord(d, {
        type: 'P',
        extKey: 'qoj:4113:A',
        parentExtKey: 'qoj:4113',
        fields: {
            name: 'A',
            id: 'HACK',
            type: 'R',
            expanded: true,
            selected: true,
            currentPage: 99,
            lastModified: 'HACK',
            status1: 1,
            status2: 4,
            acTime: '2020.01.01 00:00',
            lastSubmitTime: '2020.01.01 00:00',
            xcpcDifficulty: 'C+',
            statusComplete1: 3,
            statusComplete2: 3
        }
    }, idx);

    assert.equal(res.ok, true);
    const node = d.nodes[res.nodeId];
    assert.equal(node.id, res.nodeId, 'id 不可被覆盖');
    assert.equal(node.type, 'P', 'type 不可被覆盖');
    assert.equal(node.extKey, 'qoj:4113:A');
    assert.equal(node.expanded, undefined, '`expanded` 不是节点字段（导入也不会写它）');
    assert.ok(!(d.view && d.view.expanded && d.view.expanded[res.nodeId]),
        '展开态住在 `view.expanded`，导入通道不碰它');
    assert.equal(node.selected, false);
    assert.equal(node.currentPage, undefined, 'currentPage 不是节点字段（导入也不会写它）');
    assert.notEqual(node.lastModified, 'HACK');
    assert.equal(node.status1, 0);
    assert.equal(node.status2, 0);
    assert.equal(node.acTime, '----.--.-- --:--');
    assert.equal(node.xcpcDifficulty, '-');
    assert.equal(node.name, 'A', '可写字段仍应写入');
    assert.deepEqual(res.changedFields, ['name']);
});

test('upsertRecord 合并时不覆盖既有派生字段与结构字段', () => {
    const { draft: d, index: idx, contestId } = makeDraftWithContest();
    // 先造一个已有 P（带上派生字段），并把折叠态放进**视图表**
    put(d, 'p1', 'P', contestId, {
        extKey: 'qoj:4113:A', status2: 3, name: 'Old', acTime: '2026.01.01 10:00'
    });
    d.view.expanded.p1 = true;
    idx['qoj:4113:A'] = 'p1';

    const res = upsertRecord(d, {
        type: 'P',
        extKey: 'qoj:4113:A',
        parentExtKey: 'qoj:4113',
        fields: { name: 'New', status2: 4, expanded: false, acTime: 'HACK' }
    }, idx);

    assert.equal(res.ok, true);
    assert.equal(res.action, 'updated');
    assert.equal(res.nodeId, 'p1');
    assert.equal(d.nodes.p1.status2, 3, 'status2 不可被导入覆盖');
    assert.equal(d.nodes.p1.expanded, undefined, '`expanded` 不是节点字段（导入也不会写它）');
    assert.equal(isExpanded(d, 'p1'), true, '导入不碰折叠态（它在视图表里）');
    assert.equal(d.nodes.p1.acTime, '2026.01.01 10:00', 'acTime 不可被导入覆盖');
    assert.equal(d.nodes.p1.name, 'New', '可写字段正常更新');
    assert.deepEqual(res.changedFields, ['name']);
});

test('cleanNodeFields 按白名单过滤', () => {
    const out = cleanNodeFields(
        { name: 'A', cfDifficulty: 800, status2: 4, id: 'x' },
        { allowedFields: ['name', 'cfDifficulty'] }
    );
    assert.deepEqual(out, { name: 'A', cfDifficulty: 800 });
});

test('cleanNodeFields 丢弃 undefined，保留 null', () => {
    const out = cleanNodeFields({ name: 'A', ratio: undefined, link: null });
    assert.deepEqual(out, { name: 'A', link: null });
});

test('isWritableField 判定', () => {
    assert.equal(isWritableField('name'), true);
    assert.equal(isWritableField('remark'), true, 'remark 可写但由策略层强制 never');
    assert.equal(isWritableField('status2'), false);
    assert.equal(isWritableField('id'), false);
    // `extKey` 是**身份元素（结构保护）**：导入不许直接写，
    // 由 upsert 的 assignExtKey 单独赋值（这条规则从属性表派生，不手抄名单）
    assert.equal(isWritableField('extKey'), false, 'extKey 是身份键，导入只经 assignExtKey 写');
});

// ================================================================
// assignExtKey（第八节 / 8.5）
// ================================================================

test('assignExtKey 写入空 key', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o');
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', 'qoj:1:A', idx);
    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(d.nodes.p1.extKey, 'qoj:1:A');
    assert.equal(idx['qoj:1:A'], 'p1');
});

test('assignExtKey 幂等：同 key 重复执行无变化', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'qoj:1:A' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', 'qoj:1:A', idx);
    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
});

test('assignExtKey 不覆盖已有的不同 key', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'old' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', 'new', idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'already-has-key');
    assert.equal(d.nodes.p1.extKey, 'old');
});

test('assignExtKey 目标 key 已被别的节点占用 → 拒绝（不自动挑一个）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'taken' });
    put(d, 'p2', 'P', 'o', { extKey: '' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p2', 'taken', idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'key-taken');
    assert.equal(d.nodes.p2.extKey, '', '被拒后不应写入任何 key');
    assert.equal(d.nodes.p1.extKey, 'taken', '持有者的 key 不受影响');
});

test('assignExtKey 空 key 与不存在的节点被拒', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o');
    assert.equal(assignExtKey(d, 'p1', '  ').code, 'empty-key');
    assert.equal(assignExtKey(d, 'nope', 'k').code, 'no-node');
});

// ================================================================
// 更换 / 清空（allowOverwrite，第八节的"救援通道"）
// ================================================================

test('assignExtKey 默认**不**允许覆盖（安全默认值）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'old' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', 'new', idx);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'already-has-key');
    assert.equal(d.nodes.p1.extKey, 'old', '默认不覆盖');
    assert.equal(idx.new, undefined, '索引也不该被改动');
});

test('allowOverwrite 时能更换 key，并同步更新索引', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'old' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', 'new', idx, { allowOverwrite: true });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(d.nodes.p1.extKey, 'new');
    assert.equal(idx.new, 'p1', '新 key 进索引');
    assert.equal(idx.old, undefined, '旧 key 必须从索引移除（否则会指向本节点造成假命中）');
});

test('allowOverwrite 时能清空 key（救援通道）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'typo-key' });
    const idx = buildExtKeyIndex(d);
    const res = assignExtKey(d, 'p1', '', idx, { allowOverwrite: true });

    assert.equal(res.ok, true);
    assert.equal(res.changed, true);
    assert.equal(d.nodes.p1.extKey, '', 'key 被清空');
    assert.equal(idx['typo-key'], undefined, '索引里的旧 key 也要清掉');
});

test('清空在**非** allowOverwrite 模式下仍被拒（语义不变）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'old' });
    const res = assignExtKey(d, 'p1', '', buildExtKeyIndex(d));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'empty-key');
    assert.equal(d.nodes.p1.extKey, 'old');
});

test('本来就空时清空是幂等的（不记为 changed）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: '' });
    const res = assignExtKey(d, 'p1', '', buildExtKeyIndex(d), { allowOverwrite: true });
    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
});

test('更换到相同的 key 是幂等的', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'same' });
    const res = assignExtKey(d, 'p1', 'same', buildExtKeyIndex(d), { allowOverwrite: true });
    assert.equal(res.ok, true);
    assert.equal(res.changed, false);
});

test('更换时目标 key 被别的节点占用 → 仍拒绝（不靠覆盖掩盖脏数据）', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'a' });
    put(d, 'p2', 'P', 'o', { extKey: 'b' });
    const idx = buildExtKeyIndex(d);

    const res = assignExtKey(d, 'p1', 'b', idx, { allowOverwrite: true });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'key-taken');
    assert.equal(d.nodes.p1.extKey, 'a', '失败时不改动');
    assert.equal(d.nodes.p2.extKey, 'b', '持有者不受影响');
});

test('更换不会影响其它节点的 key', () => {
    const d = makeDraft();
    put(d, 'p1', 'P', 'o', { extKey: 'a' });
    put(d, 'p2', 'P', 'o', { extKey: 'b' });
    const idx = buildExtKeyIndex(d);

    assignExtKey(d, 'p1', 'c', idx, { allowOverwrite: true });
    assert.equal(d.nodes.p2.extKey, 'b');
    assert.equal(idx.b, 'p2');
    assert.equal(idx.c, 'p1');
    assert.equal(idx.a, undefined);
});
