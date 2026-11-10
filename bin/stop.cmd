@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\Stop-Panel.ps1" %*
exit /b %errorlevel%
