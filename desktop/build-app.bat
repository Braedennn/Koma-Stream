@echo off
title Build the Koma app
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is needed to build the app: https://nodejs.org
  pause
  exit /b 1
)
if exist dist\BUILD-OK.txt del dist\BUILD-OK.txt

echo.
echo   [1/3] Getting Electron (about 100 MB the first time)...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo.
echo   [2/3] Building Koma.exe...
node build.mjs
if errorlevel 1 goto fail

echo.
echo   [3/3] Adding Koma to your desktop and Start menu...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-shortcuts.ps1"

echo built> dist\BUILD-OK.txt
echo.
echo   Done! Koma is on your desktop and in the Start menu. Starting it now...
start "" "dist\Koma-win32-x64\Koma.exe"
timeout /t 5 >nul
exit /b 0

:fail
echo.
echo   The build failed. Scroll up for the error.
pause
exit /b 1
