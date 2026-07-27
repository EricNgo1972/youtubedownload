// Service worker: makes the Playlists page — the app's ONE surface — work offline.
//
// There is no separate "Downloads" page any more. Playlists is a Blazor Server page,
// so it normally needs a live SignalR circuit; we make it survive without one by
// caching its PRERENDERED HTML. That HTML already contains everything needed to
// listen: the track lists, and play/expand controls wired to plain JS rather than
// @onclick. Offline you get the last-seen playlists and can play whatever is saved;
// only the editing controls (which genuinely need the server) go quiet.
//
// Four caches:
//   SHELL  — static assets, pre-cached on install.
//   PAGE   — the app's prerendered HTML, refreshed on every successful online visit.
//   MEDIA  — audio files, filled on demand when a playlist is saved for offline.
//   API    — the last good /api/playlists manifest.
//
// Every network read here is time-boxed. A "connected but one bar" link is worse than
// no link: plain fetch() has no timeout, so without deadlines the app sits waiting on
// requests the network will never answer.

// The build token this worker was registered with (/sw.js?v=abc123). Appending it to the
// precache URLs defeats any CDN in front of the app: the edge has never seen these exact
// URLs for a new build, so it cannot hand back a previous deploy's files.
const BUILD = new URL(self.location.href).searchParams.get('v') || '';
const versioned = (u) => (BUILD ? u + '?v=' + BUILD : u);

// The shell cache is named after the BUILD, not a hand-maintained constant, so every
// deploy gets a clean one and activate() bins the previous.
//
// This has to be per-build. Precached entries carry ?v=<build> while cacheFirst() looks
// them up with ignoreSearch:true — so a cache reused across builds ends up holding both
// /player.js?v=old and /player.js?v=new, and Cache.match returns the FIRST, i.e. the old
// one. An installed PWA would then keep running the previous deploy's JavaScript with no
// way for the user to break out short of deleting and re-adding the app. VERSION remains
// only as the fallback for a worker somehow loaded without a token.
const VERSION = 'v42';
const SHELL = `ytdl-shell-${BUILD || VERSION}`;
const PAGE = 'ytdl-page';             // unversioned: last-good HTML survives shell upgrades
const MEDIA = 'ytdl-media';           // unversioned: saved audio survives shell upgrades
const CHUNKS = 'ytdl-chunks';         // pieces of large files, plus their metadata
const API = 'ytdl-api';               // unversioned for the same reason

const API_PATH = '/api/playlists';
const HOME = '/';
const BLAZOR_JS = '/_framework/blazor.web.js';
const API_MS = 2500;                  // manifest: fall back to the cached copy fast
const MEDIA_MS = 15000;               // uncached audio: allow a slow start, not a hang
const NAV_MS = 6000;                  // page load: fall back to the cached page
const JS_MS = 4000;                   // blazor.web.js: see serveBlazor()

const SHELL_ASSETS = [
  '/offline.html',
  '/offline-store.js',
  '/ui.js',
  '/player.js',
  '/playlist-offline.js',
  '/share.js',
  '/reconnect.js',
  '/pwa-install.js',
  '/app.css',
  '/fonts.css',
  '/icon.svg',
  '/manifest.webmanifest',
  // Self-hosted faces. Precached with the shell so type renders identically offline
  // rather than falling back to a system font mid-trip.
  '/fonts/space-grotesk-500-latin.woff2',
  '/fonts/space-grotesk-500-latin-ext.woff2',
  '/fonts/space-grotesk-500-vietnamese.woff2',
  '/fonts/space-grotesk-700-latin.woff2',
  '/fonts/space-grotesk-700-latin-ext.woff2',
  '/fonts/space-grotesk-700-vietnamese.woff2',
  '/fonts/ibm-plex-sans-400-latin.woff2',
  '/fonts/ibm-plex-sans-400-latin-ext.woff2',
  '/fonts/ibm-plex-sans-400-vietnamese.woff2',
  '/fonts/ibm-plex-sans-500-latin.woff2',
  '/fonts/ibm-plex-sans-500-latin-ext.woff2',
  '/fonts/ibm-plex-sans-500-vietnamese.woff2',
  '/fonts/ibm-plex-sans-600-latin.woff2',
  '/fonts/ibm-plex-sans-600-latin-ext.woff2',
  '/fonts/ibm-plex-sans-600-vietnamese.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // cache:'reload' is essential, not a nicety. A plain addAll() is allowed to satisfy
      // itself from the browser's HTTP cache, so a new build would fill its brand-new
      // shell cache with STALE files — the app would look updated while still running old
      // code, and no amount of restarting would fix it. This forces the network.
      .then((c) => c.addAll(SHELL_ASSETS.map((u) => new Request(versioned(u), { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('ytdl-shell-') && k !== SHELL).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isMedia = (url) => url.pathname.startsWith('/stream/');
const isShell = (url) =>
  SHELL_ASSETS.some((a) => url.pathname === a) || url.pathname === '/offline';

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (isMedia(url)) { event.respondWith(serveMedia(request)); return; }
  if (url.pathname.startsWith('/preview/')) { event.respondWith(servePreview(request)); return; }
  if (isShell(url)) { event.respondWith(cacheFirst(request, SHELL)); return; }
  if (url.pathname === API_PATH) { event.respondWith(serveApi(request)); return; }
  // Lyrics are immutable for a given track, so cache-first: instant, and available with
  // no signal once the track has been saved.
  if (url.pathname.startsWith('/api/lyrics/')) { event.respondWith(cacheFirst(request, CHUNKS, false)); return; }
  if (url.pathname === BLAZOR_JS) { event.respondWith(serveBlazor(request)); return; }
  if (request.mode === 'navigate') { event.respondWith(serveNavigation(request)); return; }
  // Everything else (the live Blazor circuit) — leave to the network.
});

// fetch() with a hard deadline. The request is aborted, not merely ignored, so a dead
// connection stops occupying the (very small) mobile connection pool.
function fetchWithin(request, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(request, { signal: ctl.signal }).finally(() => clearTimeout(timer));
}

// ignoreSearch defaults to true for shell assets, whose ?v= build token must not create
// a cache miss. It MUST be false where the query selects content — lyrics use ?t= to pick
// a language, and ignoring it would hand back whichever track was fetched first.
async function cacheFirst(request, cacheName, ignoreSearch = true) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch });
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    return hit || new Response('Offline', { status: 504 });
  }
}

// Playlist manifest: fresh when the network is quick (it must reflect server-side
// edits), the last good copy the moment it isn't. A 504 rather than an empty list on
// total failure, so callers can tell "no playlists" from "couldn't ask".
async function serveApi(request) {
  const cache = await caches.open(API);
  try {
    const res = await fetchWithin(request, API_MS);
    if (res.ok) { cache.put(API_PATH, res.clone()); return res; }
    throw new Error(`status ${res.status}`);
  } catch (e) {
    return (await cache.match(API_PATH)) || new Response('offline', { status: 504 });
  }
}

// The app's own pages. Online (or nearly so) the live page always wins and is stashed
// as the new fallback; past NAV_MS we serve the last prerendered copy, which is enough
// to browse playlists and play anything saved on the device.
async function serveNavigation(request) {
  const url = new URL(request.url);
  const cacheKey = url.pathname === '/playlists' ? HOME : url.pathname;   // same page, two routes
  const cache = await caches.open(PAGE);
  try {
    const res = await fetchWithin(request, NAV_MS);
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(cacheKey))
        || (await cache.match(HOME))                    // any page beats none
        || new Response(OFFLINE_HTML, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

// blazor.web.js decides whether the page gets a circuit. It is a PARSER-BLOCKING script
// at the end of <body>, so if the request hangs, DOMContentLoaded never fires and the
// plain-JS player never boots — the page would look loaded but be completely dead.
// Time-box it, then fall back to cache, then to an empty script so parsing continues
// immediately: no circuit, but a fully working offline player.
async function serveBlazor(request) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetchWithin(request, JS_MS);
    if (res.ok) cache.put(BLAZOR_JS, res.clone());
    return res;
  } catch (e) {
    return (await cache.match(BLAZOR_JS))
        || new Response('/* offline: no Blazor circuit */', {
             status: 200, headers: { 'Content-Type': 'text/javascript' },
           });
  }
}

// A track that is only a link, relayed from YouTube by the server. NEVER cached — there
// is nothing durable here, and caching a signed upstream URL would be caching something
// already expiring. Still time-boxed, so with no signal it fails fast and the player can
// skip to a track that IS on the device, rather than hanging on a dead request.
//
// The deadline covers reaching the server, not the listening: fetch() settles when the
// response headers arrive, which clears the timer and lets the body stream on freely.
async function servePreview(request) {
  try { return await fetchWithin(request, MEDIA_MS); }
  catch (e) { return new Response('This track is a link — it needs a connection', { status: 504 }); }
}

// --- chunked media ----------------------------------------------------------------
// A several-hundred-MB audiobook is stored as ~8 MB pieces so its download can survive a
// dropped connection (see offline-store.js). Playback must not know or care: we answer
// each range request by slicing only the pieces it actually overlaps. Blob.slice() and
// multi-part Blob construction are both lazy, so a 64 KB seek reads 64 KB — never the
// whole book. Key shapes are duplicated from offline-store.js because a service worker
// cannot import the page's modules.
//
// Keyed by PATHNAME, not by the URL as given. The page saves relative track URLs
// ("/stream/id/0") while a fetch handler only ever sees the absolute request URL, so
// keying on the raw string had the two sides writing and reading different keys — every
// chunked file downloaded fine, reported itself as saved, and then fell through to the
// network at playback. Audiobooks are the only files big enough to be chunked, which is
// why songs were unaffected.
const idOf = (u) => { try { return new URL(u, self.location.origin).pathname; } catch (e) { return u; } };
const chunkKey = (url, i) => `/__chunk__?u=${encodeURIComponent(idOf(url))}&i=${i}`;
const metaKey = (url) => `/__chunkmeta__?u=${encodeURIComponent(idOf(url))}`;

// The most we will assemble for a single response. iOS asks for "bytes=0-" as its second
// request, i.e. the entire remaining file; answering that literally would stitch every
// piece of a 200 MB book together for one read. A 206 is allowed to return less than was
// asked for — the media element simply requests the next window — so this keeps each
// response to at most two pieces no matter how big the file is.
const MAX_SPAN = 8 * 1048576;

async function serveFromChunks(request) {
  let cache, meta;
  try {
    cache = await caches.open(CHUNKS);
    const metaRes = await cache.match(metaKey(request.url));
    if (!metaRes) return null;
    meta = await metaRes.json();
  } catch (e) { return null; }
  if (!meta || !meta.have || !meta.have.every(Boolean)) return null;   // still downloading

  const size = meta.size, cs = meta.chunkSize;
  const range = request.headers.get('range');
  let start = 0, end = size - 1;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    start = m ? Number(m[1]) : 0;
    end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  if (range) end = Math.min(end, start + MAX_SPAN - 1);

  const parts = [];
  for (let i = Math.floor(start / cs); i <= Math.floor(end / cs); i++) {
    const r = await cache.match(chunkKey(meta.url, i));
    if (!r) return null;                       // a piece went missing — let the caller retry
    const b = await r.blob();
    const base = i * cs;
    const from = Math.max(0, start - base);
    const to = Math.min(b.size, end - base + 1);
    parts.push(from === 0 && to === b.size ? b : b.slice(from, to));
  }
  const body = parts.length === 1 ? parts[0] : new Blob(parts, { type: meta.type });

  if (!range) {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': meta.type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(body.size),
      'Content-Type': meta.type,
    },
  });
}

// Last resort: never seen a page on this device, and no network to fetch one.
const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>My Music — offline</title>
<link rel="stylesheet" href="/app.css"></head><body><div class="page">
<header class="topbar"><span class="brand">🎵 My Music</span></header>
<main><div class="card hint">You're offline and this device hasn't loaded your playlists yet.
Connect once and they'll be available here from then on.</div></main></div></body></html>`;

// Serve a saved audio file from the MEDIA cache, honouring Range requests by slicing
// the cached body into a 206 response. iOS Safari REQUIRES 206 for <audio>, and the
// cached entry is a full 200, so we synthesise the partial response ourselves.
async function serveMedia(request) {
  const cache = await caches.open(MEDIA);
  const cached = await cache.match(request.url);
  if (!cached) {
    // Large files are stored in pieces so their download can resume; reassemble them
    // here, transparently to <audio>.
    const chunked = await serveFromChunks(request);
    if (chunked) return chunked;

    // Not saved for offline — try the network (works when online), else fail cleanly.
    // Bounded: <audio> gives no feedback while a request hangs, so a stuck stream must
    // become a real error the player can report and skip past.
    try { return await fetchWithin(request, MEDIA_MS); }
    catch (e) { return new Response('Not available offline', { status: 504 }); }
  }

  const range = request.headers.get('range');
  if (!range) return cached;

  // Slice via Blob, NOT arrayBuffer(). arrayBuffer() would pull the whole file into
  // memory on every single range request — and a seek in a several-hundred-MB audiobook
  // fires a lot of them, which is enough to kill the worker. Blob.slice() is lazy: it
  // references the stored bytes and streams them from disk.
  const blob = await cached.blob();
  const size = blob.size;
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  const chunk = blob.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunk.size),
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
    },
  });
}
