using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace YoutubeDownloader.Services;

/// <summary>
/// One box (a TV, a kiosk, a cheap phone) running /player, paired under a name. The box
/// proves who it is with a random key it made for itself the first time it started. Only a
/// hash of that key is kept here, so a copy of players.json cannot impersonate a player.
///
/// The same pattern as MapleKiosk's wall TVs (SPC.BO/Display/WallTv/TvDevices.cs).
/// </summary>
public sealed class PlayerPairing
{
    public string DeviceId { get; set; } = "";
    public string KeyHash { get; set; } = "";
    public string Name { get; set; } = "";
    public DateTime PairedUtc { get; set; }
}

/// <summary>
/// What a box says it is doing. Reported by the box itself and held only in memory: it
/// changes every few seconds and none of it is worth a disk write.
/// </summary>
public sealed class BoxState
{
    public string? Url { get; set; }
    public string? Title { get; set; }
    public string? Author { get; set; }
    public string? PlaylistId { get; set; }
    public string? PlaylistName { get; set; }
    public bool Playing { get; set; }
    public double Pos { get; set; }
    public double Dur { get; set; }
    public double Volume { get; set; } = 1;
    public int Index { get; set; } = -1;
    public int Count { get; set; }
    public bool Shuffle { get; set; }
    /// <summary>The browser blocked sound until someone taps the box's screen.</summary>
    public bool NeedsTap { get; set; }
    /// <summary>Tracks of the current playlist already saved on the box.</summary>
    public int Saved { get; set; }
    public string? Note { get; set; }
}

/// <summary>The answer to a box's check-in.</summary>
public sealed record BoxHello(
    bool Paired,
    string? Code,
    string? DeviceId,
    string? Name,
    bool Reload,
    JsonElement? Pending);

/// <summary>A paired box as the Players page lists it.</summary>
public sealed record PlayerView(
    string DeviceId,
    string Name,
    DateTime PairedUtc,
    DateTime? LastSeenUtc,
    string? AppVersion,
    bool IsOnline,
    bool IsConnected,
    BoxState? State,
    DateTime? StateUtc);

/// <summary>A box showing a pairing code, waiting for someone to name it.</summary>
public sealed record WaitingBox(string Code, DateTime SinceUtc);

/// <summary>How a command to a box went.</summary>
public enum SendOutcome
{
    /// <summary>Pushed down the box's live connection.</summary>
    Delivered,
    /// <summary>The box is checking in but its live connection is down right now. It
    /// picks the command up at its next check-in, within 15 seconds.</summary>
    Queued,
    /// <summary>No such player, or it has not checked in for a while.</summary>
    Offline,
}

/// <summary>
/// Pairs boxes to names and relays commands to them.
///
/// A box that nobody has named shows a 4-digit code. Someone in the main app enters the
/// code and a name on the Players page, and from then on the box plays whatever it is
/// sent. Pairing a new box under an existing name releases the old one, which is how a
/// dead box is replaced without reconfiguring anything.
///
/// Commands travel down a Server-Sent Events stream the box keeps open. A pause has to
/// land now, not at the next 15-second check-in. The check-in still matters: it is how
/// the server knows a box is alive, and it carries anything the stream missed.
/// </summary>
public sealed class PlayerBoxService
{
    public const int MinKeyLength = 16;

    /// <summary>How long a code shown on an unnamed box stays valid without the box
    /// asking again.</summary>
    public static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(30);

    /// <summary>A box checks in every 15 s while it can, so three missed check-ins is a box
    /// that is gone.</summary>
    public static readonly TimeSpan OnlineWindow = TimeSpan.FromSeconds(45);

    /// <summary>A command that missed the live stream is handed over at the next check-in,
    /// but only if that comes soon. "Play" two minutes late is a surprise, not a feature.</summary>
    public static readonly TimeSpan PendingLifetime = TimeSpan.FromSeconds(60);

    /// <summary>A ceiling on boxes waiting at once, so nothing can grow this list without bound.</summary>
    public const int MaxWaiting = 50;

    /// <summary>Open streams per box. A box reconnecting faster than the server notices the
    /// old stream died can briefly hold two; anything beyond that is not a box.</summary>
    private const int MaxStreamsPerBox = 3;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly JsonSerializerOptions JsonFile = new() { WriteIndented = true };

    private readonly string _path;
    private readonly SemaphoreSlim _saveGate = new(1, 1);
    private readonly List<PlayerPairing> _pairings;

    private readonly object _codeGate = new();
    private readonly Dictionary<string, PendingCode> _codes = new(StringComparer.Ordinal);

    private readonly ConcurrentDictionary<string, Seen> _seen = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (BoxState State, DateTime Utc)> _state = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, bool> _reload = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (string Json, DateTime Utc)> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, List<Channel<string>>> _streams = new(StringComparer.Ordinal);

    private sealed record PendingCode(string KeyHash, DateTime CreatedUtc, DateTime LastSeenUtc);
    private sealed record Seen(DateTime Utc, string? Version);

    /// <summary>Something a Players page would show has changed: a box checked in, paired,
    /// reported its state, or went away.</summary>
    public event Action? Changed;

    public PlayerBoxService(IConfiguration config)
    {
        Directory.CreateDirectory(AppPaths.DataDir(config));
        _path = Path.Combine(AppPaths.DataDir(config), "players.json");
        try
        {
            _pairings = File.Exists(_path)
                ? JsonSerializer.Deserialize<List<PlayerPairing>>(File.ReadAllText(_path)) ?? new()
                : new();
        }
        catch (JsonException) { _pairings = new(); }
    }

    public static bool IsValidKey(string? key) =>
        !string.IsNullOrWhiteSpace(key) && key.Trim().Length is >= MinKeyLength and <= 200;

    public static string Hash(string key) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key.Trim())));

    // --- the box's side ------------------------------------------------------------

    /// <summary>A box checking in: who it is, or the code it should show.</summary>
    public BoxHello Hello(string key, string? version, BoxState? state)
    {
        var hash = Hash(key);
        var now = DateTime.UtcNow;
        _seen[hash] = new Seen(now, string.IsNullOrWhiteSpace(version) ? null : version.Trim());

        var pairing = ByHash(hash);
        if (pairing is null)
        {
            _state.TryRemove(hash, out _);
            var code = CodeFor(hash, now);
            Changed?.Invoke();
            return new BoxHello(false, code, null, null, false, null);
        }

        if (state is not null) _state[hash] = (state, now);
        JsonElement? pending = null;
        if (_pending.TryRemove(pairing.DeviceId, out var p) && now - p.Utc <= PendingLifetime)
            pending = JsonDocument.Parse(p.Json).RootElement.Clone();

        Changed?.Invoke();
        return new BoxHello(true, null, pairing.DeviceId, pairing.Name,
            _reload.TryRemove(pairing.DeviceId, out _), pending);
    }

    /// <summary>A paired box telling us what it is playing. Ignored for an unknown key.</summary>
    public bool Report(string key, BoxState state)
    {
        var hash = Hash(key);
        if (ByHash(hash) is null) return false;
        var now = DateTime.UtcNow;
        _state[hash] = (state, now);
        // A state report proves the box is alive just as well as a check-in does.
        _seen.AddOrUpdate(hash, _ => new Seen(now, null), (_, s) => s with { Utc = now });
        Changed?.Invoke();
        return true;
    }

    /// <summary>
    /// Opens the command stream for a box. The reader yields JSON commands. Disposing the
    /// handle closes the stream. An unpaired box may listen too: that is how it hears
    /// "you were just paired" instantly instead of at its next check-in.
    /// </summary>
    public (ChannelReader<string> Reader, IDisposable Handle) Listen(string key)
    {
        var hash = Hash(key);
        var ch = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
        {
            // A box that stops reading must not make the sender wait. Old commands are the
            // least useful ones to keep.
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
        });
        var list = _streams.GetOrAdd(hash, _ => new List<Channel<string>>());
        lock (list)
        {
            while (list.Count >= MaxStreamsPerBox)
            {
                list[0].Writer.TryComplete();
                list.RemoveAt(0);
            }
            list.Add(ch);
        }
        Changed?.Invoke();
        return (ch.Reader, new Unlisten(this, hash, ch));
    }

    private sealed class Unlisten(PlayerBoxService owner, string hash, Channel<string> ch) : IDisposable
    {
        public void Dispose()
        {
            ch.Writer.TryComplete();
            if (owner._streams.TryGetValue(hash, out var list))
                lock (list) list.Remove(ch);
            owner.Changed?.Invoke();
        }
    }

    // --- the controlling side -------------------------------------------------------

    /// <summary>
    /// The box showing <paramref name="code"/> becomes the player called
    /// <paramref name="name"/>. If a player already has that name, the new box takes its
    /// place (same id), and the old box goes back to showing a code.
    /// </summary>
    public async Task<PlayerPairing> PairAsync(string code, string name)
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) throw new InvalidOperationException("Give the player a name, such as Lobby or Kitchen.");
        if (name.Length > 40) name = name[..40];

        string hash;
        lock (_codeGate)
        {
            Prune(DateTime.UtcNow);
            if (!_codes.Remove((code ?? "").Trim(), out var pending))
                throw new InvalidOperationException("That code isn't on any screen. Check the player and try again.");
            hash = pending.KeyHash;
        }

        PlayerPairing pairing;
        PlayerPairing? replaced;
        lock (_pairings)
        {
            replaced = _pairings.FirstOrDefault(p => string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase));
            _pairings.RemoveAll(p => p.KeyHash == hash || ReferenceEquals(p, replaced));
            pairing = new PlayerPairing
            {
                DeviceId = replaced?.DeviceId ?? "PLR-" + Guid.NewGuid().ToString("N")[..10],
                KeyHash = hash,
                Name = name,
                PairedUtc = DateTime.UtcNow,
            };
            _pairings.Add(pairing);
        }
        await SaveAsync();

        if (replaced is not null && replaced.KeyHash != hash)
        {
            _state.TryRemove(replaced.KeyHash, out _);
            Push(replaced.KeyHash, new { type = "hello" });   // old box: you are released
        }
        Push(hash, new { type = "hello" });                   // new box: you are paired
        Changed?.Invoke();
        return pairing;
    }

    /// <summary>The box goes quiet and back to showing a code.</summary>
    public async Task ReleaseAsync(string deviceId)
    {
        PlayerPairing? gone;
        lock (_pairings)
        {
            gone = _pairings.FirstOrDefault(p => p.DeviceId == deviceId);
            if (gone is not null) _pairings.Remove(gone);
        }
        if (gone is null) return;
        await SaveAsync();
        _state.TryRemove(gone.KeyHash, out _);
        _pending.TryRemove(deviceId, out _);
        Push(gone.KeyHash, new { type = "hello" });
        Changed?.Invoke();
    }

    public async Task RenameAsync(string deviceId, string name)
    {
        name = (name ?? "").Trim();
        if (name.Length == 0) return;
        if (name.Length > 40) name = name[..40];
        PlayerPairing? p;
        lock (_pairings)
        {
            if (_pairings.Any(x => x.DeviceId != deviceId && string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Another player is already called {name}.");
            p = _pairings.FirstOrDefault(x => x.DeviceId == deviceId);
            if (p is not null) p.Name = name;
        }
        if (p is null) return;
        await SaveAsync();
        Push(p.KeyHash, new { type = "hello" });
        Changed?.Invoke();
    }

    /// <summary>The box reloads its page: picks up a new build, or shakes off a bad state.</summary>
    public SendOutcome Reload(string deviceId)
    {
        var outcome = Send(deviceId, new { type = "reload" }, queue: false);
        if (outcome != SendOutcome.Delivered) _reload[deviceId] = true;
        return outcome == SendOutcome.Delivered ? outcome : SendOutcome.Queued;
    }

    /// <summary>
    /// Sends a command to a player. Delivered now if its stream is open, otherwise kept
    /// (the newest one only) for its next check-in, as long as that is soon.
    /// </summary>
    public SendOutcome Send(string deviceId, object command, bool queue = true)
    {
        var pairing = ById(deviceId);
        if (pairing is null) return SendOutcome.Offline;
        var json = JsonSerializer.Serialize(command, Json);
        if (Push(pairing.KeyHash, json)) return SendOutcome.Delivered;
        if (!IsOnline(pairing.KeyHash)) return SendOutcome.Offline;
        if (queue) _pending[deviceId] = (json, DateTime.UtcNow);
        return SendOutcome.Queued;
    }

    /// <summary>Starts a playlist on a player. The box gets the whole track list, so from
    /// here on it needs nothing more from the server to keep playing.</summary>
    public SendOutcome Play(string deviceId, Models.Playlist pl, HistoryService history, string? startUrl = null, bool? shuffle = null)
    {
        var tracks = PlaylistManifest.Tracks(pl, history);
        if (tracks.Count == 0) throw new InvalidOperationException($"{pl.Name} has nothing to play yet.");
        return Send(deviceId, new
        {
            type = "play",
            playlistId = pl.Id,
            name = pl.Name,
            tracks,
            start = startUrl,
            shuffle,
        });
    }

    public IReadOnlyList<PlayerView> Players()
    {
        List<PlayerPairing> snapshot;
        lock (_pairings) snapshot = _pairings.OrderBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList();
        return snapshot.Select(p =>
        {
            var seen = _seen.TryGetValue(p.KeyHash, out var s) ? s : null;
            var st = _state.TryGetValue(p.KeyHash, out var x) ? x : ((BoxState, DateTime)?)null;
            return new PlayerView(p.DeviceId, p.Name, p.PairedUtc, seen?.Utc, seen?.Version,
                IsOnline(p.KeyHash), IsConnected(p.KeyHash), st?.Item1, st?.Item2);
        }).ToList();
    }

    /// <summary>The boxes showing a code right now, oldest first.</summary>
    public IReadOnlyList<WaitingBox> Waiting()
    {
        var now = DateTime.UtcNow;
        lock (_codeGate)
        {
            Prune(now);
            return _codes
                // Only boxes still asking. A code nobody refreshed for a minute belongs to
                // a box that was closed, and offering it would only invite a failed pair.
                .Where(c => now - c.Value.LastSeenUtc <= OnlineWindow)
                .OrderBy(c => c.Value.CreatedUtc)
                .Select(c => new WaitingBox(c.Key, c.Value.CreatedUtc))
                .ToList();
        }
    }

    // --- internals ------------------------------------------------------------------

    private bool IsOnline(string hash) =>
        IsConnected(hash) || (_seen.TryGetValue(hash, out var s) && DateTime.UtcNow - s.Utc <= OnlineWindow);

    private bool IsConnected(string hash)
    {
        if (!_streams.TryGetValue(hash, out var list)) return false;
        lock (list) return list.Count > 0;
    }

    private bool Push(string hash, object command) =>
        Push(hash, JsonSerializer.Serialize(command, Json));

    private bool Push(string hash, string json)
    {
        if (!_streams.TryGetValue(hash, out var list)) return false;
        var sent = false;
        lock (list)
            foreach (var ch in list)
                sent |= ch.Writer.TryWrite(json);
        return sent;
    }

    private PlayerPairing? ByHash(string hash)
    {
        lock (_pairings) return _pairings.FirstOrDefault(p => p.KeyHash == hash);
    }

    private PlayerPairing? ById(string deviceId)
    {
        lock (_pairings) return _pairings.FirstOrDefault(p => p.DeviceId == deviceId);
    }

    /// <summary>The code this unnamed box should show: the one it already has, or a new one.</summary>
    private string CodeFor(string hash, DateTime now)
    {
        lock (_codeGate)
        {
            Prune(now);
            var mine = _codes.FirstOrDefault(p => p.Value.KeyHash == hash);
            if (mine.Key is not null)
            {
                _codes[mine.Key] = mine.Value with { LastSeenUtc = now };
                return mine.Key;
            }
            if (_codes.Count >= MaxWaiting)
                _codes.Remove(_codes.MinBy(p => p.Value.LastSeenUtc).Key);

            string code;
            do code = RandomNumberGenerator.GetInt32(1000, 10000).ToString(System.Globalization.CultureInfo.InvariantCulture);
            while (_codes.ContainsKey(code));
            _codes[code] = new PendingCode(hash, now, now);
            return code;
        }
    }

    private void Prune(DateTime now)
    {
        foreach (var stale in _codes.Where(p => now - p.Value.LastSeenUtc > CodeLifetime).Select(p => p.Key).ToList())
            _codes.Remove(stale);
    }

    private async Task SaveAsync()
    {
        List<PlayerPairing> snapshot;
        lock (_pairings) snapshot = _pairings.ToList();
        await _saveGate.WaitAsync();
        try { await File.WriteAllTextAsync(_path, JsonSerializer.Serialize(snapshot, JsonFile)); }
        finally { _saveGate.Release(); }
    }
}
