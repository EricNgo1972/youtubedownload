// Custom play/pause buttons for the History page, "resume where you left off",
// and continuous playback (auto-advance to the next track, like an album/queue).
//
// Playback is native (keeps going when the iPhone screen locks) and streams
// straight from /stream. Each track's position is saved in localStorage under a
// key derived from its stable history id, so closing the tab / restarting the
// browser (or server) and pressing Play again resumes from the saved spot.
window.ytdlPlayer = {
    toggle: function (audioId) {
        var el = document.getElementById(audioId);
        if (!el) return;
        if (el.paused) {
            el.play();          // 'play' listener pauses any other track
        } else {
            el.pause();
        }
    },
    // "Play all": start the first track on the page; 'ended' auto-advances the rest.
    playFirst: function () {
        var a = document.querySelector('audio');
        if (a) a.play();
    }
};

function ytdlPosKey(id) { return 'ytdl-pos-' + id; }

// All <audio> elements on the page, in list (DOM) order — this is the play queue.
function ytdlQueue() { return Array.prototype.slice.call(document.querySelectorAll('audio')); }

// Play the track `delta` positions from `el` (e.g. +1 = next, -1 = previous).
function ytdlPlayRelative(el, delta) {
    var q = ytdlQueue();
    var i = q.indexOf(el);
    if (i < 0) return;
    var j = i + delta;
    if (j >= 0 && j < q.length) {
        q[j].scrollIntoView({ block: 'nearest' });
        q[j].play();
    }
}

function ytdlUpdateButton(el, playing) {
    if (!el || el.tagName !== 'AUDIO') return;
    var btn = document.querySelector('[data-audio="' + el.id + '"]');
    if (btn) btn.textContent = playing ? '⏸ Pause' : '▶ Play';
}

// 'play'/'pause'/'ended'/'loadedmetadata'/'timeupdate' don't bubble -> capture phase.

document.addEventListener('play', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'AUDIO') return;

    // Only one track at a time.
    document.querySelectorAll('audio').forEach(function (other) {
        if (other !== el) other.pause();
    });

    // Lock-screen "Now Playing" info + controls (iOS/Android), including next/prev
    // so the queue can be driven from the lock screen.
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: el.dataset.title || document.title,
            artist: el.dataset.artist || '',
            album: 'YouTube Downloader'
        });
        navigator.mediaSession.setActionHandler('play', function () { el.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { el.pause(); });
        navigator.mediaSession.setActionHandler('nexttrack', function () { ytdlPlayRelative(el, 1); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { ytdlPlayRelative(el, -1); });
    }

    ytdlUpdateButton(el, true);
}, true);

document.addEventListener('pause', function (e) { ytdlUpdateButton(e.target, false); }, true);

// Resume: once the media is ready, jump to the saved position (if any).
document.addEventListener('loadedmetadata', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'AUDIO') return;
    var saved = parseFloat(localStorage.getItem(ytdlPosKey(el.id)) || '0');
    if (saved > 0 && isFinite(el.duration) && saved < el.duration - 1) {
        try { el.currentTime = saved; } catch (_) { /* seek not ready yet */ }
    }
}, true);

// Persist the position roughly every 5s while playing.
document.addEventListener('timeupdate', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'AUDIO') return;
    var now = Date.now();
    if (!el._ytdlLastSave || now - el._ytdlLastSave > 5000) {
        el._ytdlLastSave = now;
        if (el.currentTime > 0) localStorage.setItem(ytdlPosKey(el.id), String(el.currentTime));
    }
}, true);

// Finished -> forget this track's position, then auto-advance to the next one.
document.addEventListener('ended', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'AUDIO') return;
    localStorage.removeItem(ytdlPosKey(el.id));
    ytdlUpdateButton(el, false);
    ytdlPlayRelative(el, 1);   // continuous playback: play the next file in the list
}, true);
