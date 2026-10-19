// ================================================================
// 冒烟：**被忽略的提交**（scripts/smoke/ignored-submission.smoke.mjs）
//
// 用户 2026-10-13 的第 1 条 + 方向："Ac时间的第 4 种状态：截断后取最早，忽略截断前的所有提交
// （用于重复利用训练资源）"；实现方向："提交**不存更多字段**，只是**按条件判断**（提交是否忽略）
// **整体渲染变淡**"。
//
// 这个文件只钉**观感那一半**（"算不算数"那一半在 `src/test/acTimeRule.test.js`）：
//   R 行该不该带 `.node-ignored`。判据必须与派生那条链**同一个函数**
//   （`core/acTimeRule.js:isSubmissionIgnored`），否则会出现"看着算进去了、其实没算"。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

installDom([]);
const { renderNode } = await import(mod('view/renderers.js'));
const { createInitialState } = await import(mod('core/model/state.js'));

/** 一发提交（R），只带渲染真正读的那几格 */
function makeState(settings, time) {
    const base = createInitialState();
    const st = {};
    for (const k of Object.keys(base)) st[k] = base[k];
    st.settings = { ...base.settings, ...settings };
    st.nodes = {
        o: { id: 'o', type: 'O', name: '根', values: {} },
        p1: { id: 'p1', type: 'P', name: '题', values: {} },
        r1: { id: 'r1', type: 'R', status: 'WA', time, submitKind: 'upsolve',
            createdAt: 'C', lastModified: 'M',
            values: { status: [{ v: 'WA', src: 'qoj', at: 'T1' }], time: [{ v: time, src: 'qoj', at: 'T1' }] } }
    };
    st.childOrder = { o: ['p1'], p1: ['r1'], r1: [] };
    st.parentOf = { p1: 'o', r1: 'p1' };
    st.rootId = 'o';
    st.view = {};
    st.pages = {};
    return st;
}
/** 把一个 R 节点渲染成 HTML（只画这一层：`shallow` + `readonly`） */
const htmlOfR = st => renderNode(st, st.nodes.r1, 0, [st.nodes.r1], 'p1', true, 'readonly');

group('① 前三种规则：R 行一律**不变淡**（回归锚 —— 老行为一字不变）');
{
    for (const r of ['earliest', 'latest', 'cutoff']) {
        const st = makeState({ acTimeRule: r, acTimeCutoff: '20260101' }, '2019.01.01 10:00:00');
        ok(!htmlOfR(st).includes('node-ignored'), `${r}：2019 那发照旧（只有第 4 种才忽略）`);
    }
}

group('② 第 4 种规则：早于截断的提交 ⇒ **整体变淡**；晚于的 ⇒ 不变');
{
    const cut = { acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' };
    const old = makeState(cut, '2019.01.01 10:00:00');
    ok(htmlOfR(old).includes('node-ignored'), '★ 早于截断 ⇒ 带 `.node-ignored`（整体变淡）');
    const now = makeState(cut, '2026.03.19 22:32:42');
    ok(!htmlOfR(now).includes('node-ignored'), '晚于截断 ⇒ 不变淡');
    // 恰好等于截断 ⇒ **不**忽略（与"入选"的 `>=` 互补）
    const edge = makeState(cut, '2026.01.01 00:00:00');
    ok(!htmlOfR(edge).includes('node-ignored'), '★ 恰好等于截断 ⇒ 不算被忽略（闭区间那一侧）');
    // 时间认不出（占位符）⇒ 不忽略（别把"没时间"当"截断前"）
    const none = makeState(cut, '----.--.-- --:--');
    ok(!htmlOfR(none).includes('node-ignored'), '没有时间的提交不变淡');
}

group('③ 变淡只是**观感**：方框还在、还能点（没被藏起来）');
{
    const cut = { acTimeRule: 'cutoffIgnore', acTimeCutoff: '20260101' };
    const html = htmlOfR(makeState(cut, '2019.01.01 10:00:00'));
    ok(html.includes('data-id="r1"'), '★ 仍然画出来（用户要的是"还在、只是不算"）');
    ok(!/display:\s*none/.test(html), '没有把它藏掉');
}

report('被忽略的提交：整体变淡');
