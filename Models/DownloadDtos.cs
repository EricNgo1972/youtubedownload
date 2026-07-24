namespace YoutubeDownloader.Models;

/// <summary>Which outputs the user asked for, and whether to grab the whole playlist.</summary>
public record DownloadOptions(bool Mp4, bool Mp3, bool Subtitles, bool Playlist = false);

/// <summary>A progress update pushed from the download service to the UI.</summary>
public record DownloadProgress(string Stage, double Percent, string? Message = null);
