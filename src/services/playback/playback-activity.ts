import { randomUUID } from 'node:crypto';
import type { MediaFileRow } from '../../types.js';
import type { FallbackAddonService } from './fallback-addon.js';
import type { PlaybackSessionRegistry } from './playback-sessions.js';

const DEFAULT_IDLE_WINDOW_MS = 15_000;
const DEFAULT_DIRECT_LINGER_MS = 30_000;

export type PlaybackActivityRoute =
  | 'direct_file'
  | 'original_http'
  | 'server_remux_progressive'
  | 'server_remux_hls'
  | 'server_transcode_hls'
  | 'external_direct_http';

export type PlaybackActivityState = 'starting' | 'streaming' | 'idle';

export interface PlaybackActivityTarget {
  quality: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  dynamicRange: string | null;
  bitrateMbps: number | null;
}

export interface PlaybackActivityRecord {
  playbackId: string;
  mediaFileId: string | null;
  mediaId: string | null;
  mediaType: 'movie' | 'series' | null;
  deviceId: string | null;
  provider: 'nuvi-flow' | 'silo' | 'fallback-addon';
  route: PlaybackActivityRoute;
  state: PlaybackActivityState;
  season: number | null;
  episode: number | null;
  target: PlaybackActivityTarget;
  fallback: {
    state: 'ready' | 'pending' | 'completed' | 'failed';
    reason: 'startup_latency' | 'slow_segments' | 'status_failures' | null;
    targetQuality: string;
  } | null;
  candidate: {
    attempt: number;
    count: number;
  } | null;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

export interface DirectPlaybackInput {
  requestScope: string;
  deviceId: string | null;
  file: MediaFileRow;
  authorizationExpiresAt: number;
  season?: number;
  episode?: number;
}

export interface PlaybackActivityHandle {
  playbackId: string;
  finish(): void;
}

interface TransferState {
  active: number;
  lastActivityAt: number;
}

interface DirectActivity {
  playbackId: string;
  requestScope: string;
  deviceId: string | null;
  mediaFileId: string;
  mediaType: 'movie' | 'series';
  season: number | null;
  episode: number | null;
  file: Pick<
    MediaFileRow,
    'quality' | 'width' | 'height' | 'video_codec' | 'audio_codec'
  >;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  maximumExpiresAt: number;
  activeTransfers: number;
}

interface PlaybackActivityOptions {
  now?: () => number;
  idleWindowMs?: number;
  directLingerMs?: number;
  cleanupIntervalMs?: number;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function normalizedRoute(value: string): PlaybackActivityRoute {
  if (
    value === 'original_http' ||
    value === 'server_remux_progressive' ||
    value === 'server_remux_hls' ||
    value === 'server_transcode_hls'
  ) {
    return value;
  }
  return 'server_transcode_hls';
}

export class PlaybackActivityService {
  private readonly direct = new Map<string, DirectActivity>();
  private readonly transfers = new Map<string, TransferState>();
  private readonly now: () => number;
  private readonly idleWindowMs: number;
  private readonly directLingerMs: number;
  private readonly cleanupTimer: NodeJS.Timeout | null;

  constructor(
    private readonly siloSessions: PlaybackSessionRegistry,
    private readonly fallbackAddon: FallbackAddonService,
    options: PlaybackActivityOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.idleWindowMs = options.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS;
    this.directLingerMs = options.directLingerMs ?? DEFAULT_DIRECT_LINGER_MS;
    const interval = options.cleanupIntervalMs ?? 15_000;
    this.cleanupTimer = interval > 0
      ? setInterval(() => this.cleanup(), interval)
      : null;
    this.cleanupTimer?.unref();
  }

  beginDirect(input: DirectPlaybackInput): PlaybackActivityHandle {
    const now = this.now();
    this.cleanup();
    let activity = this.direct.get(input.requestScope);
    if (!activity || activity.maximumExpiresAt <= now) {
      activity = {
        playbackId: randomUUID(),
        requestScope: input.requestScope,
        deviceId: input.deviceId,
        mediaFileId: input.file.id,
        mediaType: input.file.library_type,
        season: input.season ?? null,
        episode: input.episode ?? null,
        file: {
          quality: input.file.quality,
          width: input.file.width,
          height: input.file.height,
          video_codec: input.file.video_codec,
          audio_codec: input.file.audio_codec
        },
        createdAt: now,
        lastActivityAt: now,
        expiresAt: Math.min(input.authorizationExpiresAt, now + this.directLingerMs),
        maximumExpiresAt: input.authorizationExpiresAt,
        activeTransfers: 0
      };
      this.direct.set(input.requestScope, activity);
    }
    activity.activeTransfers += 1;
    activity.lastActivityAt = now;
    activity.expiresAt = Math.min(
      activity.maximumExpiresAt,
      now + this.directLingerMs
    );
    let finished = false;
    return {
      playbackId: activity.playbackId,
      finish: () => {
        if (finished) return;
        finished = true;
        const current = this.direct.get(input.requestScope);
        if (!current) return;
        const finishedAt = this.now();
        current.activeTransfers = Math.max(0, current.activeTransfers - 1);
        current.lastActivityAt = finishedAt;
        current.expiresAt = Math.min(
          current.maximumExpiresAt,
          finishedAt + this.directLingerMs
        );
      }
    };
  }

  beginSilo(pathname: string): PlaybackActivityHandle | null {
    const playbackId = this.siloSessions.playbackIdForUpstreamPath(pathname);
    return playbackId ? this.beginTransfer(playbackId) : null;
  }

  beginFallback(playbackId: string): PlaybackActivityHandle {
    return this.beginTransfer(playbackId);
  }

  async snapshot(): Promise<PlaybackActivityRecord[]> {
    this.cleanup();
    const now = this.now();
    const silo = await this.siloSessions.activeSnapshot();
    const fallback = this.fallbackAddon.activeSnapshot();
    const records: PlaybackActivityRecord[] = [];

    for (const session of silo) {
      const summary = session.planSummary;
      const transfer = this.transfers.get(session.playbackId);
      const lastActivityAt = Math.max(
        session.lastAccess,
        transfer?.lastActivityAt ?? 0
      );
      records.push({
        playbackId: session.playbackId,
        mediaFileId: session.mediaFileId,
        mediaId: null,
        mediaType: null,
        deviceId: session.deviceId,
        provider: 'silo',
        route: normalizedRoute(session.delivery),
        state: this.stateFor(
          session.createdAt,
          lastActivityAt,
          session.mediaRequestCount,
          transfer
        ),
        season: session.season,
        episode: session.episode,
        target: {
          quality: session.quality,
          width: finiteNumber(summary?.width),
          height: finiteNumber(summary?.height),
          videoCodec: summary?.videoCodec ?? null,
          audioCodec: summary?.audioCodec ?? null,
          dynamicRange: summary?.dynamicRange ?? null,
          bitrateMbps: null
        },
        fallback: session.runtimeFallback
          ? {
              state: session.runtimeFallback.state,
              reason: session.runtimeFallback.reason,
              targetQuality: session.runtimeFallback.targetQuality
            }
          : null,
        candidate: null,
        createdAt: session.createdAt,
        lastActivityAt,
        expiresAt: session.expiresAt
      });
    }

    for (const session of fallback) {
      const transfer = this.transfers.get(session.playbackId);
      const lastActivityAt = Math.max(
        session.lastAccess,
        transfer?.lastActivityAt ?? 0
      );
      records.push({
        playbackId: session.playbackId,
        mediaFileId: session.mediaFileId,
        mediaId: session.mediaId,
        mediaType: session.mediaType,
        deviceId: session.deviceId,
        provider: 'fallback-addon',
        route: 'external_direct_http',
        state: this.stateFor(
          session.createdAt,
          lastActivityAt,
          session.candidateVerified ? 1 : 0,
          transfer
        ),
        season: session.season,
        episode: session.episode,
        target: {
          quality: null,
          width: null,
          height: session.resolutionHeight,
          videoCodec: null,
          audioCodec: null,
          dynamicRange: null,
          bitrateMbps: session.bitrateMbps
        },
        fallback: null,
        candidate: {
          attempt: session.candidateAttempt,
          count: session.candidateCount
        },
        createdAt: session.createdAt,
        lastActivityAt,
        expiresAt: session.expiresAt
      });
    }

    for (const activity of this.direct.values()) {
      records.push({
        playbackId: activity.playbackId,
        mediaFileId: activity.mediaFileId,
        mediaId: null,
        mediaType: activity.mediaType,
        deviceId: activity.deviceId,
        provider: 'nuvi-flow',
        route: 'direct_file',
        state: activity.activeTransfers > 0 ||
          now - activity.lastActivityAt <= this.idleWindowMs
          ? 'streaming'
          : 'idle',
        season: activity.season,
        episode: activity.episode,
        target: {
          quality: activity.file.quality,
          width: activity.file.width,
          height: activity.file.height,
          videoCodec: activity.file.video_codec,
          audioCodec: activity.file.audio_codec,
          dynamicRange: null,
          bitrateMbps: null
        },
        fallback: null,
        candidate: null,
        createdAt: activity.createdAt,
        lastActivityAt: activity.lastActivityAt,
        expiresAt: activity.expiresAt
      });
    }

    return records.sort((left, right) =>
      right.lastActivityAt - left.lastActivityAt
    );
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.direct.clear();
    this.transfers.clear();
  }

  private beginTransfer(playbackId: string): PlaybackActivityHandle {
    const transfer = this.transfers.get(playbackId) ?? {
      active: 0,
      lastActivityAt: this.now()
    };
    transfer.active += 1;
    transfer.lastActivityAt = this.now();
    this.transfers.set(playbackId, transfer);
    let finished = false;
    return {
      playbackId,
      finish: () => {
        if (finished) return;
        finished = true;
        const current = this.transfers.get(playbackId);
        if (!current) return;
        current.active = Math.max(0, current.active - 1);
        current.lastActivityAt = this.now();
      }
    };
  }

  private stateFor(
    createdAt: number,
    lastActivityAt: number,
    mediaRequestCount: number,
    transfer?: TransferState
  ): PlaybackActivityState {
    if (transfer?.active) {
      return 'streaming';
    }
    if (mediaRequestCount === 0 && this.now() - createdAt <= this.idleWindowMs) {
      return 'starting';
    }
    if (this.now() - lastActivityAt <= this.idleWindowMs) {
      return 'streaming';
    }
    return 'idle';
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, activity] of this.direct) {
      if (activity.activeTransfers === 0 && activity.expiresAt <= now) {
        this.direct.delete(key);
      }
    }
    for (const [playbackId, transfer] of this.transfers) {
      if (transfer.active === 0 &&
        transfer.lastActivityAt <= now - this.directLingerMs) {
        this.transfers.delete(playbackId);
      }
    }
  }
}
