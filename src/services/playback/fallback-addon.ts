import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { MediaFileRow, MediaItemRow } from '../../types.js';
import type { SettingsService } from '../settings.js';
import { buildInfo } from '../../lib/build-info.js';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CANDIDATES = 25;
const CACHE_TTL_MS = 30_000;
const SESSION_TTL_MS = 10 * 60_000;
const MEDIA_CANDIDATE_TIMEOUT_MS = 4_000;
const NETWORK_PROBE_BYTES = 512 * 1024;
const NETWORK_PROBE_MIN_BYTES = 128 * 1024;
const NETWORK_PROBE_TIMEOUT_MS = 3_000;
const NETWORK_HEADROOM_FACTOR = 1.35;

interface FallbackLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

interface StremioManifest {
  id?: unknown;
  name?: unknown;
  version?: unknown;
  resources?: unknown;
  types?: unknown;
}

interface StremioStream {
  url?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  behaviorHints?: {
    notWebReady?: unknown;
    filename?: unknown;
    videoSize?: unknown;
    proxyHeaders?: {
      request?: unknown;
    };
  };
  streamData?: {
    size?: unknown;
    duration?: unknown;
    bitrate?: unknown;
    parsedFile?: {
      resolution?: unknown;
      quality?: unknown;
    };
  };
}

export interface FallbackAddonConnection {
  id: string;
  name: string;
  version: string;
  provider: 'aiostreams' | 'stremio-compatible';
}

export interface FallbackPlaybackSession {
  id: string;
  playbackId: string;
  upstreamUrl: string;
  requestHeaders: Record<string, string>;
  label: string;
  candidates: FallbackCandidate[];
  candidateIndex: number;
  candidateVerified: boolean;
  durationSeconds: number | null;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
  maximumExpiresAt: number;
  deviceId?: string;
}

export interface FallbackCandidate {
  url: string;
  label: string;
  requestHeaders: Record<string, string>;
  videoSizeBytes: number | null;
  resolutionHeight: number | null;
  bitrateMbps?: number | null;
  durationSeconds?: number | null;
  providerRank?: number;
  qualityRank?: number;
}

interface NetworkProbeResult {
  response: Response | null;
  measuredMbps: number | null;
  requiredMbps: number | null;
  reason: 'not_applicable' | 'sustainable' | 'insufficient_throughput';
}

export interface FallbackPlaybackInput {
  item?: MediaItemRow;
  file?: MediaFileRow;
  type?: 'movie' | 'series';
  mediaId?: string;
  deviceId: string;
  authorizationExpiresAt: number;
  episode?: { season: number; episode: number };
  networkEstimateMbps?: number | null;
  networkContextId?: string;
}

export interface FallbackSelectionOptions {
  limit?: number;
  maxResolutionHeight?: number | null;
  networkEstimateMbps?: number | null;
  networkHeadroomFactor?: number;
  allowResolutionDowngrade?: boolean;
  durationSeconds?: number | null;
}

interface FallbackAddonOptions {
  fetch?: typeof fetch;
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
  cleanupIntervalMs?: number;
}

function parseManifestUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Fallback addon manifest URL must be valid.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Fallback addon manifest URL must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password || !parsed.pathname.endsWith('/manifest.json')) {
    throw new Error('Fallback addon URL must be a manifest.json URL without URL credentials.');
  }
  parsed.hash = '';
  return parsed;
}

function streamResourceAvailable(resources: unknown): boolean {
  if (!Array.isArray(resources)) return false;
  return resources.some(resource =>
    resource === 'stream' ||
    (typeof resource === 'object' && resource !== null &&
      (resource as { name?: unknown }).name === 'stream')
  );
}

function streamId(input: FallbackPlaybackInput): string {
  if (input.mediaId) return input.mediaId;
  if (!input.item) throw new Error('Fallback media identity is required.');
  if (input.item.type === 'series') {
    if (!input.episode) throw new Error('Episode context is required.');
    return `${input.item.stremio_id}:${input.episode.season}:${input.episode.episode}`;
  }
  return input.item.stremio_id;
}

function streamEndpoint(manifestUrl: string, type: string, id: string): URL {
  const parsed = parseManifestUrl(manifestUrl);
  parsed.pathname = parsed.pathname.slice(0, -'manifest.json'.length) +
    `stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  return parsed;
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some(value => value > 255)) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a! >= 224;
}

export function isSafeFallbackCandidateUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '')
      .replace(/^\[|\]$/g, '');
    return parsed.protocol === 'https:' &&
      !parsed.username && !parsed.password && !parsed.hash &&
      hostname !== 'localhost' && !hostname.endsWith('.local') &&
      hostname !== '::1' && !/^(?:fc|fd|fe8|fe9|fea|feb)/.test(hostname) &&
      !isPrivateIpv4(hostname) &&
      !/\.m3u8$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function allowedProxyHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = new Set(['authorization', 'origin', 'referer', 'user-agent']);
  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    const normalized = name.toLowerCase();
    if (allowed.has(normalized) && typeof headerValue === 'string' && headerValue.length <= 4096) {
      result[normalized] = headerValue;
    }
  }
  return result;
}

function normalizeEdition(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function candidateText(stream: StremioStream): string {
  return [stream.name, stream.title, stream.description, stream.behaviorHints?.filename]
    .filter(value => typeof value === 'string')
    .join(' ');
}

function candidateVideoSize(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function candidateDurationSeconds(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // AIOStreams streamData duration is expressed in milliseconds.
  return parsed >= 1000 ? parsed / 1000 : parsed;
}

function candidateBitrateMbps(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 1000 ? parsed / 1_000_000 : parsed;
}

function candidateResolution(text: string): number | null {
  const normalized = text.toLowerCase();
  if (/\b(?:2160p|4k|uhd)\b/.test(normalized)) return 2160;
  for (const height of [1440, 1080, 720, 576, 480]) {
    if (new RegExp(`\\b${height}p\\b`).test(normalized)) return height;
  }
  return null;
}

function candidateQualityRank(text: string): number {
  const normalized = text.toLowerCase();
  if (/\bremux\b/.test(normalized)) return 5;
  if (/\bblu[ -]?ray\b|\bbdrip\b/.test(normalized)) return 4;
  if (/\bweb[ ._-]?dl\b/.test(normalized)) return 3;
  if (/\bweb[ ._-]?rip\b/.test(normalized)) return 2;
  if (/\b(?:hdtv|dvd)\b/.test(normalized)) return 1;
  return 0;
}

function responseVideoSize(response: Response): number | null {
  const contentRange = response.headers.get('content-range');
  const rangeTotal = contentRange?.match(/\/([0-9]+)$/)?.[1];
  if (rangeTotal) return candidateVideoSize(rangeTotal);
  if (response.status === 200) {
    return candidateVideoSize(response.headers.get('content-length'));
  }
  return null;
}

export function requiredAverageBitrateMbps(
  videoSizeBytes: number | null,
  durationSeconds: number | null
): number | null {
  if (
    !videoSizeBytes || !durationSeconds ||
    !Number.isFinite(videoSizeBytes) || !Number.isFinite(durationSeconds) ||
    videoSizeBytes <= 0 || durationSeconds <= 0
  ) return null;
  return videoSizeBytes * 8 / durationSeconds / 1_000_000;
}

export function hasNetworkHeadroom(
  measuredMbps: number,
  requiredMbps: number,
  factor = NETWORK_HEADROOM_FACTOR
): boolean {
  return measuredMbps >= requiredMbps * factor;
}

export function selectFallbackCandidate(
  streams: unknown,
  edition?: string | null
): FallbackCandidate | null {
  return selectFallbackCandidates(streams, edition, 1)[0] || null;
}

export function selectFallbackCandidates(
  streams: unknown,
  edition?: string | null,
  options: number | FallbackSelectionOptions = 10
): FallbackCandidate[] {
  if (!Array.isArray(streams)) return [];
  const normalizedEdition = edition ? normalizeEdition(edition) : '';
  const eligible: FallbackCandidate[] = [];
  const seenUrls = new Set<string>();
  for (const [providerRank, value] of streams.entries()) {
    if (!value || typeof value !== 'object') continue;
    const stream = value as StremioStream;
    if (typeof stream.url !== 'string' || !isSafeFallbackCandidateUrl(stream.url)) continue;
    if (stream.behaviorHints?.notWebReady === true) continue;
    if (normalizedEdition && !normalizeEdition(candidateText(stream)).includes(normalizedEdition)) continue;
    if (seenUrls.has(stream.url)) continue;
    seenUrls.add(stream.url);
    const text = [candidateText(stream), stream.streamData?.parsedFile?.resolution,
      stream.streamData?.parsedFile?.quality].filter(value => typeof value === 'string').join(' ');
    const videoSizeBytes = candidateVideoSize(
      stream.behaviorHints?.videoSize ?? stream.streamData?.size
    );
    const durationSeconds = candidateDurationSeconds(stream.streamData?.duration);
    const bitrateMbps = candidateBitrateMbps(stream.streamData?.bitrate) ??
      requiredAverageBitrateMbps(videoSizeBytes, durationSeconds);
    eligible.push({
      url: stream.url,
      label: text.slice(0, 240) || 'Fallback addon stream',
      requestHeaders: allowedProxyHeaders(stream.behaviorHints?.proxyHeaders?.request),
      videoSizeBytes,
      resolutionHeight: candidateResolution(text),
      bitrateMbps,
      durationSeconds,
      providerRank,
      qualityRank: candidateQualityRank(text)
    });
  }
  const selection = typeof options === 'number' ? { limit: options } : options;
  const boundedLimit = Math.max(1, Math.min(MAX_CANDIDATES, selection.limit ?? 10));
  const ceiling = selection.maxResolutionHeight ?? null;
  const permitted = ceiling
    ? eligible.filter(candidate => candidate.resolutionHeight === null || candidate.resolutionHeight <= ceiling)
    : eligible;
  const budget = selection.networkEstimateMbps && selection.networkEstimateMbps > 0
    ? selection.networkEstimateMbps / (selection.networkHeadroomFactor || NETWORK_HEADROOM_FACTOR)
    : null;
  const duration = selection.durationSeconds || null;
  const ranked = permitted.map(candidate => {
    const bitrate = candidate.bitrateMbps ?? requiredAverageBitrateMbps(
      candidate.videoSizeBytes,
      candidate.durationSeconds ?? duration
    );
    return { candidate: { ...candidate, bitrateMbps: bitrate }, sustainable: budget === null || bitrate === null || bitrate <= budget };
  }).sort((left, right) => {
    if (left.sustainable !== right.sustainable) return left.sustainable ? -1 : 1;
    const resolution = (right.candidate.resolutionHeight || 0) - (left.candidate.resolutionHeight || 0);
    if (resolution) return resolution;
    const quality = (right.candidate.qualityRank || 0) - (left.candidate.qualityRank || 0);
    if (quality) return quality;
    if (left.sustainable && right.sustainable) {
      const bitrate = (right.candidate.bitrateMbps || 0) - (left.candidate.bitrateMbps || 0);
      if (bitrate) return bitrate;
    } else {
      const bitrate = (left.candidate.bitrateMbps || Number.MAX_VALUE) -
        (right.candidate.bitrateMbps || Number.MAX_VALUE);
      if (bitrate) return bitrate;
    }
    return (left.candidate.providerRank || 0) - (right.candidate.providerRank || 0);
  });
  if (selection.allowResolutionDowngrade === false && ranked[0]?.candidate.resolutionHeight) {
    const height = ranked[0].candidate.resolutionHeight;
    return ranked.filter(entry => entry.candidate.resolutionHeight === height)
      .slice(0, boundedLimit).map(entry => entry.candidate);
  }
  const selected = ranked.slice(0, Math.min(4, boundedLimit));
  const selectedUrls = new Set(selected.map(entry => entry.candidate.url));
  for (const height of [2160, 1440, 1080, 720, 480]) {
    if (selected.length >= boundedLimit) break;
    const alternative = ranked
      .filter(entry => !selectedUrls.has(entry.candidate.url) &&
        entry.candidate.resolutionHeight === height)
      .sort((left, right) =>
        (left.candidate.bitrateMbps ?? Number.MAX_VALUE) -
        (right.candidate.bitrateMbps ?? Number.MAX_VALUE) ||
        (left.candidate.videoSizeBytes ?? Number.MAX_SAFE_INTEGER) -
        (right.candidate.videoSizeBytes ?? Number.MAX_SAFE_INTEGER)
      )[0];
    if (alternative) {
      selected.push(alternative);
      selectedUrls.add(alternative.candidate.url);
    }
  }
  for (const entry of ranked) {
    if (selected.length >= boundedLimit) break;
    if (!selectedUrls.has(entry.candidate.url)) selected.push(entry);
  }
  return selected.map(entry => entry.candidate);
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error('Fallback addon response is too large.');
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('Fallback addon response is too large.');
  }
  try {
    return JSON.parse(Buffer.from(body).toString('utf8'));
  } catch {
    throw new Error('Fallback addon returned invalid JSON.');
  }
}

export class FallbackAddonService {
  private readonly fetcher: typeof fetch;
  private readonly lookup: (hostname: string) => Promise<string[]>;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout | null;
  private readonly cache = new Map<string, { expiresAt: number; streams: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly sessionsById = new Map<string, FallbackPlaybackSession>();
  private readonly sessionIdsByKey = new Map<string, string>();

  constructor(
    private readonly settings: SettingsService,
    private readonly logger: FallbackLogger,
    options: FallbackAddonOptions = {}
  ) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.lookup = options.lookup ?? (async hostname =>
      (await dnsLookup(hostname, { all: true, verbatim: true }))
        .map(result => result.address));
    this.now = options.now ?? Date.now;
    const interval = options.cleanupIntervalMs ?? 60_000;
    this.cleanupTimer = interval > 0
      ? setInterval(() => this.cleanupExpired(), interval)
      : null;
    this.cleanupTimer?.unref();
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cache.clear();
    this.pending.clear();
    this.sessionsById.clear();
    this.sessionIdsByKey.clear();
  }

  shouldTryForLocal(
    file: MediaFileRow,
    likelyVideoTranscode: boolean,
    networkEstimateMbps: number | null | undefined
  ): boolean {
    if (!this.settings.fallbackAddonBeforeTranscode) return false;
    if (likelyVideoTranscode) return true;
    if (!this.settings.fallbackAddonNetworkAdaptation || !networkEstimateMbps) return false;
    const sourceMbps = file.bitrate && file.bitrate > 0
      ? file.bitrate / 1_000_000
      : requiredAverageBitrateMbps(file.size, file.duration_seconds);
    if (!sourceMbps) return false;
    return networkEstimateMbps < sourceMbps *
      (1 + this.settings.fallbackAddonNetworkHeadroomPercent / 100);
  }

  async testConnection(manifestUrl = this.settings.fallbackAddonManifestUrl): Promise<FallbackAddonConnection> {
    const parsed = parseManifestUrl(manifestUrl);
    const data = await this.fetchJson(parsed, this.settings.fallbackAddonTimeoutMs) as StremioManifest;
    if (
      typeof data.id !== 'string' || !data.id.trim() ||
      typeof data.name !== 'string' || !data.name.trim() ||
      !streamResourceAvailable(data.resources)
    ) {
      throw new Error('Fallback addon manifest does not provide a stream resource.');
    }
    const identity = `${data.id} ${data.name}`.toLowerCase();
    return {
      id: data.id,
      name: data.name,
      version: typeof data.version === 'string' ? data.version : 'unknown',
      provider: identity.includes('aiostream') ? 'aiostreams' : 'stremio-compatible'
    };
  }

  async tryPlayback(input: FallbackPlaybackInput): Promise<FallbackPlaybackSession | null> {
    if (!this.settings.fallbackAddonEnabled || !this.settings.fallbackAddonManifestUrl) return null;
    const mediaId = streamId(input);
    const type = input.type ?? input.item?.type;
    if (type !== 'movie' && type !== 'series') throw new Error('Fallback media type is required.');
    const manifestKey = createHash('sha256')
      .update(this.settings.fallbackAddonManifestUrl)
      .digest('base64url');
    const key = createHash('sha256').update(JSON.stringify({
      manifestKey,
      deviceId: input.deviceId,
      networkContextId: input.networkContextId || null,
      type,
      mediaId,
      mediaFileId: input.file?.id || null,
      edition: input.file?.edition || null
    })).digest('base64url');
    const existingId = this.sessionIdsByKey.get(key);
    const existing = existingId ? this.sessionsById.get(existingId) : undefined;
    const now = this.now();
    if (
      existing &&
      existing.expiresAt > now &&
      existing.candidateIndex < existing.candidates.length
    ) {
      existing.lastAccess = now;
      existing.expiresAt = Math.min(existing.maximumExpiresAt, now + SESSION_TTL_MS);
      return existing;
    }
    if (existingId) this.removeSession(existingId);

    const streams = await this.fetchStreams(manifestKey, type, mediaId);
    const maxResolutionHeight = this.settings.fallbackAddonMaxResolution === 'auto'
      ? null
      : Number.parseInt(this.settings.fallbackAddonMaxResolution, 10);
    const candidates = selectFallbackCandidates(streams, input.file?.edition, {
      limit: this.settings.fallbackAddonMaxAttempts,
      maxResolutionHeight,
      networkEstimateMbps: input.networkEstimateMbps ||
        this.settings.fallbackAddonColdStartMbps || null,
      networkHeadroomFactor: 1 + this.settings.fallbackAddonNetworkHeadroomPercent / 100,
      allowResolutionDowngrade: this.settings.fallbackAddonAllowResolutionDowngrade,
      durationSeconds: input.file?.duration_seconds || null
    });
    const candidate = candidates[0];
    if (!candidate) return null;
    const coalescedId = this.sessionIdsByKey.get(key);
    const coalesced = coalescedId ? this.sessionsById.get(coalescedId) : undefined;
    if (coalesced && coalesced.expiresAt > this.now()) return coalesced;
    const session: FallbackPlaybackSession = {
      id: randomUUID(),
      playbackId: randomUUID(),
      upstreamUrl: candidate.url,
      requestHeaders: candidate.requestHeaders,
      label: candidate.label,
      candidates,
      candidateIndex: 0,
      candidateVerified: false,
      durationSeconds: input.file?.duration_seconds ?? candidate.durationSeconds ?? null,
      createdAt: now,
      lastAccess: now,
      expiresAt: Math.min(input.authorizationExpiresAt, now + SESSION_TTL_MS),
      maximumExpiresAt: input.authorizationExpiresAt,
      deviceId: input.deviceId
    };
    this.sessionsById.set(session.id, session);
    this.sessionIdsByKey.set(key, session.id);
    this.logger.info({
      playback_id: session.playbackId,
      device_id: input.deviceId,
      media_file_id: input.file?.id || null,
      media_id: mediaId,
      provider: 'fallback_addon',
      decision: 'external_direct_http',
      candidate_count: candidates.length,
      candidate_resolution: candidate.resolutionHeight,
      candidate_bitrate_mbps: candidate.bitrateMbps === null || candidate.bitrateMbps === undefined
        ? null
        : Number(candidate.bitrateMbps.toFixed(1)),
      fallback_attempt: 1
    }, 'Fallback addon playback selected');
    return session;
  }

  getSession(id: string): FallbackPlaybackSession | null {
    const session = this.sessionsById.get(id);
    const now = this.now();
    if (!session || session.expiresAt <= now) {
      if (session) this.removeSession(id);
      return null;
    }
    session.lastAccess = now;
    session.expiresAt = Math.min(session.maximumExpiresAt, now + SESSION_TTL_MS);
    return session;
  }

  async fetchMedia(session: FallbackPlaybackSession, init: RequestInit): Promise<Response> {
    const deadline = this.now() + (this.settings.fallbackAddonStartupBudgetMs || 15_000);
    let lastFailure = 'unavailable';
    for (
      let index = session.candidateIndex;
      index < session.candidates.length && this.now() < deadline;
      index += 1
    ) {
      const candidate = session.candidates[index]!;
      try {
        const remaining = deadline - this.now();
        let response = await this.fetchCandidate(
          candidate,
          init,
          Math.max(1, Math.min(MEDIA_CANDIDATE_TIMEOUT_MS, remaining))
        );
        const retryable = ![200, 206, 304, 416].includes(response.status);
        const hls = /mpegurl/i.test(response.headers.get('content-type') || '');
        if (retryable || hls) {
          lastFailure = hls ? 'unsupported_hls' : `http_${response.status}`;
          await response.body?.cancel();
          session.candidateIndex = index + 1;
          session.candidateVerified = false;
          this.logCandidateFailure(session, index, lastFailure);
          continue;
        }
        if (
          !session.candidateVerified &&
          String(init.method || 'GET').toUpperCase() !== 'HEAD' &&
          [200, 206].includes(response.status)
        ) {
          const probe = await this.probeNetwork(
            response,
            candidate,
            session.durationSeconds,
            Math.max(1, Math.min(
              NETWORK_PROBE_TIMEOUT_MS,
              deadline - this.now()
            ))
          );
          if (!probe.response) {
            lastFailure = probe.reason;
            session.candidateIndex = index + 1;
            session.candidateVerified = false;
            this.logCandidateFailure(session, index, lastFailure, {
              measured_mbps: probe.measuredMbps === null
                ? null
                : Number(probe.measuredMbps.toFixed(1)),
              required_mbps: probe.requiredMbps === null
                ? null
                : Number(probe.requiredMbps.toFixed(1))
            });
            continue;
          }
          response = probe.response;
          session.candidateVerified = true;
          if (probe.reason === 'sustainable') {
            this.logger.info({
              playback_id: session.playbackId,
              candidate_attempt: index + 1,
              measured_mbps: Number(probe.measuredMbps!.toFixed(1)),
              required_mbps: Number(probe.requiredMbps!.toFixed(1)),
              headroom_factor: NETWORK_HEADROOM_FACTOR
            }, 'Fallback addon candidate passed network probe');
          }
        }
        session.candidateIndex = index;
        session.upstreamUrl = candidate.url;
        session.requestHeaders = candidate.requestHeaders;
        session.label = candidate.label;
        return response;
      } catch (error) {
        lastFailure = error instanceof DOMException && error.name === 'AbortError'
          ? 'timeout'
          : 'request_failed';
        session.candidateIndex = index + 1;
        session.candidateVerified = false;
        this.logCandidateFailure(session, index, lastFailure);
      }
    }
    this.removeSession(session.id);
    throw new Error(`Fallback candidates exhausted: ${lastFailure}`);
  }

  private async fetchCandidate(
    candidate: FallbackCandidate,
    init: RequestInit,
    timeoutMs: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let target = candidate.url;
    try {
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (!isSafeFallbackCandidateUrl(target)) throw new Error('Unsafe fallback stream URL.');
        await this.assertPublicDestination(new URL(target).hostname);
        const headers = new Headers(candidate.requestHeaders);
        new Headers(init.headers).forEach((value, name) => headers.set(name, value));
        const response = await this.fetcher(target, {
          ...init,
          headers,
          signal: controller.signal,
          redirect: 'manual'
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('Fallback stream redirect is invalid.');
        target = new URL(location, target).toString();
      }
      throw new Error('Fallback stream redirected too many times.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private logCandidateFailure(
    session: FallbackPlaybackSession,
    candidateIndex: number,
    reason: string,
    details: Record<string, unknown> = {}
  ): void {
    this.logger.warn({
      playback_id: session.playbackId,
      provider: 'fallback_addon',
      candidate_attempt: candidateIndex + 1,
      candidate_count: session.candidates.length,
      reason,
      ...details
    }, 'Fallback addon candidate failed');
  }

  private async probeNetwork(
    response: Response,
    candidate: FallbackCandidate,
    durationSeconds: number | null,
    timeoutMs: number
  ): Promise<NetworkProbeResult> {
    const requiredMbps = requiredAverageBitrateMbps(
      candidate.videoSizeBytes ?? responseVideoSize(response),
      durationSeconds
    );
    const declaredLength = Number(response.headers.get('content-length'));
    if (
      !response.body || requiredMbps === null ||
      (Number.isFinite(declaredLength) && declaredLength < NETWORK_PROBE_MIN_BYTES)
    ) {
      return {
        response,
        measuredMbps: null,
        requiredMbps,
        reason: 'not_applicable'
      };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    try {
      while (bytes < NETWORK_PROBE_BYTES) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new DOMException('Probe timed out', 'AbortError');
        let timer: NodeJS.Timeout | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new DOMException('Probe timed out', 'AbortError')),
              remaining
            );
          })
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        if (result.done) break;
        if (result.value.byteLength > 2 * 1024 * 1024) {
          throw new Error('Fallback probe chunk is too large.');
        }
        chunks.push(result.value);
        bytes += result.value.byteLength;
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }

    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const measuredMbps = bytes * 8 / elapsedMs / 1000;
    if (
      bytes >= NETWORK_PROBE_MIN_BYTES &&
      !hasNetworkHeadroom(measuredMbps, requiredMbps)
    ) {
      await reader.cancel().catch(() => undefined);
      return {
        response: null,
        measuredMbps,
        requiredMbps,
        reason: 'insufficient_throughput'
      };
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason).catch(() => undefined);
      }
    });
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      }),
      measuredMbps,
      requiredMbps,
      reason: bytes >= NETWORK_PROBE_MIN_BYTES
        ? 'sustainable'
        : 'not_applicable'
    };
  }

  private async assertPublicDestination(hostname: string): Promise<void> {
    const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const addresses = isIP(normalized) ? [normalized] : await this.lookup(normalized);
    if (!addresses.length || addresses.some(address => {
      const value = address.toLowerCase();
      const mappedIpv4 = value.startsWith('::ffff:')
        ? value.slice('::ffff:'.length)
        : '';
      return isPrivateIpv4(value) || value === '::1' || value === '::' ||
        /^(?:fc|fd|fe8|fe9|fea|feb)/.test(value) ||
        (mappedIpv4 ? isPrivateIpv4(mappedIpv4) : false);
    })) {
      throw new Error('Unsafe fallback stream destination.');
    }
  }

  private async fetchStreams(manifestKey: string, type: string, id: string): Promise<unknown> {
    const key = `${manifestKey}:${type}:${id}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return cached.streams;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = (async () => {
      try {
        const endpoint = streamEndpoint(this.settings.fallbackAddonManifestUrl, type, id);
        const data = await this.fetchJson(endpoint, this.settings.fallbackAddonTimeoutMs) as { streams?: unknown };
        const streams = data && typeof data === 'object' ? data.streams : undefined;
        this.cache.set(key, { streams, expiresAt: this.now() + CACHE_TTL_MS });
        return streams;
      } catch (error) {
        this.logger.warn({
          provider: 'fallback_addon',
          media_type: type,
          error: error instanceof DOMException && error.name === 'AbortError'
            ? 'timeout'
            : 'request_failed'
        }, 'Fallback addon lookup failed');
        return undefined;
      } finally {
        this.pending.delete(key);
      }
    })();
    this.pending.set(key, request);
    return request;
  }

  private async fetchJson(url: URL, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        headers: {
          accept: 'application/json',
          'user-agent': `AIOStreams/Nuvi-Flow/${buildInfo().version}`
        },
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response.ok) throw new Error(`Fallback addon returned HTTP ${response.status}.`);
      return await readJson(response);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Fallback addon ')) {
        throw error;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error('Fallback addon request timed out.');
      }
      throw new Error('Fallback addon could not be reached.');
    } finally {
      clearTimeout(timeout);
    }
  }

  private cleanupExpired(): void {
    const now = this.now();
    for (const [id, session] of this.sessionsById) {
      if (session.expiresAt <= now) this.removeSession(id);
    }
    for (const [key, cached] of this.cache) {
      if (cached.expiresAt <= now) this.cache.delete(key);
    }
  }

  private removeSession(id: string): void {
    this.sessionsById.delete(id);
    for (const [key, value] of this.sessionIdsByKey) {
      if (value === id) this.sessionIdsByKey.delete(key);
    }
  }
}
