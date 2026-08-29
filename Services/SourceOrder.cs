namespace YoutubeDownloader.Services;

/// <summary>
/// Puts tracks back into the order the link that added them listed them, from the position
/// each one recorded at that moment (see DownloadRecord.SourceIndex).
///
/// This is the exact answer where NaturalOrder is an inferred one: sorting by title works
/// only because an audiobook numbers its parts, and says nothing about a playlist of songs.
/// </summary>
public static class SourceOrder
{
    /// <summary>
    /// Orders <paramref name="items"/> by source playlist, then by position within it.
    /// Playlists appear in the order they first show up in the list as it stands, so
    /// reordering a mixed playlist does not shuffle its sections around. Tracks with no
    /// recorded position — uploads, single videos, anything added before positions were
    /// stored — keep their relative order at the end rather than claiming position zero.
    /// </summary>
    public static List<T> Apply<T>(IReadOnlyList<T> items, Func<T, string> playlistId, Func<T, int> index)
    {
        var groups = new List<string>();
        foreach (var item in items)
            if (index(item) >= 0 && !groups.Contains(playlistId(item))) groups.Add(playlistId(item));

        // OrderBy is stable, so the tail keeps the order it already had.
        return items.Where(i => index(i) >= 0)
            .OrderBy(i => groups.IndexOf(playlistId(i)))
            .ThenBy(i => index(i))
            .Concat(items.Where(i => index(i) < 0))
            .ToList();
    }
}
