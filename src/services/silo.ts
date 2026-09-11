import { randomUUID } from 'node:crypto';
import { buildInfo } from '../lib/build-info.js';
import type { MediaFileRow, MediaItemRow } from '../types.js';
import type { SiloPlaybackRequestProfile } from './playback/playback-policy.js';

export class SiloApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'SiloApiError';
  }
}

export interface SiloHealth {
  status: string;
  server_name?: string;
  server_id?: string;
}

export interface SiloProfile {
  id: string;
  name: string;
  primary?: boolean;
  pin_required?: boolean;

  [key: string]: unknown;
}

interface SiloProfilesResponse {
  profiles: SiloProfile[];
  avatar_upload_enabled?: boolean;
}

export interface SiloVersion {
  file_id: number;
  file_path: string;
  file_name?: string;
  resolution?: string;
  codec_video?: string;
  codec_audio?: string;
  container?: string;

  [key: string]: unknown;
}

export interface SiloEpisodeReference {
  season: number;
  episode: number;
}

export interface SiloPlaybackStream {
  url: string;
  protocol: string;
  container?: string;
  mime_type?: string;
  headers: Record<string, string>;
  header_refresh: string;
  header_refresh_url?: string;

  [key: string]: unknown;
}

export interface SiloPlaybackPlan {
  delivery: string;
  stream: SiloPlaybackStream;
  decision_reason?: string;
  effective_recipe?: {
    video_codec?: string;
    audio_codec?: string;
    dynamic_range?: string;
    width?: number;
    height?: number;

    [key: string]: unknown;
  };
  transformations?: Array<{
    name?: string;
    executor?: string;

    [key: string]: unknown;
  }>;

  [key: string]: unknown;
}

export interface SiloPlaybackDecision {
  protocol_version: 3;
  server_features: string[];
  outcome: string;
  session_id?: string;
  playback_plan?: SiloPlaybackPlan;
  terminal?: {
    reason: string;
    message: string;
    retryable: boolean;

    [key: string]: unknown;
  };

  [key: string]: unknown;
}

interface SiloPlaybackStartRequest {
  protocol_version: 3;
  client_features: string[];
  file_id: number;
  profile_id: string;
  playback_attempt_id: string;
  quality_preference: string;
  subtitle_fidelity_preference: 'preserve' | 'compatible';
  start_position: number;
  progress_persistence: 'server' | 'client';
  metered: boolean;

  client_capabilities: SiloPlaybackRequestProfile['clientCapabilities'];
  client_playback_context: {
    protocol_version: 3;
    app_version: string;
  } & SiloPlaybackRequestProfile['clientPlaybackContext'];
}

function seriesTvdbId(
  item: Pick<MediaItemRow, 'metadata_json'>
): number | null {
  try {
    const metadata = JSON.parse(
      item.metadata_json || '{}'
    ) as {
      external_ids?: {
        tvdb_id?: number | string | null;
      };
    };

    const value =
      Number(metadata.external_ids?.tvdb_id);

    return Number.isInteger(value) && value > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

export function siloContentId(
  item: Pick<
    MediaItemRow,
    'type' | 'tmdb_id' | 'metadata_json'
  >,
  episode?: SiloEpisodeReference
): string | null {
  if (item.type === 'movie') {
    return item.tmdb_id &&
      Number.isInteger(item.tmdb_id) &&
      item.tmdb_id > 0
      ? `movie-tmdb-${item.tmdb_id}`
      : null;
  }

  if (!episode) {
    return null;
  }

  if (
    !Number.isInteger(episode.season) ||
    episode.season < 0 ||
    !Number.isInteger(episode.episode) ||
    episode.episode < 1
  ) {
    return null;
  }

  const tvdbId = seriesTvdbId(item);

  return tvdbId
    ? `episode-tvdb-${tvdbId}-${episode.season}-${episode.episode}`
    : null;
}

export class SiloClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  private url(pathname: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    const path =
      pathname.startsWith('/')
        ? pathname
        : `/${pathname}`;

    return `${base}${path}`;
  }

  private async request<T>(
    pathname: string,
    init: RequestInit = {}
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new SiloApiError(
        'Silo URL is not configured.'
      );
    }

    if (!this.apiKey) {
      throw new SiloApiError(
        'Silo API key is not configured.'
      );
    }

    let response: Response;

    const headers = new Headers(init.headers);
    headers.set(
      'Authorization',
      `Bearer ${this.apiKey}`
    );

    if (!headers.has('Accept')) {
      headers.set('Accept', 'application/json');
    }

    try {
      response = await fetch(
        this.url(pathname),
        {
          ...init,
          signal:
            init.signal ??
            AbortSignal.timeout(10_000),
          headers
        }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown network error';

      throw new SiloApiError(
        `Could not connect to Silo: ${message}`
      );
    }

    if (!response.ok) {
      throw new SiloApiError(
        `Silo returned HTTP ${response.status}.`,
        response.status
      );
    }

    const contentType =
      response.headers.get('content-type') || '';

    if (!contentType.includes('application/json')) {
      throw new SiloApiError(
        'Silo returned an unexpected response.'
      );
    }

    return await response.json() as T;
  }

  async fetchMedia(
    pathname: string,
    init: RequestInit = {}
  ): Promise<Response> {
    if (!this.baseUrl) {
      throw new SiloApiError(
        'Silo URL is not configured.'
      );
    }

    if (!this.apiKey) {
      throw new SiloApiError(
        'Silo API key is not configured.'
      );
    }

    const headers = new Headers(init.headers);

    headers.set(
      'Authorization',
      `Bearer ${this.apiKey}`
    );

    let response: Response;

    try {
      response = await fetch(
        this.url(pathname),
        {
          ...init,
          signal:
            init.signal ??
            AbortSignal.timeout(60_000),
          headers
        }
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unknown network error';

      throw new SiloApiError(
        `Could not fetch Silo media: ${message}`
      );
    }

    return response;
  }

  health(): Promise<SiloHealth> {
    return this.request<SiloHealth>(
      '/api/v1/health'
    );
  }

  async profiles(): Promise<SiloProfile[]> {
    const response = await this.request<
      SiloProfile[] | { profiles?: SiloProfile[] }
    >(
      '/api/v1/profiles'
    );

    if (Array.isArray(response)) {
      return response;
    }

    if (Array.isArray(response.profiles)) {
      return response.profiles;
    }

    throw new SiloApiError(
      'Silo returned an unexpected profiles response.'
    );
  }

  versions(
    contentId: string
  ): Promise<SiloVersion[]> {
    return this.request<SiloVersion[]>(
      `/api/v1/catalog/items/${encodeURIComponent(contentId)}/versions`
    );
  }

  startPlayback(
    fileId: number,
    profileId: string,
    requestProfile: SiloPlaybackRequestProfile
  ): Promise<SiloPlaybackDecision> {
    const clientVersion = buildInfo().version;
    const body: SiloPlaybackStartRequest = {
      protocol_version: 3,

      client_features: [
        'playback_plan_v3',
        'neutral_playback_v3_contract_v1',
        'header_authenticated_media_v1'
      ],

      file_id: fileId,
      profile_id: profileId,
      playback_attempt_id: randomUUID(),

      quality_preference: requestProfile.qualityPreference,
      subtitle_fidelity_preference: 'compatible',

      start_position: 0,
      progress_persistence: 'client',
      metered: false,

      client_capabilities: requestProfile.clientCapabilities,

      client_playback_context: {
        protocol_version: 3,
        app_version: clientVersion,
        ...requestProfile.clientPlaybackContext
      }
    };

    return this.request<SiloPlaybackDecision>(
      '/api/v1/playback/start',
      {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),

        headers: {
          'Content-Type': 'application/json',
          'X-Profile-Id': profileId,
          'X-Silo-Client': 'Nuvi-Flow',
          'X-Silo-Client-Version': clientVersion
        },

        body: JSON.stringify(body)
      }
    );
  }

  async resolveFileId(
    item: Pick<
      MediaItemRow,
      'type' | 'tmdb_id' | 'metadata_json'
    >,
    file: Pick<MediaFileRow, 'absolute_path'>,
    episode?: SiloEpisodeReference
  ): Promise<number | null> {
    const contentId =
      siloContentId(item, episode);

    if (!contentId) {
      return null;
    }

    const versions =
      await this.versions(contentId);

    const match = versions.find(
      version =>
        version.file_path ===
        file.absolute_path
    );

    return match?.file_id ?? null;
  }
}
