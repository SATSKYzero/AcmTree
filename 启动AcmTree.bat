@echo off
chcp 65001 >nul
rem ★ 让 Python 走 UTF-8 模式（2026-10-18）：它把 stdout/stderr **和 open() 的默认编码**
rem   都钉成 UTF-8，于是"控制台/管道里打 ✅ 会不会炸"与系统那个
rem   「Beta: 使用 Unicode UTF-8 提供全球语言支持」开不开**没关系**（关掉时 ACP 会变 936/GBK，
rem   而 GBK 里没有 ✅❌⚠️✔✘ℹ↳⟨⟩ ⇒ 打印第一行符号就 UnicodeEncodeError，实测 8 套自测全崩）。
rem   注意本窗口还要 chcp 65001（上一行）：那是给 cmd 自己读本文件与 echo 用的，两者是两件事。
set PYTHONUTF8=1
rem 用 %~dp0（本文件所在目录）而不是写死的绝对路径：整个目录复制到别的机器/别的盘也能双击起来。
cd /d "%~dp0"

rem 优先使用带 no-store 的开发服务器，避免 ES 模块被浏览器缓存
rem 导致「新插件 + 旧核心」的模块版本混合（表现为某个 api.xxx is not a function）
rem
rem ⚠️ 这里用 goto 而不是 if ... (...) else (...) —— 括号块要求 CRLF 行尾，
rem    一旦本文件被某个编辑器/工具改成 LF 行尾，cmd 会把分支解析错、
rem    静悄悄跑成 else 那条 `python -m http.server`（2026-10-02 实测：就是它
rem    让按钮一直 404、还叠出好几个抢答的 python.exe）。goto 对行尾不敏感。⚠️ 两段根：机械部分（index.html / src / scripts / acm-data）在 app\ 下，仓库根只放 package.json、个人数据\、作者专用\ ⇒ 兜底那条也必须 /d "%~dp0app"，否则列的是仓库根、入口 404。
if not exist "app\scripts\dev-server.py" goto fallback
start /min "" python "app\scripts\dev-server.py" 8321
goto opened

:fallback
start /min /d "%~dp0app" "" python -m http.server 8321

:opened
timeout /t 2 /nobreak >nul
start "" http://localhost:8321/index.html
