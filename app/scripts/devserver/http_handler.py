# ================================================================
# HTTP 处理器：路由 + 静态服务（scripts/devserver/http_handler.py）
#
# 从 `dev-server.py` 拆出来的：`NoCacheHandler` —— 给每个响应加
# `no-store`（**这就是这个服务器存在的理由**：不加的话浏览器会缓存 ES 模块，
# 出现"插件是新的、它 import 的那个模块是旧的"）、三条 `/api/*` 路由、CORS 与关键 MIME。
# ================================================================
import functools
import json
import os
import re
import sys
import build_chain
from .build_runner import BuildRunner, parse_build_body, parse_offline_flag
from . import auth_probe
from . import roots
import build_chain
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit
from .me_store import ME_MAX_BYTES, ME_REL, me_read_file, me_write_file
from .nature_store import NATURE_MAX_BYTES, NATURE_REL, nature_read_file, nature_write_file
from .nature_registry_store import (REGISTRY_MAX_BYTES, REGISTRY_REL, registry_read_file,
                                    registry_write_file)


#: 接口版本 —— 页面拿它比对（低版本 = 服务器是旧进程）
#: ⚠️ 放在这个文件里（而不是入口 `dev-server.py`）：拆包后 `selftest.py` 也要用它，
#:    而从入口 import 会成环（入口反过来 import selftest）。
#: **当前接口版本是 7**，包含以下路由：
#:   · `POST /api/build` 的 body 带 `mode`（**重建档位**，页面在界面上选、不必手输指令）
#:     ⇒ 不认 `mode` 的旧服务器会**静静地按标准重建**，所以必须靠版本号把它认出来
#:     （页面会提示"服务器是旧进程，重启一次 启动AcmTree.bat"）。
#:   · `GET /api/me` **不打码**（直给真值）+ `POST /api/auth-probe`（登录态探活）——
#:     不认这两条的旧服务器会给回 `<已隐藏>` 且探活 404，同样是"必须重启"的一件事。
#:   · `GET/POST /api/nature-assignments`（回代 baseline **直接写盘**，缩水默认 409 拒绝、
#:     确认后才写）⇒ 旧服务器不认这条路由（页面会退回到"下载一份"并提示重启）。
#:   · `POST /api/build/stop` 与状态里的 `stopRequested/canStop/stopped`（暂停）。
#:   · `GET/PUT /api/nature-registry`（**性质注册表**：形状不过 `nature_registry_lib`
#:     就 400、sha256 冲突 409）⇒ 旧服务器不认这条路由（性质注册表那一栏会提示重启）。
#:     ⚠️ 改这里必须**同时**改页面那份（`src/features/AutoImport/buildApi.js` 的 `API_VERSION`），
#:     否则页面会一直判"服务器是旧进程"。
API_VERSION = 7

#: 清空请求 body 时最多读掉多少（`_drain_body`）—— 只防"客户端谎报 Content-Length"时卡住
DRAIN_MAX_BYTES = 4 * 1024 * 1024

EXTRA_TYPES = {
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
}

# ================================================================
# 本机 API：让应用里能**一键重建总包 + 自动导入**
#
# 让应用里能**一键重建总包 + 自动导入**：应用里放个按钮直接触发建包步骤，建完再自动导入。
#
# ⚠️ 为什么必须是**这个本地服务器**来做：应用是纯前端、跑在浏览器里的，
#    它自己**没法**执行本机脚本。而这个服务器本来就是本机进程（`启动AcmTree.bat`
#    起的，只绑 127.0.0.1）⇒ 它自己就**是**"主脚本"：原料处理链在它进程内跑
#    （`scripts/build_chain.py`，与命令行 `scripts/build-all.py` 同一份步骤表）。
#
# 接口（同源**或**跨源都能用 —— 页面即使是从别的端口 / 双击 index.html 打开的，
# 只要本机这个服务器在跑，就能连上；见 `cors_origin_allowed`）：
#   GET  /api/ping    —— 探活 + **自报身份**（api 版本 / pid / 端口 / 根目录 / 源码指纹 /
#                        磁盘上的 APP_BUILD，用来判断"页面是不是旧代码"）
#   POST /api/build   —— 开始重建（已经在跑就返回 running，不重复起）；body 可带
#                        `{"offline": bool, "mode": "<重建档位>"}`（两样都是**枚举/布尔**，见下）
#   GET  /api/me      —— 读 `me.json`（**直给真值，不打码**：见 `me_store.py` 的文件头）
#                        + sha256/mtime（供设置页"表单 / JSON"双视图用）
#   PUT  /api/me      —— 写 `me.json`（**只认这一个文件**；先备份、mtime/sha 冲突就拒绝）
#   POST /api/auth-probe —— 探一次**登录态**（`{"platform":"qoj","overrides":{…}}`）：
#                        起 `Scaper/lib/auth_state.py --probe <平台>`，把它的输出原样带回去
#   GET  /api/nature-assignments —— 读磁盘上那份回代 baseline（`acm-data/nature-assignments.json`）
#   POST /api/nature-assignments —— 写它（**不备份**；**缩水默认 409 拒绝**，带 `confirm` 才写）
#   GET  /api/build   —— 状态：{running, startedAt, elapsed, code, steps[{key,title,state,seconds}],
#                        lines[尾部若干行], package:{mtime,bytes}, buildMode, buildModeLabel,
#                        stopRequested, canStop, stopped}
#   POST /api/build/stop —— **暂停**：登记一次"停"的请求，
#                        链子**跑完当前步**就停（绝不在写文件中途掐断 ⇒ 不会留下半个包）；
#                        停出来的退出码是 **0**（不是失败），`stopped: true` 与之区分。
#   POST /api/build   —— 开始重建（已经在跑就返回 running，不重复起）；body 可带离线布尔 + 档位
#
# ⚠️ **传不了命令、也传不了任意参数**（能传任意参数 = 本机任意命令执行）：页面只能传
#    ① 一个布尔（要不要 `--offline`）② `build_chain.BUILD_MODES` 里那**四个写死的重建档位**之一。
#    ⚠️ 页面下拉框里有 **5 个**预设 —— 第 5 个「离线重建」= `offline:true` + 标准档，
#    **协议没变**：仍然是这里这两个键。
#    跑哪几步由 `build_chain.steps_for()` 决定，档位只决定"要不要先按需求补抓、用哪个追值门槛"。
# ⚠️ 构建产物 `acm-data/nodes/all_nodes.json` 本来就在服务器根目录下，
#    应用直接 fetch 它即可（不用再开一个下载接口）。
# ================================================================

#: 接口版本 —— 页面拿它比对（低版本 = 服务器是旧进程）


LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1', '[::1]')
#: 启动时那个真 stdout（跑处理链时 `sys.stdout` 会被换成行回调，见 `BuildRunner._append`）


def cors_origin_allowed(origin):
    """
    这个 `Origin` 允许读 `/api/*` 的响应吗？

    - 没有 Origin（同源请求 / curl）⇒ 允许（浏览器也不看 CORS 头）；
    - `null`（`file://` 页面）⇒ 允许；
    - 本机回环地址 ⇒ 允许；
    - 其它站点 ⇒ **不允许**：本地接口虽只跑固定命令，但日志与仓库路径不该随便给外站看。
    """
    if not origin:
        return True
    if origin == 'null':
        return True
    try:
        host = urlsplit(origin).hostname or ''
    except ValueError:
        return False
    return host in LOCAL_HOSTS


def read_app_build(path):
    """从 `src/A_constants.js` 里读出磁盘上的 `APP_BUILD`（判断"页面是不是旧代码"的锚点）"""
    try:
        with open(path, 'r', encoding='utf-8') as fh:
            text = fh.read()
    except OSError:
        return ''
    found = re.search(r"APP_BUILD\s*=\s*'([^']+)'", text)
    return found.group(1) if found else ''


class NoCacheHandler(SimpleHTTPRequestHandler):
    """禁用缓存的静态文件处理器（+ 三个本机 API，见 `BuildRunner`）"""

    #: 由 `main()` 注入（`functools.partial` 不方便传两个额外参数）
    runner = None
    package_path = ''
    api_enabled = False
    #: 服务器身份（`/api/ping` 自报；`main()` 填）
    server_info = {}

    # ---- API ----
    def _cors(self):
        """
        给 `/api/*` 的响应该带哪个 Origin？

        页面可能压根不是这个服务器提供的（别的静态服务器 / 双击 index.html ⇒ Origin `null`），
        所以本机接口必须**自己**放行跨源，否则"按钮可用"就白绑在"页面必须由它提供"上。
        非本机的站点一律不放行：接口虽只跑固定命令，日志与仓库路径也不该给外站看。
        """
        origin = self.headers.get('Origin', '')
        if origin and cors_origin_allowed(origin):
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Vary', 'Origin')
            return True
        return False

    def _drain_body(self):
        """
        回话**之前**把客户端还没被读掉的请求 body 读干净。

        为什么必须做（2026-10-18 定位）：405/400 这类"早退"原来**不读 body 就回话并 close**。
        Windows 内核发现 recv 缓冲里还有没读的数据 ⇒ 连接直接 RST ⇒ 客户端读状态行时拿到
        `WinError 10053`，表现成"服务端明明回了 405，客户端却是 0"。
        这条竞态一直是 `npm test` 8 路并行下 1/113 的偶发红灯，自测那边只好把断言放宽成
        "0 也算没被接受"。根子在这里：先清缓冲再回话，客户端就一定能读到回话
        （断言因此可以恢复成严的，见 `devserver/selftest.py`）。
        """
        if getattr(self, '_body_consumed', False):
            return
        self._body_consumed = True
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return
        left = min(max(length, 0), DRAIN_MAX_BYTES)
        while left > 0:
            try:
                chunk = self.rfile.read(min(left, 65536))
            except OSError:
                return
            if not chunk:
                return
            left -= len(chunk)

    def _read_body(self, length):
        """读掉 `length` 字节的请求 body（同时记账：`_json` 就不会再清一遍）"""
        self._body_consumed = True
        return self.rfile.read(length)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self._drain_body()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _ping(self):
        """
        探活 + 自报身份。

        为什么要报这么多：**服务器进程不热加载新代码**（Python 本来就不热加载）与
        **页面还在用旧模块**这两件事，从页面上完全看不出来。现在页面可以把两条都判准：
          - `api` < 页面期望 ⇒ 服务器是旧的（重启/自重启即可）；
          - 页面带上自己的 `?build=`，与磁盘上的 `APP_BUILD` 一比 ⇒ 页面是旧的（刷新即可）。
        """
        want = (parse_qs(urlsplit(self.path).query).get('build') or [''])[0]
        disk_build = read_app_build(os.path.join(self.runner.root, 'src', 'A_constants.js'))
        info = dict(self.server_info)
        info.update({
            'ok': True,
            'root': self.runner.root,
            'diskBuild': disk_build,
            'pageBuild': want,
            'stalePage': bool(want and disk_build and want != disk_build),
            'rebuildRunning': self.runner.status(self.package_path).get('running', False),
        })
        self._json(info)

    def _api(self, method):
        path = self.path.split('?', 1)[0].rstrip('/')
        if not self.api_enabled:
            self._json({'ok': False, 'error': '本机接口没开（用 启动AcmTree.bat / '
                                              'python scripts/dev-server.py 启动才有）'}, 404)
            return True
        if path == '/api/ping':
            self._ping()
            return True
        if path == '/api/me':
            if method == 'PUT':
                self._me_write()
            elif method == 'GET':
                self._me_read()
            else:
                self._json({'ok': False, 'error': '只支持 GET（读）与 PUT（写整份文本）'}, 405)
            return True
        if path == '/api/auth-probe':
            if method == 'POST':
                self._auth_probe()
            else:
                self._json({'ok': False, 'error': '只支持 POST'}, 405)
            return True
        if path == '/api/nature-assignments':
            if method == 'POST':
                self._nature_write()
            elif method == 'GET':
                self._nature_read()
            else:
                self._json({'ok': False, 'error': '只支持 GET（看磁盘上那份）与 POST（写）'}, 405)
            return True
        if path == '/api/nature-registry':
            if method == 'GET':
                self._registry_read()
            elif method == 'PUT':
                self._registry_write()
            else:
                self._json({'ok': False, 'error': '只支持 GET（读）与 PUT（写整份文档）'}, 405)
            return True
        if path == '/api/build/stop':
            # ★ **暂停**：页面按一下 ⇒ 置标志，链子**跑完当前步**就停。
            #   `accepted=False` 表示当时没在跑（页面上那按钮本来也不该在）—— 不是错误。
            if method != 'POST':
                self._json({'ok': False, 'error': '只支持 POST（登记一次"停"的请求）'}, 405)
            else:
                accepted = self.runner.request_stop()
                self._json({'ok': True, 'accepted': accepted,
                            'status': self.runner.status(self.package_path)})
            return True
        if path == '/api/build':
            if method == 'POST':
                opts = self._read_build_options()
                started = self.runner.start(offline=opts['offline'], mode=opts['mode'])
                self._json({'ok': True, 'started': started,
                            'status': self.runner.status(self.package_path)})
            else:
                self._json({'ok': True, 'status': self.runner.status(self.package_path)})
            return True
        return False

    def _me_path(self):
        # ⚠️ `个人数据/` 按**仓库根**解析（它在机械层 `APP_ROOT` 外面）—— 见 `roots.py` 文件头
        return os.path.join(roots.repo_root(self.runner.root), ME_REL)

    def _me_read(self):
        """GET /api/me —— 原样返回那份文档 + 指纹（sha/mtime），给设置页双视图用"""
        code, payload = me_read_file(self._me_path())
        self._json(payload, code)

    def _me_write(self):
        """PUT /api/me —— 只认"整份 JSON 文本"，其余全在 `me_write_file` 里把关"""
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > ME_MAX_BYTES:
            self._json({'ok': False, 'error': 'body 空或超过 %d KB' % (ME_MAX_BYTES // 1024)}, 400)
            return
        raw = self._read_body(length)
        try:
            payload = json.loads(raw.decode('utf-8', 'replace'))
        except ValueError as err:
            self._json({'ok': False, 'error': 'body 不是 JSON：%s' % err}, 400)
            return
        code, out = me_write_file(self._me_path(), payload)
        self._json(out, code)

    # ---- 回代 baseline（`acm-data/nature-assignments.json`）：**直接写盘** ----
    def _nature_path(self):
        return os.path.join(self.runner.root, NATURE_REL)

    def _nature_read(self):
        """GET /api/nature-assignments —— 磁盘上那份（不存在 ⇒ `doc: null`，那是合法状态）"""
        code, out = nature_read_file(self._nature_path())
        self._json(out, code)

    def _nature_write(self):
        """
        POST /api/nature-assignments —— 写回代 baseline（**不备份**，见 `nature_store.py` 文件头）。

        body 只认 `{"doc": <整份文档>, "confirm": bool}`；形状校验、缩水拒绝、原子替换
        都在 `nature_store.py` 里（路径写死 —— 页面传不了文件名）。
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > NATURE_MAX_BYTES:
            self._json({'ok': False, 'error': 'body 空或超过 %d KB'
                                              % (NATURE_MAX_BYTES // 1024)}, 400)
            return
        try:
            payload = json.loads(self._read_body(length).decode('utf-8', 'replace'))
        except ValueError as err:
            self._json({'ok': False, 'error': 'body 不是 JSON：%s' % err}, 400)
            return
        code, out = nature_write_file(self._nature_path(), payload)
        self._json(out, code)

    # ---- 性质注册表（`acm-data/nature-registry.json`）：规则文件，**形状不过不写** ----
    def _registry_path(self):
        return os.path.join(self.runner.root, REGISTRY_REL)

    def _registry_read(self):
        """GET /api/nature-registry —— 磁盘上那份 + 概况（`summary`）；缺了是 404（它在 git 里）"""
        code, out = registry_read_file(self._registry_path())
        self._json(out, code)

    def _registry_write(self):
        """
        PUT /api/nature-registry —— 写性质注册表。

        body 只认 `{"doc": <整份文档>, "sha256": "<载入时那份，可选>"}`（也收 `text`）；
        形状校验（唯一一份，`nature_registry_lib.parse_registry`）、sha256 冲突、大小上限、
        原子替换都在 `nature_registry_store.py` 里（路径写死 —— 页面传不了文件名）。
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > REGISTRY_MAX_BYTES:
            self._json({'ok': False, 'error': 'body 空或超过 %d KB'
                                              % (REGISTRY_MAX_BYTES // 1024)}, 400)
            return
        try:
            payload = json.loads(self._read_body(length).decode('utf-8', 'replace'))
        except ValueError as err:
            self._json({'ok': False, 'error': 'body 不是 JSON：%s' % err}, 400)
            return
        code, out = registry_write_file(self._registry_path(), payload)
        self._json(out, code)

    def _auth_probe(self):
        """
        POST /api/auth-probe —— 探一次某个平台的**登录态**。

        body 只认 `{"platform": "qoj", "overrides": {"qoj.cookie": "…"}}`（都可以为空）；
        参数校验与子进程都在 `devserver/auth_probe.py` 里（**路径写死、只允许标识符**）。
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            length = 0
        payload = {}
        if length > 0:
            if length > 64 * 1024:
                self._json({'ok': False, 'error': 'body 太大'}, 400)
                return
            try:
                payload = json.loads(self._read_body(length).decode('utf-8', 'replace'))
            except ValueError as err:
                self._json({'ok': False, 'error': 'body 不是 JSON：%s' % err}, 400)
                return
        code, out = auth_probe.probe(self.runner.root, payload if isinstance(payload, dict) else {})
        self._json(out, code)

    def _read_build_options(self):
        """
        读 POST body 里页面能传的**两样**东西：`{"offline": bool, "mode": "<重建档位>"}`。

        ⚠️ 页面**传不了命令、也传不了任意参数**：
          · `offline` 只在"两份写死的步骤表"里选一份（`build_chain.steps_for` 的第三步是
            `--force` 还是 `--offline`）；
          · `mode` 只是 `build_chain.BUILD_MODES` 里那**四个写死的档位**之一
            （标准 / 按需求补抓 / 连 low 一起 / 兜底全重爬），每个档位对应命令行的一组开关。
            ⚠️ 页面下拉框里的第 5 个「离线重建」**不是**一个新的 `mode`，而是 `offline:true` +
            标准档（页面侧的一个预设）—— 所以这里两个键的协议没变。
        别的键、非字符串的 `mode` 一律忽略（不进日志、不影响执行）。
        """
        try:
            length = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            return {'offline': None, 'mode': ''}
        if length <= 0 or length > 4096:                    # 没 body / 离谱的大 body ⇒ 用默认档
            return {'offline': None, 'mode': ''}
        try:
            return parse_build_body(self._read_body(length))
        except OSError:
            return {'offline': None, 'mode': ''}

    def do_OPTIONS(self):
        """预检（目前页面发的是"简单请求"用不到，留着免得将来加自定义头像被挡）"""
        if not self.path.startswith('/api/'):
            self.send_error(404)
            return
        self.send_response(204)
        if self._cors():
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')
            self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        if self.path.startswith('/api/') and self._api('POST'):
            return
        self.send_error(404)

    def do_GET(self):
        if self.path.startswith('/api/') and self._api('GET'):
            return
        super().do_GET()

    def do_PUT(self):
        """
        PUT 只给 `/api/me` 用（改磁盘上的 me.json）。

        ⚠️ 必须自己实现：`SimpleHTTPRequestHandler` 没有 `do_PUT`，
        不写这个方法会得到 **501 Unsupported method**（实测踩到）。
        非 `/api/` 的 PUT 一律按 404 处理 —— 本服务器不提供任何"写文件"的通用入口。
        """
        if self.path.startswith('/api/') and self._api('PUT'):
            return
        self.send_error(404)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def log_message(self, fmt, *args):
        # 默认日志太吵；只报错误
        status = args[1] if len(args) > 1 else ''
        if isinstance(status, str) and status.startswith(('4', '5')):
            sys.stderr.write('[dev-server] %s %s\n' % (self.address_string(), fmt % args))
