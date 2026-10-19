#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
XCPC 导入流水线（**入口**）—— 清单 + 各来源适配器 → 一个导入包

它做什么
--------
1. 读场次清单 `xcpc_contests.json`（每场的数据来自哪些来源，写在里面）；
2. 对每场，按来源调对应的适配器，各产出一个 **crate 片段**；
3. 用现成的 `scripts/crate-merge.mjs` **按类各出一包**，末尾再合并成
   `acm-data/nodes/mix_contain_xcpc.json`（按身份键去重 + 冲突体检；**排除**
   atcoder / cf-contest 两类）。**合成节点不在这里** —— 它们由链上后面的
   `synth-bind.mjs` 按 nature 建、直接写进最终包。

**它不猜任何东西**：哪个文件属于哪场比赛、哪份是权威榜单，全在清单里。
（XCPC 各场没有统一编号，两个来源之间的 ID 毫无关系 —— 这层对应关系
只能是人写下来的数据，不是算法能推出来的。）

各来源的角色
------------
    board        权威榜单：C 的名字/时间 + P 的 ratio 由它算     pta | srk | nk
    sources      补充来源（role: titles）：补题名/链接，不动 ratio  srk
    submissions  提交来源：只出 R                                  qoj | cf | pta

为什么 ratio 只由 board 算：**分子和分母必须同源**。实测 ICEC 第二场，
PTA 榜有 2494 支有效队伍，rankland 的 rows 只有 2622 行（2480 支），
逐格数出来每题少 1 —— 而 rankland 自己的 `statistics` 与 PTA 完全一致。

用法
----
    python xcpc_pipeline.py                      # 清单里所有场次
    python xcpc_pipeline.py icpc2026preliminary-2
    python xcpc_pipeline.py --dry-run            # 只说要跑什么，不执行
    python xcpc_pipeline.py --check              # 合并后顺手跑 crate:check

产出
----
    cache/crate_<slug>_<source>.json        各来源片段（中间产物，可随时删）
                                            ⚠️ 一个来源担两个角色时带角色后缀，
                                            如 `crate_<slug>_pta_submissions.json`
    acm-data/nodes/<类>.json                每类一包（qoj / cf-gym / pta / …）
    acm-data/nodes/mix_contain_xcpc.json    **混装包**（7 个来源包 + 合成节点包；
                                            排除 atcoder / cf-contest）—— 一次导入那份
    acm-data/nodes/all_nodes.json           **可选**（`--all-nodes`）：上面那个 + atcoder
                                            + cf-contest + 牛客多校 + 杭电多校
"""

from __future__ import annotations

import argparse
import json
import glob
import os
import re
import shutil
import subprocess
import sys
import time

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
# 通用区的 `Scaper/lib`（`progress` 在那里；各渠道的适配器也走同一个 sys.path 约定）
sys.path.insert(0, os.path.join(os.path.dirname(HERE), 'lib'))

import progress  # noqa: E402  —— 进度只有一种写法（`Scaper/lib/progress.py`）

# 「当场停」的退出码**只有一处**（`lib/batch.py`）：凭据过期/被拦、必需原料不在本地。
# 批处理子进程会把它原样转出来，这里据此把它当"这一轮没法继续"报（而不是"某一场失败"）。
from batch import HARD_STOP  # noqa: E402

from xcpc_common import (  # noqa: E402
    CACHE, NODES, REPO, find_contest, load_manifest, norm_letter, read_json, rel,
)

# 环节记账（`Scaper/lib/stages.py`）：各适配器进程退场时把自己那份并进一个文件，
# 链尾这里读合并结果念一遍（见 `main()` 末尾"环节记账"那一段）
import stages  # noqa: E402

DEFAULT_OUT = os.path.join(NODES, 'mix_contain_xcpc.json')
MERGE = os.path.join(REPO, 'scripts', 'crate-merge.mjs')


def _class_pieces_empty(pieces: list) -> bool:
    """
    这一类的片段是不是**都没数据**（`records` 缺失或空）？

    用途：区分"这类没事可做"（跳过）与"这类真的坏了"（终止链子）—— 见下面的注释。
    """
    for path in pieces or []:
        try:
            with open(path, 'r', encoding='utf-8-sig') as f:
                doc = json.load(f)
        except (OSError, ValueError):
            return False                        # 读不了/坏 JSON ⇒ 交给合并去报错，别当"空"
        recs = doc.get('records') if isinstance(doc, dict) else None
        if recs:
            return False
    return True

# 「**整棵树一个片段**」的来源：渠道 → (适配器, 片段路径)。
#
# 为什么 QOJ 是这样：它的场次集合 = "分类树 ∪ 我提交过的"（299 场），来自 `04 qoj` 的
# `qoj_category_tree.json` —— **与主树清单无关**（清单里只有 35 场有 QOJ 提交），
# 所以不能按"逐场跑适配器"那条路出。
#
# 什么时候重跑：全量重建、或 `--only-source <它>`；`--only <slug>` 时沿用它 cache 里那份。
TREE_SOURCES = {
    'qoj': ('qoj_adapter.py', os.path.join(CACHE, 'crate_qoj_tree.json')),
    # 补充任务1：CF 正式比赛（≠ gym）与 AtCoder —— 按「提交过哪些场」整棵树出
    'cf-contest': ('cf_contest_adapter.py', os.path.join(CACHE, 'crate_cf_contest_tree.json')),
    'atcoder': ('atcoder_adapter.py', os.path.join(CACHE, 'crate_atcoder_tree.json')),
}

# 来源 → 适配器脚本。**要接新来源，就在这里加一行**
ADAPTERS = {
    'pta': 'pta_adapter.py',
    # 牛客榜单**复用 pta_adapter**：它自己认形状（PTA 的 `xcpcRankings`
    # 与牛客的 `problems`，见它的 `analyze_nk`），所以没有单独的 nk 脚本。
    # 清单里写 `source: nk` 就会走它。
    'nk': 'pta_adapter.py',

    # QOJ 的**题单**（C + P 的链接），不是提交
    # ⚠️ `qoj-problems` 不接：它唯一的产物是"合并树 C 上的 QOJ 补题入口"，
    #    而那棵树拆了；QOJ 树自己的 C 本身就带这条链接（`qoj_adapter.py`）。
    'srk': 'srk_adapter.py',
    'qoj': 'qoj_adapter.py',
    'cf': 'cf_adapter.py',

    # rankland 索引：出 C+P 的题单与开赛时间（分 board / time 两个角色）
    'rankland-index': 'rankland_index_adapter.py',
    # rankland 引用：一次搬全部链接（不再分 board/problems 两个角色）
    'rankland-refs': 'rankland_refs_adapter.py',

    # xcpcio：board=出 C+P.ratio（默认）；index=只出赛名/时间/题号
    'xcpcio': 'xcpcio_adapter.py',
}

# 片段文件名里的来源 tag（`crate_<slug>_<tag>.json`）。
# 名字太长会把路径撑爆，所以这两个缩短；其余直接用来源名。
FILE_TAG = {'rankland-index': 'rlidx', 'rankland-refs': 'rlrefs'}

# 角色 → 适配器：**同一来源担多个角色**时用它（PTA 既出榜单又出本队提交、
# CF 既出榜单又出官网链接/题名）。查表顺序是 role 优先、退回 source。
ADAPTERS_BY_ROLE = {
    ('pta', 'submissions'): 'pta_submissions_adapter.py',

    ('cf', 'board'): 'cf_board_adapter.py',
    # CF 榜单里的 websiteUrl（官网链接）—— link 的备选值，只写 C 的 link
    ('cf', 'website'): 'cf_board_adapter.py',

    ('cf', 'titles'): 'cf_board_adapter.py',
}


#: 传给**每个子适配器**的环境变量（`--offline` 用；为什么不用命令行开关：
#: 600+ 个子进程里有些根本不认 `add_cli_args` 那套开关（如 `qoj_adapter.py`）⇒
#: 逐个拼命令行必然漏，所以用环境变量，子进程 import `read_modes` 时自动生效）。
#: 见 `Scaper/lib/read_modes.py` 的 `OFFLINE_ENV`。
READ_ENV: dict[str, str] = {}


def _reexec_with_hashseed():
    """
    固定哈希盐（PYTHONHASHSEED=0）—— 不固定就不可能有"逐字节可复现"的包。盐要在解释器启动前
    设好，所以换一个"固定盐的自己"重跑。

    @returns 子进程退出码（父进程原样转出）；不需重跑时 `None`。

    ⚠️ **别用 `os.execv`**（实测）：Windows 上它"起新进程 + 自己退出"，父进程以 **0**
    退出 ⇒ 失败码被吞掉（链子/命令行会把失败当成功）。用子进程 + 转出退出码。
    ⚠️ 命令用列表，别拼 shell 字符串（`05 xcpc` 带空格）。
    想要随机盐：设 `ACM_NO_HASHSEED=1`。
    """
    if os.environ.get('PYTHONHASHSEED') == '0' or os.environ.get('ACM_NO_HASHSEED') == '1':
        return None
    env = dict(os.environ, PYTHONHASHSEED='0')
    sys.stdout.flush()
    sys.stderr.flush()
    try:
        return subprocess.call([sys.executable, '-B', os.path.abspath(__file__)] + sys.argv[1:],
                               env=env)
    except OSError as err:
        print('⚠️ 固定哈希盐失败（%s）⇒ 这一次按随机盐继续' % err)
        return None


def run(cmd: list[str], dry: bool) -> int:
    print('   $ ' + ' '.join(f'"{c}"' if ' ' in c else c for c in cmd))
    if dry:
        return 0
    # ⚠️ **环境缺件换成人话 + 一条能直接粘贴的安装命令**：Windows 上 `subprocess.call(['node', …])`
    #    找不到 `node` 时抛的是 `FileNotFoundError: [WinError 2] 系统找不到指定的文件`
    #    （还带一整屏 Python 栈），看着像"哪个文件坏了/包坏了"，其实是**没装 Node.js 或它不在 PATH 里**
    #    （应用本身只要 Python，是这条产包链要用 `.mjs`）。实测踩到（2026-10-15，队友那台）：
    #    整条链跑了 60.7s，到"按类出包"的 `node crate-merge.mjs` 才炸出一屏栈，谁都不知道该装什么。
    #    `winget` 那行的形状与 `保存快照.bat:72`（装 git）**同一套写法**。
    if not shutil.which(cmd[0]):
        prog = os.path.basename(cmd[0]).lower()
        print(f'❌ 这一步要 `{cmd[0]}`，但 PATH 里找不到它 —— 这是**环境缺件**'
              f'（应用本身只要 Python，是这条产包链要用 `.mjs`），不是包坏了；'
              f'这一步**没动任何已有产物**。', file=sys.stderr)
        if prog in ('node', 'node.exe'):
            print('   PowerShell 一条装完：winget install --id OpenJS.NodeJS.LTS -e', file=sys.stderr)
            print('   （没有 winget 就去 https://nodejs.org/ 下 LTS 安装包）', file=sys.stderr)
        else:
            print(f'   按上面那个程序名自己装一个（`winget search {prog}` 可以找包名）', file=sys.stderr)
        print('   装完**关掉主脚本/终端重开**（PATH 才生效），再按一次「🛠 重建总包并导入」。',
              file=sys.stderr)
        return 1
    # ★ 固定哈希盐：不固定就不可能有「逐字节可复现」的包（见 `_pin_hashseed`）
    env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
           # 子进程的 stdout 这次是**管道**（见下），Windows 上默认会用代码页编码 ⇒ 中文会乱码；
           # 让它一律吐 UTF-8，父进程按 UTF-8 解码，两边一致。
           'PYTHONIOENCODING': 'utf-8',
           'PYTHONHASHSEED': os.environ.get('PYTHONHASHSEED', '0'), **READ_ENV}
    # ★ **子进程的输出要接回自己这条流**（2026-10-17 修）：原来是 `subprocess.call` —— 子进程
    #   （`lib/batch.py` 与各适配器）直接继承**真 stdout**，于是：
    #     ① 应用里那个日志框（走 `build_chain` 的 `on_line`）**看不到适配器在跑什么**，
    #        只有服务器控制台有；② 适配器喊的进度（`lib/progress.py`）也就传不到心跳。
    #   改成"逐行接住再原样打出去"：管道 ⇒ 解码 ⇒ `print`。父进程的 stdout 已经被
    #   `build_chain` 换成行回调（在应用里跑时）或就是终端（命令行跑时），两种情况都对。
    try:
        proc = subprocess.Popen(cmd, env=env, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, bufsize=1, text=True,
                                encoding='utf-8', errors='replace')
    except OSError as err:
        print(f'❌ 起不来：{type(err).__name__}: {err}', file=sys.stderr)
        return 1
    assert proc.stdout is not None
    for line in proc.stdout:
        print(line.rstrip('\r\n'), flush=True)
    return proc.wait()


def phase_done(label: str, started: float) -> None:
    print(f'   ⏱ {label}：{time.time() - started:.1f}s')


def run_timed(label: str, cmd: list[str], dry: bool) -> int:
    """
    跑一步并把**耗时**打出来。

    为什么要有它：适配器按"一个来源一个进程"跑，504 场加起来只要 7 秒，
    时间大头跑到**合并/回代**那几步去了（每类一个包 + 混装包 + all_nodes 各跑一次
    `crate-merge`）。那些步骤不计时，慢在哪全凭猜 —— 现在直接看得到。
    """
    started = time.time()
    code = run(cmd, dry)
    print(f'   ⏱ {label}：{time.time() - started:.1f}s')
    return code


def fragments_of(contest: dict) -> list[tuple[str, dict, str]]:
    """
    这一场要跑哪些适配器。

    @returns [(source, 来源条目, 角色)]；board 排在最前 ——
             crate-merge 对同 key 的字段"先到先得"，board 必须先到。

    ⚠️ `qoj` **不在这里**：QOJ 那棵树是"整棵树一个片段"（见 `TREE_SOURCES`），
    因为它的场次集合与主树清单无关（清单里只有 35 场有 QOJ 提交，而包里有 299 场）。
    """
    out = []
    board = contest.get('board') or {}
    if board.get('source'):
        out.append((board['source'], board, 'board'))
    for s in (contest.get('sources') or []):
        if not s.get('source'):
            continue
        out.append((s['source'], s, s.get('role') or 'titles'))
    for s in (contest.get('submissions') or []):
        if not s.get('source') or s.get('source') == 'qoj':
            continue
        out.append((s['source'], s, 'submissions'))
    # ⚠️ 清单里同一个提交来源可能**同时**出现在 `sources` 和 `submissions`
    #    （实测 ccpc2019final 等：`{'source':'cf','role':'submissions'}` 两处都有），
    #    于是同一个 (source, role) 会被跑两遍、同一片段被列进合并清单两次
    #    （实测 `_pieces.txt` 542 行 ↔ 507 个不同文件，含 35 个重复）。
    #    `fragment_path()` 只按 (slug, source, role) 命名 ⇒ 这里按同一个键去重才正确。
    seen_keys = set()
    uniq = []
    for src, entry, role in out:
        k = (src, role)
        if k in seen_keys:
            continue
        seen_keys.add(k)
        uniq.append((src, entry, role))
    return uniq


def xcpcio_letters(contest: dict) -> str:
    """
    这一场的题号（`A,B,C…`）—— **只给 rankland-index 用**。

    为什么要它：`config.json` 报了题号，而 rankland 索引里可能少几题；
    少的那几题没有 P 节点，其它来源（xcpcio 的 ratio、CF 的提交）就挂不上去
    （crate-merge 只按 extKey 合并）。

    取**所有来源的并集**，不只是 xcpcio 的：
    实测 `ccpc2024ladies`：xcpcio 只收了 12 题（A–L），而 CF gym 是 13 题（A–M），
    本队的提交正好落在 M 上 —— 只拿 xcpcio 的题号，那条 R 的父题目就不存在，导入会被拒。
    """
    board = contest.get('board') or {}
    if board.get('source') != 'xcpcio' or not board.get('path'):
        return ''
    letters = []
    cfg = os.path.join(CACHE, 'xcpcio', *str(board['path']).split('/'), 'config.json')
    if os.path.isfile(cfg):
        try:
            letters += [str(p.get('label') or '') for p in (read_json(cfg).get('problems') or [])]
        except (ValueError, OSError):
            pass
    # 其它来源的题号（现在只有 CF 榜单缓存里有 `problems[].index`）
    for s in [board] + list(contest.get('sources') or []) + list(contest.get('submissions') or []):
        gid = str(s.get('gym') or '')
        if not gid:
            m = re.search(r'cf_standings_(\d+)\.json', str(s.get('file') or ''))
            gid = m.group(1) if m else ''
        if not gid:
            continue
        sp = os.path.join(CACHE, f'cf_standings_{gid}.json')
        if not os.path.isfile(sp):
            continue
        try:
            letters += [str(p.get('index') or '') for p in (read_json(sp).get('problems') or [])]
        except (ValueError, OSError):
            continue
    seen, out = set(), []
    for x in letters:
        x = norm_letter(x)
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return ','.join(out)


def fragment_path(contest: dict, source: str, role: str) -> str:
    """
    **片段文件名的唯一定义**（`--only` 快路径与主循环都调它）。

    一个来源**只担一个角色**时是 `crate_<slug>_<source>.json`（老习惯，别改）；
    一个来源担**两个角色**（PTA 既是榜单、又出本队提交）时必须带角色后缀，
    否则两个适配器会写到同一个文件、后写的把先写的覆盖掉。
    """
    roles = [r for s, _e, r in fragments_of(contest) if s == source]
    suffix = f'_{role}' if len(roles) > 1 else ''
    return os.path.join(
        CACHE, f'crate_{contest["slug"]}_{FILE_TAG.get(source, source)}{suffix}.json')


def expected_pieces(contests: list) -> list[str]:
    """
    **当前清单下应该存在**的片段路径（不删任何文件，只算路径）。

    `--only` 靠它把孤儿片段挡在外面。
    """
    return [fragment_path(c, source, role)
            for c in contests for source, _entry, role in fragments_of(c)]


def side_tree_notes(nodes_dir: str, rel_fn=None) -> list[str]:
    """
    `--all-nodes` 那两棵"**链上读、链上不产**"的树：树比原料旧就说一句（**只报，不改行为、不联网**）。

    ★ 为什么要有这一条（2026-10-17 真踩到，用户先问"怎么归到其他比赛了"再问"我重新建包?"）：
      `build_chain` 里连 `hdu` / `nk` 这两个词都没有 —— 那两棵树由 `npm run crate:hdu` /
      `crate:nk` 单独产出，链只把 `nodes/<那两份>.json` 读进来。于是"原料更新了、树还是旧的"
      **没有任何机器可读信号**：实测那条链从头跑到尾都"成功"，而包里那棵杭电树只有 **10 场**
      （原料里已经有 50 场）。`.stale` 标记也救不了它 —— 那套只标"链上产出的类"。

    ★ 判据只看 **mtime**（不判内容、不猜），因为这一句要说的是"该重跑那条命令了"，
      而不是"数据对不对"；真要判内容，得把两棵树的产出命令都挂进链里（那是另一件事）。
    ⚠️ 杭电那棵**跳过它自己的 `cache/`**：`hdu_contests_all.json` 是归档页枚举的缓存，
       天天会被 `--refresh-archive` 刷新，算进"原料变新"会让这句长期误报。
    """
    show = rel_fn or (lambda p: p)
    out: list[str] = []
    for name, label, cmd, roots, skips in SIDE_TREES:
        target = os.path.join(nodes_dir, name)
        if not os.path.isfile(target):
            continue                                   # 缺文件那边有别的提示，别重复说
        newest, newest_at = 0.0, ''
        for root_rel in roots:
            root = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', root_rel)
            skip_dirs = {os.path.normcase(os.path.join(REPO, 'acm-data', 'raw', 'Scaper', s))
                         for s in skips}
            for dirpath, dirnames, filenames in os.walk(root):
                if os.path.normcase(dirpath) in skip_dirs:
                    dirnames[:] = []
                    continue
                dirnames[:] = [d for d in dirnames if d != '__pycache__']
                for fn in filenames:
                    if os.path.splitext(fn)[1].lower() in ('.py', '.js', '.mjs', '.md', '.bat', '.sh'):
                        continue                   # 脚本与说明不是原料（与 `material.py` 同一条）
                    p = os.path.join(dirpath, fn)
                    try:
                        mt = os.path.getmtime(p)
                    except OSError:
                        continue
                    if mt > newest:
                        newest, newest_at = mt, p
        if not newest_at or newest <= os.path.getmtime(target) + 1:
            continue
        out.append('   ⚠️ %s**比原料旧**：%s ｜ 最新原料 %s（%s）—— 先跑 `%s` 再重建总包'
                   % (label, show(target),
                      time.strftime('%Y-%m-%d %H:%M', time.localtime(newest)),
                      show(newest_at), cmd))
    return out


#: 链上读、链上不产的树 = (产物文件名, 人话名字, 该跑哪条命令, 该吃的原料目录（相对 `Scaper/`）, 要跳过的子目录）
SIDE_TREES = (
    ('hdu-multi-university.json', '杭电那棵树', 'npm run crate:hdu',
     ('02 hdu',), ('02 hdu/cache',)),
    ('nk-multi-university.json', '牛客那棵树', 'npm run crate:nk',
     ('05 xcpc/cache/nk',), ()),
)


def sync_stale_marks(produced, known, nodes_dir: str = '', rel_fn=None) -> list[str]:
    """
    按"**这一轮真的产出了哪几类**"同步 `*.json.stale` 标记，返回要打印的行。

    · `cls in produced` ⇒ **删掉**旧标记（这一轮的产物是新的，那条标记已经过期）；
    · 否则（含"空片段被 `continue` 跳过"的类）⇒ 产物在就**写**标记，并如实说一句；
    · 产物不在 ⇒ 不写标记（没有东西可标）。

    ★ 为什么必须有"删"这一半（2026-10-16 修，审计翻出来的）：标记的语义是"**这一轮**没产出"，
      而这一段原来**只写不删** ⇒ 一次没产出留下的标记会一直挂着，于是
      `build_chain.stale_products()` 与链尾那句话（"见到它就说明这份产物是上一轮的"）
      会长期说谎（实测：某一类补上之后的很多轮里，标记还在）。
    ★ 顺带补一个洞：**空片段被跳过**的那几类原来两头都不沾（既不产出、也不在原来的
      `known - set(groups)` 里）⇒ 旧产物既没标记、也没人说。现在统一按 `produced` 判。

    抽成函数是为了**能单测**（这一段原来埋在 `main()` 里，`selftest.py` 碰不到）——
    行为完全一样，只是把 `print` 变成返回行、由调用方打。
    """
    show = rel_fn or (lambda p: p)
    out: list[str] = []
    for cls in sorted(known):
        target = os.path.join(nodes_dir, f'{cls}.json')
        mark = target + '.stale'
        if cls in produced:
            if os.path.isfile(mark):
                try:
                    os.remove(mark)
                    out.append(f'   ✅ {cls} 类本轮产出 ⇒ 清掉上一轮留下的 {show(mark)}')
                except OSError:
                    pass
            continue
        if os.path.isfile(target):
            out.append(f'   ⚠️ 本轮没有产出 {cls} 类 —— 旧产物 {show(target)} 仍在，**可能是过期数据**')
            try:
                with open(mark, 'w', encoding='utf-8', newline='\n') as f:
                    f.write('本次运行没有产出这个类；该文件是上一次的产物，可能是过期数据。\n')
            except OSError:
                pass
        else:
            out.append(f'   ⚠️ 本轮没有产出 {cls} 类（也没有上一轮产物）')
    return out


def main(argv):
    ap = argparse.ArgumentParser(description='XCPC 导入流水线')
    ap.add_argument('slug', nargs='?', help='只做这一场（slug）；不给就做清单里全部')
    ap.add_argument('-o', '--output', default=DEFAULT_OUT)
    ap.add_argument('--manifest', default='')
    ap.add_argument('--list', action='store_true', help='列出清单里的场次')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--check', action='store_true', help='合并后跑 crate:check')
    ap.add_argument('--offline', action='store_true',
                    help='**离线重跑**：一次也不联网，只用本地缓存/归档（以 `ACM_READ_OFFLINE=1` '
                         '传给每个子适配器，见 `Scaper/lib/read_modes.py`）。省的是联网那几笔 ——'
                         '实测全量建包 **~110s → ~92s**（CF `contest.list` 26.6s、AtCoder '
                         '`contests.json` 5s+）；⚠️ **大头不是联网**：518 个子进程各起一个 Python'
                         '（~0.17s）≈ 80s，离线省不掉。缺哪份本地文件会当场报错；与 `--force` 互斥')
    ap.add_argument('--force', action='store_true',
                    help='**强制重跑所有适配器**（先删已有片段）—— 改过清单/注册表'
                         '（例如把某场挪到别的系列）时必须加，否则片段里的 F/S 层名不对')
    ap.add_argument('--all-nodes', action='store_true', dest='all_nodes',
                    help='额外再合一个 `all_nodes.json` = 混装包 + atcoder/cf-contest/'
                         'nk-multi-university/hdu-multi-university（可选项；'
                         '后两个包要各自的流水线产出，缺了就跳过并提示）')
    ap.add_argument('--only', default='',
                    help='逗号分隔的 slug：**只重跑这几场的适配器**，但合并 cache 里'
                         '**全部已有片段** —— 秒级。用在"只动了几场的数据"（如补几个 QOJ 题号）时；'
                         '⚠️ 若清单/注册表改动了**别的场次要不要跑哪些来源**，必须改回全量重建')
    ap.add_argument('--no-baseline', action='store_true', dest='no_baseline',
                    help='**不回代**（默认会自动把 `acm-data/nature-assignments.json` 里'
                         '人工填过的值写回产出的包；重出包会从零生成，不回代就等于把人的结论丢了）。'
                         '只在"故意要一份纯脚本产物"时用')
    ap.add_argument('--only-source', default='',
                    help='只重跑**这一个来源**的适配器（如 qoj），其余片段沿用 cache —— '
                         '合并仍然用全部片段。用在"只改了一个渠道的适配器/缓存"时（QOJ 那 35 场，'
                         '十几秒；全量重建要给 600+ 个片段各起一个进程）。')
    ap.add_argument('--team', default='',
                    help='**你的队名**，逗号分隔算多支（PTA 提交那一段的账户线索用它）。'
                         '给了就随环境变量 `PTA_TEAM` 传给每个子适配器，盖过自动认出来的那些；'
                         '不给则自动认：`me.json` 账户里声明的**所有** `pta:<赛季> : 队伍`'
                         '（本场赛季的排前，一个都不吞），再不行才看 `pta.teamName`／账户的 '
                         '`pta` 字段，最后才用提交文件里的 `teamInfo.teamName`')
    ap.add_argument('--no-batch', action='store_true', dest='no_batch',
                    help='**回到老路子**：每场每个来源各起一个 python 子进程（默认按适配器批处理，'
                         '一个适配器一个进程）。只用于"怀疑批处理改了产物"时做 A/B 对照 —— '
                         '两条路的片段内容与合并顺序应当**逐字节一致**。')
    args = ap.parse_args(argv)

    # 环节记账**一轮一清**：不清的话数字会跨轮一直累加（"这条判据判了 9 万场"）。
    # ⚠️ 只清记账文件，不碰任何产物。
    # ⚠️⚠️ **"只预演 / 只列清单"那两条路一个字节都不许动**（2026-10-17 实测踩到）：
    #    下面这两句原先**无条件**执行，而 `--dry-run` 在链尾那一支**提前 return**、根本不会把
    #    这一轮的账写回 ⇒ 跑一次 `--dry-run` 等于**删掉** `acm-data/reports/stage-tally.json`
    #    （它还是 git 跟踪的 ⇒ 下次保存快照就把这个"删除"一起提交了）。
    #    "只预演"这类开关必须真的什么都不动 —— 判据：跑完大小与 mtime 逐项不变。
    # `ACM_STAGE_TALLY=1` 是本进程与**所有子适配器**的约定：只有它开着，适配器退场时才
    # 把自己的记账并进那份文件（见 `stages._flush_tally_at_exit`）—— 免得跑一次单测/自测
    # 也往里面塞数字，链尾念出来成了假账。
    if not (args.dry_run or args.list):
        os.environ['ACM_STAGE_TALLY'] = '1'
        stages.reset_tally_file()

    manifest = load_manifest(args.manifest)
    if args.list:
        for c in manifest['contests']:
            b = (c.get('board') or {}).get('source', '?')
            subs = ','.join(s.get('source', '?') for s in (c.get('submissions') or [])) or '-'
            print(f"   {c['slug']:<40} board={b:<4} 提交={subs}   {c.get('name', '')}")
        return 0

    only = [s.strip() for s in str(args.only).split(',') if s.strip()]
    only_source = str(args.only_source).strip()
    # 两个开关互斥：`--force` 要重抓、`--offline` 一次也不联网 —— 与其猜人的意思，直接说清
    # （子适配器那边也会各自报一次，但那是 600 个子进程各报一遍，不如在这里拦）。
    if args.offline and args.force:
        print('❌ `--offline` 与 `--force` 互斥：一个是"只用本地"，一个是"忽略本地重抓"',
              file=sys.stderr)
        return 2
    if args.offline:
        # 子适配器全都不联网（环境变量随 `run()` 传下去，见 `READ_ENV`）
        READ_ENV['ACM_READ_OFFLINE'] = '1'
        print('🔌 --offline：本次一次也不联网（只用本地缓存/归档）——'
              '缺哪份本地文件会当场报错')
    if args.team.strip():
        # 队名随环境变量传下去（`me.pta_team()` 认 `PTA_TEAM`）——
        # 于是"我是谁"不必写进任何数据文件，也不必每个适配器各传一次参数。
        READ_ENV['PTA_TEAM'] = args.team.strip()
        print(f'🏷️ --team {args.team.strip()}：PTA 提交那一段的账户线索按这个队名写'
              '（提交文件里写别的队名时会警告一句）')
    if args.slug and only:
        print('❌ `slug` 与 `--only` 不要一起用（前者会只合并这一场的片段）', file=sys.stderr)
        return 2
    if only:
        contests = [find_contest(manifest, s) for s in only]
    elif args.slug:
        contests = [find_contest(manifest, args.slug)]
    else:
        contests = manifest['contests']
    if only_source:
        # 「整棵树一个片段」的来源不逐场，在 `fragments_of` 里也不挂任何一场
        if only_source in TREE_SOURCES:
            print(f'🔎 --only-source {only_source}：重跑**整棵树**（一个片段，不逐场），'
                  '其余片段沿用 cache')
        else:
            contests = [c for c in contests
                        if any(src == only_source for src, _e, _r in fragments_of(c))]
            print(f'🔎 --only-source {only_source}：只重跑这 {len(contests)} 场的 {only_source} 适配器，'
                  f'其余片段沿用 cache')
    if not contests and only_source not in TREE_SOURCES:
        print('❌ 清单里一场都没有'); return 1

    print(f'📂 {len(contests)} 场：')
    for c in contests:
        marks = ' + '.join(f'{src}({role})' for src, _e, role in fragments_of(c))
        print(f"   {c['slug']}  [{marks}]")

    # ---- 「整棵树一个片段」的来源：一次跑一个适配器出整棵树 ----
    # 什么时候重跑：全量重建、或 `--only-source <它>`。`--only <slug>` 时它的输入
    # （04 qoj 的缓存）没变，直接沿用 cache 里那份。
    trees_t0 = time.time()
    trees_to_run = [] if only else [s for s in TREE_SOURCES if not only_source or s == only_source]
    # ⚠️ 整棵树这一段**也要认「当场停」**：`cf-contest` / `atcoder`
    #    这两个适配器正是调 `require_local()` 的那两个（本地缺必需原料时 `SystemExit(2)`）⇒
    #    若一律压成 1，"缺原料"就会被报成"某一场失败"，重跑/排查方向全错。
    for source in trees_to_run:
        script, fragment = TREE_SOURCES[source]
        print(f'\n=== {source} 树（整棵树一个片段）===')
        cmd = [sys.executable, os.path.join(HERE, script), '-o', fragment]
        if args.force:
            # ★ `--force` **要透传给适配器**（2026-10-17 修）：它原来只删片段、让适配器重跑，
            #   而"忽略本地缓存去重抓"是**适配器自己**按 `read_modes` 那套做的
            #   ⇒ 父进程喊 force、子进程照旧读缓存（实测：整条链 83.8s、CF「归档命中 616 / 联网 7」，
            #   等于"重新打包"而不是"整份重抓"）。现在每个适配器都挂了统一开关（`read_modes.add_cli_args`），
            #   一律原样透传。
            cmd.append('--force')
        if args.force and os.path.isfile(fragment):
            os.remove(fragment)
        code = run(cmd, args.dry_run)
        if code != 0:
            if code == HARD_STOP:
                print(f'   ⛔ {source} 树适配器**当场停**（退出码 {HARD_STOP}）：'
                      f'凭据过期/被拦，或必需的原料不在本地 —— 先按上面那句话处理，别急着重跑')
                return HARD_STOP
            print(f'   ❌ {source} 树适配器失败'); return 1

    phase_done('整棵树适配器（qoj / cf-contest / atcoder）', trees_t0)

    # ---- 逐场跑适配器，收集片段 ----
    #
    # ⚠️ **进程粒度 = 适配器，不是场次**。
    #    若按「一场 × 一个来源 = 一个 python 子进程」，全量重建约 800 个：每个子进程都要
    #    重新 import 一遍 lib、再把共享大缓存（rankland 索引 / xcpcio config / cf 提交…）
    #    重读重解析一遍。实测 `--only-source qoj` 的 35 场 4.4 秒 ⇒ 约 0.11 秒/进程，
    #    光"起进程"就吃掉全量重建 132 秒里的大头。
    #    现在按 **(适配器脚本, 附加参数)** 分组，一组一个进程，组内逐个调用适配器自己的
    #    `main(argv)`（见 `lib/batch.py`）。**产物与合并输入顺序照旧**：`jobs` 就是按
    #    "场次顺序 + 场次内来源顺序"收集的，片段路径/内容都不变。
    collect_t0 = time.time()
    pieces: list[str] = [p for _s, (_a, p) in TREE_SOURCES.items() if os.path.isfile(p)]
    failed = False
    # 「当场停」那一类（凭据/原料）—— 与"某一场失败"分开报、分开退出码
    hard_stop = False
    jobs: list[dict] = []
    for c in contests:
        slug = c['slug']
        for source, entry, role in fragments_of(c):
            if only_source and source != only_source:
                continue
            script = ADAPTERS_BY_ROLE.get((source, role)) or ADAPTERS.get(source)
            if not script:
                print(f'   ⚠️ {slug}：没有 {source} 的适配器（清单里却有）—— 跳过。'
                      f'要接新来源就在 xcpc_pipeline.py 的 ADAPTERS 里加一行')
                continue
            # 片段文件名：规则在 fragment_path() 里，**只有一份**
            out = fragment_path(c, source, role)
            # `--force`：**强制重跑已有片段**。
            # 什么时候需要：改了**清单/注册表**（如把某场挪到别的系列）—— 系列与层名是编在
            # **片段**里的（C 记录写着层名），而适配器自己按"来源缓存"判断要不要重算，
            # 于是"改了分类却看不出变化"（实测踩过：改完注册表重跑，xcpc.json 没变）。
            if args.force and os.path.isfile(out):
                os.remove(out)
                print(f'   （--force：删掉已有片段 {os.path.basename(out)}（{slug}），重跑适配器）')
            extra: list[str] = []
            if args.force:
                # ★ 与"整棵树"那条同一个口径：`--force` 原样透传给适配器（见上面那段注释）。
                #   只删片段是不够的 —— 适配器不认 force 就照旧读它自己的缓存。
                extra += ['--force']
            if args.manifest:
                extra += ['--manifest', args.manifest]
            if source == 'srk' and role in ('titles', 'board'):
                extra += ['--role', role]
            # rankland-index 也分角色：board=出 C+P 题单；titles=只补题名/题号/链接；time=只补开赛时间
            if source == 'rankland-index' and role in ('titles', 'board', 'time'):
                # ★ 角色**原样透传**（2026-10-16 修）：原来把 `titles` 折成 `--role board`，
                #   而适配器**按 role 声明 kind** ⇒ "只补题名/题号/链接的索引"拿着**权威榜单**身份，
                #   会压掉真榜单的 `name`/`contestTime`/`problemId`（实测包内 134 个
                #   `rankland-index-*` 是 board，而清单里只有 **13** 场是真正拿它当 board）。
                #   ⇒ 与 `srk`（:509 本来就原样透传）、`xcpcio`（board/index）同一个形状。
                extra += ['--role', role]
                # 把 xcpcio 的题号带上：索引里缺的题补个空壳 P，ratio 才挂得上
                letters = xcpcio_letters(c)
                if letters and role != 'time':
                    extra += ['--letters', letters]
            if source == 'cf' and role in ('website', 'titles'):
                # `website` 与 `titles` 都要透传角色（只透传 website 时，
                # `titles` 会被当成 `board` 跑 —— 那就会和不需要再算的 ratio 撞上）
                extra += ['--role', role]
            # rankland-refs：**一次搬全部**（不再分 board/problems 两个角色），
            # 类别写进 C 的「链接分类」，所以这里没有 `--role` 要透传。
            # xcpcio 也分两个角色：board=出 C+P.ratio（默认）；index=只出赛名/时间/题号
            if source == 'xcpcio' and role in ('board', 'index'):
                extra += ['--role', role]
            jobs.append({
                'slug': slug, 'source': source, 'role': role, 'out': out,
                'module': os.path.join(HERE, script),
                'argv': [slug, '-o', out] + extra,
                'key': (script, tuple(extra)),
            })

    phase_done('收集 jobs（含逐场的 xcpcio_letters / 片段路径）', collect_t0)

    # 分组：同一个适配器 + 同一组附加参数 ⇒ 一个进程跑完这一组的所有场次
    groups: dict = {}
    for job in jobs:
        groups.setdefault(job['key'], []).append(job)
    print(f'\n📦 片段 {len(jobs)} 个 → 进程 {len(groups)} 个'
          f'（若每场一个进程则是 {len(jobs)} 个）')
    dispatch_t0 = time.time()
    batch_script = os.path.join(HERE, 'lib', 'batch.py')
    for index, (key, group) in enumerate(groups.items(), start=1):
        script, _extra = key
        # 分组这一层也喊一拍：这一层是**进程内**的，所以即使适配器那边还没开口，
        # 心跳也立刻有 a/b 可看（组内的"第几场"由 `lib/batch.py` 再细分）。
        progress.emit(index, len(groups), '适配器进程')
        if len(group) == 1 or args.no_batch:
            # 单个 job（或 `--no-batch` A/B 对照）⇒ 老老实实一个场次一个进程
            for job in group:
                print(f'\n=== {job["slug"]} ===')
                cmd = [sys.executable, job['module']] + job['argv']
                code = run(cmd, args.dry_run)
                if code == 0:
                    continue
                if code == HARD_STOP:
                    # ⚠️ 这一条路（单 job 组 / `--no-batch`）若只记 failed=True
                    #    最后压成 1 ⇒ "凭据过期"又变成"某一场失败"。与批处理那条同口径。
                    print(f'   ⛔ {job["slug"]}：适配器**当场停**（退出码 {HARD_STOP}）'
                          f'—— 凭据过期/被拦，或必需的原料不在本地；**不再跑后面的场次**')
                    hard_stop = True
                    break
                print(f'   ❌ {job["slug"]}：{job["source"]} 适配器失败 —— 这一场**整场跳过**'
                      f'（不半途合并）')
                failed = True
            if hard_stop:
                break
            continue
        jobs_file = os.path.join(CACHE, f'batch_jobs_{index:02d}.json')
        if not args.dry_run:
            with open(jobs_file, 'w', encoding='utf-8') as fh:
                json.dump(group, fh, ensure_ascii=False, indent=1)
        cmd = [sys.executable, batch_script, '--jobs', jobs_file, '--label', script]
        code = run(cmd, args.dry_run)
        if not args.dry_run and os.path.isfile(jobs_file):
            os.remove(jobs_file)                       # 不把中间文件留在 cache 里
        if code != 0:
            if code == HARD_STOP:
                # ⚠️ 2 = "当场停"（凭据过期/被拦、必需原料不在本地），
                #    与"某一场失败"**不是一回事** —— 重跑没有意义，得让人先去处理凭据。
                print(f'   ⛔ 批处理**当场停**（{script}，退出码 {HARD_STOP}）：'
                      f'凭据过期/被拦，或必需的原料不在本地 —— 重跑没有意义，'
                      f'先把那句可执行的话里的凭据换了')
            else:
                print(f'   ❌ 批处理失败（{script}）—— 失败的场次见上面，它们**整场跳过**'
                      f'（不半途合并）')
            failed = True
            hard_stop = hard_stop or (code == HARD_STOP)
        if hard_stop:
            break

    phase_done('跑适配器（逐场那批）', dispatch_t0)

    if failed:
        if hard_stop:
            print('\n⛔ 这轮**当场停**（凭据/原料），未写导入包 —— 与"某一场失败"不同，'
                  '别急着重跑，先按上面那句话去换凭据')
            return HARD_STOP
        print('\n❌ 有场次失败，未写导入包')
        return 1

    # 合并清单：**与逐场跑时同序**（场次顺序 + 场次内来源顺序）
    for job in jobs:
        if args.dry_run or os.path.isfile(job['out']):
            pieces.append(job['out'])
        else:
            print(f'   （{job["source"]} 没有产出片段（{job["slug"]}）'
                  f'—— 这个来源这场没数据，跳过）')

    # ---- `--only`：只重跑了这几场，但合并**全部"当前清单下应该存在"的片段**（秒级快路径）----
    # 为什么需要它：全量重建要给**每个片段起一个 python 进程**（600+ 个，1–3 分钟），
    # 而"只动了几场的数据"（例如给几场补了 QOJ 题号）是常见情形 —— 那时其它片段本来就没变。
    #
    # ⚠️ 不能直接 glob `cache/crate_*.json`：cache 里还留着**孤儿片段**
    #    （双角色那套 refs、系列合并前的层名…），它们与新片段**父引用冲突** ——
    #    实测合并直接报 31 个错误、整包不写。
    #    所以按**当前清单**算出"应该有哪些片段"，只合并其中**真实存在**的那些。
    # ⚠️ 前提：清单没改动"别的场次跑哪些来源"。改过就老老实实全量重建。
    if (only or only_source) and not args.dry_run:
        all_pieces = expected_pieces(manifest['contests'])
        # 「整棵树」那些片段不挂在任何一场上，单独补进来（它们就在 cache 里）
        all_pieces += [p for _s, (_a, p) in TREE_SOURCES.items() if os.path.isfile(p)]
        pieces = [p for p in all_pieces if os.path.isfile(p)]
        what = f'--only {len(only)} 场' if only else f'--only-source {only_source}'
        print(f'\n⚠️ {what}：只重跑了这几场，但合并**全部 {len(pieces)} 个**已有片段'
              f'（当前清单应有 {len(all_pieces)} 个）')
        print('   （前提：清单没改过"别的场次跑哪些来源"；改了请去掉它全量重建）')

    if not pieces:
        print('\n❌ 一个片段都没有')
        return 1

    # ---- 产出层：**一个类一个包** ----
    # 片段名带来源后缀（`crate_<slug>_<src>.json`）或就是整棵树（`crate_<x>_tree.json`），
    # 按它分组各出一包；最后再"简单合并"全部包出 args.output（只为一次导入，内容不变）。
    # 以后要"加料"（比如组成 XCPC 类）就在这一步加，不动上游。
    SUFFIX_CLASS = (
        ('_cf_submissions.json', 'cf-gym'), ('_cf_titles.json', 'cf-gym'),
        ('_cf_website.json', 'cf-gym'),
        ('_cf_board.json', 'cf-gym'), ('_cf.json', 'cf-gym'),
        ('_xcpcio.json', 'xcpcio'), ('_rlidx_titles.json', 'rankland'),
        ('_pta_board.json', 'pta'), ('_pta_submissions.json', 'pta'),
        ('_rlidx.json', 'rankland'), ('_rlidx_time.json', 'rankland'),
        ('_rlrefs.json', 'rankland'),
        ('_pta.json', 'pta'), ('_nk.json', 'nk-ranklist'), ('_srk.json', 'srk'),
    )
    TREE_CLASS = {'crate_qoj_tree.json': 'qoj',
                  'crate_cf_contest_tree.json': 'cf-contest',
                  'crate_atcoder_tree.json': 'atcoder'}

    def class_of(path: str) -> str:
        name = os.path.basename(path)
        if name in TREE_CLASS:
            return TREE_CLASS[name]
        for suf, cls in SUFFIX_CLASS:
            if name.endswith(suf):
                return cls
        return 'other'

    groups: dict = {}
    for one in pieces:
        groups.setdefault(class_of(one), []).append(one)
    if 'other' in groups:
        names = [os.path.basename(x) for x in groups['other']]
        print(f'   ⚠️ {len(names)} 个片段没匹配到任何类（会出成 other.json）：'
              + '、'.join(names[:5]) + ('…' if len(names) > 5 else '')
              + ' —— 要归类就往 SUFFIX_CLASS / TREE_CLASS 加一行')
    NODES = os.path.dirname(os.path.abspath(args.output))
    print(f'\n=== 按类出包：{len(groups)} 个类 → {rel(NODES, REPO)} ===')
    produced: set[str] = set()          # ★ 这一轮**真的产出**了哪几类（`.stale` 标记按它增删，见下面那圈）
    for cls in sorted(groups):
        cls_pieces = groups[cls]
        cls_file = os.path.join(CACHE, f'_pieces_{cls}.txt')
        with open(cls_file, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join(cls_pieces) + '\n')
        cls_out = os.path.join(NODES, f'{cls}.json')
        print(f'   {cls:12s} {len(cls_pieces):3d} 个片段 → {rel(cls_out, REPO)}')
        if run_timed(f'{cls} 类出包', ['node', MERGE, '--inputs-file', cls_file, '-o', cls_out], args.dry_run) != 0:
            # ⚠️ **空片段不算链子失败**（实测踩到）：某一类没数据（比如
            #    `me.json` 里没登记 atcoder 账号 ⇒ 那一棵树 0 条）时，crate-merge 会以
            #    "records 缺失或为空数组"退出 1 —— 那是"这类没事可做"，不是"链子坏了"。
            #    若它**直接终止整条链**（看到的"❌ atcoder 类出包失败 / 退出码 1"），
            #    于是一个空来源把别的类全带崩。所以：空片段 ⇒ 警告 + 跳过这一类
            #    （已有产物不删、照下面的 .stale 逻辑标注），其余类继续出。
            if _class_pieces_empty(cls_pieces):
                print(f'   ⚠️ {cls} 类的片段都是空的（没有数据）⇒ 跳过这一类，不算失败')
                continue                    # ⚠️ **不进 `produced`**：这一类这轮确实没产出，
                                            #    下面那圈照样给它（旧的）产物标 `.stale`
            print(f'❌ {cls} 类出包失败')
            return 1
        produced.add(cls)

    # 本轮**没产出**的类：**不删**已有产物（那可能是唯一能导入的一份），只大声标注 + 落 .stale 标记；
    # 本轮**产出了**的类：把之前留下的 `.stale` 删掉 —— 增删两半都在 `sync_stale_marks()` 里，
    # 那个函数有单测（`selftest.py` 的 `test_sync_stale_marks()`），改动只许改那一处。
    known = {c for _, c in SUFFIX_CLASS} | set(TREE_CLASS.values()) | {'other'}
    for line in sync_stale_marks(produced, known, NODES, lambda p: rel(p, REPO)):
        print(line)

    # ---- 全部合并：**改名 + 换成分** ----
    #   · `xcpc.json` 这个名字**误导**：qoj / cf gym 里有大量非 XCPC 的内容，
    #     它其实是"**混装、但含 XCPC**"的包 ⇒ 改名 `mix_contain_xcpc.json`；
    #   · `atcoder` / `cf-contest` 两类**不进**这个混装包（它们各是一棵独立的树、语义干净）；
    #   · **合成节点不在这里**：它们由链上后面的 `synth-bind.mjs` 按 nature 建、
    #     直接写进最终包（`--all-nodes` 那个）。以前这里会额外并一份
    #     `xcpc-synth.json`（`scripts/nature_rules.py build` 产），**那一步已停用**
    #     （第二个建组器；它独有的顶层 W / icpc 中间层容器 / 指针来源痕已补进 `synth-bind`，
    #     实测清单见 `scripts/nature_rules.py` 文件头）。
    MIX_EXCLUDE = {'atcoder', 'cf-contest'}
    mix_pieces = [p for p in pieces if class_of(p) not in MIX_EXCLUDE]
    print(f'\n=== 合并 {len(mix_pieces)} 项 → {rel(args.output, REPO)}'
          f'（排除 {"、".join(sorted(MIX_EXCLUDE))}；合成节点由链上的 synth-bind 建） ===')
    if not os.path.isfile(MERGE):
        print(f'❌ 找不到 {MERGE}')
        return 1
    # 片段路径可能上百个、还可能带空格，直接塞进命令行会超长 —— 写成清单文件交给 crate-merge
    # `_pieces.txt` 保持原义（**全部片段**，诊断用）；混装的输入另写一份，别让名字说谎
    os.makedirs(CACHE, exist_ok=True)
    with open(os.path.join(CACHE, '_pieces.txt'), 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(pieces) + '\n')
    pieces_file = os.path.join(CACHE, '_pieces_mix.txt')
    with open(pieces_file, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(mix_pieces) + '\n')
    print(f'   （{len(mix_pieces)} 项，路径清单写在 {rel(pieces_file, REPO)}）')
    cmd = ['node', MERGE, '--inputs-file', pieces_file, '-o', args.output]
    if run_timed('混装包合并', cmd, args.dry_run) != 0:
        print('❌ 合并失败（crate-merge 有问题时不会写出带病文件）')
        return 1
    if args.dry_run:
        print('（--dry-run：到此为止，不写盘 —— `--all-nodes` 与末尾那步「回代 baseline」也不跑）')
        return 0

    # ---- 可选：`all_nodes.json` = 混装包 + 那几棵不在混装里的树 ----
    if args.all_nodes:
        extra = [os.path.join(NODES, n) for n in
                 ('atcoder.json', 'cf-contest.json',
                  'nk-multi-university.json', 'hdu-multi-university.json')]
        have = [p for p in extra if os.path.isfile(p)]
        missing = [os.path.basename(p) for p in extra if not os.path.isfile(p)]
        all_out = os.path.join(NODES, 'all_nodes.json')
        all_file = os.path.join(CACHE, '_pieces_all.txt')
        with open(all_file, 'w', encoding='utf-8', newline='\n') as f:
            f.write('\n'.join([args.output] + have) + '\n')
        print(f'\n=== 可选：{1 + len(have)} 个包 → {rel(all_out, REPO)} ===')
        if missing:
            print(f'   ⚠️ 缺这几个（没算进去）：{"、".join(missing)}'
                  f'（牛客/杭电那两个要跑 `npm run crate:nk` / `crate:hdu`）')
        for line in side_tree_notes(NODES, lambda p: rel(p, REPO)):
            print(line)
        if run_timed('all_nodes 合并', ['node', MERGE, '--inputs-file', all_file, '-o', all_out], args.dry_run) != 0:
            print('❌ all_nodes 合并失败')
            return 1
        args.output = all_out            # 下面的"下一步"指着刚产出的那个

    # ---- ★ 回代 baseline：把「人定过的值」写回刚产出的包 ----
    #
    # 为什么**必须在这里**（"建总包还需要额外指令调 baseline 吗？能不能方便一些"）：
    #   · 重出包是**从零生成**的 ⇒ 上一次 `manual:set`（手改过的分类/年份/地区…）会被抹掉；
    #   · 忘了跑那一步，"改过的那几十条"就悄悄没了（而且**看不出来**）。
    #   所以把它并进产包这一步，**不用再记一条额外命令**。
    #
    # 口径：没有 `acm-data/nature-assignments.json` 时**友好跳过**（一行提示，不是错误）；
    # `--dry-run` 只打印、不写盘。想要"就是不要回代"时用 `--no-baseline`。
    if not args.no_baseline:
        baseline = os.path.join(REPO, 'acm-data', 'nature-assignments.json')
        baseline_script = os.path.join(REPO, 'scripts', 'nature-baseline.py')
        print('\n=== 回代 baseline（把人工填过的值写回包） ===')
        if not os.path.isfile(baseline):
            print(f'   （没有 {rel(baseline, REPO)} —— 跳过。'
                  '有手工填写时，在应用「判重整理 · ③」点「📤 导出人工填写」再放过来）')
        elif not os.path.isfile(baseline_script):
            print(f'   ⚠️ 找不到 {rel(baseline_script, REPO)} —— 跳过回代')
        elif run_timed('回代 baseline', [sys.executable, '-B', baseline_script, 'apply',
                        '--baseline', baseline, args.output], args.dry_run) != 0:
            print('   ⚠️ 回代失败：包已经产出了，但**人工填过的值没写回去** —— '
                  '检查那份 baseline（`npm run crate:baseline:report` 先看一眼）')
            return 1
    else:
        # ⚠️ `--no-baseline` **必须把上一轮的核对报告清掉**：那份 `baseline.json` 会被
        #    `embed-reports.py` **塞进这一轮的包**（包顶层 `reports.baseline`）——
        #    留着它，人在应用里看到的就是**上一次**的核对结论（"这 N 个 identity 不在包里"），
        #    而这一轮**根本没跑回代**。⇒ 删掉，并说清"这一轮没有回代核对"。
        #    （`--dry-run` 在上面已经 `return`，走不到这里。）
        stale = os.path.join(REPO, 'acm-data', 'reports', 'baseline.json')
        if os.path.isfile(stale):
            try:
                os.remove(stale)
            except OSError as err:              # Windows 上被占用会抛：包已产出，别在这里炸栈
                print(f'   ⚠️ 清不掉上一轮的 {rel(stale, REPO)}（{err}）—— '
                      '它会被塞进这一轮的包，请手动删掉或关掉占用它的程序')
            else:
                print(f'（--no-baseline：这一轮不回代 ⇒ 已清掉上一轮的 {rel(stale, REPO)}'
                      '，免得它被塞进这一轮的包）')
        else:
            print('（--no-baseline：这一轮不回代、也没有上一轮的核对报告可清）')

    # ---- ★ 环节记账：整条链上**每条判据各判了几场** ----
    #
    # 为什么放在这里、而不是各个适配器里自己打：适配器是**子进程**，一个进程只看得到
    # 自己那几十场；而"哪些判据从来没中过"只有在**整条链**的尺度上才看得出来
    # （一条判据被前面的判据完全挡住 ⇒ 每个进程里它都是 0，但没人报）。
    # 每个进程退场时把记账**并进** `acm-data/reports/stage-tally.json`（`stages` 的 atexit），
    # 这里读那份合并结果念一遍。
    # ⚠️ 纯记账：不参与判定。一轮构建开始时先清掉上一轮的（见 `main()` 开头）。
    tidbits = stages.tally_lines()
    if tidbits:
        print('\n=== 环节记账（②③④ 各条判据判了几场）===')
        for line in tidbits:
            print(line)

    print('\n下一步：')
    print(f'   npm run crate:check -- {rel(args.output, REPO)}')
    print('   然后把该文件拖进应用的「📥 节点自动导入」')
    if args.check:
        print('\n=== crate:check ===')
        return run_timed('crate:check', ['node', os.path.join(REPO, 'scripts', 'crate-check.mjs'),
                            rel(args.output, REPO)], False)
    return 0


if __name__ == '__main__':
    _code = _reexec_with_hashseed()
    # ⚠️ **模块级不许 `return`**（那是 `SyntaxError: 'return' outside function` —— 一旦整份文件
    #    编译不过，**任何** import 它的东西都跟着死，而"谁 import 了它"在自测里看不出来：
    #    `05 xcpc selftest` 不 import 它、`build_chain --selftest` 也只查步骤表不执行）。
    #    实测踩到：产包这一步整条挂掉，而手头的几套自测全绿 —— 为此加了一条
    #    "全仓 .py 语法扫"的守卫，就是为这类事）。
    sys.exit(_code if _code is not None else main(sys.argv[1:]))
