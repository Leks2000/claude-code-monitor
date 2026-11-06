@echo off
rem Claude Code Monitor: start the background server if it is not running, then open the dashboard.
rem   start_monitor.bat           start + open http://127.0.0.1:8770
rem   start_monitor.bat --quiet   start only
powershell -NoProfile -Command "try{(New-Object Net.Sockets.TcpClient('127.0.0.1',8770)).Close();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
  start "" pythonw "%~dp0monitor.py"
  ping -n 4 127.0.0.1 >nul
)
if /i not "%1"=="--quiet" start "" http://127.0.0.1:8770
