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

const VERSION = 'v25';
const SHELL = `ytdl-shell-${VERSION}`;
const PAGE = 'ytdl-page';             // unversioned: last-good HTML survives shell upgrades
const MEDIA = 'ytdl-media';           // unversioned: saved audio survives shell upgrades
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
  '/player.js',
  '/playlist-offline.js',
  '/share.js',
  '/nav.js',
  '/reconnect.js',
  '/pwa-install.js',
  '/app.css',
  '/icon.svg',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
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
  if (isShell(url)) { event.respondWith(cacheFirst(request, SHELL)); return; }
  if (url.pathname === API_PATH) { event.respondWith(serveApi(request)); return; }
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

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
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
    // Not saved for offline — try the network (works when online), else fail cleanly.
    // Bounded: <audio> gives no feedback while a request hangs, so a stuck stream must
    // become a real error the player can report and skip past.
    try { return await fetchWithin(request, MEDIA_MS); }
    catch (e) { return new Response('Not available offline', { status: 504 }); }
  }

  const range = request.headers.get('range');
  if (!range) return cached;

  const buf = await cached.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    });
  }
  const chunk = buf.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(chunk.byteLength),
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
    },
  });
}
