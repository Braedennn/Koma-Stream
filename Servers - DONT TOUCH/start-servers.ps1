# Starts both anime backend servers as hidden background processes with logs.
#   AniVault (port 3000) + AllAnime (port 8000)
# They keep running until the machine reboots or stop-servers.ps1 is called;
# closing windows/terminals can no longer kill them. Logs: .\logs\
param([switch]$NoPause)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logs = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$busy = Get-NetTCPConnection -LocalPort 3000, 8000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Warning "Ports 3000/8000 are already in use. Run .\stop-servers.ps1 first, or the new servers will fail to bind."
}

# Hidden -NoExit shells: stop-servers.ps1 recognizes exactly this shape.
$win1 = Start-Process powershell -WorkingDirectory "$root\anivault-scraper" -WindowStyle Hidden -PassThru `
    -ArgumentList '-NoExit', '-Command', "npm run dev *>> '$logs\anivault.log'"
$win2 = Start-Process powershell -WorkingDirectory "$root\allanime-api" -WindowStyle Hidden -PassThru `
    -ArgumentList '-NoExit', '-Command', ".\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 *>> '$logs\allanime.log'"

# Remember the shell PIDs so stop-servers.ps1 can kill the whole dev-watcher
# trees, not just whatever currently owns the ports.
"$($win1.Id) $($win2.Id)" | Set-Content "$root\.server-pids" -Encoding ascii

$keyLine = Get-Content "$root\anivault-scraper\.env" | Where-Object { $_ -match '^ANIVAULT_API_KEY=' }
$apiKey = $keyLine -replace '^ANIVAULT_API_KEY=', ''

Write-Host ""
Write-Host "=== Servers starting (hidden background processes) ===" -ForegroundColor Green
Write-Host "  AniVault  (primary, playback) : http://localhost:3000/api"
Write-Host "  AllAnime  (catalog/search)    : http://127.0.0.1:8000"
Write-Host ""
Write-Host "  API key location: anivault-scraper\.env -> ANIVAULT_API_KEY"
Write-Host "  Required as 'x-anivault-api-key' header on every /api/* call"
Write-Host "  except /api/proxy/hls|video|subtitle (keyless, Origin-gated)."
Write-Host "  Current key: $apiKey"
Write-Host ""
Write-Host "  Logs (append): logs\anivault.log and logs\allanime.log"
Write-Host "  Ready when anivault.log prints 'AniVault API running on http://localhost:3000'"
Write-Host "  and allanime.log prints 'Uvicorn running on http://127.0.0.1:8000'."
Write-Host ""
Write-Host "Stop everything with: .\stop-servers.ps1"

if (-not $NoPause) { Read-Host "`nPress Enter to close this window" | Out-Null }
