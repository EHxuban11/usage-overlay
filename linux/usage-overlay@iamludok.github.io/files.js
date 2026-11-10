// Async file helpers. Everything here runs inside GNOME Shell, so no file is
// read or directory listed synchronously: a slow disk must never stall the
// desktop. Gio's async methods are promisified once, here, for every module.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'make_directory_async');
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'close_async');
Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

const decoder = new TextDecoder();
const ENUM_BATCH = 100;

export function isCancelled(e) {
    return !!e?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// Whether path exists (file or directory).
export async function exists(path, cancellable = null) {
    try {
        await Gio.File.new_for_path(path).query_info_async('standard::type',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable);
        return true;
    } catch (e) {
        if (isCancelled(e)) throw e;
        return false;
    }
}

// Whole file as a UTF-8 string. Throws if it's missing or unreadable.
export async function readText(path, cancellable = null) {
    const [contents] = await Gio.File.new_for_path(path).load_contents_async(cancellable);
    return decoder.decode(contents);
}

// Like readText, but null when the file is missing or unreadable.
export async function readTextOrNull(path, cancellable = null) {
    try {
        return await readText(path, cancellable);
    } catch (e) {
        if (isCancelled(e)) throw e;
        return null;
    }
}

// Every regular file under dir (recursively) whose name passes match and that
// was modified at or after minMtimeMs, as { path, size, mtimeMs }. Unreadable
// directories are skipped.
export async function listFiles(dir, { match = () => true, minMtimeMs = 0 } = {}, cancellable = null) {
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
            if (isCancelled(e)) throw e;
            continue;
        }
        try {
            for (;;) {
                const infos = await en.next_files_async(ENUM_BATCH, GLib.PRIORITY_LOW, cancellable);
                if (!infos.length) break;
                for (const info of infos) {
                    const name = info.get_name();
                    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                        stack.push(d.get_child(name));
                    } else if (match(name)) {
                        const mt = info.get_modification_date_time();
                        const mtimeMs = mt ? mt.to_unix() * 1000 : 0;
                        if (mtimeMs >= minMtimeMs)
                            out.push({ path: d.get_child(name).get_path(), size: info.get_size(), mtimeMs });
                    }
                }
            }
        } finally {
            en.close_async(GLib.PRIORITY_LOW, null).catch(() => {});
        }
    }
    return out;
}
