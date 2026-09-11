import { createHash, randomUUID } from 'node:crypto';

export interface PlaybackKeyParts {
  deviceId: string;
  mediaFileId: string;
  profileId: string;
  mode: string;
  quality: string;
  audioSelection: string;
  subtitleSelection: string;
  dynamicRangeMode: string;
  season?: number;
  episode?: number;
}

export interface PlaybackSessionStart {
  siloSessionId: string | null;
  siloFileId: number;
  upstreamPath: string;
  delivery: string;
}

export interface PlaybackSession extends PlaybackSessionStart {
  playbackId: string;
  playbackKey: string;
  deviceId: string;
  mediaFileId: string;
  quality: string;
  createdAt: number;
  lastAccess: number;
  expiresAt: number;
}

export type PlaybackSessionSource =
  | 'created'
  | 'coalesced'
  | 'reused';

export interface PlaybackSessionResult {
  session: PlaybackSession;
  source: PlaybackSessionSource;
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
    season: normalizedKeyValue(parts.season),
    episode: normalizedKeyValue(parts.episode)
  });

  return createHash('sha256')
    .update(canonical)
    .digest('base64url');
}

export interface ProvisionalDeviceIdentityInput {
  explicitDeviceId?: string;
  clientName?: string;
  clientVersion?: string;
  userAgent?: string;
  ip: string;
  streamTokenId: string;
}

export function provisionalDeviceId(
  input: ProvisionalDeviceIdentityInput
): string {
  const explicit = input.explicitDeviceId?.trim();
  const material = explicit
    ? [
        'explicit',
        explicit,
        input.clientName || '',
        input.clientVersion || ''
      ]
    : [
        'request-scope',
        input.ip,
        input.userAgent || '',
        input.clientName || '',
        input.clientVersion || '',
        input.streamTokenId
      ];

  const digest = createHash('sha256')
    .update(JSON.stringify(material))
    .digest('hex')
    .slice(0, 24);

  return `provisional_${digest}`;
}

export class PlaybackSessionRegistry {
  private readonly pendingSessions = new Map<
    string,
    Promise<PlaybackSession>
  >();

  private readonly activeSessions = new Map<
    string,
    PlaybackSession
  >();

  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly cleanupTimer: NodeJS.Timeout | null;

  constructor(
    options: PlaybackSessionRegistryOptions = {}
  ) {
    this.sessionTtlMs =
      options.sessionTtlMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;

    const cleanupIntervalMs =
      options.cleanupIntervalMs ?? 60_000;

    if (cleanupIntervalMs > 0) {
      this.cleanupTimer = setInterval(
        () => this.cleanupExpired(),
        cleanupIntervalMs
      );
      this.cleanupTimer.unref();
    } else {
      this.cleanupTimer = null;
    }
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
        return {
          session: active,
          source: 'reused'
        };
      }

      this.activeSessions.delete(playbackKey);
    }

    const pending =
      this.pendingSessions.get(playbackKey);

    if (pending) {
      return {
        session: await pending,
        source: 'coalesced'
      };
    }

    const playbackId = randomUUID();
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
        quality: parts.quality,
        createdAt,
        lastAccess: createdAt,
        expiresAt: Math.min(
          maximumExpiresAt,
          createdAt + this.sessionTtlMs
        )
      };

      this.activeSessions.set(
        playbackKey,
        session
      );

      return session;
    })();

    this.pendingSessions.set(
      playbackKey,
      pendingCreation
    );

    try {
      return {
        session: await pendingCreation,
        source: 'created'
      };
    } finally {
      if (
        this.pendingSessions.get(playbackKey) ===
        pendingCreation
      ) {
        this.pendingSessions.delete(playbackKey);
      }
    }
  }

  cleanupExpired(): number {
    const now = this.now();
    let removed = 0;

    for (const [key, session] of this.activeSessions) {
      if (session.expiresAt > now) continue;
      this.activeSessions.delete(key);
      removed += 1;
    }

    return removed;
  }

  counts(): { pending: number; active: number } {
    return {
      pending: this.pendingSessions.size,
      active: this.activeSessions.size
    };
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.pendingSessions.clear();
    this.activeSessions.clear();
  }
}
