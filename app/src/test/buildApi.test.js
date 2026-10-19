// ================================================================
// 「一键重建总包」客户端的单测（src/test/buildApi.test.js）
//
// 建包步骤直接在主脚本里放个按钮触发，并顺带自动导入；整条原料处理链都跑在主脚本
// 进程内，不另加限制。
//
// 处理链现在跑在本机"主脚本"（scripts/dev-server.py）**进程内**，这里钉客户端这一侧：
//   ① 探活失败**不抛**（没在跑是常态，界面要能照常显示）；
//   ② **找得到**服务器：同源 → `127.0.0.1:<DEFAULT_PORT>` → `localhost:<DEFAULT_PORT>`
//      （`DEFAULT_PORT` = 8321；页面从别的端口打开也能用）；
//   ③ 身份判读：接口版本低 = 旧进程；页面 `APP_BUILD` 与磁盘不符 = 页面是旧代码；
//   ④ 起 / 查 / 判定"跑完了"的口径（`running=false` 且 `code !== null`）；
//   ⑤ 取包 → `File`（走既有导入通道）；取不到就抛（调用方据此报错）。
// 全部通过**注入的 fetch** 测，不碰网络。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    BUILD_API_PATH,
    PING_API_PATH,
    PACKAGE_URL,
    API_VERSION,
    DEFAULT_PORT,
    BUILD_MODES,
    DEFAULT_BUILD_MODE,
    pingBuildApi,
    probeBuildApi,
    defaultBases,
    resolvedBase,
    setResolved,
    startBuild,
    fetchBuildStatus,
    isBuildFinished,
    fetchPackageFile,
    stepMark
} from '../features/AutoImport/buildApi.js';
import { APP_BUILD } from '../A_constants.js';

/** 造一个"像 fetch 一样"的桩：按调用记录返回预设响应 */
function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), method: String(opts.method || 'GET'), opts });
        const out = handler(String(url), opts);
        if (out instanceof Error) throw out;
        return {
            ok: out.status ? out.status < 400 : true,
            status: out.status || 200,
            json: async () => out.json,
            blob: async () => out.blob
        };
    };
    fn.calls = calls;
    return fn;
}

/** 服务器自报身份的一份样本 */
const identity = (over = {}) => ({
    ok: true,
    api: API_VERSION,
    pid: 4242,
    port: 8000,
    root: 'D:/repo',
    srcSha: 'abc123',
    restarts: 0,
    diskBuild: APP_BUILD,
    pageBuild: APP_BUILD,
    stalePage: false,
    steps: ['registry', 'nature', 'crate', 'check'],
    ...over
});

test('探活：接口在 ⇒ 带回仓库根与身份；接口不在（404）⇒ `ok:false` 且**不抛**', async () => {
    const okF = fakeFetch(() => ({ json: identity() }));
    const ping = await pingBuildApi(okF);
    assert.equal(ping.ok, true);
    assert.equal(ping.root, 'D:/repo');
    assert.equal(ping.api, API_VERSION);
    assert.equal(ping.pid, 4242);
    assert.deepEqual(ping.steps, ['registry', 'nature', 'crate', 'check']);
    assert.match(okF.calls[0].url, new RegExp(`^${PING_API_PATH}\\?build=`), '打的是 /api/ping');
    assert.ok(okF.calls[0].url.includes(encodeURIComponent(APP_BUILD)),
        '探活要带上页面自己的 APP_BUILD（服务器据此判断"页面是不是旧代码"）');
    assert.equal(okF.calls[0].opts.cache, 'no-store', '不吃缓存');

    const missing = fakeFetch(() => ({ status: 404, json: { ok: false, error: '接口没开' } }));
    const gone = await pingBuildApi(missing);
    assert.deepEqual([gone.ok, gone.error], [false, '接口没开']);

    const dead = fakeFetch(() => new Error('连不上'));
    assert.deepEqual((await pingBuildApi(dead)).error, '连不上', '连不上也当"不可用"，不抛给界面');

    assert.equal((await pingBuildApi(null)).error, '这个环境没有 fetch');
});

test('找服务器：同源优先；同源没有就试 127.0.0.1:<DEFAULT_PORT>（页面从别的端口打开也能用）', async () => {
    // 同源就打中 ⇒ 只发一次请求
    const same = fakeFetch(() => ({ json: identity() }));
    const a = await probeBuildApi(same, ['', `http://127.0.0.1:${DEFAULT_PORT}/`]);
    assert.equal(a.ok, true);
    assert.equal(same.calls.length, 1, '同源打中就不再试别的');
    assert.equal(a.base, '');

    // 同源 404（页面是别的静态服务器提供的，比如 8000 上那个）⇒ 落到主脚本的回环地址
    const cross = fakeFetch(u => (u.startsWith(`http://127.0.0.1:${DEFAULT_PORT}/`)
        ? { json: identity({ port: DEFAULT_PORT }) } : { status: 404, json: { ok: false, error: '页面同源没有这个接口' } }));
    const b = await probeBuildApi(cross, defaultBases({ hostname: 'localhost', port: '5500' }));
    assert.equal(b.ok, true);
    assert.equal(b.base, `http://127.0.0.1:${DEFAULT_PORT}/`);
    assert.equal(cross.calls.length, 2, '先同源、再回环地址');
    assert.equal(resolvedBase(), `http://127.0.0.1:${DEFAULT_PORT}/`, '找到后就记住，后面的调用都用它');

    // 全都没有 ⇒ 说清试过哪些，且不抛
    const none = fakeFetch(() => new Error('连不上'));
    const c = await probeBuildApi(none, ['', `http://127.0.0.1:${DEFAULT_PORT}/`]);
    assert.equal(c.ok, false);
    assert.deepEqual(c.tried.map(t => t.base), ['', `http://127.0.0.1:${DEFAULT_PORT}/`]);
    setResolved(null);
});

test('试哪些地址：页面就在主脚本端口上时不用试绝对地址；别的端口/文件打开都要试回环', () => {
    const P = DEFAULT_PORT;
    assert.deepEqual(defaultBases({ hostname: '127.0.0.1', port: String(P) }), ['']);
    assert.deepEqual(defaultBases({ hostname: 'localhost', port: String(P) }), ['']);
    assert.deepEqual(defaultBases({ hostname: '', port: '' }),
        ['', `http://127.0.0.1:${P}/`, `http://localhost:${P}/`], 'file:// 打开 ⇒ 两个回环都试');
    assert.deepEqual(defaultBases({ hostname: '127.0.0.1', port: '5500' }),
        ['', `http://127.0.0.1:${P}/`, `http://localhost:${P}/`], '别的端口 ⇒ 也要试回环');
    // ★ 真实局面：8000 上蹲着别人的静态服务器（没有 /api/*），页面就是它给的 ——
    //   只要主脚本在默认端口上跑着，按钮就得能找到它（页面在 localhost ⇒ 回环只试 127.0.0.1 那条）。
    assert.deepEqual(defaultBases({ hostname: 'localhost', port: '8000' }),
        ['', `http://127.0.0.1:${P}/`], '页面在 8000（别人给的）⇒ 照样去默认端口找主脚本');
    assert.notEqual(P, 8000, '主脚本默认端口别用 8000（那里常被别的工具占着）');
});

test('身份判读：接口版本低 = 旧进程；页面 APP_BUILD 与磁盘不符 = 页面旧代码', async () => {
    const old = await pingBuildApi(fakeFetch(() => ({ json: identity({ api: 1 }) })));
    assert.equal(old.api < API_VERSION, true, '接口版本低 ⇒ 调用方据此提示"旧进程"');

    const stale = await pingBuildApi(fakeFetch(() => ({
        json: identity({ diskBuild: 'v8.5.0-nature-class-31', pageBuild: 'v8.5.0-nature-class-30', stalePage: true })
    })));
    assert.equal(stale.stalePage, true);
    assert.equal(stale.pageBuild, 'v8.5.0-nature-class-30');
    assert.equal(stale.diskBuild, 'v8.5.0-nature-class-31');
});

test('起重建 / 查状态：走 POST 与 GET 同一个路径，形状原样带回来', async () => {
    const f = fakeFetch(() => ({
        json: { ok: true, started: true, status: { running: true, code: null, lines: ['🚀 原料处理链'] } }
    }));
    const started = await startBuild(f, 'http://127.0.0.1:8000/');
    assert.equal(started.started, true);
    assert.equal(f.calls[0].method, 'POST', '起重建必须是 POST');
    assert.equal(f.calls[0].url, `http://127.0.0.1:8000/${BUILD_API_PATH}`, '跟着找到的那个根地址');

    const g = fakeFetch(() => ({
        json: {
            ok: true,
            status: {
                running: false, code: 0, lines: ['✅ 可写入 22606 个节点'],
                steps: [{ key: 'crate', title: '产包', state: 'ok', seconds: 12.3 }]
            }
        }
    }));
    const st = await fetchBuildStatus(g);
    assert.equal(g.calls[0].method, 'GET', '查状态是 GET');
    assert.equal(st.code, 0);
    assert.deepEqual(st.lines, ['✅ 可写入 22606 个节点']);
    assert.equal(st.steps[0].state, 'ok', '每步状态是结构化的，不用从日志里猜');

    await assert.rejects(() => startBuild(fakeFetch(() => ({ status: 500, json: { error: '炸了' } }))),
        /炸了/, '非 2xx/`ok:false` 要抛（调用方据此报错）');
    await assert.rejects(() => fetchBuildStatus(fakeFetch(() => new Error('断线'))), /断线/);
});

test('「跑完了」的判据：`running=false` **且** `code !== null`', () => {
    assert.equal(isBuildFinished({ running: false, code: 0 }), true);
    assert.equal(isBuildFinished({ running: false, code: 1 }), true, '失败也算"结束"（要去看日志）');
    assert.equal(isBuildFinished({ running: true, code: null }), false);
    assert.equal(isBuildFinished({ running: false, code: null }), false, '还没跑过 ≠ 跑完了');
    assert.equal(isBuildFinished(null), false);
});

test('每步的标记：五种状态都有记号（界面上那条进度）；未知状态不炸', () => {
    for (const state of ['pending', 'running', 'ok', 'fail', 'skip']) {
        assert.notEqual(stepMark(state), undefined);
    }
    assert.equal(stepMark('莫名其妙的'), '·');
    assert.equal(stepMark(undefined), '·');
});

test('取包：包成 File（带 `?t=` 绕缓存）；取不到就抛', async () => {
    class FakeFile {
        constructor(parts, name, opts) { this.parts = parts; this.name = name; this.type = opts && opts.type; }
    }
    const f = fakeFetch(() => ({ blob: { size: 11 } }));
    const file = await fetchPackageFile(f, FakeFile, '');
    assert.equal(file.name, 'all_nodes.json');
    assert.equal(file.type, 'application/json');
    assert.match(f.calls[0].url, new RegExp(`^${PACKAGE_URL}\\?t=\\d+$`), '带时间戳');

    // 跨源时也要跟着那个根地址取包
    const g = fakeFetch(() => ({ blob: { size: 11 } }));
    await fetchPackageFile(g, FakeFile, 'http://127.0.0.1:8000/');
    assert.match(g.calls[0].url, /^http:\/\/127\.0\.0\.1:8000\/acm-data\/nodes\/all_nodes\.json\?t=\d+$/);

    // 老环境没有 File：补一个"像 File"的形状（`readAllFiles` 只要 `.name` + blob 语义）
    const blob = await fetchPackageFile(f, null, '');
    assert.equal(blob.name, 'all_nodes.json');

    await assert.rejects(() => fetchPackageFile(fakeFetch(() => ({ status: 404 })), FakeFile, ''),
        /取包失败/, '取不到必须抛（否则会拿空包去导入）');
});

test('离线开关：`startBuild(…, true/false)` 才带 body；不给 ⇒ 一个字节都不多发', async () => {
    const f = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(f, '', true);
    assert.equal(f.calls[0].opts.body, '{"offline":true}', '离线档 ⇒ body 里就这一个布尔');
    assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/json');

    const g = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(g, '', false);
    assert.equal(g.calls[0].opts.body, '{"offline":false}', '联网档 ⇒ false（不是"不说"）');

    const h = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(h, '');
    assert.equal(h.calls[0].opts.body, undefined, '不给 ⇒ 不带 body（用服务器默认档）');
    assert.equal(h.calls[0].opts.headers, undefined, '不给就连 Content-Type 都不带（不触发预检）');
});

test('重建档位：选了非默认档才带 `mode`；默认档/空 ⇒ 不传（老服务器照旧）', async () => {
    // 主脚本建包又不能手输指令，所以要给个选项 —— 这就是那个选项。
    // ★ 页面上"离线"并进了档位 ⇒ 每个预设发的是**下面这两种形状之一**。
    //   ① 离线档：只发布尔（档位就是标准档，默认档不发 `mode`）
    const off = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(off, '', true, 'standard');
    assert.equal(off.calls[0].opts.body, '{"offline":true}',
        '离线档 ⇒ 只带 offline:true（mode 是默认档，不发；老服务器照样认得）');
    //   ② 补抓档：布尔是 false、档位是那个档
    const low = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(low, '', false, 'needs-low');
    assert.equal(low.calls[0].opts.body, '{"offline":false,"mode":"needs-low"}',
        '补抓档 ⇒ offline:false + mode（页面能传的就这两样）');
    //   ⚠️ `offline:true` + 补抓档 是**非法组合**（`--offline` 与 `--force` 互斥，服务器会拒）——
    //      页面已经从源头排除了它（只有离线档是 `offline:true`，而它的 mode 就是标准档），
    //      见下面"档位表"那条断言。

    const needs = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(needs, '', null, 'needs');
    assert.equal(needs.calls[0].opts.body, '{"mode":"needs"}', '只给档位 ⇒ body 里只有 mode');

    const def = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(def, '', null, 'standard');
    assert.equal(def.calls[0].opts.body, undefined, '默认档 == 不加选项之前的行为 ⇒ 一个字节都不多发');

    const empty = fakeFetch(() => ({ json: { ok: true, started: true, status: null } }));
    await startBuild(empty, '', null, '');
    assert.equal(empty.calls[0].opts.body, undefined, '空档位也不传');
});

test('档位表：**联网那五档**的键与服务器 `build_chain.BUILD_MODES` 一一对应（+ 本地的「离线」档）', () => {
    // ⚠️ 这条钉的是**跨语言契约**：键名对不上 ⇒ 服务器认不出、按标准档跑（最坏情况是不会跑错东西，
    //    但用户会以为选项没生效）。改这里就要同步改 `scripts/build_chain.py` 的 BUILD_MODES。
    // ★ 「离线」不算「不联网」，所以 6 个档位都进下拉框：
    //   表里多了本地的 **`offline`** 档（= `offline:true` + 标准档，服务器侧没有这个键）；
    //   **除它之外的五个键**必须与服务器逐字一致。
    //   顺序 = **越轻越前**：
    //   离线（不联网）→ 标准（用现有原料）→ 按需求补抓 → 补抓+low → 兜底重探 → **全删重爬（最重）**。
    //   ★ **只有「全删重爬」会删原料、会整份重抓**（用户 2026-10-17 定的口径）。
    assert.deepEqual(BUILD_MODES.map(m => m.key),
        ['offline', 'standard', 'needs', 'needs-low', 'probe-all', 'purge']);
    assert.deepEqual(BUILD_MODES.filter(m => m.key !== 'offline').map(m => m.key),
        ['standard', 'needs', 'needs-low', 'probe-all', 'purge'], '除离线外的五个 = 服务器的五个');
    assert.equal(DEFAULT_BUILD_MODE, 'standard');
    assert.ok(BUILD_MODES.every(m => m.label && m.hint), '每个档位都要有标签与说明（下拉框与悬停都用）');
    assert.ok(BUILD_MODES.some(m => m.key === DEFAULT_BUILD_MODE), '默认档必须在表里');
    // 每个预设都要**两个轴都写全**（`offline` 一个布尔 + `mode` 一个枚举名）——
    // 漏一个 ⇒ 面板 `startBuild(undefined, undefined, !!preset.offline, preset.mode)` 会发出 `undefined`
    assert.ok(BUILD_MODES.every(m => typeof m.offline === 'boolean' && !!m.mode),
        '每个档位都同时给出 offline（轴 A）与 mode（轴 B）');
    // ⚠️ 「离线」与三个补抓档**互斥**（`--offline` 与 `--force` 互斥）⇒ 只有离线档可以是 offline:true
    assert.deepEqual(BUILD_MODES.filter(m => m.offline).map(m => m.key), ['offline'],
        '只有「离线重建」是离线档（补抓必须联网；拼一起会被服务器拒）');
    assert.equal(BUILD_MODES.find(m => m.key === 'offline').mode, 'standard',
        '离线档 = 标准档 + 不联网（它不补抓）');
});
