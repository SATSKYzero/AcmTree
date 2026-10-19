import { isPlainObject } from '../../utils/guards.js';
import { str as s } from '../../utils/guards.js';
// ================================================================
// 账户注册表写操作（core/ops/account.js）
//
// 依据：账户维度
//
// 账户**不是树的节点**：它是一张顶层注册表（`state.accounts`）。
// 为什么：`extKey` 是**不可变身份**（导入后改一个字就分叉），
// 而账户的显示名、映射表会天天变 —— 把会变的东西塞进 extKey 是自找麻烦。
//
// 结构是 **DAG**（一个子账户可以有多个父），真源是 `children`，
// 父由全表反推。因此本模块里凡是"加一条边"都**必须**查环。
//
// 两个指针（都在 state 上、都持久化）：
//   - `currentAccountId` 登录账户：手改的值以谁的名义记（来源层的 `account`）
//   - `viewingAccountId` 在查看的账户：投影/筛选用谁的眼睛
//   `viewing ≠ current` ⇒ **手改禁止**（导入不禁，设置类操作不禁）。
//
// 依赖：无（纯函数 + draft 原地修改），可进 Node 单测。
// ================================================================

/** 默认账户 id：本机（永远存在、不可删） */
export const LOCAL_ACCOUNT_ID = 'local';

/** 账户 id 的字符表（小写字母 + 数字，肉眼好念、URL 好带） */
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 账户 id 长度 */
const ID_LENGTH = 12;

/**
 * 生成一个账户 id。
 *
 * ⚠️ 这是**机器本地标识**，不是名字：
 *   - 随机、生成后**永不改**（改名只动 `name`）；
 *   - 不用自增数字、不用用户名 —— 那两样都会在"合并两台机器"时撞车。
 * 用户看到的是 `name`（必要时带上 id 后 4 位，见 `accountLabel`）。
 *
 * @returns {string}
 */
export function newAccountId() {
    const bytes = new Uint8Array(ID_LENGTH);
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        // 兜底（老浏览器 / 极简测试环境）：不加密，只求不撞
        for (let i = 0; i < ID_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    let out = '';
    for (let i = 0; i < ID_LENGTH; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return out;
}

/** 是普通对象（非 null、非数组） *//** 取字符串并 trim *//** 账户表（永远返回对象；坏数据不炸） */
function accountsOf(state) {
    if (!isPlainObject(state.accounts)) state.accounts = {};
    return state.accounts;
}

// ================================================================
// 查询（全部只读，可以随便调）
// ================================================================

/** 账户是否存在 */
export function hasAccount(state, id) {
    return !!(state && isPlainObject(state.accounts) && state.accounts[id]);
}

/**
 * 账户是不是**活跃**的。
 *
 * 老数据没有 `active` 键 → 默认活跃；`local` **永远活跃**（它是"没有归属"的兜底身份，
 * 停用它等于把整个应用变成只读且无法手改）。
 */
export function isAccountActive(state, id) {
    if (!hasAccount(state, id)) return false;
    if (id === LOCAL_ACCOUNT_ID) return true;
    return state.accounts[id].active !== false;
}

/** 活跃账户 id（按名字排序） */
export function listActiveAccountIds(state) {
    return listAccountIds(state).filter(id => isAccountActive(state, id));
}

/**
 * 停用 / 启用一个账户。
 *
 * 语义（三条规则）：
 *   ① 只有活跃账户能作登录/查看 → 停用当前/正在查看的账户时，指针回落 `local`；
 *   ② 只有活跃账户参与归认 → 见 `core/accounts.js` 的 `resolveAccount`；
 *   ③ 字段来源不显示非活跃账户的信息 → 值**不删**，只是不再显示/不再参与投影。
 *
 * 停用≠删除：数据、映射、子账户关系都留着，随时可以启用回来。
 */
export function setAccountActive(draft, id, active) {
    assertManualEditAllowed(draft, '停用/启用账户');
    if (id === LOCAL_ACCOUNT_ID) throw new Error('默认账户「本机」永远是活跃的');
    const acc = accountsOf(draft)[id];
    if (!acc) throw new Error('账户不存在');
    acc.active = !!active;
    if (!active) {
        if (draft.currentAccountId === id) draft.currentAccountId = LOCAL_ACCOUNT_ID;
        if (draft.viewingAccountId === id) draft.viewingAccountId = LOCAL_ACCOUNT_ID;
    }
    return acc.active;
}

/**
 * 所有账户 id（**默认账户「本机」恒第一**，其余按 `order`，没 `order` 的再按名字）。
 *
 * **账户允许交换顺序**。
 *
 * ⚠️ **顺序存在哪儿**（定案）：挂在每一项账户上的 `order`（数字），而不是
 *    ① 另立一条 `state.accountOrder` —— 那要再走一遍"加顶层字段要动几处"的清单
 *       （持久化白名单 / diff / 导出 / 快照 / 测试），而账户表本来就**整份**持久化、
 *       导出、进快照 ⇒ 挂在项上就自动跟着走；
 *    ② "对象键序" —— 它**不是**能依赖的东西：本函数**按名字排序**，
 *       而且全数字的 id 会被 JS 按数值提前排。
 *    `order` 只在"移动"时**整列重排**（0..n-1），所以它永远是一份紧凑的序号；
 *    没写过 `order` 的老数据照旧按名字排（行为不变）。
 */
export function listAccountIds(state) {
    const acc = (state && isPlainObject(state.accounts)) ? state.accounts : {};
    const ids = Object.keys(acc);
    const rest = ids.filter((id) => id !== LOCAL_ACCOUNT_ID);
    rest.sort((a, b) => {
        const oa = orderOf(acc[a]);
        const ob = orderOf(acc[b]);
        if (oa !== ob) return oa - ob;
        const na = s(acc[a] && acc[a].name) || a;
        const nb = s(acc[b] && acc[b].name) || b;
        return na.localeCompare(nb, 'zh');
    });
    // 「本机」是"没有任何账户信息"的兜底身份，不是一个能被排序的人 ⇒ 永远排第一
    return ids.includes(LOCAL_ACCOUNT_ID) ? [LOCAL_ACCOUNT_ID, ...rest] : rest;
}

/** 这一项的 `order`（没写过 / 坏值 ⇒ 排在所有写过 `order` 的后面） */
function orderOf(acc) {
    const v = acc && acc.order;
    const n = Number(v);
    return (v === undefined || v === null || !Number.isFinite(n))
        ? Number.MAX_SAFE_INTEGER : n;
}

/**
 * 把某个账户**上移/下移一位**。
 *
 * - 默认账户「本机」不参与（它恒第一，见 `listAccountIds`）；
 * - 已经在头/尾 ⇒ 返回 `false`（不是错误，界面据此禁用箭头）；
 * - 移动后**整列重排 `order` = 0..n-1** ⇒ 老数据（没 `order`）一移就归一化，
 *   之后顺序与名字无关（改名不会再让它在列表里跳位）。
 *
 * @param {Object} draft
 * @param {string} id
 * @param {number} delta - 负数上移、正数下移（一般就是 ±1）
 * @returns {boolean} 真的动了没有
 */
export function moveAccount(draft, id, delta) {
    assertManualEditAllowed(draft, '调整账户顺序');
    const acc = accountsOf(draft);
    if (!acc[id]) throw new Error('账户不存在');
    if (id === LOCAL_ACCOUNT_ID) return false;
    const ids = listAccountIds(draft);
    const from = ids.indexOf(id);
    const to = from + (delta < 0 ? -1 : 1);
    // ⚠️ 「本机」恒在 ids[0]（见 `listAccountIds`）⇒ 谁都不许与它交换（`lo` = 可动的最小下标）
    const lo = ids[0] === LOCAL_ACCOUNT_ID ? 1 : 0;
    if (from < lo || to < lo || to >= ids.length) return false;
    const next = ids.slice();
    [next[from], next[to]] = [next[to], next[from]];
    next.forEach((aid, i) => { if (acc[aid]) acc[aid].order = i; });
    return true;
}

/** 展示名：`名字 #后4位`（同名账户靠这 4 位区分） */
export function accountLabel(state, id) {
    if (!id) return '（无）';
    const acc = state && isPlainObject(state.accounts) ? state.accounts[id] : null;
    const name = acc ? (s(acc.name) || id) : id;
    return `${name} #${String(id).slice(-4)}`;
}

/** 展示名（不带 id 后缀，用于句子中间） */
export function accountName(state, id) {
    const acc = state && isPlainObject(state.accounts) ? state.accounts[id] : null;
    return acc ? (s(acc.name) || id) : (id || '（无）');
}

/** 直接子账户 id 列表 */
export function childrenOf(state, id) {
    const acc = state && isPlainObject(state.accounts) ? state.accounts[id] : null;
    return (acc && Array.isArray(acc.children)) ? acc.children.filter(c => hasAccount(state, c)) : [];
}

/**
 * 反推父账户：一个子账户可以挂在多个父下（DAG），所以返回数组。
 * @returns {string[]}
 */
export function parentsOf(state, id) {
    const acc = (state && isPlainObject(state.accounts)) ? state.accounts : {};
    const out = [];
    for (const pid of Object.keys(acc)) {
        if (pid === id) continue;
        const kids = acc[pid] && Array.isArray(acc[pid].children) ? acc[pid].children : [];
        if (kids.includes(id)) out.push(pid);
    }
    return out.sort();
}

/** `id` 的全部祖先（含间接；坏环也能终止） */
export function ancestorsOf(state, id) {
    const seen = new Set();
    const stack = [...parentsOf(state, id)];
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const p of parentsOf(state, cur)) if (!seen.has(p)) stack.push(p);
    }
    return [...seen];
}

/** `id` 的全部子孙（含间接） */
export function descendantsOf(state, id) {
    const seen = new Set();
    const stack = [...childrenOf(state, id)];
    while (stack.length) {
        const cur = stack.pop();
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const c of childrenOf(state, cur)) if (!seen.has(c)) stack.push(c);
    }
    return [...seen];
}

/**
 * 把 `childId` 挂到 `parentId` 下会不会**成环**？
 *
 * 边是"父 → 子"，所以成环 ⇔ `parentId` 本身已经是 `childId` 的子孙
 * （或就是它自己）。
 */
export function wouldCycle(state, parentId, childId) {
    if (!parentId || !childId) return false;
    if (parentId === childId) return true;
    return descendantsOf(state, childId).includes(parentId);
}

/** 可以当 `id` 的子账户的候选（排除自己 + 自己的祖先，避免环） */
export function candidateChildren(state, id) {
    const bad = new Set([id, ...ancestorsOf(state, id)]);
    return listAccountIds(state).filter(x => !bad.has(x));
}

// ================================================================
// 只读边界
// ================================================================

/** 正在查看别的账户？（此时禁止手改） */
export function isViewOnly(state) {
    if (!state) return false;
    const cur = s(state.currentAccountId);
    const view = s(state.viewingAccountId);
    return !!cur && !!view && cur !== view;
}

/**
 * 手改守卫：在**任何手改入口**先调它，不允许就直接抛。
 *
 * 为什么不静默跳过：静默跳过会让用户以为改成功了。
 * 抛异常 → 事务整体回滚 → 界面弹错误提示，这是这套代码库一贯的失败方式。
 *
 * @param {Object} state
 * @param {string} [what] 干什么（写进错误信息，例如 '修改题目字段'）
 */
export function assertManualEditAllowed(state, what = '手改') {
    if (!isViewOnly(state)) return;
    throw new Error(
        `${what}被拒绝：正在查看「${accountName(state, state.viewingAccountId)}」`
        + `，但登录账户是「${accountName(state, state.currentAccountId)}」——`
        + '只读模式下不能手改。请先切回登录账户（顶部 👤）。'
    );
}

// ================================================================
// 写操作（都在 draft 上原地改；调用方负责放进 execute 里）
// ================================================================

/**
 * 新建账户
 *
 * @param {Object} draft
 * @param {Object} patch
 * @param {string} patch.name   显示名（必填）
 * @param {string} [patch.nature] 性质标签（自由文本，UI 用）
 * @param {string} [patch.parentId] 挂到哪个账户下（可省）
 * @param {string} [patch.id]   指定 id（只给测试用；正常走随机）
 * @returns {string} 新账户 id
 */
export function createAccount(draft, patch = {}) {
    assertManualEditAllowed(draft, '新建账户');
    const acc = accountsOf(draft);
    const name = s(patch.name);
    if (!name) throw new Error('账户名称不能为空');

    const id = s(patch.id) || newAccountId();
    if (acc[id]) throw new Error(`账户 id 已存在：${id}`);

    // 顺序：新账户排在**最后**（`order` = 现有最大值 + 1）——
    // 不写的话它会插进"按名字排"的那一段里，用户会以为"新建的跑哪去了"
    let maxOrder = -1;
    for (const other of Object.values(acc)) {
        const n = orderOf(other);
        if (Number.isFinite(n) && n !== Number.MAX_SAFE_INTEGER) maxOrder = Math.max(maxOrder, n);
    }

    acc[id] = {
        id,
        name,
        nature: s(patch.nature),
        children: [],
        isLocal: false,
        // 活跃开关（`false` = 停用：不参与归认、不能当登录/查看、不显示）
        active: patch.active !== false,
        // 列表里的位置（见 `listAccountIds` / `moveAccount`）
        order: maxOrder + 1,
        mappings: []
    };

    const parentId = s(patch.parentId);
    if (parentId) {
        if (!hasAccount(draft, parentId)) throw new Error(`父账户不存在：${parentId}`);
        if (wouldCycle(draft, parentId, id)) throw new Error('账户结构不能成环');
        if (!Array.isArray(acc[parentId].children)) acc[parentId].children = [];
        acc[parentId].children.push(id);
    }
    return id;
}

/**
 * 保存一个账户的表单（名称 / 性质 / 子账户 / 映射表）
 *
 * 一次性替换，语义简单：**界面上看到的 = 保存后的**。
 * `mappings` 是用户维护的**数据**，所以这里只做形状校验（去空、去重），
 * 不去猜"这个映射对不对"。
 *
 * @param {Object} draft
 * @param {string} id
 * @param {Object} patch - { name, nature, children, mappings }
 * @returns {string[]} 被剔除的子账户 id（成环 / 不存在）
 */
export function saveAccount(draft, id, patch = {}) {
    assertManualEditAllowed(draft, '修改账户');
    const acc = accountsOf(draft);
    const target = acc[id];
    if (!target) throw new Error('账户不存在');

    if (patch.name !== undefined) {
        const name = s(patch.name);
        if (!name) throw new Error('账户名称不能为空');
        target.name = name;
    }
    if (patch.nature !== undefined) target.nature = s(patch.nature);
    if (patch.active !== undefined) {
        if (id === LOCAL_ACCOUNT_ID && patch.active === false) {
            throw new Error('默认账户「本机」永远是活跃的');
        }
        if (id !== LOCAL_ACCOUNT_ID) target.active = !!patch.active;
    }

    if (patch.mappings !== undefined) {
        target.mappings = normalizeMappings(patch.mappings);
    }

    const dropped = [];
    if (patch.children !== undefined) {
        const wanted = Array.isArray(patch.children) ? patch.children : [];
        const keep = [];
        for (const c of wanted) {
            const cid = s(c);
            if (!cid) continue;
            if (!hasAccount(draft, cid) || cid === id || wouldCycle(draft, id, cid)) {
                dropped.push(cid);
                continue;
            }
            if (!keep.includes(cid)) keep.push(cid);
        }
        target.children = keep;
    }
    return dropped;
}

/**
 * 删除账户（DAG 上摘一个点：其它账户的 `children` 里也要摘掉它）
 *
 * `local` 不可删 —— 它是"没有任何账户信息"的兜底身份。
 */
export function removeAccount(draft, id) {
    assertManualEditAllowed(draft, '删除账户');
    if (id === LOCAL_ACCOUNT_ID) throw new Error('默认账户「本机」不能删除');
    const acc = accountsOf(draft);
    if (!acc[id]) throw new Error('账户不存在');
    for (const pid of Object.keys(acc)) {
        const kids = acc[pid] && Array.isArray(acc[pid].children) ? acc[pid].children : null;
        if (!kids) continue;
        acc[pid].children = kids.filter(c => c !== id);
    }
    delete acc[id];
    // 指针不能指向已删掉的账户（否则投影和手改归属都会悬空）
    if (draft.currentAccountId === id) draft.currentAccountId = LOCAL_ACCOUNT_ID;
    if (draft.viewingAccountId === id) draft.viewingAccountId = LOCAL_ACCOUNT_ID;
    return true;
}

/** 切换查看中的账户（投影/过滤用；对手改的影响见 isViewOnly） */
export function setViewingAccount(draft, id) {
    if (!hasAccount(draft, id)) throw new Error('账户不存在');
    if (!isAccountActive(draft, id)) throw new Error('这个账户已停用，不能作为查看账户');
    draft.viewingAccountId = id;
    return id;
}

/** 切换登录账户（手改归属用） */
export function setCurrentAccount(draft, id) {
    if (!hasAccount(draft, id)) throw new Error('账户不存在');
    if (!isAccountActive(draft, id)) throw new Error('这个账户已停用，不能作为登录账户');
    draft.currentAccountId = id;
    return id;
}

// ================================================================
// 映射表（线索 → 账户）
// ================================================================

/**
 * 规范化一组映射：trim、丢掉三个字段不全的行、同账户内去重。
 * @returns {Array<{source:string, field:string, value:string, current:boolean}>}
 */
export function normalizeMappings(list) {
    const out = [];
    const seen = new Set();
    for (const m of Array.isArray(list) ? list : []) {
        if (!isPlainObject(m)) continue;
        const source = s(m.source);
        const field = s(m.field);
        const value = s(m.value);
        if (!source || !field || !value) continue;
        const key = `${source}\u0000${field}\u0000${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ source, field, value, current: m.current !== false });
    }
    return out;
}

/**
 * 这条映射是不是**别的**账户也声明了？（同一个线索被多个账户认领 = 冲突）
 *
 * 应用侧遇到冲突时**不猜**（见 core/accounts.js），所以界面上要提前提醒。
 * ⚠️ 只看**活跃**账户：停用账户不参与归认，与它重复不算冲突。
 *
 * @returns {string[]} 冲突的其它账户 id
 */
export function findMappingConflicts(state, mapping, exceptAccountId = '') {
    const out = [];
    const acc = (state && isPlainObject(state.accounts)) ? state.accounts : {};
    const source = s(mapping && mapping.source);
    const field = s(mapping && mapping.field);
    const value = s(mapping && mapping.value);
    if (!source || !field || !value) return out;
    for (const id of Object.keys(acc)) {
        if (id === exceptAccountId) continue;
        if (!isAccountActive(state, id)) continue;
        const list = Array.isArray(acc[id].mappings) ? acc[id].mappings : [];
        for (const m of list) {
            if (!m) continue;
            if (s(m.source) === source && s(m.field) === field && s(m.value) === value) {
                out.push(id);
                break;
            }
        }
    }
    return out.sort();
}
