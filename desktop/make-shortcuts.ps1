# Puts a Koma shortcut on the desktop and in the Start menu (run by build-app.bat).
# The icon is named outright — a shortcut that leaves the icon location empty
# keeps whatever the shell had cached for it, which is how the desktop ended
# up showing a stale picture.
$exe = Join-Path $PSScriptRoot 'dist\Koma-win32-x64\Koma.exe'
if (-not (Test-Path $exe)) { throw "build the app first: $exe is missing" }
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Koma.lnk'))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = Split-Path $exe
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Koma'
    $lnk.Save()
}
