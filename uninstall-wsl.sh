#!/bin/bash
# Undo install-wsl.sh: remove our registry keys, the Claude Code MCP entry and
# the Windows install dir. Never touches the official extension's keys.
#   ./uninstall-wsl.sh [--dry-run]
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
HOST_NAME="com.anthropic.open_claude_in_chrome"
WIN_USER="${OCIC_WIN_USER:-$USER}"
DEST="${OCIC_WIN_DIR:-/mnt/c/Users/$WIN_USER/open-claude-in-chrome}"
REG=/mnt/c/Windows/System32/reg.exe

run() {
  if [ "$DRY" = 1 ]; then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@" || true; fi
}

for hive in 'Google\Chrome' 'Microsoft\Edge' 'BraveSoftware\Brave-Browser'; do
  run "$REG" delete "HKCU\\Software\\$hive\\NativeMessagingHosts\\$HOST_NAME" /f
done
run claude mcp remove -s user open-claude-in-chrome
run rm -rf "$DEST"
echo "Uninstalled. Remove the extension itself in chrome://extensions."
