import urllib.error
import urllib.request
# ================================================================
# 端口 / 进程工具（scripts/devserver/procutil.py）
#
# 从 `dev-server.py` 拆出来的：找端口占用 → 挑 PID → **只杀 python**，
# 以及探活（`local_ping`）。⚠️ 这里全是"危险动作"：自测特意钉住了挑选判据
# （只挑 LISTENING、只认 python.exe/pythonw.exe/py.exe）。
# ================================================================
import json
import os
import re
import socket
import subprocess
import time
from urllib.parse import parse_qs, urlsplit


def port_in_use(host, port):
    """
    主动连接探测端口是否已被监听。

    不能依赖 bind 失败来判断：Windows 下 SO_REUSEADDR 允许在已被占用的
    端口上再次绑定，结果是两个服务器抢答，且旧的（无 no-store）仍然生效，
    表现为"换了服务器但缓存问题依旧"，非常难查。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


# ================================================================
# 端口上那个"旧的我"（再双击一次启动脚本时的接管逻辑）
#
# 不把幂等/接管这件事丢给启动脚本，而是**主脚本自己**处理：再双击一次
# `启动AcmTree.bat` 时，如果端口上已经有一个本服务器，就：
#   - 版本够新 ⇒ 直接退出（让它继续服务，浏览器反正是连它）；
#   - 是旧版本（没有 /api/* 或接口版本低）⇒ 只杀 **python** 进程后接管。
# 端口上是别的程序则一个都不碰，照旧提示换端口。
# 去重只认映像名（tasklist / netstat），"千万别删错"。
# ================================================================

#: 允许被结束的映像名（只认 python；别的一律不碰）


PYTHON_IMAGES = ('python.exe', 'pythonw.exe', 'py.exe')


def parse_listeners(netstat_text, port):
    """
    从 `netstat -ano` 的输出里挑出**正在监听该端口**的 PID。

    样例行（列之间空格数不定）：
      `  TCP    127.0.0.1:8000    0.0.0.0:0    LISTENING    1234`
    """
    pids = []
    pattern = re.compile(r'^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$', re.IGNORECASE)
    for line in (netstat_text or '').splitlines():
        found = pattern.match(line)
        if not found or int(found.group(1)) != int(port):
            continue
        pid = int(found.group(2))
        if pid > 0 and pid not in pids:
            pids.append(pid)
    return pids


def parse_tasklist_image(csv_text, pid):
    """从 `tasklist /FO CSV /NH` 的输出里取该 PID 的映像名（小写）；找不到返回 ''"""
    for line in (csv_text or '').splitlines():
        parts = [p.strip().strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[1].strip('"') == str(pid):
            return parts[0].strip('"').lower()
    return ''


def is_python_image(image):
    """这个映像名允许被我们结束吗（只认 python）"""
    return bool(image) and image.lower() in PYTHON_IMAGES


def local_ping(port, timeout=0.8):
    """本机这个端口后面是不是**本服务器**？是就返回它自报的身份（含 api 版本），否则 None"""
    url = 'http://127.0.0.1:%d/api/ping' % port
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            data = json.loads(res.read().decode('utf-8'))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return data if isinstance(data, dict) and data.get('ok') else None


def _run_capture(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return ''


def _run_ok(cmd):
    """跑一条命令，成功（退出码 0）返回 True（输出丢掉就行）"""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8',
                              errors='replace', timeout=15).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _image_via_winapi(pid):
    """
    用 Windows 原生接口问"这个 PID 的映像是谁"（不依赖外部命令）。

    为什么不只用 `tasklist`：它有被策略/权限挡掉的时候（本机沙箱里实测 "Access denied"），
    那时映像名是空的 ⇒ **谁都不敢杀**，接管这条腿就瘸了，用户看到的还是"换不掉旧进程"。
    `QueryFullProcessImageNameW` 只要 `PROCESS_QUERY_LIMITED_INFORMATION`，够用且稳。
    """
    if os.name != 'nt':
        return ''
    try:
        import ctypes
        from ctypes import wintypes
    except ImportError:
        return ''
    try:
        k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k32.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                                  wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
        k32.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k32.OpenProcess(0x1000, False, int(pid))       # QUERY_LIMITED_INFORMATION
        if not handle:
            return ''
        try:
            size = wintypes.DWORD(32768)
            buf = ctypes.create_unicode_buffer(32768)
            if not k32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                return ''
            return os.path.basename(buf.value).lower()
        finally:
            k32.CloseHandle(handle)
    except (OSError, AttributeError, ValueError):
        return ''


def image_of(pid):
    """这个 PID 的映像名（小写，如 `python.exe`）；两边都没答案 ⇒ `''`（调用方据此不动手）"""
    return _image_via_winapi(pid) or parse_tasklist_image(
        _run_capture(['tasklist', '/FI', 'PID eq %d' % pid, '/FO', 'CSV', '/NH']), pid)


def stop_python_on_port(port, log=print):
    """
    把端口上那个**我们自己的旧服务器**停掉。

    只杀 python 进程：端口上若是别的东西（用户自己开的别的服务），一个都不碰，
    交给调用方去提示换端口。
    """
    pids = parse_listeners(_run_capture(['netstat', '-ano']), port)
    if not pids:
        return True, '没找到监听进程（可能刚好退出了）'
    killed = []
    for pid in pids:
        image = image_of(pid)
        if not is_python_image(image):
            return False, '端口 %d 被 %s（PID %d）占着，不是 python —— 不动它' % (
                port, image or '认不出的程序（查不到映像名）', pid)
        if not _run_ok(['taskkill', '/PID', str(pid), '/F']) and not _run_ok(
                ['powershell', '-NoProfile', '-Command', 'Stop-Process -Id %d -Force' % pid]):
            return False, '杀不掉 PID %d（taskkill / Stop-Process 都不行）—— 手动关掉它的窗口再试' % pid
        killed.append('%s(PID %d)' % (image, pid))
    for _ in range(20):                       # 等端口真的空出来
        if not port_in_use('127.0.0.1', port):
            return True, '已停掉旧服务器：%s' % '、'.join(killed)
        time.sleep(0.2)
    log('[dev-server] 旧服务器（%s）还占着端口' % '、'.join(killed))
    return False, '旧服务器（%s）还占着端口' % '、'.join(killed)
