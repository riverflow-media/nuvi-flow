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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new JellyfinApiError(`Jellyfin returned an invalid ${field}.`);
  }
  return value.trim();
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

  private async get<T>(pathname: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
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
