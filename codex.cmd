@echo off
setlocal
set "CODEX_EXE="
for /f "delims=" %%F in ('dir /b /s /o-d "%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe" 2^>nul') do (
  set "CODEX_EXE=%%F"
  goto found
)
:found
if not defined CODEX_EXE (
  echo Codex CLI executable was not found under %LOCALAPPDATA%\OpenAI\Codex\bin.
  exit /b 1
)
"%CODEX_EXE%" %*
