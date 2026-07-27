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
        // Before the playlist-only work below: waiting tracks must be picked up on the
        // Library page too, and that returns early when there are no download toggles.
        drainWanted();

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

    // Called by the server side after any playlist edit (add / remove / reorder / rename
    // / delete). The device's copy of the manifest is what the player resolves a tap
    // against without touching the network, so an edit MUST invalidate it right away.
    // Without this the copy stays whatever it was — serverPlaylists() holds its result
    // for 4 s and a Blazor re-render is the only thing that would re-run sync(), so the
    // just-added track stayed unknown to the tap handler until the page was reloaded.
    // In an installed PWA there is no reload: the only way out was to kill the app.
    window.ytdlPlaylistsChanged = function () {
        cacheTs = 0;
        cacheData = null;
        schedule();
    };

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

    // --- tracks this phone is waiting for -------------------------------------------
    // "Download" is one intent with two halves: the server pulls the audio, then this
    // device saves it. The gap between them can be minutes, and the user will navigate
    // away or lock the phone in between — so the intent is written down here and acted
    // on by every later pass, rather than living in the click handler that started it.
    var WANT_LS = 'ytdl.wanted.v1';
    var draining = false, lastDrain = 0;

    function wanted() {
        try { return JSON.parse(localStorage.getItem(WANT_LS)) || []; } catch (e) { return []; }
    }
    function setWanted(a) {
        try { localStorage.setItem(WANT_LS, JSON.stringify(a)); } catch (e) { /* quota */ }
    }

    // Called from the Library's Download button (server side) the moment a fetch is queued.
    window.ytdlWantOnDevice = function (recordId) {
        if (!recordId) return;
        var w = wanted();
        if (w.indexOf(recordId) < 0) { w.push(recordId); setWanted(w); }
        drainWanted();
    };

    /// Save anything this phone asked for whose audio has now arrived on the server.
    /// Ids stay on the list until they are genuinely resolved, so a fetch that outlives
    /// the page — or a save interrupted half way — is simply picked up next time.
    async function drainWanted() {
        var w = wanted();
        if (!w.length || draining || !navigator.onLine) return;
        var now = Date.now();
        if (now - lastDrain < 3000) return;
        lastDrain = now;
        draining = true;
        try {
            var still = [];
            for (var i = 0; i < w.length; i++) {
                var id = w[i], res;
                try { res = await fetch('/api/track/' + id, { cache: 'no-store' }); }
                catch (e) { still.push(id); continue; }        // couldn't ask — keep waiting
                if (res.status === 404) continue;              // gone from the library — stop waiting
                if (!res.ok) { still.push(id); continue; }

                var info = await res.json().catch(function () { return null; });
                if (!info) { still.push(id); continue; }
                if (!info.ready) {
                    // Still being fetched. A record that is neither ready nor pending has
                    // no audio and never will, so waiting on it forever helps nobody.
                    if (info.pending) still.push(id);
                    continue;
                }
                try {
                    if (!(await ytdlOffline.isCached(info.url))) {
                        setMark(info.url, 'Saving…', true, false);
                        await ytdlOffline.saveTrack(
                            { url: info.url, title: info.title, author: info.author },
                            function (f, bytes) {
                                setMark(info.url, f === null ? 'Saving ' + mb(bytes)
                                    : 'Saving ' + Math.round(f * 100) + '% · ' + mb(bytes), true, false);
                            });
                        setMark(info.url, 'Offline', false, true);
                    }
                } catch (e) {
                    setMark(info.url, 'Save failed', false, false);
                    still.push(id);                            // retry on the next pass
                }
            }
            setWanted(still);
        } finally {
            draining = false;
            schedule();
        }
    }

    // --- syncing with the server ----------------------------------------------------
    // The rows on this page are server-rendered HTML. In a browser you reload to pick up
    // a change made elsewhere (a track added from a laptop, a playlist renamed); an
    // INSTALLED PWA has no reload, so the only way out was to kill the app and relaunch.
    //
    // Two halves, because they cost different amounts:
    //   * the MANIFEST — what the player resolves a tap against — is refreshed on every
    //     foreground, reconnect and manual sync. Cheap, invisible, needs no circuit, and
    //     it alone is enough to make a newly added track playable.
    //   * the RENDERED ROWS can only come from the server, i.e. a reload, which stops
    //     playback. So that happens automatically only when the list really did change
    //     AND nothing is playing; otherwise we offer it and let the user pick the moment.
    var SIG_LS = 'ytdl.syncSig';      // the state we last reloaded for — see reloadFor()
    var syncing = false, lastAuto = 0;

    function onPlaylistsPage() {
        var p = location.pathname;
        return p === '/' || p === '/playlists';
    }

    // A fetch that FAILS when the server can't be reached, unlike serverPlaylists()
    // which falls back to the stored manifest — comparing that against the DOM would be
    // comparing the device with itself and could report "up to date" while offline.
    async function fetchPlaylists(ms) {
        var ctl = new AbortController();
        var t = setTimeout(function () { ctl.abort(); }, ms);
        try {
            var res = await fetch('/api/playlists', { cache: 'no-store', signal: ctl.signal });
            if (!res.ok) throw new Error('status ' + res.status);
            return await res.json();
        } finally { clearTimeout(t); }
    }

    // What the page is CURRENTLY showing: each playlist's id, name and ordered track
    // URLs. Rows with no stream URL are skipped because the manifest leaves those tracks
    // out too — counting them would make the two sides disagree forever and re-reload.
    function domSig() {
        var out = [];
        document.querySelectorAll('[data-pl-card]').forEach(function (card) {
            var nameEl = card.querySelector('.pl-name');
            var urls = [];
            card.querySelectorAll('.trk[data-track-url]').forEach(function (r) {
                var u = r.getAttribute('data-track-url');
                if (u) urls.push(u);
            });
            out.push(card.getAttribute('data-pl-card') + ' ' +
                     (nameEl ? nameEl.textContent : '') + ' ' + urls.join(','));
        });
        return out.join('\n');
    }

    function serverSig(pls) {
        return (pls || []).map(function (p) {
            return p.id + ' ' + p.name + ' ' +
                   (p.tracks || []).map(function (t) { return t.url; }).join(',');
        }).join('\n');
    }

    // A reload throws away anything the page is in the middle of. Playback is the obvious
    // one; a download in flight is the expensive one — reloading during a 200 MB
    // audiobook would drop it, and a whole-file save has nothing to resume from.
    function isBusy() {
        try {
            if (window.ytdlPlayer && ytdlPlayer.isPlaying()) return true;
        } catch (e) { }
        return !!document.querySelector('[data-download-id].busy, [data-off-for].busy');
    }

    function banner() {
        var el = document.getElementById('sync-msg');
        if (el) return el;
        el = document.createElement('button');
        el.id = 'sync-msg';
        el.className = 'sync-msg';
        el.hidden = true;
        el.addEventListener('click', function () {
            if (el.dataset.reload === '1') location.reload();
            else hideBanner();
        });
        (document.getElementById('sync-slot') || document.body).appendChild(el);
        return el;
    }
    var hideTimer = null;
    function hideBanner() { var el = banner(); el.hidden = true; el.dataset.reload = ''; }
    function flash(msg, keep) {
        var el = banner();
        clearTimeout(hideTimer);
        el.textContent = msg;
        el.dataset.reload = keep ? '1' : '';
        el.classList.toggle('act', !!keep);
        el.hidden = false;
        if (!keep) hideTimer = setTimeout(hideBanner, 2600);
    }

    // Reload for a given server state at most ONCE. Without this guard, any systematic
    // difference between the two signatures (rather than a real change) would put an
    // installed app into a reload loop with no way for the user to stop it.
    function reloadFor(sig) {
        var tried = null;
        try { tried = sessionStorage.getItem(SIG_LS); } catch (e) { }
        if (tried === sig) return false;
        try { sessionStorage.setItem(SIG_LS, sig); } catch (e) { }
        location.reload();
        return true;
    }

    /// Pull the playlists from the server and bring this device into line with them.
    /// `userAsked` distinguishes the ⟳ button (always reports what happened) from the
    /// automatic passes on foreground/reconnect, which stay silent unless there's news.
    async function syncNow(userAsked) {
        if (syncing) return;
        if (!navigator.onLine) { if (userAsked) flash('No connection — nothing to sync with'); return; }
        syncing = true;
        var btn = document.getElementById('btn-sync');
        if (btn) btn.classList.add('spin');
        try {
            var pls = await fetchPlaylists(userAsked ? 8000 : 4000);
            ytdlOffline.saveManifest(pls);
            cacheData = pls; cacheTs = Date.now();      // keep this file's own cache in step
            schedule();                                 // repaint the toggles and ⤓ markers

            if (!onPlaylistsPage()) { if (userAsked) flash('Synced'); return; }

            var sig = serverSig(pls);
            if (sig === domSig()) {
                try { sessionStorage.removeItem(SIG_LS); } catch (e) { }
                if (userAsked) flash('Up to date');
                return;
            }
            // The list really has changed. A reload is the only way to re-render
            // server-side HTML, and it discards whatever the page is doing — so when
            // something is playing or downloading we offer it instead of taking it.
            // Taps already work regardless: the manifest above is now current.
            if (!isBusy() && reloadFor(sig)) return;
            flash('Playlists changed — tap to refresh the list', true);
        } catch (e) {
            if (userAsked) flash('Couldn’t reach the server — try again in a moment');
        } finally {
            syncing = false;
            if (btn) btn.classList.remove('spin');
        }
    }

    // The ⟳ button in the header.
    window.ytdlSync = function () { syncNow(true); };

    // Coming back to the app is the moment a stale list is most likely and most
    // annoying — that is precisely when the user used to kill and relaunch it.
    function autoSync() {
        var now = Date.now();
        if (now - lastAuto < 10000) return;             // don't refetch on every flip
        lastAuto = now;
        syncNow(false);
    }

    function boot() {
        applyOpen();                                             // no debounce: re-open immediately on load
        applyMode();
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
    }
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') autoSync();
    });
    window.addEventListener('pageshow', function (e) { if (e.persisted) autoSync(); });
    window.addEventListener('online', function () { schedule(); autoSync(); });
    window.addEventListener('offline', schedule);
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
