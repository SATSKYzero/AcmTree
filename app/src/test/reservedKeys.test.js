// ================================================================
// 结构键清单**只有一处**（`features/AutoImport/fieldmap.js` 的 `RESERVED_KEYS`）
//
// 病根：清单一旦分处存放 —— `fieldmap.js` 的 `RESERVED_KEYS`、
// `parse.js` 自己抄的 `STRUCTURAL_KEYS`（两份差着 `type`），`type` 就得靠多处
// `[...RESERVED_KEYS, 'type']` 现拼对齐（应用、冒烟、单测各拼一遍）。
// 加一个结构键要记得改两处，漏一处的症状是"已经被用掉的信息
// 被报成未使用字段"。
//
// `type` 在 `RESERVED_KEYS` 里，`parse.js` / `plan/prepare.js` / `index.js` 都 import 它。
// 下面两条：① 行为上"结构键确实被排除在映射/未使用之外"；② 源码级 lint —— 不许再有第二份清单。
// ================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyFieldMap, RESERVED_KEYS } from '../features/AutoImport/fieldmap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const readSrc = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

test('结构键：`type` / `节点类型` 都在清单里，且**都不进字段、也不报未使用**', () => {
    assert.ok(RESERVED_KEYS.includes('type'), '应用形状的 `type` 必须在清单里');
    assert.ok(RESERVED_KEYS.includes('节点类型'), '包形状的 `节点类型` 必须在清单里');
    for (const key of ['extKey', '父extKey', '父synthKey', '字段来源', '分类依据', '链接分类']) {
        assert.ok(RESERVED_KEYS.includes(key), `结构键 ${key} 必须在清单里`);
    }
    // 行为：这两种写法的身份列都既不当字段、也不算"未使用列"
    const rec = { 节点类型: 'C', type: 'C', extKey: 'qoj:c:1', 名字: 'x' };
    const out = applyFieldMap(rec, { 名字: 'name' });
    assert.deepEqual(Object.keys(out.fields), ['name']);
    assert.deepEqual(out.unmapped, [], '身份列不许冒成"未使用字段"');
    assert.deepEqual(out.ignored, []);
});

//: 剥注释（行注释与块注释）——注释里提旧写法不算
const stripComments = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * 找"又抄了一份结构键清单"或"给 RESERVED_KEYS 现拼 type"的地方。
 *
 * ⚠️ **判据不看变量名叫什么**（只看名字挡不住换个名字照抄一份，
 * 例如 `const RESERVED_KEYS_LOCAL = ['节点类型','type','extKey','父extKey'];`）。
 * 判据认的是**内容**：
 *   ① 一个数组字面量里**同时**出现 `'节点类型'` 与 `'type'` 两个字面量 ⇒ 那就是一份结构键清单；
 *   ② 一个数组字面量里既有 `...`（展开）又有 `'type'` 字面量 ⇒ 那就是 `[...RESERVED_KEYS, 'type']`。
 * 而且**按整文件匹配**（按行 split 的话多行字面量能躲掉）。
 */
function reservedKeyOffenders(rel, text) {
    const t = stripComments(text);
    const out = [];
    //: 数组字面量：从 `[` 到这个 `]`（允许跨行；限长是为了别把两处无关的括号凑成一对）
    for (const m of t.matchAll(/\[[^\]]{0,400}\]/g)) {
        const body = m[0];
        // 真源那一份是**赋给 `RESERVED_KEYS` 的**（`fieldmap.js` 导出的就是它）⇒ 放行；
        // 任何**别的**数组里同时有这两个字面量，就是抄了一份。
        const before = t.slice(Math.max(0, m.index - 60), m.index);
        const isDefinition = /RESERVED_KEYS\s*=\s*(?:Object\.freeze\(\s*)?$/.test(before);
        const hasNodeType = /['"]节点类型['"]/.test(body);
        const hasType = /['"]type['"]/.test(body);
        if (isDefinition) continue;
        if (hasNodeType && hasType) {
            out.push(`${rel} 又抄了一份结构键清单（应 import RESERVED_KEYS）→ ${body.replace(/\s+/g, ' ').slice(0, 60)}`);
        } else if (hasType && /\.\.\./.test(body)) {
            out.push(`${rel} 还在现拼 [...RESERVED_KEYS, 'type']（type 已在其中）→ ${body.replace(/\s+/g, ' ').slice(0, 60)}`);
        }
    }
    return out;
}

test('源码级 lint：不许再出现第二份结构键清单 / 不许再现拼 `[...RESERVED_KEYS, \'type\']`', () => {
    const files = [
        'src/features/AutoImport/parse.js',
        'src/features/AutoImport/plan/prepare.js',
        'src/features/AutoImport/index.js',
        'src/features/AutoImport/fieldmap.js',
        'scripts/smoke/link-kinds.smoke.mjs',
        'scripts/smoke/auto-import.smoke.mjs',
        'scripts/crate-check.mjs'
    ];
    const offenders = files.flatMap(rel => reservedKeyOffenders(rel, readSrc(rel)));
    assert.deepEqual(offenders, [], '结构键清单只能有一处');
});

test('★ 上面那条 lint 自己会咬（含"换个名字"的躲法）', () => {
    // 真源那一份是赋给 `RESERVED_KEYS` 的 ⇒ 放行（不然守卫一上来就红）
    assert.deepEqual(reservedKeyOffenders('假.js',
        "export const RESERVED_KEYS = Object.freeze(['节点类型', 'type', 'extKey']);"), [], '定义处不算抄');
    // ★ 一种躲法：换个名字照抄一份
    assert.equal(reservedKeyOffenders('假.js',
        "const RESERVED_KEYS_LOCAL = ['节点类型', 'type', 'extKey', '父extKey'];").length, 1,
    '换个名字照抄一份必须抓');
    // 多行写法也要抓（按行 split 会躲掉）
    assert.equal(reservedKeyOffenders('假.js',
        "const K = [\n  '节点类型',\n  'type',\n  'extKey'\n];").length, 1, '多行也要抓');
    // 现拼 type
    assert.equal(reservedKeyOffenders('假.js', "const a = [...RESERVED_KEYS, 'type'];").length, 1, '现拼要抓');
    assert.equal(reservedKeyOffenders('假.js', "const a = [...RK, 'type'];").length, 1, '换个简称也要抓');
    // 这些**不该**被误伤
    assert.deepEqual(reservedKeyOffenders('假.js', "import { RESERVED_KEYS } from './fieldmap.js';"), [],
        'import 不算抄');
    assert.deepEqual(reservedKeyOffenders('假.js', "const a = [...RESERVED_KEYS, 'name'];"), [],
        '现拼别的键不算（只有 type 原本就在清单里）');
    assert.deepEqual(reservedKeyOffenders('假.js', "const a = ['节点类型'];"), [], '只有一半不算清单');
    assert.deepEqual(reservedKeyOffenders('假.js', "// const K = ['节点类型', 'type'];"), [], '注释里提不算');
});

test('源码级 lint：fieldMap 的解析**只有一份实现**（`fieldmap.js` 的 `applyFieldMap`）', () => {
    // 病根：`parse.js` 若自己留一份 `applyFieldMapLocal`，那就是手抄镜像，分叉症状是
    // "离线试跑说字段在、导入后却是空的"。`parse.js` 的兜底路径直接调那一份。
    // ⚠️ `parse.js` 里那个**转调**函数也叫 `applyFieldMap`（先看注入、再落共用件）—— 允许它存在，
    //    这里禁的是"另写一份解析"：名字带 Local/Fallback/Impl 后缀的定义，以及兜底不调共用件。
    const files = [
        'src/features/AutoImport/parse.js',
        'src/features/AutoImport/plan/prepare.js',
        'src/features/AutoImport/index.js'
    ];
    /** 剥注释 → 找"又写了一份解析" / "兜底没调共用件" —— 抽成纯函数好**自检** */
    const stripComments = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const fieldMapOffenders = (rel, text) => {
        const out = [];
        text.split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            if (/function\s+applyFieldMap(Local|Fallback|Impl)\w*\s*\(/.test(line)) {
                out.push(`${rel}:${i + 1} 又写了一份自己的 fieldMap 解析（应调 fieldmap.js 的 applyFieldMap）`);
            }
        });
        return out;
    };
    const offenders = files.flatMap(rel => fieldMapOffenders(rel, readSrc(rel)));

    // 兜底那条路必须**真的调**共用件（只查"有没有那句 import"
    // 挡不住"留着死 import、自己另写一份 internalMapLocal()"）
    // ⚠️ 正则不剥注释的话：删掉真调用、只在**注释**里留一句
    //    `applyFieldMapShared(...)` 也会被判合格 ⇒ 这里先剥注释再匹配。
    const callsShared = (text) => /applyFieldMapShared\s*\(/.test(stripComments(text));
    assert.ok(callsShared(readSrc('src/features/AutoImport/parse.js')),
        'parse.js 的兜底路径必须**调用** fieldmap.js 的 applyFieldMap（只留 import 或只在注释里提不算）');
    assert.deepEqual(offenders, [], 'fieldMap 解析只能有一处');

    // ★ **自检**：喂两份已知样本 —— 真写一份自己的（必须抓）、只在注释里提（不算）
    assert.notDeepEqual(fieldMapOffenders('假.js', 'function applyFieldMapLocal(r, m) { return {}; }'), [],
        '自检：另写一份解析必须被抓');
    assert.deepEqual(fieldMapOffenders('假.js', '// 以前叫 applyFieldMapLocal(r, m)'), [],
        '自检：注释里提到不算');
    assert.equal(callsShared('// 等价于 applyFieldMapShared(r, m) 的行为\nconst out = internalMapLocal(r, m);'), false,
        '自检：只在注释里留旧名字不算"真的调了"（那种绕法必须被抓）');
    assert.equal(callsShared('const out = applyFieldMapShared(record, fieldMap);'), true,
        '自检：真调用要认出来');
});
