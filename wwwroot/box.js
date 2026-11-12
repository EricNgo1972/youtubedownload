// Player box: the page a TV, kiosk or spare phone leaves running at /player.
//
// It pairs the way MapleKiosk's wall TVs do. The box makes a random key for itself once
// and keeps it. While nobody has named it, the server hands it a 4-digit code to show.
// Someone enters that code on the Players page, and from then on the box is "Lobby"
// and plays what it is sent.
//
// Two channels to the server:
//   * a check-in every 15 s (POST /api/box/hello): proves the box is alive, learns its
//     name or its code, and picks up anything the live stream missed
//   * a Server-Sent Events stream (/api/box/events): commands land the moment someone
//     presses a button, not up to 15 s later
//
// OFFLINE-FIRST, the same rule as the main app: the network is for being told what to
// do, never for doing it. A "play" command carries the whole track list, the box keeps
// it in localStorage, and saves the audio into the same Cache API store the phone uses.
// From then on a dropped connection only takes away the remote control. The music keeps
// going, survives a reboot, and every network call has a deadline.
(function () {
    'use strict';

    var V = (function () {
        var s = document.currentScript && document.currentScript.src;
        var m = s && /[?&]v=([^&]+)/.exec(s);
        return m ? m[1] : '';
    })();

    var HELLO_MS = 15000;      // check-in cadence: the server calls a box gone after 45 s
    var NET_MS = 6000;         // deadline for any call to the server
    var STALL_MS = 15000;      // a track that produces no audio this long is skipped
    var REFRESH_MS = 10 * 60000;   // re-check the playlist and finish saving it this often

    var LS_KEY = 'ytdl.box.key';   // this box's identity: made once, never sent anywhere but here
    var LS_ME = 'ytdl.box.me';     // last known {id, name}, so a reboot offline still knows who it is
    var LS_NOW = 'ytdl.box.now';   // what it is playing, so a reboot carries on
    var LS_VOL = 'ytdl.box.vol';

    function $(id) { return document.getElementById(id); }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { } }
    function readJson(k) { try { return JSON.parse(lsGet(k) || 'null'); } catch (e) { return null; } }

    function makeKey() {
        var a = new Uint8Array(24);
        crypto.getRandomValues(a);
        return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    }

    var key = lsGet(LS_KEY);
    if (!key || key.length < 16) { key = makeKey(); lsSet(LS_KEY, key); }

    // --- state ------------------------------------------------------------------------
    var me = readJson(LS_ME);          // {id, name} while paired
    var code = null;                   // the code to show while unpaired
    var linkUp = false;                // did the last call to the server get through
    var now = readJson(LS_NOW);        // {playlistId, name, tracks, order, pos, shuffle, playing, at}
    if (now && (!now.tracks || !now.tracks.length || !now.order)) now = null;
    var needsTap = false;              // the browser is refusing sound until a touch
    var note = '';
    var saved = 0;                     // tracks of the current playlist already on this box
    var failures = 0;                  // consecutive tracks that would not play
    var gen = 0;                       // bumped per track, so late async results can tell they're stale

    var audio = $('bx-audio');
    var vol = parseFloat(lsGet(LS_VOL));
    audio.volume = isFinite(vol) ? Math.max(0, Math.min(1, vol)) : 1;

    function cur() { return now ? now.tracks[now.order[now.pos]] : null; }
    function trackAt(p) { return now ? now.tracks[now.order[(p + now.order.length) % now.order.length]] : null; }
    function save() { lsSet(LS_NOW, now ? JSON.stringify(now) : null); }
    function pathOf(u) { try { return new URL(u, location.origin).pathname; } catch (e) { return u; } }

    // --- network (always time-boxed) ---------------------------------------------------
    function post(url, body) {
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, NET_MS);
        return fetch(url, {
            method: 'POST', cache: 'no-store', signal: ctl.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        }).finally(function () { clearTimeout(timer); });
    }

    function getJson(url) {
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, NET_MS);
        return fetch(url, { cache: 'no-store', signal: ctl.signal })
            .then(function (r) { if (!r.ok) throw new Error('status ' + r.status); return r.json(); })
            .finally(function () { clearTimeout(timer); });
    }

    function setLink(up) {
        if (linkUp === up) return;
        linkUp = up;
        render();
    }

    // --- check-in ----------------------------------------------------------------------
    var helloTimer = null;
    async function hello() {
        clearTimeout(helloTimer);
        try {
            var r = await post('/api/box/hello', { key: key, version: V, state: me ? report() : null });
            if (!r.ok) throw new Error('status ' + r.status);
            var h = await r.json();
            setLink(true);
            if (!h.paired) {
                if (me) released();
                code = h.code;
            } else {
                code = null;
                me = { id: h.deviceId, name: h.name };
                lsSet(LS_ME, JSON.stringify(me));
                if (h.reload) { location.reload(); return; }
                if (h.pending) handle(h.pending);
                maintain();
            }
            // A stream that hit a hard error (a 4xx, a proxy restart) is closed for good;
            // EventSource only retries on its own after a network-level drop.
            if (!es || es.readyState === 2) listen();
        } catch (e) {
            setLink(false);
        }
        render();
        helloTimer = setTimeout(hello, HELLO_MS);
    }

    // Released on the Players page, or another box took this one's name: stop, and give
    // the space back. A released box should not keep anyone's music.
    function released() {
        me = null;
        lsSet(LS_ME, null);
        stop();
        if (window.ytdlOffline) {
            ytdlOffline.list().forEach(function (p) { ytdlOffline.remove(p.id).catch(function () { }); });
        }
    }

    // --- live commands -----------------------------------------------------------------
    var es = null;
    function listen() {
        if (!window.EventSource) return;
        if (es) { try { es.close(); } catch (e) { } }
        try { es = new EventSource('/api/box/events?key=' + encodeURIComponent(key)); }
        catch (e) { es = null; return; }
        es.onopen = function () { setLink(true); };
        es.onmessage = function (e) {
            var cmd;
            try { cmd = JSON.parse(e.data); } catch (err) { return; }
            handle(cmd);
        };
    }

    function handle(cmd) {
        if (!cmd || !cmd.type) return;
        switch (cmd.type) {
            case 'hello': hello(); return;
            case 'reload': location.reload(); return;
        }
        if (!me) return;   // only a paired box takes orders
        switch (cmd.type) {
            case 'play': startPlaylist(cmd); break;
            case 'toggle': if (now && now.playing && !needsTap) pause(); else resume(); break;
            case 'pause': pause(); break;
            case 'resume': resume(); break;
            case 'next': step(1); break;
            case 'prev':
                if (audio.currentTime > 3) { try { audio.currentTime = 0; } catch (e) { } }
                else step(-1);
                break;
            case 'stop': stop(); break;
            case 'seek':
                if (isFinite(cmd.pos)) { try { audio.currentTime = Math.max(0, cmd.pos); } catch (e) { } }
                break;
            case 'volume': setVolume(cmd.value); break;
            case 'shuffle': setShuffle(!!cmd.on); break;
        }
        render();
        pushSoon();
    }

    // --- playback ----------------------------------------------------------------------
    function shuffled(a) {
        for (var k = a.length - 1; k > 0; k--) {
            var r = Math.floor(Math.random() * (k + 1)), t = a[k]; a[k] = a[r]; a[r] = t;
        }
        return a;
    }
    function range(n) { var a = []; for (var i = 0; i < n; i++) a.push(i); return a; }

    // Play order. Straight through, or shuffled with `first` at the front so the track
    // someone picked plays first either way.
    function buildOrder(n, shuffle, first) {
        if (!shuffle) return { order: range(n), pos: first };
        var rest = range(n).filter(function (i) { return i !== first; });
        return { order: [first].concat(shuffled(rest)), pos: 0 };
    }

    function startPlaylist(cmd) {
        var tracks = (cmd.tracks || []).filter(function (t) { return t && t.url; });
        if (!tracks.length) return;
        var shuffle = cmd.shuffle == null ? !!(now && now.shuffle) : !!cmd.shuffle;
        var first = cmd.start ? tracks.findIndex(function (t) { return t.url === cmd.start; }) : -1;
        if (first < 0) first = shuffle ? Math.floor(Math.random() * tracks.length) : 0;
        var o = buildOrder(tracks.length, shuffle, first);
        now = { playlistId: cmd.playlistId || '', name: cmd.name || '', tracks: tracks,
                order: o.order, pos: o.pos, shuffle: shuffle, playing: true, at: 0 };
        failures = 0;
        saved = 0;
        pendingList = null;
        save();
        playCurrent(0);
        cacheSoon(true);
    }

    function playCurrent(resumeAt, keepNote) {
        var t = cur();
        if (!t) return;
        gen++;
        if (!keepNote) note = '';
        now.playing = true;
        now.at = resumeAt || 0;
        save();
        audio.src = t.url;
        if (resumeAt > 0) {
            var myGen = gen;
            audio.addEventListener('loadedmetadata', function seekOnce() {
                audio.removeEventListener('loadedmetadata', seekOnce);
                if (myGen === gen && resumeAt < (audio.duration || 0) - 1) {
                    try { audio.currentTime = resumeAt; } catch (e) { }
                }
            });
        }
        tryPlay();
        session(t);
        render();
        pushSoon();
    }

    function tryPlay() {
        armStall();
        var p = audio.play();
        if (!p || !p.then) return;
        p.then(function () {
            if (needsTap) { needsTap = false; render(); pushSoon(); }
        }, function (e) {
            if (e && e.name === 'NotAllowedError') {
                // Not a failure: the browser wants a touch first. Say so on screen and to
                // the Players page, and wait.
                clearStall();
                needsTap = true;
                render();
                pushSoon();
            } else if (!e || e.name !== 'AbortError') {
                fail();
            }
        });
    }

    function pause() {
        if (now) { now.playing = false; now.at = audio.currentTime || 0; save(); }
        clearStall();
        audio.pause();
    }

    function resume() {
        if (!now) return;
        if (!audio.getAttribute('src')) { playCurrent(now.at || 0); return; }
        now.playing = true;
        save();
        tryPlay();
    }

    function step(d) {
        if (!now) return;
        var n = now.order.length;
        now.pos = (now.pos + d + n) % n;   // a box plays its playlist round and round
        playCurrent(0);
    }

    function stop() {
        gen++;
        clearStall();
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (e) { }
        now = null;
        needsTap = false;
        note = '';
        save();
        render();
        pushSoon();
    }

    function setVolume(v) {
        v = Number(v);
        if (!isFinite(v)) return;
        audio.volume = Math.max(0, Math.min(1, v));
        lsSet(LS_VOL, String(audio.volume));
    }

    function setShuffle(on) {
        if (!now || now.shuffle === on) { if (now) now.shuffle = on; return; }
        var curIdx = now.order[now.pos];
        if (on) {
            var head = now.order.slice(0, now.pos + 1);
            var tail = now.order.slice(now.pos + 1);
            now.order = head.concat(shuffled(tail));
        } else {
            now.order = range(now.tracks.length);
            now.pos = curIdx;
        }
        now.shuffle = on;
        save();
    }

    // A track that will not play is skipped. Offline, straight to the next one that is
    // actually saved on this box. Online, simply the next one. If the whole playlist
    // fails in a row, stop hammering and try again in a while.
    async function fail() {
        clearStall();
        if (!now) return;
        var myGen = gen, n = now.order.length;
        failures++;
        if (failures >= n) {
            note = 'Nothing in ' + (now.name || 'this playlist') + ' will play right now. Trying again soon.';
            audio.pause();
            render();
            pushSoon();
            setTimeout(function () {
                if (myGen === gen && now) { failures = 0; playCurrent(0); }
            }, 30000);
            return;
        }
        var target = (now.pos + 1) % n;
        if (!linkUp && window.ytdlOffline && ytdlOffline.cachedSet) {
            var have = await ytdlOffline.cachedSet().catch(function () { return null; });
            if (myGen !== gen || !now) return;
            if (have) {
                for (var k = 1; k < n; k++) {
                    var p = (now.pos + k) % n;
                    if (have.has(pathOf(trackAt(p).url))) { target = p; break; }
                }
            }
        }
        now.pos = target;
        note = linkUp ? 'Skipped a track that wouldn’t play.' : 'Offline. Playing what’s saved on this player.';
        playCurrent(0, true);
    }

    var stallTimer = null;
    function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
    function armStall() {
        clearStall();
        var myGen = gen;
        stallTimer = setTimeout(function () {
            if (myGen === gen && now && now.playing && !needsTap && audio.readyState < 3) fail();
        }, STALL_MS);
    }

    audio.addEventListener('playing', function () {
        clearStall();
        failures = 0;
        if (needsTap) needsTap = false;
        render();
        pushSoon();
    });
    audio.addEventListener('pause', function () { render(); pushSoon(); });
    audio.addEventListener('waiting', function () { if (now && now.playing) armStall(); });
    audio.addEventListener('progress', function () { if (stallTimer) armStall(); });
    audio.addEventListener('ended', function () {
        if (takePendingList()) return;
        if (now && now.order.length === 1) { playCurrent(0); return; }
        step(1);
    });
    audio.addEventListener('error', function () {
        if (audio.error && audio.error.code === 1) return;   // aborted: a newer load replaced it
        if (!audio.getAttribute('src')) return;
        fail();
    });
    audio.addEventListener('timeupdate', paintTime);
    audio.addEventListener('durationchange', paintTime);
    audio.addEventListener('volumechange', pushSoon);

    // Where in the track we are, kept so a power cut resumes mid-song, not from the top.
    setInterval(function () {
        if (now && !audio.paused) { now.at = audio.currentTime || 0; save(); }
    }, 5000);

    // The phone's lock screen and a TV remote's media keys.
    function session(t) {
        if (!('mediaSession' in navigator)) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: t.title || '', artist: t.author || '', album: (now && now.name) || '',
            });
            navigator.mediaSession.setActionHandler('play', resume);
            navigator.mediaSession.setActionHandler('pause', pause);
            navigator.mediaSession.setActionHandler('nexttrack', function () { step(1); });
            navigator.mediaSession.setActionHandler('previoustrack', function () { step(-1); });
        } catch (e) { }
    }

    // --- saving the playlist onto the box ---------------------------------------------
    // A box is told to play a playlist once and then expected to keep playing it for days,
    // through Wi-Fi that comes and goes. So it saves the audio as soon as it is told what
    // to play, with the same store the phone uses (offline-store.js), and the service
    // worker serves it from there whether or not the network is up.
    var caching = Promise.resolve();
    var lastMaintain = 0;

    function cacheSoon(dropOthers) {
        if (!window.ytdlOffline || !now) return;
        var id = now.playlistId, name = now.name;
        // Links (not yet downloaded on the server) cannot be saved; they stream or skip.
        var tracks = now.tracks.filter(function (t) { return !t.pending; });
        caching = caching.then(async function () {
            if (!now || now.playlistId !== id) return;          // superseded while queued
            try {
                await ytdlOffline.download(id, name, tracks, function () { countSaved(); });
            } catch (e) { }
            if (dropOthers && now && now.playlistId === id) {
                // A dedicated player holds one playlist. Whatever it played before only
                // takes space a cheap phone does not have.
                var others = ytdlOffline.list().filter(function (p) { return p.id !== id; });
                for (var i = 0; i < others.length; i++) {
                    try { await ytdlOffline.remove(others[i].id); } catch (e) { }
                }
            }
            await countSaved();
        });
    }

    var counting = false;
    async function countSaved() {
        if (counting || !window.ytdlOffline || !now) return;
        counting = true;
        try {
            var have = await ytdlOffline.cachedSet(true);
            var n = 0;
            if (now) now.tracks.forEach(function (t) { if (have.has(pathOf(t.url))) n++; });
            if (n !== saved) { saved = n; pushSoon(); }
        } catch (e) { }
        counting = false;
    }

    // Every so often while the server is reachable: pick up tracks added to the playlist
    // since it was sent, and finish saving anything a dropped connection interrupted.
    async function maintain() {
        if (!now || Date.now() - lastMaintain < REFRESH_MS) return;
        lastMaintain = Date.now();
        try {
            var pls = await getJson('/api/playlists');
            if (window.ytdlOffline) ytdlOffline.saveManifest(pls);
            var pl = now && pls.find(function (p) { return p.id === now.playlistId; });
            if (pl && pl.tracks.length && !sameList(pl.tracks, now.tracks)) relist(pl);
        } catch (e) { }
        cacheSoon(false);
    }

    function sameList(a, b) {
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (a[i].url !== b[i].url || a[i].title !== b[i].title) return false;
        return true;
    }

    // The playlist changed on the server. Take the new list without interrupting the song
    // that is on: it stays current, and the order is rebuilt around it.
    var pendingList = null;   // a new list held back until the removed track ends
    function relist(pl) {
        var t = cur();
        var at = t ? pl.tracks.findIndex(function (x) { return x.url === t.url; }) : -1;
        if (at < 0) {
            // The playing track was taken out of the playlist. Let it finish (cutting a
            // song off mid-way is worse than one extra song), then switch.
            pendingList = pl;
            return;
        }
        pendingList = null;
        var o = buildOrder(pl.tracks.length, now.shuffle, at);
        now.tracks = pl.tracks;
        now.name = pl.name;
        now.order = o.order;
        now.pos = o.pos;
        save();
        render();
    }

    // Called when a track ends: if a new list is waiting, start it from the top.
    function takePendingList() {
        if (!pendingList || !now) return false;
        var pl = pendingList;
        pendingList = null;
        var first = now.shuffle ? Math.floor(Math.random() * pl.tracks.length) : 0;
        var o = buildOrder(pl.tracks.length, now.shuffle, first);
        now.tracks = pl.tracks;
        now.name = pl.name;
        now.order = o.order;
        now.pos = o.pos;
        playCurrent(0);
        return true;
    }

    // --- reporting back ----------------------------------------------------------------
    function report() {
        var t = cur();
        return {
            url: t ? t.url : null,
            title: t ? t.title : null,
            author: t ? t.author : null,
            playlistId: now ? now.playlistId : null,
            playlistName: now ? now.name : null,
            playing: !!now && !audio.paused && !needsTap,
            pos: isFinite(audio.currentTime) ? audio.currentTime : 0,
            dur: isFinite(audio.duration) ? audio.duration : 0,
            volume: audio.volume,
            index: now ? now.order[now.pos] : -1,
            count: now ? now.tracks.length : 0,
            shuffle: !!(now && now.shuffle),
            needsTap: needsTap,
            saved: saved,
            note: note || null,
        };
    }

    // Tell the server what changed, at most once a second. Losing one is harmless: the
    // next change, the 10-second heartbeat or the next check-in carries the same picture.
    var pushTimer = null, lastPush = 0;
    function pushSoon() {
        if (pushTimer || !me) return;
        var wait = Math.max(0, 1000 - (Date.now() - lastPush));
        pushTimer = setTimeout(function () {
            pushTimer = null;
            lastPush = Date.now();
            if (!me) return;
            post('/api/box/state', { key: key, state: report() }).then(function (r) {
                setLink(true);
                if (r.status === 404) hello();   // not paired any more
            }, function () { setLink(false); });
        }, wait);
    }
    setInterval(function () { if (now && !audio.paused) pushSoon(); }, 10000);

    // --- screen ------------------------------------------------------------------------
    function txt(id, v) { var el = $(id); if (el && el.textContent !== v) el.textContent = v; }

    function fmt(s) {
        if (!isFinite(s) || s < 0) return '0:00';
        var m = Math.floor(s / 60), r = Math.floor(s % 60);
        if (m < 60) return m + ':' + (r < 10 ? '0' : '') + r;
        var h = Math.floor(m / 60);
        return h + ':' + ((m % 60) < 10 ? '0' : '') + (m % 60) + ':' + (r < 10 ? '0' : '') + r;
    }

    // Artwork stand-ins, the same as the main app's, so a track looks the same on the
    // phone and on the wall.
    function mono(title) {
        var parts = String(title || '').split(/\s+/).filter(Boolean), out = '';
        for (var i = 0; i < parts.length && out.length < 2; i++) {
            var m = /[\p{L}\p{N}]/u.exec(parts[i]);
            if (m) out += m[0];
        }
        return out ? out.toUpperCase() : '♪';
    }
    var HUES = [148, 190, 262, 24, 330, 96];
    function tint(url) {
        var m = /\/(?:stream|preview)\/([^/]+)/.exec(url || '');
        var id = m ? m[1] : String(url || ''), h = 0;
        for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0x7FFFFFFF;
        return 'oklch(0.42 0.09 ' + HUES[h % HUES.length] + ')';
    }

    function render() {
        var mode = !me ? 'pair' : (now ? 'now' : 'idle');
        var box = $('box');
        if (box.getAttribute('data-mode') !== mode) box.setAttribute('data-mode', mode);

        txt('bx-name', me ? me.name : 'My Music player');
        var dot = $('bx-dot');
        dot.classList.toggle('up', linkUp);
        dot.classList.toggle('down', !linkUp);
        txt('bx-link', linkUp
            ? (me ? 'Connected' : 'Waiting to be paired')
            : (now && now.playing ? 'Offline. Still playing' : 'Offline'));

        if (mode === 'pair') {
            txt('bx-code', code ? code.split('').join(' ') : '· · · ·');
        } else if (mode === 'idle') {
            txt('bx-idle-title', me.name + ' is ready');
        } else {
            var t = cur();
            txt('bx-from', 'Playing from ' + (now.name || 'a playlist'));
            txt('bx-title', t.title || 'Untitled');
            txt('bx-artist', t.author || '');
            txt('bx-art', mono(t.title));
            var art = $('bx-art'), bg = tint(t.url);
            if (art.style.background !== bg) art.style.background = bg;
            var nx = now.order.length > 1 ? trackAt(now.pos + 1) : null;
            var next = $('bx-next');
            if (nx) {
                next.textContent = 'Up next  ';
                var b = document.createElement('b');
                b.textContent = nx.title || 'Untitled';
                next.appendChild(b);
            } else {
                next.textContent = '';
            }
            txt('bx-state', needsTap ? '' : (audio.paused ? 'Paused' : ''));
        }
        txt('bx-note', note);
        $('bx-tap').hidden = !needsTap;
        paintTime();
    }

    function paintTime() {
        if (!now) return;
        var d = audio.duration, p = audio.currentTime || 0;
        var pct = isFinite(d) && d > 0 ? Math.min(100, (p / d) * 100) : 0;
        var fill = $('bx-fill');
        if (fill.style.width !== pct + '%') fill.style.width = pct + '%';
        txt('bx-pos', fmt(p));
        txt('bx-dur', isFinite(d) ? fmt(d) : '');
    }

    // The one touch the browser insists on. It also re-takes the wake lock, which some
    // browsers only grant after a gesture.
    $('bx-tap').addEventListener('click', function () {
        needsTap = false;
        render();
        wake();
        if (now) { now.playing = true; save(); tryPlay(); }
    });

    // Keep the screen on: a player that goes dark looks broken, and on some phones a
    // sleeping screen also means a frozen tab.
    var lock = null;
    async function wake() {
        if (lock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
        try {
            lock = await navigator.wakeLock.request('screen');
            lock.addEventListener('release', function () { lock = null; });
        } catch (e) { lock = null; }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') { wake(); hello(); }
    });
    window.addEventListener('online', hello);

    // --- start-up ----------------------------------------------------------------------
    // Carry on from where the box was before it lost power: no server needed, so a box
    // rebooting into a dead network still plays what it was playing.
    render();
    if (me && now) {
        if (now.playing) playCurrent(now.at || 0);
        else { audio.src = cur().url; render(); }
        countSaved();
    }
    hello();
    listen();
    wake();
})();
