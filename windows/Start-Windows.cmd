@echo off
rem ALLMIND Windows first-run entry: installs both dependency trees from lockfiles,
rem builds, and starts the Book desktop entry. Fails fast; logs are written under
rem code\desktop-pet\.local\ (ignored by git).
setlocal
cd /d "%~dp0code\desktop-pet"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found on PATH. Install the Node.js LTS release from https://nodejs.org/, then run this shortcut again.
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found on PATH. Install the Node.js LTS release from https://nodejs.org/, then run this shortcut again.
  pause
  exit /b 1
)
node -e "const [maj,min]=process.versions.node.split('.').map(Number);process.exit(maj>22||(maj===22&&min>=12)?0:1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.12.0 or newer is required. Install the Node.js LTS release from https://nodejs.org/, then run this shortcut again.
  pause
  exit /b 1
)
if not exist ".local" mkdir ".local"
if not exist node_modules (
  echo Installing main project dependencies ^(npm ci^)...
  call npm.cmd ci > ".local\start-windows-install.log" 2>&1
  if errorlevel 1 (
    echo Main project dependency installation failed. See code\desktop-pet\.local\start-windows-install.log
    pause
    exit /b 1
  )
)
if not exist "management\character-ui\node_modules" (
  echo Installing management UI dependencies ^(npm ci^)...
  call npm.cmd --prefix management/character-ui ci > ".local\start-windows-ui-install.log" 2>&1
  if errorlevel 1 (
    echo Management UI dependency installation failed. See code\desktop-pet\.local\start-windows-ui-install.log
    pause
    exit /b 1
  )
)
echo Building and starting the ALLMIND Book desktop entry...
call npm.cmd run dev > ".local\start-windows-run.log" 2>&1
if errorlevel 1 (
  echo The desktop entry could not start. See code\desktop-pet\.local\start-windows-run.log
  pause
  exit /b 1
)
exit /b 0
