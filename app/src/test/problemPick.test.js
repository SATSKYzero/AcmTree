// ================================================================
// 「按条件挑题」测试（core/problemPick.js）
//
// 设计稿 `docs/training-plan.md` ㉒㉓："筛选放在**更靠前的环节**"——题单形成时挑好，计划那边不再筛。
// 这个模块就是那一步的**唯一一份判据**（`ui/G_modal/G5_actions.js:promptTodoProblemSheet` 调它）。
//
// ⚠️ 老行为（「未通过/待处理」）是**默认值**：这一组必须有"不给条件时结果与以前一字不差"的回归锚。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickProblemsOf, tagNamesOf, platformOf, DEFAULT_PICK_FILTER } from '../core/problemPick.js';
import { XCPC_ORDER, XCPC_UNFILLED } from '../utils/color.js';

/** 五道题：状态/档位/数值难度/标签/平台各不同 */
function fixture() {
    const P = (id, extra) => ({ id, type: 'P', name: id, values: {}, ...extra });
    return {
        nodes: {
            root: { id: 'root', type: 'O', values: {} },
            c1: { id: 'c1', type: 'C', values: {} },
            p1: P('p1', { status2: 0, status1: 0, xcpcDifficulty: '银牌', cfDifficulty: 1900, tags: ['dp'], natureClass: 'cf/gyms' }),
            p2: P('p2', { status2: 2, status1: 1, xcpcDifficulty: '铜牌', cfDifficulty: 1300, tags: ['math', 'dp'], natureClass: 'qoj/xcpc' }),
            p3: P('p3', { status2: 4, status1: 1, xcpcDifficulty: '金牌', cfDifficulty: 2600, tags: ['flow'], natureClass: 'cf/contest' }),
            p4: P('p4', { status2: 5, status1: 1, tags: ['dp'], natureClass: 'atcoder/abc' }),
            p5: P('p5', { status2: 3, status1: 0, xcpcDifficulty: '银牌' })
        },
        childOrder: { root: ['c1'], c1: ['p1', 'p2', 'p3', 'p4', 'p5'], p1: [], p2: [], p3: [], p4: [], p5: [] },
        parentOf: { c1: 'root', p1: 'c1', p2: 'c1', p3: 'c1', p4: 'c1', p5: 'c1' }
    };
}
const ids = (r) => r.matched.map((p) => p.id);

test('★ 不给条件 = 老口径（未通过/待处理）：status2 ∈ {0,1,2} 或 status1 === 0', () => {
    const st = fixture();
    const r = pickProblemsOf(st, 'c1', {});
    assert.deepEqual(ids(r).sort(), ['p1', 'p2', 'p5']);
    assert.equal(r.total, 5, '子树里一共 5 道题');
    assert.deepEqual(DEFAULT_PICK_FILTER.statuses, [0, 1, 2], '默认状态名单就是老那三个');
});

test('状态可以自己勾：只要"已提交未通过"、或连"忽略"也一起挑', () => {
    const st = fixture();
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { statuses: [2], includeUnhandled: false })).sort(), ['p2']);
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { statuses: [2, 5], includeUnhandled: false })).sort(), ['p2', 'p4']);
    const withIgnore = pickProblemsOf(st, 'c1', { statuses: [0, 1, 2, 5], includeUnhandled: true });
    assert.deepEqual(ids(withIgnore).sort(), ['p1', 'p2', 'p4', 'p5'], '忽略也能被挑进来（勾了才要）');
});

test('档位 / 数值难度 / 标签 / 平台四个维度各自生效（空 = 不限）', () => {
    const st = fixture();
    // ⚠️ 别忘了**默认状态口径**也在生效：p3 是"赛时通过"（s2=4）⇒ 想按难度挑它得先把状态放宽
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { levels: ['银牌'] })).sort(), ['p1', 'p5']);
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { statuses: [4], includeUnhandled: false, cfMin: 2000 })).sort(), ['p3']);
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { cfMax: 1400 })).sort(), ['p2'],
        'p1 是 1900 ⇒ 超上限；p5 没填难度 ⇒ 设了区间就排除（见下一条测试）');
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { tags: ['dp'] })).sort(), ['p1', 'p2'],
        'p5 没有标签；p4 有 dp 但状态是"忽略"且已处理 ⇒ 状态那关就没过');
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { platforms: ['cf'] })).sort(), ['p1'],
        'p3 也是 cf，但它是"赛时通过" ⇒ 默认状态口径下不进候选');
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { tags: ['dp'], levels: ['铜牌'] })).sort(), ['p2'],
        '多条维度之间是"与"');
});

test('★ 设了数值区间时，**没填难度**的题被排除并单独计数（别静默当 0 分）', () => {
    const st = fixture();
    const r = pickProblemsOf(st, 'c1', { cfMin: 1000 });
    assert.equal(r.unknownDifficulty, 1, 'p4 没填难度 ⇒ 只因这一条被排除');
    assert.ok(!ids(r).includes('p4'));
    const noRange = pickProblemsOf(st, 'c1', {});
    assert.equal(noRange.unknownDifficulty, 0, '不设区间就不算"未知难度"（老行为不变）');
});

test('被各维度剔掉的数目都记着（界面能如实说"筛掉了多少"）', () => {
    const st = fixture();
    const r = pickProblemsOf(st, 'c1', { levels: ['银牌'], tags: ['dp'] });
    assert.deepEqual(ids(r).sort(), ['p1'], '只剩 p1：p2 档位不符、p5 没有 dp 标签');
    // 精确数目（不是"至少几道"）：候选是 p1/p2/p5 ⇒ p2 档位不符、p5 没标签，各 1 道
    assert.equal(r.droppedByLevel, 1, '档位筛掉 1 道（p2 是铜牌）');
    assert.equal(r.droppedByTag, 1, '标签筛掉 1 道（p5 没有 dp）');
});

test('标签 / 平台的归一化：来源层是字符串数组、缓存层是 [{id,text}]，两种都认', () => {
    assert.deepEqual(tagNamesOf(['dp', 'math']), ['dp', 'math']);
    assert.deepEqual(tagNamesOf([{ id: 't1', text: 'dp' }, { id: 't2', text: 'math' }]), ['dp', 'math']);
    assert.deepEqual(tagNamesOf('dp math,math'), ['dp', 'math'], '逗号/空格分开的也能认，且去重');
    assert.deepEqual(tagNamesOf(null), []);
    assert.equal(platformOf('cf/gyms/2025'), 'cf');
    assert.equal(platformOf(''), '');
    assert.equal(platformOf(undefined), '');
});

test('档位名单只认 `XCPC_ORDER` 里的（乱填的档位当没填 ⇒ 不会挑中任何东西）', () => {
    const st = fixture();
    assert.ok(XCPC_ORDER.includes('银牌'));
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { levels: ['不存在的档'] })), [],
        '★ 乱填的档位**挑不中任何东西**（别偷偷当成"不限"、把全部题都给你）');
});

test('★ 「未填写」当**哨兵**用：勾它 = 只要没填难度的题（用户第 4 轮："XCPC 难度也可以勾选"）', () => {
    const st = fixture();
    assert.equal(XCPC_UNFILLED, '未填写', '哨兵字面量的唯一一份在 `utils/color.js`');
    // p4 / p5 都没填 `xcpcDifficulty`（p5 只有 status2=3 ⇒ 得把状态放宽才进候选）
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { levels: [XCPC_UNFILLED], statuses: [5], includeUnhandled: true })).sort(),
        ['p4'], '勾「未填写」⇒ 只剩没填档位的那道（在候选里的）');
    assert.deepEqual(ids(pickProblemsOf(st, 'c1', { levels: ['银牌'] })).sort(), ['p1', 'p5'],
        '⚠️ 不勾「未填写」时，没填档位的照旧被排除（失败方向仍然安全）');
    const union = pickProblemsOf(st, 'c1', { levels: ['银牌', XCPC_UNFILLED], statuses: [0, 3, 4, 5], includeUnhandled: true });
    assert.deepEqual(ids(union).sort(), ['p1', 'p4', 'p5'],
        '★ 多选：两档一起勾 = 取并集（p3 是金牌 ⇒ 不在里面；p2 状态是 2 ⇒ 状态那关没过）');
});
// ================================================================
// 源码级锚：**挑题的判据只有一份**（UI 不许再写一遍 if）
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');

test('★ 挑题弹窗调的是 `pickProblemsOf`，没在 UI 里再抄一遍筛法（源码级锚）', () => {
    // ⚠️ **先去掉注释再匹配**（注释里提到那些写法是**故意的** —— 它就是写着"别这么干"）
    const src = read('src/ui/G_modal/G5_todoSheet.js')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(/pickProblemsOf\s*\(/.test(src), '必须调那一份纯函数');
    // "再抄一遍"的三种典型写法，一个都不许有（注释里提到名字没关系，这里只看裸写法）
    assert.equal(/status2\s*===\s*0\s*\|\|/.test(src), false, '不许自己写"未通过"那串 if');
    assert.equal(/XCPC_ORDER\.includes\(/.test(src) && /levels\.length/.test(src), false,
        '档位命中判断也不许在这儿重写（那是 `pickProblemsOf` 的事）');
});

test('★ 入口还在：`G5_actions.js` 转发 `promptTodoProblemSheet`（老入口不许断）', () => {
    const src = read('src/ui/G_modal/G5_actions.js');
    assert.ok(/export\s*\{\s*promptTodoProblemSheet\s*\}\s*from\s*'\.\/G5_todoSheet\.js'/.test(src),
        '`G5_actions.js` 要转发过去（`G_modals.js` 是从它那儿再导出的）');
    const modals = read('src/ui/G_modal/G_modals.js');
    assert.ok(/promptTodoProblemSheet/.test(modals), '`G_modals.js` 的导出名单里也得还在');
});