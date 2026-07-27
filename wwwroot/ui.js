// Shell behaviour that has to work with no SignalR circuit: the header, the search box,
// the Library filter chips, the storage meter and the per-track action sheet.
//
// The sheet is the design's single ⋯ affordance for row actions. Server-side actions
// (reorder, remove, archive) still go through Blazor: each row renders those buttons
// hidden inside .row-ops, and the sheet clicks them. A programmatic .click() dispatches
// a real bubbling event, so the @onclick handler runs exactly as if tapped — which keeps
// one implementation of every mutation instead of a parallel JS one.
window.ytdlUI = (function () {
    var TITLES = { '/': 'Playlists', '/playlists': 'Playlists', '/library': 'Library', '/history': 'Library', '/download': 'Add music' };
    var query = '';
    var filter = 'all';

    function $(id) { return document.getElementById(id); }

    function setTitle() {
        var el = $('view-title');
        if (el) el.textContent = TITLES[location.pathname] || 'My Music';
    }

    // --- search --------------------------------------------------------------------
    // Filters the rows already in the DOM, so it works offline and needs no round-trip.
    function toggleSearch() {
        var wrap = $('search-wrap'), btn = $('btn-search');
        if (!wrap) return;
        var open = wrap.hidden;
        wrap.hidden = !open;
        if (btn) btn.classList.toggle('on', open);
        if (open) { var i = $('search-input'); if (i) i.focus(); }
        else { query = ''; var inp = $('search-input'); if (inp) inp.value = ''; applyRows(); }
    }
    function onQuery(v) { query = (v || '').trim().toLowerCase(); applyRows(); }

    // --- library filter chips ------------------------------------------------------
    function bindChips() {
        document.querySelectorAll('.chip[data-filter]').forEach(function (c) {
            if (c._bound) return;
            c._bound = true;
            c.addEventListener('click', function () {
                filter = c.getAttribute('data-filter');
                applyRows();
            });
        });
    }

    // One pass over every row: search text AND offline filter decide visibility. The
    // offline state comes from the row's own painted label, so this stays local.
    function applyRows() {
        document.querySelectorAll('.chip[data-filter]').forEach(function (c) {
            c.classList.toggle('on', c.getAttribute('data-filter') === filter);
        });
        var rows = document.querySelectorAll('#lib-rows .trk');
        var shown = 0;
        rows.forEach(function (r) {
            var hay = ((r.getAttribute('data-title') || '') + ' ' + (r.getAttribute('data-artist') || '')).toLowerCase();
            var okText = !query || hay.indexOf(query) >= 0;
            var off = r.querySelector('.trk-off');
            var saved = !!(off && off.classList.contains('on'));
            var okFilter = filter === 'all' || (filter === 'offline' ? saved : !saved);
            var vis = okText && okFilter;
            r.hidden = !vis;
            if (vis) shown++;
        });
        var none = $('no-results');
        if (none) none.hidden = !(rows.length && shown === 0);
    }

    // Counts for the chips, and the "on this phone" meter. Both read the Cache API only.
    async function paintStorage() {
        var rows = document.querySelectorAll('#lib-rows .trk');
        if (rows.length) {
            var saved = 0;
            rows.forEach(function (r) {
                var o = r.querySelector('.trk-off');
                if (o && o.classList.contains('on')) saved++;
            });
            var a = document.querySelector('[data-count="offline"]');
            var b = document.querySelector('[data-count="missing"]');
            if (a) a.textContent = String(saved);
            if (b) b.textContent = String(rows.length - saved);
        }

        var fill = $('storage-fill'), label = $('storage-label');
        if (!fill || !label) return;
        // Bytes actually saved come from the download store; the ceiling comes from the
        // browser's own quota estimate, which is the real limit on a phone.
        var used = 0;
        try { (ytdlOffline.list() || []).forEach(function (p) { used += p.bytes || 0; }); } catch (e) { }
        var quota = 0;
        try {
            if (navigator.storage && navigator.storage.estimate) {
                var est = await navigator.storage.estimate();
                quota = est.quota || 0;
                if (est.usage) used = Math.max(used, est.usage);
            }
        } catch (e) { }
        fill.style.width = (quota ? Math.min(100, (used / quota) * 100) : 0) + '%';
        label.textContent = quota ? gb(used) + ' of ' + gb(quota) + ' used' : gb(used) + ' saved on this phone';

        // Whether the browser has agreed not to evict this data matters more than the
        // number: without it, a long gap between trips can silently bin the downloads.
        try {
            var s = await ytdlOffline.space();
            if (!s.persisted) {
                label.textContent += ' · not protected from cleanup';
                label.title = 'The browser may reclaim this space. Installing the app to your ' +
                              'home screen makes downloads persistent.';
            }
        } catch (e) { }
    }
    function gb(b) {
        if (b >= 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(1) + ' GB';
        return Math.round(b / 1024 / 1024) + ' MB';
    }

    // --- action sheet ---------------------------------------------------------------
    function ensureSheet() {
        var el = $('ytdl-sheet');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'ytdl-sheet';
        el.className = 'sheet-scrim';
        el.innerHTML =
            '<div class="sheet" id="sheet-panel">' +
              '<div class="sheet-grip"></div>' +
              '<div class="sheet-head"><div class="sheet-title" id="sheet-title"></div>' +
              '<div class="sheet-sub" id="sheet-sub"></div></div>' +
              '<div class="sheet-items" id="sheet-items"></div>' +
            '</div>';
        (document.querySelector('.app') || document.body).appendChild(el);
        el.addEventListener('click', function (e) { if (e.target === el) close(); });
        return el;
    }
    function close() { var el = $('ytdl-sheet'); if (el) el.classList.remove('show'); }

    function item(glyph, label, meta, onClick, danger) {
        var b = document.createElement('button');
        b.className = 'sheet-btn' + (danger ? ' danger' : '');
        b.innerHTML = '<span class="sheet-glyph"></span><span class="sheet-label"></span><span class="sheet-meta"></span>';
        b.children[0].textContent = glyph;
        b.children[1].textContent = label;
        b.children[2].textContent = meta || '';
        b.addEventListener('click', onClick);
        return b;
    }

    // Build the sheet for the row the ⋯ belongs to.
    function sheet(btn) {
        var row = btn.closest('.trk');
        if (!row) return;
        var el = ensureSheet();
        var url = row.getAttribute('data-track-url');
        var listId = row.getAttribute('data-list');
        var off = row.querySelector('.trk-off');
        var saved = !!(off && off.classList.contains('on'));

        $('sheet-title').textContent = row.getAttribute('data-title') || '';
        $('sheet-sub').textContent = [row.getAttribute('data-artist'), saved ? 'On this phone' : 'Not saved'].filter(Boolean).join(' · ');

        var host = $('sheet-items');
        host.innerHTML = '';

        // A track that is still only a link: the one thing worth deciding before the
        // download starts is whether it is speech or music, because that is a 4x
        // difference in the file it produces — and once it's fetched it's too late.
        if (row.getAttribute('data-pending') === '1') {
            var speech = row.getAttribute('data-speech') === '1';
            proxy(host, row, '.op-speech',
                speech ? '♪' : '🎙',
                speech ? 'Download at music quality instead' : 'Download as audiobook (about 4× smaller)');
        }

        if (url) {
            host.appendChild(item('▶', 'Play now', '', function () {
                close();
                if (listId) ytdlPlayer.tapTrack(url, listId);
                else ytdlPlayer.playEl(row.querySelector('.trk-hit'));
            }));

            // Per-file offline, independent of any playlist. Saving needs the network by
            // definition; removing does not, so it stays available offline.
            var title = row.getAttribute('data-title'), artist = row.getAttribute('data-artist');
            var off = row.querySelector('.trk-off');
            var partly = off && /^Saved \d+%$/.test(off.textContent || '');
            if (saved) {
                host.appendChild(item('✓', 'Remove from this phone', 'frees space', function () {
                    close(); ytdlTrackToggle(url, title, artist);
                }));
            } else if (navigator.onLine) {
                // A large download resumes from the first missing piece, so the verb is
                // "Resume" — restarting a 500 MB book from zero would be the wrong promise.
                host.appendChild(item('⤓', partly ? 'Resume download' : 'Save to this phone',
                    partly ? off.textContent.toLowerCase() + ' already' : 'plays with no signal',
                    function () { close(); ytdlTrackToggle(url, title, artist); }));
                if (partly) {
                    host.appendChild(item('✕', 'Discard partial download', '', function () {
                        close(); ytdlTrackToggle(url, title, artist, true);
                    }, true));
                }
            } else {
                host.appendChild(item('⤓', 'Save to this phone', 'needs a connection', function () { close(); }));
            }
        }

        // Server-backed actions, proxied to the row's hidden Blazor buttons. Skipped
        // entirely with no circuit — offering them would do nothing.
        if (!document.body.classList.contains('no-circuit')) {
            proxy(host, row, '.op-up', '▲', 'Move up');
            proxy(host, row, '.op-down', '▼', 'Move down');
            proxy(host, row, '.op-archive', '⌫', 'Archive');
            proxy(host, row, '.op-restore', '↺', 'Restore');
            proxy(host, row, '.op-remove', '✕', 'Remove from this playlist', true);
        }

        // Sharing hands out a public link, so it needs the network by definition.
        if (row.getAttribute('data-share-id') && navigator.onLine) {
            host.appendChild(item('⇗', 'Share a listen link', '', function () { close(); ytdlShare(row); }));
        }

        row.querySelectorAll('.row-files a').forEach(function (a) {
            host.appendChild(item('⤓', 'Download ' + (a.getAttribute('data-label') || 'file'), '', function () {
                close(); a.click();
            }));
        });

        el.classList.add('show');
    }

    // Add a sheet row that clicks a hidden Blazor button, if that button exists and is
    // enabled (a disabled ▲ on the first track simply doesn't appear).
    function proxy(host, row, sel, glyph, label, danger) {
        var b = row.querySelector(sel);
        if (!b || b.disabled) return;
        host.appendChild(item(glyph, label, '', function () { close(); b.click(); }, danger));
    }

    // Which shell version this device is actually serving assets from. If it lags the
    // server build, the app is running old code and needs a reload.
    async function paintVersion() {
        var el = $('sw-version');
        if (!el) return;
        try {
            var shell = (await caches.keys()).filter(function (k) { return k.indexOf('ytdl-shell-') === 0; });
            el.textContent = shell.length
                ? 'offline cache ' + shell[0].replace('ytdl-shell-', '')
                : 'no offline cache yet';
        } catch (e) { el.textContent = 'offline cache unavailable'; }
    }

    function refresh() { setTitle(); bindChips(); applyRows(); paintStorage(); paintVersion(); }

    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    // The title and the chips are pure DOM work — they must not wait on the Cache API
    // read that paints the offline labels, or the header sits on a stale value whenever
    // that read is slow or unavailable (e.g. an insecure origin, where caches is absent).
    function boot() { setTitle(); bindChips(); }
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);

    return {
        toggleSearch: toggleSearch, onQuery: onQuery, sheet: sheet, close: close,
        refresh: refresh, applyRows: applyRows, paintStorage: paintStorage,
    };
})();
