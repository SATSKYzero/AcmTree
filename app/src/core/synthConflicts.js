// ================================================================
// 「合成归属」的**冲突/待办**（core/synthConflicts.js）
//
// 做法：**应用实时算**，单开一栏 ⑤ 冲突。
// 判据**完全共用**产包侧那份（`core/synthPlan.js` 的算键 + `core/natureConfidence.js` 的级别）
// —— 绝不在这里另写一套（否则脚本说 2 处、界面说 3 处，谁都不可信）。
//
// 报出来的几样（每一档的"要不要进 tab 数字"都是单独定的，见下面 `summary.alarms`）：
//   · 前五档（年份冲突 / 低可信差异 / 算不出 / 该换键 / 注册表排除）与
//     `scripts/synth-bind.mjs` 的**构建日志同口径**（那日志要重建才更新，这一份随树实时变）；
//   · **最后两档只有应用侧有**（`unroundedPre` / `orphanP`）—— 构建日志里没有对应档，
//     它们报的是"机器分不开 / 父链连不上"，产包脚本那一步压根不判这两件事，别去那边找。
//   ① `yearConflicts` —— **赛季一致、年份不一致**，且两边都是 **M/A/B 高可信**的值（**报警**）；
//   ② `yearLow`       —— 高可信 vs **低可信但确实报了个年份**（C 级赛名年份…）⇒ 不算警报，只记账；
//   ③ `noKey`         —— 国内范围内**算不出键**的（缺地点 / 缺类型）⇒ 只能留给人；
//                        ⚠️ **灰值（`上游异常` / `…/无归类`）不进这一样** —— 那是结论、不是欠账，
//                        本来就没有"补"这回事（要补的是蓝的 `未归类`）；
//   ④ `drift`         —— 已经绑着**脚本格式**的键、但按现在的 nature 该是**另一个**键
//                        （脚本对这类**一个字不动**，只报出来请人核）。
//   ⑤ `noSynth`       —— **注册表（`acm-data/synth-registry.json`）排除的**：这些节点本来就
//                        不该算合成键（"引入『有些节点不该算合成键』的逻辑与注册表"）
//                        ⇒ 不算"算不出"，单独**只记账**（`noSynthMissing` 是"注册表点名了、树里没有"）。
//   ⑩ `unroundedPre`  —— **没序号可区分的网络赛**：**同一个渠道**在一个**无序号**网络赛组里
//                        给了 ≥2 条**参数完全相同**的比赛 ⇒ 这个键下可能挤了两场（序号读不出来
//                        时**不猜**，所以只能报给人）。**只记账**；**不同渠道之间不算异常**
//                        （同一场在多棵树里各来一条本来就是常态）。
//   ⑪ `orphanP`       —— **题（P）找不到它的场次**：父标识读不出、或树上根本没有那个 C
//                        ⇒ 那些题**一条都绑不上**（P 层是按父标识找父的）⇒ 单独记一行。
//   （⑥…⑨ 是别的几档，正文里按它们在文件里的顺序编号：⑥splits ⑦题目绑定 ⑧旧组头 ⑨组头待同步）
// ⚠️ 全部**只读**：这一栏不写任何东西（要改去 ③ / 节点编辑）。
// ================================================================
import { isNotApplicableValue, isRealYear } from './natureFields.js';
import { classRuleOf, isHighLevel, isHumanBoundOwner, levelOfClassRule, pickGroupNature } from './natureConfidence.js';
import { KEY_PREFIX, PROBLEM_KEY_RE, bareClass, extTreeOf, groupFacetsOf, isOldKey, isScriptKey, isScriptKeyOrOld,
    isUnroundedOnlineKey, planKeyOf, planKeyProblem, problemBindPlan, realPlace, sameNatureValue,
    suspectSplitPairs } from './synthPlan.js';
// ★ 「哪些节点**不该**算合成键」的注册表（"引入…的逻辑与注册表"）——
//   命中它的节点不算"算不出"（那是**结论**，不是欠账），单独记一行（`noSynth`）。
import { missingSynthRules, noSynthRuleOf, problemIdMapOf } from './synthRegistry.js';
// 「谁是组头、谁算成员」**只有一处**（这一栏以前自己也建一张表 —— 全仓五份、取舍还不一致）
import { synthIndex } from './ops/synth.js';
import { OWNER_FIELD } from './ops/synth.js';

/** 节点身份：合成节点看 `synthKey`、原料看 `extKey`（与产包侧 `keyOf` 同一口径） */
const keyOf = (n) => (n && (n.synthKey || n.extKey)) || '';

/**
 * 把应用侧的 `state.nodes` 折成 `problemBindPlan()` 认的 **crate 形状**（只它要用的那几格）。
 *
 * ⚠️ 为什么需要这一层：P 层那套判据（`synthPlan.problemBindPlan`）是给**产包脚本**写的，
 *    读的是 `节点类型` / `父extKey`；应用侧是 `type` / `parent`（**节点 id**）⇒ 形状不同。
 *    这里只做换算，**判据一个字不重写**（"一份判据、两个消费者"）。
 *
 * @returns {{records: Array, orphans: Array}} `orphans` = **父链连不上**的那几条 P：
 *   它们进不了下一步（那一步按 `父extKey` 找场次的成员），于是**一条都不绑、也不报**
 *   —— 以前这里是 `continue` 了事（"静默丢一条判据比判错更糟"）。
 */
//: 「节点表 → crate records」的唯一一份（`problemBindPlan` 认这个形状）。
//: 导出只为**诊断/对拍**（`perf-bench.mjs` 要单独给 `problemBindPlan` 计时）；应用代码走 `synthConflicts`。
export function asCrateRecords(nodes, parentOf) {
    const list = Object.values(nodes || {}).filter((n) => n && typeof n === 'object');
    // ⚠️ **不要依赖 `extKey` 一定在顶层**：应用侧那颗树里，成员的 `extKey` 可能读不到
    //    （实测踩到：⑤ 里别的栏都正常，只有这一栏空 —— 因为 P 的父链一条都没连上）。
    //    办法：父子两边用**同一个稳定标识** —— 有 `extKey` 就用它，没有就退回**节点 id**；
    //    只要两边取法一致，链就必然连得上（产包侧本来就有 `extKey`，行为不变）。
    const idOf = (n) => String((n && n.extKey) || (n && n.id) || '');
    const idOfNode = new Map();
    for (const n of list) if (n.id) idOfNode.set(String(n.id), idOf(n));
    // ⚠️ 父关系**两种来源**（不是三种：全仓没有任何地方给节点写 `.parent`，
    //    应用侧的真源是 `parentOf`，包/crate 记录上是 `父extKey` —— 别再把 `.parent` 加回来，
    //    那会变成一条永远走不到、却看着像"支持三种写法"的死分支）：
    const po = (parentOf && parentOf.parentOf) || parentOf || null;
    //: 一条 P 的**父节点标识** —— 两种来源取同一个稳定标识（**只有这一处**）
    const parentKeyOf = (n) => {
        const raw = String(n['父extKey'] || '').trim()
            || String((po && n.id ? po[n.id] : '') || '').trim();
        return idOfNode.get(raw) || raw;
    };
    const out = [];
    const orphans = [];                // 父链连不上的 P（下一步一条都不绑 ⇒ 必须报出来）
    for (const n of list) {
        const t = String(n.type || '');
        if (t === 'C') {
            const r = { 节点类型: 'C' };
            if (n.synthKey) r.synthKey = String(n.synthKey);
            if (n.extKey || n.id) r.extKey = idOf(n);
            if (n.ownerSynth) r.ownerSynth = String(n.ownerSynth);
            // ⚠️ `分类依据` 必须带上：**"人确认过"那条痕迹就在它里面**（`ownerSynth = manual:set`）
            //    —— 漏了它 ⇒ 确认过的组还会继续报（点完不消失，实测踩到）。
            if (n['分类依据']) r['分类依据'] = n['分类依据'];
            if (r.synthKey || r.extKey) out.push(r);
        } else if (t === 'P') {
            const pid = parentKeyOf(n);
            if (!idOf(n) || !pid) {
                // 两种起因分开记（界面上要说清是"没写父"还是"这条题连标识都没有"）
                orphans.push({ id: String(n.id || ''), key: idOf(n), name: String(n.name || ''),
                    problemId: String(n.problemId || ''), parent: pid,
                    why: idOf(n) ? 'no-parent' : 'no-key' });
                continue;
            }
            out.push({ 节点类型: 'P', extKey: idOf(n), problemId: n.problemId,
                name: n.name, 父extKey: pid });
            if (n['分类依据']) out[out.length - 1]['分类依据'] = n['分类依据'];
            if (n.ownerSynth) out[out.length - 1].ownerSynth = String(n.ownerSynth);
            // ★ **题目组头**（有合成键的那些）也要带上自己的身份与那格 `已确认`：
            //   `problemBindPlan` 按它判"人确认过这一组 ⇒ 不再报"（`confirmedByHead`）。
            //   漏了这两格，应用侧就只剩"成员那套 manual:set"这一条兜底判据 ——
            //   而**刚从包里导进来的树根本没有它**（导入不写 manual）⇒ 人确认过的组
            //   会重新冒出来当待判（判据见 `core/synthPlan.problemBindPlan` 的 `confirmedByHead`）。
            if (n.synthKey) out[out.length - 1].synthKey = String(n.synthKey);
            if (n['已确认'] !== undefined) out[out.length - 1]['已确认'] = n['已确认'];
        }
    }
    // ⚠️ **第二类**：父标识有，但**树上根本没有那个节点**（父被删了 / 指针写错）——
    //    它同样进不了下一步（那一步在"场次的成员"里找父），也是**一条都不绑、也不报**。
    //    判据：父标识不在**本表认得的 C** 里（合成 C 头也算 —— 它们的标识就是 `idOf`）。
    const cKeys = new Set(out.filter((r) => r.节点类型 === 'C').map((r) => r.extKey));
    for (const r of out) {
        if (r.节点类型 !== 'P' || cKeys.has(r.父extKey)) continue;
        orphans.push({ id: '', key: r.extKey, name: String(r.name || ''),
            problemId: String(r.problemId || ''), parent: r.父extKey, why: 'dangling' });
    }
    orphans.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    return { records: out, orphans };
}

/**
 * 一个节点的年份**依据级别**（`M`/`A`…/`E`；没有依据 ⇒ `''`）。
 * ⚠️ 与界面上的徽标同一处读法（`natureNav` 用 `classRuleOf(node, field)` + `levelOfClassRule`）。
 */
function yearLevel(node) {
    const rule = classRuleOf(node, 'natureYear');
    return rule ? levelOfClassRule(rule) : '';
}

/**
 * 一个**成员**（有 C 身份、自己不是组节点）该进哪一栏 —— **判据只有这一处，顺序就是口径**。
 *
 * 为什么抽成纯函数：这四步散在 `synthConflicts` 的循环里、靠 `continue`
 * 串起来，"**哪一个先判**"就是策略本身：
 *   ① 注册表排除（"这场本来就不该合成"）**排在灰值之前** —— 排除是更明确的结论；
 *   ② 灰值（`上游异常` / `…/无归类`）是**结论**，不是欠账 ⇒ 不进"算不出"；
 *   ③ 有 owner 就不进"算不出"（它已经归入了）；
 *   ④ 只有**脚本格式**的 owner、且**不是人绑的**，才谈得上"该换键"。
 * 顺序一改，结论就变 —— 所以它得是一处看得见的东西，而不是散在流程里的四个 `continue`。
 *
 * @returns {{kind:'skip'|'noSynth'|'none'|'noKey'|'drift'|'driftHuman', node?:Object}}
 *   `skip` = 不是成员（非 C / 组节点 / 灰值）；`none` = 这一轮没事；
 *   `drift` = 脚本绑的键过时了；`driftHuman` = **人绑的**键过时了（同一件事，只是"谁绑的"不同）
 */
export function classifySynthMember(n) {
    // ⚠️ 类型那一格**两种形状都要认**：应用里是 `type`、包里（crate 记录）是 `节点类型`
    //    （实测踩到：只认 `节点类型` ⇒ 在应用里**一个节点都进不来**、这一栏空着）
    if (!n || typeof n !== 'object') return { kind: 'skip' };
    if (String(n['节点类型'] || n.type || '') !== 'C') return { kind: 'skip' };
    if (String(n.synthKey || '').trim()) return { kind: 'skip' };        // 组节点自己不做成员

    const owner = String(n.ownerSynth || '').trim();
    const cls = String(n.natureClass || '');

    // ① 注册表排除：这是**结论**（"这场本来就不该合成"）⇒ 单独记一行给页面显示
    const rule = noSynthRuleOf(n);
    if (rule) {
        return { kind: 'noSynth', node: { id: n.id, key: keyOf(n), name: String(n.name || ''),
            cls, layer: rule.layer, match: rule.match, why: rule.why } };
    }
    // ② 灰值不算"算不出"：`上游异常` / `…/无归类` 是结论（判不了 / 判过了、归不进去），
    //    不是"等人补"的欠账（否则 ⑤ 会叫你去补一个**根本补不出来**的格子）。蓝色 `未归类` 照旧留着。
    if (isNotApplicableValue('natureClass', cls.trim())) return { kind: 'skip' };
    // ③ 还没归入、且算得出为什么算不出 ⇒ "算不出"
    const why = planKeyProblem(n);
    if (why && !owner) {
        return { kind: 'noKey', node: { id: n.id, key: keyOf(n), name: String(n.name || ''), cls, why } };
    }
    // ④ 已绑、绑的是**脚本格式**的键、按现在 nature 该是别的键 ⇒ "该换键"。
    //    两类**只差"谁绑的"**，所以判据合成一块，只在归类时分叉（抄成两块迟早分叉：
    //    改了一处忘另一处 —— 实测就是这样漏掉"人绑的那一档"的）：
    //      · 脚本绑的（④）  —— 脚本**一个字不动**，只报出来提醒；
    //      · **人绑的**（④b）—— 脚本不碰人的结论，可**重出包时组头会按"人后来补全的性质"
    //        改名 / 另建一个**（`synth-bind` 会新建组、把旧清单键换成新键）⇒ 那个人绑的旧键
    //        就**在包里找不到**了，而**树上一切正常**（旧头还在、成员还指着它）⇒
    //        应用里一格警报都不报，直到包里的 baseline 核对说"这几个 identity 不在包里"。
    //        所以人绑的那一档要**单独报、并给人一键改到新键**。
    if (owner && isScriptKey(owner)) {
        const got = planKeyOf(n);
        if (got && got.key !== owner) {
            const node = { id: n.id, node: keyOf(n), cur: owner, want: got.key, cls };
            return { kind: isHumanBoundOwner(n) ? 'driftHuman' : 'drift', node };
        }
    }
    return { kind: 'none' };
}

/**
 * 一棵子树里有几个节点（**含根**；`nodes` 按 id 索引、`poMap` 是 `id → 父id`）。
 *
 * 用途：报"收掉这个 C 会连带收掉多少子孙" —— 人按下那个按钮之前要知道代价。
 * ⚠️ 只走 `poMap`（应用侧的真源）；拿不到父子链（夹具 / 包里没传）⇒ 返回 1（只算它自己）。
 */
function countSubtree(nodes, poMap, rootId) {
    const seen = new Set();
    const stack = [rootId];
    while (stack.length) {
        const cur = stack.pop();
        if (!cur || seen.has(cur) || !nodes || !nodes[cur]) continue;
        seen.add(cur);
        for (const [id, p] of Object.entries(poMap || {})) {
            if (String(p) === cur) stack.push(id);
        }
    }
    return seen.size || 1;
}

/**
 * 扫一遍当前的树，给出上面那几样（年份警报 / 低可信差异 / 算不出 / 该换键 / 同组不一致 /
 * **注册表排除** / **无序号网络赛** / **找不到场次的题** / **同场被拆成两个 C**）。
 *
 * @param {Object} nodes - `state.nodes`（`{id: node}`）
 * @param {Object} [parentOf] - `state.parentOf`（父子链的**真源**；应用侧要传）
 * @returns {{yearConflicts:Array, yearLow:Array, noKey:Array, drift:Array, driftHuman:Array,
 *            noSynth:Array, noSynthMissing:Array, groupConflicts:Array, suspectSplits:Array,
 *            staleHeads:Array, humanEmptyHeads:Array, headNatureDrift:Array, unroundedPre:Array,
 *            orphanP:Array, legacyTwins:Array, problemBind:Object, groups:number, summary:Object}}
 */
export function synthConflicts(nodes, parentOf = null, onPhase = null) {
    // ★ 可观测性（2026-10-18，**只给诊断用**）：`onPhase('段名')` 在每个大段收尾时被调一次；
    //   **不传就什么都不做**（判定逻辑一个字没动）。`perf-bench.mjs` 用它把那 359ms 拆开。
    const mark = onPhase ? (name) => { try { onPhase(name); } catch { /* 探针自己炸了不许影响正事 */ } } : null;
    const list = Object.values(nodes || {}).filter((n) => n && typeof n === 'object');

    // ---- 分组：`synthKey` 是组节点、`ownerSynth` 指回来（判定只有这一条，见 `core/dedup.js`）----
    // ---- 分组：**表只有一处**（`ops/synth.js` 的 `synthIndex`）----
    //   ⚠️ 以前这里自己建 `heads` / `members` 两张表，于是"谁是组头、谁算成员"全仓有**五份**
    //      实现，重复 `synthKey` 时取舍还不一致（这边"后出现者赢"、判重页"先出现者赢"），
    //      而且**只有 `synthIndex` 会报坏数据** —— 那正是最该报警的一类。
    //   ⚠️ 一个**语义差别**（刻意的）：`synthIndex.members` 只收**有头**的键
    //      ⇒ 悬空指针指向的那些"幽灵组"不再参与年份/分类冲突（它们不是组，真正的问题是
    //      那条悬空指针，已经单独报在「🧹 悬空成员指针」里）。以前那几组会在这里再造一批
    //      "同组不一致"，把人引到不存在的东西上。
    const idx = synthIndex({ nodes });
    // ⚠️ 用 **`nodes` 的键**索引（`synthIndex.byKey` 存的就是它），**不是 `node.id`** ——
    //    两者在应用里相同，但包里 / 测试夹具里未必（实测：夹具没有 `.id` ⇒ 查出一串 undefined）。
    const byId = new Map(Object.entries(nodes || {}));
    const heads = new Map();      // 键 → 组节点
    for (const [key, id] of idx.byKey) heads.set(key, byId.get(String(id)));
    const members = new Map();    // 键 → 成员节点[]
    for (const [key, ids] of idx.members) {
        members.set(key, ids.map((id) => byId.get(String(id))).filter(Boolean));
    }

    const yearConflicts = [];
    if (mark) mark('index');
    const yearLow = [];
    const groupConflicts = [];
    for (const [key, mem] of members) {
        // ---- 年份：只看**成员**（组头那格是第一个成员的副本、它自己没有依据）----
        const high = new Map();       // 值 → 节点
        const low = new Map();        // 值 → 节点（空值不进：那是"还没填"，不是主张）
        for (const n of mem) {
            const v = String(n.natureYear === undefined || n.natureYear === null ? '' : n.natureYear).trim();
            if (!v) continue;
            // ★ "判定冲突时**自动忽略灰色项**（与自动忽略 C 即以下并行）"
            //   ⇒ 年份那几格"确定不用"的值（`待同步`/`不确定`/`无`）**不算主张**，直接跳过
            //   （它们与 xcpcio 的真日期"不一样"也不再互相打架 ⇒ 不用去动来源优先级）。
            if (isNotApplicableValue('natureYear', v)) continue;
            const bucket = isRealYear(v) && isHighLevel(yearLevel(n)) ? high : low;
            if (!bucket.has(v)) bucket.set(v, []);
            bucket.get(v).push({ id: n.id, key: keyOf(n) });
        }
        if (high.size >= 2) {
            yearConflicts.push({
                key, head: heads.get(key) || null,
                high: [...high].map(([value, ids]) => ({ value, nodes: ids })).sort((a, b) => a.value.localeCompare(b.value)),
                low: [...low].map(([value, ids]) => ({ value, nodes: ids })).sort((a, b) => a.value.localeCompare(b.value))
            });
        } else if (high.size === 1 && [...low.keys()].some((v) => isRealYear(v) && !high.has(v))) {
            yearLow.push({
                key, head: heads.get(key) || null,
                high: [...high].map(([value, ids]) => ({ value, nodes: ids })),
                low: [...low].map(([value, ids]) => ({ value, nodes: ids })).sort((a, b) => a.value.localeCompare(b.value))
            });
        }

        // ---- 分类 / 地区：同组内不一致（分类只差镜像前缀不算；地区特殊值不算）----
        const clsSet = new Map();
        const regSet = new Map();
        for (const n of mem) {
            const cls = String(n.natureClass || '').trim();
            if (cls) {
                const bare = bareClass(cls);
                if (!clsSet.has(bare)) clsSet.set(bare, []);
                clsSet.get(bare).push({ id: n.id, key: keyOf(n) });
            }
            const reg = realPlace(n.natureRegion);
            if (reg) {
                if (!regSet.has(reg)) regSet.set(reg, []);
                regSet.get(reg).push({ id: n.id, key: keyOf(n) });
            }
        }
        if (clsSet.size > 1) groupConflicts.push({ key, field: 'natureClass', values: [...clsSet].map(([v, ids]) => ({ value: v, nodes: ids })) });
        if (regSet.size > 1) groupConflicts.push({ key, field: 'natureRegion', values: [...regSet].map(([v, ids]) => ({ value: v, nodes: ids })) });
    }

    if (mark) mark('yearGroup');
    // ---- 算不出键（国内范围内、还没归入的）+ 该换键（已绑但按现在 nature 该是别的键）----
    // 判据全在 `classifySynthMember` 里（"哪一个先判"就是口径，见它的注释）
    const noKey = [];
    const drift = [];
    const driftHuman = [];
    const noSynth = [];
    for (const n of list) {
        const v = classifySynthMember(n);
        if (v.kind === 'noSynth') noSynth.push(v.node);
        else if (v.kind === 'noKey') noKey.push(v.node);
        else if (v.kind === 'drift') drift.push(v.node);
        else if (v.kind === 'driftHuman') driftHuman.push(v.node);
    }
    yearConflicts.sort((a, b) => a.key.localeCompare(b.key));
    yearLow.sort((a, b) => a.key.localeCompare(b.key));
    noKey.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    drift.sort((a, b) => String(a.node).localeCompare(String(b.node)));
    driftHuman.sort((a, b) => String(a.node).localeCompare(String(b.node)));
    noSynth.sort((a, b) => String(a.key).localeCompare(String(b.key)));
    // 注册表里点名了、树里却没有的条目（写错 extKey / 那场没了 ⇒ 属"注册表与实际不符"）
    const noSynthMissing = missingSynthRules(list);

    // ---- ⑥ **疑似被拆开的组**：同赛季 + 同地点 + 同类型，**一边写了主办、一边没写** ----
    //   来由：省赛那一支正交化成 `<主办>/<类型>` 之后，主办是**从各来源自己的赛名**读的，
    //   而同一场在不同来源的名字里品牌词不一致（qoj 官方英文名写 `ICPC`、中文源一个品牌词都不写）
    //   ⇒ 同一场被算成两组。
    //   判据只有一份：`synthPlan.isSuspectSplit`（产包侧 `synth-bind.mjs` 读的是同一条）。
    //   ⚠️ **只记账、不进 `alarms`**（与 `noSynth` 同一档）：选的是
    //   "**不自动合、交给用户判断（是否合理）**" —— 人完全可能决定就这么留着；
    //   把它算进 tab 数字等于逼人去做一件他还没打算做的事（那正是"狼来了"）。
    const facets = [];
    for (const [key, head] of heads) {
        const mem = members.get(key) || [];
        // ⚠️ 带上 `headId` / `memberIds`：⑤ 那一栏要能**点进去**（否则报出来的是一串
        //    既跳不过去、又搜不到的文字 —— "现在根本无法筛选异常项"）。
        facets.push({
            ...groupFacetsOf(head, mem.length),
            headId: String(head.id || key),
            memberIds: mem.map((m) => String(m.id || m.extKey || '')).filter(Boolean)
        });
    }
    const suspectSplits = suspectSplitPairs(facets);
    if (mark) mark('facets/suspect');

    // ---- ⑦ **题目绑定（P 随 C）的异常**：题名冲突 / 全组无题名 / 题号对不上 ----
    //   判据与产包侧 `scripts/problem-bind.mjs` **同一份**（`synthPlan.problemBindPlan`），
    //   这里只把 `state.nodes` 折成它认的形状。"异常交给用户，且让用户方便改怎么绑"
    //   ⇒ 全量列出来、可点，不截断。
    //   ⚠️ **只记账、不进 `alarms`**（与 `noSynth` / `suspectSplits` 同一档）：它不阻塞任何东西，
    //   留着也是一种选择（那几组就先不绑）。
    const crate = asCrateRecords(nodes, parentOf);
    if (mark) mark('crate');
    // ⚠️ **手写题号映射（注册表 `problemIdMap`）必须一起传**：产包侧（`problem-bind.mjs`）
    //    传了它 ⇒ 不传的话两边会算出**两套座位**（应用说"它绑在 J"、包里绑在 C），
    //    正是那条老毛病"点一次换一次"的成因。
    const problemPlan = problemBindPlan(crate.records, problemIdMapOf);
    // ⚠️ 异常里带的是**标识**（`extKey` / 合成键），而"跳转"要的是**节点 id** ⇒ 这里换算一次，
    //    给每条挂上 `id`（合成节点：`key` 就是它的 id；成员：`ext` 是它的标识）。
    const idByKey = new Map();
    const idBySynth = new Map();
    for (const n of list) {
        const k = String((n && n.extKey) || (n && n.id) || '');
        if (k && n.id) idByKey.set(k, String(n.id));
        const sk = String((n && n.synthKey) || '');
        // ⚠️ **合成节点要用 `synthKey` 查**：它的节点 id **不等于**那个键（`idByKey` 是按 id 建的）
        //    —— 混用会让"点组键/点场次"原地不动（实测踩到：点第一个超链接不跳）。
        if (sk && n.id) idBySynth.set(sk, String(n.id));
    }
    if (mark) mark('heads');
    const problemBind = {
        ...problemPlan.anomalies,
        groups: problemPlan.stats.groups,
        boundP: problemPlan.stats.boundP
    };
    for (const x of problemBind.nameConflicts) {
        x.id = idBySynth.get(String(x.key)) || idByKey.get(String(x.key)) || '';
        x.cNodeId = idBySynth.get(`${KEY_PREFIX}${x.cId}`) || '';   // 场次那个合成节点的节点 id
        for (const c of x.list) c.id = idByKey.get(String(c.ext)) || '';
    }
    for (const x of problemBind.noName) {
        x.ids = (x.memberExts || []).map((e) => idByKey.get(String(e)) || '');
        // ★ 整组无题名的组**也会被建出来、也会绑** ⇒ ⑤ 里这条要能点、能确认：
        //   `id` = 组头那个 P 合成节点的**节点 id**（`key` 是合成键，不等于 id），
        //   `memberIds` = 真正绑上的那些成员的节点 id（「✓ 确认这一场」按它逐个打 `manual:set`）。
        x.id = idBySynth.get(String(x.key)) || '';
        x.memberIds = x.ids.filter(Boolean);
        x.cNodeId = idBySynth.get(`${KEY_PREFIX}${x.cId}`) || '';
    }
    for (const x of problemBind.noProblemId) x.id = idByKey.get(String(x.ext)) || '';
    // ★ 挂上**链接**（"提供各比赛的链接（+各题目的链接？）方便人工核对"）：
    //   · 成员的链接 = 那条 P 自己的 `link`（题面）；
    //   · 场次的链接 = 那个 C 合成节点 `链接分类` 里的第一条（榜单/题单入口）。
    const nodeByKey = new Map();
    for (const n of list) {
        const k = String((n && n.extKey) || (n && n.id) || '');
        if (k) nodeByKey.set(k, n);
    }
    const linkOf = (k) => String((nodeByKey.get(String(k)) || {}).link || '');
    const bagLinkOf = (n) => {
        const bag = (n || {})['链接分类'] || {};
        for (const arr of Object.values(bag)) {
            if (Array.isArray(arr) && arr.length && arr[0] && arr[0].v) return String(arr[0].v);
        }
        return String((n || {}).link || '');
    };
    const po = (parentOf && parentOf.parentOf) || parentOf || null;
    // ⚠️ **合成节点自己不带链接**（它是脚本造的）⇒ 场次链接要从**成员 C** 上取：
    //    成员的 P → 它的父节点（就是那个成员 C）→ `链接分类` 第一条。实测：只读合成节点 ⇒ 0/50。
    const contestLinkOf = (cId, memberExt) => {
        const direct = bagLinkOf(nodeByKey.get(`${KEY_PREFIX}${cId}`));
        if (direct) return direct;
        const pid = memberExt ? idByKey.get(String(memberExt)) : '';
        const parentId = (pid && po) ? String(po[pid] || '') : '';
        return bagLinkOf(nodeByKey.get(parentId));
    };
    for (const x of problemBind.nameConflicts) {
        x.link = contestLinkOf(x.cId, (x.list[0] || {}).ext);
        for (const c of x.list) c.link = linkOf(c.ext);
    }
    // ★ 每条冲突组带上**整组成员的节点 id**：⑤ 的「✓ 确认这一组」要一次确认**所有成员**
    //   （只确认起冲突的那几条不够 —— 其余成员也得打上"人确认过"，否则脚本下次还会重算）。
    for (const x of problemBind.nameConflicts) {
        const g = problemPlan.groups.find((y) => y.key === x.key);
        x.memberIds = g ? g.memberExts.map((e) => idByKey.get(String(e)) || '').filter(Boolean) : [];
    }
    // ★ **分类**（"冲突项太多了，该分类了"）：给每条冲突挂上"**这一场共几题、
    //   冲突几题**" ⇒ ⑤ 能按规模分档（**整场** / **部分** / **零散**），人按档批量处理，而不是一条条看。
    const perContest = new Map();
    for (const g of problemPlan.groups) {
        if (!perContest.has(g.cId)) perContest.set(g.cId, { tasks: 0, conflicts: 0 });
        perContest.get(g.cId).tasks++;
    }
    for (const x of problemBind.nameConflicts) {
        const c = perContest.get(x.cId);
        if (c) c.conflicts++;
    }
    for (const x of problemBind.nameConflicts) {
        const c = perContest.get(x.cId) || { tasks: 0, conflicts: 0 };
        x.cTasks = c.tasks;
        x.cConflicts = c.conflicts;
    }
    //: 每场一档：**整场**（冲突 ≥ 半数且 ≥3）/ **零散**（≤2）/ **部分**
    for (const x of problemBind.nameConflicts) {
        x.cScale = (x.cConflicts >= 3 && x.cConflicts * 2 >= Math.max(1, x.cTasks)) ? 'all'
            : (x.cConflicts <= 2 ? 'few' : 'part');
    }
    for (const x of problemBind.noName) {
        x.link = contestLinkOf(x.cId, (x.memberExts || [])[0]);
        x.links = (x.memberExts || []).map((e) => linkOf(e));
    }
    for (const x of problemBind.noProblemId) x.link = linkOf(x.ext);
    // 「同一来源多出一条」也要能点：`c.ext` 是那条 P 的标识 ⇒ 换成节点 id + 题面链接
    // ★ "前面的节点加超链接"：这一行的**前半段**也得能点进去 ——
    //   `cId` = 场次那个 C 合成节点，`problemId` 指的那一组 = P 合成节点（键就是 `x.key`）。
    for (const x of problemBind.sameSourceExtra || []) {
        for (const c of x.list) { c.id = idByKey.get(String(c.ext)) || ''; c.link = linkOf(c.ext); }
        x.cNodeId = idBySynth.get(`${KEY_PREFIX}${x.cId}`) || '';
        x.id = idBySynth.get(String(x.key)) || '';
    }
    // ★ **按题名对上的那些**（题号对不上 ⇒ 脚本拿"题名 → 题号"把某条对到了另一个题号）：
    //   **已经绑上了**，不是待办 —— 但"哪一条、从哪个题号对到哪个题号"**必须看得见**
    //   否则人没法审它（这一条以前只有数据、没有消费者：报出来等于没报）。
    //   两头的节点 id 都挂上（P 那条 + 场次那个合成节点）。
    for (const x of problemBind.namePaired || []) {
        x.id = idByKey.get(String(x.ext)) || '';
        x.link = linkOf(x.ext);
        x.cNodeId = idBySynth.get(`${KEY_PREFIX}${x.cId}`) || '';
    }

    // ---- ⑧ **旧组头**：没人指着它、且键是**脚本生成的** ⇒ 纯遗留，能安全收掉 ----
    //   为什么需要它：**信息补全会让组标识改名**（`synth:xcpc:年份未知provincial-山东`
    //   → `synth:xcpc:2019provincial-山东`）。成员被点到新头之后，**旧头就成了空组**，
    //   在树上还是一张"没有成员的比赛卡"（用户 2026-10-06："旧组头能不能直接判出来"）。
    //   判据（硬，不猜）：
    //     ① 它有 `synthKey`（它是组头）；
    //     ② **没有任何节点指着它**（`members` 里没这个键）；
    //     ③ 键是**本步/旧清单格式**（`isScriptKey` / `isOldKey`）—— **人手建的键不算**：
    //        "人刚建好、还没放成员"是常态（`scripts/synth-bind.mjs` 里同一条守卫）。
    //   ⚠️ 只收**没人指着**的；"有成员但键过时"归 ⑤ 的 `drift`（成员点「➡️ 改到该键」就对了，
    //      旧头随后自然会变成空组、再被这里收掉）。
    const staleHeads = [];
    const humanEmptyHeads = [];
    for (const [key, head] of heads) {
        if ((members.get(key) || []).length) continue;
        const item = {
            key, id: head.id, name: String(head.name || ''),
            cls: String(head.natureClass || '')
        };
        // 判据只有一处（`synthPlan.isScriptKeyOrOld`）—— 人手建的键不可能是那两个形状
        // （手输会被拒保留前缀；应用自动生成的是 `synth:<序号>`）⇒ 那种空组只报不动。
        if (isScriptKeyOrOld(key)) staleHeads.push(item);
        else humanEmptyHeads.push(item);                 // 人的键：只报，不动
    }

    // ---- ⑨ **组头待同步**：成员的 nature 已经比组头新，组头还停在旧值/占位 ----
    //   为什么单列：组头这四个字段是**派生量**（口径 = `pickGroupNature`），它落后就说明
    //   "成员填了、组头没跟" —— 存量数据里很常见（用户 2026-10-06："还有没同步的"）。
    //   一键对齐见 ⑤ 的「🔄 把组头按成员刷新」（`core/ops/synth.js` 的 `syncAllGroupNatures`）。
    const headNatureDrift = [];
    for (const [key, mem] of members) {
        const head = heads.get(key);
        if (!head || !mem.length) continue;
        const { values } = pickGroupNature(mem);
        const fields = [];
        for (const [f, v] of Object.entries(values)) {
            if (!v) continue;
            // ★ **没有"人改过组头就别报"这一档**（**故意没有**，别再加）：组头上的
            //   `manual:set` 既可能是"人直接改了组头那一格"，也可能是**成员**那格是人定的
            //   被 `pickGroupNature` **原样抄上来**的 —— 两者长得一样，拿它当判据会把
            //   派生自己锁死（实测：成员改一次之后组头永远停在旧值、这里也永远不报）。
            //   口径：组头那四格是按成员派生的；真·人改的组头值会被下一次对齐按成员重算。
            // ★ "算不算已经一致"走同一份判据（`sameNatureValue`：分类只差镜像前缀不算不同）
            //   —— 与「🔄 一键对齐」真正会改哪些格**逐条对齐**，不会出现"报了却改不动"。
            if (sameNatureValue(f, head, v)) continue;
            fields.push(f);
        }
        if (fields.length) {
            headNatureDrift.push({ id: head.id, key, name: String(head.name || ''), fields });
        }
    }

    // ---- ⑩ **没序号可区分的网络赛**（⚠️ **只记账**）----
    //   网络赛的键靠序号区分（`…ec_pre1` / `…ec_pre2`）；序号读不出来时**不猜**（`onlineRound`
    //   返回空串 ⇒ 键就是 `…ec_pre`）—— 这是**正常情形**（"单场无序号、2 场有序号"，实测
    //   6 个无序号网络赛组全是"同一场、多来源"），所以**绝不能**因此拒写键。
    //   但"这场其实是两场、两边都没序号"时就**真的分不开**了：它们会算出同一个键、并成一组。
    //   ⚠️ **口径**：只有**同一渠道**（同一棵来源树）给出**参数完全相同**的比赛（分类 / 赛季 /
    //   地区 / 序号一路算到**同一个键**）才算"无法区分"；**不同渠道**之间怎么对不上都
    //   **不算异常** —— 那正是合成组要干的事（同一场在多棵树里叫法不同、成员多几条都是常态）。
    //   判据（硬，不猜）：**同一棵树**在这个组里给了 **≥2 条** —— 一棵树对同一场只会给一条，
    //   两条就说明这个键下多半挤了两场（可能是 UC 镜像 + 官方身份那种，也得人看一眼）。
    //   ⚠️ **读不到 `extKey` 的成员不许静默跳过**（本文件上面自己就写着"成员的 extKey 可能读不到，
    //   实测踩到"）：它们**无法归到任何渠道**，但"两条都读不到"同样是**分不开** ⇒ 归到同一个
    //   桶里（`(无 extKey)`）一起报出来 —— 少报一条就是"两场并成一组且谁都看不见"。
    //   ⇒ 报出来让人自己判（给成员补序号 / 手工拆），**一个字不动**。
    const NO_TREE = '(无 extKey)';
    const unroundedPre = [];
    for (const [key, mem] of members) {
        if (!isUnroundedOnlineKey(key)) continue;
        const byTree = new Map();
        for (const m of mem) {
            const t = extTreeOf(m) || NO_TREE;
            if (!byTree.has(t)) byTree.set(t, []);
            byTree.get(t).push(m);
        }
        const dup = [...byTree].filter(([, nodesInTree]) => nodesInTree.length > 1);
        if (!dup.length) continue;
        const head = heads.get(key) || {};
        unroundedPre.push({
            key, name: String(head.name || ''),
            // ⚠️ 报出来就得能点进去（否则是一串既跳不过去、又搜不到的文字）
            headId: String(head.id || key),
            trees: dup.map(([tree, nodesInTree]) => ({
                tree,
                nodes: nodesInTree.map((m) => ({
                    id: String(m.id || ''), extKey: String(m.extKey || ''), name: String(m.name || '')
                }))
            }))
        });
    }
    unroundedPre.sort((a, b) => a.key.localeCompare(b.key));

    // ---- ⑪ **题（P）找不到它的场次**（⚠️ **只记账**，但不许静默）----
    //   来由：P 层那一步（`problemBindPlan`）是**按父标识在"场次的成员"里找父**的 ⇒
    //   父标识读不出、或树上根本没那个 C 的 P，**一条都不绑、也不报**（以前这里就是一个 `continue`）。
    //   "静默丢一条判据比判错更糟" ⇒ 单独记一行，给出这条 P 与它写的那个父，让人去改。
    const orphanP = crate.orphans.map((o) => ({
        ...o,
        // ⚠️ 报出来就得能点进去（`key` 是标识，跳转要的是节点 id）
        id: String(o.id || idByKey.get(String(o.key)) || '')
    }));

    // ---- ⑫ **同一个场次在树上被拆成两个 C**（一个键是另一个的键 + **旧写法**的尾巴）----
    //   来由：包那边的 QOJ 场次键**只可能是两种**：基键 `qoj:c:<id>`（XCPC 读法）与
    //   `qoj:c:<id>:ucup`（UC 读法，**2026-10-07 起是正规的第二份**：两种读法两个节点、
    //   互不绑定与干扰）。**旧写法 `:xcpc` 那个尾巴已废、包里不再产出** —— 而**树上遗留的那批**
    //   （连同它们的题单）包里已经没有对应记录了，导入又**只加/改、从不删**
    //   ⇒ 它们会一直挂着当重复子树。这里报出来 + 给一个"点一下收掉"的入口（⑤ 的「🧹 可清理」）。
    //   判据（**一条**，且**以树自己为准**）：C 的键去掉最后一段之后，树上**真有**那个键的节点，
    //   **且最后一段是旧写法 `:xcpc`**。
    //   ⚠️ `:ucup` 那份**不许报、更不许收** —— 那是正规的第二份（收掉它 = 把 UC 那个节点删了）。
    //   ⚠️ 与"键规范漂移"（`features/AutoImport/extkey.js` 只提示、不处理）不是一回事：这里要删。
    //   ⚠️ 前缀不在树上就不报（"宁可少报" —— 真源不在时删掉就是丢数据）。
    const keySet = new Set(Object.values(nodes || {})
        .map((n) => String((n && n.extKey) || '').trim())
        .filter(Boolean));
    const poMap = (parentOf && parentOf.parentOf) || parentOf || null;
    const legacyTwins = [];
    for (const n of list) {
        if (String(n.type || n['节点类型'] || '') !== 'C') continue;
        const key = String(n.extKey || '').trim();
        // ★ 只认**旧写法** `:xcpc`（见上：`:ucup` 现在是正规的第二份）
        if (!key.endsWith(':xcpc')) continue;
        const cut = key.lastIndexOf(':');
        if (cut <= 0) continue;
        const base = key.slice(0, cut);
        if (!keySet.has(base)) continue;
        const id = String(n.id || '');
        legacyTwins.push({ id, key, base, name: String(n.name || ''), subtree: countSubtree(nodes, poMap, id) });
    }
    legacyTwins.sort((a, b) => a.key.localeCompare(b.key));

    // ---- ⑬ **P 组键跟着 C 组过时了**（题目组没跟着场次的新键搬）----
    //   来由：场次（C 组）的键会因为"性质补全 / 改名"而变（实测：`…-东北` → `…-河北`），
    //   而**题目组的键里嵌着场次标识**（`synth:problem:<场次标识>-<题号>`）⇒ 一起过期。
    //   导入那边按 never 口径**不覆盖**已存在的成员指针（`features/AutoImport/plan/pointers.js`
    //   的"旧值不是死指针 ⇒ 拒绝"），于是它们会一直停在旧键上：C 组已经叫新名、题目组还叫旧名，
    //   两边都"存在"、界面上不报、导入也不管 ⇒ 只能人一条条手改。这一档把它们列出来 + 一键改到新键。
    //   判据**只有一份**：`problemPlan.groups`（与产包脚本同一个 `problemBindPlan`）——
    //   它算出的 `key` 就是"按现在的 C 键该用的那个键"，这里不重算。
    //   ⚠️ 旧头不在树上（`id` 为空）就不列：没有"改到新键"这个动作可做（那种是悬空，另有那一档）。
    const staleProblemKeys = [];
    {
        const byStale = new Map();
        for (const g of (problemPlan.groups || [])) {
            for (const ext of (g.memberExts || [])) {
                const nid = idByKey.get(String(ext));
                const node = nid ? nodes[nid] : null;
                const cur = String((node && node[OWNER_FIELD]) || '').trim();
                if (!cur || cur === g.key) continue;
                if (!PROBLEM_KEY_RE.test(cur)) continue;      // 只认题目组的键；别的指针另有归属
                if (!byStale.has(cur)) byStale.set(cur, { key: cur, want: g.key, memberIds: [] });
                byStale.get(cur).memberIds.push(nid);
            }
        }
        for (const it of [...byStale.values()].sort((a, b) => a.key.localeCompare(b.key))) {
            it.id = String(idBySynth.get(it.key) || '');
            it.count = it.memberIds.length;
            if (it.id) staleProblemKeys.push(it);
        }
    }

    if (mark) mark('problemBind');
    return {
        yearConflicts, yearLow, noKey, drift, driftHuman, groupConflicts, noSynth, noSynthMissing, suspectSplits,
        staleHeads, humanEmptyHeads, headNatureDrift, unroundedPre, orphanP, legacyTwins, staleProblemKeys,
        problemBind,
        groups: members.size,
        summary: {
            yearConflicts: yearConflicts.length,
            yearLow: yearLow.length,
            noKey: noKey.length,
            drift: drift.length,
            //: **人绑的键过时了**（`manual:set` + 按现值该是另一个键）—— 重出包会让它落空，
            //   所以算"要人动的事"；见 `classifySynthMember` 的 ④b
            driftHuman: driftHuman.length,
            groupConflicts: groupConflicts.length,
            //: 注册表排除的条数（**只记账**，不进 tab 数字：它不是"要人动的事"）
            noSynth: noSynth.length,
            noSynthMissing: noSynthMissing.length,
            //: 疑似被拆开的组**对数**（同样**只记账**：留着也是一种选择）
            suspectSplits: suspectSplits.length,
            //: **旧组头**（空组 + 脚本键 ⇒ 点一下就能收掉）；人的键那种只报不动
            staleHeads: staleHeads.length,
            humanEmptyHeads: humanEmptyHeads.length,
            //: **组头待同步**（成员的 nature 比组头新）—— ⑤ 里一个按钮对齐，不进 tab 数字
            headNatureDrift: headNatureDrift.length,
            //: **没序号可区分的网络赛**（同一棵树在一个无序号网络赛组里给了 ≥2 条）——
            //: 同样**只记账**："单场无序号"是常态，只有人才能判它是不是两场
            unroundedPre: unroundedPre.length,
            //: **题（P）找不到它的场次**（父标识读不出 / 树上没那个 C）—— 那些题**一条都绑不上**
            orphanP: orphanP.length,
            //: **同一场被拆成两个 C**（键是另一个的键 + 尾巴）⇒ 收掉带尾巴那个（连子树）
            legacyTwins: legacyTwins.length,
            //: **P 组键跟着 C 组过时了**（一键可改；见 ⑬ 的注释）
            staleProblemKeys: staleProblemKeys.length,
            //: 题目绑定异常的三类计数（同样**只记账**）
            problemNameConflicts: problemBind.nameConflicts.length,
            problemNoName: problemBind.noName.length,
            problemNoProblemId: problemBind.noProblemId.length,
            //: ⑤ 那一栏 tab 上的数字：**要人动的**那几样（年份警报 + 算不出 + 该换键 + 旧组头
            //: + **人绑的键过时了** + **同场被拆成两个 C**）——最后两项也算：
            //: 一个不修下次重出包手填就落空，另一个是树上明摆着的重复子树
            alarms: yearConflicts.length + noKey.length + drift.length + staleHeads.length
                + driftHuman.length + legacyTwins.length
        }
    };
}
