#!/bin/bash
# Undo install-wsl.sh: remove our registry keys, the Claude Code MCP entry and
# the Windows install dirs (extension/ and host/ only, and only where the
# installer's .ocic-install marker exists). Never touches the official extension's keys.
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
# OCIC_WIN_DIR comes from the environment, so never rm -rf it: a mistaken value
# (say, the Windows profile) would be wiped. Remove only what the installer put
# there, and only if the installer marked the dir.
if [ -f "$DEST/.ocic-install" ]; then
  run rm -rf "$DEST/extension" "$DEST/host" "$DEST/.ocic-install"
  run rmdir "$DEST"
else
  echo "Not removing $DEST: no .ocic-install marker (installed by an older version, or OCIC_WIN_DIR is not the install dir)."
  echo "If it is the install dir, 'touch \"$DEST/.ocic-install\"' and run this again, or delete its extension/ and host/ by hand."
fi
echo "Uninstalled. Remove the extension itself in chrome://extensions."
