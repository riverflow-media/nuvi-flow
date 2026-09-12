import { randomUUID } from 'node:crypto';
import type { MediaFileRow, MediaItemRow } from '../types.js';
import {
  SiloClient,
  siloContentId,
  type SiloEpisodeReference,
  type SiloHealth,
  type SiloPlaybackDecision,
  type SiloPlaybackPlan,
  type SiloProfile
} from './silo.js';
import {
  SiloFileMappingStore,
  siloServerKey
} from './silo-file-mappings.js';
import type { SettingsService } from './settings.js';
import type { SiloPlaybackRequestProfile } from './playback/playback-policy.js';

export interface SiloConnectionResult {
  health: SiloHealth;
  profiles: SiloProfile[];
}

export interface SiloPlaybackResult {
  fileId: number;
  playbackAttemptId: string;
  decision: SiloPlaybackDecision;
}

const MAPPED_FILE_REFRESH_MS = 24 * 60 * 60 * 1000;
const MISSING_FILE_RETRY_MS = 60 * 1000;

/**
 * Application-facing Silo boundary.
 *
 * Routes use this service instead of constructing protocol clients or handling
 * credentials directly. The low-level SiloClient remains responsible for HTTP,
 * authentication, timeouts, protocol-v3 payloads, and response validation.
 */
export class SiloService {
  constructor(
    private readonly settings: SettingsService,
    private readonly mappings?: SiloFileMappingStore
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
    file: Pick<MediaFileRow, 'id' | 'absolute_path'>,
    profileId: string,
    requestProfile: SiloPlaybackRequestProfile,
    episode?: SiloEpisodeReference
  ): Promise<SiloPlaybackResult | null> {
    const client = this.client();
    const serverKey = siloServerKey(this.settings.siloUrl);
    const existing = this.mappings?.get(file.id, serverKey);
    const negativeCacheIsFresh = existing?.status === 'not_found' &&
      existing.mapped_path === file.absolute_path &&
      Date.now() - existing.updated_at < MISSING_FILE_RETRY_MS;
    const mappedCacheIsFresh = existing?.status === 'mapped' &&
      existing.mapped_path === file.absolute_path &&
      Date.now() - existing.updated_at < MAPPED_FILE_REFRESH_MS;
    let fileId = mappedCacheIsFresh
      ? existing.silo_file_id
      : null;

    if (negativeCacheIsFresh) {
      return null;
    }

    if (fileId === null) {
      const contentId = siloContentId(item, episode);

      if (!contentId) {
        this.mappings?.record(
          file.id,
          serverKey,
          file.absolute_path,
          'not_found',
          null,
          null
        );
        return null;
      }

      try {
        fileId = await client.resolveFileId(item, file, episode);
      } catch (error) {
        this.mappings?.record(
          file.id,
          serverKey,
          file.absolute_path,
          'error',
          null,
          contentId
        );
        throw error;
      }

      this.mappings?.record(
        file.id,
        serverKey,
        file.absolute_path,
        fileId === null ? 'not_found' : 'mapped',
        fileId,
        contentId
      );
    }

    if (fileId === null) {
      return null;
    }

    const playbackAttemptId = randomUUID();

    return {
      fileId,
      playbackAttemptId,
      decision: await client.startPlayback(
        fileId,
        profileId,
        requestProfile,
        playbackAttemptId
      )
    };
  }

  replanPlaybackQuality(
    sessionId: string,
    profileId: string,
    playbackAttemptId: string,
    currentPlan: SiloPlaybackPlan,
    qualityPreference: string,
    requestProfile: SiloPlaybackRequestProfile,
    positionSeconds = 0
  ): Promise<SiloPlaybackDecision> {
    return this.client().replanPlaybackQuality(
      sessionId,
      profileId,
      playbackAttemptId,
      randomUUID(),
      currentPlan,
      qualityPreference,
      requestProfile,
      positionSeconds
    );
  }

  fetchMedia(
    pathname: string,
    init: RequestInit = {}
  ): Promise<Response> {
    return this.client().fetchMedia(pathname, init);
  }

  async keepPlaybackAlive(pathname: string): Promise<boolean> {
    const response = await this.fetchMedia(pathname, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(10_000)
    });
    await response.body?.cancel();
    return response.ok;
  }
}
