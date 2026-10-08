import { createHash, randomUUID } from 'node:crypto';
import type { MediaFileRow, MediaItemRow } from '../../types.js';
import {
  JellyfinApiError,
  JellyfinClient,
  type JellyfinDeviceProfile,
  type JellyfinPlayMethod,
  type JellyfinPlaybackInfoResponse,
  type JellyfinPlaybackMediaSource,
  type JellyfinPlaybackSessionReference
} from '../jellyfin.js';
import type { PlaybackServersService } from '../playback-servers.js';
import type { SettingsService } from '../settings.js';
import type {
  DeviceCapabilitySnapshot,
  DeviceCapabilityStore
} from './device-capabilities.js';
import {
  sourceAudioCodec,
  sourceContainer,
  sourceResolutionCeiling,
  sourceVideoCodec
} from './playback-policy.js';

const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 15_000;
const MAX_RESOURCES_PER_SESSION = 5_000;
const MAX_STREAMING_BITRATE = 200_000_000;

export type JellyfinPlaybackRoute =
  | 'original_http'
  | 'server_remux_progressive'
  | 'server_remux_hls'
  | 'server_audio_transcode_progressive'
  | 'server_audio_transcode_hls'
  | 'server_transcode_progressive'
  | 'server_transcode_hls';

export interface JellyfinPlaybackTarget {
  quality: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  dynamicRange: string | null;
  bitrateMbps: number | null;
}

export interface JellyfinPlaybackInput {
  item: MediaItemRow;
  file: MediaFileRow;
  deviceId: string;
  deviceIdentitySource: string;
  authorizationExpiresAt: number;
  season?: number;
  episode?: number;
}

export interface JellyfinPlaybackStart {
  sessionId: string;
  resourceId: string;
  playbackId: string;
  route: JellyfinPlaybackRoute;
  expiresAt: number;
}

export interface JellyfinPlaybackActivitySession {
  sessionId: string;
  playbackId: string;
  deviceId: string;
  mediaFileId: string;
  mediaType: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  route: JellyfinPlaybackRoute;
  target: JellyfinPlaybackTarget;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
  mediaRequestCount: number;
}

export interface JellyfinMediaFetch {
  response: Response;
  playbackId: string;
  route: JellyfinPlaybackRoute;
  expiresAt: number;
  release(): void;
}

export class JellyfinPlaybackError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'JellyfinPlaybackError';
  }
}

interface JellyfinPlaybackLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface JellyfinPlaybackClient {
  readonly origin: string;
  playbackInfo(
    itemId: string,
    request: Parameters<JellyfinClient['playbackInfo']>[1]
  ): Promise<JellyfinPlaybackInfoResponse>;
  fetchMedia(
    url: URL,
    deviceId: string,
    init?: Pick<RequestInit, 'method' | 'headers' | 'signal'>
  ): Promise<Response>;
  reportPlaybackStart(session: JellyfinPlaybackSessionReference): Promise<void>;
  stopPlayback(session: JellyfinPlaybackSessionReference): Promise<void>;
}

interface JellyfinPlaybackOptions {
  now?: () => number;
  idleMs?: number;
  cleanupIntervalMs?: number;
  clientFactory?: (baseUrl: string, apiKey: string) => JellyfinPlaybackClient;
}

interface JellyfinPlaybackPlan {
  url: URL;
  route: JellyfinPlaybackRoute;
  playMethod: JellyfinPlayMethod;
  transcoding: boolean;
  target: JellyfinPlaybackTarget;
}

interface JellyfinPlaybackSession extends JellyfinPlaybackActivitySession {
  id: string;
  key: string;
  rootResourceId: string;
  itemId: string;
  mediaSourceId: string;
  playSessionId: string;
  playMethod: JellyfinPlayMethod;
  transcoding: boolean;
  maximumExpiresAt: number;
  client: JellyfinPlaybackClient;
  resources: Map<string, URL>;
  resourceIds: Map<string, string>;
  activeControllers: Set<AbortController>;
  startedReported: boolean;
  startReportPromise: Promise<void> | null;
}

function unsupported(
  snapshot: DeviceCapabilitySnapshot,
  category: string,
  capability: string
): boolean {
  return snapshot.capabilities.some(value =>
    value.category === category &&
    value.capability === capability &&
    value.state === 'unsupported'
  );
}

function directProfileKey(profile: {
  Container: string;
  VideoCodec: string;
  AudioCodec: string;
}): string {
  return `${profile.Container}\0${profile.VideoCodec}\0${profile.AudioCodec}`;
}

function profileBitrate(
  file: Pick<MediaFileRow, 'bitrate' | 'width' | 'height'>,
  snapshot: DeviceCapabilitySnapshot
): number {
  const ceiling = sourceResolutionCeiling(file);
  if (ceiling === '2160p' && unsupported(snapshot, 'max_resolution', '2160p')) {
    return 20_000_000;
  }
  if (ceiling === '1080p' && unsupported(snapshot, 'max_resolution', '1080p')) {
    return 8_000_000;
  }
  const source = typeof file.bitrate === 'number' && file.bitrate > 0
    ? Math.ceil(file.bitrate * 1.35)
    : MAX_STREAMING_BITRATE;
  return Math.max(12_000_000, Math.min(MAX_STREAMING_BITRATE, source));
}

function copyPermissions(
  file: MediaFileRow,
  snapshot: DeviceCapabilitySnapshot
): { video: boolean; audio: boolean } {
  const videoCodec = sourceVideoCodec(file.video_codec);
  const audioCodec = sourceAudioCodec(file.audio_codec);
  return {
    video: Boolean(
      videoCodec &&
      !unsupported(snapshot, 'video_codec', videoCodec) &&
      !unsupported(snapshot, 'max_resolution', sourceResolutionCeiling(file))
    ),
    audio: Boolean(
      audioCodec && !unsupported(snapshot, 'audio_codec', audioCodec)
    )
  };
}

/**
 * Builds a deliberately small profile. Unknown devices get the universally
 * compatible MP4/H.264/AAC baseline plus the exact scanned source as a
 * direct-first attempt. Explicit unsupported evidence removes that exact
 * source claim; trusted positive evidence can restore it.
 */
export function buildJellyfinDeviceProfile(
  file: MediaFileRow,
  snapshot: DeviceCapabilitySnapshot
): JellyfinDeviceProfile {
  const container = sourceContainer(file);
  const videoCodec = sourceVideoCodec(file.video_codec);
  const audioCodec = sourceAudioCodec(file.audio_codec);
  const resolution = sourceResolutionCeiling(file);
  const denied = Boolean(
    container && unsupported(snapshot, 'container', container) ||
    videoCodec && unsupported(snapshot, 'video_codec', videoCodec) ||
    audioCodec && unsupported(snapshot, 'audio_codec', audioCodec) ||
    unsupported(snapshot, 'max_resolution', resolution)
  );
  const profiles: JellyfinDeviceProfile['DirectPlayProfiles'] = [];
  if (!denied) {
    profiles.push({
      Container: 'mp4',
      Type: 'Video',
      VideoCodec: 'h264',
      AudioCodec: 'aac'
    });
  }
  if (!denied && container && videoCodec && audioCodec) {
    const exact = {
      Container: container,
      Type: 'Video' as const,
      VideoCodec: videoCodec,
      AudioCodec: audioCodec
    };
    if (!profiles.some(profile => directProfileKey(profile) === directProfileKey(exact))) {
      profiles.push(exact);
    }
  }

  const maxBitrate = profileBitrate(file, snapshot);
  const copy = copyPermissions(file, snapshot);
  const videoTargets = [
    ...(copy.video ? [videoCodec!] : []),
    'h264'
  ].filter((value, index, values) => values.indexOf(value) === index);
  const audioTargets = [
    ...(copy.audio ? [audioCodec!] : []),
    'aac'
  ].filter((value, index, values) => values.indexOf(value) === index);
  return {
    Name: 'Nuvi-Flow direct-first',
    MaxStaticBitrate: MAX_STREAMING_BITRATE,
    MaxStreamingBitrate: maxBitrate,
    DirectPlayProfiles: profiles,
    TranscodingProfiles: [
      {
        Container: 'ts',
        Type: 'Video',
        VideoCodec: videoTargets.join(','),
        AudioCodec: audioTargets.join(','),
        Protocol: 'hls',
        Context: 'Streaming',
        MaxAudioChannels: '2',
        MinSegments: 1,
        SegmentLength: 6,
        BreakOnNonKeyFrames: true,
        CopyTimestamps: false,
        EnableSubtitlesInManifest: false
      },
      {
        Container: 'mp4',
        Type: 'Video',
        VideoCodec: videoTargets.join(','),
        AudioCodec: audioTargets.join(','),
        Protocol: 'http',
        Context: 'Static',
        MaxAudioChannels: '2',
        MinSegments: 0,
        SegmentLength: 0,
        BreakOnNonKeyFrames: false,
        CopyTimestamps: false,
        EnableSubtitlesInManifest: false
      }
    ],
    ContainerProfiles: [],
    CodecProfiles: [],
    SubtitleProfiles: []
  };
}

function safeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)) {
    throw new JellyfinPlaybackError(502, `Jellyfin returned an invalid ${label}.`);
  }
  return value.trim();
}

function stripAuthentication(url: URL): void {
  const names = [...url.searchParams.keys()];
  for (const name of names) {
    if (['api_key', 'apikey', 'x-emby-token', 'x-mediabrowser-token']
      .includes(name.toLowerCase())) {
      url.searchParams.delete(name);
    }
  }
}

function validateMediaUrl(
  raw: string,
  baseUrl: string,
  itemId: string
): URL {
  let url: URL;
  let base: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(raw, `${baseUrl.replace(/\/+$/, '')}/`);
  } catch {
    throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid media URL.');
  }
  stripAuthentication(url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname).replaceAll('\\', '/');
  } catch {
    throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid media URL.');
  }
  const marker = `/videos/${itemId.toLowerCase()}`;
  const lower = pathname.toLowerCase();
  const markerIndex = lower.indexOf(marker);
  const boundary = markerIndex < 0 ? '' : lower[markerIndex + marker.length] || '';
  if (!['http:', 'https:'].includes(url.protocol) ||
    url.origin !== base.origin || url.username || url.password || url.hash ||
    /%(?:2e|2f|5c)/i.test(url.pathname) || markerIndex < 0 ||
    (boundary && !['/', '.'].includes(boundary))) {
    throw new JellyfinPlaybackError(
      502,
      'Jellyfin returned a media URL outside the authorized item.'
    );
  }
  return url;
}

function queryValue(url: URL, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [key, value] of url.searchParams) {
    if (key.toLowerCase() === expected) return value;
  }
  return null;
}

function queryCodecs(url: URL, name: string): string[] {
  return (queryValue(url, name) || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function targetDimension(url: URL, name: 'Width' | 'Height'): number | null {
  const direct = Number(queryValue(url, name));
  const maximum = Number(queryValue(url, `Max${name}`));
  const value = Number.isFinite(direct) && direct > 0 ? direct : maximum;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function selectedTranscodeMethod(
  url: URL,
  file: MediaFileRow
): 'remux' | 'audio' | 'video' {
  const reasons = (queryValue(url, 'TranscodeReasons') || '').toLowerCase();
  const sourceVideo = sourceVideoCodec(file.video_codec);
  const sourceAudio = sourceAudioCodec(file.audio_codec);
  const videoCodecs = queryCodecs(url, 'VideoCodec');
  const audioCodecs = queryCodecs(url, 'AudioCodec');
  const videoCopyDisabled = queryValue(url, 'allowVideoStreamCopy')
    ?.toLowerCase() === 'false';
  const audioCopyDisabled = queryValue(url, 'allowAudioStreamCopy')
    ?.toLowerCase() === 'false';
  const videoReason = /video|bitrate|resolution|framerate|level|profile|bitdepth|interlac/i
    .test(reasons);
  const audioReason = /audio|channel|samplerate/i.test(reasons);
  const videoTargetMismatch = Boolean(
    sourceVideo && videoCodecs.length && !videoCodecs.includes(sourceVideo)
  );
  const audioTargetMismatch = Boolean(
    sourceAudio && audioCodecs.length && !audioCodecs.includes(sourceAudio)
  );
  if (videoCopyDisabled || videoReason || videoTargetMismatch) return 'video';
  if (audioCopyDisabled || audioReason || audioTargetMismatch) return 'audio';
  return 'remux';
}

function targetForPlan(
  route: JellyfinPlaybackRoute,
  url: URL,
  file: MediaFileRow
): JellyfinPlaybackTarget {
  const videoTranscode = route === 'server_transcode_hls' ||
    route === 'server_transcode_progressive';
  const audioTranscode = route === 'server_audio_transcode_hls' ||
    route === 'server_audio_transcode_progressive' || videoTranscode;
  return {
    quality: videoTranscode ? 'Auto' : file.quality,
    width: videoTranscode ? targetDimension(url, 'Width') : file.width,
    height: videoTranscode ? targetDimension(url, 'Height') : file.height,
    videoCodec: videoTranscode
      ? queryCodecs(url, 'VideoCodec')[0] || 'h264'
      : file.video_codec,
    audioCodec: audioTranscode
      ? queryCodecs(url, 'AudioCodec')[0] || 'aac'
      : file.audio_codec,
    dynamicRange: null,
    bitrateMbps: null
  };
}

function selectPlaybackPlan(
  response: JellyfinPlaybackInfoResponse,
  source: JellyfinPlaybackMediaSource,
  baseUrl: string,
  itemId: string,
  mediaSourceId: string,
  userId: string,
  deviceId: string,
  file: MediaFileRow
): { plan: JellyfinPlaybackPlan; playSessionId: string } {
  if (response.ErrorCode !== undefined && response.ErrorCode !== null &&
    response.ErrorCode !== 'None') {
    throw new JellyfinPlaybackError(502, 'Jellyfin could not select a playback route.');
  }
  const playSessionId = safeIdentifier(response.PlaySessionId, 'play session');
  if (source.SupportsDirectPlay === true) {
    const direct = new URL(
      `${baseUrl.replace(/\/+$/, '')}/Videos/${encodeURIComponent(itemId)}/stream`
    );
    direct.searchParams.set('Static', 'true');
    direct.searchParams.set('MediaSourceId', mediaSourceId);
    direct.searchParams.set('PlaySessionId', playSessionId);
    direct.searchParams.set('DeviceId', deviceId);
    direct.searchParams.set('UserId', userId);
    direct.searchParams.set('IsPlayback', 'true');
    const url = validateMediaUrl(direct.toString(), baseUrl, itemId);
    return {
      playSessionId,
      plan: {
        url,
        route: 'original_http',
        playMethod: 'DirectPlay',
        transcoding: false,
        target: targetForPlan('original_http', url, file)
      }
    };
  }
  if (typeof source.TranscodingUrl !== 'string' || !source.TranscodingUrl.trim()) {
    throw new JellyfinPlaybackError(502, 'Jellyfin did not return a usable playback route.');
  }
  if (source.SupportsDirectStream !== true && source.SupportsTranscoding !== true) {
    throw new JellyfinPlaybackError(502, 'Jellyfin returned an unsupported playback decision.');
  }
  const url = validateMediaUrl(source.TranscodingUrl, baseUrl, itemId);
  const hls = url.pathname.toLowerCase().endsWith('.m3u8') ||
    String(source.TranscodingSubProtocol || '').toLowerCase() === 'hls';
  const selectedMethod = selectedTranscodeMethod(url, file);
  const method = source.SupportsDirectStream === true
    ? selectedMethod
    : 'video';
  const route: JellyfinPlaybackRoute = method === 'video'
    ? hls ? 'server_transcode_hls' : 'server_transcode_progressive'
    : method === 'audio'
      ? hls ? 'server_audio_transcode_hls' : 'server_audio_transcode_progressive'
      : hls ? 'server_remux_hls' : 'server_remux_progressive';
  return {
    playSessionId,
    plan: {
      url,
      route,
      playMethod: method === 'video' ? 'Transcode' : 'DirectStream',
      transcoding: true,
      target: targetForPlan(route, url, file)
    }
  };
}

function resourceId(url: URL): string {
  return createHash('sha256').update(url.toString()).digest('hex').slice(0, 32);
}

function sessionKey(parts: Record<string, string>): string {
  return createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('base64url');
}

export class JellyfinPlaybackService {
  private readonly sessions = new Map<string, JellyfinPlaybackSession>();
  private readonly sessionsByKey = new Map<string, string>();
  private readonly pending = new Map<string, Promise<JellyfinPlaybackSession>>();
  private readonly terminationPromises = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly cleanupTimer: NodeJS.Timeout | null;
  private readonly clientFactory: NonNullable<JellyfinPlaybackOptions['clientFactory']>;
  private cleanupRunning = false;
  private closed = false;

  constructor(
    private readonly settings: SettingsService,
    private readonly playbackServers: PlaybackServersService,
    private readonly capabilities: DeviceCapabilityStore,
    private readonly logger: JellyfinPlaybackLogger,
    options: JellyfinPlaybackOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.idleMs = Math.max(1_000, options.idleMs ?? DEFAULT_IDLE_MS);
    this.clientFactory = options.clientFactory ??
      ((baseUrl, apiKey) => new JellyfinClient(baseUrl, apiKey));
    const interval = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.cleanupTimer = interval > 0
      ? setInterval(() => void this.cleanupExpired(), interval)
      : null;
    this.cleanupTimer?.unref();
  }

  async start(input: JellyfinPlaybackInput): Promise<JellyfinPlaybackStart> {
    if (this.closed) {
      throw new JellyfinPlaybackError(503, 'Jellyfin playback is shutting down.');
    }
    if (!this.settings.jellyfinEnabled || !this.settings.jellyfinUrl ||
      !this.settings.jellyfinApiKey || !this.settings.jellyfinUserId) {
      throw new JellyfinPlaybackError(503, 'Jellyfin is not configured.');
    }
    if (input.authorizationExpiresAt <= this.now()) {
      throw new JellyfinPlaybackError(401, 'Playback authorization has expired.');
    }
    this.capabilities.touchDevice(input.deviceId, input.deviceIdentitySource);
    const snapshot = this.capabilities.getSnapshot(input.deviceId);
    const mapping = await this.playbackServers.resolveMapping('jellyfin', input.file);
    if (!mapping?.provider_item_id || !mapping.provider_media_id) {
      throw new JellyfinPlaybackError(404, 'No exact Jellyfin media mapping is ready.');
    }
    const itemId = safeIdentifier(mapping.provider_item_id, 'item ID');
    const mediaSourceId = safeIdentifier(mapping.provider_media_id, 'media source ID');
    const key = sessionKey({
      provider: 'jellyfin',
      server: mapping.server_key,
      endpoint: this.settings.jellyfinUrl,
      file: input.file.id,
      item: itemId,
      source: mediaSourceId,
      device: input.deviceId,
      capabilities: snapshot.revision,
      user: this.settings.jellyfinUserId,
      credential: createHash('sha256')
        .update(this.settings.jellyfinApiKey)
        .digest('base64url')
        .slice(0, 12),
      episode: input.episode === undefined
        ? ''
        : `${input.season}:${input.episode}`
    });
    const existingId = this.sessionsByKey.get(key);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && existing.maximumExpiresAt > this.now()) {
      this.touch(existing, input.authorizationExpiresAt);
      return this.publicStart(existing, input.authorizationExpiresAt);
    }
    const inFlight = this.pending.get(key);
    if (inFlight) {
      const session = await inFlight;
      this.touch(session, input.authorizationExpiresAt);
      return this.publicStart(session, input.authorizationExpiresAt);
    }
    const creation = this.createSession(
      key,
      itemId,
      mediaSourceId,
      snapshot,
      input
    ).finally(() => {
      if (this.pending.get(key) === creation) this.pending.delete(key);
    });
    this.pending.set(key, creation);
    return this.publicStart(await creation, input.authorizationExpiresAt);
  }

  async fetchMedia(
    sessionId: string,
    resourceIdValue: string,
    init: Pick<RequestInit, 'method' | 'headers' | 'signal'>
  ): Promise<JellyfinMediaFetch> {
    const session = this.activeSession(sessionId);
    const url = session?.resources.get(resourceIdValue);
    if (!session || !url) {
      throw new JellyfinPlaybackError(410, 'Jellyfin playback resource has expired.');
    }
    this.touch(session, session.maximumExpiresAt);
    session.mediaRequestCount += 1;
    const controller = new AbortController();
    session.activeControllers.add(controller);
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let response: Response;
    try {
      response = await session.client.fetchMedia(url, session.deviceId, {
        method: init.method,
        headers: init.headers,
        signal
      });
    } catch (error) {
      session.activeControllers.delete(controller);
      if (error instanceof JellyfinApiError || error instanceof JellyfinPlaybackError) {
        throw new JellyfinPlaybackError(502, 'Jellyfin media could not be fetched.');
      }
      throw error;
    }
    if (!session.startedReported && response.ok) {
      session.startedReported = true;
      session.startReportPromise = session.client
        .reportPlaybackStart(this.sessionReference(session))
        .catch(error => this.logger.warn({
          playback_id: session.playbackId,
          error: error instanceof Error ? error.name : 'unknown'
        }, 'Jellyfin playback start could not be reported'));
    }
    let released = false;
    return {
      response,
      playbackId: session.playbackId,
      route: session.route,
      expiresAt: session.maximumExpiresAt,
      release: () => {
        if (released) return;
        released = true;
        session.activeControllers.delete(controller);
        if (this.sessions.has(session.id)) this.touch(session, session.maximumExpiresAt);
      }
    };
  }

  registerChildResource(
    sessionId: string,
    sourceResourceId: string,
    reference: string,
    authorizationExpiresAt: number
  ): { resourceId: string; expiresAt: number } {
    const session = this.activeSession(sessionId);
    const source = session?.resources.get(sourceResourceId);
    if (!session || !source) {
      throw new JellyfinPlaybackError(410, 'Jellyfin playback resource has expired.');
    }
    let resolved: URL;
    try {
      resolved = validateMediaUrl(
        new URL(reference, source).toString(),
        this.settings.jellyfinUrl,
        session.itemId
      );
    } catch (error) {
      if (error instanceof JellyfinPlaybackError) throw error;
      throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid HLS media URI.');
    }
    return {
      resourceId: this.registerResource(session, resolved),
      expiresAt: Math.min(session.maximumExpiresAt, authorizationExpiresAt)
    };
  }

  playbackIdForSession(sessionId: string): string | null {
    return this.activeSession(sessionId)?.playbackId ?? null;
  }

  async activeSnapshot(): Promise<JellyfinPlaybackActivitySession[]> {
    await this.cleanupExpired();
    return [...this.sessions.values()].map(session => ({
      sessionId: session.id,
      playbackId: session.playbackId,
      deviceId: session.deviceId,
      mediaFileId: session.mediaFileId,
      mediaType: session.mediaType,
      season: session.season,
      episode: session.episode,
      route: session.route,
      target: { ...session.target },
      createdAt: session.createdAt,
      lastAccess: session.lastAccess,
      expiresAt: session.expiresAt,
      mediaRequestCount: session.mediaRequestCount
    }));
  }

  counts(): { active: number; pending: number; transfers: number } {
    let transfers = 0;
    for (const session of this.sessions.values()) {
      transfers += session.activeControllers.size;
    }
    return {
      active: this.sessions.size,
      pending: this.pending.size,
      transfers
    };
  }

  async stopPlayback(playbackId: string): Promise<boolean> {
    const session = [...this.sessions.values()]
      .find(candidate => candidate.playbackId === playbackId);
    if (!session) return false;
    await this.retire(session, 'admin_stopped');
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.pending.values()]);
    await Promise.allSettled(
      [...this.sessions.values()].map(session => this.retire(session, 'shutdown'))
    );
  }

  private async createSession(
    key: string,
    itemId: string,
    mediaSourceId: string,
    snapshot: DeviceCapabilitySnapshot,
    input: JellyfinPlaybackInput
  ): Promise<JellyfinPlaybackSession> {
    const baseUrl = this.settings.jellyfinUrl;
    const userId = this.settings.jellyfinUserId;
    const client = this.clientFactory(baseUrl, this.settings.jellyfinApiKey);
    let response: JellyfinPlaybackInfoResponse;
    try {
      const copy = copyPermissions(input.file, snapshot);
      response = await client.playbackInfo(itemId, {
        userId,
        mediaSourceId,
        deviceId: input.deviceId,
        deviceProfile: buildJellyfinDeviceProfile(input.file, snapshot),
        allowVideoStreamCopy: copy.video,
        allowAudioStreamCopy: copy.audio
      });
    } catch (error) {
      if (error instanceof JellyfinApiError) {
        throw new JellyfinPlaybackError(502, 'Jellyfin playback negotiation failed.');
      }
      throw error;
    }
    if (!Array.isArray(response.MediaSources)) {
      throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid playback decision.');
    }
    const sources = (response.MediaSources as JellyfinPlaybackMediaSource[])
      .filter(source => source?.Id === mediaSourceId);
    if (sources.length !== 1) {
      throw new JellyfinPlaybackError(502, 'Jellyfin did not return the exact mapped media source.');
    }
    const { plan, playSessionId } = selectPlaybackPlan(
      response,
      sources[0]!,
      baseUrl,
      itemId,
      mediaSourceId,
      userId,
      input.deviceId,
      input.file
    );
    if (client.origin !== plan.url.origin) {
      throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid media origin.');
    }
    const now = this.now();
    const id = randomUUID();
    const rootResourceId = resourceId(plan.url);
    const session: JellyfinPlaybackSession = {
      id,
      sessionId: id,
      key,
      rootResourceId,
      playbackId: randomUUID(),
      deviceId: input.deviceId,
      mediaFileId: input.file.id,
      mediaType: input.item.type,
      season: input.season ?? null,
      episode: input.episode ?? null,
      route: plan.route,
      target: plan.target,
      itemId,
      mediaSourceId,
      playSessionId,
      playMethod: plan.playMethod,
      transcoding: plan.transcoding,
      createdAt: now,
      lastAccess: now,
      expiresAt: Math.min(input.authorizationExpiresAt, now + this.idleMs),
      maximumExpiresAt: input.authorizationExpiresAt,
      mediaRequestCount: 0,
      client,
      resources: new Map([[rootResourceId, plan.url]]),
      resourceIds: new Map([[plan.url.toString(), rootResourceId]]),
      activeControllers: new Set(),
      startedReported: false,
      startReportPromise: null
    };
    if (this.closed) {
      await client.stopPlayback(this.sessionReference(session)).catch(() => undefined);
      throw new JellyfinPlaybackError(503, 'Jellyfin playback is shutting down.');
    }
    this.sessions.set(id, session);
    this.sessionsByKey.set(key, id);
    this.logger.info({
      playback_id: session.playbackId,
      media_file_id: session.mediaFileId,
      delivery: session.route
    }, 'Jellyfin playback session created');
    return session;
  }

  private registerResource(session: JellyfinPlaybackSession, url: URL): string {
    const existing = session.resourceIds.get(url.toString());
    if (existing) return existing;
    if (session.resources.size >= MAX_RESOURCES_PER_SESSION) {
      throw new JellyfinPlaybackError(502, 'Jellyfin HLS manifest referenced too many resources.');
    }
    const id = resourceId(url);
    const collision = session.resources.get(id);
    if (collision && collision.toString() !== url.toString()) {
      throw new JellyfinPlaybackError(502, 'Jellyfin returned an invalid HLS resource.');
    }
    session.resources.set(id, url);
    session.resourceIds.set(url.toString(), id);
    return id;
  }

  private activeSession(sessionId: string): JellyfinPlaybackSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const now = this.now();
    if (session.maximumExpiresAt <= now ||
      (session.expiresAt <= now && session.activeControllers.size === 0)) {
      void this.retire(session, 'expired');
      return null;
    }
    return session;
  }

  private touch(session: JellyfinPlaybackSession, authorizationExpiresAt: number): void {
    const now = this.now();
    session.maximumExpiresAt = Math.max(
      session.maximumExpiresAt,
      authorizationExpiresAt
    );
    session.lastAccess = now;
    session.expiresAt = Math.min(session.maximumExpiresAt, now + this.idleMs);
  }

  private publicStart(
    session: JellyfinPlaybackSession,
    authorizationExpiresAt: number
  ): JellyfinPlaybackStart {
    return {
      sessionId: session.id,
      resourceId: session.rootResourceId,
      playbackId: session.playbackId,
      route: session.route,
      expiresAt: Math.min(session.maximumExpiresAt, authorizationExpiresAt)
    };
  }

  private sessionReference(
    session: JellyfinPlaybackSession
  ): JellyfinPlaybackSessionReference {
    return {
      itemId: session.itemId,
      mediaSourceId: session.mediaSourceId,
      playSessionId: session.playSessionId,
      deviceId: session.deviceId,
      playMethod: session.playMethod,
      transcoding: session.transcoding
    };
  }

  private async cleanupExpired(): Promise<void> {
    if (this.cleanupRunning) return;
    this.cleanupRunning = true;
    try {
      const now = this.now();
      await Promise.allSettled([...this.sessions.values()]
        .filter(session => session.maximumExpiresAt <= now ||
          (session.expiresAt <= now && session.activeControllers.size === 0))
        .map(session => this.retire(session, 'expired')));
    } finally {
      this.cleanupRunning = false;
    }
  }

  private retire(
    session: JellyfinPlaybackSession,
    reason: 'admin_stopped' | 'expired' | 'shutdown'
  ): Promise<void> {
    const existing = this.terminationPromises.get(session.id);
    if (existing) return existing;
    const termination = (async () => {
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      if (this.sessionsByKey.get(session.key) === session.id) {
        this.sessionsByKey.delete(session.key);
      }
      for (const controller of session.activeControllers) controller.abort();
      session.activeControllers.clear();
      if (session.mediaRequestCount > 0) {
        try {
          await session.startReportPromise;
          await session.client.stopPlayback(this.sessionReference(session));
        } catch (error) {
          this.logger.warn({
            playback_id: session.playbackId,
            retirement_reason: reason,
            error: error instanceof Error ? error.name : 'unknown'
          }, 'Jellyfin playback session retirement failed');
          return;
        }
      }
      this.logger.info({
        playback_id: session.playbackId,
        retirement_reason: reason
      }, 'Jellyfin playback session retired');
    })().finally(() => this.terminationPromises.delete(session.id));
    this.terminationPromises.set(session.id, termination);
    return termination;
  }
}
