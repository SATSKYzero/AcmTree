// ================================================================
// 判重（core/dedup.js）：把原料「归入合成节点」
//
// 模型是"**原料归属某个合成节点**"（非对称）：合成节点是树上一个**真节点**
// （身份 `synthKey`），原料节点靠指针字段 `ownerSynth` 指向它。
//
// 所以本模块的三件事：
//   ① `synthGroups`         —— 合成节点清单 + 它的成员（判定归属的**唯一依据**）
//   ② `unownedMaterialIds`  —— 还没归入任何合成节点的原料
//   ③ `suggestMembers`      —— **推荐**（只推荐，绝不写、绝不判定）
//
// 建议口径：
//   · `suggestMembers` 默认走 **`strict` 硬门槛**（只认 `problemId` 相同 /
//     归一化标题完全相同），相似度建议走**显式开启**的 `mode:'similar'/'all'`；
//   · **筛选范围**：`scopeNodeIds`（整棵树 / 子树 / 单场比赛）、
//     `matchesDedupFilter`（nature 四维 / 类型 / 关键词 / 归入状态）、
//     `collectDedupFacets`（可选项**从数据里收集**，不穷举词表）；
//   · **跨性质不建议**：`natureComboOf(a).matches(b)`（"两边都非空才比"）。
//
// 硬约束（docs/manual-workflow.md（合成节点与指针））：
//   · **相似度永不参与判定**，只决定"说不说"（与导入侧 4.6 同一条）；
//   · **合成节点自己不进候选**：任何 `synthKey` 非空的节点都从"可被推荐 / 可被归入"
//     的集合里排除（合成节点不能当成员，成员名单不能嵌套）；
//   · **W/S 不参与合成**（也不参与推荐）—— 只有 C / P / R；
//   · 悬空指针**不是灾难**：指向不存在的 `synthKey` 时那个原料自己就是一组，
//     界面上标黄 + 一键清理（`core/ops/synth.js` 的 `clearDanglingOwners`）。
//
// 本模块是**纯逻辑**：不碰 DOM、不读 AppState 单例、不 import UI / immer ——
// 调用方把节点表与父子表传进来，所以它能在 Node 单测里直接跑。
// ================================================================
import {
    titleSimilarity,
    differsOnlyByNumbers,
    blockingKey,
    normalizeTitle,
    DEFAULT_SIMILARITY_THRESHOLD
} from '../utils/similarity.js';
// 「性质」四字段：判重页的三条口径都建在它上面
//   ① **跨性质不建议**（`natureComboOf(a).matches(b)`，"两边都非空才比"）；
//   ② 筛选范围里的四个 chip 维度；
//   ③ 可选项**从数据里收集**（`collectNatureValues`），不穷举词表。
// ⚠️ 本模块只 **import** 它、绝不改它（词表有另一个 fork 在动）。
import {
    NATURE_FIELD_KEYS,
    normalizeNatureValue,
    natureComboOf,
    natureLabel,
    natureFieldOf,
    isRealYear,
    collectNatureValues,
    CLASS_PATHS,
    classPathOf,
    classLabel,
    classMatches,
    isCompleteClassPath
} from './natureFields.js';
// 分类的**依据强度**（元列 `分类依据` → 级别表）。
// 纯函数、无依赖，判重页的条目带一个 `level` 就能画徽标 / 按"依据弱"筛。
import { classLevelOf, classRuleOf, levelRank, MANUAL_LEVEL } from './natureConfidence.js';
// 「哪些指针是悬空的」**判据只有一处**（`ops/synth.js` 的 `findDanglingOwners`）——
// 这一栏的 `danglingCount` 与判重页那条黄条、与「一键清理」清的条数，必须同源。
import { findDanglingOwners } from './ops/synth.js';

// ---- 字段名的**第二份**（唯一真源在 core/ops/synth.js） ----
// 这一份是**故意的**：判重页要能在**纯 Node 单测**里跑，而 `core/ops/synth.js`
// 会牵进 `ops/account.js` → `shell/state.js` → `immer`（`npm test` 不带解析钩子）。
// 两份之间由 `src/test/elements.test.js` 与 `synthOps.test.js` 的字段名单钉住。
/** 身份字段（长在合成节点上） */
export const SYNTH_KEY_FIELD = 'synthKey';
/** 指针字段（长在原料节点上） */
export const OWNER_FIELD = 'ownerSynth';
/** 允许合成的节点类型（与 core/ops/synth.js 的 `SYNTH_TYPES` 同源同义） */
export const SYNTH_TYPES = ['C', 'P', 'R'];

/**
 * 一次推荐**总共**最多两两比多少对。
 *
 * 为什么要有总量上限：`titleSimilarity` 内含 Levenshtein，实测每对约 18µs ——
 * 2 万节点、每桶几十个节点就是几十万对，十几秒（整理页直接卡死）。
 * 桶内分块只减少"块间"的比较，挡不住"某一个大块里有几千个节点"（实测 200×100 的
 * 分布仍然 13 秒）。所以这里给一个**总量预算**：花完就退化成"同名配对"（O(n)），
 * 并把被挡下的块如实报给页面。
 *
 * 真实数据的块都很小（一个系列十几场比赛、一场比赛十几道题），预算根本用不到；
 * 它只在"练习容器里挂了上千道散题"这种分布下才生效。
 *
 * ⚠️ 候选是"一个原料 + 一个归属目标"，但两两比的循环仍是"桶内同块两两比一次"，
 * 所以预算的含义按这个循环算。
 *
 * ⚠️ 它**只挡相似度那条路**。硬门槛（`mode:'strict'`）是哈希分组，
 *    本来就不两两比，所以不受它影响。
 */
const MAX_TOTAL_PAIRS = 50000;

/** 取节点的合成标识（非空 ⇒ 它是合成节点；字符串统一在这里归一） */
function synthKeyOfNode(node) {
    if (!node) return '';
    const v = node[SYNTH_KEY_FIELD];
    return (v === undefined || v === null) ? '' : String(v).trim();
}

/** 取节点的指针（非空 ⇒ 它归入了某个合成节点） */
function ownerOfNode(node) {
    if (!node) return '';
    const v = node[OWNER_FIELD];
    return (v === undefined || v === null) ? '' : String(v).trim();
}

/** 是不是合成节点（合成节点**不能**当成员，也不进候选） */
export function isSynthesisNode(node) {
    return synthKeyOfNode(node) !== '';
}

/** 这个类型参不参与合成（W/S/O 一律不参与） */
export function isSynthType(type) {
    return SYNTH_TYPES.indexOf(String(type || '')) >= 0;
}

/**
 * 参不参与"归入/推荐"：**原料**（没有 `synthKey`）且**类型合法**（C/P/R）。
 *
 * 两个方向都排除合成节点：合成节点不能当成员（名单不能嵌套），也不该被推荐给谁。
 */
export function isMaterialCandidate(node) {
    if (!node) return false;
    if (isSynthesisNode(node)) return false;
    return isSynthType(node.type);
}

// ================================================================
// ① 合成节点清单
// ================================================================

/**
 * 一次 DFS 的**树序**（`节点 id → 序号`）。
 *
 * 为什么成员要按树序排而不是对象键序：聚合按"名单顺序"叠值，
 * 顺序必须**稳定且看得懂**；对象键序在插入/删除后会变，不能当"名单顺序"。
 * 顺带也是 O(n) —— 20k 节点一次遍历，MS 量级以下。
 */
function treeOrderOf(state) {
    const nodes = (state && state.nodes) || {};
    const childOrder = (state && state.childOrder) || {};
    const order = new Map();
    let seq = 0;
    const stack = [state && state.rootId];
    while (stack.length) {
        const id = stack.pop();
        if (!id || order.has(id)) continue;
        order.set(id, seq++);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    // 不在树上的（正常不该有，但别静默丢掉）排到最后，保持稳定
    for (const id of Object.keys(nodes)) {
        if (!order.has(id)) order.set(id, seq++);
    }
    return order;
}

/**
 * **合成节点清单**（判重页第一块的数据源）。
 *
 * 返回的 `memberIds` 按**树序**；`dangling` = 指针指向的标识不存在、跨界、或指向自己
 * （与 `core/ops/synth.js` 的 `findDanglingOwners` 同口径，这里只做"能不能显示"）。
 *
 * ⚠️ 合成节点**不会**出现在任何 `memberIds` 里 —— 成员名单不能嵌套。
 *
 * @param {Object} state - `{nodes, childOrder, rootId}`
 * @returns {Array<{key:string, nodeId:string, name:string, type:string,
 *                  memberIds:string[], danglingCount:number}>} 按 `key` 升序
 */
export function synthGroups(state) {
    const nodes = (state && state.nodes) || {};
    const order = treeOrderOf(state);
    const byKey = new Map();
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const key = synthKeyOfNode(node);
        if (!key) continue;
        // 同一标识被两个节点占用（导入才能造出来）：保留先出现的那个，别静默覆盖
        if (!byKey.has(key)) byKey.set(key, id);
    }

    const membersOf = new Map();
    const danglingOf = new Map();
    // ⚠️ **悬空判据从 `findDanglingOwners` 取**（不再在这里手写"不存在 / 指向自己 / 类型不符"
    //    三条件）：两处各写一份时，黄条说 2 条、一键清理说清了 3 条（差别就在"合成节点自己带了
    //    成员指针"这种坏数据：那边报、这边以前 `continue` 掉了）。
    //    成员清单仍然**排除合成节点**（口径：合成节点不能当成员），悬空那份不排除 —— 那是要报的坏数据。
    const danglingIds = new Set(findDanglingOwners(state).map((d) => String(d.id)));
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        const key = ownerOfNode(node);
        if (!key) continue;
        if (isSynthesisNode(node)) continue;          // 合成节点不能当成员
        if (!membersOf.has(key)) membersOf.set(key, []);
        membersOf.get(key).push(id);
        if (danglingIds.has(String(id))) {
            if (!danglingOf.has(key)) danglingOf.set(key, []);
            danglingOf.get(key).push(id);
        }
    }

    const byOrder = (a, b) => (order.get(a) || 0) - (order.get(b) || 0);
    return [...byKey.entries()]
        .map(([key, nodeId]) => ({
            key,
            nodeId,
            name: nodes[nodeId].name || '',
            type: nodes[nodeId].type || '',
            memberIds: (membersOf.get(key) || []).sort(byOrder),
            danglingCount: (danglingOf.get(key) || []).length
        }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * 还没归入任何合成节点的**原料** id（合成节点与 W/S 都不在里面）。
 *
 * 口径 = `ownerSynth` **为空**。所以**悬空指针不算"未归入"** —— 它归入的是一个
 * 不存在的组，界面由「悬空指针」那一条黄带负责（`core/ops/synth.js` 的
 * `findDanglingOwners` + `clearDanglingOwners`），不在这里混着数。
 *
 * @param {Object} nodes - `state.nodes`
 * @returns {string[]} 按传入（对象键）顺序
 */
export function unownedMaterialIds(nodes) {
    return Object.keys(nodes || {}).filter(id => isMaterialCandidate(nodes[id]) && !ownerOfNode(nodes[id]));
}

// ================================================================
// ①.5 筛选范围与硬门槛的**纯逻辑**（判重页控制栏的数据面）
//
// 口径：
//   · 判重整理支持筛选范围，且**相信性质归类** —— 跨性质的不建议；
//   · nature 是判重页的重要依据；
//   · 建议默认必须收紧，否则干扰项太多、没法用。
//
// 量化依据（xcpc 20464 节点，只读调查）：松散口径下 `suggestMembers` 出 1,829 条建议，
// 随机抽 30 条 **30/30 都不是同一题**（全是 `ICPC EC Online (I)` vs `(II)` 这种
// 标题模板噪声）；`problemId` 非空且相同的建议 **0 条**。所以精度 ≈ 0，
// 默认必须收紧成"只留**机器可判定**的等价信号"（见 `SUGGEST_REASON`）。
//
// 本段只给**纯函数**：不碰 DOM、不读 AppState —— 判重页把 state 拆开喂进来。
// ================================================================

/** 范围档位（判重页控制栏第一个下拉框的三档） */
export const DEDUP_SCOPE_KINDS = Object.freeze(['all', 'subtree', 'contest']);

/** 建议的**依据**（页面必须写明是哪一种，别让用户猜） */
export const SUGGEST_REASON = Object.freeze({
    /** 双方 `problemId` 都非空且相同 —— 机器可判定 */
    PROBLEM_ID: 'problemId',
    /** 归一化标题完全相同 —— 机器可判定 */
    SAME_TITLE: 'title',
    /** 只有标题相似（**仅供参考**，默认不产生） */
    SIMILAR: 'similarity'
});

/** 建议模式（默认 `strict` = 只出可信信号） */
export const DEDUP_SUGGEST_MODES = Object.freeze(['strict', 'similar', 'all']);

/** 建议依据的排序权重（可信的排前面） */
const REASON_RANK = Object.freeze({
    [SUGGEST_REASON.PROBLEM_ID]: 0,
    [SUGGEST_REASON.SAME_TITLE]: 1,
    [SUGGEST_REASON.SIMILAR]: 2
});

/** 归入状态的取值（控制栏那一维） */
export const DEDUP_OWNED_VALUES = Object.freeze(['unowned', 'any']);

// ================================================================
// 筛选的**哨兵值**（唯一一份；判重页 ② 与 ③ 共用）
//
// 为什么不能用空串顶这两个位置：四维里"**没标**"本身就是一个有意义的筛选项
// （常用动线就是"先把没标的筛出来补"），而空串已经被"全部"占了。
//
// ⚠️ **它们也是"从数据里收集"的**（`collectDedupFacets`）：数据里真有没标的节点才列出来，
//    与"不穷举词表"同一个口径 —— 没有这种节点时列表里就不该多两个选项。
// ================================================================
export const ALL_CLASSES = '\u0000all';        // 「全部」
export const NO_CLASS = '\u0000none';          // 「（没标分类）」
export const PARTIAL_CLASS = '\u0000partial';  // 「（分类不完全）」= 有值但**没到叶子**
export const NO_VALUE = '\u0000empty';         // 「（没标年份 / 赛季 / 地区）」
export const HAS_VALUE = '\u0000filled';       // 「（有标…）」= 这一维非空

/** 一个空的筛选条件（**唯一一份**默认值；页面与测试都从这里取）。
 *
 * 四个 nature 维度按 `NATURE_FIELD_KEYS` **动态生成** —— 别手抄字段名：
 * 词表那边加/减一个字段时（另一个 fork 正在动它），这里自动跟上。
 */
export function emptyDedupFilter() {
    const f = { types: [], keyword: '', owned: 'unowned', classLevel: '' };
    for (const key of NATURE_FIELD_KEYS) f[key] = [];
    return f;
}

/**
 * 单个节点**过不过**这条筛选条件（**纯字段判据**，不含范围与配对）。
 *
 * 口径（分类走"不定层路径"）：
 *   · `types` 非空 → 节点类型必须在里面（C / P / R）；
 *   · 三个 nature 维度：**维度内多选是"或"，维度之间是"与"**；
 *   · **分类按前缀匹配**（`classMatches`）：选 `cf` 命中 `cf` / `cf/div2` / `cf/others/无归类`…
 *     ——"要不要往下细分"是深度问题，不该把同一支的父子判成两种性质；
 *     年份 / 地区仍是**完全相等**（只 trim）。
 *   · `keyword` 非空 → 题名**或**题号包含它（大小写不敏感）；
 *   · `owned === 'unowned'` → 已归入（含悬空指针）的节点**不算**；
 *   · **哨兵值**与真值同列：`（没标分类）` / `（分类不完全）` / `（没标年份）` / `（有标年份）`…
 *     （`core/dedup.js` 的 `NO_CLASS` / `PARTIAL_CLASS` / `NO_VALUE` / `HAS_VALUE`）；
 *   · `classLevel` 非空 → **分类依据强度**（`M` 人工 / `≤ X` 及更弱），与 ③ 性质待补**逐条同口径**。
 *
 * ⚠️ 它只管"这个节点本身"，**不管配对**：候选行还要两个端点都过。
 * ⚠️ 它不认识合成节点 —— 合成节点上通常没有 nature（那是**组头**，不是原料），
 *    所以调用方（`suggestMembers`）只把本函数用在**原料端点**上。
 */
export function matchesDedupFilter(node, filter) {
    if (!node) return false;
    const f = filter || {};
    const types = Array.isArray(f.types) ? f.types : [];
    if (types.length && !types.includes(String(node.type || ''))) return false;
    for (const key of NATURE_FIELD_KEYS) {
        const wanted = Array.isArray(f[key]) ? f[key] : [];
        if (!wanted.length) continue;
        const value = normalizeNatureValue(key, node[key]);
        // 维度内"或"；**哨兵值**与真值同列（`（没标分类）`/`（分类不完全）`/`（没标年份）`/`（有标年份）`）
        const hit = (w) => {
            if (key === 'natureClass') {
                if (w === NO_CLASS) return !value;
                if (w === PARTIAL_CLASS) return !!value && !isCompleteClassPath(value);
                return classMatches(value, w);
            }
            if (w === NO_VALUE) return !value;
            if (w === HAS_VALUE) return !!value;      // `无` / `待同步` / `不确定` 也算**有标**
            return value === w;
        };
        if (!wanted.some(hit)) return false;
    }
    const kw = String(f.keyword === undefined || f.keyword === null ? '' : f.keyword).trim().toLowerCase();
    if (kw) {
        const name = String(node.name || '').toLowerCase();
        const pid = String(node.problemId || '').toLowerCase();
        if (!name.includes(kw) && !pid.includes(kw)) return false;
    }
    if (f.owned === 'unowned' && ownerOfNode(node)) return false;
    // 分类的**依据强度**：与 ③ 性质待补的 `passFilters` **逐条同口径**
    // （`M` 人工是单选那一档；`≤ X` = 该级及更弱；级别未知（老数据）**任何"≤ X"都不收**）。
    if (f.classLevel) {
        const lv = classLevelOf(node);
        if (f.classLevel === MANUAL_LEVEL) {
            if (lv !== MANUAL_LEVEL) return false;
        } else {
            if (!lv) return false;
            if (levelRank(lv) < levelRank(f.classLevel)) return false;
        }
    }
    return true;
}

/**
 * 从**当前数据**里收集控制栏的可选项（不穷举词表 —— 词表里的值可能一条数据都没有）。
 *
 * 分类：列出**数据里真的出现过的路径**，外加它们**在 Trie 里的祖先**
 *   （出现过 `cf/div2` ⇒ 也列 `cf`：筛父级要看得到、也要点得动 —— 前缀匹配的入口）。
 * 年份 / 地区：直接 `collectNatureValues`。
 *
 * @param {Object|Array} nodes - 节点表（或节点数组）
 * @returns {{nature:Object<string, Array<{value:string,label:string}>>, types:string[]}}
 */
export function collectDedupFacets(nodes) {
    const list = Array.isArray(nodes) ? nodes : Object.values(nodes || {});
    const nature = {};
    for (const key of NATURE_FIELD_KEYS) {
        const values = collectNatureValues(list, key);
        const label = (natureFieldOf(key) || {}).label || key;
        // ★ **"没标 / 有标"永远列出来**（乙，用户 2026-10-12 拍板）——与 ③ 性质待补同一个口径：
        //   不看当前有没有这种条目，各维度一致，而且"先把没标的筛出来补"正是常用动线。
        //   （② 的候选**允许**"两边都没标"的配对：`natureComboOf` 是"两边都非空才比"
        //     ⇒ 少了这一档，那类候选就筛不出来。）
        const sentinels = [];
        if (key === 'natureClass') {
            sentinels.push({ value: NO_CLASS, label: `（没标${label}）` });
            sentinels.push({ value: PARTIAL_CLASS, label: '（分类不完全）' });
        } else {
            sentinels.push({ value: NO_VALUE, label: `（没标${label}）` });
            sentinels.push({ value: HAS_VALUE, label: `（有标${label}）` });
        }
        if (key === 'natureClass') {
            const seen = new Set();
            const options = [];
            const push = (v) => {
                if (!v || seen.has(v)) return;
                seen.add(v);
                options.push({ value: v, label: natureLabel(key, v) });
            };
            for (const v of values) {
                const segs = classPathOf(v);
                for (let i = 1; i <= segs.length; i++) push(segs.slice(0, i).join('/'));
            }
            nature[key] = [...sentinels, ...options.sort((a, b) => (a.value < b.value ? -1 : (a.value > b.value ? 1 : 0)))];
            continue;
        }
        nature[key] = [...sentinels, ...values.map(v => ({ value: v, label: natureLabel(key, v) }))];
    }
    const types = [];
    for (const node of list) {
        const t = String((node && node.type) || '');
        if (SYNTH_TYPES.includes(t) && !types.includes(t)) types.push(t);
    }
    types.sort((a, b) => SYNTH_TYPES.indexOf(a) - SYNTH_TYPES.indexOf(b));
    return { nature, types };
}

/** 取节点的 `problemId`（统一 trim；空 = 没填，**不参与硬门槛**） */
function problemIdOf(node) {
    const v = node && node.problemId;
    return (v === undefined || v === null) ? '' : String(v).trim();
}

/**
 * 两边**都填了** `problemId` 且不相等 ⇒ 它们是**两道不同的官方题**，哪怕标题一模一样。
 *
 * 实测案例：AtCoder `arc120` 的 `F` 与 `F2`，`name` 都是 "Wine Thief" ——
 * 官方口径是"题面相同、约束与时限不同"，**两个独立 task**。只按标题相同就建议归入
 * 会得到一条**误报**；题号是权威的，所以两边都有题号时以题号为准。
 *
 * ⚠️ 只在**标题类**信号上生效（`SUGGEST_REASON.SAME_TITLE`）：`problemId` 相同的分支
 * 本来就要求它相等；相似度那条路（`similar`）是**显式开启**的辅助，不受这条判定影响。
 */
function differByProblemId(all, aId, bId) {
    const a = problemIdOf(all[aId]);
    const b = problemIdOf(all[bId]);
    return !!a && !!b && a !== b;
}

/**
 * 范围 → 节点 id 集合（**含子树根自己**）。
 *
 * 为什么要有"范围"这一维（量化依据）：不限制范围时 `suggestMembers` 在 xcpc 上把
 * 1,829 条建议摊到整棵树；缩到**单场比赛（一个 C 容器）**后 median 只有 1 条 ——
 * 那就是"规模够小，足以手动处理"的那一层。
 *
 * @param {Object} state - `{nodes, childOrder, rootId}`
 * @param {{kind:string, nodeId?:string}} scope
 * @returns {Set<string>|null} `kind === 'all'` → `null`（**不限制**）；
 *          范围节点不存在 → **空集**（什么都命中，不静默退化成"整棵树"）
 */
export function scopeNodeIds(state, scope) {
    const kind = String((scope && scope.kind) || 'all');
    if (kind === 'all' || !DEDUP_SCOPE_KINDS.includes(kind)) return null;
    const nodes = (state && state.nodes) || {};
    const childOrder = (state && state.childOrder) || {};
    const out = new Set();
    const rootId = scope && scope.nodeId;
    if (!rootId || !nodes[rootId]) return out;
    // 显式栈（两万节点的深子树不爆栈）；`seen` 兼作防环
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop();
        if (!id || out.has(id) || !nodes[id]) continue;
        out.add(id);
        const kids = childOrder[id] || [];
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
}

// ================================================================
// ①.7 「性质待补」—— 判重页那一块的数据源（**最直白的列表 + 手填**）
//
// 口径（**只有这一条**，页面一个字都不重复判）：
//   **比赛（C）**：`natureClass` 为空 **也算缺**（比赛总该知道自己是哪一类）；
//   **其余类型（W/S/P/R）**：只在 `natureClass` **非空**时才管（题/提交不背比赛级的性质），
//   非空时 `natureYear` / `natureRegion` 里**任意一个为空** ⇒ 待补。
//   字段**逐字段独立**判（`missingNatureKeysOf` 直接返回"缺了哪几个"）——
//   所以"只缺年份"和"三个都缺"是同一张表里的两行，界面上写清楚缺什么。
//
// ⚠️ 门槛只对 C 放开（否则"连大类都没标的比赛"进不了这一块、也没地方补）：
//    实测 `all_nodes.json`：C 没有大类的**全是合成节点**（组头），而组头那四格是**按成员派生**的
//    ⇒ 它们的性质待补**不在这一页**（成员那一条会承担，见下面 `collectNatureItems` 的注释）；
//    其余没有大类的记录是 P/R/W/S —— 它们本来就**不该**背比赛级的性质，所以只对 C 强制。
// ⚠️ 只列**既有写路径写得进去**的类型（W/S/C/P/R）—— 根节点（O）没有手改入口，
//    列出来点「填」会在事务里被 `updateWS` 拒掉，而**一个节点被拒 = 整批回滚**。
//
// ⚠️ 这里**只做最直白的列表 + 手填**：以后要优化的方向（按系列批量推断、
//    导入回代、按父容器继承……）**不在这里做**。真要做时先动本段的口径函数
//    （它是这一块唯一的判据来源），再改 `ui/dedup/dedupPage.js` 的画法。
// ================================================================

/**
 * 「性质待补」里**除分类以外**的那些字段（派生，不手抄一份）。
 *
 * ⚠️ 缺分类时（只有 C 会走到），`missingNatureKeysOf` 用的是**全部**字段
 *    （见下面的 `MAIN_REQUIRED_TYPES`）—— 那张全表就是 `NATURE_FIELD_KEYS` 本身，
 *    顺序天然是「分类、年份、赛季、地区」，界面直接照它写「缺：分类、赛季、地区」。
 */
export const NATURE_PENDING_KEYS = Object.freeze(
    NATURE_FIELD_KEYS.filter(k => k !== 'natureClass')
);

/**
 * 待补列表里**可以被填**的类型：`updateP` / `updateR` / `updateWS` 三条写路径合起来覆盖的类型。
 * 根（O）不在里面 —— 它没有任何手改入口（见上面那段注释）。
 */
const NATURE_WRITABLE_TYPES = Object.freeze(['W', 'S', 'C', 'P', 'R']);

/**
 * **必须**知道自己是哪一类的类型 = 比赛（`C`）。
 *
 * 为什么只有 C：nature 是**比赛级**的性质（分类 = 这场是什么比赛、年份 = 赛季…）；
 * 题（P）与提交（R）是从比赛派生的，它们没有分类**不是缺点**。
 * 而一场比赛连分类都没有 ⇒ 判重分区里它谁也不挨着，值得在 ③ 里点出来。
 */
const MAIN_REQUIRED_TYPES = Object.freeze(['C']);

/** 分类为空时那一组的显示文案（界面/分组共用一处，别各写一份） */
export const NATURE_NO_MAIN_LABEL = '没标分类';

/**
 * 这个节点**缺哪几个性质**（空数组 = 不缺 / 不参与待补）。
 *
 * 判据见本段顶上的口径；三条实现细节：
 *   · 值一律走 `normalizeNatureValue`（分类归一成 `a/b`；其余只 trim）；
 *   · 顺序 = `NATURE_FIELD_KEYS` 的字段顺序（缺分类时就是"缺：分类、…"）；
 *   · 类型不在 `NATURE_WRITABLE_TYPES` 里 ⇒ `[]`（列出来也填不动）。
 *
 * @param {Object} node
 * @returns {string[]} 缺的字段名（可能为空数组）
 */
export function missingNatureKeysOf(node) {
    return natureStatusOf(node).missing;
}

/**
 * 一个节点在「性质待补」这套口径里的**状态**（`missingNatureKeysOf` 的唯一实现）。
 *
 * 为什么要分 `participates` 与 `missing` 两件事（要在『性质待补』里
 * 同时按筛选看到 nature 已填满的节点）：`missing` 为空有两种完全不同的意思 ——
 * **填满了** 与 **根本不参与**（题/提交没标分类、根节点没有手改入口）。
 * 想"顺便看看已填满的"时，必须能把前者挑出来，否则会把两万条 P/R 一起列出来。
 *
 * ⚠️ nature 的分类字段，只有在 Trie 树的叶子节点时才被视为填好 ——
 *    所以这里的"分类标了"= **`isCompleteClassPath()`**（走到叶子），不是"非空"。
 *    `cf` / `xcpc/icpc` 这类**合法但没细到叶子**的值 ⇒ 照旧算「缺分类」，继续待在 ③ 里
 *    （`无归类` 是叶子 ⇒ 算填好；不在 Trie 里的旧值不算 ⇒ 回到 ③ 让人看见、清掉）。
 *    门槛那一条（谁参与）仍按"有没有分类"判：非 C 类型**一个字都没标**时才不管它，
 *    否则两万条 P/R 会一起涌进来 —— 而"标了个前缀"是**欠细化**，该管。
 *
 * @returns {{participates:boolean, missing:string[]}} `participates=false` ⇒ 这一块不管它
 */
export function natureStatusOf(node) {
    if (!node) return { participates: false, missing: [] };
    const type = String(node.type || '');
    if (!NATURE_WRITABLE_TYPES.includes(type)) return { participates: false, missing: [] };
    const cls = normalizeNatureValue('natureClass', node.natureClass);
    // 门槛：比赛（C）没有分类也算"缺"；其余类型仍只在"分类非空"时才管。
    if (!cls && !MAIN_REQUIRED_TYPES.includes(type)) return { participates: false, missing: [] };
    // ⚠️ 分类**不能**只按"值非空"判缺：`xcpc/icpc` 是非空的、但没细到叶子 ⇒ 也算缺。
    //    所以这里逐字段判，分类那一格走 `isCompleteClassPath()`（叶子判定）。
    return {
        participates: true,
        missing: NATURE_FIELD_KEYS.filter(key => (key === 'natureClass'
            ? !isCompleteClassPath(cls)
            : !normalizeNatureValue(key, node[key])))
    };
}

/**
 * 待补条目（**树序**，与合成节点清单的成员表同一套顺序口径）。
 *
 * 每条只带界面要用的东西（id / 类型 / 名字 / 分类 / 年份 / 缺哪几个）——
 * 节点对象本身不复制，界面要显示节点标签时自己拿 `id` 去 `AppState.nodes` 取
 * （复制一份会让"数据变了但缓存没作废"这种错误变得看不出来）。
 *
 * @param {Object} state - `{nodes, childOrder, rootId}`
 * @returns {Array<{id:string, type:string, name:string, cls:string, year:string, missing:string[]}>}
 */
export function collectNaturePendingItems(state) {
    return collectNatureItems(state, { includeFilled: false }).pending;
}

/**
 * 「性质待补」这一块要用的**全部**条目（可以顺带把"已填满"的也带回来）。
 *
 * 参数 `includeFilled` 让调用方顺带把"已填满"的也带回来
 * ⇒ 已填满的**不算待补**（计数、tab 上的条数都还是只看 `pending`），只是"顺便看看"，
 * 所以在这里就分成两摞，别让调用方自己拿 `missing` 反推。
 *
 * 两摞都按**树序**（与合成节点清单的成员表同一套顺序口径）；界面按"先待补、后已填满"画。
 *
 * @returns {{pending:Array, filled:Array}} 每条形如
 *          `{id, type, name, cls, year, region, missing}`
 */
export function collectNatureItems(state, opts = {}) {
    const nodes = (state && state.nodes) || {};
    const order = treeOrderOf(state);
    const pending = [];
    const filled = [];
    for (const id of Object.keys(nodes)) {
        const node = nodes[id];
        // ★ **组头（合成节点）不进"性质待补"**：它那四个性质是**按成员派生**的
        //   （人改不了它 —— 编辑弹窗不给这四格）。把组头列在这里，人就会去填**组头**
        //   那一格：填完当场看着变了，可下一次成员变化 / 重新导入 / 一键对齐会按成员重算走
        //   （实测：手填落在组头上的那两条，最后成了"手填成了孤儿"）。
        //   欠账本身是**成员**的 ⇒ 让成员那一条去承担。
        if (isSynthesisNode(node)) continue;
        const st = natureStatusOf(node);
        if (!st.participates) continue;
        const item = {
            id,
            type: String(node.type || ''),
            name: String(node.name || ''),
            cls: normalizeNatureValue('natureClass', node.natureClass),
            year: normalizeNatureValue('natureYear', node.natureYear),
            season: normalizeNatureValue('natureSeason', node.natureSeason),
            region: normalizeNatureValue('natureRegion', node.natureRegion),
            // ★ 分类的**依据强度**（`A`…`E`；没有依据信息 ⇒ `''`）。
            //   来源是元列 `分类依据`（爬虫写的规则 id → `core/natureConfidence.js` 查表），
            //   人改过分类的节点由 `core/ops/node.js` 清成空 ⇒ **空 = 人填的/老数据**，
            //   所以按"依据弱"筛的时候它**不该**混进来（人填的恰恰是最可信的那一类）。
            level: classLevelOf(node),
            rule: classRuleOf(node),
            missing: st.missing,
            filled: st.missing.length === 0
        };
        (st.missing.length ? pending : filled).push(item);
    }
    const byTree = (a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0);
    pending.sort(byTree);
    filled.sort(byTree);
    return { pending, filled: opts.includeFilled ? filled : [] };
}

/**
 * 年份的排序键：`20xx` 按**数**排 → 词表外/手误的写法按字典序 → **空（年份未知）排最后**。
 *
 * "是不是一个 20xx"只问唯一入口 `isRealYear()`（`^20\d{2}$`）——
 * 这里不自己 `new RegExp`：年份的格式口径只有一处（`core/natureFields.js`）。
 * ⚠️ 用 `isRealYear` 而**不是** `isNatureYear`：后者连 `待同步` / `不确定` 也算合法
 *    （它们是"处理过了、还没定"，存得进去），但 `Number('待同步')` 是 `NaN`，
 *    混进数字序里会让整段的排序变成未定义行为 ⇒ 那两个值走下面的字典序档。
 * 为什么不用字符串排：`'26'` / `'2026年'` 这类写法混在里面时，
 * 字符串序会把它们插到 `'2024'` 前面，看起来像"年份倒着排"。
 */
function yearSortKey(year) {
    const s = String(year === undefined || year === null ? '' : year).trim();
    if (!s) return [2, 0, ''];                       // 年份未知：永远最后
    if (isRealYear(s)) return [0, Number(s), s];     // 20xx：按数排
    return [1, 0, s];                                // 别的写法（含「待同步」）：字典序，排在 20xx 之后
}

function cmpYear(a, b) {
    const x = yearSortKey(a);
    const y = yearSortKey(b);
    if (x[0] !== y[0]) return x[0] - y[0];
    if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
    return x[2] < y[2] ? -1 : (x[2] > y[2] ? 1 : 0);
}

/**
 * 按 **`分类 + 赛季`** 分组（赛季为空的那批自成一组，标题上写「赛季未知」）。
 *
 * ⚠️ **分组看的是「赛季」（`natureSeason`），不是「年份（举办）」** —— 用户 2026-10-07：
 *    "把 `.2023` 改为 `.2023赛季` 即可"。理由是**分组键（`planKeyOf`）用的就是赛季**：
 *    ③ 这一栏按赛季切，看到的切片才和"判重里怎么分组"对得上（年份那一格不参与算键）。
 *    每行自己的「年份」仍然照旧显示在行里（四个小标签），一个字都不少。
 *
 * 组的顺序：分类按 **Trie 的书写顺序**（注册表里 `classTrie` 的先后；不在注册表里的路径排最后
 * 按字典序），组内按赛季升序、赛季未知的最后。组里的条目保持传入顺序
 * （`collectNaturePendingItems` 给的是树序）。
 *
 * ⚠️ `main` 就是**整条分类路径**（不是第一段）：`xcpc/icpc` 与 `xcpc/ccpc` 是两组。
 *    `mainLabel` 由 `natureLabel('natureClass', …)` 给出（`a / b` 显示），空 → `没标分类`。
 *
 * @param {Array} items - `collectNaturePendingItems()` 的结果
 * @returns {Array<{main:string, mainLabel:string, season:string, items:Array}>}
 */
export function groupNaturePending(items) {
    const groups = new Map();
    for (const it of (Array.isArray(items) ? items : [])) {
        if (!it) continue;
        const key = `${it.cls}\u0000${it.season}`;
        if (!groups.has(key)) {
            groups.set(key, {
                main: it.cls,
                mainLabel: classLabel(it.cls) || NATURE_NO_MAIN_LABEL,
                season: it.season,
                items: []
            });
        }
        groups.get(key).items.push(it);
    }
    const rank = new Map(CLASS_PATHS.map((p, i) => [p.value, i]));
    const mainRank = main => (rank.has(main) ? rank.get(main) : CLASS_PATHS.length);
    return [...groups.values()].sort((a, b) =>
        (mainRank(a.main) - mainRank(b.main))
        || (a.main < b.main ? -1 : (a.main > b.main ? 1 : 0))
        || cmpYear(a.season, b.season));
}

// ================================================================
// ② 推荐成员（**只推荐，不写**）
// ================================================================

/**
 * 整理页的**候选推荐**：某个还没归入的原料"该归入哪个合成节点"。
 *
 * 两种建议（`suggestSynthId` 非空与否）：
 *   · `suggestSynthId` 非空 → **归入**这个已有的合成节点（`suggestKey` = 它的标识）；
 *   · `suggestSynthId` 为空 → 和另一个同样没归属的原料**新建一个合成节点**一起归入
 *     （`b` 就是那个同伴，`suggestKey` 是"新建时建议用的标识"）。
 *
 * 三条**永远成立**的判据（与模式无关）：
 *   · **同一个父节点**（跨系列的两个同名比赛不是一回事）；
 *   · **类型相同**（平台与系列名字像纯属噪声，见 similarity.js 的同类注释）；
 *   · **跨性质不建议**（`natureComboOf(a).matches(b)`）。
 *
 * 再按 `mode` 决定"什么算等价"：
 *   · `strict`（**默认**）：只认**机器可判定**的信号 —— 双方 `problemId` 都非空且
 *     相同，**或**归一化标题完全相同（见 `SUGGEST_REASON`）。相似度**不参与**。
 *     量化依据：松散口径在 xcpc 上出 1,829 条、随机抽 30 条 30/30 都不是同一题 ⇒
 *     精度 ≈ 0；硬门槛把它压到个位数（不为了"看起来有用"放宽它）。
 *   · `similar`：只出相似度建议 —— 它是**回归锚**，
 *     以及给"我知道自己在看什么"的使用者一个显式开关。
 *   · `all`：两者都出（页面上的「同时显示相似度建议」）。
 *
 * ⚠️ 合成节点**不会被推荐**（不参与"被别人绑定"），W/S 节点也不参与。
 *
 * ⚠️ **性能**：相似度那条路两两比是 O(n²)，2 万节点实测 18 秒。所以分三层挡：
 *   ① 先按 (父, 类型) 分桶 —— 跨父的本来就不比；
 *   ② 桶内再按 `blockingKey`（标题前 1 个 token）分块 —— 只有同块才两两比；
 *   ③ **总量预算** `MAX_TOTAL_PAIRS`：花完之后的块退化成"归一化标题完全相同"配对（O(n)）。
 *   被 ③ 挡下的块会出现在 `truncated` 里，页面如实告诉用户"这部分只按同名配了"。
 *   ★ **硬门槛那条路不两两比**（键完全相同 ⇒ 哈希分组 O(n)），所以它既不需要预算，
 *     也不会被预算挡掉 —— 值得信的那几条永远不会因为性能闸门消失。
 *
 * 推荐出来的 `suggestKey` 只是**建议**，不是判定 —— 用户点了「归入」才写数据。
 *
 * @param {Object} nodes - `state.nodes`
 * @param {Object} parentOf - `state.parentOf`
 * @param {Object} [opts]
 * @param {number} [opts.threshold] - 只对 `similar` / `all` 模式有意义
 * @param {number} [opts.maxPairs] - 覆盖总量预算（测试用；只挡住相似度那条路）
 * @param {string} [opts.mode] - `strict`（默认，**硬门槛**：只出机器可判定的等价信号）
 *        / `similar`（只出相似度建议 —— 回归锚）/ `all`（两者都出）。
 *        布尔开关 `strict:false` 等价于 `mode:'similar'`（兼容别名）。
 * @param {Object} [opts.filter] - 节点级筛选（`emptyDedupFilter()` 的形状）。
 *        ⚠️ 只作用在**原料端点**上：合成节点是组头、通常没有 nature，
 *        拿 nature 去筛它会把所有"建议归入"整片抹掉（那是错的）。
 * @param {Set<string>} [opts.scopeIds] - `scopeNodeIds()` 的结果；`null`/省略 = 不限制
 * @returns {{candidates:Array<{a:string,b:string,score:number,suggestSynthId:string,
 *                             suggestKey:string,reason:string,evidence:string}>,
 *            truncated:Array<{parent:string,type:string,size:number}>}}
 *          candidates 按 **依据可信度**（problemId > 标题完全相同 > 相似度）
 *          再按 score 降序
 */
export function suggestMembers(nodes, parentOf, opts = {}) {
    const mode = resolveSuggestMode(opts);
    const useStrict = mode === 'strict' || mode === 'all';
    const useSimilar = mode === 'similar' || mode === 'all';
    const threshold = (typeof opts.threshold === 'number' && Number.isFinite(opts.threshold))
        ? opts.threshold
        : DEFAULT_SIMILARITY_THRESHOLD;
    const maxPairs = (typeof opts.maxPairs === 'number' && Number.isFinite(opts.maxPairs))
        ? opts.maxPairs
        : MAX_TOTAL_PAIRS;
    const filter = opts.filter || null;
    const scopeIds = (opts.scopeIds instanceof Set) ? opts.scopeIds : null;

    const all = nodes || {};
    // 目标侧：合成标识 → 节点 id（只认 C/P/R 的合成节点）
    const synthByKey = new Map();
    for (const id of Object.keys(all)) {
        const node = all[id];
        if (!isSynthesisNode(node) || !isSynthType(node.type)) continue;
        if (!synthByKey.has(synthKeyOfNode(node))) synthByKey.set(synthKeyOfNode(node), id);
    }
    // 候选 = 原料（**默认只取还没归属的**；`owned:'any'` 才把已归入的也放进来 ——
    // 那是"核对已绑好的组有没有绑错"的用法，用户要显式选）。
    const includeOwned = !!(filter && filter.owned === 'any');
    const candidatesOf = Object.keys(all)
        .filter(id => isMaterialCandidate(all[id]) && (includeOwned || !ownerOfNode(all[id])));

    // ① 同父同类型才比。原料与合成节点各自入桶：
    //    原料之间比出"该和谁一起新建"，原料对合成节点比出"该归入哪个"。
    const buckets = new Map();
    const bucketOf = (parent, type) => {
        const k = `${parent}\u0000${type}`;
        if (!buckets.has(k)) buckets.set(k, { materials: [], synths: [] });
        return buckets.get(k);
    };
    for (const id of candidatesOf) {
        const node = all[id];
        bucketOf((parentOf && parentOf[id]) || '', node.type || '').materials.push(id);
    }
    for (const sId of synthByKey.values()) {
        const node = all[sId];
        bucketOf((parentOf && parentOf[sId]) || '', node.type || '').synths.push(sId);
    }

    // 配对闸门（**唯一一处**）：范围 → 节点级筛选（只对原料）→ **跨性质不建议**。
    const ctx = {
        all,
        filter,
        scopeIds,
        synthIdOf(key) { return synthByKey.get(String(key || '')) || ''; },
        /** 原料端点过不过（范围 + 节点级筛选） */
        okMaterial(id) {
            const node = all[id];
            if (!node) return false;
            if (scopeIds && !scopeIds.has(id)) return false;
            return filter ? matchesDedupFilter(node, filter) : true;
        },
        /** 合成节点端点：只受范围约束（见 opts.filter 的注释） */
        okSynth(id) {
            if (!all[id]) return false;
            return !scopeIds || scopeIds.has(id);
        },
        /** "两边都非空才比" —— 跨性质的一律不建议（核心口径） */
        natureOk(aId, bId) {
            return natureComboOf(all[aId]).matches(all[bId]);
        }
    };

    const candidates = [];
    const truncated = [];
    let budget = maxPairs;
    for (const [bucketKey, bucket] of buckets) {
        const [parent, type] = bucketKey.split('\u0000');

        // ★ 硬门槛这条路**不两两比**：它要的就是"键完全相同"，天然是哈希分组 O(n)。
        //   所以它既没有阻塞键分块，也不受总量预算影响 —— 可信信号一条都不会被预算挡掉。
        if (useStrict) collectStrictPairs(candidates, ctx, bucket.materials, bucket.synths);
        if (!useSimilar) continue;

        // ② 桶内按阻塞键分块（原料一块、合成节点一块 —— 它们各自两两比没有意义）
        const blocks = new Map();
        for (const id of bucket.materials) {
            if (!ctx.okMaterial(id)) continue;
            const key = blockingKey(all[id].name);
            // 没有可用 token 的（空名字）只能丢弃：没法和谁比
            if (!key) continue;
            if (!blocks.has(key)) blocks.set(key, { materials: [], synths: [] });
            blocks.get(key).materials.push(id);
        }
        for (const id of bucket.synths) {
            if (!ctx.okSynth(id)) continue;
            const key = blockingKey(all[id].name);
            if (!key) continue;
            if (!blocks.has(key)) blocks.set(key, { materials: [], synths: [] });
            blocks.get(key).synths.push(id);
        }

        for (const block of blocks.values()) {
            // 预算按**两两比的总对数**算：原料×原料 + 原料×合成节点。
            // 同块的合成节点与所有未归入原料都要比一次（"归入哪个"就靠它）。
            const m = block.materials.length;
            const s = block.synths.length;
            const pairCount = m * (m - 1) / 2 + m * s;
            if (pairCount > budget) {
                // ③ 预算不够：退化成"同名配对"（O(n)，不漏掉最强的信号）
                truncated.push({ parent, type, size: m + s });
                addSameNamePairs(candidates, ctx, block.materials, block.synths);
                continue;
            }
            budget -= pairCount;

            for (let i = 0; i < m; i++) {
                const aId = block.materials[i];
                const a = all[aId];
                // 归入**已有的**合成节点（同块 = 同父 + 同类型 + 同阻塞键）
                for (const sId of block.synths) {
                    if (!ctx.natureOk(aId, sId)) continue;
                    const score = titleSimilarity(a.name, all[sId].name);
                    if (score < threshold) continue;
                    if (differsOnlyByNumbers(a.name, all[sId].name)) continue;
                    pushJoin(candidates, ctx, aId, sId, score, SUGGEST_REASON.SIMILAR, '');
                }
                // 和另一个原料一起（新建 / 归入对方所在组，见 emitNewGroupPair）
                for (let j = i + 1; j < m; j++) {
                    const bId = block.materials[j];
                    if (!ctx.natureOk(aId, bId)) continue;
                    const b = all[bId];
                    const score = titleSimilarity(a.name, b.name);
                    if (score < threshold) continue;
                    if (differsOnlyByNumbers(a.name, b.name)) continue;
                    emitNewGroupPair(candidates, ctx, aId, bId, score, SUGGEST_REASON.SIMILAR, '');
                }
            }
        }
    }

    candidates.sort((x, y) => (REASON_RANK[x.reason] - REASON_RANK[y.reason])
        || (y.score - x.score) || (x.a < y.a ? -1 : 1));
    return { candidates: dedupCandidates(candidates), truncated };
}

/**
 * 同一对、同一个写入目标**只留一条**（排序之后保留第一条 ⇒ 可信的依据优先）。
 *
 * 为什么需要：`mode:'all'` 下"硬门槛"与"相似度"两条路都会跑到同一对
 * （标题完全相同的两对，相似度必然是 1）—— 不在这里合并，页面上就会出现
 * 两条一模一样的建议。
 */
function dedupCandidates(list) {
    const seen = new Set();
    const out = [];
    for (const c of list) {
        const sig = `${c.a}\u0000${c.b}\u0000${c.suggestSynthId}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(c);
    }
    return out;
}

/** 解析建议模式（`opts.mode` 优先；旧布尔开关 `strict:false` 是 `similar` 的别名） */
function resolveSuggestMode(opts) {
    const m = String((opts && opts.mode) || '');
    if (DEDUP_SUGGEST_MODES.includes(m)) return m;
    if (opts && opts.strict === false) return 'similar';
    return 'strict';
}

/**
 * **硬门槛**那条路：把一批原料与一批合成节点按"机器可判定的键"分组再配对。
 *
 * 两个键（沿用 `strictKeysOf`）：`problemId` 非空且相同 / 归一化标题完全相同。
 * 复杂度 **O(原料数 + 合成节点数 + 组内成员数)** —— 没有两两比、没有预算，
 * 所以"值得信的那几条"永远不会被性能闸门吃掉。
 *
 * 原料×原料用**星形**配对（`组内第一个` × 其余）：与旧退化路径 `addSameNamePairs`
 * 同一口径 —— 组里有 N 个时出 N-1 条，不是一个真组出 C(N,2) 条把人淹掉。
 */
function collectStrictPairs(sink, ctx, materials, synths) {
    const all = ctx.all;
    /** key → {reason, evidence, mats:[], syns:[]} */
    const byKey = new Map();
    const put = (id, kind) => {
        for (const k of strictKeysOf(all[id])) {
            let entry = byKey.get(k.key);
            if (!entry) {
                entry = { reason: k.reason, evidence: k.evidence, mats: [], syns: [] };
                byKey.set(k.key, entry);
            }
            entry[kind].push(id);
        }
    };
    for (const id of materials) if (ctx.okMaterial(id)) put(id, 'mats');
    for (const id of synths) if (ctx.okSynth(id)) put(id, 'syns');

    // 同一对可能被两个键各命中一次（题号相同 + 标题也完全相同）—— 只出一条
    const seen = new Set();
    const firstTime = (x, y) => {
        const sig = x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    };
    const out = [];
    for (const entry of byKey.values()) {
        // ⚠️ "标题完全相同"这个信号在**同父且题号都非空但不同**时无效 —— 那是**两道不同的官方题**
        //    恰好同名。实测：`arc120:F` 与 `arc120:F2` 的 `name` 都是 "Wine Thief"，
        //    但 AtCoder 官方明说它们"题面相同、约束与时限不同"（是两个独立 task）。
        //    `problemId` 是权威的题号，只要两边都填了，就以它为准。
        const titleOnly = entry.reason === SUGGEST_REASON.SAME_TITLE;
        // 原料 × 合成节点 → 建议**归入**它
        for (const sId of entry.syns) {
            for (const aId of entry.mats) {
                if (titleOnly && differByProblemId(all, aId, sId)) continue;
                if (!ctx.natureOk(aId, sId)) continue;
                if (!firstTime(aId, sId)) continue;
                pushJoin(out, ctx, aId, sId, 1, entry.reason, entry.evidence);
            }
        }
        // 原料 × 原料 → 建议**新建一个合成节点**把它们一起归入（星形）
        const anchor = entry.mats[0];
        if (!anchor) continue;
        for (let i = 1; i < entry.mats.length; i++) {
            const bId = entry.mats[i];
            if (titleOnly && differByProblemId(all, anchor, bId)) continue;
            if (!ctx.natureOk(anchor, bId)) continue;
            if (!firstTime(anchor, bId)) continue;
            emitNewGroupPair(out, ctx, anchor, bId, 1, entry.reason, entry.evidence);
        }
    }
    // ⚠️ **最后再去一次重**：`emitNewGroupPair` 会把"一边已归入"的那对改写成
    //    一条**归入**建议（目标变成那一组的组头），于是它可能与上面
    //    "原料 × 合成节点"那条撞成同一条。按键一 + 键二两条路各命中一次也会撞。
    //    判据 = 写什么 + 写给谁 + 依据，三者全同就是同一条建议。
    const dedup = new Set();
    for (const c of out) {
        const sig = `${c.a}\u0000${c.b}\u0000${c.suggestSynthId}\u0000${c.reason}`;
        if (dedup.has(sig)) continue;
        dedup.add(sig);
        sink.push(c);
    }
}

/**
 * 硬门槛的两个键（**都要求非空** —— "没填"不是"相同"）。
 * 返回的 `key` 带前缀，避免"题号恰好等于标题"时两个维度撞车。
 */
function strictKeysOf(node) {
    const keys = [];
    const title = normalizeTitle(node && node.name);
    if (title) {
        keys.push({
            reason: SUGGEST_REASON.SAME_TITLE,
            key: 'T\u0000' + title,
            evidence: title
        });
    }
    const pid = problemIdOf(node);
    if (pid) {
        keys.push({
            reason: SUGGEST_REASON.PROBLEM_ID,
            key: 'I\u0000' + pid,
            evidence: pid
        });
    }
    return keys;
}

/**
 * 退化路径（相似度那条路预算花完时用，O(n)）：**归一化标题完全相同**的才配对。
 *
 * 两条都做，因为"同名"本来就是最强信号：
 *   · 原料 × 同名的**合成节点** → 建议归入它；
 *   · 原料 × 同名的**另一个原料** → 建议新建一个合成节点一起归入。
 *
 * ⚠️ 范围 / 节点级筛选在入块前就过掉了，这里只补 **nature 闸门**。
 */
function addSameNamePairs(out, ctx, materials, synths) {
    const nodes = ctx.all;
    const synthByName = new Map();
    for (const id of synths) {
        const nk = normalizeTitle(nodes[id].name);
        if (!nk) continue;
        if (!synthByName.has(nk)) synthByName.set(nk, []);
        synthByName.get(nk).push(id);
    }
    const byName = new Map();
    for (const id of materials) {
        const nk = normalizeTitle(nodes[id].name);
        if (!nk) continue;
        if (!byName.has(nk)) byName.set(nk, []);
        byName.get(nk).push(id);
    }
    for (const [nk, ids] of byName) {
        for (const sId of (synthByName.get(nk) || [])) {
            if (!ctx.natureOk(ids[0], sId)) continue;
            pushJoin(out, ctx, ids[0], sId, 1, SUGGEST_REASON.SAME_TITLE, nk);
        }
        for (let i = 1; i < ids.length; i++) {
            if (!ctx.natureOk(ids[0], ids[i])) continue;
            emitNewGroupPair(out, ctx, ids[0], ids[i], 1, SUGGEST_REASON.SAME_TITLE, nk);
        }
    }
}

/**
 * 一条「归入已有合成节点」的建议（`a` 是原料，`b` 是合成节点）。
 *
 * **只为"还没归入"的原料产生建议** —— 已归入的原料怎么写由「核对」那块
 * （抽查 / 解绑）负责，这里不替它出主意。`owned:'any'` 放它们进来只是为了
 * 让它们当**对照物**（见 `emitNewGroupPair`）。
 */
function pushJoin(out, ctx, aId, sId, score, reason, evidence) {
    const a = ctx.all[aId];
    if (ownerOfNode(a)) return;                 // 已归入：不在这里出建议
    const target = ctx.all[sId];
    if (!target) return;
    out.push({
        a: aId,
        b: sId,
        score,
        suggestSynthId: sId,
        suggestKey: synthKeyOfNode(target),
        reason: reason || SUGGEST_REASON.SIMILAR,
        evidence: evidence || ''
    });
}

/**
 * 一条「原料 × 原料」的建议 —— 按**归入状态**分流（`owned:'any'` 的关键口径）：
 *   · 两边都没归入 → 建议**新建一个合成节点**把它们一起归入；
 *   · 一边已归入       → 建议把**还没归入**的那边，归入已归入那一边**所在的组**
 *                        （"这边这份和那组里的是同一个东西"）；
 *   · 两边都已归入     → **不产生建议**（那两组各归各的，动不动是核对的事）。
 *
 * 默认（`owned:'unowned'`）下第二个分支不可能走到。
 */
function emitNewGroupPair(out, ctx, aId, bId, score, reason, evidence) {
    const a = ctx.all[aId];
    const b = ctx.all[bId];
    const ownA = ownerOfNode(a);
    const ownB = ownerOfNode(b);
    if (ownA && ownB) return;
    if (ownA) {
        const target = ctx.synthIdOf(ownA);
        if (target) pushJoin(out, ctx, bId, target, score, reason, evidence);
        return;
    }
    if (ownB) {
        const target = ctx.synthIdOf(ownB);
        if (target) pushJoin(out, ctx, aId, target, score, reason, evidence);
        return;
    }
    out.push({
        a: aId,
        b: bId,
        score,
        suggestSynthId: '',
        // 建议的**显示标识**：先有的那个非空 extKey（通常是权威来源的 slug），
        // 没有就留空 —— 页面会用自动标识（`synth:N`），绝不拿它当判定。
        suggestKey: String(a.extKey || b.extKey || '').trim(),
        reason: reason || SUGGEST_REASON.SIMILAR,
        evidence: evidence || ''
    });
}
