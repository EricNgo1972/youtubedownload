namespace YoutubeDownloader.Models;

/// <summary>Which outputs the user asked for, and whether to grab the whole playlist.
/// <paramref name="SpokenWord"/> encodes the audio for speech instead of music — see
/// YoutubeDownloadService for what that means and why it is worth several hundred MB on
/// a long audiobook.</summary>
public record DownloadOptions(bool Mp4, bool Mp3, bool Subtitles, bool Playlist = false,
                              bool SpokenWord = false);

/// <summary>A progress update pushed from the download service to the UI.</summary>
public record DownloadProgress(string Stage, double Percent, string? Message = null);

/// <summary>One video the download will produce, known before downloading starts.</summary>
public record PlannedVideo(string VideoId, string Title);

/// <summary>The resolved set of videos a URL expands to (1 for a video, N for a playlist),
/// plus the folder they'll be written to.</summary>
public record DownloadPlan(string PlaylistTitle, string OutputDir, IReadOnlyList<PlannedVideo> Videos);

/// <summary>A video behind a pasted link, known from metadata alone — nothing downloaded.
/// This is what a library entry holds until someone asks for the audio.
///
/// <paramref name="PlaylistId"/> and <paramref name="Index"/> record WHERE the link listed
/// this video. It is the only moment that order is known — the library sorts by when a
/// track arrived, so without carrying the position here a playlist's real order is gone
/// the instant it lands. Both are empty/-1 for a single video, which has no position.</summary>
public record LinkedVideo(string VideoId, string Title, string Author, string Duration,
                          string PlaylistId = "", int Index = -1);
