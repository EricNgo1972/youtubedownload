using System.Globalization;

namespace YoutubeDownloader.Services;

/// <summary>
/// Presentation helpers shared by the Playlists and Library views: the monogram and
/// tint that stand in for cover art, plus display formatting for artist and duration.
///
/// These are computed server-side on purpose. They are deterministic from the record,
/// so baking them into the prerendered HTML means a page served from the service worker
/// cache looks identical with no circuit and no JavaScript pass.
/// </summary>
public static class TrackVisuals
{
    // Well-spaced hues; lightness/chroma fixed so every tile carries the same weight
    // behind white text. Same palette as the design.
    private static readonly int[] Hues = { 148, 190, 262, 24, 330, 96 };

    /// <summary>A stable background colour for a track's artwork tile.</summary>
    public static string Tint(string id)
    {
        var h = 0;
        foreach (var c in id) h = (h * 31 + c) & 0x7FFFFFFF;
        return string.Create(CultureInfo.InvariantCulture, $"oklch(0.42 0.09 {Hues[h % Hues.Length]})");
    }

    /// <summary>Up to two initials from the title, e.g. "hai triệu năm" → "HT".</summary>
    public static string Mono(string title)
    {
        var initials = title
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(FirstLetter)
            .Where(c => c is not null)
            .Take(2)
            .ToArray();
        return initials.Length == 0 ? "♪" : string.Concat(initials).ToUpperInvariant();
    }

    // Skip leading punctuation and emoji (many titles start with "P1:" or "🔥") so the
    // monogram is made of characters that actually render in the tile.
    private static string? FirstLetter(string word)
    {
        foreach (var c in word)
            if (char.IsLetterOrDigit(c)) return c.ToString();
        return null;
    }

    /// <summary>Author, blanked for uploads (where it's the placeholder "Uploaded").</summary>
    public static string Artist(string? author) =>
        string.IsNullOrWhiteSpace(author) || author == "Uploaded" ? "" : author;

    /// <summary>"00:04:12" → "4:12"; "10:03:50" stays "10:03:50". Empty stays empty.</summary>
    public static string Duration(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "";
        if (!TimeSpan.TryParse(raw, CultureInfo.InvariantCulture, out var t)) return raw;
        return t.TotalHours >= 1
            ? string.Create(CultureInfo.InvariantCulture, $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}")
            : string.Create(CultureInfo.InvariantCulture, $"{t.Minutes}:{t.Seconds:00}");
    }

    /// <summary>"3 tracks · 12 min" for a playlist header.</summary>
    public static string Meta(int count, IEnumerable<string?> durations)
    {
        var total = TimeSpan.Zero;
        foreach (var d in durations)
            if (!string.IsNullOrWhiteSpace(d) && TimeSpan.TryParse(d, CultureInfo.InvariantCulture, out var t))
                total += t;

        var label = count == 1 ? "1 track" : $"{count} tracks";
        if (total == TimeSpan.Zero) return label;
        var mins = (int)Math.Round(total.TotalMinutes);
        return mins >= 60
            ? $"{label} · {total.TotalHours:0.#} hr"
            : $"{label} · {mins} min";
    }
}
