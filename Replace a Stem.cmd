@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\pythonw.exe" (
  echo Open this launcher inside the Chord Buddy folder.
  pause
  exit /b 1
)
start "" "runtime\pythonw.exe" "stem_tool_start.py"
