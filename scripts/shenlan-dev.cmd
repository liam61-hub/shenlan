@echo off
REM shenlan-dev - local dev launcher for shenlan CLI (CMD wrapper, ASCII only)
REM Usage: shenlan-dev [args...]  (incremental build, then run CLI with caller cwd)
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%"
call npm run build >nul
popd
node "%ROOT%\packages\cli\dist\index.js" %*
