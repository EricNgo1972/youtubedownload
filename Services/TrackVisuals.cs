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

    // Where a shared prefix may end, and what to shave off the front of what's left. Both
    // are separators a title uses between its series name and the part that names the
    // episode, so cutting on one keeps whole words on both sides of the cut.
    private static readonly char[] Boundary = { ' ', '-', '\u2013', '\u2014', ':', '|', '\u00b7' };
    private static readonly char[] LeadIn = { ' ', '-', '\u2013', '\u2014', ':', '|', '\u00b7', '.', ',' };

    /// <summary>The shortest prefix worth hoisting. Shorter than this and lifting it out
    /// costs the reader a line of chrome to win back four characters.</summary>
    private const int MinPrefix = 12;

    /// <summary>Longest prefix considered, and the share of the list that must start with
    /// one for it to win. "Most", not "all": a playlist of fifty audiobook parts usually
    /// has a stray track or two in it, and they must not cost the other forty-eight their
    /// readable rows — a row that doesn't start with the prefix simply keeps its title.</summary>
    private const int MaxPrefix = 60;
    private const double DominantShare = 0.6;

    /// <summary>
    /// The leading run most of these titles share, cut at a word boundary — the series
    /// name in front of a 58-part audiobook. Shown once above the list so each row can
    /// spend its width on the part that actually tells it apart; returns "" when no
    /// prefix is common or long enough to be worth the trade.
    /// </summary>
    public static string SharedPrefix(IEnumerable<string> titles)
    {
        var list = titles as IList<string> ?? titles.ToList();
        if (list.Count < 3) return "";

        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var title in list)
            foreach (var candidate in Prefixes(title))
                counts[candidate] = counts.GetValueOrDefault(candidate) + 1;

        // A longer candidate can never be commoner than a shorter one it extends, so the
        // longest that clears the bar is the most specific prefix the list agrees on.
        var needed = Math.Max(3, (int)Math.Ceiling(list.Count * DominantShare));
        var best = "";
        foreach (var (candidate, count) in counts)
            if (count >= needed &&
                (candidate.Length > best.Length ||
                 (candidate.Length == best.Length && string.CompareOrdinal(candidate, best) < 0)))
                best = candidate;
        return best;
    }

    /// <summary>Every word-boundary prefix of one title, longest-worth-having only, each
    /// yielded once — repeated separators ("A - B") must not make one title look like
    /// three votes for the same prefix.</summary>
    private static IEnumerable<string> Prefixes(string title)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var limit = Math.Min(title.Length, MaxPrefix);
        for (var i = MinPrefix; i < limit; i++)
        {
            if (Array.IndexOf(Boundary, title[i]) < 0) continue;
            // Cutting at a boundary char keeps whole words on both sides — and every
            // boundary char is a single UTF-16 unit, so it can never split a surrogate.
            var candidate = title[..i].TrimEnd(LeadIn);
            if (candidate.Length >= MinPrefix && seen.Add(candidate)) yield return candidate;
        }
    }

    /// <summary>A title with the list's shared prefix taken off the front. Falls back to
    /// the whole title when nothing would be left — a row with no text is worse than a
    /// row that repeats the series name.</summary>
    public static string StripPrefix(string title, string prefix)
    {
        if (prefix.Length == 0 || !title.StartsWith(prefix, StringComparison.Ordinal)) return title;
        var rest = title[prefix.Length..].TrimStart(LeadIn);
        return rest.Length == 0 ? title : rest;
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
