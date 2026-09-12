import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const mediaItems = sqliteTable('media_items', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['movie', 'series'] }).notNull(),
  stremioId: text('stremio_id').notNull(),
  tmdbId: integer('tmdb_id'),
  imdbId: text('imdb_id'),
  title: text('title').notNull(),
  displayTitle: text('display_title'),
  year: integer('year'),
  description: text('description'),
  poster: text('poster'),
  background: text('background'),
  logo: text('logo'),
  genresJson: text('genres_json').notNull().default('[]'),
  castJson: text('cast_json').notNull().default('[]'),
  directorsJson: text('directors_json').notNull().default('[]'),
  runtimeMinutes: integer('runtime_minutes'),
  releaseDate: text('release_date'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [
  uniqueIndex('media_items_stremio_id_uq').on(table.stremioId),
  index('media_items_type_idx').on(table.type),
  uniqueIndex('media_items_tmdb_type_uq').on(table.type, table.tmdbId)
]);

export const mediaFiles = sqliteTable('media_files', {
  id: text('id').primaryKey(),
  libraryType: text('library_type', { enum: ['movie', 'series'] }).notNull(),
  absolutePath: text('absolute_path').notNull(),
  relativePath: text('relative_path').notNull(),
  size: integer('size').notNull(),
  mtimeMs: real('mtime_ms').notNull(),
  durationSeconds: real('duration_seconds'),
  bitrate: integer('bitrate'),
  videoCodec: text('video_codec'),
  audioCodec: text('audio_codec'),
  width: integer('width'),
  height: integer('height'),
  frameRate: real('frame_rate'),
  audioChannels: integer('audio_channels'),
  audioTracksJson: text('audio_tracks_json').notNull().default('[]'),
  audioLanguagesJson: text('audio_languages_json').notNull().default('[]'),
  subtitleTracksJson: text('subtitle_tracks_json').notNull().default('[]'),
  probeJson: text('probe_json').notNull().default('{}'),
  parsedTitle: text('parsed_title'),
  parsedYear: integer('parsed_year'),
  edition: text('edition'),
  quality: text('quality'),
  source: text('source'),
  season: integer('season'),
  episodeStart: integer('episode_start'),
  episodeEnd: integer('episode_end'),
  mediaItemId: text('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
  confidence: real('confidence'),
  manualOverride: integer('manual_override', { mode: 'boolean' }).notNull().default(false),
  status: text('status', { enum: ['matched', 'unmatched', 'ignored', 'error'] }).notNull(),
  compatibilityWarning: text('compatibility_warning'),
  error: text('error'),
  addedAt: integer('added_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull()
}, (table) => [
  uniqueIndex('media_files_path_uq').on(table.absolutePath),
  index('media_files_item_idx').on(table.mediaItemId),
  index('media_files_status_idx').on(table.status)
]);

export const siloFileMappings = sqliteTable('silo_file_mappings', {
  mediaFileId: text('media_file_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
  siloServerKey: text('silo_server_key').notNull(),
  siloFileId: integer('silo_file_id'),
  siloItemId: text('silo_item_id'),
  status: text('status', { enum: ['mapped', 'not_found', 'stale', 'error'] }).notNull(),
  mappedPath: text('mapped_path').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [
  uniqueIndex('silo_file_mappings_file_server_uq').on(table.mediaFileId, table.siloServerKey),
  index('silo_file_mappings_status_idx').on(table.status)
]);

export const playbackDevices = sqliteTable('playback_devices', {
  id: text('id').primaryKey(),
  identitySource: text('identity_source').notNull(),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull()
}, (table) => [
  index('playback_devices_last_seen_idx').on(table.lastSeenAt)
]);

export const deviceCapabilities = sqliteTable('device_capabilities', {
  deviceId: text('device_id').notNull().references(() => playbackDevices.id, { onDelete: 'cascade' }),
  category: text('category', { enum: [
    'max_resolution',
    'video_codec',
    'bit_depth',
    'container',
    'hdr',
    'audio_codec',
    'audio_passthrough',
    'subtitle'
  ] }).notNull(),
  capability: text('capability').notNull(),
  supported: integer('supported', { mode: 'boolean' }).notNull(),
  evidence: text('evidence', { enum: [
    'declared',
    'observed_success',
    'observed_failure',
    'user_override'
  ] }).notNull(),
  confidence: real('confidence').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  firstObservedAt: integer('first_observed_at').notNull(),
  lastObservedAt: integer('last_observed_at').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [
  uniqueIndex('device_capabilities_device_category_capability_uq')
    .on(table.deviceId, table.category, table.capability),
  index('device_capabilities_device_idx').on(table.deviceId),
  index('device_capabilities_evidence_idx').on(table.evidence)
]);

export const externalSubtitles = sqliteTable('external_subtitles', {
  id: text('id').primaryKey(),
  mediaFileId: text('media_file_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
  absolutePath: text('absolute_path').notNull(),
  relativePath: text('relative_path').notNull(),
  language: text('language'),
  format: text('format').notNull(),
  size: integer('size').notNull(),
  updatedAt: integer('updated_at').notNull()
}, (table) => [
  uniqueIndex('external_subtitles_path_uq').on(table.absolutePath),
  index('external_subtitles_file_idx').on(table.mediaFileId)
]);

export const episodeMetadata = sqliteTable('episode_metadata', {
  id: text('id').primaryKey(),
  mediaItemId: text('media_item_id').notNull().references(() => mediaItems.id, { onDelete: 'cascade' }),
  season: integer('season').notNull(),
  episode: integer('episode').notNull(),
  tmdbId: integer('tmdb_id'),
  title: text('title'),
  overview: text('overview'),
  still: text('still'),
  airDate: text('air_date'),
  runtimeMinutes: integer('runtime_minutes'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  updatedAt: integer('updated_at').notNull()
}, (table) => [
  uniqueIndex('episode_item_number_uq').on(table.mediaItemId, table.season, table.episode)
]);

export const tmdbCache = sqliteTable('tmdb_cache', {
  cacheKey: text('cache_key').primaryKey(),
  responseJson: text('response_json').notNull(),
  expiresAt: integer('expires_at').notNull(),
  updatedAt: integer('updated_at').notNull()
});

export const streamTokens = sqliteTable('stream_tokens', {
  jti: text('jti').primaryKey(),
  mediaFileId: text('media_file_id').notNull().references(() => mediaFiles.id, { onDelete: 'cascade' }),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false)
}, (table) => [index('stream_tokens_expiry_idx').on(table.expiresAt)]);

export const scanRuns = sqliteTable('scan_runs', {
  id: text('id').primaryKey(),
  mode: text('mode').notNull(),
  status: text('status').notNull(),
  discovered: integer('discovered').notNull().default(0),
  processed: integer('processed').notNull().default(0),
  matched: integer('matched').notNull().default(0),
  unmatched: integer('unmatched').notNull().default(0),
  errors: integer('errors').notNull().default(0),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  message: text('message')
});
