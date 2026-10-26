# Puts a Koma shortcut on the desktop and in the Start menu (run by build-app.bat).
$exe = Join-Path $PSScriptRoot 'dist\Koma-win32-x64\Koma.exe'
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Koma.lnk'))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = Split-Path $exe
    $lnk.IconLocation = "$exe,0"
    $lnk.Description = 'Koma'
    $lnk.Save()
}
