[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [switch]$SkipNpmInstall,
    [switch]$SkipConPtyBuild
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = Join-Path $env:USERPROFILE ".gemini\config\plugins\external-terminal-bridge"
}

$repoRoot = $PSScriptRoot
Write-Host "Installing Antigravity External Terminal Bridge to: $InstallDir" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path `
    $InstallDir, `
    (Join-Path $InstallDir "scripts"), `
    (Join-Path $InstallDir "skills\external-terminal-bridge"), `
    (Join-Path $InstallDir "rules"), `
    (Join-Path $InstallDir "tests") | Out-Null

foreach ($file in @("plugin.json", "package.json", "package-lock.json", "README.md", "LICENSE")) {
    $src = Join-Path $repoRoot $file
    if (Test-Path -LiteralPath $src) {
        Copy-Item -LiteralPath $src -Destination (Join-Path $InstallDir $file) -Force
    }
}

Get-ChildItem (Join-Path $repoRoot "scripts") -File | Where-Object { $_.Extension -ne ".exe" } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDir "scripts\$($_.Name)") -Force
}
Copy-Item -LiteralPath (Join-Path $repoRoot "skills\external-terminal-bridge\SKILL.md") -Destination (Join-Path $InstallDir "skills\external-terminal-bridge\SKILL.md") -Force
Copy-Item -LiteralPath (Join-Path $repoRoot "rules\AGENTS.md") -Destination (Join-Path $InstallDir "rules\AGENTS.md") -Force
Get-ChildItem (Join-Path $repoRoot "tests") -File -Filter "*.test.mjs" | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $InstallDir "tests\$($_.Name)") -Force
}

$mcpServerPath = Join-Path $InstallDir "scripts\mcp-server.mjs"
$mcpConfigObj = @{
    mcpServers = @{
        "external-terminal-bridge" = @{
            command = "node"
            args    = @($mcpServerPath)
            env     = @{
                EXTERNAL_TERMINAL_BRIDGE_REV = "1.2.0"
            }
        }
    }
}
$mcpConfigJson = ($mcpConfigObj | ConvertTo-Json -Depth 5) + "`n"
[System.IO.File]::WriteAllText((Join-Path $InstallDir "mcp_config.json"), $mcpConfigJson, [System.Text.UTF8Encoding]::new($false))

if (-not $SkipConPtyBuild) {
    & (Join-Path $InstallDir "scripts\build-conpty.ps1")
}

if (-not $SkipNpmInstall) {
    Write-Host "Installing Node.js dependencies..." -ForegroundColor Cyan
    Push-Location $InstallDir
    try {
        npm install --omit=dev
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "Plugin directory: $InstallDir"
Write-Host "Restart or refresh plugins in Antigravity to load 'external-terminal-bridge'."
