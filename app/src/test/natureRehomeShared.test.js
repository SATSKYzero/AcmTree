// ================================================================
// 「是不是 `(?/)xcpc` 那一支」只有一处判据（`core/synthPlan.bareClass`）+ 兜底层名的跨语言对拍
//
// 病根：
//   · "**什么算镜像前缀**"只该有一处实现（`core/synthPlan.js` 的 `bareClass`：
//     `qoj/xcpc/…` / `cf/gyms/xcpc/…` → `xcpc/…`）；`scripts/nature-rehome.mjs` 自己写一份
//     "分类里含 `xcpc` 段、且它不在最后"的判据 ⇒ 同一个问题两套定义，早晚分叉。
//     `classIsXcpc` = "`bareClass` 之后以 `xcpc/` 开头"，只剩一处定义。
//   · 兜底桶层名 `'（QOJ 上没挂分类）'` 是**跨语言**的一对：Python 侧
//     `qoj_adapter.QOJ_SERIES_NAME` 产出它、JS 侧 `nature-rehome.FALLBACK_NAMES` 认它。
//     光靠注释说"要一样"不够 —— 这里按本仓既有做法（见 `linkKinds` / `sourceReportRanks`）
//     **手抄 + 对拍**：哪边单独改了名字，这里就红。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bareClass } from '../core/synthPlan.js';
import { classIsXcpc, enoughClass, FALLBACK_NAMES } from '../../scripts/nature-rehome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

test('★ 「xcpc 支」的判据与 `bareClass` 同口径（镜像前缀只认那一份实现）', () => {
    // 该算的：镜像前缀去不去掉都算
    for (const cls of ['xcpc/icpc/ec/regional/official', 'qoj/xcpc/ccpc/final',
        'cf/gyms/xcpc/icpc/ap', 'aux/xcpc/省赛']) {
        assert.equal(classIsXcpc(cls), true, `${cls} 属于 xcpc 支`);
    }
    // 不该算的：别的支、只到 `xcpc` 一层、以及"看起来像但不是那一段"的写法
    for (const cls of ['cf/contest/div2', 'atcoder/abc', 'nk/多校', 'qoj/ucup', 'xcpc',
        'cf/xcpc-ish/foo', '', null, undefined]) {
        assert.equal(classIsXcpc(cls), false, `${JSON.stringify(cls)} 不属于 xcpc 支`);
    }
    // 与裸判据一致 —— ⚠️ **期望值写死**（写成
    // `classIsXcpc(cls) === bareClass(cls).startsWith('xcpc/')` 是"实现比自己"，
    // 把 classIsXcpc 换成手写"数段"实现它也恒真）。
    assert.equal(bareClass('qoj/xcpc/ccpc'), 'xcpc/ccpc', '`bareClass` 去掉镜像前缀');
    assert.equal(bareClass('cf/gyms/xcpc/icpc/ap'), 'xcpc/icpc/ap');
    assert.equal(bareClass('nk/多校'), 'nk/多校', '没有 xcpc 段就原样（不猜）');
    assert.equal(bareClass('aux/xcpc/省赛'), 'xcpc/省赛');
    // ★ **源码级**：`classIsXcpc` 必须**真的委托** `bareClass` —— 光把 `bareClass` 的期望值写死
    //   钉不住"它被换成手写实现"：两者在被测样例上等价 ⇒ 行为断言照样绿。
    //   所以这里读源码看函数体内有没有那次调用。
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'nature-rehome.mjs'), 'utf8');
    const body = /export function classIsXcpc\(cls\)\s*\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(body, '找不到 `export function classIsXcpc(cls) { … }`');
    assert.match(body[1], /bareClass\s*\(/,
        '`classIsXcpc` 必须调 `bareClass`（"什么算镜像前缀"只有那一份实现）—— 不许自己数段');
    // 「够不够」= 非空 + 不是"归不进去"的写法 + 属于这一支
    assert.equal(enoughClass('qoj/xcpc/ccpc/final'), true);
    assert.equal(enoughClass('qoj/xcpc/ccpc/无归类'), false, '「无归类」= 判过了、这一支里没有它可归的一项');
    assert.equal(enoughClass('qoj/xcpc/provincial&invitational/未归类'), true,
        '「未归类」= 脚本判不出、等人补 ⇒ 不是兜底桶（别把这两个字搞混）');
    assert.equal(enoughClass('nk/多校'), false, '别的支不算够（这个机制只对 xcpc 支生效）');
});

test('跨语言对拍：兜底桶层名 `（QOJ 上没挂分类）` 两边必须是同一个字面量', () => {
    const py = readSrc('acm-data/raw/Scaper/05 xcpc/qoj_adapter.py');
    const m = /QOJ_SERIES_NAME\s*=\s*(['"])(.*?)\1/.exec(py);
    assert.ok(m, 'qoj_adapter.py 里找不到 QOJ_SERIES_NAME —— 改法变了就得同步这份对拍');
    assert.ok(FALLBACK_NAMES.includes(m[2]),
        `qoj_adapter 产出兜底层名叫 ${JSON.stringify(m[2])}，而 nature-rehome 认的是 ${JSON.stringify(FALLBACK_NAMES)}`
        + ' —— 两边必须对上，否则那个兜底桶再也搬不动');
});
