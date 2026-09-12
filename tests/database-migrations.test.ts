import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { migrations } from '../src/db/migrations.js';

describe('database migrations', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates and verifies a backup before upgrading an existing database', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-migration-'));
    directories.push(directory);
    const databasePath = path.join(directory, 'media.db');
    const legacy = new Database(databasePath);
    legacy.exec('CREATE TABLE _migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    migrations.slice(0, -1).forEach((sql, index) => {
      legacy.exec(sql);
      legacy.prepare('INSERT INTO _migrations (id,applied_at) VALUES (?,?)').run(index + 1, Date.now());
    });
    legacy.prepare("INSERT INTO settings (key,value,updated_at) VALUES ('sentinel','preserved',?)").run(Date.now());
    legacy.close();

    const upgraded = new AppDatabase(databasePath);
    const backupPath = upgraded.lastMigrationBackupPath;

    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath!)).toBe(true);
    expect(upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='silo_file_mappings'"
    ).get()).toBeTruthy();
    expect(upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='playback_devices'"
    ).get()).toBeTruthy();
    expect(upgraded.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='device_capabilities'"
    ).get()).toBeTruthy();

    const backup = new Database(backupPath!, { readonly: true });
    expect(backup.pragma('quick_check', { simple: true })).toBe('ok');
    expect(backup.prepare("SELECT value FROM settings WHERE key='sentinel'").get()).toEqual({ value: 'preserved' });
    expect(backup.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='silo_file_mappings'"
    ).get()).toBeTruthy();
    expect(backup.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='playback_devices'"
    ).get()).toBeUndefined();
    expect(backup.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='device_capabilities'"
    ).get()).toBeUndefined();
    backup.close();
    upgraded.close();
  });
});
