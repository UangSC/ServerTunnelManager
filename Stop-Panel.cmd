@echo off
setlocal
cd /d "%~dp0"
call "%~dp0bin\pwsh.cmd" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Panel.ps1"
if errorlevel 1 pause
