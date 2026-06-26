# YouTube Video Downloader

A simple .NET 8.0 console application that downloads YouTube **videos and
playlists** using [YoutubeExplode](https://github.com/Tyrrrz/YoutubeExplode).

Run it, paste a URL, and it downloads to your **Downloads** folder:

- **Video + audio** merged into a single `.mp4` (H.264/AAC).
- **Prefers 1080p** — picks the best stream at or below 1080p (no giant 4K
  files), falling back to the highest available if 1080p isn't offered.
- **Subtitles** — every available caption track is saved as `Title.<lang>.srt`.
- **Playlists** — paste a playlist URL and it downloads every video into a
  sub-folder named after the playlist.

Merging requires [ffmpeg](https://ffmpeg.org/download.html). If ffmpeg isn't
found, the app falls back to a combined stream (max ~720p) so it still works.

## Requirements

- .NET 8.0 SDK (or a newer SDK able to target net8.0)
- ffmpeg on your `PATH` (for 1080p). Install on Windows with:
  `winget install Gyan.FFmpeg` — then open a new terminal.

## Usage

```bash
dotnet run
```

```
=== YouTube Video Downloader ===

Enter the public YouTube video or playlist URL: <paste here>
```

- **Video URL** (e.g. `https://www.youtube.com/watch?v=...` or `https://youtu.be/...`)
  → downloads that one video. A `&list=` parameter on a video URL is ignored;
  only a pure playlist URL triggers playlist mode.
- **Playlist URL** (e.g. `https://www.youtube.com/playlist?list=...`)
  → downloads every video in the playlist.

### Where ffmpeg is found

In order: `FFMPEG_PATH` env var → next to the executable → current directory →
system `PATH`.

```bash
set FFMPEG_PATH=C:\tools\ffmpeg\bin\ffmpeg.exe   # Windows
export FFMPEG_PATH=/usr/bin/ffmpeg               # Linux/macOS
```

## Notes

- Files are saved to `%USERPROFILE%\Downloads` (playlists go in a sub-folder).
- Only download content you have the right to download. Respect YouTube's
  Terms of Service and applicable copyright law.
