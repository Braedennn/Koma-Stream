# Stops both anime backend servers.
#   1. Tree-kills the windows recorded by start-servers.ps1 (kills the whole
#      dev chain: npm -> ts-node-dev watcher -> server node, window included).
#   2. Kills anything still listening on ports 3000/8000 (strays not started
#      by the script).
param([switch]$NoPause)

$root = $PSScriptRoot
$pidFile = Join-Path $root '.server-pids'

# Step 1: kill the start-script windows by recorded PID (guarded against PID reuse).
if (Test-Path $pidFile) {
    $recorded = (Get-Content $pidFile -Raw) -split '\s+' | Where-Object { $_ } | ForEach-Object { [int]$_ }
    foreach ($procId in $recorded) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
        if (-not $p) { continue }
        # Safety: only kill if it still looks like one of our -NoExit server windows.
        if ($p.Name -notin 'powershell.exe', 'pwsh.exe' -or $p.CommandLine -notmatch '-NoExit' -or $p.CommandLine -notmatch 'npm run dev|uvicorn main:app') {
            Write-Host "PID $procId no longer looks like a server window (now: $($p.Name)) - skipping."
            continue
        }
        Write-Host "Killing server window PID $procId ..."
        taskkill /PID $procId /T /F | Out-Null
    }
    Remove-Item $pidFile -ErrorAction SilentlyContinue
}

# Step 2: kill by port (works for servers not started by the script).
foreach ($port in 3000, 8000) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host "Port $port : nothing listening"
        continue
    }
    foreach ($owner in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        Write-Host "Port $port : killing PID $owner ..."
        taskkill /PID $owner /T /F | Out-Null
    }
}

Start-Sleep -Seconds 1
$left = Get-NetTCPConnection -LocalPort 3000, 8000 -State Listen -ErrorAction SilentlyContinue
Write-Host ""
if ($left) {
    Write-Warning "Ports 3000/8000 still have listeners - check manually:"
    $left | Select-Object LocalPort, OwningProcess | Format-Table | Out-Host
} else {
    Write-Host "Ports 3000 and 8000 are free." -ForegroundColor Green
}

if (-not $NoPause) { Read-Host "`nPress Enter to close this window" | Out-Null }
