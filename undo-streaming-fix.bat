@echo off
title Undo streaming fix
cd /d "%~dp0"
rem Puts the streaming server's original mapper.ts back (from the .bak copy) and restarts everything.
copy /Y "Servers - DONT TOUCH\anivault-scraper\src\utils\mapper.ts.bak" "Servers - DONT TOUCH\anivault-scraper\src\utils\mapper.ts"
call "%~dp0restart-all.bat"
