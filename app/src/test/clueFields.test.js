// ================================================================
// 跨语言对拍：账户线索的**字段名**两边必须一样
//
// `src/core/rosterMappings.js` 的 `PLATFORM_CLUES[平台].field` 自称"照抄抓取侧各 adapter 的
// `CLUE_FIELD`"，但抓取侧只有 nk/hdu 有那个常量，其余 5 处是**内联字面量**（qoj/cf/cf-contest/
// pta/atcoder）—— 两边一旦漂了，症状是"抓取侧打出的线索、应用里配的映射永远认不上"
//（那 10120 条"未认领"就是这一类）。
//
// 本仓同类跨语言表都有源码级对拍（`linkKinds.test.js` / `submitKind.test.js` /
// `sourceReportRanks.test.js` / `natureRehomeShared.test.js`），**唯独这张表没有** ——
// 改 JS 会红、改 Python 那 7 处一个字都不红。
//
// ⚠️ 判据**不是**正则抓字面量（只认"单行 + 单引号 + 裸字面量"的话，
//    把 `'field': '提交者'` 换成 `'field': QOJCLUE`（常量仍是 handle）就**照绿**）。
//    现在做**静态解析**：字面量直接用，标识符去同文件找它的定义 —— 换常量也躲不掉。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLATFORM_CLUES } from '../core/rosterMappings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');

/** 平台 → 抓取侧"这一格字段叫什么"写在哪几个文件 */
const PY = {
    nk: ['acm-data/raw/Scaper/01 nk/nk_adapter.py'],
    hdu: ['acm-data/raw/Scaper/02 hdu/hdu_adapter.py'],
    qoj: ['acm-data/raw/Scaper/05 xcpc/qoj_adapter.py'],
    cf: ['acm-data/raw/Scaper/05 xcpc/cf_adapter.py',
        'acm-data/raw/Scaper/05 xcpc/cf_contest_adapter.py'],
    pta: ['acm-data/raw/Scaper/05 xcpc/pta_submissions_adapter.py'],
    atcoder: ['acm-data/raw/Scaper/05 xcpc/atcoder_adapter.py']
};

/**
 * 从一段 Python 源码里，把线索字段的取值**静态解析**出来。
 *
 * 两条来源都收：`'field': <值>`（内联写法）与 `NAME = '字面量'`（模块级常量，如 `CLUE_FIELD`）。
 * 值是字面量就直接取；是标识符就去同文件的常量表里查。**解析不出来的不猜**（例如
 * `_s(declared.get('field')) or '队伍'` 那种运行时才知道的表达式）—— 但只要有**一个**
 * 解析得出来，那个就足以钉住漂移；一个都解析不出来时调用方会报红（写法变了就得同步）。
 */
function pyClueFields(src) {
    const consts = new Map();
    for (const m of src.matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*(['"])([^'"]*)\2/gm)) {
        consts.set(m[1], m[3]);
    }
    const out = [];
    for (const m of src.matchAll(/['"]field['"]\s*:\s*([^,\n}]+)/g)) {
        const raw = m[1].trim();
        const lit = /^(['"])([^'"]*)\1$/.exec(raw);
        if (lit) { out.push(lit[2]); continue; }
        if (/^[A-Za-z_]\w*$/.test(raw) && consts.has(raw)) out.push(consts.get(raw));
    }
    return out;
}

for (const [platform, files] of Object.entries(PY)) {
    test(`跨语言对拍：\`${platform}\` 的线索字段名两边一致（JS PLATFORM_CLUES ↔ Python）`, () => {
        const want = PLATFORM_CLUES[platform].field;
        for (const rel of files) {
            const got = pyClueFields(read(rel));
            assert.ok(got.length, `${rel} 里解析不出任何线索字段值 —— 写法变了就要同步这份对拍`);
            for (const one of got) {
                assert.equal(one, want,
                    `${rel} 写的是 ${JSON.stringify(one)}，而应用侧 PLATFORM_CLUES.${platform}.field 是 ${JSON.stringify(want)}`
                    + ' —— 两边必须逐字相同（线索匹配是三元组全等）');
            }
        }
    });
}

test('六个平台都在对拍表里（加了平台却忘了登记 ⇒ 这里红）', () => {
    assert.deepEqual(Object.keys(PLATFORM_CLUES).sort(), Object.keys(PY).sort());
});

test('★ 上面的解析自己会咬（含"抽成常量"躲法）', () => {
    // 字面量、单双引号都行
    assert.deepEqual(pyClueFields("x = {'field': '提交者'}"), ['提交者']);
    assert.deepEqual(pyClueFields('x = {"field": "提交者"}'), ['提交者']);
    // ★ 抽成常量 —— 那种写法必须解析得出来
    assert.deepEqual(pyClueFields("QOJCLUE = 'handle'\nx = {'field': QOJCLUE}"), ['handle']);
    // 同一文件里多处都要对上（只要有一处漂了就报出来）
    assert.deepEqual(pyClueFields("a = {'field': '队伍'}\nb = {'field': '队伍'}"), ['队伍', '队伍']);
    assert.deepEqual(pyClueFields("a = {'field': '队伍'}\nb = {'field': '队员'}"), ['队伍', '队员']);
    // 运行时才知道的表达式不猜（但也不假装解析出了错的值）
    assert.deepEqual(pyClueFields("x = {'field': _s(o.get('field')) or '队伍'}"), []);
    // 读取（没有冒号）不是定义，不算
    assert.deepEqual(pyClueFields("clue['field'] = 1"), []);
});
