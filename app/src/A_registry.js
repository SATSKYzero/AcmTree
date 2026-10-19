// ================================================================
// 数据注册表（A_registry.js）
// 职责：**一张表**声明每个顶层字段算不算「用户数据」、存哪儿、怎么存
//
// `USER_FIELDS` 每行四件事：
//   store     走**独立的 IndexedDB store**（nodes / childOrder / pages），不进 meta 表
//   default   缺省值（老存档回填 / 空基线用）—— 只有进 meta 表的字段才有这一格
//   persist   要落 IndexedDB
//   export    要进「完整数据导出」包
//   snapshot  要进撤销快照
//
// 消费者**全部派生自这张表**（谁都不许再手写第二份"顶层字段名单"）：
//   落盘形状   persistence/index.js    captureRef / emptyRef / loadData
//   差分       persistence/diff.js     metaFields
//   导出包     persistence/index.js    buildExportData
//   导入通道   shell/executor.js       importState（`importedState`）
//   撤销       transaction/history.js  captureState
//   脏标记     core/model/dirtyFlags.js  PERSIST_ROOTS / EXPORT_ROOTS
//
// 加一个顶层状态字段 = 这里加一行；忘了加 ⇒ `src/test/registryCoverage.test.js` 直接红。
// 名单漏一处 = 静默丢数据：手写投影还会把 `meta` 削成 `{ idCounter }`，
// 把 `synthKeyCounter` 丢在往返路上。
// ================================================================

/** 来源层 `trust` 的缺省值（老存档没有这一节时用它）。
 *  ⚠️ 这里**只有 `normalizeTrust` 认的那几个键** —— 例如 `mode` 全仓没人读它
 *  （`normalizeTrust` 是白名单式构造，连归一化都会把它丢掉）。 */
const TRUST_DEFAULT = {
    categoryRank: ['manual', 'board', 'script', 'derived'],
    sources: {},
    fieldPrefer: {}
};

export const USER_FIELDS = {
    // ── 树数据（各自有独立 store，不进 meta 表） ──
    'nodes':            { store: 'nodes',      persist: true,  export: true,  snapshot: true },
    'childOrder':       { store: 'childOrder', persist: true,  export: true,  snapshot: true },
    'pages':            { store: 'pages',      persist: true,  export: true,  snapshot: true },
    'parentOf':         { persist: false, export: false, snapshot: false },   // 由 childOrder 派生

    // ── meta store 里的用户数据（漏一个 = "刷新一次就没了"） ──
    'rootId':           { default: null,              persist: true, export: true,  snapshot: true },
    'settings':         { default: {},                persist: true, export: true,  snapshot: true },
    'meta':             { default: { idCounter: 0 },   persist: true, export: true,  snapshot: true },
    'currentPageId':    { default: 'main',            persist: true, export: true,  snapshot: true },
    'sources':          { default: {},                persist: true, export: true,  snapshot: true },
    'trust':            { default: TRUST_DEFAULT,     persist: true, export: true,  snapshot: true },
    'accounts':         { default: {},                persist: true, export: true,  snapshot: true },
    'currentAccountId': { default: '',                persist: true, export: true,  snapshot: true },
    'viewingAccountId': { default: '',                persist: true, export: true,  snapshot: true },
    'fieldRegistry':    { default: null,              persist: true, export: true,  snapshot: true },
    'reports':          { default: null,              persist: true, export: true,  snapshot: true },
    // ★ **训练计划**（设计稿 `docs/training-plan.md`）：`{ planId: {...} }`。
    //   放 meta 表（只有几条，不值得单开 store）；进导出包（用户 ⑦：包里存的是**形状**）。
    'plans':            { default: {},                persist: true, export: true,  snapshot: true },

    // ── 会话位置：落盘（下次打开还在这一页），但不进导出包、不进撤销 ──
    'currentTab':       { default: 'main',            persist: true, export: false, snapshot: false },

    // ── **视图态**：展开/页码/勾选这类"看的姿势"，**不住在 nodes 里** ──
    // 为什么单独一层：它们住在 `nodes` 里时，点一下折叠就会换掉 `nodes` 引用 ⇒
    //   所有按"数据引用"失效的缓存整片作废（实测：一次折叠要重算整份派生表 ~292ms）。
    // 所以它们**不落盘、不进导出、不进撤销**：折叠态的真源是 localStorage
    //   （`core/model/viewState.js`），重启后贴回来。
    'view':             { default: { expanded: {} },   persist: false, export: false, snapshot: false }
};

// ================================================================
// 不在 AppState 顶层、但同属"要存的数据"的字段
//
// ① infoState：会话层标记（core/model/infoState.js）。它是**单个对象**，
//    `persistence/index.js` 的 saveData 每次都整体写它，这里登记只为"脏标记别当它是新字段"。
// ② 历史栈：**声明已备、尚未接线** —— `transaction/history.js` 目前只活在内存里，
//    没有任何代码按这两行落盘（`setHistoryFromArray` 也还没有调用方）。
//    保留这两行是记录意图；真要接线时，这里就是落盘口径的唯一出处。
// ================================================================
export const SIDE_FIELDS = {
    'infoState.lastSaveTime':     { persist: true, export: false, snapshot: false },
    'infoState.lastModifiedTime': { persist: true, export: false, snapshot: false },
    'infoState.jsonIsSaved':      { persist: true, export: false, snapshot: false },
    'infoState.jsonLastSaveTime': { persist: true, export: false, snapshot: false },

    'Hisstate':                   { persist: true, export: false, snapshot: false, storageKey: 'history' },
    'HisCount':                   { persist: true, export: false, snapshot: false, storageKey: 'history' }
};

// ================================================================
// 派生查询（所有消费者只准用这些，不准自己遍历表）
// ================================================================

const keysWhere = (pred) => Object.keys(USER_FIELDS).filter(k => pred(USER_FIELDS[k]));

/** 进 meta store 的顶层键：`captureRef` / `emptyRef` / `loadData` / `diff.metaFields` 的形状 */
export const META_FIELD_KEYS = keysWhere(f => f.persist && !f.store);

/** 走独立 store 的顶层键（节点表 / 顺序表 / 副页表） */
export const STORE_FIELD_KEYS = keysWhere(f => f.store);

/** **会落盘**的顶层键（meta 表 + 三个 store 表）—— 导入通道要把它们全接住 */
export const PERSISTED_FIELD_KEYS = keysWhere(f => f.persist);

/** 进撤销快照的顶层键（`transaction/history.js` 的 captureState） */
export const SNAPSHOT_KEYS = keysWhere(f => f.snapshot);

/** 会影响导出的顶层键（导出包） */
export const EXPORT_KEYS = keysWhere(f => f.export);

const rootOf = (path) => path.split('.')[0];

/** 把字段路径收敛到顶层键：'meta.idCounter' → 'meta' */
const rootsOf = (paths) => new Set(paths.map(rootOf));

/** 会影响持久化存储的顶层字段（脏标记用） */
export const PERSIST_ROOTS = rootsOf([
    ...keysWhere(f => f.persist),
    ...Object.keys(SIDE_FIELDS).filter(k => SIDE_FIELDS[k].persist)
]);

/** 会影响导出文件的顶层字段（脏标记用） */
export const EXPORT_ROOTS = rootsOf([
    ...keysWhere(f => f.export),
    ...Object.keys(SIDE_FIELDS).filter(k => SIDE_FIELDS[k].export)
]);

/** 表里登记过的全部顶层字段 —— 不在其中的按"既落盘也导出"保守处理（见 dirtyFlags） */
export const REGISTERED_ROOTS = rootsOf([
    ...Object.keys(USER_FIELDS),
    ...Object.keys(SIDE_FIELDS)
]);

// ================================================================
// 落盘 / 导入 / 导出形状的取数函数（唯一出处，别再手写第二份名单）
// ================================================================

/** 深拷贝一份缺省值（对象每次都是新的，免得被就地改坏） */
function freshDefault(v) {
    if (v === null || typeof v !== 'object') return v;
    return JSON.parse(JSON.stringify(v));
}

/** meta 层每个键的缺省值（`emptyRef` 用：空引用的形状 = 全部缺省值） */
export function metaDefaults() {
    const out = {};
    for (const k of META_FIELD_KEYS) out[k] = freshDefault(USER_FIELDS[k].default);
    return out;
}

/** 从 state 里取出 meta 层字段（`captureRef` 用） */
export function pickMetaFields(state) {
    const out = {};
    for (const k of META_FIELD_KEYS) out[k] = state[k];
    return out;
}

/**
 * 从 IndexedDB meta store 的键值表回填（`loadData` 用）。
 * ⚠️ 老存档里没有的键 → 用缺省值；值写的是空串/0 这类假值也回落到缺省值。
 */
export function metaFieldsFrom(map) {
    const out = {};
    for (const k of META_FIELD_KEYS) out[k] = map[k] || freshDefault(USER_FIELDS[k].default);
    return out;
}

/**
 * 从**导入数据**拼出完整 state（`shell/executor.js` 的 importState 用）。
 *
 * 每个落盘字段走同一条规则：**文件里有就用文件的；没有（老存档缺这一节）就沿用本机现值；
 * 再没有就用缺省值**。名单派生自注册表 ⇒ 以后加一个落盘字段，导入通道**自动接住**
 * （手写键名单漏一个就是"文件里带着、导进来没有"，例如 `fieldRegistry`/`reports`）。
 *
 * ⚠️ 用 `||` 而不是 `??`：空串/0 这类假值也回落到本机现值。
 */
export function importedState(incoming, current) {
    const out = {};
    for (const k of PERSISTED_FIELD_KEYS) {
        out[k] = incoming[k] || current[k] || freshDefault(USER_FIELDS[k].default);
    }
    return out;
}

// ================================================================
// 路径工具
// ================================================================

/**
 * 按路径写入嵌套对象的字段（中间层级不存在则自动创建）
 * @param {Object} obj
 * @param {string} path
 * @param {*} value
 */
export function setByPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
    target[last] = value;
}
