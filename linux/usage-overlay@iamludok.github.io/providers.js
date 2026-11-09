// Data layer, ported from the Get-*Usage functions in usage-overlay.ps1.
//
// Each provider exposes detect(ctx) -> bool and async fetch(ctx) -> result,
// where a result is { ok:true, rows|textRows } or { ok:false, err }. rows carry
// { label, pct, resets } with resets as an ISO string (or null) so results
// serialize straight to the on-disk cache.
//
// ctx = { home, extDir, nodeExe, config, session, cancellable }  (built in
// extension.js; fetchers may also stash per-run state on it, e.g. tokenCounter)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { httpErrLabel } from './render.js';
import { ClaudeTokenCounter } from './tokens.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder();

function decode(bytes) {
    return decoder.decode(bytes instanceof Uint8Array ? bytes : bytes.get_data());
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function epochToIso(sec) {
    const n = Number(sec);
    if (!Number.isFinite(n)) return null;
    return new Date(n * 1000).toISOString();
}

// node's SQLite warning goes to stderr; stdout is JSON. Take the last JSON line.
function parseJsonLine(out) {
    if (!out) return null;
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]); } catch (_e) { /* keep scanning up */ }
    }
    return null;
}

async function httpGetJson(ctx, url, headers) {
    const msg = Soup.Message.new('GET', url);
    for (const [k, v] of Object.entries(headers))
        msg.request_headers.append(k, v);
    const bytes = await ctx.session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null);
    const status = msg.get_status();
    return { status, text: decode(bytes) };
}

// The SQLite-backed providers (Cursor, Devin, OpenCode) go through Node's
// built-in node:sqlite, since GJS has no SQLite binding of its own.
async function runNode(ctx, mode) {
    const args = [ctx.nodeExe, GLib.build_filenamev([ctx.extDir, 'sqlite-usage.js']), mode];
    const proc = Gio.Subprocess.new(
        args, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    const [stdout] = await proc.communicate_utf8_async(null, ctx.cancellable);
    return stdout;
}

// Newest-first list of Codex rollout logs, walking the year/month/day tree.
function listCodexRollouts(dir) {
    const results = [];
    const stack = [Gio.File.new_for_path(dir)];
    const attrs = 'standard::name,standard::type,time::modified';
    while (stack.length) {
        const d = stack.pop();
        let en;
        try {
            en = d.enumerate_children(attrs, Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        } catch (_e) { continue; }
        let info;
        while ((info = en.next_file(null)) !== null) {
            const name = info.get_name();
            const child = d.get_child(name);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                stack.push(child);
            } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
                const mt = info.get_modification_date_time();
                results.push({ path: child.get_path(), mtime: mt ? mt.to_unix() : 0 });
            }
        }
        en.close(null);
    }
    results.sort((a, b) => b.mtime - a.mtime);
    return results;
}

// ---------- fetchers ----------

async function fetchClaude(ctx) {
    try {
        const [ok, contents] = GLib.file_get_contents(
            GLib.build_filenamev([ctx.home, '.claude', '.credentials.json']));
        if (!ok) return { ok: false, err: 'read failed' };
        const cred = JSON.parse(decode(contents)).claudeAiOauth;
        const { status, text } = await httpGetJson(ctx,
            'https://api.anthropic.com/api/oauth/usage', {
                Authorization: `Bearer ${cred.accessToken}`,
                'anthropic-beta': 'oauth-2025-04-20',
            });
        if (status !== 200) return { ok: false, err: httpErrLabel(status) };
        const r = JSON.parse(text);
        const rows = [];
        rows.push({ label: '5h ', pct: Number(r.five_hour.utilization), resets: r.five_hour.resets_at || null });
        rows.push({ label: 'wk ', pct: Number(r.seven_day.utilization), resets: r.seven_day.resets_at || null });
        for (const lim of r.limits || []) {
            if (lim.kind === 'weekly_scoped' && lim.scope?.model?.display_name) {
                const name = lim.scope.model.display_name.toLowerCase().slice(0, 3);
                rows.push({ label: name, pct: Number(lim.percent), resets: lim.resets_at || null });
            }
        }
        return { ok: true, rows };
    } catch (_e) {
        return { ok: false, err: 'offline' };
    }
}

function formatTokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
    return String(n);
}

// Raw token counts (today / last 7 days), read from Claude Code's own local
// transcripts. Complements fetchClaude's percent-of-quota rows, which don't
// say how many actual tokens that was.
async function fetchClaudeTokens(ctx) {
    try {
        // Lives on ctx so it survives between ticks and only reads what the
        // transcripts gained since the last count (see tokens.js).
        ctx.tokenCounter ??= new ClaudeTokenCounter(
            GLib.build_filenamev([ctx.home, '.claude', 'projects']));
        const j = await ctx.tokenCounter.count(ctx.cancellable);
        return { ok: true, textRows: [
            `today ${formatTokens(Number(j.today))} tok`,
            `wk ${formatTokens(Number(j.week))} tok`,
        ] };
    } catch (_e) {
        return { ok: false, err: 'read failed' };
    }
}

async function fetchCodex(ctx) {
    try {
        return readCodexRateLimits(ctx) || { ok: false, err: 'no session data' };
    } catch (_e) {
        return { ok: false, err: 'read failed' };
    }
}

// Latest 5h/weekly windows from the newest rollouts that logged any, or null.
// Shared by fetchCodex and Codex's detect, so a sessions dir holding only
// rollouts without quota data (e.g. a session that never reached the server)
// doesn't put a permanent "--" in the panel.
function readCodexRateLimits(ctx) {
    const dir = GLib.build_filenamev([ctx.home, '.codex', 'sessions']);
    for (const f of listCodexRollouts(dir).slice(0, 5)) {
        const [ok, contents] = GLib.file_get_contents(f.path);
        if (!ok) continue;
        const lines = decode(contents).split('\n').filter(l => l.includes('"rate_limits"'));
        if (!lines.length) continue;
        const rl = JSON.parse(lines[lines.length - 1]).payload?.rate_limits;
        if (!rl) continue;
        const rows = [];
        if (rl.primary)
            rows.push({ label: '5h ', pct: Number(rl.primary.used_percent), resets: epochToIso(rl.primary.resets_at) });
        if (rl.secondary)
            rows.push({ label: 'wk ', pct: Number(rl.secondary.used_percent), resets: epochToIso(rl.secondary.resets_at) });
        // This rollout logged a rate_limits event, but with neither window
        // populated (seen on old/free-tier sessions) — try an older one
        // instead of reporting a provider with nothing to show.
        if (rows.length === 0) continue;
        return { ok: true, rows };
    }
    return null;
}

async function fetchCursor(ctx) {
    try {
        if (!ctx.nodeExe) return { ok: false, err: 'node missing' };
        const j = parseJsonLine(await runNode(ctx, 'cursor'));
        if (!j || j.error) return { ok: false, err: 'fetch failed' };
        return { ok: true, rows: [
            { label: 'api', pct: Number(j.api), resets: j.resets || null },
            { label: 'tot', pct: Number(j.total), resets: j.resets || null },
        ] };
    } catch (_e) {
        return { ok: false, err: 'read failed' };
    }
}

async function fetchCopilot(ctx) {
    try {
        if (!ctx.config.githubUser || !ctx.config.githubToken) return { ok: false, err: 'no token' };
        const now = new Date();
        const url = `https://api.github.com/users/${ctx.config.githubUser}` +
            `/settings/billing/ai_credit/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`;
        const { status, text } = await httpGetJson(ctx, url, {
            Authorization: `Bearer ${ctx.config.githubToken}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2026-03-10',
        });
        if (status !== 200)
            return { ok: false, err: httpErrLabel(status, { 403: 'no permission', 404: 'check user' }) };
        const r = JSON.parse(text);
        let used = 0;
        for (const item of r.usageItems || [])
            if (!item.product || item.product === 'copilot') used += Number(item.grossQuantity);
        const included = Number(ctx.config.copilotIncluded) || 200;
        const pct = included > 0 ? used / included * 100 : 0;
        // AI credits reset on the 1st of next month, 00:00 UTC.
        const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
        return { ok: true, rows: [{ label: 'mo ', pct, resets }] };
    } catch (_e) {
        return { ok: false, err: 'offline' };
    }
}

async function fetchDevin(ctx) {
    try {
        if (!ctx.nodeExe) return { ok: false, err: 'node missing' };
        const j = parseJsonLine(await runNode(ctx, 'devin'));
        if (!j || j.error) return { ok: false, err: j?.error === 'not logged in' ? 'not logged in' : 'fetch failed' };
        // The app only shows the weekly quota; the API's daily figure sits at 0%
        // and never moves, so it's only a fallback when there is no weekly one.
        const rows = [];
        if (typeof j.weekly === 'number')
            rows.push({ label: 'wk ', pct: 100 - j.weekly, resets: epochToIso(j.weeklyResets) });
        else if (typeof j.daily === 'number')
            rows.push({ label: 'day', pct: 100 - j.daily, resets: epochToIso(j.dailyResets) });
        if (rows.length === 0) return { ok: false, err: 'no quota data' };
        return { ok: true, rows };
    } catch (_e) {
        return { ok: false, err: 'read failed' };
    }
}

async function fetchOpenCode(ctx) {
    try {
        if (!ctx.nodeExe) return { ok: false, err: 'node missing' };
        const j = parseJsonLine(await runNode(ctx, 'opencode'));
        if (!j || j.error) return { ok: false, err: 'read failed' };
        const mtok = (Number(j.tin) + Number(j.tout)) / 1e6;
        return { ok: true, textRows: [
            `mo $${Number(j.month).toFixed(2)} spent`,
            `all $${Number(j.total).toFixed(2)} / ${mtok.toFixed(1)}M tok`,
        ] };
    } catch (_e) {
        return { ok: false, err: 'read failed' };
    }
}

// ollama.com has no usage API; the numbers only exist in the /settings HTML,
// behind the session cookie the user pastes into config.json (ollamaCookie).
// Each meter is "<label> ... N% used", followed by a data-time reset stamp.
function ollamaLabel(name) {
    const n = name.toLowerCase();
    if (n.includes('session') || n.includes('hour')) return '5h ';
    if (n.includes('week')) return 'wk ';
    if (n.includes('month')) return 'mo ';
    return n.replace(/\s*usage\s*$/, '').slice(0, 3).padEnd(3);
}

async function fetchOllama(ctx) {
    try {
        if (!ctx.config.ollamaCookie) return { ok: false, err: 'no cookie' };
        const { status, text } = await httpGetJson(ctx, 'https://ollama.com/settings', {
            Cookie: ctx.config.ollamaCookie,
        });
        // Signed-out requests get a 303 to the login page (Soup follows it).
        if (status !== 200 || !text.includes('% used')) return { ok: false, err: 'not logged in' };
        const rows = [];
        const re = /<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>\s*([\d.]+)%\s*used\s*<\/span>/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const next = text.slice(re.lastIndex, re.lastIndex + 2500);
            const t = /data-time="([^"]+)"/.exec(next);
            rows.push({ label: ollamaLabel(m[1].trim()), pct: Number(m[2]), resets: t ? t[1] : null });
        }
        if (rows.length === 0) return { ok: false, err: 'no quota data' };
        return { ok: true, rows };
    } catch (_e) {
        return { ok: false, err: 'offline' };
    }
}

// ---------- registry ----------
//
// One entry per source (mirrors the $providers registry). remote=true providers
// hit a rate-limited network API and are polled every 3rd tick; autoHide=true
// means "needs explicit config, never shown by the nothing-detected fallback".

export const PROVIDERS = [
    { key: 'claude', name: 'CLAUDE', remote: true, fetch: fetchClaude,
        detect: ctx => exists(GLib.build_filenamev([ctx.home, '.claude', '.credentials.json'])) },
    { key: 'claudeTokens', name: 'TOKENS', remote: false, fetch: fetchClaudeTokens,
        detect: ctx => exists(GLib.build_filenamev([ctx.home, '.claude', 'projects'])) },
    { key: 'codex', name: 'CODEX ', remote: false, fetch: fetchCodex,
        // Only show Codex once a recent rollout actually logged quota windows:
        // an empty sessions dir, or one with only quota-less sessions, would
        // otherwise sit in the panel as a permanent "--".
        detect: ctx => { try { return readCodexRateLimits(ctx) !== null; } catch (_e) { return false; } } },
    { key: 'cursor', name: 'CURSOR', remote: true, fetch: fetchCursor,
        detect: ctx => exists(GLib.build_filenamev([ctx.home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'])) },
    { key: 'copilot', name: 'COPILT', remote: true, fetch: fetchCopilot, autoHide: true,
        detect: ctx => !!ctx.config.githubToken && !!ctx.config.githubUser },
    { key: 'devin', name: 'DEVIN ', remote: true, fetch: fetchDevin,
        detect: ctx => !!ctx.nodeExe && ['Devin', 'Windsurf'].some(app =>
            exists(GLib.build_filenamev([ctx.home, '.config', app, 'User', 'globalStorage', 'state.vscdb']))) },
    { key: 'ollama', name: 'OLLAMA', remote: true, fetch: fetchOllama, autoHide: true,
        detect: ctx => !!ctx.config.ollamaCookie },
    { key: 'opencode', name: 'OPENCD', remote: false, fetch: fetchOpenCode,
        detect: ctx => exists(GLib.build_filenamev([ctx.home, '.local', 'share', 'opencode', 'opencode.db'])) },
];

// Resolve which providers to show, in registry order (mirrors $enabledProviders).
export function resolveEnabled(ctx) {
    const sections = ctx.config.sections;
    if (Array.isArray(sections)) {
        const wanted = sections.map(s => String(s).toLowerCase());
        return PROVIDERS.filter(p => wanted.includes(p.key));
    }
    // "auto": only tools with local data/config; if none, fall back to
    // everything that runs without extra config.
    let enabled = PROVIDERS.filter(p => {
        try { return p.detect(ctx); } catch (_e) { return false; }
    });
    if (enabled.length === 0) enabled = PROVIDERS.filter(p => !p.autoHide);
    return enabled;
}
