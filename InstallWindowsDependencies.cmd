@echo off
setlocal
cd /d "%~dp0"
title Chord Buddy - install Windows dependencies
echo.
echo  Chord Buddy: installing what it needs into this folder (nothing is installed elsewhere).
echo  It downloads a few GB the first time, so keep this window open. Safe to run again.
echo.
if not exist "runtime\python.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_bootstrap.ps1"
  if errorlevel 1 goto failed
)
"runtime\python.exe" "%~dp0install_windows_dependencies.py" %*
if errorlevel 1 goto failed
echo.
echo  All done.
goto end
:failed
echo.
echo  Not everything installed. The list above says which parts and why. Run this file again after fixing them.
:end
echo.
if /i not "%~1"=="--no-pause" pause
