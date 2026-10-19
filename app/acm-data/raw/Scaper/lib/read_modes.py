#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""
读取一页的「模式组合」+ 页级归档 + 强制重爬 —— **通用区，各渠道共用**

读取逻辑（每个读取点都套入 3×2 的模式组合函数，并设好各自的模式默认值）：
    1.不缓存  2.缓存,无新值不截断  3.缓存,无新值截断
    a.只试一次  b.失败则再进行一定尝试
    (可能 a 不用,有 b 就行)

这层逻辑必须放在**通用区**，`xcpc` 内和外的各渠道都可以调用（本文件第二、三层就是它）：

这里有三层，**任何渠道都能直接调**（`04 qoj` 是第一个接入的）：

    ① 模式（缓存 × 重试）—— 每个读取点就地声明自己的默认
    ② 归档 `Archive`     —— 页级原始原料 `<目录>/<key>.<kind>.html`，**网络的边界**
    ③ 本次运行的策略      —— `--cache-mode / --retry-mode / --force`（`add_cli_args` 一把挂上）

    缓存（`CACHE_*`）                          默认 `CACHE_KEEP`
    ├─ NONE   不缓存：每次都联网（抓到仍然入库 —— 归档是"原料"，不嫌多）
    ├─ KEEP   缓存：有归档就用归档；**本轮没有新值也继续**（翻到自然结束）
    ├─ STOP   缓存：有归档就用归档；**本轮没有新值就截断**（提前停，见 `should_stop_on_no_new`）
    └─ OFFLINE **离线：只用本地，一次也不联网**（缺哪份本地文件就当场报错，见 `require_local`）

    重试（`RETRY_*`）                          默认 `RETRY_RETRY`
    ├─ ONCE   只试一次（失败就算了）
    └─ RETRY  失败再试几次（默认 3 次，每次多等一会儿）

三条边界（都是实测踩出来的，写在这里免得再踩）：
  · **被拦/登录页不算失败，但会当场停**：凭据过期是"重试一百次也一样"的那一类，
    而一轮抓取有 20–75 页 ⇒ 由 `Scaper/lib/auth_state.py` 定性（`AuthError`）、这里**不重试**、
    直接打印那句可执行的话并 `SystemExit(2)`。返回空串让调用方接着跑，结果是**跑到一半才发现**。
  · **归档只在"抓到好页"时写**：登录页/半截页入库会把"凭据过期"固化成"原料"，
    以后再也分不出真假。
  · **不缓存 ≠ 不写**：`CACHE_NONE` 只是不读归档（用于"我要看最新的"），
    抓到的页照样入库；"连原料也不要"没有使用场景。

**强制重爬（`--force`）的语义只有一条：把归档/缓存当成不存在。**
读页时联网、`Archive.has()` 一律 False ⇒ 调用方那些"还欠哪些"的判据
（`[c for c in cids if not archive.has(c, 'contest')]`）**自动变成"全部重抓"**，
不必在每个渠道里各写一遍 if。于是"重爬某一类"和"重爬类里某几个值"是同一件事：
`--force` 决定要不要忽略归档，命令自己的选择器（`--contest`/`--category`…）决定范围。
（`--cache-mode none` 在这一点上效果相同 —— 它同样是"每次都联网"，见 `should_refetch`。）

**离线（`CACHE_OFFLINE` / `--offline`）**是第四条：
实测 `xcpc_pipeline.py --all-nodes` **在线 ~110s / 离线 ~92s** —— 离线省的是**联网那几笔**
（CF `contest.list` **26.6s**、AtCoder `contests.json` **5s+**，外加几处活清单），
⚠️ **不是大头**：真正的大头是**518 个 Python 子进程**（每个片段一个：起进程 + import
crate + 读缓存 ≈ 0.17s ⇒ **~80s**），那是"逐场跑适配器"的架构成本，离线省不掉。
`--offline` = **一次也不联网**：所有读取点走"读本地"，本地没有就**当场报错**
（`require_local()`，绝不静默出一份缺数据的包）。
⚠️ 与 `--force` **互斥**（一个是"把缓存当不存在"、一个是"只用缓存"）—— 同时给会直接报错。
⚠️ 它不改变"本地有什么"：想在离线时拿到新数据，得先在线跑一次把缓存刷出来。

怎么接进来（任何渠道都是这三段）：

    from read_modes import Archive, add_cli_args, configure_from, forced

    ap = argparse.ArgumentParser(...)
    add_cli_args(ap)                      # ① 挂上 --cache-mode/--retry-mode/--force
    args = ap.parse_args(argv)
    configure_from(args)                  # ② 让它们对本次运行生效（要在读第一页之前）
    ARCHIVE = Archive(os.path.join(HERE, 'cache', 'pages'))   # ③ 页级原料目录
    html = ARCHIVE.page(key=cid, kind='contest', url=url, fetch=fetch_html,
                        cookie=cookie, accept=lambda h: not is_login_page(h))
    if not ARCHIVE.has(cid, 'contest'):   # "还欠"的判据 —— --force 时自动为 True
        ...

  自己管缓存的渠道照**形状**挑一件（三件都在这里，语义一模一样）：

    | 形状 | 用什么 | 例 |
    |---|---|---|
    | **页级原料**（一页一文件，要留原样 HTML） | `Archive(dir)` → `.page(...)` / `.read` / `.has` | `04 qoj` 的 `cache/pages/` |
    | **JSON 缓存**（map / 一 key 一文件，只要解析结果） | `should_refetch(本地有吗)` + 自己读写 JSON | `qoj_categories.json`、`cache/cf_<gym>.json` |
    | **JSON API / 大文件**（没有"页"） | `retry_call(fetch, ...)` + `should_refetch(...)` | CF API、xcpcio 的 run/team |

    `--force` 对三者是**同一个语义**：把已有的东西当成不存在 ⇒ 该重抓。
    各渠道自己的选择器（`--contest` / `--missing` / `--slug`…）决定范围。

  **已经有自己开关的渠道别再挂一遍**：把老开关喂进来就行 ——
  `configure(force=args.refresh)`（`--refresh` / `--force` 那一类的）。`add_cli_args` 只在
  渠道**还没有**这三个开关时用（否则 argparse 会因重名直接报错）。

谁用哪个模式（每个调用点也各自写清了，这里是索引）：
    | 读取点 | 缓存 | 重试 | 为什么 |
    |---|---|---|---|
    | 场次页 `contest`          | KEEP | RETRY | 树全靠它；一次网络抖动不该让整轮白跑（题单偶有增补 ⇒ `--force`） |
    | 场次提交页 `submissions`   | **看用途** | RETRY | **成列表读 ⇒ STOP**（提交页都是**时间倒序**的 ⇒ 整页都是已存的就截断，各渠道的提交页基本都是如此）｜抓原料单页 ⇒ KEEP｜判时间列 ⇒ NONE（这页会变） |
    | 分类页 `category`         | KEEP | RETRY | 公开页、永久有效 |
    | 场次列表页 `contests.p<N>` | **NONE** | RETRY | **活列表**（QOJ 不断加场）：每次都联网，抓到照旧入库；只 1 个请求 |
    | 全局提交列表 `submitter-…` | **看模式** | RETRY | **活列表，三个模式各管一件事**：STOP（默认）联网取最新 + 一页全旧就截断（日常增量）｜KEEP 有归档用归档（**接着补归档**，断了重跑不重抓）｜NONE 联网不读归档（强制刷新）。⚠️ STOP **不能**读归档：第 1 页归档是上次快照，当缓存用就永远看不见新提交 |
    | 用户主页 `user`（VP 名单） | **NONE** | RETRY | **活页**（VP 名单只增不减，实测重抓每人都多 1 场）：每次都联网，抓到照旧入库 |
    | 题面页 `problem`          | KEEP | RETRY | "这题被哪些比赛用过"、公开页；归属取**第一场**（原场）⇒ 后来被镜像再用不影响判断 |
    | 比赛名册 `04 qoj` 的 `qoj_contest_titles.json` | **NONE** | RETRY | **活名册**（QOJ 天天加场；05 的注册表/缺场报告/名单生成都读它）—— 只 1 个请求（`--list`） |

"活数据"（内容会变：提交列表、VP 名单、场次列表、索引）是这套模式里唯一需要小心的一类，
写在这里免得下次又把它套成"缓存优先"：
**它的日常读取必须联网**（`CACHE_NONE` / 活列表的 `STOP`）—— 归档是**上次的快照**，
当缓存读就等于"永远看不到新增"；归档对它的意义只有「原料」＋「断了接着补（KEEP）」。

**提交页另有一条通用规则**：**各渠道的提交页都是时间倒序的** ⇒
凡是**成列表**读提交页，都该用 `STOP`：碰到"整页都是本地已有的提交"就**截断**
（水位线 = 本地已有的提交 ID）—— 新提交在前面，后面只会更旧。
QOJ 两处都这么做：`--fetch`（全局 / 场次）与 `--archive` 抓"我提交过"的场次。
"""

from __future__ import annotations

import os
import socket
import sys
import time
import traceback

try:                                    # 与本文件同层（`Scaper/lib/`）
    from auth_state import AuthError, safe_where
except ImportError:                     # pragma: no cover —— 只在被复制走一半时发生
    class AuthError(RuntimeError):      # type: ignore[no-redef]
        """（退路）登录态坏了 —— 见 `Scaper/lib/auth_state.py`"""

    def safe_where(where) -> str:       # type: ignore[misc]
        """（退路）见 `Scaper/lib/auth_state.py`"""
        return str(where or '')

# ---- 缓存模式 ----
CACHE_NONE = 'none'     # 1 不缓存：每次都联网（抓到仍入库）
CACHE_KEEP = 'keep'     # 2 缓存；无新值**不**截断
CACHE_STOP = 'stop'     # 3 缓存；无新值**截断**
CACHE_OFFLINE = 'offline'   # 4 **离线：只用本地，一次也不联网**（缺文件即报错）

# ---- 重试模式 ----
RETRY_ONCE = 'once'     # a 只试一次
RETRY_RETRY = 'retry'   # b 失败再尝试几次

CACHE_MODES = (CACHE_NONE, CACHE_KEEP, CACHE_STOP, CACHE_OFFLINE)
RETRY_MODES = (RETRY_ONCE, RETRY_RETRY)

#: 离线还能从**环境变量**传（给"父进程跑一堆子进程"的场景用）：
#: `xcpc_pipeline.py` 要给 600+ 个适配器（其中有的根本不认 `add_cli_args` 的开关，
#: 比如 `qoj_adapter.py`）传"这次别联网"，逐个拼命令行必然漏 ⇒ 改成环境变量，
#: 子进程 import 本模块时自动生效。
OFFLINE_ENV = 'ACM_READ_OFFLINE'

# 两个维度的**默认值**（各调用点可以就地覆盖，覆盖的地方都写了理由）
DEFAULT_CACHE = CACHE_KEEP
DEFAULT_RETRY = RETRY_RETRY

DEFAULT_TRIES = 3           # 含第一次
DEFAULT_SLEEP = 0.6         # 第一次失败后等这么久，之后翻倍

# ---- 本次运行的计数（几行就有，用来"用数据决定怎么优化"，别再靠猜） ----
_T0 = time.monotonic()
_STATS = {'pages': 0, 'archive': 0, 'fetches': 0, 'retries': 0, 'failed': 0, 'bytes': 0}


def stats() -> dict:
    """本次运行到现在的计数：页 / 归档命中 / 联网次数 / 重试 / 失败 / 联网字节 / 秒"""
    out = dict(_STATS)
    out['seconds'] = round(time.monotonic() - _T0, 1)
    return out


def print_stats(label: str = '读取') -> dict:
    """一行统计（各渠道在 main 结尾调一次）+ **有失败就再补一行 ❌**（别让它淹在数字里）"""
    s = stats()
    print(f'⏱ {label}统计：页 {s["pages"]}（归档命中 {s["archive"]}）｜'
          f'联网 {s["fetches"]} 次（重试 {s["retries"]}，失败 {s["failed"]}）｜'
          f'{s["bytes"] / 1048576:.2f} MB｜{s["seconds"]}s')
    # ⚠️ `read_page` 拿不到页时**只写一行 stderr 就返回空串** ——
    #    这在日志里会淹进上面的数字里，而后果是"这一趟出的包**少了那几页**"。
    #    这里补一条显眼的 ❌ 行：**"没拿到"必须看得见**。
    #    ⚠️ 有意**不改退出码**：缺页在**在线**模式也可能正常（上游确实没有那一页），
    #    一律当失败会让整条链为"少一页"白跑完全不产出。要不要致命由调用方决定 ——
    #    用 `require_local()`（"这一页必须在本地"），它会当场 `SystemExit`。
    if s['failed']:
        print(f'❌ {label}：有 {s["failed"]} 页**没拿到**（上面那几行 ✗ 是明细）——'
              f'如果这几页是必需的，这份产物**不完整**；'
              f'"必须在本地"的读取点请改用 require_local()，别靠返回值判。',
              file=sys.stderr)
    return s


# ================================================================
# ③ 本次运行的策略：CLI 设一次，所有读取点自动生效
#
#   不设（None）= 每个读取点用它**就地声明的默认值**；
#   设了        = **全局盖过**就地默认（例：`--cache-mode none` = 这次谁都不许读归档）。
#   `force` 的含义见文件头：**把归档当成不存在**。
# ================================================================
_POLICY: dict = {'cache': None, 'retry': None, 'force': False}


# ================================================================
# 离线兜底：把"往外连"这一层拦下来（一处挡住所有渠道，包括以后新写的）
# ================================================================

# 一份**原始**函数（import 时抓的；装/卸都从这里取，来回切也切不坏）
_PRISTINE_SOCKET = {
    'create_connection': socket.create_connection,
    'connect': socket.socket.connect,
    'connect_ex': socket.socket.connect_ex,
}
_GUARD_ON = False
_INET = (socket.AF_INET, socket.AF_INET6)


def _blame() -> str:
    """谁想联网：栈里第一个**不在标准库、也不在本文件**的帧（那才是调用点）"""
    lib = os.path.dirname(os.__file__ or '')
    for fr in reversed(traceback.extract_stack()[:-1]):
        fn = fr.filename
        if fn != __file__ and not (lib and fn.startswith(lib)):
            return f'{fn}:{fr.lineno}'
    return ''


def _offline_net_error(address) -> SystemExit:
    who = _blame()
    return SystemExit(
        f'❌ 离线模式（--offline）下不许联网，但有人要连 {address}。\n'
        + (f'   是谁要连：{who}\n' if who else '')
        + '   离线只读本地 ⇒ 要么这次别加 --offline（先在线跑一次把缓存刷出来），'
          '要么把这次要用的本地缓存补齐（缺什么上面那句会点名）。\n'
          '   这一层是**兜底**：各渠道自己的 `should_refetch()` / `require_local()` 是把话说清楚，'
          '这里保证"忘一处也不会静默联网"。')


def _blocked_create_connection(address, *a, **k):                     # noqa: ARG001
    raise _offline_net_error(address)


def _blocked_connect(self, address, *a, **k):
    # 只拦**网络**地址；AF_UNIX 那种本机 IPC 不算"联网"
    if getattr(self, 'family', None) in _INET:
        raise _offline_net_error(address)
    return _PRISTINE_SOCKET['connect'](self, address, *a, **k)


def _blocked_connect_ex(self, address, *a, **k):
    if getattr(self, 'family', None) in _INET:
        raise _offline_net_error(address)
    return _PRISTINE_SOCKET['connect_ex'](self, address, *a, **k)


def _apply_offline_guard(on: bool) -> None:
    """
    **离线时把"往外连"装成闸门**（`configure()` 每次都会调一次，切回来就卸掉）。

    为什么要有它（"收成一处"）：`--offline` 的语义是"一次也不联网"，
    而"每个读取点自己记得加 `should_refetch()` / `require_local()`"是**忘一处就静默联网**
    的那类设计 —— 例：`atcoder_adapter.load_submissions` 把 `should_refetch()`
    只用在水位线上），而且仓里还有 ~28 处**直连 `urllib`**（不走 `retry_call`，
    任何"联网 N 次"的统计都看不见）。所以在最底下装一道闸门：不管谁、走哪条路要往外连，
    离线时**当场报错并指出调用点**。

    ⚠️ 边界：只拦"往外连"（`create_connection` / `connect` / `connect_ex` 且地址族是 INET）——
    不碰 `bind`/`listen`/`accept`（`dev-server.py` 要监听）、不碰 AF_UNIX、也不拦 DNS 解析本身。
    """
    global _GUARD_ON
    if on == _GUARD_ON:
        return
    if on:
        socket.create_connection = _blocked_create_connection
        socket.socket.connect = _blocked_connect
        socket.socket.connect_ex = _blocked_connect_ex
    else:
        socket.create_connection = _PRISTINE_SOCKET['create_connection']
        socket.socket.connect = _PRISTINE_SOCKET['connect']
        socket.socket.connect_ex = _PRISTINE_SOCKET['connect_ex']
    _GUARD_ON = on


def configure(*, cache: str | None = None, retry: str | None = None,
              force: bool = False, offline: bool = False) -> dict:
    """
    设本次运行的策略（就地默认仍由各读取点声明）。返回生效后的策略副本。

    `offline=True` = `cache=CACHE_OFFLINE` 的糖（**一次也不联网**）；
    与 `force=True` **互斥**（一个说"把缓存当不存在"、一个说"只用缓存"）—— 同时给就报错，
    免得"以为在离线跑、其实在重抓"或反过来。
    """
    if offline:
        if force:
            raise ValueError('--offline 与 --force 互斥：一个是"只用本地"，一个是"忽略本地重抓"')
        if cache is not None and cache != CACHE_OFFLINE:
            raise ValueError(f'--offline 与 --cache-mode {cache} 互斥（offline 本身就是一种缓存模式）')
        cache = CACHE_OFFLINE
    elif offline_from_env():
        # 环境变量说的（父进程传下来的）—— 同样不许和 `--force` 并存
        if force:
            raise ValueError(f'{OFFLINE_ENV}=1 与 --force 互斥：一个是"只用本地"，一个是"忽略本地重抓"')
        cache = CACHE_OFFLINE
    if cache is not None and cache not in CACHE_MODES:
        raise ValueError(f'未知的缓存模式 {cache!r}（只能是 {CACHE_MODES}）')
    if retry is not None and retry not in RETRY_MODES:
        raise ValueError(f'未知的重试模式 {retry!r}（只能是 {RETRY_MODES}）')
    _POLICY['cache'] = cache
    _POLICY['retry'] = retry
    _POLICY['force'] = bool(force)
    # ⚠️ 这里**不能**写 `offline()` —— 本函数的形参就叫 `offline`，会把它遮住
    #   （实测踩到：`TypeError: 'bool' object is not callable`）。就用刚刚定下来的 `cache`。
    _apply_offline_guard(cache == CACHE_OFFLINE)   # 离线 ⇒ 装上"往外连"闸门（见上）
    return dict(_POLICY)


def policy() -> dict:
    """当前策略（副本，改它不影响本模块）"""
    return dict(_POLICY)


def active_cache(local_default: str = DEFAULT_CACHE) -> str:
    """本读取点实际用的缓存模式：CLI 设了听 CLI，否则用它就地声明的默认"""
    return _POLICY['cache'] if _POLICY['cache'] is not None else local_default


def active_retry(local_default: str = DEFAULT_RETRY) -> str:
    """本读取点实际用的重试模式：CLI 设了听 CLI，否则用它就地声明的默认"""
    return _POLICY['retry'] if _POLICY['retry'] is not None else local_default


def forced() -> bool:
    """本次运行是不是"强制重爬"（= 把归档当成不存在）"""
    return bool(_POLICY['force'])


def offline() -> bool:
    """本次运行是不是**离线**（= 一次也不联网，缺什么本地文件就报错）"""
    return _POLICY['cache'] == CACHE_OFFLINE


def offline_from_env() -> bool:
    """环境变量（`ACM_READ_OFFLINE`）说这次离线吗 —— 给"父进程跑子进程"的场景传（见 `OFFLINE_ENV`）"""
    return os.environ.get(OFFLINE_ENV, '').strip() not in ('', '0', 'false', 'False')


def require_local(path: str, what: str = '缓存') -> None:
    """
    **离线时**要求这份本地文件必须在；不在就当场退出（带一句人话）。

    为什么要有它：`should_refetch()` 在离线时对谁都返回 False（"不许联网"），于是调用方
    会去读本地文件 —— 文件不在的话，报出来的是 `FileNotFoundError` 或（更糟）**静默出一份
    缺数据的包**。这里把"离线 + 本地没有"变成一句明确的错误：**要么先在线跑一次，要么别加 `--offline`**。
    在线模式下本函数是**空操作**（调用方照旧联网抓）。
    """
    if not offline() or os.path.isfile(path):
        return
    raise SystemExit(
        f'❌ 离线模式（--offline）下没有本地 {what}：{path}\n'
        f'   离线只读本地、绝不联网 ⇒ 先不带 --offline 跑一次把缓存刷出来，再去掉它重跑。')


def should_refetch(has_cache: bool, default: str = DEFAULT_CACHE) -> bool:
    """
    **非页级缓存**（自己管 JSON / 一 key 一文件的渠道）用的判据：**该联网取这个 key 吗**。

    三条会重抓：① `--force`（把缓存当不存在）② `--cache-mode none`（不读缓存，每次联网）
    ③ 本地本来就没有。写成函数是为了让
    `if should_refetch(os.path.isfile(p)):` 读起来就是它想说的意思 ——
    并且**各渠道的 `--force` 语义因此完全一致**：范围看它自己的选择器，开关只决定"忽不忽略已有缓存"。

    `default` 是这个渠道**就地声明**的默认模式（与 `active_cache(local_default)` 同一套规则）：
    只有"活数据"（索引/名单会不断变）才该写 `CACHE_NONE` —— 那时**每次都要联网**，
    缓存只当原料。

    ⚠️ **离线（`CACHE_OFFLINE`）一律 False**：那是"绝对不许联网"，与"该不该取这个 key"无关 ——
    调用方读到 False 就会去读本地；本地没有的话请用 `require_local()` 报错（别静默出空数据）。
    """
    if offline():
        return False
    return (forced() or active_cache(default) == CACHE_NONE or not has_cache)


def retry_call(fn, *args, what: str = '', tries: int = DEFAULT_TRIES,
               sleep: float = DEFAULT_SLEEP, **kw):
    """
    按**本次运行的重试模式**跑一次网络调用 —— 给不走 `read_page` 的读取点用
    （JSON API / 单文件下载那种：它们自己 fetch + 自己落盘，没有"页"的概念）。

    `--retry-mode once` 就只试一次；默认 `retry` 试 `tries` 次、退避翻倍。
    失败（最后一次仍抛）就**原样抛出** —— "拿不到"的原因由调用方说清。

    ⚠️ **离线时这里当场退出**（`fn` 一次都不调）—— 这是"一次也不联网"的**兜底**：
    各读取点自己写 `should_refetch()` 守卫是对的，但"忘一处就静默联网"
    （`atcoder_adapter.load_submissions` 就把 `should_refetch()`
    只用在水位线上，离线重跑照样打 kenkoooo）。凡走本函数的网络调用，
    离线时一律在这里被拦下，不用逐个渠道去记。
    """
    where = what or getattr(fn, '__name__', 'fetch')
    # 进日志/报错的形态：`where` 的调用惯例是"一处人话或一个 URL"，而 CF 那类接口把
    # **`apiKey`/`apiSig` 写在查询串里** ⇒ 一律先过 `safe_where`（与 `AuthError` 同一套）。
    shown = safe_where(where)
    if offline():
        raise SystemExit(
            f'❌ 离线模式（--offline）下不许联网，但 {shown} 正要联网。\n'
            f'   离线只读本地 ⇒ 要么这次别加 --offline（先在线跑一次把缓存刷出来），\n'
            f'   要么把这次要用的本地缓存补齐（缺什么上面那句会点名）。')
    attempt_total = 1 if active_retry() == RETRY_ONCE else max(1, tries)
    last: Exception | None = None
    for i in range(1, attempt_total + 1):
        _STATS['fetches'] += 1
        if i > 1:
            _STATS['retries'] += 1
        try:
            got = fn(*args, **kw)
            if isinstance(got, (str, bytes)):
                _STATS['bytes'] += len(got)
            return got
        except AuthError:
            # **登录态坏了：重试一百次也一样** ⇒ 不重试、不吞，直接让 main 去报
            #（那句话（去 me.json 更新哪一份凭据）在 `AuthError` 里，见 `lib/auth_state.py`）
            _STATS['failed'] += 1
            raise
        except Exception as e:  # noqa: BLE001
            last = e
            if i < attempt_total:
                wait = sleep * (2 ** (i - 1))
                print(f'   ↻ {shown} 第 {i} 次失败（{type(e).__name__}: {str(e)[:60]}）'
                      f'→ {wait:.1f}s 后再试')
                time.sleep(wait)
    _STATS['failed'] += 1
    raise last if last else RuntimeError(where)


def add_cli_args(ap, *, cache_help: str = '', retry_help: str = '',
                 force_help: str = '') -> None:
    """
    给任何渠道的 argparse **挂上统一的读取开关**（`--cache-mode/--retry-mode/--force`）。

    不挂也能跑（就地默认值照旧）；挂了以后 `configure_from(args)` 一调就全局生效。
    三个 help 参数留给"这个渠道另有说法"的地方覆盖（比如把 `--contest a,b` 这种
    具体选择器写进去）。
    """
    ap.add_argument('--cache-mode', dest='cache_mode', default=None,
                    choices=CACHE_MODES,
                    help=cache_help or
                    '读取的**缓存模式**（默认：各读取点自己声明，见 `Scaper/lib/read_modes.py`）：'
                    f'`{CACHE_NONE}` 不缓存（每次联网，抓到仍入库）｜'
                    f'`{CACHE_KEEP}` 缓存、无新值**不截断**｜'
                    f'`{CACHE_STOP}` 缓存、无新值**截断**｜'
                    f'`{CACHE_OFFLINE}` **离线**（只用本地、绝不联网，缺文件即报错）。'
                    '给了它就**盖过所有就地默认**')
    ap.add_argument('--retry-mode', dest='retry_mode', default=None,
                    choices=RETRY_MODES,
                    help=retry_help or
                    f'读取的**重试模式**：`{RETRY_RETRY}`（默认）失败再试 3 次（每次多等一会儿）｜'
                    f'`{RETRY_ONCE}` 只试一次')
    ap.add_argument('--offline', action='store_true',
                    help='**离线跑**（= `--cache-mode offline`）：一次也不联网，只用本地缓存/归档，'
                         '缺哪份本地文件就当场报错。省的是联网那几笔（实测整条流水线 '
                         '~110s → ~92s；另有 518 个 Python 子进程 ≈ 80s 是架构成本，离线省不掉）。'
                         '⚠️ 与 `--force` 互斥')
    ap.add_argument('--force', action='store_true',
                    help=force_help or
                    '**强制重抓**：把已有的缓存/归档当成不存在 —— 该联网就联网，'
                    '"还欠哪些"的判据也自动变成"全部重抓"。'
                    '范围由命令自己的选择器定（不给选择器 = 该命令的整类）')


def reset_stats() -> None:
    """
    把"本次运行"的计数清零（`_T0` 也重置）。

    ★ 为什么必须有（2026-10-16 修，审计翻出来的）：链子里的 `.py` 步骤在**应用那个长驻进程**里
      是 `runpy` **就地**跑的（`build_chain.run_step`，不是子进程）⇒ 模块级的 `_STATS/_T0`
      会**跨步骤、跨多次构建**累加：每一步打出来的"页 N｜联网 M｜失败 K"其实是"这个进程至今"，
      而那句 `❌ 有 N 页没拿到` 也永远回不到 0（它把前面所有步骤的失败都算进来了）。
      例：改前 `05 xcpc/selftest.py` 里得专门写一句"别拿全局累加计数当证据，比前后差值"来绕它。

    粒度 = **一次运行**：`configure_from(args)` 会调它（每个脚本都在"读第一页之前"调那一句）。
    """
    global _T0, _STATS
    _T0 = time.monotonic()
    _STATS = {'pages': 0, 'archive': 0, 'fetches': 0, 'retries': 0, 'failed': 0, 'bytes': 0}


def configure_from(args) -> dict:
    """
    把 `add_cli_args` 挂上的开关变成"本次运行的策略"（解析完参数后立刻调一次）。

    ⚠️ **要在读第一页之前调**（策略只影响之后发生的读取）。
    ⚠️ 它同时把统计**清零**（`reset_stats()`）：一次"运行"= 从这一句开始 —— 见 `reset_stats()` 的注释。
    ⚠️ `--offline` 与 `--force`（或与 `--cache-mode <别的>`）同时给 ⇒ `ValueError`
    （见 `configure`）—— 矛盾的命令与其猜人的意思，不如直接说清。
    """
    reset_stats()
    return configure(cache=getattr(args, 'cache_mode', None),
                     retry=getattr(args, 'retry_mode', None),
                     offline=bool(getattr(args, 'offline', False)),
                     force=bool(getattr(args, 'force', False)))


def should_stop_on_no_new(cache_mode: str) -> bool:
    """
    "本页没有新值"要不要**截断**（提前停）。

    只有 `CACHE_STOP` 才截断；`CACHE_KEEP` 说"没新值也继续"（例如要补全归档）。
    `CACHE_NONE` 不读归档 ⇒ "新值"这件事无从谈起，也按不截断处理。
    `CACHE_OFFLINE` 同理（不联网 ⇒ 没有"新值"）。
    """
    return cache_mode == CACHE_STOP


def read_page(*, key: str, kind: str, url: str, fetch, load=None, save=None,
              cache: str | None = None, retry: str | None = None,
              cookie: str = '', accept=None, tries: int = DEFAULT_TRIES,
              sleep: float = DEFAULT_SLEEP, verbose: bool = True,
              label: str = '') -> str:
    """
    读一页：**先看归档，没有就抓（可重试），抓到即入库**。

    @param key      归档里的标识（场次号 / 用户名 / 题目号 / `submitter-<名字>`…）
    @param kind     归档后缀（`contest` / `submissions` / `category` / `user` / `problem`…）
    @param url      联网用的网址
    @param fetch    `(url, cookie) -> html`，失败请抛异常（本函数按 `retry` 决定重试）
    @param load     `(key, kind) -> html`（缺省 = 不读归档；`Archive` 会接好）
    @param save     `(key, kind, html) -> None`（缺省 = 不入库；`Archive` 会接好）
    @param accept   `(html) -> bool`：这算一页**好页**吗（缺省全算好）。
                    返回 False ⇒ **不重试、不入库**，直接返回空串（典型：登录页）。
    @param cache    `CACHE_*`；`None` = `DEFAULT_CACHE`。
                    ⚠️ **策略只解析一次**：想让它被 `--cache-mode` 盖过，就在读取点用
                    `active_cache(就地默认)` 拿到实际值再传进来（`Archive.page` 已经这么做了），
                    本函数只认给它的值 —— 免得"解析两次"把派生出来的模式又改回去。
    @param retry    `RETRY_*`；`None` = `DEFAULT_RETRY`（同上）
    @returns 页面 HTML；拿不到就是 `''`（调用方负责说清原因）
    """
    cache = DEFAULT_CACHE if cache is None else cache
    retry = DEFAULT_RETRY if retry is None else retry
    if cache not in CACHE_MODES:
        raise ValueError(f'未知的缓存模式 {cache!r}（只能是 {CACHE_MODES}）')
    if retry not in RETRY_MODES:
        raise ValueError(f'未知的重试模式 {retry!r}（只能是 {RETRY_MODES}）')

    where = label or f'{kind}:{key}'
    _STATS['pages'] += 1

    # ---- ① 归档 ----
    if cache != CACHE_NONE and load is not None:
        html = load(key, kind)
        if html:
            _STATS['archive'] += 1
            if verbose:
                print(f'   📄 用归档 {where}')
            return html

    # ---- ② 联网（按 retry 决定试几次）----
    # 离线模式：网络这一步**不存在**（本地没有就返回空，绝不偷偷联网）。
    if cache == CACHE_OFFLINE:
        _STATS['failed'] += 1
        print(f'   ✗ {where}：离线模式（--offline）且本地没有这一页 —— 不联网，返回空',
              file=sys.stderr)
        return ''

    attempts = 1 if retry == RETRY_ONCE else max(1, tries)
    last = ''
    for i in range(1, attempts + 1):
        _STATS['fetches'] += 1
        if i > 1:
            _STATS['retries'] += 1
        try:
            html = fetch(url, cookie)
        except AuthError as auth_err:
            # ★ **过期/被拦 ⇒ 当场停**（别让 20–75 页跑到一半才发现）：
            #   这不是失败，是"这一轮没法继续"—— 重试没有意义，吞掉更糟（调用方会一路空转到收尾）。
            #   `AuthError` 自带那句可执行的话（去哪份凭据、怎么拿、以及"重跑不会重抓"）。
            #   与 `require_local()` 同一个态度：**宁可当场停，也不出一份半截的包**。
            _STATS['failed'] += 1
            print(f'\n{auth_err}', file=sys.stderr)
            raise SystemExit(2)
        except Exception as e:  # noqa: BLE001
            last = f'{type(e).__name__}: {e}'
            if i < attempts:
                wait = sleep * (2 ** (i - 1))
                print(f'   ↻ {where} 第 {i} 次失败（{last[:60]}）→ {wait:.1f}s 后再试')
                time.sleep(wait)
            continue
        if accept is not None and not accept(html):
            # 好页才有价值：这不叫失败，重试没意义（典型：cookie 过期）
            _STATS['failed'] += 1
            if verbose:
                print(f'   ✗ {where} 拿到的不是好页（登录页/被拦）—— 不重试、不入库')
            return ''
        if save is not None:
            save(key, kind, html)
        _STATS['bytes'] += len(html)
        if verbose:
            print(f'   ⬇️ 抓到并入库 {where}（{len(html)} 字节'
                  + (f'，第 {i} 次尝试' if i > 1 else '') + '）')
        return html

    _STATS['failed'] += 1
    print(f'   ✗ {where} 试了 {attempts} 次都失败（{last[:80]}）', file=sys.stderr)
    return ''


# ================================================================
# ② 页级归档：`<目录>/<key>.<kind>.html`，**网络的边界**
#
#   `--force` / `--cache-mode none` 都在这里落地：`read()` 返回空、`has()` 返回 False ——
#   对调用方来说就是"这一页还没有原料"，于是它自然会去联网、也会把
#   "还欠哪些"的待办算成"全部"。**不必在每个渠道里各写一遍 if force**。
# ================================================================
class Archive:
    """一个目录里的页级原始原料（每页一个文件，原样存、原样读）。"""

    def __init__(self, directory: str, suffix: str = '.html'):
        self.dir = directory
        self.suffix = suffix

    def path(self, key, kind) -> str:
        """这一页在归档里的路径：`<dir>/<key>.<kind>.html`"""
        return os.path.join(self.dir, f'{key}.{kind}{self.suffix}')

    def read(self, key, kind) -> str:
        """读归档；**没有 / `--force` / `--cache-mode none`** 都返回空串（调用方据此去联网）"""
        if should_refetch(self.has(key, kind)):
            return ''
        try:
            with open(self.path(key, kind), 'r', encoding='utf-8-sig', errors='replace') as f:
                return f.read()
        except OSError:
            return ''

    def has(self, key, kind) -> bool:
        """
        这一页有没有原料。

        **`--force` / `--cache-mode none` 时一律 False** ⇒ 调用方那些"还欠哪些"的判据
        自动变成"全部重抓"。（两者在页级归档上是同一效果；区别只是语义来源：
        一个是"强制重爬"，一个是"不缓存、每次联网"。）
        """
        if forced() or active_cache(DEFAULT_CACHE) == CACHE_NONE:
            return False
        return os.path.isfile(self.path(key, kind))

    def write(self, key, kind, html) -> None:
        os.makedirs(self.dir, exist_ok=True)
        with open(self.path(key, kind), 'w', encoding='utf-8', newline='\n') as f:
            f.write(html)

    def page(self, *, key: str, kind: str, url: str, fetch, cookie: str = '',
             accept=None, cache: str | None = None, retry: str | None = None,
             verbose: bool = True, label: str = '') -> str:
        """
        读这一页（归档优先，没有才联网，抓到即入库）——
        = `read_page` 把 `load/save` 接成本归档，`--force`/`--cache-mode` 自动生效。

        `cache=None`（默认）= 用**就地默认 `CACHE_KEEP`**，但**被 `--cache-mode` 盖过**：
        策略在这里解析一次，再原样交给 `read_page`。
        """
        return read_page(
            key=key, kind=kind, url=url, fetch=fetch, load=self.read, save=self.write,
            cache=active_cache(DEFAULT_CACHE if cache is None else cache),
            retry=active_retry(DEFAULT_RETRY if retry is None else retry),
            cookie=cookie, accept=accept,
            verbose=verbose, label=label or os.path.basename(self.path(key, kind)),
        )
