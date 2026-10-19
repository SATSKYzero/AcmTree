// ================================================================
// 链接分类测试（元列 `链接分类` → 应用层派生）
// 依据：docs/field-rules.md
//
// 钉住的契约：
//   1. **取舍只在应用层**：爬取层只写 `链接分类`（`{类别: [{v, src}]}`），
//      到了这里才派生缓存值 `link`（**所有类别都进 `link`**，没有单独的分类链接字段）；
//   2. 缓存值 `link` 按**类别优先级**挑第一条：补题 → 榜单 → 仓库 → 其它（`LINK_KIND_PRIORITY`），
//      所以"有补题就是补题链接、没有也不会空着"；
//   3. **其余候选一条都不丢**：都进 `otherValues`（带 `linkKind`）→ 写进来源层 →
//      界面按类别分组显示（"「仓库」与「未知」两类也应在非空时显示"）。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlan } from '../features/AutoImport/plan.js';
import { applyFieldMap, RESERVED_KEYS } from '../features/AutoImport/fieldmap.js';
import { buildExtKeyIndex } from '../core/ops/upsert.js';
import {
    collectLinkGroups, buildLinkBlock, shortLinkText, LINK_KIND_CHIPS
} from '../view/linkChips.js';
import { LINK_KIND_LABELS, LINK_KIND_ORDER, LINK_KIND_PRIORITY } from '../core/linkKinds.js';
import { EXTERNAL_LINK_ATTRS } from '../utils/html.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * **跨语言**的类别表必须同步 —— 爬取层（Python）写进 `链接分类` 的类别 key，
 * 应用侧（JS）必须都认得出。
 *
 * 为什么要有这条：两边各有一份表（JS 带 emoji、多一个 UI 专用的
 * `unclassified`；Python 是纯中文 4 类），**没有别的测试钉住它们同步** ——
 * 哪一边单独加了第 5 类，应用侧就静默退化成「❔ 其它」，而且 Python 侧还会
 * 直接 `raise`（见 `crate.py` 的 `link_kinds()`），报错在爬虫、现象在界面。
 */
function pythonLinkKinds() {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'crate.py'), 'utf8');
    const m = src.match(/^LINK_KINDS\s*=\s*\(([^)]*)\)/m);
    assert.ok(m, 'crate.py 里应该有一行 `LINK_KINDS = (...)`');
    return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('跨语言类别表同步：Python 的 LINK_KINDS 必须都在 JS 标签表里', () => {
    const py = pythonLinkKinds();
    assert.deepEqual(py, ['board', 'problems', 'repo', 'browse', 'unknown'],
        'Python 侧 5 类（browse 是给容器节点用的，见 crate.py 的注释）');
    for (const kind of py) {
        assert.ok(LINK_KIND_LABELS[kind], `JS 标签表缺 Python 会产出的类别：${kind}`);
    }
    // `unclassified` 是**应用侧专用**（"这条值没告诉我们类别"），爬取层不许产出它
    assert.ok(LINK_KIND_LABELS.unclassified, 'JS 侧要有 unclassified');
    assert.equal(py.includes('unclassified'), false, 'Python 侧不许产出 unclassified');
});

test('两个顺序必须含同一套类别 key（显示顺序 vs 挑选优先级）', () => {
    // 这两个常量**故意不同**（一个是界面小标题顺序、一个是缓存值挑选优先级），
    // 但它们认的是**同一套词汇表** —— 只更新一处就会出现"挑得出来、显示不出来"。
    const display = [...LINK_KIND_ORDER].sort();
    const pick = [...LINK_KIND_PRIORITY, 'unclassified'].sort();
    assert.deepEqual(display, pick, '两者的 key 集合必须一致（unclassified 只参与显示）');
    // 口径本身也要钉住：缓存值优先取补题
    assert.equal(LINK_KIND_PRIORITY[0], 'problems', '有补题时 `link` 必须是补题链接');
});

const RESERVED = RESERVED_KEYS;   // `type` 已在其中

function makeState() {
    return {
        rootId: 'o',
        nodes: { o: { id: 'o', type: 'O', name: '根' } },
        childOrder: { o: [] },
        parentOf: { o: null }
    };
}

/** 造一个只含一条 C 记录的包（raw 里带元列 `链接分类`） */
function cNodeCrate(linkKinds, extraRaw = {}) {
    const raw = { extKey: 'xcpc:c:chengdu', name: '成都站', kind: 'contest', ...extraRaw };
    if (linkKinds) raw['链接分类'] = linkKinds;
    return {
        crateVersion: 1,
        source: { id: 'xcpcio-chengdu' },
        generatedAt: '',
        fieldMap: { name: 'name', kind: 'kind', contestTime: 'contestTime' },
        fieldPolicies: {},
        records: [{
            index: 0,
            type: 'C',
            extKey: 'xcpc:c:chengdu',
            parentExtKey: '',
            raw
        }]
    };
}

const plan = (crate, state) => buildPlan({
    crate,
    state,
    keyIndex: buildExtKeyIndex(state),
    applyFieldMap: (record, fieldMap) => applyFieldMap(record, fieldMap, { reservedKeys: RESERVED })
});

test('链接分类：所有类别都进 `link`，缓存值按 补题→榜单→仓库→其它 挑', () => {
    const state = makeState();
    const p = plan(cNodeCrate({
        board: [{ v: 'https://board.xcpcio.com/icpc/50th/chengdu', src: 'xcpcio-chengdu' }],
        problems: [{ v: 'https://qoj.ac/contest/2567', src: 'qoj-chengdu' }],
        repo: [{
            v: 'https://github.com/algoux/srk-collection/blob/master/official/icpc/icpc2025/icpc2025chengdu.srk.json',
            src: 'rankland-index-chengdu'
        }],
        unknown: [{ v: 'https://ccpc.io/', src: 'cf-web-chengdu' }]
    }), state);

    const rec = p.records[0];
    assert.equal(rec.fields.link, 'https://qoj.ac/contest/2567', '有补题时缓存值取补题');
    assert.equal(rec.fieldSources.link, 'qoj-chengdu');
    assert.deepEqual(rec.linkKindsByField, { link: 'problems' }, '缓存值的类别也带下去');

    // 被选中的那条不算"落选值"（否则界面上会重复显示同一个 URL）
    const others = rec.otherValues.link || [];
    assert.equal(others.some(x => x.v === 'https://qoj.ac/contest/2567'), false);

    // 其余候选**一条都不丢**，全部落在 `link` 字段下，且带着类别
    const asSet = new Set(others.map(x => `${x.linkKind}|${x.v}`));
    assert.ok(asSet.has('board|https://board.xcpcio.com/icpc/50th/chengdu'), '榜单要留下');
    assert.ok(asSet.has(
        'repo|https://github.com/algoux/srk-collection/blob/master/official/icpc/icpc2025/icpc2025chengdu.srk.json'));
    assert.ok(asSet.has('unknown|https://ccpc.io/'), '`unknown` 也要留下来（非空就显示）');
});

test('缓存值挑选：没有补题就退到榜单，再退到仓库（`link` 不会空着）', () => {
    const state = makeState();
    const p = plan(cNodeCrate({
        board: [{ v: 'https://board.xcpcio.com/x', src: 's-board' }],
        repo: [{ v: 'https://github.com/a/b', src: 's-repo' }]
    }), state);

    const rec = p.records[0];
    assert.equal(rec.fields.link, 'https://board.xcpcio.com/x', '没有补题 → 取榜单');
    assert.equal(rec.linkKindsByField.link, 'board');
    const others = rec.otherValues.link || [];
    assert.equal(others.some(x => x.v === 'https://github.com/a/b' && x.linkKind === 'repo'), true);
});

test('同类多条：取第一条，其余进落选值（一条都不丢）', () => {
    const state = makeState();
    const p = plan(cNodeCrate({
        problems: [
            { v: 'https://qoj.ac/contest/2567', src: 's-qoj' },
            { v: 'https://codeforces.com/gym/106589', src: 's-cf' }
        ]
    }), state);

    const rec = p.records[0];
    assert.equal(rec.fields.link, 'https://qoj.ac/contest/2567');
    const others = rec.otherValues.link || [];
    assert.deepEqual(others.map(x => [x.linkKind, x.v]), [
        ['problems', 'https://codeforces.com/gym/106589']
    ]);
});

test('没有 `链接分类` 的老包：一个字都不动（不凭空造 link）', () => {
    const state = makeState();
    const p = plan(cNodeCrate(null), state);

    const rec = p.records[0];
    assert.equal(rec.fields.link, undefined);
    assert.equal(rec.otherValues, null);
});

test('`链接分类` 的形状**只有一种**：`{v, src}`（归一在产出点，读取端不写容错）', () => {
    // ⚠️ 这条契约的由来：hdu / nk 不过 crate-merge，它们的条目可能是裸 URL；
    // 读取端不许"两种形状都认 + 出处回落"的容错 —— "数据处理的逻辑中一个特判都没有"，
    // **归一在产出点**（`scripts/crate.py` 的
    // `Crate._normalize_link_kinds`，裸 URL 在那里就被补成 `{v, src}`），
    // 所以这里读的就是一种形状；空值 / 缺 `src` 的条目按契约视为非法，跳过。
    const state = makeState();
    const p = plan(cNodeCrate({
        problems: [{ v: '', src: 's-empty' }, { v: 'https://qoj.ac/contest/1', src: '' }],
        board: [{ v: 'https://board.xcpcio.com/y', src: 's-board' }]
    }), state);

    const rec = p.records[0];
    assert.equal(rec.fields.link, 'https://board.xcpcio.com/y', '空值/缺 src 的条目跳过');
    assert.equal(rec.linkKindsByField.link, 'board');
    assert.equal(rec.otherValues, null, '没有合法的落选值');
});

test('链接块：折叠头 + 按类别分组，仓库/其它也成组（非空就显示）', () => {
    const node = {
        id: 'c1',
        type: 'C',
        name: '成都站',
        extKey: 'xcpc:c:chengdu',
        values: {
            // **所有类别都在 `link` 一个字段里**（没有单独的分类链接字段）
            link: [
                { v: 'https://board.xcpcio.com/x', src: 's-board', at: '', linkKind: 'board' },
                { v: 'https://qoj.ac/contest/2567', src: 's-qoj', at: '', linkKind: 'problems' },
                { v: 'https://codeforces.com/gym/106589', src: 's-cf', at: '', linkKind: 'problems' },
                { v: 'https://github.com/a/b', src: 's-repo', at: '', linkKind: 'repo' }
            ]
        }
    };

    const html = buildLinkBlock({}, node);

    // 折叠头：总数 = 4 条候选
    assert.ok(html.includes('<details'), '默认折叠（原生 details）');
    assert.ok(html.includes('🔗 链接 (4)'), `折叠头带总数：${html.slice(0, 80)}`);

    // 小标题 = 类别，顺序：榜单 → 补题 → 仓库
    const order = ['🏆 榜单', '🔗 补题', '📦 仓库'].map(l => html.indexOf(l));
    assert.ok(order.every(i => i >= 0), '三类都要有小标题');
    assert.deepEqual([...order].sort((a, b) => a - b), order, '小标题按榜单→补题→仓库排列');

    // 同类多条都列着（一条都不丢）
    assert.ok(html.includes('qoj.ac/contest/2567'));
    assert.ok(html.includes('codeforces.com/gym/106589'));

    // 选中的那条加粗（.pick）—— 投影选的是"补题优先"的第一条
    assert.equal((html.match(/class="link pick"/g) || []).length, 1, '只有一个选中值');
});

test('链接块：没有类别信息的老值归入「🔗 链接」组，不假装知道类别', () => {
    const node = {
        id: 'c2',
        type: 'C',
        name: '老场次',
        extKey: 'xcpc:c:old',
        values: {
            link: [{ v: 'https://example.com/contest', src: 's-old', at: '' }]
        }
    };
    const groups = collectLinkGroups({}, node);
    assert.deepEqual(groups.map(g => g.kind), ['unclassified']);
    assert.equal(groups[0].label, LINK_KIND_CHIPS.unclassified);

    const html = buildLinkBlock({}, node);
    assert.ok(html.includes('🔗 链接 (1)'));
    assert.ok(html.includes('https://example.com/contest'));
    assert.ok(!html.includes('📦'), '不该凭空冒出别的类别');
});

test('链接块：一个链接都没有 → 不渲染（不留空块）', () => {
    const node = { id: 'c3', type: 'C', extKey: 'xcpc:c:empty', values: {} };
    assert.equal(buildLinkBlock({}, node), '');
    assert.deepEqual(collectLinkGroups({}, node), []);
});

test('链接块：被标「不用」的值（invalid）不显示，但同类别其它值照常', () => {
    const node = {
        id: 'c4',
        type: 'C',
        extKey: 'xcpc:c:inv',
        values: {
            link: [
                { v: 'https://qoj.ac/contest/1', src: 's-qoj', at: '', linkKind: 'problems' },
                { v: 'https://vjudge.net/contest/1', src: 's-vj', at: '', linkKind: 'problems', invalid: true }
            ]
        }
    };
    const html = buildLinkBlock({}, node);
    assert.ok(html.includes('🔗 链接 (1)'), 'invalid 的不计入总数');
    assert.equal(html.includes('vjudge.net'), false, 'invalid 不显示');
});

test('长链接截断显示，完整 URL 仍在 title 里（不丢信息）', () => {
    const long = `https://github.com/algoux/srk-collection/blob/master/official/icpc/${'x'.repeat(60)}.srk.json`;
    assert.ok(shortLinkText(long).length <= 46);
    const node = {
        id: 'c5',
        type: 'C',
        extKey: 'xcpc:c:long',
        values: { link: [{ v: long, src: 's-repo', at: '', linkKind: 'repo' }] }
    };
    const html = buildLinkBlock({}, node);
    assert.ok(html.includes(long), '完整 URL 在 title 属性里');
});

test('外链都带 `noopener noreferrer` + `referrerpolicy="no-referrer"`（防盗链站点不按 Referer 回 403）', () => {
    // 实测（"点击 403 Forbidden openresty、复制到新标签页就好"）：
    // `board.xcpcio.com` 带 `Referer: http://localhost:8000/` → **403**，不带 → 200。
    // 所以外链一律**不发 Referer**：这是"为什么某几个链接点不开"的根因，钉在这里防回归。
    const node = {
        id: 'c6',
        type: 'C',
        extKey: 'xcpc:c:board',
        values: { link: [{ v: 'https://board.xcpcio.com/provincial-contest/2024/beijing', src: 's-x', at: '', linkKind: 'board' }] }
    };
    const html = buildLinkBlock({}, node);
    assert.ok(html.includes('rel="noopener noreferrer"'), html.slice(0, 160));
    assert.ok(html.includes('referrerpolicy="no-referrer"'), '不发 Referer');
    assert.ok(html.includes('target="_blank"'), '仍然新标签打开');
    // 属性是**同一份常量**（三个渲染点不许各写各的）
    assert.ok(EXTERNAL_LINK_ATTRS.includes('noreferrer'));
});
