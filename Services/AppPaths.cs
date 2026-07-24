namespace YoutubeDownloader.Services;

/// <summary>
/// Resolves where durable state (downloads + history.json) lives.
///
/// Maple fleet convention: in the container the app writes to the hard-coded path
/// /var/lib/mk-youtubedownloader, which the Dockerfile symlinks onto the mounted
/// /data volume — so data survives container recreation on redeploy. Locally it
/// falls back to a "data" folder next to the app. An explicit Storage:DataDirectory
/// override always wins (used by local dev / tests).
/// </summary>
public static class AppPaths
{
    private const string ContainerStateRoot = "/var/lib/mk-youtubedownloader";

    public static string DataDir(IConfiguration config)
    {
        if (config["Storage:DataDirectory"] is { Length: > 0 } configured)
            return configured;

        // .NET base images set DOTNET_RUNNING_IN_CONTAINER=true; use the symlinked
        // state root there, and a local folder everywhere else.
        if (Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true")
            return ContainerStateRoot;

        return Path.Combine(AppContext.BaseDirectory, "data");
    }

    public static string DownloadsDir(IConfiguration config) =>
        Path.Combine(DataDir(config), "downloads");

    public static string HistoryFile(IConfiguration config) =>
        Path.Combine(DataDir(config), "history.json");

    public static string PlaylistsFile(IConfiguration config) =>
        Path.Combine(DataDir(config), "playlists.json");
}
