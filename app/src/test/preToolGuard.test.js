// ================================================================
// 操作端守门的判据（`src/test/preToolGuard.test.js`）
//
// 为什么要在 `npm test` 里钉它：这条守门只在**工具执行之前**生效，平时谁都看不见。
// 一旦规则写宽了（放行"用脚本改文本"）或者写窄了（把正常构建也拒了），必须当场红 ——
// 所以这里的样本**全是真实发生过的命令**（2026-10-17 那几次事故），逐条对拍。
//
// ⚠️ 判据只有一份：`作者专用/hooks/pre-tool-guard.mjs` 的 `judgeCommand()`，这里只喂样本。
// ================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '../../scripts/roots.mjs';

const ROOT = repoRoot();
// ⚠️ 守门脚本住 **`作者专用/`** —— 那一层是**作者的**，`clean-personal`/`publish-copy` 之前会被删掉
//    （`作者专用/` 不随包发出）⇒ 在"公开发布副本"里这份测试**没法跑**，只能 skip 并打印原因
//    （不是红：它守的是作者本机的工具链，不是收件人拿到的那份东西）。
const HOOK = path.join(ROOT, '作者专用', 'hooks', 'pre-tool-guard.mjs');
if (!fs.existsSync(HOOK)) {
    console.log('   ⏭ 跳过整份测试：作者专用/hooks/pre-tool-guard.mjs 不在'
        + '（作者物不随包发出 ⇒ 公开发布副本里本来就没有它）');
    process.exit(0);
}
const { judgeCommand, commandOf, judgePayload, parsePayload } = await import(
    pathToFileURL(HOOK).href
);

const D = (cmd) => judgeCommand(cmd).decision;

test('★ 用内联代码批量改仓库文本 ⇒ 拒（2026-10-17 真发生的那次）', () => {
    // 那次是：一段 python -c 里对 A_constants.js 做 .replace()
    const real = `python -B -c "
p='app/src/A_constants.js'
s=open(p,encoding='utf-8').read()
s=s.replace('v9.4.26','v9.4.27')
open(p,'w',encoding='utf-8',newline='\\n').write(s)
"`;
    assert.equal(D(real), 'deny', '内联 python + .replace/write ⇒ 必须拒');
    assert.equal(D(`node -e "require('fs').writeFileSync('a.js','x')"`), 'deny', 'node -e + writeFileSync ⇒ 拒');
    assert.equal(D(`python -c "import re;t=open('a.md').read();open('a.md','w').write(re.sub('x','y',t))"`), 'deny',
        '内联 re.sub + 写 ⇒ 拒');
});

test('★ 老式整篇改写命令 ⇒ 拒（这两条也是真踩过的）', () => {
    assert.equal(D(`Set-Content -Path 'app/src/x.js' -Value 'y'`), 'deny', 'Set-Content（BOM/CRLF 那次）');
    assert.equal(D(`[System.IO.File]::WriteAllText($p,$t)`), 'deny', 'WriteAllText');
    assert.equal(D(`sed -i 's/a/b/' app/src/x.js`), 'deny', 'sed -i');
    assert.equal(D(`git apply fix.patch`), 'deny', 'git apply');
    assert.equal(D(`git reset --hard HEAD~1`), 'deny', 'git reset --hard');
    assert.equal(D(`python -c "print(1)" > app/src/x.js`), 'deny', '内联输出重定向进源文件');
});

test('★ 正常跑仓库里的脚本 / 测试 / 只读命令 ⇒ 放行（不能误杀构建）', () => {
    for (const ok of [
        'python -B app/scripts/build_chain.py --selftest',
        'python -B "app/acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" build',
        'npm test',
        'npm run test:smoke -- accounts',
        'node --import ./app/scripts/smoke/register.mjs app/scripts/smoke/accounts.smoke.mjs',
        'git status --short',
        'git diff --numstat -- app/src/A_constants.js',
        'git log --oneline -5',
        'Get-ChildItem app/src -Recurse -File | Select-Object Name',
        'python -B app/scripts/prune-raw.py'
    ]) {
        assert.equal(D(ok), 'allow', `不该拦：${ok}`);
    }
});

test('内联代码但看不出写不写 ⇒ 问一下（不硬拒）', () => {
    assert.equal(D(`python -c "import sys; print(sys.version)"`), 'ask');
    assert.equal(D(`node -e "console.log(1)"`), 'ask');
});

test('会丢未提交改动的动作 ⇒ 问一下（不是不让做，是别静默做）', () => {
    assert.equal(D('git checkout -- app/acm-data/raw/Scaper/02 hdu/hdu_contests.json'), 'ask');
    assert.equal(D('git stash'), 'ask');
    assert.equal(D('Remove-Item app/scripts/_probe-x.mjs -Recurse -Force'), 'ask');
});

test('载荷形态：命令类工具按「命令」判；写入类工具按「内容」判（不按命令）', () => {
    assert.equal(judgePayload({ tool_name: 'pwsh', tool_input: { command: 'Set-Content x y' } }).decision, 'deny');
    // `edit` 的载荷里没有 `content/new_string` ⇒ 判不出内容 ⇒ 放行（2026-10-18 起：edit 也会被看一眼）
    assert.equal(judgePayload({ tool_name: 'edit', tool_input: { command: 'Set-Content x y' } }).decision, 'allow',
        'edit 的**命令字段**不参与判定（改法本来就允许；只有"写脚本+写文件 API"才 ask）');
    assert.equal(judgePayload({ tool_name: 'pwsh', tool_input: { script: 'python -c "print(1)"' } }).decision, 'ask',
        'script 那个键也要认');
    assert.equal(commandOf({ tool_name: 'pwsh', tool_input: { command: 'a' } }), 'a');
    assert.equal(commandOf('a'), 'a');
    assert.equal(commandOf(null), '');
    assert.equal(judgePayload(null).decision, 'allow', '空载荷不许把工具链卡死');
});

test('★ 带 BOM 的载荷也要照常判（PS 5.1 写出来的 JSON 带 BOM —— 踩过：那时守门静默全放行）', () => {
    const json = '{"tool_name":"pwsh","tool_input":{"command":"Set-Content x y"}}';
    assert.equal(judgePayload(parsePayload('\uFEFF' + json)).decision, 'deny', '去 BOM 后照常拒');
    assert.equal(judgePayload(parsePayload('')).decision, 'allow', '空文本 = 空载荷（放行）');
    assert.equal(parsePayload('{坏 json'), null, '坏 JSON ⇒ null（放行，不卡工具链）');
});

test('★ 写"会自己改文件的脚本"⇒ 问一句（挡住"先写脚本再跑"那条绕路）', () => {
    // 用户 2026-10-18："好"（把我提的这条做掉）。命令守门挡不住这条路：先写 .py 再跑它。
    const py = { tool_name: 'write', tool_input: { file_path: 'app/scripts/x.py',
        content: "s = open('a.md').read()\nopen('a.md', 'w').write(s.replace('a', 'b'))\n" } };
    assert.equal(judgePayload(py).decision, 'ask', "写 .py 且内容里有 open(...,'w') / .replace( ⇒ ask");
    const mjs = { tool_name: 'edit', tool_input: { file_path: 'app/scripts/x.mjs',
        old_string: 'a', new_string: "require('fs').writeFileSync('x', 'y')" } };
    assert.equal(judgePayload(mjs).decision, 'ask', 'edit 里塞 writeFileSync ⇒ ask');
    // 反例：同一段话写进 .md（文档里引用这些 API 名）⇒ 放行，别误伤
    assert.equal(judgePayload({ tool_name: 'write', tool_input: { file_path: 'docs/x.md',
        content: '别用 `.replace(` 改仓库文本' } }).decision, 'allow', '写 .md ⇒ 放行');
    // 反例：写 .py 但内容里没有写文件 API ⇒ 放行
    assert.equal(judgePayload({ tool_name: 'write', tool_input: { file_path: 'app/scripts/y.py',
        content: 'print(1)\n' } }).decision, 'allow', '普通脚本 ⇒ 放行');
    // 反例：脚本**永远**不该被 deny（硬拒会把正常开发卡死）
    assert.notEqual(judgePayload(py).decision, 'deny', '写脚本至多 ask，绝不 deny');
});
