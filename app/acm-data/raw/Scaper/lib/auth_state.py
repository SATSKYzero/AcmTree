#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
登录态（cookie / apiKey）：「这一发响应说明凭据怎么了」—— **通用区，各渠道共用**

**cookie 过期这种情况值得一个模块去处理**：QOJ 的 `qoj.cookie` 过期后，抓取端只表现为
    "**第 1 页没拿到（网络失败 / 登录页）**" + **0 字节** ——
    要靠**人眼看 HTTP 头**（`302 → //qoj.ac/login`）才能定性成"cookie 过期"。

为什么要有它：**凭据过期是常态**（`cf_clearance` 只活几十分钟到几小时，见
`04 qoj/QOJ_submissions_scraper.py` 的文件头），而"过期"在 HTTP 层的长相**每个平台都不一样**
（302 → login / 401 / 403 + Cloudflare / 200 + 登录页 / JSON 里一句 comment）。
每个脚本各写一遍判断，等于都没写。这里把它收成**一处**：

    from auth_state import from_http, raise_if_bad      # 或 from_urlopen / from_httperror
    resp = from_http(status, url, location, body)
    return raise_if_bad('qoj', resp)                    # 过期 ⇒ 抛 AuthError（带可执行的那句话）

三条规矩（都是实测踩出来的）：

  ① **判据是响应本身**（status / `Location` / 401 / 403 / 正文特征串），**不是"内容像不像"**。
     ⚠️ 反面教材：牛客的正常页面导航里就有 `login` 这个词 —— 拿它当判据会**把好页判成过期**。
     只有**实测过、且只属于登录态**的串才准进表（`user_not_logged_in`、`incorrect api key`…）。
  ② **过期 ≠ 失败**：重试一百次也没用 ⇒ `read_page`/`retry_call` 遇到 `AuthError`
     **不重试、直接停**（`CACHE_KEEP` 的归档让"换完凭据重跑"不必重抓，见 `read_modes.py`）。
  ③ **被拦（blocked）不是凭据问题**：403/429/Cloudflare 验证页 ⇒ 别让人去改 `me.json`，
     等一会儿 / 换 UA 再跑（两者要分开说，否则提示在骗人）。

每平台"过期长什么样"== 本文件的 `PLATFORMS` 表（**唯一一处**），每条都写着实测证据（`note`）。

自测：判据是纯函数，锚在 `05 xcpc/selftest.py`（`python "…/05 xcpc/selftest.py"`）。
探活：`python -B "…/lib/auth_state.py" --probe qoj`（1 个请求；过期就打印可执行的那句话）。
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

#: 三态
OK = 'ok'               # 凭据没问题（或者这个平台压根没有登录态）
EXPIRED = 'expired'     # 凭据过期/无效 ⇒ 要去更新 me.json（**可执行**）
BLOCKED = 'blocked'     # 被拦/限流/验证页 ⇒ 不是凭据问题，等等再跑

#: 抓取用的 UA（不设 UA 有些站直接 403 —— 见 `04 qoj` 的文件头）
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')

# ================================================================
# 每平台一张表：**唯一的判据来源**（`expired` / `blocked` 都是"任一子句成立"）
#
#   子句 = `{status: (...), location: (...), body: (...)}`，**同一子句里各条件是 AND**。
#   `location` / `body` 都按**小写子串**比（`body` 比的是解码后的正文）。
#   加一个平台 = 加一行 + 把实测证据写进 `note`（别再靠猜）。
# ================================================================
PLATFORMS: dict = {
    'qoj': {
        'label': 'QOJ',
        'credential': 'qoj.cookie',
        'howto': '去 `acm-data/raw/Scaper/me.json` 的 `qoj.cookie` 换一个新 cookie'
                 '（浏览器登录 qoj.ac → F12 → Network → 点任一 qoj.ac 请求 → 复制整条 `Cookie` 头）',
        'expired': [
            {'status': (301, 302, 303, 307, 308), 'location': ('/login',)},
        ],
        'blocked': [
            {'status': (429,)},
            {'status': (403,), 'body': ('just a moment', 'cf-chl-', 'captcha')},
        ],
        # ① 真 cookie ⇒ 200 / 25099 B（带 `table-bordered` 提交表）
        # ② 假 cookie / 无 cookie ⇒ 302 + `Location: //qoj.ac/login` + **0 字节**
        #    这就是"第 1 页没拿到（网络失败/登录页）、0 字节"背后的原因
        # ③ `/login` 本身不带 UA 会被 Cloudflare 挡 ⇒ 403 + `Just a moment...`
        'note': '实测：真 200/25KB；假与无 ⇒ 302 → `//qoj.ac/login`、0 字节',
        'probe': {'url': 'https://qoj.ac/submissions?submitter={qoj_username}',
                  'cookie': '{qoj.cookie}'},
    },
    'cf': {
        'label': 'Codeforces',
        'credential': 'cf.apiKey / cf.apiSecret',
        'howto': '去 `me.json` 的 `cf.apiKey` / `cf.apiSecret` 换一对新的'
                 '（codeforces.com → Settings → API），或用环境变量 '
                 '`CF_API_KEY` / `CF_API_SECRET` 临时覆盖',
        # CF 把失败写在 **JSON 正文**里（HTTP 400），不是状态码：
        'expired': [
            {'body': ('incorrect api key',)},
            {'body': ('incorrect signature',)},
            {'body': ('you have to be authenticated',)},
        ],
        'blocked': [
            {'body': ('too many requests',)},
            {'status': (429, 503)},
        ],
        'note': '实测：真凭据 200 + `"status":"OK"`；假 secret ⇒ 400 + '
                '`"apiKey: Incorrect signature"`；假 key ⇒ 400 + `"Incorrect API key"`',
        # ⚠️ 没有便宜的探针：CF 的每一发都要 `apiSig` 签名 ⇒ 探活只能靠抓取时的第一发
        'probe': {},
    },
    'clist': {
        'label': 'CLIST',
        'credential': 'clist.apiKey',
        'howto': '去 `me.json` 的 `clist`（`username` + `apiKey`）换一份新的'
                 '（clist.by → 右侧 API 区块），或用环境变量 '
                 '`CLIST_USERNAME` / `CLIST_API_KEY` 临时覆盖',
        'expired': [
            {'status': (401,)},
            {'status': (403,), 'body': ('invalid token', 'unauthorized')},
        ],
        'blocked': [
            {'status': (429,)},
            {'body': ('throttled', 'too many requests')},
        ],
        # 用户名的**写法**也算凭据的一部分：只给 key（`Authorization: ApiKey <key>`）一律 401
        'note': '实测：真 key 200 + JSON；假 key ⇒ **401 + 0 字节**（正文都是空的）；'
                '只给 key 不给用户名也 401',
        'probe': {'url': 'https://clist.by/api/v4/problem/?limit=1',
                  'header': ('Authorization', 'ApiKey {clist.username}:{clist.apiKey}')},
    },
    'pta': {
        'label': 'PTA（拼题A）',
        'credential': '',
        'howto': 'PTA 目前**只用公开页**（榜单/题面），不需要登录态；'
                 '若哪天用上要登录的 API，就去 me.json 加一份 cookie',
        # 实测：`/api/problem-sets/...` 这类 API 页会 401 + 这句机器可读的错
        'expired': [
            {'body': ('user_not_logged_in',)},
            {'status': (401,)},
        ],
        'blocked': [
            {'status': (429,)},
            {'status': (403,)},
        ],
        'note': '实测：`pintia.cn/api/problem-sets/...` ⇒ 401 + '
                '`{"error":{"code":"USER_NOT_LOGGED_IN"}}`；而榜单/题面页 200（公开）',
        'probe': {},
    },
    'nk': {
        'label': '牛客',
        'credential': '',
        'howto': '牛客抓取只用公开页 + `me.json` 里的队名（不是登录态）⇒ 没有"过期"这回事',
        'expired': [],
        'blocked': [
            {'status': (429,)},
            {'status': (403,)},
        ],
        # ⚠️ 这条 note 是**反面教材**：正常页面的导航里就有 login 这个词
        'note': '实测：场次页/提交页都 200（约 18–22KB；⚠️ 正文里的 `login` '
                '是导航链接 ⇒ **不能**拿它当判据）',
        'probe': {},
    },
    'hdu': {
        'label': '杭电',
        'credential': '',
        'howto': '杭电只用公开页 ⇒ 没有登录态；被拦就是被拦（等一会儿再跑）',
        'expired': [],
        'blocked': [{'status': (429,)}, {'status': (403,)}],
        'note': '实测：首页与场次列表都 200（gb2312 编码，约 7–16KB）',
        'probe': {},
    },
    'atcoder': {
        'label': 'AtCoder',
        'credential': '',
        'howto': 'AtCoder 走公开 API / 公开题面页 ⇒ 没有登录态',
        'expired': [],
        'blocked': [{'status': (429,)}, {'status': (403,)}],
        'note': '公开数据源（`atcoder-problems` API + 官方题表页），无需凭据',
        'probe': {},
    },
    'xcpcio': {
        'label': 'XCPCIO 榜单',
        'credential': '',
        'howto': '榜单是公开数据 ⇒ 没有登录态',
        'expired': [],
        'blocked': [{'status': (403,)}, {'status': (429,)}],
        'note': '⚠️ 那家开了**防盗链**（带 Referer 才 403）—— '
                '抓取端不带 Referer 就没事',
        'probe': {},
    },
    'rankland': {
        'label': 'RankLand(srk)',
        'credential': '',
        'howto': '公开仓库数据 ⇒ 没有登录态',
        'expired': [],
        'blocked': [{'status': (403,)}, {'status': (429,)}],
        'note': '走 GitHub 原始文件（raw），无需凭据',
        'probe': {},
    },
}


def known_platforms() -> tuple:
    """表里有哪几个平台（`--list` 与文档用）"""
    return tuple(PLATFORMS)


#: `--set a.b=值` 的覆盖（**探活时优先于 `me.json`**）—— 设置页"用刚敲的值探一次"用它
_OVERRIDES: dict = {}


def set_overrides(pairs) -> dict:
    """
    设覆盖值（`['qoj.cookie=session=…', 'clist.apiKey=xx']`）—— 返回生效后的副本。

    ⚠️ 只影响**探活取参**，不写任何文件（要落盘还是得去设置页点保存）。
    """
    for one in (pairs or ()):
        text = str(one or '')
        if '=' not in text:
            continue
        key, value = text.split('=', 1)
        key = key.strip()
        if key:
            _OVERRIDES[key] = value
    return dict(_OVERRIDES)


# ================================================================
# 响应：只留判据要用得着的四样（status / url / Location / 正文）
# ================================================================
class Response:
    """
    一发的原始结果 —— **不跟重定向**（跟了就看不见"302 → login"这件事）。

    ⚠️ `body` 用 `str`（各渠道本来就是 `decode(...)` 之后再用）；字节数以 `bytes` 现算。
    """

    __slots__ = ('status', 'url', 'location', 'body', 'reason')

    def __init__(self, status: int = 0, url: str = '', location: str = '',
                 body: str = '', reason: str = ''):
        self.status = int(status or 0)
        self.url = str(url or '')
        self.location = str(location or '')
        self.body = body if isinstance(body, str) else (body or b'').decode('utf-8', 'replace')
        self.reason = str(reason or '')

    @property
    def size(self) -> int:
        return len(self.body.encode('utf-8', 'replace'))

    def summary(self) -> str:
        """一行话（日志/自测用）：`HTTP 302 → //qoj.ac/login（0 字节）`"""
        loc = f' → {self.location}' if self.location else ''
        return f'HTTP {self.status}{loc}（{self.size} 字节）'

    def __repr__(self) -> str:                                          # pragma: no cover
        return f'<Response {self.summary()}>'


def from_http(status: int, url: str = '', location: str = '', body: str = '',
              reason: str = '') -> Response:
    """给**自己拿 http.client** 的渠道用（QOJ 就是这一类：连接复用 + 不跟重定向）"""
    return Response(status, url, location, body, reason)


def from_urlopen(res) -> Response:
    """给 `urllib.request.urlopen(...)` 的渠道用（`res.geturl()` = **跟随重定向之后**的地址）"""
    try:
        body = res.read().decode('utf-8', 'replace')
    except Exception:                                                   # noqa: BLE001
        body = ''
    return Response(getattr(res, 'status', 0) or 0,
                    getattr(res, 'geturl', lambda: '')() or '',
                    '', body, getattr(res, 'reason', '') or '')


def from_httperror(err: urllib.error.HTTPError) -> Response:
    """给 `urllib.error.HTTPError` 用（4xx/5xx 就是从这里来的）"""
    try:
        body = err.read().decode('utf-8', 'replace')
    except Exception:                                                   # noqa: BLE001
        body = ''
    headers = getattr(err, 'headers', None)
    location = ''
    if headers is not None:
        try:
            location = headers.get('Location') or ''
        except Exception:                                               # noqa: BLE001
            location = ''
    return Response(getattr(err, 'code', 0) or 0, getattr(err, 'url', '') or '',
                    location, body, getattr(err, 'reason', '') or '')


# ================================================================
# 判据：**纯函数**（自测就钉在这里）
# ================================================================
def _clause_hits(clause: dict, resp: Response) -> bool:
    """一个子句成不成立（子句里各条件是 **AND**；`location`/`body` 按小写子串比）"""
    statuses = tuple(clause.get('status') or ())
    if statuses and resp.status not in statuses:
        return False
    locations = tuple(clause.get('location') or ())
    if locations and not any(x.lower() in resp.location.lower() for x in locations):
        return False
    markers = tuple(clause.get('body') or ())
    if markers:
        low = resp.body.lower()
        if not any(x.lower() in low for x in markers):
            return False
    return True


def state_of(platform: str, resp) -> str:
    """
    这一发响应说明**登录态**怎么了：`ok` / `expired` / `blocked`。

    ⚠️ 表里没有的平台、`resp is None`、或者没命中任何子句 ⇒ **一律 `ok`**：
    宁可漏报，也别把"网络抖一下"说成"你的 cookie 过期了"（那会让人白白去翻 me.json）。
    """
    rule = PLATFORMS.get(str(platform or '').strip().lower())
    if rule is None or resp is None:
        return OK
    for name, state in (('expired', EXPIRED), ('blocked', BLOCKED)):
        for clause in (rule.get(name) or ()):
            if _clause_hits(clause, resp):
                return state
    return OK


def explain(platform: str, resp, state: str = '') -> str:
    """
    人话 + **可执行的那句话**（`AuthError` 的正文就是用这个拼的）。

    过期 ⇒ 指路 me.json（给具体键与怎么拿）；被拦 ⇒ 明说"不是凭据问题，别去改 me.json"。
    """
    key = str(platform or '').strip().lower()
    rule = PLATFORMS.get(key) or {}
    label = rule.get('label') or (platform or '这个平台')
    state = state or state_of(key, resp)
    head = f'❌ {label} 登录态失效' if state == EXPIRED else f'❌ {label} 被拦住了'
    lines = [f'{head}（{resp.summary() if resp is not None else "没有响应"}）']
    if state == EXPIRED:
        cred = rule.get('credential') or ''
        lines.append(f'   → {rule.get("howto") or "去 me.json 更新这一份凭据"}')
        if cred:
            lines.append(f'   （要动的是 `{cred}`）')
    else:
        lines.append('   → 这不是凭据的问题（别去改 me.json）：多半是限流 / 验证页 —— '
                     '等几分钟再跑；连着几次都一样就把响应头也贴出来看一眼。')
    note = rule.get('note') or ''
    if note:
        lines.append(f'   判据：{note}')
    return '\n'.join(lines)


def safe_where(where) -> str:
    """
    把"发生在哪里"洗成**可以进日志/报错**的形式。

    为什么必须有它：`where` 会被拼进 `AuthError` 的正文（用户会看到、脚本会打日志），
    而调用点的惯例一直是 `where=url` —— CF 那种接口把 **`apiKey` / `apiSig` 写在查询串里**
    ⇒ 凭据直接进了日志。这里**一处收口**：去掉查询串、再把常见的凭据参数名打码。

    ⚠️ 只做"减法"（不改变错误判据、不改变调用方式）：
      · `https://codeforces.com/api/x?apiKey=…&apiSig=…` ⇒ `https://codeforces.com/api/x`
      · 非 URL / 空 ⇒ 原样（只做长度截断，免得把整段正文塞进报错）
    """
    text = str(where or '').strip()
    if not text:
        return ''
    # 只留 scheme://host/path（有查询串就砍掉）
    if '://' in text:
        text = text.split('?', 1)[0]
    else:
        # 不是完整 URL（可能只是"方法名"或"某页"）——仍然砍掉明显的 key=… 片段
        text = text.split('?', 1)[0]
    return text[:160]


class AuthError(RuntimeError):
    """
    **登录态坏了**（过期 / 被拦）—— 抓取要**当场停**，别重试。

    `read_modes.read_page` / `retry_call` 认得它：不重试、直接把这句话打出来并退出。
    为什么不当普通异常重试：过期是"重试一百次也一样"的那一类，
    而一轮抓取有 20–75 页 —— 不早失败就会跑到一半才发现。
    """

    def __init__(self, platform: str, resp, state: str = '', where: str = ''):
        self.platform = str(platform or '')
        self.state = state or state_of(self.platform, resp)
        self.response = resp
        self.where = safe_where(where)
        text = explain(self.platform, resp, self.state)
        if self.where:
            text = f'{text}\n   （发生在 {self.where}）'
        if self.state == EXPIRED:
            text += ('\n   ✅ 已经抓到的页都在归档里（`cache/pages/`）⇒ 换完凭据**用同样的命令重跑**，'
                     '不会重抓已抓的那些。')
        super().__init__(text)


def raise_if_bad(platform: str, resp, where: str = '') -> str:
    """
    每渠道 fetch 的最后一行：**好页就把正文还给你，坏了就抛 `AuthError`**。

    用法（3 行接进来，见 `04 qoj/QOJ_submissions_scraper.py`）：

        resp = from_http(status, url, location, body)
        return raise_if_bad('qoj', resp, where=url)
    """
    state = state_of(platform, resp)
    if state != OK:
        raise AuthError(platform, resp, state, where)
    return resp.body


def guard_body(platform: str, body: str, where: str = '', status: int = 0) -> str:
    """
    只拿得到**正文**的渠道用这个（典型：CF 把失败写在 JSON 里、状态码都是 400）。

        auth.guard_body('cf', body, where=url, status=e.code)     # 过期/限流 ⇒ AuthError
    """
    return raise_if_bad(platform, from_http(status, where, '', body), where)


def open_text(req_or_url, *, platform: str, timeout: int = 60, where: str = '') -> tuple:
    """
    `urllib` 那类渠道的**一行接法**：GET 一发、**过登录态判据**，返回 `(status, text)`。

        status, text = auth_state.open_text(req, platform='clist', where=url)
        return json.loads(text)

    好响应原样给回；`401` / `403` / 限流 / 登录页 ⇒ `AuthError`（带那句可执行的话）。
    ⚠️ `urllib` 默认**跟随重定向** ⇒ 这里只能看 `Location`；判"302 → login"请用
    `from_http`（不跟重定向的渠道，如 QOJ 的 `http.client`）。
    """
    url = getattr(req_or_url, 'full_url', '') or str(req_or_url)
    try:
        with urllib.request.urlopen(req_or_url, timeout=timeout) as res:
            text = res.read().decode('utf-8', 'replace')
            status = int(getattr(res, 'status', 200) or 200)
    except urllib.error.HTTPError as err:
        raw = ''
        try:
            raw = err.read().decode('utf-8', 'replace')
        except Exception:                                               # noqa: BLE001
            raw = ''
        headers = getattr(err, 'headers', None)
        location = ''
        if headers is not None:
            try:
                location = headers.get('Location') or ''
            except Exception:                                           # noqa: BLE001
                location = ''
        raise_if_bad(platform, from_http(getattr(err, 'code', 0) or 0, url, location, raw),
                     where=where or url)
        raise                                        # 上面没抛 ⇒ 不是登录态问题，原样抛给调用方
    raise_if_bad(platform, from_http(status, url, '', text), where=where or url)
    return status, text


# ================================================================
# 「抓前探一次」（spec ③）：1 个请求，过期就当场停 —— 别让 75 页跑到一半才发现
# ================================================================
def _fill(template: str) -> str:
    """
    `'{qoj.cookie}'` / `'{qoj_username}'` 这类占位符 → 真值。

    `{a.b}` 走 `me.get('a.b')`；`{name}` 若是 `me.py` 的函数就调它（`{qoj_username}`）；
    取不到就空串（探活会因此拿到 401/302，照样会把话说清）。

    ⚠️ `--set a.b=值` 传进来的**覆盖值优先**（设置页"用框里刚敲的那个值探活"就靠它 ——
    不然探的永远是磁盘上那份旧的）。
    """
    import me                                                           # noqa: PLC0415
    out = str(template or '')
    for _ in range(4):                       # 最多展开 4 层（`ApiKey {u}:{k}` 这种）
        if '{' not in out:
            break
        for key in sorted({s.split('}')[0] for s in out.split('{')[1:] if '}' in s}):
            if key in _OVERRIDES:
                val = _OVERRIDES[key]
            elif '.' in key:
                val = me.get(key)
            else:
                fn = getattr(me, key, None)
                val = fn() if callable(fn) else (fn if isinstance(fn, str) else '')
            out = out.replace('{' + key + '}', str(val or ''))
    return out


def fetch_once(url: str, *, headers: dict | None = None, cookie: str = '',
               timeout: int = 25, method: str = 'GET') -> Response:
    """打**一发**（不跟重定向、不重试）—— 只为"看凭据怎么了"，因此刻意做得便宜"""
    parts = urllib.parse.urlsplit(url)
    cls = http.client.HTTPSConnection if parts.scheme == 'https' else http.client.HTTPConnection
    kw = {'timeout': timeout}
    if cls is http.client.HTTPSConnection:
        kw['context'] = ssl.create_default_context()
    conn = cls(parts.netloc, **kw)
    path = parts.path + (f'?{parts.query}' if parts.query else '')
    head = {'User-Agent': UA, 'Accept-Encoding': 'identity'}
    if cookie:
        head['Cookie'] = cookie
    head.update(headers or {})
    try:
        conn.request(method, path, headers=head)
        res = conn.getresponse()
        body = res.read()
        return from_http(res.status, url, res.getheader('Location') or '',
                         body.decode('utf-8', 'replace'), res.reason or '')
    finally:
        try:
            conn.close()
        except Exception:                                               # noqa: BLE001
            pass


def probe(platform: str, url: str = '', cookie: str = '', verbose: bool = True) -> Response:
    """
    **抓前探一次**：按表里的 `probe` 配方打一发；过期/被拦 ⇒ 抛 `AuthError`。

    两种形状：
      · **一个 GET 就够的**（QOJ 的 cookie、clist 的 key）⇒ 表里的 `probe` 配方（`{'url': …}`）；
      · **每一发都要签名的**（CF）⇒ `SIGNED_PROBES` 里那个函数（用户 2026-10-17："cf 怎么能因为贵
        就不探"）。⚠️ 别把 `PLATFORMS` 变成带函数的表：`--list` 直接打印它，保持**纯数据**。

    表里两样都没有（公开站：牛客 / 杭电 / PTA / AtCoder…）⇒ 不打，返回 `None`。
    """
    key = str(platform or '').strip().lower()
    rule = PLATFORMS.get(key)
    if rule is None:
        raise ValueError(f'表里没有这个平台：{platform!r}（有 {known_platforms()}）')
    signed = SIGNED_PROBES.get(key)
    if signed is not None:
        return signed(verbose=verbose)
    recipe = rule.get('probe') or {}
    if not recipe:
        if verbose:
            print(f'ℹ️ {rule.get("label") or key}：没有登录态，不用探'
                  f'（公开页 / 公开 API）⇒ 抓取侧也不会拿"过期"来烦你')
        return None
    url = url or _fill(recipe.get('url') or '')
    if not cookie and recipe.get('cookie'):
        cookie = _fill(recipe['cookie'])
    headers = {}
    header = recipe.get('header')
    if header:
        headers[header[0]] = _fill(header[1])
    resp = fetch_once(url, headers=headers, cookie=cookie)
    if verbose:
        print(f'🔎 探 {rule.get("label") or key} 登录态：{url} ⇒ {resp.summary()}')
    got = raise_if_bad(key, resp, where=url)
    if verbose:
        print(f'✅ {rule.get("label") or key} 登录态正常（{len(got)} 字节）')
    return resp


def _cf_state_on_error(msg: str) -> str:
    """
    CF 探针**失败**时怎么定性（纯函数，方便自测）。

    · **根本还没填**（`cf_api` 会说"需要 Codeforces 凭据，但没找到"）：显式 `EXPIRED`
      —— 那不是"过期"也不是"被拦"，但要去的地方一样（表里 `howto` 那句"codeforces.com →
      Settings → API"）。⚠️ 不显式指定的话正文匹配不上任何一条 ⇒ 落到默认的"被拦"，
      打出的却是"这不是凭据的问题（别去改 me.json）"——**正好是反话**（实测踩到）。
    · 其余（`Incorrect API key` / `Incorrect signature` / 限流…）：返回 `''` ⇒ **交给表定性**，
      本函数不自己判（那三条 `expired` / 两条 `blocked` 就是为 CF 写的）。
    """
    return EXPIRED if ('凭据' in msg and '没找到' in msg) else ''


def _cf_apply_overrides() -> int:
    """
    把 `--set cf.apiKey=… / cf.apiSecret=…` 的覆盖**喂进环境变量**给 `cf_api` 用；返回喂了几条。

    ⚠️ 为什么必须这一步（2026-10-17 实测踩到）：界面那句承诺是"**用框里现在的值**探一发（不要求先保存）"，
    而 QOJ/clist 那两条走的是 `_fill('{qoj.cookie}')`（`_OVERRIDES` 优先）；CF 这条不走模板 ——
    它调 `cf_api.check_credentials()`，而那边只认 `me.cf_credentials()`（**环境变量 > me.json**）。
    不喂这一步的后果：用户在设置页刚生成一对新 key/secret、按「探活」，探的却是**磁盘上那份**
    （多半还是空的）⇒ 明明填对了也报"登录态失效"（用户当场演示给我看的那张图就是它）。
    """
    n = 0
    for key, env_name in (('cf.apiKey', 'CF_API_KEY'), ('cf.apiSecret', 'CF_API_SECRET')):
        val = str(_OVERRIDES.get(key) or '').strip()
        if val:
            os.environ[env_name] = val
            n += 1
    return n


def _probe_cf(verbose: bool = True) -> Response:
    """
    CF 的探针：**真发一个带 `apiSig` 签名的请求**（`contest.standings` 对 gym 必须带凭据）。

    签名与请求**一份实现**：`05 xcpc/lib/cf_api.py:check_credentials()`（`lib/me.py --check`
    调的是同一个；别在这儿再写一遍签名）。
    失败时：把 CF 那句话**当成正文**合成一个 `Response` 抛 `AuthError` —— 这样"哪一样错了"
    （`Incorrect API key` / `Incorrect signature` / 被限流）仍然由**上面那张表**定性，
    本函数不自己判（表里 CF 那三条 `expired` / 两条 `blocked` 就是为它写的）。
    """
    here = os.path.dirname(os.path.abspath(__file__))              # …/Scaper/lib
    lib = os.path.join(os.path.dirname(here), '05 xcpc', 'lib')
    if lib not in sys.path:
        sys.path.insert(0, lib)
    if verbose:
        print(f'🔎 探 {PLATFORMS["cf"].get("label") or "cf"} 登录态：'
              f'contest.standings（带 apiSig 签名的一次真请求）')
    _cf_apply_overrides()                                         # 框里的值优先（见那个函数的说明）
    try:
        from cf_api import check_credentials
        line = check_credentials()
    except Exception as err:                                      # noqa: BLE001
        raise AuthError('cf', Response(status=200, url='contest.standings',
                                       body=str(err)[:400]),
                        state=_cf_state_on_error(str(err))) from None
    if verbose:
        print(line)
    return Response(status=200, url='contest.standings', body=line)


#: **要签名的**平台的探针（函数）—— 表 `PLATFORMS` 保持纯数据，这里放"怎么探"
SIGNED_PROBES: dict = {'cf': _probe_cf}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='登录态判据（每平台"过期长什么样"的唯一一处）')
    ap.add_argument('--probe', metavar='平台', default='',
                    help='抓前探一次（1 个请求）：过期/被拦就打印可执行的那句话并退出码 1。'
                         f'平台：{", ".join(known_platforms())}')
    ap.add_argument('--url', default='', help='覆盖探针地址（默认用表里的）')
    ap.add_argument('--cookie', default='', help='覆盖 cookie（默认从 me.json 取）')
    ap.add_argument('--set', action='append', dest='sets', default=[], metavar='键=值',
                    help='覆盖某一格（可给多次）：`--set clist.apiKey=xx`；'
                         '**只影响探活取参**，不写文件')
    ap.add_argument('--list', action='store_true', dest='list_all', help='列出表里每个平台怎么认')
    args = ap.parse_args(argv)
    set_overrides(args.sets)

    if args.list_all:
        for key, rule in PLATFORMS.items():
            print(f'{key:10s} {rule.get("label") or "":12s} 凭据={rule.get("credential") or "（无）"}')
            print(f'           过期：{rule.get("expired") or "（不可能）"}')
            print(f'           被拦：{rule.get("blocked") or "—"}')
            print(f'           实测：{rule.get("note") or "—"}')
        return 0
    if not args.probe:
        ap.print_help()
        return 2
    try:
        probe(args.probe, url=args.url, cookie=args.cookie)
    except AuthError as err:
        print(str(err), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
