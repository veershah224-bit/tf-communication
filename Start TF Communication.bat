@echo off
title TF Communication Server
cd /d "%~dp0"
echo ============================================================
echo    Starting TF Communication...
echo ============================================================
echo.
echo    The shareable link(s) will appear below in a moment.
echo    Give the "Staff on your Wi-Fi" link to your team.
echo.
echo    KEEP THIS WINDOW OPEN while staff are using the app.
echo    To stop the app, close this window.
echo ============================================================
echo.
call npm start
echo.
echo    The server has stopped.
pause
