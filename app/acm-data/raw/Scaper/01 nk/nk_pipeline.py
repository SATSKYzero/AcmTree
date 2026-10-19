#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
牛客（Nowcoder）全自动流水线（源 HTML → JSON → 导入包，一条命令）

用法
----
    npm run crate:nk                 # 等价于下面这条
    python "acm-data/raw/Scaper/01 nk/nk_pipeline.py" --all

    npm run crate:nk:keep            # 同上，但**保留**源 HTML（默认解析后删掉）
    python "…/nk_pipeline.py" 133877 # 只处理某一场
    python "…/nk_pipeline.py" --all --dry-run   # 只看要做什么

它按顺序做这些事
----------------
    1. **自动解析**源 HTML（`*_source.html` / `*_submit.html`）→ 同目录的 JSON，
       解析成功后删掉源（`--keep-source` 可关）
    2. 对每场有完整榜单的，算出 `nk_cid<CID>_rank_stats.json`（ratio 的来源），
       然后删掉那份 9MB 的榜单 JSON
    3. 把各场的 比赛身份 + 题目 + 提交 + 统计 合成**一个**导入包
       `acm-data/nodes/nk-multi-university.json`

它会认哪些输入（**只有一条命名规则**）
--------------------------------------
    nk_cid<CID>_<种类>.json / .html
    种类 = problems | submits | contest | rank_stats | rank | submit

文件放在本目录下的**任意深度**都行 —— 身份写在名字里，目录不参与识别。

它**不会**帮你爬数据 —— 抓取仍由你手动做（见 _usage.md）。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
NODES = os.path.join(REPO, 'acm-data', 'nodes')
LIB = os.path.join(HERE, 'lib')
#: ⚠️ **本脚本不写 `nk-multi-university.json`**：
#: 那份**牛客多校正式包**由 **`05 xcpc/nk_multi_fetch.py build --from-year 2023`** 出
#: （40 场 / 2358 节点，原料在 `05 xcpc/cache/nk/`，走牛客的 JSON 接口）。
#: 这个脚本是**浏览器手爬那条路**（原料在 `01 nk/2026/`，只有 10 场）—— 两条路**都写同一个
#: 文件**时，后跑的会把先跑的**静默缩小**（实测：把 2358 条覆盖成 442 条，谁也看不出来）。
#: ⇒ 各写各的文件：这里输出 `nk-browser.json`。
DEFAULT_OUT = os.path.join(NODES, 'nk-browser.json')

# 不要生成 __pycache__（下面要 import lib/nk_common.py）
sys.dont_write_bytecode = True

sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # …/Scaper/lib
from pipeline_common import delete_source as _delete_source, run as _run  # noqa: E402

# ---- 接上公共工具（lib/nk_common.py）----
# 文件名识别规则（identify / normalize_stem）只有那一份，流水线只是使用者
sys.path.insert(0, LIB)
from nk_common import identify, normalize_stem, read_json  # noqa: E402


def nk_handles() -> list[str]:
    """
    **要认领的牛客账号**（可以多个）—— 读取实现**只有 `Scaper/lib/me.py:handles()` 一份**。

    ⚠️ 只读**单数** `nk.handle` 时，`me.json` 里写成 `nk.handles: [...]` 或花名册 `team[].nk`，
    **流水线根本不知道**（适配器支持多人，而自动跑的那条路只传一个名字）。
    所以一律走 `me.handles('nk')`：`nk.handles` 列表 → 花名册 `team[].nk` → 单个 `nk.handle`。

    ★ **不再兜底**（2026-10-16，用户定的口径："② 干脆别兜底"）：原来 `me.py` 导不进来时会
      自己解析 `me.json`，而那段只读 `nk.handles` + 单数 `nk.handle`、**不认花名册** ⇒
      会**静默缩小认领范围**（队友的提交不带账户线索 —— 正是这一层最恨的"静默少数据"）。
      现在导不进来就**当场停**并说清修哪儿（与"凭据过期就当场停"同一条姿态）。
    """
    shared = os.path.abspath(os.path.join(HERE, '..', 'lib'))
    if shared not in sys.path:
        sys.path.insert(0, shared)
    try:
        import me as me_mod
    except ImportError as err:
        sys.exit(f'❌ 读不到 {shared}{os.sep}me.py（{err}）—— 这里**不自己解析 me.json**：'
                 f'认领范围（含花名册）只有那一份实现，兜底会静默缩小范围。修好这个 import 再跑。')
    return [h for h in (me_mod.handles('nk') or []) if h]


def nk_handle() -> str:
    """
    单数版本（兼容调用）：返回第一个账号。

    多人请用 `nk_handles()` —— 只拿第一个会让队友的提交不带账户线索。
    """
    hs = nk_handles()
    return hs[0] if hs else ''


def run(cmd: list[str], dry: bool) -> int:
    """跑一个子命令（dry-run 时只打印）—— 实现在 `Scaper/lib/pipeline_common.py`"""
    return _run(cmd, dry, REPO)


# ================================================================
# 小工具：判定"产出有没有数据" / 删源
# ================================================================

def has_records(path: str, kind: str) -> bool:
    """
    这份 JSON **真的有数据**吗？

    两个用途：
      1. 同一个 cid 有多个候选时"非空"优先 —— 否则一个残留的空文件会把
         真正有数据的顶掉，而且悄无声息；
      2. 决定**能不能删源** —— 只有产出确实有数据才敢删。
    """
    try:
        data = read_json(path)
    except Exception:
        return False
    if kind == 'contest':
        return isinstance(data, dict) and bool(data.get('contestName'))
    if kind == 'rankstats':
        return (isinstance(data, dict) and bool(data.get('problems'))
                and int(data.get('effectiveTeams') or 0) > 0)
    return isinstance(data, list) and len(data) > 0


def delete_source(source: str, why: str, keep: bool):
    """删掉已经"榨干"的源文件（实现在 `Scaper/lib/pipeline_common.py`）"""
    _delete_source(source, why, keep, HERE)


# ================================================================
# 源 HTML → JSON（自动）
# ================================================================

def find_source_jobs() -> dict:
    """
    扫出"哪些源文件还没被解析"，返回 {目标 JSON: (源文件, 解析脚本, 产出种类)}。

    规则表：
        nk_cid<CID>_problems_source.html → nk_cid<CID>_problems.json
        nk_cid<CID>_submits_source.html  → nk_cid<CID>_submits.json
        nk_cid<CID>_submit.html          → nk_cid<CID>_submits.json（多页包）

    同一份产出撞到多个源时取**更新的那个**（输出里会写出用的是谁）。
    """
    best: dict[str, tuple[str, str, str]] = {}

    def offer(target: str, source: str, script: str, kind: str):
        old = best.get(target)
        if old and os.path.getmtime(old[0]) >= os.path.getmtime(source):
            return
        best[target] = (source, script, kind)

    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '__pycache__']
        for name in filenames:
            low = name.lower()
            if not low.endswith('.html'):
                continue
            full = os.path.join(dirpath, name)
            stem = normalize_stem(os.path.splitext(name)[0])

            # ⚠️ 源文件的名字里带 `_source`，**不在** identify() 的规范表里
            # （它认的是"流水线输入"那几种），所以这里单独用正则认。
            # 若写成 `identify(...) == 'problems' and stem.endswith('_source')`，
            # 前半句永远为假 → 自动解析不会被触发。
            m = re.fullmatch(r'nk_cid(\d+)_problems_source', stem, re.I)
            if m:
                cid = m.group(1)
                offer(os.path.join(dirpath, f'nk_cid{cid}_problems.json'),
                      full, 'Nowcoder_prob_scraper.py', 'problems')
                continue
            m = re.fullmatch(r'nk_cid(\d+)_submits_source', stem, re.I)
            if m:
                cid = m.group(1)
                offer(os.path.join(dirpath, f'nk_cid{cid}_submits.json'),
                      full, 'Nowcoder_submit_scraper.py', 'submits')
                continue
            kind, cid = identify(stem + '.html')
            if kind == 'submitbundle':
                offer(os.path.join(dirpath, f'nk_cid{cid}_submits.json'),
                      full, 'Nowcoder_submit_scraper.py', 'submits')
    return best


def ingest_sources(dry: bool, keep_source: bool = False) -> int:
    """把源 HTML 自动解析成 JSON（写在源旁边），成功后删掉源"""
    jobs = find_source_jobs()
    todo = []
    for target, (source, script, kind) in sorted(jobs.items()):
        fresh = os.path.isfile(target) and os.path.getmtime(target) >= os.path.getmtime(source)
        if fresh:
            if has_records(target, kind):
                delete_source(source, '产出已是最新', keep_source)
            continue
        todo.append((target, source, script, kind))
    if not todo:
        return 0

    print(f'📥 自动解析源文件（{len(todo)} 个）：')
    for target, source, script, kind in todo:
        print(f'   {os.path.relpath(source, HERE)}  →  {os.path.basename(target)}')
        if run([sys.executable, os.path.join(HERE, script), '-i', source], dry) != 0:
            print(f'   ❌ 解析失败，**保留源文件**：{os.path.relpath(source, HERE)}')
            continue
        if dry:
            continue
        if has_records(target, kind):
            delete_source(source, f'已解析成 {os.path.basename(target)}', keep_source)
        else:
            print(f'   ⚠️ 产出为空/不存在，**保留源文件**：{os.path.relpath(source, HERE)}')
    print()
    return len(todo)


# ================================================================
# 发现输入
# ================================================================

def discover() -> dict:
    """
    **递归**扫描本目录（跳过隐藏目录与 __pycache__），按 cid 汇总可用输入。

    身份完全来自文件名（`nk_cid<CID>_<种类>`），所以文件放哪都行。

    @returns { cid: {problems, submits, contest, rank, rankstats, submitbundles} }
    """
    found: dict[str, dict] = {}
    notes: list[str] = []
    unknown: list[str] = []

    def slot(cid: str) -> dict:
        return found.setdefault(cid, {'problems': '', 'submits': '', 'contest': '',
                                      'rank': '', 'rankstats': '', 'submitbundles': []})

    def pick(current: str, candidate: str, kind: str = '') -> str:
        """同一场撞到多份同类文件时选一个：有内容 > 名字干净 > 更新；并记一条提示"""
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
                     f'{os.path.relpath(chosen, HERE)} 两份同类文件 → 用后者，忽略前者')
        return chosen

    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if not d.startswith('.') and d != '__pycache__']
        for name in sorted(filenames):
            kind, cid = identify(name)
            if not kind:
                low = name.lower()
                # 只提醒"像流水线输入但名字不对"的 json（源 HTML 名字本来就随便）
                if low.endswith('.json') and not low.startswith('_'):
                    unknown.append(os.path.relpath(os.path.join(dirpath, name), HERE))
                continue
            full = os.path.join(dirpath, name)
            if kind == 'submitbundle':
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
    把某场的榜单跑成统计 JSON（写在榜单旁边），成功后删掉榜单 JSON。

    @returns (统计文件路径 或 '', 要传给适配器的文件列表)
    """
    rel = lambda p: os.path.relpath(p, HERE) if p else '(缺 ❌)'
    if files['rank']:
        rank_line = rel(files['rank'])
    elif files['rankstats'] and has_records(files['rankstats'], 'rankstats'):
        rank_line = f'(榜单已删；用现成的 {os.path.basename(files["rankstats"])})'
    else:
        rank_line = '(无 → 没有赛时通过率)'

    print(f'\n=== cid={cid} ===')
    print(f'   题目 : {rel(files["problems"])}')
    print(f'   比赛 : {rel(files["contest"]) if files["contest"] else "(无 → 名字/系列会退化 ⚠️)"}')
    # 提交可以现在没有、以后才补，所以写 `(无)` 而不是 `(缺 ❌)`：
    # 它只是"这一场目前没有提交数据"的中性提示，不是操作失误。
    print(f'   提交 : {rel(files["submits"]) if files["submits"] else "(无)"}')
    print(f'   榜单 : {rank_line}')

    if not files['problems']:
        print('   ⚠️ 没有题目文件 —— 这场只会被跳过（榜单不会单独建出东西）')
        return '', []

    stat_path = ''
    if files['rank']:
        stat_path = os.path.join(os.path.dirname(files['rank']),
                                 f'nk_cid{cid}_rank_stats.json')
        if run([sys.executable, os.path.join(LIB, 'nk_rank_stats.py'),
                files['rank'], '-o', stat_path], dry) != 0:
            print('   ❌ 榜单统计失败，**保留榜单**')
            return '', []
        if not dry and has_records(stat_path, 'rankstats'):
            delete_source(files['rank'], '已算出赛时统计', keep_source)
        elif not dry:
            print(f'   ⚠️ 统计为空/不完整，**保留榜单**：{rel(files["rank"])}')
    elif files['rankstats'] and has_records(files['rankstats'], 'rankstats'):
        # 榜单被删之后 —— 统计 JSON 才是留下来的那份。这一支是"删源"能成立的前提：
        # 少了它，删掉榜单就等于把 ratio 一起丢了。
        stat_path = files['rankstats']

    inputs = []
    if files['contest']:
        inputs.append(files['contest'])
    inputs.append(files['problems'])
    if files['submits']:
        inputs.append(files['submits'])
    return stat_path, inputs


def build_crate(cids: list[str], plan: dict, out: str, dry: bool) -> bool:
    inputs: list[str] = []
    stats: list[str] = []
    for cid in cids:
        stat_path, files = plan[cid]
        inputs += files
        if stat_path:
            stats.append(stat_path)

    if not inputs:
        print('\n❌ 没有可用的输入，未生成导入包')
        return False

    cmd = [sys.executable, os.path.join(HERE, 'nk_adapter.py')] + inputs + ['-o', out]
    if stats:
        cmd += ['--rank-stats'] + stats
    # 账户线索：`me.json` 的 `nk.handles` / 花名册 `team[].nk` / 单个 `nk.handle`
    # （**不给也照样出包**，只是提交不带线索）。多人用逗号分隔一次传过去。
    hs = nk_handles()
    if hs:
        cmd += ['--handle', ','.join(hs)]
        if len(hs) > 1:
            print(f'   账户线索：{len(hs)} 个牛客账号（{", ".join(hs)}）')
    if run(cmd, dry) != 0:
        print('   ❌ 生成导入包失败')
        return False
    print(f'   ✅ 完成 → {os.path.relpath(out, REPO)}')
    return True


def main(argv):
    ap = argparse.ArgumentParser(description='牛客全自动流水线')
    ap.add_argument('cid', nargs='?', help='比赛 ID；或用 --all')
    ap.add_argument('--all', action='store_true', help='处理所有能凑齐输入的场次')
    ap.add_argument('-o', '--out', default=DEFAULT_OUT, help='输出导入包路径')
    ap.add_argument('--per-contest', action='store_true',
                    help='每场单独出一个包 nk-<cid>.json（默认合成一个）')
    ap.add_argument('--dry-run', action='store_true', help='只打印将执行的命令')
    ap.add_argument('--keep-source', action='store_true',
                    help='保留源文件（默认解析成功后自动删掉；榜单一份 9MB）')
    args = ap.parse_args(argv)

    if not args.cid and not args.all:
        ap.error('请给一个 cid，或用 --all')

    # ---- 0. 先把源文件解析掉（产出写在源旁边；成功后删源）----
    ingest_sources(args.dry_run, args.keep_source)

    found = discover()
    notes = found.pop('_notes', [])
    unknown = found.pop('_unknown', [])
    submitbundles = {c: v['submitbundles'] for c, v in found.items() if v.get('submitbundles')}

    if notes:
        print(f'ℹ️  {len(notes)} 条取名/归属说明：')
        for n in notes:
            print(f'   • {n}')
        print()
    if unknown:
        print(f'⚠️  {len(unknown)} 份 json 名字不符合规范（已跳过）：')
        for a in unknown:
            print(f'   • {a}')
        print('   规范只有一条：`nk_cid<CID>_<种类>.json|.html`'
              '（种类 = problems / submits / contest / rank / rank_stats / submit）')
        print()
    if submitbundles:
        need = {c: p for c, p in submitbundles.items() if not found.get(c, {}).get('submits')}
        have = {c: p for c, p in submitbundles.items() if c not in need}
        if need:
            print('📦 有提交包还没被解析（这次不会用上）：')
            for cid, paths in sorted(need.items()):
                for p in paths:
                    print(f'   cid={cid}: {os.path.relpath(p, HERE)}')
                    print('      python "acm-data/raw/Scaper/01 nk/Nowcoder_submit_scraper.py" '
                          f'-i "{os.path.relpath(p, REPO)}"')
            print()
        if have:
            names = ', '.join(os.path.relpath(p, HERE) for paths in have.values() for p in paths)
            print(f'ℹ️  这些提交包已有对应的提交 JSON，未使用：{names}')
            print()

    if not found:
        print('❌ 没找到任何可用输入。')
        print('   规范只有一条：`nk_cid<CID>_<种类>.json|.html`')
        print(f'   放在 {HERE} 下的**任意深度**都行（目录名不参与识别）。')
        return 1

    print(f'📂 发现 {len(found)} 场：')
    for cid in sorted(found, key=lambda c: int(c) if c.isdigit() else 0):
        f = found[cid]
        marks = [m for m, k in (('比赛名', 'contest'), ('题目', 'problems'),
                                ('提交', 'submits'), ('榜单', 'rank')) if f[k]]
        # 榜单删掉后统计还在 —— 那就是 ratio，必须体现出来，
        # 否则 `[题目 + 提交]` 看起来像"没有通过率"
        if not f['rank'] and f['rankstats'] and has_records(f['rankstats'], 'rankstats'):
            marks.append('通过率')
        print(f'   cid={cid}  [{" + ".join(marks) if marks else "（无）"}]')

    if args.all:
        targets = sorted(found, key=lambda c: int(c) if c.isdigit() else 0)
    else:
        if args.cid not in found:
            print(f'\n❌ cid={args.cid} 没有可用输入。上面列出了可用的场次。')
            return 1
        targets = [args.cid]

    plan: dict[str, tuple[str, list[str]]] = {}
    for cid in targets:
        plan[cid] = prepare(cid, found[cid], args.dry_run, args.keep_source)

    ok = True
    groups = [[cid] for cid in targets] if args.per_contest else [targets]
    for group in groups:
        out = args.out
        if args.per_contest:
            stem, ext = os.path.splitext(args.out)
            out = f'{stem}-{group[0]}{ext}'
        print(f'\n=== 生成导入包（{"、".join("cid=" + c for c in group)}）===')
        if not build_crate(group, plan, out, args.dry_run):
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
