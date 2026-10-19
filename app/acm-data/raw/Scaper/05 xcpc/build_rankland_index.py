#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
建 **rankland 跨平台索引**：一场比赛 ↔ 它在各平台的 id

为什么要有它
---------------------------------------
"同一场在不同平台的信息要**尽可能整合成一场**"。rankland 的 srk 文件恰好就是那张对照表：

    contest.title       中文赛名（比 CF gym 的英文名友好）
    contest.refLinks[]  原始榜单链接 → 多是 `pintia.cn/rankings/<id>`（PTA）、官方公示 PDF
    problems[].link     补题链接   → `codeforces.com/gym/<号>/problem/<X>` 或 `qoj.ac/problem/<pid>`

于是"CF gym 102361"与"rankland 的 ccpc2019qinhuangdao"是同一场 —— 可以给它们**一个身份**、
把题名/榜单/提交都挂在同一场下，而不是当成两场。

⚠️ 只取**文件头部**：`problems` 在 JSON 最前面（实测 title@65B、problems@1.8KB、rows@5KB），
   所以用 HTTP Range 取前 200KB 就够；394 场约 78MB，而不是整份 5–8MB（≈2.5GB）。

产出：`cache/rankland_index.json`
    bySlug         slug → { title, startAt, series, mid, gyms, qojProblems, ptaRankings, refs, problems }
    byGym          gym 号 → slug      （**同一场整合**的关键：CF 那边用它反查 rankland 身份）
    byProblem      qoj 题目 id → slug （QOJ 提交按题目 id 归到这场，不必知道 QOJ 比赛号）

用法
----
    python build_rankland_index.py                # 增量：已抓过的 slug 跳过
    python build_rankland_index.py --limit 20     # 先试 20 场
    python build_rankland_index.py --force        # 全部重抓（把已有索引当不存在）

（读取开关 `--cache-mode/--retry-mode/--force` 来自通用层 `Scaper/lib/read_modes.py`。）
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # Scaper/lib（通用读取层）

from rankland_tree import fetch_config_text, iter_contests  # noqa: E402
from read_modes import print_stats, add_cli_args, configure_from, should_refetch  # noqa: E402
from xcpc_common import CACHE, rel, title_of, write_json  # noqa: E402

RAW_HOSTS = [
    # 实测：raw 国内必被重置（19–83s 白等）；jsdelivr/gcore 无视 Range 回整份 ~1MB；
    # fastly 严格按 Range 只回 200KB、0.6s。所以按"快且省流量"排序，raw 放最后兜底。
    'https://fastly.jsdelivr.net/gh/algoux/srk-collection@master/',
    'https://gcore.jsdelivr.net/gh/algoux/srk-collection@master/',
    'https://cdn.jsdelivr.net/gh/algoux/srk-collection@master/',
    'https://raw.githubusercontent.com/algoux/srk-collection/master/',
]
UA = {'User-Agent': 'acm-tree/xcpc'}
# 分档取头部：多数场次 24KB 就够（省流量），不够自动升档，不会丢数据
HEAD_TIERS = (24_000, 64_000, 200_000)
OUT = os.path.join(CACHE, 'rankland_index.json')

GYM_RE = re.compile(r'codeforces\.com/gym/(\d+)')
# QOJ 有两种题面链接：qoj.ac/contest/<cid>/problem/<pid>（主流）与 qoj.ac/problem/<pid>
QOJ_PROB_RE = re.compile(r'qoj\.ac/(?:contest/\d+/)?problem/(\d+)')
QOJ_CONTEST_RE = re.compile(r'qoj\.ac/contest/(\d+)')
PTA_RE = re.compile(r'pintia\.cn/rankings/(\d+)')
NC_RE = re.compile(r'(?:ac\.)?nowcoder\.com/(?:acm/)?contest/(\d+)')
LUOGU_RE = re.compile(r'luogu\.com\.cn/(?:problem|contest)/([A-Za-z0-9_]+)')


HOST_STATS: dict[str, list] = {}      # host → [成功, 失败, 累计秒]（跑完打印，好知道该留哪个源）


def _head_enough(text: str) -> bool:
    """
    这段头部够用了吗？（`problems` 完整、且已经看到 `refLinks`）

    实测 `title@65B`、`problems@1.8KB`、`rows@5KB` —— 真正要的东西都在**前 10KB 以内**，
    所以 200KB 是远远过量的。分档取：先 24KB，不够再往上加。
    """
    if '"problems"' not in text:
        return False
    if '"rows"' in text:
        return True                     # 已经越过题单，说明题单是完整的
    try:
        return len(_slice_json_array(text, 'problems')) > 0
    except Exception:                   # noqa: BLE001 —— 截断的 JSON，说明不够
        return False


def _get_head(repo_path: str, timeout: int = 15) -> str:
    """
    按 Range 取文件头部（`problems` 在最前面，够用）。

    实测：raw 必被重置且要等十几秒到一分多钟才报错，所以它排最后；
    fastly 支持 Range（只回 200KB），jsdelivr/gcore 会无视 Range 回整份 ~1MB。
    每个源**只试一次**（换源才是常态，重试只会把时间浪费在挂起的连接上）。

    **分档取**（`HEAD_TIERS`）：多数场次 24KB 就够（省 88% 流量）；不够自动升档到 200KB，
    所以不会因为取小了而丢数据。⚠️ 时间上几乎一样 —— 大小不是瓶颈，每次请求的握手/排队才是
    （实测同一场：200KB 与 600KB 都是 0.6s）。
    """
    last = None
    for host in RAW_HOSTS:
        for size in HEAD_TIERS:
            t0 = time.time()
            st = HOST_STATS.setdefault(host, [0, 0, 0.0])
            try:
                req = urllib.request.Request(host + repo_path,
                                             headers={**UA, 'Range': f'bytes=0-{size}'})
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    text = r.read().decode('utf-8', errors='replace')
                if '"problems"' not in text and '"contest"' not in text:
                    raise RuntimeError('返回内容不含 contest/problems')
                if not _head_enough(text) and size != HEAD_TIERS[-1]:
                    raise RuntimeError(f'{size // 1000}KB 不够（题单被截断）')
                st[0] += 1
                st[2] += time.time() - t0
                return text
            except Exception as e:  # noqa: BLE001 —— 换源/升档是正常路径
                st[1] += 1
                st[2] += time.time() - t0
                last = e
    raise RuntimeError(f'{repo_path}: {last}')


def _slice_json_array(text: str, key: str) -> list:
    """
    从**被截断的 JSON** 里抠出 `"key": [ ... ]` 这一段（配对方括号，忽略字符串里的括号）。

    为什么不直接 `json.loads`：头部只有 120KB，`rows` 之后的内容不在里面，
    整段不是合法 JSON。而 `problems` 在 `rows` **之前**，所以这一段是完整的。
    """
    i = text.find(f'"{key}"')
    if i < 0:
        return []
    i = text.find('[', i)
    if i < 0:
        return []
    depth = 0
    in_str = False
    esc = False
    for j in range(i, len(text)):
        ch = text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[i:j + 1])
                except ValueError:
                    return []
    return []


def _slice_json_object(text: str, key: str) -> dict:
    """抠出 `"key": { ... }`（同上，配对花括号）"""
    i = text.find(f'"{key}"')
    if i < 0:
        return {}
    i = text.find('{', i)
    if i < 0:
        return {}
    depth = 0
    in_str = False
    esc = False
    for j in range(i, len(text)):
        ch = text[j]
        if in_str:
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[i:j + 1])
                except ValueError:
                    return {}
    return {}


def extract(text: str) -> dict:
    contest = _slice_json_object(text, 'contest')
    problems = _slice_json_array(text, 'problems')
    refs = contest.get('refLinks') if isinstance(contest.get('refLinks'), list) else []

    gyms, qoj_problems, qoj_contests, pta, nowcoder = set(), set(), set(), set(), set()
    luogu = set()
    prob_list = []
    for p in problems:
        p = p or {}
        link = str(p.get('link') or '')
        alias = str(p.get('alias') or '')
        pt = p.get('title')
        if isinstance(pt, dict):
            pname = str(pt.get('zh-CN') or pt.get('fallback') or '').strip()
        else:
            pname = str(pt or '').strip()
        prob_list.append({'alias': alias, 'title': pname, 'link': link})
        for rx, bag in ((GYM_RE, gyms), (QOJ_PROB_RE, qoj_problems), (QOJ_CONTEST_RE, qoj_contests),
                        (PTA_RE, pta), (NC_RE, nowcoder), (LUOGU_RE, luogu)):
            m = rx.search(link)
            if m:
                bag.add(m.group(1))
    ref_links = []
    for r in refs:
        link = str((r or {}).get('link') or '')
        ref_links.append({'link': link, 'title': str((r or {}).get('title') or '')})
        for rx, bag in ((GYM_RE, gyms), (PTA_RE, pta), (QOJ_CONTEST_RE, qoj_contests), (NC_RE, nowcoder),
                        (LUOGU_RE, luogu)):
            m = rx.search(link)
            if m:
                bag.add(m.group(1))

    return {
        'title': title_of(contest),
        'startAt': contest.get('startAt', ''),
        'gyms': sorted(gyms),
        'qojProblems': sorted(qoj_problems, key=lambda x: int(x)),
        'qojContests': sorted(qoj_contests),
        'ptaRankings': sorted(pta),
        'nowcoder': sorted(nowcoder),
        'luogu': sorted(luogu),
        'refs': ref_links,
        'problems': prob_list,
        'problemCount': len(problems),
    }


def main(argv):
    ap = argparse.ArgumentParser(description='rankland 跨平台索引')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--sleep', type=float, default=0.15)
    add_cli_args(ap)                  # --cache-mode/--retry-mode/--force（通用层）
    args = ap.parse_args(argv)
    configure_from(args)              # 必须在下面任何读缓存/联网之前

    contests = iter_contests(fetch_config_text())
    print(f'rankland 树里 {len(contests)} 场')

    old = {}
    # 已有索引就是这份抓取的缓存：`--force` / `--cache-mode none` 时当成不存在
    #（= 老的 `--refresh` 行为：bySlug 从空开始、全部重抓）
    if not should_refetch(os.path.isfile(OUT)):
        with open(OUT, 'r', encoding='utf-8') as f:
            old = (json.load(f).get('bySlug') or {})

    todo = [c for c in contests if c['slug'] not in old]
    if args.limit:
        todo = todo[:args.limit]
    print(f'要抓 {len(todo)} 场（已有 {len(old)} 场，增量跳过）')

    by_slug = dict(old)
    failed = []
    consec = 0
    t_start = time.time()
    last_doc: dict = {}

    def dump() -> dict:
        nonlocal last_doc
        bg, bp = {}, {}
        for s, i in by_slug.items():
            for g in i.get('gyms') or []:
                bg.setdefault(g, s)
            for pid in i.get('qojProblems') or []:
                bp.setdefault(pid, s)
        last_doc = {
            'generatedAt': datetime.now(timezone.utc).astimezone().strftime('%Y.%m.%d %H:%M'),
            'note': [
                'rankland 的跨平台索引：一场 ↔ 它在各平台的 id。',
                'gyms / qojProblems / qojContests / ptaRankings / nowcoder / luogu 取自题目链接与 refLinks。',
                '只抓了文件头部（problems 在最前面），所以没有 rows（榜单行）—— 那部分按需再抓。'
                f'共 {len(by_slug)} 场（本次跑到第 {n_done} 场）。',
            ],
            'bySlug': by_slug,
            'byGym': bg,
            'byProblem': bp,
        }
        return last_doc

    n_done = 0
    for n, c in enumerate(todo, 1):
        try:
            text = _get_head(c['repo_path'])
            info = extract(text)
            info.update({
                'series': c['series'], 'seriesName': c.get('series_name', ''),
                'mid': c.get('mid', ''), 'midName': c.get('mid_name', ''),
                'ranklandName': c.get('name', ''), 'repoPath': c['repo_path'],
            })
            by_slug[c['slug']] = info
            consec = 0
        except Exception as e:
            failed.append((c['slug'], str(e)[:80]))
            consec += 1
            if consec >= 8:
                print(f'❌ 连续 {consec} 场抓不到 —— 多半是网络/镜像整段挂了，先停下来。'
                      '（已抓到的部分会存盘，重跑会增量续）')
                break
        n_done = n
        if n % 25 == 0 or n == len(todo):
            dt = time.time() - t_start
            hosts = '、'.join(f'{h.split("/")[2].split(".")[0]} {a[0]}/{a[0] + a[1]}'
                              f'({a[2] / max(a[0] + a[1], 1):.1f}s)' for h, a in HOST_STATS.items())
            print(f'   … {n}/{len(todo)}（失败 {len(failed)}，{dt:.0f}s，{dt / n:.1f}s/场）{hosts}')
            write_json(OUT, dump())        # 增量落盘：中途断掉不用从头再来

    write_json(OUT, dump())

    if HOST_STATS:
        print('   各源表现：' + '、'.join(
            f'{h.split("/")[2]} 成功{a[0]}/失败{a[1]} {a[2]:.0f}s' for h, a in HOST_STATS.items()))

    with_multi = sum(1 for i in by_slug.values() if len(i.get('gyms') or []) and (i.get('qojProblems') or []))
    print(f'✅ {rel(OUT)}')
    print(f'   {len(by_slug)} 场 | 有 gym 号的 {len(last_doc["byGym"])} 场 | QOJ 题号可归场的 '
          f'{len(last_doc["byProblem"])} 场 | gym+QOJ 双平台都有 {with_multi} 场')
    if failed:
        print(f'   ⚠️ 失败 {len(failed)} 场：{", ".join(s for s, _ in failed[:8])}'
              + (' …' if len(failed) > 8 else ''))
    print('   下一步：python gen_gym_manifest.py   # 用索引把 gym 场次换成 rankland 身份（同一场 = 一条目）')
    print_stats('rankland 索引')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
