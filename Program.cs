using YoutubeExplode;
using YoutubeDownloader.Components;
using YoutubeDownloader.Models;
using YoutubeDownloader.Services;

var builder = WebApplication.CreateBuilder(args);

// Blazor Server (interactive server components over a SignalR circuit).
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents()
    .AddCircuitOptions(o =>
    {
        // Keep a disconnected circuit's state around longer so a phone that briefly
        // drops (backgrounded tab, screen lock, wifi<->cellular) resumes without
        // losing UI state instead of forcing a reload.
        o.DisconnectedCircuitRetentionPeriod = TimeSpan.FromMinutes(5);
        o.DisconnectedCircuitMaxRetained = 200;
    })
    .AddHubOptions(o =>
    {
        // More tolerance for laggy mobile networks before the server gives up on
        // the connection. Client pings every KeepAliveInterval; the server drops
        // the circuit only after ClientTimeoutInterval of silence.
        o.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
        o.KeepAliveInterval = TimeSpan.FromSeconds(15);
        o.HandshakeTimeout = TimeSpan.FromSeconds(30);
    });

// One YouTube client and one history store shared across the app.
builder.Services.AddSingleton<YoutubeClient>();
builder.Services.AddSingleton<HistoryService>();
builder.Services.AddSingleton<PlaylistService>();
builder.Services.AddSingleton<UploadService>();
builder.Services.AddSingleton<YoutubeDownloadService>();

// The download queue: one instance is both the queue API and the hosted worker.
builder.Services.AddSingleton<DownloadJobService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<DownloadJobService>());

var app = builder.Build();

app.UseStaticFiles();
app.UseAntiforgery();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

// Liveness endpoints for the fleet health checks + the release workflow's verify step.
app.MapGet("/health", () => Results.Text("OK"));
app.MapGet("/api/health", () => Results.Json(new { status = "ok", service = "youtubedownloader" }));

// Serve a downloaded file by history id + index. Referencing files by record id
// — rather than an arbitrary path — avoids path traversal.
//   /files/…  -> attachment (browser saves it)
//   /stream/… -> inline     (browser plays it in an <audio>/<video> element)
// Both enable range processing so the transfer is resumable and iOS Safari,
// which requires HTTP 206 support, can play/seek the media.
app.MapGet("/files/{id}/{index:int}",
    (string id, int index, HistoryService history) => Media.Serve(history, id, index, asDownload: true));

app.MapGet("/stream/{id}/{index:int}",
    (string id, int index, HistoryService history) => Media.Serve(history, id, index, asDownload: false));

// Playlist manifest consumed by the offline PWA player (wwwroot/offline.html). Returns
// every playlist with its playable tracks resolved to a stream URL, so the offline page
// knows what to cache and how to render the queue without needing a Blazor circuit.
app.MapGet("/api/playlists", (PlaylistService playlists, HistoryService history) =>
{
    var result = playlists.All().Select(pl => new
    {
        id = pl.Id,
        name = pl.Name,
        tracks = pl.RecordIds
            .Select(rid => (rid, rec: history.Get(rid)))
            .Where(x => x.rec is not null)
            .Select(x => (x.rid, rec: x.rec!, idx: Media.FirstAudioIndex(x.rec!)))
            .Where(x => x.idx >= 0)
            .Select(x => new
            {
                url = $"/stream/{x.rid}/{x.idx}",
                title = x.rec.Title,
                author = x.rec.Author,
                duration = x.rec.Duration,
            })
            .ToList(),
    });
    return Results.Json(result);
});

// A shareable "listen" page for a single track: a self-contained player anyone can open
// (no app or account needed) at /listen/{id}. The record id is an unguessable GUID, so
// the link is effectively unlisted — anyone who has it can listen.
app.MapGet("/listen/{id}", (string id, HistoryService history, HttpRequest req) =>
{
    var rec = history.Get(id);
    var idx = rec is null ? -1 : Media.FirstAudioIndex(rec);
    if (rec is null || idx < 0)
        return Results.Content(ListenPage.NotFound(), "text/html; charset=utf-8");
    var baseUrl = $"{req.Scheme}://{req.Host}";
    return Results.Content(ListenPage.Html(rec, idx, baseUrl), "text/html; charset=utf-8");
});

app.Run();

internal static class ListenPage
{
    public static string Html(DownloadRecord rec, int idx, string baseUrl)
    {
        var title = System.Net.WebUtility.HtmlEncode(rec.Title);
        var rawAuthor = rec.Author is { Length: > 0 } a && a != "Uploaded" ? rec.Author : "";
        var author = System.Net.WebUtility.HtmlEncode(rawAuthor);
        var stream = $"/stream/{rec.Id}/{idx}";
        var absStream = baseUrl + stream;
        var absListen = $"{baseUrl}/listen/{rec.Id}";
        var authorHtml = author.Length > 0 ? $"<div class=\"auth\">{author}</div>" : "";
        var ogDesc = (author.Length > 0 ? author + " · " : "") + "Shared via My Music";

        return $$"""
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1220">
<title>{{title}}</title>
<meta property="og:type" content="music.song">
<meta property="og:title" content="{{title}}">
<meta property="og:description" content="{{ogDesc}}">
<meta property="og:audio" content="{{absStream}}">
<meta property="og:url" content="{{absListen}}">
<link rel="icon" href="/icon.svg">
<style>
  :root{--bg:#0f1220;--panel:#1a1e33;--text:#e7e9f3;--muted:#9aa0bd;--border:#2c3252;--ok:#34d399}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:var(--bg);color:var(--text);padding:24px;
       font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{width:100%;max-width:440px;background:var(--panel);border:1px solid var(--border);
        border-radius:20px;padding:28px 24px;text-align:center}
  .ico{font-size:44px;margin-bottom:10px}
  h1{font-size:1.3rem;margin:0 0 6px;line-height:1.3;word-break:break-word}
  .auth{color:var(--muted);font-size:.95rem;margin-bottom:20px}
  audio{width:100%}
  .foot{margin-top:20px;font-size:.8rem;color:var(--muted)}
  .foot a{color:var(--ok);text-decoration:none}
</style>
</head>
<body>
  <div class="card">
    <div class="ico">🎵</div>
    <h1>{{title}}</h1>
    {{authorHtml}}
    <audio controls autoplay preload="metadata" src="{{stream}}"></audio>
    <div class="foot">Shared via <a href="/">My Music</a></div>
  </div>
</body>
</html>
""";
    }

    public static string NotFound() => """
<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Track unavailable</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;
padding:24px;background:#0f1220;color:#9aa0bd;font-family:system-ui,sans-serif}h1{color:#e7e9f3;margin:0 0 8px}</style>
</head><body><div><h1>Track unavailable</h1><p>This shared track no longer exists.</p></div></body></html>
""";
}

internal static class Media
{
    public static IResult Serve(HistoryService history, string id, int index, bool asDownload)
    {
        var record = history.Get(id);
        if (record is null || index < 0 || index >= record.Files.Count)
            return Results.NotFound();

        var path = record.Files[index];
        if (!File.Exists(path))
            return Results.NotFound();

        var contentType = ContentTypeFor(path);
        return asDownload
            ? Results.File(path, contentType, Path.GetFileName(path), enableRangeProcessing: true)
            : Results.File(path, contentType, enableRangeProcessing: true);
    }

    private static readonly string[] AudioExts =
        { ".mp3", ".m4a", ".webm", ".wav", ".ogg", ".oga", ".aac", ".flac" };

    /// <summary>Index of the first playable audio file in a record, or -1.</summary>
    public static int FirstAudioIndex(DownloadRecord r)
    {
        for (var i = 0; i < r.Files.Count; i++)
            if (AudioExts.Contains(Path.GetExtension(r.Files[i]).ToLowerInvariant()))
                return i;
        return -1;
    }

    public static string ContentTypeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".mp4" => "video/mp4",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".webm" => "video/webm",
        ".wav" => "audio/wav",
        ".ogg" or ".oga" => "audio/ogg",
        ".aac" => "audio/aac",
        ".flac" => "audio/flac",
        ".srt" => "application/x-subrip",
        _ => "application/octet-stream",
    };
}
