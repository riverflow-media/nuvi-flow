# Nuvi-Flow

**Nuvi-Flow** is a self-hosted personal media addon for **Nuvio and Stremio-compatible clients**.

It scans your local movie, TV, and anime libraries, streams the original files directly, presents useful playback metadata in Nuvio, and can automatically request missing media through **Radarr** and **Sonarr** when you try to play something that is not already in your library.

Nuvi-Flow is based on [Squipy411/personal-media-addon](https://github.com/Squipy411/personal-media-addon) and extends it with automatic media requests, flexible Sonarr monitoring, anime-aware Sonarr support, richer Nuvio stream metadata, symlink-friendly scanning, request tracking, and customizable branding.

## Features

### Personal media streaming

- Movies and TV series from your own folders
- Optional separate Anime library directory
- Direct playback of original media files
- Nuvio-friendly stream names and technical metadata
- Resolution, source, video codec, audio codec, and channel information when available
- HTTP byte-range support for seeking
- External subtitle support
- Signed media URLs
- Mandatory private addon installation URLs
- Optional Silo-backed HLS transcoding
- No media-file modifications
- Searchable movie and series catalogs
- Recently added catalogs
- Posters, backdrops, episode artwork, descriptions, genres, cast, and technical metadata
- TMDB metadata when configured
- Automatic Cinemeta fallback

### Symlink-friendly libraries

Nuvi-Flow supports media files exposed through symlinks, making it suitable for setups using rclone, InfiniDysk, or other virtual/remote media mounts.

Symlinked media files are followed and scanned while the configured media directories can remain read-only.

### Silo playback

Nuvi-Flow can use a separate [Silo](https://github.com/Silo-Server/silo-server) server for authenticated HLS transcoding while keeping Silo credentials and internal container addresses away from Nuvio/Stremio clients.

The current integration provides:

- Original-file direct playback as the first stream option
- An optional fixed-quality Silo HLS stream
- Exact-path matching between Nuvi-Flow media files and Silo files
- Signed Nuvi-Flow URLs for Silo manifests and segments
- Server-side Silo authentication
- Concurrent playback-start coalescing
- Short-lived reuse of active Silo sessions, preventing repeated client requests from starting overlapping FFmpeg jobs
- A unique Nuvi-Flow playback ID in structured session logs and the `X-Nuvi-Flow-Playback-Id` response header

Automatic per-device direct-play, remux, audio-only transcode, HDR, and quality fallback decisions are planned but are not part of the current fixed-quality integration.

For exact-path matching to work, the same media file must have the same container path in Nuvi-Flow and Silo. For example, mount the library as `/media/movies` in both containers rather than `/media/movies` in one and `/movies` in the other.

### Automatic Radarr and Sonarr requests

When enabled, opening missing media in Nuvio can automatically send a request directly to Radarr or Sonarr.

No Seerr or Jellyseerr intermediary is required.

#### Movies

Missing movies are sent to Radarr using a configurable:

- Radarr URL
- API key
- Root folder
- Quality profile

Nuvi-Flow can add the movie and trigger a Radarr search automatically.

#### TV episodes

Missing TV episodes are sent directly to Sonarr.

Nuvi-Flow:

- Supports IMDb identifiers
- Supports TVDB identifiers
- Lets Sonarr resolve its own TVDB metadata
- Searches only the episode you attempted to play
- Can monitor only the requested episode or the entire series
- Can enable whole-series monitoring for series already present in Sonarr
- Can automatically monitor future seasons when whole-series monitoring is enabled
- Does not trigger an automatic search of the entire backlog
- Does not move or re-profile existing Sonarr series

If a new series must be added first, Nuvi-Flow waits briefly for Sonarr to populate its episode records before searching for the requested episode.

With **Requested episode only**, Nuvi-Flow monitors only the episode you requested.

With **Monitor entire series**, regular seasons and episodes are monitored in Sonarr, including future additions, while Nuvi-Flow still triggers an immediate search only for the episode requested in Nuvio. Specials keep their existing Sonarr monitoring state.

### Anime support

Anime can be configured independently from normal TV.

Nuvi-Flow supports:

- Optional separate Anime library directory
- Optional separate Sonarr Anime root folder
- Optional separate Sonarr Anime quality profile
- Automatic detection using Sonarr's `seriesType`
- Normal TV profile fallback when no Anime-specific profile is selected

Existing Sonarr series are never moved or re-profiled.

### Request queue

The admin dashboard includes a request queue for missing media sent to Radarr and Sonarr.

Statuses include:

- Pending
- Requested
- Searching
- Failed
- Added

**Added** means Nuvi-Flow has actually detected and matched the downloaded/imported media in the local library. It does not simply mean Radarr or Sonarr accepted the request.

Once media appears in the library:

1. The request changes to **Added**
2. It remains visible for about five minutes
3. The completed request is removed from the queue
4. Nuvi-Flow runs a follow-up changed-library scan

Failed requests remain visible and can be retried manually.

### Custom branding

Nuvi-Flow can be branded directly from the admin dashboard.

You can:

- Change the visible addon name
- Upload a custom PNG, JPG, or WEBP icon
- Replace the icon at any time
- Remove the custom icon to restore the default Nuvi-Flow icon

The same icon is used by:

- Nuvio/Stremio through the addon manifest
- The Nuvi-Flow admin interface

Uploaded branding is stored in the persistent `/app/data` volume.

## Admin dashboard

The password-protected dashboard provides:

- Library overview
- Recently added media
- Files needing review
- Manual metadata matching
- Scan history
- Changed-library scans
- Full rescans
- Automatic request history
- Failed-request retries
- Radarr connection testing
- Sonarr connection testing
- Silo connection and profile testing
- Silo transcode-quality selection
- Root-folder selection
- Quality-profile selection
- Requested-episode or whole-series Sonarr monitoring
- Anime-specific Sonarr settings
- Runtime configuration
- Custom addon name
- Custom addon icon
- Secure addon URL display and one-click regeneration
- Running version and Git commit badge

Saved Radarr and Sonarr API keys are never returned to the browser.

## Docker

### Build locally

```bash
git clone https://github.com/riverflow-media/nuvi-flow.git
cd nuvi-flow
cp .env.example .env
```

Edit `.env`, then start Nuvi-Flow:

```bash
docker compose up -d --build
docker compose ps
```

The container is ready when its status becomes `healthy` and the `/health` endpoint returns `{"status":"ok"}`.

Default endpoints:

- Admin: `http://localhost:60500/admin`
- Health: `http://localhost:60500/health`
- Secure manifest: copy it from **Admin → Settings**
- Addon icon: `http://localhost:60500/addon-icon`

### Persistent storage

`/app/data` contains:

- SQLite database
- Saved settings
- Uploaded addon icon

Do not delete this volume during normal upgrades if you want to preserve your configuration.

### Media mounts

The container only needs read access to your media.

Typical paths:

```text
/mnt/media/movies
/mnt/media/tv
/mnt/media/anime
```

Anime is optional.

## GitHub Container Registry

Nuvi-Flow images will be published as:

```text
ghcr.io/riverflow-media/nuvi-flow
```

Example:

```bash
docker pull ghcr.io/riverflow-media/nuvi-flow:latest
```

Each successful default-branch build publishes both `latest` and an immutable `sha-<commit>` tag. The image is published only after the automated test suite, typecheck, production build, Docker build, container startup, and Docker health check pass.

## Add Nuvi-Flow to Nuvio

Make sure the health endpoint returns `"status":"ok"`.

Open **Admin → Settings** and copy the generated **Nuvio addon manifest URL**. It has this form:

```text
https://YOUR-NUVI-FLOW-DOMAIN/addon/RANDOM-256-BIT-TOKEN/manifest.json
```

The token is created automatically on first startup and stored in the persistent database. The public `/manifest.json`, `/catalog`, `/meta`, and `/stream` routes are intentionally unavailable, so knowing the domain alone is not enough to use the addon.

Keep the installation URL private. If it may have been exposed, choose **Regenerate secure URL** in the dashboard. The prior URL stops working immediately, and Nuvi-Flow must be reinstalled in Nuvio with the replacement URL.

The Nuvi-Flow manifest ID is:

```text
community.nuviflow
```

If you previously installed Nuvi-Flow from `/manifest.json`, remove that installation and reinstall it using the secure URL shown in the dashboard.

## Automatic request setup

Open the Nuvi-Flow admin dashboard and go to:

**Settings → Automatic Requests**

Set **Missing media behavior** to:

```text
Automatically request missing media
```

### Radarr

Configure:

- Enable Radarr
- Radarr URL
- Radarr API key
- Movie root folder
- Movie quality profile

Use **Test Connection** to verify access.

### Sonarr

Configure:

- Enable Sonarr
- Sonarr URL
- Sonarr API key
- TV root folder
- TV quality profile
- Series monitoring mode:
  - **Requested episode only**
  - **Monitor entire series**

Whole-series monitoring does not automatically search or download the entire backlog. Nuvi-Flow still starts an immediate Sonarr search only for the episode requested in Nuvio.

Optional Anime settings:

- Separate Anime root folder
- Anime root folder
- Anime quality profile

The dashboard automatically loads the real Radarr/Sonarr root-folder and quality-profile names from the saved connection.

## How missing media works

When Nuvio asks Nuvi-Flow for a stream:

```text
Media exists locally
        ↓
Return local stream
```

When it is missing:

```text
Missing stream
        ↓
Nuvi-Flow creates/deduplicates a request
        ↓
Radarr or Sonarr
        ↓
Download/import
        ↓
Nuvi-Flow detects the new file or symlink
        ↓
Request becomes Added
        ↓
Visible for about 5 minutes
        ↓
Completed queue entry clears
```

A successful Radarr/Sonarr API request alone does **not** mark the media as Added.

## Configuration

Common environment variables include:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port, default `60500` |
| `BASE_URL` | Public URL used in manifest and stream links |
| `ADDON_NAME` | Default addon name |
| `TMDB_API_KEY` | Optional TMDB API credential |
| `ADMIN_USERNAME` | Initial admin username |
| `ADMIN_PASSWORD` | Initial admin password |
| `SESSION_SECRET` | Admin-session signing secret |
| `STREAM_SECRET` | Media-link signing secret |
| `MOVIES_PATH` | Movie library directory |
| `TV_PATH` | TV library directory |
| `ANIME_PATH` | Optional separate Anime library directory |
| `SCAN_INTERVAL_MINUTES` | Scheduled scan frequency |
| `MINIMUM_FILE_SIZE_MB` | Ignore files smaller than this |
| `SCAN_CONCURRENCY` | Concurrent scan work |
| `WATCH_MEDIA` | Watch media directories for changes |
| `SCAN_ON_STARTUP` | Scan after startup |
| `SILO_ENABLED` | Enable optional Silo playback |
| `SILO_URL` | Internal Silo base URL, such as `http://silo:8080` |
| `SILO_API_KEY` | Silo API key; never returned to the browser |
| `SILO_PROFILE_ID` | Silo playback profile ID |
| `SILO_TRANSCODE_QUALITY` | Fixed Silo quality rung used by the current integration |

Radarr, Sonarr, Silo, Anime root/profile selections, addon branding, and other runtime settings can be managed from the admin dashboard.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

Build a local Docker image:

```bash
docker build \
  --build-arg VERSION=dev \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  --build-arg SOURCE_URL=https://github.com/riverflow-media/nuvi-flow \
  -t nuvi-flow:local \
  .
```

## Windows

The project retains the upstream Electron-based Windows desktop build.

Build it on Windows with Node.js 22:

```powershell
npm ci
npm test
npm run typecheck
npm run make:windows
```

Artifacts are written beneath:

```text
out/make/
```

## Security

Nuvi-Flow is intended primarily for private/self-hosted use.

The admin dashboard requires authentication, media URLs are signed, and integration API keys are stored server-side.

If exposing Nuvi-Flow to the internet, place it behind a properly configured reverse proxy and restrict admin access appropriately.

## Privacy

Media remains on your server and is streamed directly to the player.

Library titles may be sent to the configured metadata provider while matching media.

## Fork and attribution

Nuvi-Flow is a modified fork of:

**Personal Media Addon**
https://github.com/Squipy411/personal-media-addon

The original Personal Media Addon copyright and MIT license notice are preserved in this repository. Nuvi-Flow-specific modifications are maintained separately in this fork.

Nuvi-Flow adds functionality focused on Nuvio integration, richer stream metadata, automatic Radarr/Sonarr requests, flexible Sonarr series monitoring, Anime handling, symlinked libraries, request lifecycle tracking, and customizable branding.

See [FORK_NOTICE.md](FORK_NOTICE.md) for additional attribution information.

## License

MIT. See [LICENSE](LICENSE).
