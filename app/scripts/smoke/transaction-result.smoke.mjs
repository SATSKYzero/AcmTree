// ================================================================
// 事务返回值里的 **draft**
//
// 症状：导入真包之后，**改一个节点必炸** ——
//   `Cannot perform 'get' on a proxy that has been revoked`
//   （栈只指到 `transaction/executor.js` 的 `return result`，看着像那儿出错，其实是"承诺结算"时炸的）
//
// 真凶：`core/ops/node.js` 的 `updateP`/`updateR`/… 结尾是 **`return node`** —— 那是个 **draft**。
//   `produce` 一结束，draft 被**撤销**；`await execute(...)` 时
//   `Promise.resolve(被撤销的代理)` 会去读它的 `.then` ⇒ 当场抛。
//   ⚠️ 所以症状很迷惑人：**块体 mutator（返回 undefined）一点事没有**，
//      只有"顺手把 draft 返回出来"的才炸（`d => updateP(...)` 这种表达式体就中招）。
//
// 修法：在 `executeTransaction` 的 **produce 回调里面**把 draft 换成 `original(...)`
//   （出了回调连 `isDraft()` 都会因为读 `DRAFT_STATE` 而抛，必须在那之前换）。
// ================================================================
import { installDom } from './dom.mjs';
import { installIndexedDb } from './idb.mjs';
import { group, ok, eq, report } from './harness.mjs';

installDom();
installIndexedDb();
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} };

const { AppState, replaceState } = await import('../../src/shell/state.js');
const { execute } = await import('../../src/shell/executor.js');
const { createInitialState } = await import('../../src/core/model/state.js');
const { addChild } = await import('../../src/core/ops/tree.js');
const { updateP } = await import('../../src/core/ops/node.js');

replaceState(createInitialState());
// 树按 `O → W → S → C → P` 建（`addChild` 只允许某些父子组合）；id 是生成的，所以逐层接住
let P_ID = '';
await execute((d) => {
    const kid = (parentId, type, name) => {
        addChild(d, parentId, type, name);
        const ids = d.childOrder[parentId];
        return ids[ids.length - 1];
    };
    const w = kid(AppState.rootId, 'W', '平台');
    const s = kid(w, 'S', '系列');
    const c = kid(s, 'C', '比赛');
    P_ID = kid(c, 'P', '题目');
}, { skipHistory: true, validate: false, skipPersist: true });

group('事务返回值：操作返回 draft 时，`await execute(...)` 不许炸');
{
    // ① 表达式体（`d => updateP(...)`）：返回值 = **draft** —— 不换成 `original(...)` 就必炸
    let res = null;
    let err = null;
    try {
        res = await execute((d) => updateP(d, P_ID, { status1: 1 }),
            { skipHistory: true, validate: false, skipPersist: true });
    } catch (e) { err = e; }
    eq(err && err.message, null, '★ 返回 draft 也不许抛（否则会抛 "proxy that has been revoked"）');
    ok(!!res, '而且仍然把操作结果交回来（不是被吞成 undefined）');
    if (res) {
        eq(res.id, P_ID, '结果是**普通对象**（能安全读）');
        eq(res.type, 'P', '字段读得出来');
        eq(res.status1, 1, '而且给的是**改完之后**的那条（从 produce 产物里取的新节点）');
    }

    // ② 块体 mutator（返回 undefined）：照旧
    const r2 = await execute((d) => { updateP(d, P_ID, { status1: 0 }); },
        { skipHistory: true, validate: false, skipPersist: true });
    eq(r2, undefined, '返回 undefined 的照旧是 undefined');

    // ③ 返回普通对象：一个字不动
    const r3 = await execute(() => ({ ok: true, n: 7 }), { skipHistory: true, validate: false, skipPersist: true });
    eq(r3 && r3.n, 7, '返回普通对象时原样带回');
}

report('事务返回值（draft）');
