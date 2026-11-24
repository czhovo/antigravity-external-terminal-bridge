[CmdletBinding()]
param(
    [string]$Label = "Administrator Terminal",
    [ValidateSet("", "powershell", "pwsh", "cmd")]
    [string]$Shell = "",
    [string]$WorkingDirectory = "",
    [string]$PairingFile = "",
    [int]$TtlSeconds = 600
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$principal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isElevated = $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

if ($isElevated) {
    $startScript = Join-Path $PSScriptRoot "start-external-bridge.ps1"
    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        Set-Location -LiteralPath $WorkingDirectory
    }
    $passParams = @{
        Label = $Label
        TtlSeconds = $TtlSeconds
    }
    if (-not [string]::IsNullOrWhiteSpace($Shell)) { $passParams.Shell = $Shell }
    if (-not [string]::IsNullOrWhiteSpace($PairingFile)) { $passParams.PairingFile = $PairingFile }
    & $startScript @passParams
    exit $LASTEXITCODE
}

$launcher = Join-Path $PSScriptRoot "launch-external-terminal.ps1"
$launchParams = @{
    Elevated = $true
    Label = $Label
    TtlSeconds = $TtlSeconds
    UseWindowsTerminal = $true
    KeepOpenOnExit = $true
}
if (-not [string]::IsNullOrWhiteSpace($Shell)) { $launchParams.Shell = $Shell }
if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $launchParams.WorkingDirectory = $WorkingDirectory }
if (-not [string]::IsNullOrWhiteSpace($PairingFile)) { $launchParams.PairingFile = $PairingFile }

Write-Host "Requesting Windows UAC elevation to open an Administrator external terminal..." -ForegroundColor Yellow
& $launcher @launchParams
exit $LASTEXITCODE
