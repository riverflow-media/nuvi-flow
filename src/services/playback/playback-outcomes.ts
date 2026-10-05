import type { AppDatabase } from '../../db/index.js';
import type {
  MediaType,
  PlaybackOutcomeCode,
  PlaybackOutcomeDomain,
  PlaybackOutcomeLevel,
  PlaybackOutcomeProvider,
  PlaybackOutcomeRoute,
  PlaybackOutcomeRow
} from '../../types.js';

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_ROWS = 2_000;
const DEFAULT_CLEANUP_EVERY = 1;

export interface PlaybackOutcomeInput {
  playbackId: string;
  code: PlaybackOutcomeCode;
  provider: PlaybackOutcomeProvider;
  route?: PlaybackOutcomeRoute | null;
  level: PlaybackOutcomeLevel;
  failureDomain: PlaybackOutcomeDomain;
  reason?: string | null;
  httpStatus?: number | null;
  mediaFileId?: string | null;
  mediaId?: string | null;
  mediaType?: MediaType | null;
  season?: number | null;
  episode?: number | null;
  deviceId?: string | null;
}

export interface PlaybackOutcome {
  playbackId: string;
  code: PlaybackOutcomeCode;
  provider: PlaybackOutcomeProvider;
  route: PlaybackOutcomeRoute | null;
  level: PlaybackOutcomeLevel;
  failureDomain: PlaybackOutcomeDomain;
  reason: string | null;
  httpStatus: number | null;
  mediaFileId: string | null;
  mediaId: string | null;
  mediaType: MediaType | null;
  season: number | null;
  episode: number | null;
  deviceId: string | null;
  capabilityEvidence: false;
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface PlaybackOutcomeSummary {
  total: number;
  warnings: number;
  errors: number;
  byFailureDomain: Record<string, number>;
}

interface PlaybackOutcomeStoreOptions {
  now?: () => number;
  retentionMs?: number;
  maxRows?: number;
  cleanupEvery?: number;
}

const PLAYBACK_OUTCOME_ROUTES = new Set<PlaybackOutcomeRoute>([
  'direct_file',
  'original_http',
  'server_remux_progressive',
  'server_remux_hls',
  'server_transcode_hls',
  'external_direct_http'
]);

export function playbackOutcomeRoute(
  value: string | null | undefined
): PlaybackOutcomeRoute | null {
  return value && PLAYBACK_OUTCOME_ROUTES.has(value as PlaybackOutcomeRoute)
    ? value as PlaybackOutcomeRoute
    : null;
}

function boundedText(value: string | null | undefined, maximum: number): string | null {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function safeReason(value: string | null | undefined): string | null {
  const reason = boundedText(value, 80);
  return reason && /^[a-z0-9_.-]+$/i.test(reason) ? reason.toLowerCase() : null;
}

function nullableInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function toOutcome(row: PlaybackOutcomeRow): PlaybackOutcome {
  return {
    playbackId: row.playback_id,
    code: row.code,
    provider: row.provider,
    route: row.route,
    level: row.level,
    failureDomain: row.failure_domain,
    reason: row.reason,
    httpStatus: row.http_status,
    mediaFileId: row.media_file_id,
    mediaId: row.media_id,
    mediaType: row.media_type,
    season: row.season,
    episode: row.episode,
    deviceId: row.device_id,
    // Server transport observations are deliberately never converted into
    // negative device-capability evidence. A future explicit client signal
    // needs a separate, reviewed path before this can ever become true.
    capabilityEvidence: false,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at
  };
}

/**
 * Persistent, sanitized, and bounded playback observations.
 *
 * One row is retained per playback/code pair so segment traffic cannot flood
 * SQLite. The store accepts only enumerated classifications and short reason
 * codes; URLs, tokens, paths, session IDs, request headers, and raw client
 * identity inputs have no field in this schema.
 */
export class PlaybackOutcomeStore {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxRows: number;
  private readonly cleanupEvery: number;
  private insertionsSinceCleanup = 0;

  constructor(
    private readonly database: AppDatabase,
    options: PlaybackOutcomeStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_RETENTION_MS);
    this.maxRows = Math.max(1, options.maxRows ?? DEFAULT_MAX_ROWS);
    this.cleanupEvery = Math.max(1, options.cleanupEvery ?? DEFAULT_CLEANUP_EVERY);
    this.cleanup();
  }

  record(input: PlaybackOutcomeInput): boolean {
    const playbackId = boundedText(input.playbackId, 80);
    if (!playbackId) return false;
    const now = this.now();
    const result = this.database.sqlite.prepare(
      `INSERT OR IGNORE INTO playback_outcomes (
        playback_id,code,provider,route,level,failure_domain,reason,http_status,
        media_file_id,media_id,media_type,season,episode,device_id,
        capability_evidence,first_observed_at,last_observed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`
    ).run(
      playbackId,
      input.code,
      input.provider,
      input.route ?? null,
      input.level,
      input.failureDomain,
      safeReason(input.reason),
      nullableInteger(input.httpStatus),
      boundedText(input.mediaFileId, 160),
      boundedText(input.mediaId, 200),
      input.mediaType ?? null,
      nullableInteger(input.season),
      nullableInteger(input.episode),
      boundedText(input.deviceId, 160),
      now,
      now
    );

    if (result.changes > 0) {
      this.insertionsSinceCleanup += 1;
      if (this.insertionsSinceCleanup >= this.cleanupEvery) this.cleanup();
      return true;
    }
    return false;
  }

  recent(limit = 50): PlaybackOutcome[] {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return (this.database.sqlite.prepare(
      `SELECT * FROM playback_outcomes
       WHERE last_observed_at>=?
       ORDER BY last_observed_at DESC, rowid DESC
       LIMIT ?`
    ).all(
      this.now() - this.retentionMs,
      boundedLimit
    ) as PlaybackOutcomeRow[]).map(toOutcome);
  }

  summarySince(since: number): PlaybackOutcomeSummary {
    const threshold = Number.isFinite(since) ? Math.trunc(since) : this.now();
    const rows = this.database.sqlite.prepare(
      `SELECT level,failure_domain,COUNT(*) count
       FROM playback_outcomes
       WHERE last_observed_at>=?
       GROUP BY level,failure_domain`
    ).all(threshold) as Array<{
      level: PlaybackOutcomeLevel;
      failure_domain: PlaybackOutcomeDomain;
      count: number;
    }>;
    const summary: PlaybackOutcomeSummary = {
      total: 0,
      warnings: 0,
      errors: 0,
      byFailureDomain: {}
    };
    for (const row of rows) {
      const count = Math.max(0, Number(row.count) || 0);
      summary.total += count;
      if (row.level === 'warning') summary.warnings += count;
      if (row.level === 'error') summary.errors += count;
      if (row.failure_domain !== 'none') {
        summary.byFailureDomain[row.failure_domain] =
          (summary.byFailureDomain[row.failure_domain] || 0) + count;
      }
    }
    return summary;
  }

  cleanup(): number {
    const expired = this.database.sqlite.prepare(
      'DELETE FROM playback_outcomes WHERE last_observed_at<?'
    ).run(this.now() - this.retentionMs).changes;
    const overflow = this.database.sqlite.prepare(
      `DELETE FROM playback_outcomes
       WHERE rowid IN (
         SELECT rowid FROM playback_outcomes
         ORDER BY last_observed_at DESC, rowid DESC
         LIMIT -1 OFFSET ?
       )`
    ).run(this.maxRows).changes;
    this.insertionsSinceCleanup = 0;
    return expired + overflow;
  }
}
