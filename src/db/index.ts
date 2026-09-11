import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import * as schema from './schema.js';
import { migrations } from './migrations.js';

export type SqliteDatabase = Database.Database;

export class AppDatabase {
  readonly sqlite: SqliteDatabase;
  readonly orm;
  lastMigrationBackupPath: string | null = null;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.sqlite = new Database(databasePath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.pragma('busy_timeout = 5000');
    this.orm = drizzle(this.sqlite, { schema });
    this.migrate(databasePath);
  }

  private migrate(databasePath: string): void {
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL
    )`);
    const applied = new Set(
      this.sqlite.prepare('SELECT id FROM _migrations').all().map((row) => (row as { id: number }).id)
    );
    const pending = migrations
      .map((_sql, index) => index + 1)
      .filter((id) => !applied.has(id));

    if (applied.size > 0 && pending.length > 0) {
      this.lastMigrationBackupPath = this.backupBeforeMigration(
        databasePath,
        pending[0]!
      );
    }

    migrations.forEach((sql, index) => {
      const id = index + 1;
      if (applied.has(id)) return;
      this.sqlite.transaction(() => {
        this.sqlite.exec(sql);
        this.sqlite.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now());
      })();
    });
  }

  private backupBeforeMigration(databasePath: string, migrationId: number): string {
    const backupPath = `${databasePath}.backup-before-migration-${migrationId}-${Date.now()}`;
    const quotedPath = backupPath.replaceAll("'", "''");
    this.sqlite.exec(`VACUUM INTO '${quotedPath}'`);

    const backup = new Database(backupPath, { readonly: true });
    try {
      const result = backup.pragma('quick_check', { simple: true });
      if (result !== 'ok') {
        throw new Error('SQLite migration backup failed integrity verification.');
      }
    } finally {
      backup.close();
    }

    return backupPath;
  }

  getSetting(key: string): string | undefined {
    return this.orm.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
  }

  setSetting(key: string, value: string): void {
    this.orm.insert(schema.settings).values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: Date.now() } }).run();
  }

  close(): void {
    this.sqlite.close();
  }
}
