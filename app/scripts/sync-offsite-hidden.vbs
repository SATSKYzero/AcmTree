' ================================================================
' Hidden launcher for scripts/sync-offsite.bat  (window style 0 = no console flash)
' Used by the Windows scheduled task "AcmTree-offsite-sync".
' Why a .vbs: registering a .bat directly makes a black window pop up every run.
' NOTE: keep this file pure ASCII (wscript reads it with the system ANSI codepage).
' ================================================================
Dim fso, here
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & fso.BuildPath(here, "sync-offsite.bat") & """", 0, False
