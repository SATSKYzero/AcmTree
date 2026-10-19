#!/usr/bin/env python3
# ================================================================
# 开发用静态服务器（scripts/dev-server.py）
#
# 存在的理由：
#   `python -m http.server` 只发送 Last-Modified，不发送 Cache-Control。
#   浏览器于是按启发式规则缓存 ES 模块，导致「模块版本混合」：
#   新增文件正常加载，但**被改动的旧文件仍走缓存**。
#   症状极具迷惑性，例如：
#     TypeError: api.registerFolderView is not a function
#   —— 插件是新的，而它 import 的 pluginRegistry.js 是旧的。
#
# 本服务器对每个响应都加 no-store，保证刷新即是最新代码。
#
# 用法：
#   python scripts/dev-server.py            # 端口 8321，根目录为仓库根
#   python scripts/dev-server.py 9000
#   python scripts/dev-server.py 9000 ./src
#
# ⚠️ 正常入口是 `启动AcmTree.bat` → `scripts/launch.py`（幂等：已在跑就只开浏览器、
#    旧进程会自动被换掉、端口被占就换端口）。直接跑这个文件也行。
#
# 自重启：本文件被改动后，服务器会**自己重启**（见 `start_restart_watcher`）——
#   实测的坑：改完 `dev-server.py` 不重启，旧进程里没有 `/api/*`，
#   页面点「重建总包」只会得到 404，而人根本想不到要去重启一个后台进程。
# ================================================================
import functools
import hashlib
import importlib
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import types
import urllib.error
import urllib.request

# ⚠️ 必须在**任何 import 之前**：`启动AcmTree.bat` 是 `python "scripts\dev-server.py"`（**没带 `-B`**）
#    ⇒ 不写这一行就会生成 `scripts/__pycache__` 与 `scripts/devserver/__pycache__`
#    （仓库规矩：不留这些）。
sys.dont_write_bytecode = True

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

# 同一目录下的步骤表：**本进程内**跑原料处理链（不起 npm → node → python 子进程）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# ★ 本进程 stdio 钉 UTF-8（2026-10-18，见 `utf8_stdio.py` 文件头）：关掉 Windows「UTF-8 Beta」后
#   ACP=936，服务器日志里的中文/符号会按 GBK 编 ⇒ 有的字符直接崩。
#   ⚠️ `_pin_hashseed()` 的 execv 也把 `PYTHONUTF8=1` 写进环境，两条路都覆盖。
import utf8_stdio                                                           # noqa: E402
utf8_stdio.pin()
import build_chain                                                          # noqa: E402
from selftest_kit import Selftest

# Windows 上 .js 的 MIME 可能被注册表改成 text/plain，会让浏览器
# 拒绝把模块当 ES module 执行。这里显式固定关键类型。
#: 默认端口（与 启动AcmTree.bat、src/features/AutoImport/buildApi.js 保持一致）
#: ⚠️ 为什么不用 8000：那个端口常被别的工具占着（本机实测撞上过 python -m http.server，
#:    还叠了三份抢答）—— 换个不抢的端口，页面的按钮也会主动来这里找主脚本。
DEFAULT_PORT = 8321
#: 自重启轮询间隔（秒）
RESTART_POLL = 2.0

# ---- 本服务器的内部模块（从本文件拆出去的模块；按职责分文件，见各自头注）----
# 直接 import 名字（而不是 `import devserver.x as x_mod`）：这样 `main()` 里的引用一个字不用改。
from devserver.build_runner import BuildRunner                       # noqa: E402
from devserver.http_handler import API_VERSION, NoCacheHandler       # noqa: E402
from devserver.procutil import local_ping, port_in_use, stop_python_on_port   # noqa: E402
from devserver.selftest import _selftest                             # noqa: E402


# ---- 本服务器的**源文件组**（入口 + devserver/ 里的模块 + 本进程内跑的构建步骤那一组）----
# ⚠️ 自重启与 `/api/ping` 的源码指纹都必须覆盖**整组**：只盯入口的话，改了内部模块
#    既不重启、指纹也不变。
def build_source_files(server_file):
    """
    **在本进程里跑的**那些构建步骤会用到的 `.py`（链上 `kind='py'` 的步骤 + 它同目录的兄弟模块
    + 它们的 `lib/`）。

    为什么它们与服务器自己的模块**同等对待**：那些步骤是 `runpy` 在**本进程内**执行的
    ⇒ 它们 import 的模块被改了，旧进程会**一直用内存里那份**。
    实测踩到（2026-10-16）：换了 `Scaper/me.json` 的 cookie 之后，应用里重建**稳定**判
    "登录态失效（302）"，而**另起一个进程**跑同一条抓取命令却是好的 —— 差别只在
    "这个长驻进程里的 `lib/me.py` 是哪一版 + 它缓存的是哪一份 me.json"。
    （`me.json` 那一半已在 `lib/me.py` 里按文件 (mtime, size) 失效修掉了；这里管**代码**那一半。）

    ★ **兄弟模块也要收**（2026-10-16 补，审计翻出来的）：步骤常常 import **同目录**的模块 ——
      各 Scaper 适配器都 `add_crate_path()` 之后 `from crate import Crate`，而 `crate.py` 住
      `scripts/`；只盯"步骤脚本 + 它的 `lib/`"时，改 `scripts/crate.py` **既不重启、指纹也不变**
      （症状与上面那条一模一样）。所以把**步骤脚本自己的目录**也按 `lib/` 那样整目录收。

    ⚠️ 名单**算出来**、不手写：`build_chain.steps_for()` 是唯一那份步骤表；
    `lib/` 是那些脚本的同级依赖目录（`Scaper/lib` 与 `<渠道>/lib` 都收）。
    """
    try:
        import build_chain
        steps = build_chain.steps_for()
        root = os.path.dirname(os.path.dirname(os.path.abspath(server_file)))
    except Exception:                                             # noqa: BLE001 —— 算不出来就不盯，别把服务器带坏
        return []
    out = set()
    for step in steps:
        if step.kind != 'py':                                     # `cmd` 那些本来就是另起进程
            continue
        script = os.path.abspath(os.path.join(root, step.script))
        out.add(script)
        here = os.path.dirname(script)
        up = os.path.dirname(here)
        for d in (here, os.path.join(here, 'lib'), os.path.join(up, 'lib')):
            if os.path.isdir(d):
                out |= {os.path.join(d, f) for f in os.listdir(d) if f.endswith('.py')}
    return sorted(out)


def server_source_files(server_file):
    """本服务器由哪些 .py 组成（入口 + `devserver/` 模块 + 本进程内跑的构建步骤那一组，按名字排）"""
    here = os.path.dirname(os.path.abspath(server_file))
    files = [os.path.abspath(server_file)]
    pkg = os.path.join(here, 'devserver')
    if os.path.isdir(pkg):
        files += [os.path.join(pkg, f) for f in sorted(os.listdir(pkg)) if f.endswith('.py')]
    return files + build_source_files(server_file)


def build_running() -> bool:
    """现在有没有构建在跑 —— 有的话自重启要**等它跑完**（别把正在跑的构建掐断）。"""
    runner = getattr(NoCacheHandler, 'runner', None)
    if runner is None:
        return False
    try:
        return bool(runner.status().get('running'))
    except Exception:                                             # noqa: BLE001
        return False


def server_src_sha(server_file):
    """整组源文件的指纹（`/api/ping` 自报）—— 相对路径 + 内容一起进哈希"""
    h = hashlib.sha256()
    for path in server_source_files(server_file):
        try:
            with open(path, 'rb') as fh:
                data = fh.read()
        except OSError:
            continue
        h.update(os.path.relpath(path, os.path.dirname(os.path.abspath(server_file))).encode('utf-8'))
        h.update(b'\0')
        h.update(data)
    return h.hexdigest()[:12]



def source_sha(path):
    """本文件的内容指纹（`/api/ping` 自报，页面/人都能确认"跑的是哪一版服务器"）"""
    try:
        with open(path, 'rb') as fh:
            return hashlib.sha256(fh.read()).hexdigest()[:12]
    except OSError:
        return ''


def start_restart_watcher(server_file, httpd, info):
    """
    盯着**自己这组源文件**（入口 + `devserver/*.py`）：被改动过就自动重启。

    踩到的坑：改了 `dev-server.py`（加 `/api/*`）但旧进程还在跑 ——
    Python 不热加载，于是页面上有新按钮、服务器却不认识这个接口，只报 404，
    而"去重启一个后台进程"这件事根本不在人的直觉里。与其写一句提醒，不如让它自己重启。

    ⚠️ 重启前先 `compile()` 一遍新代码：正写到一半（语法错）就不重启，
    否则会把服务器带进"起不来"的循环里。
    """

    def stamps(files):
        out = []
        for one in files:
            try:
                out.append(os.stat(one).st_mtime)
            except OSError:
                out.append(0.0)                            # 编辑器换文件（保存中）—— 当成"变过"
        return tuple(out)

    def loop():
        files = server_source_files(server_file)
        stamp = stamps(files)
        while True:
            time.sleep(RESTART_POLL)
            current = stamps(files)
            if current == stamp:
                continue
            changed = [f for f, a, b in zip(files, stamp, current) if a != b]
            if build_running():
                # ⚠️ 有构建在跑：**先不动**，而且**不更新 `stamp`**（这一改下次轮询还会看到）
                #    —— 否则重启会把正在跑的构建掐断，而那次改动也就丢了。
                continue
            stamp = current
            time.sleep(0.4)                                # 等编辑器写完
            # ⚠️ 每个**改过的**文件都 `compile()` 一遍：正写到一半（语法错）就不重启，
            #    否则会把服务器带进"起不来"的循环里。（拆成多文件后不能只看入口那一个。）
            bad = None
            for one in changed:
                try:
                    with open(one, 'r', encoding='utf-8') as fh:
                        compile(fh.read(), one, 'exec')
                except SyntaxError as err:
                    bad = (one, getattr(err, 'lineno', '?'), err.msg)
                    break
                except OSError as err:
                    bad = (one, '?', str(err))
                    break
            if bad:
                sys.stderr.write('[dev-server] %s 有语法错误（第 %s 行），先不重启：%s\n'
                                 % (os.path.basename(bad[0]), bad[1], bad[2]))
                continue
            info['restarts'] = int(info.get('restarts', 0)) + 1
            sys.stderr.write('[dev-server] 检测到脚本已更新 ⇒ 自动重启（端口 %s）\n' % info.get('port'))
            sys.stderr.flush()
            sys.stdout.flush()
            try:
                httpd.server_close()
            except OSError:
                pass
            # `os.execv` 在 Windows 上是「起新进程 + 自己退出」，监听套接字随进程关闭。
            # 带上 `--takeover`：万一旧进程还没退干净、端口还被自己占着，新进程要能接管，
            # 而不是看到"已经有一个本服务器在跑"就自己退出（那就把服务器弄没了）。
            keep = [a for a in sys.argv[1:] if a not in ('--takeover', '--selftest')]
            os.execv(sys.executable, [sys.executable, server_file] + keep + ['--takeover'])

    threading.Thread(target=loop, daemon=True, name='dev-server-restart-watch').start()


def _pin_hashseed() -> None:
    """
    固定哈希盐（PYTHONHASHSEED=0）：不固定的话，set/dict 的迭代顺序每个进程都不一样
    ⇒ 包里的记录顺序（甚至某些"先到先得"的取值）会变，两次构建【逐字节不同】。
    盐必须在解释器启动前设好（运行时改不了），所以用 execv 换一个"固定盐的自己"。
    想要随机盐：设 ACM_NO_HASHSEED=1。
    """
    if os.environ.get('PYTHONHASHSEED') == '0' or os.environ.get('ACM_NO_HASHSEED') == '1':
        return
    os.environ['PYTHONHASHSEED'] = '0'
    # ★ 换新进程时也要把 **UTF-8 模式** 带上（2026-10-18）：`os.execv` 只传 `-B`，父进程的
    #   `-X utf8` 会丢 ⇒ 关掉 Windows「UTF-8 Beta」后（ACP=936）新进程按 GBK 打日志/中文。
    #   写进环境变量（execv 会继承）而不是只补参数：`启动AcmTree.bat` 与本处任一条路都覆盖。
    os.environ['PYTHONUTF8'] = '1'
    sys.stdout.flush()
    sys.stderr.flush()
    target = os.path.abspath(__file__)
    if os.name == 'nt' and ' ' in target:
        target = '"%s"' % target        # Windows 的 execv 只按空格拼接、不会自己加引号
    os.execv(sys.executable, [sys.executable, '-B', target] + sys.argv[1:])


def main():
    _pin_hashseed()      # 批处理在本进程跑适配器 ⇒ 盐必须从一开始就固定
    # 认参数：位置参数是 `[端口] [目录]`；`--xxx` 可以混在里面
    flags = set(a for a in sys.argv[1:] if a.startswith('--'))
    rest = [a for a in sys.argv[1:] if not a.startswith('--')]
    if '--selftest' in flags:
        return _selftest()
    port = int(rest[0]) if rest else DEFAULT_PORT
    # 默认服务本仓库根（与启动脚本的 cwd 无关，从哪儿跑都一样）
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    directory = os.path.abspath(rest[1]) if len(rest) > 1 else repo_root
    # 本机接口（一键重建总包）默认开；`ACM_NO_BUILD_API=1` 或 `--no-build-api` 关掉
    api_enabled = not (os.environ.get('ACM_NO_BUILD_API') == '1' or '--no-build-api' in flags)
    # 离线档（第三步走 `--offline`，不联网）；应用按钮发的还是联网那份
    offline = ('--offline' in flags) or (os.environ.get('ACM_BUILD_OFFLINE') == '1')
    # 自重启时带上 `--takeover`：此时端口上那个"还没退干净的自己"必须让位
    takeover = '--takeover' in flags

    if not os.path.isdir(directory):
        sys.stderr.write('[dev-server] 目录不存在: %s\n' % directory)
        return 1

    if port_in_use('127.0.0.1', port):
        mine = local_ping(port)
        if mine and not takeover and int(mine.get('api') or 0) >= API_VERSION:
            # 再双击一次启动脚本会走到这里：已经是我们的服务器（且够新）⇒ 不重复起
            print('[dev-server] 端口 %d 上已经有一个本服务器在跑（pid %s，接口 v%s）—— 不用再起一个。'
                  % (port, mine.get('pid'), mine.get('api')))
            print('[dev-server] 浏览器直接访问 http://127.0.0.1:%d/index.html 即可。' % port)
            return 0
        if mine:
            print('[dev-server] 端口 %d 上是**旧版本**的服务器（接口 v%s < v%d）⇒ 换掉它'
                  % (port, mine.get('api'), API_VERSION))
        else:
            print('[dev-server] 端口 %d 被占（应答的不是本服务器的 /api/ping）⇒ 试着腾出来' % port)
        freed, why = stop_python_on_port(port)
        print('[dev-server] %s' % why)
        if not freed:
            sys.stderr.write('[dev-server] 处理方式（任选其一）：\n')
            sys.stderr.write('[dev-server]   1) 手动关掉占端口的那个窗口，再跑一次启动AcmTree.bat\n')
            sys.stderr.write('[dev-server]   2) 换端口:  python scripts/dev-server.py %d\n\n' % (port + 1))
            return 1

    handler = functools.partial(NoCacheHandler, directory=directory)
    # 本机接口只在"这个目录确实是**机械层根**"时开（有 index.html + scripts/）
    # ⚠️ 别检查 `package.json`：它住在**仓库根**（机械层的上一层）—— 2026-10-17 机械层搬进
    #    `app/` 之后它就不在这儿了，检查它会让接口整个被判"不是仓库根"而关掉。
    api_ok = (os.path.isfile(os.path.join(repo_root, 'index.html'))
              and os.path.isdir(os.path.join(repo_root, 'scripts')))
    NoCacheHandler.runner = BuildRunner(repo_root, offline=offline)
    NoCacheHandler.package_path = build_chain.PACKAGE_PATH
    NoCacheHandler.api_enabled = bool(api_enabled and api_ok)
    server_file = os.path.abspath(__file__)
    NoCacheHandler.server_info = {
        'api': API_VERSION,
        'pid': os.getpid(),
        'port': port,
        'startedAt': time.time(),
        'srcSha': server_src_sha(server_file),        # 整组文件的指纹（拆分后）
        'restarts': 0,
        'apiEnabled': NoCacheHandler.api_enabled,
        'offline': offline,
        'steps': [s.key for s in NoCacheHandler.runner.steps],
    }
    try:
        httpd = ThreadingHTTPServer(('127.0.0.1', port), handler)
    except OSError as err:
        sys.stderr.write('\n[dev-server] 无法监听 127.0.0.1:%d —— %s\n\n' % (port, err))
        return 1

    watch = '--no-restart-watch' not in flags
    with httpd:
        print('[dev-server] 根目录: %s' % directory)
        print('[dev-server] 地址:   http://127.0.0.1:%d/index.html' % port)
        print('[dev-server] 缓存:   已禁用（no-store）')
        print('[dev-server] 版本:   api v%d  pid %d  源码 %s'
              % (API_VERSION, os.getpid(), NoCacheHandler.server_info['srcSha']))
        print('[dev-server] 自重启: %s' % ('已开（改本文件即自动重启）' if watch else '已关（--no-restart-watch）'))
        print('[dev-server] 本机接口: %s' % (
            '已开（应用里可一键重建总包：POST /api/build，进程内跑 build_chain）'
            if NoCacheHandler.api_enabled else '已关（--no-build-api / ACM_NO_BUILD_API=1）'))
        if watch:
            start_restart_watcher(server_file, httpd, NoCacheHandler.server_info)
        print('[dev-server] 按 Ctrl+C 停止')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n[dev-server] 已停止')
    return 0


if __name__ == '__main__':
    sys.exit(main())
