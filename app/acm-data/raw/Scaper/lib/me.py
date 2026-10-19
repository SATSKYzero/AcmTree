#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
**你的个人信息**都在这一个文件里（`<仓库根>/个人数据/me.json`；搬到 `app/` 之前的老位置是
`acm-data/raw/Scaper/me.json`，`--migrate` 认得它）。

★ **"个人信息"只在这一个文件里，仓库里别处不留痕迹**（用户 2026-10-19："TEAM0/teamA 等所有个人信息
理应由 me.json 提供，且不留痕迹"）⇒ 账号 / 队名 / handle / 口令 / "这一场用哪个账号抓的"**都写这里**，
不许在 `acm-data/` 下落 `{cid: 账号}` 那种文件（原来是 `02 hdu/hdu_contest_accounts.json`，已删）。

为什么要有它
-----------------------------------
这些东西散在三处时，改一个 handle 要翻三个文件：
    CF 密钥    → `05 xcpc/cache/cf_api.json`
    CF handle  → `05 xcpc/gym_whitelist.json` 的 handle、`05 xcpc/xcpc_contests.json` 的 defaults
    QOJ 登录态  → 根本没有（只能手动存页面）
现在统一到这里，**脚本一律先读它**，环境变量仍然可以临时覆盖。

⚠️ 这个文件里有**密钥与登录态**：
   * 别放进公开仓库、别发给别人（本项目没有 git，注意你手工同步的目录里有没有它）；
   * `python me.py --show` **原样显示**（不再打码）：
     那是你自己的终端，遮起来只是让自己核对时多一步。
     ⚠️ 所以**给别人看结构时别发这份 me.json**，要发就先把凭据换成占位符。

字段
----
**账户就是花名册的一项**，一份文件装下"自己是谁 / 在各平台叫什么 /
历年的队名 / 应用那边的映射"。

    accounts[]            每个人一项 = 应用里的一个账户：
        id                可选；应用写的稳定 id（树数据里 `值.account` 引用它）
        name              显示名（= 账户名）
        nature            自由标签（"本人小号"…）
        active            false = 停用（缺省 = 活跃）
        children[]        可选：子账户（按 id / name 引用）
        cf/qoj/nk/hdu/…   各平台账号（**就是花名册那一行**）
        byYear            带赛季平台的历年账号：{"nk": {"2023": "选手甲", …}}
        mappings[]        可选：应用那边的映射**原文**（应用没装/没跑时也一条不丢）
    current / viewing     应用的"登录账户 / 在查看"（按 id 或 name 引用）

    cf.apiKey/apiSecret   平台凭据仍按平台放在**顶层**（与 accounts 无关）
    qoj.cookie / clist.apiKey / …
    cf.handle / qoj.username / nk.handle / hdu.handle / pta.teamName
                          单人写法的"当前账号"（兼容：`accounts` 为空时全靠它）
    hdu.files             HDU 提交文件的显式绑定（Status 表没有提交者列）
    hdu.years.<年份>.contestUser/.contestPassword
                          HDU **按年的比赛口令**（`/contest/login` 表单那一对）—— 自动抓 HDU 赛内页靠它
                          （见 `02 hdu/hdu_multi_fetch.py`），**出包侧"这一场的历史账号"也从这里推**
                          （`hdu_year_accounts()`：按 cid 查出年份再取那一格，仓库里不落任何文件）
    hdu.contestUser / hdu.contestPassword
                          顶层的**兜底**那一对（老写法 / 只关心一年的场合）
    hdu.cookie            HDU 站点登录 Cookie 整行（**可选**：只有个别页面在口令之外还要站点登录态）

取值优先级：命令行参数 > 环境变量 > `me.json`。

用法
----
    python me.py --show        # 原样显示当前配置（含凭据；这是你自己的终端）
    python me.py --team        # 账户/花名册（每人各平台账号 + 各平台实际会抓的）
    python me.py --check       # 用 CF 发一个需要登录的请求 + 用 QOJ cookie 取一次列表，验证是否有效
    python me.py --migrate     # 把 `team` + 顶层单个 handle，以及兼容位置的值搬进来
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))          # …/Scaper/lib
SCAPER = os.path.dirname(HERE)                             # …/Scaper


def _repo_root() -> str:
    """
    仓库根 = **向上第一个含 `package.json` 的目录**（**不手推 `..` 级数**）。

    ⚠️ 为什么要走一遍：`个人数据/` 在**机械层外面**，而抓取层被整目录搬过一次
    （`app/` 那次），手推的 `'..'` 个数一搬就错。找不到（单独复制出来的 `Scaper/`）
    就退回 `SCAPER`：`load_me()` 本来就容错"文件不存在"，宁可指个空位置也别抛。
    """
    d = HERE
    while True:
        if os.path.isfile(os.path.join(d, 'package.json')):
            return d
        up = os.path.dirname(d)
        if up == d:
            return SCAPER
        d = up


#: 凭据 + 花名册的**唯一位置**：`<仓库根>/个人数据/me.json`（用户 2026-10-17：
#  "个人信息集中一处，公开副本整目录排除"）。同一条口径的服务器侧另一份在
#  `scripts/devserver/paths.py` + `me_store.ME_REL`。
ME_FILE = os.path.join(_repo_root(), '个人数据', 'me.json')

# 兼容位置（--migrate 从这里搬；搬完可以删）
LEGACY_CF_CRED = os.path.join(SCAPER, '05 xcpc', 'cache', 'cf_api.json')

#: `load_me()` 的一格缓存 —— **按 (路径, mtime, 大小) 失效**（**不是**"读过就永远用它"）。
#  ⚠️ 实测踩到（2026-10-16）：应用里那颗「🛠 重建总包并导入」是**在 dev-server 那个长驻进程里**
#     跑链子的（`scripts/devserver/build_runner.py`，只 `importlib.reload(build_chain)`），
#     而这一步 `runpy` 进去之后 `import me` **复用同一个已导入的模块** ⇒ 缓存里还是**旧 cookie**
#     ⇒ 症状正是"**另起进程探活通过（读的是新 me.json）、长驻进程里爬数据稳定判过期**"
#     （用户实测：换完 cookie 反复重建都停在 `qoj-submits` 的 302）。
#     ⇒ 文件一变就必须重读；顺带修掉"传了别的 `path` 也照样返回第一份"这个毛病。
#     ★ 判据与 `05 xcpc/lib/xcpc_common.py:read_json_cached()` 的 `_JSON_MEMO` **同一套**
#       （(路径, mtime_ns, size) 当键、同一文件只留最新那一版）—— 那边早就对了，这边漏了。
_CACHE: list = []          # [(路径, mtime_ns, 大小, data)]


def load_me(path: str = '') -> dict:
    """
    读 `me.json`（容错：没有/坏了都返回 {} 并只提示一次）。

    缓存**按文件的 (mtime, 大小) 失效**：文件改了就重读（理由见上面 `_CACHE` 的实测记录）。
    """
    p = path or ME_FILE
    try:
        st = os.stat(p)
        key = (p, st.st_mtime_ns, st.st_size)
    except OSError:                     # 文件不在 ⇒ 用 (p,0,0) 当键：以后出现了自然会重读
        key = (p, 0, 0)
    if _CACHE and _CACHE[0][:3] == key:
        return _CACHE[0][3]
    data: dict = {}
    if os.path.isfile(p):
        try:
            with open(p, 'r', encoding='utf-8-sig') as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except (ValueError, OSError) as e:
            print(f'⚠️ 读不了 {p}（{e}）—— 按"没有个人信息"处理', file=sys.stderr)
    _CACHE[:] = [(key[0], key[1], key[2], data)]
    return data


def get(dotted: str, default: str = '') -> str:
    """按 `cf.handle` 这种点号路径取值；没有就返回 default"""
    cur = load_me()
    for part in dotted.split('.'):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(part)
    return str(cur).strip() if cur is not None else default


# ================================================================
# 各平台的具体取值（**唯一一份**，别的脚本都从这里拿）
# ================================================================

def cf_credentials() -> tuple[str, str]:
    """(apiKey, apiSecret)—— 环境变量 > me.json > cache/cf_api.json"""
    key = os.environ.get('CF_API_KEY', '').strip()
    secret = os.environ.get('CF_API_SECRET', '').strip()
    if key and secret:
        return key, secret
    key, secret = get('cf.apiKey'), get('cf.apiSecret')
    if key and secret:
        return key, secret
    if os.path.isfile(LEGACY_CF_CRED):                      # 向后兼容：这个位置还有就用
        try:
            with open(LEGACY_CF_CRED, 'r', encoding='utf-8-sig') as f:
                d = json.load(f)
            return str(d.get('key', '')).strip(), str(d.get('secret', '')).strip()
        except (ValueError, OSError):
            pass
    return '', ''


def _main_handle(platform: str) -> str:
    """
    "这个平台**当前**用哪个账号"（`cf_handle()` 这类单值 getter 的兜底）。

    顺序：`me.json` 的 `current`（按 id 或 name 找那个账户）→ 第一个有这个平台账号的账户。
    为什么要它：账号只在 `accounts[]` 里，顶层不再重复写一份（免得两处打架）。
    """
    plat = str(platform or '').lower()
    accs = accounts()
    if not accs:
        return ''
    cur = str(load_me().get('current') or '').strip()
    if cur:
        for acc in accs:
            if cur in (acc['id'], acc['name']) and acc['handles'].get(plat):
                return acc['handles'][plat]
    for acc in accs:
        if acc['active'] and acc['handles'].get(plat):
            return acc['handles'][plat]
    return ''


def cf_handle(explicit: str = '') -> str:
    """CF 用户名 —— 参数 > 环境变量 > me.json（顶层单人键 > 账户里的第一个）"""
    return (explicit or os.environ.get('CF_HANDLE', '').strip()
            or get('cf.handle') or _main_handle('cf'))


def qoj_username(explicit: str = '') -> str:
    return (explicit or os.environ.get('QOJ_USERNAME', '').strip()
            or get('qoj.username') or _main_handle('qoj'))


def qoj_cookie(explicit: str = '') -> str:
    """
    QOJ 的 Cookie 整行。环境变量 `QOJ_COOKIE` 可以临时覆盖。

    顺手兼容两种写法：整行 `a=1; b=2`（推荐）或只给 `__cf_bm`/`uoj_…` 那一段都行 ——
    这里只做去空白与去掉可能多余的 `Cookie:` 前缀。
    """
    raw = (explicit or os.environ.get('QOJ_COOKIE', '').strip() or get('qoj.cookie'))
    raw = raw.strip()
    if raw.lower().startswith('cookie:'):
        raw = raw.split(':', 1)[1].strip()
    return raw.replace('\n', ' ').strip()


def _cookie_line(raw: str) -> str:
    """Cookie 的清洗只有一处：去空白、去掉可能多余的 `Cookie:` 前缀、折成一行"""
    raw = str(raw or '').strip()
    if raw.lower().startswith('cookie:'):
        raw = raw.split(':', 1)[1].strip()
    return raw.replace('\n', ' ').strip()


def hdu_cookie(explicit: str = '') -> str:
    """
    HDU **站点登录**的 Cookie 整行（**可选**）。环境变量 `HDU_COOKIE` 可临时覆盖。

    ⚠️ 多数情况**用不到**：HDU 赛内页（problems/status/rank）的门是**比赛口令**
    （`hdu_contest_login()` 那一对），不是站点登录态。只有个别页面在口令之外还要它。
    """
    return _cookie_line(explicit or os.environ.get('HDU_COOKIE', '').strip() or get('hdu.cookie'))


def hdu_contest_login(explicit_user: str = '', explicit_password: str = '',
                      year: str = '') -> tuple[str, str]:
    """
    HDU **比赛口令**（`POST /contest/login?cid=<CID>` 表单里的 `username` / `password`）。

    **按年一套**（用户 2026-10-17："就年份；实际上 hdu 只需要每年 10 场多校"）：
        "hdu": { "years": { "2026": { "contestUser": "teamA", "contestPassword": "…" },
                            "2025": { … } } }
    顶层那对 `hdu.contestUser / hdu.contestPassword` 是**兜底**（老写法 / 只关心一年的场合）。

    环境变量 `HDU_CONTEST_USER` / `HDU_CONTEST_PASSWORD` 可临时覆盖（**不进仓库**，适合临时跑一次）。
    用户名缺省取 `handles('hdu')` 的第一个（就是 HDU 上那个队名/账号）。

    @param year 这场比赛的年份（从开赛时间取）；给了就先找 `hdu.years.<year>`
    @returns `(username, password)`；没配就是两个空串（调用方**当场停下来说清**，不许硬猜）。
    """
    y = str(year or '').strip()
    yuser = ypwd = ''
    if y:
        yuser = str(get(f'hdu.years.{y}.contestUser') or '').strip()
        ypwd = str(get(f'hdu.years.{y}.contestPassword') or '').strip()
    user = (explicit_user or os.environ.get('HDU_CONTEST_USER', '').strip()
            or yuser or get('hdu.contestUser') or (handles('hdu') or [''])[0])
    pwd = (explicit_password or os.environ.get('HDU_CONTEST_PASSWORD', '').strip()
           or ypwd or get('hdu.contestPassword'))
    return str(user).strip(), str(pwd).strip()


def hdu_year_accounts() -> dict[str, str]:
    """
    `me.json` 里 `hdu.years.<年份>.contestUser` 的**全部** `{年份: 账号}`。

    为什么要有它（用户 2026-10-19 定）：**"这一场是用哪个账号抓的"也算个人信息**，
    它的家只能是 `me.json`（唯一一处个人信息文件，`.gitignore` 里整份排除、清个人数据第 1 级清空）
    —— 不许再在仓库里落一份 `hdu_contest_accounts.json` 那样的 `{cid: 账号}` 痕迹
    （那份文件里有 `TEAM0/teamA` 这类队名/账号，会随仓库一起发出去）。
    HDU 的账号本来就**按年一套**（`hdu_contest_login(year=…)` 读的就是这几个键），
    所以"按 cid 的账号"= **按 cid 查出年份**再取这里 —— 事实只在 `me.json` 一处。
    """
    sec = load_me().get('hdu')
    years = sec.get('years') if isinstance(sec, dict) else None
    if not isinstance(years, dict):
        return {}
    out: dict[str, str] = {}
    for year, box in years.items():
        u = str((box or {}).get('contestUser') or '').strip() if isinstance(box, dict) else ''
        if str(year).strip() and u:
            out[str(year).strip()] = u
    return out


def hdu_year_account(year: str = '') -> str:
    """
    某一年的 HDU 比赛账号：`hdu.years.<year>.contestUser`；**那年没声明就退回顶层**
    `hdu.contestUser`（它的既有含义就是"兜底 / 只关心一年的场合"）；都没有 ⇒ 空串。

    ⚠️ 调用方要**区分**"按年声明"与"顶层兜底"：后者是"我只配了一个账号"，
    拿它给历年场次署名就是 2026-10-17 那个病（"不可能全是 teamA"）—— 见 `hdu_contest_account` 的说明。
    """
    y = str(year or '').strip()
    if y:
        got = hdu_year_accounts().get(y, '')
        if got:
            return got
    return get('hdu.contestUser')


def declared_handle(platform: str, account: str) -> str:
    """
    把**裸账号**换成本人**声明过的写法**（花名册里登记成 `队名/账号` 的那种），没声明过就原样返回。

    唯一用处：已导入的账户线索写的是 `TEAM0/teamA`，而抓取拿到的用户名是 `teamA`
    —— 不换就"同一个人两个值"。⚠️ **不替它编队名**（用户 2026-10-17："不可能全是 TEAM0"）。

    ★ **结果不许取决于花名册顺序**（2026-10-19 实测踩到）：花名册里同时登记了
    `teamA`（裸的）与 `TEAM0/teamA`（带队名的）时，原来"先碰上的那个"说了算 ——
    而 `handles()` 的顺序来自 `accounts[]`/`mappings` 的书写顺序 ⇒ 同一份数据能得出两个线索值
    （一个跟已导入的 `TEAM0/teamA` 对不上，「账户对比」里就成了两个账户）。判据：
    **优先带 `队名/` 的那个**（它信息更多、也是历史数据的写法），没有才用裸账号。
    """
    u = str(account or '').strip()
    if not u:
        return ''
    exact = ''
    for h in (handles(platform) or []):
        h = str(h).strip()
        if not h:
            continue
        if h.endswith('/' + u):
            return h            # 带队名的那份最具体 ⇒ 先用它（与顺序无关）
        if h == u and not exact:
            exact = h
    return exact or u


def hdu_file_handles() -> dict[str, str]:
    """
    `me.json` 的 `hdu.files`：**持久化的"哪份提交文件是谁抓的"绑定** `{文件名: 账号}`。

    为什么放在这里：出包侧（`hdu_adapter`）以前自己 `open(Scaper/me.json)` 读它 ——
    而凭据 2026-10-17 已经搬到 `个人数据/me.json` ⇒ 那条路**永远读不到**（`hdu.files` 静默失效）。
    现在只有这一处读，位置与解析都跟着 `ME_FILE` 走。
    """
    sec = load_me().get('hdu')
    files = sec.get('files') if isinstance(sec, dict) else None
    if not isinstance(files, dict):
        return {}
    return {str(k): str(v).strip() for k, v in files.items() if str(k).strip() and str(v).strip()}


def _pta_from_mappings(namespace: str = '', field: str = '队伍') -> list[tuple[str, str]]:
    """
    账户里声明过的**所有** PTA 值（`field` = 队伍 / 成员 …）—— `[(值, 那条映射的 source)]`。

    为什么要认 mappings：应用「设置 → 🔑 账户/名册」里填的 PTA 队名/成员，落盘就是
    `mappings: [{source: "pta:icpc2026", field: "队伍", value: "TEAM0"}]`
    `mappings: [{source: "pta:icpc2026", field: "成员", value: "某真名"}]`（一人一条）
    （`core/rosterMappings.js` 的 `PLATFORM_CLUES.pta`：赛季是**命名空间**，不是两位年）。
    me.json 顶层的 `pta.teamName` 是老写法 —— 不认 mappings 的话，这些值
    在管线里就认不出来，只能靠提交文件里的 `teamInfo` 兜底
    （那里面的**真名**是最不该由数据文件决定的东西）。
    实测踩到：me.json 里只有 `pta:icpc2026 : 队伍 = TEAM0` 时，`pta_team()` 返回空。

    ⚠️ **全取**（与 cf/qoj/nk/hdu 的 `handles()` 同口径）：几个账户写了几条就给几条，
       一个都不吞 —— "名单"是调用方的事（如提交适配器拿它核对"这份文件是哪支队/哪些人"）。
       往届的也在（`pta:icpc2024/2025/2026` 都可能同时挂着），只是**排序**不同：

           `namespace` = 本场比赛的赛季命名空间（`pta:icpc2026` 的 `icpc2026`）时，
           顺序 = ① 正好这个赛季的 → ② 不带赛季的 `pta` → ③ 别的赛季的；
           每组之内 `current` 指的账户排最前，其余按账户/映射原本的顺序（`sorted` 稳定）。
    """
    want = str(namespace or '').strip()
    cur = str(load_me().get('current') or '').strip()
    rows: list[tuple[int, int, str, str]] = []      # (档, 当前账户?, 值, source)
    for acc in accounts():
        if not acc['active']:                       # 停用的账户不作数（与应用侧一致）
            continue
        # 1 = `current` 指的那个账户（"当前在查看/登录"就是"本季的我"）
        is_cur = 1 if (cur and cur in (acc['id'], acc['name'])) else 0
        for m in acc['mappings']:
            src = str(m.get('source') or '').strip()
            if not (src == 'pta' or src.startswith('pta:')):
                continue
            # 字段要对得上（空 = 没写，按调用方问的那个认）；写别的字段的不当这个用
            if str(m.get('field') or '').strip() not in ('', field):
                continue
            value = str(m.get('value') or '').strip()
            if not value:
                continue
            if src == f'pta:{want}' and want:
                tier = 0                            # 正好本场赛季
            elif src == 'pta':
                tier = 1                            # 不带赛季的写法
            else:
                tier = 2                            # 别的赛季（往届）
            rows.append((tier, is_cur, value, src))
    rows.sort(key=lambda r: (r[0], -r[1]))
    out: list[tuple[str, str]] = []
    for _tier, _cur, value, src in rows:
        if (value, src) not in out:
            out.append((value, src))
    return out


def pta_teams_source(explicit: str = '', namespace: str = '') -> tuple[list[str], str]:
    """
    `(PTA 队名名单, 它是从哪来的)` —— 给适配器打印用。**全取**，不是挑一条。

    优先级（高的那一档有值就用那一档，档内的全部返回）：
        ① 参数 `--team`（逗号分隔算多支）/ 环境变量 `PTA_TEAM` —— 人显式说的；
        ② **账户映射**（`pta:<赛季> : 队伍`，见 `_pta_from_mappings`）；
        ③ `me.json` 顶层的 `pta.teamName`；④ 账户里的 `pta` 字段。
    都没有就返回 `([], '')` —— 让调用方去用兜底（如提交文件里的 `teamInfo.teamName`）。
    """
    one = (explicit or os.environ.get('PTA_TEAM', '').strip())
    if one:
        out: list[str] = []
        for x in str(one).split(','):
            x = x.strip()
            if x and x not in out:
                out.append(x)
        return out, '主脚本/环境变量'
    cands = _pta_from_mappings(namespace, '队伍')
    if cands:
        srcs = sorted({s for _v, s in cands})
        return [v for v, _s in cands], f'me.json 账户映射（{"、".join(srcs)}）'
    top = str(get('pta.teamName') or '').strip()
    if top:
        return [top], 'me.json 的 pta.teamName'
    main = _main_handle('pta')
    return ([main], '账户的 pta 字段') if main else ([], '')


def pta_members_source(namespace: str = '', team: str = '') -> tuple[dict, str, list]:
    """
    PTA 队伍的成员（真名）—— 返回 `({队名: [(真名, 那条映射的 source), …]}, 来源说明, 注意事项)`。

    为什么要它：PTA 数据里唯一带**真名**的地方是提交文件的 `teamInfo.memberNames`
    （别人那支队的三个人叫什么，不该由仓库里的数据文件决定）。谁是你队友，
    由你在账户/名册里声明：

        mappings: [{ "source": "pta:icpc2026", "field": "成员", "value": "TEAM0/某人" }, …]

    ⚠️ **成员必须连队一起写**（值的形状 = `<队名>/<真名>`，与 `hdu_handle` 推荐的组合值同一个
       写法）：只写真名的话，同一赛季**两支队的名单就分不清谁是谁家的** —— 往 `source` 里
       塞队名也救不了（`source` 只到赛季：`pta:icpc2026`）。
       宽容一条：只写真名、且这一赛季只声明了**一支**队时，按那支队算；两支以上就报出来不猜。

    每条都**带 source**（`pta:icpc2026` / 往届 `pta:icpc2025`），调用方好按赛季分开说 ——
    "本季的人"与"往届的人"混在一张名单里，同样看不出归属。

    ⚠️ 名单是**人**，不是账号：它只用于核对/显示，**不进包**
       （crate 里没有"真名"这个字段 —— 队友在包里的身份是他自己的平台账号）。
    """
    notes: list = []
    by_team: dict = {}
    cands = _pta_from_mappings(namespace, '成员')
    if not cands:
        return {}, '', notes
    for value, src in cands:
        if '/' in value:
            team_name, member = value.split('/', 1)
            team_name, member = team_name.strip(), member.strip()
            if not team_name or not member:
                notes.append(f'成员映射「{value}」（{src}）没写成 `<队名>/<真名>`，已跳过')
                continue
        else:
            team_name, member = '', value
        row = by_team.setdefault(team_name, [])
        if member not in [n for n, _s in row]:
            row.append((member, src))
    # 只写真名（没写队）的那些：只有一支队时归它，多支队时报出来（不猜）
    if '' in by_team:
        nameless = by_team.pop('')
        known = [t for t in by_team if t]
        if team and not known:
            by_team.setdefault(team, []).extend(nameless)
            notes.append(f'成员映射里没写队名 ⇒ 按「{team}」算（下次写成 `{team}/<真名>` 更稳）')
        elif len(known) == 1 and not team:
            by_team.setdefault(known[0], []).extend(nameless)
        else:
            notes.append('成员映射里有没写队名的（' + '、'.join(n for n, _s in nameless) + '）——'
                         ' 队名要写在值里（`<队名>/<真名>`），否则两支队的名单分不清')
    srcs = sorted({s for _v, s in cands})
    return by_team, f'me.json 账户映射（{"、".join(srcs)}）', notes


def pta_team_source(explicit: str = '', namespace: str = '') -> tuple[str, str]:
    """`(第一支队名, 来源)` —— 只要一个值的地方用（如 `--show` 的 `pta.teamName` 那行）。"""
    teams, src = pta_teams_source(explicit, namespace)
    return (teams[0], src) if teams else ('', '')


def pta_team(explicit: str = '', namespace: str = '') -> str:
    return pta_team_source(explicit, namespace)[0]


def hdu_handle(explicit: str = '') -> str:
    """
    HDU（杭电）上的用户名 —— 用来给提交打「账户线索」`hdu:<年份> : handle = <这个值>`。

    为什么需要单独一个键：HDU 的 Status 表格里**没有"提交者"列**、榜单也只到队伍级，
    所以"这条提交是谁的"无法从数据里认出来，只能由你声明（`02 hdu/_usage.md` §2.2.2）。
    推荐用**组合值**（如 `示例队/teamA`）：单值会跨届重复，而账户是按三元组全等匹配的。
    """
    return (explicit or os.environ.get('HDU_HANDLE', '').strip()
            or get('hdu.handle') or _main_handle('hdu'))


def nk_handle(explicit: str = '') -> str:
    """
    牛客（Nowcoder）上的用户名 —— 用来给提交打「账户线索」`nk:<赛季> : 用户名 = <这个值>`。

    牛客与 HDU 的差别：**提交记录里自带「用户名」**，所以线索能从数据里取。
    但"数据里有别人的提交"是完全可能的，所以适配器只给
    **用户名与这里相同**的那几条打线索（见 `01 nk/_usage.md`）。
    """
    return (explicit or os.environ.get('NK_HANDLE', '').strip()
            or get('nk.handle') or _main_handle('nk'))


# ================================================================
# 账户（唯一真源：`accounts[]`；`team` 自动当账户读）
# ================================================================

# 每个账户上"不是平台账号"的键（其余键都当成平台名）
_NON_PLATFORM_KEYS = {'id', 'name', 'role', 'nature', 'active', 'children',
                      'mappings', 'byYear', 'note', '_note'}


def _account_of(item: dict) -> dict:
    """把一项整理成账户：`{id, name, nature, active, children, handles:{平台:账号}, byYear, mappings}`"""
    name = str(item.get('name') or '').strip()
    handles: dict = {}
    for key, value in item.items():
        if key in _NON_PLATFORM_KEYS or key.startswith('_'):
            continue
        v = str(value).strip() if isinstance(value, str) else ''
        if v:
            handles[key] = v
    by_year = item.get('byYear') if isinstance(item.get('byYear'), dict) else {}
    return {
        'id': str(item.get('id') or '').strip(),
        'name': name,
        # 花名册的 `role`（member/coach）与应用的 `nature` 都是"给人看的标签" ⇒ 合成一个
        'nature': str(item.get('nature') or item.get('role') or '').strip(),
        'active': item.get('active') is not False,
        'children': [str(c).strip() for c in item.get('children') or [] if str(c).strip()],
        'handles': handles,
        'byYear': {str(p): {str(y): str(v).strip() for y, v in (years or {}).items() if str(v).strip()}
                   for p, years in by_year.items() if isinstance(years, dict)},
        'mappings': [m for m in (item.get('mappings') or []) if isinstance(m, dict)],
    }


def accounts() -> list[dict]:
    """
    **唯一的账户清单**：`me.json` 顶层 `accounts[]`。

    兼容写法（没有 `accounts` 时）：把 `team[]`（+ 顶层单个 handle 当"我"）**当成账户**读 ——
    这样没有 `accounts` 的 me.json 一行不用改就能继续用（`--migrate` 会把它规范化）。
    """
    data = load_me()
    raw = data.get('accounts')
    if not isinstance(raw, list):
        # --- 兼容结构：team[] → accounts ---
        raw = []
        team = data.get('team')
        if isinstance(team, list):
            for item in team:
                if isinstance(item, str) and item.strip():
                    raw.append({'name': item.strip(), 'cf': item.strip()})
                elif isinstance(item, dict):
                    raw.append(dict(item))
        if not raw:
            # 连 team 都没有：顶层单个 handle 当唯一的账户（名字叫"我"）
            single = {p: data.get(p, {}).get('handle') or data.get(p, {}).get('username')
                      for p in PLATFORMS if isinstance(data.get(p), dict)}
            single = {k: v for k, v in single.items() if v}
            if single:
                single['name'] = '我'
                raw.append(single)
    out = [_account_of(item) for item in raw if isinstance(item, dict)]
    return [a for a in out if a['name'] or a['handles']]


#: 赛季**带在 source 里**的平台（裸账号 = 本赛季）。照抄应用侧 `core/rosterMappings.js` 的
#: `PLATFORM_CLUES`（`season: 'year'` 的那些）—— 多校都是有赛季的。
#: ⚠️ 赛季写法是**四位年**（`nk:2026`，见 `scripts/crate.py` 的 `season_of()`）；
#:    下面"裸账号算今年"用的就是四位（`str(tm_year)`），与线索口径一致。
#: ⚠️ PTA 不在里面：它的赛季是**命名空间**（`icpc2026`），从年份推不出来。
SEASONED_PLATFORMS = ('nk', 'hdu')


def by_year(platform: str) -> dict:
    """
    "年份 → 账号"（账户的 `byYear` + 裸账号算本赛季；兼容结构也认）。

    典型用途：牛客多校按年查队名（`nk_multi_fetch.py`）—— 少算了今年就会漏查今年的场次。
    """
    plat = str(platform or '').lower()
    out: dict = {}
    for acc in accounts():
        for year, value in (acc['byYear'].get(plat) or {}).items():
            out.setdefault(year, value)
        # 裸账号 = 本赛季（还没写进 byYear 的"今年那个名字"）
        bare = acc['handles'].get(plat)
        if bare and plat in SEASONED_PLATFORMS:
            import time
            out.setdefault(str(time.localtime().tm_year), bare)
    data = load_me()
    sec = data.get(plat) if isinstance(data.get(plat), dict) else {}
    legacy = sec.get('byYear') if isinstance(sec.get('byYear'), dict) else {}
    for year, value in legacy.items():                     # 兼容写法：顶层 `<平台>.byYear`
        v = str(value).strip()
        if v:
            out.setdefault(str(year), v)
    return out


# ================================================================
# 花名册（**就是 accounts**）
# ================================================================

# 花名册里每个平台可用的键；顺序 = 输出顺序
PLATFORMS = ('cf', 'qoj', 'nk', 'hdu')


def team() -> list[dict]:
    """
    花名册（每个人一项）—— **就是 `accounts()` 的老形状**。

    形状（缺的键就不写）:
        {"name": "我", "role": "member", "cf": "...", "qoj": "...", "nk": "...", "hdu": "..."}

    ⚠️ 保留这个函数是为了**所有调用点一行都不用改**（各平台适配器都在用它）。
    """
    out = []
    for acc in accounts():
        row = {'name': acc['name'], 'role': acc['nature'] or 'member'}
        row.update(acc['handles'])
        out.append(row)
    return out


def handles(platform: str, explicit: str = '') -> list[str]:
    """
    这个平台要抓的**所有账号**（去重、保持顺序）。

    优先级：参数 > 环境变量（`<平台>_HANDLE`，支持逗号分隔） > `me.json` 的
    `<平台>.handles` 列表 > **账户**（`accounts[].<平台>` 与它的 `byYear` 历年值）> 单个 `handle` 键。

    最后那一步就是为了**兼容现状**：账户里没登记时返回 `[单个 handle]`。

    ⚠️ **历年队名也算"要抓的账号"**（队名可以只写在 `byYear` 里，多校就是如此）。
       实测踩到：只看裸 `nk` 时这里返回空 ⇒ 提交**一条账户线索都不打**
       （包里 1832 条 R、线索 0 条）。

    ⚠️ **"不抓谁"只有账户级这一个开关**（用户 2026-10-15 问过"要不要给账号加个是否爬取"）：
       账户级 = `accounts[].active: false`（下面那圈 `if not acc['active']: continue`；
       应用侧同一份语义 —— 设置页「📤 写进 me.json」会给每个账户显式写这一格）。
       **平台级没有**（"这个人 QOJ 不抓、CF 照抓"做不到）：现在的办法只有把
       `<平台>.handles` 列成**白名单**（列了谁就只抓谁）。
       真要加平台级开关，就加在这里这条优先级链上（`<平台>.handles` 旁边），别再开第二条路。
    """
    plat = str(platform or '').lower()
    out: list[str] = []

    def add(v, split: bool = False) -> None:
        """
        `split=True` **只给"一次给多个"的那种输入**（命令行参数 / 环境变量）——
        文件里取到的值一律**当一个整体**。

        ⚠️ 为什么必须分开（实测踩到）：QOJ 队伍账号的显示名是
        `ZJUT7 (Xianliang Lu, Zihang Feng, Haoshuo Shi)`，按逗号拆会得到
        `ZJUT7 (Xianliang Lu` / `Zihang Feng` / `Haoshuo Shi)` 三个**不存在的用户名**
        ⇒ 抓取时白查 3 次、还各报一条"没拿到"。
        要写多个账号请用 `<平台>.handles` **列表**（本来就支持），别靠逗号。

        ⚠️ 2026-10-17 修：**列表要一个个进 `out`，不是整条 `str()` 进去**。原来这里只写了
        `[v]`，于是 `cf.handles: ["a","b"]` 变成**一个**账号 `"['a', 'b']"` ——
        去查这个不存在的账号、真正的 a/b 一条都不抓（**静默缩小范围**）。
        它一直没暴露，是因为应用导出的那份 me.json 把平台账号写在
        `accounts[].cf` / `mappings` 里，**没走过列表这一支**。
        判据：`05 xcpc/selftest.py` 的 `test_handles_accepts_list()`。
        """
        if v is None:
            return
        if isinstance(v, list):                        # 列表：逐个当账号（见上面那条实测）
            for one in v:
                add(one)
            return
        for one in (str(v).split(',') if (split and isinstance(v, str)) else [v]):
            one = str(one).strip()
            if one and one not in out:
                out.append(one)

    env = os.environ.get(f'{plat.upper()}_HANDLES') or os.environ.get(f'{plat.upper()}_HANDLE')
    add(explicit, split=True)
    add(env, split=True)
    sec = load_me().get(plat)
    if isinstance(sec, dict):
        add(sec.get('handles') if isinstance(sec.get('handles'), list) else None)
    for acc in accounts():
        if not acc['active']:                              # 停用的账户不抓（与应用侧一致）
            continue
        add(acc['handles'].get(plat))
        for value in (acc['byYear'].get(plat) or {}).values():
            add(value)                                     # 历年队名（多校）
        # ⚠️ 也认**映射**里写着的（`source` 正好等于平台名，如 `atcoder : handle = someone`）：
        #    应用导出的那份 me.json 里，平台账号就落在这两种地方（字段 / mappings）。
        #    ⚠️ atcoder 只在 `mappings` 里 ⇒ 这里返回空 ⇒ 那一棵树 0 条
        #    ⇒ 合并失败、整条链挂掉。
        for m in acc['mappings']:
            if str(m.get('source') or '').strip() == plat:
                add(m.get('value'))
    if isinstance(sec, dict):
        add(sec.get('handle'))
        legacy = sec.get('byYear') if isinstance(sec.get('byYear'), dict) else {}
        for value in legacy.values():                      # 兼容写法：顶层 `<平台>.byYear`
            add(value)
    return out


def team_rows() -> list[tuple[str, str, str]]:
    """`--team` 的展示数据：[(显示名, 标签, 各平台 handle 拼好的串)]"""
    rows = []
    for acc in accounts():
        parts = [f'{p}={acc["handles"][p]}' for p in PLATFORMS if acc['handles'].get(p)]
        for plat, years in sorted(acc['byYear'].items()):
            for year in sorted(years):
                parts.append(f'{plat}:{year}={years[year]}')
        rows.append((acc['name'] or '（未命名）',
                     acc['nature'] or 'member',
                     '、'.join(parts)))
    return rows


# ================================================================
# 命令行
# ================================================================

def _cmd_show() -> int:
    """
    原样显示当前配置（**不打码**）。

    ⚠️ 这是你自己的终端、你自己的文件；遮起来只是让自己核对时多一步
    （要给别人看结构，就**别把这台机器的 me.json 发出去** —— 文件头那句提醒仍然算数）。
    """
    print(f'📄 {ME_FILE}' + ('' if os.path.isfile(ME_FILE) else '  ⚠️ 文件不存在'))
    rows = [
        # ⚠️ 一律走 getter：账号只在 `accounts[]` 里，直接 `get('cf.handle')` 会是空的
        ('cf.handle', cf_handle()),
        ('cf.apiKey', get('cf.apiKey')),
        ('cf.apiSecret', get('cf.apiSecret')),
        ('qoj.username', qoj_username()),
        ('qoj.cookie', qoj_cookie()),
        ('pta.teamName', pta_team()),
        ('hdu.handle', hdu_handle()),
        ('nk.handle', nk_handle()),
        ('clist.username', get('clist.username')),
        ('clist.apiKey', get('clist.apiKey')),
    ]
    for name, val in rows:
        print(f'   {name:15} {val or "（空）"}')
    k, s = cf_credentials()
    if k and not get('cf.apiKey'):
        print('   ℹ️ CF 密钥来自旧位置 cache/cf_api.json（跑 --migrate 搬进来就能删掉它）')

    # ---- 账户（v2：账户就是花名册，映射也在这份文件里）----
    accs = accounts()
    print(f'   {"accounts":15} {len(accs)} 个' + ('' if accs else '（空 —— 只有顶层单个 handle）'))
    for acc in accs:
        who = acc['name'] or '（未命名）'
        flags = []
        if acc['nature']:
            flags.append(acc['nature'])
        if not acc['active']:
            flags.append('已停用')
        if acc['children']:
            flags.append(f'子账户 {len(acc["children"])}')
        if acc['mappings']:
            flags.append(f'映射 {len(acc["mappings"])} 条')
        plats = '、'.join(f'{p}={v}' for p, v in acc['handles'].items())
        years = '、'.join(f'{p}:{y}={v}' for p, ys in sorted(acc['byYear'].items()) for y, v in sorted(ys.items()))
        print(f'     · {who:<12} {" / ".join(flags)}')
        print(f'       {plats or "（没有平台账号）"}')
        if years:
            print(f'       历年：{years}')
    return 0


#: v2 的 `_note`（结构变了，说明也一起换；旧说明只在你自己的备份里）
V2_NOTE = [
    '这里是**你的**个人信息（爬虫 + 应用共用），全项目只此一处。脚本优先读它，环境变量可临时覆盖。',
    '⚠️ 含密钥与登录态：别放进公开仓库、别整目录发给别人（`python lib/me.py --show` 是原样显示，也不适合贴给别人）。',
    '',
    '★ accounts —— **账户就是花名册**：我是谁 / 我在各平台叫什么 / 历年的队名 / 应用那边的映射，全在这一份里。',
    '  每个人一项：{ name(显示名＝应用里的账户名), nature(自由标签，可选), active(false = 停用), children(子账户，可选),',
    '               cf / qoj / nk / hdu(各平台账号), byYear(带赛季平台的历年账号), mappings(应用那边的映射原文，可选) }。',
    '  · 爬虫按 cf/qoj/nk/hdu 这些键批量取数（`python lib/me.py --team` 看整理结果）；',
    '  · 应用（设置 →「🔑 账户/名册」）读同一份：账户列表＝这里的每一项，映射由这些账号生成；',
    '  · 带赛季的平台（nk/hdu/pta）历年名字写 byYear：{"nk":{"2023":"你的昵称","2025":"你的队名"}}。',
    '',
    '平台凭据仍按平台放在顶层（与 accounts 无关）：',
    '  cf.apiKey / cf.apiSecret —— Codeforces 的 API 密钥（codeforces.com/settings/api 生成；gym 榜单要用）。',
    '  qoj.cookie —— QOJ 登录后的 Cookie 整行（浏览器 F12 → Network → 任一 qoj.ac 请求 → Request Headers 的 Cookie 整行）。',
    '  clist.username / clist.apiKey —— CLIST 难度（鉴权是 `Authorization: ApiKey <用户名>:<key>`，用户名不是可选的）。',
    '  pta / atcoder / hdu.files —— PTA 队名、AtCoder 账号、HDU 提交文件的显式绑定（HDU 的表里没有提交者列）。',
    '  current / viewing —— 应用里的「登录账户 / 在查看」（按 id 或 name 引用；两者不同 ⇒ 应用只读）。',
    '',
    '命令行：--show（原样看）／--team（账户 + 各平台实际会抓的账号）／--check（联网验证）／--migrate（把 v1 结构搬进来，先备份 .bak）。',
]


def _upgrade_to_v2(data: dict) -> list[str]:
    """
    把 v1（`team[]` + 顶层单人 handle）规范化成 v2（**只有 `accounts[]` 一处写账号**）。

    为什么必须"只有一处"（映射与花名册要合并成一个东西）：
    顶层再留一份 `cf.handle`，就会和账户里那份打架 —— 改了这头忘了那头，
    "当前用哪个账号"就说不清了。搬完这里就把顶层那份删掉。
    """
    changed: list[str] = []
    accs = data.get('accounts') if isinstance(data.get('accounts'), list) else None

    if accs is None:
        accs = []
        for item in (data.get('team') if isinstance(data.get('team'), list) else []):
            if isinstance(item, str) and item.strip():
                accs.append({'name': item.strip(), 'cf': item.strip()})
            elif isinstance(item, dict):
                accs.append({k: v for k, v in item.items() if v not in (None, '')})
        singles = {}
        for plat in PLATFORMS:
            sec = data.get(plat)
            if not isinstance(sec, dict):
                continue
            v = sec.get('handle') or sec.get('username') or (sec.get('teamName') if plat == 'pta' else '')
            if v:
                singles[plat] = str(v).strip()
        if singles:
            hit = next((a for a in accs
                        if any(str(a.get(p) or '') == v for p, v in singles.items())), None)
            if hit is None:
                hit = {'name': '我'}
                accs.insert(0, hit)
            for plat, v in singles.items():
                hit.setdefault(plat, v)
            changed.append('顶层单人 handle → 并进账户')
        data['accounts'] = accs

    # 顶层 `<平台>.byYear`（老写法）并进第一个账户
    for plat in PLATFORMS:
        sec = data.get(plat)
        by = sec.get('byYear') if isinstance(sec, dict) else None
        if isinstance(by, dict) and by and accs:
            target = accs[0].setdefault('byYear', {}).setdefault(plat, {})
            for year, value in by.items():
                if str(value).strip() and str(year) not in target:
                    target[str(year)] = str(value).strip()
                    changed.append(f'顶层 {plat}.byYear → 账户的 byYear')
            sec.pop('byYear', None)

    # 顶层那份单人键（handle/username/teamName）：搬进账户后**删掉**。
    # ⚠️ 不只 cf/qoj/nk/hdu —— `pta.teamName` 这种"键名不是平台"的也要收，
    #    否则顶层永远留着第二个真源，正是"必须合并成一个东西"要消掉的东西。
    # ⚠️ 账户里已经有这个平台账号时**以账户为准**（v2 是权威），顶层那份删掉并说明。
    for plat in list(data.keys()):
        sec = data.get(plat)
        if not isinstance(sec, dict):
            continue
        # ⚠️ **凭据节**不折（`cf.apiKey`/`qoj.cookie`/`clist.apiKey`/`hdu.files`…）：
        #    那里的 `username` 是"解锁凭据用的账号"（clist 鉴权要它），不是"某人的平台账号"。
        #    实测踩到过一次：`clist.username` 被当成平台账号塞进账户里了。
        if any(k in sec for k in ('apiKey', 'apiSecret', 'cookie', 'token', 'files')):
            continue
        for key in ('handle', 'username', 'teamName'):
            if key not in sec:
                continue
            val = str(sec.get(key) or '').strip()
            sec.pop(key, None)
            if not val:
                continue
            exact = next((a for a in accs if str(a.get(plat) or '') == val), None)
            if exact is not None:
                changed.append(f'删除顶层 {plat}.{key}（账户「{exact.get("name") or "?"}」里已经有它）')
                continue
            free = next((a for a in accs if not a.get(plat)), None)
            if free is not None:
                free[plat] = val
                changed.append(f'顶层 {plat}.{key} → 并进账户「{free.get("name") or "?"}」')
            else:
                changed.append(f'⚠️ 丢掉顶层 {plat}.{key}（账户里都有各自的账号，这条是旧的重复值）')
        if not sec:
            data.pop(plat, None)
    if 'team' in data:
        data.pop('team', None)
        changed.append('删除 `team`（v2 起就是 `accounts`）')
    if '_team_note' in data:                    # 那段是老 `team` 的说明，v2 的 `_note` 已经涵盖
        data.pop('_team_note', None)
        changed.append('删除 `_team_note`（老 `team` 的说明，v2 的 `_note` 已涵盖）')

    # `role`（member/coach）与应用里的 `nature` 都是"给人看的标签" ⇒ 合成一个
    for acc in accs:
        if isinstance(acc.get('role'), str) and acc['role'].strip() and not acc.get('nature'):
            acc['nature'] = acc['role'].strip()
        if 'role' in acc:
            acc.pop('role', None)
            changed.append('账户项里的 `role` → `nature`（同一个东西，只留一个）')

    if accs and not str(data.get('current') or '').strip():
        data['current'] = str(accs[0].get('name') or '')
        changed.append('补 `current`（当前账户）')

    note = data.get('_note')
    looks_v2 = isinstance(note, list) and any('accounts' in str(x) for x in note)
    if not looks_v2:
        data['_note'] = list(V2_NOTE)
        changed.append('`_note` 换成 v2 说明（旧说明只在你自己的备份里）')
    return changed


def _cmd_migrate() -> int:
    data = load_me()
    changed = []
    if not get('cf.apiKey') and os.path.isfile(LEGACY_CF_CRED):
        try:
            with open(LEGACY_CF_CRED, 'r', encoding='utf-8-sig') as f:
                d = json.load(f)
            if d.get('key') and d.get('secret'):
                data.setdefault('cf', {})['apiKey'] = d['key']
                data.setdefault('cf', {})['apiSecret'] = d['secret']
                changed.append(f'CF 密钥（← {os.path.relpath(LEGACY_CF_CRED, SCAPER)}）')
        except (ValueError, OSError) as e:
            print(f'⚠️ 读不了旧凭据文件：{e}', file=sys.stderr)
    # handle 可能只写在白名单或清单里
    # ⚠️ 判据要问 `cf_handle()`（它会兜到账户里）—— 只看顶层 `cf.handle` 的话，
    #    v2 里那个键已经删了 ⇒ 每次 `--migrate` 都会从白名单**再捞回来**（实测踩到）。
    if not cf_handle():
        for rel, key_path in (('05 xcpc/gym_whitelist.json', ('handle',)),
                              ('05 xcpc/xcpc_contests.json', ('defaults', 'cfHandle'))):
            p = os.path.join(SCAPER, rel)
            if not os.path.isfile(p):
                continue
            try:
                with open(p, 'r', encoding='utf-8-sig') as f:
                    d = json.load(f)
                v = d
                for k in key_path:
                    v = (v or {}).get(k) if isinstance(v, dict) else None
                if v:
                    data.setdefault('cf', {})['handle'] = str(v)
                    changed.append(f'CF handle（← {rel}）')
                    break
            except (ValueError, OSError):
                pass

    # ---- v1 → v2：把花名册 `team` + 顶层单个 handle 合成 `accounts[]` ----
    # 把花名册 `team` 与映射合并成同一个东西（结构大改）。
    changed.extend(_upgrade_to_v2(data))

    if not changed:
        print('ℹ️ 没有可搬的东西（要么已经搬过，要么旧位置也没有）')
        return 0
    if not os.path.isfile(ME_FILE):
        print(f'❌ {ME_FILE} 不存在 —— 先建好这个文件（含 _note），再跑 --migrate', file=sys.stderr)
        return 1
    # ⚠️ **不写备份**（用户 2026-10-06：不要 `me.json.bak` 和它那套逻辑）——
    #    要留底就自己先把整个文件夹复制一份；这里只保证写入是"整份 JSON 一次写"。
    with open(ME_FILE, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'✅ 已搬进 {os.path.basename(ME_FILE)}：')
    for c in changed:
        print(f'   · {c}')
    print('   （值没有打印出来；`--show` 可以原样核对）')
    if any(c.startswith('CF 密钥') for c in changed):
        print(f'   搬完可以删掉旧文件：{os.path.relpath(LEGACY_CF_CRED, SCAPER)}')
    return 0


def _cmd_check() -> int:
    rc = 0
    # CF：发一个**需要登录**的请求（contest.standings 对 gym 必须带凭据）。
    # ⚠️ 调用**与设置页那颗「🔎 探活」同一份实现**（`cf_api.check_credentials()`）——
    #    原来这里自己写了一遍签名调用，两处会各漂一半。
    key, secret = cf_credentials()
    if not key or not secret:
        print('❌ CF 密钥：没有（me.json 的 cf.apiKey/apiSecret）')
        rc = 1
    else:
        sys.path.insert(0, os.path.join(SCAPER, '05 xcpc', 'lib'))
        try:
            from cf_api import check_credentials
            print(check_credentials())
        except Exception as e:  # noqa: BLE001
            print(f'❌ CF 密钥无效或被拒：{str(e)[:120]}')
            rc = 1

    cookie = qoj_cookie()
    if not cookie:
        print('❌ QOJ cookie：没有（me.json 的 qoj.cookie）—— 抓提交时会回落到"手动存页面"')
        rc = 1
    else:
        import urllib.request
        url = 'https://qoj.ac/contest/4113/submissions'
        req = urllib.request.Request(url, headers={
            'User-Agent': 'acm-tree/xcpc', 'Cookie': cookie})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                html = resp.read().decode('utf-8', 'replace')
            if 'table-bordered' in html:
                n = html.count('<tr')
                print(f'✓ QOJ cookie 有效（{url} 返回 {len(html)}B、约 {n} 行）')
            else:
                print(f'❌ QOJ cookie 无效/过期：返回 {len(html)}B，里面没有提交表格（多半是登录页）')
                rc = 1
        except Exception as e:  # noqa: BLE001
            print(f'❌ QOJ 请求失败：{str(e)[:120]}')
            rc = 1
    return rc


def _cmd_team() -> int:
    """
    `--team`：打印**账户/花名册整理结果**（多账号批量取数的入口）。

    它回答"一条命令会抓哪几个人"：每个账户各平台账号 + 各平台实际会用的账号
    （顺序 = 优先级：`<平台>.handles` → `accounts[].<平台>` → 该平台单个 handle）。
    """
    rows = team_rows()
    print(f'📄 {ME_FILE}')
    if not rows:
        print('   ℹ️ 还没有账户（`me.json` 的 `accounts` 是空的）—— '
              '各平台就只抓顶层单个 handle（现状不变）。')
        print('   结构（一个人一项，**这就是应用里的账户**）：')
        print('     "accounts": [')
        print('       { "name": "我", "nature": "本人", "cf": "…", "qoj": "…", '
              '"nk": "…", "hdu": "…",')
        print('         "byYear": { "nk": { "2023": "你的昵称", "2025": "你的队名" } } },')
        print('       { "name": "队友A", "cf": "…", "qoj": "…" }')
        print('     ]')
    else:
        print(f'   账户 {len(rows)} 个：')
        for name, role, parts in rows:
            print(f'     {name:<12} ({role})  {parts or "（没有登记任何平台账号）"}')
    print('\n   各平台**实际会抓**的账号：')
    for plat in PLATFORMS:
        hs = handles(plat)
        print(f'     {plat:<5} {len(hs)} 个：{"、".join(hs) if hs else "（空）"}')
    print('\n   怎么用（一条命令批量取数）：')
    print('     CF   ：`npm run crate:xcpc` 会自动带上账户里所有 CF 账号；'
          '单场调试用 `cf_adapter.py <slug> --handles a,b`')
    print('     QOJ  ：`QOJ_submissions_scraper.py --fetch --submitter a,b`'
          '（抓这几人的全部提交；默认就用账户）')
    print('     nk   ：提交里自带用户名 → 只影响"线索打给谁"（多人一页全带）')
    print('     HDU  ：Status 页没有提交者列 → 得**逐人筛页面各抓一份**，见 02 hdu/_usage.md')
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description='个人信息文件 me.json')
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--show', action='store_true', help='显示当前配置（原样，含凭据）')
    g.add_argument('--team', action='store_true',
                   help='花名册（多人/多队）：列出每人登记的平台账号 + 各平台实际会抓的账号')
    g.add_argument('--check', action='store_true', help='联网验证 CF 密钥与 QOJ cookie')
    g.add_argument('--migrate', action='store_true', help='把旧位置的值搬进 me.json（不打印值）')
    args = ap.parse_args(argv)

    if args.migrate:
        return _cmd_migrate()
    if args.check:
        return _cmd_check()
    if args.team:
        return _cmd_team()
    return _cmd_show()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))



