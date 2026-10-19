// ================================================================
// 插件清单读不上时要**说出来**（shell/bootstrap.js）
//
// 病根：`/plugins.json` 读不到时只 `console.warn` 一句就返回 ——
// 而"检索 / 自动导入"这些**插件页**因此**无提示地消失**：用户看到的是"这版怎么没那两页了"，
// 控制台里那行没人会去看。
//
// 装载问题攒进 `startupProblems`，由 `I_app.js` 在 toast 容器就绪后弹一次。
// 这份测试钉两件事：① 读不上时**确实记了**一条（且说得清后果）；
//                ② `takeStartupProblems()` **取走即清**（别每次刷新都念同一句）。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';

import { bootstrapPlugins, takeStartupProblems, announceStartupProblems } from '../shell/bootstrap.js';

const realFetch = globalThis.fetch;
const realError = console.error;
const realWarn = console.warn;
const realDocument = globalThis.document;

function stubFetch(impl) {
    globalThis.fetch = impl;
}

/** 这些用例**故意**制造装载失败 —— 把 bootstrap 自己那两行日志压掉，别刷测试输出 */
function hushConsole() {
    console.error = () => {};
    console.warn = () => {};
}
function restoreConsole() {
    console.error = realError;
    console.warn = realWarn;
}

test('读不到 /plugins.json ⇒ 记一条"插件页这一趟都没有"的问题', async () => {
    try {
        hushConsole();
        stubFetch(async () => ({ ok: false, status: 404 }));
        const summary = await bootstrapPlugins();
        assert.deepEqual(summary.activated, []);
        const problems = takeStartupProblems();
        assert.equal(problems.length, 1, `应当正好记一条，实际 ${JSON.stringify(problems)}`);
        assert.match(problems[0], /plugins\.json/, '要说清是哪个文件');
        assert.match(problems[0], /插件页/, '要说清后果（那几页这一趟都不会有）');
        assert.deepEqual(takeStartupProblems(), [], '取走之后就清了（别每次刷新都念）');
    } finally {
        restoreConsole();
        globalThis.fetch = realFetch;
    }
});

test('读清单本身抛错（网络/解析）⇒ 也要记一条', async () => {
    try {
        hushConsole();
        stubFetch(async () => { throw new Error('网络断了'); });
        await bootstrapPlugins();
        const problems = takeStartupProblems();
        assert.equal(problems.length, 1);
        assert.match(problems[0], /网络断了/, '要把原因带上（排查用）');
    } finally {
        restoreConsole();
        globalThis.fetch = realFetch;
    }
});

test('清单正常但没有任何条目 ⇒ **不报问题**（空清单是正常状态）', async () => {
    try {
        hushConsole();
        stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ plugins: [] }) }));
        const summary = await bootstrapPlugins();
        assert.deepEqual(summary.activated, []);
        assert.deepEqual(takeStartupProblems(), [], '空清单不该弹"插件没装全"');
    } finally {
        restoreConsole();
        globalThis.fetch = realFetch;
    }
});

// ⚠️ 上面三条只证明"攒下来了"；另一半是"真的派发出去"—— 攒得再好、不派发就等于没修。
test('`announceStartupProblems()`：把攒下的**派发**成一次 show-toast（且只派一次）', async () => {
    const events = [];
    globalThis.document = { dispatchEvent: (e) => { events.push(e); return true; } };
    try {
        hushConsole();
        stubFetch(async () => ({ ok: false, status: 500 }));
        await bootstrapPlugins();
        const message = announceStartupProblems();
        assert.equal(events.length, 1, '必须派发一次（不派发 = 又静默了）');
        assert.equal(events[0].type, 'show-toast');
        assert.match(events[0].detail.message, /插件没装全/);
        assert.equal(events[0].detail.type, 'error', '用 error 档，别混进普通提示');
        assert.equal(message, events[0].detail.message, '返回的那句与派发的是同一句（排查用）');
        assert.equal(announceStartupProblems(), '', '再调一次 ⇒ 空（取走即清，不重复弹）');
        assert.equal(events.length, 1, '而且不再派发');
    } finally {
        restoreConsole();
        globalThis.fetch = realFetch;
        if (realDocument === undefined) delete globalThis.document;
        else globalThis.document = realDocument;
    }
});

test('没有 DOM 时 `announceStartupProblems()` **不抛**（启动路径不许因为报错而崩）', async () => {
    const realDoc = globalThis.document;
    delete globalThis.document;
    try {
        hushConsole();
        stubFetch(async () => ({ ok: false, status: 500 }));
        await bootstrapPlugins();
        assert.equal(typeof announceStartupProblems(), 'string', '拿不出 toast 也要把话回给调用方');
    } finally {
        restoreConsole();
        globalThis.fetch = realFetch;
        globalThis.document = realDoc;
    }
});
