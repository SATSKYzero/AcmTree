// ================================================================
// 回代 baseline「直接写盘」客户端的单测（src/test/natureBaselineApi.test.js）
//
// 口径："注册表是否是完整数据导出的一部分？如果是，`acm-data/nature-assignments.json`
// 就不用备份，直接写入" + "**后者**"（缩水时**先拒绝、要人确认**）。
//
// 这里钉客户端这一侧**只交文档、交不了路径**的边界，以及缩水那条路的读法：
//   ① 写：body 只有 `{doc, confirm}` 两个键（页面传不了文件名/命令）；
//   ② 正常 ⇒ 返回 `{path, count, fields, diff}`（页面拿它拼 toast）；
//   ③ 409（缩水被拒）要能被调用方认出来（`err.status` + `err.data.diff.removedKeys`），
//      别当成普通网络错误（那样永远看不到"少了什么"）；
//   ④ 网络不通 ⇒ 抛（调用方据此**退回下载**）；
//   ⑤ `diffText()` 说的是**完整数字**（不是被服务器截断的那几个 key）。
// 全部用**注入的 fetch** 测，不碰网络、不碰磁盘。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NATURE_ASSIGNMENTS_PATH, saveNatureBaseline, fetchNatureBaseline, diffText }
    from '../core/natureBaselineApi.js';
import { setResolved } from '../core/localServer.js';

/** 造一个"像 fetch 一样"的桩（与 `meApi.test.js` 那份同形） */
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

const DOC = { format: 'nature-assignments', version: 1, generatedAt: '2026-10-04T00:00:00.000Z',
    registryVersion: 1, count: 1, fields: 1,
    assignments: [{ extKey: 'qoj:c:1', fields: { natureYear: { v: '2020', rule: 'manual:set' } } }] };

const OK = { ok: true, path: 'acm-data/nature-assignments.json', count: 1, fields: 1, mtime: 1,
    diff: { added: 1, removed: 0, changed: 0, addedKeys: ['qoj:c:1'], removedKeys: [], changedKeys: [] } };

test('写：走 POST /api/nature-assignments，body 只有 doc 与 confirm（传不了路径/文件名）', async () => {
    const f = fakeFetch(() => ({ json: OK }));
    setResolved(null);
    const got = await saveNatureBaseline(f, '', { doc: DOC });
    assert.equal(f.calls[0].url, NATURE_ASSIGNMENTS_PATH);
    assert.equal(f.calls[0].method, 'POST');
    assert.equal(f.calls[0].opts.headers['Content-Type'], 'application/json');
    const body = JSON.parse(f.calls[0].opts.body);
    assert.deepEqual(Object.keys(body).sort(), ['confirm', 'doc']);
    assert.equal(body.confirm, false, '默认不带 confirm（缩水时必须先被拒一次）');
    assert.equal(body.doc.format, 'nature-assignments');
    assert.equal(got.path, 'acm-data/nature-assignments.json');
    assert.equal(got.count, 1);
    assert.equal(got.fields, 1);
    assert.equal(got.diff.added, 1, 'diff 原样带回来（页面用它拼 toast）');
});

test('写：`confirm: true` 只在那一次带', async () => {
    const f = fakeFetch(() => ({ json: OK }));
    await saveNatureBaseline(f, '', { doc: DOC, confirm: true });
    assert.equal(JSON.parse(f.calls[0].opts.body).confirm, true);
});

test('写：缩水被拒 ⇒ `err.status === 409` 且 `err.data.diff.removedKeys` 能给人看', async () => {
    const shrink = { ok: false, needConfirm: true,
        error: '这次比磁盘上那份少了 1 个节点（1 处值）——先确认再写',
        diff: { added: 0, removed: 1, changed: 0, removedKeys: ['qoj:c:3871'] } };
    const f = fakeFetch(() => ({ status: 409, json: shrink }));
    await assert.rejects(() => saveNatureBaseline(f, '', { doc: DOC }), (err) => {
        assert.equal(err.status, 409, '★ 调用方靠它认"缩水被拒"（不是网络错误）');
        assert.deepEqual(err.data.diff.removedKeys, ['qoj:c:3871']);
        assert.match(err.message, /少了 1 个节点/, '提示词是服务器给的那句');
        return true;
    });
});

test('写：形状不合法（400）也带状态；网络不通 ⇒ 抛（调用方退回下载）', async () => {
    const bad = fakeFetch(() => ({ status: 400, json: { ok: false, error: '缺 assignments' } }));
    await assert.rejects(() => saveNatureBaseline(bad, '', { doc: DOC }), (err) => {
        assert.equal(err.status, 400);
        return true;
    });
    const dead = fakeFetch(() => new Error('连不上'));
    await assert.rejects(() => saveNatureBaseline(dead, '', { doc: DOC }), /连不上/);
});

test('读：GET 回磁盘上那份（还没有时 doc 为 null —— 那是合法状态）', async () => {
    const none = fakeFetch(() => ({ json: { ok: true, path: 'acm-data/nature-assignments.json',
        doc: null, count: 0, fields: 0 } }));
    const got = await fetchNatureBaseline(none, '');
    assert.equal(none.calls[0].method, 'GET');
    assert.equal(got.doc, null);
    assert.equal(got.count, 0);
});

test('diffText：说的是**完整数字**（服务器回带的 key 列表是截断的）', () => {
    assert.equal(diffText({ added: 3, changed: 1, removed: 0 }), '新增 3 / 改过 1');
    assert.equal(diffText({ added: 0, changed: 0, removed: 0 }), '与磁盘上那份一致');
    assert.equal(diffText(null), '');
});
