// ================================================================
// 状态2 的四张表必须**一样长**（A_constants.js）
//
// 四张表：`STATUS2_VALUES`（下拉取值）/ `STATUS2_LABELS`（词表）/ `STATUS2_ICONS`
// （对比页短标记）/ `STATUS2_COLORS`（配色）。它们分散着长过一次事故：
// 标签与取值各写各的 —— 加第七档状态时，下拉里选不到、
// 对比页没有图标、颜色缺一格，而且**没有任何测试会红**。
//
// 这张守卫只做一件事：让"加档却漏改一处"立刻红。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    STATUS2_VALUES, STATUS2_LABELS, STATUS2_ICONS, STATUS2_COLORS, STATUS2_FIELD_INFO
} from '../A_constants.js';

const readSrc = (rel) => fs.readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

test('状态2 的取值 / 词表 / 图标 / 配色**四张表一样长**', () => {
    const n = STATUS2_LABELS.length;
    assert.equal(STATUS2_VALUES.length, n,
        `取值 ${STATUS2_VALUES.length} 个、词表 ${n} 个 —— 加档时两张表要一起改`);
    assert.equal(STATUS2_ICONS.length, n,
        `图标 ${STATUS2_ICONS.length} 个、词表 ${n} 个 —— 对比页按**位次**取图标，短一个就错位`);
    assert.deepEqual(STATUS2_VALUES, STATUS2_VALUES.map((_, i) => i),
        '取值必须是 0..n-1 连续（下拉与配色都按它索引）');
    for (const v of STATUS2_VALUES) {
        assert.ok(STATUS2_COLORS[v], `配色缺第 ${v} 档`);
        assert.ok(String(STATUS2_LABELS[v] || '').trim(), `词表缺第 ${v} 档`);
    }
});

test('`STATUS2_FIELD_INFO`（编辑面板那一项）逐档来自词表与取值表', () => {
    assert.deepEqual(STATUS2_FIELD_INFO.options, STATUS2_VALUES.map(String),
        '下拉取值必须与取值表逐项一致');
    for (const v of STATUS2_VALUES) {
        assert.ok(STATUS2_FIELD_INFO.label.includes(`${v}${STATUS2_LABELS[v]}`),
            `文案里缺第 ${v} 档（${v}${STATUS2_LABELS[v]}）`);
    }
});

// ⚠️ 下面这条是**源码级 lint**，不假装它证明行为：`ui/G_modal/editForm.js` 要 import 整个
//    shell（`immer` 在 Node 单测里解析不到），所以只能这样断言"没有第二处手写"。
//    真正跑得到的那半边在上一条（`STATUS2_FIELD_INFO` 本身逐档对得上）。
test('编辑面板 / 批量导入面板**不许再手写**状态2 的文案与取值范围', () => {
    const edit = readSrc('ui/G_modal/editForm.js');
    // 「用了派生件」才是关键那条：手写回去必然去掉这个 spread ⇒ 红。
    // （不去查"有没有以 '0','1','2' 开头的数组" —— 同文件里容器那档 statusComplete2
    //   本来就是这个形状，那样的正则只会误报。）
    assert.ok(/\.\.\.STATUS2_FIELD_INFO/.test(edit), '编辑面板的 status2 要 spread STATUS2_FIELD_INFO');
    assert.ok(!/0未使用/.test(edit), '编辑面板不许再手写「0未使用…」那串文案');
    const batch = readSrc('handlers/H2_batchImport.js');
    assert.ok(/STATUS2_VALUES/.test(batch), '批量导入面板的取值范围也要派生');
    assert.ok(!/状态2 \(0-5\)/.test(batch), '不许再手写「状态2 (0-5)」');
});
