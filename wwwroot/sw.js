// Service worker for the offline PWA player (offline.html + offline.js).
//
// Two caches:
//   SHELL  — the offline page and its static assets, pre-cached on install so the
//            app opens with NO network (on a plane).
//   MEDIA  — audio files, filled on demand when the user taps "Save for offline".
//
// The Blazor Server app itself is NOT made offline-capable (its UI needs a live
// SignalR circuit); we only intercept the offline page, its assets, and /stream/…
// audio. Everything else passes straight through to the network.

const VERSION = 'v21';
const SHELL = `ytdl-shell-${VERSION}`;
const MEDIA = 'ytdl-media';           // unversioned: saved audio survives shell upgrades

const SHELL_ASSETS = [
  '/offline.html',
  '/offline.js',
  '/offline-store.js',
  '/player.js',
  '/nav.js',
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
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (isMedia(url)) { event.respondWith(serveMedia(event.request)); return; }
  if (isShell(url)) { event.respondWith(cacheFirst(event.request, SHELL)); return; }
  // Everything else (the live Blazor app) — leave to the network.
});

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

// Serve a saved audio file from the MEDIA cache, honouring Range requests by slicing
// the cached body into a 206 response. iOS Safari REQUIRES 206 for <audio>, and the
// cached entry is a full 200, so we synthesise the partial response ourselves.
async function serveMedia(request) {
  const cache = await caches.open(MEDIA);
  const cached = await cache.match(request.url);
  if (!cached) {
    // Not saved for offline — try the network (works when online), else fail cleanly.
    try { return await fetch(request); }
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
