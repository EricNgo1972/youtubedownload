// Kebab nav toggle. The app's layout (MainLayout) renders statically — page render
// modes don't extend to it — so its menu can't use Blazor @onclick. This drives the
// dropdown with plain DOM instead, which works with no interactive circuit.
window.ytdlNav = {
    toggle: function (e) {
        if (e) e.stopPropagation();
        var nav = document.querySelector('.topbar nav');
        if (!nav) return;
        var open = nav.classList.toggle('open');
        var btn = document.querySelector('.nav-kebab');
        if (btn) btn.textContent = open ? '✕' : '⋮';
    },
    close: function () {
        var nav = document.querySelector('.topbar nav');
        if (nav) nav.classList.remove('open');
        var btn = document.querySelector('.nav-kebab');
        if (btn) btn.textContent = '⋮';
    }
};

// Close the menu when tapping a link inside it, or anywhere outside it.
document.addEventListener('click', function (e) {
    var openNav = document.querySelector('.topbar nav.open');
    if (!openNav) return;
    if (e.target.closest('.topbar nav a')) { ytdlNav.close(); return; }   // link tapped
    if (e.target.closest('.topbar nav') || e.target.closest('.nav-kebab')) return; // inside menu/button
    ytdlNav.close();                                                      // outside tap
});
