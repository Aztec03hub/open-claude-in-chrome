#!/bin/bash
# Install Open Claude in Chrome for Claude Code in WSL + Chrome on Windows.
#
#   ./install-wsl.sh [--dry-run]
#
# - copies extension/ and the native host (host/, no test/codemode) to a Windows folder
# - writes a Windows .bat wrapper (Windows node.exe) + native messaging manifest
#   (allowed_origins = the stable extension id from the manifest "key")
# - registers the host under HKCU for Chrome/Edge/Brave (name
#   com.anthropic.open_claude_in_chrome; the official extension's keys are never touched)
# - registers the MCP server in Claude Code at user scope (remove, then add)
#
# Env: OCIC_WIN_USER (Windows account, default $USER), OCIC_WIN_DIR (WSL path of the
# install dir), OCIC_WIN_NODE (WSL path of a Windows node.exe).
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SRC="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="hfogjicbglghcojkgmfhdaalcpfkdpkn" # derived from the manifest "key"; see docs
HOST_NAME="com.anthropic.open_claude_in_chrome"
WIN_USER="${OCIC_WIN_USER:-$USER}"
DEST="${OCIC_WIN_DIR:-/mnt/c/Users/$WIN_USER/open-claude-in-chrome}"
REG=/mnt/c/Windows/System32/reg.exe

run() { # print every action; execute unless --dry-run
  if [ "$DRY" = 1 ]; then printf 'DRY-RUN:'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
write_file() { # write_file <path> <content>
  if [ "$DRY" = 1 ]; then printf 'DRY-RUN: write %s:\n%s\n' "$1" "$2"; else printf '%s\n' "$2" > "$1"; fi
}
winpath() { # WSL path -> Windows path (works for not-yet-existing paths)
  if command -v wslpath >/dev/null; then wslpath -w "$1"; else echo "$1"; fi
}

# newest fnm node.exe, else Program Files
find_win_node() {
  if [ -n "${OCIC_WIN_NODE:-}" ]; then echo "$OCIC_WIN_NODE"; return; fi
  local f
  f="$(ls -d /mnt/c/Users/"$WIN_USER"/AppData/Roaming/fnm/node-versions/*/installation/node.exe 2>/dev/null | sort -V | tail -1 || true)"
  [ -z "$f" ] && [ -f "/mnt/c/Program Files/nodejs/node.exe" ] && f="/mnt/c/Program Files/nodejs/node.exe"
  [ -n "$f" ] && echo "$f"
}

[ -d "/mnt/c/Users/$WIN_USER" ] || { echo "No /mnt/c/Users/$WIN_USER (set OCIC_WIN_USER)"; exit 1; }
WIN_NODE="$(find_win_node)" || true
[ -n "$WIN_NODE" ] || { echo "No Windows node.exe found (set OCIC_WIN_NODE)"; exit 1; }
[ -x "$REG" ] || { echo "reg.exe not reachable at $REG"; exit 1; }

echo "Windows user:   $WIN_USER"
echo "Install dir:    $DEST ($(winpath "$DEST"))"
echo "Windows node:   $WIN_NODE"
echo "Extension id:   $EXT_ID"
[ "$DRY" = 1 ] && echo "(dry run: nothing below is executed)"
echo

# 1. Copy extension + host to Windows (Windows node must never run from \\wsl$).
run rm -rf "$DEST/extension" "$DEST/host"
run mkdir -p "$DEST/extension" "$DEST/host"
run cp -r "$SRC/extension/." "$DEST/extension/"
# The native host is stdlib-only, so no node_modules are needed on the Windows side.
for f in endpoint.js native-host.js parent-watch.js package.json; do
  run cp "$SRC/host/$f" "$DEST/host/$f"
done

# 2. Wrapper + manifest.
BAT="$DEST/host/native-host-wrapper.bat"
MANIFEST="$DEST/host/$HOST_NAME.json"
BAT_WIN="$(winpath "$BAT")"
BAT_CONTENT="$(printf '@echo off\r\n"%s" "%s" %%*\r\n' "$(winpath "$WIN_NODE")" "$(winpath "$DEST/host/native-host.js")")"
write_file "$BAT" "$BAT_CONTENT"
write_file "$MANIFEST" "$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Open Claude in Chrome Native Messaging Host",
  "path": "$(printf '%s' "$BAT_WIN" | sed 's/\\/\\\\/g')",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF
)"

# 3. Registry (HKCU, per-user, no admin). Only our own key name.
MANIFEST_WIN="$(winpath "$MANIFEST")"
for hive in 'Google\Chrome' 'Microsoft\Edge' 'BraveSoftware\Brave-Browser'; do
  run "$REG" add "HKCU\\Software\\$hive\\NativeMessagingHosts\\$HOST_NAME" /ve /t REG_SZ /d "$MANIFEST_WIN" /f
done

# 4. Claude Code MCP server, user scope. Remove-then-add; ok if not present yet.
if [ "$DRY" = 1 ] || command -v claude >/dev/null; then
  if [ "$DRY" = 1 ]; then
    run claude mcp remove -s user open-claude-in-chrome
  else
    claude mcp remove -s user open-claude-in-chrome >/dev/null 2>&1 || true
  fi
  [ -d "$SRC/host/node_modules" ] || run npm --prefix "$SRC/host" install --omit=dev
  run claude mcp add -s user open-claude-in-chrome -- node "$SRC/host/mcp-server.js"
else
  echo "claude CLI not found; register manually: claude mcp add -s user open-claude-in-chrome -- node $SRC/host/mcp-server.js"
fi

cat <<EOF

Done. One manual step left:
  In Windows Chrome open chrome://extensions, enable Developer mode, click
  "Load unpacked" and pick: $(winpath "$DEST/extension")
  The extension id should read $EXT_ID (the manifest pins it).
Then start a new Claude Code session in WSL.
EOF
