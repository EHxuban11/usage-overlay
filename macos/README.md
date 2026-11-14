# usage-overlay for macOS

A native Swift/AppKit port with a floating, always-on-top, click-through overlay
and a menu-bar control. Supports Claude Code, Codex, Cursor, GitHub Copilot and
OpenCode. It uses Apple's Foundation, Security and SQLite frameworks; no Node,
Python, package downloads or third-party runtime is required.

## Install

Requires macOS 13 or newer, on Apple Silicon or Intel, and Xcode Command Line
Tools with Swift 5.9 or newer (Xcode 15+).

```sh
xcode-select --install  # only if Apple's developer tools are not installed
git clone https://github.com/EHxuban11/usage-overlay.git
cd usage-overlay
./macos/install.sh
```

The installer builds for your Mac's architecture, signs locally, installs to
`~/Applications/Usage Overlay.app`, and launches it. It needs no administrator
access. Re-run it to upgrade; your configuration and saved position are preserved.
Use `./macos/install.sh --no-launch` to install without starting the app.

The app has no Dock icon. Use the bar-chart icon in the menu bar to refresh,
hide/show, move, open/reload configuration, view the legend, or quit. Choose
**Move overlay**, drag it, then **Lock overlay (click-through)**. Position is
saved separately from configuration and clamped to the available displays.
**Reset position** restores the configured corner.

To start it again, open the app in Finder or run:

```sh
open "$HOME/Applications/Usage Overlay.app"
```

For optional startup at login, add the app in System Settings > General > Login
Items. The installer does not change login items. To uninstall, quit from its
menu and move `~/Applications/Usage Overlay.app` to the Trash; optionally remove
`~/.config/usage-overlay` and run `defaults delete io.github.ehxuban11.usage-overlay`.
The config folder can also be shared with the Linux port, so keep it if needed.

## Sources and authentication

| Provider | Read-only source |
| --- | --- |
| Claude | OAuth usage API with credentials from `~/.claude/.credentials.json`, falling back to the `Claude Code-credentials` macOS Keychain item when the file is missing, invalid or expired. |
| Codex | Latest usable account-wide rate limits from local `~/.codex/sessions/rollout-*.jsonl` files, including dated subfolders. Window labels use `window_minutes`. |
| Cursor | Usage-summary API with the existing login in `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. |
| Copilot | GitHub AI-credit billing API with an explicitly configured fine-grained PAT, Account permissions > Plan > Read-only. Disabled unless configured. |
| OpenCode | Local monthly/all-time spend and token counts in `~/.local/share/opencode/opencode.db` (the `session` totals schema). This is recorded spend, not a remaining quota. |

macOS may ask to allow this app to read the Claude Code Keychain item. Denying
access leaves a visible error for Claude; other providers continue working.
Locally signed builds also support legacy Keychain items through Apple's bundled
`/usr/bin/security` reader, capturing the credential in memory only.
The app never signs in, refreshes login tokens, or modifies provider databases.
Sign in again using the provider's own app if its credentials expire. Credentials
are not included in the cache or diagnostic output.

Codex values are snapshots, not a live API: an expired reset is shown as
**awaiting new session data** until Codex writes a new event. The reader checks
the 20 most recently modified rollout files and up to the final 8 MiB per file.
Sparse or older logs outside that bound may show **no session data**. The source
timestamp is displayed next to each provider. Fetch failures preserve the last
good values in amber with their original timestamp and the error text.
Claude's `spnd` row shows its enabled spending limit utilization when available,
including credit/team plans that do not expose subscription quota windows. No
reset countdown is invented when the API does not supply one.

`CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `XDG_DATA_HOME` are honored when present in
the app's environment. Apps launched from Finder do not inherit shell profile
variables. The Linux-only Devin, Ollama and Claude raw-token extensions are not
included in this port.

## Configuration

On first launch, the app copies [config.example.json](config.example.json) to
`~/.config/usage-overlay/config.json` without overwriting an existing file.
Choose **Reload configuration** after editing it.

| Key | Default | Meaning |
| --- | --- | --- |
| `sections` | `"auto"` | Detect installed tools, or list e.g. `["claude", "codex", "cursor"]`. An empty list hides all sections. |
| `refreshSeconds` | `60` | Local polling interval, minimum 15 seconds. Remote APIs are polled every third tick; Refresh now polls all providers. |
| `corner` | `"top-right"` | `top-right`, `top-left`, `bottom-right`, `bottom-left`. Used until a position is saved. |
| `marginX`, `marginY` | `14` | Distance in screen points from the visible screen edge. |
| `githubUser`, `githubToken` | empty | Enables Copilot. Keep this file private if adding a PAT. |
| `copilotIncluded` | `200` | Monthly included AI credits; set it to your actual plan. |
| `claudeKeychainService` | `"Claude Code-credentials"` | Keychain service override for custom Claude installations. |

The app caches only displayed usage in `macos-cache.json` in the same directory.
New config and cache files are user-readable/writable only. Windows `x`/`y`
settings are not used; macOS keeps position in its own preferences.

## Develop and verify

```sh
swift test --package-path macos
./macos/install.sh
"$HOME/Applications/Usage Overlay.app/Contents/MacOS/UsageOverlay" --diagnose
```

`--diagnose` outputs sanitized usage JSON and exits without showing the overlay.
It uses the same sources and can trigger the normal Claude Keychain prompt.
Tests use temporary fixtures, never your account credentials. GitHub Actions
builds, tests and verifies the installed bundle on both Apple Silicon and Intel.
