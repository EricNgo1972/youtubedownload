using YoutubeExplode;
using YoutubeDownloader.Components;
using YoutubeDownloader.Services;

var builder = WebApplication.CreateBuilder(args);

// Blazor Server (interactive server components over a SignalR circuit).
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();

// One YouTube client and one history store shared across the app.
builder.Services.AddSingleton<YoutubeClient>();
builder.Services.AddSingleton<HistoryService>();
builder.Services.AddSingleton<PlaylistService>();
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

app.Run();

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

    public static string ContentTypeFor(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".mp4" => "video/mp4",
        ".mp3" => "audio/mpeg",
        ".m4a" => "audio/mp4",
        ".webm" => "video/webm",
        ".srt" => "application/x-subrip",
        _ => "application/octet-stream",
    };
}
