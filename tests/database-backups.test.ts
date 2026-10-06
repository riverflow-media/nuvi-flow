import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/index.js';
import { DatabaseBackupService } from '../src/services/database-backups.js';

describe('database backups', () => {
  let directory: string;
  let database: AppDatabase;
  let service: DatabaseBackupService;
  let now: number;
  let randomSequence: number;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuviflow-backups-'));
    const config = loadConfig({
      DATABASE_PATH: path.join(directory, 'private-name.db'),
      DATABASE_BACKUP_ENABLED: 'true',
      DATABASE_BACKUP_INTERVAL_HOURS: '24',
      DATABASE_BACKUP_RETENTION: '2'
    });
    database = new AppDatabase(config.databasePath);
    now = 1_800_000_000_000;
    randomSequence = 0;
    service = new DatabaseBackupService(
      database,
      config,
      { info: vi.fn(), warn: vi.fn() } as any,
      {
        now: () => now,
        randomId: () => (++randomSequence).toString(16).padStart(8, '0')
      }
    );
  });

  afterEach(async () => {
    await service.stop();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('creates an opaque, live SQLite snapshot and verifies its integrity', async () => {
    database.setSetting('backup_test_marker', 'captured');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(backupDirectory);
    fs.writeFileSync(path.join(
      backupDirectory,
      '.private-name.db.backup-manual-1700000000000-deadbeef.sqlite.partial'
    ), 'interrupted');

    const created = await service.create('manual');
    database.setSetting('backup_test_marker', 'changed-after-backup');
    const snapshot = await service.snapshot();

    expect(created).toMatchObject({
      id: '1800000000000-00000001',
      createdAt: now,
      reason: 'manual',
      integrity: 'verified'
    });
    expect(created.id).not.toContain('private-name.db');
    expect(snapshot.latest).toEqual(created);
    expect(snapshot.backups).toEqual([created]);
    expect(snapshot.automatic).toMatchObject({
      enabled: true,
      intervalHours: 24,
      retention: 2,
      nextDueAt: now + 24 * 60 * 60_000
    });

    expect(fs.readdirSync(backupDirectory).some(filename => filename.includes('.partial')))
      .toBe(false);
    const backupFilename = fs.readdirSync(backupDirectory)
      .find(filename => filename.endsWith('.sqlite'))!;
    expect(fs.statSync(backupDirectory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(backupDirectory, backupFilename)).mode & 0o777)
      .toBe(0o600);
    const backup = new Database(path.join(backupDirectory, backupFilename), {
      readonly: true,
      fileMustExist: true
    });
    try {
      expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
      expect((backup.prepare(
        'SELECT value FROM settings WHERE key=?'
      ).get('backup_test_marker') as { value: string }).value).toBe('captured');
    } finally {
      backup.close();
    }
  });

  it('coalesces concurrent requests and prunes only managed backups', async () => {
    const firstRequest = service.create('manual');
    const coalescedRequest = service.create('manual');
    expect(coalescedRequest).toBe(firstRequest);
    await firstRequest;

    const backupDirectory = path.join(directory, 'backups');
    fs.writeFileSync(path.join(backupDirectory, 'keep-me.txt'), 'not managed');
    now += 1_000;
    await service.create('scheduled');
    now += 1_000;
    const newest = await service.create('manual');

    const snapshot = await service.snapshot();
    expect(snapshot.backups).toHaveLength(2);
    expect(snapshot.backups[0]).toEqual(newest);
    expect(snapshot.backups.map(backup => backup.createdAt)).toEqual([
      1_800_000_002_000,
      1_800_000_001_000
    ]);
    expect(fs.readFileSync(path.join(backupDirectory, 'keep-me.txt'), 'utf8'))
      .toBe('not managed');
    expect(await service.open('1800000000000-00000001')).toBeNull();
  });

  it('records a fixed safe failure without retaining partial files', async () => {
    vi.spyOn(database.sqlite, 'backup').mockRejectedValueOnce(
      new Error(`ENOSPC at ${directory}/private-name.db with secret detail`)
    );

    await expect(service.create('manual')).rejects.toThrow(
      'The database backup could not be created and verified.'
    );
    const snapshot = await service.snapshot();
    expect(snapshot.lastError).toMatchObject({
      message: 'The database backup could not be created and verified.'
    });
    expect(JSON.stringify(snapshot)).not.toContain(directory);
    const entries = fs.existsSync(path.join(directory, 'backups'))
      ? fs.readdirSync(path.join(directory, 'backups'))
      : [];
    expect(entries.some(entry => entry.endsWith('.partial'))).toBe(false);
  });

  it('creates the first automatic recovery point when scheduling starts', async () => {
    service.startSchedules();

    await vi.waitFor(async () => {
      expect((await service.snapshot()).backups).toHaveLength(1);
    });
    expect((await service.snapshot()).latest).toMatchObject({
      reason: 'scheduled',
      integrity: 'verified'
    });
  });
});
