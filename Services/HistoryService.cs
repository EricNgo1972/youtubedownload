using System.Text.Json;
using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>
/// Persists the download history to a single JSON file and keeps an in-memory
/// copy. Registered as a singleton; writes are serialized with a gate.
/// </summary>
public class HistoryService
{
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<DownloadRecord> _records;

    public HistoryService(IConfiguration config)
    {
        Directory.CreateDirectory(AppPaths.DataDir(config));
        _path = AppPaths.HistoryFile(config);

        _records = File.Exists(_path)
            ? JsonSerializer.Deserialize<List<DownloadRecord>>(File.ReadAllText(_path)) ?? new()
            : new();
    }

    /// <summary>All records, newest first.</summary>
    public IReadOnlyList<DownloadRecord> All() => Snapshot(_ => true);

    /// <summary>Visible (non-archived) records, newest first.</summary>
    public IReadOnlyList<DownloadRecord> Active() => Snapshot(r => !r.Archived);

    /// <summary>Archived records, newest first.</summary>
    public IReadOnlyList<DownloadRecord> ArchivedItems() => Snapshot(r => r.Archived);

    public int ArchivedCount()
    {
        lock (_records) return _records.Count(r => r.Archived);
    }

    private IReadOnlyList<DownloadRecord> Snapshot(Func<DownloadRecord, bool> predicate)
    {
        lock (_records)
            return _records.Where(predicate).OrderByDescending(r => r.DownloadedAt).ToList();
    }

    /// <summary>True if this video id already appears in the history.</summary>
    public bool Contains(string videoId)
    {
        lock (_records)
            return _records.Any(r => r.VideoId == videoId);
    }

    /// <summary>Looks up a single record by its id (used to serve its files).</summary>
    public DownloadRecord? Get(string id)
    {
        lock (_records)
            return _records.FirstOrDefault(r => r.Id == id);
    }

    public async Task AddAsync(DownloadRecord record)
    {
        await _gate.WaitAsync();
        try
        {
            lock (_records) _records.Add(record);
            await SaveAsync();
        }
        finally { _gate.Release(); }
    }

    /// <summary>Archives or restores a record (files are left in place).</summary>
    public async Task SetArchivedAsync(string id, bool archived)
    {
        await _gate.WaitAsync();
        try
        {
            lock (_records)
            {
                var record = _records.FirstOrDefault(r => r.Id == id);
                if (record is null) return;
                record.Archived = archived;
            }
            await SaveAsync();
        }
        finally { _gate.Release(); }
    }

    public async Task ClearAsync()
    {
        await _gate.WaitAsync();
        try
        {
            lock (_records) _records.Clear();
            await SaveAsync();
        }
        finally { _gate.Release(); }
    }

    private async Task SaveAsync()
    {
        List<DownloadRecord> snapshot;
        lock (_records) snapshot = _records.ToList();
        await File.WriteAllTextAsync(_path, JsonSerializer.Serialize(snapshot, JsonOpts));
    }
}
