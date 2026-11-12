// "Play on…": send a playlist to a paired player box (a TV, kiosk or spare phone) instead
// of playing it on this device. The button on each playlist card only shows once at least
// one player is paired (body.has-players), so a phone-only setup never sees it.
//
// Plain JS like the rest of the playlist controls, and time-boxed like every network call
// here: asking a player to play needs the server by definition, but failing to reach it
// must say so quickly rather than hang.
window.ytdlCast = (function () {
    'use strict';
    var NET_MS = 4000;
    var players = [];

    function fetchSoon(url, opts) {
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, NET_MS);
        opts = opts || {};
        opts.signal = ctl.signal;
        opts.cache = 'no-store';
        return fetch(url, opts).finally(function () { clearTimeout(timer); });
    }

    async function refresh() {
        try {
            var r = await fetchSoon('/api/players');
            if (!r.ok) return;
            players = await r.json();
            document.body.classList.toggle('has-players', players.length > 0);
        } catch (e) { /* offline: keep whatever we knew */ }
    }

    function $(id) { return document.getElementById(id); }

    function ensureSheet() {
        var el = $('ytdl-cast');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'ytdl-cast';
        el.className = 'sheet-scrim';
        el.innerHTML =
            '<div class="sheet">' +
              '<div class="sheet-grip"></div>' +
              '<div class="sheet-head"><div class="sheet-title" id="cast-title"></div>' +
              '<div class="sheet-sub" id="cast-sub"></div></div>' +
              '<div class="sheet-items" id="cast-items"></div>' +
            '</div>';
        el.addEventListener('click', function (e) { if (e.target === el) close(); });
        return el;
    }
    function close() { var el = $('ytdl-cast'); if (el) el.classList.remove('show'); }

    function row(glyph, label, meta, onClick, disabled) {
        var b = document.createElement('button');
        b.className = 'sheet-btn';
        b.innerHTML = '<span class="sheet-glyph"></span><span class="sheet-label"></span><span class="sheet-meta"></span>';
        b.children[0].textContent = glyph;
        b.children[1].textContent = label;
        b.children[2].textContent = meta || '';
        if (disabled) { b.disabled = true; b.style.opacity = '.45'; }
        else b.addEventListener('click', onClick);
        return b;
    }

    async function pick(playlistId) {
        var el = ensureSheet();
        // Re-attached every time: a Blazor re-render can sweep it out of the app column.
        var host = document.querySelector('.app') || document.body;
        if (el.parentNode !== host) host.appendChild(el);

        var card = document.querySelector('[data-pl-card="' + playlistId + '"] .pl-name');
        $('cast-title').textContent = 'Play on…';
        $('cast-sub').textContent = card ? card.textContent : '';
        var items = $('cast-items');
        items.innerHTML = '';
        el.classList.add('show');

        await refresh();
        items.innerHTML = '';
        if (!players.length) {
            $('cast-sub').textContent = 'No players paired yet. Add one from Players.';
            return;
        }
        players.forEach(function (p) {
            var meta = !p.online ? 'Offline' : p.playing && p.title ? '♪ ' + p.title : 'Online';
            items.appendChild(row(p.online ? '●' : '○', p.name, meta, function () { send(p, playlistId); }, !p.online));
        });
    }

    async function send(p, playlistId) {
        var sub = $('cast-sub');
        sub.textContent = 'Sending to ' + p.name + '…';
        try {
            var r = await fetchSoon('/api/players/' + encodeURIComponent(p.id) + '/play', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playlistId: playlistId }),
            });
            var body = await r.json().catch(function () { return {}; });
            if (!r.ok) { sub.textContent = body.error || 'Couldn’t reach ' + p.name + '.'; return; }
            sub.textContent = body.outcome === 'delivered' ? 'Playing on ' + p.name + '.'
                : body.outcome === 'queued' ? p.name + ' will start within 15 seconds.'
                : p.name + ' isn’t connected right now.';
            if (body.outcome !== 'offline') setTimeout(close, 1400);
        } catch (e) {
            sub.textContent = 'Couldn’t reach the server. Players need a connection to be told what to play.';
        }
    }

    function boot() {
        refresh();
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') refresh();
        });
    }
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);

    return {
        pick: pick,
        refresh: refresh,
        // For the Players page: the address as the browser sees it, and clipboard access.
        origin: function () { return location.origin; },
        copy: function (text) {
            if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        },
    };
})();
