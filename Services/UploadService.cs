using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>
/// Adds user-uploaded audio files to the library. An upload becomes a library
/// record (<see cref="TrackSource.Upload"/>) with a single audio file, so it is
/// playable and addable to playlists exactly like a downloaded track.
/// </summary>
public class UploadService
{
    // Audio containers we accept and can stream back via the <audio> element.
    private static readonly string[] AllowedExts = { ".mp3", ".m4a", ".webm", ".wav", ".ogg", ".oga", ".aac", ".flac" };

    private readonly HistoryService _history;
    private readonly IConfiguration _config;

    public UploadService(HistoryService history, IConfiguration config)
    {
        _history = history;
        _config = config;
    }

    public static bool IsAllowed(string fileName) =>
        AllowedExts.Contains(Path.GetExtension(fileName).ToLowerInvariant());

    public static string AllowedExtsLabel => string.Join(", ", AllowedExts.Select(e => e.TrimStart('.').ToUpperInvariant()));

    /// <summary>
    /// Saves <paramref name="content"/> under the uploads folder and records it as
    /// a library track. <paramref name="progress"/>, when supplied, is reported the
    /// running number of bytes written (for an upload progress bar). Returns the
    /// new record.
    /// </summary>
    public async Task<DownloadRecord> AddAsync(
        string fileName, Stream content, IProgress<long>? progress = null, CancellationToken ct = default)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        if (!AllowedExts.Contains(ext))
            throw new InvalidOperationException($"Unsupported file type. Allowed: {AllowedExtsLabel}.");

        var uploadsDir = Path.Combine(AppPaths.DownloadsDir(_config), "Uploads");
        Directory.CreateDirectory(uploadsDir);

        var title = Path.GetFileNameWithoutExtension(fileName);
        // Prefix with the record id so two uploads of the same name never collide.
        var record = new DownloadRecord
        {
            Source = TrackSource.Upload,
            Title = string.IsNullOrWhiteSpace(title) ? "Untitled upload" : title,
            Author = "Uploaded",
            Url = "",
            DownloadedAt = DateTimeOffset.Now,
            Mp3 = true,
            OutputDir = uploadsDir,
        };

        var path = Path.Combine(uploadsDir, $"{record.Id}{ext}");
        try
        {
            await using (var dest = File.Create(path))
            {
                var buffer = new byte[128 * 1024];
                long copied = 0;
                int read;
                while ((read = await content.ReadAsync(buffer, ct)) > 0)
                {
                    await dest.WriteAsync(buffer.AsMemory(0, read), ct);
                    copied += read;
                    progress?.Report(copied);
                }
            }
        }
        catch
        {
            // Don't leave a half-written file behind on cancel/failure.
            try { if (File.Exists(path)) File.Delete(path); } catch { /* best effort */ }
            throw;
        }

        record.Files.Add(path);
        await _history.AddAsync(record);
        return record;
    }
}
