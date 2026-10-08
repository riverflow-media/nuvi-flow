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

export interface JellyfinDirectPlayProfile {
  Container: string;
  Type: 'Video';
  VideoCodec: string;
  AudioCodec: string;
}

export interface JellyfinTranscodingProfile {
  Container: string;
  Type: 'Video';
  VideoCodec: string;
  AudioCodec: string;
  Protocol: 'hls' | 'http';
  Context: 'Streaming' | 'Static';
  MaxAudioChannels: string;
  MinSegments: number;
  SegmentLength: number;
  BreakOnNonKeyFrames: boolean;
  CopyTimestamps: boolean;
  EnableSubtitlesInManifest: boolean;
}

export interface JellyfinDeviceProfile {
  Name: string;
  MaxStaticBitrate: number;
  MaxStreamingBitrate: number;
  DirectPlayProfiles: JellyfinDirectPlayProfile[];
  TranscodingProfiles: JellyfinTranscodingProfile[];
  ContainerProfiles: [];
  CodecProfiles: [];
  SubtitleProfiles: [];
}

export interface JellyfinPlaybackRequest {
  userId: string;
  mediaSourceId: string;
  deviceId: string;
  deviceProfile: JellyfinDeviceProfile;
  allowVideoStreamCopy: boolean;
  allowAudioStreamCopy: boolean;
}

export interface JellyfinPlaybackMediaSource {
  Id?: unknown;
  Container?: unknown;
  SupportsDirectPlay?: unknown;
  SupportsDirectStream?: unknown;
  SupportsTranscoding?: unknown;
  TranscodingUrl?: unknown;
  TranscodingSubProtocol?: unknown;
  TranscodingContainer?: unknown;
  MediaStreams?: unknown;
}

export interface JellyfinPlaybackInfoResponse {
  ErrorCode?: unknown;
  MediaSources?: unknown;
  PlaySessionId?: unknown;
}

export type JellyfinPlayMethod = 'DirectPlay' | 'DirectStream' | 'Transcode';

export interface JellyfinPlaybackSessionReference {
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  deviceId: string;
  playMethod: JellyfinPlayMethod;
  transcoding: boolean;
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
 * Credentials remain server-side for both control-plane and media requests.
 * Playback URLs returned by Jellyfin are consumed only by the application
 * playback boundary and are never handed directly to a player.
 */
export class JellyfinClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, '');
  }

  get origin(): string {
    return new URL(this.baseUrl).origin;
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

  async playbackInfo(
    itemId: string,
    request: JellyfinPlaybackRequest
  ): Promise<JellyfinPlaybackInfoResponse> {
    return this.requestJson<JellyfinPlaybackInfoResponse>(
      `/Items/${encodeURIComponent(itemId)}/PlaybackInfo`,
      {
        method: 'POST',
        body: JSON.stringify({
          UserId: request.userId,
          MediaSourceId: request.mediaSourceId,
          MaxStreamingBitrate: request.deviceProfile.MaxStreamingBitrate,
          MaxAudioChannels: 2,
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
          AllowVideoStreamCopy: request.allowVideoStreamCopy,
          AllowAudioStreamCopy: request.allowAudioStreamCopy,
          AutoOpenLiveStream: false,
          AlwaysBurnInSubtitleWhenTranscoding: false,
          DeviceProfile: request.deviceProfile
        })
      },
      request.deviceId
    );
  }

  async fetchMedia(
    url: URL,
    deviceId: string,
    init: Pick<RequestInit, 'method' | 'headers' | 'signal'> = {}
  ): Promise<Response> {
    if (!['http:', 'https:'].includes(url.protocol) ||
      url.origin !== this.origin || url.username || url.password || url.hash) {
      throw new JellyfinApiError('Jellyfin returned an invalid media URL.');
    }
    const headers = new Headers(init.headers);
    this.applyAuthentication(headers, deviceId);
    try {
      return await fetch(url, {
        method: init.method,
        headers,
        signal: init.signal,
        redirect: 'manual'
      });
    } catch {
      throw new JellyfinApiError('Jellyfin media request failed.');
    }
  }

  async reportPlaybackStart(
    session: JellyfinPlaybackSessionReference
  ): Promise<void> {
    await this.requestNoContent('/Sessions/Playing', {
      method: 'POST',
      body: JSON.stringify({
        ItemId: session.itemId,
        MediaSourceId: session.mediaSourceId,
        PlaySessionId: session.playSessionId,
        PlayMethod: session.playMethod,
        PositionTicks: 0,
        CanSeek: true,
        IsPaused: false
      })
    }, session.deviceId);
  }

  async stopPlayback(
    session: JellyfinPlaybackSessionReference
  ): Promise<void> {
    let encodingError: unknown;
    if (session.transcoding) {
      try {
        await this.requestNoContent('/Videos/ActiveEncodings', {
          method: 'DELETE'
        }, session.deviceId, {
          DeviceId: session.deviceId,
          PlaySessionId: session.playSessionId
        }, true);
      } catch (error) {
        encodingError = error;
      }
    }
    try {
      await this.requestNoContent('/Sessions/Playing/Stopped', {
        method: 'POST',
        body: JSON.stringify({
          ItemId: session.itemId,
          MediaSourceId: session.mediaSourceId,
          PlaySessionId: session.playSessionId,
          PositionTicks: 0,
          Failed: false
        })
      }, session.deviceId, {}, true);
    } catch (error) {
      throw error;
    }
    if (encodingError) throw encodingError;
  }

  private async get<T>(
    pathname: string,
    query: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    return this.requestJson<T>(pathname, {}, 'nuvi-flow-server', query);
  }

  private async requestJson<T>(
    pathname: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    deviceId: string,
    query: Record<string, string | number | boolean> = {}
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    this.applyAuthentication(headers, deviceId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        body: init.body,
        headers,
        redirect: 'manual',
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

  private async requestNoContent(
    pathname: string,
    init: Pick<RequestInit, 'method' | 'body'>,
    deviceId: string,
    query: Record<string, string | number | boolean> = {},
    tolerateMissing = false
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value));
    }
    const headers = new Headers({ Accept: 'application/json' });
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    this.applyAuthentication(headers, deviceId);
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method,
        body: init.body,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new JellyfinApiError('Jellyfin request failed.');
    }
    if (!response.ok && !(tolerateMissing && response.status === 404)) {
      await response.body?.cancel();
      throw new JellyfinApiError(
        `Jellyfin returned HTTP ${response.status}.`,
        response.status
      );
    }
    await response.body?.cancel();
  }

  private applyAuthentication(headers: Headers, deviceId: string): void {
    headers.set('X-Emby-Token', this.apiKey);
    headers.set(
      'Authorization',
      `MediaBrowser Client="Nuvi-Flow", Device="Nuvi-Flow Server", DeviceId="${deviceId}", Version="${buildInfo().version}", Token="${this.apiKey}"`
    );
  }
}
