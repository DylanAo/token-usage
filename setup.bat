@echo off
setlocal
title Token Usage - Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [Error] Node.js not found.
    echo Install Node.js ^>=22.13 from https://nodejs.org then run this again.
    pause
    exit /b 1
)

wscript start-hidden.vbs "%~dp0"