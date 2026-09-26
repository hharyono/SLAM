$ErrorActionPreference = 'Stop'

$taskName = 'Luckfox Drone Dashboard LAN'
$scriptPath = $MyInvocation.MyCommand.Path
wsl.exe -d Ubuntu -- sh -lc 'systemctl --user start drone-dashboard.service'
$wslIp = (wsl.exe -d Ubuntu -- sh -lc "hostname -I | awk '{print `$1}'").Trim()
if (-not $wslIp) { throw 'Could not resolve the Ubuntu WSL address.' }

netsh interface portproxy delete v4tov4 listenport=3001 listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenport=3001 listenaddress=0.0.0.0 connectport=3001 connectaddress=$wslIp | Out-Null

if (Get-NetFirewallRule -DisplayName 'Drone Dashboard 3001' -ErrorAction SilentlyContinue) {
    Set-NetFirewallRule -DisplayName 'Drone Dashboard 3001' -Profile Any -Enabled True
} else {
    New-NetFirewallRule -DisplayName 'Drone Dashboard 3001' -Direction Inbound `
        -Action Allow -Protocol TCP -LocalPort 3001 -Profile Any | Out-Null
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -RefreshOnly"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Description 'Refresh WSL port forwarding for the Luckfox dashboard.' `
    -Force | Out-Null

Write-Host "Dashboard LAN forwarding active: http://192.168.1.71:3001 -> $wslIp`:3001"
