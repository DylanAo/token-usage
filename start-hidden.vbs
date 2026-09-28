' Token Usage - hidden launcher
' Usage: wscript start-hidden.vbs "<project-dir>"
' Launches the dashboard server and opens the browser, all with hidden windows.
' open-browser.mjs handles both starting the server (if not already running)
' and opening the browser once it is ready.

Set shell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

If WScript.Arguments.Count > 0 Then
    projectDir = WScript.Arguments(0)
Else
    projectDir = scriptDir
End If

shell.CurrentDirectory = projectDir
shell.Run "cmd /c node open-browser.mjs", 0, False