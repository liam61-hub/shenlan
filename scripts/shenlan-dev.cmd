@echo off
REM shenlan-dev - local dev launcher for shenlan CLI (CMD wrapper, ASCII only)
REM Usage: shenlan-dev [args...]  (build only when sources change, preserve caller cwd)
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\scripts\shenlan-dev.mjs" %*
