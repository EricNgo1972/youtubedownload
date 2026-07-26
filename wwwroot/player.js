// Unified player — ONE <audio> and ONE "now playing" bar, shared by every page
// (Playlists, Library). It streams when online and plays downloaded audio when offline
// with no code difference: the service worker serves /stream from the cache when
// present, else from the network. Keeps resume-position, continuous auto-advance,
// shuffle, and lock-screen / Media Session controls.
//
// OFFLINE-FIRST RULE: never let the network decide *whether* we can start playing.
// Track lists are resolved from the device (downloaded playlist -> cached manifest)
// before any fetch, every network read is time-boxed, and a load that never produces
// audio trips a watchdog instead of spinning forever. On a weak-but-connected link
// (one bar on a mountain) an unbounded fetch can hang for minutes — that is what made
// the app look frozen even though the file was sitting in the cache.
(function () {
    var audio, bar, elTitle, elArtist, elPlay, elShuffle, elStatus, elSrc;
    var status = '';  // '' | 'loading' | 'ok' | 'error'
    var queue = [];   // live play order (already shuffled when shuffle is on)
    var src = [];     // original unshuffled order, so shuffle can be turned back off
    var idx = -1;
    var ctx = '';     // context name (playlist) for the lock-screen "album"
    var shuffle = localStorage.getItem('ytdl-shuffle') === '1';
    var lastSave = 0;
    var stallTimer = null;   // watchdog for "load started but no audio ever arrived"
    var API_MS = 2500;       // give up on the playlist API this fast, then use local data
    var STALL_MS = 12000;    // …and this long for a track to produce any playable audio

    // A network read that CANNOT outlive its deadline. Plain fetch() has no timeout:
    // on a weak signal the browser keeps the request open long past any human patience.
    function fetchSoon(url, ms) {
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || API_MS);
        var opts = { cache: 'no-store' };
        if (ctl) opts.signal = ctl.signal;
        return fetch(url, opts).then(
            function (r) { clearTimeout(timer); return r; },
            function (e) { clearTimeout(timer); throw e; }
        );
    }

    function posKey(url) { return 'ytdl-pos-' + url; }
    function shuf(a) { for (var k = a.length - 1; k > 0; k--) { var r = Math.floor(Math.random() * (k + 1)); var t = a[k]; a[k] = a[r]; a[r] = t; } return a; }
    function cur() { return (idx >= 0 && queue[idx]) ? queue[idx] : null; }

    // --- the now-playing bar (injected once, persists across in-page navigation) ---
    function injectBar() {
        if (!document.getElementById('ytdl-bar')) {
            var el = document.createElement('div');
            el.id = 'ytdl-bar';
            el.className = 'np-bar';
            el.innerHTML =
                '<div class="np-meta"><div class="np-title" id="np-title">—</div>' +
                '<div class="np-artist" id="np-artist"></div>' +
                '<div class="np-src" id="np-src"></div>' +
                '<div class="np-status" id="np-status"></div></div>' +
                '<div class="np-ctl">' +
                '<button id="np-prev" title="Previous">⏮</button>' +
                '<button id="np-play" class="np-play" title="Play/Pause">▶</button>' +
                '<button id="np-next" title="Next">⏭</button>' +
                '</div>' +
                '<audio id="np-audio" preload="none"></audio>';
            document.body.appendChild(el);
        }
        bind();
    }

    function bind() {
        bar = document.getElementById('ytdl-bar');
        audio = document.getElementById('np-audio');
        elTitle = document.getElementById('np-title');
        elArtist = document.getElementById('np-artist');
        elPlay = document.getElementById('np-play');
        elStatus = document.getElementById('np-status');
        elSrc = document.getElementById('np-src');
        if (audio._ytdlBound) { syncShuffle(); return; }
        audio._ytdlBound = true;

        audio.addEventListener('ended', function () { forgetPos(); next(); });
        audio.addEventListener('play', function () { elPlay.textContent = '⏸'; emit(true); });
        audio.addEventListener('playing', function () { setStatus('ok'); });   // real audio started
        audio.addEventListener('canplay', function () { if (status === 'loading') setStatus('ok'); });
        audio.addEventListener('progress', function () { armStall(); });   // bytes arriving — reset the watchdog
        audio.addEventListener('waiting', function () { setStatus('loading'); armStall(); });   // buffering
        audio.addEventListener('stalled', function () { if (!audio.paused) { setStatus('loading'); armStall(); } });
        audio.addEventListener('pause', function () { clearStall(); elPlay.textContent = '▶'; elPlay.classList.remove('loading'); emit(false); });
        audio.addEventListener('error', function () {
            if (audio.error && audio.error.code === 1) return;   // MEDIA_ERR_ABORTED — a new load replaced it
            fail();
        });
        audio.addEventListener('loadedmetadata', restorePos);
        audio.addEventListener('timeupdate', savePos);

        // In the error state the play button becomes a retry; otherwise play/pause.
        elPlay.addEventListener('click', function () { if (status === 'error') playAt(idx); else toggle(); });
        document.getElementById('np-prev').addEventListener('click', prev);
        document.getElementById('np-next').addEventListener('click', next);
        syncShuffle();   // still syncs any [data-shuffle] buttons on the page
    }

    // Tell the current page which track is playing so it can highlight the row.
    function emit(playing) {
        var t = cur();
        if (bar) bar.classList.toggle('show', !!t);
        document.body.classList.toggle('has-np', !!t);   // pages reserve bottom space
        document.dispatchEvent(new CustomEvent('ytdl:playing', { detail: { url: t ? t.url : null, playing: playing } }));
    }

    function play(tracks, start, name) {
        if (!tracks || !tracks.length) return;
        start = start || 0;
        ctx = name || '';
        src = tracks.slice();
        if (shuffle) {
            var rest = tracks.map(function (_, i) { return i; }).filter(function (i) { return i !== start; });
            shuf(rest);
            queue = [start].concat(rest).map(function (i) { return tracks[i]; });
            playAt(0);
        } else {
            queue = tracks.slice();
            playAt(start);
        }
    }

    // Bumped on every playAt so a late async result (source probe, watchdog) belonging
    // to a track the user has already skipped past can't clobber the current one.
    var gen = 0;

    function playAt(i) {
        if (i < 0 || i >= queue.length) return;
        idx = i;
        gen++;
        var t = queue[i];
        elTitle.textContent = t.title || '—';
        elArtist.textContent = t.author || '';
        bar.classList.add('show');
        setStatus('loading');
        markSource(t, gen);
        audio.src = t.url;
        var p = audio.play();
        // Surface real failures (network down, missing/unplayable file) instead of a frozen UI.
        if (p && p.catch) p.catch(function (e) { if (!e || e.name !== 'AbortError') fail(); });
        setSession(t);
        armStall();
    }

    // --- offline awareness ----------------------------------------------------------
    function cached(url) {
        if (!window.ytdlOffline || !ytdlOffline.isCached) return Promise.resolve(false);
        return ytdlOffline.isCached(url).catch(function () { return false; });
    }

    // Tell the user WHERE the audio is coming from, so "it's downloaded" is visible
    // rather than assumed.
    async function markSource(t, myGen) {
        if (!elSrc) return;
        elSrc.textContent = '';
        var onDevice = await cached(t.url);
        if (myGen !== gen || !elSrc) return;
        elSrc.textContent = onDevice ? '⤓ on this device' : (navigator.onLine ? '☁ streaming' : '☁ not saved offline');
        elSrc.classList.toggle('off', onDevice);
    }

    // Watchdog: a track that has started loading but produced no playable audio within
    // STALL_MS is treated as failed. Without this a request the network never answers
    // leaves the spinner up indefinitely — the "app hangs" symptom.
    function clearStall() { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } }
    function armStall() {
        clearStall();
        if (status !== 'loading') return;
        var myGen = gen;
        stallTimer = setTimeout(function () {
            if (myGen === gen && status === 'loading') fail();
        }, STALL_MS);
    }

    async function fail() {
        clearStall();
        var myGen = gen, t = cur();
        var onDevice = t ? await cached(t.url) : false;
        if (myGen !== gen) return;               // user moved on already

        // On the device but still unplayable — a real file/decode problem, not the network.
        if (onDevice) { setStatus('error', '⚠ This track wouldn’t play — tap ▶ to retry.'); return; }

        // Not on the device: rather than stalling the whole queue on a dead link, jump
        // ahead to the next track we know we can play right now.
        if (await skipToDownloaded(myGen)) return;

        setStatus('error', navigator.onLine
            ? '⚠ Weak signal — this track isn’t saved on this device. Tap ▶ to retry.'
            : '⚠ Offline — this track isn’t saved on this device.');
    }

    // Advance to the next track whose audio is already in the cache. Returns whether it
    // moved. Bounded: the track it lands on is on-device, so it can't chain failures.
    async function skipToDownloaded(myGen) {
        if (queue.length < 2 || idx < 0) return false;
        var set = window.ytdlOffline && ytdlOffline.cachedSet ? await ytdlOffline.cachedSet() : null;
        if (!set || !set.size || myGen !== gen) return false;
        for (var j = idx + 1; j < queue.length; j++) {
            if (set.has(pathOf(queue[j].url))) {
                var skipped = j - idx;
                playAt(j);
                note('⤓ Skipped ' + skipped + ' track' + (skipped === 1 ? '' : 's') + ' not saved on this device.');
                return true;
            }
        }
        return false;
    }
    function pathOf(u) { try { return new URL(u, location.origin).pathname; } catch (e) { return u; } }

    // Loading spinner on the play button / visible error line, so a buffering or failed
    // track never looks like a frozen UI.
    function setStatus(s, msg) {
        status = s;
        if (s !== 'loading') clearStall();
        if (!elPlay) return;
        elPlay.classList.toggle('loading', s === 'loading');
        if (s === 'error') {
            elPlay.classList.remove('loading');
            elPlay.textContent = '▶';
            note(msg || '⚠ Couldn’t play this track — tap ▶ to retry.');
        } else if (noteGen !== gen) {            // keep a note attached to THIS track
            elStatus.classList.remove('show');
            elStatus.textContent = '';
        }
    }

    // One-line message under the title (errors, "skipped N tracks", …). It survives the
    // track's own status changes so a skip notice doesn't vanish the instant audio starts.
    var noteGen = -1;
    function note(msg) {
        if (!elStatus) return;
        noteGen = gen;
        elStatus.textContent = msg;
        elStatus.classList.add('show');
    }

    function next() { if (idx + 1 < queue.length) playAt(idx + 1); }
    function prev() {
        if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
        if (idx > 0) playAt(idx - 1);
    }
    function toggle() { if (!audio) return; if (audio.paused) audio.play().catch(function () { }); else audio.pause(); }

    function setShuffle(on) {
        shuffle = on;
        localStorage.setItem('ytdl-shuffle', on ? '1' : '0');
        if (idx >= 0 && queue.length) {
            var curUrl = queue[idx].url;
            if (on) {
                var tail = shuf(queue.slice(idx + 1));
                queue = queue.slice(0, idx + 1).concat(tail);
            } else if (src.length) {
                var ci = src.findIndex(function (t) { return t.url === curUrl; });
                if (ci >= 0) { queue = src.slice(); idx = ci; }
            }
        }
        syncShuffle();
    }
    function syncShuffle() {
        if (elShuffle) elShuffle.classList.toggle('on', shuffle);
        document.querySelectorAll('[data-shuffle]').forEach(function (b) { b.classList.toggle('on', shuffle); });
    }

    function setSession(t) {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || '', artist: t.author || '', album: ctx });
        navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
        navigator.mediaSession.setActionHandler('nexttrack', next);
        navigator.mediaSession.setActionHandler('previoustrack', prev);
    }

    // Start a resolved playlist ({name, tracks}) at `atUrl` (or the top).
    function start(pl, atUrl) {
        var i = atUrl ? pl.tracks.findIndex(function (t) { return t.url === atUrl; }) : 0;
        play(pl.tracks, i < 0 ? 0 : i, pl.name);
    }

    // Resume where each track left off (keyed by its stable stream URL).
    function restorePos() {
        var t = cur(); if (!t) return;
        var s = parseFloat(localStorage.getItem(posKey(t.url)) || '0');
        if (s > 0 && isFinite(audio.duration) && s < audio.duration - 1) { try { audio.currentTime = s; } catch (e) { } }
    }
    function savePos() {
        var now = Date.now();
        if (now - lastSave < 5000) return;
        lastSave = now;
        var t = cur();
        if (t && audio.currentTime > 0) localStorage.setItem(posKey(t.url), String(audio.currentTime));
    }
    function forgetPos() { var t = cur(); if (t) localStorage.removeItem(posKey(t.url)); }

    // Generic row highlighter: any page whose track rows carry [data-track-url] (and an
    // optional .play-glyph) gets the playing row marked and its glyph flipped for free.
    document.addEventListener('ytdl:playing', function (e) {
        var url = e.detail.url, playing = e.detail.playing;
        document.querySelectorAll('[data-track-url]').forEach(function (el) {
            var on = url && el.getAttribute('data-track-url') === url;
            el.classList.toggle('playing', !!on);
            var g = el.querySelector('.play-glyph');
            if (g) g.textContent = (on && playing) ? '⏸' : '▶';
            if (el.classList.contains('play-label')) el.textContent = (on && playing) ? '⏸ Pause' : '▶ Play';
        });
    });

    window.ytdlPlayer = {
        play: play,
        // Play/pause a single track from a button carrying data-track-url/title/artist
        // (keeps titles with quotes out of inline onclick strings).
        playEl: function (el) {
            var url = el.getAttribute('data-track-url');
            var t = cur();
            if (t && t.url === url) { toggle(); return; }
            play([{ url: url, title: el.getAttribute('data-title'), author: el.getAttribute('data-artist') }], 0, el.getAttribute('data-title'));
        },
        // Play a playlist by id, optionally starting at the track with `atUrl` (indices in
        // /api/playlists are audio-only, so match by URL).
        //
        // Resolution order is deliberately device-first:
        //   1. the downloaded copy   — authoritative for what we can actually play, 0 ms
        //   2. the cached manifest   — last-known track list, still 0 ms
        //   3. the server            — only when the device knows nothing, and time-boxed
        // Previously this always went to the network first with no timeout, so on a weak
        // link the tap did nothing for minutes even when every byte was already local.
        //
        // Note there is deliberately NO background refresh here: playing something that
        // is already on the device must touch the network ZERO times. The manifest is
        // refreshed on page load instead (playlist-offline.js).
        playFromApi: async function (id, atUrl) {
            var local = window.ytdlOffline
                ? (ytdlOffline.get(id) || ytdlOffline.manifestPlaylist(id))
                : null;
            if (local && local.tracks && local.tracks.length) {
                start(local, atUrl);
                return;
            }
            try {
                var res = await fetchSoon('/api/playlists');
                var pls = await res.json();
                if (window.ytdlOffline) ytdlOffline.saveManifest(pls);
                var pl = pls.find(function (p) { return p.id === id; });
                if (!pl || !pl.tracks.length) return;
                start(pl, atUrl);
            } catch (e) {
                // No local copy and no reachable server — say so instead of doing nothing.
                if (bar) bar.classList.add('show');
                note(navigator.onLine
                    ? '⚠ Weak signal — this playlist isn’t saved on this device.'
                    : '⚠ Offline — this playlist isn’t saved on this device.');
            }
        },
        // Tap a row: toggle if it's the current track, else start the playlist there.
        tapTrack: function (url, id) {
            var t = cur();
            if (t && t.url === url) toggle(); else this.playFromApi(id, url);
        },
        toggle: toggle, next: next, prev: prev,
        setShuffle: setShuffle, toggleShuffle: function () { setShuffle(!shuffle); },
        isShuffle: function () { return shuffle; },
        current: function () { var t = cur(); return t ? t.url : null; },
        isPlaying: function () { return !!(audio && !audio.paused); }
    };

    if (document.readyState !== 'loading') injectBar();
    else document.addEventListener('DOMContentLoaded', injectBar);
})();
