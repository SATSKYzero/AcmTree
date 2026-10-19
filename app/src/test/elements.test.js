// ================================================================
// 元素属性表测试（core/model/elements.js）
//
// 这张表是"有哪些元素、每个元素什么性质"的**唯一属性源**，
// 所以这里钉三件事：
//   1. 它派生的清单 == 既有的那份（**零行为变化的保证**）；
//   2. 它和别的真源对齐（节点默认值 / upsert 的派生字段与结构字段）；
//   3. 规则查的是属性，不是 if —— 派生元素不许被记来源，
//      `remark`（手改留痕但导入不写）、`tags`（列表型）各按属性说话。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    ELEMENT_NATURE,
    ELEMENTS,
    ELEMENT_NAMES,
    elementOf,
    isElement,
    natureOf,
    shapeOf,
    isImportable,
    isManuallyEditable,
    importableElements,
    elementsOfType,
    isFieldApplicableTo,
    normalizeFieldValue,
    isEmptyFieldValue,
    fieldValueKey,
    formatFieldValue,
    pinValuesOf,
    isPinValue,
    normalizeTagList,
    isCanonicalTagList,
    toCacheShape
} from '../core/model/elements.js';
import { DEFAULT_TAG_COLOR } from '../A_constants.js';
import { WRITABLE_VALUE_FIELDS } from '../core/fieldValue.js';
import { WRITABLE_FIELDS } from '../features/AutoImport/constants.js';
import { PROTECTED_NODE_KEYS, AUTO_NODE_KEYS } from '../core/ops/upsert.js';
import { createNode } from '../core/model/node.js';

/** 既有的可写字段清单（core/fieldValue.js 与 features/AutoImport/constants.js 各一份） */
const LEGACY_WRITABLE = [
    'name', 'problemId', 'cfDifficulty', 'atcoderDifficulty', 'clistDifficulty', 'ratio', 'link', 'tags', 'contestTime',
    'kind', 'identityKey',
    // 合成：合成节点的身份 + 原料节点的指针（导入可写 ⇒ 在这份清单里；
    // 但 `manual: false` —— 它们是全局结构，不记手改来源值）
    'synthKey', 'ownerSynth',
    'submitKind', 'time', 'status',
    // 「先提取备用」：提交的运行信息（CF/QOJ 都有；口径：毫秒 / 字节）
    'language', 'timeUsed', 'memoryUsed', 'codeLength',
    // 「性质」四字段：分类 / 年份（举办）/ 赛季 / 地区。
    // 都是普通字段而且**跨类型**（`types: '*'`），所以排在通用字段段落的最后。
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion',
    // ★ 「这一组（题目组）人确认过」—— **组级标记**，只落在题目组头上（`types: ['P']`）。
    //   排最后：它是唯一一个"组的结论"性质的字段（其余都是成员/节点自己的值）。
    '已确认',
    // ★ 「这一条与同号那道题不是同一道」（成员级；人在 ⑤ 点「✂️ 不同的题」打上）
    '拆开'
];

test('派生的可写清单 == 既有的那份（顺序也一样）', () => {
    assert.deepEqual([...WRITABLE_VALUE_FIELDS], LEGACY_WRITABLE, 'core/fieldValue.js 的清单');
    assert.deepEqual([...WRITABLE_FIELDS], LEGACY_WRITABLE, 'features/AutoImport/constants.js 的清单');
    assert.deepEqual(importableElements(), LEGACY_WRITABLE, '属性表自己派生的清单');
});

test('元素表与节点默认值对齐（防止"表里写了、节点上没有"）', () => {
    // 节点实际会有的字段 = createNode 出来的键（含各类型默认值与通用默认值）
    const actual = new Set();
    for (const type of ['O', 'W', 'S', 'C', 'P', 'R']) {
        for (const k of Object.keys(createNode('probe_' + type, type, {}))) actual.add(k);
    }
    // 由**插件迁移**补上的键（单测里没 bootstrap 插件，所以不在 createNode 的结果里）
    const fromMigrations = new Set(['extKey', 'importFingerprint', 'importSource']);
    // `origin` 由创建路径（addChild / applyPlans）写，不在 `createNode` 的默认值里 ——
    // 因为"谁建的"是创建动作的属性，不是节点类型的默认值。
    const notNodeKeys = new Set(['origin']);
    // 「性质」四字段："都可空 —— 没标就是没标，别写默认值占位"，
    // 所以它们**故意不进** `COMMON_DEFAULTS`，改走 `extKey` 那套**插件迁移只补缺键**
    // （`features/AutoImport/index.js` 的 registerNodeMigration / registerVNodeMigration）。
    // ⇒ 单测里同样属于"插件补上的键"，与上面那三个同级。
    for (const k of ['natureClass', 'natureYear', 'natureSeason', 'natureRegion']) fromMigrations.add(k);
    // 「分类依据」（`{ natureClass: 'xcpc:name-stage' }`）：同一条路 ——
    // 它是 STRUCTURAL（不是业务字段），由插件迁移只补**缺的键**（空对象 = 没有依据信息）。
    fromMigrations.add('分类依据');
    // `expanded`：**已经不是节点字段了** —— 展开态住在 `state.view.expanded`
    // （`core/model/viewState.js`）。它在元素表里留着，是为了让**导入白名单继续拒绝**
    // 这个键（包里的 `expanded` 一律不许写进节点）⇒ 这里允许"表里有、节点上没有"。
    notNodeKeys.add('expanded');
    // currentPage 同理：页码也搬进视图态了（state.view.pages），表里留着只为挡住导入。
    notNodeKeys.add('currentPage');

    for (const key of ELEMENT_NAMES) {
        if (fromMigrations.has(key) || notNodeKeys.has(key)) continue;
        assert.equal(actual.has(key), true, `元素「${key}」在节点上不存在（表与模型漂移了）`);
    }
});

test('元素表与 upsert 的两份保护清单对齐', () => {
    for (const key of AUTO_NODE_KEYS) {
        assert.equal(natureOf(key), ELEMENT_NATURE.DERIVED, `${key} 该是派生元素`);
    }
    for (const key of PROTECTED_NODE_KEYS) {
        // upsert 的 PROTECTED = 结构/元信息 + 存在性（origin）
        const n = natureOf(key);
        assert.equal(n === ELEMENT_NATURE.STRUCTURAL || n === ELEMENT_NATURE.EXISTENCE, true,
            `${key} 该是结构或存在性元素，实际 ${n}`);
    }
    assert.equal(natureOf('origin'), ELEMENT_NATURE.EXISTENCE, 'origin = 存在性元素的值');
});

test('派生元素：不许进值级来源（不是"懒得记"，是记了没意义）', () => {
    for (const key of AUTO_NODE_KEYS) {
        assert.equal(isImportable(key), false, `${key} 导入不该写`);
        assert.equal(isManuallyEditable(key), false, `${key} 手改不该记`);
    }
});

test('remark：手改留痕，但导入永不写（题解是不可再生数据）', () => {
    assert.equal(natureOf('remark'), ELEMENT_NATURE.NOTE);
    assert.equal(isManuallyEditable('remark'), true, '手改要留痕');
    assert.equal(isImportable('remark'), false, '导入不许写');
});

test('tags：列表型元素（形状由属性声明，不硬编码特判）', () => {
    assert.equal(natureOf('tags'), ELEMENT_NATURE.TAG_LIST);
    assert.equal(shapeOf('tags'), 'list');
    assert.equal(isImportable('tags'), true);
    assert.equal(isManuallyEditable('tags'), true);
    assert.equal(shapeOf('name'), 'scalar', '普通字段仍是标量');
});

test('identityKey：身份元素（导入可写 + 手改留痕，只读时禁）', () => {
    assert.equal(natureOf('identityKey'), ELEMENT_NATURE.IDENTITY);
    assert.equal(isImportable('identityKey'), true);
    assert.equal(isManuallyEditable('identityKey'), true);
});

// ================================================================
// 属性化的"特判"：覆盖值 / 是否按范围算
//
// 口径：**逻辑尽量通用、特判越少越好**。
// 所以"哪些派生值算用户覆盖""哪个派生字段暂时不按范围算"都写在属性表里，
// 写入/校验/迁移/派生引擎统一读它 —— 代码里不该再出现 `[1,4,5]` 这类名单。
// ================================================================

test('pinValues 是"覆盖值"的唯一真源（写入/校验/迁移都读它）', () => {
    assert.deepEqual(pinValuesOf('status2'), ['1', '4', '5'], '待写 / 赛时通过 / 忽略');
    assert.deepEqual(pinValuesOf('statusComplete2'), ['4'], '容器忽略');
    assert.deepEqual(pinValuesOf('name'), [], '普通字段没有"覆盖"这回事');
    assert.deepEqual(pinValuesOf('没这个字段'), []);

    assert.equal(isPinValue('status2', 5), true);
    assert.equal(isPinValue('status2', ' 5 '), true, '规范形式是字符串，数字也认');
    assert.equal(isPinValue('status2', 2), false, '"已提交未通过"是算出来的');
    assert.equal(isPinValue('status2', null), false);
    assert.equal(isPinValue('name', 5), false);
});

test('覆盖值只在派生元素上声明（普通字段靠 manual 的来源值表达）', () => {
    for (const key of ELEMENT_NAMES) {
        if (!pinValuesOf(key).length) continue;
        assert.equal(natureOf(key), ELEMENT_NATURE.DERIVED, `${key} 声明了覆盖，应该是派生元素`);
    }
});

test('未登记的元素：不猜性质（宁可漏记）', () => {
    assert.equal(isElement('没这个字段'), false);
    assert.equal(natureOf('没这个字段'), 'unknown');
    assert.equal(isImportable('没这个字段'), false);
    assert.equal(isManuallyEditable('没这个字段'), false);
    assert.equal(shapeOf('没这个字段'), 'scalar');
    assert.equal(elementOf(null), undefined);
});

test('elementsOfType：`*` 通用元素 + 该类型特有元素', () => {
    const p = elementsOfType('P');
    assert.equal(p.includes('ratio'), true, 'P 特有');
    assert.equal(p.includes('name'), true, '通用');
    assert.equal(p.includes('contestTime'), false, 'C 的字段不出现在 P 上');
    const c = elementsOfType('C');
    assert.equal(c.includes('contestTime'), true);
    assert.equal(c.includes('ratio'), false);
    assert.equal(elementsOfType('不存在的类型').includes('name'), true, '通用元素仍匹配');
});

test('表是不可变的（冻结）：规则读它，谁都不许改它', () => {
    assert.equal(Object.isFrozen(ELEMENTS), true);
    assert.equal(Object.isFrozen(ELEMENT_NAMES), true);
    assert.equal(Object.isFrozen(ELEMENT_NATURE), true);
    assert.throws(() => { 'use strict'; ELEMENTS.name = null; });
});

test('手改会留痕的元素：包含写值的那三个入口，不含派生/结构', () => {
    for (const k of ['name', 'problemId', 'cfDifficulty', 'ratio', 'link', 'tags',
                     'contestTime', 'kind', 'identityKey', 'time', 'status', 'remark',
                     'natureClass', 'natureYear', 'natureSeason', 'natureRegion']) {
        assert.equal(isManuallyEditable(k), true, `${k} 该能记手改`);
    }
    for (const k of ['status1', 'status2', 'xcpcDifficulty', 'id', 'values', 'expanded']) {
        assert.equal(isManuallyEditable(k), false, `${k} 不该记手改`);
    }
});

test('「性质」四字段：跨类型 + 导入可写 + 手改留痕（性质分区不受节点类型限制）', () => {
    for (const k of ['natureClass', 'natureYear', 'natureSeason', 'natureRegion']) {
        assert.equal(natureOf(k), ELEMENT_NATURE.FIELD, `${k} 该是普通字段`);
        assert.equal(isImportable(k), true, `${k} 爬虫产包要能写`);
        assert.equal(isManuallyEditable(k), true, `${k} 人也要能手改`);
        assert.equal(shapeOf(k), 'scalar', `${k} 是标量（不是一个组合对象）`);
        for (const type of ['O', 'W', 'S', 'C', 'P', 'R']) {
            assert.equal(isFieldApplicableTo(k, type), true, `${k} 该适用于 ${type}`);
        }
        // **可空**：空值不算一个"值"（不记来源、不参与投影）
        assert.equal(isEmptyFieldValue(k, ''), true, `${k} 空值必须算空`);
    }
    assert.equal(elementsOfType('P').includes('natureClass'), true, '通用元素');
});

// ================================================================
// 值的形状（标量 / 列表）—— 规范化、空值、比较、显示
// ================================================================

test('P6 normalizeFieldValue：标量 trim；`-` 保留原样', () => {
    assert.equal(normalizeFieldValue('name', '  A  '), 'A');
    assert.equal(normalizeFieldValue('status', '-'), '-');
    assert.equal(normalizeFieldValue('name', 42), '42', '数字也照常转字符串');
    assert.equal(normalizeFieldValue('name', undefined), '');
});

test('P6 normalizeFieldValue：列表去空、去重、保序，并从对象里取 text', () => {
    assert.deepEqual(normalizeFieldValue('tags', ['dp', ' math ', 'dp', '']), ['dp', 'math']);
    assert.deepEqual(normalizeFieldValue('tags', [{ text: '图论' }, { text: 'dp', color: '红' }]),
        ['图论', 'dp'], '对象数组取 text（颜色/ID 是节点自己的展示信息）');
    assert.deepEqual(normalizeFieldValue('tags', '单值'), ['单值'], '给个单值也能收下');
    assert.deepEqual(normalizeFieldValue('tags', undefined), []);
    assert.deepEqual(normalizeFieldValue('tags', [{ v: 'v 也算' }]), ['v 也算']);
});

test('P6 isEmptyFieldValue：空列表算空；`-` **不算**空', () => {
    assert.equal(isEmptyFieldValue('tags', []), true);
    assert.equal(isEmptyFieldValue('tags', ['dp']), false);
    assert.equal(isEmptyFieldValue('name', '  '), true);
    assert.equal(isEmptyFieldValue('status', '-'), false, '`-` 是合法值（与 core/trust.js 口径一致）');
});

test('B5 normalizeTagList：缓存字段的形状是 `[{id,text,color}]`', () => {
    const fromStrings = normalizeTagList(['dp', ' math ', 'dp', '']);
    assert.deepEqual(fromStrings.map(t => t.text), ['dp', 'math'], '去空、去重、保序');
    assert.equal(fromStrings.every(t => typeof t.id === 'string' && t.id.length > 0), true, '补稳定 id');
    assert.equal(fromStrings.every(t => t.color === DEFAULT_TAG_COLOR), true, '补默认颜色');

    // 已经是对象的：保留 id 与颜色，只补齐缺的
    const kept = normalizeTagList([{ id: 'x1', text: '图论', color: '红' }, { text: 'dp' }]);
    assert.deepEqual(kept[0], { id: 'x1', text: '图论', color: '红' });
    assert.equal(kept[1].text, 'dp');

    // 同一个文字 → 同一个 id（重复加载不会换 id）
    assert.equal(normalizeTagList(['dp'])[0].id, normalizeTagList(['dp'])[0].id);
    assert.equal(isCanonicalTagList(fromStrings), true);
    assert.equal(isCanonicalTagList(['dp']), false, '字符串数组不是规范形状');
    assert.equal(isCanonicalTagList([{ text: 'dp' }]), false, '缺 id/color 也不算');
    assert.deepEqual(normalizeTagList(undefined), []);
    assert.deepEqual(toCacheShape('tags', ['dp']), normalizeTagList(['dp']), 'toCacheShape 只对列表型元素转形状');
    assert.equal(toCacheShape('name', 'A'), 'A', '标量元素原样返回');
});

test('P6 fieldValueKey：同内容的两个列表键相同（顺序不同则不同）', () => {
    assert.equal(fieldValueKey('tags', ['dp', 'math']), fieldValueKey('tags', ['dp', 'math']));
    assert.notEqual(fieldValueKey('tags', ['dp', 'math']), fieldValueKey('tags', ['math', 'dp']),
        '顺序不同 = 不同的说法（不替用户排序）');
    assert.equal(fieldValueKey('tags', [{ text: 'dp' }]), fieldValueKey('tags', ['dp']),
        '对象与文字等价');
    assert.equal(fieldValueKey('name', 'A'), 'A');
});

test('P6 formatFieldValue：列表用「、」连起来给人看', () => {
    assert.equal(formatFieldValue('tags', ['dp', 'math']), 'dp、math');
    assert.equal(formatFieldValue('tags', []), '');
    assert.equal(formatFieldValue('name', 'A'), 'A');
});
