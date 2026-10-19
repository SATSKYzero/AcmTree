// ================================================================
// 冒烟测试：完整数据导出包里带本机 `me.json`（scripts/smoke/me-in-export.smoke.mjs）
//
// 来由（用户 2026-10-17）："me.json 应该进（主脚本）导出包 —— 它对应完整数据导出，**不上 GitHub**"。
// 即：那份包只在本机/信任的人之间流转 ⇒ **连凭据一起带上**，换台机器导入一次就全回来。
//
// 钉住三件：
//   ① 导出：`exportFullJSON` 把本机那份 `me.json` 挂进包里的顶层 `me` 一节；
//   ② 带不上也**照样导出成功**（主脚本接口没开是常态）—— 缺那一节 + toast 说清楚，不许静默；
//   ③ 导入：包里带 `me` ⇒ 往本机写回一次，且**不带 `sha256`**（恢复语义），
//      而且**不拖住导入**（`importFullJSON` 仍同步返回 `undefined`）。
//
// 全程 fetch 是桩，不碰网络、不碰磁盘。
// 跑法：npm run test:smoke
// ================================================================
import { installDom } from './dom.mjs';
import { installIndexedDb } from './idb.mjs';
import { group, ok, eq, deepEq, report } from './harness.mjs';

installDom();
installIndexedDb();

const { createInitialState } = await import('../../src/core/model/state.js');
const { AppState, replaceState } = await import('../../src/shell/state.js');
const { buildExportData } = await import('../../src/persistence/index.js');
const { setResolved } = await import('../../src/features/AutoImport/buildApi.js');
const { exportFullJSON, exportFullCompressedJSON, importFullJSON } =
    await import('../../src/handlers/H1_jsonIO.js');

replaceState(createInitialState());
setResolved(null);                       // 相对地址：`api/me`，由下面的 fetch 桩接住

// ---- 下载桩：把 Blob 拦下来（dom 桩有 document 与元素 click()，但 Node 没有 URL 那对 API）----
let lastBlob = null;
globalThis.URL.createObjectURL = (blob) => { lastBlob = blob; return 'blob:stub'; };
globalThis.URL.revokeObjectURL = () => {};

// ---- FileReader 桩：`importFullJSON` 读普通 JSON 走 `readAsText` ----
// ⚠️ `reader.onload` 是 **async** 的，而 `importFullJSON()` 本身同步返回 undefined ⇒
//    桩必须把那个 promise 接住，测试才有确定的等待点（与 `accounts.smoke.mjs` 同一条理由）。
let pendingImport = Promise.resolve();
globalThis.FileReader = class {
    _run(fn) {
        pendingImport = Promise.resolve(fn()).catch(() => {});
        return pendingImport;
    }
    readAsText(file) {
        this._run(() => this.onload({ target: { result: file._text } }));
    }
    readAsArrayBuffer(file) {
        const bytes = new TextEncoder().encode(file._text);
        this._run(() => this.onload({ target: { result: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } }));
    }
};

// ---- 服务器桩：`/api/me` 直给真值（不打码），PUT 记账 ----
const ME_DOC = { cf: { handle: 'someone', apiKey: 'REAL-CF-KEY', apiSecret: 'REAL-CF-SECRET' },
    qoj: { cookie: 'session=REAL-COOKIE' } };
const calls = [];
let meBroken = false;
globalThis.fetch = async (url, opts = {}) => {
    const method = String(opts.method || 'GET');
    calls.push({ url: String(url), method, body: opts.body });
    const okJson = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).includes('api/me')) {
        if (meBroken) throw new Error('连不上本机主脚本');
        if (method === 'PUT') {
            const sent = JSON.parse(opts.body);
            return okJson({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: 'b'.repeat(64),
                            mtime: 1700000000, doc: JSON.parse(sent.text) });
        }
        return okJson({ ok: true, path: 'acm-data/raw/Scaper/me.json', sha256: 'a'.repeat(64),
                        mtime: 1700000000, doc: ME_DOC });
    }
    return okJson({ ok: false, error: '不接这条' }, 404);
};

const toasts = [];
document.addEventListener('show-toast', (e) => toasts.push(`${e.detail.type}:${e.detail.message}`));

group('导出：包里带本机 me.json');
await exportFullJSON(AppState, false);
ok(lastBlob, '导出真的产出了一个 Blob（下载桩接住了）');
const payload = JSON.parse(await lastBlob.text());
deepEq(payload.me, ME_DOC, '★ 顶层 `me` 那一节就是本机那份 me.json（含凭据）');
ok(!!payload.nodes && !!payload.settings, '应用状态那几节照旧在（没被这一节挤掉）');
ok(toasts.some(t => t.includes('me.json')), 'toast 说清楚这次**带了**本机个人信息（不静默）');

group('导出：主脚本接口没开时照样导得出来');
meBroken = true;
lastBlob = null;
await exportFullJSON(AppState, false);
const payload2 = JSON.parse(await lastBlob.text());
eq('me' in payload2, false, '★ 读不到 /api/me ⇒ 包里没有 `me` 那一节');
ok(!!payload2.nodes, '★ 但导出**照样成功**（宁可少带，也不许导不出来）');
ok(toasts.some(t => t.includes('未含本机个人信息')), 'toast 明说"未含本机个人信息"', toasts.at(-1));
meBroken = false;

group('导入：包里带 me ⇒ 写回本机');
calls.length = 0;
const ret = importFullJSON({ name: 'full.json', _text: JSON.stringify(payload) });
eq(ret, undefined, '★ `importFullJSON` 仍**同步返回 undefined**（既有契约：这一笔没拖住它）');
await pendingImport;
await new Promise(r => setTimeout(r, 30));
const put = calls.find(c => c.method === 'PUT' && c.url.includes('api/me'));
ok(!!put, '★ 确实往本机写了一次 me.json');
if (put) {
    const sent = JSON.parse(put.body);
    eq(sent.sha256, '', '恢复语义：**不带 sha256**（不走"磁盘上被人改过"那道闸）');
    deepEq(JSON.parse(sent.text), ME_DOC, '写回去的就是包里那一份（逐字）');
}

group('它不进 EXPORT_KEYS（那是应用状态的名单）');
ok(!('me' in buildExportData(AppState)),
   '★ `buildExportData` 里没有 `me` —— me.json 在磁盘上、由主脚本管，只能由 H1_jsonIO 现读');

if (typeof CompressionStream !== 'undefined') {
    group('压缩导出：同一口径');
    calls.length = 0;
    lastBlob = null;
    await exportFullCompressedJSON(AppState, false);
    ok(!!lastBlob, '压缩导出也产出了 Blob');
    ok(calls.some(c => c.url.includes('api/me') && c.method === 'GET'), '压缩导出同样先去读了一次 /api/me');
}

report();
