// ================================================================
// 映射「写法」检查的单测（src/test/rosterMappings.test.js）
//
// 账户里若写的是 **`nk:23`（冒号 + 两位年）**，而抓取侧发出来的是 `nk:2023`（**冒号 + 四位年**，
// 数据端已统一）⇒ **10120 条值全成了"未认领的线索"**。
// 这类错字眼看不出来（差一个数字），所以 `mappingWarnings()` 在账户编辑弹窗里点出来。
//
// ⚠️ 它**只提醒、绝不自动改**：匹配判据是三元组**全等**，猜错了会把线索认到别人头上。
// ================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLATFORM_CLUES, mappingWarnings, currentSeason } from '../core/rosterMappings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const warn = (m) => mappingWarnings([m])[0] || null;

test('源码级 lint：账户弹窗的提示要给出**正确写法**（教成两位年 = 10120 条的病根）', () => {
    // 弹窗提示必须与同一次输入触发的黄条**一致**
    //（提示若叫用户写 `nk:23`，而黄条说"应写 `nk:2023`"，用户照提示写就永远认不上）。
    // ⚠️ 只搜中文短语 + 否定断言挡不住"把整句换成教两位年"
    //    （否定断言只挡得住一种排版）⇒ 钉"**那句提示里必须出现 `nk:2023`**"。
    const src = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'G_modal', 'G8_accounts.js'), 'utf8');
    const line = src.split('\n').find(l => l.includes('带赛季的平台要写')) || '';
    assert.ok(line, '找不到账户弹窗里那句"带赛季的平台要写…"的提示');
    assert.ok(line.includes('nk:2023'), `那句提示里必须给出正确的写法 \`nk:2023\`，实际是：${line.trim()}`);
});

test('平台表 6 行（照抄抓取侧 CLUE_FIELD + atcoder 那种"没线索但要抓"的）：season 三态', () => {
    assert.deepEqual(Object.keys(PLATFORM_CLUES).sort(), ['atcoder', 'cf', 'hdu', 'nk', 'pta', 'qoj']);
    assert.equal(PLATFORM_CLUES.cf.season, null);
    assert.equal(PLATFORM_CLUES.atcoder.season, null, '⚠️ atcoder 没线索，但**是**平台账号（爬虫靠它抓提交）');
    assert.equal(PLATFORM_CLUES.nk.season, 'year');
    assert.equal(PLATFORM_CLUES.pta.season, 'ns');
});

test('⭐ 两位年要报出来（并给出 `nk:2023`）', () => {
    const w = warn({ source: 'nk:23', field: '用户名', value: '某昵称' });
    assert.ok(w, '报了');
    assert.match(w.why, /四位年/);
    assert.equal(w.suggest, 'nk:2023');
});

test('`hdu:26` 同理（也要补成四位年 `hdu:2026`）', () => {
    assert.equal(warn({ source: 'hdu:26', field: 'handle', value: 'demo/teamA' }).suggest, 'hdu:2026');
});

test('分隔符写错（`nk.2023` 这种笔误）也报 —— 抓取侧发的是**冒号**', () => {
    const w = warn({ source: 'nk.2023', field: '用户名', value: '某昵称' });
    assert.ok(w);
    assert.match(w.why, /冒号/);
    assert.equal(w.suggest, 'nk:2023');
});

test('⭐ 冒号后**带空格**（`nk: 2023`）也要报 —— 线索匹配是三元组全等，这种写法永远认不上', () => {
    // 病根：这条判断若改问会 trim 的 `isRealYear`，`' 2023'` 会被当成合法年份
    // ⇒ 黄条不再出现 —— 而这正是这个函数存在的理由（那 10120 条未认领）。
    const w = warn({ source: 'nk: 2023', field: '用户名', value: 'X' });
    assert.ok(w, '带空格的写法必须报出来（否则用户永远看不出为什么认不上）');
    assert.match(w.why, /四位年|对得上/);
    assert.ok(warn({ source: 'hdu: 2026', field: 'handle', value: 'X' }), '`hdu: 2026` 同理');
    // 两种同类脏写法：**冒号前**的空格、**平台名大小写**
    assert.ok(warn({ source: 'nk :2023', field: '用户名', value: 'X' }), '`nk :2023`（冒号前有空格）也要报');
    assert.ok(warn({ source: 'NK:2023', field: '用户名', value: 'X' }), '`NK:2023`（大小写不对）也要报');
    assert.equal(warn({ source: 'NK:2023', field: '用户名', value: 'X' }).suggest, 'nk:2023', '建议值给规范写法');
});

test('✅ 对的写法一律不报：`nk:2023` / `hdu:2026` / `nk`（本赛季）/ `cf` / `qoj` / `pta:icpc2026`', () => {
    assert.equal(warn({ source: 'nk:2023', field: '用户名', value: 'X' }), null);
    assert.equal(warn({ source: 'hdu:2026', field: 'handle', value: 'X' }), null);
    assert.equal(warn({ source: 'nk', field: '用户名', value: 'X' }), null, '裸平台名 = 本赛季，合法');
    assert.equal(warn({ source: 'cf', field: 'handle', value: 'X' }), null);
    assert.equal(warn({ source: 'qoj', field: '提交者', value: 'X' }), null);
    assert.equal(warn({ source: 'pta:icpc2026', field: '队伍', value: 'demo' }), null);
});

test('`cf:handle` 这种"自带赛季"的写法要报（cf 不带赛季）', () => {
    const w = warn({ source: 'cf:handle', field: 'handle', value: 'X' });
    assert.ok(w);
    assert.match(w.why, /不带赛季/);
    assert.equal(w.suggest, 'cf');
});

test('PTA 不能只写 `pta`（赛季是命名空间，推不出来 ⇒ 照数据里那条抄）', () => {
    const w = warn({ source: 'pta', field: '队伍', value: 'demo' });
    assert.ok(w);
    assert.match(w.why, /命名空间/);
});

test('不认识的平台 / 空行 / 坏输入一律不报（不猜）', () => {
    assert.equal(warn({ source: 'atcoder', field: 'handle', value: 'X' }), null);
    assert.equal(warn({ source: '某平台:2026', field: 'x', value: 'y' }), null);
    assert.deepEqual(mappingWarnings([null, {}, { source: '' }]), []);
    assert.deepEqual(mappingWarnings('bad'), []);
});

test('一次查多行（编辑弹窗就是这么用的）—— 两位年那几行会被一并点出来', () => {
    const list = mappingWarnings([
        { source: 'cf', field: 'handle', value: 'me' },
        { source: 'nk:23', field: '用户名', value: '某昵称' },
        { source: 'nk:24', field: '用户名', value: '选手乙' },
        { source: 'nk:2025', field: '用户名', value: 'demo0' }
    ]);
    assert.deepEqual(list.map((w) => w.suggest), ['nk:2023', 'nk:2024']);
});

test('本赛季 = 今年的**四位年**（跟着年份走）', () => {
    assert.equal(currentSeason(new Date('2026-05-01')), '2026');
    assert.equal(currentSeason(new Date('2031-01-01')), '2031');
});

