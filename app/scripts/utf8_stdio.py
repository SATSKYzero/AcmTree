#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把**本进程**的 stdout/stderr 钉成 UTF-8（`app/scripts/utf8_stdio.py`）

为什么要有它（2026-10-18 用户实测）：Python 的 stdio 默认按**系统 ANSI 代码页**编码。
Windows 的「Beta: 使用 Unicode UTF-8 提供全球语言支持」一关，ACP 从 65001 变 **936(GBK)**，
而 GBK 里没有 `✅ ❌ ⚠️ ✔ ✘ ℹ ↳ ⟨ ⟩` ⇒ 脚本打第一行符号就 `UnicodeEncodeError`。

我们已经在**每条命令**上钉了 UTF-8（npm 的 23 条带 `-X utf8`、`启动AcmTree.bat` 设
`PYTHONUTF8=1`、父子进程之间传 `PYTHONIOENCODING`）。但那都是"**别人替我设**"——
一旦有人手敲 `python 某脚本.py`（不带 flag），就又回落到系统代码页。

所以入口自己再兜一层：`pin()` 只改**本进程**的两个流，不看任何环境变量。
效果 = `python -X utf8`（stdio 那一半）；而文件读写本来就已经全仓显式 `encoding='utf-8'`
（`syntax-sweep.py` 扫过：0 处缺 encoding），所以这一层兜住就够了。
"""

from __future__ import annotations

import sys


def pin() -> None:
    """把 `sys.stdout` / `sys.stderr` 重设成 UTF-8（做不到就静默跳过，绝不因此崩）"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            # 被替换成不支持的流（测试桩 / 已关闭）⇒ 让它去，这不是错误
            pass
