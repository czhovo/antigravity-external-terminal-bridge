[CmdletBinding()]
param(
    [string]$Label = "",
    [ValidateSet("", "powershell", "pwsh", "cmd")]
    [string]$Shell = "",
    [string]$PairingFile = "",
    [int]$TtlSeconds = 600
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$nodeCommand = Get-Command node -ErrorAction Stop
$bridgeScript = Join-Path $PSScriptRoot "terminal-bridge.mjs"

if ([string]::IsNullOrWhiteSpace($PairingFile)) {
    $desktopPath = [Environment]::GetFolderPath(
        [Environment+SpecialFolder]::Desktop
    )
    $PairingFile = Join-Path $desktopPath "pairing-code.json"
}

$principal = [Security.Principal.WindowsPrincipal]::new(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
$isElevated = $principal.IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)

if ([string]::IsNullOrWhiteSpace($Shell)) {
    if ($PSVersionTable.PSEdition -eq "Core" -and (Get-Command pwsh -ErrorAction SilentlyContinue)) {
        $Shell = "pwsh"
    } else {
        $Shell = "powershell"
    }
}

$bridgeArguments = @(
    "--pairing-file", $PairingFile,
    "--shell", $Shell,
    "--ttl-seconds", "$TtlSeconds"
)
if ($isElevated) {
    $bridgeArguments += "--elevated"
}
if (-not [string]::IsNullOrWhiteSpace($Label)) {
    $bridgeArguments += @("--label", $Label)
}

if ($isElevated) {
    Write-Host "Starting Antigravity External Terminal Bridge [ADMINISTRATOR]..." -ForegroundColor Yellow
} else {
    Write-Host "Starting Antigravity External Terminal Bridge [Standard User]..." -ForegroundColor Cyan
}

& $nodeCommand.Source $bridgeScript @bridgeArguments
exit $LASTEXITCODE
