#!/usr/bin/env bash
# Install the Usage Overlay GNOME Shell extension for the current user.
#   ./install.sh            copy the extension and enable it
#   ./install.sh --link     symlink instead of copy (handy while developing)
set -euo pipefail

UUID="usage-overlay@iamludok.github.io"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HERE/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
CFG_DIR="$HOME/.config/usage-overlay"

command -v node >/dev/null 2>&1 || echo "warning: 'node' not found on PATH; the CURSOR and OPENCD sections need it."

# Install the extension (copy by default, symlink with --link).
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
if [[ "${1:-}" == "--link" ]]; then
  ln -s "$SRC" "$DEST"
  echo "linked  $DEST -> $SRC"
else
  cp -r "$SRC" "$DEST"
  echo "copied  $SRC -> $DEST"
fi

# Seed a config.json from the example on first install (never overwrite one).
mkdir -p "$CFG_DIR"
if [[ ! -f "$CFG_DIR/config.json" ]]; then
  cp "$SRC/config.example.json" "$CFG_DIR/config.json"
  echo "created $CFG_DIR/config.json (edit to add a Copilot token, change corner, etc.)"
fi

# Enable it. On Wayland the new extension is only picked up after a fresh
# session, so log out and back in the first time if enabling fails.
if gnome-extensions enable "$UUID" 2>/dev/null; then
  echo "enabled $UUID"
else
  echo "installed. Log out and back in, then run: gnome-extensions enable $UUID"
fi
