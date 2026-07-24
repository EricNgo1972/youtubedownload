// Blazor Server keeps a live WebSocket "circuit". Mobile browsers drop it when the
// tab is backgrounded, the screen locks, or the network switches — by default that
// strands the user on a reconnect/reload overlay that needs a manual tap.
//
// We DON'T override Blazor startup (that would risk breaking interactivity); we just
// add self-healing on top of the default reconnect UI:
//   * auto-reload once reconnection has permanently failed (no manual tap), and
//   * reload immediately when the tab returns to the foreground while disconnected
//     (the key mobile fix — unlock the phone and it's usable again at once).
(function () {
    function modal() { return document.getElementById('components-reconnect-modal'); }

    function failed() {
        var m = modal();
        return !!m && (m.classList.contains('components-reconnect-failed') ||
                       m.classList.contains('components-reconnect-rejected'));
    }

    function down() {
        var m = modal();
        return !!m && (m.classList.contains('components-reconnect-show') || failed());
    }

    var m = modal();
    if (m) {
        new MutationObserver(function () {
            if (failed()) setTimeout(function () { location.reload(); }, 500);
        }).observe(m, { attributes: true, attributeFilter: ['class'] });
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && down()) {
            location.reload();
        }
    });
})();
