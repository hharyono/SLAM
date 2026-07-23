# Run this script from an elevated Windows PowerShell terminal.
# It is safe to run again whenever WSL receives a different NAT address.

param(
    [string]$WslDistro = 'Ubuntu2204ArduP',
    [string]$BoardAddress = '192.168.1.24',
    [string]$ListenAddress,
    [int]$RobotPort = 42000,
    [int]$ScanPort = 42010,
    [switch]$Elevated
)

$ErrorActionPreference = 'Stop'

$ListenPorts = @($RobotPort, $ScanPort) | Select-Object -Unique
$FirewallRuleName = 'Luckfox AGV TCP'

$WslAddress = (wsl.exe -d $WslDistro hostname -I).Trim().Split(' ')[0]
if (-not $ListenAddress) {
    $ListenAddress = Find-NetRoute -RemoteIPAddress $BoardAddress |
        Where-Object { $_.IPAddress } |
        Select-Object -First 1 -ExpandProperty IPAddress
}

if (-not $WslAddress) {
    throw 'Tidak dapat menemukan alamat IPv4 WSL.'
}

if (-not $ListenAddress) {
    throw "Tidak dapat menemukan alamat Windows yang dapat mencapai board $BoardAddress."
}

function Test-PortProxyHealthy {
    $ProxyTable = netsh interface portproxy show v4tov4 | Out-String
    foreach ($ListenPort in $ListenPorts) {
        $ExpectedRule = '(?m)^\s*{0}\s+{1}\s+{2}\s+{1}\s*$' -f `
            [regex]::Escape($ListenAddress), $ListenPort, [regex]::Escape($WslAddress)
        if ($ProxyTable -notmatch $ExpectedRule) {
            return $false
        }
        if (-not (Get-NetTCPConnection `
                -State Listen `
                -LocalAddress $ListenAddress `
                -LocalPort $ListenPort `
                -ErrorAction SilentlyContinue)) {
            return $false
        }
    }
    return $true
}

if (Test-PortProxyHealthy) {
    Write-Host "Luckfox portproxy sudah aktif di $ListenAddress untuk $WslDistro at $WslAddress."
    exit 0
}

$IsAdministrator = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $IsAdministrator) {
    if ($Elevated) {
        throw 'Portproxy memerlukan hak Administrator.'
    }
    $ArgumentLine = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -WslDistro "{1}" ' + `
        '-BoardAddress "{2}" -ListenAddress "{3}" -RobotPort {4} -ScanPort {5} -Elevated' -f `
        $PSCommandPath, $WslDistro, $BoardAddress, $ListenAddress, $RobotPort, $ScanPort
    Write-Host 'Portproxy belum aktif; meminta izin Administrator...'
    $ElevatedProcess = Start-Process powershell.exe -Verb RunAs `
        -ArgumentList $ArgumentLine -Wait -PassThru
    if ($ElevatedProcess.ExitCode -ne 0) {
        throw "Perbaikan portproxy gagal dengan exit code $($ElevatedProcess.ExitCode)."
    }
    exit 0
}

# Remove a stale rule first because the WSL NAT address can change after restart.
foreach ($ListenPort in $ListenPorts) {
    netsh interface portproxy delete v4tov4 `
        listenaddress=$ListenAddress listenport=$ListenPort | Out-Null

    netsh interface portproxy add v4tov4 `
        listenaddress=$ListenAddress listenport=$ListenPort `
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

Write-Host "Luckfox endpoint : $ListenAddress ports $($ListenPorts -join ', ')"
Write-Host "Forwarded to     : $WslDistro at $WslAddress"
Write-Host 'Portproxy aktif:'
netsh interface portproxy show v4tov4
