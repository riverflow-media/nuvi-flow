export const migrations = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS media_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('movie','series')),
    stremio_id TEXT NOT NULL UNIQUE, tmdb_id INTEGER, imdb_id TEXT, title TEXT NOT NULL,
    display_title TEXT, year INTEGER, description TEXT, poster TEXT, background TEXT, logo TEXT,
    genres_json TEXT NOT NULL DEFAULT '[]', cast_json TEXT NOT NULL DEFAULT '[]',
    directors_json TEXT NOT NULL DEFAULT '[]', runtime_minutes INTEGER, release_date TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(type, tmdb_id)
  );
  CREATE INDEX IF NOT EXISTS media_items_type_idx ON media_items(type);
  CREATE TABLE IF NOT EXISTS media_files (
    id TEXT PRIMARY KEY, library_type TEXT NOT NULL CHECK(library_type IN ('movie','series')),
    absolute_path TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
    duration_seconds REAL, bitrate INTEGER, video_codec TEXT, audio_codec TEXT, width INTEGER, height INTEGER,
    frame_rate REAL, audio_channels INTEGER, audio_languages_json TEXT NOT NULL DEFAULT '[]',
    subtitle_tracks_json TEXT NOT NULL DEFAULT '[]', probe_json TEXT NOT NULL DEFAULT '{}',
    parsed_title TEXT, parsed_year INTEGER, edition TEXT, quality TEXT, source TEXT,
    season INTEGER, episode_start INTEGER, episode_end INTEGER,
    media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
    confidence REAL, manual_override INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK(status IN ('matched','unmatched','ignored','error')),
    compatibility_warning TEXT, error TEXT, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS media_files_item_idx ON media_files(media_item_id);
  CREATE INDEX IF NOT EXISTS media_files_status_idx ON media_files(status);
  CREATE TABLE IF NOT EXISTS external_subtitles (
    id TEXT PRIMARY KEY, media_file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    absolute_path TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL, language TEXT, format TEXT NOT NULL,
    size INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS external_subtitles_file_idx ON external_subtitles(media_file_id);
  CREATE TABLE IF NOT EXISTS episode_metadata (
    id TEXT PRIMARY KEY, media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
    season INTEGER NOT NULL, episode INTEGER NOT NULL, tmdb_id INTEGER, title TEXT, overview TEXT,
    still TEXT, air_date TEXT, runtime_minutes INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL, UNIQUE(media_item_id, season, episode)
  );
  CREATE TABLE IF NOT EXISTS tmdb_cache (
    cache_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS stream_tokens (
    jti TEXT PRIMARY KEY, media_file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS stream_tokens_expiry_idx ON stream_tokens(expires_at);
  CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, discovered INTEGER NOT NULL DEFAULT 0,
    processed INTEGER NOT NULL DEFAULT 0, matched INTEGER NOT NULL DEFAULT 0, unmatched INTEGER NOT NULL DEFAULT 0,
    errors INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL, finished_at INTEGER, message TEXT
  );`,
  `CREATE INDEX IF NOT EXISTS media_files_seen_idx ON media_files(last_seen_at);`,
  `ALTER TABLE media_files ADD COLUMN audio_tracks_json TEXT NOT NULL DEFAULT '[]';`,
  `CREATE TABLE IF NOT EXISTS media_requests (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,

    media_type TEXT NOT NULL CHECK(media_type IN ('movie','series')),
    stremio_id TEXT NOT NULL,

    imdb_id TEXT,
    tvdb_id INTEGER,

    season INTEGER,
    episode INTEGER,

    title TEXT,

    backend TEXT NOT NULL CHECK(backend IN ('radarr','sonarr')),
    backend_item_id INTEGER,

    status TEXT NOT NULL CHECK(status IN (
      'pending',
      'requested',
      'searching',
      'available',
      'failed'
    )),

    message TEXT,

    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS media_requests_status_idx
    ON media_requests(status);

  CREATE INDEX IF NOT EXISTS media_requests_updated_idx
    ON media_requests(updated_at);

  CREATE INDEX IF NOT EXISTS media_requests_imdb_idx
    ON media_requests(imdb_id);

  CREATE INDEX IF NOT EXISTS media_requests_tvdb_idx
    ON media_requests(tvdb_id);`,
  `CREATE TABLE IF NOT EXISTS silo_file_mappings (
    media_file_id TEXT NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    silo_server_key TEXT NOT NULL,
    silo_file_id INTEGER,
    silo_item_id TEXT,
    status TEXT NOT NULL CHECK(status IN ('mapped','not_found','stale','error')),
    mapped_path TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(media_file_id, silo_server_key)
  );

  CREATE INDEX IF NOT EXISTS silo_file_mappings_status_idx
    ON silo_file_mappings(status);`,
  `CREATE TABLE IF NOT EXISTS playback_devices (
    id TEXT PRIMARY KEY,
    identity_source TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS playback_devices_last_seen_idx
    ON playback_devices(last_seen_at);

  CREATE TABLE IF NOT EXISTS device_capabilities (
    device_id TEXT NOT NULL REFERENCES playback_devices(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK(category IN (
      'max_resolution',
      'video_codec',
      'bit_depth',
      'container',
      'hdr',
      'audio_codec',
      'audio_passthrough',
      'subtitle'
    )),
    capability TEXT NOT NULL,
    supported INTEGER NOT NULL CHECK(supported IN (0,1)),
    evidence TEXT NOT NULL CHECK(evidence IN (
      'declared',
      'observed_success',
      'observed_failure',
      'user_override'
    )),
    confidence REAL NOT NULL DEFAULT 0 CHECK(confidence >= 0 AND confidence <= 1),
    success_count INTEGER NOT NULL DEFAULT 0 CHECK(success_count >= 0),
    failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
    first_observed_at INTEGER NOT NULL,
    last_observed_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(device_id, category, capability)
  );

  CREATE INDEX IF NOT EXISTS device_capabilities_device_idx
    ON device_capabilities(device_id);

  CREATE INDEX IF NOT EXISTS device_capabilities_evidence_idx
    ON device_capabilities(evidence);`
] as const;
