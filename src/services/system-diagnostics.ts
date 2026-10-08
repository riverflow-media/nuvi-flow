import fs from 'node:fs';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { buildInfo, type BuildInfo } from '../lib/build-info.js';
import type { MediaScanner } from './scanner.js';
import type { SettingsService } from './settings.js';
import type { SiloService } from './silo-service.js';
import type { FallbackAddonService } from './playback/fallback-addon.js';
import type { PlaybackOutcomeStore } from './playback/playback-outcomes.js';
import type { PlaybackService } from './playback/playback-service.js';
import type { DatabaseBackupService } from './database-backups.js';
import type { PlaybackServersService } from './playback-servers.js';
import type { PlaybackServerMappingSummary } from './playback-server-mappings.js';
import type { JellyfinPlaybackService } from './playback/jellyfin-playback.js';

export type SystemDiagnosticStatus =
  | 'healthy'
  | 'warning'
  | 'error'
  | 'disabled';

export interface SystemDiagnosticCheck {
  id: string;
  label: string;
  status: SystemDiagnosticStatus;
  summary: string;
  latencyMs: number | null;
}

export interface SystemDiagnosticsSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy';
  generatedAt: number;
  expiresAt: number;
  build: BuildInfo;
  uptimeSeconds: number;
  checks: SystemDiagnosticCheck[];
  operations: {
    scanner: {
      running: boolean;
      phase: string | null;
      progressPercent: number | null;
    };
    silo: {
      activeSessions: number;
      pendingSessions: number;
      activeStarts: number;
      queuedStarts: number;
      maxConcurrentStarts: number;
      maxQueuedStarts: number;
    };
    jellyfin: { active: number; pending: number; transfers: number };
    fallback: { active: number; transfers: number };
  };
  recentOutcomes: {
    windowMinutes: number;
    total: number;
    warnings: number;
    errors: number;
    byFailureDomain: Record<string, number>;
  };
}

interface SystemDiagnosticsOptions {
  now?: () => number;
  uptime?: () => number;
  cacheTtlMs?: number;
}

interface ScanRunSummary {
  status: string;
  errors: number;
  finished_at: number | null;
}

const OUTCOME_WINDOW_MS = 60 * 60_000;

function bounded(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 120)
    : fallback;
}

function mappingSummaryText(summary: PlaybackServerMappingSummary): string {
  if (summary.total === 0) {
    return 'No eligible local files are awaiting exact mapping.';
  }
  const attention = summary.total - summary.mapped;
  const reasons = [
    summary.pending ? `${summary.pending} pending` : '',
    summary.stale ? `${summary.stale} stale` : '',
    summary.notFound ? `${summary.notFound} not found` : '',
    summary.ambiguous ? `${summary.ambiguous} ambiguous` : '',
    summary.errors ? `${summary.errors} invalid` : ''
  ].filter(Boolean);
  const suffix = attention > 0
    ? `; ${reasons.join(', ') || `${attention} unavailable`}`
    : summary.refreshDue > 0
      ? `; ${summary.refreshDue} due for revalidation`
      : '';
  return `Exact mapping is ready for ${summary.mapped} of ${summary.total} local files${suffix}.`;
}

/**
 * Builds one authenticated, deliberately sanitized operational snapshot.
 *
 * External integration checks are cached and single-flight so opening the
 * dashboard cannot recreate the rapid idle polling that this project avoids.
 * Paths, URLs, credentials, tokens, raw device identities, and upstream error
 * strings have no field in the returned contract.
 */
export class SystemDiagnosticsService {
  private readonly now: () => number;
  private readonly uptime: () => number;
  private readonly cacheTtlMs: number;
  private cached: SystemDiagnosticsSnapshot | null = null;
  private pending: Promise<SystemDiagnosticsSnapshot> | null = null;
  private cacheGeneration = 0;

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: SettingsService,
    private readonly scanner: MediaScanner,
    private readonly silo: SiloService,
    private readonly fallbackAddon: FallbackAddonService,
    private readonly playback: PlaybackService,
    private readonly playbackOutcomes: PlaybackOutcomeStore,
    private readonly databaseBackups: DatabaseBackupService,
    private readonly playbackServers: PlaybackServersService,
    private readonly jellyfinPlayback: JellyfinPlaybackService,
    private readonly config: AppConfig,
    options: SystemDiagnosticsOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.uptime = options.uptime ?? process.uptime;
    this.cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? 60_000);
  }

  snapshot(forceRefresh = false): Promise<SystemDiagnosticsSnapshot> {
    const now = this.now();
    if (!forceRefresh && this.cached && this.cached.expiresAt > now) {
      return Promise.resolve(this.cached);
    }
    if (this.pending) return this.pending;

    const cacheGeneration = this.cacheGeneration;
    const pending = this.generate().then(snapshot => {
      if (this.cacheGeneration === cacheGeneration) this.cached = snapshot;
      return snapshot;
    }).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  invalidate(): void {
    this.cacheGeneration += 1;
    this.cached = null;
    this.pending = null;
  }

  private async generate(): Promise<SystemDiagnosticsSnapshot> {
    const generatedAt = this.now();
    const recentOutcomes = this.recentOutcomeSummary(generatedAt);
    const checks = await Promise.all([
      this.databaseCheck(),
      this.databaseBackupCheck(),
      this.libraryRootCheck('movies_root', 'Movies library', this.settings.moviesPath),
      this.libraryRootCheck('tv_root', 'TV library', this.settings.tvPath),
      this.libraryRootCheck('anime_root', 'Anime library', this.settings.animePath, true),
      this.scannerCheck(),
      this.securityCheck(),
      this.siloCheck(),
      this.jellyfinCheck(),
      this.plexCheck(),
      this.fallbackCheck(),
      Promise.resolve(this.playbackOperationsCheck()),
      Promise.resolve(this.outcomeCheck(recentOutcomes))
    ]);
    const operations = this.playback.operationsSnapshot();
    const jellyfin = this.jellyfinPlayback.counts();
    const fallback = this.fallbackAddon.counts();
    const scan = this.scanner.snapshot();
    const status = checks.some(check => check.status === 'error')
      ? 'unhealthy'
      : checks.some(check => check.status === 'warning')
        ? 'degraded'
        : 'healthy';

    return {
      status,
      generatedAt,
      expiresAt: generatedAt + this.cacheTtlMs,
      build: buildInfo(),
      uptimeSeconds: Math.max(0, Math.floor(this.uptime())),
      checks,
      operations: {
        scanner: {
          running: Boolean(scan),
          phase: scan?.phase ?? null,
          progressPercent: scan?.progressPercent ?? null
        },
        silo: {
          activeSessions: operations.sessions.active,
          pendingSessions: operations.sessions.pending,
          activeStarts: operations.starts.active,
          queuedStarts: operations.starts.queued,
          maxConcurrentStarts: operations.starts.maxConcurrent,
          maxQueuedStarts: operations.starts.maxQueued
        },
        jellyfin,
        fallback
      },
      recentOutcomes
    };
  }

  private async databaseCheck(): Promise<SystemDiagnosticCheck> {
    const startedAt = this.now();
    try {
      const result = this.database.sqlite.pragma('quick_check', {
        simple: true
      });
      return {
        id: 'database',
        label: 'Database integrity',
        status: result === 'ok' ? 'healthy' : 'error',
        summary: result === 'ok'
          ? 'SQLite quick check passed.'
          : 'SQLite reported an integrity problem.',
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'database',
        label: 'Database integrity',
        status: 'error',
        summary: 'The database integrity check could not run.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async databaseBackupCheck(): Promise<SystemDiagnosticCheck> {
    const startedAt = this.now();
    try {
      const snapshot = await this.databaseBackups.snapshot();
      if (!snapshot.automatic.enabled) {
        return {
          id: 'database_backups',
          label: 'Database backups',
          status: 'disabled',
          summary: snapshot.backups.length
            ? `Automatic backups are disabled; ${snapshot.backups.length} verified backup${snapshot.backups.length === 1 ? '' : 's'} retained.`
            : 'Automatic backups are disabled; manual backups remain available.',
          latencyMs: this.elapsed(startedAt)
        };
      }
      if (snapshot.running) {
        return {
          id: 'database_backups',
          label: 'Database backups',
          status: 'healthy',
          summary: 'A live database backup is being created and verified.',
          latencyMs: this.elapsed(startedAt)
        };
      }
      if (snapshot.lastError) {
        return {
          id: 'database_backups',
          label: 'Database backups',
          status: 'warning',
          summary: snapshot.lastError.message,
          latencyMs: this.elapsed(startedAt)
        };
      }
      if (!snapshot.latest) {
        return {
          id: 'database_backups',
          label: 'Database backups',
          status: 'warning',
          summary: 'No verified database backup exists yet.',
          latencyMs: this.elapsed(startedAt)
        };
      }
      const ageHours = Math.max(0, (this.now() - snapshot.latest.createdAt) / (60 * 60_000));
      const overdue = snapshot.automatic.nextDueAt != null &&
        snapshot.automatic.nextDueAt + 5 * 60_000 < this.now();
      return {
        id: 'database_backups',
        label: 'Database backups',
        status: overdue ? 'warning' : 'healthy',
        summary: overdue
          ? 'The latest verified database backup is overdue.'
          : `Latest verified backup is ${ageHours < 1 ? 'less than one hour' : `${Math.floor(ageHours)} hour${Math.floor(ageHours) === 1 ? '' : 's'}`} old; ${snapshot.backups.length} retained.`,
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'database_backups',
        label: 'Database backups',
        status: 'error',
        summary: 'Backup storage could not be inspected.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async libraryRootCheck(
    id: string,
    label: string,
    root: string,
    optional = false
  ): Promise<SystemDiagnosticCheck> {
    const startedAt = this.now();
    if (!root.trim() && optional) {
      return {
        id,
        label,
        status: 'disabled',
        summary: 'Optional library root is not configured.',
        latencyMs: null
      };
    }
    if (!root.trim()) {
      return {
        id,
        label,
        status: 'error',
        summary: 'Library root is not configured.',
        latencyMs: null
      };
    }

    try {
      const stat = await fs.promises.stat(root);
      if (!stat.isDirectory()) throw new Error('not-directory');
      await fs.promises.access(root, fs.constants.R_OK);
      return {
        id,
        label,
        status: 'healthy',
        summary: 'Configured directory is readable.',
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id,
        label,
        status: 'error',
        summary: 'Configured directory is unavailable or unreadable.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async scannerCheck(): Promise<SystemDiagnosticCheck> {
    const scan = this.scanner.snapshot();
    if (scan) {
      const progress = scan.progressPercent == null
        ? `${scan.discovered} files discovered`
        : `${scan.examined} of ${scan.discovered} files examined`;
      return {
        id: 'scanner',
        label: 'Library scanner',
        status: 'healthy',
        summary: scan.cancelRequested
          ? 'A library scan is stopping safely.'
          : `A ${scan.mode} scan is ${scan.phase}; ${progress}.`,
        latencyMs: null
      };
    }
    const latest = this.database.sqlite.prepare(
      `SELECT status,errors,finished_at
       FROM scan_runs
       ORDER BY started_at DESC
       LIMIT 1`
    ).get() as ScanRunSummary | undefined;
    if (!latest) {
      return {
        id: 'scanner',
        label: 'Library scanner',
        status: 'warning',
        summary: 'No library scan has completed yet.',
        latencyMs: null
      };
    }
    if (latest.status !== 'completed') {
      return {
        id: 'scanner',
        label: 'Library scanner',
        status: 'warning',
        summary: 'The most recent scan did not finish cleanly.',
        latencyMs: null
      };
    }
    const errors = Math.max(0, Number(latest.errors) || 0);
    return {
      id: 'scanner',
      label: 'Library scanner',
      status: errors ? 'warning' : 'healthy',
      summary: errors
        ? `The most recent scan completed with ${errors} error${errors === 1 ? '' : 's'}.`
        : 'The most recent scan completed without errors.',
      latencyMs: null
    };
  }

  private async securityCheck(): Promise<SystemDiagnosticCheck> {
    const shortSecrets = [
      this.config.sessionSecret,
      this.config.streamSecret
    ].filter(secret => secret.length < 32).length;
    return {
      id: 'runtime_secrets',
      label: 'Runtime secrets',
      status: shortSecrets ? 'warning' : 'healthy',
      summary: shortSecrets
        ? `${shortSecrets} runtime secret${shortSecrets === 1 ? '' : 's'} should be at least 32 characters.`
        : 'Session and stream secrets meet the minimum length.',
      latencyMs: null
    };
  }

  private async siloCheck(): Promise<SystemDiagnosticCheck> {
    if (!this.settings.siloEnabled) {
      return {
        id: 'silo',
        label: 'Silo playback',
        status: 'disabled',
        summary: 'Silo integration is disabled.',
        latencyMs: null
      };
    }
    if (!this.settings.siloUrl || !this.settings.siloApiKey ||
      !this.settings.siloProfileId) {
      return {
        id: 'silo',
        label: 'Silo playback',
        status: 'error',
        summary: 'Silo is enabled but its connection or profile is incomplete.',
        latencyMs: null
      };
    }

    const startedAt = this.now();
    try {
      const { health, profiles } = await this.silo.testConnection(
        this.settings.siloUrl,
        this.settings.siloApiKey
      );
      const selected = profiles.find(profile =>
        profile.id === this.settings.siloProfileId
      );
      if (!selected) {
        return {
          id: 'silo',
          label: 'Silo playback',
          status: 'error',
          summary: 'Silo is reachable, but the selected profile is unavailable.',
          latencyMs: this.elapsed(startedAt)
        };
      }
      const serverStatus = bounded(health.status, 'unknown').toLowerCase();
      const ready = ['ok', 'healthy', 'ready'].includes(serverStatus);
      return {
        id: 'silo',
        label: 'Silo playback',
        status: ready ? 'healthy' : 'warning',
        summary: ready
          ? `${bounded(health.server_name, 'Silo')} is reachable; profile ${bounded(selected.name, 'selected')} is available.`
          : 'Silo is reachable but did not report a ready status.',
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'silo',
        label: 'Silo playback',
        status: 'error',
        summary: 'Silo could not be reached with the saved configuration.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async jellyfinCheck(): Promise<SystemDiagnosticCheck> {
    if (!this.settings.jellyfinEnabled) {
      return {
        id: 'jellyfin',
        label: 'Jellyfin playback server',
        status: 'disabled',
        summary: 'Jellyfin integration is disabled.',
        latencyMs: null
      };
    }
    if (!this.settings.jellyfinUrl || !this.settings.jellyfinApiKey ||
      !this.settings.jellyfinUserId) {
      return {
        id: 'jellyfin',
        label: 'Jellyfin playback server',
        status: 'error',
        summary: 'Jellyfin is enabled but its connection or playback user is incomplete.',
        latencyMs: null
      };
    }

    const startedAt = this.now();
    try {
      const { server, users } = await this.playbackServers.testJellyfin();
      const selected = users.find(user =>
        user.id === this.settings.jellyfinUserId && !user.disabled
      );
      if (!selected) {
        return {
          id: 'jellyfin',
          label: 'Jellyfin playback server',
          status: 'error',
          summary: 'Jellyfin is reachable, but the selected playback user is unavailable.',
          latencyMs: this.elapsed(startedAt)
        };
      }
      const mapping = this.playbackServers.mappingSummary(
        'jellyfin',
        server.id
      );
      const mappingReady = mapping.mapped === mapping.total &&
        mapping.refreshDue === 0;
      return {
        id: 'jellyfin',
        label: 'Jellyfin playback server',
        status: mappingReady ? 'healthy' : 'warning',
        summary: `${bounded(server.name, 'Jellyfin')} ${bounded(server.version, 'unknown')} is authenticated; playback user ${bounded(selected.name, 'selected')} is available. ${mappingSummaryText(mapping)}`,
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'jellyfin',
        label: 'Jellyfin playback server',
        status: 'error',
        summary: 'Jellyfin could not be reached with the saved configuration.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async plexCheck(): Promise<SystemDiagnosticCheck> {
    if (!this.settings.plexEnabled) {
      return {
        id: 'plex',
        label: 'Plex playback server',
        status: 'disabled',
        summary: 'Plex integration is disabled.',
        latencyMs: null
      };
    }
    if (!this.settings.plexUrl || !this.settings.plexToken) {
      return {
        id: 'plex',
        label: 'Plex playback server',
        status: 'error',
        summary: 'Plex is enabled but its connection is incomplete.',
        latencyMs: null
      };
    }

    const startedAt = this.now();
    try {
      const { server, libraries } = await this.playbackServers.testPlex();
      const mapping = this.playbackServers.mappingSummary('plex', server.id);
      const mappingReady = mapping.mapped === mapping.total &&
        mapping.refreshDue === 0;
      return {
        id: 'plex',
        label: 'Plex playback server',
        status: libraries.length && mappingReady ? 'healthy' : 'warning',
        summary: libraries.length
          ? `${bounded(server.name, 'Plex')} ${bounded(server.version, 'unknown')} is authenticated; ${libraries.length} accessible ${libraries.length === 1 ? 'library' : 'libraries'} found. ${mappingSummaryText(mapping)}`
          : 'Plex is authenticated, but no accessible libraries were returned.',
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'plex',
        label: 'Plex playback server',
        status: 'error',
        summary: 'Plex could not be reached with the saved configuration.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private async fallbackCheck(): Promise<SystemDiagnosticCheck> {
    if (!this.settings.fallbackAddonEnabled) {
      return {
        id: 'fallback_addon',
        label: 'Fallback addon',
        status: 'disabled',
        summary: 'Fallback addon integration is disabled.',
        latencyMs: null
      };
    }
    if (!this.settings.fallbackAddonManifestUrl) {
      return {
        id: 'fallback_addon',
        label: 'Fallback addon',
        status: 'error',
        summary: 'Fallback addon is enabled but no private manifest is configured.',
        latencyMs: null
      };
    }

    const startedAt = this.now();
    try {
      const connection = await this.fallbackAddon.testConnection();
      return {
        id: 'fallback_addon',
        label: 'Fallback addon',
        status: 'healthy',
        summary: `${bounded(connection.name, 'Fallback addon')} ${bounded(connection.version, 'unknown')} exposes a compatible stream resource.`,
        latencyMs: this.elapsed(startedAt)
      };
    } catch {
      return {
        id: 'fallback_addon',
        label: 'Fallback addon',
        status: 'error',
        summary: 'Fallback addon could not be reached with the saved configuration.',
        latencyMs: this.elapsed(startedAt)
      };
    }
  }

  private playbackOperationsCheck(): SystemDiagnosticCheck {
    const operations = this.playback.operationsSnapshot();
    const queued = operations.starts.queued;
    const saturated = queued > 0 && queued >= operations.starts.maxQueued;
    return {
      id: 'playback_operations',
      label: 'Playback operations',
      status: saturated ? 'warning' : 'healthy',
      summary: saturated
        ? 'The Silo start queue is at its configured limit.'
        : `${operations.sessions.active} active session${operations.sessions.active === 1 ? '' : 's'}; ${queued} start${queued === 1 ? '' : 's'} queued.`,
      latencyMs: null
    };
  }

  private recentOutcomeSummary(now: number): SystemDiagnosticsSnapshot['recentOutcomes'] {
    const outcomes = this.playbackOutcomes.summarySince(now - OUTCOME_WINDOW_MS);
    return {
      windowMinutes: OUTCOME_WINDOW_MS / 60_000,
      ...outcomes
    };
  }

  private outcomeCheck(
    outcomes: SystemDiagnosticsSnapshot['recentOutcomes']
  ): SystemDiagnosticCheck {
    const problems = outcomes.warnings + outcomes.errors;
    return {
      id: 'playback_outcomes',
      label: 'Recent playback observations',
      status: problems ? 'warning' : 'healthy',
      summary: problems
        ? `${problems} warning or error classification${problems === 1 ? '' : 's'} in the last ${outcomes.windowMinutes} minutes.`
        : `No warning or error classifications in the last ${outcomes.windowMinutes} minutes.`,
      latencyMs: null
    };
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, Math.round(this.now() - startedAt));
  }
}
