// ================================================================
// 导入计划的**准备与读值**（features/AutoImport/plan/prepare.js）
//
// 这一段是"把 crate 的记录归一化、逐字段映射、读出链接类别与来源"——**纯函数、无状态**，
// 和"编排"（buildPlan）不是一件事。
// ================================================================
import { LINK_KIND_PRIORITY } from '../../../core/linkKinds.js';
import { OWNER_FIELD, SYNTH_KEY_FIELD, normalizeSynthKey } from '../../../core/ops/synth.js';
import { RESERVED_KEYS } from '../fieldmap.js';
import { TYPE_CHILDREN_MAP } from '../../../core/model/constants.js';
import { classRulesOf } from '../../../core/natureConfidence.js';
import { sameNatureValue } from '../../../core/synthPlan.js';
import { computeMerge } from '../merge.js';

// ⚠️ `type` 已经在 `RESERVED_KEYS` 里 —— 这里只是给它起个本模块用的名字
export const STRUCTURAL_KEYS = RESERVED_KEYS;

export const NATURE_DIFF_KEYS = Object.freeze([
    'natureClass', 'natureYear', 'natureSeason', 'natureRegion'
]);

export const trimOf = v => String(v === undefined || v === null ? '' : v).trim();

/**
 * **包里的性质判定 vs 树上已有的值** —— 逐字段列出「不一致」的那些。
 *
 * 性质四字段的导入策略是 **fill-if-empty**（人手填过的值不该被一次重导冲掉），
 * 于是"包里判成 `xcpc/icpc/ec/regional`、树上写着 `xcpc/icpc`"这种事**悄悄地不发生** ——
 * 用户既不知道有差异、也不知道树上的值已经旧了。这里把它**报出来**（不自动改）。
 *
 * ⚠️ **只报"两边都非空且不同"**：
 *   · 树上是空的、包里判出来了 ⇒ 那是**正常的补全**（导入会写），不是差异；
 *   · 包里没带这个字段 ⇒ 没意见，不算差异。
 *
 * ⚠️ **"不同"的判据不是裸串比** —— 分类这一维交给 `core/synthPlan.js` 的 `sameNatureValue`。
 *   为什么：**分类只差镜像前缀不算不同**（`qoj/xcpc/…` / `cf/gyms/xcpc/…` 与 `xcpc/…`
 *   指的是同一件事，由 `sameNatureValue` 里的 `bareClass` 去前缀判定）。这条口径在仓里
 *   **只有这一份实现**，另三处消费者早就这么判（`core/synthConflicts.js` 的「组头待同步」、
 *   `core/ops/synth.js` 的 `syncHeadNature`、`scripts/synth-bind.mjs` 的产包侧收敛）——
 *   这里原先自己写了一份裸串比，于是**只有这一处口径分叉**：真包 27408 条 dry-run 里，
 *   树上组头按本口径算有 50 处 / 50 个组头报不一致，**全部是 `natureClass`、且去前缀后逐字相同**
 *   （裸串比那一份是 96 处 / 95 个组头）⇒ 预览那句「🧬 性质不一致 N 条」里绝大部分是噪声。
 *   ⇒ 口径统一后，只有"去前缀后仍不同"的才算差异（`natureChanged` / `natureForced`
 *     的计数口径本身没动，仍然是"有几条记录有差异" / "有几处会被覆盖"）。
 *
 * @returns {Array<{field:string, oldValue:string, newValue:string, rule:string}>} 空的表示一致
 */

export function natureDiffOf(incoming, existing, raw) {
    if (!existing || !incoming || typeof incoming !== 'object') return [];
    const rules = classRulesOf(raw);
    const out = [];
    for (const field of NATURE_DIFF_KEYS) {
        const nextValue = incoming[field];
        if (nextValue === undefined) continue;
        const before = trimOf(existing[field]);
        const after = trimOf(nextValue);
        if (!before || !after) continue;                       // 空的一律不算差异（补全 / 没意见）
        // ★ 分类走共用口径（镜像前缀容忍）；其余三维逐字比（`sameNatureValue` 内部也是这么分的）
        if (sameNatureValue(field, existing, nextValue)) continue;
        // `rule` = 包里这条分类是**哪条规则**判出来的（有就带上：界面能顺带说"它凭什么"）
        out.push({ field, oldValue: before, newValue: after, rule: rules[field] || '' });
    }
    return out;
}


/** 统一入口：带上结构键黑名单 */

export function mapRecord(applyFieldMap, record, fieldMap) {
    return applyFieldMap(record, fieldMap, { reservedKeys: STRUCTURAL_KEYS });
}

/**
 * 生成导入计划（纯函数，不写状态）
 *
 * @param {Object} params
 * @param {Object} params.crate - parseCrate 产出的 crate
 * @param {Object} params.state - AppState（只读）
 * @param {Object<string,string>} params.keyIndex - extKey → nodeId（buildExtKeyIndex）
 * @param {Function} [params.applyFieldMap] - (record, fieldMap) => {fields, ignored, unmapped}
 *        （由 parse 层注入，避免本模块直接依赖 fieldmap 的实现细节）
 * @param {number} [params.similarityThreshold]
 * @param {boolean} [params.forceNature=false] - 「以包里为准」：把"包里非空、与树上不同"的
 *        性质字段真的写进去（默认只报不改）。预览里那个开关就是它 —— 会**重算计划**。
 * @returns {{
 *   records: Array<Object>,
 *   summary: { total:number, create:number, update:number, skip:number, reject:number,
 *              warnings:number, errors:number, unusedColumns:string[], natureChanged:number,
 *              synthCreate:number, synthUpdate:number, synthNodes:number, synthSkip:number,
 *              pointerSet:number, pointerRejected:number, pointerDangling:number },
 *   warnings: Array<Object>,
 *   errors: Array<Object>,
 *   synth: { nodes:Array<Object>, pointers:Array<Object>, createdKeys:string[], knownKeys:string[] },
 *   crate: Object
 * }}
 */

export function normalizeKey(value) {
    if (value === undefined || value === null) return '';
    return String(value).trim();
}

// ================================================================
// 合成：两阶段解析（packages 可以带合成节点与成员指针）
// ================================================================

/**
 * 把幸存记录预处理成「身份三件套 + 映射后的字段」。
 *
 * 关键动作：把 `synthKey` / `ownerSynth` 从**普通字段**里摘出来。
 * 为什么必须摘：
 *   1. 它们是**结构**（全局一份），不是"某账户在某渠道看到的值" ⇒ 不能进
 *      `computeMerge` / `recordIncoming`，否则来源层里会多出这两个字段的条目
 *      （口径：绝不能让 `ownerSynth` 变成一条账户级的 manual 来源）；
 *   2. 它们的写入口径是**两阶段**（先建合成节点、再落指针），与逐字段策略不是一套。
 */

export function prepareRecords(ordered, applyFieldMap, fieldMap) {
    const out = [];
    for (const rec of ordered) {
        const mapped = mapRecord(applyFieldMap, rec.raw, fieldMap);
        const fields = (mapped && mapped.fields) ? mapped.fields : {};
        // 身份来源有两处：parse 层归一化的 `rec.synthKey`，或 fieldMap 映射到内部名
        // `synthKey` 的列（手写包/测试直接给内部名时走这条）。
        const synthKey = normalizeSynthKey(rec.synthKey || fields[SYNTH_KEY_FIELD]);
        const ownerSynth = normalizeSynthKey(fields[OWNER_FIELD]);
        delete fields[SYNTH_KEY_FIELD];
        delete fields[OWNER_FIELD];
        out.push({
            rec,
            mapped,
            extKey: normalizeKey(rec.extKey),
            synthKey,
            ownerSynth,
            // 父引用的两种写法（resolve.js 已裁定"恰好给一个"并归一化）：
            //   · parentExtKey   父是普通节点
            //   · parentSynthKey 父是合成节点（执行层按它解析父节点 id）
            parentExtKey: normalizeKey(rec.parentExtKey),
            parentSynthKey: normalizeKey(rec.parentSynthKey),
            error: false
        });
    }
    return out;
}

/**
 * **第一阶段**：合成节点记录 → 执行清单（新建 / 更新 / 跳过）。
 *
 * 合成节点就是一个真节点（挂父容器下、有名字），只是多了身份 `synthKey`：
 *   · 树上按 `synthKey` 认人（不是 extKey —— 它没有 extKey）；
 *   · 包里新建的标识**当场登记**进 `knownSynthKeys`，于是同一次导入的成员指针
 *     不会被误判成悬空（§6.3 第 8 条）。
 *
 * 这里还做**父容器预检**（判据唯一一份：`TYPE_CHILDREN_MAP`）——
 * 两条都在**计划阶段**逐条拒绝，绝不留到执行时才失败
 * （否则预览算"新建 N"、结果逐条失败：用户看到的预览与结果不符）：
 *   ① 合成节点**必须**显式给父容器（两种父引用都留空 = 想挂根，而根 O 只允许 W/S，
 *      合成节点只能是 C/P/R ⇒ 永远放不下）；
 *   ② 父容器的**类型**必须允许这个子节点。
 * 预检在第二趟做，用的表是"本包会建出来的合成标识 → 类型"（第一趟的产物），
 * 因此包里"子写在父前面"也不影响判定。
 * ⚠️ 两条都**只管合成节点**：普通记录不给父引用 = 挂真实根，仍然合法（3.3）。
 *
 * @returns {Array<Object>} 执行清单（**只含真的建得出来的那些**）
 */

export function mappedAll(ordered, applyFieldMap, fieldMap) {
    const out = [];
    for (const rec of ordered) {
        const mapped = mapRecord(applyFieldMap, rec.raw, fieldMap);
        out.push(...(mapped.unmapped || []));
    }
    return out;
}

export function collectUnused(columns) {
    const set = new Set();
    for (const c of columns) if (c) set.add(c);
    return [...set].sort();
}

/**
 * 建立「父 extKey → 该父下节点的展示信息」映射，供相似度警告使用。
 * 只收集写题目类节点（P），因为相似度是针对题名的。
 */

export function collectSiblingMap(state, index) {
    const map = new Map();
    if (!state || !state.nodes || !state.childOrder) return map;

    // extKey → nodeId 反查，用于算出每个节点的父 extKey
    const keyOfId = new Map();
    for (const k of Object.keys(index)) keyOfId.set(index[k], k);

    for (const id of Object.keys(state.nodes)) {
        const node = state.nodes[id];
        if (!node || node.type !== 'P') continue;
        const parentId = state.parentOf ? state.parentOf[id] : null;
        if (!parentId) continue;
        const parentKey = keyOfId.get(parentId);
        if (parentKey === undefined) continue;   // 父节点没有 extKey → 无法参与比对
        if (!map.has(parentKey)) map.set(parentKey, []);
        map.get(parentKey).push({
            extKey: normalizeKey(node.extKey),
            fields: { name: node.name, problemId: node.problemId }
        });
    }
    return map;
}

// ================================================================
// 逐字段来源
// ================================================================

/**
 * 读一条记录上的 `字段来源` 元列，并把它按 fieldMap 映射成**内部字段名**。
 *
 * 背景：`crate-merge` 把多个来源的片段合成一个包时，会用这个元列记下
 * "每个字段最后是谁给的"（`{ 列名: 来源id }`）。没有它，整包只能共用一个来源，
 * 界面上就会出现"ratio 与 name 都来自『合并自 3 个包』"这种没用的出处。
 *
 * ⚠️ 用同一套 `mapRecord`/`fieldMap` 做映射，避免"列名 → 内部名"的规则写两遍。
 *
 * @param {Object} raw 原始记录
 * @param {Object} fieldMap
 * @param {Function} applyFieldMap
 * @param {Function} mapRecord
 * @returns {Object|null} `{ 内部字段名: 来源id }`；没有这一列时返回 null
 */
/**
 * 读合并包带的元列 `其它来源值`：`{ 列名: [{ v, src }] }` → `{ 内部字段: [{ v, src }] }`。
 *
 * 为什么要有它：同字段多个来源各说各话时，合并产物只保留一个值（先到先得），
 * 其余的值如果就此丢掉，应用的来源层就永远看不到"第二个链接/第二个题名"。
 * 这里把它们按**各自来源**传下去，`apply.js` 逐值写进来源层（不进缓存字段）。
 *
 * 与 `readFieldSources` 同一套路：列名先过 fieldMap 映射成内部字段名。
 */

export function readOtherValues(raw, fieldMap, applyFieldMap, mapRecord) {
    const src = raw && typeof raw === 'object' ? raw['其它来源值'] : null;
    if (!src || typeof src !== 'object') return null;
    const out = {};
    for (const col of Object.keys(src)) {
        const list = Array.isArray(src[col]) ? src[col] : [];
        const field = mapRecord(applyFieldMap, { [col]: '' }, fieldMap);
        const internal = (field && field.fields) ? Object.keys(field.fields)[0] : '';
        if (!internal) continue;
        const items = list
            .filter(x => x && x.src && x.v !== undefined && x.v !== null && x.v !== '')
            .map(x => ({ v: x.v, src: String(x.src) }));
        if (items.length) out[internal] = items;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * 读元列 `链接分类`：`{ 类别: [{ v, src }] }`（C 节点专用）。
 *
 * 爬取层**只记录、不取舍** —— 同一个类别有几条就全在这儿；这里不做任何选择。
 *
 * ⚠️ **形状是唯一的一种，由产出点保证**（`scripts/crate.py` 的 `Crate._add` →
 * `_normalize_link_kinds`：裸 URL 也会被补成 `{v, src}`，出处缺省用包来源 id）。
 * 所以这里**不需要**"两种形状都认"、"出处回落"那种容错 ——
 * 口径："数据处理的逻辑中一个特判都没有"。
 * （hdu/nk 不走 `crate-merge`，形状不一致时读取端若靠补丁兜着就容易自己出 bug ——
 *   把没 `src` 的条目整批丢掉。**归一要在产出点做。**）
 *
 * @returns {Object|null} `{ problems: [{v, src}], board: […], repo: […], unknown: […] }`
 */

export function readLinkKinds(raw) {
    const src = raw && typeof raw === 'object' ? raw['链接分类'] : null;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    const out = {};
    for (const kind of Object.keys(src)) {
        const items = (Array.isArray(src[kind]) ? src[kind] : [])
            .filter(x => x && String(x.v || '').trim() !== '' && x.src)
            .map(x => ({ v: String(x.v), src: String(x.src) }));
        if (items.length) out[kind] = items;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * **应用层**的取舍规则（**唯一一处**）——从分类里挑出"缓存值"那一条。
 *
 * **所有类别的链接都进 `link` 一个字段**。
 * 按类别优先级取第一条，保证"有补题入口时 `link` 就是补题链接"这个口径不变，
 * 而没有补题的场次也不会空着（退到榜单 → 仓库 → 其它）。
 *
 * 同类别有多条时取第一条（合并层给的顺序 = 来源顺序，是稳定的）。
 *
 * @returns {{v:string, src:string, kind:string}|null}
 */

export function pickLink(linkKinds) {
    if (!linkKinds) return null;
    for (const kind of LINK_KIND_PRIORITY) {
        const list = linkKinds[kind];
        if (list && list.length) return { v: list[0].v, src: list[0].src, kind };
    }
    return null;
}

/** 选中的值也要有出处（`字段来源` 那一列里没有它，因为爬取层没写 `link` 列） */

export function withPickedSource(fieldSources, pickedLink) {
    if (!pickedLink) return fieldSources;
    return { ...(fieldSources || {}), link: pickedLink.src };
}

/**
 * `链接分类` 里**没被选中**的候选，全部并进"落选值"（带 `linkKind`）。
 *
 * 为什么必须带上：口径是"数据爬取部分不应该有『存在多值时排除一些值』
 * 的逻辑"，且"「仓库」与「未知」两类也应在非空时显示" —— 它们没有独立字段，
 * 就靠这条路径进来源层（`apply.js` 逐值写入），界面按类别分组显示。
 *
 * ⚠️ 顺序很重要：`apply.js` 先把 `rec.fields` 里的"选中值"写进来源层，
 *    再写这些落选值；投影规则是"同分先到者胜"（`trust.js` 的 `isBetter`），
 *    所以落选值**不会**把选中值顶掉。
 */

export function mergeLinkKindOthers(otherValues, linkKinds, pickedLink) {
    if (!linkKinds) return otherValues;
    const out = otherValues ? { ...otherValues } : {};
    const isPicked = item => pickedLink && pickedLink.v === item.v && pickedLink.src === item.src;
    for (const kind of Object.keys(linkKinds)) {
        for (const item of linkKinds[kind]) {
            if (isPicked(item)) continue;                     // 选中值不算落选
            if (!out.link) out.link = [];
            if (!out.link.some(x => x.v === item.v && x.src === item.src)) {
                out.link.push({ v: item.v, src: item.src, linkKind: kind });
            }
        }
    }
    return Object.keys(out).length ? out : null;
}

export function readFieldSources(raw, fieldMap, applyFieldMap, mapRecord) {
    const src = raw && typeof raw === 'object' ? raw['字段来源'] : null;
    if (!src || typeof src !== 'object') return null;
    const pseudo = {};
    for (const col of Object.keys(src)) {
        if (src[col] === undefined || src[col] === null) continue;
        pseudo[col] = String(src[col]);
    }
    if (Object.keys(pseudo).length === 0) return null;
    const mapped = mapRecord(applyFieldMap, pseudo, fieldMap);
    const out = (mapped && mapped.fields) ? mapped.fields : {};
    return Object.keys(out).length ? out : null;
}
