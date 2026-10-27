@echo off
rem Double-click to keep the game updated from GitHub and serve it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0play.ps1" %*
pause
