# ================================================================
# 「登录态探活」那条子进程（scripts/devserver/auth_probe.py）
#
# **登录态所需资料的 UI 端手输** —— 手输之后自然要问一句
# "**现在到底有效没有**"。答案只有抓取侧那份判据能给：`Scaper/lib/auth_state.py` 的
# `--probe <平台>`（1 个请求，过期/被拦会打印那句可执行的话并退出码 1）。
#
# 这里只做三件事：**校验参数 → 起一个子进程 → 把它的输出原样带回去**。
# ⚠️ 页面**传不了命令**：平台名只允许 `[a-z0-9_-]`，`--set` 的键只允许点分标识符、
#    值有长度上限、条数有上限 —— 一道都不满足就 400（能传任意参数 = 本机任意命令执行）。
# ⚠️ 探针**读磁盘上的 me.json**（页面可以用 `overrides` 覆盖某几格，见 `auth_state._fill`）
#    ⇒ 想让它测"磁盘上那份"，就别传 overrides。
# ================================================================
import os
import re
import subprocess
import sys

PROBE_TIMEOUT = 45              # 1 个请求 + 起进程，正常 1~3 秒；超过就当失败
MAX_OVERRIDES = 8
MAX_VALUE_CHARS = 4096

#: 平台名（**只允许这个形状**：字母数字下划线短横，1~16 位）
PLATFORM_RE = re.compile(r'^[a-z0-9_-]{1,16}$')
#: `--set` 的键（点分：`qoj.cookie` / `clist.apiKey`）
KEY_RE = re.compile(r'^[A-Za-z0-9_.-]{1,40}$')


def auth_state_path(repo: str) -> str:
    """那份判据在哪儿（**路径写死在这儿**，页面传不了）"""
    return os.path.join(repo, 'acm-data', 'raw', 'Scaper', 'lib', 'auth_state.py')


def _bad(msg: str):
    return 400, {'ok': False, 'error': msg}


def parse_probe_body(payload: dict):
    """
    `POST /api/auth-probe` 的 body ⇒ `(platform, ['k=v', ...])`；不合法 ⇒ 抛 `ValueError`。

    body 形状：`{"platform": "qoj", "overrides": {"qoj.cookie": "session=…"}}`
    """
    if not isinstance(payload, dict):
        raise ValueError('body 必须是 JSON 对象')
    platform = str(payload.get('platform') or '').strip().lower()
    if not PLATFORM_RE.match(platform):
        raise ValueError('platform 只允许 [a-z0-9_-]{1,16}')
    overrides = payload.get('overrides') or {}
    if not isinstance(overrides, dict):
        raise ValueError('overrides 必须是对象')
    if len(overrides) > MAX_OVERRIDES:
        raise ValueError('overrides 最多 %d 条' % MAX_OVERRIDES)
    pairs = []
    for key, value in overrides.items():
        k = str(key or '')
        if not KEY_RE.match(k):
            raise ValueError('overrides 的键只允许字母数字与 _ . -（最多 40 位）')
        v = '' if value is None else str(value)
        if len(v) > MAX_VALUE_CHARS:
            raise ValueError('overrides 的值最长 %d 字符' % MAX_VALUE_CHARS)
        pairs.append('%s=%s' % (k, v))
    return platform, pairs


def probe(repo: str, payload: dict, timeout: int = PROBE_TIMEOUT):
    """
    跑一次探活 ⇒ `(http_code, payload)`。

    @returns `{ok:True, code, output}`（`code` = 子进程退出码：0 有效 / 1 过期或被拦 /
             2 用法或平台名不对）；参数不合法 ⇒ 400
    """
    try:
        platform, pairs = parse_probe_body(payload)
    except ValueError as err:
        return _bad(str(err))

    script = auth_state_path(repo)
    if not os.path.isfile(script):
        return 500, {'ok': False, 'error': '找不到登录态判据：%s' % script}
    argv = [sys.executable, '-B', script, '--probe', platform]
    for one in pairs:
        argv += ['--set', one]
    try:
        done = subprocess.run(argv, cwd=repo, capture_output=True, text=True,
                              encoding='utf-8', errors='replace', timeout=timeout)
    except subprocess.TimeoutExpired:
        return 504, {'ok': False, 'error': '探活超时（%ds）——多半是网络卡住，不是凭据的问题' % timeout}
    except OSError as err:
        return 500, {'ok': False, 'error': '起不来：%s: %s' % (type(err).__name__, err)}
    out = ((done.stdout or '') + (done.stderr or '')).strip()
    return 200, {'ok': True, 'code': done.returncode, 'platform': platform, 'output': out}
