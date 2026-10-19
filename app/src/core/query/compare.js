// ================================================================
// 多账户对比矩阵（core/query/compare.js）
//
// 职责：把"同一棵树、按多个账户各算一份"的结果整理成一张表：
//   行 = 比赛（可展开成题目）｜列 = 账户｜格 = 那个人在这道题/这场比赛上的状态
//
// 为什么能这么做：**派生字段按"查看范围"现算**（`buildDerivedTable`），
// 而"范围"本来就是个集合（`scopeAccounts`）。所以"3 个人各自的补题情况"
// 不是新数据，而是同一份数据按 3 个范围各算一次的并列。
//
// 纯函数：只读 state，返回普通对象（可在 Node 单测里直接跑）。
// 依赖：core/derive.js（按范围算派生字段）、core/query/stats.js（分档汇总）、
//       core/ops/account.js（账户名与活跃判定）
// ================================================================
import { buildDerivedTable } from '../derive.js';
import { isPassed, isIgnored } from '../model/status.js';
import { collectByType, collectPStats } from './stats.js';
import { MODE_PLAIN } from './groupCount.js';
import { accountName, isAccountActive, hasAccount } from '../ops/account.js';

/**
 * 一个账户的"口径读取器"：给定节点，返回该账户范围内的派生字段值。
 * 与 `view/viewDerived` 的差别：这里**不带显示兜底**（不借别人的值），
 * 对比表要的是"这个人到底过没过"，不是"屏幕上会显示什么"。
 */
function derivedReaderFor(table) {
    return (node, field) => {
        const d = table.get(node.id);
        return d ? d[field] : undefined;
    };
}

/**
 * 建对比矩阵。
 *
 * @param {Object} state
 * @param {Object} opts
 * @param {string[]} opts.accounts - 要对比的账户 id（顺序 = 列顺序；无效/停用的会被剔除）
 * @param {string} [opts.rootId] - 只看这棵子树（缺省 = 整棵树）
 * @param {number} [opts.maxAccounts] - 最多几列（防止表格宽到没法看）
 * @returns {{ accounts: Array, groups: Array, summary: Object, dropped: string[] }}
 *   - `accounts`: `[{ id, name, active }]`（列定义）
 *   - `groups`: `[{ id, name, contestTime, cells: {账户id: 完成状态}, problems: [{ id, problemId, name, cells: {账户id: 状态2} }] }]`
 *   - `summary`: `{ 账户id: { total, passed, processed, ... } }`（整棵树口径）
 *   - `dropped`: 被剔除的账户 id（不存在/已停用/超出列数上限）
 */
export function buildCompareMatrix(state, opts = {}) {
    const empty = { accounts: [], groups: [], summary: {}, dropped: [] };
    if (!state || !state.nodes || !state.rootId) return empty;

    const maxAccounts = opts.maxAccounts && opts.maxAccounts > 0 ? opts.maxAccounts : 6;
    const dropped = [];
    const ids = [];
    for (const raw of (Array.isArray(opts.accounts) ? opts.accounts : [])) {
        const id = String(raw || '');
        if (!id || ids.includes(id)) continue;
        if (!hasAccount(state, id)) { dropped.push(id); continue; }
        if (!isAccountActive(state, id)) { dropped.push(id); continue; }
        if (ids.length >= maxAccounts) { dropped.push(id); continue; }
        ids.push(id);
    }
    if (ids.length === 0) return { ...empty, dropped };

    // 每个账户一份派生表（范围 = 单个账户）。`buildDerivedTable` 是纯函数，
    // 记忆化由调用方（`derivedTable`）管，这里刻意用 build 版：一次算好就够，
    // 不必进入全局 memo（否则统计页与树会互相挤掉对方的缓存）。
    const derived = new Map();
    for (const id of ids) {
        derived.set(id, buildDerivedTable(state, {
            scopeAccounts: [id],
            accounts: state.accounts,
            trust: state.trust
        }));
    }

    const rootId = opts.rootId && state.nodes[opts.rootId] ? opts.rootId : state.rootId;
    const inScope = (node) => {
        if (rootId === state.rootId) return true;
        let cur = node;
        const guard = new Set();
        while (cur && !guard.has(cur.id)) {
            if (cur.id === rootId) return true;
            guard.add(cur.id);
            cur = state.nodes[state.parentOf[cur.id]];
        }
        return false;
    };

    const accounts = ids.map(id => ({
        id,
        name: accountName(state, id) || id,
        active: isAccountActive(state, id)
    }));

    // ---- 比赛（C）分组 + 组内题目 ----
    const contests = collectByType(state, rootId, 'C').filter(inScope);
    const groups = [];
    for (const c of contests) {
        const cells = {};
        for (const id of ids) {
            const d = derived.get(id).get(c.id);
            cells[id] = d ? d.statusComplete2 : undefined;
        }
        const problems = [];
        for (const pid of state.childOrder[c.id] || []) {
            const p = state.nodes[pid];
            if (!p || p.type !== 'P') continue;
            const pcells = {};
            for (const id of ids) {
                const d = derived.get(id).get(p.id);
                pcells[id] = d ? d.status2 : undefined;
            }
            problems.push({
                id: p.id,
                problemId: p.problemId || '',
                name: p.name || '',
                tags: Array.isArray(p.tags) ? p.tags.map(t => t.text) : [],
                cells: pcells
            });
        }
        groups.push({
            id: c.id,
            name: c.name || '',
            contestTime: c.contestTime || '',
            kind: c.kind || 'contest',
            cells,
            problems
        });
    }

    // ---- 每人总计（整棵子树口径，供列头显示） ----
    //
    // ⚠️ **固定 `plain`，不跟全局设置走**：对比表的每一列就是"**那个人自己看到的**"口径
    //    （范围 = 单个账户）。全局设置若是 `dedup`，统计会按组计数、状态取**合成节点**那份
    //    —— 于是每列的合计都变成"按组、看组头"，**各账户之间的差异会被组头盖掉**，
    //    这张表就没有意义了。所以这里显式 `plain`，
    //    与"对比就是每个人自己看到的口径"一致。
    const summary = {};
    for (const id of ids) {
        const read = derivedReaderFor(derived.get(id));
        const st = collectPStats(state, rootId, (node, field) => {
            // collectPStats 只读 status1 / status2
            return read(node, field);
        }, { mode: MODE_PLAIN });
        summary[id] = {
            total: st.total,
            // "补题情况"最有用的两个数：过了几道 / 处理了几道
            passed: st.passedIgnore,
            processed: st.processedIgnore
        };
    }

    return { accounts, groups, summary, dropped };
}

/**
 * 一行该不该显示（筛选）。
 *
 * @param {Object} row - 题目行或分组（都要有 `cells`）
 * @param {Object} opts
 * @param {string[]} opts.accounts - 列
 * @param {string} [opts.only] - `''` 全部｜`'undone'` 有人没过｜`'diff'` 各人不一样｜账户 id = 这个人没过
 * @param {string} [opts.search] - 题号/名称包含（不区分大小写）
 */
export function rowMatches(row, opts = {}) {
    const ids = Array.isArray(opts.accounts) ? opts.accounts : [];
    const cells = row.cells || {};
    const search = String(opts.search || '').trim().toLowerCase();
    if (search) {
        const hay = `${row.problemId || ''} ${row.name || ''} ${row.contestTime || ''}`.toLowerCase();
        if (!hay.includes(search)) return false;
    }
    const only = opts.only || '';
    if (!only) return true;
    const vals = ids.map(id => cells[id]);
    // "没过、也没被忽略" / "过题" 统一问 status.js，别在这里裸比较 3/4/5
    const undone = vals.filter(v => !isPassed(v) && !isIgnored(v));
    if (only === 'undone') return undone.length > 0;
    if (only === 'diff') {
        // 全一样（含全都没过）→ 不算差异；只要有人成功、有人没成功就算
        const done = vals.map(v => isPassed(v));
        return done.some(Boolean) && !done.every(Boolean);
    }
    if (ids.includes(only)) return !isPassed(cells[only]) && !isIgnored(cells[only]);
    return true;
}
