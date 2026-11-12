using YoutubeDownloader.Models;

namespace YoutubeDownloader.Services;

/// <summary>One playable track as every player sees it: the phone's own player through
/// /api/playlists, and a paired player box through a "play" command.</summary>
public sealed record ManifestTrack(string Url, bool Pending, string Title, string Author, string Duration, bool Lyrics);

/// <summary>
/// Resolves a playlist's record ids to playable tracks. Shared by /api/playlists and the
/// player boxes so both play the exact same URLs. A box that has already saved a track
/// for offline then finds it in its cache under the same key the phone would use.
/// </summary>
public static class PlaylistManifest
{
    public static List<ManifestTrack> Tracks(Playlist pl, HistoryService history) =>
        pl.RecordIds
            .Select(rid => (rid, rec: history.Get(rid)))
            .Where(x => x.rec is not null)
            .Select(x => (x.rid, rec: x.rec!, idx: Media.FirstAudioIndex(x.rec!)))
            // A downloaded track plays from disk; a track that is still only a link plays
            // via the relay. Either way it has a URL, so the player needs no special case.
            // The difference shows up as "not saved on this phone", which is the truth.
            .Where(x => x.idx >= 0 || x.rec.Pending)
            .Select(x => new ManifestTrack(
                Url: x.idx >= 0 ? $"/stream/{x.rid}/{x.idx}" : $"/preview/{x.rid}",
                Pending: x.idx < 0,
                Title: x.rec.Title,
                // Blanked for uploads, where "Uploaded" is a placeholder rather than an
                // artist. It would otherwise show as the artist in the player and on the
                // lock screen.
                Author: TrackVisuals.Artist(x.rec.Author),
                Duration: TrackVisuals.Duration(x.rec.Duration),
                Lyrics: LyricsService.Has(x.rec)))
            .ToList();
}
