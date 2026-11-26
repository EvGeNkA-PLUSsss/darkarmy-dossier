# Secure reverse-tunnel: this PC's Ollama -> server loopback:11434
$ErrorActionPreference = 'Stop'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$key = if ($env:DARKARMY_BRIDGE_KEY) { $env:DARKARMY_BRIDGE_KEY } else { Join-Path $env:USERPROFILE '.ssh\darkarmy_ollama_bridge' }
$target = if ($env:DARKARMY_BRIDGE_TARGET) { $env:DARKARMY_BRIDGE_TARGET } else { 'ollama-bridge@147.45.78.20' }
$localPort = if ($env:DARKARMY_OLLAMA_PORT) { $env:DARKARMY_OLLAMA_PORT } else { '11434' }
if (!(Test-Path $ssh)) { throw "OpenSSH ssh.exe not found: $ssh" }
if (!(Test-Path $key)) { throw "Bridge key not found: $key" }
$args = @(
  '-i', $key,
  '-N',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-R', ('127.0.0.1:' + $localPort + ':127.0.0.1:' + $localPort),
  $target
)
$p = Start-Process -FilePath $ssh -ArgumentList $args -WindowStyle Hidden -PassThru
Write-Host "Ollama bridge started (PID $($p.Id)): $target -> localhost:$localPort"
