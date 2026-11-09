// Node helper: sums Claude Code's own local token usage from the session
// transcripts it writes under ~/.claude/projects/**/*.jsonl, so the overlay
// can show tokens spent today and in the last 7 days without another API
// call (the quota endpoint gives percentages, not raw counts).
// Prints one JSON line: { today, week } (raw input+output token counts).
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.claude', 'projects');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Files that haven't changed in longer than this can't hold anything inside
// the 7-day window, so skip reading them.
const SCAN_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

function listJsonlFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsonlFiles(full));
    else if (entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function main() {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const weekStart = now - WEEK_MS;

  let today = 0;
  let week = 0;

  for (const file of listJsonlFiles(ROOT)) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_e) {
      continue;
    }
    if (now - stat.mtimeMs > SCAN_HORIZON_MS) continue;

    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_e) {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (_e) {
        continue;
      }
      const usage = entry?.message?.usage;
      if (!usage) continue;
      const ts = Date.parse(entry.timestamp);
      if (Number.isNaN(ts) || ts < weekStart) continue;
      const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
      week += tokens;
      if (ts >= todayStart.getTime()) today += tokens;
    }
  }

  console.log(JSON.stringify({ today, week }));
}

try {
  main();
} catch (e) {
  console.log(JSON.stringify({ error: String(e) }));
}
