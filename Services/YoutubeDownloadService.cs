using YoutubeExplode;
using YoutubeExplode.Common;
using YoutubeExplode.Converter;
using YoutubeExplode.Playlists;
using YoutubeExplode.Videos;
using YoutubeExplode.Videos.Streams;
using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>
/// Downloads a single YouTube video as any combination of MP4 (video),
/// MP3 (audio) and SRT subtitle tracks, reporting progress as it goes.
/// Refactored from the original console app.
/// </summary>
public class YoutubeDownloadService
{
    private readonly YoutubeClient _youtube;
    private readonly HistoryService _history;
    private readonly IConfiguration _config;

    public YoutubeDownloadService(YoutubeClient youtube, HistoryService history, IConfiguration config)
    {
        _youtube = youtube;
        _history = history;
        _config = config;
    }

    /// <summary>Parses a URL to a video id, or null if it isn't a single-video URL.</summary>
    public static string? TryGetVideoId(string? url) =>
        VideoId.TryParse(url) is { } id ? id.Value : null;

    /// <summary>True if the URL contains a playlist id (so "whole playlist" is offered).</summary>
    public static bool HasPlaylist(string? url) => PlaylistId.TryParse(url) is not null;

    /// <summary>
    /// Resolves a URL into the concrete list of videos to download — one entry for a
    /// single video, every entry for a playlist — WITHOUT downloading anything. Lets
    /// the caller show the full item list up front, then download them one by one.
    /// </summary>
    public async Task<DownloadPlan> ResolveAsync(string url, DownloadOptions opts, CancellationToken ct)
    {
        if (!opts.Mp4 && !opts.Mp3 && !opts.Subtitles)
            throw new InvalidOperationException("Pick at least one of MP4, MP3 or subtitles.");

        if (opts.Playlist)
        {
            if (PlaylistId.TryParse(url) is not { } playlistId)
                throw new InvalidOperationException("That URL doesn't contain a playlist.");

            var playlist = await RetryAsync(async () => await _youtube.Playlists.GetAsync(playlistId), ct);
            var videos = await RetryAsync(
                async () => await _youtube.Playlists.GetVideosAsync(playlistId).CollectAsync(), ct);

            // Each playlist gets its own sub-folder.
            var playlistDir = Path.Combine(AppPaths.DownloadsDir(_config), Sanitize(playlist.Title));
            var items = videos.Select(v => new PlannedVideo(v.Id.Value, v.Title)).ToList();
            return new DownloadPlan(playlist.Title, playlistDir, items);
        }

        if (VideoId.TryParse(url) is not { } videoId)
            throw new InvalidOperationException("That doesn't look like a YouTube video URL.");

        // Single video: title fills in once the download resolves its metadata.
        return new DownloadPlan("", AppPaths.DownloadsDir(_config),
            new List<PlannedVideo> { new(videoId.Value, "") });
    }

    /// <summary>Downloads one already-resolved video into <paramref name="outputDir"/>,
    /// reporting stage/percent for that single item. Adds a history record and returns it.</summary>
    public Task<DownloadRecord> DownloadSingleAsync(
        string videoId, DownloadOptions opts, string outputDir,
        IProgress<DownloadProgress> progress, CancellationToken ct) =>
        DownloadOneAsync(videoId, opts, outputDir, "", progress, ct);

    /// <summary>Downloads one video into <paramref name="outputDir"/>; <paramref name="label"/>
    /// prefixes progress stages (e.g. "[3/12] ") when part of a playlist.</summary>
    private async Task<DownloadRecord> DownloadOneAsync(
        VideoId videoId, DownloadOptions opts, string outputDir, string label,
        IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        progress.Report(new($"{label}Fetching video info", 0));
        // YouTube occasionally returns a transient failure (throttling / a bad
        // response) that surfaces as VideoUnavailableException even for a perfectly
        // available video — so retry the metadata + manifest calls with backoff.
        var video = await WithRetryAsync(
            () => _youtube.Videos.GetAsync(videoId, ct).AsTask(),
            $"{label}Fetching video info", progress, ct);

        Directory.CreateDirectory(outputDir);
        var baseName = Path.Combine(outputDir, Sanitize(video.Title));

        var record = new DownloadRecord
        {
            VideoId = video.Id.Value,
            Title = video.Title,
            Author = video.Author.ChannelTitle,
            Url = $"https://youtu.be/{video.Id}",
            Duration = video.Duration?.ToString(@"hh\:mm\:ss") ?? "",
            DownloadedAt = DateTimeOffset.Now,
            Mp4 = opts.Mp4,
            Mp3 = opts.Mp3,
            Subtitles = opts.Subtitles,
            OutputDir = outputDir,
        };

        progress.Report(new($"{label}{video.Title}", 0, "Looking up streams…"));
        var manifest = await WithRetryAsync(
            () => _youtube.Videos.Streams.GetManifestAsync(videoId, ct).AsTask(),
            $"{label}Looking up streams", progress, ct);
        var ffmpeg = ResolveFFmpegPath();

        var mp4Path = baseName + ".mp4";
        var mp3Path = baseName + ".mp3";

        try
        {
            if (opts.Mp4)
                record.Files.Add(await DownloadVideoAsync(manifest, ffmpeg, mp4Path, label, progress, ct));

            if (opts.Mp3)
                record.Files.Add(await DownloadAudioAsync(manifest, ffmpeg, mp3Path, label, progress, ct));

            // Subtitles are secondary: a failure here must not discard a good audio/video
            // download, so it's caught and reported rather than failing the whole item.
            if (opts.Subtitles)
            {
                try
                {
                    record.Files.AddRange(await DownloadSubtitlesAsync(videoId, baseName, label, progress, ct));
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    progress.Report(new($"{label}Subtitles", 1, $"Skipped subtitles: {ex.Message}"));
                }
            }
        }
        catch
        {
            // Failed or cancelled mid-download: remove the half-written outputs (and any
            // ffmpeg .stream-*.tmp scratch files) so no partial file or temp is left behind.
            CleanupPartial(mp4Path);
            CleanupPartial(mp3Path);
            throw;
        }

        await _history.AddAsync(record);
        progress.Report(new($"{label}Saved “{video.Title}”", 1));
        return record;
    }

    /// <summary>Deletes a partial output file and any ffmpeg "<file>.stream-*.tmp"
    /// scratch files left beside it. Best-effort; never throws.</summary>
    private static void CleanupPartial(string finalPath)
    {
        TryDelete(finalPath);
        var dir = Path.GetDirectoryName(finalPath);
        if (dir is null || !Directory.Exists(dir)) return;
        try
        {
            foreach (var tmp in Directory.EnumerateFiles(dir, Path.GetFileName(finalPath) + ".stream-*"))
                TryDelete(tmp);
        }
        catch { /* best effort */ }
    }

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* best effort */ }
    }

    private async Task<string> DownloadVideoAsync(
        StreamManifest manifest, string? ffmpeg, string filePath, string label,
        IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var stage = $"{label}Video (MP4)";
        var sub = new Progress<double>(v => progress.Report(new(stage, v)));

        if (ffmpeg is not null)
        {
            // Prefer 1080p: best stream at or below 1080p, else overall highest.
            var videoOnly = manifest.GetVideoOnlyStreams();
            var videoStream =
                videoOnly.Where(s => s.VideoQuality.MaxHeight <= 1080).GetWithHighestVideoQuality()
                ?? videoOnly.GetWithHighestVideoQuality();
            var audioStream = manifest.GetAudioOnlyStreams().GetWithHighestBitrate();

            progress.Report(new(stage, 0,
                $"{videoStream.VideoQuality.Label} + {audioStream.Bitrate.KiloBitsPerSecond:F0} kbps, merging with ffmpeg"));

            var conversion = new ConversionRequestBuilder(filePath)
                .SetFFmpegPath(ffmpeg)
                .SetContainer(Container.Mp4)
                .Build();

            await WithRetryAsync(async () =>
            {
                CleanupPartial(filePath);   // start each attempt from a clean slate
                await _youtube.Videos.DownloadAsync(
                    new IStreamInfo[] { videoStream, audioStream }, conversion, sub, ct);
            }, stage, progress, ct);
        }
        else
        {
            // No ffmpeg: fall back to a combined stream (max ~720p).
            var muxed = manifest.GetMuxedStreams().GetWithHighestVideoQuality();
            progress.Report(new(stage, 0, $"{muxed.VideoQuality.Label} (combined, no ffmpeg)"));
            await WithRetryAsync(async () =>
            {
                CleanupPartial(filePath);
                await _youtube.Videos.Streams.DownloadAsync(muxed, filePath, sub, ct);
            }, stage, progress, ct);
        }

        return filePath;
    }

    private async Task<string> DownloadAudioAsync(
        StreamManifest manifest, string? ffmpeg, string mp3Path, string label,
        IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var audio = manifest.GetAudioOnlyStreams().GetWithHighestBitrate();
        var stage = $"{label}Audio (MP3)";
        var sub = new Progress<double>(v => progress.Report(new(stage, v)));

        if (ffmpeg is not null)
        {
            progress.Report(new(stage, 0,
                $"{audio.Bitrate.KiloBitsPerSecond:F0} kbps, transcoding to MP3"));
            var conversion = new ConversionRequestBuilder(mp3Path)
                .SetFFmpegPath(ffmpeg)
                .SetContainer(Container.Mp3)
                .Build();
            await WithRetryAsync(async () =>
            {
                CleanupPartial(mp3Path);
                await _youtube.Videos.DownloadAsync(new IStreamInfo[] { audio }, conversion, sub, ct);
            }, stage, progress, ct);
            return mp3Path;
        }

        // No ffmpeg: save the raw audio stream in its native container instead.
        var rawPath = Path.ChangeExtension(mp3Path, "." + audio.Container.Name);
        progress.Report(new(stage, 0, $"ffmpeg not found - saving raw .{audio.Container.Name}"));
        await WithRetryAsync(async () =>
        {
            TryDelete(rawPath);
            await _youtube.Videos.Streams.DownloadAsync(audio, rawPath, sub, ct);
        }, stage, progress, ct);
        return rawPath;
    }

    private async Task<List<string>> DownloadSubtitlesAsync(
        VideoId videoId, string baseName, string label, IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var files = new List<string>();
        var stage = $"{label}Subtitles";
        progress.Report(new(stage, 0, "Checking for subtitle tracks…"));
        var captions = await _youtube.Videos.ClosedCaptions.GetManifestAsync(videoId, ct);

        if (captions.Tracks.Count == 0)
        {
            progress.Report(new(stage, 1, "None available for this video."));
            return files;
        }

        var total = captions.Tracks.Count;
        for (var i = 0; i < total; i++)
        {
            var track = captions.Tracks[i];
            var srtPath = $"{baseName}.{track.Language.Code}.srt";
            await _youtube.Videos.ClosedCaptions.DownloadAsync(track, srtPath, cancellationToken: ct);
            files.Add(srtPath);
            progress.Report(new(stage, (i + 1d) / total, $"Saved {track.Language.Name}"));
        }

        return files;
    }

    /// <summary>Exponential-backoff retry (1s, 2s, 4s) with no progress channel —
    /// used while resolving playlist metadata. Cancellation is never retried.</summary>
    private static async Task<T> RetryAsync<T>(Func<Task<T>> action, CancellationToken ct, int maxAttempts = 4)
    {
        for (var attempt = 1; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try { return await action(); }
            catch (OperationCanceledException) { throw; }
            catch when (attempt < maxAttempts)
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Pow(2, attempt - 1)), ct);
            }
        }
    }

    /// <summary>Void-returning overload of <see cref="WithRetryAsync{T}"/>.</summary>
    private static Task WithRetryAsync(
        Func<Task> action, string label, IProgress<DownloadProgress> progress,
        CancellationToken ct, int maxAttempts = 4) =>
        WithRetryAsync(async () => { await action(); return true; }, label, progress, ct, maxAttempts);

    /// <summary>Runs an operation with exponential backoff (1s, 2s, 4s), retrying
    /// transient failures. Cancellation is never retried.</summary>
    private static async Task<T> WithRetryAsync<T>(
        Func<Task<T>> action, string label, IProgress<DownloadProgress> progress,
        CancellationToken ct, int maxAttempts = 4)
    {
        for (var attempt = 1; ; attempt++)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                return await action();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex) when (attempt < maxAttempts)
            {
                var delay = TimeSpan.FromSeconds(Math.Pow(2, attempt - 1));
                progress.Report(new(label, 0,
                    $"Attempt {attempt} failed ({ex.Message}); retrying in {delay.TotalSeconds:F0}s…"));
                await Task.Delay(delay, ct);
            }
        }
    }

    /// <summary>Locates ffmpeg via FFMPEG_PATH, next to the app, cwd, or PATH.</summary>
    private static string? ResolveFFmpegPath()
    {
        var env = Environment.GetEnvironmentVariable("FFMPEG_PATH");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env))
            return env;

        var exeName = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";

        foreach (var dir in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var candidate = Path.Combine(dir, exeName);
            if (File.Exists(candidate)) return candidate;
        }

        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var dir in pathVar.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), exeName);
                if (File.Exists(candidate)) return candidate;
            }
            catch { /* ignore malformed PATH entries */ }
        }

        return null;
    }

    private static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var clean = string.Concat(name.Select(c => invalid.Contains(c) ? '_' : c));
        return clean.Length > 150 ? clean[..150] : clean;
    }
}
