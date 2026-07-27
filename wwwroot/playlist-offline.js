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
            c.textContent = c.getAttribute('data-pl-caret') === id ? '▼' : '▶';
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

    function paint(btn, info) {
        btn.classList.remove('saved', 'stale', 'partial');
        if (info.state === 'saved') {
            btn.classList.add('saved'); btn.textContent = '✓';
            btn.title = 'Every track is on this phone — tap to remove';
        } else if (info.state === 'stale') {
            btn.classList.add('stale'); btn.textContent = '↻';
            btn.title = 'Playlist changed — tap to update the download';
        } else if (info.state === 'partial') {
            // Some tracks are here (saved on their own, or a part-finished download).
            btn.classList.add('partial'); btn.textContent = info.saved + '/' + info.total;
            btn.title = info.saved + ' of ' + info.total + ' tracks on this phone — tap to get the rest';
        } else {
            btn.textContent = '⬇'; btn.title = 'Download the whole playlist';
        }
    }

    // Run a DOM write without our own MutationObserver re-triggering us.
    function quiet(fn) {
        if (observer) observer.disconnect();
        try { fn(); } finally {
            if (observer) observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // "Offline" / "Not saved" on every track row, plus the header's running count. Reads
    // only the Cache API — no network, so it's just as accurate on a mountain as on wifi.
    async function paintTracks() {
        var set = await ytdlOffline.cachedSet(true);
        var marks = document.querySelectorAll('[data-off-for]');

        // A part-finished large download reports how far it got, so an interrupted
        // 500 MB book reads "Saved 62%" rather than a bare "Not saved".
        var partial = {};
        for (var i = 0; i < marks.length; i++) {
            var u = marks[i].getAttribute('data-off-for');
            if (!u || set.has(u) || marks[i].classList.contains('busy')) continue;
            var pr = await ytdlOffline.progressOf(u);
            if (pr) partial[u] = pr;
        }

        quiet(function () {
            marks.forEach(function (m) {
                if (m.classList.contains('busy')) return;     // mid-save: leave the % alone
                var u = m.getAttribute('data-off-for');
                var on = set.has(u);
                var pr = partial[u];
                m.textContent = on ? 'Offline' : (pr ? 'Saved ' + Math.round(pr.fraction * 100) + '%' : 'Not saved');
                m.classList.toggle('on', on);
                m.title = on ? 'Saved on this phone — plays with no network'
                    : (pr ? 'Download stopped part-way — tap ⋯ to resume' : 'Needs a connection to play');
            });
            var count = document.getElementById('offline-count');
            if (count) {
                count.textContent = set.size === 1
                    ? '1 track ready offline'
                    : set.size + ' tracks ready offline';
            }
        });
        // Chips, search and the storage meter all read the labels we just painted.
        if (window.ytdlUI) ytdlUI.refresh();
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
                  'Anything marked <b>Offline</b> plays straight from this phone.'
                : '<b>Offline</b> — tracks marked <b>Offline</b> are on this phone and play ' +
                  'normally. Adding and editing need a connection.';
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

        // playlistState is async (it reads the Cache API), so resolve every button's
        // state before touching the DOM — one quiet() pass instead of one per button.
        var states = [];
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].classList.contains('busy')) continue;    // mid-download: leave the % alone
            var pl = find(pls, btns[i].getAttribute('data-download-id'));
            states.push([btns[i], pl
                ? await ytdlOffline.playlistState(pl.id, pl.tracks)
                : { state: 'none', saved: 0, total: 0 }]);
        }
        quiet(function () { states.forEach(function (s) { paint(s[0], s[1]); }); });
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(sync, 150); }

    // --- one track at a time --------------------------------------------------------
    // Save or remove a single file, independent of any playlist. The same URL may appear
    // in several rows (a playlist and the Library), so progress paints on all of them.
    function offMarks(url) { return document.querySelectorAll('[data-off-for="' + CSS.escape(url) + '"]'); }

    function setMark(url, text, busy, on) {
        offMarks(url).forEach(function (m) {
            m.textContent = text;
            m.classList.toggle('busy', !!busy);
            m.classList.toggle('on', !!on);
        });
    }

    function mb(b) {
        if (b >= 1024 * 1024 * 1024) return (b / 1073741824).toFixed(1) + ' GB';
        return Math.round(b / 1048576) + ' MB';
    }

    window.ytdlTrackToggle = async function (url, title, author, discard) {
        if (!url) return;
        var set = await ytdlOffline.cachedSet();
        if (discard) {                                    // throw away a part-finished download
            setMark(url, 'Removing…', true, false);
            await ytdlOffline.removeTrack(url);
            setMark(url, 'Not saved', false, false);
            schedule();
            return;
        }
        if (set.has(url)) {
            setMark(url, 'Removing…', true, false);
            await ytdlOffline.removeTrack(url);
            setMark(url, 'Not saved', false, false);
            schedule();
            return;
        }
        if (!navigator.onLine) { setMark(url, 'No connection', false, false); schedule(); return; }

        setMark(url, 'Saving…', true, false);
        try {
            // A long audiobook can be hundreds of MB, so show what's actually landed —
            // a percentage alone looks stuck for minutes, and there may be no
            // Content-Length to compute one from.
            await ytdlOffline.saveTrack({ url: url, title: title, author: author }, function (f, bytes) {
                setMark(url, f === null ? 'Saving ' + mb(bytes)
                                        : 'Saving ' + Math.round(f * 100) + '% · ' + mb(bytes), true, false);
            });
            setMark(url, 'Offline', false, true);
        } catch (e) {
            setMark(url, 'Save failed', false, false);
        }
        schedule();
    };

    window.ytdlDownloadToggle = async function (id) {
        var btn = document.querySelector('[data-download-id="' + id + '"]');
        if (!btn || btn.classList.contains('busy')) return;
        var pls;
        try { pls = await serverPlaylists(); } catch (e) { return; }
        var pl = find(pls, id);
        if (!pl || !pl.tracks.length) return;

        // ✓ means everything is here, so the tap clears it. Anything else (none, partial,
        // stale) means "get the rest" — download() skips whatever is already cached.
        var info = await ytdlOffline.playlistState(id, pl.tracks);
        if (info.state === 'saved') { await ytdlOffline.remove(id, pl.tracks); schedule(); return; }

        btn.classList.add('busy'); btn.classList.remove('saved', 'stale', 'partial'); btn.textContent = '0%';
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
