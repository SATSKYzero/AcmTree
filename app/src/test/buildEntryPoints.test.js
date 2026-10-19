// ================================================================
// npm 入口的"名字 → 实际跑谁"（`src/test/buildEntryPoints.test.js`）
//
// 为什么要有这条（2026-10-17 用户发图问"怎么归到其他比赛了 / 我重新建包?"）：
//   `npm run crate:hdu` 当时指向的是**手存路的解析器**（`02 hdu/hdu_pipeline.py --all`），
//   而"自动抓 + 补元信息"那条在 `hdu_multi_fetch.py`，**根本没有 npm 名字**。
//   于是 `crate:hdu` 听起来像"把杭电那棵树更新一下"，实际是"把盘上旧原料重新解析一遍" ——
//   整条链从头跑到尾都"成功"，包里那棵杭电树却只有 10 场（原料里已经有 50 场）。
//   同一个任务，两个平台还是相反的形状（`crate:nk` = 自动路、`crate:nk:browser` = 手存路；
//   `crate:hdu` 却是手存路）。⇒ 现在统一成"**不带后缀 = 生产那条**"，并在这里钉住。
//
// ⚠️ 这条**不是**在测"命令能跑"（那要真联网/真读原料）；它只钉"名字指向哪个脚本"，
//   因为出事的正是这层映射：脚本都对、名字骗人。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from '../../scripts/roots.mjs';

const ROOT = repoRoot();
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const S = pkg.scripts || {};

const has = (name, ...needles) => {
    const cmd = S[name];
    assert.ok(cmd, `package.json 里没有 ${name} 这条命令（有人改名了？）`);
    for (const n of needles) {
        assert.ok(cmd.includes(n), `${name} 应该跑 ${n}，实际是：${cmd}`);
    }
};

test('杭电：三个入口各指各的脚本（crate:hdu = 生产那条，不联网）', () => {
    has('crate:hdu', 'hdu_multi_fetch.py', 'build');
    has('crate:hdu:fetch', 'hdu_multi_fetch.py', 'fetch');
    // 手存路只能叫 `:browser` —— 别把不带后缀的那个让给它
    has('crate:hdu:browser', 'hdu_pipeline.py', '--all');
    assert.ok(!String(S['crate:hdu']).includes('hdu_pipeline.py'),
        'crate:hdu 不许再指回 hdu_pipeline.py（那只是解析，不会补往年元信息）');
});

test('牛客：crate:nk = 自动路，crate:nk:browser = 手存路（与杭电同形）', () => {
    has('crate:nk', 'nk_multi_fetch.py');
    has('crate:nk:browser', 'nk_pipeline.py');
});

test('教学模板不许占生产的名字：crate:sample:qoj', () => {
    has('crate:sample:qoj', 'acm-data/scripts/qoj_adapter.py');
    assert.equal(S['crate:qoj'], undefined,
        'crate:qoj 是教学模板的旧名字，容易被当成正式那条（现在是 crate:sample:qoj）');
});

test('原料三档有直白的入口（默认只报告，--apply 才删）', () => {
    has('prune:raw', 'prune-raw.py');
    assert.ok(!String(S['prune:raw']).includes('--apply'), 'prune:raw 不许带 --apply（那是删东西）');
    has('prune:raw:apply', 'prune-raw.py', '--apply');
});

test('★ 每条 python 调用都带 `-X utf8`（与系统代码页脱钩，2026-10-18）', () => {
    // 为什么：Python 的 stdio 默认按**系统 ANSI 代码页**编码。关掉 Windows 的「UTF-8 Beta」后它是
    // 936(GBK)，而 GBK 里没有 ✅❌⚠️✔✘⟨⟩ ⇒ 脚本打第一行符号就 UnicodeEncodeError（实测 8 套自测全崩）。
    // `-X utf8` 是**进程内** UTF-8 模式（stdio 与 open() 的默认编码都变 UTF-8），不依赖任何机器设置 ——
    // 所以它必须写在**命令本身**里，而不是靠人 `setx` 一个环境变量（用户 2026-10-18："这我无法接受"）。
    const py = Object.entries(S).filter(([, cmd]) => /\bpython\b/i.test(cmd));
    assert.ok(py.length >= 20, `python 命令太少（${py.length}）—— 脚本表是不是被整体改过？`);
    const bad = py.filter(([, cmd]) => !/-X\s+utf8/.test(cmd)).map(([k]) => k);
    assert.deepEqual(bad, [], `这些 python 命令缺 -X utf8：${bad.join('、')}`);
});
