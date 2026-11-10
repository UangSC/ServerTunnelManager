@echo off
setlocal
call "%~dp0pwsh.cmd" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Start-Panel.ps1" %*
exit /b %errorlevel%
