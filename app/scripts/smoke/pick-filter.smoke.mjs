// ================================================================
// 冒烟测试：「四维条件」共用件真的成立（scripts/smoke/pick-filter.smoke.mjs）
//
// 背景（`v9.4.0`）：这套条件原来只有一处界面（`G5_todoSheet.js` 里的私有 `chipRow`），
// 现在**两个入口**都要用它 —— ①「📋 按条件挑题 → 生成题单页」②计划设置的「⚙ 条件…」
// （计划的题集按 `plan.pick` 自动筛，`core/problemPick.js:matchesProblemFilter` 是判据）。
// 可执行的判据是三件事：
//   ① 渲染件产出的控件就那四个（档位芯片 / 数值区间两个框 / 标签芯片 / 平台芯片），id 固定；
//   ② 读回只有一份：勾了就给值、**空就给空串**（`Number('')===0` 会把"不限"变成"区间 0~0"，实测踩过）；
//   ③ 两个入口都真的从这个文件取（源码锚 —— 谁再抄一份就红）。
//
// ⚠️ 用 `installDom([], { parseHtml: true })`：条件那一段是拼 `innerHTML` 的，
//    不开解析开关的话 `panel.querySelector('#pick-cf-min')` 永远拿不到（断言会空转地绿）。
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { installDom, makeContainer } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = (rel) => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;
const raw = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const body = installDom([], { parseHtml: true });
const app = makeContainer(body, 'app');
for (const id of ['toast', 'tree-body', 'tree-container', 'tab-main']) makeContainer(app, id);
globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });

const { AppState } = await import(mod('shell/state.js'));
const { createInitialState } = await import(mod('core/model/state.js'));
const kit = await import(mod('ui/kit/pickFilter.js'));
const planPage = await import(mod('ui/plan/planPage.js'));
const { promptTodoProblemSheet } = await import(mod('ui/G_modal/G5_todoSheet.js'));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

/** 一棵小树：C 下两道题（带标签/平台，好让"可选值"那两行不为空） */
function seed() {
    const base = createInitialState();
    for (const k of Object.keys(base)) AppState[k] = base[k];
    AppState.nodes = {
        root: { id: 'root', type: 'O', name: '根', values: {} },
        c1: { id: 'c1', type: 'C', name: '某场比赛', values: {} },
        p1: { id: 'p1', type: 'P', name: 'A题', problemId: 'A', status1: 0, status2: 0, tags: ['dp'], natureClass: 'cf/Div2' },
        p2: { id: 'p2', type: 'P', name: 'B题', problemId: 'B', status1: 0, status2: 0, tags: ['图论'], natureClass: 'qoj' }
    };
    AppState.childOrder = { root: ['c1'], c1: ['p1', 'p2'], p1: [], p2: [] };
    AppState.parentOf = { c1: 'root', p1: 'c1', p2: 'c1' };
    AppState.rootId = 'root';
    AppState.currentTab = 'main';
    AppState.currentPageId = 'main';
    AppState.pages = {};
}
const topOverlay = () => { const o = body.querySelectorAll('.modal-overlay'); return o[o.length - 1] || null; };
const closeAll = () => {
    while (topOverlay()) {
        const btn = topOverlay().querySelectorAll('.btn').find((b) => b.textContent === '取消');
        if (btn) btn.click(); else break;
    }
};

// ================================================================
group('① 渲染件就那四个控件（档位 / 数值区间 / 标签 / 平台）');
// ================================================================
seed();
const html = kit.pickConditionHtml({ rootIds: ['c1'], initial: { levels: ['银牌'], cfMin: '2400', tags: ['dp'], platforms: ['cf'] } });
const panelA = document.createElement('div');
panelA.innerHTML = html;
const chips = (key) => panelA.querySelectorAll(`[data-pick="${key}"]`);
ok(chips('level').length > 0, '档位芯片有（名单来自 `XCPC_ORDER` + 「未填写」）');
eq(chips('level').find((c) => c.value === '银牌').checked, true, '传进去的档位是勾上的');
// ⚠️ 桩的边界：没写 `checked` 属性的复选框，解析出来是 `undefined`（不是 `false`）⇒ 比 `!== true`
ok(chips('level').find((c) => c.value === '金牌').checked !== true, '没传的档位不勾');
ok(chips('tag').some((c) => c.value === 'dp'), '标签芯片来自"这个范围里现有哪些值"');
ok(chips('platform').some((c) => c.value === 'qoj'), '平台芯片同上（取 `natureClass` 第一段）');
eq(panelA.querySelector('#pick-cf-min').value, '2400', '数值下限那个框按传进去的值填好');
ok(!!panelA.querySelector('#pick-cf-max'), '数值上限那个框也在（id 固定：pick-cf-min / pick-cf-max）');

// ================================================================
group('② 读回只有一份：勾了给值、**空给空串**（不许变成 0）');
// ================================================================
eq(JSON.stringify(kit.readPickCondition(panelA)),
    JSON.stringify({ levels: ['银牌'], cfMin: '2400', cfMax: '', tags: ['dp'], platforms: ['cf'] }),
    '★ 读回 = 传进去的那一份（`cfMax` 空 ⇒ 空串，不是 0）');
const panelB = document.createElement('div');
panelB.innerHTML = kit.pickConditionHtml({ rootIds: ['c1'] });
eq(JSON.stringify(kit.readPickCondition(panelB)),
    JSON.stringify({ levels: [], cfMin: '', cfMax: '', tags: [], platforms: [] }),
    '★ 一个都不勾 / 都不填 ⇒ 四维全空（那一维"不限"）');
panelB.querySelector('#pick-cf-min').value = '0';           // ★ 用户**真的**填 0 要留住
eq(kit.readPickCondition(panelB).cfMin, '0', '★ 真填的 0 留住（只有空串才是"不限"）');

// ================================================================
group('③ 两个入口都从这个文件取（源码锚）');
// ================================================================
ok(/from '\.\.\/kit\/pickFilter\.js'/.test(raw('src/ui/G_modal/G5_todoSheet.js')),
    '挑题弹窗从共用件取');
ok(/from '\.\.\/kit\/pickFilter\.js'/.test(raw('src/ui/plan/planPage.js')),
    '计划设置从共用件取');
ok(!/function chipRow\(/.test(raw('src/ui/G_modal/G5_todoSheet.js')),
    '★ 挑题弹窗里**不再有**自己那份 `chipRow`（抄回去就红）');

// ================================================================
group('④ 真走一遍挑题弹窗：条件那一段就是共用件产出的');
// ================================================================
seed();
promptTodoProblemSheet('c1');
await tick(20);
const panel = topOverlay() && topOverlay().querySelector('.modal-panel');
ok(!!panel, '（前提）挑题弹窗开了');
ok(!!panel.querySelector('#pick-cf-min') && !!panel.querySelector('#pick-cf-max'),
    '★ 数值区间那两个框在（id 与共用件一致）');
ok(panel.querySelectorAll('[data-pick="level"]').length > 0, '★ 档位芯片在');
ok(panel.querySelectorAll('[data-pick="status"]').length > 0, '状态2 那两行**仍然**是本弹窗自己的（不进共用件）');
ok(!!panel.querySelector('#pick-unhandled'), '「只要没处理过的也算」那个勾还在');
closeAll();

// ================================================================
group('⑤ 计划侧那句条件摘要（唯一一份文本）');
// ================================================================
// ⚠️ 前缀是「**题集条件**」不是"条件"：它进数据（要保存），与「📋 题目列表」那栏的「列表筛选」不是一回事
//   （用户 2026-10-14 定："'筛选'确实要先看看具体语义" ⇒ 语义清单见 `docs/ui-conventions.md` 第 19 节）
eq(planPage.pickConditionTextOf({}), '题集条件：不限（五维都空）', '全空 ⇒ 明说"不限"');
// ★ 档位按**易 → 难**排（全仓口径只有这一条；摘要必须**与点选顺序无关** —— 芯片行永远按易→难画）
//   ⚠️ 方向别搞反：`-` 是**易**的那一端（`银牌-` 15% ＞ `银牌` 11% ＞ `银牌+` 8%）
ok(/档位 银牌-\/银牌/.test(planPage.pickConditionTextOf({ levels: ['银牌', '银牌-'] })),
    '★ 给 【银牌, 银牌-】（故意逆着点）⇒ 必须印成 银牌-/银牌（易 → 难）');
ok(/档位 银牌\/银牌\+\/未填写/.test(planPage.pickConditionTextOf({ levels: ['未填写', '银牌+', '银牌'] })),
    '★ 一次给三档（乱序 + 哨兵）⇒ 也按 易→难 排、认不出的（未填写）垫底');
ok(/数值 2400~2600/.test(planPage.pickConditionTextOf({ cfMin: '2400', cfMax: '2600' })), '数值区间照写');
ok(/数值 0~不限/.test(planPage.pickConditionTextOf({ cfMin: '0' })),
    '★ 填 0 摘要里写 0（不许被当成"不限"糊掉）');
ok(/标签 dp/.test(planPage.pickConditionTextOf({ tags: ['dp'] })) && /平台 cf/.test(planPage.pickConditionTextOf({ platforms: ['cf'] })),
    '标签 / 平台照列');

report();
