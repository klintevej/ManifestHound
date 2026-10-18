# Registers ManifestHound to start at logon via Task Scheduler (no admin rights needed).
# Usage: npm run build; npm run install-startup      (remove with: schtasks /Delete /TN ManifestHound /F)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
if (-not (Test-Path "$root\dist\main.js")) { throw "Run 'npm run build' first." }
$action = New-ScheduledTaskAction -Execute $node -Argument "dist\main.js" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName "ManifestHound" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "ManifestHound"
Write-Host "Installed. ManifestHound starts at logon and restarts on failure. Dashboard: http://127.0.0.1:4019"
