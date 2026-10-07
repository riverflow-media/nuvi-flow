import type { SettingsService } from './settings.js';
import type {
  MediaFileRow,
  PlaybackServerMappingRow,
  PlaybackServerProvider
} from '../types.js';
import {
  JellyfinClient,
  type JellyfinServerInfo,
  type JellyfinUser
} from './jellyfin.js';
import {
  PlexClient,
  type PlexLibrary,
  type PlexServerInfo
} from './plex.js';
import {
  normalizeMediaPath,
  parsePathPrefixMappings,
  playbackServerKey,
  PlaybackServerMappingStore,
  translateMediaPath,
  type PlaybackServerMappingCandidate,
  type PlaybackServerMappingSummary
} from './playback-server-mappings.js';

export interface JellyfinConnectionResult {
  server: JellyfinServerInfo;
  users: JellyfinUser[];
}

export interface PlexConnectionResult {
  server: PlexServerInfo;
  libraries: PlexLibrary[];
}

export interface PlaybackServerMappingRefreshResult {
  provider: PlaybackServerProvider;
  serverKey: string;
  summary: PlaybackServerMappingSummary;
}

export class PlaybackServerMappingError extends Error {
  constructor(
    message: string,
    public readonly provider: PlaybackServerProvider
  ) {
    super(message);
    this.name = 'PlaybackServerMappingError';
  }
}

const emptySummary = (): PlaybackServerMappingSummary => ({
  total: 0,
  mapped: 0,
  pending: 0,
  stale: 0,
  notFound: 0,
  ambiguous: 0,
  errors: 0,
  refreshDue: 0,
  lastUpdatedAt: null
});

/**
 * Application-facing boundary for optional playback-server providers.
 *
 * Routes and diagnostics use this service rather than handling provider
 * credentials or protocol clients directly. Playback negotiation is added in
 * later roadmap phases behind this same boundary.
 */
export class PlaybackServersService {
  private readonly pendingRefreshes = new Map<
    PlaybackServerProvider,
    Promise<PlaybackServerMappingRefreshResult>
  >();

  constructor(
    private readonly settings: SettingsService,
    private readonly mappings?: PlaybackServerMappingStore
  ) {}

  async testJellyfin(
    baseUrl = this.settings.jellyfinUrl,
    apiKey = this.settings.jellyfinApiKey
  ): Promise<JellyfinConnectionResult> {
    const client = new JellyfinClient(baseUrl, apiKey);
    const [server, users] = await Promise.all([
      client.systemInfo(),
      client.users()
    ]);
    return { server, users };
  }

  async testPlex(
    baseUrl = this.settings.plexUrl,
    token = this.settings.plexToken
  ): Promise<PlexConnectionResult> {
    const client = new PlexClient(baseUrl, token);
    const [server, libraries] = await Promise.all([
      client.serverInfo(),
      client.libraries()
    ]);
    return { server, libraries };
  }

  mappingSummary(
    provider: PlaybackServerProvider,
    serverId: string
  ): PlaybackServerMappingSummary {
    if (!this.mappings) return emptySummary();
    const rules = parsePathPrefixMappings(
      provider === 'jellyfin'
        ? this.settings.jellyfinPathMappings || ''
        : this.settings.plexPathMappings || ''
    );
    return this.mappings.summary(
      provider,
      playbackServerKey(provider, serverId),
      rules
    );
  }

  refreshMappings(
    provider: PlaybackServerProvider,
    force = true
  ): Promise<PlaybackServerMappingRefreshResult> {
    const pending = this.pendingRefreshes.get(provider);
    if (pending) return pending;
    const refresh = this.performMappingRefresh(provider, force)
      .finally(() => {
        if (this.pendingRefreshes.get(provider) === refresh) {
          this.pendingRefreshes.delete(provider);
        }
      });
    this.pendingRefreshes.set(provider, refresh);
    return refresh;
  }

  markMappingsStale(mediaFileId: string): void {
    this.mappings?.markStale(mediaFileId);
  }

  async resolveMapping(
    provider: PlaybackServerProvider,
    file: Pick<MediaFileRow, 'id' | 'absolute_path'>
  ): Promise<PlaybackServerMappingRow | null> {
    if (!this.mappings) return null;
    const result = await this.refreshMappings(provider, false);
    const row = this.mappings.get(provider, result.serverKey, file.id);
    const rules = parsePathPrefixMappings(
      provider === 'jellyfin'
        ? this.settings.jellyfinPathMappings || ''
        : this.settings.plexPathMappings || ''
    );
    const mappedPath = translateMediaPath(file.absolute_path, rules);
    return row?.status === 'mapped' && row.mapped_path === mappedPath
      ? row
      : null;
  }

  private async performMappingRefresh(
    provider: PlaybackServerProvider,
    force: boolean
  ): Promise<PlaybackServerMappingRefreshResult> {
    if (!this.mappings) {
      throw new PlaybackServerMappingError(
        'Playback-server mapping storage is unavailable.',
        provider
      );
    }
    const pathMappings = parsePathPrefixMappings(
      provider === 'jellyfin'
        ? this.settings.jellyfinPathMappings || ''
        : this.settings.plexPathMappings || ''
    );
    const eligibleFiles = this.mappings.eligibleFiles();

    let serverId: string;
    let inventory: Array<{
      itemId: string;
      mediaId: string;
      streamPath: string | null;
      path: string;
    }> | null = null;

    if (provider === 'jellyfin') {
      if (!this.settings.jellyfinUrl || !this.settings.jellyfinApiKey ||
        !this.settings.jellyfinUserId) {
        throw new PlaybackServerMappingError(
          'Jellyfin mapping configuration is incomplete.',
          provider
        );
      }
      const client = new JellyfinClient(
        this.settings.jellyfinUrl,
        this.settings.jellyfinApiKey
      );
      serverId = (await client.systemInfo()).id;
      const serverKey = playbackServerKey(provider, serverId);
      if (eligibleFiles.length === 0) {
        return {
          provider,
          serverKey,
          summary: this.mappings.summary(provider, serverKey, pathMappings)
        };
      }
      if (!force && !this.mappings.needsRefresh(
        provider,
        serverKey,
        pathMappings
      )) {
        return {
          provider,
          serverKey,
          summary: this.mappings.summary(provider, serverKey, pathMappings)
        };
      }
      inventory = (await client.mediaInventory(this.settings.jellyfinUserId))
        .map(candidate => ({
          itemId: candidate.itemId,
          mediaId: candidate.mediaSourceId,
          streamPath: null,
          path: candidate.path
        }));
    } else {
      if (!this.settings.plexUrl || !this.settings.plexToken) {
        throw new PlaybackServerMappingError(
          'Plex mapping configuration is incomplete.',
          provider
        );
      }
      const client = new PlexClient(
        this.settings.plexUrl,
        this.settings.plexToken
      );
      serverId = (await client.serverInfo()).id;
      const serverKey = playbackServerKey(provider, serverId);
      if (eligibleFiles.length === 0) {
        return {
          provider,
          serverKey,
          summary: this.mappings.summary(provider, serverKey, pathMappings)
        };
      }
      if (!force && !this.mappings.needsRefresh(
        provider,
        serverKey,
        pathMappings
      )) {
        return {
          provider,
          serverKey,
          summary: this.mappings.summary(provider, serverKey, pathMappings)
        };
      }
      const libraries = await client.libraries();
      inventory = (await client.mediaInventory(libraries)).map(candidate => ({
        itemId: candidate.ratingKey,
        mediaId: candidate.partId,
        streamPath: candidate.partKey,
        path: candidate.path
      }));
    }

    const serverKey = playbackServerKey(provider, serverId);
    const byPath = new Map<string, typeof inventory>();
    for (const candidate of inventory) {
      const key = normalizeMediaPath(candidate.path);
      const existing = byPath.get(key) ?? [];
      existing.push(candidate);
      byPath.set(key, existing);
    }

    const records: PlaybackServerMappingCandidate[] =
      eligibleFiles.map(file => {
        const mappedPath = translateMediaPath(file.absolute_path, pathMappings);
        const matches = byPath.get(normalizeMediaPath(mappedPath)) ?? [];
        if (matches.length === 1) {
          const match = matches[0]!;
          return {
            mediaFileId: file.id,
            mappedPath,
            status: 'mapped',
            reason: null,
            providerItemId: match.itemId,
            providerMediaId: match.mediaId,
            providerStreamPath: match.streamPath
          };
        }
        return {
          mediaFileId: file.id,
          mappedPath,
          status: matches.length ? 'error' : 'not_found',
          reason: matches.length
            ? 'ambiguous_exact_path'
            : 'no_exact_path',
          providerItemId: null,
          providerMediaId: null,
          providerStreamPath: null
        };
      });
    this.mappings.recordBatch(provider, serverKey, records);

    return {
      provider,
      serverKey,
      summary: this.mappings.summary(provider, serverKey, pathMappings)
    };
  }
}
