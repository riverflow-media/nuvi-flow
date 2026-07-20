import { parseJson } from '../lib/json.js';
import type { MediaFileRow, MediaItemRow } from '../types.js';

export interface StremioMetaPreview {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  imdbRating?: string;
}

export function catalogPreview(item: MediaItemRow): StremioMetaPreview {
  return withoutUndefined({
    id: item.stremio_id,
    type: item.type,
    name: item.display_title || item.title,
    poster: item.poster || undefined,
    background: item.background || undefined,
    logo: item.logo || undefined,
    description: item.description || undefined,
    releaseInfo: item.year ? String(item.year) : undefined,
    genres: parseJson<string[]>(item.genres_json, [])
  });
}

interface EpisodeRow {
  season: number;
  episode: number;
  title: string | null;
  overview: string | null;
  still: string | null;
  air_date: string | null;
  runtime_minutes: number | null;
}

export function fullMeta(item: MediaItemRow, episodes: EpisodeRow[] = []): Record<string, unknown> {
  const metadata = parseJson<Record<string, any>>(item.metadata_json, {});
  const base = {
    ...catalogPreview(item),
    moviedb_id: item.tmdb_id || undefined,
    imdb_id: item.imdb_id || undefined,
    runtime: item.runtime_minutes ? `${item.runtime_minutes} min` : undefined,
    released: item.release_date ? new Date(`${item.release_date}T00:00:00.000Z`).toISOString() : undefined,
    cast: parseJson<string[]>(item.cast_json, []),
    director: parseJson<string[]>(item.directors_json, []),
    country: metadata.origin_country?.join(', ') || metadata.production_countries?.map((country: any) => country.name).join(', ') || undefined
  };
  if (item.type === 'series') {
    return withoutUndefined({
      ...base,
      videos: episodes.map((episode) => withoutUndefined({
        id: `${item.stremio_id}:${episode.season}:${episode.episode}`,
        title: episode.title || `Episode ${episode.episode}`,
        overview: episode.overview || undefined,
        thumbnail: episode.still || undefined,
        released: episode.air_date ? new Date(`${episode.air_date}T00:00:00.000Z`).toISOString() : undefined,
        season: episode.season,
        episode: episode.episode,
        runtime: episode.runtime_minutes ? `${episode.runtime_minutes} min` : undefined
      }))
    });
  }
  return withoutUndefined(base);
}

export function qualityLabel(file: Pick<MediaFileRow, 'quality' | 'height'>): string {
  if (file.quality) return file.quality.toUpperCase();
  if (file.height) return `${file.height}p`;
  return 'Original quality';
}

export function audioLabel(file: Pick<MediaFileRow, 'audio_channels'>): string {
  if (!file.audio_channels) return 'Audio';
  if (file.audio_channels >= 8) return '7.1 Audio';
  if (file.audio_channels >= 6) return '5.1 Audio';
  if (file.audio_channels === 2) return 'Stereo Audio';
  return `${file.audio_channels}-channel Audio`;
}

export function streamTitle(file: Pick<MediaFileRow, 'quality' | 'height' | 'video_codec' | 'audio_channels'>): string {
  const codec = file.video_codec ? file.video_codec.toUpperCase().replace('H264', 'H.264').replace('HEVC', 'HEVC') : 'Original';
  return `Local File — ${qualityLabel(file)} ${codec} — ${audioLabel(file)}`;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}
