# Run this script from an elevated Windows PowerShell terminal.
# It is safe to run again whenever WSL receives a different NAT address.

param(
    [string]$WslDistro = 'Ubuntu2204ArduP',
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

$ListenPorts = @(42000, 42010)
$FirewallRuleName = 'Luckfox AGV TCP'

$WslAddress = (wsl.exe -d $WslDistro hostname -I).Trim().Split(' ')[0]
$LuckfoxHostAddress = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like '172.32.*' } |
    Select-Object -First 1 -ExpandProperty IPAddress

if (-not $WslAddress) {
    throw 'Tidak dapat menemukan alamat IPv4 WSL.'
}

if (-not $LuckfoxHostAddress) {
    throw 'Tidak dapat menemukan adapter Windows pada jaringan Luckfox 172.32.0.0/16.'
}

function Test-PortProxyHealthy {
    $ProxyTable = netsh interface portproxy show v4tov4 | Out-String
    foreach ($ListenPort in $ListenPorts) {
        $ExpectedRule = '(?m)^\s*{0}\s+{1}\s+{2}\s+{1}\s*$' -f `
            [regex]::Escape($LuckfoxHostAddress), $ListenPort, [regex]::Escape($WslAddress)
        if ($ProxyTable -notmatch $ExpectedRule) {
            return $false
        }
        if (-not (Get-NetTCPConnection `
                -State Listen `
                -LocalAddress $LuckfoxHostAddress `
                -LocalPort $ListenPort `
                -ErrorAction SilentlyContinue)) {
            return $false
        }
    }
    return $true
}

if (Test-PortProxyHealthy) {
    Write-Host "Luckfox portproxy sudah aktif untuk $WslDistro at $WslAddress."
    exit 0
}

$IsAdministrator = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdministrator) {
    if ($Elevated) {
        throw 'Portproxy memerlukan hak Administrator.'
    }
    $ArgumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -WslDistro "{1}" -Elevated' -f `
        $PSCommandPath, $WslDistro
    Write-Host 'Portproxy belum aktif; meminta izin Administrator...'
    Start-Process powershell.exe -Verb RunAs -ArgumentList $ArgumentLine
    exit 0
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

# A stale IP Helper listener can survive a WSL address change. Restart it only
# when the newly written rules have not produced the expected listeners.
Start-Sleep -Milliseconds 500
if (-not (Test-PortProxyHealthy)) {
    Restart-Service iphlpsvc -Force
    Start-Sleep -Milliseconds 500
}

if (-not (Test-PortProxyHealthy)) {
    throw 'Rule tersimpan, tetapi listener portproxy Windows belum aktif.'
}

Write-Host "Luckfox endpoint : $LuckfoxHostAddress ports $($ListenPorts -join ', ')"
Write-Host "Forwarded to     : $WslDistro at $WslAddress"
Write-Host 'Portproxy aktif:'
netsh interface portproxy show v4tov4
