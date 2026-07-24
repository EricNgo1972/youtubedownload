namespace YoutubeDownloader.Models;

/// <summary>A user-created, ordered play queue of history record ids.</summary>
public class Playlist
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public List<string> RecordIds { get; set; } = new();
    public DateTimeOffset CreatedAt { get; set; }
}
