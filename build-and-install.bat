@echo off
REM ============================================================
REM DevNexus - Build and install locally into VS Code
REM ============================================================
REM Requires: Node.js 20+ (https://nodejs.org/), VS Code on PATH
REM Run from the repo root: build-and-install.bat
REM ============================================================

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo [1/4] Checking prerequisites...
where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js not found on PATH. Install Node 20+ from https://nodejs.org/
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm not found on PATH.
    exit /b 1
)
where code >nul 2>nul
if errorlevel 1 (
    echo ERROR: VS Code "code" CLI not found on PATH.
    echo   In VS Code: Ctrl+Shift+P then "Shell Command: Install 'code' command in PATH"
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   Node:     %%v
for /f "tokens=*" %%v in ('npm --version') do echo   npm:      %%v
for /f "tokens=*" %%v in ('code --version') do (
    echo   VS Code:  %%v
    goto :after_code_version
)
:after_code_version

echo.
echo [2/4] Installing npm dependencies (npm ci)...
if not exist node_modules (
    call npm ci
) else (
    echo   node_modules already present, skipping. Delete it to force reinstall.
)
if errorlevel 1 (
    echo ERROR: npm ci failed.
    exit /b 1
)

echo.
echo [3/4] Compiling TypeScript and packaging extension...
call npx --yes @vscode/vsce@^2.22.0 package --no-dependencies
if errorlevel 1 (
    echo ERROR: vsce package failed.
    exit /b 1
)

REM Find the produced .vsix (newest)
set "VSIX="
for /f "delims=" %%f in ('dir /b /o:-d devnexus-*.vsix 2^>nul') do (
    set "VSIX=%%f"
    goto :found_vsix
)
:found_vsix
if "%VSIX%"=="" (
    echo ERROR: No devnexus-*.vsix file found after packaging.
    exit /b 1
)
echo   Built: %VSIX%

echo.
echo [4/4] Installing %VSIX% into VS Code...
call code --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo ERROR: VS Code extension install failed.
    exit /b 1
)

echo.
echo ============================================================
echo  DevNexus installed. Reload VS Code, then use @nexus
echo  in Copilot Chat. Configure devnexus.jira.baseUrl and
echo  devnexus.bitbucket.baseUrl in Settings before first use.
echo ============================================================
endlocal
exit /b 0
