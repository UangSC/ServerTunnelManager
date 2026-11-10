@echo off
setlocal
call "%~dp0pwsh.cmd" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0shortcuts.ps1" %*
exit /b %errorlevel%
