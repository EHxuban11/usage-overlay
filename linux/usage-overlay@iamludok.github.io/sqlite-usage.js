// Node helper for the providers that need SQLite, which PowerShell 5.1 can't
// read natively. Prints one JSON line for usage-overlay.ps1:
//   node sqlite-usage.js cursor    -> Cursor plan usage (token from state.vscdb)
//   node sqlite-usage.js opencode  -> OpenCode local spend from opencode.db
//   node sqlite-usage.js devin     -> Devin/Windsurf ACU quota (apiKey from state.vscdb)
const os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

const mode = process.argv[2];

// Cursor's state DB lives under %APPDATA% on Windows and ~/.config on Linux,
// so the one helper works on both platforms.
const cursorDbPath = process.platform === 'win32'
  ? process.env.APPDATA + '\\Cursor\\User\\globalStorage\\state.vscdb'
  : path.join(os.homedir(), '.config/Cursor/User/globalStorage/state.vscdb');

if (mode === 'cursor') {
  // Read Cursor's session token from its local state.vscdb and print the plan
  // usage summary. Cursor stores no quota locally, so we still hit its API,
  // but the SQLite read is what makes this a Node helper.
  try {
    const db = new DatabaseSync(cursorDbPath, { readOnly: true });
    const token = db.prepare("SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'").get().value;
    const sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
    const userId = sub.includes('|') ? sub.split('|').pop() : sub;
    fetch('https://cursor.com/api/usage-summary', {
      headers: { Cookie: `WorkosCursorSessionToken=${userId}%3A%3A${token}` },
      signal: AbortSignal.timeout(8000),
    })
      .then((r) => r.json())
      .then((j) => {
        console.log(JSON.stringify({
          api: j.individualUsage.plan.apiPercentUsed,
          total: j.individualUsage.plan.totalPercentUsed,
          resets: j.billingCycleEnd,
        }));
      })
      .catch((e) => console.log(JSON.stringify({ error: String(e) })));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
} else if (mode === 'opencode') {
  // OpenCode Zen is a prepaid-credit product with no usage/quota API reachable
  // from the local API key, so we report locally-tracked spend from opencode.db
  // (this calendar month + all-time).
  try {
    const db = new DatabaseSync(path.join(os.homedir(), '.local/share/opencode/opencode.db'), { readOnly: true });
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const all = db.prepare('SELECT SUM(cost) c, SUM(tokens_input) ti, SUM(tokens_output) to_ FROM session').get();
    const mo = db.prepare('SELECT SUM(cost) c FROM session WHERE time_created >= ?').get(monthStart);
    console.log(JSON.stringify({
      month: mo.c || 0,
      total: all.c || 0,
      tin: all.ti || 0,
      tout: all.to_ || 0,
    }));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
} else if (mode === 'devin') {
  // Devin Desktop (formerly Windsurf) has no public usage API for self-serve
  // plans, but its editor is a VS Code fork built on the codeium.windsurf
  // extension, which caches the account's apiKey in plain JSON in its own
  // state.vscdb (Cognition merged Devin/Windsurf billing, so either app dir
  // may hold it). We replay that key against the same Connect-RPC endpoint
  // the desktop app itself calls to render its quota bar.
  (async () => {
    const candidates = ['Devin', 'Windsurf'].map(app =>
      path.join(os.homedir(), `.config/${app}/User/globalStorage/state.vscdb`));
    let apiKey = null;
    for (const dbPath of candidates) {
      try {
        const db = new DatabaseSync(dbPath, { readOnly: true });
        const row = db.prepare("SELECT value FROM ItemTable WHERE key='windsurfAuthStatus'").get();
        db.close();
        if (row) {
          const key = JSON.parse(row.value).apiKey;
          if (key) { apiKey = key; break; }
        }
      } catch (_e) { /* try next candidate */ }
    }
    if (!apiKey) return console.log(JSON.stringify({ error: 'not logged in' }));

    const body = JSON.stringify({
      metadata: {
        apiKey, ideName: 'windsurf', ideVersion: '1.9600.41',
        extensionName: 'windsurf', extensionVersion: '1.9600.41', locale: 'en',
      },
    });
    const hosts = ['server.codeium.com', 'server.self-serve.windsurf.com'];
    for (const host of hosts) {
      try {
        const r = await fetch(`https://${host}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
          body,
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const ps = (await r.json())?.userStatus?.planStatus || {};
        return console.log(JSON.stringify({
          daily: typeof ps.dailyQuotaRemainingPercent === 'number' ? ps.dailyQuotaRemainingPercent : null,
          weekly: typeof ps.weeklyQuotaRemainingPercent === 'number' ? ps.weeklyQuotaRemainingPercent : null,
          dailyResets: ps.dailyQuotaResetAtUnix ?? null,
          weeklyResets: ps.weeklyQuotaResetAtUnix ?? null,
        }));
      } catch (_e) { /* try next host */ }
    }
    console.log(JSON.stringify({ error: 'fetch failed' }));
  })();
} else {
  console.log(JSON.stringify({ error: 'usage: sqlite-usage.js cursor|opencode|devin' }));
}
