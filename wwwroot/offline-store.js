// Offline store — the single source of truth for "what's downloaded to this device".
// Audio bytes live in the Cache API ('ytdl-media', the cache the service worker serves
// from); playlist metadata lives in localStorage. Shared by the Playlists download
// toggle and per-track ⤓ markers (playlist-offline.js) and by the player.
//
// Everything here answers from local storage with NO network, so a caller can decide
// what to play before it ever touches the radio. On a weak connection a network read
// can hang for minutes — the device's own copy must always win the race.
window.ytdlOffline = (function () {
    var LS = 'ytdl.offline.v1';
    var MANIFEST = 'ytdl.manifest.v1';
    var CACHE = 'ytdl-media';

    function load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
    function write(o) { localStorage.setItem(LS, JSON.stringify(o)); }

    function list() { return Object.values(load()); }
    function get(id) { return load()[id]; }

    // --- last-known server manifest -------------------------------------------------
    // A copy of /api/playlists kept on the device, so playlists that were never
    // downloaded still resolve to a track list (titles + stream URLs) with no network.
    function saveManifest(pls) {
        try { localStorage.setItem(MANIFEST, JSON.stringify(pls)); } catch (e) { /* quota */ }
    }
    function manifest() {
        try { var m = JSON.parse(localStorage.getItem(MANIFEST)); return Array.isArray(m) ? m : null; }
        catch (e) { return null; }
    }
    function manifestPlaylist(id) {
        var m = manifest();
        return m ? (m.find(function (p) { return p.id === id; }) || null) : null;
    }

    // --- what audio is actually on this device --------------------------------------
    // Cached lazily: reading every key out of the Cache API on each track change would
    // be wasteful, and the set only changes when we download or remove a playlist.
    var urls = null;
    function key(u) { try { return new URL(u, location.origin).pathname; } catch (e) { return u; } }

    async function cachedSet(force) {
        if (urls && !force) return urls;
        urls = new Set();
        try {
            var keys = await (await caches.open(CACHE)).keys();
            keys.forEach(function (r) { urls.add(key(r.url)); });
        } catch (e) { /* no Cache API (insecure origin) — treat as nothing saved */ }
        return urls;
    }
    async function isCached(url) { return (await cachedSet()).has(key(url)); }

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
        await cachedSet(true);                       // refresh the "on device" index
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
        await cachedSet(true);
    }

    return {
        list: list, get: get, state: state, matches: matches,
        download: download, remove: remove, renameSaved: renameSaved,
        saveManifest: saveManifest, manifest: manifest, manifestPlaylist: manifestPlaylist,
        cachedSet: cachedSet, isCached: isCached,
    };
})();
