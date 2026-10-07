import { buildInfo } from '../lib/build-info.js';

export class JellyfinApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'JellyfinApiError';
  }
}

export interface JellyfinServerInfo {
  id: string;
  name: string;
  version: string;
  operatingSystem: string | null;
}

export interface JellyfinUser {
  id: string;
  name: string;
  disabled: boolean;
}

export interface JellyfinMediaCandidate {
  itemId: string;
  mediaSourceId: string;
  path: string;
}

interface JellyfinSystemInfoResponse {
  Id?: unknown;
  ServerName?: unknown;
  Version?: unknown;
  OperatingSystem?: unknown;
}

interface JellyfinUserResponse {
  Id?: unknown;
  Name?: unknown;
  Policy?: { IsDisabled?: unknown } | null;
}

interface JellyfinMediaSourceResponse {
  Id?: unknown;
  Path?: unknown;
}

interface JellyfinItemResponse {
  Id?: unknown;
  Path?: unknown;
  MediaSources?: unknown;
}

interface JellyfinItemsResponse {
  Items?: unknown;
  TotalRecordCount?: unknown;
}

const MEDIA_PAGE_SIZE = 200;
const MAX_MEDIA_PAGES = 5_000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JellyfinApiError(`Jellyfin returned an invalid ${field}.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

/**
 * Minimal authenticated Jellyfin control-plane client.
 *
 * Playback URLs intentionally remain out of this first boundary. The next
 * roadmap phase will add exact media mapping and server-selected PlaybackInfo
 * decisions without ever placing the access token in a player URL.
 */
export class JellyfinClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  async systemInfo(): Promise<JellyfinServerInfo> {
    const result = await this.get<JellyfinSystemInfoResponse>('/System/Info');
    return {
      id: requiredString(result.Id, 'server ID'),
      name: requiredString(result.ServerName, 'server name'),
      version: requiredString(result.Version, 'server version'),
      operatingSystem: typeof result.OperatingSystem === 'string' &&
        result.OperatingSystem.trim()
        ? result.OperatingSystem.trim()
        : null
    };
  }

  async users(): Promise<JellyfinUser[]> {
    const result = await this.get<unknown>('/Users');
    if (!Array.isArray(result)) {
      throw new JellyfinApiError('Jellyfin returned an invalid user list.');
    }
    return result.map((candidate, index) => {
      const user = candidate as JellyfinUserResponse;
      return {
        id: requiredString(user?.Id, `user ID at position ${index + 1}`),
        name: requiredString(user?.Name, `user name at position ${index + 1}`),
        disabled: user?.Policy?.IsDisabled === true
      };
    });
  }

  async mediaInventory(userId: string): Promise<JellyfinMediaCandidate[]> {
    const candidates: JellyfinMediaCandidate[] = [];
    const seen = new Set<string>();
    let startIndex = 0;

    for (let page = 0; page < MAX_MEDIA_PAGES; page += 1) {
      const result = await this.get<JellyfinItemsResponse>('/Items', {
        UserId: userId,
        Recursive: true,
        IncludeItemTypes: 'Movie,Episode',
        Fields: 'Path,MediaSources',
        EnableImages: false,
        EnableUserData: false,
        EnableTotalRecordCount: true,
        StartIndex: startIndex,
        Limit: MEDIA_PAGE_SIZE
      });
      if (!Array.isArray(result.Items)) {
        throw new JellyfinApiError('Jellyfin returned an invalid media inventory.');
      }

      for (const value of result.Items) {
        const item = value as JellyfinItemResponse;
        const itemId = optionalString(item?.Id);
        const itemPath = optionalString(item?.Path);
        const sources = Array.isArray(item?.MediaSources)
          ? item.MediaSources as JellyfinMediaSourceResponse[]
          : [];
        if (!itemId) continue;
        for (const source of sources) {
          const mediaSourceId = optionalString(source?.Id);
          const sourcePath = optionalString(source?.Path) ??
            (sources.length === 1 ? itemPath : null);
          if (!mediaSourceId || !sourcePath) continue;
          const key = `${itemId}\0${mediaSourceId}\0${sourcePath}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ itemId, mediaSourceId, path: sourcePath });
        }
      }

      const count = result.Items.length;
      startIndex += count;
      const total = typeof result.TotalRecordCount === 'number' &&
        Number.isFinite(result.TotalRecordCount)
        ? Math.max(0, Math.floor(result.TotalRecordCount))
        : null;
      if (count === 0 || (total !== null && startIndex >= total) ||
        (total === null && count < MEDIA_PAGE_SIZE)) {
        return candidates;
      }
    }

    throw new JellyfinApiError('Jellyfin media inventory exceeded the safe page limit.');
  }

  private async get<T>(
    pathname: string,
    query: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Emby-Token': this.apiKey,
          Authorization: `MediaBrowser Client="Nuvi-Flow", Device="Nuvi-Flow Server", DeviceId="nuvi-flow-server", Version="${buildInfo().version}", Token="${this.apiKey}"`
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      if (error instanceof JellyfinApiError) throw error;
      throw new JellyfinApiError('Jellyfin request failed.');
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new JellyfinApiError(
        `Jellyfin returned HTTP ${response.status}.`,
        response.status
      );
    }

    try {
      return await response.json() as T;
    } catch {
      throw new JellyfinApiError('Jellyfin returned an invalid JSON response.');
    }
  }
}
