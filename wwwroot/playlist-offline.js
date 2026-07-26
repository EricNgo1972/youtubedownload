// Client-side behaviour for the Playlists page — the app's single surface, online or off.
//   * per-playlist download toggle (⬇/%/✓/↻) and a ⤓ marker on every track whose audio
//     is on THIS device — inherently client state (Cache API), invisible to the server.
//   * expand/collapse of a playlist (ytdlPl) — deliberately NOT a Blazor @onclick, so a
//     weak or dead SignalR circuit can't lock the user out of the ▶ buttons for music
//     already sitting on the device.
//   * offline mode: when there's no circuit, the editing controls (.needs-circuit) go
//     quiet and a banner explains it. Playing never depends on any of this.
// All of it re-applies whenever Blazor re-renders the list (debounced MutationObserver,
// with self-mutation guarded out).
(function () {
    var cacheTs = 0, cacheData = null, observer = null, timer = null;
    var OPEN_LS = 'ytdl.openPlaylist';

    // --- expand / collapse ----------------------------------------------------------
    function openId() { try { return localStorage.getItem(OPEN_LS); } catch (e) { return null; } }
    function setOpenId(id) {
        try { id ? localStorage.setItem(OPEN_LS, id) : localStorage.removeItem(OPEN_LS); } catch (e) { }
    }

    function applyOpen() {
        var id = openId();
        document.querySelectorAll('[data-pl-detail]').forEach(function (d) {
            d.hidden = d.getAttribute('data-pl-detail') !== id;
        });
        document.querySelectorAll('[data-pl-caret]').forEach(function (c) {
            c.textContent = c.getAttribute('data-pl-caret') === id ? '▾' : '▸';
        });
    }

    window.ytdlPl = {
        toggle: function (id) { setOpenId(openId() === id ? null : id); applyOpen(); },
        open: function (id) { setOpenId(id); applyOpen(); },
        forget: function (id) { if (openId() === id) setOpenId(null); applyOpen(); },
    };

    // The manifest, time-boxed — and not attempted at all when the device says it's
    // offline. On a weak signal an unbounded fetch here would hang the download toggle
    // (and, worse, pile up one stuck request per Blazor re-render), so we give up
    // quickly and fall back to the copy stored on the device.
    async function serverPlaylists() {
        var now = Date.now();
        if (cacheData && now - cacheTs < 4000) return cacheData;
        if (!navigator.onLine) {
            var off = ytdlOffline.manifest();
            if (off) { cacheData = off; cacheTs = now; return cacheData; }
        }
        try {
            var ctl = new AbortController();
            var timer = setTimeout(function () { ctl.abort(); }, 2500);
            var res = await fetch('/api/playlists', { cache: 'no-store', signal: ctl.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error('status ' + res.status);
            cacheData = await res.json(); cacheTs = now;
            ytdlOffline.saveManifest(cacheData);
            return cacheData;
        } catch (e) {
            var local = ytdlOffline.manifest();
            if (!local) throw e;
            cacheData = local; cacheTs = now;
            return cacheData;
        }
    }
    function find(pls, id) { return pls.find(function (p) { return p.id === id; }); }

    function paint(btn, st) {
        btn.classList.remove('saved', 'stale');
        if (st === 'saved') { btn.classList.add('saved'); btn.textContent = '✓'; btn.title = 'Downloaded — tap to remove'; }
        else if (st === 'stale') { btn.classList.add('stale'); btn.textContent = '↻'; btn.title = 'Playlist changed — tap to update the download'; }
        else { btn.textContent = '⬇'; btn.title = 'Download for offline'; }
    }

    // Run a DOM write without our own MutationObserver re-triggering us.
    function quiet(fn) {
        if (observer) observer.disconnect();
        try { fn(); } finally {
            if (observer) observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // A ⤓ in front of every track whose audio is on this device. Reads only the Cache
    // API — no network, so it's just as accurate on a mountain as on wifi.
    async function paintTracks() {
        var marks = document.querySelectorAll('[data-off-for]');
        if (!marks.length) return;
        var set = await ytdlOffline.cachedSet(true);
        quiet(function () {
            marks.forEach(function (m) {
                var on = set.has(m.getAttribute('data-off-for'));
                m.textContent = on ? '⤓' : '';
                m.classList.toggle('on', on);
                m.title = on ? 'Saved on this device — plays with no network' : '';
            });
        });
    }

    // --- offline mode ---------------------------------------------------------------
    // "No circuit" = the server-backed half of the page is unusable. Either the device
    // is offline, or blazor.web.js never booted (the SW served its offline stub).
    function noCircuit() { return !navigator.onLine || !window.Blazor; }

    function applyMode() {
        var off = noCircuit();
        document.body.classList.toggle('no-circuit', off);
        var banner = document.getElementById('offline-banner');
        if (!banner) return;
        banner.hidden = !off;
        if (off) {
            banner.innerHTML = navigator.onLine
                ? '<b>Limited connection</b> — showing your last-loaded playlists. ' +
                  'Anything marked ⤓ plays straight from this device.'
                : '<b>Offline</b> — tracks marked ⤓ are on this device and play normally. ' +
                  'Editing needs a connection.';
        }
    }

    async function sync() {
        // Local state first, and unconditionally: none of it may wait on (or be skipped
        // because of) the manifest read below.
        quiet(applyOpen);
        quiet(applyMode);
        paintTracks();

        var btns = document.querySelectorAll('[data-download-id]');
        if (!btns.length) return;
        var pls;
        try { pls = await serverPlaylists(); } catch (e) { return; }
        quiet(function () {
            btns.forEach(function (btn) {
                if (btn.classList.contains('busy')) return;      // mid-download: leave the % alone
                var pl = find(pls, btn.getAttribute('data-download-id'));
                paint(btn, pl ? ytdlOffline.state(pl.id, pl.tracks) : 'none');
            });
        });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(sync, 150); }

    window.ytdlDownloadToggle = async function (id) {
        var btn = document.querySelector('[data-download-id="' + id + '"]');
        if (!btn || btn.classList.contains('busy')) return;
        var pls;
        try { pls = await serverPlaylists(); } catch (e) { return; }
        var pl = find(pls, id);
        if (!pl || !pl.tracks.length) return;

        if (ytdlOffline.state(id, pl.tracks) === 'saved') { await ytdlOffline.remove(id); schedule(); return; }

        btn.classList.add('busy'); btn.classList.remove('saved', 'stale'); btn.textContent = '0%';
        cacheTs = 0;                                             // metadata will change; force a fresh read next sync
        await ytdlOffline.download(id, pl.name, pl.tracks, function (p) { btn.textContent = Math.round(p * 100) + '%'; });
        btn.classList.remove('busy');
        schedule();
    };

    function boot() {
        applyOpen();                                             // no debounce: re-open immediately on load
        applyMode();
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
    }
    window.addEventListener('online', schedule);
    window.addEventListener('offline', schedule);
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
