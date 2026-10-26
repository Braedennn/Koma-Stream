# Convenience: stop both servers, then start them again.
& "$PSScriptRoot\stop-servers.ps1" -NoPause
Start-Sleep -Seconds 1
& "$PSScriptRoot\start-servers.ps1"
