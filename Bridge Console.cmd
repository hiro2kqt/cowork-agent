@echo off
rem Double-click to start the Bridge Console (needs Node.js 20+). Close this window to stop it.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1)
title Bridge Console
node scripts\console.mjs %*
if errorlevel 1 pause
