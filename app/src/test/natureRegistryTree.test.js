// ================================================================
// 性质注册表「树编辑」的单测（`src/test/natureRegistryTree.test.js`）
//
// 钉的是**规则**那一半（纯函数、不碰 DOM）：
//   · 同级顺序**有意义**（分类是"有序列表"落成的 `a/b/c`）⇒ 改名/上下移必须保序；
//   · 根与三片特殊叶子**不许删**（少一片就有值判不出来）；
//   · 名字的判据只有一份（空 / 首尾空白 / 带 `/` / 重名）；
//   · 编辑是**纯**的（原文档一个字不动）。
// 写盘那侧的闸在 `scripts/nature_registry_lib.py`（唯一一份形状判据），由 Python 自测钉。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SPECIAL_LEAVES,
    addChild,
    isSpecial,
    leafPaths,
    listRows,
    moveAt,
    patchField,
    pathText,
    patternProblem,
    readAt,
    removeAt,
    renameAt,
    validateName
} from '../ui/settings/natureRegistryTree.js';

const doc = () => ({
    registryVersion: 1,
    fields: {
        natureClass: { label: '分类', kind: 'classPath' },
        natureYear: { label: '年份', kind: 'pattern', pattern: '^(20\\d{2}|无)$' }
    },
    classTrie: {
        xcpc: { icpc: { aa: { pre: { official: {}, '无归类': {}, '未归类': {}, '上游异常': {} } } } },
        cf: { contest: {} }
    }
});
const keysOf = (d, path) => Object.keys(readAt(d, path));

test('`listRows` 只列"祖先都展开"的那些（根默认展开）', () => {
    const d = doc();
    assert.deepEqual(listRows(d, new Set()).map((r) => r.name), ['xcpc', 'cf'],
        '一个都没展开时只看到根那一层');
    const rows = listRows(d, new Set(['xcpc']));
    assert.deepEqual(rows.map((r) => pathText(r.path)), ['xcpc', 'xcpc/icpc', 'cf']);
    assert.equal(rows.find((r) => r.name === 'xcpc').leaf, false, '有子分类 ⇒ 不是叶子');
    const deep = listRows(d, new Set(['xcpc', 'xcpc/icpc', 'xcpc/icpc/aa', 'xcpc/icpc/aa/pre']));
    assert.equal(deep.filter((r) => r.leaf).length, 4,
        '展开到 pre：4 个叶子（official + 三片特殊叶子；cf 还没展开，它自己不是叶子）');
});

test('`leafPaths` = 所有叶子（特殊叶子也算叶子）', () => {
    const got = leafPaths(doc());
    assert.ok(got.includes('xcpc/icpc/aa/pre/official'));
    for (const name of SPECIAL_LEAVES) {
        assert.ok(got.some((p) => p.endsWith(`/${name}`)), `特殊叶子「${name}」要算叶子`);
    }
    assert.equal(got.length, 5, `叶子共 5 条（实际 ${got.length}）`);
});

test('`validateName`：空 / 首尾空白 / 带 `/` / 重名', () => {
    assert.equal(validateName('ec', ['icpc']), '');
    assert.match(validateName('', []), /不能是空/);
    assert.match(validateName('  ', []), /不能是空/);
    assert.match(validateName(' ec', []), /首尾空白/);
    assert.match(validateName('a/b', []), /分隔符/);
    assert.match(validateName('icpc', ['icpc']), /已经有/);
});

test('加子分类：能加、重名报错、特殊叶子下面不加、**原文档不动**', () => {
    const d = doc();
    const one = addChild(d, ['xcpc', 'icpc'], 'ec');
    assert.deepEqual(keysOf(one, ['xcpc', 'icpc']), ['aa', 'ec'], '新加的在最后');
    assert.deepEqual(keysOf(d, ['xcpc', 'icpc']), ['aa'], '★ 原来的那份一个字没动（纯函数）');
    assert.throws(() => addChild(d, ['xcpc', 'icpc'], 'aa'), /已经有/);
    assert.throws(() => addChild(d, ['xcpc', 'icpc'], 'a/b'), /分隔符/);
    assert.throws(() => addChild(d, ['xcpc', 'icpc', 'aa', 'pre', '无归类'], 'x'),
        /特殊叶子/, '特殊叶子是"这一维没有"的意思 ⇒ 下面不加子分类');
    assert.throws(() => addChild(d, ['不存在'], 'x'), /找不到/);
});

test('改名：**保持同级顺序**（顺序是语义）', () => {
    const d = addChild(doc(), ['xcpc', 'icpc'], 'zz');
    const one = renameAt(d, ['xcpc', 'icpc', 'aa'], 'aaa');
    assert.deepEqual(keysOf(one, ['xcpc', 'icpc']), ['aaa', 'zz'], '改名的那个**还在原位**');
    assert.throws(() => renameAt(d, ['xcpc', 'icpc', 'aa'], 'zz'), /已经有/);
    assert.throws(() => renameAt(d, ['xcpc'], 'x'), /根分类不能改名/);
    assert.deepEqual(renameAt(d, ['xcpc', 'icpc', 'aa'], 'aa'), d, '改成同一个名字 = 没变');
});

test('删分类：普通叶子能删；**根与特殊叶子不许删**', () => {
    const d = doc();
    assert.throws(() => removeAt(d, ['cf']), /根分类/, '根不许删（那是平台那一层）');
    assert.deepEqual(keysOf(removeAt(d, ['cf', 'contest']), ['cf']), [], '根下面那条能删');
    for (const name of SPECIAL_LEAVES) {
        assert.throws(() => removeAt(d, ['xcpc', 'icpc', 'aa', 'pre', name]), /不能删/,
            `特殊叶子「${name}」不许删`);
    }
});

test('上下移：交换同级顺序；到头了什么都不做', () => {
    const d = doc();                                     // 顺序：['xcpc', 'cf']
    assert.deepEqual(keysOf(moveAt(d, ['cf'], -1), []), ['cf', 'xcpc'], 'cf 上移一格');
    assert.deepEqual(keysOf(moveAt(d, ['xcpc'], 1), []), ['cf', 'xcpc'], 'xcpc 下移一格（等价）');
    assert.deepEqual(keysOf(moveAt(d, ['cf'], 1), []), ['xcpc', 'cf'], '已经在最后 ⇒ 不动');
    assert.deepEqual(keysOf(d, []), ['xcpc', 'cf'], '★ 原文档不受影响');
});

test('改字段：清空 = 删掉那一格；键名不在这个 API 里（改不了）', () => {
    const d = doc();
    const one = patchField(d, 'natureYear', { label: '年份（四位）', pattern: '' });
    assert.equal(one.fields.natureYear.label, '年份（四位）');
    assert.equal('pattern' in one.fields.natureYear, false, '清空 ⇒ 删键（不是写空串）');
    assert.equal(d.fields.natureYear.pattern, '^(20\\d{2}|无)$', '原文档不动');
    assert.throws(() => patchField(d, '不存在的字段', { label: 'x' }), /找不到字段/);
});

test('`patternProblem`：能编出来 / 编不出来 / 空', () => {
    assert.equal(patternProblem('^(20\\d{2}|无)$'), '');
    assert.match(patternProblem('^(20\\d{2}'), /编不出来/);
    assert.match(patternProblem(''), /不能是空/);
    assert.equal(isSpecial('无归类'), true);
    assert.equal(isSpecial('official'), false);
});
