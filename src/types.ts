export type MediaType = 'movie' | 'series';

export interface MediaFileRow {
  id: string;
  library_type: MediaType;
  absolute_path: string;
  relative_path: string;
  size: number;
  mtime_ms: number;
  duration_seconds: number | null;
  bitrate: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  audio_channels: number | null;
  audio_tracks_json: string;
  audio_languages_json: string;
  subtitle_tracks_json: string;
  probe_json: string;
  parsed_title: string | null;
  parsed_year: number | null;
  edition: string | null;
  quality: string | null;
  source: string | null;
  season: number | null;
  episode_start: number | null;
  episode_end: number | null;
  media_item_id: string | null;
  confidence: number | null;
  manual_override: number;
  status: 'matched' | 'unmatched' | 'ignored' | 'error';
  compatibility_warning: string | null;
  error: string | null;
  added_at: number;
  updated_at: number;
  last_seen_at: number;
}

export interface MediaItemRow {
  id: string;
  type: MediaType;
  stremio_id: string;
  tmdb_id: number | null;
  imdb_id: string | null;
  title: string;
  display_title: string | null;
  year: number | null;
  description: string | null;
  poster: string | null;
  background: string | null;
  logo: string | null;
  genres_json: string;
  cast_json: string;
  directors_json: string;
  runtime_minutes: number | null;
  release_date: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

export interface SiloFileMappingRow {
  media_file_id: string;
  silo_server_key: string;
  silo_file_id: number | null;
  silo_item_id: string | null;
  status: 'mapped' | 'not_found' | 'stale' | 'error';
  mapped_path: string;
  updated_at: number;
}

export type PlaybackServerProvider = 'jellyfin' | 'plex';

export type PlaybackServerMappingReason =
  | 'no_exact_path'
  | 'ambiguous_exact_path'
  | 'invalid_provider_item'
  | 'local_file_changed';

export interface PlaybackServerMappingRow {
  media_file_id: string;
  provider: PlaybackServerProvider;
  server_key: string;
  provider_item_id: string | null;
  provider_media_id: string | null;
  provider_stream_path: string | null;
  status: 'mapped' | 'not_found' | 'stale' | 'error';
  reason: PlaybackServerMappingReason | null;
  mapped_path: string;
  updated_at: number;
}

export type DeviceCapabilityCategory =
  | 'max_resolution'
  | 'video_codec'
  | 'bit_depth'
  | 'container'
  | 'hdr'
  | 'audio_codec'
  | 'audio_passthrough'
  | 'subtitle';

export type DeviceCapabilityEvidence =
  | 'declared'
  | 'observed_success'
  | 'observed_failure'
  | 'user_override';

export interface PlaybackDeviceRow {
  id: string;
  identity_source: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface DeviceCapabilityRow {
  device_id: string;
  category: DeviceCapabilityCategory;
  capability: string;
  supported: number;
  evidence: DeviceCapabilityEvidence;
  confidence: number;
  success_count: number;
  failure_count: number;
  first_observed_at: number;
  last_observed_at: number;
  updated_at: number;
}

export interface PlaybackNetworkProfileRow {
  device_id: string;
  network_context_id: string;
  context_reliable: number;
  estimated_mbps: number;
  sample_count: number;
  confidence: number;
  first_observed_at: number;
  last_observed_at: number;
  expires_at: number;
}

export type PlaybackOutcomeProvider =
  | 'nuvi-flow'
  | 'silo'
  | 'fallback-addon';

export type PlaybackOutcomeRoute =
  | 'direct_file'
  | 'original_http'
  | 'server_remux_progressive'
  | 'server_remux_hls'
  | 'server_transcode_hls'
  | 'external_direct_http';

export type PlaybackOutcomeCode =
  | 'route_selected'
  | 'delivery_observed'
  | 'delivery_degraded'
  | 'quality_fallback_applied'
  | 'quality_fallback_failed'
  | 'capacity_unavailable'
  | 'media_unavailable'
  | 'plan_unavailable'
  | 'fallback_candidate_failed'
  | 'upstream_unavailable';

export type PlaybackOutcomeLevel = 'info' | 'warning' | 'error';

export type PlaybackOutcomeDomain =
  | 'none'
  | 'capacity'
  | 'source'
  | 'server'
  | 'transcoder'
  | 'transport'
  | 'ambiguous';

export interface PlaybackOutcomeRow {
  playback_id: string;
  code: PlaybackOutcomeCode;
  provider: PlaybackOutcomeProvider;
  route: PlaybackOutcomeRoute | null;
  level: PlaybackOutcomeLevel;
  failure_domain: PlaybackOutcomeDomain;
  reason: string | null;
  http_status: number | null;
  media_file_id: string | null;
  media_id: string | null;
  media_type: MediaType | null;
  season: number | null;
  episode: number | null;
  device_id: string | null;
  capability_evidence: number;
  first_observed_at: number;
  last_observed_at: number;
}

export interface ExternalSubtitleRow {
  id: string;
  media_file_id: string;
  absolute_path: string;
  relative_path: string;
  language: string | null;
  format: string;
  size: number;
  updated_at: number;
}
