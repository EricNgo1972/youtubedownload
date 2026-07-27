using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>One timed line of lyrics.</summary>
public readonly record struct LyricLine(double T, string Text);

/// <summary>
/// Turns a track's subtitle file into timed lyric lines for the karaoke view.
///
/// The source is whatever was downloaded alongside the audio — an .lrc if the user
/// supplied one, otherwise the .srt the downloader fetched from YouTube. Nothing is
/// requested from a third-party lyrics service: the text is already on disk, which is
/// also what lets it work on a plane.
/// </summary>
public static partial class LyricsService
{
    /// <summary>One selectable lyrics source, e.g. the Vietnamese vs English captions.</summary>
    public readonly record struct Sub(int Index, string Lang, string Label, string Path);

    /// <summary>
    /// Every lyrics file on a record. A YouTube download often carries captions in more
    /// than one language ("…x Orange.en.srt" and "….vi.srt"), and picking one silently
    /// gets it wrong half the time — so they are all offered and the user chooses.
    /// A hand-made .lrc sorts first, then languages alphabetically.
    /// </summary>
    public static IReadOnlyList<Sub> List(DownloadRecord rec)
    {
        var found = rec.Files
            .Where(f => f.EndsWith(".lrc", StringComparison.OrdinalIgnoreCase)
                     || f.EndsWith(".srt", StringComparison.OrdinalIgnoreCase))
            .Where(File.Exists)
            .Select(f => (path: f, lrc: f.EndsWith(".lrc", StringComparison.OrdinalIgnoreCase), lang: LangOf(f)))
            .OrderByDescending(x => x.lrc)
            .ThenBy(x => x.lang, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return found
            .Select((x, i) => new Sub(i, x.lang, Label(x.lang, x.lrc), x.path))
            .ToList();
    }

    public static bool Has(DownloadRecord rec) => List(rec).Count > 0;

    /// <summary>Language code from "Title.vi.srt" → "vi"; "" when the name carries none.</summary>
    private static string LangOf(string path)
    {
        var stem = Path.GetFileNameWithoutExtension(path);     // "Title.vi"
        var dot = stem.LastIndexOf('.');
        if (dot < 0) return "";
        var code = stem[(dot + 1)..];
        // Only treat it as a language tag if it looks like one ("vi", "en", "pt-BR").
        return code.Length is >= 2 and <= 5 && code.All(c => char.IsLetter(c) || c == '-')
            ? code.ToLowerInvariant() : "";
    }

    private static readonly Dictionary<string, string> Names = new(StringComparer.OrdinalIgnoreCase)
    {
        ["vi"] = "Tiếng Việt", ["en"] = "English", ["zh"] = "中文", ["ja"] = "日本語",
        ["ko"] = "한국어", ["fr"] = "Français", ["es"] = "Español", ["de"] = "Deutsch",
    };

    private static string Label(string lang, bool lrc)
    {
        var name = lang.Length == 0 ? "Lyrics"
            : Names.TryGetValue(lang, out var n) ? n : lang.ToUpperInvariant();
        return lrc ? name + " (LRC)" : name;
    }

    public static IReadOnlyList<LyricLine> Load(DownloadRecord rec, int index = 0)
    {
        var subs = List(rec);
        if (subs.Count == 0) return Array.Empty<LyricLine>();
        var sub = subs[Math.Clamp(index, 0, subs.Count - 1)];
        try
        {
            var text = File.ReadAllText(sub.Path, Encoding.UTF8);
            var lines = sub.Path.EndsWith(".lrc", StringComparison.OrdinalIgnoreCase)
                ? ParseLrc(text)
                : ParseSrt(text);
            return Clean(lines);
        }
        catch (IOException) { return Array.Empty<LyricLine>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<LyricLine>(); }
    }

    // "00:01:02,340 --> 00:01:05,000" then one or more text lines, blank-line separated.
    private static List<LyricLine> ParseSrt(string text)
    {
        var outp = new List<LyricLine>();
        foreach (var block in text.Replace("\r\n", "\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            var rows = block.Split('\n', StringSplitOptions.TrimEntries);
            var arrow = Array.FindIndex(rows, r => r.Contains("-->"));
            if (arrow < 0) continue;

            var stamp = rows[arrow].Split("-->")[0].Trim();
            if (!TryStamp(stamp, out var t)) continue;

            var body = string.Join(' ', rows.Skip(arrow + 1)).Trim();
            body = TagRx().Replace(body, "").Trim();          // strip <i>, <c.colorE5E5E5> etc.
            if (body.Length == 0) continue;                    // YouTube emits blank spacer cues
            outp.Add(new LyricLine(t, body));
        }
        return outp;
    }

    // "[mm:ss.xx] text", optionally several stamps on one line.
    private static List<LyricLine> ParseLrc(string text)
    {
        var outp = new List<LyricLine>();
        foreach (var row in text.Replace("\r\n", "\n").Split('\n'))
        {
            var stamps = LrcRx().Matches(row);
            if (stamps.Count == 0) continue;
            var body = LrcRx().Replace(row, "").Trim();
            if (body.Length == 0) continue;
            foreach (Match m in stamps)
            {
                var min = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                var sec = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                outp.Add(new LyricLine(min * 60 + sec, body));
            }
        }
        return outp;
    }

    private static bool TryStamp(string s, out double seconds)
    {
        seconds = 0;
        var m = SrtRx().Match(s);
        if (!m.Success) return false;
        seconds = int.Parse(m.Groups[1].Value) * 3600
                + int.Parse(m.Groups[2].Value) * 60
                + int.Parse(m.Groups[3].Value)
                + int.Parse(m.Groups[4].Value) / 1000.0;
        return true;
    }

    /// <summary>Order by time and drop repeats. Auto-captions roll the same phrase across
    /// consecutive cues, which would make the karaoke view stutter on duplicates.</summary>
    private static List<LyricLine> Clean(List<LyricLine> lines)
    {
        lines.Sort((a, b) => a.T.CompareTo(b.T));
        var outp = new List<LyricLine>(lines.Count);
        foreach (var l in lines)
        {
            if (outp.Count > 0 && string.Equals(outp[^1].Text, l.Text, StringComparison.Ordinal)) continue;
            outp.Add(l);
        }
        return outp;
    }

    [GeneratedRegex(@"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})")] private static partial Regex SrtRx();
    [GeneratedRegex(@"\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]")] private static partial Regex LrcRx();
    [GeneratedRegex(@"<[^>]+>")] private static partial Regex TagRx();
}
