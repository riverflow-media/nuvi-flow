import { buildInfo } from '../lib/build-info.js';

export class PlexApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'PlexApiError';
  }
}

export interface PlexServerInfo {
  id: string;
  name: string;
  version: string;
}

export interface PlexLibrary {
  id: string;
  name: string;
  type: string;
}

interface PlexContainer {
  MediaContainer?: {
    machineIdentifier?: unknown;
    friendlyName?: unknown;
    version?: unknown;
    Directory?: unknown;
  } | null;
}

interface PlexDirectory {
  key?: unknown;
  title?: unknown;
  type?: unknown;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlexApiError(`Plex returned an invalid ${field}.`);
  }
  return value.trim();
}

/**
 * Minimal authenticated Plex Media Server control-plane client.
 *
 * Nuvi-Flow's compatibility baseline deliberately requires no Plex Pass:
 * direct play, direct stream/remux, and software transcoding only. Hardware
 * acceleration and tone mapping are never treated as available requirements.
 */
export class PlexClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  async serverInfo(): Promise<PlexServerInfo> {
    const result = await this.get<PlexContainer>('/');
    const container = result.MediaContainer;
    if (!container) {
      throw new PlexApiError('Plex returned an invalid server response.');
    }
    return {
      id: requiredString(container.machineIdentifier, 'server ID'),
      name: requiredString(container.friendlyName, 'server name'),
      version: requiredString(container.version, 'server version')
    };
  }

  async libraries(): Promise<PlexLibrary[]> {
    const result = await this.get<PlexContainer>('/library/sections/all');
    const directories = result.MediaContainer?.Directory;
    if (!Array.isArray(directories)) {
      throw new PlexApiError('Plex returned an invalid library list.');
    }
    return directories.map((candidate, index) => {
      const directory = candidate as PlexDirectory;
      return {
        id: requiredString(directory?.key, `library ID at position ${index + 1}`),
        name: requiredString(directory?.title, `library name at position ${index + 1}`),
        type: requiredString(directory?.type, `library type at position ${index + 1}`)
      };
    });
  }

  private async get<T>(pathname: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${pathname}`, {
        headers: {
          Accept: 'application/json',
          'X-Plex-Token': this.token,
          'X-Plex-Client-Identifier': 'nuvi-flow-server',
          'X-Plex-Product': 'Nuvi-Flow',
          'X-Plex-Version': buildInfo().version,
          'X-Plex-Pms-Api-Version': '1.0.0'
        },
        signal: AbortSignal.timeout(10_000)
      });
    } catch (error) {
      if (error instanceof PlexApiError) throw error;
      throw new PlexApiError('Plex request failed.');
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new PlexApiError(
        `Plex returned HTTP ${response.status}.`,
        response.status
      );
    }

    try {
      return await response.json() as T;
    } catch {
      throw new PlexApiError('Plex returned an invalid JSON response.');
    }
  }
}
