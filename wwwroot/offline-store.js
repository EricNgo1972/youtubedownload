// Offline store — the single source of truth for "what's downloaded to this device".
// Audio bytes live in the Cache API ('ytdl-media', the cache the service worker serves
// from); playlist metadata lives in localStorage. Shared by the Playlists download
// toggle and per-track ⤓ markers (playlist-offline.js) and by the player.
//
// Everything here answers from local storage with NO network, so a caller can decide
// what to play before it ever touches the radio. On a weak connection a network read
// can hang for minutes — the device's own copy must always win the race.
window.ytdlOffline = (function () {
    var LS = 'ytdl.offline.v1';        // playlistId -> saved playlist
    var LS_T = 'ytdl.tracks.v1';       // url -> individually saved track
    var MANIFEST = 'ytdl.manifest.v1';
    var CACHE = 'ytdl-media';          // whole-file entries (small tracks)
    var CHUNKS = 'ytdl-chunks';        // chunked entries + their metadata

    // Big files are stored in pieces. A Cache API entry is one immutable response, so a
    // 500 MB download that dies at 480 MB would otherwise start again from zero — which
    // is exactly what happens on hotel wifi the night before a flight. Chunks make the
    // download resumable, and the service worker stitches them back together per range
    // request so playback and seeking are unchanged.
    var CHUNK = 8 * 1048576;           // 8 MB: ~63 pieces for a 500 MB book
    var CHUNK_MIN = 12 * 1048576;      // below this, chunking is pure overhead

    // Keys are internal to this app, but they are read from TWO places that see a URL
    // differently: this page holds relative track URLs ("/stream/id/0") while the service
    // worker only ever sees the absolute request URL. Both sides must therefore key off
    // the same canonical form — the pathname — or the worker looks up a key that was
    // never written and every chunked file silently falls through to the network.
    function idOf(u) { try { return new URL(u, location.origin).pathname; } catch (e) { return u; } }
    function chunkKey(url, i) { return '/__chunk__?u=' + encodeURIComponent(idOf(url)) + '&i=' + i; }
    function metaKey(url) { return '/__chunkmeta__?u=' + encodeURIComponent(idOf(url)); }

    async function readMeta(url) {
        try {
            var r = await (await caches.open(CHUNKS)).match(metaKey(url));
            return r ? await r.json() : null;
        } catch (e) { return null; }
    }
    async function writeMeta(meta) {
        // Stored in the Cache API rather than localStorage because the SERVICE WORKER
        // needs to read it when serving audio, and workers have no localStorage.
        await (await caches.open(CHUNKS)).put(metaKey(meta.url), new Response(JSON.stringify(meta), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        }));
    }
    function metaComplete(m) { return !!m && m.have && m.have.length === m.count && m.have.every(Boolean); }

    function load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch (e) { return {}; } }
    function write(o) { localStorage.setItem(LS, JSON.stringify(o)); }

    function list() { return Object.values(load()); }
    function get(id) { return load()[id]; }

    // --- individually saved tracks ---------------------------------------------------
    // A track's audio can be kept by a saved playlist, by an explicit per-track save, or
    // by both. These are separate claims on the same bytes: removing one owner must not
    // delete audio the other still wants.
    function loadT() { try { return JSON.parse(localStorage.getItem(LS_T)) || {}; } catch (e) { return {}; } }
    function writeT(o) { localStorage.setItem(LS_T, JSON.stringify(o)); }

    function savedTracks() { return Object.values(loadT()); }
    function isSavedTrack(url) { return !!loadT()[url]; }

    // Every URL some saved playlist still needs.
    function urlsHeldByPlaylists(exceptId) {
        var held = new Set(), all = load();
        Object.keys(all).forEach(function (k) {
            if (k === exceptId) return;
            (all[k].tracks || []).forEach(function (t) { held.add(t.url); });
        });
        return held;
    }

    // Download straight into the cache, counting bytes as they go past.
    //
    // The body is NEVER accumulated in JavaScript: it is piped through a counting
    // TransformStream directly into cache.put(), so peak memory is one chunk regardless
    // of file size. A single audiobook here can be hundreds of MB — buffering it (as a
    // chunk array or a Blob) would spike the heap by that much and take the tab with it.
    //
    // onProgress(fraction|null, bytesSoFar): fraction is null when the server sends no
    // Content-Length, in which case the caller shows bytes instead of a percentage.
    async function cacheInto(url, onProgress) {
        var res = await fetch(url);
        if (!res.ok) throw new Error('status ' + res.status);
        var total = Number(res.headers.get('Content-Length') || 0);
        var type = res.headers.get('Content-Type') || 'audio/mpeg';
        var cache = await caches.open(CACHE);
        var got = 0;

        var streamed = res.body && typeof TransformStream !== 'undefined' && res.body.pipeThrough;
        if (streamed) {
            var counter = new TransformStream({
                transform: function (chunk, ctl) {
                    got += chunk.byteLength;
                    if (onProgress) onProgress(total ? Math.min(1, got / total) : null, got);
                    ctl.enqueue(chunk);
                },
            });
            var headers = { 'Content-Type': type };
            if (total) headers['Content-Length'] = String(total);
            await cache.put(url, new Response(res.body.pipeThrough(counter), { status: 200, headers: headers }));
            if (!got) got = total;                       // some engines don't surface chunks
        } else {
            // No streams (old WebKit): fall back to letting the Cache API consume the
            // response itself — still no JS-side copy, just no progress ticks.
            await cache.put(url, res.clone());
            got = total || (await res.blob()).size;
        }
        if (onProgress) onProgress(1, got);
        return got;
    }

    // Ask the server how big the file is and whether it will serve byte ranges. One tiny
    // request; if it can't answer, we fall back to a whole-file download.
    async function probe(url) {
        try {
            var r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
            if (r.status !== 206) return null;
            var cr = r.headers.get('Content-Range') || '';       // "bytes 0-0/12345"
            var total = Number((cr.split('/')[1] || '').trim());
            if (!total || !isFinite(total)) return null;
            return { size: total, type: r.headers.get('Content-Type') || 'audio/mpeg' };
        } catch (e) { return null; }
    }

    /// Download a track in resumable pieces. Re-running this after an interruption picks
    /// up at the first missing chunk instead of starting over.
    async function saveChunked(url, info, onProgress) {
        var cache = await caches.open(CHUNKS);
        var count = Math.ceil(info.size / CHUNK);
        var meta = await readMeta(url);
        if (!meta || meta.size !== info.size || meta.chunkSize !== CHUNK) {
            meta = { url: url, size: info.size, type: info.type, chunkSize: CHUNK, count: count,
                     have: new Array(count).fill(false), savedAt: new Date().toISOString() };
        }

        var done = meta.have.filter(Boolean).length;
        if (onProgress) onProgress(done / count, done * CHUNK);

        for (var i = 0; i < count; i++) {
            if (meta.have[i]) continue;
            var start = i * CHUNK;
            var end = Math.min(start + CHUNK, info.size) - 1;
            var res = await fetch(url, { headers: { Range: 'bytes=' + start + '-' + end } });
            if (res.status !== 206 && res.status !== 200) throw new Error('status ' + res.status);
            // The Cache API refuses to store a 206, so rewrap the piece as a plain 200.
            // Passing the body stream through keeps this from buffering even 8 MB.
            await cache.put(chunkKey(url, i), new Response(res.body, {
                status: 200,
                headers: { 'Content-Type': info.type, 'Content-Length': String(end - start + 1) },
            }));
            meta.have[i] = true;
            // Persist after EVERY chunk: an interruption must cost at most one chunk.
            await writeMeta(meta);
            done++;
            if (onProgress) onProgress(done / count, Math.min(done * CHUNK, info.size));
        }
        return info.size;
    }

    /// Store one URL's audio the right way round: large files in resumable chunks, small
    /// ones whole, where the extra bookkeeping would just be overhead. Used by BOTH the
    /// per-track ⤓ and the playlist ⬇ — a playlist of audiobooks must not be the one path
    /// that downloads several hundred MB with no way to resume it.
    async function saveAudio(url, onProgress) {
        var info = await probe(url);
        if (info && info.size >= CHUNK_MIN) {
            // Drop any whole-file copy so the two storage modes can't both claim this URL.
            try { await (await caches.open(CACHE)).delete(url); } catch (e) { }
            return await saveChunked(url, info, onProgress);
        }
        var bytes = await cacheInto(url, onProgress);
        // …and the reverse: a stale chunk manifest would keep reporting a partial
        // download for a file that is now stored whole.
        await dropChunks(url);
        return bytes;
    }

    /// Save one track's audio to this device, and record the per-track claim on it.
    async function saveTrack(track, onProgress) {
        await ensurePersisted();
        var url = track.url;
        var bytes = await saveAudio(url, onProgress);

        await saveLyrics(url);

        var all = loadT();
        all[url] = {
            url: url, title: track.title || '', author: track.author || '',
            bytes: bytes, savedAt: new Date().toISOString(),
        };
        writeT(all);
        await cachedSet(true);
        return bytes;
    }

    // Pull the timed lyrics down with the audio. A few hundred KB of JSON, and without it
    // the karaoke view would be the one part of a saved track that needs a signal.
    async function saveLyrics(url) {
        var m = /\/stream\/([^/]+)/.exec(url);
        if (!m) return;
        try {
            var base = '/api/lyrics/' + m[1];
            var cache = await caches.open(CHUNKS);
            var first = await fetch(base + '?t=0');
            if (!first.ok) return;
            var data = await first.clone().json();
            await cache.put(base + '?t=0', first);
            // Every language, not just the chosen one — they are a few hundred KB each,
            // and switching language on a plane shouldn't need a signal.
            var tracks = data.tracks || [];
            for (var i = 1; i < tracks.length; i++) {
                var r = await fetch(base + '?t=' + i);
                if (r.ok) await cache.put(base + '?t=' + i, r);
            }
        } catch (e) { /* no lyrics for this track, or offline — not fatal */ }
    }

    /// How far a part-finished download got: {have, count, fraction} or null.
    async function progressOf(url) {
        var m = await readMeta(url);
        if (!m || metaComplete(m)) return null;
        var have = m.have.filter(Boolean).length;
        return { have: have, count: m.count, fraction: have / m.count };
    }

    // --- keeping the bytes ------------------------------------------------------------
    // Cache API storage is evictable by default: under disk pressure — or, on iOS, after
    // a stretch of not opening the app — the browser may bin exactly the audiobook you
    // saved for the trip. Asking for persistent storage is what opts out of that.
    var persisted = null;
    async function ensurePersisted() {
        if (persisted !== null) return persisted;
        try {
            if (navigator.storage && navigator.storage.persisted) {
                persisted = await navigator.storage.persisted();
                if (!persisted && navigator.storage.persist) persisted = await navigator.storage.persist();
            } else persisted = false;
        } catch (e) { persisted = false; }
        return persisted;
    }

    /// Room left on the device: {usage, quota, free, persisted}. Used to warn BEFORE a
    /// long download rather than failing part-way through it.
    async function space() {
        var usage = 0, quota = 0;
        try {
            if (navigator.storage && navigator.storage.estimate) {
                var e = await navigator.storage.estimate();
                usage = e.usage || 0; quota = e.quota || 0;
            }
        } catch (err) { }
        return { usage: usage, quota: quota, free: Math.max(0, quota - usage), persisted: persisted === true };
    }

    /// Drop the per-track claim. The audio itself survives if a saved playlist holds it.
    async function removeTrack(url) {
        var all = loadT();
        delete all[url];
        writeT(all);
        if (!urlsHeldByPlaylists(null).has(url)) await dropAudio(url);
        await cachedSet(true);
    }

    // Delete a URL's bytes however they were stored — one whole entry, or every chunk
    // plus its metadata. Leaving orphaned chunks behind would silently eat hundreds of MB.
    async function dropAudio(url) {
        try { await (await caches.open(CACHE)).delete(url); } catch (e) { }
        await dropChunks(url);
        // The lyrics belong to the track — leaving them behind would slowly accumulate
        // JSON for music that is no longer on the device. Enumerate rather than guess:
        // there is one entry per language (?t=0, ?t=1, …), not a single fixed URL.
        try {
            var m = /\/stream\/([^/]+)/.exec(url);
            if (!m) return;
            var prefix = '/api/lyrics/' + m[1];
            var ck = await caches.open(CHUNKS);
            var keys = await ck.keys();
            for (var i = 0; i < keys.length; i++) {
                if (new URL(keys[i].url).pathname === prefix) await ck.delete(keys[i]);
            }
        } catch (e) { }
    }

    async function dropChunks(url) {
        try {
            var ck = await caches.open(CHUNKS);
            var m = await readMeta(url);
            if (!m) return;
            for (var i = 0; i < m.count; i++) await ck.delete(chunkKey(url, i));
            await ck.delete(metaKey(url));
        } catch (e) { }
    }

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
    var urls = null;      // last completed index
    var reading = null;   // in-flight refresh, shared by concurrent callers
    function key(u) { try { return new URL(u, location.origin).pathname; } catch (e) { return u; } }

    async function cachedSet(force) {
        if (urls && !force) return urls;
        // Build into a LOCAL set and publish only when it's complete: a concurrent
        // unforced caller must never observe a half-built (or empty) index, or it
        // reports everything as "not saved" for as long as the read takes.
        if (!reading) {
            reading = (async function () {
                var next = new Set();
                try {
                    var keys = await (await caches.open(CACHE)).keys();
                    keys.forEach(function (r) { next.add(key(r.url)); });

                    // A chunked file counts as playable only when every piece is here —
                    // a part-finished book must not claim to be available offline.
                    var ck = await caches.open(CHUNKS);
                    var metas = (await ck.keys()).filter(function (r) { return r.url.indexOf('/__chunkmeta__') >= 0; });
                    for (var i = 0; i < metas.length; i++) {
                        var m = await (await ck.match(metas[i])).json().catch(function () { return null; });
                        if (metaComplete(m)) next.add(key(m.url));
                    }
                } catch (e) { /* no Cache API (insecure origin) — nothing is saved */ }
                urls = next;
                reading = null;
                return next;
            })();
        }
        return reading;
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

    // The fuller picture, now that individual tracks can be saved on their own: a
    // playlist with no saved-playlist record can still be wholly or partly on the device.
    //   {state: 'none'|'partial'|'saved'|'stale', saved: n, total: n}
    async function playlistState(id, tracks) {
        var set = await cachedSet();
        var saved = tracks.filter(function (t) { return set.has(key(t.url)); }).length;
        var rec = get(id);
        var st;
        if (rec && !matches(rec, tracks)) st = 'stale';
        else if (saved === 0) st = 'none';
        else if (saved === tracks.length) st = 'saved';
        else st = 'partial';
        return { state: st, saved: saved, total: tracks.length };
    }

    async function download(id, name, tracks, onProgress) {
        await ensurePersisted();
        var have = await cachedSet(true);
        var bytes = 0;
        for (var i = 0; i < tracks.length; i++) {
            // Already on the device (saved on its own, or by another playlist) — don't
            // re-download it. Resuming a part-finished playlist should be cheap.
            if (!have.has(key(tracks[i].url))) {
                try {
                    // Blend within-file progress into the overall bar, so a single long
                    // audiobook doesn't leave the toggle frozen on one number for minutes.
                    bytes += await saveBytes(tracks[i].url, function (f) {
                        if (onProgress) onProgress((i + (f || 0)) / tracks.length);
                    });
                } catch (e) { /* skip a track that fails; the rest still save */ }
            }
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

    // Cache one URL's audio without recording a per-track claim (used by playlist
    // downloads, where the playlist record is the claim). Its lyrics come along too, for
    // the same reason they do on a per-track save.
    async function saveBytes(url, onProgress) {
        var bytes = await saveAudio(url, onProgress);
        await saveLyrics(url);
        return bytes;
    }

    async function remove(id) {
        var all = load(), pl = all[id];
        if (!pl) {
            // No playlist record, but its tracks may still be here from per-track saves.
            await removeTracks((arguments[1] || []).map(function (t) { return t.url; }));
            return;
        }
        var keep = urlsHeldByPlaylists(id);          // audio another saved playlist needs
        var pinned = loadT();                        // …and audio saved on its own
        for (var i = 0; i < pl.tracks.length; i++) {
            var u = pl.tracks[i].url;
            if (!keep.has(u) && !pinned[u]) await dropAudio(u);
        }
        delete all[id];
        write(all);
        await cachedSet(true);
    }

    // Drop several per-track saves at once (used when clearing a playlist that was only
    // ever saved track by track).
    async function removeTracks(urls) {
        var all = loadT();
        var held = urlsHeldByPlaylists(null);
        for (var i = 0; i < urls.length; i++) {
            delete all[urls[i]];
            if (!held.has(urls[i])) await dropAudio(urls[i]);
        }
        writeT(all);
        await cachedSet(true);
    }

    return {
        list: list, get: get, state: state, matches: matches, playlistState: playlistState,
        download: download, remove: remove, renameSaved: renameSaved,
        saveTrack: saveTrack, removeTrack: removeTrack, removeTracks: removeTracks,
        savedTracks: savedTracks, isSavedTrack: isSavedTrack, progressOf: progressOf,
        space: space, ensurePersisted: ensurePersisted,
        saveManifest: saveManifest, manifest: manifest, manifestPlaylist: manifestPlaylist,
        cachedSet: cachedSet, isCached: isCached,
    };
})();
