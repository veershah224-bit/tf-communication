# Allows TF Communication (port 3000) through Windows Firewall so that staff on
# your local network can connect to http://<your-ip>:3000.
#
# Safe to run again any time. Must be run as Administrator (right-click > Run as
# administrator), or it will ask for permission via a UAC popup.

$ErrorActionPreference = 'Stop'
$ruleName = 'TF Communication (port 3000)'

# Remove an old copy of the rule first so this script is safe to re-run.
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

# Allow incoming connections to TCP port 3000 on all network types.
New-NetFirewallRule `
  -DisplayName $ruleName `
  -Direction Inbound `
  -Action Allow `
  -Protocol TCP `
  -LocalPort 3000 `
  -Profile Any | Out-Null

Write-Host ''
Write-Host '  Done! Windows Firewall now allows port 3000.' -ForegroundColor Green
Write-Host '  Staff on the same Wi-Fi can open:  http://192.168.1.16:3000' -ForegroundColor Green
Write-Host ''
Start-Sleep -Seconds 3
