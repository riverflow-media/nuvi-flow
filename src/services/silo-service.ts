import type { MediaFileRow, MediaItemRow } from '../types.js';
import {
  SiloClient,
  type SiloEpisodeReference,
  type SiloHealth,
  type SiloPlaybackDecision,
  type SiloProfile
} from './silo.js';
import type { SettingsService } from './settings.js';

export interface SiloConnectionResult {
  health: SiloHealth;
  profiles: SiloProfile[];
}

export interface SiloPlaybackResult {
  fileId: number;
  decision: SiloPlaybackDecision;
}

/**
 * Application-facing Silo boundary.
 *
 * Routes use this service instead of constructing protocol clients or handling
 * credentials directly. The low-level SiloClient remains responsible for HTTP,
 * authentication, timeouts, protocol-v3 payloads, and response validation.
 */
export class SiloService {
  constructor(
    private readonly settings: SettingsService
  ) {}

  private client(
    baseUrl = this.settings.siloUrl,
    apiKey = this.settings.siloApiKey
  ): SiloClient {
    return new SiloClient(baseUrl, apiKey);
  }

  async testConnection(
    baseUrl: string,
    apiKey: string
  ): Promise<SiloConnectionResult> {
    const client = this.client(baseUrl, apiKey);
    const [health, profiles] = await Promise.all([
      client.health(),
      client.profiles()
    ]);

    return { health, profiles };
  }

  async startPlaybackForMedia(
    item: Pick<MediaItemRow, 'type' | 'tmdb_id' | 'metadata_json'>,
    file: Pick<MediaFileRow, 'absolute_path'>,
    profileId: string,
    qualityPreference: string,
    episode?: SiloEpisodeReference
  ): Promise<SiloPlaybackResult | null> {
    const client = this.client();
    const fileId = await client.resolveFileId(item, file, episode);

    if (fileId === null) {
      return null;
    }

    return {
      fileId,
      decision: await client.startPlayback(
        fileId,
        profileId,
        qualityPreference
      )
    };
  }

  fetchMedia(
    pathname: string,
    init: RequestInit = {}
  ): Promise<Response> {
    return this.client().fetchMedia(pathname, init);
  }
}
