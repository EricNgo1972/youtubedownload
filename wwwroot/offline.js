// Downloads page — lists what's saved on this device and plays it through the shared
// ytdlPlayer (same engine as the online pages). No download UI lives here anymore:
// choosing what to download happens on the Playlists page. This page just plays.

const fmtMb = (b) => (b / 1024 / 1024).toFixed(1) + ' MB';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const artistOf = (t) => (t.author && t.author !== 'Uploaded') ? t.author : '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  const host = document.getElementById('dl-list');
  const list = ytdlOffline.list().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  if (list.length === 0) {
    host.innerHTML = navigator.onLine
      ? '<div class="empty">No downloads yet.<br>Open the <a href="/">Playlists</a> page and tap ⬇ on a playlist to save it here for offline listening.</div>'
      : '<div class="empty">No downloads on this device.<br>Reconnect to wifi and download playlists from the Playlists page.</div>';
    return;
  }
  const curUrl = ytdlPlayer.current();
  const playing = ytdlPlayer.isPlaying();
  host.innerHTML = '';
  for (const pl of list) {
    const card = document.createElement('div');
    card.className = 'opl';
    card.innerHTML = `
      <div class="opl-head">
        <div>
          <div class="opl-name">${esc(pl.name)}</div>
          <div class="opl-meta">${plural(pl.tracks.length, 'track')} · ${fmtMb(pl.bytes || 0)} · <span class="off-ok">✓ offline</span></div>
        </div>
        <button class="icon-btn icon-btn--danger act-remove" title="Remove download" aria-label="Remove download">🗑</button>
      </div>
      <div class="opl-actions">
        <button class="obtn obtn--play act-play">▶ Play all</button>
        <button class="obtn obtn--ghost act-shuffle${ytdlPlayer.isShuffle() ? ' on' : ''}" data-shuffle>🔀 Shuffle</button>
      </div>`;
    const ol = document.createElement('ul');
    ol.className = 'tracks';
    pl.tracks.forEach((t, i) => {
      const on = curUrl && t.url === curUrl;
      const artist = artistOf(t);
      const li = document.createElement('li');
      li.className = 'trk' + (on ? ' playing' : '');
      li.setAttribute('data-track-url', t.url);
      li.innerHTML = `<button class="trk-btn play-glyph">${on && playing ? '⏸' : '▶'}</button>
        <span class="trk-idx">${i + 1}</span>
        <span class="trk-main"><div class="trk-title">${esc(t.title)}</div>
        ${artist ? `<div class="trk-auth">${esc(artist)}</div>` : ''}</span>`;
      li.addEventListener('click', () => ytdlPlayer.tapTracks(pl.tracks, i, pl.name));
      ol.appendChild(li);
    });
    card.appendChild(ol);
    card.querySelector('.act-play').addEventListener('click', () => ytdlPlayer.play(pl.tracks, 0, pl.name));
    card.querySelector('.act-shuffle').addEventListener('click', () => ytdlPlayer.toggleShuffle());
    card.querySelector('.act-remove').addEventListener('click', async () => { await ytdlOffline.remove(pl.id); render(); });
    host.appendChild(card);
  }
}

function setNet(online) {
  const el = document.getElementById('net');
  el.textContent = online ? '● online' : '● offline';
  el.className = 'net ' + (online ? 'online' : 'offline');
  // Playlists/Library are live Blazor pages — unreachable with no signal, so dim them.
  document.body.classList.toggle('offline-mode', !online);
}

window.addEventListener('online', () => { setNet(true); render(); });
window.addEventListener('offline', () => { setNet(false); render(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

setNet(navigator.onLine);
render();
