@echo off
rem Открыть DarkArmy Dossier как отдельное окно приложения (Edge/Chrome --app).
rem Сервер должен быть запущен: start.bat или npm start.
setlocal
set URL=%DOSSIER_URL%
if "%URL%"=="" set URL=http://127.0.0.1:7561
set EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe
if not exist "%EDGE%" set EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe
if exist "%EDGE%" (
  start "" "%EDGE%" --app=%URL% --window-size=1440,900
  exit /b 0
)
set CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe
if exist "%CHROME%" (
  start "" "%CHROME%" --app=%URL% --window-size=1440,900
  exit /b 0
)
start "" "%URL%"
