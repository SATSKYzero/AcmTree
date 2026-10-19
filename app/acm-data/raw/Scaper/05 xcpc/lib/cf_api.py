#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
Codeforces 公开 API 客户端（含**需要登录态**的方法）

为什么要有它：CF 的方法分两档 ——
  * 公开（不用登录）：`contest.status`（某场比赛里某个 handle 的提交，**gym 也行**）、
    `contest.list`、`user.status`；
  * **需要认证**：`contest.standings`（gym 榜单）。而"题目清单 + 通过率"只能从榜单拿，
    所以想给"rankland 没收录的 gym"补齐 C/P 与 ratio，就必须带凭据请求。

凭据从哪来
----------
**唯一来源是 `acm-data/raw/Scaper/me.json`**（`lib/me.py` 负责读）：
环境变量 `CF_API_KEY` / `CF_API_SECRET` > `me.json` 的 `cf.apiKey/apiSecret`
> 旧的 `05 xcpc/cache/cf_api.json`（仅向后兼容）。
从 https://codeforces.com/settings/api 生成；**等同于账号权限，别外传**。

签名规则（CF 官方）
------------------
    apiSig = <6 位随机前缀> + sha512_hex(
                 <前缀> + "/" + <方法名> + "?" + <参数按名字排序后 key=value&…> + "#" + <secret>)
请求时把 `apiKey` / `time` 一起放进查询串（**签名里也要包含它们**）。

只依赖标准库。
"""

from __future__ import annotations

import hashlib
import json
import os
import random
import string
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.dirname(HERE)
CRED_FILE = os.path.join(SPEC, 'cache', 'cf_api.json')
def _find_scaper_lib() -> str:
    """
    向上找 `Scaper/lib/me.py`（**不手推 `..` 级数** —— 手推错过两次）。

    本文件在 `<Scaper>/05 xcpc/lib/`，而 `me.py` 在 `<Scaper>/lib/`：
    手写相对路径时少一级就指向了一个**根本不存在的目录**，
    `from me import …` 变成静默 `ImportError` → `load_credentials()` 永远返回空
    → **所有需要凭据的 CF gym 榜单都被拒**（实测 12 场里只有 1 场靠旧缓存成功）。
    向上找一步到位，目录结构怎么挪都不会再错。
    """
    d = HERE
    for _ in range(8):
        cand = os.path.join(d, 'lib')
        if os.path.isfile(os.path.join(cand, 'me.py')):
            return cand
        d = os.path.dirname(d)
    return os.path.abspath(os.path.join(HERE, '..', '..', 'lib'))   # 兜底（保持老行为）


SCAPER_LIB = _find_scaper_lib()

sys.path.insert(0, SCAPER_LIB)
try:
    from me import cf_credentials as _me_cf_credentials      # 个人信息唯一入口
except ImportError:                                          # 理论上不会发生
    _me_cf_credentials = None

# ★ 登录态判据（CF：`Incorrect API key` / `Too many requests` 都写在正文里）
#   —— 各渠道共用一份，见 `Scaper/lib/auth_state.py`
import auth_state  # noqa: E402

API = 'https://codeforces.com/api/'
UA = {'User-Agent': 'acm-tree/xcpc'}

# ---- 礼貌限速 + 退避 ----
# 为什么要它：一次批量导入要发上百个请求（每场 gym：榜单分页 + 提交），
# CF 对 API 有频率限制，闷头打会被拒（`Too many requests` / HTTP 429）。
MIN_INTERVAL = 0.7      # 两次请求之间至少间隔多少秒
_last_call = [0.0]


def _throttle() -> None:
    import time as _t
    gap = _t.time() - _last_call[0]
    if gap < MIN_INTERVAL:
        _t.sleep(MIN_INTERVAL - gap)
    _last_call[0] = _t.time()


class CfError(RuntimeError):
    """CF 返回的失败（`status != OK`）；message 里是 CF 的原话"""


def load_credentials() -> tuple[str, str]:
    """
    取 (key, secret)；没有就返回 ('', '') —— 公开方法不需要它。

    实现在 `Scaper/lib/me.py`：环境变量 > `me.json` > `cache/cf_api.json`。
    """
    if _me_cf_credentials is not None:
        key, secret = _me_cf_credentials()
        if key and secret:
            return key, secret
    # 极端兜底（me.py 读不到时）：`cache/cf_api.json`
    if os.path.isfile(CRED_FILE):
        try:
            with open(CRED_FILE, 'r', encoding='utf-8-sig') as f:
                data = json.load(f)
            return str(data.get('key', '')).strip(), str(data.get('secret', '')).strip()
        except (ValueError, OSError):
            pass
    return '', ''


def _sign(prefix: str, method: str, params: dict, secret: str) -> str:
    items = sorted((k, str(v)) for k, v in params.items())
    query = '&'.join(f'{k}={v}' for k, v in items)
    payload = f'{prefix}/{method}?{query}#{secret}'
    return prefix + hashlib.sha512(payload.encode('utf-8')).hexdigest()


def call(method: str, params: dict | None = None, auth: bool = False, timeout: int = 60,
         retries: int = 3):
    """
    调一个 CF API 方法（自带限速与"被限流就退避重试"）。

    @param method 形如 `contest.standings`
    @param params 查询参数（不含 apiKey/time/apiSig）
    @param auth   需要登录态的方法传 True（会带 apiKey/time/apiSig）
    @param retries 被限流时最多重试几次
    @returns result 部分（CF 的 `status=OK` 时那个字段）
    """
    last_err = None
    for attempt in range(retries + 1):
        if attempt:
            time.sleep(2.0 * attempt)          # 退避：2s、4s、6s
        _throttle()
        try:
            return _call_once(method, params, auth, timeout)
        except CfError as e:
            msg = str(e)
            if not ('Too many requests' in msg or 'limit' in msg.lower() or 'HTTP 429' in msg):
                raise
            last_err = e
    raise last_err


def _call_once(method: str, params: dict | None, auth: bool, timeout: int):
    q = {k: v for k, v in (params or {}).items() if v is not None}
    if auth:
        key, secret = load_credentials()
        if not key or not secret:
            raise CfError(
                '这个方法需要 Codeforces 凭据，但没找到 —— 设环境变量 CF_API_KEY/CF_API_SECRET，'
                f'或写 {os.path.relpath(CRED_FILE)}（{{"key": "...", "secret": "..."}}）')
        q['apiKey'] = key
        q['time'] = int(time.time())
        prefix = ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))
        q['apiSig'] = _sign(prefix, method, q, secret)

    url = API + method + '?' + urllib.parse.urlencode(q)
    req = urllib.request.Request(url, headers=UA)
    status = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode('utf-8')
            status = getattr(r, 'status', 200) or 200
    except urllib.error.HTTPError as e:              # CF 用 400/403 表达"参数/权限不对"
        raw = e.read().decode('utf-8', errors='replace')
        status = e.code
        # ★ **限流要先转成"可重试"**：CF 的 429 /
        #   `Too many requests` 在共用件里被定性为**被拦（BLOCKED）** ⇒ `guard_body`
        #   直接抛 `AuthError`，而上面 `call` 的 `except CfError` **接不到** ⇒
        #   文档里那句"被限流就退避重试"**永不生效**，一次瞬时限流会把整趟抓取
        #   当"被拦"当场停掉（`read_page` 收到 AuthError 会 SystemExit(2)）。
        #   判据仍然只有共用件那一张表（`state_of`），这里不另写一套关键词。
        if auth_state.state_of('cf', auth_state.from_http(e.code, body=raw)) == auth_state.BLOCKED:
            raise CfError(f'HTTP {e.code}：Too many requests（CF 限流）—— '
                          f'{auth_state.safe_where(raw)[:120]}')
        # ★ **凭据失效先过共用件**：CF 把原因写在正文里
        #   （`Incorrect API key` / `Incorrect signature` / `Too many requests`），
        #   状态码一律 400 ⇒ 只靠 `status != OK` 分不出"该去换凭据"还是"再等等"。
        # ⚠️ `where` **不要传完整 url**：CF 的查询串里有 `apiKey`/`apiSig`，
        #    而 `where` 会进报错正文与日志。
        #    `safe_where()` 会再兜一道，但调用点自己写对更省事。
        auth_state.guard_body('cf', raw, where=f'cf_api.{method}', status=e.code)
    except urllib.error.URLError as e:
        raise CfError(f'网络错误：{e.reason}')

    # ⚠️ **解析必须放在两个分支之外**（实测的真 bug）：只有
    #    `except HTTPError` 那一支里 `payload = json.loads(raw)` ⇒ **200 成功那条路
    #    `payload` 从未赋值**，下一行 `payload.get(...)` 抛 `UnboundLocalError` ——
    #    结果是"每一次成功的 CF API 调用都失败"，整条链**静默退回缓存/本地快照**
    #    （用户："若有任何不符必须注意" —— 这就是一处：不是网络问题，是代码问题）。
    try:
        payload = json.loads(raw)
    except ValueError:
        raise CfError(f'HTTP {status}：CF 返回的不是 JSON —— {raw[:200]}') from None

    if payload.get('status') != 'OK':
        # 200 也可能带 FAILED（CF 时不时这么干）—— 同样先让共用件定性。
        # ⚠️ `where` 用**方法名**，别传完整 url：`apiKey`/`apiSig` 就在查询串里
        #    （与上面那一处同一条口径；`safe_where()` 只是兜底）。
        auth_state.guard_body('cf', raw, where=f'cf_api.{method}', status=status)
        raise CfError(payload.get('comment') or json.dumps(payload, ensure_ascii=False)[:200])
    return payload.get('result')


def has_credentials() -> bool:
    key, secret = load_credentials()
    return bool(key and secret)


#: 探针用的那一场：**gym 的榜单必须带凭据**（匿名拿不到）⇒ 正好当"凭据有效吗"的试金石
PROBE_CONTEST_ID = 104813


def check_credentials(timeout: int = 30) -> str:
    """
    **探一次 CF 凭据**（真发一个带 `apiSig` 签名的请求）⇒ 有效返回一句人话，无效/被拒抛异常。

    谁在用：`lib/auth_state.py` 的 CF 探针（设置页那颗「🔎 探活」）与 `lib/me.py --check` ——
    **一处实现**，两处都调它（别在两个地方各写一遍签名调用）。

    ⚠️ 用户 2026-10-17 定的口径："cf 怎么能因为贵就不探"：旧说法是"CF 没有**便宜的**探针"，
       讲的是"没有免签名的探法"——那是"贵"的理由，不是"不探"的理由。
       探活是**人主动按的**，一次请求的代价由按的人决定；而"不探"的代价是
       key/secret 填错也要等抓取跑到第一发才知道。
    """
    r = call('contest.standings', {'contestId': PROBE_CONTEST_ID, 'from': 1, 'count': 1,
                                   'showUnofficial': 'true'}, auth=True, timeout=timeout)
    return f'✓ CF 密钥有效（拿到 gym {PROBE_CONTEST_ID} 的榜单，{len(r.get("rows") or [])} 行）'
