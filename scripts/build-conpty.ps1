[CmdletBinding()]
param(
    [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$sourcePath = Join-Path $PSScriptRoot "conpty-runner.cs"
if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "conpty-runner.cs not found at: $sourcePath"
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $PSScriptRoot "conpty-runner.exe"
}

$cscCandidates = @(
    "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
    "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)
$csc = $cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
    throw "Windows built-in .NET Framework csc.exe was not found. ConPTY runner could not be compiled."
}

Write-Host "Compiling conpty-runner.exe with $csc..." -ForegroundColor Cyan
& $csc /nologo /optimize+ /target:exe "/out:$OutputPath" $sourcePath
if ($LASTEXITCODE -ne 0) {
    throw "csc.exe failed with exit code $LASTEXITCODE"
}

Write-Host "Built: $OutputPath" -ForegroundColor Green
