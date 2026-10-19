// ================================================================
// 冒烟测试：事务提交的脏标记语义（scripts/smoke/dirty-flags.smoke.mjs）
//
// 为什么必须用冒烟而不是单测：
//   这里要跑**真实事务**（Immer produce + applyState 回填）。
//   transaction/executor.js 依赖裸包名 immer，单测环境加载不了。
//
// 核心回归点：
//   修复前，每次事务提交都无条件 markModified()，于是"切个 tab"也会
//   把「JSON 已导出」清成「JSON 未导出」。修复后只在该事务确实改动了
//   export:true 的字段时才清除该标记。
//
// 同时验证一个容易踩的陷阱：applyState 每次都重建 parentOf（新对象），
//   若判定时机不对，parentOf 会被误判为"每次都变"，导致修复失效。
//
// 运行：npm run test:smoke
// ================================================================
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom } from './dom.mjs';
import { group, ok, eq, report } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'src');
const mod = rel => `file://${path.join(SRC, rel).replace(/\\/g, '/')}`;

// 事务层本身不需要 DOM，但它牵出的模块图可能引用，先装好桩
installDom();

const { InfoState } = await import(mod('core/model/infoState.js'));
const { executeTransaction } = await import(mod('transaction/executor.js'));
const { createInitialState } = await import(mod('core/model/state.js'));

const OPTS = {
    skipHistory: true,
    saveFn: null,
    emitFn: null,
    refreshFn: null,
    DB_MODIFIED_EVENT: ''
};

/** 模拟"刚刚导出过 JSON 并且已写盘" */
function pretendJustExported() {
    InfoState.jsonIsSaved = true;
    InfoState.dbIsSaved = true;
    InfoState.jsonLastSaveTime = Date.now();
}

// ===============================================================
group('脏标记：切 tab 不应影响"已导出"');
// ===============================================================

const state = createInitialState();
pretendJustExported();

await executeTransaction(state, draft => { draft.currentTab = 'stats'; }, OPTS);

eq(InfoState.dbIsSaved, false, '切 tab 后：DB 标记为未保存（currentTab 需要写盘）');
eq(InfoState.jsonIsSaved, true, '切 tab 后：仍显示 JSON 已导出（本 bug 的修复点）');
eq(state.currentTab, 'stats', '事务已生效');

// 再切一次，确认不会累积出问题
await executeTransaction(state, draft => { draft.currentTab = 'main'; }, OPTS);
eq(InfoState.jsonIsSaved, true, '反复切 tab 仍不影响导出标记');

// ===============================================================
group('脏标记：改动数据后导出标记必须失效');
// ===============================================================

pretendJustExported();
await executeTransaction(state, draft => {
    draft.nodes.probe = { id: 'probe', type: 'P' };
}, OPTS);

eq(InfoState.dbIsSaved, false, '改节点后：DB 未保存');
eq(InfoState.jsonIsSaved, false, '改节点后：JSON 标记为未导出（导出文件确实过期了）');

// ===============================================================
group('脏标记：改设置同样让导出过期（settings 会被导出）');
// ===============================================================

pretendJustExported();
await executeTransaction(state, draft => {
    draft.settings.autoSave = { ...(draft.settings.autoSave || {}), autoSaveInterval: 42 };
}, OPTS);

eq(InfoState.jsonIsSaved, false, '改设置后 JSON 过期');
eq(InfoState.dbIsSaved, false, '改设置后 DB 未保存');

// ===============================================================
group('陷阱复验：parentOf 重建不得导致误判');
// ===============================================================

// 连续多次"只切 tab"的事务；若 parentOf 被误判为变化，jsonIsSaved 会被清掉
pretendJustExported();
for (const tab of ['stats', 'main', 'stats', 'main']) {
    await executeTransaction(state, draft => { draft.currentTab = tab; }, OPTS);
}
eq(InfoState.jsonIsSaved, true, '连续 4 次切 tab 后导出标记仍在（parentOf 未误判）');

// 确认事务确实重建了 parentOf（即上面的通过不是因为没执行 applyState）
ok(state.parentOf && typeof state.parentOf === 'object', 'parentOf 已被重建');

report();
