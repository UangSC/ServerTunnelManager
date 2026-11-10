@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Panel.ps1"
if errorlevel 1 (
  echo.
  echo Tunnel Studio failed to start. See Panel\logs\server.err.log
  pause
)
