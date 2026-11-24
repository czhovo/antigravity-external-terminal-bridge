[CmdletBinding()]
param(
    [switch]$Elevated,
    [string]$Label = "",
    [ValidateSet("", "powershell", "pwsh", "cmd")]
    [string]$Shell = "",
    [string]$WorkingDirectory = "",
    [string]$PairingFile = "",
    [string]$StateRoot = "",
    [int]$TtlSeconds = 600,
    [switch]$UseWindowsTerminal,
    [switch]$KeepOpenOnExit,
    [switch]$HiddenWindow
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$targetScript = Join-Path $PSScriptRoot "start-external-bridge.ps1"
if (-not (Test-Path -LiteralPath $targetScript)) {
    throw "Bridge launcher not found: $targetScript"
}

if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = (Get-Location).ProviderPath
}
if (-not (Test-Path -LiteralPath $WorkingDirectory)) {
    throw "Working directory does not exist: $WorkingDirectory"
}

$resolvedStateRoot = if (-not [string]::IsNullOrWhiteSpace($StateRoot)) {
    $StateRoot
} elseif (-not [string]::IsNullOrWhiteSpace($env:ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT)) {
    $env:ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT
} else {
    Join-Path $env:LOCALAPPDATA "AntigravityExternalTerminalBridge"
}

$launchesDir = Join-Path $resolvedStateRoot "launches"
New-Item -ItemType Directory -Force -Path $launchesDir | Out-Null

$launchId = [Guid]::NewGuid().ToString()
$bootstrapScript = Join-Path $launchesDir "launch-$launchId.ps1"

function Escape-PsSingle([string]$Value) {
    if ($null -eq $Value) { return "" }
    return $Value.Replace("'", "''")
}

$effectiveLabel = if (-not [string]::IsNullOrWhiteSpace($Label)) {
    $Label
} elseif ($Elevated) {
    "Administrator External Terminal"
} else {
    "External Terminal"
}

$bootstrapLines = @(
    '$ErrorActionPreference = ''Stop'''
    'try { [Console]::InputEncoding = [System.Text.Encoding]::UTF8 } catch {}'
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}'
    '$OutputEncoding = [System.Text.Encoding]::UTF8'
    "`$env:ANTIGRAVITY_TERMINAL_BRIDGE_STATE_ROOT = '$(Escape-PsSingle $resolvedStateRoot)'"
    "Set-Location -LiteralPath '$(Escape-PsSingle $WorkingDirectory)'"
    'try {'
    "    `$params = @{ Label = '$(Escape-PsSingle $effectiveLabel)'; TtlSeconds = $TtlSeconds }"
)

if (-not [string]::IsNullOrWhiteSpace($Shell)) {
    $bootstrapLines += "    `$params.Shell = '$(Escape-PsSingle $Shell)'"
}
if (-not [string]::IsNullOrWhiteSpace($PairingFile)) {
    $bootstrapLines += "    `$params.PairingFile = '$(Escape-PsSingle $PairingFile)'"
}

$bootstrapLines += @(
    "    & '$(Escape-PsSingle $targetScript)' @params"
    '} finally {'
    "    Remove-Item -LiteralPath '$(Escape-PsSingle $bootstrapScript)' -Force -ErrorAction SilentlyContinue"
    '}'
)

$utf8Bom = [System.Text.UTF8Encoding]::new($true)
[System.IO.File]::WriteAllText($bootstrapScript, ($bootstrapLines -join "`r`n") + "`r`n", $utf8Bom)

$psExe = if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { "pwsh.exe" } else { "powershell.exe" }
$psArgs = @()
if ($KeepOpenOnExit) { $psArgs += "-NoExit" }
$psArgs += @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$bootstrapScript`"")

$wt = if ($UseWindowsTerminal -and -not $HiddenWindow) {
    Get-Command wt.exe -ErrorAction SilentlyContinue
} else {
    $null
}

$windowTitle = if ($Elevated) { "Antigravity Admin Terminal" } else { "Antigravity External Terminal" }
$usedWt = $false

function Get-Win32NativeErrorCode($Exception) {
    $curr = $Exception
    while ($null -ne $curr) {
        if ($curr -is [System.ComponentModel.Win32Exception]) {
            return $curr.NativeErrorCode
        }
        $curr = $curr.InnerException
    }
    return $null
}

try {
    $launchedViaWt = $false
    if ($wt) {
        $wtArgs = "-w new new-tab --title `"$windowTitle`" `"$psExe`" " + ($psArgs -join " ")
        $wtStartParams = @{
            FilePath = "wt.exe"
            ArgumentList = $wtArgs
            ErrorAction = "Stop"
        }
        if ($Elevated) {
            $wtStartParams.Verb = "RunAs"
        }
        try {
            Start-Process @wtStartParams | Out-Null
            $launchedViaWt = $true
            $usedWt = $true
        } catch {
            if ((Get-Win32NativeErrorCode $_.Exception) -eq 1223) {
                throw
            }
            # Fall back to direct pwsh/powershell if wt.exe RunAs is unavailable on this host.
        }
    }

    if (-not $launchedViaWt) {
        $startParams = @{
            FilePath = (Get-Command $psExe -ErrorAction Stop).Source
            ArgumentList = ($psArgs -join " ")
            ErrorAction = "Stop"
        }
        if ($Elevated) {
            $startParams.Verb = "RunAs"
        }
        if ($HiddenWindow -and -not $Elevated) {
            $startParams.WindowStyle = "Hidden"
        }
        Start-Process @startParams | Out-Null
    }
    Write-Output (@{
        launched = $true
        elevated = [bool]$Elevated
        usedWindowsTerminal = $usedWt
        bootstrapScript = $bootstrapScript
    } | ConvertTo-Json -Compress)
} catch {
    Remove-Item -LiteralPath $bootstrapScript -Force -ErrorAction SilentlyContinue
    $nativeCode = Get-Win32NativeErrorCode $_.Exception
    if ($nativeCode -eq 1223) {
        [Console]::Error.WriteLine("UAC_CANCELLED: The user declined or canceled the Windows UAC elevation prompt.")
        exit 1223
    }
    throw
}
