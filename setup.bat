@echo off
REM ESP32 DevOps MCP Server - Automated Setup
REM This script installs all dependencies and builds the MCP server

echo ========================================
echo   ESP32 DevOps MCP Server Setup
echo ========================================
echo.

REM Check Python
echo [1/5] Checking Python installation...
python --version >nul 2>&1
if %errorlevel% neq 0 (
    py --version >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] Python not found!
        echo Please install Python 3.x from https://python.org
        pause
        exit /b 1
    )
    set PYTHON_CMD=py
) else (
    set PYTHON_CMD=python
)
echo [SUCCESS] Python found

REM Check Node.js
echo.
echo [2/5] Checking Node.js installation...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js not found!
    echo Please install Node.js 18+ from https://nodejs.org
    pause
    exit /b 1
)
echo [SUCCESS] Node.js found

REM Install Python dependencies
echo.
echo [3/5] Installing Python dependencies...
%PYTHON_CMD% -m pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install Python dependencies
    pause
    exit /b 1
)
echo [SUCCESS] Python dependencies installed

REM Install npm dependencies
echo.
echo [4/5] Installing npm dependencies...
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install npm dependencies
    pause
    exit /b 1
)
echo [SUCCESS] npm dependencies installed

REM Build TypeScript
echo.
echo [5/5] Building MCP server...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)
echo [SUCCESS] Build complete

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo Next steps:
echo 1. Configure Claude Desktop (see INSTALL.md)
echo 2. Restart Claude Desktop
echo 3. Test with: "List ESP32 ports"
echo.
echo For help: josephreilly19@outlook.com
echo.

pause
