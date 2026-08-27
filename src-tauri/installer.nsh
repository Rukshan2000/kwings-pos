; Creates the shared data directory while the installer still has admin rights.
;
; The app installs perMachine but runs as a normal user, and %PROGRAMDATA%'s default
; ACL only lets a user write to subdirectories they created themselves. Without this,
; the first Windows account to run the app would own the database and every other
; account would fail to start it.

!macro NSIS_HOOK_POSTINSTALL
  CreateDirectory "$COMMONPROGRAMDATA\GreenPlusPOS"
  ; S-1-5-32-545 is the built-in Users group. Using the SID rather than the name
  ; keeps this working on non-English Windows installations.
  nsExec::ExecToLog 'icacls "$COMMONPROGRAMDATA\GreenPlusPOS" /grant *S-1-5-32-545:(OI)(CI)M /T /C'
  Pop $0
!macroend

; The database holds the shop's sales history. Uninstalling the application must
; never delete it — removal is a deliberate, manual act.
!macro NSIS_HOOK_POSTUNINSTALL
!macroend
