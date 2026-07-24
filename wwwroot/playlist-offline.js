// Drives the per-playlist download toggle on the Playlists page. The download state is
// inherently client-side (Cache API), so C#/Blazor can't render it — this reads it from
// ytdlOffline and paints the [data-download-id] buttons, re-syncing whenever Blazor
// re-renders the list (debounced MutationObserver, with self-mutation guarded out).
(function () {
    var cacheTs = 0, cacheData = null, observer = null, timer = null;

    async function serverPlaylists() {
        var now = Date.now();
        if (cacheData && now - cacheTs < 4000) return cacheData;
        var res = await fetch('/api/playlists', { cache: 'no-store' });
        cacheData = await res.json(); cacheTs = now;
        return cacheData;
    }
    function find(pls, id) { return pls.find(function (p) { return p.id === id; }); }

    function paint(btn, st) {
        btn.classList.remove('saved', 'stale');
        if (st === 'saved') { btn.classList.add('saved'); btn.textContent = '✓'; btn.title = 'Downloaded — tap to remove'; }
        else if (st === 'stale') { btn.classList.add('stale'); btn.textContent = '↻'; btn.title = 'Playlist changed — tap to update the download'; }
        else { btn.textContent = '⬇'; btn.title = 'Download for offline'; }
    }

    async function sync() {
        var btns = document.querySelectorAll('[data-download-id]');
        if (!btns.length) return;
        var pls;
        try { pls = await serverPlaylists(); } catch (e) { return; }
        if (observer) observer.disconnect();                     // don't let our own writes re-trigger us
        btns.forEach(function (btn) {
            if (btn.classList.contains('busy')) return;          // mid-download: leave the % alone
            var pl = find(pls, btn.getAttribute('data-download-id'));
            paint(btn, pl ? ytdlOffline.state(pl.id, pl.tracks) : 'none');
        });
        if (observer) observer.observe(document.body, { childList: true, subtree: true });
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
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        schedule();
    }
    if (document.readyState !== 'loading') boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
