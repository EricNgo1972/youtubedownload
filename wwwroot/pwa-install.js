// "Install this app" prompt — rendered inline into #pwa-slot (in the main layout):
// installed is how you open your saved playlists from the home screen with no network.
//  - Chrome/Android: captures beforeinstallprompt and offers a native Install button.
//  - iOS Safari: no install API, so it shows the manual Share → Add to Home Screen steps.
// Stays quiet if already installed, previously dismissed, or if no slot exists on the page.
(function () {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
    if (standalone) return;
    if (localStorage.getItem('ytdl.pwa.dismissed') === '1') return;

    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

    function mount(inner) {
        var host = document.getElementById('pwa-slot');
        if (!host) return null;
        var el = document.createElement('div');
        el.className = 'pwa-card';
        el.innerHTML = inner;
        host.appendChild(el);
        // Show it at most once, ever — tapping ✕ just closes it early. This caps the iOS
        // case (where a Safari tab can't tell the app is already installed) at one appearance.
        localStorage.setItem('ytdl.pwa.dismissed', '1');
        el.querySelector('.pwa-x').addEventListener('click', function () { el.remove(); });
        return el;
    }

    // Chrome/Edge/Android: defer the browser's own prompt behind our button.
    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        var el = mount(
            '<span>📲 <b>Install My Music</b> to open your downloads from the home screen, offline.</span>' +
            '<span class="pwa-btns"><button class="pwa-go">Install</button><button class="pwa-x" aria-label="Dismiss">✕</button></span>');
        if (el) el.querySelector('.pwa-go').addEventListener('click', function () { el.remove(); e.prompt(); });
    });

    // iOS: manual instructions (beforeinstallprompt never fires here).
    if (isIOS) {
        window.addEventListener('load', function () {
            mount(
                '<span>📲 <b>Install for offline:</b> tap <b>Share</b>, then <b>Add to Home Screen</b> — then open My Music from your home screen.</span>' +
                '<span class="pwa-btns"><button class="pwa-x" aria-label="Dismiss">✕</button></span>');
        });
    }
})();
