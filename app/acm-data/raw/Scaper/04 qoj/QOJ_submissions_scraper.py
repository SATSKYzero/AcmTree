#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
QOJ 提交列表 → `qoj_submissions.json`

两种拿页面的方式（**二选一**）
------------------------------
1. **自动抓（推荐，需要登录态）**：cookie 填在 `acm-data/raw/Scaper/me.json` 的 `qoj.cookie`，然后

       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --contest 4113     # 某一场
       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --all             # 清单里所有挂 qoj 的场次
       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --url <完整网址>   # 自己指定
       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --contest 4113 --dry-run

   ⚠️ **给了 `--contest`/`--all` 就按场次抓**：花名册（`me.json` 的 qoj 账号）只是
   "**没给任何范围选择器**时的默认"，不会把显式的 `--contest` 顶掉（实测踩过：2026-10-15
   `--fetch --contest 1873` 被花名册换成"按 3 个账号抓全量列表"，`--contest` 不生效、
   只在 stderr 打一句警告 ⇒ 我指名的那一场一条都没抓到）。要按人抓就**显式** `--submitter`。

   **强制重爬**（通用层的 `--force`，任何模式都能加）：把归档当成不存在 ——
   读页时联网、"还欠哪些"的判据自动变成"全部重抓"。范围看命令自己的选择器：

       py "…/04 qoj/QOJ_submissions_scraper.py" --archive --contest 4113,1303 --force   # 这一类里的这两个
       py "…/04 qoj/QOJ_submissions_scraper.py" --archive --force                        # 这一类全部
       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter someone --cache-mode none  # 活列表：联网取最新

   `--archive` 默认只归档"**本人提交过的**"那些场次的提交页（提交页只列自己的提交）；
   **`--contest` 点名的场次连提交页一起归档**（否则没抓过 ⇒ 不在"本人提交过" ⇒ 永远不抓，
   见下面"还欠哪些"那段）。

   QOJ 的 `/contest/<id>/submissions` **默认只显示你自己的提交**（除非勾 show all），
   所以抓下来就是"登录账号在这一场的记录"，正是需要的。分页自动翻（`&page=2,3…`），
   抓到"这一页没有新提交"或到 `--max-pages` 为止。

2. **手动存页面**（没 cookie 时的老办法，仍然支持）：浏览器 Ctrl+S 存成 HTML 再跑本脚本。

      py "…/04 qoj/QOJ_submissions_scraper.py"                          # 默认读 qoj_submissions.html
      py "…/04 qoj/QOJ_submissions_scraper.py" -i 某场.html -o 单场提交.json

**按人抓（多人 / 任意账号）**
-----------------------------------
       py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter "someone,kongcheng_lige"

  ⚠️ **按人抓时 `--contest/--all` 不做任何过滤**：那个页面**不认** `contest=` ——
  实测 `?submitter=someone&contest=2609` 与 `&contest=1303` 返回的是**同一份列表**
  （页里题的 `/contest/<id>` 五花八门）。所以按人抓 = **抓全部提交**（场次归属由链接决定）；
  要"某一场里**我**的提交"用 `--contest <id>`（比赛页，见上 §1，但那页只有 cookie 身份本人）。

走**全局提交列表页** `/submissions?submitter=<用户名>`：它按提交者过滤，**比场次页多一列"语言"**，
而且只需**一份登录 cookie**（任一个已登录账号的就行）就能看**任何人**的全历史 —— 实测 someone 728 条、
队友 kongcheng_lige 157 条 / teammate_b 63 条。不给 `--submitter` 时用 `me.json` 花名册里的 qoj 账号。

> ★ **`--fetch` 现在挂在自动链上**（2026-10-15 起）：`build_chain.steps_for()` 的 `qoj-submits`
> 那一步跑的就是本脚本的 `--fetch`（排**在产包之前**）⇒ 应用里那颗「🛠 重建总包并导入」
> 会顺手刷新新提交，不用再记着手动跑。
> ⚠️ 没配 `qoj.cookie` ⇒ 这里**友好跳过（exit 0）**，链子继续（否则队友那台连包都出不了）；
> **cookie 过期/被拦** ⇒ 当场停（`read_page` 的 `SystemExit(2)`）—— 别静默出缺新提交的包。

⚠️ 四条实测出来的坑（别再踩）：
  * `/contest/<id>/submissions` **只列登录者自己的提交**，`?submitter=<别人>` 会被**忽略**
    （拿队友的名字去查，回的还是登录者自己的记录）→ 想看别人的只能用全局列表页。
  * 全局列表页**也不认 `contest=`**（`?submitter=X&contest=Y` 回的还是**全部**提交）⇒
    "按人 + 限定某场"做不到；归档名也不再拼 `-c<场次>`（那名字是假的，内容是全量）。
  * **没有 cookie 一条都拿不到**：QOJ 把匿名/过期一律**跳登录页**（`302 → //qoj.ac/login`，**0 字节**）
    —— 上层若只看"第 1 页没拿到（网络失败/登录页）"，得**人眼看 HTTP 头**才定性。
    所以 `lib/auth_state.py` 认出来就抛 `AuthError`（带"去 me.json 换 `qoj.cookie`"那句），
    `read_modes` 收到就**当场停**（别让 75 页跑到一半才发现）。抓前想先确认：
    `py "…/Scaper/lib/auth_state.py" --probe qoj`（1 个请求）。
  * 全局列表页的"题号"是**题目数字 id**（`20244`），不是字母。字母按下面的办法补。

**题号字母怎么补**（全局列表 → 应用里 R 的父节点 `p:<字母>`）
------------------------------------------------------------
`--fetch` 会顺手补（`--no-letters` 关掉）；`--archive`/`--category` 那条**解析归档**的路
也会补。补法是 `https://qoj.ac/contest/<id>` —— **比赛题目列表页把全场题目都列出来**，
一个请求就能拿到 `pid → 字母/题名/题面链接`。
⚠️ **只有一份缓存** `cache/qoj_contest_problems.json`（题目清单本身），
适配器自动读，不用改 `qoj_submissions.json`。
（`qoj_problem_letters.json` 与 `--letters-only` 装的是同一份
 题号，两条真源只会漂，统一到上面这一份。）

**一份文件可以装多场**（默认是**合并**）
----------------------------------------
不带 `--replace` 跑 = 把本次结果**并进** `qoj_submissions.json`：
同一个 `提交ID` 覆盖原位置（重抓同一次就是刷新），新的追加在后面。想重头来一遍加 `--replace`。
⚠️ **多人抓取时别用 `--replace`**：全局列表页是**时间倒序**的，旧提交（尤其别人早年打的）
可能翻不到底（默认 `--max-pages` 就是你自己的翻页上限），`--replace` 会把文件里已有、
这次没抓到的历史**直接抹掉**（实测丢过 706→250 条）。要"并集"就不带它。

增量水位线：碰到"整页都是已存的提交"就停（时间倒序，后面只会更旧）。
想**强制翻到底**（比如第一次抓别人的全历史），把输出指到一个新文件即可（那个文件是空的 → 没有水位线）：

      py "…/04 qoj/QOJ_submissions_scraper.py" --fetch --submitter "A,B" --max-pages 80 -o 新文件.json

应用侧的 `05 xcpc` 适配器会按 `contest` 号过滤 —— 同一个文件里混着好几场比赛也没关系
（它从每条记录的链接里认 `/contest/<id>`）。

为什么不用脚本里的账号密码直接登录
----------------------------------
QOJ 登录要 CSRF token + 有 Cloudflare 流量校验，脚本化登录既脆又危险；
直接把浏览器**已登录的 cookie**拿来用，等价于"你就是那个浏览器"，稳得多。

cookie 怎么拿：浏览器登录 qoj.ac → F12 → Network → 点任一 qoj.ac 请求 →
Request Headers 里的 `Cookie:` 整行，粘进 `me.json` 的 `qoj.cookie`。
过期了就再拿一次（脚本会明确告诉你"返回的是登录页"）。
"""

from __future__ import annotations

import argparse
import http.client
import os
import re
import sys
import time
from collections import deque
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'lib'))
sys.path.insert(0, os.path.abspath(os.path.join(HERE, '..', 'lib')))

from bs4 import BeautifulSoup  # noqa: E402

from me import qoj_cookie, qoj_username  # noqa: E402
# 读取的**通用层**（模式 × 归档 × 强制重爬）—— 所有"读一页"的地方都走它，见该模块文件头
from scope import union_scope  # noqa: E402
# 登录态判据（cookie 过期 ⇒ 302 → //qoj.ac/login）—— 各渠道共用，见该模块文件头
import auth_state  # noqa: E402
from read_modes import (  # noqa: E402
    CACHE_KEEP, CACHE_NONE, CACHE_STOP, DEFAULT_RETRY,
    Archive, active_cache, add_cli_args, configure_from, forced, print_stats,
    read_page, should_stop_on_no_new, stats,
)


def qoj_handles(explicit: str = '') -> list[str]:
    """
    要抓的 QOJ 账号（**多人**：花名册 `team[].qoj` 里登记过的都算）。

    注意 QOJ 的"提交者"在页面上是**用户名**（`span.uoj-username` 的 `data-nickname`），
    不是 handle；所以花名册里 `qoj` 那一栏要写 QOJ 用户名。
    读不到就返回 `[]` → 调用方退回"按 cookie 身份抓登录者自己"。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    shared = os.path.abspath(os.path.join(here, '..', 'lib'))
    if os.path.isfile(os.path.join(shared, 'me.py')):
        if shared not in sys.path:
            sys.path.insert(0, shared)
        try:
            import me as me_mod
            return me_mod.handles('qoj', explicit)
        except ImportError:
            pass
    return [x.strip() for x in str(explicit or '').split(',') if x.strip()]
from qoj_common import (  # noqa: E402
    contest_ids, count_by, fmt_counts, load_json_list, merge_by_key,
    resolve_path, write_json_list,
)

DEFAULT_HTML = 'qoj_submissions.html'
DEFAULT_OUT = 'qoj_submissions.json'
KEY = '提交ID'

BASE_URL = 'https://qoj.ac'

# 判题结果映射表
VERDICT_MAP = {
    "AC": "AC",
    "WA": "WA",
    "TL": "TLE",
    "TLE": "TLE",
    "ML": "MLE",
    "MLE": "MLE",
    "RE": "RE",
    "CE": "CE",
    "PE": "PE",
    "OLE": "OLE",
    "UKE": "UKE",
    "FAIL": "FAIL",
    "PC": "P.AC",          # 部分分：QOJ 写 PC，应用的状态词表里叫 P.AC（字面带点）
    "PAC": "P.AC",
    "PD": "PD",
    "JG": "JG",
}


def clean_verdict(text):
    """去掉 ✓ 和空白，再查映射表"""
    key = text.replace("✓", "").strip()
    return VERDICT_MAP.get(key, key)


_NUM_UNIT = re.compile(r'^\d+(?:\.\d+)?\s*(?:ms|s|kb|mb|b)$', re.I)

# 语言格长这样（**只有全局列表页**有这一列）：C++20 / G++17 / Python 3.11 / PyPy3 / Java 21…
# 用它按内容认列，而不是写死下标 —— 两种页面列数不同（见 parse_html 的说明）。
_LANG_RE = re.compile(r'^(?:G?\+\+|C\+\+|GNU C\+\+|C#|C|Java|Python|PyPy|Rust|Go|Kotlin|'
                      r'JavaScript|Node\.?js|Ruby|PHP|Pascal|Haskell|Swift|Scala|R|Perl|'
                      r'OCaml|D|Nim|Zig|Fortran|Lua|Bash)\s*[\d.]*$', re.I)


def _cell_text(cell) -> str:
    return re.sub(r'\s+', ' ', cell.get_text(' ', strip=True)).strip()


#: QOJ 用这几个符号表示"**没有这一项**"（实测：Compile Error 行的 Time/Memory 就是 `/`）
_NO_VALUE = ('/', '-', '—', '–')


def _pick(cols, index_of: dict, name: str) -> str:
    """**按表头名**取这一行的某一格（表头里没有这一列 ⇒ 空串）"""
    i = index_of.get(name, -1)
    return _cell_text(cols[i]) if 0 <= i < len(cols) else ''


def _pick_num(cols, index_of: dict, name: str) -> str:
    """按表头取一格，并把 QOJ 的"没有"占位符（`/`）当空"""
    v = _pick(cols, index_of, name)
    return '' if v in _NO_VALUE else v


def parse_html(html: str):
    """
    提交列表页的 HTML → (记录列表, 不像提交记录的行数)。**手动存页面与自动抓共用这一段**。

    ⚠️ 两种页面（**列数不同**，必须按内容认列，不能写死下标）：
      * `/contest/<id>/submissions`（8 列）：… 时间 / 内存 / 代码长度 / 提交时间
      * `/submissions?submitter=X`（9 列）：… 时间 / 内存 / **语言** / 代码长度 / 提交时间
    另外**提交者**是 `<span class="uoj-username">`，不是 `<a>`；它旁边还有个指向
    「哪场比赛」的 `<a>#</a>` —— 只认 `<a>` 的话会把提交者解析成 `#`（实测踩到）。

    ★ **「提交时间」这一列的值分两类，落成两列**（`v9.4.15`；见 `split_submit_time`）：
    绝对时刻进 `提交时间`（适配器只认这一列），比赛内的相对时间进 `相对提交时间`（证据）。
    """
    soup = BeautifulSoup(html, "html.parser")

    table = soup.find("table", class_="table-bordered")
    if not table:
        raise ValueError(
            "未找到提交记录表格（table.table-bordered）—— "
            "确认这是**提交列表**页面、且已登录（不是登录页）、页面已完整加载")
    tbody = table.find("tbody")
    if not tbody:
        raise ValueError("表格没有 tbody（页面可能是登录/验证页，或没加载完）")

    # ---- 表头 → 列号（**按名字认列**）----
    # 为什么必须按名字：两种页面**列数不同**（见 docstring），若把"时间/内存/代码长度"
    # **按"数字+单位"的出现顺序**塞 ⇒ 遇到 CE 行（时间/内存都是 `/`）就错位：唯一那个
    # `1.9kb`（**代码长度**）被塞进了**时间**；同时判定格写的是 `Compile Error`（不在映射表里）
    # 被整个丢掉 ⇒ 那 44 条"结果空 + 时间装着代码长度"就是这么来的。
    # 表头（实测）＝ `ID / Problem / Submitter / Result / Time / Memory / Language / File size / Submit time`。
    # ⚠️ 没有表头的老存档仍走下面按内容认列的退路（`HEAD_OK = False`）。
    index_of: dict = {}
    head = table.find("thead")
    if head is not None:
        for i, th in enumerate(head.find_all("th")):
            index_of.setdefault(_cell_text(th).lower(), i)
    HEAD_OK = all(k in index_of for k in ('result', 'time', 'memory', 'file size'))

    result = []
    skipped = 0
    for row in tbody.find_all("tr"):
        cols = row.find_all("td")
        if len(cols) < 6:
            skipped += 1
            continue

        # ① 提交号：第一格里指向 /submission/ 的链接
        id_tag = cols[0].find("a", href=True)
        if not id_tag or "/submission/" not in id_tag["href"]:
            skipped += 1
            continue
        submission_id = id_tag.get_text(strip=True).lstrip("#")
        submission_url = BASE_URL + id_tag["href"]

        # ② 题目：任意一格里指向 /problem/ 的链接（文本形如 `A. Name` 或 `#9602. Name`）
        prob_tag = None
        for c in cols:
            a = c.find("a", href=True)
            if a and "/problem/" in a["href"]:
                prob_tag = a
                break
        problem_full = _cell_text(prob_tag) if prob_tag else _cell_text(cols[1])
        problem_url = BASE_URL + prob_tag["href"] if prob_tag else ""
        if "." in problem_full:
            problem_label, problem_title = problem_full.split(".", 1)
        else:
            problem_label, problem_title = problem_full, ""
        problem_label = problem_label.strip().lstrip("#").strip()
        problem_title = problem_title.strip()
        # 题目 id（QOJ 的 pid）—— **全局列表里"题号"列给的就是它**（形如 `20244`），
        # 而场次内页面给的是字母（`A`）。下游按 pid 去 rankland 查字母，所以这里如实存下来。
        pid_m = re.search(r'/problem/(\d+)', problem_url)
        problem_id = pid_m.group(1) if pid_m else ""

        # ③ 提交者：**优先 span.uoj-username**（用户名），退化才找 <a>／整格文本
        submitter, user_url = "", ""
        span = row.find("span", class_="uoj-username")
        if span is not None and span.find_parent("td") in cols:
            submitter = str(span.get("data-nickname") or span.get_text(strip=True)).strip()
            user_cell = span.find_parent("td")
            a = user_cell.find("a", href=True) if user_cell is not None else None
            if a and "/user/" in a["href"]:
                user_url = BASE_URL + a["href"]
        else:
            for c in cols[1:4]:
                a = c.find("a", href=True)
                if a and "/user/" in a["href"]:
                    submitter, user_url = a.get_text(strip=True), BASE_URL + a["href"]
                    break
            if not submitter:
                submitter = _cell_text(cols[2])

        if HEAD_OK:
            # ---- 按表头认列（首选）----
            result_tag = row.find("a", class_="uoj-score")
            score = str(result_tag.get("data-score", "") or "") if result_tag is not None else ""
            # ⚠️ 判定格**如实取那一格的文本**：QOJ 会写 `Compile Error`（不在映射表里）、
            #    `AC , WA`（按测试点部分给分），有些场次干脆给**得分**（`0` / `0.5`，ICPC 计分）。
            #    归一交给下游（适配器调 `crate.normalize_status`）—— 那里才认识这些写法，
            #    认不出的也会给英文缩写，**不会丢成 `-`**。
            verdict = clean_verdict(_pick(cols, index_of, 'result'))
            time_used = _pick_num(cols, index_of, 'time')
            memory_used = _pick_num(cols, index_of, 'memory')
            file_size = _pick_num(cols, index_of, 'file size')
            language = _pick(cols, index_of, 'language')
            submit_time = _pick(cols, index_of, 'submit time')
            if not submit_time:                   # 这一列名字对不上时，退回"带 <small> 的格"
                for c in cols:
                    if c.find("small") is not None:
                        submit_time = _cell_text(c)
                        break
        else:
            # ---- 没有表头的老存档：按内容认列 ----
            # ④ 结果：带 uoj-score 的链接（同时给出 data-score），否则找含判题词的格
            result_tag = row.find("a", class_="uoj-score")
            if result_tag is not None:
                verdict_text = result_tag.get_text(strip=True)
                score = str(result_tag.get("data-score", "") or "")
            else:
                verdict_text, score = "", ""
                for c in cols[2:6]:
                    t = _cell_text(c)
                    if clean_verdict(t) in VERDICT_MAP.values() or "✓" in t:
                        verdict_text = t
                        break
            verdict = clean_verdict(verdict_text)

            # ⑤ 三个"数字+单位"的格：按出现顺序 = 时间 / 内存 / 代码长度（语言列不含数字单位）
            #    ⚠️ 这条**只在没表头时**用（CE 行会错位，见上面的说明）
            nums = [_cell_text(c) for c in cols if _NUM_UNIT.match(_cell_text(c))]
            time_used = nums[0] if len(nums) > 0 else ""
            memory_used = nums[1] if len(nums) > 1 else ""
            file_size = nums[2] if len(nums) > 2 else ""

            # ⑤b 语言：**只有全局列表页** `/submissions?submitter=X` 有这一列
            #     （比赛页 8 列没有它 —— 这是 671 条 R 缺 language 的原因）。
            #     按内容认，不按下标（两种页面列数不同，见 parse_html 的说明）。
            language = ""
            for c in cols[3:9]:
                t = _cell_text(c)
                if t and _LANG_RE.match(t) and not _NUM_UNIT.match(t):
                    language = t
                    break

            # ⑥ 提交时间：带 <small> 的格（两种页面都有），否则找日期样式
            submit_time = ""
            for c in cols:
                if c.find("small") is not None:
                    submit_time = _cell_text(c)
                    break
            if not submit_time:
                for c in cols:
                    t = _cell_text(c)
                    if re.match(r'^\d{4}-\d{2}-\d{2}', t):
                        submit_time = t
                        break

        # ★ 相对/绝对**分两列**（`v9.4.15`）—— 判据与理由见 `split_submit_time`
        abs_time, rel_time = split_submit_time(submit_time)

        result.append({
            "提交ID": submission_id,
            "提交链接": submission_url,
            "题号": problem_label,
            "题目ID": problem_id,
            "题目名称": problem_title,
            "题目链接": problem_url,
            "提交者": submitter,
            "用户主页": user_url,
            "结果": verdict,
            "得分": score,
            "时间": time_used,
            "内存": memory_used,
            "代码长度": file_size,
            "使用语言": language,
            "提交时间": abs_time,
            "相对提交时间": rel_time,
        })

    return result, skipped


def parse_submissions(filepath):
    """从**存下来的 HTML 文件**解析（老用法）"""
    with open(filepath, "r", encoding="utf-8-sig", errors="replace") as f:
        html = f.read()
    return parse_html(html)


# ================================================================
# 自动抓（需要 me.json 里的 qoj.cookie）
# ================================================================

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
DEFAULT_MAX_PAGES = 20
PAGE_SLEEP = 0.6          # 翻页之间歇一下，别把 QOJ 打急


_CONNS: dict = {}          # 每域名一条复用连接（见 fetch_html）


def fetch_html(url: str, cookie: str, timeout: int = 25) -> str:
    """
    取一个需要登录的页面。

    ⚠️ 必须带 UA：**不设 UA**（urllib 默认 `Python-urllib/3.x`）QOJ 直接回 403；
    带上任意 UA 字符串即可（浏览器 UA 非必需）。带 cookie 才看得到提交表格。

    ★ **登录态判据交给共用件**（cookie 过期这种情况值得一个模块去处理）：
    cookie 过期时 QOJ 回的是 **302 → `//qoj.ac/login` + 0 字节** —— 若把 302 当成功、
    返回空串，上层就只看到"第 1 页没拿到（网络失败/登录页）"，**人眼去看 HTTP 头才定性**。
    所以 `auth_state.raise_if_bad('qoj', …)` 认出来就抛 `AuthError`（带"去 me.json 换 cookie"那句），
    `read_modes` 收到就**当场停**（别让 75 页跑到一半才发现）。

    **连接复用**：逐请求 `urlopen` ⇒ 每次都重握手 TLS，
    翻页时 `SSL handshake / RemoteDisconnected` 一大堆。所以每个域名留一条
    keep-alive 连接；连接坏了就丢掉重开（**失败本身交给上层的重试**，这里不自己重试，
    免得和 `read_page` 的重试变成乘法）。`Accept-Encoding: identity` 是必须的 ——
    不复用 urllib 时不会自动解压。
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc
    path = parts.path + (f'?{parts.query}' if parts.query else '')
    conn = _CONNS.get(host)
    if conn is None:
        conn = http.client.HTTPSConnection(host, timeout=timeout)
        _CONNS[host] = conn
    try:
        conn.request('GET', path, headers={
            'User-Agent': UA,
            'Cookie': cookie,
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
        })
        resp = conn.getresponse()
        body = resp.read()
        status, reason, headers = resp.status, resp.reason, resp.headers
        if getattr(resp, 'will_close', False):        # 服务端说要关：别留着下次踩
            _drop_conn(host)
    except Exception:
        _drop_conn(host)
        raise
    # ★ 登录态（302 → login / 403+验证页 / 429 限流）先过共用件 —— 好页才继续（见函数头）
    text = auth_state.raise_if_bad(
        'qoj',
        auth_state.from_http(status, url, headers.get('Location') or '',
                             body.decode('utf-8', 'replace'), reason or ''),
        where=url)
    if status >= 400:
        raise urllib.error.HTTPError(url, status, reason, headers, None)
    return text


def _drop_conn(host: str) -> None:
    conn = _CONNS.pop(host, None)
    if conn is not None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass


def is_login_page(html: str) -> bool:
    """提交表格在 = 已登录；不在 = 登录页/被拦（QOJ 未登录只回约 12KB 的登录页）"""
    return 'table-bordered' not in html


# ================================================================
# 「原料」归档：页面**原样存盘**，解析只读归档
# ================================================================
#
# 为什么要有这一层（先把原料整个爬下来，解析只读库）：
#   · 链路抖：同一发请求时好时坏（实测 200 / 25 秒超时 / 403 混着出）；
#   · 凭据短命：`cf_clearance` 只活几十分钟到几小时，抓到一半过期是常态；
#   · 而要调的东西（题号字母、场次名字、时间列格式）**全都在页面本身里**。
#   ⇒ 抓下来的 HTML 原样入库（`cache/pages/<场次号>.<kind>.html`），解析一律读库；
#     已有归档就跳过、不重抓 —— 跑中断了就重贴 cookie 再跑，已抓的一次都不用重复。
#
# 只存两种页：
#   `<场次号>.contest.html`      = `https://qoj.ac/contest/<id>`（题目清单：标题、字母、题目 id、题面链接
#                                  与顶部分类面包屑 —— 一场的树**全从这一页出**，所以一场只花 1 个请求）
#   `<场次号>.submissions.html`  = `https://qoj.ac/contest/<id>/submissions`（**只列登录者自己的提交**，
#                                  所以只对"登录账号本人提交过的场次"抓；用来复核赛时/VP/补题与提交列格式）
#   `category.<分类号>.html`     = `https://qoj.ac/category/<id>`（公开页：子分类 + 直接挂的比赛）
PAGES_DIR = os.path.join(HERE, 'cache', 'pages')

# 页级原料归档（**通用层** `Scaper/lib/read_modes.py` 的 `Archive`）：
# 归档优先、没有才联网、抓到即入库；`--force` 时它一律"当作没有"⇒ 联网重爬。
ARCHIVE = Archive(PAGES_DIR)

# 场次名字（QOJ 那棵树的 C 用它）：从归档页的 `<title>` 剥，**不额外抓页面**
TITLES_CACHE = os.path.join(HERE, 'cache', 'qoj_contest_titles.json')


def good_page(html: str) -> bool:
    """QOJ 的"好页"判据：不是登录页/拦截图（**只有好页才入库**，见 read_modes 文件头）"""
    return not is_login_page(html)


# 该场**全部题目**（题号字母 / 题名 / 题面链接）与 QOJ 的**分类面包屑**
# —— 都从同一张归档的场次页里剥（收录一个比赛就该收录比赛内的所有题目；
#    按 qoj 的分类标准给 C 节点分类和定路径）。列表 /problems 那条路**不用**。
# 兜底：遍历分类树时最多走这么多页（防跑飞）
CATEGORY_MAX_PAGES = 500
# 开跑前先试抓几场验凭据（试抓全挂才判"跑不动"）
PROBE_TRIES = 3

PROBLEMS_CACHE = os.path.join(HERE, 'cache', 'qoj_contest_problems.json')
CATEGORIES_CACHE = os.path.join(HERE, 'cache', 'qoj_contest_categories.json')
# `--category` 走下来的那棵树：QOJ 包的**比赛集合**（并集）与每场的分类归属
CATEGORY_TREE_CACHE = os.path.join(HERE, 'cache', 'qoj_category_tree.json')


def contest_problems_from_html(contest_id: str, html: str) -> dict:
    """
    场次页的题目表 → `{题目id: {letter, name, link}}`（**该场全部题目**，含没有提交过的）。

    ⚠️ 必须**按行**取（一 `<tr>` 一题）——实测原文：
        <tr><td class="table-success">A</td><td><a href="/contest/4071/problem/20016">Recall</a></td></tr>
        <tr><td>B</td><td><a href="/contest/4071/problem/20017">Mod</a></td></tr>
    ⚠️ **不能**用"在题目链接前后 ±400/200 字符的窗口里找 `<td>A</td>`" —— 那个窗口会
    罩住**隔壁几行**，于是 `tds[-1]` 拿到的是别人的题号：实测 4071 整场变成
    C,C,E,E,F,… （真值是 A,B,C,D,E…），298 场里 **296 场**的题号都这么错了。

    ⚠️ 题目链接**可能带后缀**：`/contest/2575/problem/14823/statement/en`（同一张表里
    有的行带、有的不带）。所以 href 里题目 id 后面要允许 `/<任意>` —— 若要求 id 后
    紧跟引号，2575 那场 13 题只解析出 1 题（3656 同理），**漏了 15 道题**。
    """
    out: dict = {}
    # 一行一题：先把表按 `<tr>` 切开，再在**同一行内**找题号与题目链接
    pat = r'href="(/contest/%s/problem/(\d+)(?:/[^"]*)?)"[^>]*>(.*?)</a>' % re.escape(contest_id)
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', html or '', re.S | re.I):
        m = re.search(pat, row, re.S)
        if not m:
            continue
        href, pid, raw = m.group(1), m.group(2), m.group(3)
        name = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', raw)).strip()
        letter = ''
        lm = re.search(r'#\s*Problem\s+([A-Z])\b', row)
        if lm:
            letter = lm.group(1)
        else:
            # 题号 = 行内**题目链接之前**那个只含短标签的单元格：
            # `<td class="table-success">A</td>` / `<td>B</td>`，也有整场用**数字**的
            # （实测 2180：`<td>1</td><td><a …>Array Inversion</a></td>`，1…12）。
            # 只认"链接之前"的格子，免得把后面的统计列（通过数之类）当成题号。
            for td in re.findall(r'<td[^>]*>\s*([A-Za-z0-9]{1,3})\s*</td>', row[:m.start()]):
                letter = td.upper()
                break
        out[pid] = {'letter': letter, 'name': name, 'link': f'https://qoj.ac{href}'}
    return out


def contest_categories_from_html(html: str) -> list:
    """
    场次页顶部的**分类面包屑** → `[[{id, name}, …], …]`（**一条路径一个列表**；可能有多条）。

    实测原文（一个 div、多条路径用 `<br>` 分行，每行都是一条从根开始的路径）：
        <div class="alert alert-secondary role="alert">/<a href="/category/2">ICPC</a>/<a href="/category/17">Regionals</a>/…/<br>/<a href="/category/4">Training Camps</a>/…
    （注意那页的 `class` 引号本身是坏的，所以按 `alert-secondary` 起头找。）
    """
    m = re.search(r'alert-secondary[^>]*>(.*?)</div>', html or '', re.S)
    if not m:
        return []
    paths = []
    for seg in re.split(r'<br\s*/?>', m.group(1)):
        path = []
        for a in re.finditer(r'href="/category/(\d+)"[^>]*>(.*?)</a>', seg, re.S):
            name = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', a.group(2))).strip()
            if name:
                path.append({'id': a.group(1), 'name': name})
        if path:
            paths.append(path)
    return paths


def _load_map(path: str) -> dict:
    import json
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (ValueError, OSError):
        return {}


def _save_map(path: str, store: dict) -> None:
    import json
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(store, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write('\n')


def category_contests_from_html(html: str) -> list:
    """分类页里**直接挂的比赛** id（形如 `/contest/<id>`）"""
    return [m for m in dict.fromkeys(re.findall(r'href="/contest/(\d+)"', html or ''))]


def category_children_from_html(html: str) -> list:
    """
    分类页里的**子分类** id。

    ⚠️ 只能认**子分类表格**里的行 —— 每行是
    `<a href="/category/<id>"><span class="glyphicon glyphicon-folder-open"></span> 名字</a>`。
    页面顶上还有一条**面包屑**（`/category/1` → `/category/2` → `/category/17` → 自己），
    照"所有 /category/ 链接"去收会把父链当成子类，于是从任何一个分类都能走回根、
    把**整站**爬一遍（实测 768 页、1600+ 场，全是不相干的分类）。
    """
    return [m for m in dict.fromkeys(re.findall(
        r'href="/category/(\d+)"[^>]*>\s*<span class="glyphicon glyphicon-folder-open">',
        html or ''))]


def category_name_from_html(html: str) -> str:
    """分类页自己的类名 = `<title>` 去掉尾巴（`Asia East Continent - QOJ.ac`）"""
    m = re.search(r'<title>(.*?)</title>', html or '', re.S)
    return re.sub(r'\s*-\s*QOJ\.ac\s*$', '', m.group(1)).strip() if m else ''


def category_path_from_html(html: str) -> list:
    """
    分类页**自己的归属**（页面上那行 `Location: Category / ICPC / Regionals / … / 自己`）。

    ⚠️ 这是"这个分类挂在哪儿"的**唯一权威**，不要拿遍历时的来路（从哪个根走下来的）当路径 ——
    同一个分类从不同根出发会得到不同的来路，树上就会出现**一份分类挂两处**
    （实测：`212` 既直接挂 `qoj`、又挂 `qoj:s:cat-134:cat-147` 下，就是这样出现的）。

    实测 81 个分类页**全部**有这行，最后一项都是自己。

    ⚠️ **唯一的归一化**：掐掉开头的站点根 `1 Category`。QOJ 自己这条面包屑并不齐 ——
    有的页写 `Category / ICPC / …`，有的页直接从 `ICPC / …` 起（同一个 `cat-2` 于是会以
    `qoj:s:cat-2` 和 `qoj:s:cat-1:cat-2` 两条键各出一遍）。`1` 是"所有分类的容器"、
    不是分类，而场次页的面包屑从来都是从 `ICPC` 起的 —— 掐掉它，两边口径才一致。
    """
    m = re.search(r'Location:\s*((?:<a href="/category/\d+"[^>]*>.*?</a>/?)+)', html or '', re.S)
    if not m:
        return []
    out = []
    for a in re.finditer(r'href="/category/(\d+)"[^>]*>(.*?)</a>', m.group(1), re.S):
        name = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', a.group(2))).strip()
        out.append({'id': a.group(1), 'name': name})
    while out and out[0]['id'] == '1':
        out.pop(0)
    return out


def walk_categories(root_ids: list, cookie: str, sleep: float = 0.6, verbose: bool = True) -> dict:
    """
    从这几个分类出发**遍历分类树**，收齐所有比赛 id —— 连同"它归在哪个分类下"。

    分类页是**公开页**（不用登录、不需要 cookie 新鲜）；每页原始 HTML 入库
    `cache/pages/category.<id>.html`，第二次跑不重抓（断点续抓）。

    树里每个分类的路径用**分类页自己那行 `Location:`**（`category_path_from_html`），
    不用遍历来路 —— 否则同一个分类会因为"从哪个根走下来"而挂到多处。

    @returns `{contests: [场次 id…], paths: {场次 id: [[{id,name},…]]},
               names: {分类 id: 类名}, cat_paths: {分类 id: [[{id,name},…]]}, pages: 页数}`
    """
    queue = deque(str(x) for x in root_ids if str(x).strip())
    seen_cat: set = set()
    contests: list = []
    names: dict = {}
    cat_paths: dict = {}
    paths: dict = {}
    while queue:
        cid = queue.popleft()
        if cid in seen_cat:
            continue
        seen_cat.add(cid)
        if len(seen_cat) > CATEGORY_MAX_PAGES:
            print(f'   ⚠️ 分类页超过 {CATEGORY_MAX_PAGES} 个，停止（防跑飞）')
            break
        # 模式：**缓存 KEEP + 重试 RETRY**（公开页、永久有效；一次抖动不该让整棵树走歪）
        # ⚠️ 好页判据要按**这一页自己的形状**：分类页里没有提交表格（`table-bordered`），
        #    用 `good_page` 会把 81 个分类页全拒掉、整棵树变成空的。
        fetched_before = stats()['fetches']
        html = ARCHIVE.page(
            key=cid, kind='category', url=f'{BASE_URL}/category/{cid}',
            fetch=fetch_html, cookie='',                 # 公开页：不带 cookie
            accept=lambda h: bool(category_path_from_html(h) or category_children_from_html(h)
                                  or category_contests_from_html(h)),
            verbose=False, label=f'category/{cid}',
        )
        if not html:
            print(f'   ✗ 分类 {cid} 没拿到（网络失败）—— 这一支跳过')
            continue
        # 只有**真联网**了才睡（读归档时睡纯属白等：81 个分类页 ≈ 50 秒）
        if stats()['fetches'] > fetched_before:
            time.sleep(sleep)
        name = category_name_from_html(html)
        if name:
            names[cid] = name
        here = category_path_from_html(html) or [{'id': cid, 'name': name}]
        cat_paths[cid] = [here]
        got = category_contests_from_html(html)
        kids = category_children_from_html(html)
        contests.extend(got)
        for one in got:
            paths.setdefault(str(one), [here])           # 先到先得（根的先后固定 ⇒ 稳定）
        queue.extend(k for k in kids if k not in seen_cat)
        if verbose:
            print(f'   分类 {cid}: 本页比赛 {len(got)}，子类 {len(kids)}'
                  f'，路径 {" / ".join(c["name"] for c in here)}')
    out = sorted(set(contests), key=int)
    # ---- ★ 补**祖先分类**的名字 ----
    # 为什么要单独补：`names` 只装**走到的**分类（4 个根及其子树），而面包屑里还会出现
    # 它们的**祖先**（`2 ICPC` / `17 Regionals` / `134 ~` / `147 Team Competition`）——
    # 祖先的名字来自**面包屑文本**，而 QOJ 给 `134` 写的面包屑名是个占位符 `~`
    # （`134` 在面包屑里的名字要换成 qoj 的参考名）。页面自己那行 `<title>` 才写着真名
    # （实测 `https://qoj.ac/category/134` ⇒ `Misc - QOJ.ac`）。
    # 所以：面包屑里出现过、`names` 里又没有的 id，各抓一页把真名补上（公开页、断点续抓）。
    missing = []
    # ⚠️ 循环变量**不能叫 `paths`**：那正是下面要 return 的那个"场次 → 归属"表
    #    （叫 `paths` 会被覆盖成"最后一个分类的路径"，存盘后整个归属表没了）
    for cat_path in cat_paths.values():           # `{分类 id: [ [ {id,name}, … ] ]}`（两层列表）
        for one_path in (cat_path or []):
            for seg in (one_path or []):
                cid2 = str(seg.get('id') or '')
                if cid2 and cid2 not in names and cid2 not in missing:
                    missing.append(cid2)
    for cid2 in missing:
        html = ARCHIVE.page(
            key=cid2, kind='category', url=f'{BASE_URL}/category/{cid2}',
            fetch=fetch_html, cookie='',
            accept=lambda h: bool(category_name_from_html(h)),
            verbose=False, label=f'category/{cid2}',
        )
        name2 = category_name_from_html(html or '')
        if name2:
            names[cid2] = name2
            if verbose:
                print(f'   + 祖先分类 {cid2} 的真名：{name2}')
    return {'contests': out, 'paths': paths, 'names': names,
            'cat_paths': cat_paths, 'pages': len(seen_cat)}


def contest_title_from_html(html: str) -> str:
    """
    从 QOJ 页面的 `<title>` 取场次名。

    形如 `The 2022 ICPC Asia Nanjing Regional Contest - Dashboard - Contest - QOJ.ac`
    —— 尾巴是"页别 + 站点"，场次名在**最前面**；页别会变（Dashboard / Submissions /
    Problems…），所以按模式剥而不是写死。登录页（`Login - QOJ.ac`）返回空。
    """
    if not html:
        return ''
    m = re.search(r'<title>(.*?)</title>', html, re.S | re.I)
    if not m:
        return ''
    text = re.sub(r'\s+', ' ', m.group(1)).strip()
    text = re.sub(r'\s+-\s+(?:Dashboard|Submissions|Problems|Standings|Statistics|Manage'
                  r'|Hacks|Clarifications|Participants)\s+-\s+Contest\s+-\s+QOJ\.ac\s*$',
                  '', text, flags=re.I)
    text = re.sub(r'\s+-\s+QOJ\.ac\s*$', '', text, flags=re.I).strip()
    return '' if text.upper() in ('', 'QOJ', 'QOJ.AC', 'LOGIN', 'REGISTER', 'ERROR') else text


# ================================================================
# 比赛列表 `/contests` → 场次名字（**可选**、可缓存、命中够了就提前停）
# ================================================================
#
# QOJ 有比赛列表页 `/contests`，一张表四列
# （Name / Start time / Duration / Difficulty），每行就是 `[名字](/contest/<id>)`
# —— **一次就能拿到 (场次号, 名字)**，比逐场抓那 42 个要登录的页面省得多。
# ⚠️ 列表里**没有**题目链接；但不需要 —— 题名/题面链接本来就在提交记录里
#    （`qoj_submissions.json` 每条都有 `题目名称`/`题目链接`），QOJ 树的 P 就是按题目 id 建的。
#
# 另外：`qoj.ac` 对爬虫会走 Cloudflare 挑战（403），而它的**镜像域**是同一套站点、匿名可取
# （`huang.lt` / `jiang.ly`）。所以列表页按 主站 → 镜像 依次试，日志里写明这次用的是哪个。
LIST_HOSTS = ('https://qoj.ac', 'https://huang.lt', 'https://jiang.ly')
LIST_MAX_PAGES = 20          # 兜底：最多翻这么多页（目标都命中就提前停）


def contest_index_from_list_html(html: str) -> dict:
    """
    `/contests?tab=all` 列表页 → `{场次号: {names, startAt, duration, difficulty}}`。

    **一行可能有多个名字**：`?v=` 变体（实测 337 个，例：3799 = Universal Cup 镜像 +
    "2026 武汉邀请赛暨湖北省赛"），全是同一场的官方名，都留着 —— 05 那边按名字去对
    rankland 索引（`name_hint`）就靠这份。列序：名称 / 开始时间 / 时长 / 难度
    （未登录时"开始时间"多半是 `-`）。
    ⚠️ 这是**唯一**的"比赛号 → 官方赛名"来源（归 04）：同一件事不必在 05 再存一份
    `qoj_index.json` —— 第二份真源只会漂。
    """
    out: dict = {}
    for row in re.findall(r'<tr[^>]*>(.*?)</tr>', html or '', re.S | re.I):
        cells = [re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', td)).replace('&amp;', '&').strip()
                 for td in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S | re.I)]
        for m in re.finditer(r'href="/contest/(\d+)(?:\?v=\d+)?"[^>]*>(.*?)</a>', row, re.S):
            name = re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', m.group(2))).strip()
            if not name:
                continue
            cur = out.setdefault(m.group(1), {'names': []})
            if name not in cur['names']:
                cur['names'].append(name)
            cur.setdefault('startAt', cells[1] if len(cells) > 1 else '')
            cur.setdefault('duration', cells[2] if len(cells) > 2 else '')
            cur.setdefault('difficulty', cells[3] if len(cells) > 3 else '')
    return out


def fetch_list_page(page: int, cookie: str):
    """
    取第 N 页列表：主站不行就换镜像。@returns `(html, 用的域)`，全失败返回 `('', '')`

    模式：**缓存 NONE + 重试 RETRY**（3506 场名字要翻很多页，一次抖动不该作废）；
    页面入库 `contests.p<N>.html`（镜像与主站同一套站点，归档不分域）。
    ⚠️ **这是"活列表"**（QOJ 不断加场）：默认**不读归档**、每次都联网，抓到照旧入库 ——
    拿上次的快照当缓存用就会"永远看不见新场次"。它只有 1 个请求（实测不分页）。
    """
    for base in LIST_HOSTS:
        url = f'{base}/contests?tab=all' + (f'&page={page}' if page > 1 else '')
        html = ARCHIVE.page(
            key='contests', kind=f'p{page}', url=url,
            fetch=fetch_html, cookie=cookie, cache=CACHE_NONE,
            # "好页" = 认得出场次（拦截图/登录页不是原料，别把它固化成归档）
            accept=lambda h: bool(contest_index_from_list_html(h)),
            verbose=False, label=f'contests 第 {page} 页',
        )
        if html:
            return html, base
    return '', ''


# ================================================================
# 题号字母：全局列表只给 pid，字母要去场次内页面拿 —— 写进**题目清单缓存**（唯一一份）
# ================================================================

# "这条记录的题号已经是字母了"（= 不用再补）
LETTER_ONLY = re.compile(r'^[A-Z]$')


def contest_of_record(r: dict) -> str:
    """
    这条提交属于哪个 QOJ 场次。

    三条路，**按可靠性**：
      ① 记录里已经写好的 `场次号`（`--resolve-contests` 补上的，最可靠）；
      ② 题目/提交链接里直接带 `/contest/<id>`（场次内页面抓来的记录就是这样）；
      ③ 链接是**全局题号** `/problem/<pid>` 时，查"这题被哪些比赛用过"的缓存
        （`cache/qoj_problem_contests.json`，`--resolve-contests` 从题面页抓的）——
        题面页原话是 `The problem was used in the following contests:`，可能**不止一场**，
        那就取**第一场**（QOJ 自己的顺序，通常是主归属；全部候选留在缓存里）。
    """
    sid = str(r.get('场次号') or '').strip()
    if sid:
        return sid
    m = re.search(r'/contest/(\d+)', str(r.get('题目链接') or '') + ' ' + str(r.get('提交链接') or ''))
    if m:
        return m.group(1)
    pid = pid_of_record(r)
    return (problem_contests_of(pid) or [''])[0] if pid else ''


def pid_of_record(r: dict) -> str:
    pid = str(r.get('题目ID') or '').strip()
    if pid:
        return pid
    m = re.search(r'/problem/(\d+)', str(r.get('题目链接') or ''))
    return m.group(1) if m else ''


# ================================================================
# 「这题被哪些比赛用过」—— 全局题号形式的提交靠它认场次
#
# 背景：全局提交列表页给的题目链接是
# **全局题号** `/problem/<pid>`，不含场次 —— 有一批提交因此定位不到比赛（实测 23 条 / 12 题）。
# 而**题面页**上就写着归属：`The problem was used in the following contests:` 后面挂着
# 若干 `/contest/<id>`（公开页，**不需要 cookie**）。抓下来存进缓存，归属就有据可依了。
#
# ⚠️ 一题可能被**多场**用过（如 Universal Cup 的某站 = 某区域赛的镜像），
#    那就取**第一场**当归属（QOJ 自己的顺序），**全部候选都留在缓存里**不丢。
# ================================================================
PROBLEM_CONTESTS_CACHE = os.path.join(HERE, 'cache', 'qoj_problem_contests.json')

# 题面页那段：`... used in the following contests: <ul class="uoj-list"><li><a href='/contest/1365'>名字</a>...`
_USED_IN_RE = re.compile(r'used in the following contests:(.*?)</ul>', re.S | re.I)
_USED_LINK_RE = re.compile(r"href=['\"]/contest/(\d+)[^'\"]*['\"]", re.I)


def problem_contests_from_html(html: str) -> list:
    """题面页 → 它被哪些场次用过（`['1365', …]`，页面顺序、去重）"""
    m = _USED_IN_RE.search(html or '')
    if not m:
        return []
    return [x for x in dict.fromkeys(_USED_LINK_RE.findall(m.group(1)))]


def problem_contests_of(pid: str) -> list:
    """缓存的"这题属于哪些场次"；没查过就返回空（不要在解析热路径里联网）"""
    if not pid:
        return []
    got = _load_map(PROBLEM_CONTESTS_CACHE).get(str(pid))
    return got if isinstance(got, list) else []


def harvest_problem_contests(pid: str, cache: dict, verbose: bool = True) -> int:
    """
    抓一个题面页，把候选场次写进 `cache`（已有就跳过）；返回写了几场。

    模式：**缓存 KEEP + 重试 RETRY**（公开页、永久有效；12 个题目里实测有两个先超时/429，
    重试就补上了 —— 只试一次会静默漏掉归属）。页面**入归档**（`<pid>.problem.html`），
    以后复核"这题到底被哪些场用过"不用再联网。
    `--force` 时不看缓存也不看归档（两者一起失效）⇒ 这一类整个重查。
    """
    if ARCHIVE.has(pid, 'problem') and str(pid) in cache:
        return 0
    html = ARCHIVE.page(
        key=pid, kind='problem', url=f'{BASE_URL}/problem/{pid}',
        fetch=fetch_html, cookie='',                        # 公开页：不带 cookie
        accept=good_page, verbose=verbose, label=f'problem/{pid}',
    )
    if not html:
        return 0                                    # 失败**不写缓存** ⇒ 重跑会重试
    cids = problem_contests_from_html(html)
    cache[str(pid)] = cids
    if verbose:
        print(f'   题目 {pid} → {cids if cids else "（页面上没写它属于哪场比赛）"}')
    return len(cids)


def harvest_letters(records: list[dict], problems: dict) -> int:
    """
    把"题号已经是字母"的记录收进**题目清单缓存** `problems[cid][pid]['letter']`。

    只有**场次内页面**（`/contest/<id>/submissions`）的题号才是 `I. Island` 这种字母形态；
    全局列表给的是 pid。所以这一步专门用来把 pid→字母 补出来。

    ⚠️ 题目缓存**只有一份**（`PROBLEMS_CACHE`）—— 若与 `qoj_problem_letters.json`
    （`{cid: {pid: 字母}}`）各存一份同一份题号，迟早漂。
    """
    n = 0
    for r in records:
        cid, pid = contest_of_record(r), pid_of_record(r)
        letter = str(r.get('题号') or '').strip().upper()
        if cid and pid and re.fullmatch(r'[A-Z]', letter):
            slot = problems.setdefault(cid, {})
            info = slot.get(pid) or {'letter': '', 'name': '', 'link': ''}
            if info.get('letter') != letter:
                info['letter'] = letter
                slot[pid] = info
                n += 1
    return n


# ================================================================
# 参与记录（VP 名单）→ `cache/qoj_vp_contests.json`
#
# 用途：判**提交性质**（赛时 / VP）。QOJ 的比赛页**不公布起止时间**（实测：只有
# `Contest Ended` + 服务端时间；`standings` 里的 `4:00:00` 是封榜时刻的默认值），
# 但用户主页有 `Virtual Participations：N contests` 区块 —— 实测 someone 11 场 /
# kongcheng_lige 3 场 / teammate_b 5 场，每行是 `比赛号 + 时间 + 赛名`。
#
# 规则：有提交 ∧ 在 VP 名单 → `VP`；有提交 ∧ 不在名单 → `赛时`。
# 依据：QOJ 对**参与过**的场次才显示 `Your participation…`（实测 2564 有 / 1404 无），
#       而这些账号**都没有** `Contest Participations` 区块。
# ================================================================

VP_CACHE = os.path.join(HERE, 'cache', 'qoj_vp_contests.json')

# 场次内提交页的「提交时间」列格式 —— **这一列自己会说话**：
#   参与过这场（正式赛 / VP）：`04:53:08`      ← 从开赛起算的**相对时间**（6 位）
#   没参与过（纯补题）        ：`2024-07-23 10:07:05`  ← **绝对时间**（14 位）
# 实测三场对照：2564（VP 过）= 6 位；1404 / 1197（只有补题）= 14 位。
# 全局列表页 `/submissions?submitter=` 则**永远是绝对时间**，所以判这个必须用场次页。
TIMEFMT_CACHE = os.path.join(HERE, 'cache', 'qoj_contest_timefmt.json')
_REL_TIME = re.compile(r'^\s*\d{1,3}:\d{2}:\d{2}\s*$')      # 相对时间：允许超过 24 小时
_ABS_TIME = re.compile(r'^\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s*$')


def split_submit_time(value: str) -> tuple[str, str]:
    """
    页面上「提交时间」那一格的值 → `(绝对时刻, 相对时间)` 两列（各占一个，另一个是空串）。

    为什么必须分列（`v9.4.15`，用户 2026-10-15 报的："qoj 的 Ac 时间有问题"）：
      场次页 `/contest/<id>/submissions` 对**参与窗口内**的提交给的是**相对时间**
      （`00:31:01` = 开赛后第 31 分钟），窗口外的补题才给绝对时间（`2026-09-13 22:06:07`）；
      而全局列表页 `/submissions?submitter=X` **永远给绝对时间**。
      两页的**同一条提交**（同一个 `提交ID`）会按 `提交ID` 合并（`lib/qoj_common.py:merge_by_key`），
      合成规则是"新记录的非空字段覆盖旧的" ⇒ 谁后抓谁赢 —— 相对时间后抓就把绝对时间**抹了**，
      于是树上 P 的「AC时间」显示成 `00:31:01`（`scripts/crate.py:normalize_time` 那一层
      从 `v9.4.15` 起也不再收这种值，但**根子**在这里：别让它进 `提交时间`）。
      ⇒ 相对时间**不进** `提交时间`（那一列只有绝对时刻），合并时"空不覆盖非空"这条规则
      自然让**绝对那份留得住**（不管两页谁先谁后抓）。相对值不丢：它落在 `相对提交时间` 里当证据。

    ⚠️ 判据就是上面那两条正则（**别在本文件里再写第三份**）：它们本来就在判"这一列是哪种格式"。
    """
    t = str(value or '').strip()
    if _REL_TIME.match(t):
        return '', t
    return t, ''


def _selftest() -> int:
    """
    `--selftest`：判「提交时间」分列与**合并时的绝对优先**（**不联网、不读写原料**）。

    为什么这几条要在 CI 里（`npm test` → `src/test/pythonSelftests.test.js`）：
    这个 bug（相对时间穿到树上当 AC 时间）**不会有任何东西红** —— 值非空、格式"能认"，
    体检只说"有值"，要等到用户看见树上写着 `00:31:01` 才发现。所以把它钉在源码这一层。
    """
    fails: list[str] = []
    checks = 0

    def ok(cond: bool, what: str) -> None:
        nonlocal checks
        checks += 1
        if not cond:
            fails.append(what)

    # ① 分列：相对值只进 `相对提交时间`，绝不进 `提交时间`
    for raw, want in (('00:31:01', ('', '00:31:01')),
                      (' 01:02:03 ', ('', '01:02:03')),          # 前后空白照旧 strip
                      ('123:59:59', ('', '123:59:59')),          # 允许超过 24 小时
                      ('2026-09-13 22:06:07', ('2026-09-13 22:06:07', '')),
                      ('', ('', '')),
                      (None, ('', ''))):
        got = split_submit_time(raw)
        ok(got == want, f'split_submit_time({raw!r}) 期望 {want!r}，实际 {got!r}')

    # ② **合并时绝对优先**（真正的病根：两页同一条提交，谁后抓谁赢 ⇒ 相对把绝对抹了）
    #    分列之后这条是**数据驱动**的（`_merge_fields`：新记录空着的字段沿用旧值），
    #    所以这里正反两个方向都要成立 —— 谁先谁后抓都一样。
    abs_row = {'提交ID': '3175978', '提交时间': '2026-09-13 22:06:07', '相对提交时间': ''}
    rel_row = {'提交ID': '3175978', '提交时间': '', '相对提交时间': '00:31:01'}
    for newer, older, label in ((rel_row, abs_row, '相对后抓'), (abs_row, rel_row, '绝对后抓')):
        merged, _, _, _ = merge_by_key([older], [newer], KEY)
        ok(merged[0].get('提交时间') == '2026-09-13 22:06:07',
           f'{label}：合并后 提交时间 必须还是那个绝对时刻（实际 {merged[0].get("提交时间")!r}）')
        ok(merged[0].get('相对提交时间') == '00:31:01',
           f'{label}：相对值当证据留着（实际 {merged[0].get("相对提交时间")!r}）')

    total = checks
    if fails:
        print(f'❌ 自测失败，{len(fails)}/{total} 项：')
        for f in fails:
            print('  •', f)
        return 1
    print(f'✅ 自测通过：{total} 项（提交时间分列 + 合并时绝对优先）')
    return 0


def harvest_timefmt(cid: str, cookie: str, store: dict, verbose: bool = True) -> str:
    """
    看一场的**登录账号本人**提交页，从「提交时间」列的格式判断有没有"参与"这场。

    **优先用归档**（`cache/pages/<id>.submissions.html`，由 `--archive` 顺手存下），
    没有才联网抓 —— 跟场次页一个口径：解析只读归档，不再重复打网络。

    ⚠️ **但它是"活页"**（登录账号也可能在这之后补题/VP）：所以**默认不读归档、每次联网**，
    抓到照旧入库。拿旧快照当缓存用会把"后来才参与"的场次永久判成补题。

    @returns `'relative'`（参与过：正式赛或 VP）/ `'absolute'`（没参与过 = 补题）/ `''`
    """
    try:
        html = ARCHIVE.page(key=cid, kind='submissions',
                            url=f'{BASE_URL}/contest/{cid}/submissions',
                            fetch=fetch_html, cookie=cookie, cache=CACHE_NONE,
                            accept=good_page, verbose=False)
    except Exception:  # noqa: BLE001
        return ''
    if not html:
        return ''
    try:
        rows, _ = parse_html(html)
    except ValueError:
        return ''
    mine = [r for r in rows if r.get('提交者') == qoj_username()]
    if not mine:
        # 这一场登录账号一条提交都没有（归档的提交页只列自己）→ **什么都不记**
        # （别把"空页"记成 absolute = 补题）。若退到"别人的行"，
        #  就会把陌生人的提交时间当成自己的参与证据 —— 没有本人的行就一律不判。
        if verbose:
            print(f'   contest {cid}: 无提交 → 不记')
        return ''
    votes = {'relative': 0, 'absolute': 0}
    for r in mine:
        # ⚠️ 相对值**已经分到 `相对提交时间` 那一列**（`split_submit_time`）⇒ 两列都要看，
        #    否则这一票永远只数出 absolute，"参与过这场"就判不出来了。
        t = str(r.get('提交时间') or r.get('相对提交时间') or '')
        if _REL_TIME.match(t):
            votes['relative'] += 1
        elif _ABS_TIME.match(t):
            votes['absolute'] += 1
    kind = ''
    if votes['relative'] and not votes['absolute']:
        kind = 'relative'
    elif votes['absolute'] and not votes['relative']:
        kind = 'absolute'
    if kind:
        store[str(cid)] = kind
    if verbose:
        print(f'   contest {cid}: {votes} → {kind or "判不出（空页/混合）"}')
    return kind


def timefmt_needs_check(cid: str, rows: list[dict]) -> bool:
    """
    这一场的「提交时间列格式」还要不要重查？

    那页是**活页**（登录账号后来补题/VP 会变），所以默认每次都联网 —— 但"没有新东西"时没必要：
    归档页的 mtime 只要**晚于该场本人最后一次提交**，说明它已经包含"提交时的格式"。
    ⇒ 只有"页比本人最后一次提交还旧"（或还没归档）才重查。`--force` 一律 True。
    """
    if forced():
        return True
    p = ARCHIVE.path(cid, 'submissions')
    if not os.path.isfile(p):
        return True
    newest = ''
    for r in rows:
        if contest_of_record(r) != str(cid):
            continue
        t = str(r.get('提交时间') or '')
        m = _ABS_TIME.match(t)
        if m:
            newest = max(newest, t)
    if not newest:
        return True                      # 只有相对时间（说明这页已经抓过）⇒ 不重查
    return newest > time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(p)))


def parse_vp_contests(html: str) -> list[str]:
    """
    从用户主页 HTML 抽出"虚拟参赛"的场次号（去重保序）。

    区块形如：
        <h4 class="list-group-item-heading"> Virtual Participations：11 contests </h4>
        <table>… <tr><td><a href="/contest/1093">…</a></td><td>2026-09-23 …</td>…</tr> …
    取到下一个 `list-group-item-heading`（或文末）为止，只认这个区块里的 `/contest/<id>`。
    """
    key = 'Virtual Participations'
    i = html.find(key)
    if i < 0:
        return []
    j = html.find('list-group-item-heading', i + len(key))
    seg = html[i: j if j > 0 else len(html)]
    out = []
    for m in re.finditer(r'/contest/(\d+)', seg):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out


def harvest_vp_contests(user: str, cookie: str, store: dict) -> int:
    """
    抓一个人的主页 → 把他的 VP 场次并进 `store[user]`（返回新增了几场）。

    模式：**缓存 NONE + 重试 RETRY**（一次一页；页面入库 `<user>.user.html`，
    以后复核"这个人到底 VP 过哪些场"不用再联网；登录页不入库、不重试）。
    ⚠️ **这是"活页"**（VP 名单只增不减，实测每次重抓都多 1 场）：默认**不读归档**、
    每次都联网 —— 拿旧快照当缓存用就永远发现不了新 VP。
    """
    if not user:
        return 0
    html = ARCHIVE.page(
        key=user, kind='user', url=f'{BASE_URL}/user/profile/{user}',
        fetch=fetch_html, cookie=cookie, cache=CACHE_NONE,
        accept=good_page, verbose=False, label=f'user/{user}',
    )
    if not html:
        print(f'     ⚠️ {user} 主页没拿到（网络失败或 cookie 过期）—— 已抓的仍在库里')
        return 0
    found = parse_vp_contests(html)
    slot = store.setdefault(user, [])
    before = len(slot)
    for cid in found:
        if cid not in slot:
            slot.append(cid)
    return len(slot) - before


def fill_letters(rows: list[dict], problems: dict) -> int:
    """把 pid→字母 回填到"题号还是数字"的记录上（就地改），返回补了几条"""
    n = 0
    for r in rows:
        cid, pid = contest_of_record(r), pid_of_record(r)
        letter = ((problems.get(cid) or {}).get(pid) or {}).get('letter', '')
        if letter and not re.fullmatch(r'[A-Z]', str(r.get('题号') or '').strip().upper()):
            r['题号'] = letter
            n += 1
    return n


def harvest_contest_problems(contest_id: str, cookie: str, problems: dict,
                             verbose: bool = True, titles: dict | None = None) -> int:
    """
    从**比赛题目列表页** `https://qoj.ac/contest/<id>` 收**该场全部题目** → 题目清单缓存。

    （pid → 字母 / 题名 / 题面链接；**1 个请求搞定全场**，`--fetch` 那条路补字母用它。）

    `titles`：顺手把这一页的**场次名字**收进那张缓存（同一个页面，**零额外请求**）。
    QOJ 那棵树的 C 名字就靠它（`05 xcpc/qoj_adapter.py` 读 `qoj_contest_titles.json`）。

    **优先用归档**（`cache/pages/<id>.contest.html`）；没有才联网抓，抓到即入库。
    """
    try:
        html = ARCHIVE.page(key=contest_id, kind='contest',
                            url=f'{BASE_URL}/contest/{contest_id}',
                            fetch=fetch_html, cookie=cookie, accept=good_page, verbose=verbose)
    except Exception as e:  # noqa: BLE001
        # 别静默：网络/凭据出问题时，要能看到"这一场为什么没拿到"
        if verbose:
            print(f'      ✗ 抓不到题目列表页（{type(e).__name__}: {e}）')
        return 0
    if not html:
        if verbose:
            print('      ✗ 拿到的是登录页/被拦 —— **cookie 可能过期**'
                  '（浏览器登录 qoj.ac → F12 → 任一请求 → 复制 `Cookie:` 整行覆盖 me.json 的 qoj.cookie）')
        return 0
    if titles is not None:
        name = contest_title_from_html(html)
        if name:
            titles.setdefault(str(contest_id), {'names': []})['title'] = name
    # 题号与题名的解析**只有一处**（`contest_problems_from_html`，按行取）——
    # 这里不再自己写一份"窗口里找 td"，那种写法会把隔壁行的题号算到这一题头上
    #（实测 298 场里 296 场题号错乱：4071 整场变成 C,C,E,E,F,…）。
    found = contest_problems_from_html(contest_id, html)
    if not found:
        return 0
    n = 0
    slot = problems.setdefault(contest_id, {})
    for pid, info in found.items():
        if slot.get(pid) != info:
            slot[pid] = info
            n += 1
    if verbose:
        print(f'     题目列表页：{len(found)} 题，新增/更新 {n} 条'
              f'（该场缓存共 {len(slot)} 条）'
              + (f'　名字：{(titles or {}).get(str(contest_id), {}).get("title", "")}'
                 if (titles or {}).get(str(contest_id)) else ''))
    return n


def manifest_qoj_contests(manifest_path: str = '') -> list[str]:
    """从场次清单里收集"挂了 qoj 提交来源"的比赛号（`--all` 用）"""
    import json
    p = manifest_path or os.path.abspath(
        os.path.join(HERE, '..', '05 xcpc', 'xcpc_contests.json'))
    if not os.path.isfile(p):
        return []
    try:
        with open(p, 'r', encoding='utf-8-sig') as f:
            doc = json.load(f)
    except (ValueError, OSError):
        return []
    out = []
    for c in (doc.get('contests') or []):
        for s in (c.get('submissions') or []):
            if (s.get('source') or '') == 'qoj' and str(s.get('contest') or '').strip():
                cid = str(s['contest']).strip()
                if cid not in out:
                    out.append(cid)
    return out


def page_url(base: str, page: int) -> str:
    """给网址加上 `page=N`（**合并**已有查询参数，别把过滤条件冲掉 —— 如 `?submitter=X`）"""
    if page <= 1:
        return base
    parts = urllib.parse.urlsplit(base)
    q = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query) if k != 'page']
    q.append(('page', str(page)))
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(q), parts.fragment))


def fetch_pages(base: str, cookie: str, max_pages: int,
                verbose: bool = True, known: set | None = None,
                cache_key: str = '', cache: str | None = None,
                retry: str | None = None) -> tuple[list[dict], list[str]]:
    """
    逐页抓一个提交列表网址，按 `提交ID` 去重。

    停止条件（任一）：返回的不是提交表格（登录页/到底了）、**本页没有新提交**、
    不满一页、或到 `max_pages`。

    ⚠️ 实测 QOJ 页码越界时会**重复最后一页**的内容（不是空页）——
    所以"本页没有新提交"这个条件必须比"页面为空"更早判（否则会无限翻）。

    模式（`Scaper/lib/read_modes.py`）——这是"活列表"，三个模式在它身上各有明确用途
    （就地默认 **`CACHE_STOP`**，`--cache-mode` 给了就听 CLI）：
      · `cache_key` 给了就把每页**入库**（`<cache_key>.submissions.html` 是第 1 页，
        第 N 页是 `<cache_key>.pN.submissions.html`）—— 归档是"原料"，以后复核不用联网；
      · `CACHE_STOP`（默认）= **联网**逐页取最新，**一页全是旧提交就截断**（时间倒序 ⇒ 到头了）。
        这是日常增量：通常只发 1 个请求就回"已是最新"。
        ⚠️ 它**不能**读归档 —— 第 1 页的归档是**上次的快照**，拿它当缓存就会永远看不见新提交；
      · `CACHE_KEEP` = **有归档就用归档**、没有才联网；没新值也不截断。
        这是**接着补归档**（断了/被掐连接后重跑，已抓的页不重抓，很便宜）；
      · `CACHE_NONE` = **不读归档**、每页联网；不截断。想强制刷新时用。
      · `--force` 只影响 `has`/待办那一侧，这里本来就"该联网就联网"。
    """
    cache = active_cache(CACHE_STOP)          # 本点就地默认 STOP；--cache-mode 可全局翻转
    retry = retry if retry is not None else DEFAULT_RETRY
    rows: list[dict] = []
    seen: set[str] = set()
    notes: list[str] = []
    use_archive = cache == CACHE_KEEP and bool(cache_key)     # 只有 KEEP 才把归档当缓存读
    for page in range(1, max_pages + 1):
        url = page_url(base, page)
        key = cache_key if page == 1 else f'{cache_key}.p{page}'
        html = read_page(
            key=key or str(page), kind='submissions', url=url,
            fetch=fetch_html,
            # 归档的读/写都交给通用层：KEEP 才读（"接着补"），其余一律不读；拿到就入库
            load=ARCHIVE.read if use_archive else None,
            save=ARCHIVE.write if cache_key else None,
            cache=CACHE_KEEP if use_archive else CACHE_NONE, retry=retry, cookie=cookie,
            accept=good_page, verbose=False,
            label=f'{cache_key or base} 第 {page} 页',
        )
        if not html:
            notes.append(f'第 {page} 页没拿到（网络失败 / 登录页）')
            break
        try:
            page_rows, _skipped = parse_html(html)
        except ValueError as e:
            notes.append(f'第 {page} 页解析失败：{e}')
            break
        fresh = [r for r in page_rows if r.get('提交ID') not in seen]
        # ★ 增量水位线：**这一页整页都是旧提交** → 到头了。
        #   QOJ 的提交列表是**时间倒序**的，后面只会更旧。
        #   ⚠️ 这是"无新值**截断**"那档（`CACHE_STOP`）；`CACHE_KEEP` 说不看这条、继续翻。
        if (known and page_rows and all(r.get('提交ID') in known for r in page_rows)
                and should_stop_on_no_new(cache)):
            if verbose:
                print(f'   第 {page} 页：{len(page_rows)} 条全是已有的 → 到此为止（增量）')
            break
        if verbose:
            print(f'   第 {page} 页：{len(page_rows)} 条，新的 {len(fresh)} 条')
        if not fresh:
            break                       # 到底了（或页码越界重复了最后一页）
        for r in fresh:
            seen.add(r.get('提交ID'))
        rows.extend(fresh)
        if len(page_rows) < 10:         # 不满一页 → 后面没有了
            break
        time.sleep(PAGE_SLEEP)
    return rows, notes


def main(argv):
    ap = argparse.ArgumentParser(description='QOJ 提交列表 → JSON（默认合并）')
    ap.add_argument('-i', '--in', dest='inp', default='', help=f'输入 HTML（默认 {DEFAULT_HTML}）')
    ap.add_argument('--file', dest='inp_alias', default='', help='同 -i（与其它脚本的叫法一致）')
    ap.add_argument('-o', '--out', dest='out', default='', help=f'输出 JSON（默认 {DEFAULT_OUT}）')
    ap.add_argument('--output', dest='out_alias', default='', help='同 -o')
    ap.add_argument('--replace', action='store_true', help='覆盖写，不与已有文件合并')
    ap.add_argument('--dry-run', action='store_true', help='只解析并打印，不写文件')
    ap.add_argument('--fetch', action='store_true',
                    help='自动抓（需要 me.json 的 qoj.cookie）；不存页面')
    ap.add_argument('--contest', default='',
                    help='--fetch 用：比赛号，可多个用逗号分隔（如 4113,3799）')
    ap.add_argument('--url', default='', help='--fetch 用：直接给提交列表网址')
    ap.add_argument('--submitter', default='',
                    help='--fetch 用：**按人抓**（多人）—— 用户名，可多个用逗号分隔。'
                         '走全局提交列表页 `/submissions?submitter=<名字>`（那种页面还多一列"语言"），'
                         '抓**这个人的全部提交**（场次归属由列表里的 `/contest/<id>` 链接决定；'
                         '⚠️ 那个页面**不认** `contest=` ⇒ `--contest/--all` 在按人抓时不过滤）。'
                         '不给就用 me.json 花名册 `team` 里登记的所有 qoj 账号；'
                         '`--submitter -` 表示"只抓 cookie 身份本人那一场"。')
    ap.add_argument('--all', action='store_true',
                    help='--fetch 用：清单里所有挂了 qoj 提交来源的场次（按场次抓；'
                         '与 `--submitter` 同给时**不过滤** —— 见 `--submitter`）')
    ap.add_argument('--max-pages', type=int, default=DEFAULT_MAX_PAGES,
                    help=f'--fetch 用：每场最多翻几页（默认 {DEFAULT_MAX_PAGES}）')
    ap.add_argument('--cookie', default='', help='--fetch 用：临时指定 cookie（默认读 me.json）')
    ap.add_argument('--no-letters', action='store_true',
                    help='--fetch 用：不补题号字母（全局列表给的是题目数字 id，'
                         '不补的话那些记录在导入时定位不到父题目）')
    ap.add_argument('--categories-only', action='store_true', dest='categories_only',
                    help='配合 `--category`：**只把分类树（含祖先分类的真名）更新完就停**，'
                         '不再抓场次页 —— 改分类名/补分类时用这个，别为了一个名字重抓 300 场')
    # 读取的三件开关（`--cache-mode/--retry-mode/--force`）来自**通用层**，
    # 就地默认（各读取点自己声明的 KEEP / 活列表的 STOP）不传开关时照旧生效。
    add_cli_args(
        ap,
        cache_help='读取的**缓存模式**（`Scaper/lib/read_modes.py`；不给就按各读取点自己的默认）：'
                   f'`{CACHE_NONE}` 不缓存（每次联网，抓到仍入库）｜'
                   f'`{CACHE_KEEP}` 缓存、无新值**不截断**（翻到自然结束，用来补全归档）｜'
                   f'`{CACHE_STOP}` 缓存、无新值**截断**｜'
                   f'`offline` **离线**（只用本地、绝不联网，缺文件当场报错）。'
                   '给了它就**盖过所有就地默认**。'
                   '⚠️ 全局提交列表是**活列表**：`stop`（就地默认）联网取最新、一页全旧就截断；'
                   '`keep` 有归档用归档（**接着补归档**，断了重跑不重抓）；'
                   '`none` 联网且不读归档（强制刷新）。补归档：`keep`/`none` + 大 `--max-pages`',
        force_help='**强制重爬**：把归档当成不存在 —— 读页时联网，"还欠哪些"的判据也自动变成'
                   '"全部重抓"。范围看命令自己的选择器：'
                   '`--archive --contest 4071,1303 --force`（这一类里的这两个）｜'
                   '`--archive --force`（这一类全部）｜`--resolve-contests --force`（题面页归属整类）',
    )
    ap.add_argument('--category', default='',                    help='**整系列**：逗号分隔的分类 id（如 205,212,106,21）。会先**遍历分类树**'
                         '（分类页公开、不用 cookie，页面入库 cache/pages/category.<id>.html），'
                         '收齐这些系列里的**全部比赛**；再与"本人提交过的比赛"**取并集**，'
                         '按 --archive 那套逐场抓+归档+解析。')
    ap.add_argument('--sleep', type=float, default=PAGE_SLEEP,
                    help=f'每抓一页歇几秒（默认 {PAGE_SLEEP}）。嫌慢就设 0.1~0.2；'
                         '再小容易被 QOJ 掐连接。')
    ap.add_argument('--archive', action='store_true',
                    help='**爬原料**：把每场的题目列表页与提交页**原样存进** '
                         '`cache/pages/<场次号>.contest.html` / `.submissions.html`，'
                         '然后**只读归档**解析出场次名字与题号字母（离线，可反复跑）。'
                         '已有归档的场次**不重抓**（要重抓加 `--force`）—— 半路断掉/凭据过期，'
                         '重贴 cookie 再跑即可接着来。'
                         '场次默认取提交文件里出现过的那些，也可用 --contest 指定。')
    ap.add_argument('--list', action='store_true',
                    help='**取比赛列表**（`/contests`）→ 场次名字写进 cache/qoj_contest_titles.json。'
                         '**可选、独立**（不跑它也照样能用其它模式）：一页就是一批 (场次号, 名字)，'
                         '**目标场次都命中就提前停止翻页**；每页原始 HTML 入库 '
                         '`cache/pages/contests.p<N>.html`，第二次跑不重抓。'
                         '主站 qoj.ac 走 Cloudflare 会 403，会自动换镜像域（huang.lt / jiang.ly，同一套站点）。')
    ap.add_argument('--resolve-contests', action='store_true',
                    help='**补场次号**：提交文件里链接只有全局题号（`/problem/<pid>`）的那些记录，'
                         '去**题面页**查"这题被哪些比赛用过"（`The problem was used in the following '
                         'contests:`，公开页不用 cookie），把**第一场**写进记录的 `场次号`，'
                         '全部候选存 `cache/qoj_problem_contests.json`。'
                         '跑完重出一次包，这些提交就能挂到 QOJ 树上了。')
    ap.add_argument('--participation', action='store_true',
                    help='只抓**每人参加过哪些虚拟赛（VP）** → cache/qoj_vp_contests.json。'
                         '提交性质（赛时/VP）就靠它判：有提交但在 VP 名单里 = VP，不在 = 赛时。'
                         '用户名默认取 me.json 花名册；也可用 --submitter 指定。')
    ap.add_argument('--timefmt', action='store_true',
                    help='只抓**场次页「提交时间」列的格式** → cache/qoj_contest_timefmt.json。'
                         '参与过这场（正式赛/VP）显示相对时间（`04:53:08`），没参与过显示绝对时间'
                         '（`2024-07-23 10:07:05`）—— 用它就能直接判出「这条是赛时还是补题」。'
                         '场次默认取提交文件里出现过的那些。')
    ap.add_argument('--selftest', action='store_true',
                    help='**自测**（不联网、不读写任何原料）：判「提交时间」分列那几条 —— '
                         '相对时间不许进 `提交时间`。挂在 `npm test` 里（`src/test/pythonSelftests.test.js`）。')
    args = ap.parse_args(argv)
    # 读取策略（`--cache-mode/--retry-mode/--force`）**必须在读第一页之前**生效
    configure_from(args)

    if args.selftest:
        return _selftest()

    out_path = resolve_path(args.out or args.out_alias, DEFAULT_OUT)

    # ---------- 只抓"提交时间列格式"：判 赛时 / 补题 的**直接信号** ----------
    if args.timefmt:
        cookie = qoj_cookie(args.cookie)
        if not cookie:
            print('❌ 没有 QOJ cookie（me.json 的 qoj.cookie）', file=sys.stderr)
            return 1
        cids = [c.strip() for c in (args.contest or '').split(',') if c.strip()]
        if not cids:
            cids = sorted({contest_of_record(r) for r in load_json_list(out_path)
                           if contest_of_record(r)}, key=int)
        if not cids:
            print('⚠️ 没有要查的场次（提交文件里没认出场次号，也没给 --contest）', file=sys.stderr)
            return 1
        store = _load_map(TIMEFMT_CACHE)
        rows = load_json_list(out_path)
        stale = [c for c in cids if timefmt_needs_check(c, rows)]
        skip = len(cids) - len(stale)
        print(f'🕒 查「提交时间」列格式：{len(cids)} 场里 {len(stale)} 场要查'
              + (f'（跳过 {skip} 场：没有比比上次检查更新的提交；`--force` 可强制全查）' if skip else ''))
        for cid in stale:
            harvest_timefmt(cid, cookie, store)
            time.sleep(PAGE_SLEEP)
        _save_map(TIMEFMT_CACHE, store)
        print_stats('时间列')
        print(f'💾 {TIMEFMT_CACHE}')
        return 0

    # ---------- 取比赛列表：场次名字（可选、可缓存、命中够了就停）----------
    if args.list:
        cookie = qoj_cookie(args.cookie)      # 列表页公开；cookie 只是顺手带上
        cids = [c.strip() for c in (args.contest or '').split(',') if c.strip()]
        if not cids:
            cids = sorted({contest_of_record(r) for r in load_json_list(out_path)
                           if contest_of_record(r)}, key=int)
        want = set(cids)
        titles = _load_map(TITLES_CACHE)
        got_before = len(want & set(titles))
        print(f'📋 取比赛列表：目标 {len(want)} 场（已有名字 {got_before} 场）；'
              f'每页原始 HTML 会入库 cache/pages/contests.p<N>.html')
        used_host = ''
        for page in range(1, LIST_MAX_PAGES + 1):
            # 活列表 ⇒ 每页都联网取最新（要不要用归档由 `--cache-mode` 决定，见 fetch_list_page）
            html, base = fetch_list_page(page, cookie)
            if not html:
                print(f'   ✗ 第 {page} 页取不到（主站与镜像都没成）—— 停止')
                break
            if base != used_host:
                used_host = base
                print(f'   🌐 列表页来自 {base}')
            found = contest_index_from_list_html(html)
            fresh = {k: v for k, v in found.items() if k not in titles}
            for one_cid, entry in found.items():
                prev = titles.get(one_cid)
                # 场次页的 `<title>` 更权威（也更像"这场叫什么"），别被列表页盖掉
                entry['title'] = (prev or {}).get('title') if isinstance(prev, dict) else ''
                entry['title'] = entry['title'] or (entry['names'] or [''])[0]
                titles[one_cid] = entry
            hit = len(want & set(titles))
            print(f'   第 {page} 页：认出 {len(found)} 场，新增 {len(fresh)}，'
                  f'目标命中 {hit}/{len(want)}')
            if want <= set(titles):
                print('   ✅ 目标场次的名字都拿到了 → **提前停止翻页**（剩下的页不抓）')
                break
            if not fresh:
                print('   （这页没有新场次 → 列表到底了）')
                break
        _save_map(TITLES_CACHE, titles)
        missing = sorted(want - set(titles), key=int)
        print(f'💾 {TITLES_CACHE}　共 {len(titles)} 场有名字')
        if missing:
            print(f'   ⚠️ 还缺 {len(missing)} 场：{" ".join(missing)}')
        return 0

    # ---------- 补场次号：全局题号形式的提交，去题面页查它属于哪场比赛 ----------
    if args.resolve_contests:
        rows = load_json_list(out_path)
        if not rows:
            print(f'❌ {out_path} 里没有记录', file=sys.stderr)
            return 1
        cache = _load_map(PROBLEM_CONTESTS_CACHE)
        todo = [r for r in rows
                if not str(r.get('场次号') or '').strip()
                and not re.search(r'/contest/\d+', str(r.get('题目链接') or '')
                                  + ' ' + str(r.get('提交链接') or ''))]
        pids = [p for p in dict.fromkeys(pid_of_record(r) for r in todo) if p]
        # **顺手补归档**：缓存里已经有归属、但题面页还没入库的，也读一遍
        #（读 `ARCHIVE.page` ⇒ 有归档就用归档、没有才抓；以后复核"这题被哪些场用过"不用联网）
        backfill = [p for p in cache if not ARCHIVE.has(str(p), 'problem')]
        pids += [p for p in backfill if p not in pids]
        print(f'🔎 有 {len(todo)} 条提交认不出场次号（{len(pids) - len(backfill)} 个题目）；'
              f'缓存里已有 {len(cache)} 个题目的归属，其中 {len(backfill)} 个题面页还没归档')
        for i, pid in enumerate(pids, 1):
            print(f'   [{i}/{len(pids)}] 题目 {pid}')
            harvest_problem_contests(pid, cache)
        _save_map(PROBLEM_CONTESTS_CACHE, cache)

        n = 0
        for r in todo:
            pid = pid_of_record(r)
            cids_of = cache.get(str(pid)) or []
            if cids_of:
                r['场次号'] = cids_of[0]                      # 第一场 = 归属；候选全在缓存里
                n += 1
        if n:
            write_json_list(out_path, rows)
        multi = [p for p in pids if len(cache.get(str(p)) or []) > 1]
        unknown = [p for p in pids if not (cache.get(str(p)) or [])]
        print(f'✅ 补上场次号 {n} / {len(todo)} 条 → 重出一次包，它们就能挂到 QOJ 树上')
        print(f'   （题面页里被**多场**用过的 {len(multi)} 个题目取第一场；'
              f'查不到归属的 {len(unknown)} 个：{unknown[:8]}）')
        print(f'   💾 {PROBLEM_CONTESTS_CACHE}｜提交文件 {out_path}')
        return 0

    # ---------- 爬原料：把每场的两种页面原样入库，然后**只读归档**解析 ----------
    # `--category`：先遍历分类树收齐"整系列"的比赛，再与"本人提交过的比赛"取并集
    if args.archive or args.category:
        cookie = qoj_cookie(args.cookie)
        if not cookie:
            print('❌ 没有 QOJ cookie（me.json 的 qoj.cookie）—— 浏览器登录 qoj.ac 后，'
                  'F12 → 任一请求 → 复制 `Cookie:` 整行贴进去', file=sys.stderr)
            return 1
        cids = [c.strip() for c in (args.contest or '').split(',') if c.strip()]
        if not cids:
            cids = sorted({contest_of_record(r) for r in load_json_list(out_path)
                           if contest_of_record(r)}, key=int)
        named_cids = set(cids)            # `--contest` 点名的（下面"缺提交页"的判据要用）
        if args.category:
            roots = [x.strip() for x in str(args.category).split(',') if x.strip()]
            print(f'🗂️  遍历分类树：{", ".join(roots)}（分类页公开，不需要 cookie）')
            tree = walk_categories(roots, cookie, sleep=args.sleep)
            cat_contests, n_pages = tree['contests'], tree['pages']
            print(f'   → 走过 {n_pages} 个分类页，系列内比赛 {len(cat_contests)} 场')
            # 抓取范围 = 显式（--category 收来的系列场次）∪ 本人有提交的
            merged = sorted(union_scope(explicit=cat_contests, mine=cids, name='QOJ 场次'), key=int)
            cids = merged
            # 把这棵树**存盘**：05 那侧出 QOJ 包的比赛集合与"场次页抓不到时"的分类归属全靠它
            tree['roots'] = roots
            tree['contests'] = merged
            _save_map(CATEGORY_TREE_CACHE, tree)
            print(f'   💾 分类树：{CATEGORY_TREE_CACHE}'
                  f'（分类 {len(tree["names"])} 个，有分类归属的比赛 {len(tree["paths"])} 场）')
            if args.categories_only:
                print('（--categories-only：只更新分类树，不再抓场次页）')
                return 0
        if not cids:
            print('⚠️ 没有目标场次（提交文件里没认出场次号，也没给 --contest/--category）',
                  file=sys.stderr)
            return 1

        # 提交页**只对"本人提交过的场次"有意义**（那页只列自己的提交，实测 43 场）
        # —— 原料层要完整，判赛时/VP/补题就不必再碰网络
        mine_cids = {contest_of_record(r) for r in load_json_list(out_path) if contest_of_record(r)}
        # 点名要求归档的场次（`--contest`）：**连它的提交页一起归档**。
        # ⚠️ 实测踩过：`mine_cids` 只认**本地提交文件**里出现过的场次 ⇒ 没抓过的场永远不在里面、
        #    于是"缺提交页"永远是 0 —— 形成"没抓过 ⇒ 不在 mine ⇒ 不抓 ⇒ 永远抓不到"的死循环
        #    （2026-10-15 郑州站 1873：`--archive --contest 1873` 报"要跑 0 场"）。
        #    点名的场次不再问 mine_cids（显式选择器就是范围）。
        # 提交页是**时间倒序**的 ⇒ 翻页时
        # "整页都是已存的提交"就是到头了。水位线 = 文件里已有的提交 ID。
        known_ids = {str(r.get('提交ID')) for r in load_json_list(out_path) if r.get('提交ID')}
        # "还欠哪些"的判据用 `ARCHIVE.has` —— `--force` 时它一律 False ⇒ 自动变成"全部重抓"
        need_contest = [c for c in cids if not ARCHIVE.has(c, 'contest')]
        # 提交页要抓的 = 本人提交过的 ∪ **点名要的**（见上面 `named_cids` 那段）
        need_subs = [c for c in cids
                     if (c in mine_cids or c in named_cids) and not ARCHIVE.has(c, 'submissions')]
        todo = sorted(set(need_contest) | set(need_subs), key=int)
        print(f'📦 原料归档：{len(cids)} 场（其中本人提交过 {len(mine_cids)} 场）；'
              f'缺场次页 {len(need_contest)} 场、缺提交页 {len(need_subs)} 场'
              f' ⇒ 这轮要跑 {len(todo)} 场')
        if todo:
            # 先试几场验凭据：**过期就立刻停**，别白跑几百场。
            # 但不能"第一场挂掉就判死刑" —— 有的场次自己下线了（实测 2624 手动打开也是 403），
            # 那是这一场的事，不是 cookie 的事。所以连着试 PROBE_TRIES 场，全挂才停。
            dead: list = []
            # 只在"还欠得多"时先试几场验凭据 —— 要抓的就那么一两场时没什么可省的，
            # 直接进循环（否则"唯一那场已下线"会被误判成"整轮跑不动"）。
            if len(todo) > PROBE_TRIES:
                alive = False
                for probe in todo[:PROBE_TRIES]:
                    try:
                        html = ARCHIVE.page(key=probe, kind='contest',
                                            url=f'{BASE_URL}/contest/{probe}',
                                            fetch=fetch_html, cookie=cookie,
                                            accept=good_page, verbose=False)
                    except Exception as e:  # noqa: BLE001
                        print(f'   ⚠️ 试抓 {probe} 失败（{type(e).__name__}: {e}）')
                        dead.append(probe)
                        continue
                    if not html:
                        print('❌ 拿到的是登录页/被拦 —— **cookie 已过期**'
                              '（`cf_clearance` 只活几十分钟）。'
                              '\n   浏览器登录 qoj.ac → F12 → Network → 任一请求 → 复制 `Cookie:` 整行，'
                              '覆盖 me.json 的 qoj.cookie，然后重跑本命令。', file=sys.stderr)
                        return 1
                    alive = True
                    break
                if not alive:
                    print(f'❌ 连着 {len(dead)} 场都抓不到 —— 先确认网络能不能打开 https://qoj.ac',
                          file=sys.stderr)
                    return 1
            for i, cid in enumerate(todo, 1):
                if cid in dead:
                    print(f'   [{i}/{len(todo)}] contest {cid} —— 跳过（这页抓不到，多半已下线）')
                    continue
                print(f'   [{i}/{len(todo)}] contest {cid}')
                try:
                    if cid in need_contest:
                        ARCHIVE.page(key=cid, kind='contest', url=f'{BASE_URL}/contest/{cid}',
                                     fetch=fetch_html, cookie=cookie, accept=good_page)
                    if cid in need_subs:
                        # 提交页：**"本人提交过的" + `--contest` 点名的那几场**才抓（要登录）。
                        # 走 `fetch_pages` 而不是单页 —— 时间倒序 ⇒ **碰到整页已知就截断**，
                        # 不重翻旧页；抓到即入库（第 1 页 `<cid>.submissions.html`，第 N 页 `.pN.`）
                        fetch_pages(f'{BASE_URL}/contest/{cid}/submissions', cookie,
                                    DEFAULT_MAX_PAGES, verbose=False,
                                    known=known_ids, cache_key=str(cid))
                except Exception as e:  # noqa: BLE001
                    print(f'      ✗ 跳过：{type(e).__name__}: {e}（已抓的都在库里，重跑接着来）')
                    dead.append(cid)
                    continue
                if cid in need_contest and not ARCHIVE.has(cid, 'contest'):
                    print('      ✗ cookie 过期 —— 停在这里；已抓的都在库里，'
                          '重贴 cookie 后重跑本命令即可接着来')
                    break
                time.sleep(args.sleep)
            if dead:
                print(f'   ⚠️ 这 {len(dead)} 场没有归档（抓不到/已下线）：{" ".join(dead)}')
                print('      —— 它们仍会出 C 节点（名字来自场次列表页），只是没有题目清单')
        else:
            print('   （全部已有归档，直接解析）')

        # ---- 解析：**只读归档**（不联网），出场次名字与题目清单（含题号字母）----
        titles = _load_map(TITLES_CACHE)
        probs = _load_map(PROBLEMS_CACHE)          # {场次号: {题目id: {letter,name,link}}}
        cats = _load_map(CATEGORIES_CACHE)         # {场次号: [[{id,name}, …], …]}
        for cid in cids:
            html = ARCHIVE.read(cid, 'contest')
            if html:
                found = contest_problems_from_html(cid, html)
                if found:
                    probs[str(cid)] = found            # **该场全部题目**（含题号字母/题名/题面链接）
                paths = contest_categories_from_html(html)
                if paths:
                    cats[str(cid)] = paths             # QOJ 自己的分类路径
                name = contest_title_from_html(html)
                if name:
                    # 同一页顺手取名字，零额外请求；场次页的 `<title>` 是最权威的那个
                    titles.setdefault(str(cid), {'names': []})['title'] = name
        _save_map(TITLES_CACHE, titles)
        _save_map(PROBLEMS_CACHE, probs)
        _save_map(CATEGORIES_CACHE, cats)
        missed = [c for c in cids if c not in titles]
        n_probs = sum(len(v) for v in probs.values())
        print(f'✅ 解析完成：场次名字 {len(titles)} 个；'
              f'**题目清单 {n_probs} 题 / {len(probs)} 场**；分类路径 {len(cats)} 场')
        print(f'   （{PROBLEMS_CACHE} / {CATEGORIES_CACHE}）')
        # 体检：一场里题号**不该重复**（重复 = 页面格式变了 / 解析取错了行）。
        # 实测踩过：窗口式取法把隔壁行的题号算过来，298 场里 296 场错乱，全靠这行就能立刻发现。
        dup_letters = []
        for one_cid, info in probs.items():
            ls = [v.get('letter') or '' for v in info.values()]
            if len(ls) != len(set(ls)):
                dup_letters.append(one_cid)
        if dup_letters:
            print(f'   ❌ {len(dup_letters)} 场的题号有重复（页面格式可能变了，别急着导入）：'
                  f'{" ".join(dup_letters[:5])}{"…" if len(dup_letters) > 5 else ""}')
        else:
            print('   ✔ 每场的题号都不重复')
        # 体检二：题目表里的**行数**应与解析出的题数一致（差 = 有行没解析出来）。
        # 注意**字母缺口不一定是错**：QOJ 有的场次真的跳过字母（实测 1939 没 J、3542 没 G，
        # 行数与解析数一致 ⇒ 站点如此）。所以判据用"行数 vs 解析数"，字母缺口只当提示。
        lossy, gaps = [], 0
        for one_cid in cids:
            html = ARCHIVE.read(one_cid, 'contest')
            if not html:
                continue
            n_rows = sum(1 for row in re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.S | re.I)
                         if f'/contest/{one_cid}/problem/' in row)
            n_parsed = len(probs.get(str(one_cid)) or {})
            if n_rows and n_rows != n_parsed:
                lossy.append(f'{one_cid}({n_parsed}/{n_rows})')
            ls = sorted((v.get('letter') or '').strip() for v in (probs.get(str(one_cid)) or {}).values())
            if ls and all(len(x) == 1 and x.isalpha() for x in ls) \
                    and ls != [chr(ord('A') + i) for i in range(len(ls))]:
                gaps += 1
        print('   ✔ 每场的题表行数都与解析出的题数一致' if not lossy else
              f'   ❌ {len(lossy)} 场有行没解析出来（解析/行数）：{" ".join(lossy[:5])}'
              f'{"…" if len(lossy) > 5 else ""}')
        if gaps:
            print(f'   ℹ️ {gaps} 场的题号字母不连续（站点自己跳号，行数一致 ⇒ 不是漏题）')
        # 体检三：**本人提交过的每一题，都该在题目清单里**（缺 = 漏题，会挂不上父节点）。
        orphan = {}
        for r in load_json_list(out_path):
            cid, pid = contest_of_record(r), pid_of_record(r)
            if cid and pid and pid not in (probs.get(cid) or {}):
                orphan[cid] = orphan.get(cid, 0) + 1
        if orphan:
            print(f'   ❌ 有 {sum(orphan.values())} 条提交的题目不在清单里（{len(orphan)} 场）：'
                  + '、'.join(f'{c}×{n}' for c, n in list(orphan.items())[:5]))
        else:
            print('   ✔ 本人提交过的题目都在清单里')
        if missed:
            print(f'   ⚠️ 还没有名字的 {len(missed)} 场：{" ".join(missed)}')
            print('      （大多是还没抓到归档；重贴 cookie 后重跑本命令即可）')
        print_stats('原料归档')
        return 0

    # ---------- 只抓"参与记录"（VP 名单）：提交性质判定的依据 ----------
    if args.participation:
        cookie = qoj_cookie(args.cookie)
        if not cookie:
            print('❌ 没有 QOJ cookie（me.json 的 qoj.cookie）—— 抓参与记录要登录态', file=sys.stderr)
            return 1
        users = [x.strip() for x in (args.submitter or '').split(',') if x.strip()]
        if not users:
            users = qoj_handles()
        if not users:
            print('⚠️ 没有要查的用户名（me.json 花名册里没有 qoj 账号，也没给 --submitter）',
                  file=sys.stderr)
            return 1
        store = _load_map(VP_CACHE)
        print(f'👤 抓参与记录（{len(users)} 人）')
        for u in users:
            got = harvest_vp_contests(u, cookie, store)
            print(f'   {u}: VP {len(store.get(u) or [])} 场（本次新增 {got}）')
            time.sleep(PAGE_SLEEP)
        _save_map(VP_CACHE, store)
        print(f'💾 {VP_CACHE}')
        return 0

        print('   ℹ️ 适配器会自动读这两个缓存 —— 不用改 qoj_submissions.json')
        return 0

    # ---------- 取数据：自动抓 或 读存下来的 HTML ----------
    fetch_notes: list[str] = []
    if args.fetch:
        cookie = qoj_cookie(args.cookie)
        if not cookie:
            # ⚠️ **没配 cookie ⇒ 友好跳过（exit 0），不当失败** —— 口径与 `clist-difficulty.py`
            #    一致（`build_chain.py` 那条注释："没有凭据 / 网络不通 ⇒ 脚本自己友好跳过"）。
            #    为什么必须这样：这一步**挂在自动链上了**（2026-10-15 起，`steps_for()` 的
            #    `qoj-submits`）⇒ 队友那台没配 QOJ cookie 的话，硬退出 1 会让**整条重建链**
            #    当场停（他连包都出不了）。**过期/被拦**另当别论（那是 `read_page` 的
            #    `SystemExit(2)`：当场停，别静默出缺新提交的包）。
            print('⚠️ 没有 QOJ cookie（me.json 的 qoj.cookie）—— 这一次**跳过抓取**、不当失败；'
                  '包里 QOJ 那部分照旧用盘上的 `04 qoj/qoj_submissions.json`（**可能缺新提交**）。\n'
                  '   要抓就填 cookie：浏览器登录 qoj.ac → F12 → Network → 任一请求 → '
                  'Request Headers 的 `Cookie:` 整行原样粘进 me.json 的 `qoj.cookie`'
                  '（或临时用 --cookie "…"）。不想用 cookie 也行：手动 Ctrl+S 存页面，'
                  '然后不带 --fetch 跑本脚本。', file=sys.stderr)
            return 0
        # 目标列表：默认是"这场比赛里登录账号自己的提交"（cookie 身份）；
        # `--submitter` 则改成**逐人**抓全局提交列表页（多人）。
        # 全局页 `/submissions?submitter=X` 比比赛页多一列"语言"，且不受"只看自己"限制。
        subs = [x.strip() for x in (args.submitter or '').split(',') if x.strip()]
        # ★ 花名册只是"**没给任何范围选择器**时的默认" —— 范围永远由命令自己的选择器决定
        #   （`Scaper/AGENTS.md` 那条）。实测踩过（2026-10-15，郑州站）：`--fetch --contest 1873`
        #   ——文件头 §1 白纸黑字写的"某一场"—— 在这里被花名册**悄悄**换成"按 3 个账号抓全量
        #   列表"：`--contest` 一个字都不生效，只在 stderr 打一句警告，于是"我指名的那一场"
        #   一条都没抓到（那一场就是这么漏的）。
        #   花名册非空 + 给了 `--contest/--all` ⇒ 按场次抓；要按人抓就显式 `--submitter`。
        if not args.submitter and not (args.contest or args.all):
            subs = qoj_handles()          # me.json 花名册（没登记就是空 → 退回 cookie 身份）
        if args.submitter == '-':
            subs = []                     # 显式要求"只抓 cookie 身份本人"
        cids: list[str] = []
        if args.url:
            targets = [(args.url, args.url)]
        elif subs:
            # ⚠️ **按人抓时 `--contest/--all` 不做任何过滤**：QOJ 的全局提交列表页
            #    (`/submissions?submitter=X`)**不认** `contest=` —— 实测
            #    `?submitter=someone&contest=2609` 与 `&contest=1303` 返回**同一份列表**
            #    （页里那些题的 `/contest/<id>` 五花八门：1093/1303/1480/…/4113）。
            #    所以：
            #      · **不再拼 `&contest=`** —— 它只是让人以为过滤生效了，还把归档写成
            #        `submitter-<名字>-c<场次>`（那名字是假的：文件名说是那一场，内容是全量）；
            #      · `--all` 也不再对同一份列表**翻 N 遍**（那是 N 个账号 × N 场 = N² 次同样的请求）；
            #      · 场次归属**由列表里的 `/contest/<id>` 链接决定**（`contest_of_record()`），
            #        要"某一场的提交"就用 `--contest <id>`（比赛页 —— 但那页只列
            #        **cookie 身份本人**的提交，别人的拿不到，见 `_usage.md`）。
            if args.all or args.contest:
                print('⚠️ 按人抓时 `--contest/--all` **不过滤**（QOJ 全局列表页不认 `contest=`，'
                      '实测是同一份列表）⇒ 本次按**该账号的全部提交**抓，'
                      '场次归属由列表里的 `/contest/<id>` 链接决定', file=sys.stderr)
            targets = [(who, f'{BASE_URL}/submissions?submitter={urllib.parse.quote(who)}')
                       for who in subs]
            print(f'👥 按人抓：{len(subs)} 个账号（{", ".join(subs)}）（各抓全部提交）')
        elif args.contest:
            cids = [c.strip() for c in args.contest.split(',') if c.strip()]
            targets = [(f'contest {c}', f'{BASE_URL}/contest/{c}/submissions') for c in cids]
        elif args.all:
            cids = manifest_qoj_contests()
            if not cids:
                print('⚠️ 清单里没有任何挂 qoj 提交来源的场次 —— 先用 --contest 指定，'
                      '或先去 gen_gym_manifest.py 生成清单')
                return 1
            targets = [(f'contest {c}', f'{BASE_URL}/contest/{c}/submissions') for c in cids]
        else:
            print('❌ --fetch 要指明抓哪里：--contest 4113 ／ --url <网址> ／ --all '
                  '／ --submitter <用户名>', file=sys.stderr)
            return 1

        user = qoj_username() or '（me.json 里没写 qoj.username）'
        print(f'🌐 自动抓（用户 {user}，{len(targets)} 个目标，每个最多翻 {args.max_pages} 页）')
        rows = []
        seen_ids: set[str] = set()
        # 增量水位线：**已经存下来的提交 ID**。QOJ 列表时间倒序 → 撞到整页旧的即可停。
        known_ids = {str(r.get('提交ID')) for r in load_json_list(out_path) if r.get('提交ID')}
        if known_ids:
            print(f'   已存 {len(known_ids)} 条提交 → 碰到整页已知就停（增量）')
        for label, url in targets:
            print(f'  {label}  {url}')
            # 归档 key 取得能一眼认出来源：按人抓 → `submitter-<名字>`（**没有场次维度** ——
            # 那个页面不认 `contest=`，见上面"按人抓 `--contest/--all` 不过滤"那段）；
            # 按场次抓 → 场次号（第 1 页仍用 `<场次号>.submissions.html`）。
            if '/submissions?submitter=' in url:
                name = urllib.parse.unquote(url.split('submitter=')[1].split('&')[0])
                cache_key = f'submitter-{name}'
            else:
                cache_key = url.rstrip('/').split('/')[-2]
            got, notes = fetch_pages(url, cookie, args.max_pages, known=known_ids,
                                     cache_key=cache_key, cache=args.cache_mode,
                                     retry=args.retry_mode)
            fresh = [r for r in got if r.get('提交ID') not in seen_ids]
            for r in fresh:
                seen_ids.add(r.get('提交ID'))
            rows.extend(fresh)
            print(f'     → {len(fresh)} 条'
                  + (f'（跨目标跳过 {len(got) - len(fresh)} 条重复）' if len(got) > len(fresh) else ''))
            for n in notes:
                print(f'     ⚠️ {n}')
            fetch_notes.extend(notes)
    else:
        html_path = resolve_path(args.inp or args.inp_alias, DEFAULT_HTML)
        if not os.path.isfile(html_path):
            print(f'❌ 找不到 HTML：{html_path}\n'
                  f'   要么用 --fetch（需要 cookie），要么先在 QOJ 打开提交列表 → Ctrl+S 存成这个文件',
                  file=sys.stderr)
            return 1
        try:
            rows, skipped = parse_submissions(html_path)
        except ValueError as e:
            print(f'❌ {e}', file=sys.stderr)
            return 1
        print(f'📄 解析 {os.path.basename(html_path)} → {len(rows)} 条'
              + (f'（另有 {skipped} 行不像提交记录，已跳过）' if skipped else ''))

    if not rows:
        if known_ids:
            print('✅ 已是最新：一页都是已有提交（时间倒序，后面更旧）→ 没有新东西')
            return 0
        print('⚠️ 一条都没拿到 —— 若是自动抓：确认 cookie 有效、这场确实有你的提交'
              '（或页面结构变了）')
        return 1

    # 场次归属：链接只有**全局题号** `/problem/<pid>` 的那批（QOJ 的全局提交列表就这么写）——
    # 用**题面页**的 `The problem was used in the following contests:` 补上，
    # 写进同一份缓存 `cache/qoj_problem_contests.json`（公开页、不用 cookie、页面入归档）。
    # ⚠️ **必须排在补题号字母之前**：字母那一步要按 `contest_of_record()` 认场次，
    #    认不出场次的记录会被整条跳过（连字母都补不上）。
    # 为什么放在**抓取**这条路上（而不是只留 `--resolve-contests`）：这是"抓到新提交顺手补齐"。
    #    否则每冒出一条全局题号的新提交，都得记得再单独跑一趟那条命令 ——
    #    而 `05 xcpc` 的适配器只能靠这份缓存认场次（它手里没有能认出场次的链接）。
    pc_cache = _load_map(PROBLEM_CONTESTS_CACHE)
    need_pid: dict[str, int] = {}
    for r in rows:
        if contest_of_record(r):
            continue                    # 场次号 / 链接里带 /contest/<id> ⇒ 不用查题面页
        pid = pid_of_record(r)
        if pid and str(pid) not in pc_cache:
            need_pid[str(pid)] = need_pid.get(str(pid), 0) + 1
    if need_pid:
        print(f'🧭 补场次归属：{len(need_pid)} 道题（链接只有全局题号 /problem/<pid>，'
              '查题面页"被哪些场次用过"）')
        for pid, cnt in sorted(need_pid.items(), key=lambda kv: -kv[1]):
            print(f'   problem {pid}（{cnt} 条提交）')
            harvest_problem_contests(pid, pc_cache)
        _save_map(PROBLEM_CONTESTS_CACHE, pc_cache)

    # 题号字母：全局列表给的是 pid，这里按场补成字母（写进**题目清单缓存**，唯一一份）
    probs = _load_map(PROBLEMS_CACHE)
    harvest_letters(rows, probs)
    if not args.no_letters:
        need: dict[str, int] = {}
        for r in rows:
            cid, pid = contest_of_record(r), pid_of_record(r)
            if not cid or LETTER_ONLY.match(str(r.get('题号') or '').strip().upper()):
                continue
            if ((probs.get(cid) or {}).get(pid) or {}).get('letter'):
                continue
            need[cid] = need.get(cid, 0) + 1
        if need:
            print(f'🔤 补题号字母：{len(need)} 场（全局列表只给题目数字 id，'
                  f'应用里 R 的父节点要字母）')
            for cid, cnt in sorted(need.items(), key=lambda kv: -kv[1]):
                print(f'   contest {cid}（缺 {cnt} 条）')
                harvest_contest_problems(cid, cookie, probs)   # 全场题目清单（1 请求）
            _save_map(PROBLEMS_CACHE, probs)
            filled = fill_letters(rows, probs)
            left = sum(1 for r in rows if not LETTER_ONLY.match(str(r.get('题号') or '').strip().upper()))
            print(f'   → 补上 {filled} 条' + (f'；仍有 {left} 条拿不到字母（适配器会跳过并提示）'
                                              if left else ''))

    print(f'   比赛号分布：{fmt_counts(contest_ids(rows))}')
    print(f'   提交者分布：{fmt_counts(count_by(rows, "提交者"))}')

    if args.dry_run:
        print('（--dry-run：没有写文件）')
        return 0

    existing = [] if args.replace else load_json_list(out_path)
    merged, added, updated, nokey = merge_by_key(existing, rows, KEY)

    mode = '覆盖' if args.replace else '合并'
    if not args.replace and not added and not updated:
        print(f'✅ {out_path}')
        print(f'   （{mode}）内容本来就是最新的：合计 {len(merged)} 条，**未重写文件**')
    else:
        write_json_list(out_path, merged)
        print(f'💾 {out_path}')
        print(f'   （{mode}）新增 {added} 条、更新 {updated} 条、合计 {len(merged)} 条'
              + (f'；{nokey} 条没有 {KEY} 只能追加' if nokey else ''))
    all_contests = contest_ids(merged)
    if len(all_contests) > 1:
        print(f'   文件里现在有 {len(all_contests)} 场比赛：{fmt_counts(all_contests)}')
        print('   （清单里按 contest 号引用**同一份文件**即可，适配器会分开）')
    else:
        print(f'   清单里这样挂：{{ "source": "qoj", "role": "submissions", '
              f'"file": "…/{os.path.basename(out_path)}", "contest": "{list(all_contests)[0]}" }}')
    print_stats('本次')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
