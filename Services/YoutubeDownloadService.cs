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
    /// Downloads either a single video or, when <see cref="DownloadOptions.Playlist"/>
    /// is set and the URL has a playlist, every video in that playlist. Each video
    /// becomes its own history record. Returns all records produced.
    /// </summary>
    public async Task<IReadOnlyList<DownloadRecord>> DownloadAsync(
        string url, DownloadOptions opts, IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        if (!opts.Mp4 && !opts.Mp3 && !opts.Subtitles)
            throw new InvalidOperationException("Pick at least one of MP4, MP3 or subtitles.");

        if (opts.Playlist)
        {
            if (PlaylistId.TryParse(url) is not { } playlistId)
                throw new InvalidOperationException("That URL doesn't contain a playlist.");
            return await DownloadPlaylistAsync(playlistId, opts, progress, ct);
        }

        if (VideoId.TryParse(url) is not { } videoId)
            throw new InvalidOperationException("That doesn't look like a YouTube video URL.");

        var record = await DownloadOneAsync(videoId, opts, AppPaths.DownloadsDir(_config), "", progress, ct);
        return new[] { record };
    }

    private async Task<IReadOnlyList<DownloadRecord>> DownloadPlaylistAsync(
        PlaylistId playlistId, DownloadOptions opts, IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        progress.Report(new("Fetching playlist", 0));
        var playlist = await WithRetryAsync(
            async () => await _youtube.Playlists.GetAsync(playlistId), "Fetching playlist", progress, ct);
        var videos = await WithRetryAsync(
            async () => await _youtube.Playlists.GetVideosAsync(playlistId).CollectAsync(),
            "Fetching playlist", progress, ct);

        // Each playlist gets its own sub-folder.
        var playlistDir = Path.Combine(AppPaths.DownloadsDir(_config), Sanitize(playlist.Title));
        Directory.CreateDirectory(playlistDir);

        var records = new List<DownloadRecord>();
        for (var i = 0; i < videos.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var video = videos[i];
            var label = $"[{i + 1}/{videos.Count}] ";
            try
            {
                records.Add(await DownloadOneAsync(video.Id, opts, playlistDir, label, progress, ct));
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                // Skip a bad video but keep going through the rest of the playlist.
                progress.Report(new($"{label}{video.Title}", 0, $"Skipped: {ex.Message}"));
            }
        }

        progress.Report(new("Done", 1,
            $"Playlist “{playlist.Title}”: {records.Count}/{videos.Count} downloaded."));
        return records;
    }

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

        if (opts.Mp4)
            record.Files.Add(await DownloadVideoAsync(manifest, ffmpeg, baseName + ".mp4", progress, ct));

        if (opts.Mp3)
            record.Files.Add(await DownloadAudioAsync(manifest, ffmpeg, baseName + ".mp3", progress, ct));

        if (opts.Subtitles)
            record.Files.AddRange(await DownloadSubtitlesAsync(videoId, baseName, progress, ct));

        await _history.AddAsync(record);
        progress.Report(new($"{label}Saved “{video.Title}”", 1));
        return record;
    }

    private async Task<string> DownloadVideoAsync(
        StreamManifest manifest, string? ffmpeg, string filePath,
        IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var sub = new Progress<double>(v => progress.Report(new("Video (MP4)", v)));

        if (ffmpeg is not null)
        {
            // Prefer 1080p: best stream at or below 1080p, else overall highest.
            var videoOnly = manifest.GetVideoOnlyStreams();
            var videoStream =
                videoOnly.Where(s => s.VideoQuality.MaxHeight <= 1080).GetWithHighestVideoQuality()
                ?? videoOnly.GetWithHighestVideoQuality();
            var audioStream = manifest.GetAudioOnlyStreams().GetWithHighestBitrate();

            progress.Report(new("Video (MP4)", 0,
                $"{videoStream.VideoQuality.Label} + {audioStream.Bitrate.KiloBitsPerSecond:F0} kbps, merging with ffmpeg"));

            var conversion = new ConversionRequestBuilder(filePath)
                .SetFFmpegPath(ffmpeg)
                .SetContainer(Container.Mp4)
                .Build();

            await _youtube.Videos.DownloadAsync(
                new IStreamInfo[] { videoStream, audioStream }, conversion, sub, ct);
        }
        else
        {
            // No ffmpeg: fall back to a combined stream (max ~720p).
            var muxed = manifest.GetMuxedStreams().GetWithHighestVideoQuality();
            progress.Report(new("Video (MP4)", 0, $"{muxed.VideoQuality.Label} (combined, no ffmpeg)"));
            await _youtube.Videos.Streams.DownloadAsync(muxed, filePath, sub, ct);
        }

        return filePath;
    }

    private async Task<string> DownloadAudioAsync(
        StreamManifest manifest, string? ffmpeg, string mp3Path,
        IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var audio = manifest.GetAudioOnlyStreams().GetWithHighestBitrate();
        var sub = new Progress<double>(v => progress.Report(new("Audio (MP3)", v)));

        if (ffmpeg is not null)
        {
            progress.Report(new("Audio (MP3)", 0,
                $"{audio.Bitrate.KiloBitsPerSecond:F0} kbps, transcoding to MP3"));
            var conversion = new ConversionRequestBuilder(mp3Path)
                .SetFFmpegPath(ffmpeg)
                .SetContainer(Container.Mp3)
                .Build();
            await _youtube.Videos.DownloadAsync(new IStreamInfo[] { audio }, conversion, sub, ct);
            return mp3Path;
        }

        // No ffmpeg: save the raw audio stream in its native container instead.
        var rawPath = Path.ChangeExtension(mp3Path, "." + audio.Container.Name);
        progress.Report(new("Audio", 0, $"ffmpeg not found - saving raw .{audio.Container.Name}"));
        await _youtube.Videos.Streams.DownloadAsync(audio, rawPath, sub, ct);
        return rawPath;
    }

    private async Task<List<string>> DownloadSubtitlesAsync(
        VideoId videoId, string baseName, IProgress<DownloadProgress> progress, CancellationToken ct)
    {
        var files = new List<string>();
        progress.Report(new("Subtitles", 0, "Checking for subtitle tracks…"));
        var captions = await _youtube.Videos.ClosedCaptions.GetManifestAsync(videoId, ct);

        if (captions.Tracks.Count == 0)
        {
            progress.Report(new("Subtitles", 1, "None available for this video."));
            return files;
        }

        var total = captions.Tracks.Count;
        for (var i = 0; i < total; i++)
        {
            var track = captions.Tracks[i];
            var srtPath = $"{baseName}.{track.Language.Code}.srt";
            await _youtube.Videos.ClosedCaptions.DownloadAsync(track, srtPath, cancellationToken: ct);
            files.Add(srtPath);
            progress.Report(new("Subtitles", (i + 1d) / total, $"Saved {track.Language.Name}"));
        }

        return files;
    }

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
