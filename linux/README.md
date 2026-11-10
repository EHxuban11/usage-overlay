# usage-overlay: Linux (GNOME)

A GNOME Shell extension port of [usage-overlay](../README.md). It shows how much
of your AI coding-agent quota you have used directly in the **top panel**: a
small retro pixel-art glyph plus a percentage per provider, always visible. It's
the same idea as a CPU/RAM panel indicator, one glyph per tool instead of one
per resource.

![usage-overlay in the GNOME top panel](../docs/overlay_fedora.png)

Click the indicator for Claude's raw token counts (today and this week) and the
actions below.

## The top-bar menu

| Item | Windows equivalent | What it does |
|------|--------------------|--------------|
| **Refresh now** | tray → Refresh now | Re-fetches every section immediately, remote APIs included. |
| **Reload (re-read config)** | tray → Restart | Tears down and rebuilds, picking up `config.json` edits. |
| **Legend** | the `?` button | Colours, bars, sources and error wording. |

There is no Quit item (the Windows tray → Exit): to turn it off, use the
Extensions app or `gnome-extensions disable usage-overlay@iamludok.github.io`.

The panel percentage is the *worst* (highest) value across that provider's rows
— the number closest to an actual limit. Green under 60%, amber from 60%, red
from 85%; on a fetch failure it keeps the last good number (shown amber) and
retries. The full per-row detail (5h/week/model, reset countdowns) is in the
dropdown menu.

## The glyphs

Hand-drawn 8x8 retro pixel icons, not brand logos, tinted with each provider's
accent colour: a sparkle for `CLAUDE`, a hex nut for `CODEX`, a mouse pointer
for `CURSOR`, an IC chip for `COPILT`, a terminal prompt for `OPENCD`, an
antenna'd robot head for `DEVIN`. See
[icons.js](usage-overlay@iamludok.github.io/icons.js) to tweak or add one.

## Requirements

- GNOME Shell 45–48 (developed on 48).
- `node` on `PATH` (22.5 or newer, for `node:sqlite`): needed only for
  `CURSOR`, `OPENCD` and `DEVIN`, which read local SQLite databases via
  [sqlite-usage.js](usage-overlay@iamludok.github.io/sqlite-usage.js). Everything
  else, `TOKENS` included, runs inside the extension with no extra tools.

## Install

```bash
cd linux
./install.sh          # copy + enable
./install.sh --link   # symlink instead (for development)
```

On Wayland a brand-new extension is only registered after a fresh session, so if
enabling fails, **log out and back in**, then:

```bash
gnome-extensions enable usage-overlay@iamludok.github.io
```

Manage it later with `gnome-extensions disable/enable usage-overlay@iamludok.github.io`.

### Packing for extensions.gnome.org

`gnome-extensions pack` only picks up `extension.js`, `metadata.json` and
`stylesheet.css` by itself, so list every other file:

```bash
cd linux/usage-overlay@iamludok.github.io
gnome-extensions pack . --force -o ~/Downloads \
  --extra-source=providers.js --extra-source=render.js \
  --extra-source=icons.js --extra-source=tokens.js --extra-source=files.js \
  --extra-source=sqlite-usage.js --extra-source=config.example.json \
  --extra-source=LICENSE
```

Don't `gnome-extensions install --force` that zip over an `./install.sh --link`
install: it empties the symlink's target, i.e. this source folder. Run
`gnome-extensions uninstall usage-overlay@iamludok.github.io` first.

## Sources

| Section | Tool | Where the data comes from |
|---------|------|---------------------------|
| `CLAUDE` | Claude Code | `api.anthropic.com/api/oauth/usage`, OAuth token from `~/.claude/.credentials.json`. |
| `TOKENS` | Claude Code | Raw token counts (today / last 7 days), summed locally from `~/.claude/projects/**/*.jsonl` — no API call, just what the quota endpoint doesn't report. |
| `CODEX` | OpenAI Codex CLI | Last `rate_limits` event in the newest `~/.codex/sessions` log. |
| `CURSOR` | Cursor | `cursor.com/api/usage-summary`, session token from `~/.config/Cursor/User/globalStorage/state.vscdb`. |
| `COPILT` | GitHub Copilot | Billing API (`ai_credit/usage`), fine-grained PAT in `config.json`. Off unless configured. |
| `OLLAMA` | Ollama Cloud | Scrapes `ollama.com/settings` (Ollama has no usage API), using your session cookie from `config.json`. Off unless configured. |
| `DEVIN` | Devin / Windsurf | Cognition's Connect-RPC `GetUserStatus`, apiKey from the Devin (or Windsurf) desktop app's `state.vscdb`. No public API for self-serve plans, so this replays the same call the desktop app makes to render its own quota bar. |
| `OPENCD` | OpenCode | Local spend from `~/.local/share/opencode/opencode.db`, shown as `$` spent. |

`sections: "auto"` shows only the tools with local data on this machine.

## Configuration

Edit `~/.config/usage-overlay/config.json` (created from
[config.example.json](usage-overlay@iamludok.github.io/config.example.json) on install).
Missing keys keep their defaults.

| Key | Values | Meaning |
|-----|--------|---------|
| `refreshSeconds` | 15 or more | Redraw interval. Remote APIs are polled every 3rd tick. |
| `sections` | `"auto"` or e.g. `["claude", "codex"]` | Which sections to show. |
| `githubUser`, `githubToken` | login, PAT | Enables `COPILT`. Fine-grained PAT: Account permissions → Plan → Read-only. |
| `copilotIncluded` | number, default 200 | Monthly AI credits in your Copilot plan (used for the %). |
| `ollamaCookie` | Cookie header string | Enables `OLLAMA`. In a logged-in browser: DevTools → Network → any request to ollama.com → copy the `Cookie` request header. Expires occasionally (shows "not logged in"); paste a fresh one. |

After editing config, reload the extension:
`gnome-extensions disable usage-overlay@iamludok.github.io && gnome-extensions enable usage-overlay@iamludok.github.io`.

## Troubleshooting

- Logs: `journalctl --user -f -o cat /usr/bin/gnome-shell`
- Test without touching your session: `dbus-run-session -- gnome-shell --nested --wayland`
- Cursor shows `fetch failed`: your Cursor session token has expired — sign in to Cursor again.
- Devin shows `not logged in`: sign in to the Devin (or Windsurf) desktop app so it caches an apiKey locally.
