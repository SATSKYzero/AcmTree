// ================================================================
// 冒烟：来源标签 + 模块可加载（scripts/smoke/src-label.smoke.mjs）
//
// 为什么有这一份（2026-10-13 实测踩到）：
//   `ui/G_modal/sourcePanel.js` **没有任何测试加载它** ⇒ 我在给它"补 import"时把
//   `isEmptyFieldValue` 加成了**重复声明**，`node --check` 只查语法、`npm test` / `npm run test:smoke`
//   全绿，**运行期才会炸**（真打开值级面板就报 `Identifier ... has already been declared`）。
//   ⇒ 这份文件干两件事：① 真的 import 一次那个模块（缺绑定/重复声明当场红）；
//      ② 钉住"来源 id → 给人看的名字"这一处映射（`local:v7` ⇒ 「默认值」）。
//
// ⚠️ 判据只看**可见文本**：`data-src="local:v7"` 那类属性必须保持原始 id（动作靠它识别来源），
//    所以断言前先把属性剥掉，再查"原始 id 有没有漏到用户眼前"。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

installDom();
globalThis.fetch = async () => ({ ok: true, json: async () => ({ plugins: [] }) });

// ① **真的加载一次**（这条就是"缺绑定 / 重复声明"的守卫）
const panel = await import(mod('ui/G_modal/sourcePanel.js'));
const { buildSourcePanelHtml } = panel;

group('来源标签：local:v7（旧数据回填）⇒ 「默认值」');
const TRUST = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { 'local:v7': { kind: 'derived', rank: 5 }, manual: { kind: 'manual', rank: 100 } },
    fieldPrefer: {}
};
const node = {
    id: 'p1', type: 'P', name: 'x',
    values: { cfDifficulty: [{ v: '2', src: 'local:v7', at: 'T1' }] }
};
const html = buildSourcePanelHtml(node, 'cfDifficulty', TRUST, {});
// 只留可见文本：剥掉所有 HTML 属性（`data-src="local:v7"` 必须保留原始 id）
const visible = html.replace(/[a-zA-Z-]+="[^"]*"/g, '');
ok(visible.includes('默认值'), '★ 可见文本里写的是「默认值」');
ok(!visible.includes('local:v7'), '★ 可见文本里不再出现原始 id（属性里保留是**对**的，动作靠它识别来源）');

// ⚠️ 单来源时面板**不画** per-来源按钮（唯一一条没得选）⇒ 要钉"属性仍保留原始 id"得给两条来源
const twoSrc = buildSourcePanelHtml({
    id: 'p3', type: 'P', name: 'z',
    values: { cfDifficulty: [{ v: '2', src: 'local:v7', at: 'T1' }, { v: '9', src: 'srk:x', at: 'T2' }] }
}, 'cfDifficulty', TRUST, {});
ok(twoSrc.includes('data-src="local:v7"'), '★ 两条来源时 data-src 仍是原始 id（改它会让"优先/不用/真删"认不出这条来源）');

group('其它来源 id 不被误改');
eq(buildSourcePanelHtml({ id: 'p2', type: 'P', name: 'y', values: { cfDifficulty: [{ v: '9', src: 'srk:x', at: 'T1' }] } },
    'cfDifficulty', TRUST, {}).includes('srk:x'), true, '别的来源 id 照原样显示');

// ⚠️ 第 4 处（用户 2026-10-13 实测抓到）：摘要那行 `ⓘ N 个来源（当前用 …：<理由>）` 里的理由
//    **不是 UI 拼的**，是 `core/trust.js:projectField` 生成的那句人话（`info.reason`）——
//    它在"有分歧"时会把别的说法摆出来（`；另有 X 说 Y（未采用）`），X 原来是**原始来源 id**。
//    所以这一条必须**端到端**钉住：造"两个来源、说法不同"，让 `local:v7` 落进「另有」那半段。
group('来源标签：人话理由（info.reason）里也不许露原始 id');
const TRUST2 = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: { 'srk:x': { kind: 'board', rank: 90 }, 'local:v7': { kind: 'derived', rank: 5 } },
    fieldPrefer: {}
};
const twoDiff = buildSourcePanelHtml({
    id: 'p4', type: 'P', name: 'w',
    values: { cfDifficulty: [{ v: '2', src: 'local:v7', at: 'T1' }, { v: '9', src: 'srk:x', at: 'T2' }] }
}, 'cfDifficulty', TRUST2, {});
const visibleDiff = twoDiff.replace(/[a-zA-Z-]+="[^"]*"/g, '');
ok(visibleDiff.includes('另有 默认值'), '★ 「另有 … 说 …（未采用）」那半段写的是「默认值」');
ok(!visibleDiff.includes('local:v7'), '★ 人话理由里不再露原始 id');

report();
