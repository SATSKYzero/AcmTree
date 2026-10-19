#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
批处理驱动（lib/batch.py）：把「每场一个子进程」变成「每个适配器一个子进程」。

为什么要有它
------------
`xcpc_pipeline.py` 若按「一场 × 一个来源 = 起一个 python 子进程」跑，
全量重建要起约 800 个子进程。而每个子进程都要：
  ① 重新 import 一遍那套 lib（`crate` / `xcpc_common` …）；
  ② 把**共享大缓存**再读再解析一遍（rankland 索引 / xcpcio config / cf 提交 …）。
实测：`--only-source qoj` 的 35 场 4.4 秒 ⇒ 约 0.11 秒/进程 —— 光"起进程"就吃掉了
全量重建 132 秒里的大头，而重复解析是叠在上面的第二层浪费。

本驱动**不改任何适配器的内部实现**：它把 N 个 job 收进一个进程，逐个调用适配器
自己的 `main(argv)`（每个 job 的 `sys.argv` 也摆对，免得有的适配器直接 `parse_args()`）。

用法（`jobs.json` 由 `xcpc_pipeline.py` 生成，一般不用手敲）：
    python lib/batch.py --jobs <jobs.json>

`jobs.json` 形状：
    [{"slug": "bjcpc2025",
      "module": "<适配器 .py 的绝对路径>",
      "argv": ["bjcpc2025", "-o", "<片段路径>", ...]}, ...]

语义与「逐个起进程」**保持一致**：
  - 每个 job 单独捕获 `SystemExit` / 异常 —— 一场失败不影响其它场次继续跑；
  - 全部成功 ⇒ 退出码 0；只要有任何一个失败 ⇒ 退出码 1（并逐条列出失败的场次）；
  - ⚠️ **例外：退出码 2 = "当场停"**（`read_modes` 的凭据过期/被拦、`require_local` 的
    必需原料不在本地）—— 那不是"某一场没跑成"，是"这一轮没法继续"：**不再跑剩下的场次**，
    并把 2 原样转出去（`main` 曾把它压成 1，
    于是"凭据过期"变得和"某一场失败"没区别，后面的场次还会拿着死凭据一路空转）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import traceback

sys.dont_write_bytecode = True

# `Scaper/lib`（通用区）—— 进度只有一种写法，见 `lib/progress.py`
sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'lib'))

import progress     # noqa: E402

#: "当场停"那一类的退出码（`read_modes.read_page` 的 AuthError ⇒ `SystemExit(2)`；
#:   `require_local` 缺原料也是 2）—— 重试没有意义，剩下的场次也不该再跑。
HARD_STOP = 2


def load_module(path: str):
    """按文件路径把适配器当模块加载（缓存由调用方维持，一个适配器只 import 一次）"""
    name = 'batch_adapter_' + os.path.splitext(os.path.basename(path))[0]
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f'加载不了适配器：{path}')
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def run_job(module, job: dict) -> int:
    """跑一个 job（适配器的 `main(argv)`），返回退出码；异常/`sys.exit` 都收在内部"""
    argv = [str(x) for x in (job.get('argv') or [])]
    saved_argv = sys.argv
    sys.argv = [str(job.get('module') or '')] + argv      # 有的适配器直接 parse_args()
    try:
        code = module.main(argv)
    except SystemExit as exit_err:                         # 适配器自己的 sys.exit(...)
        raw = exit_err.code
        if raw is None or raw == 0:
            code = 0
        elif isinstance(raw, int):
            code = raw
        else:
            print(str(raw))                                # 字符串形式的报错要让人看见
            code = 1
    except BaseException:                                  # noqa: BLE001 —— 报给流水线看
        traceback.print_exc()
        code = 1
    finally:
        sys.argv = saved_argv
    return 0 if code is None else int(code)


def main(argv):
    ap = argparse.ArgumentParser(description='批量跑同一个适配器的多个场次（一个进程）')
    ap.add_argument('--jobs', required=True, help='jobs.json（由 xcpc_pipeline.py 生成）')
    ap.add_argument('--label', default='', help='日志里显示的来源名（可选）')
    args = ap.parse_args(argv)

    with open(args.jobs, 'r', encoding='utf-8') as fh:
        jobs = json.load(fh)
    if not jobs:
        print('（没有要跑的场次）')
        return 0

    label = args.label or os.path.splitext(os.path.basename(str(jobs[0].get('module') or '')))[0]
    print(f'📦 批处理：{label} —— {len(jobs)} 个场次挤在一个进程里跑'
          f'（原来是 {len(jobs)} 个 python 进程）')

    modules: dict = {}
    failed = []
    hard_stop = False
    timings: list = []
    for index, job in enumerate(jobs, start=1):
        slug = str(job.get('slug') or (job.get('argv') or [''])[0])
        print(f'\n=== {slug} ===   [{index}/{len(jobs)}]')
        progress.emit(index, len(jobs), '场次')     # ← 应用里那条心跳行看的就是它
        module_path = str(job.get('module') or '')
        try:
            module = modules.get(module_path) or load_module(module_path)
            modules[module_path] = module
        except BaseException:                              # noqa: BLE001
            traceback.print_exc()
            print(f'   ❌ 适配器加载失败：{module_path}')
            failed.append(slug)
            continue
        started = time.time()
        code = run_job(module, job)
        spent = time.time() - started
        timings.append((spent, slug))
        print(f'   ⏱ {spent:.2f}s')
        if code != 0:
            print(f'   ❌ {slug}：适配器失败')
            failed.append(slug)
            if code == HARD_STOP:
                # ⚠️ 凭据过期/被拦（或必需原料不在本地）⇒ **重试没有意义，也别再跑剩下的场次**
                #    （用户："别让 20–75 页跑到一半才发现"）。把 2 原样转出去。
                hard_stop = True
                print(f'   ⛔ 退出码 {HARD_STOP} = "当场停"（凭据过期/被拦，或必需的原料不在本地）'
                      f'—— **不再跑剩下的 {len(jobs) - index} 个场次**')
                break

    if timings:
        timings.sort(reverse=True)
        total = sum(t for t, _s in timings)
        slowest = '、'.join(f'{s} {t:.1f}s' for t, s in timings[:5])
        print(f'\n⏱ 这批共 {total:.1f}s（{len(timings)} 场）；最慢 5 场：{slowest}')

    if hard_stop:
        print('\n⛔ 批处理**当场停**：这不是"某一场失败"，是这一轮没法继续（见上面那句 ⛔）')
        return HARD_STOP
    if failed:
        print(f'\n❌ 批处理结束：{len(failed)}/{len(jobs)} 个场次失败 —— '
              f'{"、".join(failed[:10])}{"…" if len(failed) > 10 else ""}')
        return 1
    print(f'\n✅ 批处理结束：{len(jobs)} 个场次全部完成（一个进程）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
