import build_chain
# ================================================================
# 「重建总包」那条子进程（scripts/devserver/build_runner.py）
#
# 从 `dev-server.py` 拆出来的：`POST /api/build` 的**执行那一半** ——
# 在**本进程**里跑 `build_chain` 的步骤表、把日志按行攒给页面看、记录退出码。
# （所以"重建"不需要 npm → node → python 一串子进程。）
# ================================================================
import importlib
import json
import os
import re
import sys
import threading
import time


LOG_KEEP = 400
#: 自重启轮询间隔（秒）

#: "跑到哪儿了"那行的**解析**（写法只有一处：`acm-data/raw/Scaper/lib/progress.py`）。
#: ⚠️ 与那边的 `line()` 必须对得上 —— 守卫 `devserver/selftest.py` 拿它的输出喂给这条正则。
#: `⟨进度 37/186 场次⟩` ⇒ `(37, 186, '场次')`
PROGRESS_RE = re.compile(r'⟨进度\s+(\d+)\s*/\s*(\d+)\s*([^⟩]*)⟩')


_REAL_STDOUT = sys.stdout


def parse_build_body(raw, limit=4096):
    """
    从 `/api/build` 的 POST body 里解析页面能传的两样东西。

    **主脚本建包不能手输指令，所以给一个档位选项** ⇒ 页面能传
    `{"offline": bool, "mode": "<档位>"}`；档位的含义与合法性由 `build_chain.BUILD_MODES`
    说了算（这里**只做解析与类型检查**，不认识的值原样带出去、由 `BuildRunner` 判并写进日志）。

    @returns `{'offline': bool|None, 'mode': str}`（`None` = 页面没指定，用启动时的默认档；
             坏 JSON / 超长 body / 不是对象 ⇒ 两个都按"没指定"）
    """
    empty = {'offline': None, 'mode': ''}
    if not raw or not isinstance(raw, (bytes, bytearray)) or len(raw) > limit:
        return empty
    try:
        data = json.loads(bytes(raw).decode('utf-8'))
    except (ValueError, UnicodeDecodeError):
        return empty
    if not isinstance(data, dict):
        return empty
    out = dict(empty)
    if isinstance(data.get('offline'), bool):
        out['offline'] = data['offline']
    if isinstance(data.get('mode'), str):
        out['mode'] = data['mode'].strip()
    return out


def parse_offline_flag(raw, limit=4096):
    """
    从 `/api/build` 的 POST body 里解析出 `offline` 布尔开关（`parse_build_body` 的薄壳）。

    @returns `True` / `False`（页面明确指定）/ `None`（没指定、不是布尔、body 不像 JSON）
             —— `None` 表示"用服务器启动时那份默认档"。
    """
    return parse_build_body(raw, limit)['offline']


#: 「这一步跑太久、一行日志都没有」的门槛（秒）：超过它就往日志**尾部**补一行**事实型心跳**。
#: 为什么要它（用户 2026-10-17 原话：「长时间没动静对新用户不友好」）：产包那一步联网重抓，
#: 几分钟没有新行是**正常**的，可新用户只会以为卡死了。心跳里带"最近 N 秒真写了几个文件"
#: —— 那是**硬证据**（去 `acm-data/` 数一遍），不是一句安慰话。
HEARTBEAT_AFTER = 20.0
#: 活口探测的窗口（秒）
LIVE_WINDOW = 60
#: 活口探测最短间隔（秒）：`status()` 每秒被轮询，每次都 walk 一遍 `acm-data/`（几千个文件）太浪费 ⇒ 缓存
LIVE_MIN_GAP = 10.0


def _hms(sec):
    """`412.5` ⇒ `6 分 52 秒`（心跳里给人看的时长；不写小数、不写 `412.5s`）"""
    sec = int(max(0, sec))
    if sec < 60:
        return '%d 秒' % sec
    if sec < 3600:
        return '%d 分 %d 秒' % (sec // 60, sec % 60)
    return '%d 小时 %d 分' % (sec // 3600, (sec % 3600) // 60)


class BuildRunner:
    """
    后台跑一次整条原料处理链，把日志收进一个有上限的环形缓冲，供页面轮询。

    把整条原料处理脚本都并进主脚本，就根本不用这么复杂：
    这里**不起 npm / node / python 子进程**刮 stdout，而是直接调用
    `build_chain.run_chain()` —— 步骤表与命令行 `scripts/build-all.py` 共用一份，
    进度（跑到第几步、每步耗时/成败）是**结构化**的，不用从日志里猜。
    （唯一的例外是最后那步 node 校验，它本身就是 JS 工具，见 build_chain 的注释。）
    """

    def __init__(self, root, offline=False, mode=''):
        self.root = root
        self.offline = offline
        #: 「重建档位」（页面下拉框那个；空 ⇒ 默认档 `standard`）
        self.mode = build_chain.mode_of(mode)
        self.mode_plan = build_chain.mode_plan(self.mode)
        self.mode_label = self.mode_plan['label']
        # 启动时就带上这个档位的追值门槛（`start()` 里还会按需重算一次 ——
        # 按需求补抓之后可能多出 `--only-source`）
        self.steps = tuple(build_chain.steps_for(offline, '', self.mode_plan['pursue'],
                                                 prune=self.mode_plan.get('prune', False)))
        self._lock = threading.Lock()
        self._lines = []
        self._thread = None
        self._state = {}                 # key -> 'pending' | 'running' | 'ok' | 'fail' | 'skip'
        self._seconds = {}               # key -> 该步耗时
        #: key -> `(已做, 总数, 什么)` —— 这一步**自己喊过**的进度（见 `PROGRESS_RE`）。
        #: 进下一步时清掉（`on_phase`），免得新步骤顶着上一步的进度。
        self._progress = {}
        #: key -> 这一步**开始**的时刻（只给"当前步跑了多久"用）
        self._step_started = {}
        #: 活口探测的缓存 `(算的时刻, 文件数, 窗口秒数)` —— 见 `_liveness()`
        self._live_cache = None
        self._running = False
        self.started_at = 0.0
        self.finished_at = 0.0
        self.code = None
        # ★ **暂停**：页面按一下 ⇒ 置这个标志；
        #   链子**只在步骤边界**读它（`run_chain(should_stop=…)`）—— 绝不在写文件中途掐断。
        self._stop_requested = False
        self.stopped = False

    # ---- 只读快照 ----
    def request_stop(self):
        """
        页面按「⏸ 暂停」时调这个。

        ⚠️ **只在步骤边界生效**：链子正在跑的那一步会**跑完**（最长是产包 ~19 秒），
        然后停下 —— 这样绝不会在"写包/合并/回代"的中途掐断、留下半个包。
        返回是否成功登记（没在跑 ⇒ False，页面上那按钮本来也不该在）。
        """
        with self._lock:
            if not self._running:
                return False
            self._stop_requested = True
        return True

    def _should_stop(self):
        with self._lock:
            return bool(self._stop_requested)

    def status(self, package_path=''):
        with self._lock:
            lines = list(self._lines)
            state = dict(self._state)
            seconds = dict(self._seconds)
            progress = dict(self._progress)
            started, finished = self.started_at, self.finished_at
            code, running = self.code, self._running
            stop_requested, stopped = self._stop_requested, self.stopped
        info = {
            'running': running,
            # ★ **暂停**：页面靠这两个布尔决定按钮长什么样 ——
            #   `canStop` = 在跑且还没请求停 ⇒ 显示「⏸ 暂停」；
            #   `stopRequested` = 已经请求了、正在等当前步跑完 ⇒ 显示「正在停…（跑完当前步）」；
            #   `stopped` = 这一次**是被暂停结束的**（与"失败"分开，退出码是 0）。
            'stopRequested': stop_requested,
            'canStop': bool(running and not stop_requested),
            'stopped': stopped,
            'startedAt': started,
            'finishedAt': finished,
            'elapsed': round((time.time() - started), 1) if started and running else (
                round((finished - started), 1) if (started and finished) else 0),
            'code': code,
            # 给人看的一行命令
            'cmd': 'build_chain: ' + ' → '.join(s.key for s in self.steps),
            'mode': 'in-process',
            'offline': bool(self.offline),
            # 「重建档位」（页面下拉框）：键 + 人话标签（客户端只负责显示，不自己编标签）
            'buildMode': self.mode,
            'buildModeLabel': self.mode_label,
            'steps': [{'key': s.key, 'title': s.title, 'state': state.get(s.key, 'pending'),
                       'seconds': seconds.get(s.key, 0.0),
                       # 这一步自己喊过的进度 `[已做, 总数, 什么]`；没喊过就是 None（页面不许编）
                       'progress': list(progress[s.key]) if s.key in progress else None}
                      for s in self.steps],
            'lines': lines,
        }
        # ---- 「还在跑吗」的心跳：只加在**返回的那份副本**里（不进 `_lines`，否则会越积越多）----
        hb = self._heartbeat_line(state, running, started)
        if hb:
            info['lines'] = lines + [hb]
            info['heartbeat'] = hb
        if package_path and os.path.isfile(package_path):
            st = os.stat(package_path)
            info['package'] = {'mtime': int(st.st_mtime), 'bytes': st.st_size}
        return info

    def _liveness(self):
        """
        `acm-data/` 下**最近 `LIVE_WINDOW` 秒被写过的文件数**（硬证据：这一步真的在出活）。

        ⚠️ 每 `LIVE_MIN_GAP` 秒才真去数一遍（`status()` 每秒被页面轮询，几千个文件不该每秒 walk 一次）；
        数不到（目录不在/权限）⇒ 返回 `None`，心跳里就**不吹**这个数（宁可少说，不许瞎说）。
        """
        now = time.time()
        with self._lock:
            cached = self._live_cache
        if cached and now - cached[0] < LIVE_MIN_GAP:
            return cached[1]
        cut = now - LIVE_WINDOW
        n = 0
        try:
            for dirpath, dirnames, filenames in os.walk(os.path.join(self.root, 'acm-data')):
                dirnames[:] = [d for d in dirnames if d != '__pycache__']
                for fn in filenames:
                    try:
                        if os.path.getmtime(os.path.join(dirpath, fn)) >= cut:
                            n += 1
                    except OSError:
                        pass
        except OSError:
            return None
        with self._lock:
            self._live_cache = (now, n)
        return n

    def _heartbeat_line(self, state, running, started):
        """
        运行中、且**当前步已经跑了 `HEARTBEAT_AFTER` 秒以上**时，给一行事实型心跳；否则空串。

        它回答新用户唯一关心的问题："**它还在动吗**" —— 第几步、已跑多久、最近一分钟真写了几个文件。
        """
        if not running:
            return ''
        cur = [k for k, v in state.items() if v == 'running']
        if not cur:
            return ''
        key = cur[-1]                      # 同时挂多个 running 是历史脏数据，取最后一个（= 最新的）
        t0 = self._step_started.get(key) or started or time.time()
        el = time.time() - t0
        if el < HEARTBEAT_AFTER:
            return ''
        keys = [s.key for s in self.steps]
        title = next((s.title for s in self.steps if s.key == key), key)
        where = ('第 %d/%d 步' % (keys.index(key) + 1, len(keys))) if key in keys else '当前步'
        n = self._liveness()
        live = ('最近 %d 秒写了 %d 个文件' % (LIVE_WINDOW, n)) if n is not None else '（活口数不出来）'
        # 当前步自己喊过进度（`⟨进度 a/b 什么⟩`）就把它带上 —— 它比"第几步"更细；
        # 没喊过就**不编**（宁可不报，也不给一个假的分母）。
        with self._lock:
            prog = self._progress.get(key)
        done = ('｜进度 %s/%s%s' % (prog[0], prog[1], (' ' + prog[2].strip()) if prog[2].strip() else '')
                ) if prog else ''
        return ('⏳ %s「%s」还在跑：%s已 %s ｜ %s'
                % (where, title, done, _hms(el), live)
                + '　← 联网重抓那几步几分钟没有新行是正常的，看这一行就知道在不在动')

    def _append(self, line):
        """
        收进环形缓冲，同时打到服务器窗口（终端里也能看着跑）。

        ⚠️ 打印必须走**启动时那个真 stdout**（`_REAL_STDOUT`）：跑处理链时
        `sys.stdout` 被换成了行回调，用普通 `print` 会把这句话又送回自己，
        变成无限递归（实测报 `RecursionError: maximum recursion depth exceeded`）。
        """
        text = str(line)
        # 这一步自己喊的进度（`⟨进度 a/b 什么⟩`）：记在**当前 running 的那一步**名下。
        m = PROGRESS_RE.search(text)
        if m:
            with self._lock:
                cur = [k for k, v in self._state.items() if v == 'running']
                if cur:
                    self._progress[cur[-1]] = (int(m.group(1)), int(m.group(2)), m.group(3))
        with self._lock:
            self._lines.append(text)
            if len(self._lines) > LOG_KEEP:
                del self._lines[:len(self._lines) - LOG_KEEP]
        try:
            print('[build] ' + text, file=_REAL_STDOUT, flush=True)
        except (OSError, ValueError):          # 窗口被关掉之类，不影响构建
            pass

    def start(self, offline=None, mode=None):
        """
        开始重建。已经在跑 ⇒ 返回 False（不重复起）。

        @param offline - 本次是否走离线档（`--offline`，一次也不联网）。
                         `None` ⇒ 用启动时那份默认（`--offline` / `ACM_BUILD_OFFLINE=1`）。
                         ⚠️ 页面上它**不是独立勾选框**，而是「档位」下拉框里的一档 ——
                         页面的 5 个预设各自同时定下这个布尔与下面那个档位名。
        @param mode    - **重建档位**（`build_chain.BUILD_MODES` 的键；`None`/空 ⇒ 用启动时那份）。
                         这是页面**唯一**能传的两样东西（另一个是上面那个布尔）——
                         档位是一组**写死的预设**（标准 / 按需求补抓 / 连 low 一起 / 兜底全重爬），
                         页面传不了命令或任意参数。
        """
        want_offline = self.offline if offline is None else bool(offline)
        want_mode = self.mode if mode is None or mode == '' else mode
        # ⚠️ **每次起构建都重新加载步骤表**：`build_chain.py` 改了以后，服务器进程里还留着
        #    import 时那份旧代码（`dev-server.py` 只盯**自己**的 mtime 自重启）—— 于是
        #    "按钮少了新加的那一步"会悄悄发生（链尾加了体检/需求两步，
        #    而服务器里还是旧的那 5 步）。reload 让服务器不必重启。
        importlib.reload(build_chain)
        plan = build_chain.mode_plan(want_mode)
        with self._lock:
            if self._running:
                return False
            self.offline = want_offline
            self.mode = plan['key']
            self.mode_label = plan['label']
            self.steps = tuple(build_chain.steps_for(want_offline, '', plan['pursue']))
            self._lines = []
            self._state = {s.key: 'pending' for s in self.steps}
            self._seconds = {}
            self._step_started = {}
            self._progress = {}                    # 新的一次构建：进度也从零开始
            self._live_cache = None
            self._running = True
            self.started_at = time.time()
            self.finished_at = 0.0
            self.code = None
            # ★ **暂停标志必须在这里清掉**（每一次起构建都是**新的一次**）：
            #   上一次点过「⏸ 暂停」之后 `_stop_requested` 就一直是 True ——
            #   没有任何地方清它 ⇒ 下一次构建**在第一步之前**就被 `should_stop` 拦下。
            #   实测症状：日志写「已暂停：后面的步骤没跑」、耗时 **0.0s**、一步都没跑；
            #   页面上那颗按钮还会变成「正在停…」（`canStop` 也是拿这个标志算的）。
            self._stop_requested = False
            self.stopped = False

        def on_phase(step):
            with self._lock:
                # ⚠️ 上一步既然**还轮得到下一步**，那它一定是成功跑完了（失败会 `break`、warn 型归一成 0）
                #    —— 不把这些留在 `running`，否则状态里会同时挂着好几步 `running`（实测看到过 3 个）。
                for k, v in list(self._state.items()):
                    if v == 'running':
                        self._state[k] = 'ok'
                self._state[step.key] = 'running'
                self._step_started[step.key] = time.time()
                # 上一步喊过的进度**不能留给下一步**（否则新步骤顶着旧进度，看着像卡住）
                for k in list(self._progress):
                    if k != step.key:
                        del self._progress[k]
            self._append('=== %s ===' % step.title)

        def on_line(line):
            self._append(line)

        def worker():
            self._append('🚀 原料处理链（%d 步，%s；与命令行 scripts/build-all.py 同一份步骤表）'
                         % (len(self.steps), '离线' if self.offline else '联网'))
            # ⚠️ 给**第一次用**的人一句预期管理（用户 2026-10-17："长时间没动静对新用户不友好"）：
            #    联网重抓那几步本来就会几分钟没有新行 —— 先说明白，再靠下面那条 ⏳ 心跳证明"还在动"。
            self._append('⏱ 全程几分钟到十几分钟（联网档最慢；产包那一步是重抓所有来源）。'
                         '**中间长时间没有新行是正常的** —— 超过 %d 秒会多出一行 ⏳ 心跳，'
                         '写清"第几步 / 已跑多久 / 最近一分钟真写了几个文件"。'
                         % int(HEARTBEAT_AFTER))
            self._append('🎚 重建档位：%s —— %s' % (plan['label'], plan['hint']))
            if want_mode and plan['key'] != str(want_mode).strip():
                self._append('⚠️ 认不出档位 %r ⇒ 按默认档「%s」跑'
                             % (str(want_mode), plan['label']))
            # ★ **按需求补抓**那一段：
            #   先把该渠道的旧缓存丢掉、并定下"只重跑哪个来源"，再照常跑链子。
            #   ⚠️ 与命令行 `build-all.py --needs` 调的是**同一份**实现
            #   （`build_chain.needs_step_for`），两边不可能跑出不同的东西。
            only_source = build_chain.needs_step_for(plan, self.offline, on_line=on_line)
            steps = build_chain.steps_for(self.offline, only_source, plan['pursue'],
                                          prune=plan.get('prune', False))
            with self._lock:
                self.steps = tuple(steps)
                for step in steps:
                    self._state.setdefault(step.key, 'pending')
            try:
                results = build_chain.run_chain(steps, offline=self.offline,
                                                on_line=on_line, on_phase=on_phase,
                                                should_stop=self._should_stop)
            except BaseException as err:                               # noqa: BLE001 —— 报给页面看
                self._append('❌ 链子自己崩了：%s: %s' % (type(err).__name__, err))
                results = []
                failed = True
            else:
                failed = any(r.code != 0 for r in results)
            with self._lock:
                for result in results:
                    self._state[result.key] = 'skip' if (result.skipped or result.key == build_chain.STOPPED_KEY) else (
                        'ok' if result.code == 0 else 'fail')
                    self._seconds[result.key] = result.seconds
                # 没轮到的步骤保持 pending；有失败就把结束码定成那一步的
                bad = [r for r in results if r.code != 0]
                self.stopped = any(r.key == build_chain.STOPPED_KEY for r in results)
                # ★ **暂停不算失败**（退出码 0）：产物停在最后跑完那一步，链子幂等、随时重跑
                self.code = bad[0].code if bad else (1 if failed else 0)
                self._running = False
                self.finished_at = time.time()
            self._append('—— 结束（%s退出码 %s，耗时 %.1fs）'
                         % ('用户暂停，' if self.stopped else '', self.code,
                            self.finished_at - self.started_at))

        self._thread = threading.Thread(target=worker, daemon=True)
        self._thread.start()
        return True


#: 设置页要读写的那**唯一一个**文件（相对仓库根）。⚠️ 页面传不了路径 —— 路径写死在这儿。
