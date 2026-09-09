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

function streamResolution(
  file: Pick<MediaFileRow, 'quality' | 'height'>
): string {
  if (file.height) {
    if (file.height >= 2160) return '4K';
    if (file.height >= 1440) return '1440p';
    if (file.height >= 1080) return '1080p';
    if (file.height >= 720) return '720p';
    if (file.height >= 480) return '480p';
    return `${file.height}p`;
  }

  const quality =
    file.quality?.toUpperCase() || '';

  if (
    quality.includes('2160') ||
    quality.includes('4K')
  ) {
    return '4K';
  }

  for (const resolution of [
    '1440',
    '1080',
    '720',
    '480'
  ]) {
    if (quality.includes(resolution)) {
      return `${resolution}p`;
    }
  }

  return file.quality
    ? file.quality.toUpperCase()
    : 'Original';
}

function videoCodecLabel(
  value: string | null
): string | null {
  if (!value) return null;

  const normalized =
    value.toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  if (
    normalized === 'h264' ||
    normalized === 'avc' ||
    normalized === 'avc1'
  ) {
    return 'H.264';
  }

  if (
    normalized === 'h265' ||
    normalized === 'hevc'
  ) {
    return 'HEVC';
  }

  if (normalized === 'av1') {
    return 'AV1';
  }

  if (normalized === 'vp9') {
    return 'VP9';
  }

  return value.toUpperCase();
}

function audioCodecLabel(
  value: string | null
): string | null {
  if (!value) return null;

  const normalized =
    value.toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  if (normalized === 'truehd') {
    return 'TrueHD';
  }

  if (
    normalized === 'eac3' ||
    normalized === 'eac3joc'
  ) {
    return 'EAC3';
  }

  if (normalized === 'ac3') {
    return 'AC3';
  }

  if (
    normalized === 'dtshdma' ||
    normalized === 'dtshd'
  ) {
    return 'DTS-HD MA';
  }

  if (normalized === 'dts') {
    return 'DTS';
  }

  if (normalized === 'aac') {
    return 'AAC';
  }

  if (normalized === 'flac') {
    return 'FLAC';
  }

  if (normalized === 'opus') {
    return 'Opus';
  }

  return value.toUpperCase();
}

function channelLabel(
  channels: number | null
): string | null {
  if (!channels) return null;
  if (channels >= 8) return '7.1';
  if (channels >= 6) return '5.1';
  if (channels === 2) return 'Stereo';

  return `${channels}ch`;
}

function streamSourceLabel(
  source: string | null
): string | null {
  if (!source) return null;

  const normalized =
    source.toLowerCase()
      .replace(/[^a-z0-9]/g, '');

  if (normalized.includes('remux')) {
    return 'REMUX';
  }

  if (normalized.includes('webdl')) {
    return 'WEB-DL';
  }

  if (normalized.includes('webrip')) {
    return 'WEBRip';
  }

  if (
    normalized.includes('bluray') ||
    normalized.includes('bdrip')
  ) {
    return 'BluRay';
  }

  if (normalized.includes('hdtv')) {
    return 'HDTV';
  }

  if (normalized.includes('dvd')) {
    return 'DVD';
  }

  return source;
}

function streamAudioLabel(
  file: Pick<
    MediaFileRow,
    'audio_codec' | 'audio_channels'
  >
): string | null {
  const codec =
    audioCodecLabel(file.audio_codec);

  const channels =
    channelLabel(file.audio_channels);

  return [codec, channels]
    .filter(Boolean)
    .join(' ') || null;
}

export function streamName(
  file: Pick<
    MediaFileRow,
    | 'quality'
    | 'height'
    | 'source'
    | 'video_codec'
  >
): string {
  const resolution =
    streamResolution(file);

  const source =
    streamSourceLabel(file.source);

  const codec =
    videoCodecLabel(file.video_codec);

  return [
    resolution,
    source || codec
  ]
    .filter(Boolean)
    .join(' • ');
}

export function streamTitle(
  file: Pick<
    MediaFileRow,
    | 'quality'
    | 'height'
    | 'source'
    | 'video_codec'
    | 'audio_codec'
    | 'audio_channels'
  >
): string {
  return [
    streamResolution(file),
    streamSourceLabel(file.source),
    videoCodecLabel(file.video_codec),
    streamAudioLabel(file)
  ]
    .filter(Boolean)
    .join(' • ');
}

export function streamDescription(
  file: Pick<
    MediaFileRow,
    | 'video_codec'
    | 'audio_codec'
    | 'audio_channels'
    | 'compatibility_warning'
  >
): string {
  const parts: string[] = [];

  const video =
    videoCodecLabel(file.video_codec);

  const audio =
    streamAudioLabel(file);

  if (video) parts.push(video);
  if (audio) parts.push(audio);

  if (file.compatibility_warning) {
    const warning =
      file.compatibility_warning.toLowerCase();

    if (warning.includes('truehd')) {
      parts.push(
        '⚠ TrueHD direct-play may vary'
      );
    } else if (warning.includes('eac3')) {
      parts.push(
        '⚠ EAC3 direct-play may vary'
      );
    } else {
      parts.push(
        '⚠ Direct-play compatibility may vary'
      );
    }
  }

  return parts.join(' • ');
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null)) as T;
}
