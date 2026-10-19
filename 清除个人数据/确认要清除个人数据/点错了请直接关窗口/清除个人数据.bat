@echo off
rem ================================================================
rem  Wipe the "this is me" data out of this folder: credentials (me.json),
rem  submission / standings exports, and the raw scrape caches.
rem  Use it before handing the folder to someone else - and anyone who
rem  receives the folder can use the same file to wipe their own data.
rem
rem  Why it is buried this deep: it sits three folders below the repo
rem  root so a stray click cannot land on it by accident.
rem
rem  A double-click still changes NOTHING. It launches an interactive
rem  Node flow that asks three times: "go" right here, then a level
rem  (1/2/3), then "yes". Nothing is written before that final "yes".
rem
rem  Why this file is pure ASCII: cmd.exe mis-parses .bat files that
rem  print non-ASCII text out of a UTF-8 file (lines get split into
rem  commands, labels shift). All the Chinese text lives on the Node
rem  side, which handles Unicode properly.
rem  Only goto / single-line if below: parenthesised blocks demand
rem  CRLF line endings, and this file may get rewritten with LF.
rem
rem ================================================================

where node >nul 2>nul
if errorlevel 1 goto nonode

rem Hand over to the interactive flow (three gates: go / level / yes).
node "%~dp0..\..\..\app\scripts\clean-personal.mjs" --interactive
goto done

:nonode
echo [X] Node.js not found.
echo     Install it from https://nodejs.org and double-click this file again.

:done
echo.
pause
exit /b 0
