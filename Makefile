.PHONY: setup codex-doctor codex-login codex-run

setup:
	powershell -ExecutionPolicy Bypass -File scripts/setup-codex.ps1

codex-doctor:
	codex doctor

codex-login:
	codex login

codex-run:
	codex -C . --sandbox workspace-write --ask-for-approval on-request
