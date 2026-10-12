@echo off
REM ============================================================
REM PixelAgent company-machine environment fix
REM ------------------------------------------------------------
REM Why this exists: on a fresh Windows PC, pi (the backend that
REM actually reads files / runs commands) needs Git Bash.
REM Without it every file task fails - e.g. "cannot read the
REM USB drive". This script checks for Git Bash and installs
REM Git for Windows if it is missing.
REM
REM Messages are English on purpose: .cmd + Chinese text garbles
REM on GBK consoles. Just double-click and read the last line.
REM ============================================================
chcp 65001 >nul

echo === PixelAgent environment fix ===

echo [1/3] Checking Git Bash ...
if exist "C:\Program Files\Git\bin\bash.exe" goto found
if exist "C:\Program Files (x86)\Git\bin\bash.exe" goto found

echo   Git Bash NOT found. Installing Git for Windows ...
echo [2/3] Running: winget install Git.Git
where winget >nul 2>nul
if errorlevel 1 goto no-winget
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto winget-failed

echo [3/3] Re-checking ...
if exist "C:\Program Files\Git\bin\bash.exe" goto installed
if exist "C:\Program Files (x86)\Git\bin\bash.exe" goto installed
echo.
echo   STILL NOT FOUND after install. Try rebooting, then run again.
echo   Manual fallback: https://git-scm.com/download/win
pause
exit /b 1

:installed
echo.
echo   OK - Git Bash installed.
echo   Now: close PixelAgent completely, start it again,
echo   and retry the USB drive task.
pause
exit /b 0

:found
echo   Git Bash already present. Nothing to do.
pause
exit /b 0

:no-winget
echo.
echo   winget is not available on this machine.
echo   Install Git for Windows manually: https://git-scm.com/download/win
echo   (keep the default options; "Git Bash" component must stay checked)
pause
exit /b 1

:winget-failed
echo.
echo   winget install failed.
echo   Install Git for Windows manually: https://git-scm.com/download/win
echo   (keep the default options; "Git Bash" component must stay checked)
pause
exit /b 1
