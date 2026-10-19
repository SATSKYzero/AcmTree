// ================================================================
// 账户（映射）⇄ me.json 名册的换算（core/rosterAccounts.js）
//
// 方向：
//
//   "**绝对可信源是映射，在 AppState 里，me.json 本质上完全是映射的派生部分**，这样好些。"
//
// ⇒ 一份数据、两个方向：
//   · **真源** = `AppState.accounts[].mappings`（普通应用数据：ops 编辑、可撤销、随导出走、离线可用）；
//   · **派生** = `me.json` 的 `accounts[]`（爬虫要读的名册形状），由 `rosterAccountsFrom()` 算出来，
//     走设置页的「📤 写进 me.json」写出去（**只覆盖 `accounts` 那一节**，凭据/说明/current 不动）；
//   · 反方向（`accountOf` + `mappingsOfAccount`）留给"读回文件/一次性迁移"，两边**对得上**
//     （单测里有往返锚）。
//
// 纯函数、无副作用（可在 Node 单测里直接跑）。
// ================================================================
import { PLATFORM_CLUES, currentSeason } from './rosterMappings.js';
import { isPlainObject } from '../utils/guards.js';
import { isRealYear } from './natureFields.js';

/** 平台 → 账号（`accounts[]` 一项上除这些键之外的都当平台账号） */
const NON_PLATFORM_KEYS = new Set(['id', 'name', 'role', 'nature', 'active', 'children',
    'mappings', 'byYear', 'note', '_note',
    // 账户在应用里的**显示顺序**（app 侧字段，不是平台账号 —— 见 ops/account.js）
    'order']);

const s = (v) => (v === undefined || v === null ? '' : String(v)).trim();
/** 一项账户 → `{ id, name, nature, active, children, handles, byYear, mappings }` */
export function accountOf(item) {
    const handles = {};
    for (const key of Object.keys(isPlainObject(item) ? item : {})) {
        if (NON_PLATFORM_KEYS.has(key) || key.startsWith('_')) continue;
        const v = s(item[key]);
        if (v) handles[key] = v;
    }
    const byYear = {};
    if (isPlainObject(item && item.byYear)) {
        for (const [platform, years] of Object.entries(item.byYear)) {
            if (!isPlainObject(years)) continue;
            const clean = {};
            for (const [year, value] of Object.entries(years)) {
                if (s(value)) clean[s(year)] = s(value);
            }
            if (Object.keys(clean).length) byYear[s(platform)] = clean;
        }
    }
    return {
        id: s(item && item.id),
        name: s(item && item.name),
        nature: s(item && (item.nature || item.role)),
        active: !(item && item.active === false),
        children: Array.isArray(item && item.children) ? item.children.map(s).filter(Boolean) : [],
        handles,
        byYear,
        mappings: Array.isArray(item && item.mappings) ? item.mappings.filter(isPlainObject) : []
    };
}

/**
 * 一个账户**该有的**映射：账号推出来的 + 文件里写着的（显式）。
 *
 * ⚠️ 这正是"合并"的关键：`cf: "示例用户名"` 与 `cf : handle = 示例用户名` 是同一件事的两种写法，
 *    所以不需要"补映射"这个动作 —— 推出来的永远在，显式的那几条兜住推不出来的。
 *    **显式的优先**（先放前面，且去重时先到先得）。
 *
 * ⚠️ **带赛季平台（`season:'year'`：nk / hdu）的"裸账号"算本赛季**（
 *    "**多校都是有赛季的**" ⇒ `nk:"某用户名"` 就是 `nk:2026`、`hdu:"某队/teamA"` 就是
 *    `hdu:2026`）：多校的队名一年一换，所以这一格的含义本来就"是今年的"。
 *    想写明哪一年就写进 `byYear`（`{"nk": {"2026": "某用户名"}}`），那条更明确、两边都在。
 *    ⚠️ **赛季写四位年**（`nk:2026`）；
 *    抓取侧 `crate.season_of` 同样不截断。
 *    ⚠️ `pta` 的赛季是**命名空间**（`icpc2026`）⇒ 推不出来，只能靠显式 `mappings`。
 *
 * @param {Object} acc - `accountOf()` 的结果
 * @param {Date} [today] - "今年"是哪年（测试可注入）
 */
export function mappingsOfAccount(acc, today = new Date()) {
    const out = [];
    const seen = new Set();
    const push = (source, field, value) => {
        const key = `${s(source)}\u0000${s(field)}\u0000${s(value)}`;
        if (!s(source) || !s(field) || !s(value) || seen.has(key)) return;
        seen.add(key);
        out.push({ source: s(source), field: s(field), value: s(value) });
    };
    const season = currentSeason(today);
    for (const m of acc.mappings || []) push(m.source, m.field, m.value);      // 显式（含推不出的）
    for (const [platform, value] of Object.entries(acc.handles || {})) {
        const clue = PLATFORM_CLUES[platform];
        if (!clue) continue;
        if (clue.season === null) push(platform, clue.field, value);           // cf / qoj
        else if (clue.season === 'year') push(`${platform}:${season}`, clue.field, value);
        // `season: 'ns'`（pta）：命名空间推不出来 ⇒ 不推，靠显式 mappings
    }
    for (const [platform, years] of Object.entries(acc.byYear || {})) {
        const clue = PLATFORM_CLUES[platform];
        if (!clue) continue;
        for (const [year, value] of Object.entries(years)) {
            if (isRealYear(year)) push(`${platform}:${year}`, clue.field, value);
        }
    }
    return out;
}


/** 给界面用：这一项账户有哪些平台账号 / 历年名字（人类可读） */
export function describeAccount(acc) {
    const parts = Object.entries(acc.handles || {}).map(([p, v]) => `${p}=${v}`);
    for (const [platform, years] of Object.entries(acc.byYear || {})) {
        for (const [year, value] of Object.entries(years)) parts.push(`${platform}:${year}=${value}`);
    }
    return parts.join('、');
}

// ================================================================
// 反方向：**账户（映射）→ me.json 的账户项**
//
// 所以 `accounts[]` 那一节是**导出物**：从每个账户的 `mappings` 反推
//   · `cf : handle = X`      ⇒ `cf: "X"`（不带赛季的平台）
//   · `nk:2026 : 用户名 = X`  ⇒ `byYear: {"nk": {"2026": "X"}}`（赛季是**四位年**）
//   · `pta:icpc2026 : 队伍 = X`（命名空间，推不成年份）⇒ **原样留在 `mappings` 里**
// 名字/性质/停用/子账户也带上（爬虫侧 `handles()` 会跳过停用的）。
// ================================================================

/** 赛季串 → 四位年份：`2026` 原样；`26`（两位数）补成 `2026`；其它返回 '' */
function yearOfSeason(suffix) {
    const t = s(suffix);
    if (isRealYear(t)) return t;
    if (/^\d{2}$/.test(t)) return `20${t}`;
    return '';
}

/**
 * 应用账户表 → `me.json` 的 `accounts[]`（**导出方向**）。
 *
 * @param {Object} accounts - `AppState.accounts`
 * @param {{today?:Date, includeEmpty?:boolean}} [opts]
 *        `includeEmpty` 连"没有映射、也没有平台账号"的空账户也导出（默认不带 —— 导出了也没用）
 * @returns {Array<Object>}
 */
export function rosterAccountsFrom(accounts, opts = {}) {
    const list = isPlainObject(accounts) ? accounts : {};
    const out = [];
    for (const id of Object.keys(list)) {
        const acc = list[id];
        if (!isPlainObject(acc)) continue;
        const name = s(acc.name);
        if (!name) continue;
        const mappings = Array.isArray(acc.mappings) ? acc.mappings : [];
        if (!mappings.length && !opts.includeEmpty) continue;

        const item = { name };
        if (acc.id && acc.id !== `me_${name}`) item.id = s(acc.id);       // 带上 id：再读回来 id 不变
        if (s(acc.nature)) item.nature = s(acc.nature);
        // ★ **每个账户都写这一格**（用户 2026-10-15："每个账户都需要是否启用的信息"）：
        //   显式写出来最好核对，而且表单那边是"**整列都是布尔 ⇒ 给勾选框**"—— 全都不写就
        //   永远没有那一列（`meForm.js:boolKeysOf`）。两种写法 `accountOf()` 都认
        //   （只有 `item.active === false` 才算停用）。
        item.active = acc.active !== false;
        const children = (Array.isArray(acc.children) ? acc.children : [])
            .map((cid) => s(list[cid] && list[cid].name) || s(cid)).filter(Boolean);
        if (children.length) item.children = children;

        const handles = {};
        const byYear = {};
        const kept = [];
        for (const m of mappings) {
            const source = s(m && m.source);
            const field = s(m && m.field);
            const value = s(m && m.value);
            if (!source || !field || !value) continue;
            const clue = PLATFORM_CLUES[source];
            if (clue && clue.season === null) {                        // cf / qoj
                if (!handles[source]) handles[source] = value;
                else kept.push({ source, field, value });               // 同平台多条 ⇒ 剩下那条留着
                continue;
            }
            const [plat, suffix] = source.split(':');
            const seasoned = PLATFORM_CLUES[plat];
            const year = seasoned && seasoned.season === 'year' ? yearOfSeason(suffix) : '';
            if (year) {
                byYear[plat] = byYear[plat] || {};
                if (!byYear[plat][year]) byYear[plat][year] = value;
                else kept.push({ source, field, value });
                continue;
            }
            kept.push({ source, field, value });                        // 推不出来的（pta 等）原样留着
        }
        for (const [platform, value] of Object.entries(handles)) item[platform] = value;
        if (Object.keys(byYear).length) item.byYear = byYear;
        if (kept.length) item.mappings = kept;                          // ⚠️ 推不出来的映射一条不丢
        out.push(item);
    }
    return out;
}

// ================================================================
// 文档级的小改（账户编辑都落在 me.json 上；这些是**纯函数**，返回新 doc）
//
// ⚠️ 账户的"身份"是 **name**（文件里就是这么写的）⇒ 定位一律按名字。
//    应用那边用 id 引用账户，id 与名字的对照由投影维护（`accountsFromMe` 会沿用旧 id）。
// ================================================================

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 账户在文件里的下标（按 name） */
function indexOfName(accounts, name) {
    return accounts.findIndex((a) => isPlainObject(a) && s(a.name) === s(name));
}

/** 改一个账户（`patch` 里出现的键才改；`children`/`mappings` 整段替换）。没有这个账户 ⇒ 返回 null */
export function patchAccountInDoc(doc, name, patch = {}) {
    const src = isPlainObject(doc) ? clone(doc) : {};
    const accounts = Array.isArray(src.accounts) ? src.accounts : [];
    const i = indexOfName(accounts, name);
    if (i < 0) return null;
    const oldName = s(accounts[i].name);
    const next = { ...accounts[i] };
    for (const key of Object.keys(patch)) {
        const value = patch[key];
        if (value === undefined) continue;
        if (value === '') delete next[key];                       // 清空 = 删掉这个键
        else next[key] = value;
    }
    const newName = s(next.name);
    if (newName && newName !== oldName) {
        if (accounts.some((a, j) => j !== i && s(a.name) === newName)) return null;   // 重名 ⇒ 报错，别悄悄合并
        // ⚠️ 改名时 `current`/`viewing` 与别人的 `children` 也要跟着改（指针是按名字存的）
        for (const key of ['current', 'viewing']) {
            if (s(src[key]) === oldName) src[key] = newName;
        }
        for (const [j, other] of accounts.entries()) {
            if (j === i || !Array.isArray(other.children)) continue;
            other.children = other.children.map((c) => (s(c) === oldName ? newName : c));
        }
    }
    accounts[i] = next;
    src.accounts = accounts;
    return src;
}

/** 新建一个账户（重名 ⇒ 返回 null） */
export function addAccountToDoc(doc, item = {}) {
    const name = s(item.name);
    if (!name) return null;
    const src = isPlainObject(doc) ? clone(doc) : {};
    const accounts = Array.isArray(src.accounts) ? src.accounts : [];
    if (indexOfName(accounts, name) >= 0) return null;
    const clean = {};
    for (const [k, v] of Object.entries(item)) {
        if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
        clean[k] = v;
    }
    accounts.push(clean);
    src.accounts = accounts;
    // ⚠️ **不**把新账户设成 `current`：`current` 是"登录账户（我是谁）"，
    //    新建一个队友的账户不该把自己换掉（投影会兜到 `本机`）。
    return src;
}

/** 删掉一个账户（连带把别人的 `children` 与 `current`/`viewing` 里的指针摘掉） */
export function removeAccountFromDoc(doc, name) {
    const src = isPlainObject(doc) ? clone(doc) : {};
    const accounts = Array.isArray(src.accounts) ? src.accounts : [];
    const i = indexOfName(accounts, name);
    if (i < 0) return null;
    accounts.splice(i, 1);
    for (const other of accounts) {
        if (Array.isArray(other.children)) {
            other.children = other.children.filter((c) => s(c) !== s(name));
            if (!other.children.length) delete other.children;
        }
    }
    src.accounts = accounts;
    for (const key of ['current', 'viewing']) {
        if (s(src[key]) === s(name)) src[key] = s(accounts[0] && accounts[0].name);
    }
    return src;
}

/**
 * 把 `current` / `viewing` 指到某个账户（`which` = `'current'` | `'viewing'`）。
 *
 * ⚠️ 内置的「本机」账户**不在 me.json 里**（它是"没有任何账户信息"的兜底身份）⇒ 用字面量
 *    `"local"` 指它（应用侧 `applyRosterToState` 认这个标记）。写名字也行，但那人得在文件里。
 */
export function setCurrentInDoc(doc, name, which = 'current') {
    const src = isPlainObject(doc) ? clone(doc) : {};
    const accounts = Array.isArray(src.accounts) ? src.accounts : [];
    if (which !== 'current' && which !== 'viewing') return null;
    const ref = s(name);
    const isLocal = ref === 'local' || ref === '本机';
    if (!isLocal && indexOfName(accounts, ref) < 0) return null;
    src[which] = isLocal ? 'local' : ref;
    return src;
}

