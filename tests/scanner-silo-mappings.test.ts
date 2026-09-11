import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/index.js';
import { MediaScanner } from '../src/services/scanner.js';
import { SiloFileMappingStore, siloServerKey } from '../src/services/silo-file-mappings.js';
import type { RequestService } from '../src/services/requester.js';
import type { SettingsService } from '../src/services/settings.js';
import type { TmdbService } from '../src/services/tmdb.js';

vi.mock('../src/services/ffprobe.js', () => ({
  inspectMedia: vi.fn(async () => ({
    durationSeconds: 60,
    bitrate: 1_000_000,
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    frameRate: 24,
    audioChannels: 2,
    audioTracks: [],
    audioLanguages: [],
    subtitleTracks: [],
    raw: {},
    compatibilityWarning: null
  }))
}));

describe('scanner Silo mapping refresh', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('marks a persisted mapping stale when the local media file changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-scan-mapping-'));
    directories.push(directory);
    const mediaPath = path.join(directory, 'Example Movie (2024).mkv');
    fs.writeFileSync(mediaPath, 'changed-media');
    const database = new AppDatabase(path.join(directory, 'media.db'));
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO media_items (id,type,stremio_id,tmdb_id,title,created_at,updated_at)
       VALUES ('item-1','movie','tt1234567',123,'Example Movie',?,?)`
    ).run(now, now);
    database.sqlite.prepare(
      `INSERT INTO media_files (
        id,library_type,absolute_path,relative_path,size,mtime_ms,media_item_id,manual_override,status,added_at,updated_at,last_seen_at
       ) VALUES ('file-1','movie',?,?,1,1,'item-1',1,'matched',?,?,?)`
    ).run(mediaPath, path.basename(mediaPath), now, now, now);

    const mappings = new SiloFileMappingStore(database);
    const serverKey = siloServerKey('http://silo:8080');
    mappings.record('file-1', serverKey, mediaPath, 'mapped', 149, 'movie-tmdb-123');

    const config = loadConfig({
      DATABASE_PATH: path.join(directory, 'media.db'),
      MOVIES_PATH: directory,
      TV_PATH: path.join(directory, 'missing-tv'),
      MINIMUM_FILE_SIZE_MB: '0',
      WATCH_MEDIA: 'false',
      SCAN_ON_STARTUP: 'false'
    });
    const settings = {
      moviesPath: directory,
      tvPath: config.tvPath,
      animePath: '',
      minimumFileSizeMb: 0,
      scanIntervalMinutes: 30
    } as SettingsService;
    const scanner = new MediaScanner(
      database,
      settings,
      {} as TmdbService,
      { reconcileAvailableFromLibrary: () => 0 } as unknown as RequestService,
      config,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      mappings
    );

    await scanner.scan('changed');

    expect(mappings.get('file-1', serverKey)?.status).toBe('stale');
    database.close();
  });
});
