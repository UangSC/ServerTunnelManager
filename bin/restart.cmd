@echo off
setlocal
call "%~dp0stop.cmd"
if errorlevel 1 exit /b %errorlevel%
call "%~dp0start.cmd" %*
exit /b %errorlevel%
