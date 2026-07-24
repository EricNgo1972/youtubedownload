# YouTube Downloader (Blazor Server)

A .NET 8 **Blazor Server** web app that downloads a YouTube video as any
combination of **MP4** (video), **MP3** (audio) and **SRT** subtitles, and keeps
a **history** of everything you've downloaded so you can tell what's already done.

Built on [YoutubeExplode](https://github.com/Tyrrrz/YoutubeExplode); MP4 merging
and MP3 transcoding use [ffmpeg](https://ffmpeg.org/) (bundled in the container).

## Features

- **Download page** — paste a video URL, tick the outputs you want, watch a live
  progress bar over a SignalR circuit.
  - **MP4** — best video + audio merged, prefers ≤1080p, falls back to a combined
    stream (~720p) if ffmpeg is missing.
  - **MP3** — highest-bitrate audio transcoded to MP3 (raw audio if ffmpeg is missing).
  - **Subtitles** — every caption track saved as `Title.<lang>.srt`.
- **History page** — a JSON-backed list (title, author, formats, date, link).
  The download page warns you when a video is already in the history.

## Persistent data (survives redeploy)

Following the Maple fleet convention, the app writes all durable state — the
`downloads/` folder and `history.json` — under the hard-coded container path
**`/var/lib/mk-youtubedownloader`**, which the `Dockerfile` **symlinks onto
`/data`**. Mount a volume at `/data` and everything survives container
recreation on redeploy. (Outside a container the app just uses a `data/` folder
next to the binary — see below.)

## Deploy (container)

Deployment mirrors the other Maple apps: a manual GitHub Actions workflow builds
the image, verifies it serves `/health`, and pushes it to GHCR. Actual rollout is
done out-of-band by **mk-provisioning** from the catalog row the workflow prints.

- Workflow: **Actions → “Release Container” → Run workflow**, enter a version
  (e.g. `1.0.0`).
- Image: `ghcr.io/ericngo1972/youtubedownloader:<version>` (+ `:latest`).
- Internal port **8080**; liveness at `/health` (and `/api/health`).
- **Mount a persistent volume at `/data`.** `ffmpeg` is baked into the image.

### Run the container locally

```bash
docker compose up --build      # http://localhost:8080, state in the named volume

# or by hand, persisting to ./data on the host:
docker build -t mk-youtubedownloader .
docker run -d --name mk-youtubedownloader -p 8080:8080 \
  -v "$PWD/data:/data" mk-youtubedownloader
```

## Run locally (without Docker)

Requires the .NET 8 SDK and `ffmpeg` on your `PATH`.

```bash
dotnet run
```

Data goes to a `data/` folder next to the app unless you override it:

```bash
# choose where downloads + history are stored
export Storage__DataDirectory=/some/path      # Linux/macOS
set    Storage__DataDirectory=C:\some\path    # Windows
```

### Where ffmpeg is found

In order: `FFMPEG_PATH` env var → next to the executable → current directory →
system `PATH`.

## Configuration

| Setting        | Env var                  | Default                                                        |
|----------------|--------------------------|----------------------------------------------------------------|
| Data directory | `Storage__DataDirectory` | `/var/lib/mk-youtubedownloader` in-container (→ `/data`), else `data/` next to the app |
| HTTP port      | `ASPNETCORE_HTTP_PORTS`  | `8080` (container)                                             |
| ffmpeg path    | `FFMPEG_PATH`            | resolved from `PATH`                                           |

## Notes

- Only download content you have the right to download. Respect YouTube's Terms
  of Service and applicable copyright law.
- Downloads run as **server-side background jobs** — closing the browser tab
  doesn't cancel them (they're lost only if the server process itself restarts).
- The old lyrics→SRT `sync` console command was dropped in the Blazor rewrite; it
  remains in git history if needed.
