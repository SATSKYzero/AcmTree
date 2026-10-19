// ================================================================
// 排序操作（handlers/H3_sort.js）
//
// 职责：**题目排序**、**提交记录排序** —— 都作用在**一棵子树**上：
//   · 题目排序：子树下**每一个"子节点里有题目"的容器**（比赛 C 为主）各排一次；
//   · 提交记录排序：子树下**每一道题 P** 的提交子节点各排一次。
//   ⇒ 在 C 上点它 = 只排这一场；在 **W / S / O** 上点它 = 排这**一整支**下的所有比赛。
//
// ★ 值怎么读（**踩过的坑**）：读**屏幕上那一列** —— `viewDerivedDisplay(...) ?? viewValue(...)`
//   （`view/scope.js`，与卡片方框的难度徽标是同一份读法）。
//   ⚠️ 以前读的是**缓存字段** `node.ratio` / `node.cfDifficulty`：判重模式下界面显示的难度是
//      **组那份**（同组其他平台那一份聚合来的，见 `core/groupValue.js` 的 `AGG_BUILDERS`）——
//      组头自己那份是空的 ⇒ 用户看着方框上有「铜牌-」，点排序却报"都没有 XCPC 通过率"。
//
// ⚠️ 本文件**不动"同层顺序"那条规则**（唯一一份在 `core/siblingOrder.js`）——
//    这里只把"人要的顺序"写进 `childOrder`，并打上 `manualOrder`：
//    导入后的同层重排会**跳过**标记过的容器（不然手排的顺序下次导入就被冲掉）。
//
// 依赖：shell/state.js, shell/executor.js, core/ops/account.js, core/query/stats.js,
//       core/siblingOrder.js, view/scope.js, A_constants.js
// ================================================================

import { EVENTS } from '../A_constants.js';
import { AppState } from '../shell/state.js';
import { execute } from '../shell/executor.js';
import { assertManualEditAllowed } from '../core/ops/account.js';
import { collectByType } from '../core/query/stats.js';
import { compareProblemId } from '../core/siblingOrder.js';
import { displayColumnOf, viewDerivedDisplay, viewValue } from '../view/scope.js';

/** 能当"一支的根"的容器类型（P / R 自己不是容器，点不到也不该排） */
const CONTAINER_TYPES = new Set(['O', 'W', 'S', 'C']);

/**
 * 读"**显示那一列**"的值 —— 与界面**同一份**口径（来自来源层的字段在 `plain` 下
 * `viewDerivedDisplay` 给 `undefined`，所以必须退回 `viewValue`；`dedup` 下前者给**组那份**）。
 *
 * ⚠️ 只在 `plain` 下不会有任何聚合：`viewDerivedDisplay` 内部按 `displayColumnOf` 分流。
 */
const shownValue = (node, field) => {
    const v = viewDerivedDisplay(AppState, node, field);
    return (v === undefined || v === null) ? viewValue(AppState, node, field) : v;
};

/**
 * 子树下所有题目 —— 用**现成的收集口** `collectByType`（按 `childOrder` 前序走）。
 */
const problemsUnder = (draft, rootId) => collectByType(draft, rootId, 'P');

/**
 * 子树下"**子节点里有题目**"的那些容器（含 root 自己），按树序去重。
 *
 * 做法：拿题目反查它爸 —— `parentOf` 是**草稿里一直在维护的派生索引**
 * （`core/ops/tree.js`、`ops/upsert.js`、`ops/synth.js` 写入时都同步它），不必再写一遍走树。
 */
function problemHoldersUnder(draft, rootId) {
    const out = [];
    const seen = new Set();
    for (const p of problemsUnder(draft, rootId)) {
        const pid = draft.parentOf[p.id];
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        out.push(pid);
    }
    return out;
}

/** 拆一个容器的子节点：目标类型挑出来（保持相对位置），其余按原顺序放前面 */
function splitChildren(draft, holderId, type) {
    const picked = [];
    const others = [];
    for (const cid of draft.childOrder[holderId] || []) {
        const c = draft.nodes[cid];
        if (!c) continue;
        if (c.type === type) picked.push(c);
        else others.push(cid);
    }
    return { picked, others };
}

/** 只在标记真的变了时才写（写同值也会让 immer 认为这个节点改过） */
function setMark(node, want) {
    if (node && node.manualOrder !== want) node.manualOrder = want;
}

/** 把"显示那一列"的值当数字看（空 / 认不出 → `NaN`） */
function numOf(value) {
    if (value === '' || value === undefined || value === null) return NaN;
    const n = parseFloat(String(value).replace('%', ''));
    return isNaN(n) ? NaN : n;
}

// ================================================================
// 题目排序
// ================================================================

/**
 * 排序方式的元信息：标签（给 toast）、**读哪一列**、比较器。
 *
 * `keyOf` 收的是**已经读好的显示值**（`readProblemSortKeys` 在事务外读过），不是节点 —— 见那里的注释。
 *
 * ⚠️ 导出只为**方向**那一条单测（`src/test/problemSort.test.js`）—— 别的调用点仍然只走 `sortProblems()`。
 */
export function problemSorters() {
    // ⚠️ 难度认 `0` = **未填**（与 `core/groupValue.js` 的 `AGG_BUILDERS` 同一条口径）
    const byNum = (asc) => (a, b) => {
        const x = numOf(a), y = numOf(b);
        if (isNaN(x) && isNaN(y)) return 0;
        if (isNaN(x)) return asc ? 1 : -1;         // 没值的沉底
        if (isNaN(y)) return asc ? -1 : 1;
        return asc ? x - y : y - x;
    };
    const numAsc = (v) => !isNaN(numOf(v));
    const cfUsable = (v) => numOf(v) > 0;
    return {
        'id-asc': {
            label: '题号升序', empty: '题号', field: 'problemId',
            usable: (v) => String(v === undefined || v === null ? '' : v).trim() !== '',
            cmp: (a, b) => compareProblemId(a, b)      // ★ 题号先后只有这一份实现（`core/siblingOrder.js`）
        },
        'xcpc-asc': {
            // ★ **方向与 CF 那两档相反**（2026-10-16 修，用户指出的）：
            //   这一档读的是 **`ratio`（过题比例）**，而比例**越大 = 越容易** ⇒
            //   "难度升序"（易 → 难，与 `utils/color.js:XCPC_ORDER` 的"低→高"同一口径）
            //   = **比例降序**。改前是 `byNum(true)`（比例升序 = 难题在前）⇒ **方向反了**。
            label: 'XCPC难度升序（过题比例降序）', empty: 'XCPC 通过率', field: 'ratio',
            usable: numAsc, cmp: byNum(false)
        },
        'xcpc-desc': {
            label: 'XCPC难度降序（过题比例升序）', empty: 'XCPC 通过率', field: 'ratio',
            usable: numAsc, cmp: byNum(true)
        },
        'cf-asc': {
            label: 'CF难度升序', empty: 'CF 难度（0 表示未填）', field: 'cfDifficulty',
            usable: cfUsable, cmp: byNum(true)
        },
        'cf-desc': {
            label: 'CF难度降序', empty: 'CF 难度（0 表示未填）', field: 'cfDifficulty',
            usable: cfUsable, cmp: byNum(false)
        }
    };
}

/**
 * 在**事务外**把"显示那一列"的值读齐（`id → 值`）。
 *
 * 为什么不在草稿里读：
 *  ① 判重模式的组表按 **`state.nodes` 的引用**记忆化（`core/groupCompute.js`），
 *     草稿的 `nodes` 是另一个引用 ⇒ 会**白重算一整趟**（真包量级 ~750ms）；
 *     在事务外读还能吃到渲染刚算好的那一份。
 *  ② 读值不受"改顺序"影响（顺序本来就不参与取值）⇒ 两处读的是同一批数。
 */
function readSortKeys(rootId, sorter) {
    const keys = new Map();
    for (const p of collectByType(AppState, rootId, 'P')) keys.set(p.id, shownValue(p, sorter.field));
    return keys;
}

/**
 * 题目排序（作用在 `nodeId` 这棵子树上）。
 *
 * `id-asc`（题号升序）= **规范序** ⇒ 视为"交还给自动排序"：清掉 `manualOrder`。
 * 其余四种 = 手排：**这一列排得动的容器**打 `manualOrder`（一个值都没有的容器别冻住）。
 */
export async function sortProblems(nodeId, sortKey) {
    const sorter = problemSorters()[sortKey];
    if (!sorter) {
        document.dispatchEvent(new CustomEvent('show-toast', {
            detail: { message: '未知排序方式', type: 'error' }
        }));
        return;
    }
    const keys = readSortKeys(nodeId, sorter);
    const keyOf = (node) => keys.get(node.id);
    const manual = sortKey !== 'id-asc';

    await execute(
        (draft) => {
            // 只读边界：排序改的是树的顺序，与 `tree.js` 的上移/下移同一类手改。
            assertManualEditAllowed(draft, '题目排序');
            const root = draft.nodes[nodeId];
            if (!root || !CONTAINER_TYPES.has(root.type)) {
                throw new Error('不是可以排序的节点');
            }

            const holders = problemHoldersUnder(draft, nodeId);
            if (!holders.length) throw new Error('这棵子树下没有题目');

            // ★ **整支一个题都拿不到这个键**时排序必然"什么都没动" —— 那就**明说**，
            //   别弹"已按…排序"这种假成功（用户就是这么判成"功能失效"的）。
            if (![...keys.values()].some(sorter.usable)) {
                // `plain` 下判重那份合并值**不该**进来（口径是"读屏幕上那一列"）⇒ 给一句可操作的话
                const hint = displayColumnOf(AppState) === 'own'
                    ? '（判重模式会合并同组其他平台的那一份）' : '';
                throw new Error(`这一支下的题目都没有${sorter.empty}，排不出顺序${hint}`);
            }

            for (const hid of holders) {
                const { picked, others } = splitChildren(draft, hid, 'P');
                if (picked.length >= 2) {
                    picked.sort((a, b) => sorter.cmp(keyOf(a), keyOf(b)));
                    draft.childOrder[hid] = [...others, ...picked.map(p => p.id)];
                }
                // ★ 标记"这个容器的顺序是人定的" ⇒ 导入后的同层重排**跳过**它。
                //   `id-asc` 例外：那正是规范序（P = 题号升序）⇒ **交还给自动排序**（清标记）。
                setMark(draft.nodes[hid], manual && picked.some(p => sorter.usable(keyOf(p))));
            }
            return { sortKey, label: sorter.label, holders: holders.length };
        },
        {
            refreshParentId: nodeId,
            onSuccess: (result) => {
                const many = result.holders > 1 ? `：${result.holders} 个容器下的题目` : '';
                document.dispatchEvent(new CustomEvent('show-toast', {
                    detail: { message: `题目已按「${result.label}」排序${many}`, type: 'success' }
                }));
            },
            onError: (err) => {
                document.dispatchEvent(new CustomEvent('show-toast', {
                    detail: { message: err.message || '排序失败', type: 'error' }
                }));
            }
        }
    );
}

// ================================================================
// 提交记录排序
// ================================================================

/**
 * 提交记录排序（作用在 `nodeId` 这棵子树上：每道题的提交子节点各排一次）。
 *
 * `desc`（提交时间倒序）= **规范序**（`core/siblingOrder.js` 里 R 的规则）⇒ **恢复自动**（清标记）；
 * `asc` = 手排 ⇒ 打标记。
 */
export async function sortSubmissions(nodeId, direction) {
    await execute(
        (draft) => {
            assertManualEditAllowed(draft, '提交记录排序');
            const root = draft.nodes[nodeId];
            if (!root || !CONTAINER_TYPES.has(root.type)) {
                throw new Error('不是可以排序的节点');
            }

            const problems = problemsUnder(draft, nodeId);
            if (!problems.length) throw new Error('这棵子树下没有题目');

            // ★ 先把要动的东西看清楚再写：整支一条提交都没有 ⇒ 明说，别弹"已排序"。
            //   （写在前面，不依赖出错回滚。）
            const groups = problems.map((p) => ({ p, ...splitChildren(draft, p.id, 'R') }));
            if (!groups.some((g) => g.picked.length)) {
                throw new Error('这棵子树下的题目都没有提交记录');
            }

            const wantMark = direction === 'asc';
            for (const g of groups) {
                const { p, picked, others } = g;
                if (picked.length >= 2) {
                    picked.sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')));
                    if (!wantMark) picked.reverse();     // `asc` 保持升序；否则 = 规范序（时间倒序）
                    draft.childOrder[p.id] = [...others, ...picked.map(r => r.id)];
                }
                // ★ 同题目排序：手排（升序）打标记；**倒序 = 规范序** ⇒ 清标记、交还自动排序。
                setMark(draft.nodes[p.id], wantMark);
            }
            return { direction, holders: groups.filter((g) => g.picked.length >= 2).length };
        },
        {
            refreshParentId: nodeId,
            onSuccess: (result) => {
                const what = result.direction === 'asc'
                    ? '提交记录已按升序排序'
                    : '提交记录已按倒序排序（已恢复自动排序）';
                const many = result.holders > 1 ? `：${result.holders} 道题` : '';
                document.dispatchEvent(new CustomEvent('show-toast', {
                    detail: { message: `${what}${many}`, type: 'success' }
                }));
            },
            onError: (err) => {
                document.dispatchEvent(new CustomEvent('show-toast', {
                    detail: { message: err.message || '排序失败', type: 'error' }
                }));
            }
        }
    );
}
