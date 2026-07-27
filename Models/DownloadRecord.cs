namespace YoutubeDownloader.Models;

/// <summary>Where a library track's audio came from.</summary>
public enum TrackSource { YouTube, Upload }

/// <summary>One track in the library (persisted to history.json). A track's audio
/// may be a YouTube download or a file the user uploaded — see <see cref="Source"/>.</summary>
public class DownloadRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");

    /// <summary>How this track entered the library. Records written before this field
    /// existed deserialize to <see cref="TrackSource.YouTube"/>, which is correct.</summary>
    public TrackSource Source { get; set; } = TrackSource.YouTube;

    public string VideoId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string Url { get; set; } = "";
    public string Duration { get; set; } = "";
    public DateTimeOffset DownloadedAt { get; set; }

    public bool Mp4 { get; set; }
    public bool Mp3 { get; set; }
    public bool Subtitles { get; set; }

    /// <summary>Encode the audio for speech rather than music. Remembered on the record so
    /// a track added as a link is still fetched the way the user asked when its turn comes.</summary>
    public bool SpokenWord { get; set; }

    /// <summary>Archived records are kept (files untouched) but hidden from the main list.</summary>
    public bool Archived { get; set; }

    /// <summary>
    /// A track added as a LINK only: its title, author and duration are known but no bytes
    /// exist on the server yet, so <see cref="Files"/> is empty. Pasting a URL is then
    /// instant and free, and nothing is fetched until someone actually wants the track.
    ///
    /// Records written before this field existed deserialize to false, which is correct:
    /// they were all created by a completed download.
    /// </summary>
    public bool Pending { get; set; }

    /// <summary>Why the last fetch of a pending track failed, if it did. Kept so the row
    /// can say what went wrong and offer a retry rather than silently staying pending.</summary>
    public string? FetchError { get; set; }

    /// <summary>Absolute paths of every file written for this download.</summary>
    public List<string> Files { get; set; } = new();

    public string OutputDir { get; set; } = "";
}
