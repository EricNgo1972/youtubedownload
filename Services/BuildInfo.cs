using System.Reflection;

namespace YoutubeDownloader.Services;

/// <summary>
/// When this build was produced. Surfaced in the UI and /api/health so "am I running the
/// new code?" is answerable at a glance — a PWA caches aggressively, so the server build
/// and what a phone is actually executing can silently drift apart.
/// </summary>
public static class BuildInfo
{
    /// <summary>Human-readable build time, shown in the UI and /api/health.</summary>
    public static string Stamp { get; } = Written()?.ToString("yyyy-MM-dd HH:mm") ?? "unknown";

    /// <summary>
    /// Short token appended to every static asset URL (<c>player.js?v=…</c>).
    ///
    /// This is what makes a deploy survive a CDN. An edge cache in front of the app keys
    /// on the full URL, so a new build asks for URLs it has never seen and cannot be
    /// served a stale copy — no purge, no waiting out a TTL, no phones stuck on old code.
    /// </summary>
    public static string Version { get; } =
        (Written()?.ToUnixTimeSeconds() ?? 0).ToString("x");

    private static DateTimeOffset? Written()
    {
        try
        {
            var path = Assembly.GetExecutingAssembly().Location;
            if (path.Length > 0 && File.Exists(path)) return File.GetLastWriteTime(path);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return null;
    }
}
