Option Explicit
Dim fso, shell, root, app, node, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
app = root & "\windows\code\desktop-pet"
If Not fso.FileExists(app & "\desktop\wpf\shell\bin\ALLMIND.Widget.exe") Then
  MsgBox "Run npm run build:allmind in windows/code/desktop-pet first.", 48, "ALLMIND"
  WScript.Quit 1
End If
node = "node.exe"
If fso.FileExists(app & "\runtime\node.exe") Then node = app & "\runtime\node.exe"
command = Chr(34) & node & Chr(34) & " " & Chr(34) & app & "\desktop\wpf\main.mjs" & Chr(34)
If WScript.Arguments.Count > 0 Then command = command & " --data " & Chr(34) & WScript.Arguments(0) & Chr(34)
shell.Run command, 0, False
