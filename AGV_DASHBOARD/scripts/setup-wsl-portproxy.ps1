# Run this script from an elevated Windows PowerShell terminal.
# It is safe to run again whenever WSL receives a different NAT address.

$ErrorActionPreference = 'Stop'

$ListenPorts = @(42000, 42010)
$FirewallRuleName = 'Luckfox AGV TCP'

$WslAddress = (wsl.exe hostname -I).Trim().Split(' ')[0]
$LuckfoxHostAddress = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like '172.32.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress

if (-not $WslAddress) {
    throw 'Tidak dapat menemukan alamat IPv4 WSL.'
}

if (-not $LuckfoxHostAddress) {
    throw 'Tidak dapat menemukan adapter Windows pada jaringan Luckfox 172.32.0.0/16.'
}

# Remove a stale rule first because the WSL NAT address can change after restart.
foreach ($ListenPort in $ListenPorts) {
    netsh interface portproxy delete v4tov4 `
        listenaddress=$LuckfoxHostAddress listenport=$ListenPort | Out-Null

    netsh interface portproxy add v4tov4 `
        listenaddress=$LuckfoxHostAddress listenport=$ListenPort `
        connectaddress=$WslAddress connectport=$ListenPort
}

if (-not (Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule `
        -DisplayName $FirewallRuleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $ListenPorts | Out-Null
}

Write-Host "Luckfox endpoint : $LuckfoxHostAddress ports $($ListenPorts -join ', ')"
Write-Host "Forwarded to     : $WslAddress"
Write-Host 'Portproxy aktif:'
netsh interface portproxy show v4tov4
