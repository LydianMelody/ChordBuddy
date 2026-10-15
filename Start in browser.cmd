@echo off
setlocal
cd /d "%~dp0"
echo Keep this window open while using Chord Buddy. Press Ctrl+C here to stop it.
"runtime\python.exe" "portable_start.py" --browser
if errorlevel 1 pause
