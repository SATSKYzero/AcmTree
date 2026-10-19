#!/usr/bin/env python3
# ================================================================
# 原料处理链（scripts/build_chain.py）
#
# 口径："如果整个原料处理脚本都是主脚本的一部分，就根本不用这么复杂，且没有任何限制"
# ⇒ 整条链就是主脚本的一部分，不套额外的进程层。
#
# 若把这条链交给 `npm run crate:all` 那种形态（用 `&&` 串 3 个 python + 1 个 node 校验），
# 应用里的按钮要跑它，就得走
#   浏览器 → 本机服务器 → npm → node → python → 3 个子步骤
# ——对一条纯 python 的链子来说，中间三层全是白加的边界，每多一层多一类
#   「不可见的坑」（旧进程不知道新接口、PATH、终端编码、stdout 刮日志……）。
#
# 形态：**服务器进程内直接调用**。步骤表只此一份，两个入口共用：
#   - `scripts/dev-server.py`（应用里那个按钮）——后台线程 + 日志回给页面；
#   - `scripts/build-all.py`（命令行）——前台跑，日志直接打终端。
#
# 关于「末尾那步校验」：
#   `crate:all` 的最后一步是 `node scripts/crate-check.mjs`（用应用真实的导入引擎
#   离线试跑一份包）。口径：**处理流程保留** —— 一步不少、顺序不变。
#   它确实是 JS 工具（复用 src/ 下的导入引擎，不是能用 python
#   重写的东西），所以这一步仍是**子进程**，但直接调 `node`，不再从 npm 绕一圈；
#   机器上没有 node 时**只跳过并明说**，不算失败（纯 python 的三步照跑）。
#
# `runpy.run_path(..., run_name='__main__')` 的用法：
#   每个步骤都以"全新的命名空间"执行一次，等价于"干净地跑一遍那个脚本的 main"，
#   因此**不共享模块级状态**（连着点两次按钮不会拿到上次的缓存），
#   也**不会**因为脚本里的 `sys.exit(...)` 把服务器带走（SystemExit 被接住）。
# ================================================================
import contextlib
import glob as globmod
import io
import json
import os
import runpy
import shutil
import subprocess
import sys
import time
import traceback
from typing import Callable, NamedTuple, Optional
from selftest_kit import Selftest

# ★ 本进程的 stdio 钉成 UTF-8（2026-10-18）：见 `utf8_stdio.py` 文件头 ——
#   关掉 Windows「UTF-8 Beta」后 ACP=936，脚本自己打 `✅` 会 UnicodeEncodeError。
#   ⚠️ 只兜"本进程"；孩子那侧靠下面 `_run_cmd_step` 的 env。
import utf8_stdio                       # noqa: E402 —— 必须在 sys.path 就绪之后
utf8_stdio.pin()

# 不留 __pycache__（仓库约定）
sys.dont_write_bytecode = True

#: **机械层根**（本文件在 `app/scripts/` 下 ⇒ 上一层就是 `app/`）。
#: ⚠️ 不是仓库根：`acm-data/…`、`scripts/…` 这些相对路径都是相对 `app/` 的
#:    （2026-10-17 我按"仓库根"理解它，`EXTERNAL_TABLES` 的路径当场全部指到了 `app/app/…`）。
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: 产物目录（`xcpc_pipeline.py` 往这里写 `*.json`，以及"本轮没产出"时的 `*.json.stale` 标记）
NODES_DIR = os.path.join(REPO, 'acm-data', 'nodes')


def stale_products(nodes_dir: str = '') -> list:
    """
    哪些产物**带着 `.stale` 标记**（= 这一轮的运行没有重新生成它，盘上那份是上一次的）。

    为什么要有这个函数：
    `xcpc_pipeline.py` 会写这个标记（"本轮没有产出这个类 ⇒ 旧产物可能是过期数据"），
    但**没有任何地方读它** —— 标记等于没写，只剩日志里那几行。所以这里必须读。
    这里让链子跑到最后把话说出来：`run_chain` 成功收尾时会念一遍。
    """
    d = nodes_dir or NODES_DIR
    if not os.path.isdir(d):
        return []
    suffix = '.json.stale'
    return sorted(f[:-len('.stale')] for f in os.listdir(d) if f.endswith(suffix))
#: 产出的总包（应用会把它取回去导入）
PACKAGE_REL = os.path.join('acm-data', 'nodes', 'all_nodes.json')
PACKAGE_PATH = os.path.join(REPO, PACKAGE_REL)


class Step(NamedTuple):
    """一步：`key` 给界面认、`title` 给人看、`script`/`argv` 就是要跑的东西"""

    key: str
    title: str
    script: str
    argv: tuple = ()
    #: 'py' = 本进程内跑（runpy）；'cmd' = 起一个外部命令（只有一个：node 校验）
    kind: str = 'py'
    #: True = 离线档跳过这一步（只有必须联网的那几步用它，如 CLIST 难度）
    skip_offline: bool = False
    #: 这些退出码**只提示、不算失败**（链条继续跑，也不影响出包/导入）。
    #: ⚠️ 只许给"这一步的退出码本身就是**报告**"的步骤用 —— 目前只有 `coverage`（见那一步的注释）。
    #:    用法先例：2026-10-17 实测，只差 1 个题名 + 1 个题号就让整轮判失败 ⇒
    #:    应用那个「🛠 重建总包并导入」**永远不自动导入**（包明明已经产出来了）。
    warn_codes: tuple = ()
    #: "这一步的**原料**在不在这台机器上"（相对 `REPO` 的 glob，命中**任一**就跑）。
    #: 一个都没命中 ⇒ **跳过这一步**并说一句（不是失败）：杭电/牛客那两棵树在"没有那批原料"的
    #: 机器上本来就出不来，而链子后面那步只会打"缺这几个（没算进去）"—— 与现在的手工口径一致。
    #: ⚠️ 只用于"没有输入就无事可做"的步骤，**别拿它当开关**（要开关就加 `skip_offline` 那种显式字段）。
    needs: tuple = ()


class StepResult(NamedTuple):
    """一步的结果（`code` 非 0 ⇒ 链子在这里停下）"""

    key: str
    title: str
    code: int
    seconds: float
    skipped: bool = False


#: 原料需求清单（`material-needs.py` 的产物）—— 按需补抓读的就是它
NEEDS_JSON = os.path.join(REPO, 'acm-data', 'reports', 'material-needs.json')

#: 「用户按了暂停」那条**哨兵结果**的 `key`（暂停按钮：页面按一下 ⇒ 置标志，
#: 链子跑完当前步就停）。
#: ⚠️ 它不是失败（`code=0`），也**不是**"跑完了" ⇒ 调用方要单独认它，
#:    否则会打「✅ 全部完成」骗人（`build-all.py` 与 `build_runner.py` 两处都认了）。
STOPPED_KEY = '__stopped__'

#: 「重建档位」：应用那个「🛠 重建总包并导入」按钮**唯一**能传的东西
#  （主脚本建包不能手输指令 ⇒ 页面给一个档位选项）。
#  四个预设各自等于命令行的一组开关 —— 所以"按钮选的"与"命令行敲的"跑的是同一件事：
#    · `--needs`         ⇒ `needs`
#    · `--pursue low`    ⇒ `needs-low`（把标了"多半拿不到"的缺口也列进抓取计划）
#    · `--probe-all`     ⇒ `probe-all`（兜底重探：忘掉"拿不到"的旧结论）
#  ⚠️ 页面下拉框里有**6 个**预设：这里 5 个（标准 / 三个补抓档 / **全删重爬**），
#     第 6 个是「离线重建」= 这里的标准档 + `offline=True`（页面把它并进下拉框）—— 服务器侧照旧只收
#     "一个布尔 + 一个枚举名"（`parse_build_body`），**协议没变**。
#  ⚠️ 档位只**多做了"补抓原料"或"删无用原料"**，不改处理链本身；`pursue` 见 `docs/field-rules.md` §1.1.2。
#  ⚠️ **两个轴别混**：
#     轴 A「产包那一步怎么跑」= 链上第 3 步。**2026-10-17 起只有「全删重爬」那一档是
#        `--force --all-nodes`（= 把已有归档当不存在、所有来源重跑一遍）；其余联网档一律
#        `--all-nodes`（按需：缺的才抓，**不删任何东西**）；「离线重建」走 `--offline`。
#     轴 B「要不要先探数据、按需求补原料」= `needs_plan()` 那一段，**只有三个补抓档做**。
#     ⇒ 「标准」与「兜底」在轴 A 上**完全一样**，差别全在轴 B。
BUILD_MODES = {
    'standard': {
        'label': '标准重建（用现有原料，缺的才抓）',
        'needs': False, 'pursue': 'normal', 'probe_all': False,
        'hint': '= 命令行 `python -B scripts/build-all.py`：拿盘上现有原料按需出包'
                '（**不删任何东西**；缺的原料由适配器自己按缓存语义去抓）。'
                '要"整份重抓"请用「全删重爬」那一档',
    },
    'needs': {
        'label': '按需求补抓原料',
        'needs': True, 'pursue': 'normal', 'probe_all': False,
        'hint': '= `build-all.py --needs`：先探数据，再丢掉该渠道的旧缓存、只重跑缺的来源'
                '（补的是**原料缺口**）',
    },
    'needs-low': {
        'label': '补抓 + 连"多半拿不到"一起',
        'needs': True, 'pursue': 'low', 'probe_all': False,
        'hint': '= `--needs --pursue low`：追值门槛放到 low，那 179 格（RankLand 的题链接与开赛时间）也进计划',
    },
    'probe-all': {
        'label': '兜底重探（忘掉"拿不到"的旧结论）',
        'needs': True, 'pursue': 'normal', 'probe_all': True,
        'hint': '= `--needs --probe-all`：把那 179 格"多半拿不到"的旧结论也忘掉、缺的/缺难度的全部重查。'
                '⚠️ 它**不删原料、也不整份重抓**（那是「全删重爬」那一档的事）；比标准档慢，不是"更全的默认"',
    },
    # ★ **唯一会删东西的档位**（用户 2026-10-17 定："其他档位不应有任何删除，只有增量合并"）：
    #   先跑 `prune-raw.py --apply`（判定在 `Scaper/lib/material.py`），再 `--force --all-nodes` 整份重抓。
    'purge': {
        'label': '全删重爬（先去无用原料，再整份重抓）',
        'needs': False, 'pursue': 'normal', 'probe_all': False, 'prune': True,
        'hint': '= 先 `python -B scripts/prune-raw.py --apply`（**全仓唯一会删原料的地方**：'
                '白名单/花名册之外的旧缓存），再 `--force --all-nodes` 把剩余的来源整份重抓。'
                '用在"白名单改了 / 原料脏了"这种要重来一遍的场合',
    },
}

#: 认不出档位时用哪个（**默认档**）
DEFAULT_MODE = 'standard'


def mode_of(mode: str) -> str:
    """档位名 → 认识的档位名（认不出 ⇒ `standard`：不冒进，也不会因为拼错就去删缓存）"""
    key = str(mode or '').strip()
    return key if key in BUILD_MODES else DEFAULT_MODE


def mode_plan(mode: str) -> dict:
    """档位 → `{key, label, needs, pursue, probe_all, prune, hint}`（给服务器/日志用）"""
    key = mode_of(mode)
    out = dict(BUILD_MODES[key])
    out['key'] = key
    out['prune'] = bool(out.get('prune'))
    return out


def refetch_argv(need: dict) -> list:
    """
    这条需求"刷新原料"该跑哪条命令？—— **一律只补缺的/过期的**（`read_modes` 的缓存语义：
    有缓存的不重抓）。

    ⚠️ 2026-10-17 起**没有"带 `--force` 整份重抓"那一支了**（用户口径："其他档位不应有任何删除，
    只有增量合并"）：整份重抓属于「全删重爬」那一档 —— 它先把无用的删掉（`prune-raw.py --apply`）、
    再让产包那步带 `--force`。实测整份重抓 RankLand 索引要 **17 分钟**且可能更差，
    而"只补缺的"才是有意义的默认。
    """
    return [str(x) for x in (need.get('refetch') or [])]


def needs_plan(pursue: str = 'normal', probe_all: bool = False,
               on_line: Optional[Callable[[str], None]] = None,
               probe: bool = True) -> Optional[dict]:
    """
    跑一次 `material-needs.py --probe`（探数据）→ 读清单 → **抓取计划**。

    **让抓取部分知道该抓哪些原料**。
    清单里每条需求都写着「哪个渠道、缺什么、要碰哪份原料、怎么补」；这里把它翻成两件事：
      ① **刷新原料**：把该渠道那份旧缓存删掉（不删就永远读旧的那份 —— KEEP 语义），
         重建时它自然重抓；
      ② **重跑来源**：若所有需求指向**同一个** `--only-source`，就只重跑它（快）；
         否则老老实实全量重建（`--only-source` 一次只能给一个）。

    ⚠️ **唯一一份实现**：命令行 `scripts/build-all.py --needs` 与应用里那个按钮
    （`scripts/devserver/build_runner.py`）都调这里，两边不可能跑出不同的东西。

    @param pursue    - 重爬优先级门槛（`high`/`normal`/`low`，见 `docs/field-rules.md` §1.1.2）
    @param probe_all - 兜底档：透传 `--probe-all`（忽略已记下的结论、全部重查）
    @param on_line   - 逐行日志回调（`None` ⇒ 直接打终端）
    @param probe     - `False` ⇒ **不跑探数据那一步**，只读**现有**的 `material-needs.json`
                       （`--dry-run` 用：那一步会联网探 + **重写**那份清单，而 "dry-run = 什么都没动"）
    @returns `{needs, caches, sources, onlySource}`；**跑不起来/没有清单 ⇒ `None`**
    """
    if probe:
        argv = [sys.executable, '-B', os.path.join(REPO, 'scripts', 'material-needs.py'),
                '--probe', '--pursue', pursue]
        if probe_all:
            argv.append('--probe-all')
        _emit(on_line, '🔎 探数据 + 出原料需求清单：material-needs.py --probe --pursue %s%s'
              % (pursue, ' --probe-all' if probe_all else ''))
        try:
            subprocess.run(argv, cwd=REPO, check=False)
        except OSError as err:
            _emit(on_line, '⚠️ 跑不起来（%s: %s）⇒ 这一轮按标准重建走' % (type(err).__name__, err))
            return None
    if not os.path.isfile(NEEDS_JSON):
        _emit(on_line, '⚠️ 还没有原料需求清单 —— 先跑一次 `python -B scripts/material-needs.py`')
        return None
    with open(NEEDS_JSON, 'r', encoding='utf-8') as fh:
        doc = json.load(fh)
    needs = doc.get('needs') or []
    caches = []
    refetches = []              # 每条 = 一个 argv（去重、保序）
    covered = []               #: 有 builder 刷新的那些缓存（builder 会覆盖它 ⇒ 不删）
    for need in needs:
        cmd = refetch_argv(need)
        if cmd and cmd not in refetches:
            refetches.append(cmd)
        for rel_path in need.get('caches') or []:
            full = os.path.join(REPO, rel_path)
            if cmd and full not in covered:
                covered.append(full)
            if full not in caches:
                caches.append(full)
    sources = sorted({n.get('onlySource') or '' for n in needs} - {''})
    return {
        'needs': needs,
        'caches': caches,
        'refetches': refetches,
        'covered': covered,
        'probeAll': bool(probe_all),
        'sources': sources,
        'onlySource': sources[0] if len(sources) == 1 else '',
    }


def report_needs_plan(plan: dict, on_line: Optional[Callable[[str], None]] = None) -> None:
    """把抓取计划讲给人和日志听（`--dry-run` 与真正执行时都先讲一遍）"""
    _emit(on_line, '=== 按需补抓（%d 条需求）===' % len(plan['needs']))
    for need in plan['needs']:
        _emit(on_line, '  · [%s] %s 缺 %d 格 → %s' % (
            need.get('channelLabel'), need.get('field'), need.get('gain', 0),
            need.get('action')))
        _emit(on_line, '      要碰的原料：%s'
              % ('、'.join(need.get('caches') or []) or '（无）'))
    # ★ 实测踩到的 bug：**先刷新、不要先删** —— `rankland_index.json` 这类"建出来的
    #   索引"被删掉之后，链子**第 1 步（注册表）立刻失败**（它要拿这份索引校验 slug），
    #   而且删缓存本身**不会**触发重抓（适配器只读它）⇒ 等于把路堵死。有 builder 的就跑 builder。
    for cmd in plan.get('refetches') or []:
        _emit(on_line, '  ↻ 刷新原料（只补缺的/过期的）：%s' % ' '.join(
            os.path.relpath(x, REPO) if x.endswith('.py') else x for x in cmd))
    for path in plan['caches']:
        if path in (plan.get('covered') or []):
            _emit(on_line, '  （这份原料由上面的命令刷新）')
            continue
        _emit(on_line, '  · 这份原料缺了/该重抓，但没有 builder ⇒ 交给适配器自己按缓存语义抓'
                       '（**我们一个字节都不删**）：%s' % os.path.relpath(path, REPO))
    if len(plan['sources']) > 1:
        _emit(on_line, '  ⚠️ 需求跨了多个来源（%s）⇒ 这次**全量重建**'
                       '（`--only-source` 一次只能给一个）' % '、'.join(plan['sources']))
    elif plan['onlySource']:
        _emit(on_line, '  ↻ 只重跑来源：%s' % plan['onlySource'])


def apply_needs_plan(plan: dict, on_line: Optional[Callable[[str], None]] = None) -> str:
    """
    按计划**只刷新原料**（跑 builder），返回"只重跑哪一个来源"（空 = 全量重建）。

    ★ **这里一个字都不删**（用户 2026-10-17 定的口径："其他档位不应有任何删除，只有增量合并"）：
      · 有 builder 的 ⇒ 跑它（builder 自己按缓存语义决定抓多少、覆盖哪些）；
      · 没有 builder 的 ⇒ **什么都不做**（那份缓存缺就缺着，适配器自己会去抓；抓不到就保留旧的）。
    ⚠️ 以前这里会 `os.remove` 掉一批缓存（"先丢后抓"）—— 那是个坑：**先删**之下，
      来源一旦抓不到（凭据过期/被拦），被删的那份就**真的没了**（2026-10-17 实测：
      一次 probe-all 就删掉了 `cache/atcoder/letter_warnings.json`）。
      "哪些原料已经没用了"是**判定**问题，只有 `Scaper/lib/material.py` 有资格回答，
      而删除只发生在 `prune-raw.py --apply`（= 「全删重爬」那一档）。
    """
    report_needs_plan(plan, on_line)
    for cmd in plan.get('refetches') or []:
        argv = [sys.executable if x == 'python' else x for x in cmd]
        script = os.path.join(REPO, cmd[0]) if cmd and cmd[0].endswith('.py') else ''
        run_argv = [sys.executable, '-B', script] + list(cmd[1:]) if script else argv
        _emit(on_line, '  ▶ %s' % ' '.join(os.path.relpath(x, REPO) if x.startswith(REPO) else x
                                           for x in run_argv))
        try:
            code = subprocess.run(run_argv, cwd=REPO, check=False).returncode
        except OSError as err:
            code = -1
            _emit(on_line, '  ⚠️ 刷新原料起不来（%s）' % err)
        if code != 0:
            _emit(on_line, '  ⚠️ 刷新原料失败（退出码 %s）⇒ **保留旧缓存**，继续往下跑' % code)
    return plan['onlySource']


def steps_for(offline: bool = False, only_source: str = '', pursue: str = '',
              prune: bool = False) -> tuple:
    """
    这条链有哪几步（顺序即依赖顺序；与 `crate:all` 那条 `&&` 完全一致）。

    共 **14 步**（离线档 13 步）：注册表 → QOJ 抓取 → **杭电/牛客两棵树** → 产包 → 建组 → 题目绑定
    → 补回代 → 落位 → CLIST → 试跑 → 体检 → 需求 → 随包报告。

    @param offline - True ⇒ 第三步走 `--offline`（不联网，用本地已有的原始数据）
    @param only_source - 非空 ⇒ 第三步加 `--only-source <它>`（**只重跑这一个来源的适配器**，
                         其余片段沿用 cache）。用在「按需补抓」：见 `material-needs.py`
                         + `build-all.py --needs`。
    @param pursue - 非空 ⇒ **链尾那步原料需求**加 `--pursue <档>`（重爬优先级门槛：
                    `high`/`normal`/`low`；空 = 用 `material-needs.py` 自己的默认档 `normal`）
    @param prune - True ⇒ **在最前面**加"去除无用原料"（`prune-raw.py --apply`），
                    并且第三步走 `--force --all-nodes`（整份重抓）。
                    ⚠️ 用户 2026-10-17 定的口径：**只有这一档会删、会整份重抓**；
                       其余档位一律"增量合并"（缺的才抓；抓不到就保留旧文件）。
    """
    #: 应用的 crate 参数：**只有「全删重爬」才 `--force`**（`--force` = 把已有归档当不存在、全部重抓）
    if offline:
        crate_argv = ('--offline', '--all-nodes')
    elif prune:
        crate_argv = ('--force', '--all-nodes')
    else:
        crate_argv = ('--all-nodes',)
    if only_source:
        crate_argv = crate_argv + ('--only-source', only_source)
    needs_argv = ('--pursue', pursue) if pursue else ()
    # ★ 「去除无用原料」那一步：**全仓唯一会删原料的地方**（判定在 `Scaper/lib/material.py`）。
    prune_step = (Step('prune', '去除无用原料（prune-raw --apply：白名单/花名册之外的旧缓存）',
                       os.path.join('scripts', 'prune-raw.py'), ('--apply',)),) if prune else ()
    # ★ **QOJ 提交（活数据）：挂进链上**（用户 2026-10-15："把 QOJ 的提交加到自动链上"）。
    #   为什么要挂：它是包里"新提交"的**唯一来源**；不挂的话产包那一步只会去读盘上那份
    #   `04 qoj/qoj_submissions.json` ⇒ 只要忘了手动跑一次，包里就**静默**缺新提交
    #   （实测反复踩：18:23 的链读的是 16:15 的文件，17:53 / 18:16 的提交一条都没进）。
    #   ⚠️ **别把它读成"链上只有这一步联网"**（2026-10-17 用户拿这句话追问出来的）：
    #   产包那一步（第 3 步 `crate`）**自己也会联网** —— AtCoder 与 CF 正式比赛是活数据
    #   （适配器里就地 `CACHE_NONE` ⇒ 每次抓），CF gym / xcpcio 只补本地缺的那几场。
    #   逐条小表在 `docs/manual-workflow.md` 的「3.0 这 14 步里，哪几步会联网」。
    #   真正"链上完全不碰"的是 rankland / srk 的**抓取**（那两条是单独脚本）。
    #   ⚠️ 杭电/牛客两棵树自 2026-10-18 起**在链上产**（见下面 `hdu` / `nk` 两个步骤），
    #      但那是**本地出包**、不联网 —— 别把它读成"链上多了抓取步"。
    #   范围 = 花名册（`me.json` 的 qoj 账号；`active:false` 的按 `lib/me.py` 的口径不抓）。
    #   ⚠️ **离线档不进表**：这是**抓取**步（`--fetch` 必然联网），而离线是"一次也不联网"
    #      ⇒ 连跑都不该跑（与 `clist` 那种"有缓存就只回写"的步不同，所以走"不进表"而不是
    #      `skip_offline`）。
    #   ⚠️ **`--only-source <别的来源>` 时也不进表**：那一路的口径是"只重跑这一个来源"。
    #   ⚠️ 没配 `qoj.cookie` ⇒ 脚本自己**友好跳过**（exit 0，与 `clist` 同一条口径）；
    #      **cookie 过期/被拦** ⇒ 当场停（exit 2）—— 宁可停下来换 cookie，
    #      也不要静默出一份缺新提交的包（那正是这个坑的原始症状）。
    #   ⚠️ 必须排在**产包之前**：产包那步的 QOJ 适配器读的就是它刚写下的那份 JSON。
    qoj_fetch = () if (offline or only_source not in ('', 'qoj')) else (
        Step('qoj-submits', 'QOJ 提交（活数据：按花名册逐人抓）',
             os.path.join('acm-data', 'raw', 'Scaper', '04 qoj', 'QOJ_submissions_scraper.py'),
             ('--fetch',)),
    )
    return (
        *prune_step,
        Step('registry', '注册表（xcpc_registry build）',
             os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'xcpc_registry.py'), ('build',)),
        *qoj_fetch,
        # ⚠️ **这一步（`nature_rules.py build`）已从链上摘掉** —— 它是**第二个建组器**
        #    （清单 slug 那套），与 `synth-bind.mjs`（按 nature）并存必然漂。它 413 条产物里
        #    大部分早被 `synth-bind` 覆盖：128 个组头全是**国内**且换成新格式键、258 条成员
        #    指针重写；非国内那条路**从来没命中过**（清单 186 场全是国内口径的场次）。
        #    ⚠️ **但它不是纯冗余**：顶层 W `xcpc`、`xcpc:s:synth-icpc` 中间层容器、成员指针的
        #    `字段来源.ownerSynth` 只有它给 —— 那三样**已经补进 `synth-bind.mjs`**
        #    （它现在自己把容器链铺到顶），补完那次真重建与摘掉前的包逐条比：
        #    记录集与结构完全一致，差异只有"来源痕补全 / 组头镜像写法 / 3 个组头的依据"
        #    （详见 `scripts/nature_rules.py` 文件头的实测清单）。
        #    ⇒ 一个建组器，不再两个并存。要复活请先想清楚"谁来管非国内"。
        # ★ **杭电 / 牛客那两棵多校树：现在链上产**（2026-10-18）。
        #   为什么要挂：它们是 `--all-nodes` 的**输入**，但链里一步都不产 ⇒ 忘了手动跑
        #   `npm run crate:hdu` / `crate:nk` 时，包会静默少一整棵（`side_tree_notes()` 只能
        #   事后喊"这棵比原料旧"）。用户 2026-10-18 把这件列进"剩下的任务"。
        #   ⚠️ **这两步不联网**：`build` 只读盘上已有的原料（杭电 `hdu_multi_fetch.py build` →
        #      `hdu_pipeline --all` 解析本地 HTML/JSON；牛客 `nk_multi_fetch.py build` 读 `01 nk/cache`）
        #      ⇒ 离线档**也跑**（不加 `skip_offline`），否则离线重建出来的包会缺这两棵。
        #   ⚠️ **必须排在产包之前**：产包那步（`xcpc_pipeline --all-nodes`）读的就是它们刚写下的
        #      `nodes/hdu-multi-university.json` / `nodes/nk-multi-university.json`。
        #   ⚠️ `needs` = "这台机器上有没有那批原料"：没有就**跳过**（不失败），产包那边照旧打
        #      "缺这几个（没算进去）"—— 与之前手工口径一致，不会让别人克隆一份就跑不动链。
        Step('hdu', '杭电多校树（hdu_multi_fetch build：本地出包）',
             os.path.join('acm-data', 'raw', 'Scaper', '02 hdu', 'hdu_multi_fetch.py'), ('build',),
             needs=('acm-data/raw/Scaper/02 hdu/**/hdu_cid*_problems*.json',
                    'acm-data/raw/Scaper/02 hdu/**/hdu_cid*_source.html',
                    'acm-data/raw/Scaper/02 hdu/**/hdu_cid*_rank*.json')),
        Step('nk', '牛客多校树（nk_multi_fetch build：本地出包）',
             os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'nk_multi_fetch.py'), ('build',),
             needs=('acm-data/raw/Scaper/05 xcpc/cache/nk/nk_cid*_contest.json',)),
        Step('crate', '产包（xcpc_pipeline %s）' % ' '.join(crate_argv),
             os.path.join('acm-data', 'raw', 'Scaper', '05 xcpc', 'xcpc_pipeline.py'), crate_argv),
        # ★ **按 nature 推 `ownerSynth`**（xcpc 树是骨架、**重在绑定**；不推谁绑定谁，
        #   只推使用的 ownerSynth；不用不稳定的方案）——
        #   只给"签名（分支|赛季|地点，地点读 `natureRegion`）唯一对应一个已有组"的场次补指针，
        #   其余（骨架里没有 / 同签名多个组 / 地点不是真地点）**一个字不写**，留给人定。
        # ⚠️ 必须在 `rehome` **之前**：那一步会把整表按同层规则重排（本步只改指针、不重排）。
        Step('synthbind', '按 nature 推合成归属（synth-bind）',
             os.path.join('scripts', 'synth-bind.mjs'), ('node', PACKAGE_REL), kind='cmd'),
        # ★ 题目绑定（P 随 C）—— 等比赛的绑定做好后，再辅助其下题目的绑定：
        #   **P 随 C** —— 以比赛组为单位，把组内各来源的 P **按题号**绑成一组；P 合成节点
        #   **挂在那一个 C 合成节点下**（`父synthKey`）。键是纯函数（`synth:problem:<场次标识>-<题号>`）。
        #   ⚠️ 必须排在 `synthbind` **之后**（它要读刚定下来的 C 分组）。
        #   ⚠️ 异常（题号对不上 / 题名冲突 / 全组无题名）**只报不自动处理**，人在应用里改 `ownerSynth`。
        Step('problembind', '题目绑定（problem-bind：P 随 C）',
             os.path.join('scripts', 'problem-bind.mjs'), ('node', PACKAGE_REL), kind='cmd'),
        # ★ **回代 baseline 要补一遍**（放在"建组 / 改名"之后）。
        #   为什么：`xcpc_pipeline` 那一步末尾已经回代过一次，可**合成节点是这两步才建出来 /
        #   改名的**（`synth-bind` 铺组头、`problem-bind` 铺 P 层组头）⇒ 钉在"那时的键 / 那个
        #   还不存在的头"上的人工值**没落上**（实测：`synth:xcpc:2023ic_provincial-山东` 的手填
        #   年份至今是 `待同步`）。这一步把它们补上。
        #   ⚠️ `--no-report`：**核对报告说的是"回代那一刻"**（哪些 identity 当时不在包里、
        #      哪些值压住了脚本），那是有意义的快照；补这一遍只为写值，别再冲掉它。
        #   ⚠️ 它**修不了**"键被改名"那一类（baseline 里记的还是旧键）—— 那要靠应用侧
        #      「🧷 人绑的键过时了 → 改到该键」+ 重新导出（见 ⑤ 冲突那一栏）。
        Step('baseline2', '回代 baseline（补：组头刚建/改名之后）',
             os.path.join('scripts', 'nature-baseline.py'),
             ('apply', '--no-report', PACKAGE_REL)),
        # ★ **按 nature 把"渠道没给分类"的节点搬到位**（仅针对各渠道分类本就不充分的节点，
        #   若有足够的 nature，直接改变其在树中的路径）。
        # ⚠️ 为什么必须**排在产包之后**：那些场次的 nature 是**人在应用里手填的**，
        #    靠产包末尾那步「回代 baseline」才回到包里 —— 在适配器里跑的时候它还是 `qoj/无归类`。
        # ⚠️ 也必须排在 `crate-check` **之前**（试跑要看着搬完的包判"这份包能不能导入"）。
        Step('rehome', '按 nature 落位（nature-rehome）',
             os.path.join('scripts', 'nature-rehome.mjs'), ('node', PACKAGE_REL), kind='cmd'),
        # **CLIST 难度**（「数值难度」字段组的第三员）。
        # 放在「产包」之后、「试跑」之前：它是**给包里已有的 P 补一格**（与 baseline 同形），
        # 所以要在包已经产出来、并且还没被校验之前跑。
        # ⚠️ 离线档**不跑**（它必须联网；离线时那一步会因为没有凭据/网络而跳过，但没必要走一遍）。
        # ⚠️ 没有凭据 / 网络不通 ⇒ 脚本自己**友好跳过**（exit 0），不当失败。
        Step('clist', 'CLIST 难度（clist-difficulty）',
             os.path.join('scripts', 'clist-difficulty.py'), ('sync',),
             skip_offline=True),
        Step('check', '离线试跑（crate-check）',
             # ⚠️ 末尾这个包路径**不能漏**（实测漏了：crate-check 收到空参数、
             #   打印用法并以 2 退出，于是"包明明产出来了却判整条链失败、不自动导入"）。
             os.path.join('scripts', 'crate-check.mjs'), ('node', PACKAGE_REL), kind='cmd'),
        # ⚠️ **报告放在最后**：`crate-check` 一跑就是几千条警告，体检/需求排在它前面会被刷没
        #    （其他警告太多了 ⇒ "链尾不能算链尾"）。
        #    顺序：先试跑（它是"这份包能不能导入"的判据），再出体检与原料需求（结论）。
        # ⚠️ 它的退出码 1 = "**有真缺**"（`field-coverage.py` 末行 `return 1 if bad else 0`）——
        #    那是**报告**，不是故障。2026-10-17 实测：只差 1 个题名 + 1 个题号，整条链就判失败
        #    ⇒ 应用那个「🛠 重建总包并导入」**永远不自动导入**（包其实已经产出来了）。
        #    所以只放行 `1`：❌ 那几行照旧打给用户看，但不挡后面的 `needs`/`embed`。
        #    别的非零（脚本崩了、包读不了）**照旧致命** —— 别把 `warn_codes` 放宽成"这一步随便失败"。
        Step('coverage', '字段体检（field-coverage）',
             os.path.join('scripts', 'field-coverage.py'), ('--quiet',), warn_codes=(1,)),
        Step('needs', '原料需求（material-needs）',
             os.path.join('scripts', 'material-needs.py'), needs_argv),
        # **报告随包发布** —— 应用里加一页「🩺 体检 / 需求」。
        # ⚠️ 必须**排在最后两步之后**：报告读的就是刚写出来的这个包，写包那一步（crate-merge）
        #    跑在它们之前 —— 那时报告文件还是**上一版**的。所以只能"先出报告、再塞回包顶层"。
        #    这一步只加一节 `reports`，`records` 一个字不动（它自己也核对条数）。
        Step('embed', '报告随包（embed-reports）',
             os.path.join('scripts', 'embed-reports.py'), ('--quiet',)),
    )


def needs_step_for(plan: dict, offline: bool,
                   on_line: Optional[Callable[[str], None]] = None) -> str:
    """
    **按需求补抓那一段**（唯一一份）：探数据 → 丢旧原料 → 返回"只重跑哪个来源"。

    @param plan    - `mode_plan()` 的结果（看 `needs` / `pursue` / `probe_all`）
    @param offline - 离线档 ⇒ **不补抓**（补抓必须联网：探数据要请求官网、丢掉缓存后重建要重新抓）。
                     ⚠️ 这一步放在"删缓存"**之前**，否则离线重建会因为缺原料当场失败。
    @returns 空串 = 全量重建（没需求 / 没补抓 / 离线档拒绝补抓）
    """
    if not plan.get('needs'):
        return ''
    if offline:
        _emit(on_line, '⚠️ 离线档**不补抓原料**（补抓要先联网：探数据 + 重抓那份原料）'
                       '⇒ 这一轮按标准重建走；要补抓就取消「离线」/ 去掉 `--offline`')
        return ''
    got = needs_plan(plan['pursue'], plan['probe_all'], on_line=on_line)
    if got is None:
        _emit(on_line, '⚠️ 拿不到原料需求清单 ⇒ 这一轮按**标准重建**走（照旧出包）')
        return ''
    if not got['needs']:
        _emit(on_line, '✅ 原料需求清单是空的 —— 没有要补抓的原料（照旧全量重建）')
        return ''
    return apply_needs_plan(got, on_line=on_line)


class LineWriter(io.TextIOBase):
    """
    把子步骤的 `print` 变成**一行一行**的回调（页面要边跑边看）。

    ⚠️ 只认 `\\n`：没有换行的那半行先留在缓冲里，等后面的 `write` 或 `flush`
    补齐 —— 否则日志会出现"半行"并把后面的行首吃掉。
    """

    def __init__(self, emit: Callable[[str], None]):
        self._emit = emit
        self._buf = ''

    # `print` 走的就是 write
    def write(self, text) -> int:
        text = text if isinstance(text, str) else str(text)
        self._buf += text
        while '\n' in self._buf:
            line, self._buf = self._buf.split('\n', 1)
            self._emit(line.rstrip('\r'))
        return len(text)

    def flush(self) -> None:
        if self._buf:
            self._emit(self._buf)
            self._buf = ''

    # 少数库直接写 `sys.stdout.buffer`
    @property
    def buffer(self):
        return _ByteSink(self)

    @property
    def encoding(self):
        return 'utf-8'

    def isatty(self) -> bool:
        return False

    def writable(self) -> bool:
        return True


class _ByteSink:
    """`sys.stdout.buffer` 的最小替身（解码后交给同一个行回调）"""

    def __init__(self, writer: LineWriter):
        self._writer = writer

    def write(self, data) -> int:
        self._writer.write(bytes(data).decode('utf-8', 'replace'))
        return len(data)

    def flush(self) -> None:
        self._writer.flush()


def run_step(step: Step, on_line: Optional[Callable[[str], None]] = None) -> StepResult:
    """
    跑一步。

    - `kind='py'`  ⇒ **本进程内**执行（`runpy`，全新命名空间）；
    - `kind='cmd'` ⇒ 起一个外部命令（只有 node 校验这一步；命令写死，无页面传参）。

    @param on_line - 逐行回调（`None` ⇒ 直接继承当前 stdout，命令行用）
    """
    if step.kind == 'cmd':
        return _run_cmd_step(step, on_line)
    path = os.path.join(REPO, step.script)
    started = time.time()
    argv_backup = list(sys.argv)
    sys.argv = [path] + list(step.argv)
    code = 0
    try:
        if on_line is None:
            runpy.run_path(path, run_name='__main__')
        else:
            with contextlib.redirect_stdout(LineWriter(on_line)), \
                    contextlib.redirect_stderr(LineWriter(on_line)):
                runpy.run_path(path, run_name='__main__')
    except SystemExit as exit_err:                                    # 脚本自己 sys.exit(...)
        raw = exit_err.code
        if raw is None or raw == 0:
            code = 0
        elif isinstance(raw, int):
            code = raw
        else:
            if on_line is not None:
                on_line(str(raw))
            code = 1
    except BaseException:                                            # noqa: BLE001 —— 报给页面看
        if on_line is not None:
            for line in traceback.format_exc().splitlines():
                on_line('❌ ' + line)
        else:
            traceback.print_exc()
        code = 1
    finally:
        sys.argv = argv_backup
    return StepResult(step.key, step.title, code, round(time.time() - started, 1))


def _emit(on_line, text):
    """日志：给了回调就回调，没给就直接打终端"""
    if on_line is None:
        print(text, flush=True)
    else:
        on_line(text)


def _needs_met(patterns) -> bool:
    """`Step.needs` 里那些 glob 有没有**任一**命中（相对 `REPO`）"""
    for pat in patterns:
        if globmod.glob(os.path.join(REPO, pat), recursive=True):
            return True
    return False


def _run_cmd_step(step: Step, on_line: Optional[Callable[[str], None]]) -> StepResult:
    """外部命令那一步（`step.argv` 的第一项是解释器/程序名，其余是参数）"""
    started = time.time()
    prog = step.argv[0]
    if not shutil.which(prog):
        _emit(on_line, '⚠️ 没找到 %s —— 跳过这一步（不影响包本身；它只是离线试跑）' % prog)
        return StepResult(step.key, step.title, 0, 0.0, skipped=True)
    cmd = [prog, step.script] + list(step.argv[1:])
    _emit(on_line, '$ ' + ' '.join([cmd[0], os.path.relpath(cmd[1], REPO)] + cmd[2:]))
    code = 0
    try:
        proc = subprocess.Popen(                                             # noqa: S603 —— 固定命令
            cmd, cwd=REPO, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            # ★ 子进程的**输出编码**（2026-10-18 加）：stdout 是管道时，Python 按
            #   `locale.getpreferredencoding()` 编码 —— 也就是**系统 ANSI 代码页**。
            #   UTF-8 Beta 一关，它就从 65001 变回 936(GBK)，而 GBK 里没有 ✅❌⚠️✔✘ℹ↳⟨⟩
            #   ⇒ 子进程**打印第一行符号**时就 UnicodeEncodeError（实测这些步骤全崩）。
            #   这一行让"管道里的编码"与系统设置脱钩（与 `xcpc_pipeline.run()` 同一条）。
            env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
        assert proc.stdout is not None
        for line in proc.stdout:
            _emit(on_line, line.rstrip('\n').rstrip('\r'))
        code = proc.wait()
    except OSError as err:
        _emit(on_line, '❌ 起不来：%s: %s' % (type(err).__name__, err))
        code = 1
    return StepResult(step.key, step.title, code, round(time.time() - started, 1))


def run_chain(steps=None, on_line: Optional[Callable[[str], None]] = None,
              on_phase: Optional[Callable[[Step], None]] = None,
              offline: bool = False,
              should_stop: Optional[Callable[[], bool]] = None) -> list:
    """
    按顺序跑完整条链，**一步失败就停**（后面的步骤依赖前面的产物，硬跑只会把包写坏）。

    @param on_line  - 逐行日志回调
    @param on_phase - 每步开始前回调（界面用它标"现在跑哪一步"）
    @param should_stop - 暂停：页面按一下 ⇒ 置标志，链子跑完当前步就停。
         **只在「步骤边界」检查**（返回 True ⇒ 不再开下一步）—— **绝不在写文件的中途掐断**：
         产包 / 合并 / 回代那几秒里冻住进程会留下**半个包**，而"跑完当前步就停"没有这个险。
         链子**幂等**，停完随时可以重跑（重跑也不会重复写坏）。
         ⚠️ 返回值里会多一条 `key == STOPPED_KEY` 的 `StepResult` —— **调用方要认它**，
         不能把它当成"跑完了"（否则会打「✅ 全部完成」骗人）。
    @returns `[StepResult, ...]`（只含真正跑过的步骤；被暂停时末尾多一条 `STOPPED_KEY`）
    """
    steps = tuple(steps) if steps is not None else steps_for(offline)
    results = []
    cwd_backup = os.getcwd()
    try:
        # 步骤脚本里那些相对路径都按**本文件那一层**（`REPO`；2026-10-17 搬家后 = `app/`）解析 ⇒ 先切过去。
        # ⚠️ 别把 `npm run` 的 cwd 也当成这一层：它是**仓库根**（`package.json` 在那儿），两者不同。
        os.chdir(REPO)
        for step in steps:
            if should_stop is not None and should_stop():
                done = results[-1].title if results else '（还没跑任何一步）'
                _emit(on_line, '⏸ 已暂停：后面的步骤没跑。产物停在「%s」之后 —— 链子幂等，'
                                '随时可以重跑（也可以直接导入这一步已经产出来的包）。' % done)
                results.append(StepResult(STOPPED_KEY, '（用户暂停）', 0, 0.0))
                break
            if on_phase is not None:
                on_phase(step)
            if step.needs and not _needs_met(step.needs):
                # "没有原料 ⇒ 无事可做"：报一句、记一条 skipped，**不算失败**（见 `Step.needs`）
                _emit(on_line, '⏭️ 跳过「%s」：这台机器上找不到它的原料（%s）'
                               % (step.title, '、'.join(step.needs)))
                results.append(StepResult(step.key, step.title, 0, 0.0, skipped=True))
                continue
            result = run_step(step, on_line)
            if result.code != 0 and result.code in (step.warn_codes or ()):
                # "只提示"型退出码（见 `Step.warn_codes`）：如实说一句，然后**当成成功继续**
                # （后面的 `needs`/`embed` 照跑、包照出、应用那边照自动导入）。
                _emit(on_line, '⚠️ %s：退出码 %d 按"只提示"处理 —— **包照旧产出**，'
                               '缺口就是上面那几行 ❌，后面的步骤继续跑' % (step.title, result.code))
                result = result._replace(code=0)
            results.append(result)
            if result.code != 0:
                break
        # 成功收尾时把"带 .stale 标记的产物"念出来（那一类的数据来自上一次运行）
        if results and all(r.code == 0 for r in results) and not any(r.key == STOPPED_KEY for r in results):
            note = stale_note_line()
            if note:
                # ⚠️ 用 `_emit`（`on_line` 为 None 时打终端）—— 写成 `if on_line is not None` 的话，
                #    **命令行那条路（`npm run crate:all` / `build-all.py`）就永远看不到它**，
                #    只有应用按钮（`build_runner.py` 会传 on_line）看得到。
                _emit(on_line, note)
            # 链**依赖、但一步都不产**的人工表：只报"多旧 / 多少条 / 怎么刷新"。
            # 为什么在这儿：这与"链管什么"是同一个概念，家就在这张步骤表旁边（见 EXTERNAL_TABLES）。
            _emit(on_line, '📋 链依赖的人工表（链里没有一步会更新它们）：')
            for line in input_table_notes():
                _emit(on_line, line)
    finally:
        os.chdir(cwd_backup)
    return results


#: 链**依赖、但链里没有任何一步会生成或校验**的人工表（2026-10-17 补）。
#:
#: 为什么单列：这四张表决定"包里该有哪些场次 / 哪些 gym"（**范围**），而链只做"增量补缺 + 活数据"
#: ⇒ 它们旧了**不会有任何提示**。实测（2026-10-17 23:42 那次建包）：四张表是 02:19~03:35 的、
#: 链 12 步全绿、日志一个字没提，而 `cache/` 里最新原料是 00:08 —— **新原料配旧范围，看不出来**。
#:
#: ⚠️ 这里只报**年龄 + 条数 + 刷新命令**，**不判"过期"**：没有判据（白名单该不该变只有去问 CF
#:    才知道；`rankland_index` 漏没漏场要拿 xcpcio 的场次集合去比）。硬编一个 TTL 就是拿猜当判据。
#: ⚠️ 与 `xcpc_pipeline.side_tree_notes()` **不是同一件事**：那边判"我合进包的**产物**新不新"
#:    （比 mtime，有判据）；这边只是"链的**输入**有多旧"（没有判据，只报数）。
#:    加一个新依赖 = 加一行；加一种检查方式 = 加一个分支。
EXTERNAL_TABLES = (
    ('CF gym 白名单', 'acm-data/raw/Scaper/05 xcpc/gym_whitelist.json', '个 gym',
     lambda d: sum(1 for g in (d.get('gyms') or []) if g.get('include')),
     'python fetch_my_gyms.py'),
    ('rankland 跨平台索引', 'acm-data/raw/Scaper/05 xcpc/cache/rankland_index.json', '场',
     lambda d: len(d.get('bySlug') or {}),
     'python build_rankland_index.py'),
    ('xcpcio 目录树', 'acm-data/raw/Scaper/05 xcpc/cache/xcpcio_tree.json', '场',
     lambda d: len(d.get('contests') or []),
     'python build_xcpcio_index.py'),
    ('CF gym 元信息', 'acm-data/raw/Scaper/05 xcpc/cache/cf_gym_meta.json', '个 gym',
     lambda d: int(d.get('count') or len(d.get('gyms') or {})),
     'python gen_gym_manifest.py'),
)


def _age_text(seconds: float) -> str:
    """年龄说人话（`刚更新` / `N 小时前` / `N 天前`）"""
    if seconds < 3600:
        return '刚更新'
    if seconds < 48 * 3600:
        return '%d 小时前' % int(seconds // 3600)
    return '%d 天前' % int(seconds // 86400)


def input_table_notes(root: str = '') -> list:
    """
    链依赖的那几张人工表：**多旧 / 多少条 / 怎么刷新**（读不到就说"不在"，不抛）。

    @param root 换一个根（自测用；默认仓库根）
    @returns 每张表一行；链尾由 `run_chain` 念出来（与 `stale_note_line()` 同一个出口）。
    """
    base = root or REPO
    out: list = []
    for label, rel_path, unit, count_of, refresh in EXTERNAL_TABLES:
        path = os.path.join(base, rel_path)
        if not os.path.isfile(path):
            out.append('   ⚠️ %s 不在（%s）—— 先跑 `%s`' % (label, rel_path, refresh))
            continue
        try:
            with open(path, encoding='utf-8') as f:
                n = '%d %s' % (count_of(json.load(f)), unit)
        except Exception:                                   # noqa: BLE001
            n = '条数读不出'
        try:
            age = _age_text(time.time() - os.path.getmtime(path))
        except OSError:
            continue
        out.append('   · %s：%s ｜ %s ｜ 刷新：%s' % (label, n, age, refresh))
    return out


def stale_note_line(nodes_dir: str = '') -> str:
    """
    那句"这些产物本轮没有重新生成"的文案（没有过期的 ⇒ 空串）。

    单独一个函数是为了**能被测**：链条里那句"念出来"也要有自己的守卫
    （只测 `stale_products()` 本身是不够的）。
    """
    stale = stale_products(nodes_dir)
    if not stale:
        return ''
    return ('⚠️ 这些产物本轮**没有重新生成**（盘上那份是上一次的，可能过期）：'
            + '、'.join(stale) + '　← 见各产物同目录的 `*.json.stale` 标记')


# ================================================================
# 自测（`python -B scripts/build_chain.py`）—— 钉住三件容易悄悄错的事：
#   ① 日志按行切分（没有它，页面上的日志会出现"半行 + 吃掉下一行行首"）；
#   ② `runpy` 那层壳不会把子步骤的 `sys.exit` / 异常变成"服务器也跟着死"；
#   ③ 步骤表与 `crate:all` 那条 `&&` 一致（顺序、参数、关键脚本）。
# ================================================================
def _selftest() -> int:
    _st = Selftest('处理链')
    ok = _st.ok

    # ① 行切分
    got = []
    writer = LineWriter(got.append)
    writer.write('a\nb')
    writer.write('c\n')
    writer.flush()
    ok(got == ['a', 'bc'] or got == ['a', 'b', 'c'], '逐行回调（半行要等补齐）实际=%r' % (got,))
    got2 = []
    w2 = LineWriter(got2.append)
    w2.write('x\n\n y \r\n')
    ok(got2 == ['x', '', ' y '], '空行 / \\r 处理（只吃 \\r，不吃空格）实际=%r' % (got2,))
    got3 = []
    w3 = LineWriter(got3.append)
    w3.buffer.write('字节\n'.encode('utf-8'))
    ok(got3 == ['字节'], 'sys.stdout.buffer 也能接 实际=%r' % (got3,))

    # ①b `.stale` 标记要**有人读**（`xcpc_pipeline` 写、必须有人读）
    #   ⚠️ 探针写在**子目录**里，不碰真产物目录：并排跑真链时，真产物目录里的探针会被
    #     当成"过期产物"念出来（假警告），中断还会残留。
    scratch = os.path.join(NODES_DIR, '_selftest_stale')
    probe = os.path.join(scratch, '__probe.json.stale')
    try:
        os.makedirs(scratch, exist_ok=True)
        with open(probe, 'w', encoding='utf-8', newline='\n') as f:
            f.write('inventory\n')
        ok('__probe.json' in stale_products(scratch), '带 .stale 的产物要被认出来')
        ok(stale_products(os.path.join(scratch, '不存在的目录')) == [], '目录不在 ⇒ 空表（不抛）')
        # "念出来"那句本身也要有守卫（只测函数不够，链条里那半也要测）
        ok('__probe.json' in stale_note_line(scratch), '那句"没重新生成"要真的把名字念出来')
        ok(stale_note_line(scratch).startswith('⚠️'), '而且要是显眼的 ⚠️ 行')
    finally:
        if os.path.isfile(probe):
            os.remove(probe)
        if os.path.isdir(scratch):
            os.rmdir(scratch)
    ok('__probe.json' not in stale_products(scratch), '探针用完就清（别留在产物目录里）')

    # ①c 链依赖的人工表：每张一行、都带"下一步怎么做"；根不对 ⇒ 每张都报"不在"（**都不许抛**）
    # ⚠️ 2026-10-19 修：原来只认 `刷新：` 这一种写法 —— 而**表不在**时那行写的是
    #    `⚠️ … 不在（路径）—— 先跑 \`xxx\``（同样给出下一步，只是措辞不同）。公开发布副本里
    #    `cache/` 按档位 3 清空了 ⇒ 这几张表本来就不在 ⇒ 旧断言**假红**（实测 4 行全是"不在"）。
    #    判据改成"两种写法有任一种"，两样都没有才红（守卫不空转）。
    rows = input_table_notes()
    ok(len(rows) == len(EXTERNAL_TABLES), '每张人工表一行，实际=%r' % (len(rows),))
    ok(all(('刷新：' in r) or ('先跑' in r) for r in rows),
       '每行都要给出"怎么刷新/先跑什么"，实际=%r' % (rows,))
    missing = input_table_notes(os.path.join(NODES_DIR, '_不存在的人工表根'))
    ok(len(missing) == len(EXTERNAL_TABLES) and all('不在' in r for r in missing),
       '根不对 ⇒ 每张报"不在"、不抛，实际=%r' % (missing,))

    # ①d 管道里的编码要跟系统 ANSI 代码页**脱钩**（2026-10-18 加，踩点：UTF-8 Beta 关掉后的实测）
    #   症状：把 PYTHONIOENCODING 弄成 gbk（等价于 ACP=936 时管道子进程的默认编码）⇒
    #         `print('✅')` 当场 UnicodeEncodeError ⇒ 那些 python 步骤整步失败。
    #   判据：**故意**把父进程的 PYTHONIOENCODING 污染成 gbk，再让 `_run_cmd_step` 跑一句打 ✅ 的命令，
    #        必须仍然 exit 0（`_run_cmd_step` 自己会把孩子的编码覆盖成 utf-8）。
    #        ⚠️ 这条不能只看源码字符串 —— 去掉 `env=` 之后那句源码还在，得**真跑**才红。
    _saved_io = os.environ.get('PYTHONIOENCODING')
    try:
        os.environ['PYTHONIOENCODING'] = 'gbk'
        probe_step = Step('probe-encoding', '编码探针', sys.executable, ('-c', 'print("\\u2705 ok")'), 'cmd')
        got = _run_cmd_step(probe_step, lambda _line: None)
        ok(got.code == 0, '★ 管道子进程的编码不跟系统代码页走（父环境被污染成 gbk 也要 exit 0），实际 code=%r'
           % (got.code,))
    finally:
        if _saved_io is None:
            os.environ.pop('PYTHONIOENCODING', None)
        else:
            os.environ['PYTHONIOENCODING'] = _saved_io

    # ② 步骤表：与 `crate:all` 对齐
    steps = steps_for()
    expected = ['registry', 'qoj-submits', 'hdu', 'nk', 'crate', 'synthbind', 'problembind', 'baseline2',
                'rehome', 'clist', 'check', 'coverage', 'needs', 'embed']
    ok([s.key for s in steps] == expected,
       '步骤顺序（QOJ 抓取在产包之前；按 nature 落位排在产包之后、clist 之前；'
       'clist 在试跑之前 —— 它是给包里已有的 P 补一格）')
    ok(steps[0].script.endswith(os.path.join('05 xcpc', 'xcpc_registry.py'))
       and steps[0].argv == ('build',), '第一步是注册表 build')
    # ★ **QOJ 提交（活数据）挂上链了**（用户 2026-10-15）—— 它必须排在**产包之前**
    #   （产包那步的 QOJ 适配器读的就是它刚写下的 `qoj_submissions.json`）；
    #   范围是花名册（`--fetch` 不给选择器 ⇒ 脚本自己读 `me.json`）。
    qoj_step = [s for s in steps if s.key == 'qoj-submits'][0]
    ok(qoj_step.kind == 'py'
       and qoj_step.script.endswith(os.path.join('04 qoj', 'QOJ_submissions_scraper.py'))
       and qoj_step.argv == ('--fetch',),
       '★ QOJ 提交那一步：跑 `--fetch`（范围 = me.json 花名册），本进程内跑')
    ok(expected.index('qoj-submits') < expected.index('crate'),
       '★ 它必须排在**产包之前**（产包那步的 QOJ 适配器要读刚抓下来的那份 JSON）')
    ok('qoj-submits' not in [s.key for s in steps_for(only_source='cf-contest')],
       '★ `--only-source cf-contest` 时**不去动** QOJ（那一路的口径是"只重跑这一个来源"）')
    ok('qoj-submits' in [s.key for s in steps_for(only_source='qoj')],
       '★ `--only-source qoj` 时要带上它（这正是"只刷新 QOJ"那条路）')
    ok('qoj-submits' not in [s.key for s in steps_for(True)],
       '★ 离线档**不列**它（`--fetch` 必然联网，而离线是"一次也不联网"）')
    # ⚠️ **建组只有一处**：`nature_rules.py build` 那一步已摘掉（它是第二个建组器；它独有的
    #    三样——顶层 W、icpc 中间层容器、指针来源痕——已补进 `synth-bind`，
    #    理由与实测清单见 `steps_for()` 那段注释）—— 这条守着"不许再并存两个建组器"。
    ok('nature' not in [s.key for s in steps],
       '建组那一步只有 `synthbind`（`nature_rules` 那条已停用，别再挂回来）')
    ok(steps[4].argv == ('--all-nodes',),
       '产包那一步**默认不带 `--force`**（只有「全删重爬」那一档才整份重抓，见下面那条守卫）')
    # ★ 按 nature 推合成归属（"synthbind"）＋ 按 nature 落位（"rehome"）
    #   —— 两步都紧跟在产包之后、`clist` 之前，且都**带上包路径**（与 crate-check 同一种传法）
    synth_step = [s for s in steps if s.key == 'synthbind'][0]
    ok(synth_step.kind == 'cmd' and synth_step.argv == ('node', PACKAGE_REL),
       '按 nature 推合成归属那一步：带包路径')
    # ★ 题目绑定（P 随 C）**紧跟**在推合成归属之后（它要读刚定下来的 C 分组）
    pb_step = [s for s in steps if s.key == 'problembind'][0]
    ok(steps[5].key == 'synthbind' and steps[6].key == 'problembind'
       and pb_step.kind == 'cmd' and pb_step.argv == ('node', PACKAGE_REL),
       '题目绑定那一步：紧跟"推合成归属"、且**带上包路径**')
    # ★ **补一遍回代**：紧跟"建组 / 改名"那两步之后（组头是那两步才建出来的 ⇒ 人工值才落得上），
    #   且在 `rehome` 之前（那一步要用 nature 落位）。⚠️ 必须带 `--no-report`：核对报告是
    #   "回代那一刻"的快照，补这一遍不能再写它。
    b2_step = [s for s in steps if s.key == 'baseline2'][0]
    ok(steps[7].key == 'baseline2' and b2_step.kind == 'py'
       and b2_step.argv == ('apply', '--no-report', PACKAGE_REL),
       '补一遍回代那一步：在"题目绑定"之后、"按 nature 落位"之前，且带 `--no-report`')
    rehome_step = [s for s in steps if s.key == 'rehome'][0]
    ok(steps[8].key == 'rehome' and rehome_step.kind == 'cmd'
       and rehome_step.argv == ('node', PACKAGE_REL),
       '按 nature 落位那一步：紧跟"题目绑定"、且**带上包路径**（它负责重排，必须排在最后）')
    clist_step = [s for s in steps if s.key == 'clist'][0]
    ok(clist_step.skip_offline and clist_step.argv == ('sync',),
       'CLIST 难度那一步：离线档跳过（它必须联网）')
    ok([s.key for s in steps_for(True)] == [k for k in expected if k != 'qoj-submits'],
       '离线档只少 **QOJ 抓取**那一步（它必然联网；"一次也不联网"的档子连跑都不该跑）'
       '—— 其余与在线表逐字相同')
    ok('clist' in [s.key for s in steps_for(True)],
       '离线档仍然**列出** clist（它由 `skip_offline` 决定跑不跑，不是从表里消失 —— 与上面那条不同）')
    # ⚠️ 按 **key** 取、不按下标：离线表比在线表少一步（QOJ 抓取），下标会错位。
    ok([s for s in steps_for(True) if s.key == 'crate'][0].argv == ('--offline', '--all-nodes'),
       '离线档只换产包那一步的参数')
    check_step = [s for s in steps if s.key == 'check'][0]
    ok(check_step.kind == 'cmd' and check_step.argv == ('node', PACKAGE_REL),
       'node 离线试跑那一步**必须带上包路径**（漏了就等于没跑、还判失败）')
    ok([s.key for s in steps[-3:]] == ['coverage', 'needs', 'embed'],
       '链尾三步：体检 → 原料需求 → 报告随包（后两步都只读，最后一步把结论塞回包顶层）')
    # ★ **杭电 / 牛客两棵多校树在链上产**（2026-10-18，用户："把剩下的任务做完"）。
    #   它们此前是**链外**的（0 处引用）：忘了手动跑 ⇒ 包里静默少一整棵，只靠
    #   `xcpc_pipeline.side_tree_notes()` 事后喊"这棵比原料旧"。四条一起钉住：
    #   ① 两步都在表里、都在 `crate` **之前**（产包那步的 `--all-nodes` 读的就是它们）；
    #   ② 都是 `build`（**本地出包**）且**不是** `skip_offline` ⇒ 离线档也产（否则离线包缺两棵）；
    #   ③ 都带 `needs`（"这台机器有没有那批原料"）—— 没有就跳过，不会让别人克隆一份就跑不动链；
    #   ④ `_needs_met` 真的能判真假（正反各一条），跳过时 `run_chain` 记一条 skipped、不判失败。
    side_keys = [s.key for s in steps]
    ok(side_keys.index('hdu') < side_keys.index('crate')
       and side_keys.index('nk') < side_keys.index('crate'),
       '★ 杭电/牛客两棵树必须排在**产包之前**（产包那步 `--all-nodes` 读的就是它们）')
    for k, script in (('hdu', os.path.join('02 hdu', 'hdu_multi_fetch.py')),
                      ('nk', os.path.join('05 xcpc', 'nk_multi_fetch.py'))):
        st = [s for s in steps if s.key == k][0]
        ok(st.script.endswith(script) and st.argv == ('build',) and st.kind == 'py',
           '「%s」那一步跑的是 `build`（本地出包、不联网），实际 %r' % (st.title, st.argv))
        ok(not st.skip_offline and st.needs,
           '「%s」：离线档**也要跑**（它不联网），且带 `needs`（没原料就跳过）' % st.title)
    ok(all(s.key in side_keys for s in steps_for(True) if s.key in ('hdu', 'nk')),
       '★ 离线档的步骤表里仍然有这两步（离线重建出来的包不许缺这两棵）')
    ok(_needs_met(('acm-data/raw/Scaper/02 hdu/**/hdu_cid*_problems.json',)),
       '`_needs_met`：真存在的原料要判"有"（杭电那批 json 就在盘上）')
    ok(not _needs_met(('acm-data/raw/Scaper/__根本没有这个目录__/**/*.json',)),
       '`_needs_met`：一个都匹配不上要判"没有"（正反两条一起才说明它真的在看盘）')
    skipped = run_chain(steps=(Step('x', '假步骤', os.path.join('scripts', 'nope.py'), (),
                                    needs=('acm-data/raw/Scaper/__没有__/*.json',)),),
                        on_line=lambda _l: None)
    ok(len(skipped) == 1 and skipped[0].skipped and skipped[0].code == 0,
       '没有原料 ⇒ 那一步**跳过**（记 skipped、不算失败），后面的步骤照跑')
    # ★ 字段体检的"有真缺"**只提示、不挡包**（2026-10-17 实测：只差 1 个题名 + 1 个题号就整轮判失败
    #   ⇒ 应用那个「🛠 重建总包并导入」永远不自动导入）。这条同时钉住"只放行 1"和"只有它享受这个待遇"。
    cov_warn = [s for s in steps if s.key == 'coverage'][0].warn_codes
    ok(cov_warn == (1,), '`coverage` 的只提示退出码是 `(1,)`（1 = 有真缺 = 报告），实际 %r' % (cov_warn,))
    ok(all(s.warn_codes == () for s in steps if s.key != 'coverage'),
       '`warn_codes` 只许 `coverage` 用 —— 别的步骤非零就得停（别顺手放宽）')
    # 重爬优先级门槛（`--pursue`）要能从建包脚本一路传到链尾那步 —— 传丢了就是"选项看着有、其实没用"
    # ★ 刷新原料**两档**（不能只抓缺的）—— 默认只补缺的/过期的，
    #   2026-10-17 改口径：**整份重抓那一支取消了** —— 它属于「全删重爬」那一档（先 prune 再 --force）。
    #   实测整份重抓 RankLand 索引要 17 分钟、还可能更差 ⇒ 别的档位一律只补缺的。
    _need = {'refetch': ['build_rankland_index.py'],
             'refetchForce': ['build_rankland_index.py', '--force']}
    # ★ **只有「全删重爬」会删、会整份重抓**（用户 2026-10-17 定的口径）。
    #   三条一起钉：① 别的档位 argv 里**不许**出现 `--force`；② 那个档位**最前面**是"去除无用原料"那一步；
    #   ③ `apply_needs_plan()` **一个字都不删**（源码级 —— 它会先删后抓，删除的授权只有 material.py 有）。
    ok(refetch_argv(_need) == ['build_rankland_index.py'],
       '刷新原料一律"只补缺的"（**不再有 `--force` 整份重抓那一支**）')
    ok(refetch_argv({'refetchForce': ['x.py', '--force']}) == [],
       '更不许从 `refetchForce` 那支偷偷把 --force 捡回来')
    ok(refetch_argv({}) == [], '没有 refetch 的需求 ⇒ 空')
    for m in BUILD_MODES:
        argv = [s for s in steps_for(prune=(m == 'purge'), pursue=mode_plan(m)['pursue'])
                if s.key == 'crate'][0].argv
        if m == 'purge':
            ok('--force' in argv and argv[-1] == '--all-nodes',
               '★ 「全删重爬」那一档的产包步必须是 `--force --all-nodes`（整份重抓）')
        else:
            ok('--force' not in argv,
               '★ 档位 %s **不许**整份重抓（只有「全删重爬」才 `--force`）—— 实际 %r' % (m, argv))
    purge_steps = steps_for(prune=True)
    ok(purge_steps[0].key == 'prune' and purge_steps[0].argv == ('--apply',),
       '★ 「全删重爬」**第一步**是"去除无用原料"（`prune-raw.py --apply`）')
    ok(all(s.key != 'prune' for s in steps_for(prune=False)),
       '别的档位**没有**那一步（也就不可能删任何东西）')
    with open(os.path.join(REPO, 'scripts', 'build_chain.py'), encoding='utf-8') as fh:
        _chain_src = fh.read()
    ok('os.remove(' not in _chain_src.split('def apply_needs_plan')[1].split('\ndef ')[0],
       '★ `apply_needs_plan()` 里**不许再删文件**（删除只发生在 prune-raw.py；这一条红了说明又开了后门）')

    needs_step = [s for s in steps if s.key == 'needs'][0]
    ok(needs_step.argv == (), '原料需求那步默认不带参数（用 material-needs 自己的默认档 normal）')
    ok([s for s in steps_for(pursue='low') if s.key == 'needs'][0].argv == ('--pursue', 'low'),
       '★ `--pursue low` 要落到链尾那步（门槛就靠这条通路）')

    # ★ **`--dry-run` 必须真的什么都不跑**（实测踩到，2026-10-15）：`build-all.py --dry-run`
    #   原来**只在 `--needs` 那一支被认**（`if args.dry_run:` 在那个分支里）⇒ 裸跑它会把
    #   **整条链真跑一遍**（真改了盘上的包），而它自己的 `--help` 写着"不动任何文件"。
    #   判据：跑一次 `build-all.py --dry-run` —— 要打那句"什么都没动"，且
    #   ① **包 + 整份 `acm-data/reports/`** 的 mtime / 大小一个字节都不许变
    #      （2026-10-16 扩到 reports：`--needs` 那一支会**重写** `material-needs.json`）；
    #   ② **源码级**钉住顺序：`--needs` 支里 `if args.dry_run:` 必须排在
    #      `plan_from_needs(` **之前**（后者默认跑 `material-needs.py --probe` = 联网探 + 重写清单）。
    #      ⚠️ ② 为什么走源码级而不是真跑 `--needs --dry-run`：真跑的话，**改回去的那版**会当场联网探
    #      一次 —— 守卫不该比它守的东西更贵（同 `test_xcpcio_mirrors_order` 的姿态）。
    def _snap(path):
        if os.path.isfile(path):
            return (os.path.getmtime(path), os.path.getsize(path))
        if not os.path.isdir(path):
            # ⚠️ 2026-10-19：**包不存在也是正常状态** —— `acm-data/nodes/` 是**生成物**
            #   （`clean-personal` 档位 1 会删它，用户 2026-10-19 定："既然是生成所需的，应在档位 1 就清除"）。
            #   这里原来直接 `os.listdir` ⇒ FileNotFoundError，把"没包"当成了自测失败。
            return None
        out = {}
        for name in sorted(os.listdir(path)):
            p = os.path.join(path, name)
            if os.path.isfile(p):
                out[name] = (os.path.getmtime(p), os.path.getsize(p))
        return out
    reports_dir = os.path.join(REPO, 'acm-data', 'reports')
    before = (_snap(os.path.join(REPO, PACKAGE_REL)), _snap(reports_dir))
    probe_run = subprocess.run(
        [sys.executable, '-B', os.path.join(REPO, 'scripts', 'build-all.py'), '--dry-run'],
        cwd=REPO, capture_output=True, text=True, encoding='utf-8', errors='replace')
    ok(probe_run.returncode == 0 and '（--dry-run' in probe_run.stdout,
       '`build-all.py --dry-run` 正常返回、且打了"什么都没动"（实际尾部 %r）'
       % (probe_run.stdout[-160:],))
    after = (_snap(os.path.join(REPO, PACKAGE_REL)), _snap(reports_dir))
    ok(before == after,
       '★ `--dry-run` **真的没动包与 reports/**（mtime/大小都不许变 —— 它曾经把整条链真跑一遍）')
    with open(os.path.join(REPO, 'scripts', 'build-all.py'), encoding='utf-8') as fh:
        _all_src = fh.read()
    i_dry = _all_src.find('if args.dry_run:')
    i_plan = _all_src.find('plan = plan_from_needs(')
    ok(0 <= i_dry < i_plan,
       '★ `--needs` 那一支：`--dry-run` 的判断在 `plan_from_needs()` **之前**'
       '（后者默认会跑 `material-needs.py --probe`：联网探 + 重写清单）')

    # ⑤ 「重建档位」（页面那个下拉框）：键与命令行开关的对应关系 + 认不出的回落
    #    ⚠️ 键名是**跨语言契约**（`src/features/AutoImport/buildApi.js` 的 BUILD_MODES 照抄这几个键）
    ok(list(BUILD_MODES) == ['standard', 'needs', 'needs-low', 'probe-all', 'purge'],
       '档位键与页面下拉框一一对应（实际 %r）' % (list(BUILD_MODES),))
    ok(mode_plan('')['key'] == 'standard' and mode_plan('不认识')['key'] == 'standard',
       '★ 认不出的档位一律回落默认档（绝不因为拼错就去删缓存）')
    ok(mode_plan('needs-low')['needs'] and mode_plan('needs-low')['pursue'] == 'low',
       '★ `needs-low` = 按需求补抓 + 追值门槛 low（那 179 格才进计划）')
    ok(not mode_plan('standard')['needs'] and mode_plan('standard')['pursue'] == 'normal',
       '★ `standard` = 不补抓（与默认行为一致）')
    ok(mode_plan('probe-all')['probe_all'] and mode_plan('probe-all')['needs'],
       '`probe-all` = 补抓 + 兜底全重爬（透传 `--probe-all`）')
    ok(all(BUILD_MODES[m]['pursue'] in ('high', 'normal', 'low') for m in BUILD_MODES),
       '每个档位的追值门槛都是 material-needs 认得的取值')
    # ⚠️ 离线档 + 补抓档 = 先删了原料、再离线重建 ⇒ 必炸。拦在**删缓存之前**（纯函数，不联网）
    said = []
    ok(needs_step_for({'needs': True, 'pursue': 'low', 'probe_all': False}, True, said.append) == ''
       and any('离线档**不补抓' in line for line in said),
       '★ 离线档 + 补抓档 ⇒ 拒绝补抓并说明（不然离线重建会因为缺原料当场失败）')
    ok(needs_step_for({'needs': False}, False) == '',
       '标准档：压根不走补抓那一段')

    # ③ runpy 壳：正常返回码 / sys.exit / 抛异常 / print 被逐行接住
    #    夹具写在仓库内的临时目录（沙箱不让写系统 temp；跑完必删）
    tmp = os.path.join(REPO, '.build-chain-selftest')
    try:
        os.makedirs(tmp, exist_ok=True)
        good = os.path.join(tmp, 'good.py')
        with open(good, 'w', encoding='utf-8') as fh:
            fh.write('print("一")\nprint("二")\n')
        rel = os.path.relpath(good, REPO)
        lines = []
        res = run_step(Step('t', 'T', rel, ()), lines.append)
        ok(res.code == 0 and lines == ['一', '二'], '正常步骤 + 逐行日志 实际=%r/%r' % (res.code, lines))

        for name, body, want in (
            ('exit1.py', 'import sys\nprint("错")\nsys.exit(3)\n', 3),
            ('exitos.py', 'import sys\nsys.exit(0)\n', 0),
            ('boom.py', 'raise ValueError("炸")\n', 1),
            ('exitmsg.py', 'import sys\nsys.exit("没数据")\n', 1),
        ):
            path = os.path.join(tmp, name)
            with open(path, 'w', encoding='utf-8') as fh:
                fh.write(body)
            out = []
            r = run_step(Step('t', 'T', os.path.relpath(path, REPO), ()), out.append)
            ok(r.code == want, '%s ⇒ 退出码 %s（期望 %s）' % (name, r.code, want))
            if name == 'boom.py':
                ok(any('ValueError' in line for line in out), '异常要写进日志（页面看得见）')
            if name == 'exitmsg.py':
                ok('没数据' in ' '.join(out), 'sys.exit("字符串") 也要显示出来')
    finally:
        import shutil as _shutil
        _shutil.rmtree(tmp, ignore_errors=True)
        ok(not os.path.exists(tmp), '临时夹具要清干净（不留 __pycache__ / 垃圾）')

    # ④ 外部命令那步：程序不在时**跳过**而不是失败
    skipped = run_step(Step('t', 'T', 'no-such.mjs', ('node-绝不存在',), kind='cmd'), lambda _l: None)
    ok(skipped.skipped and skipped.code == 0, '缺 node ⇒ 跳过且不算失败')

    # ④b 暂停（`should_stop`）——**只在步骤边界**停。
    #    真路径验：两个假步骤（`python -c pass`，不碰任何产物），跑完第 1 步后请求暂停
    #    ⇒ 第 2 步**压根不许开**，结果末尾多一条哨兵（退出码 0 = 不是失败）。
    #    ⚠️ 哨兵是跨文件契约（`build-all.py` / `build_runner.py` 都认它），漏了会把"被暂停"
    #       当成"跑完了"，然后打「✅ 全部完成」骗人。
    _fake = [Step('__t1', '假步骤一', '-c', (sys.executable, 'pass'), 'cmd'),
             Step('__t2', '假步骤二', '-c', (sys.executable, 'pass'), 'cmd')]
    _seen, _lines, _st_n = [], [], {'n': 0}

    def _phase(step):
        _seen.append(step.key)
        _st_n['n'] += 1

    _res = run_chain(steps=_fake, on_line=_lines.append, on_phase=_phase,
                     should_stop=lambda: _st_n['n'] >= 1)
    ok(_seen == ['__t1'], '暂停只在**步骤边界**生效：第 2 步压根没开（实际跑了 %r）' % (_seen,))
    ok(_res[-1].key == STOPPED_KEY and _res[-1].code == 0,
       '被暂停时末尾留一条哨兵、退出码 **0**（暂停不是失败）')
    ok(sum(1 for r in _res if r.key == STOPPED_KEY) == 1, '哨兵只有一条、且在末尾')
    ok(any('已暂停' in s for s in _lines), '暂停要写日志（不然界面看着像卡死）')
    # 反向：不请求暂停时**不许**出现哨兵（否则页面会把正常跑完显示成"被暂停"）
    _seen2, _st2 = [], {'n': 0}
    _res2 = run_chain(steps=_fake, on_line=lambda _s: None,
                      on_phase=lambda s: (_seen2.append(s.key), _st2.__setitem__('n', _st2['n'] + 1)))
    ok([r.key for r in _res2] == ['__t1', '__t2'] and _seen2 == ['__t1', '__t2'],
       '不暂停 ⇒ 两步都跑、一条哨兵都没有')
    # 中途失败也**不许**留下哨兵（那条是"用户暂停"专用的，混用会让失败看起来像暂停）
    _bad = [Step('__t1', '假步骤一', '-c', (sys.executable, 'pass'), 'cmd'),
            Step('__t2', '会炸的假步骤', '-c', (sys.executable, 'import sys; sys.exit(7)'), 'cmd'),
            Step('__t3', '假步骤三', '-c', (sys.executable, 'pass'), 'cmd')]
    _res3 = run_chain(steps=_bad, on_line=lambda _s: None)
    ok([r.key for r in _res3] == ['__t1', '__t2'] and _res3[-1].code == 7
       and not any(r.key == STOPPED_KEY for r in _res3),
       '一步失败 ⇒ 停在那里、**没有**哨兵（失败与暂停在结果里分得开）')

    return _st.done()


if __name__ == '__main__':
    sys.exit(_selftest())
