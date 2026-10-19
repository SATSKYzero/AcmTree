#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自测脚手架（scripts/selftest_kit.py）—— **唯一一份**"数断言 / 报通过"的实现。

这套脚手架（`checks` 计数 + `bad` 列表 + `def ok(cond, label)` 闭包 + 结尾那段
"✅ …自测通过：N 项 / ❌ 列出失败项"）在各脚本里**抄了 7 份**，而且每份的
打印格式还不一样（有的逐条打 ✔/✘、有的只在失败时说话、通过语也不一致）——
于是"看一眼自测结果"这件小事，每个脚本都得重新读一遍。

用法（**调用点几乎不用改** —— 换成这三行即可）：

    from selftest_kit import Selftest

    def _selftest() -> int:
        st = Selftest('字段体检')          # 标题用于收尾那句"✅ 字段体检自测通过：N 项"
        ok = st.ok                          # ← 局部分别名：下面的 ok(...) 一处都不用改
        ok(1 + 1 == 2, '加法还认得')
        return st.done()                    # 打印收尾 + 返回退出码（0/1）

⚠️ 带"额外现场"的断言：`ok(cond, label, extra)` —— 失败时把 `extra` 附在标签后面
   （成功的那些不打，免得刷屏；要看就 `Selftest(..., verbose=True)`）。
"""
from __future__ import annotations

import sys

sys.dont_write_bytecode = True


class Selftest:
    """数断言、攒失败项、收尾报通过/失败"""

    def __init__(self, title: str, verbose: bool = False):
        #: 标题：收尾那句 `✅ <title>自测通过：N 项`
        self.title = title
        #: 逐条打印 ✔/✘ 吗（默认只打失败项 —— 几十项全打会把有用的输出顶走）
        self.verbose = verbose
        self.checks = 0
        self.bad = []

    def ok(self, cond, label: str, extra: str = '') -> bool:
        """一条断言。@returns 断言结果（方便 `if ok(...):` 继续用）"""
        self.checks += 1
        passed = bool(cond)
        if not passed:
            self.bad.append(label + (('　%s' % extra) if extra else ''))
        if self.verbose or not passed:
            mark = '  ✔' if passed else '  ✘'
            print('%s %s%s' % (mark, label, ('　' + extra) if extra else ''))
        return passed

    def done(self) -> int:
        """收尾：打印通过/失败并返回**退出码**（0 = 全过）"""
        if not self.bad:
            print('✅ %s自测通过：%d 项' % (self.title, self.checks))
            return 0
        print('❌ %s自测失败：%d 项失败（共 %d 项）' % (self.title, len(self.bad), self.checks))
        for one in self.bad:
            print('  •', one)
        return 1
