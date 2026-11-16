; Koma NSIS installer. Run build-installer.bat (after build-app.bat) to make dist\Koma-Setup.exe.
; Per-user install (no admin prompt), shortcuts, uninstaller, Add/Remove entry.
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define APPNAME "Koma"
!define VERSION "1.7.16"
!define PUB "TotallyNoire"

Name "${APPNAME} ${VERSION}"
OutFile "dist\Koma-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME}"

VIProductVersion "1.7.16.0"
VIAddVersionKey "LegalCopyright" "TotallyNoire"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "CompanyName" "${PUB}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!define MUI_ICON "build\icon.ico"
!define MUI_UNICON "build\icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Welcome to the ${APPNAME} installer"
!define MUI_WELCOMEPAGE_TEXT "This installs ${APPNAME} as a desktop app: the window opens straight into the site, with the site and its streaming servers bundled inside the app itself - no other software is needed, and no console windows will open.$\r$\n$\r$\n$_CLICK"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APPNAME}.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME} now"
!define MUI_FINISHPAGE_RUN_CHECKED   ; the app just closed itself — bring it straight back

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "${APPNAME}" SecInstall
  SetOutPath "$INSTDIR"

  ; Where did this installer come from? The app starts it and then closes
  ; itself, which leaves the installer standing inside the app's process tree.
  ; The installer has to stop the app (and the servers the app started) before
  ; it can overwrite the files they are holding — but a tree kill would take
  ; the installer down with them, and the update would die before it began.
  ; So when the app started us, we wait for it to close on its own. Only an
  ; installer the user started by hand is free to kill the tree.
  ClearErrors
  ${GetOptions} $CMDLINE "/fromapp" $5
  ${If} ${Errors}
    StrCpy $6 0
  ${Else}
    StrCpy $6 1
  ${EndIf}

  ${If} $6 == 1
    ; the app is closing itself — wait for it (and its servers) to be gone
    StrCpy $2 60
    wait_app:
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APPNAME}.exe" /NH | find /I "${APPNAME}.exe"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Goto koma_gone
    ${EndIf}
    DetailPrint "Waiting for ${APPNAME} to close…"
    IntOp $2 $2 - 1
    ${If} $2 == 0
      ; still there after half a minute — force it, but never the whole tree
      nsExec::Exec 'taskkill /IM ${APPNAME}.exe /F'
      Sleep 800
      Goto koma_gone
    ${EndIf}
    Sleep 300
    Goto wait_app
  ${Else}
    ; started by hand while the app was open — stop it, and the servers with it
    ; (/T also stops the servers it started; ones running from start-servers.ps1 stay).
    nsExec::Exec 'taskkill /IM ${APPNAME}.exe /T /F'
    StrCpy $2 40
    wait_gone:
    ; find exits 0 while Koma.exe is still listed, 1 once it is gone
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq ${APPNAME}.exe" /NH | find /I "${APPNAME}.exe"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Goto koma_gone
    ${EndIf}
    DetailPrint "Waiting for ${APPNAME} to close…"
    IntOp $2 $2 - 1
    ${If} $2 == 0
      Goto koma_gone
    ${EndIf}
    Sleep 300
    Goto wait_gone
  ${EndIf}
  koma_gone:
  ; a beat for the OS to release the handles the app and its servers were holding
  Sleep 800
  File /r "dist\${APPNAME}-win32-x64\*.*"

  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  ; Add/Remove Programs
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${PUB}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" "$INSTDIR\${APPNAME}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "InstallLocation" "$INSTDIR"
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "EstimatedSize" "$0"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  ; The icon is named outright rather than left to the shell. A shortcut with
  ; an empty icon location keeps whatever the shell cached for it, which is
  ; how the desktop ended up showing a stale picture after the icon changed.
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\${APPNAME}.exe" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe" "" "$INSTDIR\${APPNAME}.exe" 0
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe" "" "$INSTDIR\${APPNAME}.exe" 0

  ; An update the app ran by itself (/relaunch) brings Koma back up when it is
  ; done — the user never has to start it again. A manual install keeps the
  ; "Start Koma now" checkbox on the finish page instead.
  ${GetOptions} $CMDLINE "/relaunch" $0
  ${IfNot} ${Errors}
    DetailPrint "Starting ${APPNAME}…"
    ExecShell open '"$INSTDIR\${APPNAME}.exe"'
  ${EndIf}
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM ${APPNAME}.exe /T /F'
  Sleep 1200
un_retry:
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\${APPNAME}.exe" 0 un_removed
    MessageBox MB_RETRYCANCEL|MB_ICONQUESTION "Some ${APPNAME} files are in use (the app may still be closing).$\nClose ${APPNAME} and click Retry." IDRETRY un_retry
    Abort
un_removed:

  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd
