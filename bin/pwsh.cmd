@echo off
setlocal
where pwsh.exe >nul 2>nul
if errorlevel 1 (
  echo PowerShell 7.x is required. Install it from https://aka.ms/powershell and reopen this terminal. 1>&2
  exit /b 1
)
pwsh.exe %*
exit /b %errorlevel%
