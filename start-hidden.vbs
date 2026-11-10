' Tunnel Studio - silent autostart wrapper
' Launches the panel server in the background without a console window.
Option Explicit

Dim fso, shell, baseDir, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = baseDir

command = "pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ _
    & baseDir & "\Start-Panel.ps1"" -NoBrowser -Quiet"

shell.Run command, 0, False
