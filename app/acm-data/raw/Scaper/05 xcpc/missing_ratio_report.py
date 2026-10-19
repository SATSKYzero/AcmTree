"""列出"**某个渠道**里没有 ratio 的场次"以及每场可用的榜单源 → 补齐待办清单。

⚠️ 口径："本渠道没有 ratio 就该抓，如 pta 有数据、xcpcio 没数据时要爬 xcpcio
   ⇒ 不要跨渠道树合并看，要**每个渠道自己看**。" 所以这里按渠道各出一段
（`xcpc_common.RATIO_CHANNELS`：xcpcio / pta / nk）。
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lib'))

from xcpc_common import RATIO_CHANNELS, ratio_counts, read_json  # noqa: E402

BASE = 'acm-data/raw/Scaper/05 xcpc'
idx = read_json(f'{BASE}/cache/rankland_index.json').get('bySlug') or {}

BP = re.compile(r'/rankings/|board\.xcpcio\.com|/standings|/rank\b|/board\b', re.I)
BT = re.compile(r'榜|排名|ranklist|rankings|scoreboard|board', re.I)


def board_refs(info):
    out = []
    for r in (info.get('refs') or []):
        link, title = str(r.get('link') or ''), str(r.get('title') or '')
        if link.startswith(('https://github.com/', 'http://github.com/')):
            continue
        if BP.search(link) or BT.search(title):
            out.append(link)
    return out


for channel in RATIO_CHANNELS:
    by = ratio_counts(channel)
    zero = sorted(s for s, (_t, ok) in by.items() if not ok)
    if not by:
        print(f'=== {channel}：这棵树里一场都没有（还没出过包？）===\n')
        continue

    groups = {'PTA 榜': [], 'CF gym 榜': [], '牛客榜': [], '无榜单源': []}
    for s in zero:
        info = idx.get(s) or {}
        pta = (info.get('ptaRankings') or [''])[0]
        gym = (info.get('gyms') or [''])[0]
        nc = (info.get('nowcoder') or [''])[0]
        br = board_refs(info)
        rec = {'slug': s, 'n': by[s][0], 'pta': pta, 'gym': gym, 'nc': nc,
               'ref': br[0] if br else ''}
        if pta:
            groups['PTA 榜'].append(rec)
        elif gym:
            groups['CF gym 榜'].append(rec)
        elif nc:
            groups['牛客榜'].append(rec)
        else:
            groups['无榜单源'].append(rec)

    print(f'=== {channel} 树：没有 ratio 的 {len(zero)} 场 / '
          f'{sum(by[s][0] for s in zero)} 题（该树共 {len(by)} 场）===')
    for g, rows in groups.items():
        if not rows:
            continue
        print(f'  --- {g}（{len(rows)} 场）---')
        for r in rows:
            extra = (f"pta={r['pta']}" if r['pta']
                     else (f"gym={r['gym']}" if r['gym'] else f"nc={r['nc']}"))
            print(f"    {r['slug']:34s} {r['n']:3d}题  {extra}  {r['ref'][:44]}")
    print()
