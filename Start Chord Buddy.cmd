@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\pythonw.exe" (
  echo Open this launcher inside the built ChordBuddy-Portable folder.
  pause
  exit /b 1
)
start "" "runtime\pythonw.exe" "portable_start.py"
