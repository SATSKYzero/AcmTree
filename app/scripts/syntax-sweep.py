#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
全仓 Python **语法扫**（scripts/syntax-sweep.py）

为什么要有它：
    `acm-data/raw/Scaper/05 xcpc/xcpc_pipeline.py` 的模块级写了 `return _code`
    （`SyntaxError: 'return' outside function`）—— 那是**产包那一步整条死掉**，
    而当手头的几套自测全绿：`npm test`、`test:smoke`、`05 xcpc selftest`、
    `build_chain --selftest` 都**没有编译/import 那个文件**（它只被"产包"这一步执行）。

语法错是"最便宜的一类错"，用最便宜的办法兜住：挨个 `ast.parse`。
**不写任何字节码**（不像 `py_compile` 会落 `__pycache__`），所以跑完仓库是干净的。

用法：
    python -B scripts/syntax-sweep.py            # 全仓
    python -B scripts/syntax-sweep.py scripts    # 只扫某个子目录
    python -B scripts/syntax-sweep.py --quiet    # 只出错时才输出

退出码：0 = 全部能编译；1 = 有文件编译不过（逐条打印 文件:行:原因）。
"""
from __future__ import annotations

import ast
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)

#: 不进去的目录（第三方/缓存/产物）
SKIP_DIRS = {'node_modules', '__pycache__', '.git', '.venv', 'venv', 'dist', 'build'}


def python_files(root: str = '') -> list:
    """全仓 `*.py`（跳过 `SKIP_DIRS`），按路径排序 ⇒ 结果稳定可复现"""
    base = root or REPO
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            if name.endswith('.py'):
                out.append(os.path.join(dirpath, name))
    return sorted(out)


def parse_error(path: str):
    """能编译 ⇒ `None`；否则返回 `(行, 列, 原因)`（**不写字节码**）"""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            src = fh.read()
    except OSError as e:
        return (0, 0, f'读不了：{e}')
    try:
        ast.parse(src, filename=path)
    except SyntaxError as e:
        return (e.lineno or 0, e.offset or 0, e.msg or 'SyntaxError')
    return None


#: 子进程里"读孩子输出"的那些关键字：`text=True` 不带 `encoding=` 时按**系统代码页**解码
_TEXT_KW = ('text', 'universal_newlines')


def encoding_error(path: str):
    """
    **读子进程输出必须显式给 `encoding=`**（2026-10-18 实测）⇒ 违例返回 `(行, 原因)`，否则 `None`。

    症状：关掉 Windows「UTF-8 Beta」后 ACP=936，`subprocess.run(..., text=True)` 不带 `encoding`
    就按 GBK 解码，而孩子（加了 `-X utf8` / `PYTHONUTF8=1`）写的是 UTF-8 ⇒ `UnicodeDecodeError`。
    实测就报在 `crate_selftest.py` 与 `05 xcpc/selftest.py` 里。这条规则和 `open()` 那条是同一个病：
    **凡是"文本进出"都必须说清编码**，别让系统区域设置参与。
    """
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            tree = ast.parse(fh.read(), filename=path)
    except (OSError, SyntaxError):
        return None                      # 语法错由 `parse_error` 负责，别重复报
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        name = fn.attr if isinstance(fn, ast.Attribute) else getattr(fn, 'id', '')
        if name not in ('run', 'Popen', 'call', 'check_call', 'check_output'):
            continue
        kw = {k.arg for k in node.keywords if k.arg}
        if not (kw & set(_TEXT_KW)) or 'encoding' in kw:
            continue
        return (getattr(node, 'lineno', 0), f'subprocess.{name}(text=True) 缺 encoding="utf-8"')
    return None


#: **手敲入口**（docs/AGENTS 里直接写成命令的那几个）：必须自带 stdio pin。
#: 为什么单列而不是全仓都查：`-X utf8` 已经在 npm 的 23 条命令上、`启动AcmTree.bat` 有
#: `PYTHONUTF8=1`、进程之间传 `PYTHONIOENCODING` —— 覆盖的是"程序互相拉起来"的路。
#: 剩下的只有"人（或 agent）手敲 `python 某脚本.py`"，而那几个脚本就是这条名单。
#: 判定：文件里得有 `utf8_stdio.pin()`（app/scripts 那份）或就地 `reconfigure(encoding='utf-8'`。
#: 2026-10-18 加：用户关掉 Windows「UTF-8 Beta」后实测，这 6 个全都会在打 `✅/⟨⟩` 时崩。
#: ⚠️ 路径是**相对 `REPO`（= 机械层根 `app/`）**的 —— 这个脚本的 `REPO` 就是 `app/`，
#:    别写成相对仓库根（那会拼出 `app/app/…`，我第一版就这么错了，6 条全报"文件不存在"）。
STDIO_PINNED = (
    'scripts/build_chain.py',
    'scripts/build-all.py',
    'scripts/prune-raw.py',
    'scripts/dev-server.py',
    'acm-data/raw/Scaper/05 xcpc/selftest.py',
    'acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py',
)


def stdio_pin_error(path: str):
    """手敲入口没钉 stdio ⇒ 返回原因；否则 `None`"""
    rel = os.path.relpath(os.path.abspath(path), REPO).replace('\\', '/')
    if rel not in STDIO_PINNED:
        return None
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            src = fh.read()
    except OSError as e:
        return f'读不了：{e}'
    if 'utf8_stdio.pin()' in src or "reconfigure(encoding='utf-8'" in src:
        return None
    return '手敲入口缺 stdio pin（关掉 UTF-8 Beta 后打 ✅ 会 UnicodeEncodeError）'


def main(argv) -> int:
    quiet = '--quiet' in argv
    args = [a for a in argv if not a.startswith('-')]
    root = args[0] if args else REPO
    files = python_files(root)
    if not files:
        print(f'❌ 没找到任何 .py（root={root}）')
        return 1
    bad = []
    for path in files:
        err = parse_error(path)
        if err:
            bad.append((path, err))
    for path, (line, col, msg) in bad:
        print(f'❌ {os.path.relpath(path, REPO)}:{line}:{col}   {msg}')
    if bad:
        print(f'\n❌ {len(bad)}/{len(files)} 个 Python 文件**编译不过**'
              f'（语法错 = 任何 import 它的东西都跟着死，而"谁 import 了它"常常没人知道）')
        return 1
    enc = []
    for path in files:
        err = encoding_error(path)
        if err:
            enc.append((path, err))
    for path, (line, msg) in enc:
        print(f'❌ {os.path.relpath(path, REPO)}:{line}   {msg}')
    if enc:
        print(f'\n❌ {len(enc)} 处"读子进程输出没写编码"'
              f'（关掉 Windows「UTF-8 Beta」后 ACP=936 ⇒ 按 GBK 解码 UTF-8 ⇒ UnicodeDecodeError）')
        return 1
    pin_bad = []
    for rel in STDIO_PINNED:
        full = os.path.join(REPO, rel)
        if not os.path.isfile(full):
            pin_bad.append((rel, '名单里的文件不存在（改名了？改名单）'))
            continue
        why = stdio_pin_error(full)
        if why:
            pin_bad.append((rel, why))
    for rel, why in pin_bad:
        print(f'❌ {rel}   {why}')
    if pin_bad:
        print(f'\n❌ {len(pin_bad)} 个手敲入口没钉 stdio')
        return 1
    if not quiet:
        print(f'✅ Python 语法扫通过：{len(files)} 个文件，全部能编译；'
              f'子进程输出都写了 encoding；{len(STDIO_PINNED)} 个手敲入口都钉了 stdio')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
