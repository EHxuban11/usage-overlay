// Usage Overlay — GNOME Shell port of usage-overlay.ps1.
//
// A top-bar indicator that shows every enabled provider as a retro pixel-art
// glyph plus its worst percentage, always visible (no floating overlay, no
// clicking needed to see where you stand). Clicking it opens a menu with the
// full per-row breakdown and the usual actions. Provider/data logic lives in
// providers.js; formatting in render.js; the glyphs in icons.js.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Soup from 'gi://Soup';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { resolveEnabled } from './providers.js';
import { readTextOrNull, isCancelled } from './files.js';
import { providerMarkup, legendMarkup, panelRows, PANEL_SEPARATOR, escapeMarkup, PROVIDER_COLOR, hexToRgb } from './render.js';
import * as icons from './icons.js';

const DEFAULTS = {
    refreshSeconds: 60,
    sections: 'auto',
    githubUser: '',
    githubToken: '',
    copilotIncluded: 200,
};

const encoder = new TextEncoder();
const GLYPH_SIZE = 16;

// Top-bar button: one retro glyph + percentage per enabled provider, always
// visible. The dropdown menu (built by the extension) adds the full detail.
const UsageIndicator = GObject.registerClass(
class UsageIndicator extends PanelMenu.Button {
    _init(providers) {
        super._init(0.0, 'Usage Overlay');
        this._items = {};

        const box = new St.BoxLayout({ style_class: 'usage-panel-box', y_align: Clutter.ActorAlign.CENTER });
        for (const p of providers) {
            const item = new St.BoxLayout({ style_class: 'usage-panel-item', y_align: Clutter.ActorAlign.CENTER });
            const rgb = hexToRgb(PROVIDER_COLOR[p.key] || '#8B949E');

            const area = new St.DrawingArea({
                style_class: 'usage-panel-icon',
                width: GLYPH_SIZE, height: GLYPH_SIZE,
                y_align: Clutter.ActorAlign.CENTER,
            });
            area.connect('repaint', () => {
                const cr = area.get_context();
                icons.draw(cr, p.key, GLYPH_SIZE, [...rgb, 1]);
                cr.$dispose();
            });

            const label = new St.Label({ style_class: 'usage-panel-pct', y_align: Clutter.ActorAlign.CENTER });
            label.clutter_text.use_markup = true;

            item.add_child(area);
            item.add_child(label);
            box.add_child(item);
            this._items[p.key] = { area, label };
        }
        this.add_child(box);
    }

    update(providers, lastGood) {
        for (const p of providers) {
            const it = this._items[p.key];
            if (!it) continue;
            const rows = panelRows(lastGood[p.key]);
            const markup = rows
                .map(r => `<span foreground="${r.color}">${escapeMarkup(r.text)}</span>`)
                .join(`<span foreground="${PANEL_SEPARATOR}">·</span>`);
            it.label.clutter_text.set_markup(markup);
        }
    }
});

export default class UsageOverlayExtension extends Extension {
    enable() {
        this._start();
    }

    disable() {
        if (this._reloadId) { GLib.Source.remove(this._reloadId); this._reloadId = 0; }
        this._stop();
    }

    // Build everything up. Shared by enable() and the menu's Reload, so Reload
    // never has to call the shell-owned enable()/disable() lifecycle itself.
    _start() {
        this._destroyed = false;
        // Bumped on every start; fetches from a previous run carry the old
        // value and get dropped when they land (see _onFetched).
        this._generation = (this._generation || 0) + 1;
        this._tick = -1;
        this._inflight = new Set();
        this._lastGood = {};
        // Cancelled in _stop(), so file reads and helper processes still in
        // flight don't outlive the extension.
        this._cancellable = new Gio.Cancellable();

        // Config, detection and cache all read files, which happens async; the
        // indicator appears once they're in (a moment after enable()).
        const gen = this._generation;
        this._startAsync(gen).catch(e => {
            if (!isCancelled(e)) console.error('usage-overlay: start failed', e);
        });
    }

    async _startAsync(gen) {
        const cancellable = this._cancellable;
        const stale = () => this._destroyed || gen !== this._generation;

        const cfg = await this._loadConfig(cancellable);
        if (stale()) return;
        this._cfg = cfg;
        await this._ensureConfigDir(cancellable);
        if (stale()) return;

        this._session = new Soup.Session();
        this._session.timeout = 8;
        this._session.user_agent = 'usage-overlay/1';
        this._ctx = {
            home: GLib.get_home_dir(),
            extDir: this.path,
            nodeExe: GLib.find_program_in_path('node'),
            config: this._cfg,
            session: this._session,
            cancellable,
        };
        const enabled = await resolveEnabled(this._ctx);
        if (stale()) return;
        this._enabled = enabled;

        const cached = await this._loadCache(cancellable);
        if (stale()) return;
        Object.assign(this._lastGood, cached);

        this._buildIndicator();
        this._draw();

        // Kick an immediate tick, then refresh on the configured interval.
        this._onTick();
        this._refreshId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._cfg.refreshSeconds, () => this._onTick());
    }

    _stop() {
        this._destroyed = true;
        if (this._refreshId) { GLib.Source.remove(this._refreshId); this._refreshId = 0; }
        if (this._cancellable) { this._cancellable.cancel(); this._cancellable = null; }
        if (this._session) { this._session.abort(); this._session = null; }
        // The label lives inside the indicator's menu and would go with it,
        // but destroy it explicitly so nothing is left to chance.
        if (this._menuLabel) { this._menuLabel.destroy(); this._menuLabel = null; }
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        this._tokensProvider = null;
        this._enabled = null;
        this._ctx = null;
        this._lastGood = {};
        this._inflight.clear();
    }

    // ---------- UI ----------

    _buildIndicator() {
        // TOKENS stays out of the always-visible panel row — the percentage
        // providers already say plenty there — and only shows on click instead.
        const panelProviders = this._enabled.filter(p => p.key !== 'claudeTokens');
        this._indicator = new UsageIndicator(panelProviders);
        // Left box, appended after Activities: sits right before the clock,
        // clear of the crowded right-hand status area (where it used to get
        // squeezed for room and its percentages got clipped away).
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'left');
        const menu = this._indicator.menu;

        // The one detail block left in the dropdown: token counts, since
        // those never show in the panel itself.
        this._tokensProvider = this._enabled.find(p => p.key === 'claudeTokens') || null;
        if (this._tokensProvider) {
            const block = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            this._menuLabel = new St.Label({ style_class: 'usage-menu-label' });
            this._menuLabel.clutter_text.use_markup = true;
            block.add_child(this._menuLabel);
            menu.addMenuItem(block);
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._startFetches(true));
        menu.addMenuItem(refresh);

        // Windows' tray "Restart": tear down and build back up, which also
        // re-reads config.json (refreshSeconds, tokens, sections).
        const reload = new PopupMenu.PopupMenuItem('Reload (re-read config)');
        reload.connect('activate', () => this._scheduleReload());
        menu.addMenuItem(reload);

        const legend = new PopupMenu.PopupSubMenuMenuItem('Legend');
        const legendItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const legendLabel = new St.Label({ style_class: 'usage-legend-label' });
        legendLabel.clutter_text.use_markup = true;
        legendLabel.clutter_text.set_markup(legendMarkup(this._cfg.refreshSeconds));
        legendItem.add_child(legendLabel);
        legend.menu.addMenuItem(legendItem);
        menu.addMenuItem(legend);
    }

    // Reload once the current menu click has finished, since it destroys the
    // very menu item whose handler is running. The source id is kept so
    // disable() can cancel a reload that hasn't run yet.
    _scheduleReload() {
        if (this._reloadId) return;
        this._reloadId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._reloadId = 0;
            this._stop();
            this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- data flow ----------

    _onTick() {
        if (this._destroyed) return GLib.SOURCE_REMOVE;
        this._tick++;
        this._startFetches(this._tick % 3 === 0);
        this._draw();
        return GLib.SOURCE_CONTINUE;
    }

    // Start background fetches for every due provider not already in flight.
    // Remote (network) providers only run when remoteDue; local reads every tick.
    _startFetches(remoteDue) {
        if (this._destroyed) return;
        for (const p of this._enabled) {
            const due = p.remote ? remoteDue : true;
            if (!due || this._inflight.has(p.key)) continue;
            this._inflight.add(p.key);
            const gen = this._generation;
            p.fetch(this._ctx)
                .then(res => this._onFetched(gen, p.key, res))
                .catch(() => this._onFetched(gen, p.key, { ok: false, err: 'offline' }));
        }
    }

    _onFetched(gen, key, res) {
        if (this._destroyed || gen !== this._generation) return;
        this._inflight.delete(key);
        this._merge(key, res);
        this._draw();
    }

    // Keep the last good value on failure, flagged stale (drawn amber).
    _merge(key, d) {
        if (d && d.ok) {
            d.stale = false;
            this._lastGood[key] = d;
        } else if (this._lastGood[key]) {
            this._lastGood[key].stale = true;
        } else if (d) {
            this._lastGood[key] = d;
        }
    }

    _draw() {
        if (this._destroyed || !this._indicator) return;
        this._indicator.update(this._enabled, this._lastGood);
        if (this._menuLabel && this._tokensProvider) {
            const data = this._lastGood[this._tokensProvider.key];
            const markup = data ? providerMarkup(this._tokensProvider, data) : 'loading…';
            this._menuLabel.clutter_text.set_markup(markup);
        }
        this._saveCache();
    }

    // ---------- config & cache on disk ----------

    _configPath(name) {
        return GLib.build_filenamev([GLib.get_user_config_dir(), 'usage-overlay', name]);
    }

    async _loadConfig(cancellable) {
        const cfg = { ...DEFAULTS };
        const text = await readTextOrNull(this._configPath('config.json'), cancellable);
        if (text !== null) {
            try {
                Object.assign(cfg, JSON.parse(text));
            } catch (_e) { /* a bad config must never stop the overlay */ }
        }
        cfg.refreshSeconds = Math.max(15, Number.parseInt(cfg.refreshSeconds, 10) || 60);
        return cfg;
    }

    // The cache is written asynchronously (_writeCache), which needs its
    // directory to exist already. ~/.config itself always does.
    async _ensureConfigDir(cancellable) {
        const dir = Gio.File.new_for_path(GLib.path_get_dirname(this._configPath('config.json')));
        try {
            await dir.make_directory_async(GLib.PRIORITY_DEFAULT, cancellable);
        } catch (e) {
            if (isCancelled(e)) throw e;
            // EXISTS is the normal case; anything else just means no cache.
        }
    }

    // Last-known results from the previous session, all flagged stale.
    async _loadCache(cancellable) {
        const text = await readTextOrNull(this._configPath('usage-cache.json'), cancellable);
        if (text === null) return {};
        try {
            const saved = JSON.parse(text);
            for (const v of Object.values(saved)) v.stale = true;   // last-known, not live
            return saved;
        } catch (_e) {
            return {};   // ignore a corrupt cache
        }
    }

    // Called on every redraw, but only touches the disk when the data actually
    // changed, and never blocks the shell: the write is async, and at most one
    // runs at a time (a newer snapshot waits its turn, replacing any older one
    // still waiting).
    _saveCache() {
        const json = JSON.stringify(this._lastGood);
        if (json === this._savedJson) return;
        this._savedJson = json;
        this._writeCache(json);
    }

    _writeCache(json) {
        if (this._writing) {
            this._queuedJson = json;
            return;
        }
        this._writing = true;
        const file = Gio.File.new_for_path(this._configPath('usage-cache.json'));
        const bytes = new GLib.Bytes(encoder.encode(json));
        file.replace_contents_bytes_async(bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                } catch (_e) {
                    this._savedJson = null;   // write failed: retry on the next change
                }
                this._writing = false;
                const next = this._queuedJson;
                this._queuedJson = null;
                if (next) this._writeCache(next);
            });
    }
}
