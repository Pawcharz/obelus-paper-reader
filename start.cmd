@echo off
rem Builds and starts Paper Reader, installing its dependencies on the first run.
cd /d "%~dp0"
where npm >nul 2>nul || (echo Node.js was not found. Install it from https://nodejs.org/ and try again. & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies... & call npm ci || (pause & exit /b 1))
call npx electron-vite build || (pause & exit /b 1)
call npx electron .
