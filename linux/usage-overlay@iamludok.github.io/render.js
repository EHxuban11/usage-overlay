// Pure formatting helpers, ported from usage-overlay.ps1's rendering section.
// No shell imports here so this file stays trivially testable with plain gjs.
//
// The overlay and the panel-menu both render into a Pango markup string that an
// St.Label draws with clutter_text.use_markup = true.

const GREEN = '#7EE787';
const AMBER = '#E3B341';
const RED = '#FF7B72';
const MUTED = '#8B949E';
const TEXT = '#C9D1D9';
const BODY = '#E6EDF3';
const FAINT = '#484F58';

// Retro accent per provider, used to tint its pixel-art glyph in the panel.
// Hex -> the [r,g,b] triples Cairo wants (0..1), so icons.js can consume it
// straight from here without a second colour table to keep in sync.
export const PROVIDER_COLOR = {
    claude: '#D97757',
    claudeTokens: '#D97757',
    codex: '#10A37F',
    cursor: '#6C7CFF',
    copilot: '#8957E5',
    opencode: '#F2C744',
    devin: '#F778BA',
    ollama: '#E6EDF3',
};

export function hexToRgb(hex) {
    const n = Number.parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// Get-Bar: 10 cells, ~10% each.
export function getBar(pct) {
    const filled = Math.round(Math.min(pct, 100) / 10);
    return '#'.repeat(filled) + '-'.repeat(10 - filled);
}

// Get-PctColor: green <60, amber 60-84, red 85+.
export function getPctColor(pct) {
    if (pct >= 85) return RED;
    if (pct >= 60) return AMBER;
    return GREEN;
}

// Get-HttpErrLabel: shared HTTP-status -> user-facing label.
export function httpErrLabel(status, extra = {}) {
    if (status in extra) return extra[status];
    switch (status) {
    case 401: return 'auth stale';
    case 429: return 'rate limited';
    default: return 'offline';
    }
}

// Format-Reset: a short countdown to the reset instant. Accepts an ISO string
// (what we cache to disk) or null.
export function formatReset(iso) {
    if (!iso) return '--';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '--';
    const mins = (ms - Date.now()) / 60000;
    if (mins <= 0) return 'now';
    if (mins < 60) return `${Math.ceil(mins)}m`;
    const hours = mins / 60;
    if (hours >= 48) return `${Math.round(hours / 24)}d`;
    return `${Math.round(hours)}h`;
}

// Pango markup requires &, <, > escaped.
export function escapeMarkup(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function span(color, text) {
    return `<span foreground="${color}">${escapeMarkup(text)}</span>`;
}

function spanBold(color, text) {
    return `<span foreground="${color}" weight="bold">${escapeMarkup(text)}</span>`;
}

// One provider's block (may be several lines). `provider` has { name },
// `data` is the cached fetch result { ok, rows|textRows, err, stale }.
export function providerMarkup(provider, data) {
    if (!data.ok) {
        return span(MUTED, `${provider.name}  ${data.err}`);
    }
    const nameColor = data.stale ? AMBER : MUTED;

    // Text-only sections (OpenCode spend): no bar/% columns.
    if (data.textRows) {
        return data.textRows.map((t, i) => {
            const prefix = i === 0 ? provider.name : '      ';
            return span(nameColor, `${prefix} `) + span(TEXT, t);
        }).join('\n');
    }

    return data.rows.map((row, i) => {
        const prefix = i === 0 ? provider.name : '      ';
        const pctColor = getPctColor(row.pct);
        const pct = String(Math.round(row.pct)).padStart(3);
        return (
            span(nameColor, `${prefix} `) +
            span(MUTED, `${row.label} `) +
            span(pctColor, getBar(row.pct)) +
            span(pctColor, ` ${pct}% `) +
            span(MUTED, `r ${formatReset(row.resets)}`)
        );
    }).join('\n');
}

export const PANEL_SEPARATOR = FAINT;

// One panel entry per row of a provider's cached result — e.g. Claude's 5h
// and week limits both show as "12%/4h", "20%/5d" (percentage and time to
// reset), each independently coloured by its own threshold, instead of
// collapsing them into a single worst-case number. Text-only sections
// (OpenCode, TOKENS) get a single entry with their first line. A result with
// no rows at all (ok:true but nothing usable, e.g. an old Codex session with
// no rate-limit windows) falls back to '--' same as no data.
export function panelRows(data) {
    if (!data || !data.ok) return [{ text: '--', color: MUTED }];
    if (data.textRows) return [{ text: data.textRows[0], color: data.stale ? AMBER : TEXT }];
    if (!data.rows || data.rows.length === 0) return [{ text: '--', color: MUTED }];
    return data.rows.map(row => ({
        text: `${Math.round(row.pct)}%/${formatReset(row.resets)}`,
        color: data.stale ? AMBER : getPctColor(row.pct),
    }));
}

// Static legend, ported from Build-Panel. `refreshSeconds` is interpolated in.
export function legendMarkup(refreshSeconds) {
    const H = '#58A6FF';
    return [
        spanBold(TEXT, 'USAGE OVERLAY') + span(MUTED, '  quota across your coding agents'),
        '',
        spanBold(H, 'COLORS'),
        '  ' + span(GREEN, 'green') + span(MUTED, ' <60%   ') +
            span(AMBER, 'amber') + span(MUTED, ' 60-84%   ') +
            span(RED, 'red') + span(MUTED, ' 85%+'),
        span(MUTED, '  amber section name = cached, not live'),
        '',
        spanBold(H, 'PANEL FORMAT'),
        span(MUTED, '  ') + span(TEXT, '12%/4h') + span(MUTED, ' = percentage / time to reset   ') +
            span(TEXT, '·') + span(MUTED, ' separates a provider\'s rows (e.g. 5h · week)'),
        span(MUTED, '  TOKENS has no panel icon — its today/week counts are in this menu only'),
        '',
        spanBold(H, 'REFRESH'),
        span(MUTED, `  every ${refreshSeconds}s; `) +
            span(TEXT, 'CLAUDE/CURSOR/COPILT/DEVIN') + span(MUTED, ' (remote) every 3rd tick'),
        span(MUTED, '  on failure, keeps the last value (') +
            span(AMBER, 'amber') + span(MUTED, '), cached to disk'),
        '',
        spanBold(H, 'SOURCES'),
        span(TEXT, '  CLAUDE') + span(MUTED, '  Anthropic OAuth token   ') + span(TEXT, '5h/wk/model'),
        span(TEXT, '  TOKENS') + span(MUTED, '  local session transcripts   ') + span(TEXT, 'today/wk') + span(MUTED, ' = tokens'),
        span(TEXT, '  CODEX ') + span(MUTED, '  last local session log   ') + span(TEXT, '5h/wk'),
        span(TEXT, '  CURSOR') + span(MUTED, '  token from Cursor state.vscdb   ') + span(TEXT, 'api/tot'),
        span(TEXT, '  COPILT') + span(MUTED, '  PAT from config.json   ') + span(TEXT, 'mo') + span(MUTED, ' = AI credits'),
        span(TEXT, '  OLLAMA') + span(MUTED, '  cookie from config.json   ') + span(TEXT, 'free/5h/wk'),
        span(TEXT, '  DEVIN ') + span(MUTED, '  apiKey from Devin/Windsurf state.vscdb   ') + span(TEXT, 'wk'),
        span(TEXT, '  OPENCD') + span(MUTED, '  local spend, no quota API   ') + span(TEXT, 'mo/all') + span(MUTED, ' = $ spent'),
        '',
        spanBold(H, 'ERRORS'),
        span(TEXT, '  rate limited') + span(MUTED, '=429   ') +
            span(TEXT, 'auth stale') + span(MUTED, '=401   ') +
            span(TEXT, 'offline') + span(MUTED, '=network'),
        span(TEXT, '  no token / no permission / check user') + span(MUTED, ' = fix config.json (COPILT)'),
    ].join('\n');
}
