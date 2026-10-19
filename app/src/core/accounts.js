// ================================================================
// 账户归认（core/accounts.js）
//
// 职责：把"一条记录是关于谁的"解析成 `accountId`，供来源层写进 `值.account`。
// 依赖：无（纯函数，可在 Node 测试里直接引用）
// 依据：映射字段与自动归认
//
// 设计要点
// --------
// **猜测逻辑一行都不在应用里**：包（适配器）负责给出"线索"，
// 账户注册表里的 `mappings` 负责"线索 → 账户"。应用只做一次查表。
//
// 线索的形状（crate 的一条元列，和 `字段来源` 同级）：
//
//     { "source": "cf", "field": "handle", "value": "某用户名" }
//
// 为什么用元列而不是让应用认识各平台字段：平台会变、字段名会变，
// 而"哪个字段是账户线索"是**适配器知道、应用不该知道**的事（别猜语义）。
// ================================================================

/** crate 里承载"这条记录关于谁"的元列名（与 `字段来源` 同级的保留列） */
export const ACCOUNT_CLUE_KEY = '账户线索';

/**
 * 从一条原始记录里取线索（可能没有）。
 *
 * @param {Object} raw
 * @returns {{source:string, field:string, value:string}|null}
 */
export function clueOf(raw) {
    const c = raw && typeof raw === 'object' ? raw[ACCOUNT_CLUE_KEY] : null;
    if (!c || typeof c !== 'object') return null;
    const source = String(c.source || '').trim();
    const field = String(c.field || '').trim();
    const value = String(c.value === undefined || c.value === null ? '' : c.value).trim();
    if (!value) return null;                 // 没值 = 没线索（区别于"有值但匹配不上"）
    return { source, field, value };
}

/** 账户是不是**活跃**的（只有活跃账户参与归认 / 能当登录·查看 / 会显示在字段来源里） */
export function isAccountActive(accounts, id) {
    if (!accounts || typeof accounts !== 'object') return false;
    const acc = accounts[id];
    if (!acc || typeof acc !== 'object') return false;
    // 老数据没有 `active` 键 → 默认活跃（`local` 永远活跃）
    return acc.active !== false;
}

/**
 * 线索 → 账户 id。
 *
 * 匹配规则（刻意简单，因为映射表是**数据**，由使用者自己维护）：
 *   `accounts[a].mappings` 里存在一条 `source` 与 `field` 都相同、`value` 相等的映射。
 *   **逐字符全等**，不做任何模糊/前缀/去赛季之类的推断。
 *
 * ⚠️ **只查活跃账户**：停用账户的映射留在表里（随时可复活），但不参与归认 ——
 * 否则"停用"就只是个标签，历史映射会继续把新数据认到它头上。
 *
 * @param {Object} accounts - `state.accounts`
 * @param {{source:string, field:string, value:string}|null} clue
 * @returns {{ accountId:string, conflict:string[] }}
 *   - `accountId` 为空串 = 没认出来（调用方按"填了但没匹配上"计数）
 *   - `conflict` 非空 = **匹配到多个账户**（报出来、不猜）
 */
export function resolveAccount(accounts, clue) {
    const out = { accountId: '', conflict: [] };
    if (!accounts || typeof accounts !== 'object' || !clue) return out;

    const hits = [];
    for (const id of Object.keys(accounts)) {
        if (!isAccountActive(accounts, id)) continue;      // 停用的账户不参与归认
        const acc = accounts[id];
        const list = acc && Array.isArray(acc.mappings) ? acc.mappings : [];
        for (const m of list) {
            if (!m || typeof m !== 'object') continue;
            if (String(m.source || '').trim() !== String(clue.source || '').trim()) continue;
            if (String(m.field || '').trim() !== clue.field) continue;
            if (String(m.value === undefined || m.value === null ? '' : m.value).trim() !== clue.value) continue;
            hits.push(id);
            break;                             // 一个账户命中一次就够
        }
    }

    if (hits.length === 1) out.accountId = hits[0];
    else if (hits.length > 1) out.conflict = hits;
    return out;
}

/**
 * 归认一条记录，并把结果累加进计数器（导入摘要用）。
 *
 * 三类：
 *   - `matched`     认出账户
 *   - `unmatched`   **填了线索但没匹配上**（可指派 / 补映射）
 *   - `noClue`      **完全没填线索**（源里根本没有账户信息）
 *
 * @param {Object} accounts
 * @param {Object} raw
 * @param {{matched:number, unmatched:number, noClue:number, conflicts:Array}} counter
 * @returns {string} accountId（'' = 客观/未归认）
 */
export function resolveClueAndCount(accounts, clue, counter) {
    if (!clue) {
        if (counter) counter.noClue = (counter.noClue || 0) + 1;
        return '';
    }
    const r = resolveAccount(accounts, clue);
    if (r.accountId) {
        if (counter) counter.matched = (counter.matched || 0) + 1;
        return r.accountId;
    }
    if (counter) {
        counter.unmatched = (counter.unmatched || 0) + 1;
        if (r.conflict.length) {
            counter.conflicts = counter.conflicts || [];
            if (counter.conflicts.length < 20) {
                counter.conflicts.push({ accounts: r.conflict.slice(), value: clue.value });
            }
        }
    }
    return '';
}

/** 空计数器（导入摘要用） */
export function newCounter() {
    return { matched: 0, unmatched: 0, noClue: 0, conflicts: [] };
}

/** 给界面/日志用的一句话摘要 */
export function describeCounter(c) {
    if (!c) return '';
    const parts = [];
    if (c.matched) parts.push(`认出 ${c.matched} 条`);
    if (c.unmatched) parts.push(`线索没匹配上 ${c.unmatched} 条`);
    if (c.noClue) parts.push(`源没给线索 ${c.noClue} 条`);
    return parts.join('，') || '没有可归认的记录';
}
