# Build DarkArmyDossier.exe (.NET Framework launcher)
# Run from repo root: powershell -ExecutionPolicy Bypass -File desktop/launcher/build-exe.ps1
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path $csc)) { throw '.NET Framework csc.exe not found' }
$icon = Join-Path $root 'public\icons\app.ico'
if (!(Test-Path $icon)) { throw 'public/icons/app.ico not found' }
$outDir = Join-Path $root 'release'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir 'DarkArmyDossier.exe'
& $csc /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$icon" "/out:$out" `
  (Join-Path $PSScriptRoot 'Program.cs') /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Net.Http.dll
if ($LASTEXITCODE -ne 0) { throw 'csc failed' }
Get-Item $out | Select-Object FullName, Length
