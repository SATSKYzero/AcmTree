#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
从 Codeforces 提交反推：打过哪些 gym → 生成/更新 `gym_whitelist.json`

它做什么
--------
    user.status?handle=<handle>            全部提交（公开，不用登录）
      → 按 contestId 分组，挑出 gym（id ≥ 100000）
    contest.list?gym=true                  gym 的名字 + 开赛时间（公开）
      → 生成白名单条目：id / name / year / 提交数 / AC 数 / include / why / slug

**幂等且尊重你的手改**：白名单已存在时，`include` / `slug` / `note` 沿用你改过的值
（只刷新 name / year / 提交数 / AC 数 / why）。

用法
----
    python fetch_my_gyms.py                 # 用 defaults.cfHandle（来自清单）
    python fetch_my_gyms.py --handle X      # 临时换 handle
    python fetch_my_gyms.py --refresh-classify   # 连 include 也按启发式重判
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))   # …/Scaper/lib

from cf_api import call  # noqa: E402
from me import cf_handle  # noqa: E402
from xcpc_common import GYM_WHITELIST, load_manifest_lenient, read_json, rel, write_json  # noqa: E402

WHITELIST = GYM_WHITELIST   # ⚠️ 路径只有一处（`xcpc_common.GYM_WHITELIST`）
CST = timezone(timedelta(hours=8))
GYM_MIN_ID = 100000

PROVINCE = re.compile(
    r'(Zhejiang|Shandong|Sichuan|Hubei|Henan|Jiangxi|Jilin|Heilongjiang|Guangdong|Shaanxi|Hunan|'
    r'Jiangsu|Anhui|Fujian|Shanghai|Beijing|Guangxi|Yunnan|Guizhou|Chongqing|Gansu|Hebei|Shanxi|'
    r'Xinjiang|Inner Mongolia|Tianjin|Hainan|Macau|Hong Kong)', re.I)
NOT_XCPC = re.compile(
    r'(Southeastern Europe|SEERC|East Central North America|ECNA|East North America|'
    r'North-Western Russia|Northwestern Russia|NEERC|NWERC|SWERC|CERC|German|GCPC|Polish|Poland|'
    r'BSUIR|Samara|Petrozavodsk|Helvetic|Benelux|Baltic|Nordic|UKIEPC|Gran Premio|Mexico|'
    r'World Finals|Open Cup)', re.I)


def classify(name: str) -> tuple[bool, str]:
    """按名字判"是不是 XCPC 正赛"—— 只是**默认建议**，正文里你可以随便改 include"""
    if not name:
        return False, '取不到名字'
    if NOT_XCPC.search(name):
        return False, '非 XCPC（其它大洲/训练赛）'
    if re.search(r'CCPC|China Collegiate', name, re.I):
        return True, 'CCPC'
    if re.search(r'ICPC', name, re.I) and re.search(r'Asia|East Continent|EC Regionals|ECL', name, re.I):
        return True, 'ICPC Asia'
    if PROVINCE.search(name) and re.search(r'Provincial|Invitational|Collegiate', name, re.I):
        return True, '省赛/邀请赛'
    if re.search(r'National Invitational', name, re.I):
        return True, '邀请赛'
    return False, '不确定（默认不导，你可以把 include 改成 true）'


def main(argv):
    ap = argparse.ArgumentParser(description='CF gym 清单 → gym_whitelist.json')
    ap.add_argument('--handle', default='')
    ap.add_argument('--refresh-classify', action='store_true', help='连 include/why 也按启发式重判')
    args = ap.parse_args(argv)

    manifest = load_manifest_lenient()
    # handle 的唯一来源是个人信息文件 me.json（--handle / 环境变量可临时覆盖）
    handle = cf_handle(args.handle) or (manifest.get('defaults') or {}).get('cfHandle') or ''
    if not handle:
        # 不知道是谁 ⇒ 没有"我的提交"可言，整件事跳过（不是错误：出货的包照样能用）
        print('ℹ️ 跳过：没有 CF handle（在 acm-data/raw/Scaper/me.json 的 cf.handle 里填你的 CF 用户名，'
              '或 --handle 临时指定）—— 白名单原样不动')
        return 0

    print(f'↓ 拉 {handle} 的全部提交（user.status，公开）')
    subs = call('user.status', {'handle': handle, 'from': 1, 'count': 10000})
    by_gym = {}
    for s in subs:
        cid = s.get('contestId') or (s.get('problem') or {}).get('contestId')
        if not cid or cid < GYM_MIN_ID:
            continue
        g = by_gym.setdefault(cid, {'n': 0, 'ac': set()})
        g['n'] += 1
        if s.get('verdict') == 'OK':
            p = s.get('problem') or {}
            g['ac'].add(f"{p.get('index', '')} {p.get('name', '')}")
    print(f'   共 {len(subs)} 条提交，涉及 {len(by_gym)} 个 gym')

    print('↓ 拉 gym 名字与开赛时间（contest.list?gym=true，公开）')
    meta = {c['id']: c for c in call('contest.list', {'gym': 'true'})}

    old = {}
    if os.path.isfile(WHITELIST):
        for g in (read_json(WHITELIST).get('gyms') or []):
            old[g['id']] = g

    gyms = []
    for cid in sorted(by_gym):
        g = by_gym[cid]
        info = meta.get(cid) or {}
        name = info.get('name') or ''
        st = info.get('startTimeSeconds') or 0
        year = str(datetime.fromtimestamp(st, tz=timezone.utc).astimezone(CST).year) if st else ''
        mis = re.search(r'(20\d{2})', name)
        if mis:
            year = mis.group(1)          # 名字里的年份更权威（镜像可能晚一年）
        inc, why = classify(name)
        prev = old.get(cid) or {}
        gyms.append({
            'id': cid,
            'name': name,
            'year': year,
            # 开赛时间**在这里就取好存下来**（CF 的 contest.standings 对 gym 不返回 startTimeSeconds，
            # 而 contest.list 有）—— 榜单适配器拿不到时间时用它兜底，值级来源仍是 CF。
            'startAt': (datetime.fromtimestamp(st, tz=timezone.utc).astimezone(CST)
                        .strftime('%Y-%m-%dT%H:%M:%S+08:00') if st else ''),
            'submissions': g['n'],
            'ac': len(g['ac']),
            'include': inc if (args.refresh_classify or not prev) else bool(prev.get('include')),
            'why': why if (args.refresh_classify or not prev) else (prev.get('why') or why),
            'slug': (prev.get('slug') or f'cf{cid}'),
            'note': prev.get('note', ''),
        })
    gyms.sort(key=lambda x: (not x['include'], x['id']))

    doc = {
        'version': 1,
        'handle': handle,
        'note': [
            '要导入哪些 CF gym 场次：**改这里的 include 就行**（true/false）。',
            '本文件由 `fetch_my_gyms.py` 生成/刷新 —— 你改过的 include/slug/note 会被保留。',
            '',
            '字段：id（gym 号）| name（CF 比赛名）| year（用于挂到"年份"层）|',
            '      submissions/ac（你的提交数/通过数）| include（要不要导）| why（判定理由）| slug（tree 里的身份）',
            '',
            '⚠️ 身份由 `gen_gym_manifest.py` 定：跑过跨平台索引的，能对上 rankland 的场次',
            '   会用 rankland 的 slug（如 ccpc2023harbin）；对不上的才用 cf<gym号>。',
            '⚠️ 通过率：CF gym 的榜含虚拟参赛，与官方榜（PTA/牛客）不同源，数字会偏低。',
        ],
        'gyms': gyms,
    }
    write_json(WHITELIST, doc)

    inc = [g for g in gyms if g['include']]
    print(f'✅ {rel(WHITELIST)}：{len(gyms)} 个 gym，其中勾选 {len(inc)} 个'
          f"（{sum(g['submissions'] for g in inc)} 条提交 / {sum(g['ac'] for g in inc)} 个 AC）")
    no_year = [g['id'] for g in inc if not g['year']]
    if no_year:
        print(f'   ⚠️ 没有年份（会直接挂在系列下）：{no_year}')
    print('   下一步：python gen_gym_manifest.py  → 再 npm run crate:xcpc')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
