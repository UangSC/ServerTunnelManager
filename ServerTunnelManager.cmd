@echo off
call "%~dp0bin\pwsh.cmd" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0ServerTunnelManager.ps1"
if errorlevel 1 pause
