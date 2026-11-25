# Ежедневный бэкап DarkArmy Dossier в Планировщике задач Windows.
# Запуск в PowerShell от администратора:
#   powershell -ExecutionPolicy Bypass -File deploy\install-backup-task.ps1
# Удалить:
#   Unregister-ScheduledTask -TaskName "DarkArmy Dossier Backup" -Confirm:$false

param(
  [string]$TaskName = "DarkArmy Dossier Backup",
  [string]$Time = "03:30",
  [int]$Keep = 7,
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js не найден в PATH." }
if (-not $Destination) { $Destination = Join-Path (Split-Path -Parent $root) "backups" }

$args = "`"$(Join-Path $root 'scripts\backup.js')`" --dest `"$Destination`" --keep $Keep"
$action = New-ScheduledTaskAction -Execute $node -Argument $args -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "DarkArmy Dossier: ежедневный бэкап БД, данных и проектов" -Force | Out-Null

Write-Host "Задача '$TaskName' установлена: ежедневно в $Time, хранить $Keep копий."
Write-Host "Проверить сейчас: Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Удалить: Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false"
