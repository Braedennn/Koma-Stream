@echo off
title Build the Koma installer
cd /d "%~dp0"

set "NSIS=%ProgramFiles(x86)%\NSIS\makensis.exe"
if not exist "%NSIS%" set "NSIS=%ProgramFiles%\NSIS\makensis.exe"
if not exist "%NSIS%" (
  echo.
  echo   NSIS wasn't found. Install it from https://nsis.sourceforge.io
  echo   (the app doesn't need it - only building the installer does)
  echo.
  pause
  exit /b 1
)
if not exist "dist\Koma-win32-x64\Koma.exe" (
  echo.
  echo   The app isn't built yet. Run build-app.bat first.
  echo.
  pause
  exit /b 1
)

echo.
echo   Packing Koma-Setup.exe - this compresses ~370 MB, give it a few minutes...
echo.
"%NSIS%" Koma.nsi
if errorlevel 1 (
  echo.
  echo   The installer build failed. Scroll up for the error.
  pause
  exit /b 1
)

echo.
echo   Done! The installer is at: desktop\dist\Koma-Setup.exe
echo   It installs per-user (no admin prompt), adds desktop and Start menu
echo   shortcuts, and lists itself in Add/Remove Programs.
echo.
explorer "dist"
exit /b 0
