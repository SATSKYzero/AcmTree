#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
往年牛客**暑期多校**：**枚举 → 题目表 → 榜单** 三步全自动（见
`docs/nk-multi-university.md`）。

年份下界口径 **22~26~inf** ⇒ **下界 2022、无上限**（`--from-year` 可调）。

## 三个接口（都实测过）

| 步骤 | 接口 | 给什么 |
|---|---|---|
| ① 枚举 | clist `contest/?resource=ac.nowcoder.com&order_by=-id&limit=1000` | 赛名（含「多校/暑期」）+ 开赛时间 + `href`（`…/acm/contest/<id>`） |
| ② 题目表 | nowcoder `acm-heavy/acm/contest/problem-list?id=<cid>` | `index`（题号）/`title`（题名）/`problemId`/`acceptedCount`/`submitPersonCount` |
| ③ 榜单 | nowcoder `acm-heavy/acm/contest/real-time-rank-data?id=<cid>&limit=0` | `basicInfo`（队数）/`problemData`（每题过队数）/`rankData` —— **复用 `nk_rankings_fetch.fetch`** |

⚠️ ② 是**榜单接口里没有的**那一半：`real-time-rank-data` 的 `problemData[].name` 只有题号（`A`），
**没有题名** ⇒ 题名必须从 ② 拿（这就是"题目表也能自动"的关键发现）。
⚠️ 榜单那一步可选：只要题号+题名+过题人数时用 `--skip-rank`。
⚠️ 抓下来是**原料**（原样存 JSON），产包仍走既有的 `nk_adapter` / `nk_pipeline`。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..', '..'))
for _p in (HERE, os.path.join(HERE, 'lib'),
           os.path.abspath(os.path.join(HERE, '..', 'lib'))):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# 登录态判据（clist 的 401 / QOJ 的 302 → login…）—— 各渠道共用一份，见 `Scaper/lib/auth_state.py`
import auth_state  # noqa: E402

CACHE = os.path.join(HERE, 'cache', 'nk')
INDEX_JSON = os.path.join(CACHE, 'multi_contests.json')
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
FROM_YEAR = 2022              # 口径「22~26~inf」 ⇒ 下界 2022、无上限
SLEEP = 1.0                   # 每场之间歇一下（牛客别打太快）

#: 赛名里出现这些词就算"暑期多校"（**别用年份筛**：场次 id 不连续，年份只在赛名/开赛时间里）
MULTI_WORDS = ('多校', '暑期')


def cid_of(href: str) -> str:
    """`…/acm/contest/133885` → `133885`（认不出返回空串）"""
    m = re.search(r'/acm/contest/(\d+)', str(href or ''))
    return m.group(1) if m else ''


def is_multi(event: str) -> bool:
    """赛名像不像"暑期多校"（口径：按**赛名**判，不按年份/类型）"""
    name = str(event or '')
    return any(w in name for w in MULTI_WORDS)


def year_of(start: str) -> int:
    """`2025-08-14T12:00:00` → `2025`（认不出返回 0）"""
    m = re.match(r'(\d{4})', str(start or ''))
    return int(m.group(1)) if m else 0


def keep(row: dict, from_year: int = FROM_YEAR) -> bool:
    """这一场要不要（**年份 ≥ from_year、无上限**；赛名含「多校/暑期」；id 认得出）"""
    return bool(cid_of(row.get('href'))) and is_multi(row.get('event')) \
        and year_of(row.get('start')) >= from_year


def _get(path: str, timeout: int = 60) -> dict:
    url = f'https://clist.by/api/v4/{path}'
    req = urllib.request.Request(url, headers={
        'User-Agent': 'acm-tree/1.0', 'Accept': 'application/json',
        'Authorization': f'ApiKey {_clist_user()}:{_clist_key()}',
    })
    # ★ 凭据失效（clist ⇒ **401 + 0 字节**）由共用件定性：过期就当场停、并说清去 me.json 改哪一份
    _status, text = auth_state.open_text(req, platform='clist', timeout=timeout, where=url)
    return json.loads(text)


def _clist_user() -> str:
    return os.environ.get('CLIST_USERNAME', '').strip() or _me('clist.username')


def _clist_key() -> str:
    return os.environ.get('CLIST_API_KEY', '').strip() or _me('clist.apiKey')


def _me(dotted: str) -> str:
    try:
        import me as me_mod
        return str(me_mod.get(dotted) or '').strip()
    except Exception:                                        # noqa: BLE001
        return ''


# ================================================================
# 提交（R）—— `status-list` 接口（实测发现）
#
# ⚠️ "牛客没有提交的 JSON 接口"是**错的**：404 的是**页面** URL
#    （`/acm/contest/status?contestId=…`），而 JSON 在 `acm-heavy` 下：
#
#      GET /acm-heavy/acm/contest/status-list?id=<cid>&page=N&searchUserName=<用户名>
#        → {msg, code, data:{ data:[一条条提交], isContestFinished, basicInfo:{pageCount,statusCount,…} }}
#
#    带上 `searchUserName` 就**只回你自己的**（一场 19 条约 6 KB、1 页）⇒
#    40 场全抓也就 300 KB 上下，比"在浏览器里逐场跑脚本"省太多。
#
# 抓回来要**转成适配器认识的形状**（`01 nk/nk_adapter.py` 读的是中文键，
# 与 `collect-nk-submit.js` 的产物一致）；`提交时间` 用 **UTC+8**（与 `submit_kind`
# 的窗口判据同口径 —— 它在 `nk_adapter` 里就是用 +8 算的）。
# ================================================================

STATUS_API = 'https://ac.nowcoder.com/acm-heavy/acm/contest/status-list'
#: 运行结果 → 那两列（第二列是"是不是 AC"，适配器认 `AC`）
AC_TEXT = '答案正确'


def status_url(cid: str, user: str, page: int = 1) -> str:
    """一场比赛、某个用户名的第 N 页提交（`searchUserName` 就来自页面上那个筛选框）"""
    q = urllib.parse.urlencode({'id': str(cid), 'page': int(page), 'searchUserName': str(user)})
    return f'{STATUS_API}?{q}'


def submits_from_records(records: list, cid: str) -> list:
    """
    `status-list` 的记录 → 适配器的中文键形状（**纯函数**，自测里钉住）。

    时间戳是 epoch 毫秒 ⇒ 按 **UTC+8** 写成 `2026.08.26 22:28:24`。
    """
    import datetime as _dt
    tz = _dt.timezone(_dt.timedelta(hours=8))
    out = []
    for r in records or []:
        if not isinstance(r, dict):
            continue
        sid = str(r.get('submissionId') or '').strip()
        if not sid:
            continue
        idx = str(r.get('index') or '').strip()
        status = str(r.get('statusMessage') or '').strip()
        ts = r.get('submitTime')
        when = ''
        try:
            if ts:
                when = _dt.datetime.fromtimestamp(int(ts) / 1000, tz).strftime('%Y.%m.%d %H:%M:%S')
        except (TypeError, ValueError, OSError):
            when = ''
        link = f'https://ac.nowcoder.com/acm/contest/view-submission?submissionId={sid}'
        out.append({
            '运行ID': sid,
            '提交链接': link,
            '用户名': str(r.get('userName') or '').strip(),
            '用户主页': f'https://ac.nowcoder.com/acm/contest/profile/{r.get("userId")}',
            '题号': idx,
            '题目链接': f'https://ac.nowcoder.com/acm/contest/{cid}/{idx}',
            '运行结果': status,
            '运行结果2': 'AC' if status == AC_TEXT else '',
            '结果链接': link,
            '运行时间(ms)': str(r.get('time') or ''),
            '使用内存(KB)': str(r.get('memory') or ''),
            '代码长度': str(r.get('length') or ''),
            '使用语言': str(r.get('language') or ''),
            '提交时间': when,
        })
    return out


def fetch_contest_submits(cid: str, user: str, verbose: bool = True) -> list:
    """抓一场比赛里**某个用户名**的全部提交（页数取自响应的 `basicInfo.pageCount`）"""
    all_rows, page, pages = [], 1, 1
    while page <= pages:
        req = urllib.request.Request(status_url(cid, user, page), headers={
            'User-Agent': UA, 'Accept': 'application/json'})
        with urllib.request.urlopen(req, timeout=45) as res:
            data = json.loads(res.read().decode('utf-8', 'replace'))
        body = data.get('data') if isinstance(data, dict) else None
        if not isinstance(body, dict):
            raise RuntimeError(f'status-list 返回的形状不对：{str(data)[:120]}')
        all_rows += body.get('data') or []
        info = body.get('basicInfo') or {}
        pages = int(info.get('pageCount') or 1)
        if verbose:
            print(f'     page {page}/{pages}：本页 {len(body.get("data") or [])} 条'
                  f'（该用户名共 {info.get("statusCount", "?")} 条）')
        page += 1
    return submits_from_records(all_rows, cid)


def _nk_names_by_year() -> dict:
    """`me.json` 的"哪一年用哪个队名"（v2 从账户 byYear 汇总；老结构也认）"""
    try:
        import me as me_mod
        return {str(y): str(n) for y, n in (me_mod.by_year('nk') or {}).items() if str(n).strip()}
    except Exception:                                        # noqa: BLE001
        return {}


def run_submits(from_year: int = 2023, to_year: int = 0, force: bool = False,
                verbose: bool = True) -> int:
    """
    给多校各场补**你自己**的提交（`cache/nk/nk_cid<CID>_submits.json`）。

    - 用户名按**那一年的队名**（`me.json` 的 `nk.byYear`；今年那条由 `me.by_year` 兜底）；
    - 已有文件默认跳过（想重抓加 `--force`）；
    - ⚠️ 抓的是**赛时+赛后**的全部提交（判定"赛时/补题"交给适配器的 `submit_kind`）。
    """
    rows = [r for r in enumerate_contests(verbose=False)
            if r['year'] >= from_year and (not to_year or r['year'] <= to_year)]
    names = _nk_names_by_year()
    if not names:
        print('⚠️ me.json 里没有牛客队名（账户里的 `nk` / `byYear`）⇒ 不知道按谁筛，没得抓')
        return 1
    if verbose:
        print(f'📄 队名表：{"、".join(f"{y}={n}" for y, n in sorted(names.items()))}')
    done = skipped = 0
    for r in rows:
        cid, year = str(r['cid']), r['year']
        user = names.get(str(year), '')
        out = os.path.join(CACHE, f'nk_cid{cid}_submits.json')
        if not user:
            if verbose:
                print(f'   ⚠️ {cid}（{year}）没有那一年的队名 ⇒ 跳过')
            skipped += 1
            continue
        if os.path.isfile(out) and not force:
            if verbose:
                print(f'   ⏭ {cid}（{year} {user}）已有提交文件')
            skipped += 1
            continue
        if verbose:
            print(f'   ⬇ {cid}（{year} {user}）')
        try:
            subs = fetch_contest_submits(cid, user, verbose=verbose)
        except Exception as e:                               # noqa: BLE001
            print(f'   ❌ {cid} 抓失败：{str(e)[:120]}')
            continue
        if not subs:
            # 那一场对这个用户名**一条都没有**（没参加/换名）⇒ 不落空文件（落了对出包也没用）
            if verbose:
                print('     ∅ 没有提交，不写文件')
            skipped += 1
            continue
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(subs, f, ensure_ascii=False, indent=2)
            f.write('\n')
        done += 1
        if verbose:
            print(f'     ✅ 写 {len(subs)} 条 → {os.path.relpath(out, REPO)}')
        time.sleep(0.4)                                      # 别把人家站点打疼
    print(f'📥 提交抓取完成：{done} 场写入 / {skipped} 场跳过'
          f'（约 {done * 6} KB 量级）')
    return 0


def enumerate_contests(force: bool = False, verbose: bool = True) -> list:
    """① clist 枚举 ⇒ `[{cid, title, start, year, href}]`（缓存 `multi_contests.json`）"""
    if os.path.isfile(INDEX_JSON) and not force:
        got = json.load(open(INDEX_JSON, encoding='utf-8'))
        if verbose:
            print(f'📦 用缓存 {INDEX_JSON}：{len(got)} 场')
        return got
    user, key = _clist_user(), _clist_key()
    if not user or not key:
        print('⚠️ 没有 clist 凭据（`me.json` 的 `clist`，或环境变量 CLIST_USERNAME/CLIST_API_KEY）'
              '⇒ 枚举不了。**手爬兜底**见 docs/nk-multi-university.md')
        return []
    rows = []
    for page in range(4):                                    # 牛客 1345 场，`limit=1000` 翻两页够
        d = _get(f'contest/?format=json&limit=1000&offset={page * 1000}'
                 f'&resource=ac.nowcoder.com&order_by=-id')
        objs = d.get('objects') or []
        rows.extend(objs)
        if len(objs) < 1000:
            break
        time.sleep(6.5)                                      # clist 限速 10/分钟
    out = []
    for r in rows:
        if not keep(r):
            continue
        cid = cid_of(r.get('href'))
        out.append({'cid': cid, 'title': str(r.get('event') or '').strip(),
                    'start': str(r.get('start') or ''), 'year': year_of(r.get('start')),
                    'href': str(r.get('href') or '')})
    out.sort(key=lambda x: (x['year'], x['cid']))
    os.makedirs(CACHE, exist_ok=True)
    json.dump(out, open(INDEX_JSON, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if verbose:
        years = sorted({x['year'] for x in out})
        print(f'↓ {INDEX_JSON}：**{len(out)} 场**（{FROM_YEAR} 起，年份 {years}）')
    return out


def fetch_problem_list(cid: str, verbose: bool = True) -> dict:
    """② 题目表（题号 + 题名 + 过题人数）⇒ `cache/nk/nk_cid<cid>_problems.json`"""
    path = os.path.join(CACHE, f'nk_cid{cid}_problems.json')
    if os.path.isfile(path):
        return json.load(open(path, encoding='utf-8'))
    url = f'https://ac.nowcoder.com/acm-heavy/acm/contest/problem-list?id={cid}'
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
        'Referer': f'https://ac.nowcoder.com/acm/contest/{cid}',
    })
    with urllib.request.urlopen(req, timeout=45) as res:
        doc = json.loads(res.read().decode('utf-8', 'replace'))
    rows = ((doc.get('data') or {}).get('data')) or []
    # ⚠️ **键必须是中文的**：`nk_adapter.py` 认 `题号` / `标题` / `题目链接`
    #    （实测：写成 index/title/url 会被判"无法识别…的类型，已忽略"）。
    #    `通过率`（形如 "36/54"）**故意不写** —— 那分母不是队伍数，榜单口径才是 ratio 的来源。
    kept = [{'题号': str(r.get('index') or ''), '标题': str(r.get('title') or ''),
             '题目链接': f'https://ac.nowcoder.com/acm/contest/{cid}/{r.get("index")}'}
            for r in rows if r.get('index')]
    os.makedirs(CACHE, exist_ok=True)
    json.dump(kept, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    if verbose:
        print(f'   ✓ 题目表 {cid}：{len(kept)} 题 → {os.path.basename(path)}')
    return kept


def _rank_first_page(cid: str) -> dict:
    """榜单**第 1 页**（`limit=0` = 50 队 + `basicInfo` + `problemData` 全量）"""
    url = ('https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data'
           f'?id={cid}&limit=0&page=1')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
        'Referer': f'https://ac.nowcoder.com/acm/contest/{cid}#rank',
    })
    with urllib.request.urlopen(req, timeout=45) as res:
        raw = json.loads(res.read().decode('utf-8', 'replace'))
    data = raw.get('data') if isinstance(raw.get('data'), dict) else raw
    return {'basicInfo': (data or {}).get('basicInfo') or {},
            'problemData': (data or {}).get('problemData') or [],
            'rankData': (data or {}).get('rankData') or [],
            'pagesCollected': 1,
            'source': f'nk_first_page(cid={cid})'}


#: 每队**保留**的键（`scoreList` 是每题明细 ⇒ 占 90%+ 体积，用不上：
#: 要的只是"队数/每题过队数 + 哪支队在第几名"）
RANK_KEEP = ('ranking', 'team', 'userName', 'school', 'uid', 'acceptedCount',
             'totalScore', 'penaltyTime', 'participationType', 'colorLevel',
             'teamMemberUids', 'fullScore')


def slim_rank_doc(doc: dict) -> dict:
    """
    把榜单**瘦身**成"要保留的那几样"（方案 1）。

    保留：`basicInfo`（队数 = ratio 分母）/ `problemData`（每题过队数 = 分子）/ 每队一行**去掉
    `scoreList`**（每题明细，5~7MB 都是它）。加了 `slim: true` 标记，便于将来判断"这份是瘦过的"。
    """
    out = dict(doc or {})
    rows = out.get('rankData')
    if isinstance(rows, list):
        out['rankData'] = [{k: r.get(k) for k in RANK_KEEP if k in r} for r in rows]
    out['slim'] = True
    # ⚠️ **必须带 `bundleVersion`**：`nk_rank_stats.unwrap()` 靠它认"汇总包"形状；
    #    少了它会被当成"原始响应"去找 `data` 字段，然后报"是不是存错了文件"（实测踩到）。
    out['bundleVersion'] = int(out.get('bundleVersion') or 1)
    return out


def slim_file(path: str) -> int:
    """就地瘦身一份已落盘的榜单（返回省掉的字节数；已经是瘦的就返回 0）"""
    try:
        doc = json.load(open(path, encoding='utf-8'))
    except (OSError, ValueError):
        return 0
    if doc.get('slim'):
        return 0
    before = os.path.getsize(path)
    json.dump(slim_rank_doc(doc), open(path, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    return max(0, before - os.path.getsize(path))


def _rank_rows(doc: dict) -> list:
    """
    榜单里的队伍行 —— **两种形状都认**：
      · `nk_rankings_fetch.fetch()` 的返回：**顶层** `{basicInfo, problemData, rankData, …}`；
      · 接口原始响应：`{msg, code, data:{basicInfo, problemData, rankData}}`。
    ⚠️ 实测踩到：只读 `data.rankData` ⇒ 明明抓回来 1484 队，却被判成"没有 rankData"、
    **一个文件都没落**（白跑一刻钟）。
    """
    if not isinstance(doc, dict):
        return []
    rows = doc.get('rankData')
    if isinstance(rows, list):
        return rows
    inner = doc.get('data') if isinstance(doc.get('data'), dict) else {}
    rows = inner.get('rankData')
    return rows if isinstance(rows, list) else []


def fetch_rank(cid: str, verbose: bool = True, full: bool = False) -> bool:
    """
    ③ 榜单：**默认只取第 1 页**。

    * **第 1 页就够算 ratio**：`basicInfo.rankCount`（队数 = 分母）+ `problemData[].acceptedCount`
      （每题过队数 = 分子）**都在第一次响应里**（实测 `limit=1` 那一次就带全 14 题）；
    * 翻完所有页（20~30 页 / 每场上千队）**只有两个用途**：看某支队的名次/得分明细、以后挖别的
      ⇒ 需要时用 `full=True`（`--full-ranks`），平时不必（省 99% 的请求）。
    * 落盘带 `partial: True` 标记 —— 下游（`nk_rank_stats`）据此知道"这份只有第 1 页"。

    ⚠️ **落盘要自己做**：`nk_rankings_fetch.fetch()` 只**返回**数据，写文件是它 `main()` 里的事
    （实测踩到：直接调 `fetch()` 会把结果丢掉 ⇒ 跑一刻钟一个文件都没落）。
    """
    path = os.path.join(CACHE, f'nk_cid{cid}_rank.json')
    if os.path.isfile(path):
        try:
            have = json.load(open(path, encoding='utf-8'))
            rows = _rank_rows(have)
            if have.get('slim') and (rows or have.get('problemData')):
                if verbose:
                    print(f'   📦 榜单 {cid} 已有（{len(rows)} 队）')
                return True
        except ValueError:
            pass                                             # 坏文件 ⇒ 重抓
    if not full:
        # —— 只取第 1 页：一个请求，几十 KB ——
        try:
            doc = _rank_first_page(cid)
        except Exception as err:                              # noqa: BLE001
            print(f'   ⚠️ 榜单 {cid} 第一页失败（{type(err).__name__}: {str(err)[:60]}）—— 不影响题目表')
            return False
        rows = _rank_rows(doc)
        if not rows and not (doc.get('problemData')):
            print(f'   ⚠️ 榜单 {cid}：连 problemData 都没有 ⇒ 不落盘')
            return False
        os.makedirs(CACHE, exist_ok=True)
        out = slim_rank_doc(doc)
        out['partial'] = True                                 # 只有第 1 页
        json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        if verbose:
            n = len(out.get('problemData') or [])
            print(f'   ✓ 榜单 {cid}（第 1 页 / {n} 题 / '
                  f'{((out.get("basicInfo") or {}).get("rankCount"))} 队）→ {os.path.basename(path)}')
        return True
    try:
        import nk_rankings_fetch as rank
    except Exception as err:                                  # noqa: BLE001
        print(f'   ⚠️ 拉不到榜单（{type(err).__name__}）⇒ 跳过（题目表已经有了）')
        return False
    try:
        doc = rank.fetch(cid, verbose=False)
        rows = _rank_rows(doc)
        if not rows:
            print(f'   ⚠️ 榜单 {cid}：返回里没有 rankData ⇒ **不落盘**（别写空文件）')
            return False
        os.makedirs(CACHE, exist_ok=True)
        json.dump(slim_rank_doc(doc), open(path, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)
        if verbose:
            kb = os.path.getsize(path) / 1024
            print(f'   ✓ 榜单 {cid}：{len(rows)} 队 → {os.path.basename(path)}（{kb:.0f} KB）')
        return True
    except Exception as err:                                  # noqa: BLE001
        print(f'   ⚠️ 榜单 {cid} 失败（{type(err).__name__}: {str(err)[:60]}）—— 不影响题目表')
        return False


def team_name_of(row: dict) -> str:
    """
    榜单一行里的**队名**。⚠️ 字段不稳：`team` 有时是**字符串**（队名）、有时是 **bool**（"这是支队"），
    那种情况队名在 `userName` 里 —— 两个都试（实测）。
    """
    t = row.get('team')
    if isinstance(t, str) and t.strip():
        return t.strip()
    return str(row.get('userName') or '').strip()


def find_team(cid: str, name: str, verbose: bool = False) -> list:
    """
    ③b **按队名查榜单**（牛客榜单页那个搜索框的接口）。

    URL 是 `#rank/?searchUserName=:"队名"`；实测**参数不带引号**也能用，
    而且**直接返回那一行**（`rankCount=1`）⇒ 确认"某队在这场拿第几"只要 **1 个请求**，
    **不用翻完整榜**（一场 33 页）。
    """
    q = urllib.parse.quote(str(name))
    url = ('https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data'
           f'?id={cid}&limit=0&page=1&searchUserName={q}')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
        'Referer': f'https://ac.nowcoder.com/acm/contest/{cid}#rank/',
    })
    with urllib.request.urlopen(req, timeout=45) as res:
        raw = json.loads(res.read().decode('utf-8', 'replace'))
    data = raw.get('data') if isinstance(raw.get('data'), dict) else raw
    rows = (data or {}).get('rankData') or []
    if verbose and rows:
        r = rows[0]
        print(f'      ✓ {name}：第 {r.get("ranking")} 名（{r.get("school")}，'
              f'过 {r.get("acceptedCount")} 题）')
    return rows


def scan_teams(verbose: bool = True) -> int:
    """
    按 `me.json` 的历年队名（v2：账户里的 `byYear.nk`；老结构是顶层 `nk.byYear`）逐个查
    —— 只查**那一年的场次**。

    2023=选手甲、2024=选手乙、2025=TEAM1。
    """
    by_year = {}
    try:
        import me as me_mod
        by_year = me_mod.by_year('nk')
    except Exception:                                        # noqa: BLE001
        pass
    if not by_year:
        print('⚠️ `me.json` 里没有历年队名（年份 → 队名）⇒ 没得查')
        return 0
    rows = enumerate_contests(verbose=False)
    hit = 0
    for row in rows:
        name = str(by_year.get(str(row['year'])) or '')
        if not name:
            continue
        try:
            got = find_team(row['cid'], name, verbose=verbose)
        except Exception as err:                             # noqa: BLE001
            print(f'   ⚠️ {row["year"]} {row["cid"]} 查询失败：{type(err).__name__}')
            continue
        if got:
            hit += 1
        elif verbose:
            print(f'      · {row["year"]} {row["cid"]}「{name}」没查到（这轮没参加/名字不同）')
        time.sleep(0.5)
    print(f'↓ 共查到 {hit} 场（{", ".join(f"{y}={n}" for y, n in sorted(by_year.items()))}）')
    return hit


def _rank_page(cid: str, page: int, only_contest: bool = False) -> dict:
    """
    榜单第 `page` 页（`limit=0` + `page=N`；⚠️ `limit=50` 会把总数锁成 50，别用）。

    @param only_contest - `True` = 加 `onlyContestRank=true`（**只算正式参赛队**，排除打星/非正式）。
        口径："**两个都求，但暂时使用裸查询**" —— 见 `fetch_rank_effective()`。
    """
    extra = '&onlyContestRank=true' if only_contest else ''
    url = ('https://ac.nowcoder.com/acm-heavy/acm/contest/real-time-rank-data'
           f'?token=&id={cid}{extra}&limit=0&page={page}')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'application/json, text/plain, */*',
        'Referer': f'https://ac.nowcoder.com/acm/contest/{cid}#rank/',
    })
    with urllib.request.urlopen(req, timeout=45) as res:
        raw = json.loads(res.read().decode('utf-8', 'replace'))
    data = raw.get('data') if isinstance(raw.get('data'), dict) else raw
    return {'basicInfo': (data or {}).get('basicInfo') or {},
            'problemData': (data or {}).get('problemData') or [],
            'rankData': (data or {}).get('rankData') or []}


def _probe_counts(cid: str, only_contest: bool = False) -> tuple:
    """
    **越界探针**：`page=999` 回 **0 行**，但照样带 `basicInfo`（`pageCount`/`rankCount`）——
    响应几乎为空 ⇒ 用它开局，**不用先取第 1 页**（口径："第 1 页也不需要"）。

    @returns `(pageCount, rankCount)`
    """
    got = _rank_page(cid, 999, only_contest=only_contest)
    b = got.get('basicInfo') or {}
    return int(b.get('pageCount') or 1), int(b.get('rankCount') or 0)


def _effective_of(cid: str, only_contest: bool = False) -> dict:
    """
    一个口径的**有效队伍数**：越界探针拿页数 → **从最后一页往前扫到边界**为止。

    为什么可行（实测）：榜单按得分排序 ⇒ 0 题的队全在尾部
    （81600：第 33 页 2 队全 0、第 32 页 50 队全 0、第 31 页 21 非零）
    ⇒ 有效队伍数 = rankCount − 尾部的 0 题队数，实测 **3~4/33 页**。
    `basicInfo` 与 `problemData`（整场每题统计）**每一页都带** ⇒ 顺路拿到，不用单独取第 1 页。
    """
    pages, total = _probe_counts(cid, only_contest)
    zeros = 0
    scanned = 0
    boundary = 0
    first = None
    for page in range(pages, 0, -1):
        got = _rank_page(cid, page, only_contest=only_contest)
        scanned += 1
        if first is None:
            first = got                                  # 尾页也有 basicInfo/problemData
        rows = got.get('rankData') or []
        if any(int(r.get('acceptedCount') or 0) >= 1 for r in rows):
            zeros += sum(1 for r in rows if int(r.get('acceptedCount') or 0) == 0)
            boundary = page
            break
        zeros += len(rows)
    return {'effective': max(0, total - zeros), 'rankCount': total, 'pageCount': pages,
            'scanned': scanned, 'boundary': boundary, 'firstPageDoc': first or {}}


def fetch_rank_effective(cid: str, verbose: bool = True) -> dict:
    """
    **倒着爬**（比顺着爬快得多）+ **两个口径都求、采用裸查询**
    （口径："两个都求，但暂时使用裸查询"；"第 1 页也不需要，从最后一页取"）。

    每场 4~6 个请求：① 裸越界探针（极小）② 裸尾部扫到边界（2~4 页，主流量）
    ③ 正式口径**只探针**（1 个极小请求，拿 `rankCountOfficial` 记一笔）。

    ⚠️ 正式口径**不扫边界**：实测 81600 两口径的有效队伍数**一样**（都是 1521）——
       差的 33 支全是 `rank=0` 的报名未参赛队（`participationType` 都是 OFFICIAL，
       **多校没有打星队**），它们本来就 0 题、不进分母。
    """
    allv = _effective_of(cid, False)
    off_pages, off_total = _probe_counts(cid, True)
    first = allv['firstPageDoc'] or {}
    if verbose:
        print(f'   ✓ 榜单 {cid}：裸 {allv["rankCount"]} 队 → 有效 {allv["effective"]}'
              f'（扫 {allv["scanned"]} 页，边界在第 {allv["boundary"]} 页）'
              f' · 正式 {off_total} 队（只探针，不扫边界）')
    return {
        'basicInfo': first.get('basicInfo') or {},
        'problemData': first.get('problemData') or [],
        'rankData': first.get('rankData') or [],
        'pagesCollected': allv['scanned'],
        'pagesExpected': allv['pageCount'],
        'effectiveTeams': allv['effective'],
        'effectiveTeamsOfficial': None,
        'rankCount': allv['rankCount'],
        'rankCountOfficial': off_total,
        'pagesScannedOfficial': 0,
        'boundaryPages': {'all': allv['boundary'], 'official': None},
        'onlyContestRankPages': off_pages,
        'partial': True,
        'complete': 'boundary',
        'slim': True,
        'bundleVersion': 1,
        'source': f'nk_multi_fetch.effective(cid={cid})',
    }


def build(from_year: int = 2023, to_year: int = 0, skip_stats: bool = False,
          verbose: bool = True) -> int:
    """
    把已经抓好的原料**出成一个来源包**（`acm-data/nodes/nk-multi-university.json`）。

    两步、都是既有脚本：
      ① `01 nk/lib/nk_rank_stats.py <rank.json> -o <rank_stats.json>` 逐场 —— ratio 的唯一来源；
      ② `01 nk/nk_adapter.py <contest> <problems> … -o 包 --rank-stats <stats> …` **一次吃多场**
         （`inputs` 与 `--rank-stats` 都是 `nargs='+'`）。

    ⚠️ 2022 那 11 场**不进包**（那批没有可用的账号）⇒ 默认从 2023 起。
    """
    rows = enumerate_contests(verbose=False)
    want = [r for r in rows if r['year'] >= from_year and (not to_year or r['year'] <= to_year)]
    rank_dir = CACHE
    adapter = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '01 nk', 'nk_adapter.py')
    stats_py = os.path.join(REPO, 'acm-data', 'raw', 'Scaper', '01 nk', 'lib', 'nk_rank_stats.py')
    out_pkg = os.path.join(REPO, 'acm-data', 'nodes', 'nk-multi-university.json')

    inputs, stats = [], []
    submit_sessions = 0
    for r in want:
        cid = r['cid']
        contest = os.path.join(rank_dir, f'nk_cid{cid}_contest.json')
        problems = os.path.join(rank_dir, f'nk_cid{cid}_problems.json')
        rank = os.path.join(rank_dir, f'nk_cid{cid}_rank.json')
        statsf = os.path.join(rank_dir, f'nk_cid{cid}_rank_stats.json')
        if not (os.path.isfile(contest) and os.path.isfile(problems)):
            if verbose:
                print(f'   ⚠️ {cid} 缺身份/题目表 ⇒ 跳过')
            continue
        inputs += [contest, problems]
        # 提交（可选）：`run-submits` 抓下来的那份（有就带上 ⇒ 包里有 R 和账户线索）
        submitsf = os.path.join(rank_dir, f'nk_cid{cid}_submits.json')
        if os.path.isfile(submitsf):
            inputs.append(submitsf)
            submit_sessions += 1
        if os.path.isfile(rank):
            if not skip_stats and (not os.path.isfile(statsf)):
                c = subprocess.run([sys.executable, '-B', stats_py, rank, '-o', statsf],
                                   cwd=REPO, capture_output=True,
                                   # 读孩子一律显式 utf-8（2026-10-18）：`text=True` 不带 encoding 时
                                   # 按系统代码页解码，关掉 UTF-8 Beta 后是 GBK ⇒ UnicodeDecodeError
                                   text=True, encoding='utf-8', errors='replace')
                if c.returncode != 0:
                    print(f'   ⚠️ {cid} rank_stats 失败：{(c.stderr or c.stdout or "")[:80]}')
            if os.path.isfile(statsf):
                stats.append(statsf)
    if not inputs:
        print('⚠️ 没有可出包的场次')
        return 1
    n_sessions = len({
        os.path.dirname(p) for p in inputs
    }) if not submit_sessions else None
    sess = len([1 for r in want if os.path.isfile(os.path.join(rank_dir, f"nk_cid{r['cid']}_problems.json"))])
    print(f'📦 出包：{sess} 场 / {len(stats)} 份 rank_stats'
          + (f' / {submit_sessions} 场带提交' if submit_sessions else '')
          + f' → {out_pkg}')
    argv = [sys.executable, '-B', adapter] + inputs + ['-o', out_pkg]
    if stats:
        argv += ['--rank-stats'] + stats
    c = subprocess.run(argv, cwd=REPO)
    if c.returncode != 0:
        print(f'❌ 适配器失败（exit {c.returncode}）')
        return c.returncode
    print('✅ 包已写出。下一步：node scripts/crate-check.mjs '
          'acm-data/nodes/nk-multi-university.json')
    return 0


def run(from_year: int = FROM_YEAR, limit: int = 0, skip_rank: bool = False,
        force: bool = False, dry_run: bool = False, verbose: bool = True,
        full_ranks: bool = False, effective: bool = False, to_year: int = 0) -> int:
    rows = enumerate_contests(force=force, verbose=verbose)
    want = [r for r in rows if r['year'] >= from_year
            and (not to_year or r['year'] <= to_year)]
    if limit:
        want = want[-limit:]                                  # 从**新的**往回取
    print(f'📋 要抓 {len(want)} 场（{from_year} 起'
          + (f'，只取最新 {limit} 场' if limit else '') + f'，{"只看不抓" if dry_run else "开始抓"}）')
    for i, row in enumerate(want, 1):
        print(f'[{i}/{len(want)}] {row["year"]} {row["title"][:42]}（cid {row["cid"]}）')
        if dry_run:
            continue
        try:
            fetch_problem_list(row['cid'], verbose=verbose)
        except Exception as err:                              # noqa: BLE001
            print(f'   ❌ 题目表 {row["cid"]} 失败：{type(err).__name__}: {str(err)[:70]}')
        if not skip_rank:
            if effective:
                try:
                    doc = fetch_rank_effective(row['cid'], verbose=verbose)
                    os.makedirs(CACHE, exist_ok=True)
                    json.dump(slim_rank_doc(doc), open(
                        os.path.join(CACHE, f'nk_cid{row["cid"]}_rank.json'), 'w',
                        encoding='utf-8'), ensure_ascii=False, indent=1)
                except Exception as err:                      # noqa: BLE001
                    print(f'   ⚠️ 倒着爬 {row["cid"]} 失败：{type(err).__name__}: {str(err)[:60]}')
            else:
                fetch_rank(row['cid'], verbose=verbose, full=full_ranks)
        time.sleep(SLEEP)
    return 0


# ================================================================
# 自测（纯函数 + 离线过滤，不联网）
# ================================================================

def _selftest() -> int:
    bad = []
    checks = 0

    def ok(cond, label):
        nonlocal checks
        checks += 1
        print(('  ✔ ' if cond else '  ✘ ') + label)
        if not cond:
            bad.append(label)

    ok(cid_of('https://ac.nowcoder.com/acm/contest/133885') == '133885', 'cid_of：正常 href')
    ok(cid_of('https://ac.nowcoder.com/acm/contest/133885#rank') == '133885', 'cid_of：带锚点')
    ok(cid_of('https://ac.nowcoder.com/acm/contest/vip-index') == '', 'cid_of：列表页 ⇒ 空')
    ok(cid_of('') == '', 'cid_of：空 ⇒ 空')

    ok(is_multi('2026牛客暑期多校训练营10 [ACM]'), 'is_multi：暑期多校')
    ok(is_multi('"影石Insta360杯"2025牛客暑期多校训练营10 [ACM]'), 'is_multi：带冠名')
    ok(not is_multi('牛客练习赛 120'), 'is_multi：练习赛不算')
    ok(not is_multi('2025年牛客高校联赛'), 'is_multi：高校联赛不算')

    ok(year_of('2025-08-14T12:00:00') == 2025, 'year_of：ISO')
    ok(year_of('') == 0, 'year_of：空 ⇒ 0')

    row26 = {'href': 'https://ac.nowcoder.com/acm/contest/133885',
             'event': '2026牛客暑期多校训练营10 [ACM]', 'start': '2026-08-19T12:00:00'}
    row21 = {'href': 'https://ac.nowcoder.com/acm/contest/999',
             'event': '2021牛客暑期多校训练营1', 'start': '2021-07-01T12:00:00'}
    row_prac = {'href': 'https://ac.nowcoder.com/acm/contest/1', 'event': '牛客练习赛1',
                'start': '2024-01-01T12:00:00'}
    ok(keep(row26), 'keep：2026 多校 ⇒ 要（**无上限**）')
    ok(not keep(row21), f'keep：2021 ⇒ 不要（下界 {FROM_YEAR}）')
    ok(not keep(row_prac), 'keep：练习赛 ⇒ 不要')
    ok(keep(row26, from_year=2021), 'keep：下界可调（传 2021 就要）')

    # ---- 提交（status-list）的形状转换（纯函数，实测的接口）----
    ok(status_url('133885', '再_努_力_一_点').startswith(
        'https://ac.nowcoder.com/acm-heavy/acm/contest/status-list?id=133885&page=1&searchUserName='),
        'status_url：接口形状 + searchUserName 在')
    ok('%E5%86%8D' in status_url('133885', '再_努_力_一_点'), 'status_url：用户名要 URL 编码')
    rec = {
        'submissionId': 84606588, 'userName': '再_努_力_一_点', 'userId': 139033253,
        'index': 'A', 'statusMessage': '答案正确', 'submitTime': 1787754504000,
        'time': 698, 'memory': 7200, 'length': 1089, 'language': 'C++',
    }
    rows = submits_from_records([rec], '133885')
    r0 = rows[0]
    ok(len(rows) == 1 and r0['运行ID'] == '84606588', 'submits：运行ID')
    ok(r0['题号'] == 'A' and r0['运行结果2'] == 'AC', 'submits：题号 + AC 那一列')
    ok(r0['提交时间'] == '2026.08.26 22:28:24',
       f'提交时间按 **UTC+8** 写（与 submit_kind 的窗口同口径）：{r0["提交时间"]}')
    ok(r0['使用内存(KB)'] == '7200' and r0['运行时间(ms)'] == '698' and r0['代码长度'] == '1089',
       'submits：运行信息三样')
    ok(submits_from_records([{'statusMessage': '答案错误'}], '1') == [],
       'submits：没有 submissionId 的行丢掉')
    ok(submits_from_records([], '1') == [], 'submits：空 ⇒ 空')
    ok(submits_from_records([{**rec, 'statusMessage': '答案错误'}], '133885')[0]['运行结果2'] == '',
       'submits：不是"答案正确"就不给 AC')

    print(f'✅ 多校枚举/抓取自测通过：{checks - len(bad)} 项' if not bad else '❌ 自测失败')
    for one in bad:
        print('  •', one)
    return 0 if not bad else 1


def main(argv):
    ap = argparse.ArgumentParser(description='往年牛客暑期多校：枚举（clist）→ 题目表 + 榜单')
    ap.add_argument('action', nargs='?', default='run',
                    choices=('run', 'run-submits', 'list', 'selftest', 'slim', 'teams', 'build'))
    ap.add_argument('--from-year', type=int, default=FROM_YEAR,
                    help=f'年份下界（默认 {FROM_YEAR}；口径「22~26~inf」= 下界 2022、无上限）')
    ap.add_argument('--limit', type=int, default=0, help='只取最新 N 场（调试用）')
    ap.add_argument('--to-year', type=int, default=0, dest='to_year',
                    help='年份上界（0 = 不限）—— 例：`--from-year 2025 --to-year 2025` 只跑 2025')
    ap.add_argument('--skip-rank', action='store_true', help='不拉榜单（只要题号/题名/过题人数时用）')
    ap.add_argument('--effective', action='store_true',
                    help='**倒着爬**（推荐）：只抓到"有效队伍数"的边界（0 题的队全在尾部）'
                         '—— 实测 3/33 页就够，省 ~10 倍流量；落盘带 effectiveTeams')
    ap.add_argument('--full-ranks', action='store_true', dest='full_ranks',
                    help='榜单抓**完整**（翻完所有页，20~30 页/场）—— 默认只取第 1 页'
                         '（队数 + 每题过队数都在里面，够算 ratio）')
    ap.add_argument('--force', action='store_true', help='重跑枚举（不用缓存）')
    ap.add_argument('--dry-run', action='store_true', dest='dry_run', help='只列清单，不抓')
    args = ap.parse_args(argv)
    if args.action == 'selftest':
        return _selftest()
    if args.action == 'build':
        return build(from_year=args.from_year, to_year=args.to_year,
                     skip_stats=args.skip_rank)
    if args.action == 'teams':
        return 0 if scan_teams() >= 0 else 1
    if args.action == 'slim':
        saved = 0
        for f in sorted(glob.glob(os.path.join(CACHE, 'nk_cid*_rank.json'))):
            n = slim_file(f)
            saved += n
            print(f'   {"瘦身" if n else "已经瘦了"} {os.path.basename(f)}'
                  + (f'（省 {n / 1024:.0f} KB）' if n else ''))
        print(f'↓ 一共省下 {saved / 1024 / 1024:.1f} MB')
        return 0
    if args.action == 'run-submits':
        return run_submits(from_year=args.from_year, to_year=args.to_year, force=args.force)
    if args.action == 'list':
        rows = enumerate_contests(force=args.force)
        for r in rows:
            print(f'{r["year"]}  cid={r["cid"]:>8}  {r["title"][:60]}')
        return 0
    return run(from_year=args.from_year, limit=args.limit, skip_rank=args.skip_rank,
               force=args.force, dry_run=args.dry_run, full_ranks=args.full_ranks,
               effective=args.effective, to_year=args.to_year)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
