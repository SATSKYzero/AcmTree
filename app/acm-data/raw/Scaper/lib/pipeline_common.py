"""两条平台流水线（牛客 / 杭电）共用的小工具。

`run` 与 `delete_source` 在 `nk_pipeline.py` / `hdu_pipeline.py` 里本是**逐字相同**的两份
（连 MB/KB 分支和 🗑 文案都一样，只有 docstring 措辞不同）—— 收在这里一份。
两条流水线各自留一个同名薄壳，好让调用点一个都不用改。
"""
from __future__ import annotations

import os
import subprocess


def run(cmd: list[str], dry: bool, repo: str) -> int:
    """跑一个子命令；`dry` 为真时只打印。子脚本不许留 `__pycache__`（每次跑都长，还得手工清）。"""
    printable = ' '.join(f'"{c}"' if ' ' in c else c for c in cmd)
    print(f'   $ {printable}')
    if dry:
        return 0
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'}
    return subprocess.run(cmd, cwd=repo, env=env).returncode


def delete_source(source: str, why: str, keep: bool, here: str) -> None:
    """
    删掉已经"榨干"的源文件（`--keep-source` 可关）。

    ⚠️ 删了就**只能重新抓**（榜单要一整轮分页请求／登录），也再没法拿它重跑解析。
    所以只在**产出确实有数据**时才删，而且每次都打印"删了什么、多大、为什么" ——
    不做静默删除。
    """
    if keep:
        return
    try:
        size = os.path.getsize(source) / 1024
        os.remove(source)
        suffix = f'（{size / 1024:.1f} MB）' if size > 1024 else f'（{size:.0f} KB）'
        print(f'   🗑  已删除 {os.path.relpath(source, here)}{suffix} —— {why}')
    except OSError as e:
        print(f'   ⚠️ 删不掉 {os.path.relpath(source, here)}：{e}')
