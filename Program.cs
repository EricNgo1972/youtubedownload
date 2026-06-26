using YoutubeExplode;
using YoutubeExplode.Common;
using YoutubeExplode.Converter;
using YoutubeExplode.Playlists;
using YoutubeExplode.Videos;
using YoutubeExplode.Videos.Streams;

namespace YoutubeDownloader;

internal static class Program
{
    private static async Task<int> Main()
    {
        Console.WriteLine("=== YouTube Video Downloader ===\n");

        Console.Write("Enter the public YouTube video or playlist URL: ");
        var url = Console.ReadLine()?.Trim();
        if (string.IsNullOrWhiteSpace(url))
        {
            Console.Error.WriteLine("No URL provided.");
            return 1;
        }

        // Everything is saved into the user's Downloads folder.
        var outputDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(outputDir);

        var youtube = new YoutubeClient();

        try
        {
            // A plain video URL wins even if it also carries a "&list=" parameter;
            // only treat the input as a playlist when there is no single video id.
            if (VideoId.TryParse(url) is { } videoId)
            {
                Console.WriteLine("\nFetching video information...");
                var video = await youtube.Videos.GetAsync(videoId);
                await DownloadEntryAsync(youtube, video, outputDir);
                Console.WriteLine($"\nAll done. Files saved to:\n{outputDir}");
            }
            else if (PlaylistId.TryParse(url) is { } playlistId)
            {
                await DownloadPlaylistAsync(youtube, playlistId, outputDir);
            }
            else
            {
                Console.Error.WriteLine("That doesn't look like a YouTube video or playlist URL.");
                return 1;
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\nError: {ex.Message}");
            return 1;
        }
    }

    /// <summary>Downloads every video in a playlist into a sub-folder named after it.</summary>
    private static async Task DownloadPlaylistAsync(YoutubeClient youtube, PlaylistId playlistId, string outputDir)
    {
        Console.WriteLine("\nFetching playlist information...");
        var playlist = await youtube.Playlists.GetAsync(playlistId);
        var videos = await youtube.Playlists.GetVideosAsync(playlistId);

        Console.WriteLine($"  Playlist : {playlist.Title}");
        Console.WriteLine($"  Author   : {playlist.Author?.ChannelTitle ?? "Unknown"}");
        Console.WriteLine($"  Videos   : {videos.Count}");

        var playlistDir = Path.Combine(outputDir, Sanitize(playlist.Title));
        Directory.CreateDirectory(playlistDir);

        var done = 0;
        var failed = 0;
        for (var i = 0; i < videos.Count; i++)
        {
            var video = videos[i];
            Console.WriteLine($"\n===== [{i + 1}/{videos.Count}] =====");
            try
            {
                await DownloadEntryAsync(youtube, video, playlistDir);
                done++;
            }
            catch (Exception ex)
            {
                failed++;
                Console.Error.WriteLine($"      Skipped \"{video.Title}\" - {ex.Message}");
            }
        }

        Console.WriteLine($"\nAll done. {done}/{videos.Count} downloaded" +
                          (failed > 0 ? $" ({failed} skipped)" : "") + $" to:\n{playlistDir}");
    }

    /// <summary>Downloads one video (merged MP4) plus its subtitles.</summary>
    private static async Task DownloadEntryAsync(YoutubeClient youtube, IVideo video, string outputDir)
    {
        Console.WriteLine($"  Title    : {video.Title}");
        Console.WriteLine($"  Author   : {video.Author.ChannelTitle}");
        Console.WriteLine($"  Duration : {video.Duration}\n");

        var baseName = Path.Combine(outputDir, Sanitize(video.Title));
        await DownloadVideoAsync(youtube, video.Id, baseName + ".mp4");
        await DownloadSubtitlesAsync(youtube, video.Id, baseName);
    }

    private static async Task DownloadVideoAsync(YoutubeClient youtube, VideoId videoId, string filePath)
    {
        Console.WriteLine("[1/2] Video + audio");
        Console.WriteLine("      Looking up available streams...");
        var manifest = await youtube.Videos.Streams.GetManifestAsync(videoId);
        var ffmpegPath = ResolveFFmpegPath();

        if (ffmpegPath is not null)
        {
            // Prefer 1080p: pick the best stream at or below 1080p, falling back
            // to the overall highest quality if nothing <= 1080p exists.
            var videoOnly = manifest.GetVideoOnlyStreams();
            var videoStream =
                videoOnly.Where(s => s.VideoQuality.MaxHeight <= 1080).GetWithHighestVideoQuality()
                ?? videoOnly.GetWithHighestVideoQuality();
            var audioStream = manifest.GetAudioOnlyStreams().GetWithHighestBitrate();

            var estMb = (videoStream.Size.MegaBytes + audioStream.Size.MegaBytes);
            Console.WriteLine($"      Selected : {videoStream.VideoQuality.Label} video + " +
                              $"{audioStream.Bitrate.KiloBitsPerSecond:F0} kbps audio  (~{estMb:F0} MB)");
            Console.WriteLine($"      Merging with ffmpeg -> MP4");

            var conversion = new ConversionRequestBuilder(filePath)
                .SetFFmpegPath(ffmpegPath)
                .SetContainer(Container.Mp4)
                .Build();

            var progress = new ConsoleProgress("      Downloading + merging");
            await youtube.Videos.DownloadAsync(
                new IStreamInfo[] { videoStream, audioStream }, conversion, progress);
            progress.Complete();
        }
        else
        {
            // No ffmpeg: combined stream already contains both video and audio (~720p max).
            Console.WriteLine("      (ffmpeg not found - using combined stream, max ~720p)");
            var muxed = manifest.GetMuxedStreams().GetWithHighestVideoQuality();
            Console.WriteLine($"      Selected : {muxed.VideoQuality.Label}  (~{muxed.Size.MegaBytes:F0} MB)");

            var progress = new ConsoleProgress("      Downloading");
            await youtube.Videos.Streams.DownloadAsync(muxed, filePath, progress);
            progress.Complete();
        }

        var sizeMb = new FileInfo(filePath).Length / 1024d / 1024d;
        Console.WriteLine($"\n      Saved {Path.GetFileName(filePath)} ({sizeMb:F1} MB)");
    }

    private static async Task DownloadSubtitlesAsync(YoutubeClient youtube, VideoId videoId, string baseName)
    {
        Console.WriteLine("\n[2/2] Subtitles");
        Console.WriteLine("      Checking for subtitle tracks...");
        var captionManifest = await youtube.Videos.ClosedCaptions.GetManifestAsync(videoId);
        if (captionManifest.Tracks.Count == 0)
        {
            Console.WriteLine("      None available for this video.");
            return;
        }

        Console.WriteLine($"      Found {captionManifest.Tracks.Count} track(s), downloading...");
        foreach (var track in captionManifest.Tracks)
        {
            var lang = track.Language.Code;
            var srtPath = $"{baseName}.{lang}.srt";
            await youtube.Videos.ClosedCaptions.DownloadAsync(track, srtPath);
            Console.WriteLine($"      Saved {Path.GetFileName(srtPath)} ({track.Language.Name})");
        }
    }

    /// <summary>
    /// Locates ffmpeg via FFMPEG_PATH, next to the app, the current directory,
    /// or the system PATH. Returns null if not found.
    /// </summary>
    private static string? ResolveFFmpegPath()
    {
        var env = Environment.GetEnvironmentVariable("FFMPEG_PATH");
        if (!string.IsNullOrWhiteSpace(env) && File.Exists(env))
            return env;

        var exeName = OperatingSystem.IsWindows() ? "ffmpeg.exe" : "ffmpeg";

        foreach (var dir in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var candidate = Path.Combine(dir, exeName);
            if (File.Exists(candidate))
                return candidate;
        }

        var pathVar = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var dir in pathVar.Split(Path.PathSeparator))
        {
            if (string.IsNullOrWhiteSpace(dir))
                continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), exeName);
                if (File.Exists(candidate))
                    return candidate;
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

    /// <summary>Renders a single-line, in-place progress bar in the console.</summary>
    private sealed class ConsoleProgress : IProgress<double>
    {
        private const int Width = 30;
        private readonly string _label;
        private int _lastPercent = -1;

        public ConsoleProgress(string label) => _label = label;

        public void Report(double value)
        {
            var percent = (int)(value * 100);
            if (percent == _lastPercent)
                return;

            _lastPercent = percent;
            var filled = percent * Width / 100;
            Console.Write($"\r{_label} [{new string('#', filled)}{new string('-', Width - filled)}] {percent,3}%");
        }

        public void Complete() =>
            Console.Write($"\r{_label} [{new string('#', Width)}] 100%");
    }
}
