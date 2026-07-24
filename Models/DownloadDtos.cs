namespace YoutubeDownloader.Models;

/// <summary>Which outputs the user asked for, and whether to grab the whole playlist.</summary>
public record DownloadOptions(bool Mp4, bool Mp3, bool Subtitles, bool Playlist = false);

/// <summary>A progress update pushed from the download service to the UI.</summary>
public record DownloadProgress(string Stage, double Percent, string? Message = null);

/// <summary>One video the download will produce, known before downloading starts.</summary>
public record PlannedVideo(string VideoId, string Title);

/// <summary>The resolved set of videos a URL expands to (1 for a video, N for a playlist),
/// plus the folder they'll be written to.</summary>
public record DownloadPlan(string PlaylistTitle, string OutputDir, IReadOnlyList<PlannedVideo> Videos);
