namespace YoutubeDownloader.Models;

/// <summary>One entry in the download history (persisted to history.json).</summary>
public class DownloadRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string VideoId { get; set; } = "";
    public string Title { get; set; } = "";
    public string Author { get; set; } = "";
    public string Url { get; set; } = "";
    public string Duration { get; set; } = "";
    public DateTimeOffset DownloadedAt { get; set; }

    public bool Mp4 { get; set; }
    public bool Mp3 { get; set; }
    public bool Subtitles { get; set; }

    /// <summary>Archived records are kept (files untouched) but hidden from the main list.</summary>
    public bool Archived { get; set; }

    /// <summary>Absolute paths of every file written for this download.</summary>
    public List<string> Files { get; set; } = new();

    public string OutputDir { get; set; } = "";
}
