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
