// ================================================================
// 训练计划的纯逻辑（core/trainingPlan.js）
//
// 职责：**期与粒度**、**训练强度查表**、**题集**、**各期达成** —— 全是纯函数，零 DOM、零 `ui/`。
// 依赖：`core/query/stats.js:collectByType`（子树收集的**唯一一份**，真实/副页两种都认）、
//       `core/fieldRegistry.js:difficultyValueOf`（数值难度的**唯一一份**，0 = 未定）。
// 口径与设计依据：`docs/training-plan.md`（**改口径先改那份文档**，别只改这里）。
//
// ⚠️ **本文件不读缓存字段、不 import `view/`**（`core/` 不许反向依赖 `view/`）：
//    "显示口径 + 查看范围"的值一律由调用方经 `opts.shownValue(node, field)` 传进来
//    （界面侧就是 `viewDerivedDisplay(...) ?? viewValue(...)`，与统计页同一份）。
// ⚠️ **不自己扫全表**：题集 = **副页**里的题 ∩ `plan.rootIds` 那几棵子树（空 = 超级根 = 整个副页）
//    ∩ `plan.pick` 四维条件 —— 口径见 §13。
// ⚠️ **计划侧没有"实时范围"这一层**（用户 2026-10-14："怎么还有实时和快照两个版本…能不能稳定一点"）：
//    范围**只有存下来的快照**那一种（`plan.rootIds`）；那颗 ○ 是全局临时的，计划不跟着它变。
// ================================================================
import { collectByType } from './query/stats.js';
// ★ 「屏蔽的支不进题集」的**唯一判据**（用户 2026-10-15："屏蔽的部分不参与任何统计"）
import { childVNodesOf } from './model/page.js';
import { dedupRepresentatives } from './query/countMode.js';
import { difficultyValueOf } from './fieldRegistry.js';
// 挑题条件的**唯一一份**判据（§13：`range` 型的题集 = 子树 ∩ 这四个条件）
import { matchesProblemFilter, DEFAULT_PICK_FILTER } from './problemPick.js';
// "今天"只有一份口径（`utils/time.js` 的 `YYYY.MM.DD HH:MM:SS`）；这里只用日期那半
import { getNowStr } from '../utils/time.js';
// 档位表（控制点的横坐标就是它那 20 个通过率上限）—— 别在别处再抄一份
import { XCPC_THRESHOLDS } from '../A_constants.js';
// 通过率的显示规则（三位小数）—— 叶子模块，core 也能用；守卫在 `docAnchors.test.js` 的「唯一实现」名单里
import { fmtPercent } from '../utils/num.js';

// ----------------------------------------------------------------
// 常量（名单只有一处；界面/脚本都从这里取）
// ----------------------------------------------------------------

/** 粒度：日 / 周 / 月 / 整段一期（用户 ⑲⑳：粒度**随时可切**，执行与看图各一套） */
export const PLAN_GRAINS = ['day', 'week', 'month', 'all'];

/** 执行粒度的默认值（⑳：**执行默认日**） */
export const DEFAULT_PLAN_GRAIN = 'day';

/**
 * 两张图各自的**默认查看粒度**（⑳：折线默认日、柱状默认周）——
 * ⚠️ 这只是**默认值**：真正的当前粒度住视图态（按计划记住），不进 `state.plans`。
 */
export const DEFAULT_CHART_GRAINS = { line: 'day', bar: 'week' };

/** 算"做完"的 status2 默认集合（④：3 赛后补题 + 4 赛时通过） */
export const DEFAULT_PLAN_STATUSES = [3, 4];

/** 强度按哪个难度源算（⑯：**计划自己选**） */
export const INTENSITY_SOURCES = ['xcpc', 'cf'];

/**
 * 计划**题集来源**（§13）：
 *   · `page`（默认，= 今天的行为）＝ 计划绑的那个**副页**里的题；
 *   · `range` ＝ 树上若干**范围根**（如 `S=CCPC 2023`）子树里的题 ∩ `plan.pick` 那四个条件。
 * ⚠️ 计划侧**没有"实时筛选"那一层**（那颗 ○ 是全局临时的，计划不跟着它变）—— 见 `planProblemsOf` 的文件头。
 */
export const PLAN_SOURCES = ['page', 'range'];

// ================================================================
// 训练强度：**一条式子 + 控制点**（两条曲线共用同一份插值器）
//
// 简史（口径的来龙去脉，改之前先读这一段）：
//   · 第 5 轮（v9.1.38）：XCPC 侧从"按档位的台阶表"改成"按通过率的控制点"，横坐标 = 各档的
//     **通过率上限**（`XCPC_THRESHOLDS` 那 20 个，0.11% … 100%）；纵坐标当时是
//     `INTENSITY_MIN × INTENSITY_RATE^k`（每档 ×1.2）—— **已被第 9 轮取代，那个常数也删了**。
//   · 第 7 轮（v9.1.40）：数值侧改成**一条式子**（用户："以 2600 取 10 为基准，每差 400 分强度翻倍；
//     再对 1 取 max，大概在 1271 前生效"）⇒ `max(1, 10 × 2^((cf−2600)/400))`。
//   · 第 8 轮（v9.1.41）：两条曲线的点之间都用**指数段**相接（`mode: 'exp'`，默认）。
//   · ★ 第 9 轮（本版）：XCPC 侧**不再按档位等比递增** —— 改成"先把通过率折算成**等价的数值难度**，
//     再走数值那条式子"。用户原话："16% 以上：16% 对标 2200 的强度，8% 对标 2400，4%-2600……
//     也就是每折半多 200 分"、"16% 以下：16% 对标 2200，32% 对标 1900，64% 对标 1600"、
//     "上限对标 3500，下限我先看看你的计算结果"、"数值难度的强度计算上限也是 3500，
//     3500 以上与 3500 同强度"。
//     ⚠️ 用户明说这套对应关系"**不会明写，只是数值一致**" ⇒ 界面上仍然只显示
//     「通过率 ≤ X → 强度」，**别把"等价 CF 分"印到界面或用户文档上**；映射只住 `ratioEquivCfAt`。
//     于是两条曲线**共用同一条式子**（`cfIntensityAt`），XCPC 侧只是换一个横坐标进那条式子。
// ================================================================

/** 强度的**最低值**＝数值那条式子对 1 取 max 的那个 1 */
export const INTENSITY_MIN = 1;

// ---- 数值难度侧：**一条式子**（口径本体见 `cfIntensityAt`）----
export const CF_INTENSITY_BASE_AT = 2600;      // 基准点
export const CF_INTENSITY_BASE_VALUE = 10;     // 基准值
export const CF_INTENSITY_DOUBLE_PER = 400;    // 每差这么多分 ⇒ 强度翻倍
export const CF_INTENSITY_MIN = INTENSITY_MIN; // 下限（对 1 取 max）
/** 式子触底（= 1）的那一点：`2600 − 400·log2(10) ≈ 1271.2` ⇒ 取整 **1271**（用户说的"1271 前生效"） */
export const CF_INTENSITY_FLOOR_AT = Math.round(
    CF_INTENSITY_BASE_AT + CF_INTENSITY_DOUBLE_PER * Math.log2(CF_INTENSITY_MIN / CF_INTENSITY_BASE_VALUE)
);
/** **上限**：式子在这里封顶（用户第 9 轮："数值难度的强度计算上限也是 3500，3500 以上与 3500 同强度"；
 *  第 10 轮："其实上限改成 4000 也行" ⇒ 取 4000）。⚠️ 真数据里 cf 的最大值**正好是 3500**
 *  （326 道，没有一道更高）⇒ 这个数一动，**数值侧的实际结果不变**，变的只是通过率侧难端的天花板。 */
export const CF_INTENSITY_TOP = 4000;

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** 封顶值 = 式子算到 `CF_INTENSITY_TOP` 的那一个数（≈47.57）：比它高的一律取它 */
export const CF_INTENSITY_MAX = round2(
    CF_INTENSITY_BASE_VALUE * Math.pow(2, (CF_INTENSITY_TOP - CF_INTENSITY_BASE_AT) / CF_INTENSITY_DOUBLE_PER)
);

/**
 * **数值难度 → 强度**这条式子（口径本体；纯函数，`npm test` 里钉着用户举的那几个数）。
 *
 * ⚠️ 用户举的"1600 取 1.25"与这条式子对不上（严格算 **1600 → 1.77**、**1400 → 1.25**）——
 *    但他给的"1271 触底"正好是这条式子的解 ⇒ 以式子为准（已在报告里点明）。
 * ★ 第 9 轮起**两端都封口**：下限对 1 取 max、上限 `CF_INTENSITY_TOP`(3500) ⇒ `CF_INTENSITY_MAX`(47.57)。
 *
 * @returns {number|null} cf ≤ 0 / 不是数 ⇒ `null`（读不出难度的题强度记 0，见 `intensityOf`）
 */
export function cfIntensityAt(cf) {
    const n = Number(cf);
    if (!Number.isFinite(n) || n <= 0) return null;
    const v = CF_INTENSITY_BASE_VALUE * Math.pow(2, (n - CF_INTENSITY_BASE_AT) / CF_INTENSITY_DOUBLE_PER);
    return round2(Math.min(CF_INTENSITY_MAX, Math.max(CF_INTENSITY_MIN, v)));
}

// ---- XCPC 通过率侧：通过率 → **等价的数值难度** → 走上面那条式子（用户第 9 轮）----
/** 拐点：通过率 **16%** */
export const RATIO_INTENSITY_KNEE = 16;
/** 拐点对标的分值（"16% 对标 2200"） */
export const RATIO_INTENSITY_KNEE_CF = 2200;
/** 更难的一侧：通过率**每折半** ⇒ 加这么多分（"每折半多 200 分"） */
export const RATIO_INTENSITY_CF_PER_HALF = 200;
/** 更容易的一侧：通过率**每翻倍** ⇒ 减这么多分（"32% 对标 1900，64% 对标 1600"） */
export const RATIO_INTENSITY_CF_PER_DOUBLE = 300;

/**
 * **通过率 → 等价的数值难度**（横轴取 `log2` 的一条两段折线）：
 *   · `r ≤ 16%`：`2200 + 200 × log2(16/r)` —— 通过率每折半 +200 分；
 *   · `r ≥ 16%`：`2200 − 300 × log2(r/16)` —— 通过率每翻倍 −300 分。
 * 上限与数值侧同一条：**对 3500 封顶**（"上限对标 3500"）。
 * ⚠️ 用户明说这套对应"**不会明写**" ⇒ 只住在这里，**别印到界面/用户文档上**。
 *
 * @returns {number|null} 通过率（百分数）读不出 / ≤ 0 ⇒ `null`
 */
export function ratioEquivCfAt(ratioPct) {
    const n = Number(ratioPct);
    if (!Number.isFinite(n) || n <= 0) return null;
    const cf = (n <= RATIO_INTENSITY_KNEE)
        ? RATIO_INTENSITY_KNEE_CF + RATIO_INTENSITY_CF_PER_HALF * Math.log2(RATIO_INTENSITY_KNEE / n)
        : RATIO_INTENSITY_KNEE_CF - RATIO_INTENSITY_CF_PER_DOUBLE * Math.log2(n / RATIO_INTENSITY_KNEE);
    return Math.min(cf, CF_INTENSITY_TOP);
}

/** **通过率 → 强度**（先折算成等价数值难度，再走那条式子） */
export function xcpcIntensityAt(ratioPct) {
    const cf = ratioEquivCfAt(ratioPct);
    return cf === null ? null : cfIntensityAt(cf);
}

/**
 * 式子（等价难度）**撞上限的那一点通过率**：`16 / 2^((4000−2200)/200) = 16/2^9 = 0.03125%`。
 * ⚠️ 它不在任何档位边界上，但要**单独当控制点**：否则 `[0.11, 0.22]` 那一段会把"封顶的平段"
 *    插成斜坡（上限取 3500 时实测 0.175% 处偏 **6.3%**）。加上它以后全区间最大偏差 ~3%（`npm test` 钉着）。
 */
export const RATIO_INTENSITY_TOP_AT = Math.round(
    RATIO_INTENSITY_KNEE / Math.pow(2, (CF_INTENSITY_TOP - RATIO_INTENSITY_KNEE_CF) / RATIO_INTENSITY_CF_PER_HALF) * 1e5
) / 1e5;

/**
 * XCPC 侧的控制点 = **各档的通过率上限** + **式子自己的两个折点**（共 22 个）—— 由档位表派生，别手抄一份：
 *   · `RATIO_INTENSITY_KNEE`（16%）：式子在这里换斜率（每折半 +200 ↔ 每翻倍 −300）；
 *   · `RATIO_INTENSITY_TOP_AT`（0.03125%）：式子在这里撞上限 4000（再难也一样重）。
 * ⚠️ 这两个折点**必须**在表里：横轴取对数后，段内是"过两端点的幂律"，跨折点的段会对不上原式子
 *    （不加拐点：`[15,20]` 那段最多偏 **1.41%**；不加封顶点：`[0.11,0.22]` 那段会把封顶平段插成斜坡）。
 * ⚠️ 每个点的值都取自 `xcpcIntensityAt`（同一条式子）⇒ 加上对数横轴，**查表处处等于式子**（零误差）。
 */
export function xcpcIntensityPoints() {
    const xs = XCPC_THRESHOLDS.map((t) => Number(t.upper));
    xs.push(RATIO_INTENSITY_KNEE, RATIO_INTENSITY_TOP_AT);
    return [...new Set(xs)]
        .sort((a, b) => a - b)
        .map((x) => ({ max: x, value: xcpcIntensityAt(x) }));
}

/**
 * 通过率控制点旁边的**旁注**：正好落在某档上限上 ⇒ 那一档的名字；式子自己的折点 ⇒ 「拐点」/「到顶」。
 *
 * ⚠️ **设置页与计划页共用这一份**（别各写一遍 `XCPC_THRESHOLDS.find(...)`——那样改一处就会分叉）。
 * @returns {string} 认不出（比如用户手加的点）⇒ `''`
 */
export function xcpcPointLabelOf(max) {
    const x = Number(max);
    if (!Number.isFinite(x)) return '';
    const hit = XCPC_THRESHOLDS.find((t) => Number(t.upper) === x);
    if (hit) return hit.level;
    if (x === RATIO_INTENSITY_TOP_AT) return '到顶';
    if (x === RATIO_INTENSITY_KNEE) return '拐点';
    return '';
}

/**
 * 通过率控制点在**计划页那一栏**里怎么写（左边那半句；右边那半句是强度值）。
 *
 * 用户第 11 轮点名的两处写法：`0.031%及更小`（"到顶"那一点 —— 它管的是"**这个值以及更难的**"）、
 * 其余仍是「档名 + 通过率」（`银牌 11%` / `拐点 16%`）。
 * ⚠️ 通过率一律走 `utils/num.js:fmtPercent`（三位小数）——`fmtAmount` 会把 `0.11` 与 `0.031` 印成同一个数。
 * ⚠️ 设置页那一栏**不用这个**（它那一格是**可编辑的输入框**，数字得留在输入框里）⇒ 那边用 `xcpcPointLabelOf`。
 */
export function xcpcPointTextOf(max) {
    if (max === null || max === undefined || max === '') return '（兜底）';
    const x = Number(max);
    if (!Number.isFinite(x)) return String(max);
    if (x === RATIO_INTENSITY_TOP_AT) return `${fmtPercent(x)}%及更小`;
    const name = xcpcPointLabelOf(x);
    return `${name ? name + ' ' : ''}${fmtPercent(x)}%`;
}

/** 数值难度控制点在计划页那一栏里怎么写（上限那一点写「4000及以上」——同样是"这个值以及更高的"） */
export function cfPointTextOf(max) {
    if (max === null || max === undefined || max === '') return '（兜底）';
    const x = Number(max);
    if (!Number.isFinite(x)) return String(max);
    return (x === CF_INTENSITY_TOP) ? `${x}及以上` : String(x);
}

/**
 * 点之间怎么相接的**人话**（设置页的说明与计划页的提示共用这一份）。
 * ⚠️ 别在各处写 `mode === 'smooth' ? … : '线段'` 那种两分支 —— `'exp'` 是默认档，
 *    漏了它就会把"指数曲线"说成"线段"（`v9.1.42` 之前计划页那句就是这么错的）。
 */
export function intensityJoinLabelOf(mode) {
    if (mode === 'line') return '线段相接';
    if (mode === 'smooth') return '平滑曲线相接';
    return '指数曲线相接';
}

/**
 * CF 侧的控制点 = 把 `cfIntensityAt` **采样**成点（触底点 1271 + 每 400 一个，一直到上限 4000）。
 *
 * ★ 用户第 8 轮："尽量用指数函数连接/描述整个公式" ⇒ 出厂表的 `mode` 是 **`'exp'`**：
 *   控制点之间用**指数段**相接 ⇒ 这些采样点之间**处处等于 `cfIntensityAt`**（不是近似，是恒等）。
 *   于是采样放粗到"每 400 一点"也不丢精度（末点正好对应用户点名的那几个数）。
 *   ⚠️ 前提是"点的值取自同一个指数式子"——手改某一点之后，段与段之间改走"过两点的指数"（仍是指数，只是另一条）。
 *   ★ 第 9 轮起 `cfIntensityAt` 自己有上限 ⇒ 末点（`CF_INTENSITY_TOP`）就是全表的上限，比它高的题取它。
 */
export function cfIntensityPoints() {
    const xs = [CF_INTENSITY_FLOOR_AT];
    for (let x = CF_INTENSITY_BASE_AT - CF_INTENSITY_DOUBLE_PER * 3; x <= CF_INTENSITY_TOP;
        x += CF_INTENSITY_DOUBLE_PER) {
        if (x > CF_INTENSITY_FLOOR_AT) xs.push(x);
    }
    if (xs[xs.length - 1] !== CF_INTENSITY_TOP) xs.push(CF_INTENSITY_TOP);
    return xs.map((x) => ({ max: x, value: cfIntensityAt(x) }));
}

/** 默认的强度映射表（⑤：全局若干张有名字的表，计划引用一张） */export const DEFAULT_INTENSITY_TABLE = {
    id: 'ti_default',
    name: '默认',
    // 通过率 → 强度（**控制点，升序；点之间按 `mode` 相接**）—— 值来自 `xcpcIntensityAt`，见上面那一段
    byRatio: xcpcIntensityPoints(),
    // 数值难度 → 强度（同上：控制点，升序）
    byCf: cfIntensityPoints(),
    // 点之间怎么相接：`'exp'`（**指数段**，默认 —— 用户第 8 轮）| `'line'`（线段）| `'smooth'`（单调三次）
    mode: 'exp'
};

/**
 * **控制点插值**（两条曲线共用的唯一一份）。
 *
 * 用户 2026-10-13 第 5 轮："如果插值麻烦可以直接用线段拼（自定义可选插值 / 线段）"；
 * 第 8 轮："我希望两个难度对应的强度都以**指数函数**为主，尽量用指数函数连接/描述整个公式"
 * ⇒ 三种模式并存，**默认 `exp`（指数段）**：
 *   · `'exp'`    —— 点之间用**指数段**相接 `v₁·(v₂/v₁)^t`（见 `expAt`；两端值 ≤ 0 时那一段退回直线）；
 *   · `'line'`   —— 点之间**直线相接**（最好核对、不会出现意外起伏）；
 *   · `'smooth'` —— **单调三次（PCHIP）**：仍**穿过每个控制点**、且**不会过冲**（比样条安分）。
 *
 * @param {Array<{max:number|null, value:number}>} points 升序控制点；`max: null` = 「+∞」那一点
 * @param {number} x
 * @param {'exp'|'line'|'smooth'} [mode]
 * @param {boolean} [logX] 横轴先取**对数**再插值（见下面「横轴的取法」那一段）
 * @returns {number|null} 取不到（没有控制点 / x 不是数）⇒ `null`（调用方当"读不出难度"处理 ⇒ 强度 0）
 */
export function intensityAtPoints(points, x, mode = 'exp', logX = false) {
    const pts = (Array.isArray(points) ? points : [])
        .filter((p) => p && Number.isFinite(Number(p.value)))
        .map((p) => ({
            at: (p.max === null || p.max === undefined || p.max === '') ? Infinity : Number(p.max),
            value: Number(p.value)
        }))
        .filter((p) => Number.isFinite(p.at) || p.at === Infinity)
        .sort((a, b) => a.at - b.at);
    if (!pts.length) return null;
    // ⚠️ `null` / `''` / `undefined` **都要当"读不出来"**，别落到 `Number(null) === 0` 那一支上
    //    （那会静默取到第一个控制点的值 —— 实测踩过：整条曲线恒定成最大值）
    if (x === null || x === undefined || x === '') return null;
    if (!Number.isFinite(Number(x))) return null;
    const v = Number(x);
    // 「+∞」那一点不参与曲线：它只是"再高也取这个值"的上界
    const inf = pts.find((p) => !Number.isFinite(p.at)) || null;
    const fin = pts.filter((p) => Number.isFinite(p.at));
    if (!fin.length) return inf ? inf.value : null;
    // ★ **横轴取对数**（通过率侧用；见下面「横轴的取法」那一段）：
    //   ⚠️ 只在**所有有限控制点都 > 0** 时才用 —— 有 ≤ 0 的点（手改出来的 0）就没有对数，
    //      这时**整条曲线退回原值横轴**（如实降级，别一半对数一半原值）。
    const useLog = !!logX && fin.every((p) => p.at > 0);
    const tx = (n) => (useLog ? Math.log(n) : n);
    const pts2 = useLog ? fin.map((p) => ({ at: Math.log(p.at), value: p.value })) : fin;
    // ⚠️ 夹取一律按**原值**判（`v` 可能是 0 / 负数），别拿取过对数的去比
    if (v <= fin[0].at) return fin[0].value;
    if (v >= fin[fin.length - 1].at) return inf ? inf.value : fin[fin.length - 1].value;
    if (mode === 'smooth' && pts2.length >= 3) return round2(smoothAt(pts2, tx(v)));
    if (mode === 'exp') return round2(expAt(pts2, tx(v)));
    return round2(lineAt(pts2, tx(v)));
}

/**
 * **指数连接**：每一段都是一条指数曲线 `v(x) = v₁ · (v₂/v₁)^t`（`t = (x−x₁)/(x₂−x₁)`）。
 *
 * 用户 2026-10-13 第 8 轮："我希望两个难度对应的强度都以**指数函数**为主，尽量用指数函数连接/描述整个公式"。
 * 为什么它比"直线拼接"更贴本意：
 *   · 数值侧那条式子 `10 × 2^((cf−2600)/400)` 本身就是指数 ⇒ **只要控制点取自这条式子，
 *     "指数连接"处处等于式子**（采样点之间不再是近似，是恒等）；
 *   · 通过率侧那条规则是"**每折半 +200 分**"（对数刻度上的直线）⇒ 横轴取对数后同样恒等（见下）。
 *
 * ★ **横轴的取法**（第 10 轮加的 `logX`，只有通过率侧用）：横轴先取 `log(x)` 再插值。
 *   为什么：通过率侧的口径本来就定义在**对数刻度**上（"每折半 +200 分 / 每翻倍 −300 分"），
 *   强度于是是 `C·r^(−p)` 这种**幂律** —— 它在 `log r` 上正好是直线 ⇒ 取对数后
 *   **整条曲线处处等于式子**（不取对数只能逼近：顶段跨 3.5 倍时实测差 **10%**）。
 *   ⚠️ 数值侧**不取**对数（那条式子的自变量是分值本身，指数连接已经恒等）。
 * ⚠️ 两端值必须都 > 0（指数要求）：**任何一端 ≤ 0 ⇒ 那一段退回直线**（如实降级，别抛错也别静默取 0）。
 */
function expAt(pts, x) {
    for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i].at) {
            const a = pts[i - 1];
            const b = pts[i];
            const span = b.at - a.at;
            if (!(span > 0)) return b.value;
            const t = (x - a.at) / span;
            if (a.value > 0 && b.value > 0) return a.value * Math.pow(b.value / a.value, t);
            return a.value + (b.value - a.value) * t;
        }
    }
    return pts[pts.length - 1].value;
}

/** 线段：找 `x` 落在哪一段，按比例取 */
function lineAt(pts, x) {
    for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i].at) {
            const a = pts[i - 1];
            const b = pts[i];
            const t = (b.at === a.at) ? 1 : (x - a.at) / (b.at - a.at);
            return a.value + (b.value - a.value) * t;
        }
    }
    return pts[pts.length - 1].value;
}

/**
 * 单调三次插值（Fritsch–Carlson 的 PCHIP）——**穿过每个控制点、且不过冲**。
 * 为什么不用普通样条：普通样条会在"平台段"两头鼓出去（强度出现假的峰），PCHIP 不会。
 * 参考：`m_i` 是各点切线；`d_i` 是相邻两点的差商；同号才用加权平均，异号一律取 0。
 */
function smoothAt(pts, x) {
    const n = pts.length;
    const h = [];
    const d = [];
    for (let i = 0; i < n - 1; i++) {
        h[i] = pts[i + 1].at - pts[i].at;
        d[i] = (pts[i + 1].value - pts[i].value) / h[i];
    }
    const m = new Array(n);
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
        if (d[i - 1] * d[i] <= 0) { m[i] = 0; continue; }
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
    let i = 0;
    while (i < n - 2 && x > pts[i + 1].at) i++;
    const t = (x - pts[i].at) / h[i];
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * pts[i].value + h10 * h[i] * m[i] + h01 * pts[i + 1].value + h11 * h[i] * m[i + 1];
}

/** 从节点读**通过率**（百分数，如 `'9'` / `'10.85%'`）；读不出 ⇒ `null` */
function ratioOf(node, shownValue) {
    const raw = shownValue ? shownValue(node, 'ratio') : (node && node.ratio);
    const s = String(raw === undefined || raw === null ? '' : raw).trim().replace('%', '');
    if (!s) return null;
    const n = Number(s);
    return (Number.isFinite(n) && n >= 0 && n <= 100) ? n : null;
}

/** 档位 → 那一档通过率区间的**中点**（没有 ratio 但有档位时的近似；档位不在表里 ⇒ `null`） */
function bandCenterOf(level) {
    const s = String(level === undefined || level === null ? '' : level);
    const hit = XCPC_THRESHOLDS.find((t) => t.level === s);
    return hit ? (Number(hit.lower) + Number(hit.upper)) / 2 : null;
}


// ----------------------------------------------------------------
// 期与粒度（⑲⑳㉑）
//
// 时间串一律是仓里那一种：`YYYY.MM.DD HH:MM[:SS]`（`utils/time.js`）。
// 期的键**可排序**（`YYYY.MM.DD` / `YYYY.MM`），周用**周一那天**当键。
// ⚠️ 日期运算一律走 UTC（`Date.UTC`）：本地时区的夏令时会让"加一天"变成 23/25 小时。
// ----------------------------------------------------------------

const DAY_RE = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})/;

/** 时间串 → `YYYY.MM.DD`（取不出来就返回空串：调用方据此算"没定期"） */
export function dayKeyOf(timeStr) {
    const m = DAY_RE.exec(String(timeStr === undefined || timeStr === null ? '' : timeStr).trim());
    return m ? `${m[1]}.${m[2]}.${m[3]}` : '';
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `YYYY.MM.DD` → {y,m,d}（不合法返回 null） */
function parseDayKey(key) {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(String(key || ''));
    if (!m) return null;
    const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { y, mo, d };
}

/** 天数（UTC 毫秒）——只用于内部加减 */
function utcOf(key) {
    const p = parseDayKey(key);
    return p ? Date.UTC(p.y, p.mo - 1, p.d) : NaN;
}

/** 加 n 天 → `YYYY.MM.DD` */
export function addDays(key, n) {
    const t = utcOf(key);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t + n * 86400000);
    return `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`;
}

/** 两个"天键"相差几天（`a - b`）；任一个不合法返回 NaN */
export function daysBetween(a, b) {
    const ta = utcOf(a); const tb = utcOf(b);
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) return NaN;
    return Math.round((ta - tb) / 86400000);
}

/** 这一天的**周一**（周一~周日为一周；`getUTCDay()` 0 = 周日） */
export function mondayOf(key) {
    const t = utcOf(key);
    if (!Number.isFinite(t)) return '';
    const dow = new Date(t).getUTCDay();          // 0..6，0 = 周日
    const back = (dow + 6) % 7;                   // 周一 = 0、周日 = 6
    return addDays(key, -back);
}

/**
 * 时间串 → **期键**（按粒度）。
 * @param {string} timeStr `YYYY.MM.DD HH:MM[:SS]`
 * @param {string} grain `PLAN_GRAINS` 之一
 * @returns {string} 期键；**取不出日期时返回空串**（= 这题没定期，调用方要单独报出来）
 */
export function periodKeyOf(timeStr, grain) {
    const g = PLAN_GRAINS.includes(grain) ? grain : DEFAULT_PLAN_GRAIN;
    const day = dayKeyOf(timeStr);
    if (!day) return '';
    if (g === 'all') return 'all';
    if (g === 'day') return day;
    if (g === 'week') return mondayOf(day);
    return day.slice(0, 7);                        // month
}

/**
 * 期键 → 给人看的标签。
 * ⚠️ **都带年份**（用户 2026-10-13："日期要加年份"）：
 *   日 `2026.10.13` / 周 `2026.10.12~10.18`（跨年时写成 `2026.12.28~2027.01.03`）/ 月 `2026.10`。
 *   为什么统一带年：计划的期常常跨年（一个训练计划跨 12 月），只写 `10.13` 分不清是哪一年。
 */
export function periodLabelOf(key, grain) {
    const g = PLAN_GRAINS.includes(grain) ? grain : DEFAULT_PLAN_GRAIN;
    if (g === 'all') return '整段';
    if (!key) return '';
    if (g === 'month') return key;
    if (g === 'week') {
        const end = addDays(key, 6);
        const sameYear = String(end).slice(0, 4) === String(key).slice(0, 4);
        return sameYear ? `${key}~${String(end).slice(5)}` : `${key}~${end}`;
    }
    return key;                                    // day
}

/** 这一期有几天（㉑ 折算目标用；`all` 要给定整段范围 ⇒ 用 `spanDays`） */
export function daysInPeriod(key, grain) {
    const g = PLAN_GRAINS.includes(grain) ? grain : DEFAULT_PLAN_GRAIN;
    if (g === 'all') return 0;                     // 调用方改用 `spanDays`
    if (g === 'day') return 1;
    if (g === 'week') return 7;
    // ⚠️ 月粒度的键是 `YYYY.MM`（**不是** `YYYY.MM.DD`）—— 用 `parseDayKey` 会解不出来、
    //    于是"每月目标"折算成 0（2026-10-13 实测踩到，判据就是那条月折算的测试）
    const m = /^(\d{4})\.(\d{2})$/.exec(String(key || ''));
    if (!m) return 0;
    const y = Number(m[1]); const mo = Number(m[2]);
    if (!y || mo < 1 || mo > 12) return 0;
    return new Date(Date.UTC(y, mo, 0)).getUTCDate();       // 下月 0 号 = 本月最后一天
}

/** 整段跨几天（含首尾） */
export function spanDays(startKey, endKey) {
    const n = daysBetween(endKey, startKey);
    return Number.isFinite(n) ? n + 1 : 0;
}

/**
 * 从 `startKey` 到 `endKey` 的**连续**期键列表（含首尾；图表的 x 轴用它，空期也要占位）。
 * `all` ⇒ 只有 `['all']`。任一键不合法 ⇒ `[]`。
 */
export function periodsBetween(startKey, endKey, grain) {
    const g = PLAN_GRAINS.includes(grain) ? grain : DEFAULT_PLAN_GRAIN;
    if (g === 'all') return (startKey && endKey) ? ['all'] : [];
    const first = (g === 'week') ? mondayOf(startKey) : (g === 'month' ? String(startKey).slice(0, 7) : startKey);
    const lastRaw = (g === 'week') ? mondayOf(endKey) : (g === 'month' ? String(endKey).slice(0, 7) : endKey);
    if (!first || !lastRaw) return [];
    const out = [];
    if (g === 'month') {
        let [y, mo] = first.split('.').map(Number);
        const [ly, lmo] = lastRaw.split('.').map(Number);
        if (!y || !mo || !ly || !lmo) return [];
        // 上界兜底：防呆（最多 100 年）
        for (let i = 0; i < 1200; i++) {
            const key = `${y}.${pad2(mo)}`;
            out.push(key);
            if (y === ly && mo === lmo) break;
            mo++; if (mo > 12) { mo = 1; y++; }
        }
        return out;
    }
    const step = (g === 'week') ? 7 : 1;
    let cur = first;
    for (let i = 0; i < 40000; i++) {
        out.push(cur);
        if (cur === lastRaw) break;
        cur = addDays(cur, step);
        if (!cur) break;
    }
    return out;
}

/**
 * **表格里的期序 = 越新的越靠前**（用户 2026-10-13 第 2 轮："每期完成情况越新的越靠前"，
 * 第 4 轮："外侧时间也要倒序" ⇒ 内层表格与外层栏**同一份规则**）。
 *
 * ⚠️ **只给"列表/表格"用**：**画图仍按时间正序**（x 轴从左到右 = 时间往前）——
 *    两张图吃的是 `planChartSeriesOf(progress)` 那一份 `points`，别把它也翻了。
 * ⚠️ **返回新数组、不改入参**（`progress.periods` 是 `planProgressOf` 现算出来的，
 *    就地 `reverse()` 会把同一个对象交给下一个消费者时已经倒过序）。
 */
export function periodsNewestFirst(periods) {
    return [...(Array.isArray(periods) ? periods : [])].reverse();
}

// ----------------------------------------------------------------
// 训练强度（⑪⑮⑯⑰）
// ----------------------------------------------------------------


/**
 * 按 id 取强度表（口径只一处，别在各调用点各写一份兜底）。
 *
 * 三条判据（`v9.1.29` 起，别改回去）：
 *   · **空 id**（`''`/`null`/`undefined`）= **内置默认那张** —— 计划没引用任何自定义表就是这种；
 *   · id 非空但**表库里没有**（被删了 / 包里带来的 id 不认识）⇒ 退回**第一张自定义表**；
 *   · 表库空（老存档没有这一节）⇒ 内置默认那张。
 * ⚠️ 曾经把"空 id"也当"取不到"处理 ⇒ 选了「内置」也会显示第一张自定义表（`settings-page` ⑭ 抓到）。
 */
export function intensityTableById(tables, id) {
    if (!id) return DEFAULT_INTENSITY_TABLE;
    if (Array.isArray(tables)) {
        const hit = tables.find((t) => t && t.id === id);
        if (hit) return hit;
        if (tables.length > 0 && tables[0]) return tables[0];
    }
    return DEFAULT_INTENSITY_TABLE;
}

/** 数值难度的兜底读取器（调用方给 `shownValue` 时也用它读**数值难度字段**） */
function numOf(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 一道题的**训练强度**（⑯ 源由计划选）。
 *
 * ★ 第 12 轮（用户："未填写的不计入 因为有热身赛等" ⇒ "**强度为 0 就行了**"）：
 *   **没填难度 ⇒ 强度 0**（`usedDefault: true`）。于是它天然不参与任何强度合计 ——
 *   分子分母一起是 0，不用在聚合那侧再判一次。
 *   ⚠️ 为什么不做成"跳过不计"：那需要在每个消费点（每期 / 总计 / 预测 / 图表）都判一遍
 *      `usedDefault`，五处必然分叉；**0 是干净的**（加 0 不影响和）。
 *   ⚠️ 题数**照旧算**（题数目标不看难度；"这道题做过"也是事实）—— 那一侧不看 `value`。
 *
 * @param {Object} node
 * @param {{table?:Object, source?:string, shownValue?:(node:Object, field:string)=>*, numericValue?:number}} opts
 *        `numericValue` 可直接给（界面侧来自 `difficultyValueOf(...).value`）；
 *        不给则本函数自己调 `core/fieldRegistry.js:difficultyValueOf`（仍是那一份口径）。
 * @returns {{value:number, usedDefault:boolean, source:string}}
 */
export function intensityOf(node, opts = {}) {
    const table = opts.table || DEFAULT_INTENSITY_TABLE;
    const source = INTENSITY_SOURCES.includes(opts.source) ? opts.source : 'xcpc';
    const shownValue = opts.shownValue;
    // ⚠️ 控制点缺了就退回**内置曲线**（老表没迁移过的那种）—— 不是"退回台阶表"（那条路 v9.1.38 起没有了）
    const byRatio = Array.isArray(table.byRatio) && table.byRatio.length ? table.byRatio : DEFAULT_INTENSITY_TABLE.byRatio;
    const byCf = Array.isArray(table.byCf) && table.byCf.length ? table.byCf : DEFAULT_INTENSITY_TABLE.byCf;
    // ★ 读不出难度 ⇒ **0**（第 12 轮；以前是表里的 `defaultValue`）
    const unknown = { value: 0, usedDefault: true, source };
    // 缺省/乱填 ⇒ **指数段**（用户第 8 轮定的默认）
    const mode = (table.mode === 'smooth') ? 'smooth' : ((table.mode === 'line') ? 'line' : 'exp');

    if (source === 'xcpc') {
        // ★ 横坐标优先用**真实通过率**（用户第 5 轮："权重随 ratio 平滑改变"）；
        //   没有 ratio 但有档位 ⇒ 用那一档区间的**中点**近似；两者都没有 ⇒ 0
        const level = shownValue ? shownValue(node, 'xcpcDifficulty') : (node && node.xcpcDifficulty);
        const x = ratioOf(node, shownValue);
        const at = (x === null) ? bandCenterOf(level) : x;
        // ★ 通过率侧横轴**取对数**（口径见 `intensityAtPoints` 的「横轴的取法」）
        const v = intensityAtPoints(byRatio, at, mode, true);
        return (v === null) ? unknown : { value: v, usedDefault: false, source };
    }

    // source === 'cf'：数值难度（0 = 未定 ⇒ 0）
    let numeric = opts.numericValue;
    if (numeric === undefined || numeric === null) {
        const got = difficultyValueOf({ nodes: {} }, node, { shownValue });   // 只借它的"取哪个字段 + 取值"
        numeric = got.value;
    }
    const diff = numOf(numeric);
    if (diff <= 0) return unknown;
    const v = intensityAtPoints(byCf, diff, mode);
    return (v === null) ? unknown : { value: v, usedDefault: false, source };
}

// ----------------------------------------------------------------
// 题集（①③㉒）
// ----------------------------------------------------------------

/**
 * 题集来源（**兼容字段**，别再拿它分流）。
 *
 * ⚠️ 用户 2026-10-14："「就用这个副页里的题」就是**无选中时自动选超级根节点**的逻辑"
 *    ⇒ 两条来源其实是**同一个旋钮**：范围根空 = 超级根（`state.rootId`）；有根 = 那几棵子树。
 *    这个字段现在只用来**如实描述**当前是哪一种（`rootIds` 空 ⇒ `page`，否则 `range`），
 *    语义由 `ops/plan.js:normalizePlanShape` 从 `rootIds` 推出，**读的地方一律不看它**。
 */
export function planSourceOf(plan) {
    const roots = Array.isArray(plan && plan.rootIds) ? plan.rootIds.filter((x) => x) : [];
    return roots.length ? PLAN_SOURCES[1] : PLAN_SOURCES[0];
}

/** `plan.pick` 补上默认值（四维空 = 不限；`statuses` 不在这里 —— 见 `ops/plan.js:normPick`） */
function pickOf(plan) {
    const p = (plan && plan.pick && typeof plan.pick === 'object') ? plan.pick : {};
    return { ...DEFAULT_PICK_FILTER, ...p };
}

/**
 * 计划的**题集**（§13）。
 *
 * ★ **一条主线，两个旋钮**（用户 2026-10-14 两次定稿）：
 *   ① "**副页范围应该是默认的**"（"是不是有可能选中副页外的题"）⇒ **副页 = 题集的边界**：
 *      步骤 ① 先把"计划绑的那个副页"里的题收成池子，后面全在池子里筛（题集**永远**是它的子集）。
 *      ⚠️ 副页没了 ⇒ 算不出题集（报 `missingPage`），别当成"空题集"。
 *   ② "**「就用这个副页里的题」就是无选中时自动选超级根节点的逻辑**" ⇒ **范围根留空 = 超级根**
 *      （`state.rootId`，子树 = 全部题）⇒ ∩ 池子 = 池子本身。于是**没有"两条来源"**，
 *      条件（`plan.pick`）**永远**生效。
 *
 * 三段都是**现成的**：
 *   · 副页那一层 = `virtualIndex`（页内 id 在 `state.nodes` 里查不到）；`refId` 回真实节点；
 *   · 真实节点那一层 = `collectByType(state, real, 'P')`（**子树收集的唯一一份**）；
 *   · 条件四维 = `matchesProblemFilter`（**唯一一份**）。
 *
 * @param {Object} state
 * @param {Object} plan
 * @param {{shownValue?:(n:Object,f:string)=>*}} [opts]
 *        `shownValue` = 显示口径的取值器（判重模式下 = 组那份）；省略时退化成直读节点字段（只给测试/脚本用）。
 * @returns {{ids:string[], nodes:Object[], missingPage:boolean, linkCount:number,
 *            source:'page'|'range', missingRoots:string[], rootCount:number,
 *            rootsInPage:number, usingSuperRoot:boolean}}
 *          `linkCount` = 页里**引用到的真实节点**个数（去重后）——"同一题被引用两次只算一次"的说明；
 *          `missingRoots` = 没解析到的范围根 id；`rootCount` = 解析到的范围根个数；
 *          `rootsInPage` = 其中**在池子里真挑到过题**的根个数（一个都没有 ⇒ 界面要提示"根不在这个副页里"）；
 *          `usingSuperRoot` = 范围根是空的（= 自动用超级根 ⇒ "就用这个副页里的题"）。
 */
export function planProblemsOf(state, plan, opts = {}) {
    const empty = {
        ids: [], nodes: [], missingPage: false, linkCount: 0,
        source: PLAN_SOURCES[0], missingRoots: [], rootCount: 0, rootsInPage: 0, usingSuperRoot: true
    };
    if (!state || !plan || !plan.pageId) return empty;
    const page = state.pages && state.pages[plan.pageId];
    if (!page) return { ...empty, missingPage: true };      // ★ 边界没了 ⇒ 算不出题集

    // ---- ① 池子：副页里引用到的全部真实 P（C/W/S 展子树；同一题只算一次）----
    const pool = [];
    const seenP = new Set();
    const seenReal = new Set();
    const pushP = (p) => {
        if (!p || p.type !== 'P' || seenP.has(p.id)) return;
        seenP.add(p.id);
        pool.push(p);
    };
    const index = page.virtualIndex || {};
    const walkVirtual = (vId) => {
        const v = index[vId];
        if (!v) return;
        if (v.refId) {
            const real = state.nodes && state.nodes[v.refId];
            if (real) {
                seenReal.add(real.id);
                if (real.type === 'P') pushP(real);
                else for (const p of collectByType(state, real, 'P')) pushP(p);   // C/W/S ⇒ 展它子树里的题
            }
        }
        // ⚠️ **屏蔽的支不进题集**（用户 2026-10-15："屏蔽的部分不参与任何统计"）——
        //    判据是 `childVNodesOf`（唯一一份），别在这儿自己比 `syncBlocked`。
        for (const child of childVNodesOf(page, v, 'stats')) walkVirtual(child.id);
    };
    walkVirtual(page.rootId);

    // ---- ② 范围根（**留空 = 超级根**，即"就用这个副页里的题"）+ ③ 条件 ----
    // ★ 用户 2026-10-14："「就用这个副页里的题」就是**无选中时自动选超级根节点**的逻辑"
    //   ⇒ 不是两条来源，是**同一个旋钮**：范围根空 ⇒ 取 `state.rootId`（`O` 超级根，子树 = 全部题）
    //      ∩ 池子 = 池子本身（等价于"不再缩"）。条件**永远**生效。
    //   ⚠️ 空的时候**不真去走一遍超级根的子树**（那就是整棵树，白走一趟）—— 不过滤即等价。
    // ★ **范围只有"存下来的快照"这一种**（用户 2026-10-14："怎么还有实时和快照两个版本…能不能稳定一点"）：
    //   那颗 ○ 是**全局、临时**的（主树/副页共用，统计页那几个筛选模式也读它）⇒ 计划**不跟着它实时变**，
    //   只认 `plan.rootIds`（你在副页里标记好、按「取当前选中」那一刻写下来的那份）。
    const rootIds = (Array.isArray(plan.rootIds) ? plan.rootIds : []).filter((x) => x);
    const missingRoots = [];
    const rootSet = new Set();
    for (const rid of rootIds) {
        const real = state.nodes && state.nodes[rid];
        if (!real) { missingRoots.push(rid); continue; }
        rootSet.add(rid);
    }
    const usingSuperRoot = rootSet.size === 0;
    let rootsInPage = 0;
    let out = pool;
    if (!usingSuperRoot) {
        // "这一道题在某棵范围根子树里吗" —— 沿 `parentOf` 往上找（池子里都是真实节点，`parentOf` 可用）
        const hit = new Set();
        const underAny = (p) => {
            let id = p.id;
            while (id) {
                if (rootSet.has(id)) { hit.add(id); return true; }
                id = (state.parentOf && state.parentOf[id]) || null;
            }
            return false;
        };
        out = pool.filter(underAny);
        rootsInPage = hit.size;                    // ★ 一个都没命中 ⇒ 界面提示"范围根不在这个副页里"
    }
    const cond = pickOf(plan);
    out = out.filter((p) => matchesProblemFilter(p, cond, { shownValue: opts.shownValue, state }).ok);

    return {
        ids: out.map((p) => p.id), nodes: out, missingPage: false, linkCount: seenReal.size,
        source: usingSuperRoot ? PLAN_SOURCES[0] : PLAN_SOURCES[1],
        missingRoots, rootCount: rootSet.size, rootsInPage, usingSuperRoot
    };
}

/** 计划的**每天配额**（㉑：目标只存一份 ⇒ 其余粒度都从它折算；取不出来返回 0） */
export function dailyQuotaOf(plan, opts = {}) {
    const goal = (plan && plan.goal) || {};
    const base = PLAN_GRAINS.includes(goal.per) ? goal.per : DEFAULT_PLAN_GRAIN;
    const value = Number(goal.value);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const baseDays = (base === 'all')
        ? spanDays(opts.startKey, opts.endKey)
        : daysInPeriod(opts.baseKey || opts.startKey, base);
    return baseDays > 0 ? value / baseDays : 0;
}

/** 某一期（当前粒度）的目标值 = 每天配额 × 这一期的天数（㉑ 折算；`all` = 整段天数） */
export function periodGoalOf(plan, grain, periodKey, opts = {}) {
    const perDay = dailyQuotaOf(plan, opts);
    if (!perDay) return 0;
    const days = (grain === 'all') ? spanDays(opts.startKey, opts.endKey) : daysInPeriod(periodKey, grain);
    return perDay * days;
}

// ----------------------------------------------------------------
// 各期达成（⑩⑫⑬㉑）
// ----------------------------------------------------------------

// ----------------------------------------------------------------
// 两张图的**数据**（⑱⑲⑳：这一层只出数，不碰 DOM —— 渲染在 `ui/plan/planCharts.js`）
// ----------------------------------------------------------------

/**
 * 从 `planProgressOf` 的结果算出两张图要画什么。
 *
 * 用户 2026-10-13 定的形状（⑱）：
 *   · 图① **累计**：从计划开始那一期起逐期累加，目标线是一条**斜直线**（每期目标 × 期序）；
 *   · 图② **每期**：每期各自的量，目标线是**每期目标**那条水平线。
 * 两张图共用这一份 `points`（同一把尺子 ⇒ 不可能"图 1 和图 2 对不上"）。
 *
 * ⚠️ `goal.mode === 'count'` 时 `value` 是**题数**、否则是**Σ强度**（单位只在 `unit` 里区分）。
 * ⚠️ 期是**连续**的（`planProgressOf` 已经把空期也占位）⇒ 折线不会跳过"没做题的那些期"。
 *
 * @param {ReturnType<typeof planProgressOf>} progress
 * @returns {{grain:string, unit:string, points:Array<object>, maxValue:number,
 *            maxCumulative:number, totalGoal:number}}
 */
export function planChartSeriesOf(progress) {
    const p = progress || {};
    const periods = Array.isArray(p.periods) ? p.periods : [];
    const isCount = p.goalMode === 'count';
    let cum = 0;
    let cumGoal = 0;
    const points = periods.map((cell) => {
        const value = isCount ? Number(cell.count) || 0 : Number(cell.intensity) || 0;
        const goal = Number(cell.goal) || 0;
        cum += value;
        cumGoal += goal;
        return {
            key: cell.key,
            label: cell.label,
            value,
            goal,
            cumulative: cum,
            goalCumulative: cumGoal,
            reached: (cell.reached === undefined) ? null : cell.reached
        };
    });
    const maxValue = points.reduce((m, x) => Math.max(m, x.value, x.goal), 0);
    const maxCumulative = points.reduce((m, x) => Math.max(m, x.cumulative, x.goalCumulative), 0);
    return {
        grain: p.grain || DEFAULT_PLAN_GRAIN,
        unit: isCount ? '题' : '强度',
        points,
        maxValue,
        maxCumulative,
        totalGoal: points.length ? points[points.length - 1].goalCumulative : 0
    };
}
const NO_TIME = /^[\s-]*$/;

/**
 * **副页上每个节点方框的那两个数**（用户 2026-10-15："副页按下 Ctrl 时每个节点方框显示
 * 计划内剩余强度的总和" ⇒ 定了 **`剩 / 共` 两个都显示**）。
 *
 * 口径（`docs/training-plan.md` 的「14. 2026-10-15 用户新反馈（三条 · 分析稿）」那一节）：
 *   · **剩** = 这一支里**还没打完**的题的强度合计 = Σ `(done ? 0 : intensity)`；
 *   · **共** = 这一支里属于计划的题的强度合计（不管做没做）= Σ `intensity`；
 *   · "这一支" = 这个方框的**整棵子树**（含它自己那一格）；**按真实节点去重**
 *     （同一道题在页里出现两次只算一次 —— 与题集本身的口径一致）；
 *   · 不在计划里的题（被条件/范围根筛掉的）**不计**（它不占计划的强度）。
 *
 * ⚠️ 料是**传进来的** `entries`（`planProgressOf(...).entries`，字段 `{id, intensity, done}`）——
 *    这里**不**自己算强度、也不读 state：`core/trainingPlan.js` 里"怎么挑题、怎么算强度"只有
 *    `planProblemsOf` / `intensityOf` 那一套，别在这儿另立一份。
 * ⚠️ 只读、纯函数：**不写任何数据**（角标是"看"的东西，不进包）。
 *
 * @param {Object} page - 副页（`{rootId, virtualIndex}`）
 * @param {Array<{id:string, intensity:number, done:boolean}>} entries
 * @returns {Object<string,{remaining:number,total:number}>} 页内 id → 两个数
 */
export function planSubtreeIntensityOf(page, entries) {
    const out = {};
    const index = (page && page.virtualIndex) || {};
    const want = new Map();
    for (const e of (entries || [])) {
        if (!e || !e.id) continue;
        want.set(String(e.id), {
            intensity: Number(e.intensity) || 0,
            done: !!e.done
        });
    }
    if (!want.size) return out;

    // 后序：每个节点攒"子树里有哪些真实题 + 那一支的两个合计"。
    // ⚠️ 每个节点带一个 id 集合（同一道题在页里出现两次只算一次）；页是浅树（几层），
    //    真包 3~4k 节点实测很快 —— 真要优化再谈（别先造缓存）。
    const walk = (vid, guard) => {
        const v = index[vid];
        if (!v || guard.has(vid)) return { ids: new Set(), remaining: 0, total: 0 };
        guard.add(vid);
        const ids = new Set();
        let remaining = 0;
        let total = 0;
        const eat = (realId) => {
            if (!realId || ids.has(realId)) return;
            ids.add(realId);
            const hit = want.get(realId);
            if (!hit) return;
            total += hit.intensity;
            if (!hit.done) remaining += hit.intensity;
        };
        eat(String(v.refId || ''));
        for (const cid of (Array.isArray(v.children) ? v.children : [])) {
            // 孩子那一支的题并进来（`eat` 自带去重 ⇒ 两处出现同一道题只算一次）
            for (const id of walk(cid, guard).ids) eat(id);
        }
        out[vid] = { remaining: round2(remaining), total: round2(total) };
        return { ids, remaining, total };
    };

    if (page && page.rootId) walk(page.rootId, new Set());
    // 页根自己那格（`type === 'O'`，页里不画它的方框）不参与 —— 但它的孩子们已经算过了
    return out;
}

/** 强度是浮点乘出来的 ⇒ 两个数都收成两位小数（与全文件同一个 `round2`，别再造一个） */

/**
 * 计划的**完成情况**（现算，⑦：一个字节都不存）。
 *
 * 口径要点：
 *   · 题集 = 副页里全部真实 P（§4.1），**组层去重**跟整体计数口径走
 *     （`dedupRepresentatives` 在 `plain` 下原样返回、在判重下同组留一条 —— 用户 ③："去重模式自然解决"）；
 *   · "做完" = `status2 ∈ plan.statuses`（④ 默认 `[3,4]`，5 忽略不算）；
 *   · **期**由 `acTime` 落在哪一期决定（⑲）；没有 `acTime` 的题**不进任何期**、单独计数（`undatedCount`）；
 *   · 每期的 `count`/`intensity` 只算**做完的**（`countAll`/`intensityAll` 另给"这期共有多少"）；
 *   · 目标按 ㉑ 折算到当前粒度。
 *
 * @param {Object} state
 * @param {Object} plan
 * @param {{grain?:string, shownValue?:(n:Object,f:string)=>*, tables?:Array,
 *          levelOf?:(p:Object)=>string, startKey?:string, endKey?:string}} opts
 *        `shownValue` **必须**由界面传入（`viewDerivedDisplay(...) ?? viewValue(...)`）；
 *        省略时退化成直读节点字段（只给测试/脚本用）。
 * @returns {Object} 见函数末尾的返回注释
 */
export function planProgressOf(state, plan, opts = {}) {
    const shownValue = opts.shownValue || ((n, f) => (n ? n[f] : undefined));
    const goal = (plan && plan.goal) || {};
    const grain = PLAN_GRAINS.includes(opts.grain)
        ? opts.grain
        : (PLAN_GRAINS.includes(goal.per) ? goal.per : DEFAULT_PLAN_GRAIN);
    const statuses = (Array.isArray(plan && plan.statuses) && plan.statuses.length)
        ? plan.statuses.map(Number)
        : DEFAULT_PLAN_STATUSES.slice();
    const goalMode = (goal.mode === 'count') ? 'count' : 'intensity';
    const table = intensityTableById(opts.tables, plan && plan.intensityTableId);
    const source = INTENSITY_SOURCES.includes(plan && plan.intensitySource)
        ? plan.intensitySource
        : INTENSITY_SOURCES[0];
    const levelOf = opts.levelOf || ((p) => {
        const v = shownValue(p, 'xcpcDifficulty');
        return (v === undefined || v === null || v === '') ? '未填写' : String(v);
    });

    const got = planProblemsOf(state, plan, { shownValue });
    const hasAcTime = (p) => {
        const t = shownValue(p, 'acTime');
        return !!t && !NO_TIME.test(String(t));
    };
    // ★ 组层去重：判重模式下同组只留一条（`plain` 下原样返回 —— 口径跟整体走，别在这儿另立一套）
    const problems = dedupRepresentatives(state, got.nodes, { hasValue: hasAcTime });

    const entries = problems.map((p) => {
        const timeRaw = shownValue(p, 'acTime');
        const time = (timeRaw === undefined || timeRaw === null) ? '' : String(timeRaw);
        const s2raw = shownValue(p, 'status2');
        const s2 = Number.isFinite(Number(s2raw)) ? Number(s2raw) : 0;
        const inten = intensityOf(p, { table, source, shownValue });
        const periodKey = periodKeyOf(time, grain);
        return {
            id: p.id,
            time,
            s2,
            intensity: inten.value,
            usedDefault: inten.usedDefault,
            done: statuses.includes(s2),
            periodKey,
            level: levelOf(p)
        };
    });

    // ---- 期范围：起点必填；终点 = **今天**（用户 2026-10-13 第 2 轮：
    //      "「每期完成情况」只收录「计划开始到现在」的时间区间"）。
    //      · 计划填了结束时间且**已经过去** ⇒ 终点 = 那天（计划已经收尾，不必再摆空期）；
    //      · 计划还没开始（start > 今天）⇒ 一期都没有（界面说"还没开始"）。
    const today = opts.today || getNowStr().split(' ')[0];
    const startKey = opts.startKey || dayKeyOf(plan && plan.start);
    const planEnd = dayKeyOf(plan && plan.end);
    let endKey = (planEnd && planEnd < today) ? planEnd : today;
    if (opts.endKey) endKey = opts.endKey;                  // 显式给了就以它为准（测试/图表用）
    const keys = (startKey && endKey && startKey <= endKey) ? periodsBetween(startKey, endKey, grain) : [];

    const bucket = new Map();
    for (const k of keys) {
        bucket.set(k, {
            key: k, label: periodLabelOf(k, grain),
            days: (grain === 'all') ? spanDays(startKey, endKey) : daysInPeriod(k, grain),
            count: 0, intensity: 0,
            countAll: 0, intensityAll: 0, byLevel: {}
        });
    }
    const totals = { count: 0, intensity: 0, countAll: 0, intensityAll: 0 };
    let undatedCount = 0; let unknownDifficulty = 0;
    // ★ 第 12 轮（用户："未填写的不计入 因为有热身赛等" ⇒ "强度为 0 就行了"）：
    //   没填难度的题强度**就是 0**（见 `intensityOf`）⇒ 这里**不用判**，加 0 不影响和。
    //   ⚠️ 唯一要单独数的是 `unknownDifficulty`（给界面那句警告用）。
    for (const e of entries) {
        if (e.usedDefault) unknownDifficulty++;
        if (!e.periodKey) { undatedCount++; continue; }
        const cell = bucket.get(e.periodKey);
        if (!cell) continue;                       // 落在窗口外的期（有 `end` 卡着时）
        cell.countAll++;
        cell.intensityAll += e.intensity;
        totals.countAll++;
        totals.intensityAll += e.intensity;
        if (e.done) {
            cell.count++;
            cell.intensity += e.intensity;
            cell.byLevel[e.level] = (cell.byLevel[e.level] || 0) + 1;
            totals.count++;
            totals.intensity += e.intensity;
        }
    }

    const periods = [...bucket.values()].map((c) => {
        const goalValue = periodGoalOf(plan, grain, c.key, { startKey, endKey });
        const actual = (goalMode === 'count') ? c.count : c.intensity;
        return { ...c, goal: goalValue, actual, reached: goalValue > 0 ? actual >= goalValue : null };
    });

    const totalGoal = spanDays(startKey, endKey) > 0
        ? dailyQuotaOf(plan, { startKey, endKey }) * spanDays(startKey, endKey)
        : 0;

    // ---- 三个总数（用户 2026-10-13 第 2 轮要的）：已写 / 总训练强度 ----
    // ⚠️ `totalIntensity` 是**题集里全部题的强度和**（含没 AC 时间、含还没做的）——
    //    与 `totals.intensityAll`（只数"有 AC 时间"的）**不是一回事**，别拿错。
    // ★ 第 12 轮起没填难度的题强度是 0 ⇒ 这两项天然只含"填了难度"的题
    const totalIntensity = entries.reduce((a, e) => a + e.intensity, 0);
    const doneIntensity = entries.reduce((a, e) => a + (e.done ? e.intensity : 0), 0);

    return {
        ok: !got.missingPage,
        missingPage: got.missingPage,
        grain,
        goalMode,
        goalBase: PLAN_GRAINS.includes(goal.per) ? goal.per : DEFAULT_PLAN_GRAIN,
        startKey,
        endKey,
        planEndKey: planEnd,          // 计划自己填的结束时间（没填 = ''）——"推荐强度"要靠它判断
        goalPerDay: dailyQuotaOf(plan, { startKey, endKey }),
        today,
        entries,
        periods,
        totals: { ...totals, goal: totalGoal, actual: (goalMode === 'count') ? totals.count : totals.intensity },
        // 题集层面的三个数（含"没 AC 时间"的题）：已写 / 总
        totalIntensity,
        doneIntensity,
        remainingIntensity: Math.max(0, totalIntensity - doneIntensity),
        totalCount: entries.length,
        doneCount: entries.filter((e) => e.done).length,
        undatedCount,
        unknownDifficulty,
        linkCount: got.linkCount,
        // ⚠️ 别与上面那个 `source`（**强度源** `xcpc`/`cf`）混：这几个是**题集**的（§13）
        problemsSource: got.source,
        usingSuperRoot: got.usingSuperRoot,
        missingRoots: got.missingRoots,
        rootCount: got.rootCount,
        rootsInPage: got.rootsInPage,
        tableId: table.id,
        source
    };
}

/**
 * 计划的**预测**（用户 2026-10-13 第 2 轮要的三个数 + 预计完成日期）：
 *   · **已写 / 总训练强度**：`doneIntensity` / `totalIntensity`（题集里**全部**题的强度和）；
 *   · **推荐训练强度**：**填了结束时间**才算 —— 把"还差的强度"按剩余天数摊平（恰好按时完成）；
 *   · **目标训练强度**：计划自己填的那个目标，按 ㉑ 折算到**每天**（`goalPerDay`）；
 *     它 > 0 时再算**预计完成日期**（按这个目标速度，从**今天**起算还需要几天）。
 *
 * ⚠️ 全部是"现算"（⑦ 不存快照）。`today` 可注入（测试/脚本用）。
 * ⚠️ "剩余天数"是**含今天**的（今天也算一天可用的时间）；已完成 ⇒ 天数为 0、日期 = 今天。
 *
 * @param {ReturnType<typeof planProgressOf>} data
 * @param {{today?:string}} [opts]
 */
export function planForecastOf(data, opts = {}) {
    const d = data || {};
    const today = opts.today || d.today || getNowStr().split(' ')[0];
    const totalIntensity = Number(d.totalIntensity) || 0;
    const doneIntensity = Number(d.doneIntensity) || 0;
    const remaining = Math.max(0, totalIntensity - doneIntensity);
    const endKey = d.endKey || '';
    const planEnd = d.planEndKey || '';
    // 剩余天数：从今天到**计划结束那天**（含今天）；没结束时间 ⇒ null（算不了"推荐强度"）
    const leftDays = planEnd ? Math.max(0, daysBetween(planEnd, today) + 1) : null;
    const goalPerDay = Number(d.goalPerDay) || 0;
    const recommendPerDay = (leftDays && leftDays > 0) ? (remaining / leftDays) : null;
    let etaKey = '';
    if (goalPerDay > 0) {
        if (remaining <= 0) etaKey = today;
        else etaKey = addDays(today, Math.max(0, Math.ceil(remaining / goalPerDay) - 1));
    }
    return {
        today,
        startKey: d.startKey || '',
        endKey,
        hasEnd: !!planEnd,
        totalIntensity,
        doneIntensity,
        remainingIntensity: remaining,
        doneRatio: totalIntensity > 0 ? (doneIntensity / totalIntensity) : 0,
        goalPerDay,
        recommendPerDay,
        leftDays,
        etaKey,
        etaDays: etaKey ? Math.max(0, daysBetween(etaKey, today) + 1) : null
    };
}
