$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $MyInvocation.MyCommand.Path
$shimPath = Join-Path $workspace "codex.cmd"

$cmdLines = @(
'@echo off',
'setlocal',
'set "CODEX_EXE="',
'for /f "delims=" %%F in (''dir /b /s /o-d "%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe" 2^>nul'') do (',
'  set "CODEX_EXE=%%F"',
'  goto found',
')',
':found',
'if not defined CODEX_EXE (',
'  echo Codex CLI executable was not found under %LOCALAPPDATA%\OpenAI\Codex\bin.',
'  exit /b 1',
')',
'"%CODEX_EXE%" %*'
)
 Set-Content -Path $shimPath -Value $cmdLines -Encoding ascii

# Remove an older profile shortcut if it exists, because this PC blocks profile scripts.
$profilePath = $PROFILE
if (Test-Path $profilePath) {
    try {
        $profileText = Get-Content -Raw $profilePath
        $profileText = [regex]::Replace($profileText, '(?s)\r?\n?# Codex CLI shortcut\r?\nfunction codex \{.*?\r?\n\}\r?\n?', '')
        if ([string]::IsNullOrWhiteSpace($profileText)) {
            Remove-Item -LiteralPath $profilePath -Force
        } else {
            Set-Content -Path $profilePath -Value $profileText -Encoding ascii
        }
    } catch {
        Write-Warning "Could not clean up the old PowerShell profile shortcut. Continuing with the PATH fix."
    }
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = @()
if ($userPath) {
    $parts = $userPath -split ";" | Where-Object { $_ }
}

if ($parts -notcontains $workspace) {
    [Environment]::SetEnvironmentVariable("Path", (($parts + $workspace) -join ";"), "User")
    Write-Host "Added this project folder to your user PATH. Open a new PowerShell window for it to apply."
} else {
    Write-Host "This project folder is already on your user PATH."
}

$env:Path = "$workspace;$env:Path"
Write-Host "Testing Codex shortcut..."
& (Join-Path $workspace "codex.cmd") --version
