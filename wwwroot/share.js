// "Share" a track: builds a public /listen/{id} link and hands it to the OS share sheet
// (mobile) or copies it to the clipboard (desktop). Reads id/title from the button's
// data-attributes so titles with quotes don't break an inline onclick string.
window.ytdlShare = async function (el) {
    var id = el.getAttribute('data-share-id');
    var title = el.getAttribute('data-share-title') || 'Listen';
    var url = location.origin + '/listen/' + id;

    if (navigator.share) {
        try { await navigator.share({ title: title, url: url }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; /* else fall through to copy */ }
    }
    try { await navigator.clipboard.writeText(url); ytdlToast('🔗 Link copied'); }
    catch (e) { window.prompt('Copy this link to share:', url); }
};

function ytdlToast(msg) {
    var t = document.createElement('div');
    t.className = 'ytdl-toast';
    t.textContent = msg;
    // Inside the phone column: the toast is absolutely positioned against it.
    (document.querySelector('.app') || document.body).appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
        t.classList.remove('show');
        setTimeout(function () { t.remove(); }, 300);
    }, 1800);
}
