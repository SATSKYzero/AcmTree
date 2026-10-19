// ================================================================
// 时间格式：**存储 14 位（带秒）/ 显示 12 位（截到分钟）**
//
// 口径：脚本普遍用 14 位时间。理由：
//   - 同一分钟内的多条提交（QOJ 很常见）靠秒才排得对 → `acTime` 才准；
//   - QOJ 的 VP 记录本身就带秒（`2026-09-23 20:29:58`），12 位会把它丢掉。
// 但树上摆一串秒太吵 → 显示一律走 `displayTime`，收敛到一处。
//
// 铁律：`normalizeTime` **给了秒就保留**，**没给就不补 `:00`**（不造精度）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTime, displayTime, getNowStr } from '../utils/time.js';

test('normalizeTime：给了秒就保留（14 位路径）', () => {
    assert.equal(normalizeTime('2026.09.24 01:18:37').value, '2026.09.24 01:18:37');
    assert.equal(normalizeTime('20260924011837').value, '2026.09.24 01:18:37');
    assert.equal(normalizeTime('2026-09-24 01:18:37').value, '2026.09.24 01:18:37');
    assert.equal(normalizeTime('2026-09-24T01:18:37+08:00').value, '2026.09.24 01:18:37');
});

test('秒为 00 不写（与 scripts/crate.py 的 normalize_time / to_cst 同一口径）', () => {
    // 为什么：否则每个整点时间都拖着一条没意义的 :00，而且"同一个时刻走 ISO 路径
    // 与走中文/数字路径"会得到不同的串。
    assert.equal(normalizeTime('2026.09.24 01:18:00').value, '2026.09.24 01:18');
    assert.equal(normalizeTime('20260924011800').value, '2026.09.24 01:18');
    assert.equal(displayTime('2026.09.24 01:18:00'), '2026.09.24 01:18');
    assert.equal(displayTime('20260924011800'), '2026.09.24 01:18');
});

test('normalizeTime：没给秒就不补 :00（不造精度）', () => {
    assert.equal(normalizeTime('2026.09.24 01:18').value, '2026.09.24 01:18');
    assert.equal(normalizeTime('202609240118').value, '2026.09.24 01:18');
});

test('normalizeTime：同一分钟内的两条提交，带秒后能分出先后（字符串排序）', () => {
    const a = normalizeTime('2026.09.24 01:18:05').value;
    const b = normalizeTime('2026.09.24 01:18:37').value;
    assert.ok(a < b, `${a} 应排在 ${b} 之前`);
    // 12 位（截到分钟）会判成相等 → acTime 取错
    const a12 = normalizeTime('202609240118').value;
    const b12 = normalizeTime('202609240118').value;
    assert.equal(a12, b12, '截到分钟就分不出先后 —— 这正是 12 位口径的问题');
});

test('displayTime：**有秒就显示秒**（同一分钟多条要看得出先后）', () => {
    assert.equal(displayTime('2026.09.24 01:18:37'), '2026.09.24 01:18:37');
    assert.equal(displayTime('2026.09.24 01:18'), '2026.09.24 01:18');
    assert.equal(displayTime('20260924011837'), '2026.09.24 01:18:37');
    assert.equal(displayTime('2026-09-24 01:18:37'), '2026.09.24 01:18:37');
    assert.equal(displayTime('2026-09-24T01:18:37+08:00'), '2026.09.24 01:18:37');
});

test('displayTime：占位符 / 空值原样返回（别把 `----.--.-- --:--` 弄坏）', () => {
    assert.equal(displayTime('----.--.-- --:--'), '----.--.-- --:--');
    assert.equal(displayTime(''), '');
    assert.equal(displayTime(null), '');
    assert.equal(displayTime('-'), '-');
});

test('getNowStr：带秒（新写入的节点时间也是 14 位）', () => {
    const now = getNowStr();
    assert.match(now, /^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/, `实际：${now}`);
});
