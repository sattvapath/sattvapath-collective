$ErrorActionPreference = "Stop"

function Test-CodexCliPath {
    param([string]$Path)

    if (-not $Path) {
        return $false
    }

    try {
        & $Path --version *> $null
        return ($LASTEXITCODE -eq 0)
    }
    catch {
        return $false
    }
}

function Find-CodexCli {
    $candidates = @()

    $command = Get-Command codex -ErrorAction SilentlyContinue
    if ($command) {
        $candidates += $command.Source
    }

    $binRoot = Join-Path $env:LOCALAPPDATA "OpenAI\Codex\bin"
    if (Test-Path $binRoot) {
        $candidates += Get-ChildItem -Path $binRoot -Filter "codex.exe" -Recurse -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object { $_.FullName }
    }

    foreach ($candidate in ($candidates | Select-Object -Unique)) {
        if (Test-CodexCliPath -Path $candidate) {
            return $candidate
        }
    }

    return $null
}

$codex = Find-CodexCli

if (-not $codex) {
    Write-Host "Codex CLI was not found or could not be started."
    Write-Host "Install or open Codex, then rerun this setup."
    exit 1
}

Write-Host "Codex CLI found:"
Write-Host "  $codex"
Write-Host ""

Write-Host "Version:"
& $codex --version
Write-Host ""

Write-Host "Running Codex doctor..."
& $codex doctor
$doctorExit = $LASTEXITCODE
Write-Host ""

if ($doctorExit -ne 0) {
    Write-Host "Codex doctor reported items to fix."
    Write-Host "Common next steps:"
    Write-Host "  1. Run: codex login"
    Write-Host "  2. Rerun: make setup"
    Write-Host "  3. If network checks still fail, check VPN, proxy, firewall, or DNS."
    exit $doctorExit
}

Write-Host "Codex CLI setup looks good."
