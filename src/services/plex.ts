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

export interface PlexMediaCandidate {
  ratingKey: string;
  partId: string;
  partKey: string;
  path: string;
}

interface PlexContainer {
  MediaContainer?: {
    machineIdentifier?: unknown;
    friendlyName?: unknown;
    version?: unknown;
    Directory?: unknown;
    Metadata?: unknown;
    totalSize?: unknown;
  } | null;
}

interface PlexDirectory {
  key?: unknown;
  title?: unknown;
  type?: unknown;
}

interface PlexPart {
  id?: unknown;
  key?: unknown;
  file?: unknown;
}

interface PlexMedia {
  Part?: unknown;
}

interface PlexMetadata {
  ratingKey?: unknown;
  Media?: unknown;
}

const MEDIA_PAGE_SIZE = 200;
const MAX_MEDIA_PAGES = 5_000;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PlexApiError(`Plex returned an invalid ${field}.`);
  }
  return value.trim();
}

function optionalIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
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

  async mediaInventory(
    libraries?: PlexLibrary[]
  ): Promise<PlexMediaCandidate[]> {
    const candidates: PlexMediaCandidate[] = [];
    const seen = new Set<string>();
    const availableLibraries = libraries ?? await this.libraries();

    for (const library of availableLibraries) {
      if (library.type !== 'movie' && library.type !== 'show') continue;
      const endpoint = library.type === 'show'
        ? `/library/sections/${encodeURIComponent(library.id)}/allLeaves`
        : `/library/sections/${encodeURIComponent(library.id)}/all`;
      let start = 0;

      for (let page = 0; page < MAX_MEDIA_PAGES; page += 1) {
        const result = await this.get<PlexContainer>(endpoint, {
          'X-Plex-Container-Start': start,
          'X-Plex-Container-Size': MEDIA_PAGE_SIZE
        });
        const container = result.MediaContainer;
        if (!container || (container.Metadata !== undefined &&
          !Array.isArray(container.Metadata))) {
          throw new PlexApiError('Plex returned an invalid media inventory.');
        }
        const metadataValues = Array.isArray(container.Metadata)
          ? container.Metadata
          : [];

        for (const value of metadataValues) {
          const metadata = value as PlexMetadata;
          const ratingKey = optionalIdentifier(metadata?.ratingKey);
          const media = Array.isArray(metadata?.Media)
            ? metadata.Media as PlexMedia[]
            : [];
          if (!ratingKey) continue;
          for (const variant of media) {
            const parts = Array.isArray(variant?.Part)
              ? variant.Part as PlexPart[]
              : [];
            for (const part of parts) {
              const partId = optionalIdentifier(part?.id);
              const partKey = optionalString(part?.key);
              const filePath = optionalString(part?.file);
              if (!partId || !partKey || !partKey.startsWith('/') ||
                !filePath) continue;
              const key = `${ratingKey}\0${partId}\0${partKey}\0${filePath}`;
              if (seen.has(key)) continue;
              seen.add(key);
              candidates.push({
                ratingKey,
                partId,
                partKey,
                path: filePath
              });
            }
          }
        }

        const count = metadataValues.length;
        start += count;
        const total = typeof container.totalSize === 'number' &&
          Number.isFinite(container.totalSize)
          ? Math.max(0, Math.floor(container.totalSize))
          : typeof container.totalSize === 'string' &&
              /^\d+$/.test(container.totalSize)
            ? Number(container.totalSize)
            : null;
        if (count === 0 || (total !== null && start >= total) ||
          (total === null && count < MEDIA_PAGE_SIZE)) break;
        if (page === MAX_MEDIA_PAGES - 1) {
          throw new PlexApiError('Plex media inventory exceeded the safe page limit.');
        }
      }
    }

    return candidates;
  }

  private async get<T>(
    pathname: string,
    query: Record<string, string | number> = {}
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
