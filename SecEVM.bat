@echo off
title SecEVM — Biometric Voting System
color 0B

echo.
echo  =========================================
echo   SecEVM — Biometric EVM Voting System
echo  =========================================
echo.

:: Move to project root
cd /d "%~dp0"

:: Check Node.js is installed
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Download it from https://nodejs.org/
    pause
    exit /b 1
)

:: Install fingerprint-server dependencies if not done yet
if not exist "fingerprint-server\node_modules" (
    echo  [SETUP] Installing fingerprint server dependencies...
    cd fingerprint-server
    npm install --silent
    cd ..
    echo  [SETUP] Dependencies installed.
    echo.
)

:: Start the unified launcher
echo  [START] Launching SecEVM...
echo  [INFO]  Frontend  -^>  http://localhost:3000
echo  [INFO]  Backend   -^>  http://localhost:5002
echo  [INFO]  Browser will open automatically.
echo.
echo  Press Ctrl+C to stop the server.
echo.

node start.js

pause
