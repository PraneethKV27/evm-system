@echo off
title SecEVM - Biometric Voting System
color 0B

echo.
echo  =========================================
echo   SecEVM - Biometric EVM Voting System
echo  =========================================
echo.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Download it from https://nodejs.org/
    pause
    exit /b 1
)

echo  [SETUP] Checking ports 3000 and 5002...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5002" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
ping 127.0.0.1 -n 2 >nul

if not exist "fingerprint-server\node_modules" (
    echo  [SETUP] Installing backend dependencies - first run only...
    cd fingerprint-server
    call npm install --omit=dev
    if errorlevel 1 (
        echo  [ERROR] npm install failed. Check your internet connection.
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo  [SETUP] Dependencies installed.
    echo.
)

echo  [START] Launching SecEVM...
echo  [INFO]  Frontend  -^>  http://localhost:3000
echo  [INFO]  Backend   -^>  http://127.0.0.1:5002
echo  [INFO]  Browser will open automatically.
echo.
echo  IMPORTANT: Do NOT open index.html directly from the folder.
echo  Always use this SecEVM.bat file to start the app.
echo.
echo  Press Ctrl+C to stop the server.
echo.

node start.js
if errorlevel 1 (
    echo.
    echo  [ERROR] SecEVM failed to start. See messages above.
    pause
    exit /b 1
)

pause
