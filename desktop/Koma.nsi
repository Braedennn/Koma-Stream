; Koma NSIS installer. Run build-installer.bat (after build-app.bat) to make dist\Koma-Setup.exe.
; Per-user install (no admin prompt), shortcuts, uninstaller, Add/Remove entry.
!include "MUI2.nsh"
!include "FileFunc.nsh"

!define APPNAME "Koma"
!define VERSION "1.1.0"
!define PUB "TotallyNoire"

Name "${APPNAME} ${VERSION}"
OutFile "dist\Koma-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APPNAME}"

VIProductVersion "1.1.0.0"
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

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Section "${APPNAME}" SecInstall
  SetOutPath "$INSTDIR"
  ; An upgrade while the app is open would fail to overwrite Koma.exe — stop it first
  ; (/T also stops the servers it started; ones running from start-servers.ps1 stay).
  nsExec::Exec 'taskkill /IM ${APPNAME}.exe /T /F'
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
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPNAME}.exe"
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
