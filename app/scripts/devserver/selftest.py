# ================================================================
# 服务器自测（scripts/devserver/selftest.py）
#
# 从 `dev-server.py` 拆出来的：105 项，含**真 socket** 上把 `/api/me`、
# 走一遍 —— 纯函数测不出"路由/动词有没有被接住"（踩过的坑：
# `SimpleHTTPRequestHandler` 没有 `do_PUT`，PUT 得到 501 而纯函数全绿）。
# ⚠️ 跑法：**在 `scripts/` 下** `python -m devserver.selftest`（相对 import 与
#    `selftest_kit` 都要那个 cwd）—— 现在 `npm test` 里的 `pythonSelftests.test.js`
#    会替你跑，不用记。
# ================================================================
import functools
import json
import os
import socket
import sys
import threading
import time
import types
from urllib.parse import parse_qs, urlsplit
from selftest_kit import Selftest
import build_chain
from .build_runner import BuildRunner, PROGRESS_RE, _hms, parse_build_body, parse_offline_flag
from . import auth_probe
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from .http_handler import (API_VERSION, NoCacheHandler, cors_origin_allowed,
                           read_app_build)
from .me_store import (ME_MAX_BYTES, ME_REL, file_sha256, me_read_file, me_write_file)
from . import roots
from .nature_store import (NATURE_MAX_BYTES, NATURE_REL, nature_read_file, nature_write_file)
from .nature_registry_store import (REGISTRY_REL, registry_read_file, registry_write_file)
from nature_registry_lib import registry_summary


def _minimal_registry(extra_class=False):
    """一份最小合法的性质注册表（自测夹具用；形状与仓库里那份同构）"""
    pre = {'official': {}, '无归类': {}, '未归类': {}, '上游异常': {}}
    if extra_class:
        pre['newbie'] = {}
    return {
        'registryVersion': 1,
        'note': ['自测夹具'],
        'fields': {
            'natureClass': {'label': '分类', 'kind': 'classPath'},
            'natureYear': {'label': '年份', 'kind': 'pattern', 'pattern': r'^(20\d{2}|无)$'},
        },
        'classTrie': {'xcpc': {'icpc': {'aa': {'pre': pre}}}},
    }
from .procutil import (image_of, is_python_image, parse_listeners,
                        parse_tasklist_image)


def _selftest_http(base_dir, ok):
    """
    在**真 socket**上把 `/api/me` 与 `/api/nature-assignments` 走一遍（自测用，不进产品路径）。

    为什么非要真打一次：纯函数测不出"路由/动词有没有被接住"。
    踩过的坑 —— `SimpleHTTPRequestHandler` 没有 `do_PUT`，
    于是 PUT 返回 `501 Unsupported method`（body 还是空的），而纯函数全绿。
    """
    root = os.path.join(base_dir, 'http-root')
    os.makedirs(root, exist_ok=True)                 # ⚠️ 先建出来：`repo_root()` 认的是真的路径
    # 夹具自己当"仓库根"：`roots.repo_root()` 是**向上找 `package.json`** ⇒ 这里放一个标记，
    # 否则它会一路窜到真仓库去，`/api/me` 的写入用例就会改用户真正的 `个人数据/me.json`
    # （★ 2026-10-17 真踩到：那次真的把用户的 me.json 覆盖掉了 —— 见 `roots.repo_root()` 的说明）。
    marker = os.path.join(base_dir, 'package.json')
    if not os.path.isfile(marker):
        with open(marker, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write('{}\n')
    me = os.path.join(roots.repo_root(root), ME_REL)
    # ★ 铁律：夹具写的东西**只许落在夹具目录里** —— 这条断言就是那次事故的判据
    if not os.path.abspath(me).startswith(os.path.abspath(base_dir) + os.sep):
        raise AssertionError(f'夹具的 me.json 跑到夹具目录外面去了：{me}（base_dir={base_dir}）'
                             ' —— 查 `roots.repo_root()` 与 base_dir 的标记文件')
    os.makedirs(os.path.dirname(me), exist_ok=True)
    with open(me, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump({'cf': {'handle': 'someone', 'apiKey': 'REAL-KEY-42'}}, fh, ensure_ascii=False)

    handler = functools.partial(NoCacheHandler, directory=root)
    saved = (NoCacheHandler.runner, NoCacheHandler.api_enabled,
             NoCacheHandler.package_path, getattr(NoCacheHandler, 'server_info', None))
    NoCacheHandler.runner = types.SimpleNamespace(root=root)     # `_me_path` 只用到 `.root`
    NoCacheHandler.api_enabled = True
    NoCacheHandler.package_path = ''
    NoCacheHandler.server_info = {'api': API_VERSION, 'pid': 0, 'port': 0, 'steps': []}
    httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True, name='selftest-http').start()

    def call(method, payload=None, body=None, path=ME_API_PATH_FOR_TEST):
        data = body if body is not None else (json.dumps(payload).encode('utf-8') if payload else None)
        req = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read().decode('utf-8')), dict(res.headers)
        except urllib.error.HTTPError as err:
            raw = err.read().decode('utf-8')
            try:
                return err.code, json.loads(raw), dict(err.headers)
            except ValueError:
                return err.code, {}, dict(err.headers)
        except OSError as err:
            # 服务端**在读完 body 之前**就回话并断开时，客户端读状态行/读 body 可能拿到
            # `WinError 10053`（连接被中止）。2026-10-18 查明这是**服务端的真 bug**，不是本测固有的
            # 竞态：405/400 那些"早退"原来不读 body 就回话+close，Windows 内核见到 recv 缓冲还有
            # 没读的数据就 RST。已由 `http_handler.py` 的 `_drain_body()` 修掉（回话前清缓冲）。
            # 这里仍留 `0` 这条分支只是**兜底**（真出现 ⇒ 说明 drain 被摘了，或者出现了新的早退路径）；
            # 断言现在是严的（`set(codes) == {400}` / `{405}`，连打多发），所以兜底不会把红灯藏起来。
            return 0, {'_aborted': str(err)}, {}

    try:
        code, got, _ = call('GET')
        ok(code == 200 and got.get('ok'), 'GET /api/me ⇒ 200（路由与动词真的接住了）')
        ok(got.get('doc', {}).get('cf', {}).get('apiKey') == 'REAL-KEY-42',
           '★ GET 回来的凭据**就是真值**（不打码）')
        ok('sentinel' not in got, '响应里没有 sentinel 那一套')
        sha = got.get('sha256')

        edited = got['doc']
        edited['cf']['handle'] = '改名了'
        code, out, _ = call('PUT', {'text': json.dumps(edited, ensure_ascii=False, indent=2), 'sha256': sha})
        ok(code == 200 and out.get('ok'), 'PUT /api/me ⇒ 200（不是 501/405）')
        with open(me, encoding='utf-8') as fh:
            disk = json.load(fh)
        ok(disk['cf']['handle'] == '改名了', '改过的字段真的落盘了')
        ok(disk['cf']['apiKey'] == 'REAL-KEY-42',
           '⚠️ 没碰的凭据**原样保住**（所见即所得：读到什么写回什么）')

        code, out, _ = call('PUT', {'text': json.dumps({'x': 1}), 'sha256': 'f' * 64})
        ok(code == 409 and out.get('ok') is False, 'sha256 对不上 ⇒ 409（且 body 是给人看的 JSON）')
        with open(me, encoding='utf-8') as fh:
            ok(json.load(fh)['cf']['handle'] == '改名了', '409 那次确实没动文件')
        code, out, _ = call('PUT', body=json.dumps({'text': '不是 json'}).encode('utf-8'))
        ok(code == 400, 'body 里的 text 不是 JSON ⇒ 400')
        code, out, _ = call('PUT', body=b'x' * (ME_MAX_BYTES + 100))
        # 服务端在 handler 层按 `Content-Length` 就挡住（`http_handler.py` 的 `_me_write`）。
        # 2026-10-18 之前这条只能要求"没被接受"（回话前不断开那个竞态会让客户端读到 0）；
        # 现在回话前会 `_drain_body()` 清缓冲 ⇒ **一定是 400**，所以连打 10 发，一发 0 都不许有
        # （这条就是那个竞态的守卫：谁把 `_drain_body()` 摘了，它当场红）。
        codes = []
        for _ in range(10):
            code, out, _ = call('PUT', body=b'x' * (ME_MAX_BYTES + 100))
            codes.append(code)
        ok(set(codes) == {400}, f'超大 body ⇒ 连着 10 发都是 400（挡住且客户端读得到回话）—— 实际 {codes}')
        code, got, _ = call('GET', None)
        ok(code == 200, '出错之后接口还能用（没把服务器带崩）')
        try:
            req = urllib.request.Request('http://127.0.0.1:%d/api/me' % port, method='OPTIONS',
                                         headers={'Origin': 'http://127.0.0.1:5500'})
            with urllib.request.urlopen(req, timeout=10) as res:
                allow = res.headers.get('Access-Control-Allow-Methods', '')
        except OSError as err:                                  # 同上：别让它把自测打成崩溃
            allow = ''
            ok(False, f'OPTIONS 预检请求本身失败：{err}')
        ok('PUT' in allow, '预检里放行 PUT（页面从别的端口打开时也能用）')

        # ★ 回代 baseline 那条路由也真打一次：**路由/动词接住了没有**只有真 socket 才测得出
        na = os.path.join(root, NATURE_REL)
        na_doc = {'format': 'nature-assignments', 'version': 1, 'generatedAt': '',
                  'registryVersion': 1, 'count': 1, 'fields': 1,
                  'assignments': [{'extKey': 'qoj:c:1', 'fields': {
                      'natureYear': {'v': '2020', 'rule': 'manual:set', 'src': 'manual'}}}]}
        code, got, _ = call('POST', {'doc': na_doc}, path='/api/nature-assignments')
        ok(code == 200 and got.get('ok'), 'POST /api/nature-assignments ⇒ 200（路由真的接住了）')
        code, got, _ = call('GET', None, path='/api/nature-assignments')
        ok(code == 200 and (got.get('doc') or {}).get('count') == 1, 'GET 读回刚写的那份')
        code, got, _ = call('POST', {'doc': {'format': 'nature-assignments', 'version': 1,
                                             'assignments': []}}, path='/api/nature-assignments')
        ok(code == 409 and got.get('needConfirm'),
           '★ 缩水 ⇒ 409 且带 needConfirm（页面据此问用户，再带 confirm 重发）')
        with open(na, encoding='utf-8') as fh:
            ok(json.load(fh)['count'] == 1, '409 那次没动盘上那份')

        # ★ 性质注册表那条路由也真打一次（**规则文件**：形状不过不写、sha 冲突拒绝）
        nr = os.path.join(root, REGISTRY_REL)
        os.makedirs(os.path.dirname(nr), exist_ok=True)
        with open(nr, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(_minimal_registry(), fh, ensure_ascii=False, indent=2)
        code, got, _ = call('GET', None, path='/api/nature-registry')
        ok(code == 200 and got.get('ok') and (got.get('summary') or {}).get('classPaths'),
           'GET /api/nature-registry ⇒ 200 + 概况（路由与动词真的接住了）')
        nr_sha = got.get('sha256')
        grew = json.loads(json.dumps(got['doc'], ensure_ascii=False))
        grew['classTrie']['xcpc']['icpc']['aa']['pre']['newbie'] = {}
        code, out, _ = call('PUT', {'doc': grew, 'sha256': nr_sha}, path='/api/nature-registry')
        ok(code == 200 and (out.get('diff') or {}).get('addedClassCount') == 1,
           '★ PUT /api/nature-registry ⇒ 200 + 差异（新增 1 条分类）')
        code, out, _ = call('PUT', {'doc': {'registryVersion': 1}, 'sha256': 'x' * 64},
                            path='/api/nature-registry')
        ok(code == 400 and 'fields' in (out.get('error') or ''),
           '★ 形状不过 ⇒ 400（不过不写）')
        code, out, _ = call('PUT', {'doc': grew, 'sha256': 'f' * 64}, path='/api/nature-registry')
        ok(code == 409, '★ sha256 对不上 ⇒ 409（不覆盖别人改过的规则文件）')
        # 405 也是"早退"：换动词那条路同样必须在回话前清掉 body（2026-10-18 之前这一项是
        # `npm test` 8 路并行下 1/113 的偶发红灯，根子在 `_drain_body()` 缺失，不在自测）。
        codes = [call('POST', {'doc': grew}, path='/api/nature-registry')[0] for _ in range(5)]
        ok(set(codes) == {405}, f'只支持 GET/PUT（POST ⇒ 405，连打 5 发都是）—— 实际 {codes}')
        with open(nr, encoding='utf-8') as fh:
            ok('newbie' in json.load(fh)['classTrie']['xcpc']['icpc']['aa']['pre'],
               '通过校验的那次真的落盘了')
    finally:
        httpd.shutdown()
        httpd.server_close()
        (NoCacheHandler.runner, NoCacheHandler.api_enabled,
         NoCacheHandler.package_path, server_info) = saved
        if server_info is not None:
            NoCacheHandler.server_info = server_info


def _selftest():
    """
    自测（`python -B scripts/dev-server.py --selftest`）。

    钉住"从 netstat/tasklist 里挑 PID"与"只杀 python"这两件**危险**事，以及
    "页面是不是旧代码"的判据 —— 都跑在纯函数上，不起服务器、不碰网络。
    """
    _st = Selftest('服务器')
    ok = _st.ok

    netstat = """
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    127.0.0.1:8000         0.0.0.0:0              LISTENING       4242
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1236
  TCP    [::]:8000              [::]:0                 LISTENING       777
  TCP    127.0.0.1:8000        127.0.0.1:52000        ESTABLISHED     9999
"""
    ok(parse_listeners(netstat, 8000) == [4242, 777],
       '只挑 LISTENING 的 PID（IPv4+IPv6），不挑已建立连接')
    ok(parse_listeners(netstat, 135) == [1236], '按端口过滤')
    ok(parse_listeners('', 8000) == [], '空输出不炸')
    ok(parse_listeners(netstat, '8000') == [4242, 777], '端口给字符串也认')

    tasklist = '"python.exe","4242","Console","1","12,345 K"\n"chrome.exe","777","Console","1","1 K"\n'
    ok(parse_tasklist_image(tasklist, 4242) == 'python.exe', '从 tasklist 里取映像名')
    ok(parse_tasklist_image(tasklist, 777) == 'chrome.exe', '第二个进程也能取到')
    ok(parse_tasklist_image(tasklist, 12345) == '', 'PID 不存在 ⇒ 空串')
    ok(is_python_image('python.exe') and is_python_image('pythonw.exe'), 'python 允许被杀')
    ok(not is_python_image('chrome.exe') and not is_python_image('node.exe') and not is_python_image(''),
       '别的程序 / 空名字一律不杀（"千万别删错"）')
    if os.name == 'nt':
        ok(image_of(os.getpid()).lower().startswith('python'),
           'Windows 原生接口能问出映像名（实测=%r；不依赖 tasklist 是否被挡）' % image_of(os.getpid()))

    ok(cors_origin_allowed('') and cors_origin_allowed('null'), '同源 / file:// 页面放行')
    ok(cors_origin_allowed('http://127.0.0.1:5500') and cors_origin_allowed('http://localhost:5500'),
       '本机回环 Origin 放行（页面从别的端口打开也能用按钮）')
    ok(not cors_origin_allowed('http://evil.example.com'), '外站不放行')
    ok(not cors_origin_allowed('http://127.0.0.1.evil.com'), '差不多的域名也不放行')

    # POST body 只认一个布尔（页面「档位」里的**离线那一档** ⇒ `offline:true`）
    ok(parse_offline_flag(b'{"offline": true}') is True, '离线档 ⇒ True')
    ok(parse_offline_flag(b'{"offline": false}') is False, '没勾 ⇒ False（不是 None）')
    ok(parse_offline_flag(b'{}') is None, '没给 offline ⇒ None（用启动时的默认档）')
    ok(parse_offline_flag(b'{"offline": "yes"}') is None, '非布尔一律忽略（页面传不了命令）')
    ok(parse_offline_flag(b'{"cmd": "rm -rf /"}') is None, '别的键一概不看')
    ok(parse_offline_flag(b'not json') is None and parse_offline_flag(None) is None, '坏 body / 空 body 不炸')
    ok(parse_offline_flag(b'{"offline": true}' + b' ' * 5000) is None, '超长 body 直接忽略')

    # ★ **重建档位**（主脚本建包不能手输指令 ⇒ 页面给一个档位选项）：
    #   页面能传的第二样东西 —— 一个**写死的档位名**，不是一个命令。
    got = parse_build_body(b'{"offline": true, "mode": "needs-low"}')
    ok(got == {'offline': True, 'mode': 'needs-low'}, f'两个键一起解析（实际 {got}）')
    ok(parse_build_body(b'{"mode": "probe-all"}') == {'offline': None, 'mode': 'probe-all'},
       '只给档位 ⇒ offline 仍是 None（用服务器默认档）')
    ok(parse_build_body(b'{"mode": 3}') == {'offline': None, 'mode': ''},
       '非字符串的 mode 忽略（**只认枚举名，不认命令**）')
    ok(parse_build_body(b'{"mode": "rm -rf /"}') == {'offline': None, 'mode': 'rm -rf /'},
       '⚠️ 认不出 ≠ 可执行：`mode` 只当字符串带出去，由 `mode_of()` 判、认不出就按标准档跑')
    ok(parse_build_body(b'{"cmd": "rm -rf /"}') == {'offline': None, 'mode': ''},
       '别的键一概不看（本机接口不接受任意参数）')
    # 档位表与服务端一致（键是跨语言契约：`src/features/AutoImport/buildApi.js` 的那份照抄这几个键）
    ok(list(build_chain.BUILD_MODES) == ['standard', 'needs', 'needs-low', 'probe-all', 'purge'],
       '服务器侧五个联网档位：标准 / 按需求补抓 / 连 low 一起 / 兜底重探 / 全删重爬'
       '（页面下拉框里还有第 6 个「离线重建」= offline:true + 标准档）')

    # ★ 档位要真的**进到 runner**（页面上选了、服务器却按标准档跑 = 这个选项白给）
    runner = BuildRunner(repo_root_guess(), mode='needs-low')
    ok(runner.mode == 'needs-low' and '多半拿不到' in runner.mode_label,
       '★ 档位进 runner：needs-low ⇒ 标签里写清"连多半拿不到一起"')
    ok([s for s in runner.steps if s.key == 'needs'][0].argv == ('--pursue', 'low'),
       '★ 档位的追值门槛落到链尾那步（needs-low ⇒ `--pursue low`）')
    ok(BuildRunner(repo_root_guess(), mode='乱填').mode == 'standard'
       and BuildRunner(repo_root_guess()).mode == 'standard',
       '认不出的档位 / 没给档位 ⇒ 回落 standard（不冒进，也不去删缓存）')
    ok(runner.status()['buildMode'] == 'needs-low'
       and runner.status()['buildModeLabel'] == runner.mode_label,
       '状态里报得出这一轮按哪个档位跑（界面标题就用它）')

    # ★ **长步骤要有"心跳"**（用户 2026-10-17："长时间没动静对新用户不友好"）：产包那步联网重抓，
    #   几分钟没有新行是正常的 —— 得有一行**事实型**的"还在动"，而且是硬证据（去 `acm-data/` 数文件），
    #   不是一句安慰话。三条一起钉：超门槛要给、没到门槛不给、它**不许进 `_lines`**（否则每秒轮询会堆成几百行）。
    r2 = BuildRunner(repo_root_guess(), mode='standard')
    with r2._lock:
        r2._running = True
        r2.started_at = time.time() - 120
        r2._state['crate'] = 'running'
        r2._step_started['crate'] = time.time() - 120
        r2._live_cache = (time.time(), 7)          # 假装"最近一分钟写了 7 个文件"（别真去 walk）
    hb = r2.status().get('heartbeat', '')
    ok(hb.startswith('⏳') and '第 ' in hb and '写了 7 个文件' in hb,
       '★ 心跳：运行中且超过门槛 ⇒ 给"第几步 / 已跑多久 / 最近写了几个文件"（实际 %r）' % hb)
    ok(all('⏳' not in x for x in r2._lines),
       '★ 心跳**不进** `_lines`（它只活在返回的那份副本里 —— 否则每秒轮询会把它越堆越多）')
    with r2._lock:
        r2._step_started['crate'] = time.time()    # 刚起步
    ok(r2.status().get('heartbeat', '') == '',
       '没到门槛 ⇒ 不给心跳（否则满屏废话，真出事反而看不见）')
    ok(_hms(35) == '35 秒' and _hms(412) == '6 分 52 秒' and _hms(3700) == '1 小时 1 分',
       '心跳里的时长写人话（秒 / 分 秒 / 小时 分）')

    # ★ **每步自己的进度（a/b）**（用户 2026-10-17："补充显示每步的进度(a/b)"）：
    #   长步骤（产包）自己喊一句 `⟨进度 37/186 场次⟩`（写法只有一处：`Scaper/lib/progress.py`），
    #   这一步就该把它抄进心跳。三条一起钉：**两边格式对得上**、有进度就带上、**没喊过不许编**。
    sys.path.insert(0, os.path.join(repo_root_guess(), 'acm-data', 'raw', 'Scaper', 'lib'))
    import progress as _progress                                 # noqa: E402
    ok(bool(PROGRESS_RE.search(_progress.line(37, 186, '场次'))),
       '★ 进度的写法与解析对得上（`progress.line()` 的输出必须被 `build_runner.PROGRESS_RE` 认出来）')
    with r2._lock:
        r2._state['crate'] = 'running'
        r2._step_started['crate'] = time.time() - 120
        r2._live_cache = (time.time(), 7)
    r2._append(_progress.line(37, 186, '场次'))                  # 假装产包那一步喊了一句
    hb2 = r2.status().get('heartbeat', '')
    ok('进度 37/186 场次' in hb2,
       '★ 这一步喊过进度 ⇒ 心跳里带上它（实际 %r）' % hb2)
    ok(r2.status()['steps'][[s['key'] for s in r2.status()['steps']].index('crate')]['progress']
       == [37, 186, '场次'],
       '状态里那一步也报得出进度（页面想在步骤列表里显示也有得用）')
    with r2._lock:
        r2._progress = {}                                        # 没喊过的那种步骤
    ok('进度' not in r2.status().get('heartbeat', ''),
       '★ 没喊过进度 ⇒ 心跳里**一个数都不编**（宁可少说）')

    # ★ **自重启盯的文件组要覆盖"本进程内跑的构建步骤那一组"**（实测踩到，2026-10-16）：
    #   换了 `me.json` 的凭据后重建**稳定**判过期，而另起进程跑同一条命令是好的 ——
    #   差别只在"那个长驻进程里的 `lib/me.py` 是哪一版"。文件组原来只盯
    #   入口 + `devserver/*.py`，于是改 `lib/me.py` 既不重启、指纹也不变。
    import importlib.util
    ds_path = os.path.join(repo_root_guess(), 'scripts', 'dev-server.py')
    _spec = importlib.util.spec_from_file_location('dev_server_mod', ds_path)
    _ds = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_ds)
    group = _ds.build_source_files(ds_path)
    ok(any(f.endswith(os.path.join('Scaper', 'lib', 'me.py')) for f in group),
       '★ 自重启的文件组含 `Scaper/lib/me.py`（链上步骤是在**本进程内** import 它的）')
    ok(any(f.endswith(os.path.join('lib', 'read_modes.py')) for f in group) and len(group) >= 10,
       '★ 也含 `lib/read_modes.py` 等（名单**从 `steps_for()` 算出来**，不是手写的一张表）')
    # ★ **步骤脚本同目录的兄弟模块也要收**（2026-10-16 补，审计翻出来的）：
    #   各 Scaper 适配器都 `from crate import Crate`，而 `crate.py` 住 `scripts/`
    #   ⇒ 只收"步骤脚本 + 它的 `lib/`"时，改 `scripts/crate.py` 既不重启、指纹也不变
    #   （症状与 `lib/me.py` 那个坑一模一样：旧进程一直用内存里那份）。
    ok(any(f.endswith(os.path.join('scripts', 'crate.py')) for f in group),
       '★ 文件组含 `scripts/crate.py`（适配器 import 的兄弟模块，不是 `lib/` 里的）')
    # ③ 真正被自重启/指纹用的是 `server_source_files()` ⇒ 那一份里也必须含有它
    #    （只测 `build_source_files()` 会漏掉"算出来了、但没并进去"这种半拉子改法）
    all_files = _ds.server_source_files(ds_path)
    ok(any(f.endswith(os.path.join('Scaper', 'lib', 'me.py')) for f in all_files),
       '★ `server_source_files()`（自重启与 `/api/ping` 指纹用的就是它）里含 `Scaper/lib/me.py`')
    ok(any(f.endswith('build_runner.py') for f in all_files)
       and all_files[0].endswith('dev-server.py'),
       '服务器自己的那组仍然在（加宽不等于替换）')

    tmp = os.path.join(repo_root_guess(), '.dev-server-selftest')   # 写仓库内（沙箱不给写系统 temp）
    try:
        os.makedirs(tmp, exist_ok=True)
        probe = os.path.join(tmp, 'A_constants.js')
        with open(probe, 'w', encoding='utf-8') as fh:
            fh.write("export const APP_BUILD = 'v9.9.9-探测';\n")
        ok(read_app_build(probe) == 'v9.9.9-探测', '从 A_constants.js 里读出磁盘上的 APP_BUILD')
        ok(read_app_build(os.path.join(tmp, '不存在.js')) == '', '读不到就空串（不是抛）')

        # ---- me.json 双通道：**原样读** / 受控写（设置页的底座）----
        # 不打码（页面隐藏 cookie 之类的完全没有必要）⇒ 这里钉
        # "读到什么就是什么 + 写回仍然是所见即所得，且三道闸（备份/sha/大小）一个不少"。
        me_doc = {'cf': {'handle': 'someone', 'apiKey': 'k-123', 'apiSecret': 's-456'},
                  'qoj': {'cookie': 'session=zzz; t=1'}, 'clist': {'username': 'someone',
                  'apiKey': 'c-789'},
                  'nk': {'byYear': {'2023': '某昵称'}, '_note': '这是说明，不是凭据'}}

        # ★ 2026-10-19（用户："me.json 应在为空时仍允许账户写入，否则初次建包信息无法填全"）：
        #   夹具有意把 `个人数据/` 这一层也**先留空** —— 第一次装 / 发布副本里就是这个形状。
        #   旧口径两条都错：读 ⇒ 404（页面整块空白，凭据一处都填不了）；
        #   写 ⇒ `open(…/个人数据/me.json.tmp-write)` 报 `[Errno 2]`（导入全量包时"树进来了、
        #   个人信息没写回"）。所以这里钉"文件不在 ≠ 出错"＋"首次写入顺手建目录"两件事。
        me_dir = os.path.join(tmp, '个人数据')
        me_path = os.path.join(me_dir, 'me.json')
        ok(not os.path.isdir(me_dir), '夹具有意：`个人数据/` 还不存在（第一次装就是这个形状）')
        code, out = me_read_file(me_path)
        ok(code == 200 and out['ok'] and out['exists'] is False and out['doc'] == {},
           '★ 文件不在 ⇒ 200 + 空文档 + exists=False（页面照常进可编辑状态，不是 404）')
        code, out = me_write_file(me_path, {'text': json.dumps(me_doc, ensure_ascii=False)})
        ok(code == 200 and os.path.isdir(me_dir) and os.path.isfile(me_path) and out['exists'],
           '★ 首次写入 ⇒ 连 `个人数据/` 一起建出来（旧写法在这里报 [Errno 2] .tmp-write）')
        ok(not os.path.exists(me_path + '.bak'),
           '首次写入没有"上一份"可备份 ⇒ 不产生空的 me.json.bak')
        code, out = me_read_file(me_path)
        ok(code == 200 and out['doc'] == me_doc and out['exists'] is True
           and len(out['sha256']) == 64,
           '★ GET：200 + **原样返回**（不打码）+ sha256 + exists=True')
        ok('sentinel' not in out, '响应里没有 sentinel 那一套（不打码）')
        first_sha = out['sha256']
        code, out = me_write_file(me_path, {'text': '{不是 JSON', 'sha256': first_sha})
        ok(code == 400 and 'JSON' in out['error'], '坏 JSON ⇒ 400，不写')
        code, out = me_write_file(me_path, {'text': '[1,2]', 'sha256': first_sha})
        ok(code == 400, '顶层不是对象 ⇒ 400')
        code, out = me_write_file(me_path, {'text': json.dumps({'a': 1}), 'sha256': 'x' * 64})
        ok(code == 409, 'sha256 对不上 ⇒ 409 冲突（不覆盖别人改过的文件）')
        ok(file_sha256(me_path) == first_sha, '上面这几种拒绝都真的没动文件')
        code, out = me_write_file(me_path, {'text': json.dumps({'a': 1}, ensure_ascii=False),
                                            'sha256': first_sha})
        ok(code == 200 and out['sha256'] != first_sha, '正常写入 ⇒ 200 + 新 sha')
        # ★ 2026-10-17 改的口径（用户拍板）：**写入前把上一份留成 `me.json.bak`**
        #   —— 旧口径"不要备份和它那套逻辑"的代价那天兑现了一次：一次自测事故把用户的真
        #   me.json 从 4969 字节覆盖成 73 字节，盘上与 git 里都没有副本。现在只留一档、覆盖式。
        with open(me_path + '.bak', encoding='utf-8') as fh:
            ok(json.load(fh) == me_doc, '★ 写入前留了 me.json.bak，内容是**改之前**那一份')
        with open(me_path, 'r', encoding='utf-8') as fh:
            ok(json.load(fh) == {'a': 1}, '正文就是传进去那份')
        ok(not os.path.exists(me_path + '.tmp-write'), '不留 .tmp-write 垃圾')
        code, out = me_write_file(me_path, {'text': 'x' * (ME_MAX_BYTES + 10)})
        ok(code == 400 and 'KB' in out['error'], '超大文本 ⇒ 400（手滑贴进几 MB 挡住）')

        # 所见即所得：读到的（含真凭据）原样写回去 ⇒ 一个字都不丢
        with open(me_path, 'w', encoding='utf-8', newline='\n') as fh:
            json.dump(me_doc, fh, ensure_ascii=False, indent=2)
        _c, got = me_read_file(me_path)
        edited = json.loads(json.dumps(got['doc'], ensure_ascii=False))
        edited['cf']['handle'] = 'NewHandle'
        code, out = me_write_file(me_path, {'text': json.dumps(edited, ensure_ascii=False),
                                            'sha256': got['sha256']})
        ok(code == 200, '改一格再写回 ⇒ 200')
        with open(me_path, 'r', encoding='utf-8') as fh:
            back = json.load(fh)
        ok(back['cf']['handle'] == 'NewHandle' and back['cf']['apiKey'] == 'k-123'
           and back['qoj']['cookie'] == 'session=zzz; t=1',
           '★ 改过的键写新的、**没碰的凭据原样保住**（所见即所得）')
        # ★ 那一档是**覆盖式**的：再写一次，`.bak` 里换成"上一次那份"（不是越滚越多份）
        with open(me_path + '.bak', encoding='utf-8') as fh:
            ok(json.load(fh)['cf']['handle'] == 'someone',
               '★ me.json.bak 是**改之前**那一份（覆盖式，只留一档）')

        # ---- 登录态探活：参数闸门 + 路径写死（**不联网**：这个夹具里没有那份脚本）----
        ok(auth_probe.parse_probe_body({'platform': 'QOJ'}) == ('qoj', []),
           '平台名小写化（页面大小写不敏感）')
        got = auth_probe.parse_probe_body({'platform': 'clist', 'overrides':
                                           {'clist.apiKey': 'k', 'clist.username': 'u'}})
        ok(got[0] == 'clist' and sorted(got[1]) == ['clist.apiKey=k', 'clist.username=u'],
           '覆盖值转成 `--set k=v`')
        for bad, why in (
            ({'platform': 'qoj; rm -rf /'}, '带分号的平台名'),
            ({'platform': ''}, '空平台名'),
            ({'platform': 'qoj', 'overrides': {'a b': 'x'}}, '键里有空格'),
            ({'platform': 'qoj', 'overrides': {'k': 'x' * 5000}}, '值超长'),
            ({'platform': 'qoj', 'overrides': {f'k{i}': 'x' for i in range(9)}}, '覆盖值太多条'),
            ({'platform': 'qoj', 'overrides': 'x'}, 'overrides 不是对象'),
        ):
            try:
                auth_probe.parse_probe_body(bad)
                ok(False, f'{why} 应该被拒')
            except ValueError:
                ok(True, f'{why} 被拒（页面传不了命令）')
        code, out = auth_probe.probe(tmp, {'platform': 'qoj'})       # tmp 里没有 auth_state.py
        ok(code == 500 and '找不到登录态判据' in out['error'],
           '那份判据不在 ⇒ 500 并说清（**不联网**，探活只在真仓库里跑）')
        ok(auth_probe.auth_state_path(repo_root_guess()).endswith(
            os.path.join('lib', 'auth_state.py')), '探针路径写死在服务器侧（页面传不了）')

        # ---- 回代 baseline 的**直接写盘**（**不写备份**；缩水默认 409、带 confirm 才写）----
        # 形状校验用的是**回代那份同款读法**（`nature_baseline_lib.parse_baseline`），
        # 缩水默认 409、带 confirm 才写；**不写 .bak**；原子替换不留半个文件。
        na_path = os.path.join(tmp, 'nature-assignments.json')

        def _baseline_doc(rows):
            return {'format': 'nature-assignments', 'version': 1,
                    'generatedAt': '2026-10-04T00:00:00.000Z', 'registryVersion': 1,
                    'count': len(rows), 'fields': sum(len(r['fields']) for r in rows),
                    'assignments': rows}

        def _row(key, field, value):
            return {'extKey': key, 'type': 'C', 'name': 'x',
                    'fields': {field: {'v': value, 'rule': 'manual:set', 'src': 'manual'}}}

        code, out = nature_read_file(na_path)
        ok(code == 200 and out['doc'] is None, '还没有那份文件 ⇒ 200 + doc=null（合法状态）')
        doc1 = _baseline_doc([_row('qoj:c:1', 'natureYear', '2020'),
                              _row('qoj:c:2', 'natureClass', 'qoj/xcpc/ccpc/final/official')])
        code, out = nature_write_file(na_path, {'doc': doc1})
        ok(code == 200 and out['diff']['added'] == 2 and out['diff']['removed'] == 0,
           '第一次写 ⇒ 200（新增 2）')
        with open(na_path, encoding='utf-8') as fh:
            ok(json.load(fh) == doc1, '正文就是传进去那份')
        ok(not os.path.exists(na_path + '.bak'), '★ **不写备份**（导出物，直接写入）')
        ok(not os.path.exists(na_path + '.tmp-write'), '不留 .tmp-write 垃圾')

        code, out = nature_write_file(na_path, {'doc': {'format': 'nature-assignments', 'version': 1}})
        ok(code == 400 and 'assignments' in out['error'], '缺 assignments ⇒ 400（形状过不了）')
        code, out = nature_write_file(na_path, {'doc': {'format': '别的', 'version': 1, 'assignments': []}})
        ok(code == 400 and 'format' in out['error'], 'format 不对 ⇒ 400（与回代同一套判据）')
        code, out = nature_write_file(na_path, {'doc': _baseline_doc([_row('qoj:c:1', 'natureYear', '')])})
        ok(code == 400, '空格子 ⇒ 400（与回代那份读法一字不差）')
        code, out = nature_write_file(na_path, {'doc': _baseline_doc(
            [_row('qoj:c:1', 'natureYear', '2021')])})
        ok(code == 409 and out.get('needConfirm') and out['diff']['removedKeys'] == ['qoj:c:2'],
           '★ **缩水且没确认 ⇒ 409**，把少了哪个 key 带回来')
        with open(na_path, encoding='utf-8') as fh:
            ok(json.load(fh) == doc1, '被拒时**真的没动文件**')
        code, out = nature_write_file(na_path, {'doc': _baseline_doc(
            [_row('qoj:c:1', 'natureYear', '2021')]), 'confirm': True})
        ok(code == 200 and out['diff']['changed'] == 1 and out['diff']['removed'] == 1,
           '★ 带 confirm ⇒ 照写，并把「变了 1 / 少了 1」报给页面')
        with open(na_path, encoding='utf-8') as fh:
            ok(json.load(fh)['assignments'][0]['fields']['natureYear']['v'] == '2021', '值真的改了')
        code, _out = nature_write_file(na_path, {'doc': doc1})
        ok(code == 200, '又涨回来 ⇒ 200（缩水才拦，不是"改了就要确认"）')
        ok(NATURE_REL.replace('\\', '/') == 'acm-data/nature-assignments.json',
           '路径写死在服务器侧（页面传不了文件名）')

        # ---- 性质注册表（`acm-data/nature-registry.json`）：**规则文件** ----
        # 判据是"形状"（`nature_registry_lib.parse_registry`，唯一一份）+ sha 冲突；
        # 它**在 git 里** ⇒ 不写 `.bak`（留底就是 git）。
        nr_path = os.path.join(tmp, 'nature-registry.json')
        code, out = registry_read_file(nr_path)
        ok(code == 404 and 'git' in out['error'],
           '★ 注册表缺了 ⇒ 404 且说清"它在 git 里"（不像 me.json 那样"缺了也合法"）')
        code, out = registry_write_file(nr_path, {'doc': _minimal_registry()})
        ok(code == 200 and out['summary']['classPaths'] == 4, '★ 正常写 ⇒ 200 + 概况（4 条分类叶子）')
        ok(not os.path.exists(nr_path + '.bak'), '★ **不写 .bak**（规则文件在 git 里，留底就是 git）')
        ok(not os.path.exists(nr_path + '.tmp-write'), '不留 .tmp-write 垃圾')
        nr_sha = out['sha256']
        broken = _minimal_registry()
        broken['classTrie']['xcpc']['icpc']['aa']['pre'].pop('无归类')
        code, out = registry_write_file(nr_path, {'doc': broken, 'sha256': nr_sha})
        ok(code == 400 and '特殊叶子' in out['error'], '★ 少了特殊叶子 ⇒ 400（形状判据唯一一份）')
        code, out = registry_write_file(nr_path, {'doc': {'registryVersion': 1}, 'sha256': nr_sha})
        ok(code == 400 and 'fields' in out['error'], '缺 fields ⇒ 400')
        code, out = registry_write_file(nr_path, {'doc': _minimal_registry(), 'sha256': 'x' * 64})
        ok(code == 409 and out.get('sha256') == nr_sha, '★ sha256 对不上 ⇒ 409（顺带回带磁盘上的情况）')
        with open(nr_path, encoding='utf-8') as fh:
            ok(json.load(fh) == _minimal_registry(), '上面这几种拒绝都真的没动文件')
        # `text` 也收（页面可能拿 JSON 框的原文直接发）；写完把差异回带给页面
        code, out = registry_write_file(nr_path, {
            'text': json.dumps(_minimal_registry(True), ensure_ascii=False), 'sha256': nr_sha})
        ok(code == 200 and out['diff']['addedClassCount'] == 1 and out['diff']['keptClassCount'] == 4,
           '★ 收 `text` 也行，并把「加了 1 条、留住 4 条」报出来')
        # 磁盘上那份被手工改坏 ⇒ 500 且**不写**（免得替人盖掉还能救的文件）
        with open(nr_path, 'w', encoding='utf-8') as fh:
            fh.write('{ 不是 JSON')
        code, out = registry_write_file(nr_path, {'doc': _minimal_registry()})
        ok(code == 500 and '不合法' in out['error'], '★ 磁盘上那份自己坏了 ⇒ 500 不写')
        ok(REGISTRY_REL.replace('\\', '/') == 'acm-data/nature-registry.json',
           '路径写死在服务器侧（页面传不了文件名）')

        # ---- 真起一个 HTTP 服务器，把 `GET/PUT /api/me` 走一遍 ----
        # 实测踩到的坑：`SimpleHTTPRequestHandler` **没有 `do_PUT`**，
        # 于是 PUT 得到的是 `501 Unsupported method`（body 还是空的，客户端只能瞎猜）。
        # 纯函数测不出这个 —— 必须在真 socket 上打一次。
        _selftest_http(tmp, ok)
    finally:
        import shutil as _shutil                                    # noqa: PLC0415
        _shutil.rmtree(tmp, ignore_errors=True)
        ok(not os.path.exists(tmp), '临时夹具清干净（不留垃圾）')

    return _st.done()


def repo_root_guess():
    """仓库根（⚠️ 本文件在 `scripts/devserver/` ⇒ 要往上**三层**）"""
    return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


#: 真 socket 那一段默认打哪条路由（`/api/me`；回代那条显式传 `path=`）
ME_API_PATH_FOR_TEST = '/api/me'


if __name__ == '__main__':
    # ⚠️ 入口叫 `_selftest`，**不是 `main`** —— 写成 `sys.exit(main())` 会一跑就 `NameError`，
    #    于是**那 55 项断言一项都不会执行**（守卫变异审计逮到"基线就跑不起来"）。
    #    同类的坑：没人 import 的 `.py` 里的 SyntaxError。
    #    跑法：在 `scripts/` 下 `python -m devserver.selftest`（相对 import + `selftest_kit` 都要这个 cwd）。
    sys.exit(_selftest())
