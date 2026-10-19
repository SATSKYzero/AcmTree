// ================================================================
// 多来源投影（core/trust.js）
//
// 职责：**同一个字段有多个来源值**时，选出"当前值"，并给出**人话理由**。
// 依赖：无（纯函数，不碰 DOM / 不读全局状态），可在 Node 测试里直接引用。
//
// 依据：投影规则
//
// 为什么要有它
// ------------
// 字段只留了"值"就会丢掉"谁给的"：
//   那场 XCPC 的 A 题 ratio，PTA 说 4.61%、rankland 说 4.60%（它的 rows 被裁剪过），
//   而界面里只显示 4.61，既看不出还有另一种说法，也说不出为什么信它。
// 把来源留下来之后，就必须回答"当前显示哪一个"—— 本模块就是那条规则，
// 而且**必须能解释**（`reason` 是给界面直接显示的，不是给日志看的）。
//
// 与缓存字段的关系
// ----------------
// 投影值是**缓存字段**：`node.name` 仍然是一个字符串，调用方一行不用改；
// 来源层放在 `node.values.name`（数组）。投影算完写回 `node.name`。
// 所以本模块是纯函数，不负责写回 —— 写回由 ops 层唯一的写入口做。
// ================================================================
import {
    normalizeFieldValue,
    isEmptyFieldValue,
    fieldValueKey,
    formatFieldValue
} from './model/elements.js';
import { srcLabel } from './sourceLabel.js';

// ---- 来源类别（决定"客观vs主观"的大方向）----
export const SOURCE_KINDS = {
    MANUAL: 'manual',     // 你手改的
    BOARD: 'board',       // 权威榜单（一场比赛以它为准）
    SCRIPT: 'script',     // 脚本抓来的
    DERIVED: 'derived'    // 我们自己算出来的
};

/**
 * **来源类别 → 等级**（同类之内的先后；跨类还是看 `categoryRank`）。
 *
 * 这几个数字**只能有一份**：散在多处各写一遍时，**其中一处改了另两处不知道**，
 * 症状就是"手改不再优先""权威榜单被脚本压掉"这类**静默压错值**。
 * 现在只有这一份，别处一律 import。
 *
 * 值本身不动（改了会变投影结果）：`manual 100 > board 30 > script 20 > derived 10`。
 * ⚠️ 唯一**故意不同**的是 `fieldValue.js` 里"迁移带入、不知原始出处"的那份（rank 90）——
 * 它要**低于"你手改的"**、**高于**任何抓来的，所以不能直接用 `manual` 的 100。
 */
export const KIND_RANK = Object.freeze({
    [SOURCE_KINDS.MANUAL]: 100,
    [SOURCE_KINDS.BOARD]: 30,
    [SOURCE_KINDS.SCRIPT]: 20,
    [SOURCE_KINDS.DERIVED]: 10
});

/** 合法的来源类别名单（从 `KIND_RANK` 派生 —— 白名单与等级表**不可能再漂**） */
export const VALID_SOURCE_KINDS = Object.freeze(Object.keys(KIND_RANK));

/**
 * **来源级等级覆盖**：同一个 `kind`（类别）**之内**谁更权威。
 *
 * 病根（2026-10-16，用户："按道理，xcpcio/rankland/pta 优先于 cf，因为基本就是前者现场、
 * 后者混非正式"）：`rank` 原先在两处写入口（`features/AutoImport/apply.js` 与
 * `core/fieldValue.js` 的回填）都是**机械地** `KIND_RANK[kind]` ⇒ 同一类别里所有来源的等级
 * 恒等 ⇒ `score()` 的第 4 位永远分不出胜负，于是"CF gym 榜"和"现场权威榜"同为 board 时
 * 只能接着比 `at`（谁抓得新谁赢）。**类别不新增**（用户："没说要分"），只在类别内部排序。
 *
 * 为什么必须放**读侧**（而不是改来源注册时写进去的那个值）：来源注册表是**写一次的**
 * ——`apply.js` 只在某个 src **首次**出现时写 kind/rank ⇒ 已有库里那 50 个 `cf-*`
 * 永远停在 board/30，重导包也不更新。放读侧 ⇒ 改完刷新即生效，不必清库。
 *
 * ⚠️ 命中即**压过**注册表里的 rank（与"来源注册表是写一次的"同一个理由）。
 * ⚠️ 与 `categoryRank` **不许互相矛盾**：任何 board 的等级必须 > 任何 script 的等级，
 *    任何 script 必须 > 任何 derived（守卫 `src/test/sourceReportRanks.test.js` 正反各验一遍）。
 * ⚠️ 模式写法复用 `matchesPattern`（`'cf-*'` = 前缀），不另造一套匹配。
 *
 * ★ **这里只写"偏离类别默认"的那些档次**（2026-10-16 定，用户："按你说的来"）。全表三档：
 *   · **30｜现场/官方榜**：`xcpcio-*`、`pta-*`、`rankland-index-*`(榜角色)、`srk-*`(榜角色)
 *     —— 就是 `KIND_RANK.board`，**不写进本表**（写了等于第二份真源）；
 *   · **25｜榜但混了非正式**：本表那两条（CF gym 榜混 VP；牛客榜是多校/重现）；
 *   · **20｜脚本/补充**：`cf-titles-*`/`cf-web-*`/`cf-contest`、`qoj`、`atcoder`、`nk-scraper`、
 *     `hdu-scraper`、`rankland-refs-*`、`rankland-index-*`(titles 角色)、`synth`… —— 也是类别默认。
 *   ⚠️ **不要在 20 档内部再分先后**：脚本之间几乎从不撞同一格（① 不同树 ② 包内每格只有一个来源，
 *     实测"同一格两个来源"= **0**）⇒ 细分只增加永久维护成本；真撞上时由 `at` + 手改兜底。
 */
export const SOURCE_RANK = Object.freeze([
    // 按**类别**分档：`cf-titles-*` / `cf-web-*` / `cf-contest` 本来就是 script，不受影响。
    ['cf-*', SOURCE_KINDS.BOARD, 25],   // CF gym 榜：混 VP/非正式
    ['nk-*', SOURCE_KINDS.BOARD, 25]    // 牛客榜：多校/重现赛（含打星、VP；`nk-scraper` 是 script，不受影响）
]);

/**
 * 这个来源在这一类别下的**覆盖等级**（没命中返回 `null` = 沿用注册表那份）。
 * @param {string} src 来源 id（`cf-ccpc2024ladies` / `xcpcio-bjcpc2024`…）
 * @param {string} kind 它的类别（注册表给的；覆盖表按类别分档）
 * @returns {number|null}
 */
export function sourceRankOf(src, kind) {
    const s = String(src || '');
    const k = String(kind || '');
    for (const [pattern, kindHit, rank] of SOURCE_RANK) {
        if (kindHit === k && matchesPattern(s, pattern)) return rank;
    }
    return null;
}

/**
 * 来源 id → 投影用的元信息 `{ kind, rank }`（**唯一一份**）。
 *
 * 两个消费者：`usableValues`（值级投影）与 `core/groupValue.js` 的"组值按来源权威挑"。
 * 类别归属（注册表 kind）与**来源级覆盖**（`SOURCE_RANK`）都在这里收口 ——
 * 散成两份的话，"cf 榜到底是哪一档"会出现两个答案。
 *
 * @param {string} src
 * @param {object} trust 优先级配置（缺项回落默认）
 * @returns {{kind:string, rank:number}}
 */
export function sourceMetaOf(src, trust) {
    return metaOfNormalized(String(src || ''), normalizeTrust(trust));
}

/** `sourceMetaOf` 的内核（调用方已经归一化过配置时用，省一次 `normalizeTrust`） */
function metaOfNormalized(src, t) {
    const meta = t.sources[src] || {};
    const kind = meta.kind || SOURCE_KINDS.SCRIPT;
    // 来源级覆盖（`SOURCE_RANK`）优先于注册表那份：同类之内的先后由它说话
    const over = sourceRankOf(src, kind);
    return { kind, rank: over === null ? (typeof meta.rank === 'number' ? meta.rank : 0) : over };
}

/**
 * 一个候选值的**排序键**（越靠前越优先）：手改 > 字段偏好 > 类别序 > 来源等级。
 *
 * `projectField`（值级投影，之后才比 `at`）与 `core/groupValue.js` 的"组值按来源权威挑"
 * **共用这一份** —— "哪个来源更权威"只许一处实现，否则组值与值级会各判各的。
 *
 * ⚠️ `cand.kind` 给**空串** = "说不出出处"（值层里没有对应来源条目）⇒
 *    `categoryIndex` 认不出来 ⇒ 排在最后（比 `derived` 还后）。
 *
 * @param {string} field
 * @param {{src:string, kind:string, rank:number}} cand
 * @param {object} trust
 * @returns {number[]} 逐位比较的键（`projectField` 里比完这几位再比 `at`）
 */
export function candidateScore(field, cand, trust) {
    return scoreNormalized(field, cand, normalizeTrust(trust));
}

/** `candidateScore` 的内核（调用方已归一化配置时用；`projectField` 走这条热路） */
function scoreNormalized(field, cand, t) {
    const prefers = preferList(field, t);
    const prefHit = prefers.some(p => matchesPattern(cand.src, p)) ? 1 : 0;
    const manual = cand.kind === SOURCE_KINDS.MANUAL ? 1 : 0;
    const cat = -categoryIndex(cand.kind, t.categoryRank);
    return [manual, prefHit, cat, cand.rank];
}

/**
 * 默认优先级配置。
 *
 * ⚠️ 用户可改：`sourceRank` / `fieldPrefer` 都由设置界面写入。
 * `categoryRank` 顺序是**语义**（手改 > 权威榜单 > 脚本 > 派生），不开放给用户乱改，
 * 否则会出现"一个抓来的值盖掉你自己填的值"这种事。
 */
export const DEFAULT_TRUST = Object.freeze({
    categoryRank: [SOURCE_KINDS.MANUAL, SOURCE_KINDS.BOARD, SOURCE_KINDS.SCRIPT, SOURCE_KINDS.DERIVED],
    /** srcId → { kind, rank }：来源注册表里与"信任"有关的部分 */
    sources: {},
    /** 字段 → 偏好的来源（srcId 或前缀模式，如 'pta:*'）；命中即插队 */
    fieldPrefer: {}
});

const EMPTY_REASON = '没有来源值';

/**
 * srcId 是否命中偏好项（支持 `pta:*` 这种前缀写法）。
 * 导出给界面复用（来源面板要标"已经是首选"）—— 同一套匹配规则只此一处。
 */
export function matchesPattern(src, pattern) {
    const s = String(src || '');
    const p = String(pattern || '');
    if (!p) return false;
    if (p.endsWith('*')) return s.startsWith(p.slice(0, -1));
    return s === p;
}

/** 归一化配置：缺项一律回落到默认值（调用方可以只给一半） */
export function normalizeTrust(trust) {
    const t = trust && typeof trust === 'object' ? trust : {};
    return {
        categoryRank: Array.isArray(t.categoryRank) && t.categoryRank.length
            ? t.categoryRank.slice()
            : DEFAULT_TRUST.categoryRank.slice(),
        sources: (t.sources && typeof t.sources === 'object') ? t.sources : {},
        fieldPrefer: (t.fieldPrefer && typeof t.fieldPrefer === 'object') ? t.fieldPrefer : {},
        // **字段组偏好**（"这一组显示哪个成员"，如 `数值难度` → `atcoderDifficulty`）。
        // ⚠️ 归一化是**白名单式构造**，漏一个键 = 用户设完偏好刷新就没了（同 `fieldPrefer` 的教训）。
        groupPrefer: (t.groupPrefer && typeof t.groupPrefer === 'object') ? t.groupPrefer : {}
    };
}

/**
 * 值是不是"真的空"。
 *
 * ⚠️ `'-'` **不算空** —— 它是数据里一个**有意义的标记**（R.status / P.xcpcDifficulty
 * 的"未填写"）。若把它当空，投影结果会从 `'-'` 变成 `''`，界面就从"未填写"
 * 变成"什么都没有"，是行为变化。
 *
 * 空值不参与投影：否则一个低优先级来源的空白会把真正有内容的值盖掉。
 */
export function isEmptyValue(v) {
    if (v === null || v === undefined) return true;
    return String(v).trim() === '';
}

/**
 * 挑出可用值（过滤失效、空值，以及**别的账户的值**），并补上从注册表查到的 kind / rank。
 *
 * 账户层：值可以带 `account`（以谁的名义记的），
 * `account` 空 = 与任何账户无关（客观）。投影候选 = **本次范围里的账户值** ∪ 客观值；
 * 范围外的账户值不参与投影（但仍留在 stored 里可查）。
 *
 * 范围为**集合**（见 `resolveScope`）—— 单账户是"一个元素的集合"，
 * 一队 3 人并排看就是"三个元素的集合"，同一套规则。
 * **活跃账户**：传了 `accounts`（`state.accounts`）时，
 * **非活跃账户**的值一律不参与投影（"停用"= 看不到它的信息）；账户表里没有的
 * 悬空 id（删掉的账户）同样不参与。
 * ⚠️ 什么都不传（老调用方）时**不过滤**。
 *
 * @param {{viewingAccount?: string, scopeAccounts?: string[], accounts?: Object}} [opts]
 * @returns {Array<{v:string|string[], src:string, at:string, account:string, kind:string, rank:number}>}
 */
/**
 * 归一化"投影范围"。
 *
 * 为什么是**集合**而不是单个账户：方向是"渲染时全走投影"，
 * 而其中一个动机就是**同一屏要看多个账户**（例：一队 3 人各自的补题情况）。
 * 单账户只是集合里只有一个元素 —— 一套规则，两种用法。
 *
 * 三种输入：
 *   - 都不传        → `null`（**不过滤**）
 *   - `viewingAccount: 'k1'`（老调用方）→ `{'k1'}`
 *   - `scopeAccounts: []` → 空集合 = **只看客观值**（不看任何账户的私有值）
 *
 * @returns {Set<string>|null}
 */
/**
 * 「查看范围要不要带上**直接子账户**」—— 设置项 `settings.scopeMergeChildren`（默认 `false` = 原逻辑）。
 *
 * 用户 2026-10-13 定的口径：这件事**做成一个选项、与原逻辑并列**（全局设置，不是无条件生效）。
 * 唯一一处读它（别在各调用点自己 `!!settings.xxx`）。
 */
export function mergeChildrenOf(settings) {
    return !!(settings && settings.scopeMergeChildren);
}

/**
 * **查看范围里的账户**（`v9.1.23`，用户 2026-10-13）。
 *
 * 开关**关**（默认）⇒ `[本账户]`（**与改前逐字相同**）；
 * 开关**开** ⇒ `[本账户, ...它的直接子账户]`。
 * 为什么（用户原话）："把账户的**子账户**机制用起来，`status2` 的 own 值取本账号与所有子账户的合并结果"；
 * 并明确 **"不用递归，下层直接算就行"** ⇒ **只看直接子账户**，不往子孙里走。
 *
 * 谁在用：**两个构造口都调它这一份**（别各写一遍）——
 *   · `core/trust.js:resolveScope`（`viewingAccount` 那一支：值级面板 / 详页 / 写路径）；
 *   · `view/scope.js:scopeOpts`（`scopeAccounts` 那一支：树上与统计的显示路径）。
 * ⚠️ 那些传 `viewingAccount` 的调用点**必须把 `settings` 一起传下去**（`resolveScope` 从 `opts.settings` 读开关），
 *    否则会出现"树上算进去了、值级面板不认"的分叉。
 *
 * ⚠️ 停用的子账户**照样进集合**：它的值本来就会被"活跃账户"那道过滤挡掉
 *    （`core/fieldValue.js:explainField` 的 `keepInactive`），放进集合不会让它冒出来。
 *
 * @param {string} viewingAccount
 * @param {Object} [accounts] `state.accounts`
 * @param {boolean} [mergeChildren] 开关（`mergeChildrenOf(settings)`）
 * @returns {string[]} 本账户在头（顺序稳定 ⇒ 记忆化键稳定）
 */
export function scopeAccountsFor(viewingAccount, accounts, mergeChildren = false) {
    const me = (viewingAccount === undefined || viewingAccount === null) ? '' : String(viewingAccount);
    if (!me) return [];
    const out = [me];
    if (!mergeChildren) return out;
    const table = (accounts && typeof accounts === 'object') ? accounts : null;
    const kids = table && table[me] ? table[me].children : null;
    if (Array.isArray(kids)) {
        for (const k of kids) {
            const id = (k === undefined || k === null) ? '' : String(k);
            if (id && id !== me && !out.includes(id)) out.push(id);
        }
    }
    return out;
}

export function resolveScope(opts = {}) {
    const o = opts || {};
    if (Array.isArray(o.scopeAccounts)) {
        return new Set(o.scopeAccounts.filter(x => x !== undefined && x !== null).map(String));
    }
    if (o.viewingAccount !== undefined && o.viewingAccount !== null && o.viewingAccount !== '') {
        // ★ 本账户（+ 开关开着时的直接子账户）—— 唯一一份规则：`scopeAccountsFor`
        return new Set(scopeAccountsFor(o.viewingAccount, o.accounts, mergeChildrenOf(o.settings)));
    }
    return null;
}

/**
 * 投影候选：按"范围"筛掉不属于本次查看的账户值，再按来源类别/等级/时间排序。
 * ...
 */
export function usableValues(field, values, trust, opts = {}) {
    const t = normalizeTrust(trust);
    const scope = resolveScope(opts);
    const accounts = (opts && opts.accounts && typeof opts.accounts === 'object') ? opts.accounts : null;
    const out = [];
    for (const item of Array.isArray(values) ? values : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.invalid) continue;                  // 来源撤回 / 你标了失效
        // 值的形状由 `core/model/elements.js` 的属性决定（标量 / 列表）
        const nv = normalizeFieldValue(field, item.v);
        if (isEmptyFieldValue(field, nv)) continue;
        const account = (item.account === undefined || item.account === null)
            ? '' : String(item.account);
        // 范围过滤 —— 空账户（客观）永远在候选里，除非调用方显式要求只看账户
        if (scope && account !== '' && !scope.has(account)) continue;
        if (accounts && account !== '') {
            const acc = accounts[account];
            // 停用的账户、以及**已经不在表里**的悬空 id，都不再参与投影
            if (!acc || acc.active === false) continue;
        }
        const src = String(item.src || '');
        const { kind, rank } = metaOfNormalized(src, t);
        out.push({
            v: nv,
            src,
            at: String(item.at || ''),
            account,
            kind,
            rank
        });
    }
    return out;
}

/** 类别序里的位置（越小越优先）；不认识的类别排最后 */
function categoryIndex(kind, categoryRank) {
    const i = categoryRank.indexOf(kind);
    return i < 0 ? categoryRank.length : i;
}

/** 该字段配置的偏好来源列表 */
function preferList(field, trust) {
    const v = normalizeTrust(trust).fieldPrefer[field];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}

/**
 * 投影：从多个来源值里选出**当前值**。
 *
 * 规则顺序：
 *   手改 > 字段级偏好 > 类别序（榜单>脚本>派生） > 来源等级 > 更新时间 > 先到
 *
 * @param {string} field 字段名（用于查 fieldPrefer 与生成理由）
 * @param {Array} values 来源值列表 `[{v, src, at, invalid?}]`
 * @param {object} [trust] 优先级配置（缺项回落默认）
 * @returns {{
 *   value: string,        // 投影值；**没有可用值时是 `''` 且 `empty === true`**
 *   src: string,          // 被采用的来源（无则 ''）
 *   reason: string,       // **人话理由**，界面直接显示
 *   empty: boolean,       // true = 这个字段一个可用来源值都没有
 *   all: Array            // 全部可用值，带 selected 标记（给"值级界面"用）
 * }}
 *
 * ⚠️ 调用方契约：`empty === true` 时**不要**把 `''` 写回缓存字段 ——
 * 那会把默认值（如 `'-'` / `TIME_PLACEHOLDER`）抹成空。保持原值不动即可。
 *
 * @param {{viewingAccount?: string}} [opts] 账户层：只考虑"当前在看的账户"与客观值
 */
export function projectField(field, values, trust, opts = {}) {
    const t = normalizeTrust(trust);
    const items = usableValues(field, values, t, opts);
    if (items.length === 0) {
        return { value: '', src: '', reason: EMPTY_REASON, empty: true, all: [] };
    }

    // 值相同 → 合并（"3 个来源说同一句话"不该刷屏），选用其中优先级最高的来源作为代表
    // 比较用 `fieldValueKey`（列表值按内容的 JSON 比），显示用 `formatFieldValue`
    const byValue = new Map();
    for (const item of items) {
        const k = fieldValueKey(field, item.v);
        if (!byValue.has(k)) byValue.set(k, []);
        byValue.get(k).push(item);
    }

    const score = (item) => scoreNormalized(field, item, t);
    /**
     * `a` 是否**严格优于** `b`。
     * 平手时返回 false —— 这样"先到者胜"，投影是稳定的（同分不会被后来的顶掉）。
     */
    const isBetter = (a, b) => {
        const sa = score(a);
        const sb = score(b);
        for (let i = 0; i < sa.length; i++) {
            if (sa[i] !== sb[i]) return sa[i] > sb[i];
        }
        const ta = a.at || '';
        const tb = b.at || '';
        if (ta !== tb) return ta > tb;   // 同分取更新时间新的（空时间排最后）
        return false;
    };

    // 每个不同值里挑一个代表
    const groups = [];
    for (const item of items) {
        const k = fieldValueKey(field, item.v);
        const group = groups.find(g => g.key === k);
        if (!group) {
            groups.push({ key: k, value: item.v, rep: item, members: [item] });
        } else {
            group.members.push(item);
            if (isBetter(item, group.rep)) group.rep = item;
        }
    }

    let chosen = groups[0];
    for (const g of groups) {
        if (isBetter(g.rep, chosen.rep)) chosen = g;
    }

    // ---- 人话理由 ----
    const members = chosen.members;
    let reason;
    const prefers = preferList(field, t);
    const prefMember = members.find(m => prefers.some(p => matchesPattern(m.src, p)));
    if (members.some(m => m.kind === SOURCE_KINDS.MANUAL)) {
        reason = '你手改的（永远优先）';
    } else if (prefMember) {
        reason = `你指定这个字段优先用 ${srcLabel(prefMember.src)}`;
    } else if (groups.length === 1 && members.length > 1) {
        // 大家说的都一样 —— 这时候"为什么选它"没有意义，别硬解释成"权威榜单优先"
        reason = `${members.length} 个来源一致`;
    } else if (groups.length === 1) {
        reason = '唯一来源';
    } else if (chosen.rep.kind === SOURCE_KINDS.BOARD) {
        reason = '权威榜单优先（这场以它为准）';
    } else {
        reason = `来源等级更高（${chosen.rep.rank}）`;
    }
    // 有分歧 → 把别的说法摆出来（**不隐藏**，这是投影的核心态度）
    const others = groups.filter(g => g !== chosen);
    if (others.length) {
        const text = others
            .map(g => `${g.members.map(m => srcLabel(m.src)).join('/')} 说 ${formatFieldValue(field, g.value)}`)
            .join('、');
        reason += `；另有 ${text}（未采用）`;
    }

    const chosenKey = fieldValueKey(field, chosen.value);
    return {
        value: chosen.value,
        src: chosen.rep.src,
        reason,
        empty: false,
        all: items.map(item => ({
            v: item.v,
            src: item.src,
            at: item.at,
            kind: item.kind,
            selected: fieldValueKey(field, item.v) === chosenKey
        }))
    };
}
