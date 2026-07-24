# syntax=docker/dockerfile:1

# ── Build ────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY YoutubeDownloader.csproj ./
RUN dotnet restore YoutubeDownloader.csproj
COPY . .
RUN dotnet publish YoutubeDownloader.csproj -c Release -o /app --no-restore

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime
WORKDIR /app

# ffmpeg: required for MP4 merging + MP3 transcoding.
# curl:   the aspnet:8.0 base (Debian slim) ships NEITHER curl NOR wget, so the
#         HEALTHCHECK below could never pass without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

# Durable state — downloads/ and history.json — is written under the hard-coded path
# /var/lib/mk-youtubedownloader (see AppPaths). Symlink it onto /data so all state
# lives on the mounted volume and survives container recreation on redeploy.
# Same trick as MK.WordViewer / MK.MemberList.
RUN mkdir -p /data && ln -s /data /var/lib/mk-youtubedownloader

ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD ["sh", "-c", "curl -fsS http://localhost:8080/health >/dev/null || exit 1"]

ENTRYPOINT ["dotnet", "YoutubeDownloader.dll"]
