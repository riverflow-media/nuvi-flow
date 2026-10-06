import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import Database from 'better-sqlite3';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';

export type DatabaseBackupReason = 'manual' | 'scheduled';

export interface DatabaseBackupSummary {
  id: string;
  createdAt: number;
  sizeBytes: number;
  reason: DatabaseBackupReason;
  integrity: 'verified';
}

export interface DatabaseBackupSnapshot {
  running: boolean;
  automatic: {
    enabled: boolean;
    intervalHours: number;
    retention: number;
    nextDueAt: number | null;
  };
  latest: DatabaseBackupSummary | null;
  backups: DatabaseBackupSummary[];
  lastError: {
    occurredAt: number;
    message: string;
  } | null;
}

export interface OpenDatabaseBackup {
  backup: DatabaseBackupSummary;
  stream: fs.ReadStream;
}

interface DatabaseBackupOptions {
  now?: () => number;
  randomId?: () => string;
  retryDelayMs?: number;
}

const HOUR_MS = 60 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const SAFE_FAILURE_MESSAGE = 'The database backup could not be created and verified.';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Creates live, integrity-checked SQLite snapshots without pausing requests.
 * Only files matching this service's exact naming convention are listed,
 * downloaded, or removed by retention pruning.
 */
export class DatabaseBackupService {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly retryDelayMs: number;
  private readonly backupDirectory: string;
  private readonly databaseFilename: string;
  private readonly managedFilePattern: RegExp;
  private readonly managedPartialPattern: RegExp;
  private pending: Promise<DatabaseBackupSummary> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scheduleGeneration = 0;
  private schedulesStarted = false;
  private lastError: DatabaseBackupSnapshot['lastError'] = null;
  private lastErrorKind: 'backup' | 'retention' | 'storage' | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly config: AppConfig,
    private readonly logger: Pick<FastifyBaseLogger, 'info' | 'warn'>,
    options: DatabaseBackupOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? (() => crypto.randomBytes(4).toString('hex'));
    this.retryDelayMs = Math.max(1_000, options.retryDelayMs ?? 15 * 60_000);
    this.databaseFilename = path.basename(config.databasePath);
    this.backupDirectory = path.join(path.dirname(config.databasePath), 'backups');
    this.managedFilePattern = new RegExp(
      `^${escapeRegExp(this.databaseFilename)}\\.backup-(manual|scheduled)-(\\d{13})-([a-f0-9]{8})\\.sqlite$`
    );
    this.managedPartialPattern = new RegExp(
      `^\\.${escapeRegExp(this.databaseFilename)}\\.backup-(manual|scheduled)-\\d{13}-[a-f0-9]{8}\\.sqlite\\.partial(?:-(?:wal|shm))?$`
    );
  }

  startSchedules(): void {
    if (this.schedulesStarted) return;
    if (!this.config.databaseBackupEnabled) {
      void this.prepareBackupDirectory().catch(error => {
        this.logger.warn({ error }, 'Database backup storage cleanup failed');
      });
      return;
    }
    this.schedulesStarted = true;
    void this.runScheduledBackupIfDue();
  }

  async stop(): Promise<void> {
    this.schedulesStarted = false;
    this.scheduleGeneration += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.pending?.catch(() => undefined);
  }

  create(reason: DatabaseBackupReason = 'manual'): Promise<DatabaseBackupSummary> {
    if (this.pending) return this.pending;
    const pending = this.createVerifiedBackup(reason).finally(() => {
      if (this.pending === pending) this.pending = null;
      if (this.schedulesStarted) this.scheduleNextCheck();
    });
    this.pending = pending;
    return pending;
  }

  async snapshot(): Promise<DatabaseBackupSnapshot> {
    const backups = await this.list();
    const latest = backups[0] ?? null;
    return {
      running: Boolean(this.pending),
      automatic: {
        enabled: this.config.databaseBackupEnabled,
        intervalHours: this.config.databaseBackupIntervalHours,
        retention: this.config.databaseBackupRetention,
        nextDueAt: this.config.databaseBackupEnabled
          ? latest
            ? latest.createdAt + this.intervalMs()
            : this.now()
          : null
      },
      latest,
      backups,
      lastError: this.lastError
    };
  }

  async open(id: string): Promise<OpenDatabaseBackup | null> {
    const backup = (await this.list()).find(candidate => candidate.id === id);
    if (!backup) return null;
    const backupPath = this.pathFor(backup);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    const handle = await fs.promises.open(backupPath, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        return null;
      }
      return {
        backup: { ...backup, sizeBytes: stat.size },
        stream: handle.createReadStream({ autoClose: true })
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  private intervalMs(): number {
    return this.config.databaseBackupIntervalHours * HOUR_MS;
  }

  private async createVerifiedBackup(reason: DatabaseBackupReason): Promise<DatabaseBackupSummary> {
    const createdAt = this.now();
    const randomId = this.randomId();
    const id = `${createdAt}-${randomId}`;
    const filename = `${this.databaseFilename}.backup-${reason}-${createdAt}-${randomId}.sqlite`;
    const finalPath = path.join(this.backupDirectory, filename);
    const partialPath = path.join(this.backupDirectory, `.${filename}.partial`);

    try {
      await this.prepareBackupDirectory();
      await this.database.sqlite.backup(partialPath);
      await fs.promises.chmod(partialPath, 0o600);
      const backup = new Database(partialPath, { fileMustExist: true });
      try {
        // Produce one portable SQLite file even when the live source uses WAL.
        const journalMode = backup.pragma('journal_mode = DELETE', { simple: true });
        if (journalMode !== 'delete') {
          throw new Error('SQLite backup could not leave WAL mode.');
        }
        const result = backup.pragma('quick_check', { simple: true });
        if (result !== 'ok') throw new Error('SQLite quick_check did not pass.');
      } finally {
        backup.close();
      }
      await this.removeSidecars(partialPath);
      await fs.promises.rename(partialPath, finalPath);
      const stat = await fs.promises.stat(finalPath);
      const summary: DatabaseBackupSummary = {
        id,
        createdAt,
        sizeBytes: stat.size,
        reason,
        integrity: 'verified'
      };
      this.lastError = null;
      this.lastErrorKind = null;
      this.logger.info({ backupId: id, reason, sizeBytes: stat.size }, 'Verified database backup created');

      try {
        await this.prune();
      } catch (error) {
        this.lastError = {
          occurredAt: this.now(),
          message: 'A backup was created, but expired backups could not be removed.'
        };
        this.lastErrorKind = 'retention';
        this.logger.warn({ error }, 'Database backup retention pruning failed');
      }
      return summary;
    } catch (error) {
      await fs.promises.unlink(partialPath).catch(() => undefined);
      await this.removeSidecars(partialPath);
      this.lastError = { occurredAt: this.now(), message: SAFE_FAILURE_MESSAGE };
      this.lastErrorKind = 'backup';
      this.logger.warn({ error, reason }, 'Database backup failed');
      throw new Error(SAFE_FAILURE_MESSAGE);
    }
  }

  private async list(): Promise<DatabaseBackupSummary[]> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(this.backupDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const backups = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const match = this.managedFilePattern.exec(entry.name);
      if (!match) return null;
      const stat = await fs.promises.stat(path.join(this.backupDirectory, entry.name));
      return {
        id: `${match[2]}-${match[3]}`,
        createdAt: Number(match[2]),
        sizeBytes: stat.size,
        reason: match[1] as DatabaseBackupReason,
        integrity: 'verified' as const
      };
    }));

    return backups
      .filter((backup): backup is DatabaseBackupSummary => Boolean(backup))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
  }

  private async prune(): Promise<void> {
    const backups = await this.list();
    const expired = backups.slice(this.config.databaseBackupRetention);
    await Promise.all(expired.map(backup =>
      fs.promises.unlink(this.pathFor(backup))
    ));
  }

  private async removeSidecars(databasePath: string): Promise<void> {
    await Promise.all([
      fs.promises.unlink(`${databasePath}-wal`).catch(() => undefined),
      fs.promises.unlink(`${databasePath}-shm`).catch(() => undefined)
    ]);
  }

  private async prepareBackupDirectory(): Promise<void> {
    await fs.promises.mkdir(this.backupDirectory, {
      recursive: true,
      mode: 0o700
    });
    await fs.promises.chmod(this.backupDirectory, 0o700);
    const entries = await fs.promises.readdir(this.backupDirectory, {
      withFileTypes: true
    });
    await Promise.all(entries
      .filter(entry => entry.isFile() && this.managedPartialPattern.test(entry.name))
      .map(entry => fs.promises.unlink(path.join(this.backupDirectory, entry.name))));
  }

  private pathFor(backup: DatabaseBackupSummary): string {
    const randomId = backup.id.slice(14);
    const filename = `${this.databaseFilename}.backup-${backup.reason}-${backup.createdAt}-${randomId}.sqlite`;
    return path.join(this.backupDirectory, filename);
  }

  private async runScheduledBackupIfDue(): Promise<void> {
    if (!this.schedulesStarted) return;
    try {
      await this.prepareBackupDirectory();
      if (!this.schedulesStarted) return;
      const snapshot = await this.snapshot();
      if (!this.schedulesStarted) return;
      const due = !snapshot.latest ||
        snapshot.latest.createdAt + this.intervalMs() <= this.now();
      if (due || this.lastErrorKind === 'backup' || this.lastErrorKind === 'storage') {
        await this.create('scheduled');
      } else if (this.lastErrorKind === 'retention') {
        await this.prune();
        this.lastError = null;
        this.lastErrorKind = null;
      }
    } catch (error) {
      if (!this.lastError) {
        this.lastError = {
          occurredAt: this.now(),
          message: SAFE_FAILURE_MESSAGE
        };
        this.lastErrorKind = 'storage';
        this.logger.warn({ error }, 'Database backup schedule failed');
      }
    } finally {
      if (this.schedulesStarted && !this.timer) this.scheduleNextCheck();
    }
  }

  private scheduleNextCheck(): void {
    if (!this.schedulesStarted) return;
    const generation = ++this.scheduleGeneration;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.snapshot().then(snapshot => {
      if (!this.schedulesStarted || generation !== this.scheduleGeneration) return;
      const dueAt = snapshot.latest
        ? snapshot.latest.createdAt + this.intervalMs()
        : this.now();
      const baseDelay = Math.max(1_000, dueAt - this.now());
      const delay = snapshot.lastError
        ? Math.min(baseDelay, this.retryDelayMs)
        : baseDelay;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runScheduledBackupIfDue();
      }, Math.min(delay, MAX_TIMER_DELAY_MS));
      this.timer.unref();
    }).catch(error => {
      this.logger.warn({ error }, 'Database backup schedule could not be calculated');
      if (!this.schedulesStarted || generation !== this.scheduleGeneration) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.runScheduledBackupIfDue();
      }, this.retryDelayMs);
      this.timer.unref();
    });
  }
}
