# Sattva Path Collective

This workspace is set up for the Codex CLI.

## Setup

From a normal terminal in this folder:

```powershell
make setup
```

If `make` is not installed on Windows, run the setup script directly:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-codex.ps1
```

If setup reports missing credentials, run:

```powershell
codex login
```

Then rerun setup.

## Useful Commands

```powershell
make codex-login
make codex-doctor
make codex-run
```

The project defaults in `.codex/config.toml` keep Codex in `workspace-write`
mode with approvals available on request.
