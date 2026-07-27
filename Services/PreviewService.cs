using System.Collections.Concurrent;
using YoutubeExplode;
using YoutubeExplode.Videos.Streams;

namespace YoutubeDownloader.Services;

/// <summary>
/// Resolves a YouTube video to a directly-fetchable audio URL, so a track that is only a
/// LINK in the library can still be listened to — the server relays the audio instead of
/// downloading and keeping it.
///
/// Two things make this more than a one-liner:
///  * Format. YouTube's best audio-only stream is normally WebM/Opus, which iOS Safari
///    cannot play. Preferring the mp4/AAC variant is what makes previews work on the
///    phone rather than only on a desktop browser.
///  * Expiry. These URLs are signed and time-limited, so the resolved URL is cached only
///    briefly and re-resolved when the CDN rejects it (see PreviewProxy).
/// </summary>
public class PreviewService
{
    private readonly YoutubeClient _youtube;
    private readonly ILogger<PreviewService> _logger;
    private readonly ConcurrentDictionary<string, Resolved> _cache = new();

    // Well inside YouTube's signed-URL lifetime. Re-resolving costs one API call, while
    // serving an expired URL costs a failed playback — so this errs short.
    private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(45);

    public PreviewService(YoutubeClient youtube, ILogger<PreviewService> logger)
    {
        _youtube = youtube;
        _logger = logger;
    }

    public record Resolved(string Url, string ContentType, DateTimeOffset ExpiresAt);

    /// <summary>
    /// The current audio URL for a video, or null if it has no playable audio stream.
    /// <paramref name="refresh"/> forces a re-resolve, used when the CDN rejects a URL we
    /// had cached.
    /// </summary>
    public async Task<Resolved?> ResolveAsync(string videoId, bool refresh, CancellationToken ct)
    {
        if (!refresh && _cache.TryGetValue(videoId, out var hit) && hit.ExpiresAt > DateTimeOffset.UtcNow)
            return hit;

        StreamManifest manifest;
        try
        {
            manifest = await _youtube.Videos.Streams.GetManifestAsync(videoId, ct);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not resolve preview streams for {VideoId}", videoId);
            return null;
        }

        var audio = manifest.GetAudioOnlyStreams().ToList();
        if (audio.Count == 0) return null;

        // mp4/AAC first — the only audio-only container iOS Safari will play. Falling back
        // to the overall best is deliberate: on a desktop it still works, and a preview
        // that plays somewhere beats one that plays nowhere.
        var pick = audio.Where(s => s.Container == Container.Mp4)
                        .OrderByDescending(s => s.Bitrate)
                        .FirstOrDefault()
                   ?? audio.OrderByDescending(s => s.Bitrate).First();

        var resolved = new Resolved(
            pick.Url,
            pick.Container == Container.Mp4 ? "audio/mp4" : $"audio/{pick.Container.Name}",
            DateTimeOffset.UtcNow.Add(Ttl));

        _cache[videoId] = resolved;
        return resolved;
    }
}
