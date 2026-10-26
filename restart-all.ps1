# Restarts everything: Koma (port 4000) and both streaming servers (3000, 8000).
# Run it by double-clicking restart-all.bat.
$root = $PSScriptRoot

Write-Host 'Stopping Koma...'
$kids = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in $kids) {
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue).ParentProcessId
    taskkill /PID $procId /T /F | Out-Null
    # Close the old "Koma" window too, but only if it's the one start.bat opened.
    $pp = if ($parent) { Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue }
    if ($pp -and $pp.Name -eq 'cmd.exe' -and $pp.CommandLine -match 'start\.bat') { taskkill /PID $parent /T /F | Out-Null }
}

Write-Host 'Restarting the streaming servers...'
& "$root\Servers - DONT TOUCH\stop-servers.ps1" -NoPause
Start-Sleep -Seconds 1
& "$root\Servers - DONT TOUCH\start-servers.ps1" -NoPause

Write-Host 'Starting Koma...'
Start-Process -FilePath "$root\start.bat" -WorkingDirectory $root
Start-Sleep -Seconds 3
