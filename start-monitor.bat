@echo off
REM ============================================================================
REM  start-monitor.bat  —  start the claude-router watchdog.
REM  Double-click to run. It launches monitor.js in a MINIMIZED, auto-restarting
REM  window: the monitor keeps the router (port 8123) alive; the loop keeps the
REM  monitor alive. Close the "claude-router-monitor" window to stop watching.
REM ============================================================================

if /i "%~1"=="worker" goto worker

REM ---- launcher: refuse to start a second monitor, else spawn the worker minimized ----
tasklist /v 2>nul | find /i "claude-router-monitor" >nul && (
  echo Monitor already running ^(window "claude-router-monitor"^). Nothing to do.
  timeout /t 3 >nul
  exit /b
)
start "claude-router-monitor" /min cmd /c ""%~f0" worker"
echo.
echo  claude-router watchdog STARTED (minimized window "claude-router-monitor").
echo  It auto-restarts the router if it dies, hangs, or crashes.
echo  To stop: close that minimized window.
echo.
timeout /t 3 >nul
exit /b

:worker
title claude-router-monitor
cd /d "%~dp0"
:loop
node monitor.js
echo [%date% %time%] monitor.js exited (code %errorlevel%) - relaunching in 3s...
timeout /t 3 /nobreak >nul
goto loop
