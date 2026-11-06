# Claude Code Monitor: start with Windows.
# Puts a shortcut into the current user's Startup folder (no admin rights, no system settings)
# and a "Claude Code Monitor" shortcut on the Desktop.
# Remove autostart: delete "Claude Code Monitor.lnk" from shell:startup (Win+R, shell:startup).
$pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
if (-not $pyw) { Write-Error 'pythonw.exe not found in PATH: install Python 3.9+ from python.org'; exit 1 }
$startup = [Environment]::GetFolderPath('Startup')
$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut((Join-Path $startup 'Claude Code Monitor.lnk'))
$lnk.TargetPath = $pyw
$lnk.Arguments = '"' + (Join-Path $PSScriptRoot 'monitor.py') + '"'
$lnk.WorkingDirectory = $PSScriptRoot
$lnk.Description = 'Claude Code Monitor, http://127.0.0.1:8770'
$lnk.Save()
$d = $sh.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Code Monitor.lnk'))
$d.TargetPath = Join-Path $PSScriptRoot 'start_monitor.bat'
$d.WorkingDirectory = $PSScriptRoot
$d.WindowStyle = 7
$d.Save()
"ok: $startup\Claude Code Monitor.lnk"
