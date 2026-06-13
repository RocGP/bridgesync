@echo off
title BridgeSync - Claude & VS Code Backup Tool
echo ========================================================
echo   BridgeSync: Claude Code & VS Code Migration Utility
echo ========================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed. Please download it from https://nodejs.org/
    pause
    exit /b 1
)

:: Install dependencies
if not exist "node_modules\" (
    echo Installing required Node.js packages (express, multer)...
    call npm install
)

:: Start the backend and open browser
echo.
echo Launching local server at http://localhost:3000 ...
start http://localhost:3000
echo.
echo Server running. Close this window to stop the BridgeSync tool.
echo ========================================================
node server.js
pause
