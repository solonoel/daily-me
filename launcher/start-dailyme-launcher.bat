@echo off
:: ============================================================
:: Daily Me File Launcher — Self-Installing Setup
:: Run this once from anywhere (e.g. Downloads folder).
:: It will:
::   1. Create C:\Tools\DailyMe\
::   2. Download dailyme-launcher.js from dailyme.brunsusa.com
::   3. Copy itself there
::   4. Register as a Windows startup item
::   5. Start the launcher silently
:: ============================================================

setlocal

set INSTALL_DIR=C:\Tools\DailyMe
set LAUNCHER_JS=%INSTALL_DIR%\dailyme-launcher.js
set LAUNCHER_BAT=%INSTALL_DIR%\start-dailyme-launcher.bat
set LAUNCHER_URL=https://dailyme.brunsusa.com/launcher/dailyme-launcher.js
set STARTUP_NAME=DailyMeLauncher

:: ── Step 1: Check Node.js ────────────────────────────────────────────────────
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  Node.js is required but was not found.
    echo  Please install it from https://nodejs.org then run this file again.
    echo.
    pause
    exit /b 1
)

:: ── Step 2: Create install folder ────────────────────────────────────────────
if not exist "%INSTALL_DIR%" (
    mkdir "%INSTALL_DIR%"
    echo [Setup] Created %INSTALL_DIR%
)

:: ── Step 3: Download dailyme-launcher.js ─────────────────────────────────────
echo [Setup] Downloading launcher...
curl -s -o "%LAUNCHER_JS%" "%LAUNCHER_URL%"
if %errorlevel% neq 0 (
    echo.
    echo  Download failed. Please check your internet connection and try again.
    echo  URL: %LAUNCHER_URL%
    echo.
    pause
    exit /b 1
)
echo [Setup] Downloaded dailyme-launcher.js

:: ── Step 4: Copy this bat to install folder (if not already there) ───────────
if /i not "%~f0"=="%LAUNCHER_BAT%" (
    copy /y "%~f0" "%LAUNCHER_BAT%" >nul
    echo [Setup] Copied start-dailyme-launcher.bat to %INSTALL_DIR%
)

:: ── Step 5: Register Windows startup item ────────────────────────────────────
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
    /v "%STARTUP_NAME%" /t REG_SZ ^
    /d "\"%LAUNCHER_BAT%\"" /f >nul 2>&1
echo [Setup] Registered as Windows startup item.

:: ── Step 6: Launch silently via wscript (no console window) ──────────────────
set VBSFILE=%TEMP%\dm-launch.vbs
echo Set WshShell = CreateObject("WScript.Shell") > "%VBSFILE%"
echo WshShell.Run "node ""%LAUNCHER_JS%""", 0, False >> "%VBSFILE%"
wscript //nologo "%VBSFILE%"
del "%VBSFILE%" >nul 2>&1

echo.
echo  ============================================================
echo   Setup complete!
echo   Daily Me File Launcher is now running.
echo   It will start automatically each time you log in.
echo   You can close this window.
echo  ============================================================
echo.
timeout /t 6 /nobreak >nul
exit /b 0
