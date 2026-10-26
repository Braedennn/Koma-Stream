@echo off
title Koma
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Koma needs Node.js, which isn't installed on this PC.
  echo   Opening the download page: install the LTS version, then double-click start.bat again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

set OPEN=1
node server.js
echo.
echo   Koma has stopped.
pause
