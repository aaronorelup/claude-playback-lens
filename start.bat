@echo off
rem Claude Playback Lens — double-click to start (SPEC §9 / DESIGN §8).
rem /d matters: the install path can cross drives and contains spaces.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo This app needs Node.js, which was not found on this computer.
  echo Install it from https://nodejs.org ^(the LTS version is fine^),
  echo then double-click this file again.
  echo.
  pause
  exit /b 1
)

node "%~dp0lens.mjs" --serve --open %*
if errorlevel 1 pause
