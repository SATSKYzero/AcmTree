#!/usr/bin/env python3
# ================================================================
# 命令行跑整条原料处理链（scripts/build-all.py）
#
# 与**应用里那个「🛠 重建总包并导入」按钮**共用同一份步骤表
# （`scripts/build_chain.py`），所以两边不可能跑出不同的东西来。
#
# 用法：
#   python -B scripts/build-all.py             # 等价于 npm run crate:all
#   python -B scripts/build-all.py --offline   # 等价于 npm run crate:all:offline
#   python -B scripts/build-all.py --list      # 只列出会跑哪几步
#
#   python -B scripts/build-all.py --needs                    # 按需求补抓（默认追值门槛 normal）
#   python -B scripts/build-all.py --needs --pursue low        # 连"多半拿不到"的格子一起抓
#   python -B scripts/build-all.py --needs --probe-all         # 兜底档：全部重查
#   python -B scripts/build-all.py --purge                     # 全删重爬（**唯一会删原料的档位**）
#
# ⚠️ `npm run crate:all` 现在就是转发到这里（一个命令两处入口，步骤表只有一份）。
# ================================================================
import argparse
import json
import os
import subprocess
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ★ 本进程的 stdio 钉成 UTF-8（2026-10-18，见 `utf8_stdio.py` 文件头）：
#   关掉 Windows「UTF-8 Beta」后 ACP=936，这里自己打 `⟨…⟩` / ✅ 会 UnicodeEncodeError。
#   ⚠️ 重跑那一路（`_reexec_with_hashseed`）也会把 `PYTHONUTF8=1` 传给孩子。
import utf8_stdio                                                           # noqa: E402
utf8_stdio.pin()

import build_chain                                                          # noqa: E402


def _reexec_with_hashseed():
    """
    固定哈希盐（PYTHONHASHSEED=0）：不固定的话，set/dict 的迭代顺序每个进程都不一样
    ⇒ 包里的记录顺序（甚至某些"先到先得"的取值）会变，两次构建【逐字节不同】。
    盐必须在解释器启动前设好（运行时改不了），所以换一个"固定盐的自己"重跑。

    @returns 子进程的退出码（父进程**原样转出去**）；不需要重跑时 `None`。

    ⚠️ **不能用 `os.execv`**（实测踩到）：Windows 上 execv 是"起新进程 + 自己退出"，
    父进程以 **0** 退出 ⇒ **整条链的失败码被吞掉**（日志里写着 ❌ 第 1 步失败，`$LASTEXITCODE`
    却是 0 ⇒ 命令行与 `npm run crate:all` 看着像成功）。用子进程 + 转出退出码就没有这个洞。
    ⚠️ 子进程命令**必须用列表**（不是 shell 字符串）：目录名 `05 xcpc` 带空格，
    execv 那条路要手工加引号就是为了这个 —— 列表把引号问题彻底去掉。
    想要随机盐：设 `ACM_NO_HASHSEED=1`。
    """
    if os.environ.get('PYTHONHASHSEED') == '0' or os.environ.get('ACM_NO_HASHSEED') == '1':
        return None
    # ★ `PYTHONUTF8=1` **必须带上**（2026-10-18 实测踩到）：重跑只传了 `-B`，把**父进程的
    #   `-X utf8` 丢了** ⇒ 关掉 Windows「UTF-8 Beta」之后（ACP=936），子进程按 GBK 打输出，
    #   第一处 `⟨` 就 `UnicodeEncodeError` —— 症状是"带 `-X utf8` 也照样崩"，因为它崩在**孙子**那层。
    #   写进 env 而不是只补 `-X`：这样无论父进程是怎么起来的（npm / bat / 手敲），孩子都是 UTF-8。
    env = dict(os.environ, PYTHONHASHSEED='0', PYTHONUTF8='1')
    target = os.path.abspath(__file__)
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        return subprocess.call([sys.executable, '-B', target] + sys.argv[1:], env=env)
    except OSError as err:
        # 起不来就按随机盐继续（宁可这次不可复现，也别什么都不干）
        print('⚠️ 固定哈希盐失败（%s）⇒ 这一次按随机盐继续' % err)
        return None


NEEDS_PATH = build_chain.NEEDS_JSON


def plan_from_needs(pursue: str = 'normal', probe_all: bool = False, probe: bool = True):
    """读原料需求清单 → **抓取计划**（薄壳：实现只有一份，在 `build_chain.needs_plan`）

    `probe=False` ⇒ 不跑"探数据"那一步（`--dry-run` 用：那一步会联网探 + 重写清单）。
    """
    return build_chain.needs_plan(pursue, probe_all, probe=probe)


def main(argv):
    ap = argparse.ArgumentParser(description='原料处理链（注册表 → 分类规则 → 产包 → 字段体检 → 离线试跑）')
    ap.add_argument('--offline', action='store_true',
                    help='第三步改走 --offline（不联网，用本地已有的原始数据）')
    ap.add_argument('--list', action='store_true', dest='list_steps',
                    help='只列出步骤，不跑')
    ap.add_argument('--needs', action='store_true',
                    help='按 `acm-data/reports/material-needs.json` **补抓原料**再重建'
                         '（刷新该渠道的旧缓存 + 只重跑该来源）')
    ap.add_argument('--pursue', choices=['high', 'normal', 'low'], default='normal',
                    help='**重爬优先级门槛**（默认 normal）：低于这一档的缺口**不进需求清单** —— '
                         'normal = 跳过标了"多半拿不到"的格子；low = 连那些也一起抓；'
                         'high = 只抓明确值得追的。'
                         '（不带 `--needs` 时它只管链尾那步「原料需求」报告，不联网）')
    ap.add_argument('--probe-all', action='store_true', dest='probe_all',
                    help='（配 `--needs`）**兜底档**：忽略已记下的结论，把缺难度的题全部重查一遍'
                         '（= 第③档「兜底全部重爬」；默认是第②档：有结论的不碰、否定证据 30 天过期）')
    ap.add_argument('--purge', action='store_true',
                    help='**全删重爬**（= 应用里那第 6 档）：先 `prune-raw.py --apply` 去掉无用原料'
                         '（判定在 `Scaper/lib/material.py`），再整份重抓。'
                         '⚠️ **这是唯一会删原料的档位** —— 其余档位一律只增量合并')
    ap.add_argument('--dry-run', action='store_true', dest='dry_run',
                    help='只打印要做什么（补抓计划 / 步骤表），不动任何文件')
    args = ap.parse_args(argv)
    code = _reexec_with_hashseed()
    if code is not None:
        return code              # 父进程只当"传话筒"：**原样转出**子进程的退出码

    only_source = ''
    if args.purge and (args.needs or args.offline):
        # ⚠️ 「全删重爬」与另外两档互斥：它自己的口径是"先删无用原料、再整份重抓"，
        #    和"只补缺的"（--needs）/ "一次也不联网"（--offline）是两码事，拼一起只会写出别扭的描述。
        print('⚠️ `--purge` 与 `--needs` / `--offline` 互斥 ⇒ 这一轮只按 `--purge` 跑'
              '（先删无用原料，再整份重抓）')
        args.needs = False
        args.offline = False
    if args.needs and args.offline:
        # ⚠️ 离线档不能补抓：探数据要联网、丢掉缓存后重建还要重新抓 —— 先拦在"删缓存"之前，
        #    否则离线重建会因为缺原料当场失败（与应用里那个按钮同一个口径，见 `needs_step_for`）
        print('⚠️ --offline **不补抓原料**（补抓要先联网）⇒ 这一轮按标准重建走；'
              '要补抓就去掉 `--offline`')
    elif args.needs:
        print('=== 重爬优先级门槛：%s%s ===' % (
            args.pursue,
            '（跳过"多半拿不到"的格子；要连它们一起抓：`--pursue low`）'
            if args.pursue == 'normal' else
            '（连"多半拿不到"的都算进来）' if args.pursue == 'low' else
            '（只抓明确值得追的）'))
        print('=== 探数据档位：%s ===' % ('③ 兜底全部重爬（--probe-all）' if args.probe_all
                                          else '② 不断试爬（默认：有结论的不碰、否定证据 30 天过期）'))
        if args.dry_run:
            # ★ **`--dry-run` 必须在"探数据"之前返回**（2026-10-16 修，审计翻出来的）：
            #   `plan_from_needs()` 默认会跑 `material-needs.py --probe` —— 那一步**联网探**
            #   并且**重写** `acm-data/reports/material-needs.json`，而 `--dry-run` 承诺
            #   "什么都不动"（裸跑那一路早就修过了，只有 `--needs` 这一支还漏着）。
            #   ⇒ 只按**现有**那份清单说要说要干什么；清单还没有就如实说。
            plan = plan_from_needs(args.pursue, args.probe_all, probe=False)
            if plan is None:
                print('（还没有原料需求清单 —— 真跑时它会先探一次再补抓）')
            else:
                build_chain.report_needs_plan(plan)
            print('（--dry-run：到此为止，什么都没动）')
            return 0
        plan = plan_from_needs(args.pursue, args.probe_all)
        if plan is None:
            return 1
        if not plan['needs']:
            print('✅ 原料需求清单是空的 —— 没有要补抓的原料')
            return 0
        only_source = build_chain.apply_needs_plan(plan)

    steps = build_chain.steps_for(args.offline, only_source, args.pursue, prune=args.purge)
    if args.list_steps or args.dry_run:
        for i, step in enumerate(steps, 1):
            extra = ('  ⟨%s⟩' % ' '.join(step.argv)) if step.argv else ''
            print('%d. [%s] %s  ← %s%s' % (i, step.key, step.title, step.script, extra))
        if args.dry_run and not args.list_steps:
            # ⚠️ **`--dry-run` 必须在这里就返回**（实测踩到，2026-10-15）：它原来**只在
            #    `--needs` 那一支**被认（上面那个 `if args.dry_run`）⇒ 裸跑
            #    `build-all.py --dry-run` 会**把整条链真跑一遍**（真改了盘上的包），
            #    而自己的 `--help` 白纸黑字写着"不动任何文件"。
            #    `--list` 是它的近义词（只列步骤）⇒ 两条并成一处打印。
            print('（--dry-run：到此为止，什么都没动）')
        return 0

    print('=== 原料处理链（%d 步，%s%s，追值门槛 %s）===' % (
        len(steps), '离线' if args.offline else '联网',
        ('，只重跑 ' + only_source) if only_source else '', args.pursue))
    started = time.time()
    results = build_chain.run_chain(steps, offline=args.offline)
    print('\n=== 汇总（%.1fs）===' % (time.time() - started))
    for result in results:
        mark = '⏭️ 跳过' if result.skipped else ('✅' if result.code == 0 else '❌ 退出码 %d' % result.code)
        print('  %s %s（%.1fs）' % (mark, result.title, result.seconds))
    bad = [r for r in results if r.code != 0]
    # ★ **暂停**：`run_chain` 会在末尾塞一条哨兵结果。
    #   它**不是失败**（`code=0`），但**也不是"跑完了"** —— 不单独认它就会打「✅ 全部完成」骗人。
    stopped = [r for r in results if r.key == build_chain.STOPPED_KEY]
    if stopped:
        print('\n⏸ 已暂停（跑完当前步就停）：跑了 %d 步（共 %d 步），后面的没跑。'
              % (len(results) - 1, len(steps)))
        print('   已经产出来的包是可用的；要接着跑就直接重跑这一条命令（链子幂等）。')
        return 0
    if bad:
        print('\n❌ 第 %d 步失败：%s' % (
            [r.key for r in steps].index(bad[0].key) + 1, bad[0].title))
        return bad[0].code if isinstance(bad[0].code, int) else 1
    print('\n✅ 全部完成：%s' % os.path.relpath(build_chain.PACKAGE_PATH, build_chain.REPO))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
