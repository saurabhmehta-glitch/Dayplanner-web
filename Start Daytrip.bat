@echo off
title Daytrip static demo
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-static.ps1"
if errorlevel 1 (
  echo.
  echo Daytrip could not start. Check the error above.
  pause
)
