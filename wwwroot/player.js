// Unified player — ONE <audio> and ONE "now playing" bar, shared by every page
// (Playlists, Library, Downloads). It streams when online and plays downloaded audio
// when offline with no code difference: the service worker serves /stream from the
// cache when present, else from the network. Keeps resume-position, continuous
// auto-advance, shuffle, and lock-screen / Media Session controls.
(function () {
    var audio, bar, elTitle, elArtist, elPlay, elShuffle;
    var queue = [];   // live play order (already shuffled when shuffle is on)
    var src = [];     // original unshuffled order, so shuffle can be turned back off
    var idx = -1;
    var ctx = '';     // context name (playlist) for the lock-screen "album"
    var shuffle = localStorage.getItem('ytdl-shuffle') === '1';
    var lastSave = 0;

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
                '<div class="np-meta"><div class="np-title" id="np-title">—</div><div class="np-artist" id="np-artist"></div></div>' +
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
        if (audio._ytdlBound) { syncShuffle(); return; }
        audio._ytdlBound = true;

        audio.addEventListener('ended', function () { forgetPos(); next(); });
        audio.addEventListener('play', function () { elPlay.textContent = '⏸'; emit(true); });
        audio.addEventListener('pause', function () { elPlay.textContent = '▶'; emit(false); });
        audio.addEventListener('loadedmetadata', restorePos);
        audio.addEventListener('timeupdate', savePos);

        elPlay.addEventListener('click', toggle);
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

    function playAt(i) {
        if (i < 0 || i >= queue.length) return;
        idx = i;
        var t = queue[i];
        audio.src = t.url;
        audio.play().catch(function () { });
        elTitle.textContent = t.title || '—';
        elArtist.textContent = t.author || '';
        setSession(t);
        bar.classList.add('show');
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
        // Play a single track (Library).
        playOne: function (url, title, author) { play([{ url: url, title: title, author: author }], 0, title); },
        // Play/pause a single track from a button carrying data-track-url/title/artist
        // (keeps titles with quotes out of inline onclick strings).
        playEl: function (el) {
            var url = el.getAttribute('data-track-url');
            var t = cur();
            if (t && t.url === url) { toggle(); return; }
            play([{ url: url, title: el.getAttribute('data-title'), author: el.getAttribute('data-artist') }], 0, el.getAttribute('data-title'));
        },
        // Play a playlist resolved live from the server by id, optionally starting at the
        // track with `atUrl` (indices in /api/playlists are audio-only, so match by URL).
        playFromApi: async function (id, atUrl) {
            try {
                var res = await fetch('/api/playlists', { cache: 'no-store' });
                var pls = await res.json();
                var pl = pls.find(function (p) { return p.id === id; });
                if (!pl || !pl.tracks.length) return;
                var i = atUrl ? pl.tracks.findIndex(function (t) { return t.url === atUrl; }) : 0;
                play(pl.tracks, i < 0 ? 0 : i, pl.name);
            } catch (e) { /* offline / no server — nothing to stream */ }
        },
        // Tap a row: toggle if it's the current track, else start the playlist there.
        tapTrack: function (url, id) {
            var t = cur();
            if (t && t.url === url) toggle(); else this.playFromApi(id, url);
        },
        // Tap a row when the track list is already in hand (Downloads page, offline).
        tapTracks: function (tracks, index, name) {
            var t = cur();
            if (t && t.url === tracks[index].url) toggle(); else play(tracks, index, name);
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
