// ================================================================
// 「认领范围」只有一个入口：`Scaper/lib/me.py:handles()`
//
// 来由（2026-10-16，审计翻出来的"me.json 四处兜底"；用户当场定的口径："**② 干脆别兜底**"）：
//   那四处（nk/hdu 各两个）原来都是"先 `import me`，**导不进来就自己解析 me.json**"。
//   而那段兜底**只读单数键**（`nk.handle` / `hdu.handle` + `xxx.handles` 列表），
//   **不认花名册**（`team[].nk` / `accounts[].mappings`）—— 而 `me.handles()` 是认的
//   ⇒ 真走到兜底那条路时**认领范围静默变小**（队友的提交不带账户线索）。
//   实测（本机 me.json）：真源给 `['选手甲','选手乙','TEAM1']`（三个都来自花名册），
//   而旧兜底只看单数键 ⇒ 一个都拿不到。
//
// ⇒ 现在的规矩：这四处**只许调 `me.handles()`**；`import` 不进来就**当场停**（说清修哪儿）。
//   这条守卫核的就是"那条兜底没被重新加回来"（源码级 —— 想真触发得先把 `lib/me.py` 藏起来，
//   那种测试比它守的东西更脆）。
//
// ⚠️ 2026-10-19 改过一次形状（**别再改回去，也别把这条当"检查松了"**）：
//   `hdu_adapter.py` 那天多出两个也要走 `me.py` 的读者（按年的比赛账号、`hdu.files` 绑定），
//   于是"引 me + 导不进来就当场停"那一套收成了一个 `_me()`（唯一一份 import 舞步）。
//   ⇒ 这条守卫从"必须出现 `me_mod.handles(`"放宽到"**必须调到 `handles('<平台>')`，且那个
//   import 与 `sys.exit` 只许有一份**"。它守的失败模式没变：**自己解析 me.json 当兜底**。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCAPER = path.join(ROOT, 'acm-data', 'raw', 'Scaper');

const SPOTS = [
    path.join('01 nk', 'nk_pipeline.py'),
    path.join('01 nk', 'nk_adapter.py'),
    path.join('02 hdu', 'hdu_pipeline.py'),
    path.join('02 hdu', 'hdu_adapter.py')
];

test('★ 认领范围只走 `lib/me.py` —— 这四处不再自己解析 me.json（导不进来就当场停）', () => {
    for (const rel of SPOTS) {
        const src = fs.readFileSync(path.join(SCAPER, rel), 'utf8');
        const imports = src.match(/import me as me_mod/g) || [];
        assert.equal(imports.length, 1, `${rel}：引真源 lib/me.py 的舞步只许**一份**（多份就会各写各的兜底）`);
        assert.match(src, /\.handles\('/, `${rel}：读范围要经 \`me.handles('nk'|'hdu')\``);
        assert.match(src, /except ImportError[\s\S]{0,120}?sys\.exit\(/,
            `${rel}：\`import\` 不进来要**当场停**（别静默退回一个更窄的范围）`);
        assert.ok(!/section\.get\(['"](?:handles|handle)['"]\)/.test(src),
            `${rel}：不许再有"自己解析 me.json 拿范围"的兜底`
            + '（它只读单数键、不认花名册 ⇒ 会静默缩小范围）');
    }
});

test('四处都只是**转发** `me.handles()`（各读自己那个平台，不顺手读别的）', async () => {
    // 值本身不抄进来（会漂）：这里只钉"四处都只是转发 `me.handles()`"这一条形状 ——
    // 真正的同值靠上面那条断言（它们已经不解析 me.json 了）+ 人工核一次（见文件头那段实测）。
    for (const rel of SPOTS) {
        const src = fs.readFileSync(path.join(SCAPER, rel), 'utf8');
        // 两种合法形状：`me_mod.handles('hdu')`，或收成一个 `_me()` 之后 `_me().handles('hdu')`
        const calls = src.match(/(?:me_mod|_me\(\))\.handles\('(\w+)'\)/g) || [];
        assert.ok(calls.length >= 1, `${rel}：要真的调 \`handles('<平台>')\``);
        const platform = rel.includes('hdu') ? 'hdu' : 'nk';
        assert.ok(calls.every(c => c.includes(`'${platform}'`)),
            `${rel}：只许读自己那个平台（${platform}），别顺手读了别的`);
    }
});
