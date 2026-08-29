namespace YoutubeDownloader.Services;

/// <summary>
/// Orders titles the way a reader numbers them: "Phần 2" before "Phần 10". A plain string
/// sort reads digits as characters and puts 10 between 1 and 2, which for a 58-part
/// audiobook scrambles the whole thing — the exact case this exists for.
/// </summary>
public sealed class NaturalOrder : IComparer<string>
{
    public static readonly NaturalOrder Instance = new();

    private NaturalOrder() { }

    public int Compare(string? x, string? y)
    {
        if (ReferenceEquals(x, y)) return 0;
        if (x is null) return -1;
        if (y is null) return 1;

        int i = 0, j = 0;
        while (i < x.Length && j < y.Length)
        {
            if (char.IsDigit(x[i]) && char.IsDigit(y[j]))
            {
                var byNumber = CompareDigits(x, ref i, y, ref j);
                if (byNumber != 0) return byNumber;
            }
            else
            {
                // A digit run on one side and text on the other reads as an empty text run
                // there, so this always either returns or advances both sides — no spin.
                var a = ReadText(x, ref i);
                var b = ReadText(y, ref j);
                var byText = string.Compare(a, b, StringComparison.InvariantCultureIgnoreCase);
                if (byText != 0) return byText;
            }
        }

        // One ran out: the shorter title comes first, and ordinal breaks the last tie so
        // the order is total (two titles differing only in case must not compare equal).
        var byLeftover = (x.Length - i).CompareTo(y.Length - j);
        return byLeftover != 0 ? byLeftover : string.CompareOrdinal(x, y);
    }

    // Compared as digit strings rather than parsed: a video id or a year-month run in a
    // title can be longer than any integer type, and overflowing there would be silent.
    private static int CompareDigits(string x, ref int i, string y, ref int j)
    {
        var a = ReadDigits(x, ref i);
        var b = ReadDigits(y, ref j);
        return a.Length != b.Length ? a.Length - b.Length : a.SequenceCompareTo(b);
    }

    private static ReadOnlySpan<char> ReadDigits(string s, ref int i)
    {
        while (i < s.Length && s[i] == '0') i++;   // 007 and 7 are the same number
        var start = i;
        while (i < s.Length && char.IsDigit(s[i])) i++;
        return s.AsSpan(start, i - start);
    }

    private static string ReadText(string s, ref int i)
    {
        var start = i;
        while (i < s.Length && !char.IsDigit(s[i])) i++;
        return s[start..i];
    }
}
