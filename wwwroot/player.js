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
    var audio, bar, full, elTitle, elArtist, elPlay, elStatus, elArt;
    var status = '';  // '' | 'loading' | 'ok' | 'error'
    var queue = [];   // live play order (already shuffled when shuffle is on)
    var src = [];     // original unshuffled order, so shuffle can be turned back off
    var idx = -1;
    var ctx = '';     // context name (playlist) for the lock-screen "album"
    var ctxId = '';   // …and its id, so the right playlist card lights up
    var shuffle = localStorage.getItem('ytdl-shuffle') === '1';
    var repeat = localStorage.getItem('ytdl-repeat') === '1';
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

    // --- the mini bar + full-screen now playing (injected once, persist across nav) ---
    // The mini bar mounts into #np-slot so it sits between the scrolling view and the tab
    // bar; the full player is absolutely positioned over the whole app column.
    function injectBar() {
        if (!document.getElementById('ytdl-bar')) {
            var el = document.createElement('div');
            el.id = 'ytdl-bar';
            el.className = 'np-bar';
            el.innerHTML =
                '<div class="np-prog"><div class="np-prog-fill" id="np-prog"></div></div>' +
                '<div class="np-row">' +
                  '<button class="np-open" id="np-open">' +
                    '<span class="np-art" id="np-art">♪</span>' +
                    '<span class="np-meta"><span class="np-title" id="np-title">—</span>' +
                    '<span class="np-sub" id="np-sub"></span></span>' +
                  '</button>' +
                  '<button class="np-play" id="np-play" aria-label="Play/Pause">▶</button>' +
                  '<button class="np-skip" id="np-next" aria-label="Next">▶▶</button>' +
                '</div>' +
                '<div class="np-status" id="np-status"></div>' +
                '<audio id="np-audio" preload="none"></audio>';
            (document.getElementById('np-slot') || document.body).appendChild(el);
        }
        if (!document.getElementById('ytdl-npf')) {
            var f = document.createElement('div');
            f.id = 'ytdl-npf';
            f.className = 'np-full';
            f.innerHTML =
                '<div class="npf-head">' +
                  '<button class="icon-btn" id="npf-close" aria-label="Close">▼</button>' +
                  '<div class="npf-from" id="npf-from"></div>' +
                  '<button class="npf-tab" id="npf-lyrbtn">Lyrics</button>' +
                '</div>' +
                '<div class="npf-body">' +
                  '<div class="npf-art" id="npf-art">♪</div>' +
                  '<div class="npf-lyrics" id="npf-lyrics" hidden></div>' +
                  '<div class="npf-meta">' +
                    '<div class="npf-title" id="npf-title"></div>' +
                    '<div class="npf-artist" id="npf-artist"></div>' +
                    '<div class="npf-badge" id="npf-badge"></div>' +
                  '</div>' +
                  '<div>' +
                    '<div class="npf-seek" id="npf-seek"><div class="npf-track"><div class="npf-fill" id="npf-fill"></div></div></div>' +
                    '<div class="npf-times"><div id="npf-pos">0:00</div><div id="npf-dur">0:00</div></div>' +
                  '</div>' +
                  '<div class="npf-ctl">' +
                    '<button class="npf-side" id="npf-shuffle" aria-label="Shuffle">⤮</button>' +
                    '<button class="npf-step" id="npf-prev" aria-label="Previous">◀◀</button>' +
                    '<button class="npf-play" id="npf-play" aria-label="Play/Pause">▶</button>' +
                    '<button class="npf-step" id="npf-next" aria-label="Next">▶▶</button>' +
                    '<button class="npf-side" id="npf-repeat" aria-label="Repeat">↻</button>' +
                  '</div>' +
                '</div>';
            (document.querySelector('.app') || document.body).appendChild(f);
        }
        bind();
    }

    function $(id) { return document.getElementById(id); }

    function bind() {
        bar = $('ytdl-bar');
        audio = $('np-audio');
        elTitle = $('np-title');
        elArtist = $('np-sub');
        elPlay = $('np-play');
        elStatus = $('np-status');
        elArt = $('np-art');
        full = $('ytdl-npf');
        if (audio._ytdlBound) { syncShuffle(); return; }
        audio._ytdlBound = true;

        audio.addEventListener('ended', function () { forgetPos(); if (repeat) playAt(idx); else next(); });
        audio.addEventListener('play', function () { setGlyph('❙❙'); emit(true); });
        audio.addEventListener('playing', function () { setStatus('ok'); });   // real audio started
        audio.addEventListener('canplay', function () { if (status === 'loading') setStatus('ok'); });
        audio.addEventListener('progress', function () { armStall(); });   // bytes arriving — reset the watchdog
        audio.addEventListener('waiting', function () { setStatus('loading'); armStall(); });   // buffering
        audio.addEventListener('stalled', function () { if (!audio.paused) { setStatus('loading'); armStall(); } });
        audio.addEventListener('pause', function () { clearStall(); setGlyph('▶'); emit(false); });
        audio.addEventListener('error', function () {
            if (audio.error && audio.error.code === 1) return;   // MEDIA_ERR_ABORTED — a new load replaced it
            fail();
        });
        audio.addEventListener('loadedmetadata', function () { restorePos(); paintTime(); });
        audio.addEventListener('timeupdate', function () { savePos(); paintTime(); });
        audio.addEventListener('durationchange', paintTime);

        // In the error state the play buttons become a retry; otherwise play/pause.
        function onPlayBtn() { if (status === 'error') playAt(idx); else toggle(); }
        elPlay.addEventListener('click', onPlayBtn);
        $('npf-play').addEventListener('click', onPlayBtn);
        $('np-next').addEventListener('click', next);
        $('npf-next').addEventListener('click', next);
        $('npf-prev').addEventListener('click', prev);
        $('np-open').addEventListener('click', openFull);
        $('npf-close').addEventListener('click', closeFull);
        $('npf-shuffle').addEventListener('click', function () { setShuffle(!shuffle); });
        $('npf-repeat').addEventListener('click', function () {
            repeat = !repeat;
            localStorage.setItem('ytdl-repeat', repeat ? '1' : '0');
            $('npf-repeat').classList.toggle('on', repeat);
        });
        $('npf-seek').addEventListener('click', seekFromEvent);
        $('npf-lyrbtn').addEventListener('click', function () { setTab(tab === 'lyrics' ? 'cover' : 'lyrics'); });
        $('npf-repeat').classList.toggle('on', repeat);
        // Apply the remembered Cover/Lyrics choice. Without this the markup says "Lyrics"
        // while the state says lyrics, so the first tap toggles the wrong way.
        setTab(tab);
        // Reading ahead by hand should pause the auto-scroll, not fight it. Keyed off
        // real input events rather than 'scroll', because our own smooth scrolling emits
        // scroll events too and would otherwise permanently suppress itself.
        ['wheel', 'touchmove', 'pointerdown'].forEach(function (ev) {
            $('npf-lyrics').addEventListener(ev, function () { userScrolledAt = Date.now(); }, { passive: true });
        });
        syncShuffle();   // syncs the [data-shuffle] buttons on the page too
    }

    // --- lyrics / karaoke -----------------------------------------------------------
    // Lines come from the subtitle file downloaded with the track (see LyricsService),
    // so there is no third-party lyrics service and nothing to fetch on a plane. The
    // active line wipes left-to-right in the accent colour as it is sung/spoken.
    var tab = localStorage.getItem('ytdl-nptab') === 'lyrics' ? 'lyrics' : 'cover';
    var lyrics = [];      // [{t, text}] for the current track
    var lyrEls = [];      // one element per line
    var lyrUrl = '';      // which track the loaded lines belong to
    var lyrTracks = [];   // selectable subtitle tracks (languages) for it
    var lyrPicked = 0;    // index of the one being shown
    var lyrId = '';       // record id, for remembering the language choice
    var lyrActive = -1;
    var lyrSeq = 0;       // guards against a slow load landing on a later track
    var userScrolledAt = 0;

    function recordId(url) { var m = /\/stream\/([^/]+)/.exec(url || ''); return m ? m[1] : null; }

    function setTab(t) {
        tab = t;
        localStorage.setItem('ytdl-nptab', t);
        var btn = $('npf-lyrbtn'), box = $('npf-lyrics'), art = $('npf-art');
        if (!btn) return;
        btn.textContent = t === 'lyrics' ? 'Cover' : 'Lyrics';
        btn.classList.toggle('on', t === 'lyrics');
        if (box) box.hidden = t !== 'lyrics';
        if (art) art.hidden = t === 'lyrics';
        if (t === 'lyrics') { loadLyrics(cur()); scrollToActive(true); }
    }

    // Which subtitle track the user chose for a given record, remembered per track: a
    // video may ship several languages and the right one is a personal choice, not a
    // guess the server can make.
    function langKey(id) { return 'ytdl.lyrlang.' + id; }
    function pickedTrack(id) {
        var v = parseInt(localStorage.getItem(langKey(id)) || '', 10);
        return isFinite(v) ? v : 0;
    }

    async function loadLyrics(t, forceIndex) {
        var box = $('npf-lyrics');
        if (!box || !t) return;
        if (lyrUrl === t.url && forceIndex === undefined) return;   // already loaded
        var id = recordId(t.url);
        if (!id) { showNoLyrics('These lyrics aren’t available for this track.'); return; }

        var idx = forceIndex !== undefined ? forceIndex : pickedTrack(id);
        var mySeq = ++lyrSeq;
        lyrUrl = t.url; lyrics = []; lyrEls = []; lyrActive = -1;
        box.innerHTML = '<div class="npf-lyr-msg">Loading lyrics…</div>';
        try {
            // Cache-first in the service worker, and prefetched when a track is saved
            // offline — so this resolves with no network on a saved track.
            var res = await fetch('/api/lyrics/' + id + '?t=' + idx);
            if (!res.ok) throw new Error('status ' + res.status);
            var data = await res.json();
            if (mySeq !== lyrSeq) return;
            lyrics = data.lines || [];
            lyrTracks = data.tracks || [];
            lyrPicked = data.selected || 0;
            lyrId = id;
        } catch (e) {
            if (mySeq !== lyrSeq) return;
            showNoLyrics(navigator.onLine
                ? 'No lyrics saved for this track.'
                : 'Lyrics for this track aren’t on this phone.');
            return;
        }
        if (!lyrics.length) { showNoLyrics('No lyrics saved for this track.'); return; }
        renderLyrics();
    }

    function chooseTrack(i) {
        if (!lyrId) return;
        localStorage.setItem(langKey(lyrId), String(i));
        loadLyrics(cur(), i);
    }

    function showNoLyrics(msg) {
        var box = $('npf-lyrics');
        if (!box) return;
        lyrics = []; lyrEls = [];
        box.innerHTML = '<div class="npf-lyr-empty"><div class="npf-lyr-t">No lyrics</div>' +
            '<div class="npf-lyr-s"></div></div>';
        box.querySelector('.npf-lyr-s').textContent = msg +
            ' Lyrics come from the subtitles downloaded with a track — re-download it with ' +
            'subtitles on, or drop an .lrc file next to the audio.';
    }

    function renderLyrics() {
        var box = $('npf-lyrics');
        var frag = document.createDocumentFragment();

        // Language chooser, only when there is actually a choice to make. Sticky so it
        // stays reachable while the words scroll underneath.
        if (lyrTracks.length > 1) {
            var bar = document.createElement('div');
            bar.className = 'npf-lyr-langs';
            lyrTracks.forEach(function (tr) {
                var b = document.createElement('button');
                b.className = 'npf-lang' + (tr.i === lyrPicked ? ' on' : '');
                b.textContent = tr.label || tr.lang || ('Track ' + (tr.i + 1));
                b.dataset.lyrTrack = tr.i;
                bar.appendChild(b);
            });
            frag.appendChild(bar);
        }

        lyrEls = new Array(lyrics.length);
        for (var i = 0; i < lyrics.length; i++) {
            var el = document.createElement('div');
            el.className = 'npf-lyr';
            el.textContent = lyrics[i].text;
            el.dataset.i = i;
            frag.appendChild(el);
            lyrEls[i] = el;
        }
        box.innerHTML = '';
        box.appendChild(frag);
        lyrActive = -1;
        paintLyrics(true);
    }

    // Tap a line to jump there; one delegated listener rather than one per line, which
    // matters when an audiobook has thousands of them.
    document.addEventListener('click', function (e) {
        if (!e.target.closest) return;
        var lang = e.target.closest('[data-lyr-track]');
        if (lang) { chooseTrack(Number(lang.dataset.lyrTrack)); return; }
        var el = e.target.closest('.npf-lyr');
        if (!el || !audio) return;
        var l = lyrics[Number(el.dataset.i)];
        if (l) { try { audio.currentTime = l.t; } catch (err) { } audio.play().catch(function () { }); }
    });

    function activeIndex(pos) {
        // Binary search — a linear scan over thousands of lines four times a second is
        // exactly the kind of thing that makes a phone warm.
        var lo = 0, hi = lyrics.length - 1, best = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (lyrics[mid].t <= pos) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return best;
    }

    function paintLyrics(force) {
        if (!lyrics.length || tab !== 'lyrics' || !audio) return;
        var pos = audio.currentTime || 0;
        var i = activeIndex(pos);
        if (i !== lyrActive) {
            if (lyrEls[lyrActive]) { lyrEls[lyrActive].classList.remove('on'); lyrEls[lyrActive].style.backgroundImage = ''; }
            if (lyrEls[i]) lyrEls[i].classList.add('on');
            lyrActive = i;
            scrollToActive(force);
        }
        if (lyrEls[i]) {
            // Karaoke wipe: fill the line in proportion to how far through it we are.
            var next = lyrics[i + 1];
            var span = Math.max(0.5, (next ? next.t : (audio.duration || lyrics[i].t + 6)) - lyrics[i].t);
            var f = Math.max(0, Math.min(100, ((pos - lyrics[i].t) / span) * 100));
            lyrEls[i].style.backgroundImage =
                'linear-gradient(90deg,var(--accent) ' + f + '%,var(--dim) ' + f + '%)';
        }
    }

    function scrollToActive(force) {
        var box = $('npf-lyrics'), el = lyrEls[lyrActive];
        if (!box || !el || tab !== 'lyrics') return;
        // Leave manual scrolling alone for a few seconds so reading ahead isn't yanked back.
        if (!force && Date.now() - userScrolledAt < 4000) return;
        var top = el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2;
        box.scrollTo({ top: Math.max(0, top), behavior: force ? 'auto' : 'smooth' });
    }

    function setGlyph(g) {
        if (elPlay) elPlay.textContent = g;
        var p = $('npf-play'); if (p) p.textContent = g;
        if (g === '▶' && elPlay) { elPlay.classList.remove('loading'); if (p) p.classList.remove('loading'); }
    }

    // --- full-screen player -------------------------------------------------------
    function openFull() { if (!cur()) return; full.classList.add('show'); paintFull(); }
    function closeFull() { full.classList.remove('show'); }

    function paintFull() {
        var t = cur(); if (!t || !full) return;
        $('npf-from').textContent = ctx ? 'Playing from ' + ctx : 'Playing from library';
        $('npf-title').textContent = t.title || '';
        $('npf-artist').textContent = t.author || '';
        var art = $('npf-art');
        art.textContent = mono(t.title);
        art.style.background = tint(t.url);
        if (tab === 'lyrics' && lyrUrl !== t.url) loadLyrics(t);   // new track: new words
        paintTime();
    }

    function fmt(s) {
        if (!isFinite(s) || s < 0) return '0:00';
        var m = Math.floor(s / 60), r = Math.floor(s % 60);
        if (m < 60) return m + ':' + (r < 10 ? '0' : '') + r;
        var h = Math.floor(m / 60);
        return h + ':' + ((m % 60) < 10 ? '0' : '') + (m % 60) + ':' + (r < 10 ? '0' : '') + r;
    }

    function paintTime() {
        if (!audio) return;
        var d = audio.duration, pos = audio.currentTime || 0;
        var pct = (isFinite(d) && d > 0) ? (pos / d) * 100 : 0;
        var mini = $('np-prog'); if (mini) mini.style.width = pct + '%';
        if (!full || !full.classList.contains('show')) return;
        $('npf-fill').style.width = pct + '%';
        $('npf-pos').textContent = fmt(pos);
        $('npf-dur').textContent = isFinite(d) ? fmt(d) : '—';
        paintLyrics(false);
    }

    function seekFromEvent(e) {
        if (!audio || !isFinite(audio.duration)) return;
        var r = e.currentTarget.getBoundingClientRect();
        var f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        try { audio.currentTime = f * audio.duration; } catch (err) { }
        paintTime();
    }

    // Artwork stand-ins, matching what the server renders into the rows so a track looks
    // the same in the list and in the player.
    function mono(title) {
        var parts = String(title || '').split(/\s+/).filter(Boolean);
        var out = '';
        for (var i = 0; i < parts.length && out.length < 2; i++) {
            var m = /[\p{L}\p{N}]/u.exec(parts[i]);
            if (m) out += m[0];
        }
        return out ? out.toUpperCase() : '♪';
    }
    var HUES = [148, 190, 262, 24, 330, 96];
    function tint(seed) {
        // Match TrackVisuals.Tint: hash the record id out of "/stream/{id}/{idx}".
        var m = /\/stream\/([^/]+)/.exec(seed || '');
        var id = m ? m[1] : String(seed || '');
        var h = 0;
        for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0x7FFFFFFF;
        return 'oklch(0.42 0.09 ' + HUES[h % HUES.length] + ')';
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
        elArt.textContent = mono(t.title);
        elArt.style.background = tint(t.url);
        bar.classList.add('show');
        setStatus('loading');
        markSource(t, gen);
        paintFull();
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
    // rather than assumed. Shown as the pill in the full player.
    async function markSource(t, myGen) {
        var badge = $('npf-badge');
        if (!badge) return;
        var onDevice = await cached(t.url);
        if (myGen !== gen) return;
        badge.textContent = onDevice ? 'Saved on this phone'
            : (navigator.onLine ? 'Streaming — not saved' : 'Not saved on this phone');
        badge.classList.toggle('on', onDevice);
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
        var pf = $('npf-play'); if (pf) pf.classList.toggle('loading', s === 'loading');
        if (s === 'error') {
            setGlyph('▶');
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
        var s = $('npf-shuffle'); if (s) s.classList.toggle('on', shuffle);
        // A playlist's ⤮ lights up only while that playlist is the one playing.
        document.querySelectorAll('[data-shuffle]').forEach(function (b) {
            var card = b.closest('[data-pl-card]');
            var mine = !card || (ctx && card.getAttribute('data-pl-card') === ctxId);
            b.classList.toggle('on', shuffle && !!mine);
        });
    }

    function setSession(t) {
        if (!('mediaSession' in navigator)) return;
        navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || '', artist: t.author || '', album: ctx });
        navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
        navigator.mediaSession.setActionHandler('nexttrack', next);
        navigator.mediaSession.setActionHandler('previoustrack', prev);
    }

    // Start a resolved playlist ({id, name, tracks}) at `atUrl` (or the top).
    function start(pl, atUrl) {
        var i = atUrl ? pl.tracks.findIndex(function (t) { return t.url === atUrl; }) : 0;
        ctxId = pl.id || '';
        play(pl.tracks, i < 0 ? 0 : i, pl.name);
        markCurrentCard();
    }

    // Highlight the playlist card that's playing.
    function markCurrentCard() {
        document.querySelectorAll('[data-pl-card]').forEach(function (c) {
            c.classList.toggle('is-current', !!ctxId && c.getAttribute('data-pl-card') === ctxId);
        });
    }

    // Resolve a playlist device-first (same order as playFromApi) without playing it.
    function resolve(id) {
        if (!window.ytdlOffline) return null;
        var pl = ytdlOffline.get(id) || ytdlOffline.manifestPlaylist(id);
        return (pl && pl.tracks && pl.tracks.length) ? pl : null;
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

    // Generic row highlighter: any page whose track rows carry [data-track-url] gets the
    // playing row marked for free.
    document.addEventListener('ytdl:playing', function (e) {
        var url = e.detail.url;
        document.querySelectorAll('.trk[data-track-url]').forEach(function (el) {
            el.classList.toggle('playing', !!url && el.getAttribute('data-track-url') === url);
        });
        markCurrentCard();
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
        // The ⤮ on a playlist card: turn shuffle on and start that playlist somewhere
        // random. Device-first like everything else, so it works with no signal.
        shufflePlaylist: function (id) {
            var pl = resolve(id);
            if (!pl) { this.playFromApi(id); return; }
            shuffle = true;
            localStorage.setItem('ytdl-shuffle', '1');
            ctxId = pl.id || id;
            play(pl.tracks, Math.floor(Math.random() * pl.tracks.length), pl.name);
            markCurrentCard();
        },
        openFull: openFull,
        toggle: toggle, next: next, prev: prev,
        setShuffle: setShuffle, toggleShuffle: function () { setShuffle(!shuffle); },
        isShuffle: function () { return shuffle; },
        current: function () { var t = cur(); return t ? t.url : null; },
        isPlaying: function () { return !!(audio && !audio.paused); }
    };

    if (document.readyState !== 'loading') injectBar();
    else document.addEventListener('DOMContentLoaded', injectBar);
})();
