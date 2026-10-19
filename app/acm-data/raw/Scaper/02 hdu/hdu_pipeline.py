#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 全自动流水线（一次跑完所有场次 → 一个导入包）

它解决什么
----------
手工跑每场要敲 3~5 条长命令，还得记住哪个文件配哪场。
给一个 cid（或 --all）就行，剩下的它自己找、自己跑。

用法
----
    # 处理所有"能凑齐输入"的场次，合成**一个**导入包
    python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all

    # 只处理某一场
    python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" 1231

    # 只看它会做什么，不实际执行
    python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all --dry-run

    # 每场单独出一个包（想分开导入时用）
    python "acm-data/raw/Scaper/02 hdu/hdu_pipeline.py" --all --per-contest

它按顺序做这几件事（每场）
--------------------------
    1. 榜单 HTML  → hdu_rank_parser.py     → 只打印每队每题的交叉校验摘要（不落盘）
    2. 同一份 HTML → hdu_rank_stats.py      → acm-data/nodes/hdu_rank_stats_<cid>.json
    3. 比赛列表 + 各场题目/提交 + 各场统计 → hdu_adapter.py → 导入包 crate

（第 1 步的"每队明细"是个诊断产物：800KB 一份、没人消费，所以流水线不写它。
 要看明细自己跑 `hdu_rank_parser.py <html> -o <out>`。）

**为什么合成一个包**：导入是增量更新，一个包里放几场不会互相干扰；
而分开导入要拖好几次、且 extKey 相同的比赛会被识别为"同一节点"（符合预期）。

输入从哪来（**约定优于配置**，都相对本脚本所在目录）
---------------------------------------------------
    Hdu_contests.json                  比赛列表（可选，但强烈建议）
    26hdu<N>/Hdu_problems.json         题目（必需；cid 从里面的链接认）
    26hdu<N>/Hdu_submits.json          提交（可选）
    hdu_rank_cid<CID>_all.html         完整榜单（可选，但**有它才有赛时通过率**）

它**不会**帮你爬数据 —— 爬取仍由你手动做（见 _usage.md）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 不要生成 __pycache__（下面要 import lib/hdu_common.py）
sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
NODES = os.path.join(REPO, 'acm-data', 'nodes')
LIB = os.path.join(HERE, 'lib')        # 内部脚本（你不需要直接跑）
DEFAULT_OUT = os.path.join(NODES, 'hdu-multi-university.json')

# ---- 接上公共工具（lib/hdu_common.py）----
# 文件名识别规则（identify / normalize_stem）只有那一份，流水线只是使用者
sys.path.insert(0, LIB)
from hdu_common import identify, normalize_stem, read_json  # noqa: E402

sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # …/Scaper/lib
from pipeline_common import delete_source as _delete_source, run as _run  # noqa: E402


def hdu_handles() -> list[str]:
    """
    **要认领的 HDU 用户名**（可以多个）—— 读取实现**只有 `Scaper/lib/me.py:handles()` 一份**。

    ⚠️ 只读**单数** `hdu.handle` 时，`me.json` 里写成 `hdu.handles: [...]` 或花名册 `team[].hdu`，
    **流水线根本不知道**（适配器支持多人，而自动跑的那条路只传一个名字）。
    所以一律走 `me.handles('hdu')`：`hdu.handles` 列表 → 花名册 `team[].hdu` → 单个 `hdu.handle`。

    ★ **不再兜底**（2026-10-16，用户定的口径："② 干脆别兜底"）：原来 `me.py` 导不进来时会
      自己解析 `me.json`（只读 `hdu.handles` + 单数 `hdu.handle`、**不认花名册**）⇒ 会**静默缩小**
      认领范围；现在导不进来就**当场停**。
    """
    shared = os.path.abspath(os.path.join(HERE, '..', 'lib'))
    if shared not in sys.path:
        sys.path.insert(0, shared)
    try:
        import me as me_mod
    except ImportError as err:
        sys.exit(f'❌ 读不到 {shared}{os.sep}me.py（{err}）—— 这里**不自己解析 me.json**：'
                 f'认领范围（含花名册）只有那一份实现，兜底会静默缩小范围。修好这个 import 再跑。')
    return [h for h in (me_mod.handles('hdu') or []) if h]


def hdu_handle() -> str:
    """
    单数版本：返回第一个账号。

    多人请用 `hdu_handles()` —— 只拿第一个会让队友的提交不带账户线索。
    """
    hs = hdu_handles()
    return hs[0] if hs else ''


def run(cmd: list[str], dry: bool) -> int:
    """跑一个子命令（dry-run 时只打印）—— 实现在 `Scaper/lib/pipeline_common.py`"""
    return _run(cmd, dry, REPO)


# ================================================================
# 文件识别：**只有一条规则**
# ================================================================
#
#     hdu_cid<CID>_<种类>.json / .html
#     hdu_contests.json                    ← 比赛列表（一份列表，本身没有 cid）
#
#     种类 ∈ problems | submits | rank | submit
#
# 就这一条。**文件放在哪都行**（递归扫描，任意深度），因为身份写在名字里：
#     hdu_cid1231_problems.json    某场题目
#     hdu_cid1231_submits.json     某场提交
#     hdu_cid1231_rank.html        某场完整榜单（fetch-hdu-rank.js 的产出）
#     hdu_cid1231_submit.html      某场提交页原件（fetch-hdu-submit.js 的产出）
#
# 源 HTML 同理，一眼看出它产出谁：
#     hdu_cid1231_problems_source.html  → hdu_cid1231_problems.json
#     hdu_cid1231_submits_source.html   → hdu_cid1231_submits.json
#
# ⚠️ 不做历史兼容：`Hdu_problems.json`、`hdu_rank_cid<CID>_all.html`
#    这类名字**不再识别**，改名对照表见 _usage.md。

# 浏览器/系统给重复文件加的后缀、以及"文件名的唯一识别规则"，
# 都在 lib/hdu_common.py（normalize_stem / identify）—— 流水线只是使用者。


def has_records(path: str, kind: str) -> bool:
    """
    这份 JSON **真的有数据**吗？

    两个用途：
      1. 同一个 cid 有多个候选时"非空"优先 —— 否则一个残留的空
         `hdu_cid1234_problems.json` 会把真正有数据的顶掉，而且悄无声息；
      2. 决定**能不能删源 HTML** —— 只有产出确实有数据才敢删。
    """
    if kind not in ('problems', 'submits', 'contests'):
        return True
    try:
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
            data = json.load(f)
    except Exception:
        return False
    return isinstance(data, list) and len(data) > 0


def kind_of_json(path: str) -> str:
    """
    产出 JSON 的路径 → has_records 要的 kind（认不出返回空串）。

    注意 `identify` 返回的是 **(kind, cid)** —— 别写反，
    写反了这里会永远返回空串，于是"解析成功后删源"就永远不会发生（静默失效）。
    """
    kind, _cid = identify(os.path.basename(path))
    return kind if kind in ('problems', 'submits', 'contests') else ''


def has_records_stats(path: str) -> bool:
    """榜单统计 JSON 是否算出了东西（有题、有效队伍数 > 0）"""
    try:
        with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
            data = json.load(f)
    except Exception:
        return False
    return bool(isinstance(data, dict) and data.get('problems')
                and int(data.get('effectiveTeams') or 0) > 0)


def delete_source(source: str, why: str, keep: bool):
    """删掉已经"榨干"的源文件（实现在 `Scaper/lib/pipeline_common.py`）"""
    _delete_source(source, why, keep, HERE)


def looks_like_misnamed_input(path: str, name: str) -> bool:
    """
    这个名字不符合规范的文件，**是不是"本该被流水线用上"的数据**？

    只报这两种，别的（尤其是你随手存的页面 HTML）一律不吭声 ——
    源 HTML 的名字本来就随便，报了纯属噪音：

      - `.json` 且名字里带 problems/submits/rank/contest：像是没按规范命名的数据；
      - `.html` 且文件里带抓取脚本写的 bundle 标记
        （`<!-- hdu-rank-bundle` / `<!-- hdu-submit-bundle`）：像是下载了没改名。
    """
    low = name.lower()
    if low.endswith('.json'):
        return bool(re.search(r'problems|submits|rank|contest', low))
    if low.endswith('.html'):
        try:
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                head = f.read(4096)
        except Exception:
            return False
        return 'hdu-rank-bundle' in head or 'hdu-submit-bundle' in head
    return False


def find_source_jobs() -> dict:
    """
    扫出"有哪些源 HTML 还没被解析"，返回 {目标 JSON 路径: (源 HTML, 解析脚本)}。

    规则表（源 HTML 的规范名 → 产出）：
        hdu_cid<CID>_problems_source.html → hdu_cid<CID>_problems.json
        hdu_cid<CID>_submits_source.html  → hdu_cid<CID>_submits.json
        hdu_cid<CID>_submit.html          → hdu_cid<CID>_submits.json  （抓取脚本的全量包）
        hdu_contests_source.html          → hdu_contests.json

    同一份产出撞到多个源时取**更新的那个**（并会在输出里写出来用的是谁）——
    比如你既存了单页 submits_source 又抓了全量 submit 包，就用后抓的那份。
    """
    best: dict[str, tuple[str, str]] = {}

    def offer(target: str, source: str, script: str):
        old = best.get(target)
        if old and os.path.getmtime(old[0]) >= os.path.getmtime(source):
            return
        best[target] = (source, script)

    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '__pycache__']
        for name in filenames:
            low = name.lower()
            if not low.endswith('.html'):
                continue
            full = os.path.join(dirpath, name)
            stem = normalize_stem(os.path.splitext(name)[0])

            m = re.fullmatch(r'hdu_cid(\d+)_problems_source', stem, re.I)
            if m:
                offer(os.path.join(dirpath, f'hdu_cid{m.group(1)}_problems.json'),
                      full, 'Hdu_prob_scraper.py')
                continue
            m = re.fullmatch(r'hdu_cid(\d+)_submits_source', stem, re.I)
            if m:
                offer(os.path.join(dirpath, f'hdu_cid{m.group(1)}_submits.json'),
                      full, 'Hdu_submit_scraper.py')
                continue
            m = re.fullmatch(r'hdu_cid(\d+)_submit', stem, re.I)
            if m:
                offer(os.path.join(dirpath, f'hdu_cid{m.group(1)}_submits.json'),
                      full, 'Hdu_submit_scraper.py')
                continue
            if re.fullmatch(r'hdu_contests_source', stem, re.I):
                offer(os.path.join(dirpath, 'hdu_contests.json'),
                      full, 'Hdu_contest_list_scraper.py')
    return best


def ingest_sources(dry: bool, keep_source: bool = False) -> int:
    """
    把源 HTML 自动解析成 JSON（**写在源 HTML 旁边**），成功后删掉源 HTML。

    为什么放在流水线开头：源 HTML 的名字已经规范（`save-hdu-page.js` 直接下成规范名），
    再让人手敲 `-i` 指路径纯属多余 —— 而且路径还可能是任意深度。

    删源的理由：解析完源就没用了，而榜单 HTML 一份 7MB。
    安全阀：**产出确实有数据才删**；解析失败、产出为空一律保留；
    `--keep-source` 可以整个关掉删除。

    @param keep_source True 时保留源 HTML
    """
    jobs = find_source_jobs()
    todo = []
    for target, (source, script) in sorted(jobs.items()):
        kind = kind_of_json(target)
        fresh = os.path.isfile(target) and os.path.getmtime(target) >= os.path.getmtime(source)
        if fresh:
            # 产出已经比源新 → 源没用了，顺手清掉
            if kind and has_records(target, kind):
                delete_source(source, '产出已是最新', keep_source)
            continue
        todo.append((target, source, script, kind))
    if not todo:
        return 0

    print(f'📥 自动解析源 HTML（{len(todo)} 个）：')
    for target, source, script, kind in todo:
        print(f'   {os.path.relpath(source, HERE)}  →  {os.path.basename(target)}')
        if run([sys.executable, os.path.join(HERE, script), '-i', source], dry) != 0:
            print(f'   ❌ 解析失败，**保留源文件**：{os.path.relpath(source, HERE)}')
            continue
        if dry:
            continue
        if kind and has_records(target, kind):
            delete_source(source, f'已解析成 {os.path.basename(target)}', keep_source)
        else:
            print(f'   ⚠️ 产出为空/不存在，**保留源文件**：{os.path.relpath(source, HERE)}')
    print()
    return len(todo)


def discover() -> dict:
    """
    **递归**扫描本目录（跳过隐藏目录与 __pycache__），按 cid 汇总可用输入。

    身份完全来自文件名（`hdu_cid<CID>_<种类>`），所以：
      - 文件放在哪个目录都行，一层套一层也行；
      - 目录名不参与识别，也不需要它参与。

    @returns { cid: {problems, submits, rank, contests, submitbundles} }
    """
    found: dict[str, dict] = {}
    notes: list[str] = []
    unknown: list[str] = []

    def slot(cid: str) -> dict:
        return found.setdefault(cid, {'problems': '', 'submits': '', 'rank': '',
                                      'rankstats': '', 'contests': '',
                                      'submitbundles': []})

    def pick(current: str, candidate: str, kind: str = '') -> str:
        """
        同一个 cid 撞到多份同类文件时选一个，优先级：

          1. **有内容的**优先（JSON 解析出来是空数组的排后面）
             —— 否则一个残留的空文件会把真正有数据的那份顶掉；
          2. **名字干净的**优先（没有 `(1)` 之类的重复下载后缀）；
          3. 还平手就取**更新**的。

        每次取舍都记一条提示 —— 不静默丢弃。提示带**相对路径**，
        因为两份文件常常同名（一个在根目录、一个在场次目录里）。
        """
        if not current:
            return candidate

        def clean(p):
            stem, ext = os.path.splitext(os.path.basename(p))
            return os.path.basename(p) == normalize_stem(stem) + ext

        rank = lambda p: (1 if has_records(p, kind) else 0,
                          1 if clean(p) else 0,
                          os.path.getmtime(p))
        chosen, other = ((candidate, current) if rank(candidate) > rank(current)
                         else (current, candidate))
        notes.append(f'同一场有 {os.path.relpath(other, HERE)} 和 '
                     f'{os.path.relpath(chosen, HERE)} 两份同类文件 → '
                     f'用后者，忽略前者')
        return chosen

    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '__pycache__']
        for name in sorted(filenames):
            kind, cid = identify(name)
            if not kind:
                p = os.path.join(dirpath, name)
                if looks_like_misnamed_input(p, name):
                    unknown.append(os.path.relpath(p, HERE))
                continue
            full = os.path.join(dirpath, name)
            if kind == 'contests':
                found.setdefault('_contests', []).append(full)
                continue
            if kind == 'submitbundle':
                # 提交包是"源"，不是输入：它得先被 Hdu_submit_scraper.py 解析成 JSON。
                # 这里只登记，稍后提示（不猜优先级、不自动覆盖已有 JSON）。
                slot(cid)['submitbundles'].append(full)
                continue
            slot(cid)[kind] = pick(slot(cid)[kind], full, kind)

    found['_notes'] = notes
    found['_unknown'] = unknown
    return found


# ================================================================
# 主流程
# ================================================================

def prepare(cid: str, files: dict, dry: bool,
            keep_source: bool = False) -> tuple[str, list[str]]:
    """
    把某场的榜单跑成"统计 JSON"（写在榜单 HTML 旁边），成功后删掉榜单 HTML。

    @returns (统计文件路径 或 '', 要传给适配器的题目/提交文件列表)
    """
    rel = lambda p: os.path.relpath(p, HERE)
    if files['rank']:
        rank_line = rel(files['rank'])
    elif files['rankstats'] and has_records_stats(files['rankstats']):
        rank_line = f'(榜单 HTML 已删；用现成的 {os.path.basename(files["rankstats"])})'
    else:
        rank_line = '(无 → 没有赛时通过率)'
    print(f'\n=== cid={cid} ===')
    print(f'   题目 : {rel(files["problems"]) if files["problems"] else "(缺 ❌)"}')
    print(f'   提交 : {rel(files["submits"]) if files["submits"] else "(无)"}')
    print(f'   榜单 : {rank_line}')

    if not files['problems']:
        print('   ⚠️ 没有题目文件，跳过这一场')
        return '', []

    stat_path = ''
    if files['rank']:
        # 统计 JSON 落在**榜单 HTML 旁边**（整场的东西放一起，拿一个目录就能搬走）。
        # 名字也走同一条规范：hdu_cid<CID>_rank_stats.json
        stat_path = os.path.join(os.path.dirname(files['rank']),
                                 f'hdu_cid{cid}_rank_stats.json')
        py = sys.executable
        # 榜单解析只用来打印交叉校验摘要（三方 AC 计数对得上），
        # **不写每队明细文件** —— 那东西 800KB 一份、没人消费，
        # 随时能用 `lib/hdu_rank_parser.py <html> -o <out>` 重新生成。
        if run([py, os.path.join(LIB, 'hdu_rank_parser.py'), files['rank']], dry) != 0:
            print('   ❌ 榜单解析失败，**保留榜单 HTML**')
            return '', []
        if run([py, os.path.join(LIB, 'hdu_rank_stats.py'),
                files['rank'], '-o', stat_path], dry) != 0:
            print('   ❌ 赛时统计失败，**保留榜单 HTML**')
            return '', []
        # 统计出来了 → 榜单 HTML（一份 7MB）没用了。
        # 同样只在统计确实有数据时才删。
        if not dry and has_records_stats(stat_path):
            delete_source(files['rank'], '已算出赛时统计', keep_source)
        elif not dry:
            print(f'   ⚠️ 统计为空，**保留榜单 HTML**：{rel(files["rank"])}')
    elif files['rankstats'] and has_records_stats(files['rankstats']):
        # 榜单 HTML 已经被删了（或你手工删的）—— **直接用算好的统计**。
        # 这一支是"自动删源"能成立的前提：统计 JSON 才是留下来的那份，
        # 少了它，删掉 HTML 就等于把 ratio 一起丢了（真踩过）。
        stat_path = files['rankstats']
        print(f'   榜单 : 已删除；改用现成的 {os.path.basename(stat_path)}')

    inputs = [files['problems']] + ([files['submits']] if files['submits'] else [])
    return stat_path, inputs


def build_crate(cids: list[str], plan: dict, out: str, dry: bool,
                contests_files: list[str] | None = None) -> bool:
    """把若干场的输入合成一个导入包"""
    inputs: list[str] = []
    stats: list[str] = []
    for cid in cids:
        stat_path, files = plan[cid]
        inputs += files
        if stat_path:
            stats.append(stat_path)

    if not inputs:
        print('\n❌ 没有可用的题目文件，未生成导入包')
        return False

    cmd = [sys.executable, os.path.join(HERE, 'hdu_adapter.py')]
    contests = (contests_files or [None])[0] or os.path.join(HERE, 'Hdu_contests.json')
    if os.path.isfile(contests):
        cmd.append(contests)
    cmd += inputs + ['-o', out, '--only-used-contests']
    if stats:
        cmd += ['--rank-stats'] + stats
    # 账户线索：`me.json` 的 `hdu.handles` / 花名册 `team[].hdu` / 单个 `hdu.handle`
    # （**不给也照样出包**，只是提交不带线索）。
    # ⚠️ 多人时**归属不靠顺序**：必须在 `me.json` 写 `hdu.files`
    #    （`{"hdu_cid1229_submits.json": "我"}`）或给适配器 `--file-handle`。
    #    这里只负责把名字传下去；没绑定文件的那些**一条线索都不打**并告警。
    hs = hdu_handles()
    if hs:
        cmd += ['--handle', ','.join(hs)]
        if len(hs) > 1:
            print(f'   账户线索：{len(hs)} 个 HDU 账号（{", ".join(hs)}）'
                  f' —— 归属要在 me.json 的 `hdu.files` 里绑定（或给 --file-handle）')
    if run(cmd, dry) != 0:
        print('   ❌ 生成导入包失败')
        return False
    print(f'   ✅ 完成 → {os.path.relpath(out, REPO)}')
    return True


def main(argv):
    ap = argparse.ArgumentParser(description='HDU 全自动流水线')
    ap.add_argument('cid', nargs='?', help='比赛 ID；或用 --all')
    ap.add_argument('--all', action='store_true', help='处理所有能凑齐输入的场次')
    ap.add_argument('-o', '--out', default=DEFAULT_OUT, help='输出导入包路径')
    ap.add_argument('--per-contest', action='store_true',
                    help='每场单独出一个包 hdu-<cid>.json（默认合成一个）')
    ap.add_argument('--dry-run', action='store_true', help='只打印将执行的命令')
    ap.add_argument('--keep-source', action='store_true',
                    help='保留源 HTML（默认解析成功后自动删掉；榜单一份 7MB）')
    args = ap.parse_args(argv)

    if not args.cid and not args.all:
        ap.error('请给一个 cid，或用 --all')

    # ---- 0. 先把源 HTML 解析掉（产出写在源旁边；成功后删源）----
    ingest_sources(args.dry_run, args.keep_source)

    found = discover()
    notes = found.pop('_notes', [])
    ambiguous = found.pop('_unknown', [])
    contests_files = found.pop('_contests', [])
    submitbundles = {c: v['submitbundles'] for c, v in found.items() if v.get('submitbundles')}

    # 扫到的"杂音"要说清楚 —— 静默忽略最难查
    if notes:
        print(f'ℹ️  {len(notes)} 条取名/归属说明：')
        for n in notes:
            print(f'   • {n}')
        print()
    if ambiguous:
        print(f'⚠️  {len(ambiguous)} 份文件像是数据、但名字不符合规范（已跳过）：')
        for a in ambiguous:
            print(f'   • {a}')
        print('   规范只有一条：`hdu_cid<CID>_<种类>.json|.html`'
              '（种类 = problems / submits / rank / submit），'
              '比赛列表例外：`hdu_contests.json`')
        print('   （你自己存的页面 HTML 叫什么、放哪都行 —— 它用 -i 传给爬虫，'
              '流水线不看它；这里只列"像是流水线输入"的文件）')
        print()

    if submitbundles:
        # 只在"这场还没有提交数据"时才提示去解析 —— 否则给的就是误导
        need = {cid: paths for cid, paths in submitbundles.items()
                if not found.get(cid, {}).get('submits')}
        have = {cid: paths for cid, paths in submitbundles.items() if cid not in need}
        if need:
            print('📦 发现了提交包（HTML 源），但**它还没被解析**，这次不会用上：')
            for cid, paths in sorted(need.items(), key=lambda kv: kv[1][0]):
                for p in paths:
                    print(f'   cid={cid}: {os.path.relpath(p, HERE)}')
                    print(f'      python "acm-data/raw/Scaper/02 hdu/Hdu_submit_scraper.py" '
                          f'-i "{os.path.relpath(p, REPO)}"')
            print()
        if have:
            names = ', '.join(os.path.relpath(p, HERE) for paths in have.values() for p in paths)
            print(f'ℹ️  这些提交包已有对应的提交 JSON，未使用：{names}')
            print('   （想用包里的版本重导，就先给现有 hdu_cid<CID>_submits.json 改名或删掉）')
            print()

    if not found:
        print('❌ 没找到任何可用输入。')
        print('   规范只有一条：`hdu_cid<CID>_<种类>.json|.html`')
        print('   种类 = problems / submits / rank / submit；比赛列表是 `hdu_contests.json`。')
        print(f'   放在 {HERE} 下的**任意深度**都行（目录名不参与识别）。')
        return 1

    print(f'📂 发现 {len(found)} 场：')
    for cid in sorted(found, key=lambda c: int(c) if c.isdigit() else 0):
        f = found[cid]
        marks = [m for m, k in (('题目', 'problems'), ('提交', 'submits'),
                                ('榜单', 'rank')) if f[k]]
        # 榜单 HTML 删掉后统计还在 —— 那就是 ratio，必须在这里体现出来，
        # 否则 `[题目 + 提交]` 看起来像"没有通过率"。
        if not f['rank'] and f.get('rankstats') and has_records_stats(f['rankstats']):
            marks.append('通过率')
        print(f'   cid={cid}  [{" + ".join(marks)}]')

    if args.all:
        targets = sorted(found, key=lambda c: int(c) if c.isdigit() else 0)
    else:
        if args.cid not in found:
            print(f'\n❌ cid={args.cid} 没有可用输入。上面列出了可用的场次。')
            return 1
        targets = [args.cid]

    # ---- 每场先跑榜单 ----
    plan: dict[str, tuple[str, list[str]]] = {}
    for cid in targets:
        plan[cid] = prepare(cid, found[cid], args.dry_run, args.keep_source)

    # ---- 再合成导入包 ----
    ok = True
    if args.per_contest:
        groups = [[cid] for cid in targets]
    else:
        groups = [targets]

    for group in groups:
        out = args.out
        if args.per_contest:
            stem, ext = os.path.splitext(args.out)
            out = f'{stem}-{group[0]}{ext}'
        print(f'\n=== 生成导入包（{"、".join("cid=" + c for c in group)}）===')
        if not build_crate(group, plan, out, args.dry_run, contests_files):
            ok = False

    print(f'\n{"（dry-run，未实际执行）" if args.dry_run else ""}'
          f'完成 {len(targets)} 场的预处理'
          + ('（每场一个包）' if args.per_contest else
             f' → {os.path.relpath(args.out, REPO)}'))
    if ok and not args.dry_run:
        stem, ext = os.path.splitext(args.out)
        hint = f'{stem}-<cid>{ext}' if args.per_contest else args.out
        print(f'下一步：npm run crate:check -- {os.path.relpath(hint, REPO)}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
