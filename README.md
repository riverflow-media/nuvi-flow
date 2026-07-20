# Personal Media Addon

Personal Media Addon turns folders of movies and TV shows into a private, searchable Stremio-compatible addon. It scans files in place, adds metadata automatically, and streams the original files with seek support. It is available as a Windows desktop app and a hardened Docker/CasaOS/ZimaOS service.

## What it does

- Automatic metadata through TMDB when configured, with zero-configuration Cinemeta and local fallbacks
- Movie, series, multi-episode, special, season-folder, `S01E01`, `1x01`, and documentary `E01` filename support
- Posters, backgrounds, episode artwork, descriptions, cast, genres, and technical media details
- Four searchable Stremio catalogs: movies, series, recently added movies, and recently added series
- Direct streaming with HTTP byte ranges, `HEAD`, seeking, external subtitles, and signed URLs
- Password-protected dashboard with scans, matching corrections, settings, health, and logs
- SQLite persistence, incremental scans, file watching, bounded concurrency, and isolated scan errors
- No transcoding and no media-file writes

## Windows

Download `PersonalMediaAddonSetup.exe` from the latest GitHub release and run it. On first launch:

1. Choose the Movies folder.
2. Choose the TV Shows folder.
3. Set an admin password of at least 12 characters.
4. Keep `http://127.0.0.1:60500` when your Stremio-compatible player runs on the same PC. For another device on your LAN, use the Windows PC's LAN address instead.
5. Optionally enable start at login.

The desktop app stores its database and encrypted settings under the current Windows user's application-data directory. Movie and TV files are opened for reading; they are not renamed, moved, deleted, or edited.

The first public Windows installer is unsigned, so Windows SmartScreen may display an unrecognized-publisher warning. Code signing can be added to the release workflow once a Windows signing certificate is available.

### Build the Windows installer

Use Windows 10/11 with Node.js 22:

```powershell
npm ci
npm test
npm run make:windows
```

Installers and the portable ZIP are written under `out/make/`. Electron Forge rebuilds the native SQLite dependency for Electron during packaging.

## Docker, CasaOS, and ZimaOS

Copy the example environment file and edit it:

```bash
cp .env.example .env
```

Set absolute paths for `MOVIES_PATH` and `TV_PATH`, then create three unique values for `ADMIN_PASSWORD`, `SESSION_SECRET`, and `STREAM_SECRET`. The two secrets must each contain at least 32 random characters.

Start the service:

```bash
docker compose up -d --build
docker compose ps
```

Open:

- Dashboard: `http://localhost:60500/admin`
- Health: `http://localhost:60500/health`
- Addon manifest: `http://localhost:60500/manifest.json`

The Compose definition enforces these storage boundaries:

| Container path | Access | Purpose |
| --- | --- | --- |
| `/media/movies` | Read-only | Movie files |
| `/media/tv` | Read-only | TV files |
| `/app/data` | Writable | Database and app settings only |

The container also uses a read-only root filesystem, a non-root account, `no-new-privileges`, and a temporary in-memory `/tmp`.

Once the repository's container workflow publishes an image, set `IMAGE_NAME=ghcr.io/squipy411/personal-media-addon:latest` in `.env` and run `docker compose pull && docker compose up -d`. Remove the `build:` block if you want pull-only deployments.

## Add it to Stremio or Nuvio

1. Confirm the health endpoint reports `"status":"ok"`.
2. In the player's addon area, choose installation by manifest URL.
3. Enter `http://YOUR-SERVER:60500/manifest.json`.
4. Open Personal Movies or Personal Series.

Do not expose the service directly to the public internet without an authenticated network layer. Signed stream links protect media URLs, but the addon catalog itself is designed primarily for a trusted home network.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `60500` | Published host port |
| `BASE_URL` | `http://localhost:60500` | URL embedded in stream and subtitle links |
| `TMDB_API_KEY` | empty | Optional TMDB v3 key or v4 read token |
| `ADMIN_USERNAME` | `admin` | Initial dashboard username |
| `ADMIN_PASSWORD` | required | Initial dashboard password |
| `SESSION_SECRET` | required | Dashboard-session signing secret |
| `STREAM_SECRET` | required | Independent media-link signing secret |
| `MOVIES_PATH` | required | Absolute host Movies folder |
| `TV_PATH` | required | Absolute host TV Shows folder |
| `SCAN_INTERVAL_MINUTES` | `30` | Scheduled scan frequency |
| `MINIMUM_FILE_SIZE_MB` | `50` | Ignore smaller files |
| `SCAN_CONCURRENCY` | `2` | Concurrent metadata/inspection work |
| `WATCH_MEDIA` | `true` | Watch library folders for changes |
| `SCAN_ON_STARTUP` | `true` | Scan after startup |

Changing `ADMIN_PASSWORD` in `.env` does not replace the password already stored in an existing database. Change it in the dashboard or recreate only the app-data volume.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
npm start
```

The server requires Node.js 22 or newer. Tests cover the admin API and UI, HTTP range behavior, security, filename parsing, metadata fallbacks, and Stremio builders.

## Privacy and metadata

Library titles are sent to the configured metadata provider during matching. With no TMDB credential, the app queries Cinemeta automatically. Media bytes stay on your server and are streamed directly to your player.

## License

MIT. See [LICENSE](LICENSE).
