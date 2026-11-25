@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js не найден. Установите Node.js 20+ и повторите.
  pause
  exit /b 1
)

if not exist ".env" (
  echo [SETUP] .env не найден — создаю локальный конфиг разработки.
  for /f "delims=" %%i in ('node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"') do set SECRET=%%i
  > ".env" echo NODE_ENV=development
  >> ".env" echo PORT=7561
  >> ".env" echo BIND_HOST=127.0.0.1
  >> ".env" echo SESSION_SECRET=!SECRET!
  >> ".env" echo PROJECTS_ROOT=F:/Проекты
  >> ".env" echo TRUST_PROXY=false
  echo [SETUP] Готово. Для публикации в интернет: NODE_ENV=production + HTTPS reverse proxy.
)

title DarkArmy Dossier
node --env-file=.env server.js
set EXITCODE=%ERRORLEVEL%
if not "%EXITCODE%"=="0" (
  echo.
  echo [ERROR] Сервер завершился с кодом %EXITCODE%.
  pause
)
exit /b %EXITCODE%
