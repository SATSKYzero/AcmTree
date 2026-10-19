"""跑到哪儿了：`⟨进度 a/b 什么⟩` —— **只有这一种写法**（`app/acm-data/raw/Scaper/lib/progress.py`）

为什么要单独一个模块：这条线的进度有**两个读者** ——
  · 人：日志框里那行（`build_runner` 会把它抄进"还在跑吗"的心跳行）；
  · 机器：`app/scripts/devserver/build_runner.py` 按同一个格式解析（`PROGRESS_RE`）。
两处必须对得上 —— 守卫在 `app/scripts/devserver/selftest.py`（拿本模块 `line()` 的输出喂给
那边的正则，对不上就红）。

⚠️ **只有"数得清总量"的步骤才喊**（场次 / 页 / 条）。喊的时候**不要自己编百分比**，
   就写"已做/总数"这两个数 —— 心跳里那句"最近 60 秒写了 N 个文件"是另一条硬证据，两者互补。

⚠️ 帧率：一次构建几十条就够了（每场一条 = 600 条，可接受；**别每页都喊**）。
"""
from __future__ import annotations

#: 标记的两头（解析侧照抄）
OPEN = '⟨进度 '
CLOSE = '⟩'


def line(done, total, what: str = '') -> str:
    """`line(3, 186, '场次')` → `'⟨进度 3/186 场次⟩'`（不打印，给测试与拼一起用）"""
    tail = f' {what}' if str(what or '').strip() else ''
    return f'{OPEN}{int(done)}/{int(total)}{tail}{CLOSE}'


def emit(done, total, what: str = '') -> None:
    """
    打一行进度（**立刻 flush**：心跳靠的就是"最近这一行"，缓冲住就等于没喊）。

    `total` 小于 1（数不清）⇒ **什么都不打**：宁可不报，也不报一个假的分母。
    """
    if int(total or 0) < 1:
        return
    print(line(done, total, what), flush=True)
