// ================================================================
// 按 nature 定合成归属（scripts/synth-bind.mjs）——「骨架 + 绑定」
//
// 口径（全文见 `docs/field-rules.md` §10）：
//   · "现有的 O 下 xcpc 树似乎是骨架，**重在绑定**"；
//   · "**不推谁绑定谁**，只推使用的 `ownerSynth`，让应该绑定的比赛间自动推出相同的 `ownerSynth`"；
//   · "**别用不稳定的方案**，不稳定的东西都最终由人决定"；
//   · "地点已经有了，**是 nature**，已经人工调整过"（⇒ 地点一律读 `natureRegion` 字段，不猜）；
//   · **键与显示名的称呼**（§10.5 有全表；省赛那一支**正交化成"3 类型轴 × 4 主办轴"**，
//       叫法就是这一套，不用 `IC邀请赛` / `CC邀请赛`）：
//
// 这一步做三件事（**只做国内**：`icpc/ec`、`ccpc`、`省赛与邀请赛`）：
//   ① 按上面的映射给每个 C 算 `(键, 显示名)`；算不出的（缺地点 / 5 类都不命中）⇒
//      **一个字不写**，报出来交给人；
//      ⚠️ **「缺网络赛序号」不算算不出**（曾经的声明是"缺序号**且**该赛季不止一场"，从没实现过，
//         也不该实现）：网络赛就"单场无序号、两场才有序号"两种常态，所以序号读不出来时**不猜、
//         照旧给键**（`token` 就是 `ec_pre`）。真出现了"两场都没序号"，它们会算出**同一个键**、
//         并成一组 —— 那种**无法区分**的情形由应用侧 ⑤ 报出来（`synthConflicts` 的 ⑩），
//         判据是"同一棵树在一个无序号网络赛组里给了 ≥2 条"（一棵树对同一场只会给一条）——
//         ⚠️ 只有**同一渠道、参数完全相同**才算，**不同渠道**之间怎么不一样都**不算异常**。
//   ② 铺容器（`xcpc` → `synth-<分支>[:<赛区>]` → `<赛季>`）与**组节点**（名字按上面的称呼）；
//   ③ 给成员写 `ownerSynth`；**旧格式**（`synth:xcpc:<slug>` 那种清单方案）
//      在国内范围内**被替换**掉，空掉的旧组**收掉**。
//
// ⚠️ **只改国内**：非国内（`icpc/eu·ap·na·la`、`ucup`…）这一步一个字节都不动
//    （"暂时只针对国内部分"）。它们**现在也不建组** —— 那些分支基本都是单来源
//    （清单里非国内从来出现过 ≥2 棵树出 C 的场次），老的清单 slug 方案（`nature_rules.py`）
//    已停用；真要给非国内建组，先定清楚"谁来判断同一场"，再在这条判据上开口子。
// ⚠️ 人在应用里绑的（键不是本步格式、也不是旧清单格式）一律不动。
//
// 用法：node scripts/synth-bind.mjs <包> [--dry-run] [--quiet]
// ================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mod = rel => `file://${path.join(ROOT, 'src', rel).replace(/\\/g, '/')}`;

// ⚠️ 地区词表**不在这里抄一份**：应用侧 `core/natureFields.js` 就是真源
//   （要判"这个值是不是'不是地名但合法'"就问它的 `isNotApplicableValue`）。
//   "是不是地点"的判据只有 `core/synthPlan.js` 的 `realPlace` 一份，本文件不另立一份。
const { isNotApplicableValue, isRealYear: isRealYearShared } = await import(mod('core/natureFields.js'));
// ⚠️ 「可信度级别」也不抄：`core/natureConfidence.js` 是唯一真源（同赛季不同年份
//    **只有高可信度冲突时**才报警 ⇒ 这里要用 `isHighLevel` 判 A/B 档）。
const { classRulesOf, levelOfClassRule, isHighLevel, isHumanBoundOwner,
    pickGroupNature, CLASS_RULE_COL } = await import(mod('core/natureConfidence.js'));

// ★ 算键规则（`KEY_PREFIX` / `planKeyOf` / `isDomestic` / `realPlace` / `PROVINCIAL_TYPES`…）
//   **住在 `src/core/synthPlan.js`** —— 应用侧「判重整理 → ⑤ 冲突」那一栏要**实时**
//   用同一套判据（年份冲突 / 算不出键 / 该换键），规则只能有一份。
//   ⚠️ 这里**原样 re-export**，本文件与冒烟测试的调用方式一个字不变。
import {
    CLASS_TOKENS, KEY_PREFIX, PROVINCIAL_ORGS, PROVINCIAL_TYPES, bareClass, groupFacetsOf, isDomestic,
    isOldKey, isScriptKey, onlineRound, planKeyOf, planKeyProblem, realPlace, sameNatureValue, suspectSplitPairs,
    xcpcTail,
} from '../src/core/synthPlan.js';
// ★ 「哪些节点**不该**算合成键」的注册表（"引入…的逻辑与注册表"；
//   两层叠加："节点级白名单 + 分类白名单"）。判据只有一份，住在 `src/core/synthRegistry.js`——
//   应用侧 ⑤（`core/synthConflicts.js`）读的是同一份，别在这里另判一套。
import { missingSynthRules, noSynthRuleOf } from '../src/core/synthRegistry.js';

export {
    CLASS_TOKENS, KEY_PREFIX, PROVINCIAL_ORGS, PROVINCIAL_TYPES, bareClass, groupFacetsOf, isDomestic,
    isOldKey, isScriptKey, onlineRound, planKeyOf, planKeyProblem, realPlace, sameNatureValue, suspectSplitPairs,
    xcpcTail,
};

/**
 * 真年份（`20xx`）—— **口径只有一处**：应用侧 `core/natureFields.js` 的 `isRealYear`。
 * `待同步` / `无` / 空 / **19xx** 都不算（年份判据只用唯一那份 `isRealYear`，
 * 自写正则会与它分叉：19xx 会被顶上组头、参与年份冲突分级）。
 */
export function realYear(v) {
    const t = String(v === undefined || v === null ? '' : v).trim();
    return isRealYearShared(t) ? t : '';
}

/**
 * 这个节点在树上的键（组头看 `synthKey`、原料看 `extKey`）
 *
 * ⚠️ 这里**原来还有一份 `levelRank` + `LEVEL_ORDER`**（已删）：它与应用侧
 * `core/natureConfidence.js` 的 `levelRank` **极性相反**（那边**小 = 硬**、这份**大 = 硬**），
 * 而全仓没有任何调用者 —— 留着就是等着哪天有人 `import` 它，"M 最硬"当场反掉。
 * 要级别序请用 `natureConfidence.levelRank`（唯一一份）。
 */
const keyOf = (r) => r.synthKey || r.extKey || '';
const ownerOf = (r) => String(r.ownerSynth || '').trim();

/**
 * 这个节点的**指针是人定的**吗？
 *
 * 判据 = 手改那条路留下的 `分类依据.ownerSynth = manual:set`（见 `core/ops/synth.js` 的
 * `applyOwnerSynth`；导入与脚本产的一律没有这一条）。命中的节点本步**一个字不动** ——
 * 与"注册表排除"不同的是：它仍然可以待在某个组里（人就是这么绑的），只是脚本不许改它。
 *
 * ⚠️ 判据**只有一处**：`src/core/natureConfidence.js` 的 `isHumanBoundOwner` ——
 *    应用侧 ⑤ 冲突栏读的是同一份（两边各判一套时，界面会叫人去改
 *    一个脚本本来就不碰的键）。
 */
export function isHumanBound(r) {
    return isHumanBoundOwner(r);
}

/**
 * 被注册表排除了的节点，它**现在那个指针**该怎么处理？
 *
 * @returns `'none'`（没被排除 / 本来就没指针）· `'script'`（我们格式 ⇒ **解绑**）·
 *          `'human'`（人绑的 ⇒ **一个字不动**，只报出来请人核）
 *
 * ⚠️ 单独一个纯函数是为了能直接测：这段判断住在"删除路径"上，**错一次就会删掉别人的决定**。
 */
export function unbindKindOf(node, rule) {
    if (!rule || !node) return 'none';
    const cur = ownerOf(node);
    if (!cur) return 'none';
    // ⚠️ **人绑的排在最前面**：判据是 `分类依据.ownerSynth = manual:set`，而不是键长什么样。
    //    只按 `isScriptKey(cur)` 分的话，"人手绑了一个**脚本格式**的键"（主循环 152-153 行
    //    明说这种事会发生）会被判成 `'script'` ⇒ 走到 `delete r.ownerSynth`，
    //    **把人的结论删掉** —— 而那正是本文件反复声明的"不许做"的事。
    //    （实测路径：注册表点名的场次 + 人在 ⑤ 把它归入某个现成的组 ⇒ 重跑一次本步就没了。）
    if (isHumanBoundOwner(node)) return 'human';
    return isScriptKey(cur) ? 'script' : 'human';
}

/**
 * 主流程：算键 → 铺容器/组 → 写指针 → **按注册表排除并解绑** → 收掉空掉的组/容器（**原地改** `doc.records`）。
 */
export function bindByNature(doc, dryRun = false) {
    const records = doc.records || [];
    const nodes = new Map(records.map((r) => [keyOf(r), r]));
    const out = { bound: 0, created: 0, containers: [], replaced: 0, dropped: [], noKey: [], conflicts: [], drift: [],
        yearConflicts: [], yearLow: [], noSynth: [], unbound: [], humanKeyed: [],
        droppedContainers: [], registryMissing: [], humanBound: [] };
    //: 组键 → 成员的年份（值 + 依据级别）—— 年份冲突**单独一遍算**（见下面那段注释）
    const yearRows = new Map();
    // ① 算键
    const plan = new Map();                     // node → {key,name,container,season}
    for (const r of records) {
        if (String(r['节点类型'] || '') !== 'C') continue;
        if (String(r.synthKey || '').trim()) continue;          // 组节点自己不做成员
        // ★★ **题目组的组头（`synth:problem:…`）也不做成员** —— 它是**题目层**的产物，
        //    归 `problem-bind` 那一步管（`P 随 C`）。漏了这一条会出大乱子（实测踩到）：
        //    P 组头也是 `C` 类型、也带 `synthKey`/`父synthKey`，
        //      · 它落在"比赛组"那一支里 ⇒ 这一步会**重新算一遍 P 的归属**，
        //        而且用的是 C 那一套规则（`planKeyOf` 按 nature 算），
        //        **把 `problem-bind` 刚定好的结果整个推翻**；
        //      · 两遍（这一步 / `problem-bind`）算出的答案不同 ⇒ 用户看到
        //        "点一次换一次、永远改不动"（那三行 `-C/-H/-K ↔ -D/-G/-J`）。
        //    判据：**有 `父synthKey` 的 P 都是题目组头**（`synth-bind` 建的比赛组头没有它）。
        if (String(r['节点类型'] || '') === 'P') continue;
        if (String(r['父synthKey'] || '').trim()) continue;
        // ★ 注册表排除：这场本来就不该合成 ⇒ **不算键、不绑组**（单独记一行）。
        const rule = noSynthRuleOf(r);
        if (rule) {
            out.noSynth.push({ key: keyOf(r), name: r.name || '', cls: r.natureClass,
                layer: rule.layer, match: rule.match });
            continue;
        }
        const got = planKeyOf(r);
        if (!got) {
            // ⚠️ **灰值不算"算不出"**：`上游异常` / `…/无归类` 是
            //    结论（"这一格判不了" / "判过了、这一支里没有它可归的一项"），不是等人补的欠账。
            //    ⚠️ 与 `src/core/synthConflicts.js`（应用侧 ⑤ 那一栏）**同一条口径**，判据就是
            //    那边的 `classifySynthMember`（"哪一个先判"就是口径）：
            //      · 灰值      ⇒ 不进"算不出"；
            //      · **已有归属** ⇒ 也不进（"它已经归入了"）：键算不出来这件事由 ③ 性质待补 管，
            //        ⑤ 这边再报一次就是**同一个数字两处不一致**（实测：已绑的节点被清掉
            //        `natureRegion` 后，这边说 1 条、⑤ 说 0 条）；
            //      · **人绑的**（`manual:set`）同样不报 —— 脚本不碰人的结论。
            //    蓝色 `未归类` 照旧留着。
            if (isDomestic(String(r.natureClass || ''))
                && !isNotApplicableValue('natureClass', String(r.natureClass || ''))
                && !isHumanBound(r)
                && !ownerOf(r)) {                    // ★ 已有归属 ⇒ 不算"算不出"（见上）
                out.noKey.push({ key: keyOf(r), name: r.name || '', cls: r.natureClass });
            }
            continue;
        }
        // ★ **人绑的指针一个字不动**。
        //   判据 = 手改那条路留下的 `分类依据.ownerSynth = manual:set`（`ops/synth.js`）——
        //   ⚠️ 不能只看键的格式：人手也能绑一个**脚本格式**的键（④/① 页挑一个现成的组），
        //   那种键会被这里当成"脚本产的"重新算、**悄悄搬走**。人绑就归人。
        if (isHumanBound(r)) {
            out.humanBound.push({ node: keyOf(r), cur: ownerOf(r), cls: String(r.natureClass || '') });
            continue;
        }
        plan.set(r, got);
    }
    // ①b **解绑**：
    //     被注册表排除、却已经绑着**脚本格式**键的节点 ⇒ 清掉指针（它变回"无归属"）。
    //     ⚠️ **人工绑的键（不是我们格式）一个字不动**，只报出来 —— 那是人的决定，
    //        与注册表打架时该由人看见并自己收敛，不该由脚本悄悄删。
    const unboundOwners = new Set();
    for (const r of records) {
        if (String(r['节点类型'] || '') !== 'C') continue;
        if (String(r.synthKey || '').trim()) continue;
        if (String(r['父synthKey'] || '').trim()) continue;      // 题目组的组头归 `problem-bind`（见 ①）
        const rule = noSynthRuleOf(r);
        if (!rule) continue;
        const kind = unbindKindOf(r, rule);
        if (kind === 'none') continue;
        const cur = ownerOf(r);
        if (kind === 'human') {
            out.humanKeyed.push({ node: keyOf(r), cur, cls: String(r.natureClass || '') });
            continue;
        }
        unboundOwners.add(cur);
        if (!dryRun) delete r.ownerSynth;
        out.unbound.push({ node: keyOf(r), cur });
    }
    // ② 组节点：按 (键, 名, 容器) 建需要的容器与组
    //
    // ★ **整条容器链由本步铺出来**：`xcpc`(W) → 分支 → （icpc 那一支还有 `ec` 段）→ 赛季。
    //   ⚠️ 以前这条链是 `nature_rules.py`（清单 slug 方案）**先铺好**的，本步只补缺的赛季层
    //      —— 那一步停用之后（理由见那个文件头）这里必须自己铺到顶，否则：
    //        · 顶层 W `xcpc` 不存在 ⇒ 整棵合成子树没有根（会散到树根下）；
    //        · `icpc` 那一支的中间层 `xcpc:s:synth-icpc` 没人建 ⇒ 它下面 16 个赛季层断链。
    //   键的形状**决定父子**（`…:synth-icpc:ec:2024` 的父是 `…:synth-icpc:ec`），
    //   名字 = 键的最后一段（`synth-` 去掉；`provincial&invitational` 那一段有中文叫法）。
    const XCPC_ROOT = 'xcpc';
    const CONTAINER_NAME = { 'synth-provincial&invitational': '省赛与邀请赛' };
    const containerNameOf = (key) => {
        const seg = String(key).split(':').pop();
        if (CONTAINER_NAME[seg]) return CONTAINER_NAME[seg];
        return seg.startsWith('synth-') ? seg.slice('synth-'.length) : seg;
    };
    //   ⚠️ `xcpc:s:` 是**命名空间**那两段，不是层 ⇒ `xcpc:s:synth-ccpc` 的父是顶层 W
    //      `xcpc`（不是 `xcpc:s`）；再往里（`…:ec`、`…:ec:2024`）才是"上一层"。
    const containerParentOf = (key) => {
        const segs = String(key).split(':');
        return segs.length <= 3 ? XCPC_ROOT : segs.slice(0, -1).join(':');
    };
    const needContainers = new Map();           // extKey → { name }
    const addContainer = (key) => {
        // **一路铺到顶**：只加"要用到的那一层"会让中间层缺席（实测：`…:synth-icpc` 没人建
        // ⇒ 它下面 16 个赛季层全断链、离线试跑 2226 条 parent-not-found）
        let k = String(key || '');
        while (k && k !== XCPC_ROOT) {
            if (!needContainers.has(k)) needContainers.set(k, { name: containerNameOf(k) });
            k = containerParentOf(k);
        }
    };
    for (const [, got] of plan) {
        addContainer(got.container);
        addContainer(`${got.container}:${got.season}`);
    }
    const createdContainers = [];
    if (!dryRun) {
        // 顶层 W（合成子树的根）—— 已有的（比如爬虫侧先建了）一个字不动
        if (!nodes.has(XCPC_ROOT)) {
            const root = { '节点类型': 'W', extKey: XCPC_ROOT, name: 'XCPC', '字段来源': { name: 'synth' } };
            records.push(root);
            nodes.set(XCPC_ROOT, root);
            createdContainers.push(XCPC_ROOT);
        }
        for (const [k, v] of needContainers) {
            if (nodes.has(k)) continue;
            const rec = {
                '节点类型': 'S', extKey: k, '父extKey': containerParentOf(k), name: v.name,
                // 来源层要如实写"这个值是脚本建的"（与下面成员指针同一条口径）
                '字段来源': { name: 'synth' }
            };
            records.push(rec);
            nodes.set(k, rec);
            createdContainers.push(k);
        }
        out.containers = createdContainers;
    }
    // ③ 组节点（一个键一个）+ 成员指针
    const groupOf = new Map();                  // key → 组记录
    for (const r of records) {
        const sk = String(r.synthKey || '').trim();
        if (sk) groupOf.set(sk, r);
    }
    for (const [member, got] of plan) {
        let g = groupOf.get(got.key);
        if (!g) {
            const seasonKey = `${got.container}:${got.season}`;
            // ⚠️ **四个 nature 一开始留空，③ 的成员循环里也一个字不写** —— 它们**只**由本函数
            //    末尾那遍"组头性质收敛"按**唯一一份口径**定：`src/core/natureConfidence.js` 的
            //    `pickGroupNature`（真值顶占位 → 分类依据级别高的赢 → **同级取字典序小的**）。
            //    ⚠️ 为什么必须这样：曾经这里是"照第一个成员写"，而那个"第一个"是**包的记录顺序**
            //    —— 顺序一变（比如换个输入包）组头那一格的写法就跟着翻；收敛那一步看到"只差镜像
            //    前缀"（`sameNatureValue`）又会跳过 ⇒ 组头的写法被输入顺序钉住
            //    （实测：摘掉一个输入包之后 33 个组头的 `cf/gyms/…` ↔ `qoj/…` 来回换）。
            g = {
                '节点类型': 'C', synthKey: got.key, '父extKey': seasonKey, name: got.name
            };
            if (!dryRun) {
                records.push(g);
                nodes.set(got.key, g);
            }
            groupOf.set(got.key, g);
            out.created++;
        }
        // ⚠️ **组头那四格 nature 这里一个字都不写** —— 全部交给本函数末尾那遍"组头性质收敛"
        //    按**唯一一份口径** `src/core/natureConfidence.js` 的 `pickGroupNature` 定
        //    （真值顶占位 → 分类依据级别高的赢 → **同级取字典序小的**），与包的记录顺序无关。
        //    （曾经这里是"谁先到就照谁写"：那个"第一个成员"是**包的记录顺序**，而收敛那一步
        //      看到"只差镜像前缀"（`sameNatureValue`）会跳过 ⇒ 组头那一格的写法被输入顺序钉住。）
        // ⚠️ **组内 分类/地区 打架的报警也跟着挪到那一遍**（要跟**收敛后**的组头值比，
        //    而不是跟"第一个成员"比）—— 见下面"组头性质"那一遍。
        // ⚠️ **年份的冲突不在这里报**：同赛季不同年份**只有高可信度（M/A/B）冲突时才报警**
        //    ⇒ 年份**单独一遍**（见本函数末尾 `yearRows` 那段）：只有 **M/A/B** 档的值之间才算冲突，
        //    `待同步` 与"赛季年顶出来的"（D）只记账。这里只把值记进 `yearRows`。
        // 年份**记账**（这一场的这一份来源给了什么、凭什么级别的规则给的）
        const yRule = classRulesOf(member).natureYear || '';
        if (!yearRows.has(got.key)) yearRows.set(got.key, []);
        yearRows.get(got.key).push({
            value: String(member.natureYear === undefined || member.natureYear === null
                ? '' : member.natureYear).trim(),
            level: yRule ? levelOfClassRule(yRule) : '',
            rule: yRule,
            node: keyOf(member)
        });
        const cur = ownerOf(member);
        if (cur === got.key) continue;          // 已经对了（幂等）
        // ⚠️ 只覆盖"空白 / 旧清单格式"；人绑的（其它键）不动
        if (cur && !isOldKey(cur)) {
            // 已经是我们的新格式键、但**现在算出来是另一个键**（≠ 上面那条 `cur === got.key`）：
            // 说明绑定之后这场 nature 变了（比如人把分类改了）⇒ **留着不动**（人的决定优先），
            // 但**如实报出来**，别让它悄悄烂在那里。
            // ⚠️ **为什么不做"改名跟随"**：脚本格式的键**也可能是人挪过去的**
            //    （`分类依据.ownerSynth=manual:set`，实测那 4 条悬空指针就是），
            //    一律跟着改名会踩掉人的决定 —— `synth-bind.smoke.mjs` 把这条钉住了
            //    （"人工的键一个字不动" / "人挪进的那组不撤销"）。要动请到应用侧
            //    「判重整理」页（那里有人绑的完整信息 + 一键清理）。
            if (isScriptKey(cur)) out.drift.push({ node: keyOf(member), cur, want: got.key, cls: String(member.natureClass || '') });
            continue;
        }
        if (cur) out.replaced++;
        if (!dryRun) {
            member.ownerSynth = got.key;
            // ★ **来源层要记"这个指针是谁写的"**（`problem-bind` 给 P 成员写的是同一条：
            //   `字段来源.ownerSynth='synth'`）—— 少了它，应用里那一格的出处就查不出来。
            const src = { ...(member['字段来源'] || {}) };
            if (src.ownerSynth !== 'synth') { src.ownerSynth = 'synth'; member['字段来源'] = src; }
        }
        out.bound++;
    }
    // ★ **组头的四个 nature 按同一份口径收敛**（`core/natureConfidence.js` 的 `pickGroupNature`）：
    //   真值顶占位 → 依据级别高的赢 → 同级取最早；空的字段不动。
    //   ⚠️ **这是组头那四格的唯一定值处** —— ③ 的成员循环一个字都不写（见那里的注释），
    //      所以结果与**包的记录顺序**无关。
    //   ⚠️ **与应用侧共用这一份**：人填成员的性质时，应用在同一个事务里对组头做同样的事
    //      （`core/ops/synth.js` 的 `syncGroupNature`）—— 两边各写一套就会漂。
    //   依据（`分类依据`）从**胜出的那个成员**那一格抄过来 ⇒ 不新增规则词表。
    {
        // ⚠️ **成员集合要和应用侧同口径**（应用是 `synthIndex` 里"指着这个头的所有成员"）：
        //    只收 `plan` 里那些（**人绑过的被排除了**）会让"脚本算出的组头值"与
        //    "应用下一次同步算出的值"不一样 —— 人定的那格是级别 `M`（最硬），
        //    本来就是最该被听见的证据。所以这里单独按 `ownerSynth` 收一遍。
        const membersByGroup = new Map();
        const addMember = (own, r) => {
            if (!membersByGroup.has(own)) membersByGroup.set(own, []);
            const list = membersByGroup.get(own);
            if (!list.includes(r)) list.push(r);      // 真跑与 `--dry-run` 两条路会重叠 ⇒ 一个成员只收一次
        };
        for (const r of records) {
            if (String(r['节点类型'] || '') !== 'C') continue;
            if (String(r.synthKey || '').trim()) continue;            // 组头自己不做成员
            if (String(r['父synthKey'] || '').trim()) continue;       // 题目组的组头归 `problem-bind`
            const own = ownerOf(r);
            if (!own || !groupOf.has(own)) continue;                  // 只收"指着本包某个组头"的
            addMember(own, r);
        }
        // ⚠️ `--dry-run` 下成员指针**还没写进 `records`** ⇒ 计划里的成员要另补一遍，
        //    否则演练算出来的组头值与冲突跟真跑对不上。
        for (const [member, got] of plan) addMember(got.key, member);
        for (const [gkey, members] of membersByGroup) {
            const g = groupOf.get(gkey);
            if (!g) continue;
            const { values, rules } = pickGroupNature(members);
            for (const [f, v] of Object.entries(values)) {
                if (!v) continue;
                // ★ **组头这四格是派生量 ⇒ 没有"人改过就别动"的守卫**（**故意没有**，别再加）：
                //   组头上的 `manual:set` 有两个来源 —— 人直接改了组头那一格，或
                //   **成员**那格是人定的（级别 M 必然胜出）⇒ `pickGroupNature` 把规则 id
                //   **原样抄到组头**。两者在数据里长得一样 ⇒ 拿它当"人改过组头"的判据会把
                //   派生自己锁死（实测：成员改一次之后组头永远停在旧值，⑤ 也不报）。
                //   应用侧 `ops/synth.js` 的 `syncHeadNature` 同一条口径、同一段理由。
                // ★ "算不算已经一致"同样只有一份（`sameNatureValue`：分类只差镜像前缀不算不同）
                //   —— 与 ⑤ 的「🔄 组头待同步」逐条对齐（那边报几条，这边就改几条）。
                if (sameNatureValue(f, g, v)) continue;
                if (!dryRun) g[f] = v;
            }
            if (!dryRun) {
                const col = { ...(g[CLASS_RULE_COL] || {}) };
                let dirty = false;
                for (const [f, rule] of Object.entries(rules)) {
                    if (!rule || col[f] === rule) continue;
                    col[f] = rule;
                    dirty = true;
                }
                if (dirty) g[CLASS_RULE_COL] = col;
            }
            // ⚠️ **同组内 分类/地区 打架** ⇒ 报警：比的是**收敛后**的组头值（`values` 就是它），
            //    不是"第一个成员"的 —— 这样报出来的话与**顺序无关**，且与界面上的组头一致。
            //    ⚠️ **只对计划里的成员**报：人绑的那些脚本不碰、也不替人评判（与旧行为一致）。
            //    两条不算打架：① 分类只差**镜像前缀**（`qoj/xcpc/…` vs `xcpc/…`）；
            //    ② 地区有一边不是真地名（占位 / `无`）⇒ 不算。
            for (const m of members) {
                if (!plan.has(m)) continue;
                for (const f of ['natureClass', 'natureRegion']) {
                    const b = String(m[f] === undefined || m[f] === null ? '' : m[f]).trim();
                    if (!b) continue;
                    const a = String(values[f] === undefined || values[f] === null ? '' : values[f]).trim();
                    if (!a) continue;
                    if (f === 'natureClass') {
                        if (bareClass(a) === bareClass(b)) continue;
                    } else {
                        if (a === b) continue;
                        if (!realPlace(a) || !realPlace(b)) continue;
                    }
                    out.conflicts.push({ key: gkey, field: f, group: a, member: b, node: keyOf(m), severity: 'normal' });
                }
            }
        }
    }
    // ④ 年份冲突：**只报"高可信（M/A/B）"的值之间的**（同赛季不同年份**只有
    //    高可信度冲突时才报警** + "将『待同步』和 qoj 年份的可信度都标为『不高』"）。
    //    为什么单独一遍：组键里带赛季 ⇒ 组内赛季**必然相同**，所以"赛季一致、年份不一致"本身
    //    是**真信号**；但参与比较的必须是**硬证据** —— 只有 **M/A/B**（高可信）的值才算，
    //    `待同步`（占位）与"赛季年顶出来的"（D）都只当账（`ⓘ`），**空值什么都不算**
    //    （年份留空 ⇒ 那是"还没填"，归 ③ 性质待补，不是"和谁打架"）。
    //    ⚠️ 只看**成员**，不看组头那格：组头的年份是**从成员收敛出来的派生量**，它自己没有依据。
    for (const [gkey, rows] of yearRows) {
        const high = new Map();            // 值 → 给了这个值的高可信来源
        const low = new Map();             // 值 → 低可信但**确实报了值**的来源（空值不进）
        for (const r of rows) {
            const v = String(r.value === undefined || r.value === null ? '' : r.value).trim();
            if (!v) continue;                                  // 空 = 还没填，不算主张
            const bucket = realYear(v) && isHighLevel(r.level) ? high : low;
            if (!bucket.has(v)) bucket.set(v, []);
            bucket.get(v).push(r.node);
        }
        const entry = {
            key: gkey,
            high: [...high].map(([value, nodes]) => ({ value, nodes: nodes.sort() })).sort((a, b) => a.value.localeCompare(b.value)),
            low: [...low].map(([value, nodes]) => ({ value, nodes: nodes.sort() })).sort((a, b) => a.value.localeCompare(b.value))
        };
        // ⚠️ 低可信那一摞只在**它有"一个具体的年份"、且和高可信的不一样**时才记账：
        //    · `待同步` / `不确定` / `无` 这些**占位**不算（`待同步` 现在是非总决赛的**默认值**
        //      ⇒ 拿它当"分歧"会把账本淹成上百条：实测 123 条里绝大多数就是这种）；
        //    · 空值更不算（那是"还没填"）；
        //    · 真正要看的 = **C 级（赛名里的年份）这类"低可信但确实报了个年份"**的值。
        const lowDiffers = entry.high.length > 0
            && entry.low.some(g => realYear(g.value) && !high.has(g.value));
        if (entry.high.length >= 2) out.yearConflicts.push(entry);
        else if (lowDiffers) out.yearLow.push(entry);        // 高/低不一致（不算警报，只记账）
    }
    out.yearConflicts.sort((a, b) => a.key.localeCompare(b.key));
    out.yearLow.sort((a, b) => a.key.localeCompare(b.key));
    // ⑤ 收掉空掉的组：
    //    (a) **旧格式**的组：键是旧清单格式、且已经没有成员指着它；
    //    (b) ★ **本轮被注册表解绑而清空**的组（"删除路径"）——
    //        ⚠️ 必须**只收 (b) 里这些**：一个"当前格式"的空组也可能是**人手建的**（① 页面上
    //        刚建好、还没放成员）⇒ 全局扫"空组"会把它误删。这条判据按"谁失去了最后一个成员"认，
    //        安全且精确。
    //    ⚠️ `used` 从"**解绑之后**还剩谁指着"算（dry-run 下也照算，否则报告会说"什么都没空"）。
    const unboundNodes = new Set(out.unbound.map((u) => u.node));
    const used = new Set(records.filter((r) => !unboundNodes.has(keyOf(r)))
        .map(ownerOf).filter(Boolean));
    const emptied = new Set(unboundOwners);
    for (const r of records) {
        const sk = String(r.synthKey || '').trim();
        if (!sk) continue;
        if (used.has(sk)) continue;
        const emptiedByUnbind = emptied.has(sk);
        if (!isOldKey(sk) && !emptiedByUnbind) continue;
        out.dropped.push(sk);
    }
    //: 收掉之后还剩下哪些记录（dry-run 与真跑都用它算"父亲还在不在"）
    const dropGroups = new Set(out.dropped);
    const kept = records.filter((r) => !dropGroups.has(String(r.synthKey || '').trim()));
    if (!dryRun && out.dropped.length) doc.records = kept;
    // ⑤b 收掉**因为上面这次删除而空掉**的容器（S 层），并**向上级联**
    //     （赛季层空了 ⇒ 它的父层也可能跟着空）。
    //     判据同样是"**本轮才空**"：只看被删东西的父亲，不全局扫空容器（人手建的空容器不碰）。
    if (out.dropped.length) {
        const removed = new Set(out.dropped);
        for (let guard = 0; guard < 16; guard++) {
            const keptNow = records.filter((r) => !removed.has(keyOf(r)));
            const alive = new Set(keptNow.map((r) => String(r['父extKey'] || '')).filter(Boolean));
            const parents = new Set(records.filter((r) => removed.has(keyOf(r)))
                .map((r) => String(r['父extKey'] || '')).filter(Boolean));
            const drop = [...parents].filter((p) => !alive.has(p) && !removed.has(p)
                && nodes.get(p) && String(nodes.get(p)['节点类型'] || '') === 'S');
            if (!drop.length) break;
            for (const p of drop) { removed.add(p); out.droppedContainers.push(p); }
        }
        if (!dryRun && out.droppedContainers.length) {
            const drop = new Set(out.droppedContainers);
            doc.records = doc.records.filter((r) => !drop.has(keyOf(r)));
        }
    }
    // ⑤c 注册表里点名了、包里却没有的条目（写错 extKey / 那场没了 ⇒ 属"注册表与实际不符"）
    out.registryMissing = missingSynthRules(records);
    // ⑤d **疑似被拆开的组**：省赛那一支的主办是从**各来源自己的赛名**读的，
    //     同一场在不同来源的名字里品牌词不一致 ⇒ 会被算成两组。判据只有一份（`synthPlan.isSuspectSplit`），
    //     应用侧 ⑤ 冲突栏读的是同一条 —— 这里只负责把数报出来。
    //     ⚠️ **不自动合**（按组投票"看别人怎么说"**不可从零复现**）⇒ 交给人。
    const groups = new Map();
    for (const r of records) {
        const sk = String(r.synthKey || '').trim();
        if (r['节点类型'] !== 'C' || !sk) continue;
        groups.set(sk, { node: r, members: 0 });
    }
    for (const r of records) {
        const own = String(r.ownerSynth || '').trim();
        if (own && groups.has(own)) groups.get(own).members++;
    }
    out.suspectSplits = suspectSplitPairs(
        [...groups.values()].map((g) => groupFacetsOf(g.node, g.members))
    );
    return out;
}

// ================================================================
// 命令行
// ================================================================
function main(argv) {
    const args = { package: '', dryRun: false, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--package') args.package = argv[++i];
        else if (argv[i] === '--dry-run') args.dryRun = true;
        else if (argv[i] === '--quiet') args.quiet = true;
        else if (!argv[i].startsWith('-')) args.package = argv[i];
        else {
            console.error('用法: node scripts/synth-bind.mjs <包> [--dry-run] [--quiet]');
            return 2;
        }
    }
    if (!args.package) {
        console.error('用法: node scripts/synth-bind.mjs <包> [--dry-run] [--quiet]');
        return 2;
    }
    const doc = JSON.parse(fs.readFileSync(args.package, 'utf8'));
    const res = bindByNature(doc, args.dryRun);
    if (!args.quiet) {
        console.log(`🔗 按 nature 定合成归属（国内）：写/改指针 **${res.bound}** 条`
            + `（新建组 ${res.created}｜新铺容器 ${res.containers.length}｜替换旧清单键 ${res.replaced}）`);
        console.log(`   🧹 收掉空掉的旧组 ${res.dropped.length} 个｜⏳ 算不出、留给人 ${res.noKey.length} 条`);
        // ★ **疑似被拆开的组**：同一场因"一边写了品牌、一边没写"被算成两组 ⇒
        //   报出来交给人（**不自动合**：按组投票不可从零复现）。一条要能说清"凭什么"。
        if (res.suspectSplits.length) {
            console.log(`   🔀 **疑似被拆开的组** ${res.suspectSplits.length} 对`
                + '（同赛季 + 同地点 + 同类型，一边写了主办、一边没写 ⇒ 可能是同一场；'
                + '在判重整理页并成一组即可，脚本不会撤销人的绑定）：');
            for (const [a, b] of res.suspectSplits.slice(0, 8)) {
                console.log(`      · ${a.name}（${a.org}，${a.memberCount} 条）`
                    + `  ⟷  ${b.name}（${b.org}，${b.memberCount} 条）`);
            }
            if (res.suspectSplits.length > 8) {
                console.log(`      …… 另有 ${res.suspectSplits.length - 8} 对`);
            }
        }
        // ★ 注册表排除：这些**不该算合成键**（是结论，不是欠账）——单独一行报
        if (res.noSynth.length || res.unbound.length || res.droppedContainers.length) {
            console.log(`   ⛔ 注册表排除 ${res.noSynth.length} 条（不算合成键；`
                + `其中**解绑** ${res.unbound.length} 条，顺带收掉空组 ${res.dropped.length} 个 / `
                + `空容器 ${res.droppedContainers.length} 个）：`);
            for (const x of res.noSynth.slice(0, 5)) {
                console.log(`      · ${x.key}「${String(x.name).slice(0, 40)}」（${x.layer === 'classRules' ? '分类白名单' : '节点白名单'}：${x.match}）`);
            }
            for (const x of res.unbound.slice(0, 5)) console.log(`      ↳ 解绑 ${x.node}（原来指着 ${x.cur}）`);
        }
        if (res.humanBound && res.humanBound.length) {
            console.log(`   🔒 人绑的合成归属 ${res.humanBound.length} 条`
                + '（`分类依据.ownerSynth=manual:set`）—— 脚本**一个字不动**，也不报"算不出"：');
            for (const x of res.humanBound.slice(0, 5)) console.log(`      · ${x.node} → ${x.cur || '（空）'}`);
        }
        if (res.humanKeyed && res.humanKeyed.length) {
            console.log(`   ⚠️ 注册表排除了、但**人工绑着**键的 ${res.humanKeyed.length} 条（脚本一个字不动，请人核）：`);
            for (const x of res.humanKeyed.slice(0, 5)) console.log(`      · ${x.node} → ${x.cur}`);
        }
        if (res.registryMissing && res.registryMissing.length) {
            console.log(`   ⚠️ 注册表（acm-data/synth-registry.json）里点名、但**包里没有**的 `
                + `${res.registryMissing.length} 条（写错 extKey 还是那场没了？）：${res.registryMissing.slice(0, 5).join('、')}`);
        }
        // 「算不出」的样本**紧跟它自己那行**（放在最后会跟冲突清单糊在一起看不出是谁的）
        for (const x of res.noKey.slice(0, 5)) {
            console.log(`      · ${x.key}「${String(x.name).slice(0, 40)}」（${x.cls}）`);
        }
        // ⚠️ 年份冲突**单独报**（同赛季不同年份**只有高可信度（M/A/B）冲突时才报警**）：
        //    组键里带赛季 ⇒ 组内赛季必然相同 ⇒ "赛季一致、年份不一致"是真信号；但**参与比较的
        //    必须是硬证据**（M 人工 / A 开赛时间 / B 结构）。`待同步` 与"赛季年顶出来的"（D）
        //    只当账（`ⓘ` 那一行），**不进 ⚠️⚠️**。这类冲突**全量列出**（其余冲突只列前 5）。
        if (res.yearConflicts.length) {
            const fmt = (list) => list.map(g => `${g.value}（${g.nodes.join('、')}）`).join('  vs  ');
            console.log(`   ⚠️⚠️ **赛季一致、年份不一致** ${res.yearConflicts.length} 处`
                + '（只算 **M/A/B 高可信**的值 —— 多半某个来源的年份填错了；'
                + '跨年总决赛 / 疫情延期是已知例外）：');
            for (const c of res.yearConflicts) console.log(`      ${c.key}：${fmt(c.high)}`);
        }
        if (res.yearLow.length) {
            const fmt = (list) => list.map(g => `${g.value}（${g.nodes.join('、')}）`).join('  vs  ');
            console.log(`   ⓘ 低可信的年份差异 ${res.yearLow.length} 处（\`待同步\` 或 **C 级（赛名里的年份）**`
                + ' 说的值与硬数据不同 ⇒ **不算警报**，只记账）：');
            for (const c of res.yearLow.slice(0, 5)) {
                console.log(`      ${c.key}：高 ${fmt(c.high)} ｜ 低 ${fmt(c.low)}`);
            }
        }
        if (res.conflicts.length) {
            const fmt = (c) => `${c.key} 的 ${c.field}：组里「${c.group}」vs ${c.node}「${c.member}」`;
            console.log(`   ⚠️ 同组内 分类/地区 打架 ${res.conflicts.length} 处（组头那格由 \`pickGroupNature\` 收敛，未猜）：`);
            for (const c of res.conflicts.slice(0, 5)) console.log(`      ${fmt(c)}`);
        }
        // ⚠️ 这一摞**不是错**：人改了 nature（分类/地点/赛季）之后，那个键常常就不对了，
        //    但"绑定是人定的" ⇒ 我们不擅自搬，只报出来请人核（脚本只管空白场次）。
        //    （那 4 条 `synth:xcpc:年份未知provincial-*` 的悬空指针就是这一类：
        //     `分类依据.ownerSynth=manual:set` ⇒ 只报不动，清理去应用侧「判重整理」。）
        if (res.drift.length) {
            console.log(`   ⚠️ 已绑但按现在的 nature 该是另一个键 ${res.drift.length} 条（**不动**，请人核）：`);
            for (const d of res.drift.slice(0, 5)) {
                console.log(`      ${d.node}：现在指着「${d.cur}」，按 ${d.cls} 算应是「${d.want}」`);
            }
        }
    }
    if (args.dryRun) {
        console.log('（--dry-run：没有写盘）');
        return 0;
    }
    fs.writeFileSync(args.package, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    process.exit(main(process.argv.slice(2)));
}
