// ================================================================
// 顶层字段注册表（A_registry.js 的 USER_FIELDS）派生守卫
//
// 病根：**凡是"新增一项要记得改 N 处"的地方，都出过一次事故。**
//   落盘形状（captureRef / emptyRef / loadData）、差分（diff.metaFields）、
//   导出包（buildExportData）、撤销快照（captureState）—— 六份"顶层字段名单"
//   各写各的，sources/trust、accounts、fieldRegistry/reports
//   各漏过一次，症状统一是"内存里有、刷新或往返一下就没了、还看不出来"。
//
// 现在名单只有一处（USER_FIELDS）。这份测试逐键证明**每个消费者都真的从它派生**：
// 谁把名单改回手写、或往 AppState 塞一个没登记的顶层字段，这里就红。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    USER_FIELDS, META_FIELD_KEYS, STORE_FIELD_KEYS, PERSISTED_FIELD_KEYS, SNAPSHOT_KEYS, EXPORT_KEYS,
    metaDefaults, metaFieldsFrom, importedState
} from '../A_registry.js';
import { createInitialState } from '../core/model/state.js';
import { captureRef, emptyRef, buildExportData } from '../persistence/index.js';
import { computeDiff } from '../persistence/diff.js';
import { captureState } from '../transaction/history.js';

const fresh = () => createInitialState();

// ---- ① 表与 state 对得上：不多一行、不少一行 ----
test('AppState 的顶层字段与注册表**一一对应**（加字段必须登记）', () => {
    const stateKeys = Object.keys(fresh()).sort();
    const tableKeys = Object.keys(USER_FIELDS).sort();
    assert.deepEqual(stateKeys, tableKeys,
        'AppState 顶层字段与 A_registry 的 USER_FIELDS 必须一致：'
        + '新增字段就加一行（persist/export/snapshot 三个开关 + 缺省值），'
        + '否则它在某条通道上会被静默丢掉');
});

// ---- ② 落盘形状：captureRef / emptyRef 逐键 ----
test('captureRef / emptyRef 的形状**逐键**等于"meta 表 + 三个 store 表 + infoState"', () => {
    const want = [...META_FIELD_KEYS, ...STORE_FIELD_KEYS, 'infoState'].sort();
    assert.deepEqual(Object.keys(captureRef(fresh())).sort(), want);
    assert.deepEqual(Object.keys(emptyRef()).sort(), want);

    // 每个 meta 键都要真的透传（不是"表里有、搬运时漏了"）
    for (const k of META_FIELD_KEYS) {
        const probe = { ...fresh(), [k]: { 探针: k } };
        assert.deepEqual(captureRef(probe)[k], { 探针: k }, `captureRef 漏了 ${k}`);
        // 空基线取的是**表里声明的**缺省值（不是随手写个 {}）
        assert.deepEqual(emptyRef()[k], USER_FIELDS[k].default, `emptyRef 的 ${k} 不是表里的缺省值`);
    }
    // 缺省值必须是**新副本**：改一份不该污染下一次
    const a = emptyRef();
    if (a.trust && typeof a.trust === 'object') a.trust.categoryRank.push('污染');
    assert.equal(emptyRef().trust.categoryRank.includes('污染'), false,
        'emptyRef 每次要给新的缺省值副本（共享引用会被就地改坏）');
    for (const k of STORE_FIELD_KEYS) assert.deepEqual(emptyRef()[k], {}, `空基线的 ${k} 该是空表`);
});

test('没登记的顶层字段**任何通道都不带**（想让它过就得先在表里登记）', () => {
    const st = { ...fresh(), 没登记的新字段: { x: 1 } };
    assert.ok(!('没登记的新字段' in captureRef(st)), '落盘形状只认表');
    assert.ok(!('没登记的新字段' in emptyRef()), '空基线只认表');
    assert.ok(!('没登记的新字段' in buildExportData(st)), '导出包只认表');
    assert.ok(!('没登记的新字段' in captureState(st)), '撤销快照只认表');
});

// ---- ③ 差分：diff.metaFields 逐键 ----
test('diff.metaFields **逐键**覆盖注册表里的落盘字段', () => {
    const before = fresh();
    for (const k of META_FIELD_KEYS) {
        const after = { ...before, [k]: { 改了: k } };
        const diff = computeDiff(before, after);
        assert.ok(diff.metaFields[k] !== undefined,
            `「${k}」改了却没进 diff.metaFields ⇒ 刷新一次就丢`);
    }
    // 不落盘的字段（派生索引）不该进
    for (const k of Object.keys(USER_FIELDS)) {
        if (META_FIELD_KEYS.includes(k)) continue;
        const after = { ...before, [k]: { 改了: k } };
        assert.equal(computeDiff(before, after).metaFields[k], undefined,
            `「${k}」不该落盘（注册表里 persist 为 false / 走独立 store）`);
    }
});

// ---- ④ 导出包：buildExportData 逐键 ----
test('导出包**逐键**覆盖注册表里 export: true 的字段，且不多带', () => {
    const out = buildExportData(fresh());
    for (const k of EXPORT_KEYS) {
        assert.ok(k in out, `导出包漏了「${k}」⇒ 导出→导入一轮就把它丢了`);
    }
    for (const k of Object.keys(USER_FIELDS)) {
        if (EXPORT_KEYS.includes(k)) continue;
        assert.ok(!(k in out), `导出包不该带「${k}」（注册表里 export: false）`);
    }
    // `meta` 必须**整节**导出：手写投影成 `{ idCounter }` 会把 `synthKeyCounter` 丢掉。
    // ⚠️ 断言要拿一个**带额外键**的 state 去试 —— 拿 `fresh()` 自己比是恒真的。
    const st = fresh();
    st.meta = { idCounter: 3, synthKeyCounter: 9 };
    assert.equal(buildExportData(st).meta.synthKeyCounter, 9,
        'meta 要整节导出（手写投影会把 synthKeyCounter 丢掉）');
});

// ---- ⑤ 撤销快照：captureState 逐键 ----
test('撤销快照**逐键**覆盖注册表里 snapshot: true 的字段', () => {
    const state = fresh();
    const snap = captureState(state);
    assert.deepEqual(Object.keys(snap).sort(), [...SNAPSHOT_KEYS].sort());
    for (const k of SNAPSHOT_KEYS) {
        assert.equal(snap[k], state[k], `快照漏了「${k}」⇒ 撤回不还原它`);
    }
});

// ---- ⑦ 导入通道：shell/executor.js 的 importState 用的 importedState ----
test('importedState：文件里有就用文件的；缺的沿用本机现值；再缺用缺省值', () => {
    const now = fresh();
    // ① 覆盖全部**落盘**字段（漏一个 = 文件里带着、导进来没有）
    const shape = importedState({}, now);
    assert.deepEqual(Object.keys(shape).sort(), [...PERSISTED_FIELD_KEYS].sort());
    for (const k of PERSISTED_FIELD_KEYS) {
        const incoming = { ...now, [k]: { 来自文件: k } };
        assert.deepEqual(importedState(incoming, now)[k], { 来自文件: k }, `导入通道漏了「${k}」`);
        // ② 文件里没有（老存档）⇒ 沿用本机现值，**不是**清空
        assert.equal(importedState({}, { ...now, [k]: now[k] })[k], now[k], `老存档不该把「${k}」抹掉`);
    }
    // ③ 两边都没有 ⇒ 用表里的缺省值
    assert.equal(importedState({}, {})['fieldRegistry'], null);
    assert.equal(importedState({}, {})['currentPageId'], 'main');
    // ④ 每个导出字段都必须被导入通道接住（这条把"导出侧派生、导入侧手写"的缝焊死）
    for (const k of EXPORT_KEYS) {
        assert.ok(PERSISTED_FIELD_KEYS.includes(k), `「${k}」能导出却不在导入名单里`);
    }
});

// ---- ⑥ 回填口径：loadData 用的 metaFieldsFrom ----
test('metaFieldsFrom：老存档缺键 → 缺省值；有键 → 用存档里的', () => {
    assert.deepEqual(metaFieldsFrom({}), metaDefaults());
    const loaded = metaFieldsFrom({ meta: { idCounter: 7 }, currentTab: 'stats' });
    assert.equal(loaded.meta.idCounter, 7);
    assert.equal(loaded.currentTab, 'stats');
    assert.equal(loaded.currentPageId, 'main', '存档里没有的键回落到缺省值');
    assert.equal(loaded.fieldRegistry, null);
    // 缺省值必须是**新副本**：就地改一份不该污染下一次加载（拿"两次调用互不相等"来断言是恒真的）
    const dirty = metaFieldsFrom({});
    dirty.trust.categoryRank.push('污染');
    assert.equal(metaFieldsFrom({}).trust.categoryRank.includes('污染'), false,
        '每次回填都要给新的缺省值副本（共享引用会被就地改坏）');
});
