// ================================================================
// 插件清单解析测试（纯逻辑）
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolvePluginEntries, normalizePluginPath } from '../shell/pluginManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const entry = (over = {}) => ({ name: 'P', path: '/src/p/index.js', activate: 'act', ...over });
const names = res => res.entries.map(e => e.name);

// ================================================================
// **真实的 `plugins.json`**
//
// 上面那些用例全用**合成条目**，于是"清单里少了一项 / 路径写错"永远测不出来 ——
// 而 `bootstrap.js` 读不到清单时的表现是"检索、自动导入这些页**无提示地消失**"。
// 这两条盯的是**仓库里那份真清单**：文件必须在、名字与导出都得对得上。
// ================================================================
test('真实 plugins.json：每个条目的文件都在、`activate` 导出名也写在那个文件里', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'));
    const entries = Array.isArray(cfg.plugins) ? cfg.plugins : [];
    assert.ok(entries.length >= 3, `清单里至少该有那 3 个插件页（实际 ${entries.length}）`);

    const bad = [];
    for (const e of entries) {
        const rel = String(e.path || '').replace(/^\//, '');          // '/src/features/x/index.js' → 仓库相对
        const abs = path.join(ROOT, ...rel.split('/'));
        if (!fs.existsSync(abs)) {
            bad.push(`${e.name}：路径不存在 ${e.path}`);
            continue;
        }
        const src = fs.readFileSync(abs, 'utf8');
        // 只要"那个名字确实被导出"（不 import：插件会拉 DOM，单测环境里跑不起来）
        const declared = new RegExp(`export\\s+(async\\s+)?(function|const|let)\\s+${e.activate}\\b`).test(src)
            || new RegExp(`export\\s*\\{[^}]*\\b${e.activate}\\b`).test(src);
        if (!declared) bad.push(`${e.name}：${rel} 里没有导出 ${e.activate}`);
    }
    assert.deepEqual(bad, [], '清单与实际文件对不上 ⇒ 那个插件页会静默消失');
});

test('真实 plugins.json：那 3 个"提供页面"的插件一个都不能少', () => {
    // 它们各自代表一页/一个入口：少一个，用户看到的是"这版怎么没那页了"（没有报错）
    // ⚠️ `TestnumOp` **不在**这份名单里 —— 它是示例插件（不给页面），已按要求**拔掉**
    //    （2026-10-07：用户"把那个插件拔了"）；它的代码与插件 API 文档都还在，只是不插上。
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins.json'), 'utf8'));
    const got = new Set((cfg.plugins || []).map(e => String(e.name)));
    for (const name of ['ContestOverview', 'Search', 'AutoImport']) {
        assert.ok(got.has(name), `清单里少了「${name}」—— 它提供的那一页会静默消失`);
    }
});

// ================================================================
// 路径归一化
// ================================================================

test('normalizePluginPath 兼容 ./ 与 / 前缀', () => {
    assert.equal(normalizePluginPath('/src/a.js'), '/src/a.js');
    assert.equal(normalizePluginPath('./src/a.js'), '/src/a.js');
    assert.equal(normalizePluginPath('src/a.js'), '/src/a.js');
});

// ================================================================
// 正常解析
// ================================================================

test('单个合法条目被解析并归一化路径', () => {
    const res = resolvePluginEntries({ plugins: [entry({ name: 'A', path: './src/a.js', activate: 'go' })] });
    assert.deepEqual(names(res), ['A']);
    assert.equal(res.entries[0].fullPath, '/src/a.js');
    assert.equal(res.entries[0].activate, 'go');
    assert.deepEqual(res.entries[0].requires, []);
    assert.deepEqual(res.problems, []);
    assert.deepEqual(res.skipped, []);
});

test('空配置 / 非法配置返回空结果而不抛错', () => {
    for (const cfg of [null, undefined, {}, { plugins: null }, { plugins: 'x' }, []]) {
        const res = resolvePluginEntries(cfg);
        assert.deepEqual(res.entries, []);
        assert.deepEqual(res.problems, []);
    }
});

test('entries 与 skipped 互斥：enabled=false 不进 entries', () => {
    const res = resolvePluginEntries({
        plugins: [entry({ name: 'A' }), entry({ name: 'B', path: './src/b.js', enabled: false })]
    });
    assert.deepEqual(names(res), ['A']);
    assert.deepEqual(res.skipped.map(s => s.name), ['B']);
    assert.match(res.skipped[0].reason, /enabled=false/);
    assert.deepEqual(res.problems, []);
});

test('enabled=true 与缺省都视作启用', () => {
    const res = resolvePluginEntries({
        plugins: [entry({ name: 'A' }), entry({ name: 'B', path: './src/b.js', enabled: true })]
    });
    assert.deepEqual(names(res), ['A', 'B']);
});

// ================================================================
// 格式校验
// ================================================================

test('缺少必填字段的条目被记为问题并排除', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: '' }),
            entry({ name: 'B', path: '' }),
            entry({ name: 'C', path: './src/c.js', activate: '' }),
            entry({ name: 'OK', path: './src/ok.js' })
        ]
    });
    assert.deepEqual(names(res), ['OK']);
    assert.equal(res.problems.length, 3);
});

test('非对象条目被记为问题', () => {
    const res = resolvePluginEntries({ plugins: [null, 'x', 42, [], entry({ name: 'OK' })] });
    assert.deepEqual(names(res), ['OK']);
    assert.equal(res.problems.length, 4);
});

test('插件名重复：后者被排除', () => {
    const res = resolvePluginEntries({
        plugins: [entry({ name: 'A', path: './src/a1.js' }), entry({ name: 'A', path: './src/a2.js' })]
    });
    assert.deepEqual(names(res), ['A']);
    assert.equal(res.entries[0].fullPath, '/src/a1.js');
    assert.equal(res.problems.length, 1);
    assert.match(res.problems[0].reason, /重复/);
});

test('路径重复（归一化后相同）：后者被排除', () => {
    const res = resolvePluginEntries({
        plugins: [entry({ name: 'A', path: '/src/same.js' }), entry({ name: 'B', path: './src/same.js' })]
    });
    assert.deepEqual(names(res), ['A']);
    assert.equal(res.problems.length, 1);
    assert.match(res.problems[0].reason, /重复/);
});

test('requires 非字符串数组被记为问题', () => {
    for (const bad of ['A', 1, [1], ['']]) {
        const res = resolvePluginEntries({ plugins: [entry({ name: 'B', path: './src/b.js', requires: bad })] });
        assert.deepEqual(names(res), []);
        assert.equal(res.problems.length, 1);
        assert.match(res.problems[0].reason, /requires/);
    }
});

// ================================================================
// 依赖排序
// ================================================================

test('依赖者排在被依赖者之后（即使清单顺序相反）', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: 'B', path: './src/b.js', requires: ['A'] }),
            entry({ name: 'A', path: './src/a.js' })
        ]
    });
    assert.deepEqual(names(res), ['A', 'B']);
    assert.deepEqual(res.problems, []);
});

test('无依赖关系时保持清单原顺序', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: 'A', path: './src/a.js' }),
            entry({ name: 'B', path: './src/b.js' }),
            entry({ name: 'C', path: './src/c.js' })
        ]
    });
    assert.deepEqual(names(res), ['A', 'B', 'C']);
});

test('多级依赖被正确排序', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: 'C', path: './src/c.js', requires: ['B'] }),
            entry({ name: 'B', path: './src/b.js', requires: ['A'] }),
            entry({ name: 'A', path: './src/a.js' })
        ]
    });
    assert.deepEqual(names(res), ['A', 'B', 'C']);
});

test('依赖缺失：记为问题但条目仍保留可用', () => {
    const res = resolvePluginEntries({
        plugins: [entry({ name: 'B', path: './src/b.js', requires: ['Ghost'] })]
    });
    assert.deepEqual(names(res), ['B']);
    assert.equal(res.problems.length, 1);
    assert.match(res.problems[0].reason, /Ghost/);
});

test('依赖被 enabled=false 禁用：记为问题', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: 'A', path: './src/a.js', enabled: false }),
            entry({ name: 'B', path: './src/b.js', requires: ['A'] })
        ]
    });
    assert.deepEqual(names(res), ['B']);
    assert.deepEqual(res.skipped.map(s => s.name), ['A']);
    assert.equal(res.problems.length, 1);
});

test('依赖成环：记为问题且不丢失任何条目', () => {
    const res = resolvePluginEntries({
        plugins: [
            entry({ name: 'A', path: './src/a.js', requires: ['B'] }),
            entry({ name: 'B', path: './src/b.js', requires: ['A'] })
        ]
    });
    assert.equal(res.entries.length, 2);
    assert.equal(res.problems.length, 1);
    assert.match(res.problems[0].reason, /成环/);
});
