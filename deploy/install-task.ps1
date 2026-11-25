# Установка автозапуска DarkArmy Dossier в Планировщике задач Windows.
# Запускать в PowerShell от имени администратора:
#   powershell -ExecutionPolicy Bypass -File deploy\install-task.ps1
# Удалить:
#   Unregister-ScheduledTask -TaskName "DarkArmy Dossier" -Confirm:$false

param(
  [string]$TaskName = "DarkArmy Dossier",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
}
if (-not $NodePath) { throw "Node.js не найден в PATH. Укажите -NodePath C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path (Join-Path $root ".env"))) {
  Write-Warning ".env не найден. Скопируйте .env.example в .env и заполните SESSION_SECRET/PROJECTS_ROOT."
}

$action = New-ScheduledTaskAction -Execute $NodePath -Argument "--env-file=.env server.js" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 0) `
  -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "DarkArmy Dossier: HTTP-сервис с автозапуском при старте системы" -Force | Out-Null

Write-Host "Задача '$TaskName' установлена."
Write-Host "Запуск:   Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Статус:   Get-ScheduledTask -TaskName '$TaskName' | Get-ScheduledTaskInfo"
Write-Host "Удаление: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
