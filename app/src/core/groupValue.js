// ================================================================
// 组值：A（树内）与 B（映射）两套独立，merge 那一步才相遇
//                                             （core/groupValue.js）
//
// 【架构】A（树内）与 B（映射）拆开算，合成头不排进成员列表
// ----------------------------------------------------------------
// 对**任意节点的任意字段**，组那份（第二列）一律这么算：
//
//   ① **A = 树内计算（只看子树）** —— 节点**自己的记录** + **子节点情况的聚合**。
//      **复用既有实现**，绝不另写一套：
//        · P 的 `status1` / `status2`：A = 它**自己那份**（P 的子节点是 R，
//          R 没有这两个字段）—— `core/derive.js` 的 `derivePstatus1` / `derivePstatus2`；
//        · C/W/S 的容器字段（如 `statusComplete2`）：A = `core/derive.js` 的
//          **容器推导**（`deriveContainerStatusComplete2` / `deriveContainerStatusComplete1`，
//          与 `autoComputeRules.js` 里那套同源）。
//      取值方式：调用方给 `baseOf(node, field)`；`core/groupCompute.js` 给的是
//      **当前这一层**的派生表（`buildDerivedTable({ group: working })`）——
//      所以 A 天然允许"依赖**上一层**已经算好的派生表"（层间推进见 `groupCompute.js`）。
//
//   ② **B = 映射计算（列表）** —— `ownerSynth` 指向该节点的那些节点
//      （= **映射列表**，永远是原料）各自的值 → 用**该字段的聚合器**聚合。
//      名单来自 `core/ops/synth.js` 的 `synthMembersTable(state)`
//      （**一趟建表 + 树序**，既有件；这里不逐节点 DFS）。
//
//   ③ **合并：`最终值 = merge(A, B)`**
//        · 通用：`agg.combine(agg.value(A), B)`（该字段的聚合器，见 `AGG_BUILDERS`）；
//        · `status2` 特例：**A 为「忽略」⇒ 保持忽略**（A 这一套的结论优先），
//          否则取 `max`（= `preferReal` 聚合器；成员里的忽略不吸收，见 `makeStatus2Agg`）。
//      ⚠️ 忽略一律用**命名常量**（`model/status.js` 的 `S2_IGNORE` /
//      `query/groupCount.js` 的 `STATUS2_IGNORED`，当前同值 5）——**不写死数字**。
//      口语里说的"0"是 `S2_UNUSED`（未使用），**不是**忽略。
//
//   ④ **两套互相独立**：任何字段只需要这两套（A 的取法 + B 的聚合器）。
//
//   ⑤ **合成节点绝不排进成员列表的第 0 位**（核心约束）：
//      合成节点只通过 **A** 参与，成员只通过 **B** 参与，两者在 merge 才相遇。
//      所以成员名单（`synthMembersTable` / `groupMemberOrder`）里**没有合成节点自己**，
//      `memberIdsOf` 还会再滤一道（坏数据里的"自指"也进不来）。
//
// 两列值 / 三趟（第 2 趟按上面这套算）
// ----------------------------------------------------------------
//   · **组** = 一个合成节点 + 它的全部成员原料；无所指的原料自己就是一组（单元素组）。
//     成员关系是**指针**（`ownerSynth` → `synthKey`），**不是父子、不嵌套**。
//   · **两列值**：「自己那份」（派生表算的）与「组那份」（本模块）。
//     两列**都不落库、不写来源层、不新增缓存字段** —— 它们只是派生。
//   · **每层三趟**：`原料 → 合成 → 原料（倒推覆盖）`，层间顺序 `R → P → C`。
//     第三趟把"这一组的组值"给它的**头与成员**（写进 `working` 覆盖表，**不是**节点对象）；
//     上一层读它时就能看到"我所属组的组值"。来源层一个字节都没动。
//   · **聚合字段范围**：逐层物化的仍只有 `status1` / `status2`（别顺手加）。
//
// ⚠️ 三条硬约束
//   ① **绝不写回来源层**：本模块是**纯函数** —— 只读输入、只返回结果。写回去就会被
//      当输入重新喂进聚合 ⇒ 震荡。
//   ② **不接计数模块的折叠加**：组值不走 `core/query/groupCount.js` 的 `agg` 折叠
//      （"组 = 合成节点 + 全部成员"是**结构性质**，与统计的计数模式无关）；
//      这里只 import 它的**现成聚合器**（`makeOrAgg` / `makeStatus2Agg`）与常量 ——
//      一份实现，两处用。`groupCount.js` 继续只管**计数**（欧拉序那一套）。
//   ③ **业务字段不写死在算法里**：字段 → 聚合器的映射在下面 `AGG_BUILDERS`，
//      算法本体只认 `{ identity, value, combine }`。
//
// 依赖：core/query/groupCount.js（现成聚合器 + 忽略常量）、core/ops/synth.js（合成关系反查表）、
//       core/model/status.js（忽略档常量）。纯模块（无 immer / DOM）。
// ================================================================
import { makeOrAgg, makeStatus2Agg, STATUS2_IGNORED } from './query/groupCount.js';
import {
    isSynthesis, synthIndex, synthMembersTable, synthIndexOf,
    synthKeyOf, ownerSynthOf, SYNTH_TYPES
} from './ops/synth.js';
import { S2_IGNORE } from './model/status.js';
import { TIME_PLACEHOLDER } from './model/constants.js';
// ★ AC 时间"怎么挑"的**唯一一份**（规则从 `ctx.settings` 取）—— 组那份与另三处必须同义
import { pickAcTime, acTimeRuleOf } from './acTimeRule.js';
import { mergeLinkKinds, linkKindsOfNode } from './linkKinds.js';
// ★「一个字段怎么取」的模板（`take: { agg, materialize }`）—— `GROUP_FIELDS` 从它派生
import { ELEMENTS, fieldValueKey, isEmptyFieldValue } from './model/elements.js';
// ★「哪个来源更权威」的**唯一一份**（`candidateScore` = 手改 > 字段偏好 > 类别序 > 来源等级）——
//   值级投影（`projectField`）与下面的"组值按来源权威挑"必须同一套判据
import { normalizeTrust, sourceMetaOf, candidateScore } from './trust.js';

// ================================================================
// 层级（层间顺序 R → P → C）
// ================================================================

/** 参与合成的节点类型，**按层间顺序**排列（R → P → C；W/S 不参与） */
export const GROUP_LEVELS = Object.freeze(['R', 'P', 'C']);

/**
 * **逐层物化（"回代"）**的字段：会进 `working`（倒推覆盖表），也是界面「组那份」**直接读**的字段。
 *
 * ★ **这份名单由 `core/model/elements.js` 的 `ELEMENTS` 派生**（`take.materialize`）——
 *   一个字段"怎么取"只写在那张表的一行上（模板），这里不再手写第二份清单。
 *   ⇒ 要让一个新字段也回代：在它的 `ELEMENTS` 行里加 `take: { agg: …, materialize: true }`
 *      （顺序 = 表里的声明顺序；只影响计算次序，与值无关）。
 *
 * ⚠️ 它**不等于** `AGG_BUILDERS` 的键集：
 *    `statusComplete1` / `statusComplete2`（C 的容器字段）与信息类的 `contestTime` /
 *    `链接分类` / `acTime` / `lastSubmitTime` 也有聚合器，但**不回代**
 *    —— 它们走 `groupValueOnDemand()`（显示侧）/ `groupAggregateOf()`（统计侧）**按需聚合**，
 *    规则还是 `AGG_BUILDERS` 那一份（与 C 卡那两格"不回代"同一姿态）。
 *
 * ★ **难度（各难度 / 通过率 / 等级）要像 `status2` 一样回代**（用户 2026-10-08）：
 *    它们进这张名单 ⇒ 走"每层三趟"的物化，组头与成员都能从覆盖表里直接读到组那份。
 */
export const GROUP_FIELDS = Object.freeze(
    Object.keys(ELEMENTS).filter((f) => ELEMENTS[f].take && ELEMENTS[f].take.materialize)
);

/**
 * `status2` 的「忽略」档 —— **命名常量，不写死数字**。
 * 与 `query/groupCount.js` 的 `STATUS2_IGNORED`（`makeStatus2Agg` 的 `ignoreValue`）
 * 同源同值；这里用 `model/status.js` 的 `S2_IGNORE` 表达"A 是不是忽略"这条判定。
 */
const IGNORE_VALUE = S2_IGNORE;

/**
 * A（**树内**那份）是不是「忽略」—— 判定只此一处。
 *
 * 它是 `status2` 合并特例的唯一判据：**A 为忽略 ⇒ 组值保持忽略**（不看 B）。
 * 与聚合器给 A 的取值口径是同一套语义：判定作用在 **A**（合成头自己那份）上，
 * 而不是"排第 0 位的头"上。
 */
function aIsIgnored(value) {
    if (value === undefined || value === null || value === '') return false;
    return Number(value) === IGNORE_VALUE;
}

/**
 * 字段 → 聚合器（**唯一登记处**）。
 *
 * 每个生成器拿两个东西：`typeOf(n)`（节点类型）与 `valueOf(n)`（该节点这个字段的**自己那份**），
 * 返回 `{ identity, value, combine }`。`combine` 满足结合律 + 交换律（或 / 取最大）。
 *
 *   · `status1` = **取或**（`makeOrAgg`）：`OR(A, B)`；
 *   · `status2` = `preferReal: true` —— 只在**非忽略**的档位里取最大（`[5,3] → 3`），
 *     全为忽略才是 5；⚠️ 默认值是 `preferReal: false`（字面语义），
 *     这里**必须显式传 `{ preferReal: true }`**（`groupCount.js:92` 的注释已按这条口径）。
 *     另有一条**聚合器本体看不见**的合并特例（"A 为忽略 ⇒ 保持忽略"）——见 `mergeField`；
 *     它只作用在**一方**（A）上，**不需要**"谁是这一组的头"。
 *   · `statusComplete2` = **序数取最大**（`0 未动 / 1 接触 / 2 全处理 / 3 AK`，覆盖 `4` 忽略）。
 *     这就是 `makeStatus2Agg` 的**默认**（`preferReal: false` = 字面 `max`）：
 *     忽略 `4` 是序数最大 ⇒ 自然优先。统计 C 侧（`core/query/stats.js` 的
 *     `contestGroupValue`）也走 `groupAggregateOf`，**不自己折叠** —— 改规则只改这里。
 *     只让 **C** 参与（它是容器的字段；W/S 不许合成）。
 *   · `statusComplete1` = **取或**（`makeOrAgg`）：0/1 两档 —— **任一副本"全处理"⇒ 整组算
 *     全处理**，与 `status1` 的"或"同一姿态（"一处在 A 平台 AC 了，B 平台的副本也亮"）。
 *     同样只让 **C** 参与。
 *
 * ⚠️ 调用方传进来的取值器一律包一层：**只有参与聚合的类型**才贡献值，其余给单位元。
 */
const AGG_BUILDERS = {
    status1: (typeOf, valueOf) => makeOrAgg(n => (participatesInGroupAgg(typeOf(n)) ? valueOf(n) : 0)),
    status2: (typeOf, valueOf) => makeStatus2Agg(
        n => (participatesInGroupAgg(typeOf(n)) ? valueOf(n) : null),
        { preferReal: true }
    ),
    statusComplete2: (typeOf, valueOf) => makeStatus2Agg(
        n => (typeOf(n) === 'C' ? valueOf(n) : null)
    ),
    statusComplete1: (typeOf, valueOf) => makeOrAgg(n => (typeOf(n) === 'C' ? valueOf(n) : 0)),

    // ---- 下面两个是**信息类**字段（不是"这一组做成没做成"，而是"这一组是什么样"）----
    //   ⚠️ 它们**不进 `GROUP_FIELDS`**（不逐层物化）：链接是**列表**、时间只有 C 用得上，
    //      物化进覆盖表只增加内存与重算面。走 `groupValueOnDemand`（显示侧）/
    //      `groupAggregateOf`（统计侧）**按需聚合** —— 与 `statusComplete1/2` 同一条路。

    // `contestTime`：**取最新**（字典序最大的非空值）。
    //   ⚠️ 不是取最早 —— 实测：C 组里成员时间不一致**只有 6 例，全部是"延期/补办"**
    //     （旧来源留着原定日期、真实日期是较晚那个）：
    //       `2022ecfinal` 2023.03.25 ←→ 2022.03.25 · `2019ccpcf` 2021.05.30 ←→ 2019.11.17
    //       `2019ecfinal` 2021.04.18 ←→ 2019.12.15 · `2018ec_regional-青岛` 2018.11.04 ←→ 2018.10.21
    //     ⇒ 取最新才对得上真实日期，也顺带对得上"人在成员上把时间改成真日期"那条路。
    //   ⚠️ 已知边界：若人把某个成员的**正确**时间改**早**了、而另一个成员留着错误的晚时间，
    //     这里仍会取晚的那个（"人工最高"没进这条规则）。要那种语义就得给聚合器加
    //     `finalize` 并把来源强度折进候选 —— 现在**不做**（等到真出现那种数据再说，别提前造机制）。
    contestTime: (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const raw = valueOf(n);
            const v = String(raw === undefined || raw === null ? '' : raw).trim();
            return (!v || v === TIME_PLACEHOLDER) ? null : v;
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            if (b === null || b === undefined) return a;
            return a > b ? a : b;
        }
    }),

    // `acTime` / `lastSubmitTime`：把各原料的"最早 AC / 最晚提交"推给合成节点。
    //   与它们各自的自动计算规则**同义**（`derivePacTime` = 按 `settings.acTimeRule` 挑、
    //   `derivePlastSubmitTime` = 最晚的提交），取值口径与上面 `contestTime` 那条一字不差
    //   （空串与占位符都不进候选）；路径与 `链接分类` 相同：不进 `GROUP_FIELDS`、
    //   走 `groupValueOnDemand` 按需聚合，不新增任何东西。
    //   ★ `v9.1.21` 起**挑法也共用同一份**（`core/acTimeRule.js`）：规则从 `ctx.settings` 取，
    //     `combine` 就是"对这两个值再挑一次" ⇒ `earliest` 退化成原来的 `a < b ? a : b`（逐字等价），
    //     `latest`/`cutoff` 也自动一致。⚠️ `ctx` 由两个调用点（`groupAggregateOf` 与三趟的物化循环）传。
    acTime: (typeOf, valueOf, ctx) => {
        const rule = acTimeRuleOf(ctx && ctx.settings);
        return {
            identity: null,
            value: n => {
                if (!participatesInGroupAgg(typeOf(n))) return null;
                const raw = valueOf(n);
                const v = String(raw === undefined || raw === null ? '' : raw).trim();
                return (!v || v === TIME_PLACEHOLDER) ? null : v;
            },
            combine: (a, b) => {
                if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
                if (b === null || b === undefined) return a;
                return pickAcTime([a, b], rule, '');
            }
        };
    },
    lastSubmitTime: (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const raw = valueOf(n);
            const v = String(raw === undefined || raw === null ? '' : raw).trim();
            return (!v || v === TIME_PLACEHOLDER) ? null : v;
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            if (b === null || b === undefined) return a;
            return a > b ? a : b;                       // 取最晚
        }
    }),

    // `各难度`：**取成员里第一个有值的那一份**推给合成节点。
    //   为什么是"第一个"而不是最大/最小：这些值**没有序**（1200 与 1500 之间没有"哪个才对"），
    //   口径本来就是"这一组按哪个来源看" —— 与字段条 `core/fieldRegistry.js` 的 `pickInGroup`
    //   （按成员顺序取第一个有值的）同一姿态。
    //   路径与 `链接分类` 一字不差：不进 `GROUP_FIELDS`、走 `groupValueOnDemand` 按需聚合。
    //   ⚠️ **难度数值仍然按"第一个"**；而**通过率与它派生的档不按这个**（见下面 `ratio`）。
    cfDifficulty: (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const num = Number(valueOf(n));
            return (Number.isFinite(num) && num !== 0) ? num : null;   // `0` = 未填；负数是真值
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            return a;                                                  // 已经拿到第一个有值的 ⇒ 不覆盖
        }
    }),
    atcoderDifficulty: (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const num = Number(valueOf(n));
            return (Number.isFinite(num) && num !== 0) ? num : null;
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            return a;
        }
    }),
    clistDifficulty: (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const num = Number(valueOf(n));
            return (Number.isFinite(num) && num !== 0) ? num : null;
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            return a;
        }
    }),
    // ★ `through率`（`ratio`）与它派生的档（`xcpcDifficulty`）：**按"这条值是谁说的"挑**
    //   （`pick` + `candidateScore`；规则在 `mergeField` 里，只此一处）。
    //   与上面 `各难度` 的"第一个有值"**故意不同**：难度数值无序（1200 vs 1500 无从比较），
    //   而**通过率有对错** —— 这一场的权威榜说了算。实测踩到（用户 2026-10-16）：
    //   xcpcio 榜给 0.19%，却被某个成员身上**残留的** cf 0.77% 压住了（组值按树序先撞上它）。
    //   ⚠️ 档必须**跟着 ratio 一起**按权威挑（`pick: 'ratio'`，看的是**该成员 ratio 那份值的出处**）
    //      —— 否则会出现 `0.19%(R)` 这种自相矛盾：档是 ratio 的纯函数（`derive.js`）。
    //   ⚠️ 平手仍按老顺序（组头 → 成员树序）⇒ 只在**真有出处差异**时才改变结果。
    ratio: (typeOf, valueOf, ctx) => ({
        identity: null,
        pick: 'ratio',
        trust: normalizeTrust(ctx && ctx.trust),
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const s = String(valueOf(n) === undefined || valueOf(n) === null ? '' : valueOf(n)).trim();
            return s === '' ? null : s;
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            return a;
        }
    }),
    xcpcDifficulty: (typeOf, valueOf, ctx) => ({
        identity: null,
        pick: 'ratio',                    // ★ 档跟着 ratio 的出处走（见上面那段）
        trust: normalizeTrust(ctx && ctx.trust),
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const s = String(valueOf(n) === undefined || valueOf(n) === null ? '' : valueOf(n)).trim();
            return (s === '' || s === '-') ? null : s;                 // `-` = 未填写
        },
        combine: (a, b) => {
            if (a === null || a === undefined) return (b === null || b === undefined) ? null : b;
            return a;
        }
    }),

    // `链接分类`：**并集**（各来源的链接都要留；同类别同 URL 只留一条）。
    //   判据复用 `core/linkKinds.js` 的 `mergeLinkKinds` —— 与 `crate-merge` 合并两条记录时
    //   **同一份**实现（各写一份会漂成两种去重口径）。
    //   ⚠️ "自己那份"**不问调用方的取值器**，直接走 `linkKindsOfNode(node)`：这条信息在
    //      **包记录**（元列 `链接分类`）与**应用节点**（来源层 `values.link` + `linkKind`）
    //      里住的地方不同，只有那一个函数两种都认（链接与账户范围无关，不需要投影）。
    '链接分类': (typeOf, valueOf) => ({
        identity: null,
        value: n => {
            if (!participatesInGroupAgg(typeOf(n))) return null;
            const links = linkKindsOfNode(n);
            return Object.keys(links).length ? links : null;
        },
        // ⚠️ **每次都新建对象**：`identity` 被所有组复用，原地改它会让组之间串味
        combine: (a, b) => {
            if (!a) return b || null;
            if (!b) return a;
            const out = {};
            mergeLinkKinds(out, a);
            mergeLinkKinds(out, b);
            return Object.keys(out).length ? out : null;
        }
    })
};

/** 某个字段有没有聚合器（没登记 = 本版本不聚合它） */
export function hasGroupAgg(field) {
    return Object.prototype.hasOwnProperty.call(AGG_BUILDERS, field);
}

/**
 * **有聚合器的字段名单**（`AGG_BUILDERS` 的键）—— 给"要按聚合器逐字段走一遍"的调用方用，
 * 免得它们自己再抄一份名单（抄本会烂：加了聚合器却漏了某一处）。
 * 例：节点信息页的完整字段表要给**不在元素表里的元列**（`链接分类`）也补一行「组那份」。
 */
export function groupAggFields() {
    return Object.keys(AGG_BUILDERS);
}

/** 这个类型参不参与某一层的 status1/status2 聚合（只有 C/P；R 不参与，W/S 不许合成） */
export function participatesInGroupAgg(type) {
    return type === 'C' || type === 'P';
}

// ================================================================
// 核心：一个字段的 B 聚合 + A/B 合并
// ================================================================

/** 这一组的**成员 id**（= 映射列表）：`synthMembersTable` 的一行，**去掉合成头自己** */
function memberIdsOf(membersOf, key, headId) {
    const list = membersOf.get(key) || [];
    return list.filter(id => id !== headId && id !== undefined && id !== null);
}

/**
 * **B = 映射列表聚合**：把成员各自"自己那份"按该字段的聚合器折叠起来。
 *
 * 合成节点**不在这里** —— 它在 A 那一边（见文件头 ⑤）。
 *
 * @param {Object} agg - `AGG_BUILDERS[field]` 的结果
 * @param {Object} nodes
 * @param {string[]} memberIds
 * @returns {*} 折叠值；没有任何成员 ⇒ `agg.identity`
 */
function aggregateMembers(agg, nodes, memberIds) {
    let acc = agg.identity;
    for (const mid of memberIds) {
        const m = nodes[mid];
        if (!m) continue;                                    // 悬空 id 跳过
        acc = agg.combine(acc, agg.value(m));                // 成员（原料）各自那份
    }
    return acc;
}

/**
 * 排序键的逐位比较：`a` 严格优于 `b`？平手返 `false`（= 保持先到者，与 `trust.js:isBetter` 同姿态）。
 * ⚠️ 只比"来源权威"这几位（类别 / 等级…），**不比 `at`** —— 组值这一侧的输入是各成员
 *    "自己那份"的值，没有"这条值什么时候来的"可比；同权威就按原来的顺序（组头 → 成员树序）。
 */
function betterScore(a, b) {
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}

/**
 * **这个成员这一格的来源是谁**（给"组值按来源权威挑"用）。
 *
 * 从节点的**来源层**里挑一条最权威的（`candidateScore`：手改 > 字段偏好 > 类别 > 等级）——
 * 与值级投影"同值合并、代表取优先级最高的来源"同一口径。
 *
 * ⚠️ 一条都没有（值来自缓存字段 / 上一层倒推覆盖 / 纯派生）⇒ 返 `{kind:'', rank:0}`，
 *    而空 kind 在 `categoryIndex` 里认不出来 ⇒ 排在**所有已知类别之后**
 *    （"说不出出处"本来就无从比较权威；旧数据全是这种 ⇒ 它们之间回到老顺序，行为不变）。
 *
 * @param {Object} node
 * @param {string} srcField 按哪个字段的出处排名（`ratio` 的档 ⇒ `xcpcDifficulty` 也看 `ratio`）
 * @param {Object} t 已归一化的 trust
 * @returns {{src:string, kind:string, rank:number}}
 */
function nodeSourceOf(node, srcField, t) {
    const list = (node && node.values && node.values[srcField]) || [];
    let best = null;
    let bestScore = null;
    for (const item of Array.isArray(list) ? list : []) {
        if (!item || typeof item !== 'object' || item.invalid) continue;
        if (isEmptyFieldValue(srcField, item.v)) continue;
        const src = String(item.src || '');
        const cand = { src, ...sourceMetaOf(src, t) };
        const sc = candidateScore(srcField, cand, t);
        if (!bestScore || betterScore(sc, bestScore)) { best = cand; bestScore = sc; }
    }
    return best || { src: '', kind: '', rank: 0 };
}

/**
 * **merge(A, B)**：两套独立计算在这一步相遇。
 *
 *   · `status2` 特例：**A 为忽略 ⇒ 保持忽略**（A 这一套说了算），否则 `combine(A, B)`；
 *   · ★ **`agg.pick` 的字段（`ratio` 与它的派生档 `xcpcDifficulty`）：按"这条值是谁说的"挑** ——
 *     先比 `candidateScore`（手改 > 字段偏好 > 类别序 > 来源等级），**平手仍按原来的顺序**
 *     （组头 → 成员树序）。理由与边界见 `mergeField` 里那段长注释。
 *   · 其余字段：`combine(A, B)`（`status1` 取或 / `statusComplete2` 取最大）。
 *
 * ⚠️ 两个都空（`agg.value` 为空 + B 是单位元）⇒ 返回 `null`（调用方据此**不入表**，
 *    于是 `groupValueOf` 给 `undefined`、调用方退回"自己那份"）。
 *
 * ⚠️ "A 为忽略"只在**这个字段真的认这个节点类型**时才看（`status2` 的参与类型是 C/P）——
 *    与聚合器给 A 的取值口径**同一把尺**，坏数据（如 R 头上挂着 `status2`）不会被误判。
 *
 * @param {string} field
 * @param {Object} agg
 * @param {Function} typeOf
 * @param {Object} head 合成头（单元素组时就是那个原料自己）
 * @param {string[]} memberIds 映射列表（**不含** head）
 * @param {Object} nodes
 * @param {(node:Object) => *} readOf 该字段"自己那份"的取值器（A 侧）
 */
function mergeField(field, agg, typeOf, head, memberIds, nodes, readOf) {
    const aRaw = readOf(head);
    if (field === 'status2' && participatesInGroupAgg(typeOf(head)) && aIsIgnored(aRaw)) {
        return STATUS2_IGNORED;
    }
    // ★ **值级字段按来源权威挑**（`agg.pick` = 按哪个字段的出处排名；`ratio` 与它的档都看 `ratio`）。
    //   为什么必须改掉"第一个有值的就算"（那条规则的原话与理由见下面 `ratio` 构建器上方）：
    //   它假设"成员之间没有对错之分"（1200 与 1500 哪个才对？无从比较），而**通过率有对错**
    //   —— 这一场的权威榜说了算。用户 2026-10-16 的实例：xcpcio 榜给 0.19%，
    //   却被某个成员身上残留的 0.77% 压住了（组值按树序先撞上它）。
    //   平手仍按老顺序 ⇒ 只在**真有出处差异**时才改变结果（真包对拍：2128 个有 ratio 的组、
    //   其中 98 组有两个候选，**改前改后 0 处不同**）。
    if (agg.pick) {
        const rankField = agg.pick;
        const t = agg.trust || {};
        let best = null;
        let bestScore = null;
        const consider = (n) => {
            if (!n) return;
            const v = agg.value(n);
            if (v === null || v === undefined) return;
            const sc = candidateScore(rankField, nodeSourceOf(n, rankField, t), t);
            if (!bestScore || betterScore(sc, bestScore)) { best = v; bestScore = sc; }
        };
        consider(head);
        for (const mid of memberIds) consider(nodes[mid]);
        return best;
    }
    return agg.combine(agg.value(head), aggregateMembers(agg, nodes, memberIds));
}

/**
 * **一组的组值**（对外；`core/query/stats.js` 的"统计去重"就取这个）。
 *
 * 与 `computeLayerGroups` 的**第 2 趟**同一套规则（`AGG_BUILDERS` 的聚合器 +
 * `mergeField` 里那条 `status2` 特例）—— "统计去重"和"界面组那份"两处口径合一，
 * 改规则只需改一处。
 *
 * ⚠️ 输入是**取值器** `readOf(node, field)`（"自己那份"），**不是**节点缓存字段：
 *    统计侧的 reader 是 `viewDerived`（按账户范围投影），必须原样透传。
 *    （它不直接调 `groupValueOf` 的原因正在这里：`groupValueOf` 走 `groupCompute.js`
 *    自建的派生表，塞不进调用方的 reader；两者在生产口径下同值。）
 * ⚠️ `memberIds` 由调用方给（统计侧是 `collectGroups` 的 `slot.members`，**永远是原料**）；
 *    这里**再滤一道 headId**，保证"合成节点不出现在自己的成员列表里"。
 *
 * @param {Object} state
 * @param {Object} opts
 * @param {string} opts.headId 组头（合成节点）的节点 id
 * @param {string[]} [opts.memberIds] 该组的成员节点 id（映射列表）
 * @param {string} opts.field `status1` / `status2` / `statusComplete2`
 * @param {(node:Object, field:string) => *} opts.readOf "自己那份"的取值器
 * @returns {*} 组值；字段没有聚合器 / 组头不存在 → `undefined`
 */
export function groupAggregateOf(state, { headId, memberIds = [], field, readOf } = {}) {
    if (!hasGroupAgg(field) || typeof readOf !== 'function') return undefined;
    const nodes = (state && state.nodes) || {};
    const head = nodes[headId];
    if (!head) return undefined;
    const typeOf = n => (n && n.type) || '';
    const agg = AGG_BUILDERS[field](typeOf, n => readOf(n, field), state);
    const list = (Array.isArray(memberIds) ? memberIds : []).filter(id => id !== headId);
    return mergeField(field, agg, typeOf, head, list, nodes, n => readOf(n, field));
}

/**
 * **按需**取一个节点的「组那份」——给**没有逐层物化**的字段用（C 的
 * `statusComplete1` / `statusComplete2`，见 `GROUP_FIELDS` 的注释）。
 *
 * 为什么需要它：显示侧（`view/scope.js` 的"组那份"列）默认走
 * `groupCompute.groupValueOf()` ⇒ 只认物化表里有的字段。C 的容器字段没进物化，
 * 于是"组那份"这一列就没处落 —— 这里按需聚合补上（一个 C 组里，**一处 AC ⇒ 整场比赛亮**）。
 * 统计侧一直是对的（它走 `groupAggregateOf` 按需聚合）。这里把同一条路补到显示侧，
 * 规则仍是 `groupAggregateOf`（**只有一份**：`AGG_BUILDERS` + `mergeField`）。
 *
 * ⚠️ **算法本身只有一份**：这里**没有**第二条"父节点怎么算"的路 —— 容器**自己那份**
 *    用的是 `core/derive.js` 第二趟外面那条链路（子树里节点的**终值** + 合成节点的成员），
 *    本函数只管"这一列读哪一个字段的组值"。
 *
 * @param {Object} state
 * @param {Object} node
 * @param {string} field
 * @param {(node:Object, field:string) => *} readOf "自己那份"的取值器（按范围投影）
 * @returns {*} 组值；不在任何组 / 字段没聚合器 / 组头不在（悬空指针）→ `undefined`
 */
export function groupValueOnDemand(state, node, field, readOf) {
    if (!node || !hasGroupAgg(field) || typeof readOf !== 'function') return undefined;
    if (GROUP_FIELDS.includes(field)) return undefined;   // 物化里有的字段走物化那条（别绕）
    const key = isSynthesis(node) ? synthKeyOf(node) : ownerSynthOf(node);
    if (!key) return undefined;                          // 不在任何组里
    // ⚠️ 这里**每个节点**都会被调（走「组那份」显示时）⇒ 必须用记忆化版：
    //    原始 `synthIndex(state)` 是一趟全表（真包 27k ~9ms/次）⇒ 逐节点调 = O(N²)。
    const idx = synthIndexOf(state);
    const headId = idx.byKey.get(key);
    if (!headId) return undefined;                       // 悬空指针：没有组头就没有"组那份"
    return groupAggregateOf(state, {
        headId, memberIds: idx.members.get(key) || [], field, readOf
    });
}

// ================================================================
// ① 成员（映射列表）顺序：树序，**不含合成节点自己**
// ================================================================

/**
 * 组内有序成员表（**合成节点自己不在里面**）。
 *
 * 名单直接取 `core/ops/synth.js` 的 `synthMembersTable(state)`（一趟建表、**树序**），
 * 再按 `headId` 滤掉合成节点自己 —— 满足"合成节点不被排进成员列表的第 0 位"。
 *
 * ⚠️ 为什么要"树序"：组内名单必须是确定的、与树一致（界面/测试都按它读）。
 *    `synthIndex.members` 的顺序是 `Object.keys(nodes)` 的**插入序**，**不是树序**
 *    （`synthIndex` 的注释已写明）；真按树序的是 `synthMembersTable` / `synthMembers`。
 *
 * @returns {Map<string, string[]>} `synthKey` → 有序成员 id 列表（**只有原料**）
 */
export function groupMemberOrder(state) {
    const index = synthIndexOf(state);
    // ⚠️ 成员表**每次现算**（不缓存）：它依赖**树序**，而"就地换掉
    //    `childOrder[某父]` 那个数组"不会换 `childOrder` 对象本身
    //    （`src/test/groupValue.test.js` 的"成员顺序起作用"就是测这个）。
    const table = synthMembersTable(state);
    const out = new Map();
    for (const key of index.members.keys()) {
        out.set(key, memberIdsOf(table, key, index.byKey.get(key)));
    }
    return out;
}

/** 有没有任何合成节点（没有 ⇒ 三趟退化为"什么都不做"，这是回归锚的保证） */
export function hasSynthesisNodes(state) {
    const nodes = (state && state.nodes) || {};
    for (const id of Object.keys(nodes)) {
        if (isSynthesis(nodes[id])) return true;
    }
    return false;
}

/** 一个节点属于哪一组（合成节点看自己的 `synthKey`，原料看 `ownerSynth`；空 = 单元素组） */
function groupKeyOfNode(node, index) {
    if (!node) return '';
    if (isSynthesis(node)) return synthKeyOf(node);
    const owner = ownerSynthOf(node);
    return (owner && index.byKey.has(owner)) ? owner : '';
}

// ================================================================
// ② 每层三趟
// ================================================================

/**
 * 对**一个类型层**跑三趟：`原料（A） → 合成（B + merge） → 原料（倒推覆盖）`。
 *
 * 第 1 趟（原料）：把本层每个节点的 **A** 取出来 —— 这是扩展点
 *   （默认取缓存字段；调用方可以给"按范围/按层算"的读取器，见 `groupCompute.js`）。
 * 第 2 趟（合成）：对每个组算 `merge(A, B)` —— A 是合成头**自己那份**（树内），
 *   B 是**映射列表**（成员原料各自那份）按该字段聚合器的折叠；
 *   `status2` 的"A 为忽略 ⇒ 保持忽略"在 `mergeField` 里，**不需要事后修正**。
 * 第 3 趟（倒推覆盖）：把组值给该组的**头与成员**，写进 `working`（**不是**节点对象！）
 *   —— 于是"上一层读它时拿到的是组值"。不在任何组里的本层节点 = 单元素组，组值 ≡ A。
 *
 * @param {Object} state - `{ nodes, parentOf, childOrder, settings }`（**只读**）
 * @param {Object} opts
 * @param {'R'|'P'|'C'} opts.type      这一层的节点类型
 * @param {Map<string,Object>} [opts.working] 已有的覆盖表（会被原地补充，边跑边传给上一层）
 * @param {Function} [opts.baseOf] `(node, field) => 值` —— 本层 **A** 的取值器
 * @param {string} [opts.scopeRoot] 只算这棵子树（省 = 整棵树；组值本来是全局的，一般别给）
 * @param {Function} [opts.typeOf]  节点类型取值器（省 = `n.type`）
 * @param {boolean} [opts.hasSynthesis] 调用方预先算好的"树里有没有合成节点"
 * @returns {{ layer:'R'|'P'|'C', groups:number, values:Map<string,Object> }}
 *           `values` 是**本层**每个节点的组值（`nodeId → { 字段: 值 }`），只读副本。
 */
export function computeLayerGroups(state, opts = {}) {
    const nodes = (state && state.nodes) || {};
    const typeOf = opts.typeOf || (n => (n && n.type) || '');
    const baseOf = opts.baseOf || ((node, field) => node && node[field]);
    const type = opts.type || '';
    const working = opts.working || new Map();

    const values = new Map();
    // 分相计时（诊断用）：A 原料 / B 合成（组值）/ C 倒推覆盖 各多少
    const tA0 = Date.now();
    let tA1 = 0;
    let tB1 = 0;
    const done = (groups) => ({ layer: type, groups, values, timings: { own: tA1 ? tA1 - tA0 : 0, group: tB1 ? tB1 - tA1 : 0, back: tB1 ? Date.now() - tB1 : 0 } });
    if (!GROUP_LEVELS.includes(type)) return done(0);
    // **只有 C/P 参与 status1/status2 的聚合**（R 不参与）。
    // R 层因此不产生组值 —— 组结构在 `groupCount` 里照样成立，只是不叠 status 字段。
    if (!participatesInGroupAgg(type)) return done(0);

    // ---- 第 1 趟（原料）：A = 树内计算（只看子树）----
    const own = new Map();
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        if (!node || typeOf(node) !== type) continue;
        const row = {};
        for (const field of GROUP_FIELDS) {
            const v = baseOf(node, field);              // A：本层派生表给的那份
            if (v !== undefined) row[field] = v;        // 没值的字段不记（免得把 undefined 喂进聚合）
        }
        own.set(id, row);
    }
    if (!own.size) return done(0);
    tA1 = Date.now();                            // A（原料）这一相到此

    // ⚠️ **没有合成节点时三趟必须什么都不做**（回归锚：中间态不破坏现状）。
    //    没有组可合 ⇒ 组值 ≡ A ⇒ 不倒推、不产生覆盖表。
    const hasSynthesis = (opts.hasSynthesis !== undefined)
        ? !!opts.hasSynthesis
        : hasSynthesisNodes(state);
    if (!hasSynthesis) return done(0);

    // ---- 第 2 趟（合成）：B = 映射列表聚合；A 与 B 在 merge 相遇 ----
    const readOwn = {};
    const agg = {};
    for (const field of GROUP_FIELDS) {
        // ⚠️ 第 1 趟算出来的 A 才是聚合的输入；取不到时退回覆盖表 / 缓存
        //    （只有"不在本层的成员"会走到那两条兜底）。
        readOwn[field] = (n) => {
            const row = own.get(n.id);
            if (row) return row[field];
            const w = working.get(n.id);
            if (w && w[field] !== undefined) return w[field];
            return baseOf(n, field);
        };
        agg[field] = AGG_BUILDERS[field](typeOf, readOwn[field], state);
    }

    const index = synthIndexOf(state);                // 一趟全表（记忆化：三趟各调一次）
    const membersOf = synthMembersTable(state);       // 一趟建表：合成标识 → 成员（树序）

    // 每组的组值（A ⊕ B）。**名字的顺序在这里完全不参与** —— 名单只决定 B 的输入集合。
    const groupValueOfKey = new Map();
    for (const [key, headId] of index.byKey) {
        const head = nodes[headId];
        if (!head) continue;
        const memberIds = memberIdsOf(membersOf, key, headId);   // ⑤ 头不在名单里
        const row = {};
        for (const field of GROUP_FIELDS) {
            const v = mergeField(field, agg[field], typeOf, head, memberIds, nodes, readOwn[field]);
            // ⚠️ `null` **不入表**：它是 `makeStatus2Agg` 的"空"（A/B 都没有值）。
            //    入了表，"组那份"就会对一个本来没值的字段返回 `null`，把"退回自己那份"
            //    的兜底路径堵死。
            if (v !== null && v !== undefined) row[field] = v;
        }
        if (Object.keys(row).length) groupValueOfKey.set(key, row);
    }
    tB1 = Date.now();                            // B（合成/组值）这一相到此

    // ---- 第 3 趟（原料·倒推覆盖）：组值 → 头与成员；其余节点 = 单元素组 ----
    for (const id of own.keys()) {
        const node = nodes[id];
        const key = groupKeyOfNode(node, index);
        const grouped = key ? groupValueOfKey.get(key) : null;
        if (grouped) { values.set(id, { ...grouped }); continue; }
        // 单元素组：没有映射列表 ⇒ 组值 ≡ A（`status2` 的"A 为忽略 ⇒ 忽略"照样生效）
        const solo = {};
        for (const field of GROUP_FIELDS) {
            const v = mergeField(field, agg[field], typeOf, node, [], nodes, readOwn[field]);
            if (v !== null && v !== undefined) solo[field] = v;
        }
        if (Object.keys(solo).length) values.set(id, solo);
    }
    for (const [id, row] of values) {
        const cur = working.get(id) || {};
        working.set(id, { ...cur, ...row });
    }

    return done(index.byKey.size);
}

/**
 * 一层的入口（**层间顺序由调用方控制**）。
 *
 * ⚠️ 它只跑 `opts.type` **这一层** —— 层间顺序 `R → P → C` 由调用方
 *    （`core/groupCompute.js`）负责：上一层算完的倒推覆盖必须传进下一层的 `baseOf`，
 *    所以"一次跑完三层"在这里做不到（本模块是纯算法，不认识派生表）。
 *
 * @param {Object} state
 * @param {Object} [opts]
 * @param {'R'|'P'|'C'} [opts.type] 这一层的节点类型（省 = `'R'`）
 * @param {Function} [opts.baseOf] `(node, field) => 值`；省 = 缓存字段。
 * @returns {{ working:Map<string,Object>, layers:Array, hasSynthesis:boolean }}
 *   `working` = **倒推覆盖表**（`nodeId → { status1?, status2? }`），`layers` 恒为一项。
 *   ⚠️ 它**不是**节点字段：调用方拿它去读，**绝不能**写回 `node` / 来源层。
 */
export function runGroupPasses(state, opts = {}) {
    const hasSynthesis = (opts.hasSynthesis !== undefined)
        ? !!opts.hasSynthesis
        : hasSynthesisNodes(state);
    if (!hasSynthesis) {                       // 回归锚：没有合成节点 ⇒ 什么都不做
        return { working: new Map(), layers: [], hasSynthesis: false };
    }
    const type = opts.type || GROUP_LEVELS[0];
    const working = opts.working || new Map();
    const layer = computeLayerGroups(state, { ...opts, type, working, hasSynthesis });
    return { working, layers: [layer], hasSynthesis: true };
}

// ================================================================
// ③ 组顺序（给界面/测试看"这一组都有谁、谁优先"）
// ================================================================

/**
 * 把组整理成"可读"的形状（**派生视图**，不改任何输入）。
 *
 * ⚠️ `order` 是**映射列表**（成员，树序）—— 合成节点**不在里面**（见文件头 ⑤）；
 *    要看合成头请读 `synthId`（从 `synthIndex.byKey` 取）。
 *
 * @returns {Array<{ key:string, synthId:string, order:string[], values:Object }>}
 */
export function describeGroups(state, type = '') {
    const nodes = (state && state.nodes) || {};
    const index = synthIndexOf(state);
    const order = groupMemberOrder(state);
    const out = [];
    for (const [key, ids] of order) {
        const synthId = index.byKey.get(key) || '';
        const synth = nodes[synthId];
        if (type && (!synth || synth.type !== type)) continue;
        out.push({ key, synthId, order: ids.slice(), values: {} });
    }
    return out;
}

/** 允许合成的类型（转出去，免得调用方再 import 一份） */
export const ALLOWED_SYNTH_TYPES = SYNTH_TYPES;
