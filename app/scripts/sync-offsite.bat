@echo off
rem ================================================================
rem 异地备份同步（scripts/sync-offsite.bat）
rem
rem 谁在跑：Windows 计划任务 "AcmTree-offsite-sync"（每 30 分钟一次）。
rem         它按**你的用户身份**运行 ⇒ 不受 agent 沙箱限制、不弹任何批准。
rem 做什么：**只把本地已有的提交推一份到 `offsite`（E 盘那份裸仓库）** ——
rem         2026-10-17 起**两份都推**：规则那份（本仓库）与全量那份（`.git-full`），
rem         两者各有一个 offsite 远端（`AcmTree-backup.git` / `AcmTree-backup-full.git`）。
rem         ⚠️ **不提交、不改任何数据** —— 自动提交会把"写了一半"的状态固化进历史。
rem         提交仍然只发生在你双击 `保存快照.bat` 的时候。
rem 盘没接上 / 没配远端 / 本地没多出提交：静默跳过（不写日志，省得刷屏）。
rem 日志：%LOCALAPPDATA%\AcmTree\offsite-sync.log（只在真推了、或推失败时追加一行）
rem
rem 注册命令（已注册；换盘/重装系统后再跑一次）：
rem   schtasks /Create /F /TN AcmTree-offsite-sync /SC MINUTE /MO 30 ^
rem     /TR "wscript.exe //B <本目录>\sync-offsite-hidden.vbs"
rem （用 vbs 包一层是为了**不闪黑框**；直接挂 .bat 会每 30 分钟弹一个窗口）
rem ================================================================
setlocal
cd /d "%~dp0.."

set "LOG=%LOCALAPPDATA%\AcmTree\offsite-sync.log"

rem 仓库根从 git 问（本脚本住在 app\scripts\ ⇒ 上一层是 app\，不是仓库根）
set "TOP="
for /f "delims=" %%t in ('git rev-parse --show-toplevel 2^>nul') do set "TOP=%%t"
if "%TOP%"=="" exit /b 0

rem ---- ① 规则那份（本仓库）----
set "URL="
for /f "delims=" %%u in ('git remote get-url offsite 2^>nul') do set "URL=%%u"
if "%URL%"=="" goto full
if not exist "%URL%" goto full

rem 本地比异地多几条？0 条就什么都不做
set "AHEAD="
for /f "delims=" %%n in ('git rev-list --count offsite/main..main 2^>nul') do set "AHEAD=%%n"
if "%AHEAD%"=="" goto full
if "%AHEAD%"=="0" goto full

git push -q offsite main >nul 2>nul
if errorlevel 1 goto pushfailed
call :log "pushed %AHEAD% commit(s)"
goto full

:pushfailed
call :log "PUSH FAILED (ahead=%AHEAD%)"

:full
rem ---- ② 全量那份（.git-full）：同一套判据，别只推规则那份 ----
if not exist "%TOP%\.git-full\config" exit /b 0
set "FURL="
for /f "delims=" %%u in ('git --git-dir="%TOP%\.git-full" remote get-url offsite 2^>nul') do set "FURL=%%u"
if "%FURL%"=="" exit /b 0
if not exist "%FURL%" exit /b 0
set "FAHEAD="
for /f "delims=" %%n in ('git --git-dir="%TOP%\.git-full" rev-list --count offsite/main..main 2^>nul') do set "FAHEAD=%%n"
if "%FAHEAD%"=="" exit /b 0
if "%FAHEAD%"=="0" exit /b 0

git --git-dir="%TOP%\.git-full" push -q offsite main >nul 2>nul
if errorlevel 1 goto fullfailed
call :log "full pushed %FAHEAD% commit(s)"
exit /b 0

:fullfailed
call :log "FULL PUSH FAILED (ahead=%FAHEAD%)"
exit /b 1

:log
if not exist "%LOCALAPPDATA%\AcmTree" mkdir "%LOCALAPPDATA%\AcmTree" >nul 2>nul
>>"%LOG%" echo %DATE% %TIME%  %~1
exit /b 0
