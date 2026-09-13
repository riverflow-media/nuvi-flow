import { createHash, randomUUID } from 'node:crypto';
import type { SiloPlaybackPlan } from '../silo.js';
import type {
  SiloPlaybackRequestProfile,
  SiloQualityPreference
} from './playback-policy.js';

export interface PlaybackRuntimeFallback {
  profileId: string;
  playbackAttemptId: string;
  plan: SiloPlaybackPlan;
  requestProfile: SiloPlaybackRequestProfile;
  targetQuality: SiloQualityPreference;
  state: 'ready' | 'pending' | 'completed' | 'failed';
  reason: 'startup_latency' | 'slow_segments' | 'status_failures' | null;
}

export interface PlaybackKeyParts {
  deviceId: string;
  mediaFileId: string;
  profileId: string;
  mode: string;
  quality: string;
  audioSelection: string;
  subtitleSelection: string;
  dynamicRangeMode: string;
  capabilityRevision?: string;
  season?: number;
  episode?: number;
}

export interface PlaybackSessionStart {
  siloSessionId: string | null;
  siloFileId: number;
  upstreamPath: string;
  delivery: string;
  runtimeFallback?: PlaybackRuntimeFallback;
}

export interface PlaybackSession extends PlaybackSessionStart {
  playbackId: string;
  playbackKey: string;
  deviceId: string;
  mediaFileId: string;
  profileId: string;
  mode: string;
  quality: string;
  season: number | null;
  episode: number | null;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
  maximumExpiresAt: number;
  mediaRequestCount: number;
  slowMediaResponseCount: number;
  lastMediaResponseMs: number | null;
  lastMediaStatus: number | null;
  consecutiveSlowSegmentCount: number;
  consecutiveFailureCount: number;
  lastPositionSeconds: number;
  pathAliases: string[];
}

export interface PlaybackMediaObservation {
  playbackId: string;
  siloSessionId: string | null;
  durationMs: number;
  status: number;
  requestCount: number;
  slowResponseCount: number;
  slow: boolean;
  summaryDue: boolean;
  fallbackDue: boolean;
  fallbackReason: PlaybackRuntimeFallback['reason'];
  playbackKey: string;
}

export interface PlaybackObservationOptions {
  slowSegmentMs: number;
  slowSegmentCount: number;
}

export type PlaybackSessionSource =
  | 'created'
  | 'coalesced'
  | 'reused';

export interface PlaybackSessionResult {
  session: PlaybackSession;
  source: PlaybackSessionSource;
}

export type PlaybackSessionRetirementReason =
  | 'fallback_selected'
  | 'expired'
  | 'shutdown'
  | 'superseded';

export interface PlaybackSessionMatch {
  deviceId: string;
  mediaFileId: string;
  profileId?: string;
  mode?: string;
  season?: number;
  episode?: number;
}

export class PlaybackSessionRetiredError extends Error {
  constructor() {
    super('Playback session creation was superseded by another route.');
    this.name = 'PlaybackSessionRetiredError';
  }
}

interface PlaybackSessionRegistryOptions {
  sessionTtlMs?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
}

interface PlaybackCreationContext {
  playbackId: string;
  playbackKey: string;
}

function normalizedKeyValue(
  value: string | number | undefined
): string | number | null {
  return value === undefined ? null : value;
}

export function createPlaybackKey(
  parts: PlaybackKeyParts
): string {
  const canonical = JSON.stringify({
    deviceId: parts.deviceId,
    mediaFileId: parts.mediaFileId,
    profileId: parts.profileId,
    mode: parts.mode,
    quality: parts.quality,
    audioSelection: parts.audioSelection,
    subtitleSelection: parts.subtitleSelection,
    dynamicRangeMode: parts.dynamicRangeMode,
    capabilityRevision: normalizedKeyValue(parts.capabilityRevision),
    season: normalizedKeyValue(parts.season),
    episode: normalizedKeyValue(parts.episode)
  });

  return createHash('sha256')
    .update(canonical)
    .digest('base64url');
}

export class PlaybackSessionRegistry {
  private readonly pendingSessions = new Map<
    string,
    {
      promise: Promise<PlaybackSession>;
      parts: PlaybackKeyParts;
      generation: number;
    }
  >();

  private readonly activeSessions = new Map<
    string,
    PlaybackSession
  >();

  private readonly segmentPositions = new Map<
    string,
    { playbackKey: string; positionSeconds: number }
  >();

  private readonly retirementGenerations = new Map<string, number>();
  private readonly pendingRetirementReasons = new Map<
    string,
    PlaybackSessionRetirementReason
  >();
  private retirementHandler: (
    session: PlaybackSession,
    reason: PlaybackSessionRetirementReason
  ) => Promise<void> = async () => {};

  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout | null;

  constructor(
    options: PlaybackSessionRegistryOptions = {}
  ) {
    this.sessionTtlMs =
      options.sessionTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;

    const cleanupIntervalMs =
      options.cleanupIntervalMs ?? 60_000;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(
        () => void this.cleanupExpired(),
        cleanupIntervalMs
      );
      this.cleanupTimer.unref();
    } else {
      this.cleanupTimer = null;
    }
  }

  setRetirementHandler(handler: (
    session: PlaybackSession,
    reason: PlaybackSessionRetirementReason
  ) => Promise<void>): void {
    this.retirementHandler = handler;
  }

  async getOrCreate(
    parts: PlaybackKeyParts,
    maximumExpiresAt: number,
    create: (
      context: PlaybackCreationContext
    ) => Promise<PlaybackSessionStart>
  ): Promise<PlaybackSessionResult> {
    const now = this.now();

    if (maximumExpiresAt <= now) {
      throw new Error(
        'Playback authorization has expired.'
      );
    }

    const playbackKey = createPlaybackKey(parts);
    const active = this.activeSessions.get(playbackKey);

    if (active) {
      if (active.expiresAt > now) {
        active.lastAccess = now;
        active.expiresAt = Math.min(
          active.maximumExpiresAt,
          now + this.sessionTtlMs
        );
        return {
          session: active,
          source: 'reused'
        };
      }

      await this.retireSession(playbackKey, active, 'expired');
    }

    const pending =
      this.pendingSessions.get(playbackKey);

    if (pending) {
      return {
        session: await pending.promise,
        source: 'coalesced'
      };
    }

    const playbackId = randomUUID();
    const generation = this.retirementGenerations.get(playbackKey) || 0;
    const pendingCreation = (async () => {
      const started = await create({
        playbackId,
        playbackKey
      });
      const createdAt = this.now();
      const session: PlaybackSession = {
        ...started,
        playbackId,
        playbackKey,
        deviceId: parts.deviceId,
        mediaFileId: parts.mediaFileId,
        profileId: parts.profileId,
        mode: parts.mode,
        quality: parts.quality,
        season: parts.season ?? null,
        episode: parts.episode ?? null,
        createdAt,
        lastAccess: createdAt,
        expiresAt: Math.min(
          maximumExpiresAt,
          createdAt + this.sessionTtlMs
        ),
        maximumExpiresAt,
        mediaRequestCount: 0,
        slowMediaResponseCount: 0,
        lastMediaResponseMs: null,
        lastMediaStatus: null,
        consecutiveSlowSegmentCount: 0,
        consecutiveFailureCount: 0,
        lastPositionSeconds: started.runtimeFallback?.plan.timeline
          ?.source_start_seconds || 0,
        pathAliases: []
      };

      if ((this.retirementGenerations.get(playbackKey) || 0) !== generation) {
        await this.retirementHandler(
          session,
          this.pendingRetirementReasons.get(playbackKey) || 'superseded'
        );
        throw new PlaybackSessionRetiredError();
      }

      this.activeSessions.set(
        playbackKey,
        session
      );

      return session;
    })();

    this.pendingSessions.set(
      playbackKey,
      { promise: pendingCreation, parts, generation }
    );

    try {
      return {
        session: await pendingCreation,
        source: 'created'
      };
    } finally {
      if (
        this.pendingSessions.get(playbackKey)?.promise ===
        pendingCreation
      ) {
        this.pendingSessions.delete(playbackKey);
      }
      if (!this.pendingSessions.has(playbackKey) &&
        !this.activeSessions.has(playbackKey)) {
        this.retirementGenerations.delete(playbackKey);
        this.pendingRetirementReasons.delete(playbackKey);
      }
    }
  }

  async cleanupExpired(): Promise<number> {
    const now = this.now();
    let removed = 0;

    for (const [key, session] of this.activeSessions) {
      if (session.expiresAt > now) continue;
      await this.retireSession(key, session, 'expired');
      removed += 1;
    }

    return removed;
  }

  async retireMatching(
    match: PlaybackSessionMatch,
    reason: PlaybackSessionRetirementReason
  ): Promise<number> {
    let retired = 0;

    for (const [key, pending] of this.pendingSessions) {
      if (!this.matches(pending.parts, match)) continue;
      this.retirementGenerations.set(
        key,
        (this.retirementGenerations.get(key) || 0) + 1
      );
      this.pendingRetirementReasons.set(key, reason);
    }

    for (const [key, session] of this.activeSessions) {
      if (!this.matches(session, match)) continue;
      await this.retireSession(key, session, reason);
      retired += 1;
    }

    return retired;
  }

  touchUpstreamPath(pathname: string): boolean {
    const requestedRoot = playbackTransportRoot(pathname);
    if (!requestedRoot) return false;
    const now = this.now();

    for (const session of this.activeSessions.values()) {
      if (session.expiresAt <= now) continue;
      if (playbackTransportRoot(session.upstreamPath) !== requestedRoot) continue;
      session.lastAccess = now;
      session.expiresAt = Math.min(
        session.maximumExpiresAt,
        now + this.sessionTtlMs
      );
      return true;
    }

    return false;
  }

  recordUpstreamResponse(
    pathname: string,
    durationMs: number,
    status: number,
    options: PlaybackObservationOptions = {
      slowSegmentMs: 2000,
      slowSegmentCount: 3
    }
  ): PlaybackMediaObservation | null {
    const requestedRoot = playbackTransportRoot(pathname);
    if (!requestedRoot) return null;
    const segment = new URL(pathname, 'http://silo.invalid')
      .pathname.includes('/segment/');
    const failed = status === 0 || status === 404 || status === 408 ||
      status === 429 || status >= 500;
    const slow = failed || (segment && durationMs >= options.slowSegmentMs);

    for (const session of this.activeSessions.values()) {
      if (session.expiresAt <= this.now()) continue;
      if (playbackTransportRoot(session.upstreamPath) !== requestedRoot) continue;
      session.mediaRequestCount += 1;
      session.lastMediaResponseMs = durationMs;
      session.lastMediaStatus = status;
      const position = this.segmentPositions.get(pathname);
      if (position?.playbackKey === session.playbackKey) {
        session.lastPositionSeconds = Math.max(
          0,
          position.positionSeconds
        );
      }
      if (slow) session.slowMediaResponseCount += 1;
      session.consecutiveSlowSegmentCount = segment && slow
        ? session.consecutiveSlowSegmentCount + 1
        : 0;
      session.consecutiveFailureCount = failed
        ? session.consecutiveFailureCount + 1
        : 0;
      const fallbackReason = session.runtimeFallback?.state === 'ready'
        ? session.consecutiveFailureCount >= 2
          ? 'status_failures'
          : session.consecutiveSlowSegmentCount >= options.slowSegmentCount
            ? 'slow_segments'
            : null
        : null;

      return {
        playbackKey: session.playbackKey,
        playbackId: session.playbackId,
        siloSessionId: session.siloSessionId,
        durationMs,
        status,
        requestCount: session.mediaRequestCount,
        slowResponseCount: session.slowMediaResponseCount,
        slow,
        fallbackDue: fallbackReason !== null,
        fallbackReason,
        summaryDue: slow && (
          session.slowMediaResponseCount === 3 ||
          session.slowMediaResponseCount % 10 === 0
        )
      };
    }

    return null;
  }

  recordSegmentTimeline(entries: Array<{ path: string; positionSeconds: number }>): void {
    for (const entry of entries) {
      const requestedRoot = playbackTransportRoot(entry.path);
      if (!requestedRoot) continue;
      for (const session of this.activeSessions.values()) {
        const roots = [session.upstreamPath, ...session.pathAliases]
          .map(playbackTransportRoot);
        if (!roots.includes(requestedRoot)) continue;
        this.segmentPositions.set(entry.path, {
          playbackKey: session.playbackKey,
          positionSeconds: Math.max(0, entry.positionSeconds)
        });
        if (this.segmentPositions.size > 10_000) {
          const oldest = this.segmentPositions.keys().next().value;
          if (oldest) this.segmentPositions.delete(oldest);
        }
      }
    }
  }

  claimRuntimeFallback(
    playbackKey: string,
    reason: NonNullable<PlaybackRuntimeFallback['reason']>
  ): PlaybackSession | null {
    const session = this.activeSessions.get(playbackKey);
    if (!session?.runtimeFallback || session.runtimeFallback.state !== 'ready') {
      return null;
    }
    session.runtimeFallback.state = 'pending';
    session.runtimeFallback.reason = reason;
    return session;
  }

  completeRuntimeFallback(
    playbackKey: string,
    result: {
      plan: SiloPlaybackPlan;
      upstreamPath: string;
      delivery: string;
      siloSessionId?: string | null;
    } | null
  ): boolean {
    const session = this.activeSessions.get(playbackKey);
    if (!session?.runtimeFallback || session.runtimeFallback.state !== 'pending') return false;
    if (!result) {
      session.runtimeFallback.state = 'failed';
      return true;
    }
    if (session.upstreamPath !== result.upstreamPath) {
      session.pathAliases.push(session.upstreamPath);
    }
    session.upstreamPath = result.upstreamPath;
    session.delivery = result.delivery;
    if (result.siloSessionId) session.siloSessionId = result.siloSessionId;
    session.runtimeFallback.plan = result.plan;
    session.runtimeFallback.state = 'completed';
    return true;
  }

  resolveUpstreamPath(pathname: string): string {
    for (const session of this.activeSessions.values()) {
      if (session.expiresAt <= this.now()) continue;
      if (pathname === session.upstreamPath) return pathname;
      if (session.pathAliases.includes(pathname)) return session.upstreamPath;

      const requestedRoot = playbackTransportRoot(pathname);
      const currentRoot = playbackTransportRoot(session.upstreamPath);
      if (!requestedRoot || !currentRoot) continue;
      if (!session.pathAliases.some(alias => playbackTransportRoot(alias) === requestedRoot)) {
        continue;
      }
      return currentRoot + pathname.slice(requestedRoot.length);
    }
    return pathname;
  }

  sourceStartSeconds(pathname: string): number {
    const requestedRoot = playbackTransportRoot(pathname);
    if (!requestedRoot) return 0;
    for (const session of this.activeSessions.values()) {
      const roots = [session.upstreamPath, ...session.pathAliases]
        .map(playbackTransportRoot);
      if (!roots.includes(requestedRoot)) continue;
      return Math.max(
        0,
        session.runtimeFallback?.plan.timeline?.source_start_seconds || 0
      );
    }
    return 0;
  }

  async activeSnapshot(): Promise<PlaybackSession[]> {
    await this.cleanupExpired();
    return [...this.activeSessions.values()].map(session => ({ ...session }));
  }

  counts(): { pending: number; active: number } {
    return {
      pending: this.pendingSessions.size,
      active: this.activeSessions.size
    };
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    for (const key of this.pendingSessions.keys()) {
      this.retirementGenerations.set(
        key,
        (this.retirementGenerations.get(key) || 0) + 1
      );
      this.pendingRetirementReasons.set(key, 'shutdown');
    }
    await Promise.allSettled(
      [...this.pendingSessions.values()].map(entry => entry.promise)
    );
    const active = [...this.activeSessions.entries()];
    for (const [key, session] of active) {
      await this.retireSession(key, session, 'shutdown');
    }
    this.pendingSessions.clear();
    this.pendingRetirementReasons.clear();
    this.retirementGenerations.clear();
    this.segmentPositions.clear();
  }

  private matches(
    candidate: {
      deviceId: string;
      mediaFileId: string;
      profileId: string;
      mode: string;
      season?: number | null;
      episode?: number | null;
    },
    match: PlaybackSessionMatch
  ): boolean {
    return candidate.deviceId === match.deviceId &&
      candidate.mediaFileId === match.mediaFileId &&
      (match.profileId === undefined || candidate.profileId === match.profileId) &&
      (match.mode === undefined || candidate.mode === match.mode) &&
      (match.season === undefined || candidate.season === match.season) &&
      (match.episode === undefined || candidate.episode === match.episode);
  }

  private async retireSession(
    key: string,
    session: PlaybackSession,
    reason: PlaybackSessionRetirementReason
  ): Promise<void> {
    if (this.activeSessions.get(key) === session) {
      this.activeSessions.delete(key);
    }
    for (const [path, position] of this.segmentPositions) {
      if (position.playbackKey === session.playbackKey) {
        this.segmentPositions.delete(path);
      }
    }
    await this.retirementHandler(session, reason);
  }
}

export function playbackTransportRoot(pathname: string): string | null {
  const match = pathname.match(
    /^(\/api\/v1\/(?:playback\/transcode|stream)\/[^/?#]+)/
  );
  return match?.[1] || null;
}
