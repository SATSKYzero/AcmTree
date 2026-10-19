#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
HDU 多校：**登录 → 逐页抓 → 出原料**（`02 hdu/hdu_multi_fetch.py`）

用户 2026-10-17："nk/hdu 多校的爬取能否不每场比赛手动" ⇒ HDU 这条到这里：
**不用再逐场开控制台粘 `save-hdu-page.js` 了**。本脚本**只搬原料**（不解析、不出包）——
与 `05 xcpc/nk_multi_fetch.py` 同一个分工：抓下来是原料，产包仍走既有的 `hdu_pipeline.py`。

## 为什么能自动（2026-10-17 实测）

HDU 赛内页是**服务端渲染**的普通 HTML（`fetch-hdu-rank.js` 的注释里写着同一件事），
所以过得了那道门，Python 就能拉同一份：

| 打哪 | 得到 |
|---|---|
| `POST /contest/login?cid=<CID>`（表单 `username` + `password`） | 该场的比赛会话（Cookie） |
| `GET /contest/problems?cid=<CID>` | 题目页 → `hdu_cid<CID>_problems_source.html` |
| `GET /contest/rank?cid=<CID>&page=<0..>` | 榜单页（**0 基**）→ `hdu_cid<CID>_rank.html` |
| `GET /contest/status?cid=<CID>&status=&page=<1..>` | 提交页（**1 基**）→ `hdu_cid<CID>_submit.html` |

⚠️ **没登录/没输口令时这三个 URL 也是 HTTP 200，正文却是 `<title>Contest Login</title>`**
（实测：都是 11247 字节的同一页）⇒ 判据只能看正文，不能看状态码。本脚本把它当**当场停**
（退出码 2，与流水线 `HARD_STOP` 同口径）：口令不对时继续跑下一场只会白刷登录失败。

## 与"通用读取层"的关系（**没有第二套**）

每页都走 `Scaper/lib/read_modes.py`：`Archive.page(...)`（归档优先 → 联网 → 重试 → 记账），
`accept=` 就是"**登录门不算好页**"（好页才入库 —— 本仓那条硬规矩）。于是
`--force`（把已有页当没有）、`--offline`（一次也不联网）、`--cache-mode/--retry-mode` 全部白拿。
⚠️ 页级归档**就是这个 bundle 文件本身**（`<!-- PAGE n -->` 就是页号，见 `Bundle` 类）——
不再另存一份"每页一个文件"的中间物。

## 凭据（`me.json`，唯一入口 `Scaper/lib/me.py`）

```json
"hdu": { "contestUser": "TEAM0/teamA", "contestPassword": "全季那一个口令" }
```
`contestUser` 缺省取 `handles('hdu')` 的第一个；`contestPassword` 没配就当场停下来说清。
临时跑一次可用环境变量 `HDU_CONTEST_USER` / `HDU_CONTEST_PASSWORD`（不进仓库）。
`hdu.cookie`（站点登录 Cookie）**可选**：只有个别页面在口令之外还要站点登录态。

## 用法

```powershell
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" list
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" fetch --from-year 2026
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" fetch --cid 1229,1238 --skip-rank
python "acm-data/raw/Scaper/02 hdu/hdu_multi_fetch.py" build      # 交给 hdu_pipeline 出包
```
"""
from __future__ import annotations

import argparse
import html
import http.cookiejar
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

# ★ 本进程 stdio 钉 UTF-8（2026-10-18）：关掉 Windows「UTF-8 Beta」后 ACP=936，这里打 `✅ / ⟨…⟩`
#   会 UnicodeEncodeError。与 `app/scripts/utf8_stdio.py` 同一句话（两个根各一份，别无第三份）。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except (AttributeError, ValueError, OSError):
        pass

HERE = os.path.dirname(os.path.abspath(__file__))
SCAPER = os.path.abspath(os.path.join(HERE, '..'))
for _p in (os.path.join(SCAPER, 'lib'), HERE, os.path.join(HERE, 'lib')):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import me                                                      # noqa: E402
import read_modes as rm                                        # noqa: E402

BASE = 'https://acm.hdu.edu.cn'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
LIST = os.path.join(HERE, 'hdu_contests.json')                 # 现成的比赛列表（只读它，不重新枚举）
#: 归档页（`/contests/contest_list.php?page=N`）—— **往年**那 10 场就是从这儿翻出来的；
#: 本地清单只有**当季**那 20 场，往年根本不在里面。
ARCHIVE = os.path.join(HERE, 'cache', 'hdu_contests_all.json')
#: **哪一场是用哪个账号抓的** —— 事实在 `me.json` 的 `hdu.years.<年份>.contestUser` 里
#: （各年那套比赛口令不同：2021 teamB / 2023 teamC / 2024 teamD / 2025 teamE / 2026 teamA）。
#: ★ 2026-10-19 用户定："**所有个人信息理应由 me.json 提供，且不留痕迹**" ⇒ 这里**不再落**
#:   `hdu_contest_accounts.json` 那种 `{cid: 账号}` 的文件（仓库里带 `TEAM0/teamA` 这类队名/账号
#:   会随仓库一起发出去）。出包侧按 cid 查出年份、直接读 `me.json` ⇒ 与原来那张小表逐条相同。
SLEEP = 0.4                                                    # 页与页之间歇一下（与 JS 那份同一个值）
RETRY_SLEEP = 1.5                                              # 归档页拿不到时的退避基数（第 n 次等 n 倍）
MAX_PAGE = 200                                                 # 安全上限（**到末尾靠"连续两页没新行"**；
                                                               #   60 会截断：实测一场 1080 支队就有 60 页）
EMPTY_STOP = 2                                                 # 连续两页没新行/空页 ⇒ 到末尾（与 JS 同口径）
HARD_STOP = 2                                                  # = 流水线那条"当场停"的退出码

#: 登录门的判据（**看正文**：那三个 URL 未登录时也是 200）
LOGIN_RE = re.compile(r'Contest\s+Login', re.I)
#: 表格（榜单与提交页同名，见 `fetch-hdu-rank.js` / `fetch-hdu-submit.js`）
TABLE_RE = re.compile(r'<table[^>]*class="[^"]*page-card-table[^"]*"[^>]*>.*?</table>', re.S | re.I)
#: 一行的身份 = `tr.page-card-row` 里**第一个 `<td>` 的文字** —— 与 `fetch-hdu-submit.js:extract()`
#: 逐字同口径（⚠️ 别再拿"链接里的 uid/pid"当身份：实测 Status 表的行里根本没有那种链接，
#: 于是每页都算"没有标识"，翻两页就误判到末尾 —— 2026-10-17 踩过）。
ROW_RE = re.compile(r'<tr[^>]*class="[^"]*page-card-row[^"]*"[^>]*>(.*?)</tr>', re.S | re.I)
TD_RE = re.compile(r'<td[^>]*>(.*?)</td>', re.S | re.I)
TAG_RE = re.compile(r'<[^>]+>')
#: bundle 里一页的开始（`read_page` 的页级归档就靠它）
PAGE_RE = re.compile(r'<!-- PAGE (\d+) -->\s*\n(.*?)(?=\n*<!-- PAGE |\Z)', re.S)


def row_ids(table_html: str) -> list:
    """这一页每行一个身份（第一格文字）；拿不到行就用整行文字兜底 —— 只给"是不是新页"用"""
    out = []
    for body in ROW_RE.findall(table_html):
        tds = TD_RE.findall(body)
        text = TAG_RE.sub(' ', tds[0] if tds else body)
        text = ' '.join(text.split())
        if text:
            out.append(text)
    return out


def is_login_gate(html: str) -> bool:
    """这一页是不是那道登录门（有表格就不算 —— 口令页里也会出现 Contest Login 字样）"""
    return bool(LOGIN_RE.search(html)) and not TABLE_RE.search(html)


def table_of(html: str) -> str:
    m = TABLE_RE.search(html)
    return m.group(0) if m else ''


# ---------------------------------------------------------------- 会话
class Session:
    """一个 HDU 会话（Cookie 罐 + 统一 UA）；`login()` 过那道比赛口令门"""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def _open(self, req):
        req.add_header('User-Agent', UA)
        cookie = me.hdu_cookie()
        if cookie:
            req.add_header('Cookie', cookie)
        with self.opener.open(req, timeout=40) as res:
            return res.read().decode('utf-8', 'replace')

    def fetch(self, url: str, _cookie: str = '') -> str:
        """给 `Archive.page(fetch=…)` 的形状：`(url, cookie) -> html`"""
        return self._open(urllib.request.Request(url))

    def login(self, cid: str, user: str, password: str) -> str:
        """过 `POST /contest/login?cid=<CID>`；返回正文（调用方看它是不是还是登录门）"""
        data = urllib.parse.urlencode({'username': user, 'password': password}).encode('utf-8')
        req = urllib.request.Request(BASE + f'/contest/login?cid={cid}', data=data)
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        req.add_header('Referer', f'{BASE}/contest/problems?cid={cid}')
        return self._open(req)


# ---------------------------------------------------------------- 页级归档 = bundle 本身
class Bundle(rm.Archive):
    """
    **一个 bundle 文件**当页级归档（`<!-- PAGE n -->` 就是页号）。

    为什么继承 `Archive` 而不是自己写：force / offline / 重试 / 记账 / "好页才入库"
    这五件事全在通用层里 —— 这里只换"一页存哪"这一件事（`path/read/has/write` 四个方法）。
    ⚠️ `read()` / `has()` 必须**自己判 force/offline**（基类那两条是按"一页一个文件"写的）。
    """

    def __init__(self, path: str):
        super().__init__(os.path.dirname(path), '.html')
        self.file = path

    def path(self, _key, _kind) -> str:                 # noqa: D102 —— 页不各占一个文件
        return self.file

    def pages(self) -> dict:
        """现有页 ⇒ `{页号: 表格 HTML}`"""
        if not os.path.isfile(self.file):
            return {}
        try:
            with open(self.file, encoding='utf-8', errors='replace') as fh:
                txt = fh.read()
        except OSError:
            return {}
        return {int(n): body.strip() for n, body in PAGE_RE.findall(txt)}

    def read(self, _key, kind) -> str:
        if rm.forced() or rm.active_cache(rm.CACHE_KEEP) == rm.CACHE_NONE:
            return ''                                  # `--force` / `--cache-mode none`：当作没有
        if rm.offline() and not os.path.isfile(self.file):
            rm.require_local(self.file, 'HDU 原料')
        return self.pages().get(int(kind), '')

    def has(self, _key, kind) -> bool:
        return bool(self.read('', kind))

    def write(self, _key, kind, html) -> None:
        """存这一页 —— **只在它带来新行时**才存（与浏览器脚本 `fetch-hdu-submit.js` 的 `take()` 同口径）。

        ⚠️ 实测（2026-10-17，cid 1238）：HDU 的 `page` 语义很刁 —— 有的相邻页**内容一样**
        （实测 1↔2、3↔4…），"翻过头"时它也不报错、照样渲染**最后一页**。若把每一页都往 bundle 里塞，
        解析侧就会把同一支队/同一条提交**数两遍**（榜单的过队数直接算错）。
        """
        table = table_of(html)
        new_ids = set(row_ids(table))
        pages = self.pages()
        old_ids = set()
        for body in pages.values():
            old_ids |= set(row_ids(body))
        if new_ids and new_ids <= old_ids:
            return                                     # 这一页全是见过的行 ⇒ 不存（它不是新的一页）
        pages[int(kind)] = table.strip() if table else html.strip()
        self.save(pages)

    def save(self, pages: dict) -> None:
        os.makedirs(os.path.dirname(self.file), exist_ok=True)
        head = [f'<!-- hdu-bundle',
                f'     pages={len(pages)}',
                f'     fetchedAt={time.strftime("%Y-%m-%dT%H:%M:%S")}',
                f'     本文件由 02 hdu/hdu_multi_fetch.py 生成；每页之间用 "<!-- PAGE n -->" 分隔',
                '-->']
        body = [f'<!-- PAGE {n} -->\n{pages[n]}' for n in sorted(pages)]
        with open(self.file, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('\n'.join(head + body) + '\n')


# ---------------------------------------------------------------- 一场
def grab(sess: Session, cid: str, path: str, kind: str, url_of, first_page: int) -> tuple[int, str]:
    """
    逐页抓进 `path`（bundle），到末尾自动停。

    @param first_page 榜单 **0 基**、提交 **1 基**（`fetch-hdu-submit.js` 的注释里实测写着）
    @returns `(抓到几页, 停止原因)`；**登录门** ⇒ `(n, '登录门')`，调用方据此当场停
    """
    bundle = Bundle(path)
    if rm.forced() or rm.active_cache(rm.CACHE_KEEP) == rm.CACHE_NONE:
        # ★ `--force` = "把已有的当成不存在" ⇒ **整份重来**。
        #   ⚠️ 不先清掉的话，下面"只存有新行的页"会拿**旧**内容去比 ⇒ 新抓的页全被判成重复、
        #   文件被覆盖成只剩一两页（实测踩到：60 页 → 1 页）。
        if os.path.isfile(path):
            os.remove(path)
    known = set(bundle.pages())                        # 已有的页（`--force` 时已被清掉）
    seen: set = set()
    gate: list = []
    empty = 0
    page = first_page
    got = 0

    def good(html: str) -> bool:
        if is_login_gate(html):
            gate.append(page)
            return False                               # 登录门不是好页 ⇒ 不重试、不入库
        return True

    for _ in range(MAX_PAGE):
        html = bundle.page(key=cid, kind=str(page), url=url_of(page), fetch=sess.fetch,
                           accept=good, verbose=False,
                           label=f'{kind} page={page}（cid={cid}）')
        if gate:
            return got, '登录门'
        if not html:
            break                                      # 离线 / 试完都失败 ⇒ 停（上面已说明原因）
        table = table_of(html)
        ids = set(row_ids(table))
        if not table or not ids:
            empty += 1
        elif not (ids - seen):
            empty += 1                                 # 这一页没有新行（翻过头了 / 与上一页一样）
        else:
            empty = 0
            seen |= ids
            got += 1
        if empty >= EMPTY_STOP:
            break
        page += 1
        time.sleep(SLEEP)
    why = '连续两页没新行' if empty >= EMPTY_STOP else '到末尾'
    return got, why


def clue_name(user: str) -> str:
    """
    把抓取用的裸账号换成**本人声明过的写法**（me.json 花名册里登记成 `队名/账号` 的那种）。

    实现只有 `lib/me.py:declared_handle()` 一份（抓取侧与出包侧都用同一条判据）：
    `me.json` 里若声明过**同一个账号**的 handle（`队名/账号`），就用**声明的那一个** ——
    这样已导入的 2026 那批（`TEAM0/teamA`）的映射照旧认得上。
    ⚠️ 但**不替它编队名**：没声明过 `队名/账号` 就原样写账号（用户 2026-10-17："不可能全是 TEAM0"）。
    """
    return me.declared_handle('hdu', user)


def do_fetch(rows: list[dict], skip_rank: bool) -> int:
    base_user, base_pwd = me.hdu_contest_login()
    if not base_pwd:
        print('❌ 没配 HDU 比赛口令：在 `个人数据/me.json` 的 `hdu` 段加\n'
              '     "years": { "2026": { "contestUser": "<用户名>", "contestPassword": "<口令>" } }\n'
              '   （按年一套；顶层 `contestUser/contestPassword` 是兜底；'
              '也可以临时给环境变量 HDU_CONTEST_USER / HDU_CONTEST_PASSWORD）', file=sys.stderr)
        return HARD_STOP
    skipped: list = []                                 # 这一轮没抓成的场次 + 原因
    for row in rows:
        cid = str(row['contest_id'])
        year = str(year_of(row) or '')
        user, password = me.hdu_contest_login(year=year)
        print(f'\n=== cid {cid}｜{row.get("contest_name")}｜{str(row.get("start_time"))[:10]} ===')
        if not password:
            print(f'   ⚠️ 跳过：**{year} 年的口令没配**（`hdu.years.{year}`）', file=sys.stderr)
            skipped.append((cid, f'{year} 年没配口令'))
            continue
        sess = Session()
        if not rm.offline():
            body = sess.login(cid, user, password)
            if is_login_gate(body):
                # ★ **这场口令不对 ≠ 全部停下**（2026-10-17 改）：HDU 每场/每系列一个口令的话，
                #   第一场错就把后面全停掉，"全自动"就没意义了。
                #   区分两种门：明确回 `Invalid username or password` = **这一场**的口令问题 ⇒ 跳过这场；
                #   其它登录门（会话/站点层面）= 全局问题 ⇒ 仍按"当场停"处理。
                if 'invalid username or password' in body.lower():
                    print(f'   ⚠️ 跳过这一场：口令不对（cid {cid}，{year} 年那套）—— 继续抓后面的场次',
                          file=sys.stderr)
                    skipped.append((cid, '口令不对'))
                    continue
                print(f'   ⛔ 登录门（cid {cid}）—— **停在这里**，后面那些场次不跑了\n'
                      f'      这不是"这一场口令不对"（那会跳过继续），而是会话/站点层面的问题',
                      file=sys.stderr)
                return HARD_STOP
        # ★ "这一场是用哪个账号抓的"（2026-10-17 用户看图：「不可能全是 teamA，而且不可能
        #   全是 TEAM0」）：出包侧要按 cid 写账户线索，而不是拿一个全局 `--handle` 盖满 50 场。
        #   ★ 2026-10-19 起**不落文件**：这行账号已经在 `me.json` 的 `hdu.years.<年>.contestUser` 里
        #     （上面 `me.hdu_contest_login(year=…)` 读的就是它），出包侧按 cid 查年份直接取 ⇒
        #     仓库里不留任何 `{cid: 账号}` 痕迹。这里只把它**打出来**（万一某年没声明，屏幕上看得出）。
        where = f'hdu.years.{year}.contestUser' if year else '顶层 hdu.contestUser'
        print(f'   账号：{clue_name(user)}（`me.json` 的 `{where}`）')
        probs = p(row, 'problems_source.html')
        if rm.offline() and not os.path.isfile(probs) and not os.path.isfile(p(row, 'problems.json')):
            rm.require_local(probs, '题目页原料')
        if rm.should_refetch(os.path.isfile(probs)) and not os.path.isfile(p(row, 'problems.json')):
            html = sess.fetch(f'{BASE}/contest/problems?cid={cid}')
            if is_login_gate(html):
                print(f'   ⛔ 题目页仍是登录门（cid {cid}）', file=sys.stderr)
                return HARD_STOP
            os.makedirs(os.path.dirname(probs), exist_ok=True)
            with open(probs, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(html)
            print(f'   ↓ 题目页 → {os.path.relpath(probs, HERE)}（{len(html)} 字节）')
        else:
            print('   · 题目页：本地已有（`--force` 可重抓）')

        plan = [('submit.html', '提交', lambda pg: f'{BASE}/contest/status?cid={cid}&status=&page={pg}', 1)]
        if not skip_rank:
            plan.append(('rank.html', '榜单',
                         lambda pg: f'{BASE}/contest/rank?cid={cid}&page={pg}', 0))
        for name, label, url_of, first in plan:
            path = p(row, name)
            n, why = grab(sess, cid, path, label, url_of, first)
            if why == '登录门':
                print(f'   ⛔ {label}抓到登录门（cid {cid}）—— 停', file=sys.stderr)
                return HARD_STOP
            if n:
                print(f'   ↓ {label} 新抓 {n} 页 → {os.path.relpath(path, HERE)}（{why}）')
            else:
                print(f'   · {label}：没有新页（{why}）')
    rm.print_stats('HDU 赛内页')
    if skipped:
        print('\n⚠️ 这一轮有 %d 场没抓成（口令不对，**不影响其它场次**）：' % len(skipped))
        for cid, why in skipped:
            print('   · cid %s：%s' % (cid, why))
        print('   这些场次的手存原料（如果有）仍在，`build` 照旧能用它们出包。')
        return 0                                       # 部分跳过**不算失败**（包照旧出）
    return 0


# ---------------------------------------------------------------- 落哪
def contest_rows() -> list[dict]:
    """`hdu_contests.json`（**产包**要的那些场次元信息；`hdu_adapter.py` 按它写 C 的名字/时间）"""
    if not os.path.isfile(LIST):
        return []
    with open(LIST, encoding='utf-8-sig') as fh:
        got = json.load(fh)
    return got if isinstance(got, list) else list(got.get('contests') or [])


def enumerate_archive(pages: int = MAX_PAGE) -> list:
    """
    把 HDU 的比赛归档翻一遍：`/contests/contest_list.php?page=N`（第 0 页 = 不带参数）。

    ⚠️ **这一页是 GBK 编码**（用 utf-8 解会得到一堆 `�`）；`02 hdu` 里别的页面是 utf-8，
       所以这条解码只在这里用，别套到别处去。
    ⚠️ 这是"往年场次打哪儿来"的唯一入口 —— 本地 `hdu_contests.json` 只有**当季**那 20 场
       （2026-10-17 实测：`/contests` 与它一模一样），往年（2025/2024/…）根本不在里面。

    ★ **这一份要么整份、要么没有**（2026-10-17 踩到）：它原来是"某页拿不到就 `continue`"，
      于是"翻到一半超时"和"翻完了"两种结果长得一模一样 —— 缓存被写成 40 场，
      而"每年 10 场"少了几年是**看不出来的**（清单照样排得整整齐齐）。
      现在判据只看**抓取事件**，不看行数（"比上次少就别写"那种比法要被"今年真少了 4 场"推翻，
      不成立）：**任一页重试 3 次仍拿不到 ⇒ 当场退出、缓存一个字节不动**；
      **到末尾**由"连续 `EMPTY_STOP` 页没有新 cid"认定（HDU 翻过头会把最后一页重复给你，
      空页和重复页都算"没有新 cid"），所以也不需要预先知道总共几页。

    @returns `[{cid, name, start, type, status}]`
    """
    import urllib.request

    def page_body(page: int) -> str:
        url = BASE + '/contests/contest_list.php' + (f'?page={page}' if page else '')
        last: Exception | None = None
        for attempt in (1, 2, 3):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': UA})
                with urllib.request.urlopen(req, timeout=40) as res:
                    return res.read().decode('gbk', 'replace')   # ← GBK，见上面
            except Exception as err:                             # noqa: BLE001
                last = err
                time.sleep(RETRY_SLEEP * attempt)
        raise SystemExit(
            f'❌ 归档第 {page} 页试了 3 次都拿不到（{type(last).__name__}: {last}）\n'
            f'   ⇒ **整次枚举作废，缓存一个字节不动**（半份清单会让"每年 10 场"静默少几年）；'
            f'稍后原样重跑这条命令即可')

    out: dict = {}
    empty = 0
    for page in range(0, pages):
        body = page_body(page)
        fresh = 0
        for m in re.finditer(r'/contest/problems\?cid=(\d+)"[^>]*>\s*([^<]*)</a>(.*?)</tr>',
                             body, re.S):
            # ⚠️ 名字里带 HTML 实体（实测 `&nbsp;2021“MINIEYE杯”…`）—— 不洗掉就会原样进包，
            #   应用里显示成 `&nbsp;2021…`（2026-10-17 踩到）。
            cid = m.group(1)
            name = html.unescape(m.group(2).replace('&nbsp;', ' ')).strip()
            rest = m.group(3)
            cells = [re.sub(r'<[^>]+>', '', c).strip() for c in
                     re.findall(r'<td[^>]*>(.*?)</td>', rest, re.S)]
            cells = [' '.join(c.split()) for c in cells]
            start = next((c for c in cells if re.match(r'20\d{2}', c)), '')
            kind = next((c for c in cells if c in ('Public', 'Private', 'Register')), '')
            if cid not in out:
                fresh += 1
            out[cid] = {'cid': cid, 'name': name, 'start': start, 'type': kind,
                        'status': cells[-1] if cells else ''}
        empty = 0 if fresh else empty + 1
        if empty >= EMPTY_STOP:
            break
        time.sleep(SLEEP)
    if not out:
        raise SystemExit('❌ 归档页一页 cid 都没解析出来（页面结构变了？）⇒ **不写缓存**')
    rows = list(out.values())
    os.makedirs(os.path.dirname(ARCHIVE), exist_ok=True)
    with open(ARCHIVE, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(rows, fh, ensure_ascii=False, indent=1)
    return rows


def archive_rows(refresh: bool = False, local_only: bool = False) -> list:
    """
    归档清单（有缓存就用缓存；`--refresh-archive` 才重翻）。

    @param local_only  True ⇒ **一次也不联网**（没有缓存就直接说"没有"，交给调用方退回本地清单）。
                       出包那一路（`build`）用它：它是"把盘上原料变成包"，不该顺手去翻 36 页归档
                       （`crate:nk` 的 `build` 也是纯本地的，两个平台同一形状 —— 2026-10-17 统一）。
    """
    if not refresh and os.path.isfile(ARCHIVE):
        try:
            with open(ARCHIVE, encoding='utf-8') as fh:
                got = json.load(fh)
            if got:
                return got
        except (OSError, ValueError):
            pass
    if local_only:
        return []
    return enumerate_archive()


def fetch_rows(*, cids=(), year: int = 0, all_: bool = False, refresh: bool = False,
               local_only: bool = False) -> list:
    """
    **要抓哪些场次**：默认 = **每年那 10 场多校**（从归档枚举里挑；归档读不到才退回本地清单）。

    @param cids  指名抓这几场（逗号分隔来的）
    @param year  只抓这一年
    @param all_  连非多校的一起抓
    @param refresh 重翻归档页
    @param local_only 只用盘上已有的（归档缓存缺失时**不联网**，退回 `hdu_contests.json`）
    """
    raw = archive_rows(refresh, local_only)
    if not raw:
        if local_only and not os.path.isfile(ARCHIVE):
            print('   · 没有归档缓存（`02 hdu/cache/hdu_contests_all.json`）⇒ 这次只按本地清单补元信息；'
                  '要重翻归档：`hdu_multi_fetch.py fetch --refresh-archive`')
        raw = [{'cid': str(r.get('contest_id') or ''), 'name': r.get('contest_name') or '',
                'start': r.get('start_time') or ''} for r in contest_rows()]
    out = []
    for r in raw:
        cid, name, start = str(r.get('cid') or ''), r.get('name') or '', r.get('start') or ''
        if not cid:
            continue
        if cids and cid not in cids:
            continue
        y = int(start[:4]) if start[:4].isdigit() else year_of({'start_time': start})
        if year and y != year:
            continue
        if not cids and not all_ and not is_multi({'contest_name': name}):
            continue
        out.append({'contest_id': cid, 'contest_name': name,
                    'start_time': start or str(y)})
    # 按"年份升序 + cid 升序"排（归档页是倒序给的；抓的时候按赛季顺序看着顺眼）
    out.sort(key=lambda r: (year_of(r), int(r['contest_id']) if r['contest_id'].isdigit() else 0))
    return out


def merge_into_list(rows: list) -> int:
    """
    把这次要抓的场次**补进 `hdu_contests.json`**（`hdu_adapter.py` 按它写 C 的名字/开赛时间）。

    往年场次本来就不在这份清单里（它只有当季 20 场），不补的话 `build` 出来的 C 没有名字/时间。
    @returns 补了几条
    """
    have = {str(r.get('contest_id') or '') for r in contest_rows()}
    add = [{'contest_id': str(r['contest_id']),
            'contest_name': r.get('contest_name') or '',
            'link': f'{BASE}/contest/problems?cid={r["contest_id"]}',
            'start_time': r.get('start_time') or '',
            'end_time': '',
            'type': 'Private', 'status': ''}
           for r in rows if str(r.get('contest_id')) not in have]
    if not add:
        return 0
    allrows = contest_rows() + add
    with open(LIST, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(allrows, fh, ensure_ascii=False, indent=1)
    return len(add)


def year_of(row: dict) -> int:
    m = re.match(r'(\d{4})', str(row.get('start_time') or ''))
    return int(m.group(1)) if m else 0


#: 赛名里出现这些词就算"多校"（用户 2026-10-17："实际上 hdu 只需要每年 10 场多校"）。
#: ⚠️ **词表只有一份**：`lib/hdu_common.py` 的 `MULTI_WORDS` —— 出包侧
#: （`hdu_adapter.SERIES_RULES`，决定挂「杭电多校」还是「其他比赛」）读的是同一份。
#: 2026-10-17 就是因为那边自己另写了一遍很窄的规则，2021 那十场跑进了「其他比赛」。
from hdu_common import is_multi_name                              # noqa: E402


def is_multi(row: dict) -> bool:
    """这场是不是"多校"（按**赛名**判：暑期联赛 / 超级联赛 / Multi-University / 多校）"""
    return is_multi_name(str(row.get('contest_name') or ''))


def round_of(row: dict) -> str:
    """赛名里那一场的序号：`…暑期联赛（10）` → `10`（认不出就用 cid 兜底）"""
    m = re.findall(r'[（(](\d{1,2})[)）]', str(row.get('contest_name') or ''))
    return m[-1] if m else str(row.get('contest_id') or '')


def p(row: dict, kind: str) -> str:
    """
    某场某类原料的规范路径（**命名规则只有一份**：与 `02 hdu/_usage.md` §1 那张表一致）。
    落 `02 hdu/<yy>hdu/<yy>hdu<N>/` —— 目录名不参与识别（身份写在文件名里），
    与手存那批（`26hdu/26hdu1..10`）同一个位置。
    """
    yy = str(year_of(row) or '')[-2:] or 'xx'
    return os.path.join(HERE, f'{yy}hdu', f'{yy}hdu{round_of(row)}',
                        f'hdu_cid{row["contest_id"]}_{kind}')


# ---------------------------------------------------------------- 自测
def selftest() -> int:
    """
    离线自测（不联网、不动真原料）：**行身份**、**bundle 去重**、**归档枚举的整份或没有**。

    为什么必须钉（2026-10-17 实测踩到的三个坑，都会把数据**静默数错**）：
      ① 行身份曾用"链接里的 `uid/pid`" ⇒ Status 表的行里根本没有那种链接 ⇒ 每页都算"没有标识"
         ⇒ 翻两页就误判到末尾（结果只抓到 1 页）。正确口径 = `tr.page-card-row` 第一格文字
         （与 `fetch-hdu-submit.js:extract()` 一字不差）。
      ② HDU 翻过头**不报错、照样渲染最后一页**，相邻页还会重复 ⇒ 旧实现把重复页也存进 bundle
         ⇒ 榜单的过队数/提交数被**数两遍**。现在"只存带来新行的页"。
      ③ 归档枚举曾是"这一页拿不到就 `continue`" ⇒ 半份清单与整份**长得一模一样**；更好的判据不是
         "比上次少就别写"（那要被"今年真少了 4 场"推翻），而是**拿不到就整次作废**。
    """
    import shutil

    bad, ok = [], 0

    def check(name, cond, detail=''):
        nonlocal ok
        if cond:
            ok += 1
        else:
            bad.append('%s %s' % (name, detail))

    # ---- ① 行身份：第一格文字（`<tr class="page-card-row">`）----
    table = ('<table class="page-card-table">'
             '<tr><td>表头</td></tr>'
             '<tr class="page-card-row"><td> 12 </td><td>1001</td></tr>'
             '<tr class="page-card-row odd"><td>13</td><td>1002</td></tr>'
             '<tr class="page-card-row"><td> </td><td>空行不算</td></tr>'
             '</table>')
    check('行身份 = tr.page-card-row 第一格文字（表头不算、空行不算）',
          row_ids(table) == ['12', '13'], row_ids(table))

    # ---- ② bundle 去重：只存带来新行的页 ----
    tmp = os.path.join(HERE, '.hdu-selftest')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp, exist_ok=True)
    try:
        path = os.path.join(tmp, 'hdu_cid1_rank.html')
        b = Bundle(path)

        def page(*ids_):
            return ('<table class="page-card-table">'
                    + ''.join('<tr class="page-card-row"><td>%s</td></tr>' % i for i in ids_)
                    + '</table>')

        b.write('1', '0', page('a', 'b'))
        check('第一页照存', list(b.pages()) == [0], list(b.pages()))
        b.write('1', '1', page('a', 'b'))
        check('★ 全是见过的行 ⇒ 不存（否则同一支队/同一条提交会被数两遍）', list(b.pages()) == [0],
              list(b.pages()))
        b.write('1', '2', page('c', 'd'))
        check('有新行的页照存', list(b.pages()) == [0, 2], list(b.pages()))

        # ---- ③ `--force`：整份重来（不清掉的话新抓的页会被旧内容判成重复） ----
        rm.configure(force=True)
        check('★ `--force` ⇒ 归档当不存在（read 返回空）', b.read('1', '0') == '')
        rm.configure(force=False)
        check('不带 force ⇒ 读得回来', b.read('1', '0') != '')

        # ---- ④ 归档枚举：**要么整份、要么没有**（2026-10-17 踩到：某页超时被 `continue` 跳过，
        #        缓存被写成半份，而"每年 10 场"少了几年是看不出来的）----
        import urllib.request as _ur
        g = globals()
        saved = (g['ARCHIVE'], g['SLEEP'], g['RETRY_SLEEP'], _ur.urlopen)
        cache = os.path.join(tmp, 'archive.json')

        def row(cid, name):
            return ('<tr><td><a href="/contest/problems?cid=%s">%s</a></td>'
                    '<td>2025-07-01</td><td>Public</td><td>Ended</td></tr>' % (cid, name))

        pages = {0: row('1000', '2025 多校 1'), 1: row('1001', '2025 多校 2'),
                 2: row('1002', '2025 多校 3')}          # `&nbsp;` 与 GBK 一起验

        class _Res:
            def __init__(self, body):
                self._b = body

            def read(self):
                return self._b.encode('gbk')              # ← 归档页是 GBK（见 `enumerate_archive`）

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_ok(req, timeout=0):
            page = int(re.search(r'page=(\d+)', req.full_url).group(1)) if 'page=' in req.full_url else 0
            return _Res('<table>' + pages.get(min(page, 2), pages[2]) + '</table>')  # 翻过头 = 重复最后一页

        try:
            g['ARCHIVE'] = cache
            g['SLEEP'] = g['RETRY_SLEEP'] = 0
            _ur.urlopen = fake_ok
            got = enumerate_archive()
            check('★ 归档枚举：翻过头（重复页）靠"没新 cid"停，三场都在',
                  [r['cid'] for r in got] == ['1000', '1001', '1002'], [r['cid'] for r in got])
            check('★ 归档页按 GBK 解、名字里的实体洗掉',
                  got[0]['name'] == '2025 多校 1', got[0]['name'])

            before = open(cache, 'rb').read()

            def fake_bad(req, timeout=0):
                if 'page=' not in req.full_url:
                    return fake_ok(req)
                raise OSError('半路断了')

            _ur.urlopen = fake_bad
            raised = ''
            try:
                enumerate_archive()
            except SystemExit as err:
                raised = str(err)
            check('★ 有页拿不到 ⇒ 当场退出，**不写成半份缓存**',
                  '整次枚举作废' in raised and open(cache, 'rb').read() == before, raised[:60])
        finally:
            g['ARCHIVE'], g['SLEEP'], g['RETRY_SLEEP'], _ur.urlopen = saved
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # ---- ⑤ "哪一场算多校"只有一份词表：出包侧必须认全（2026-10-17 用户看到 2021 跑进「其他比赛」）----
    try:
        import hdu_adapter as _ad
        names = ['2026“钉耙编程”中国大学生算法设计暑期联赛（1）',
                 '2024“钉耙编程”中国大学生算法设计超级联赛（3）',
                 '2022“杭电杯”中国大学生算法设计超级联赛（5）',
                 '2021“MINIEYE杯”中国大学生算法设计超级联赛（10）',
                 '2019 Multi-University Training Contest 4']
        got = [(nm, _ad.pick_series(nm)[0]) for nm in names]
        check('★ 出包侧认得出每一年的多校名（同一份词表）',
              all(key == 'summer' for _, key in got), [g for g in got if g[1] != 'summer'])
        check('★ 非多校的别被误判成多校（校赛/公开赛还在自己那一档）',
              _ad.pick_series('第十届HDU校赛') [0] == 'hdu', _ad.pick_series('第十届HDU校赛'))
    except Exception as err:                                  # noqa: BLE001
        bad.append('出包侧系列规则核不了（%s: %s）' % (type(err).__name__, err))

    # ---- ⑥ 账户线索**按 cid 的年份**取，不是全局一个（用户 2026-10-17：「不可能全是 teamA」）----
    # ★ 2026-10-19：事实来源改成 `me.json` 的 `hdu.years.<年份>.contestUser`（用户：
    #   "所有个人信息理应由 me.json 提供，且不留痕迹"）⇒ 这条守卫钉的是**推导**：
    #   同一个 `--handle` 不许盖满全场，两场不同年份必须出两个值；
    #   顺便钉住"仓库里不许再有那份 `{cid: 账号}` 文件"。
    try:
        import hdu_adapter as _ad

        class _FakeMe:                     # 只实现出包侧用到的那三样
            YEARS = {'2021': 'teamB', '2026': 'teamA'}

            def hdu_year_accounts(self):
                return dict(self.YEARS)

            def get(self, dotted, default=''):
                return 'topTeam' if dotted == 'hdu.contestUser' else default

            def declared_handle(self, platform, account):
                return 'TEAM0/' + account if account == 'teamA' else account

        keep = _ad._me
        _ad._me = lambda: _FakeMe()
        try:
            def _prob(cid, title):
                return {'problem_id': '1001', 'problem_id2': 'A', 'title': title,
                        'link': f'https://acm.hdu.edu.cn/contest/problem?cid={cid}&pid=1001',
                        'ratio': '1%', 'accepted': 1, 'submitted': 2,
                        '_来源文件': f'hdu_cid{cid}_problems.json'}

            def _sub(cid, rid, when):
                return {'运行ID': rid, '题号': '1001', '题号2': 'A', '运行结果': 'Accepted',
                        '题目链接': f'https://acm.hdu.edu.cn/contest/problem?cid={cid}&pid=1001',
                        '提交时间': when, '_来源文件': f'hdu_cid{cid}_submits.json'}

            subs = [_sub('1238', '1', '2026-07-21 12:10:00'), _sub('989', '2', '2021-07-27 12:10:00')]
            cons = [{'contest_id': '1238', 'contest_name': '2026 x',
                     'start_time': '2026-07-21 12:00:00'},
                    {'contest_id': '989', 'contest_name': '2021 y',
                     'start_time': '2021-07-27 12:00:00'}]
            crate, _w = _ad.build(cons, [_prob('1238', 'x'), _prob('989', 'y')], subs,
                                 handle=['TEAM0/teamA'])
            seen = {}
            for rec in crate.to_dict()['records']:
                clue = rec.get('账户线索')
                if isinstance(clue, dict) and ':sub:' in rec['extKey']:
                    seen[rec['extKey'].split(':')[2]] = clue.get('value')
            check('★ 账户线索按 cid 的年份取（两场不同年份 ⇒ 两个值，不是一个 --handle 盖满）',
                  seen == {'1238': 'TEAM0/teamA', '989': 'teamB'}, seen)
        finally:
            _ad._me = keep
        check('★ 仓库里不许再有 `hdu_contest_accounts.json`（个人信息只在 me.json）',
              not os.path.isfile(os.path.join(HERE, 'hdu_contest_accounts.json')),
              os.path.join(HERE, 'hdu_contest_accounts.json'))

        # ★ 线索值**不许由花名册顺序决定**（2026-10-19：`teamA` 与 `TEAM0/teamA` 同时登记，
        #   原来"先碰上的"说了算 ⇒ 同一份数据能得出两个值，与已导入的 `TEAM0/teamA` 对不上）
        real_handles = me.handles
        try:
            for order in (['teamA', 'TEAM0/teamA'], ['TEAM0/teamA', 'teamA']):
                me.handles = lambda _p, _o=order: list(_o)
                got_one = me.declared_handle('hdu', 'teamA')
                check(f'★ 线索值优先取带队名的那份（花名册顺序 {order[0]} 在前也一样）',
                      got_one == 'TEAM0/teamA', got_one)
            me.handles = lambda _p: ['teamA']
            check('没登记过 `队名/账号` 就原样用裸账号（**不替它编队名**）',
                  me.declared_handle('hdu', 'teamA') == 'teamA', me.declared_handle('hdu', 'teamA'))
        finally:
            me.handles = real_handles

        # ---- ⑦ 分页榜单的合并：**页边界上的重复行只算一次、且 results 取并集** ----
        # 为什么要有这条（2026-10-18 实测 cid 984，21 页）：HDU 的榜单每页 54 个 `<tr>`、
        # 里面有 4 个 `page-card-table`（表头镜像 + 主表 + **本队置顶表**），而**主表每页只有 51 队**；
        # 逐页相加 21×51 = 1068，去重后 **1047**（= `teamCount`）⇒ 每处页边界重复 1 行。
        # 所以"页数 / `<tr>` 数 / 行数"三个数**都不该拿来当队数** —— 唯一的判据是 `parse_pages`
        # 合并去重后的 `len(teams)`。这条守卫就是钉它的：去掉去重 ⇒ 下面那个 2 会变 3。
        try:
            import hdu_rank_parser as _rp
            head = ('<tr><th>Rank</th><th>Author</th><th>Solved</th><th>Penalty</th>'
                    '<th>1001 1/2</th></tr>')
            # 主表第 1 页：A、B 两队（B 那格还空着）
            p1 = ('<table class="page-card-table">%s'
                  '<tr><td>1</td><td>team0001<br/>A</td><td>1</td><td>00:10:00</td>'
                  '<td class="rank-status-accepted">00:09:00</td></tr>'
                  '<tr><td>2</td><td>team0002<br/>B</td><td>0</td><td>00:00:00</td>'
                  '<td class="rank-status-empty"></td></tr></table>') % head
            # 主表第 2 页：**B 又出现一次**（页边界重复），这一页那格补上了通过；另有 C
            p2 = ('<table class="page-card-table">%s'
                  '<tr><td>2</td><td>team0002<br/>B</td><td>1</td><td>00:20:00</td>'
                  '<td class="rank-status-accepted">00:18:00</td></tr>'
                  '<tr><td>3</td><td>team0003<br/>C</td><td>0</td><td>00:00:00</td>'
                  '<td class="rank-status-empty"></td></tr></table>') % head
            # ⚠️ 每一页**前面**必须有自己的 `<!-- PAGE n -->`（实测真文件就是这么拼的：第一段是空的，
            #    页内容都在标记之后）—— 少了它那一段会被整段跳过。
            got = _rp.parse_pages('<!-- PAGE 0 -->' + p1 + '<!-- PAGE 1 -->' + p2)
            names = [(t.get('teamId') or '') for t in (got.get('teams') or [])]
            check('★ 页边界的重复队只算一次（两页共 4 行、3 支不同的队，B 出现两页）',
                  len(names) == 3 and names.count('team0002') == 1, names)
            b_row = [t for t in (got.get('teams') or []) if t.get('teamId') == 'team0002']
            check('★ 重复的那两页里，results 是**并集**（后一页补前一页缺的那格，不整行覆盖）',
                  len(b_row) == 1 and (b_row[0].get('results') or {}).get('1001', {}).get('state')
                  == 'accepted', b_row)
        except Exception as err:                                # noqa: BLE001
            bad.append('分页榜单合并核不了（%s: %s）' % (type(err).__name__, err))

    except Exception as err:                                  # noqa: BLE001
        bad.append('出账线索核不了（%s: %s）' % (type(err).__name__, err))

    if bad:
        for x in bad:
            print('  ❌ %s' % x)
        return 1
    print('✅ HDU 多抓自测通过：%d 项（行身份 + bundle 去重 + force 语义 + 归档整份或没有 + '
          '多校词表只有一份 + 分页榜单合并去重）' % ok)
    return 0


# ---------------------------------------------------------------- 入口
def main(argv) -> int:
    ap = argparse.ArgumentParser(description='HDU 多校：登录 → 逐页抓原料（不解析、不出包）')
    ap.add_argument('cmd', nargs='?', default='fetch', choices=('fetch', 'build', 'list'),
                    help='fetch=抓原料（默认）；build=交给 hdu_pipeline 出包；list=看有哪些场')
    ap.add_argument('--selftest', action='store_true', help='离线自测（不联网、不动真原料）')
    ap.add_argument('--cid', default='', help='只抓这几场（逗号分隔）；默认**只抓多校**（见 --all）')
    ap.add_argument('--all', action='store_true',
                    help='连非多校的场次一起抓（春季联赛 / 校赛…）—— 默认只抓"每年那 10 场多校"')
    ap.add_argument('--year', type=int, default=0, help='只抓这一年的多校（如 2025；默认全部年份）')
    ap.add_argument('--refresh-archive', action='store_true',
                    help='重翻 HDU 的比赛归档页（默认用 `02 hdu/cache/hdu_contests_all.json`）')
    ap.add_argument('--from-year', type=int, default=0, help='只抓这一年及以后的场次')
    ap.add_argument('--skip-rank', action='store_true', help='不抓榜单（只要题名+过题数时用）')
    ap.add_argument('--keep-source', action='store_true',
                    help='给 build：源 HTML 留着（默认解析成功就删，榜单一份 7MB）')
    rm.add_cli_args(ap, force_help='**强制重抓**：本地已有的原料当没有，全部重新拉一遍（会先清掉旧 bundle）')
    args = ap.parse_args(argv)
    rm.configure_from(args)

    if args.selftest:
        return selftest()

    if args.cmd == 'list':
        rows = contest_rows()
        print(f'hdu_contests.json：{len(rows)} 场')
        for row in rows:
            have = [k for k in ('problems_source.html', 'problems.json', 'submit.html', 'submits.json',
                                'rank.html', 'rank_stats.json') if os.path.isfile(p(row, k))]
            print('  %-6s %-10s %-40s ｜ 已有: %s'
                  % (row.get('contest_id'), str(row.get('start_time'))[:10],
                     str(row.get('contest_name'))[:40], ','.join(have) or '—'))
        return 0

    if args.cmd == 'build':
        # 往年场次不在 `hdu_contests.json` 里 ⇒ 先补进去（否则 C 没名字/时间）。
        # ⚠️ **只补"本地真有原料"的那些**：按选择器补会把整年的春季联赛/校赛也塞进去
        #   （实测：`--year 2025` 一年有 32 场归档，只有 10 场多校有原料）。
        rows = fetch_rows(year=args.year, all_=True, local_only=True)
        # ⚠️ **"有原料"要连未解析的源 HTML 一起算**（2026-10-17 踩到）：这一步跑在流水线**之前**，
        #   新抓的只有 `*_source.html` / `*_submit.html`，`problems.json` 要等流水线解析完才有
        #   ⇒ 只认 `.json` 的话新场次会被当成"没原料"，元信息一条都补不进去（结果 C 名字全是"比赛 984"）。
        ready = [r for r in rows
                 if any(os.path.isfile(p(r, k)) for k in
                        ('problems.json', 'problems_source.html', 'submits.json', 'submit.html'))]
        added = merge_into_list(ready)
        if added:
            print(f'   ＋ 往 hdu_contests.json 补了 {added} 场（往年场次的元信息来自归档页）')
        cmd = [sys.executable, '-B', os.path.join(HERE, 'hdu_pipeline.py'), '--all']
        if args.keep_source:
            cmd.append('--keep-source')
        print('$ ' + ' '.join('"%s"' % c if ' ' in c else c for c in cmd))
        return subprocess.call(cmd)

    want = {c.strip() for c in (args.cid or '').split(',') if c.strip()}
    rows = fetch_rows(cids=want, year=args.year, all_=args.all, refresh=args.refresh_archive)
    if args.from_year:
        rows = [r for r in rows if year_of(r) >= args.from_year]
    if not rows:
        print('❌ 没有匹配的场次（`list` 看有哪些；`--year` / `--cid` / `--all` 是选择器）',
              file=sys.stderr)
        return 1
    years = sorted({year_of(r) for r in rows})
    print(f'🎯 {len(rows)} 场待抓（年份 {",".join(str(y) for y in years)}'
          + ('；含非多校' if args.all else '；只取多校')
          + f'）' + ('；--skip-rank 跳过榜单' if args.skip_rank else ''))
    return do_fetch(rows, args.skip_rank)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
