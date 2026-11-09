// Claude Code token counter, in GJS (replaces the old claude-tokens.js Node
// helper). Sums input+output tokens from the session transcripts Claude Code
// writes under ~/.claude/projects/**/*.jsonl, for today and the last 7 days.
//
// Those transcripts add up to hundreds of MB, and this runs inside GNOME
// Shell, so it never re-reads them wholesale: the first count reads each file
// asynchronously in chunks, and every count after that reads only the bytes
// appended since. Per file it keeps just (timestamp, tokens) pairs from the
// last week, so memory stays small.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
// Files untouched for longer than this can't hold anything inside the 7-day
// window, so they're skipped (and forgotten).
const SCAN_HORIZON_MS = 8 * DAY_MS;
const CHUNK_BYTES = 1 << 20;
const ENUM_BATCH = 100;
const NEWLINE = 10;

const decoder = new TextDecoder();

// Every *.jsonl under dir modified since minMtimeMs, as { path, size }.
async function listRecentJsonl(dir, minMtimeMs, cancellable) {
    const out = [];
    const stack = [Gio.File.new_for_path(dir)];
    const attrs = 'standard::name,standard::type,standard::size,time::modified';
    while (stack.length) {
        const d = stack.pop();
        let en;
        try {
            en = await d.enumerate_children_async(attrs,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, GLib.PRIORITY_LOW, cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
            continue;   // unreadable dir: skip it
        }
        try {
            for (;;) {
                const infos = await en.next_files_async(ENUM_BATCH, GLib.PRIORITY_LOW, cancellable);
                if (!infos.length) break;
                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        stack.push(d.get_child(name));
                    } else if (name.endsWith('.jsonl')) {
                        const mt = info.get_modification_date_time();
                        if (mt && mt.to_unix() * 1000 >= minMtimeMs)
                            out.push({ path: d.get_child(name).get_path(), size: info.get_size() });
                    }
                }
            }
        } finally {
            en.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
    return out;
}

// Append (timestamp ms, tokens) pairs from complete JSONL lines to samples.
function parseLines(bytes, samples) {
    for (const line of decoder.decode(bytes).split('\n')) {
        // Most of the volume is tool output; only lines mentioning usage are
        // worth a JSON.parse.
        if (!line.includes('"usage"')) continue;
        let entry;
        try { entry = JSON.parse(line); } catch (_e) { continue; }
        const usage = entry?.message?.usage;
        if (!usage) continue;
        const ts = Date.parse(entry.timestamp);
        if (Number.isNaN(ts)) continue;
        const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0);
        if (tokens > 0) samples.push(ts, tokens);
    }
}

export class ClaudeTokenCounter {
    constructor(root) {
        this._root = root;
        // path -> { offset, rest: Uint8Array|null, samples: [ts, tokens, ...] }
        this._files = new Map();
    }

    async count(cancellable = null) {
        const now = Date.now();
        const files = await listRecentJsonl(this._root, now - SCAN_HORIZON_MS, cancellable);

        const seen = new Set();
        for (const f of files) {
            seen.add(f.path);
            let st = this._files.get(f.path);
            // New file, or one that shrank (rewritten): start it from scratch.
            if (!st || f.size < st.offset) {
                st = { offset: 0, rest: null, samples: [] };
                this._files.set(f.path, st);
            }
            if (f.size > st.offset) {
                try {
                    await this._readAppended(f.path, st, cancellable);
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) throw e;
                    this._files.delete(f.path);   // retry the whole file next time
                }
            }
        }
        for (const path of [...this._files.keys()]) {
            if (!seen.has(path)) this._files.delete(path);
        }

        const todayStart = new Date(now);
        todayStart.setHours(0, 0, 0, 0);
        const todayMs = todayStart.getTime();
        const weekMs = now - WEEK_MS;
        let today = 0, week = 0;
        for (const st of this._files.values()) {
            // Drop samples that fell out of the window for good; time only
            // moves forward, so they'll never count again.
            const kept = [];
            const s = st.samples;
            for (let i = 0; i < s.length; i += 2) {
                if (s[i] < weekMs) continue;
                kept.push(s[i], s[i + 1]);
                week += s[i + 1];
                if (s[i] >= todayMs) today += s[i + 1];
            }
            st.samples = kept;
        }
        return { today, week };
    }

    // Read the bytes past st.offset in chunks, parsing complete lines and
    // holding a trailing partial line (still being written) for next time.
    async _readAppended(path, st, cancellable) {
        const stream = await Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, cancellable);
        try {
            if (st.offset > 0) stream.seek(st.offset, GLib.SeekType.SET, cancellable);
            for (;;) {
                const bytes = await stream.read_bytes_async(CHUNK_BYTES, GLib.PRIORITY_LOW, cancellable);
                const n = bytes.get_size();
                if (n === 0) break;
                st.offset += n;
                let data = bytes.toArray();
                if (st.rest) {
                    const merged = new Uint8Array(st.rest.length + data.length);
                    merged.set(st.rest);
                    merged.set(data, st.rest.length);
                    data = merged;
                }
                const lastNl = data.lastIndexOf(NEWLINE);
                if (lastNl < 0) {
                    st.rest = data;
                    continue;
                }
                st.rest = lastNl + 1 < data.length ? data.slice(lastNl + 1) : null;
                parseLines(data.subarray(0, lastNl), st.samples);
            }
        } finally {
            stream.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
}
