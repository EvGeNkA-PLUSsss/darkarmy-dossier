@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js не найден. Установите Node.js 20+ и повторите.
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo [WARN] .env не найден — создан из .env.example.
    echo        Отредактируйте SESSION_SECRET и PROJECTS_ROOT перед публикацией в интернет.
  ) else (
    echo [WARN] .env не найден, запускаю с настройками по умолчанию.
  )
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
