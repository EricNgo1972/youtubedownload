using System.Text.Json;
using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>
/// User-created playlists (ordered lists of history record ids), persisted to
/// playlists.json alongside history.json. Thread-safe; writes are serialized.
/// </summary>
public class PlaylistService
{
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly List<Playlist> _playlists;

    public PlaylistService(IConfiguration config)
    {
        Directory.CreateDirectory(AppPaths.DataDir(config));
        _path = AppPaths.PlaylistsFile(config);
        _playlists = File.Exists(_path)
            ? JsonSerializer.Deserialize<List<Playlist>>(File.ReadAllText(_path)) ?? new()
            : new();
    }

    public IReadOnlyList<Playlist> All()
    {
        lock (_playlists) return _playlists.OrderBy(p => p.CreatedAt).ToList();
    }

    public Playlist? Get(string id)
    {
        lock (_playlists) return _playlists.FirstOrDefault(p => p.Id == id);
    }

    public async Task<Playlist> CreateAsync(string name)
    {
        var playlist = new Playlist
        {
            Name = string.IsNullOrWhiteSpace(name) ? "Untitled" : name.Trim(),
            CreatedAt = DateTimeOffset.Now,
        };
        await _gate.WaitAsync();
        try
        {
            lock (_playlists) _playlists.Add(playlist);
            await SaveAsync();
        }
        finally { _gate.Release(); }
        return playlist;
    }

    public Task RenameAsync(string id, string name) => Mutate(() =>
    {
        var p = Find(id);
        if (p is not null && !string.IsNullOrWhiteSpace(name)) p.Name = name.Trim();
    });

    public Task DeleteAsync(string id) => Mutate(() =>
    {
        lock (_playlists) _playlists.RemoveAll(p => p.Id == id);
    });

    public Task AddItemAsync(string id, string recordId) => Mutate(() =>
    {
        var p = Find(id);
        if (p is not null && !p.RecordIds.Contains(recordId)) p.RecordIds.Add(recordId);
    });

    /// <summary>Appends several tracks at once (skipping any already present), saving once.</summary>
    public Task AddItemsAsync(string id, IEnumerable<string> recordIds) => Mutate(() =>
    {
        var p = Find(id);
        if (p is null) return;
        foreach (var rid in recordIds)
            if (!p.RecordIds.Contains(rid)) p.RecordIds.Add(rid);
    });

    public Task RemoveItemAsync(string id, string recordId) => Mutate(() =>
    {
        Find(id)?.RecordIds.Remove(recordId);
    });

    /// <summary>Moves an item by <paramref name="delta"/> positions (-1 up, +1 down).</summary>
    public Task MoveAsync(string id, string recordId, int delta) => Mutate(() =>
    {
        var p = Find(id);
        if (p is null) return;
        var i = p.RecordIds.IndexOf(recordId);
        if (i < 0) return;
        var j = i + delta;
        if (j < 0 || j >= p.RecordIds.Count) return;
        (p.RecordIds[i], p.RecordIds[j]) = (p.RecordIds[j], p.RecordIds[i]);
    });

    private Playlist? Find(string id)
    {
        lock (_playlists) return _playlists.FirstOrDefault(p => p.Id == id);
    }

    private async Task Mutate(Action action)
    {
        await _gate.WaitAsync();
        try { action(); await SaveAsync(); }
        finally { _gate.Release(); }
    }

    private async Task SaveAsync()
    {
        List<Playlist> snapshot;
        lock (_playlists) snapshot = _playlists.ToList();
        await File.WriteAllTextAsync(_path, JsonSerializer.Serialize(snapshot, JsonOpts));
    }
}
