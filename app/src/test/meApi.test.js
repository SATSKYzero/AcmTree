// ================================================================
// `me.json` 读写客户端的单测（src/test/meApi.test.js）
//
// 口径："me.json 又有 json 修改又有 ui 修改（像 vsc 的设置那种）"。
//
// 这里钉客户端这一侧**只交文本、交不了路径**的边界，以及三种失败要说人话：
//   ① 读：**原样透传**服务器那份文档（不打码 —— "页面隐藏 cookie
//      之类的完全没有必要"；边界交给服务器：只对回环 Origin 放行 + 写前三道闸）；
//      ⚠️ 文件还没建（`exists:false`）**不算失败** —— 那是第一次装的合法状态，设置页要能填；
//   ② 写：body 只有 `{text, sha256}` 两个键（页面传不了文件名/命令）；
//   ③ 409（磁盘变了）要能被调用方认出来（`err.status`），别当成普通网络错误；
//   ④ 接口不在（没起主脚本）时**探活不抛**，设置页要能提示"用启动AcmTree.bat 起服务器"；
//   ⑤ 登录态探活（41k）：`POST /api/auth-probe` 只交「平台名 + 覆盖值」，`code` 原样带回。
// 全部用**注入的 fetch** 测，不碰网络、不碰磁盘。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ME_API_PATH, AUTH_PROBE_PATH, fetchMe, saveMe, probeMeApi, mtimeText, authProbe }
    from '../ui/MeEditor/meApi.js';
import { setResolved } from '../features/AutoImport/buildApi.js';

/** 造一个"像 fetch 一样"的桩 */
function fakeFetch(handler) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), method: String(opts.method || 'GET'), opts });
        const out = handler(String(url), opts);
        if (out instanceof Error) throw out;
        return {
            ok: out.status ? out.status < 400 : true,
            status: out.status || 200,
            json: async () => out.json
        };
    };
    fn.calls = calls;
    return fn;
}

const DOC = { cf: { handle: 'X', apiKey: 'REAL-KEY' }, nk: { byYear: { '2023': '甲' } } };
const OK = { ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: 'a'.repeat(64), mtime: 1700000000,
    doc: DOC };

test('读：走 GET /api/me，把服务器那份文档 + sha256 原样带回来（**不打码**）', async () => {
    const f = fakeFetch(() => ({ json: OK }));
    setResolved(null);
    const got = await fetchMe(f);
    assert.equal(f.calls[0].url, ME_API_PATH);
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(got.sha256, 'a'.repeat(64));
    assert.equal(got.doc.cf.apiKey, 'REAL-KEY', '★ 原样带回来（页面自己看得见才敢改）');
    assert.equal(got.sentinel, undefined, '没有 sentinel 这一套（不打码）');
});

test('读：接口报错（服务器说 ok:false）⇒ 抛错并带上 HTTP 状态', async () => {
    const f = fakeFetch(() => ({ status: 404, json: { ok: false, error: '没有 me.json' } }));
    await assert.rejects(() => fetchMe(f), (err) => {
        assert.equal(err.message, '没有 me.json');
        assert.equal(err.status, 404);
        return true;
    });
});

test('读：文件还没建（exists:false + 空文档）⇒ **不抛**，`exists` 原样带出来', async () => {
    // 2026-10-19（用户："me.json 应在为空时仍允许账户写入，否则初次建包信息无法填全"）：
    // 第一次装 / 发布副本里连 `个人数据/` 都没有，服务器对这种情况回 200 + 空文档
    // ⇒ 设置页必须进可编辑状态（旧口径靠 404 ⇒ 页面只剩一句"读不到 me.json"）。
    const f = fakeFetch(() => ({ json: { ok: true, path: '个人数据/me.json', exists: false,
        sha256: '', mtime: 0, doc: {} } }));
    const got = await fetchMe(f);
    assert.equal(got.exists, false, '★ 界面靠它说"还没有 me.json，保存一次就会建出来"');
    assert.deepEqual(got.doc, {}, '空文档 ⇒ 表单空着，照样能填');
    assert.equal(got.sha256, '', '空 sha ⇒ 第一次保存不会撞 409');
});

test('写：PUT 的 body 只有 text 与 sha256（页面传不了路径、更传不了命令）', async () => {
    const f = fakeFetch(() => ({ json: OK }));
    setResolved(null);
    await saveMe(f, '', { text: '{}\n', sha256: 'b'.repeat(64) });
    assert.equal(f.calls[0].method, 'PUT');
    const body = JSON.parse(f.calls[0].opts.body);
    assert.deepEqual(Object.keys(body).sort(), ['sha256', 'text']);
    assert.equal(body.text, '{}\n');
    assert.equal(body.sha256, 'b'.repeat(64));
    assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/json');
});

test('写：不带 sha256 也能交（服务器那道冲突闸就跳过）', async () => {
    const f = fakeFetch(() => ({ json: OK }));
    await saveMe(f, '', { text: '{}' });
    assert.equal(JSON.parse(f.calls[0].opts.body).sha256, '');
});

test('写：409（磁盘上那份变过了）⇒ `err.status === 409`，提示词是服务器给的', async () => {
    const f = fakeFetch(() => ({ status: 409, json: { ok: false, error: '磁盘上的 me.json 变过了（冲突）' } }));
    await assert.rejects(() => saveMe(f, '', { text: '{}' }), (err) => {
        assert.equal(err.status, 409);
        assert.match(err.message, /变过/);
        return true;
    });
});

test('探活：主脚本在跑（/api/ping 答话）就用它那个 base', async () => {
    const f = fakeFetch((url) => (url.includes('api/ping')
        ? { json: { ok: true, api: 2, root: 'D:/repo' } }
        : { json: OK }));
    const probe = await probeMeApi(f, ['']);
    assert.equal(probe.ok, true);
    assert.equal(probe.base, '');
    assert.equal(probe.root, 'D:/repo');
});

test('探活：主脚本没跑 ⇒ `ok:false` 且**不抛**（设置页据此给一句人话）', async () => {
    const f = fakeFetch(() => new Error('连不上'));
    const probe = await probeMeApi(f, ['', 'http://127.0.0.1:8321/']);
    assert.equal(probe.ok, false);
    assert.ok(probe.tried.length >= 2, '记下试过哪些地址（排错用）');
});

test('探活：/api/ping 没有但 /api/me 在 ⇒ 也算找到', async () => {
    const f = fakeFetch((url) => (url.includes('api/ping')
        ? { status: 404, json: { ok: false } }
        : { json: { ok: false, error: '没有 me.json' } }));
    const probe = await probeMeApi(f, ['']);
    assert.equal(probe.ok, true, '答得出 /api/me 就够（哪怕 me.json 还不存在）');
    assert.equal(probe.me, true);
});

test('最后改动时间给人看（本地时区，补零）', () => {
    assert.equal(mtimeText(0), '未知');
    assert.match(mtimeText(1700000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

// ================================================================
// 41k：登录态探活（`POST /api/auth-probe`）
// ================================================================
test('探活：POST /api/auth-probe，body 只有「平台名 + 覆盖值」（传不了命令）', async () => {
    const f = fakeFetch(() => ({ json: { ok: true, code: 0, platform: 'qoj', output: '✅ 正常' } }));
    const got = await authProbe(f, '', { platform: 'qoj', overrides: { 'qoj.cookie': 'session=abc' } });
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].url, AUTH_PROBE_PATH);
    const body = JSON.parse(f.calls[0].opts.body);
    assert.deepEqual(Object.keys(body).sort(), ['overrides', 'platform'], '只有这两个键');
    assert.equal(body.platform, 'qoj');
    assert.deepEqual(body.overrides, { 'qoj.cookie': 'session=abc' });
    assert.equal(got.code, 0);
    assert.match(got.output, /正常/);
});

test('探活：过期（子进程退出码 1）也**不抛** —— 那句话要照原样显示给用户', async () => {
    const f = fakeFetch(() => ({
        json: { ok: true, code: 1, platform: 'qoj',
                output: '❌ QOJ 登录态失效…去 me.json 换 cookie' }
    }));
    const got = await authProbe(f, '', { platform: 'qoj' });
    assert.equal(got.code, 1, '调用方靠 code 判"有效没有"，不靠抛异常');
    assert.match(got.output, /换 cookie/);
});

test('探活：参数不合法（400）⇒ 抛，并把服务器那句话带出来', async () => {
    const f = fakeFetch(() => ({ status: 400, json: { ok: false, error: 'platform 只允许 [a-z0-9_-]{1,16}' } }));
    await assert.rejects(() => authProbe(f, '', { platform: 'x; rm -rf /' }), (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /platform/);
        return true;
    });
});
