#!/bin/bash
set -euo pipefail

if [[ "$(uname -s)" != Darwin ]]; then
    echo "This installer requires macOS 13 or newer." >&2
    exit 1
fi
case "${1:-}" in
    ""|--no-launch) ;;
    *) echo "Usage: $0 [--no-launch]" >&2; exit 1 ;;
esac
if ! xcrun --find swift >/dev/null 2>&1; then
    echo "Install Apple's command line tools first: xcode-select --install" >&2
    exit 1
fi

source_dir="$(cd "$(dirname "$0")" && pwd)"
app_dir="$HOME/Applications/Usage Overlay.app"
build_dir="$source_dir/.build/Usage Overlay.app"
swift build --package-path "$source_dir" -c release
binary_dir="$(swift build --package-path "$source_dir" -c release --show-bin-path)"
mkdir -p "$build_dir/Contents/MacOS" "$build_dir/Contents/Resources" "$HOME/Applications"
cp "$binary_dir/UsageOverlay" "$build_dir/Contents/MacOS/UsageOverlay"
cp "$source_dir/Info.plist" "$build_dir/Contents/Info.plist"
cp "$source_dir/config.example.json" "$build_dir/Contents/Resources/config.example.json"
cp "$source_dir/../LICENSE" "$build_dir/Contents/Resources/LICENSE"
codesign --force --sign - "$build_dir"

# Quit only our own executable, if this is an upgrade. Config is kept separately.
pkill -x -f "$app_dir/Contents/MacOS/UsageOverlay" 2>/dev/null || true
ditto "$build_dir" "$app_dir"
codesign --verify --strict "$app_dir"
echo "Installed: $app_dir"
if [[ "${1:-}" != --no-launch ]]; then open "$app_dir"; fi
