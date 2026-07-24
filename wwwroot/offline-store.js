// Offline store — the single source of truth for "what's downloaded to this device".
// Audio bytes live in the Cache API ('ytdl-media', the cache the service worker serves
// from); playlist metadata lives in localStorage. Shared by the Playlists download
// toggle (playlist-offline.js) and the Downloads page (offline.js).
window.ytdlOffline = (function () {
    var LS = 'ytdl.offline.v1';
    var CACHE = 'ytdl-media';

    function load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
    function write(o) { localStorage.setItem(LS, JSON.stringify(o)); }

    function list() { return Object.values(load()); }
    function get(id) { return load()[id]; }

    // True when the saved copy holds exactly this set of track URLs (i.e. not stale).
    function matches(saved, tracks) {
        if (!saved) return false;
        var have = new Set(saved.tracks.map(function (t) { return t.url; }));
        return have.size === tracks.length && tracks.every(function (t) { return have.has(t.url); });
    }

    // 'none' | 'saved' | 'stale' for a playlist given its current server tracks.
    function state(id, tracks) {
        var s = get(id);
        if (!s) return 'none';
        return matches(s, tracks) ? 'saved' : 'stale';
    }

    async function download(id, name, tracks, onProgress) {
        var cache = await caches.open(CACHE);
        var bytes = 0;
        for (var i = 0; i < tracks.length; i++) {
            try {
                var res = await fetch(tracks[i].url);
                if (res.ok) { await cache.put(tracks[i].url, res.clone()); bytes += (await res.blob()).size; }
            } catch (e) { /* skip a track that fails; the rest still save */ }
            if (onProgress) onProgress((i + 1) / tracks.length);
        }
        var all = load();
        all[id] = {
            id: id, name: name, savedAt: new Date().toISOString(), bytes: bytes,
            tracks: tracks.map(function (t) { return { url: t.url, title: t.title, author: t.author }; })
        };
        write(all);
    }

    // Update a downloaded copy's display name (audio is unchanged) after a rename.
    function renameSaved(id, name) {
        var all = load();
        if (all[id] && all[id].name !== name) { all[id].name = name; write(all); }
    }

    async function remove(id) {
        var all = load(), pl = all[id];
        if (!pl) return;
        var cache = await caches.open(CACHE);
        var keep = new Set();                        // keep audio still used by another download
        Object.keys(all).forEach(function (k) {
            if (k !== id) all[k].tracks.forEach(function (t) { keep.add(t.url); });
        });
        for (var i = 0; i < pl.tracks.length; i++) {
            if (!keep.has(pl.tracks[i].url)) await cache.delete(pl.tracks[i].url);
        }
        delete all[id];
        write(all);
    }

    return { list: list, get: get, state: state, matches: matches, download: download, remove: remove, renameSaved: renameSaved };
})();
