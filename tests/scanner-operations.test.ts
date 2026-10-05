import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/index.js';
import { MediaScanner } from '../src/services/scanner.js';
import type { RequestService } from '../src/services/requester.js';
import type { SettingsService } from '../src/services/settings.js';
import type { TmdbService } from '../src/services/tmdb.js';

const inspectMedia = vi.hoisted(() => vi.fn());

vi.mock('../src/services/ffprobe.js', () => ({ inspectMedia }));

describe('scanner operations', () => {
  const resources: Array<{
    database: AppDatabase;
    directory: string;
    scanner?: MediaScanner;
  }> = [];

  afterEach(async () => {
    inspectMedia.mockReset();
    for (const resource of resources.splice(0)) {
      await resource.scanner?.stop();
      resource.database.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture(createScanner = true) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-scan-ops-'));
    const movies = path.join(directory, 'movies');
    const tv = path.join(directory, 'tv');
    fs.mkdirSync(movies);
    fs.mkdirSync(tv);
    const config = loadConfig({
      DATABASE_PATH: path.join(directory, 'data', 'media.db'),
      MOVIES_PATH: movies,
      TV_PATH: tv,
      MINIMUM_FILE_SIZE_MB: '0',
      SCAN_CONCURRENCY: '2',
      WATCH_MEDIA: 'false',
      SCAN_ON_STARTUP: 'false'
    });
    const database = new AppDatabase(config.databasePath);
    const settings = {
      moviesPath: movies,
      tvPath: tv,
      animePath: '',
      minimumFileSizeMb: 0,
      scanIntervalMinutes: 30
    } as SettingsService;
    const requester = {
      reconcileAvailableFromLibrary: vi.fn(() => 0)
    } as unknown as RequestService;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    } as any;
    const makeScanner = () => new MediaScanner(
      database,
      settings,
      {
        search: vi.fn(async () => []),
        ensureLocalMediaItem: vi.fn(() => 'local-item')
      } as unknown as TmdbService,
      requester,
      config,
      logger
    );
    const resource = { database, directory, scanner: undefined as MediaScanner | undefined };
    resources.push(resource);
    if (createScanner) resource.scanner = makeScanner();
    return { database, directory, movies, tv, requester, logger, makeScanner, resource };
  }

  function blockProbeUntilAbort() {
    inspectMedia.mockImplementation(
      (_filePath: string, _ffprobePath: string, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true
          });
        })
    );
  }

  it('reports live progress and cancels without removal reconciliation', async () => {
    const { database, movies, requester, resource } = fixture();
    const scanner = resource.scanner!;
    for (let index = 1; index <= 4; index += 1) {
      fs.writeFileSync(
        path.join(movies, `Slow Movie ${index} (2026).mkv`),
        'media'
      );
    }
    const stalePath = path.join(movies, 'Removed Movie (2025).mkv');
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO media_files (
        id,library_type,absolute_path,relative_path,size,mtime_ms,status,
        added_at,updated_at,last_seen_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'stale-file',
      'movie',
      stalePath,
      path.basename(stalePath),
      100,
      1,
      'matched',
      now,
      now,
      1
    );
    blockProbeUntilAbort();

    const run = scanner.scan('full');
    await vi.waitFor(() => expect(inspectMedia).toHaveBeenCalledTimes(2));

    expect(scanner.snapshot()).toMatchObject({
      mode: 'full',
      phase: 'processing',
      status: 'running',
      discovered: 4,
      examined: 0,
      progressPercent: 0,
      cancelRequested: false
    });
    expect(scanner.cancel()).toBe(true);
    expect(scanner.cancel()).toBe(false);
    expect(scanner.snapshot()).toMatchObject({
      status: 'cancelling',
      cancelRequested: true
    });
    await run;

    expect(scanner.snapshot()).toBeNull();
    expect(requester.reconcileAvailableFromLibrary).not.toHaveBeenCalled();
    expect(database.sqlite.prepare(
      'SELECT status,message,discovered,processed FROM scan_runs ORDER BY started_at DESC LIMIT 1'
    ).get()).toEqual({
      status: 'cancelled',
      message: 'Scan cancelled by an administrator.',
      discovered: 4,
      processed: 0
    });
    expect(database.sqlite.prepare(
      'SELECT COUNT(*) count FROM media_files WHERE id=?'
    ).get('stale-file')).toEqual({ count: 1 });
  });

  it('turns abandoned running rows into explicit interrupted history', () => {
    const { database, makeScanner, resource } = fixture(false);
    database.sqlite.prepare(
      `INSERT INTO scan_runs (id,mode,status,started_at)
       VALUES ('abandoned','changed','running',1)`
    ).run();

    resource.scanner = makeScanner();

    expect(database.sqlite.prepare(
      'SELECT status,finished_at finishedAt,message FROM scan_runs WHERE id=?'
    ).get('abandoned')).toMatchObject({
      status: 'interrupted',
      finishedAt: expect.any(Number),
      message: 'Scan interrupted by an earlier process exit.'
    });
  });

  it('records a sanitized terminal failure when reconciliation throws', async () => {
    const { database, requester, resource } = fixture();
    const scanner = resource.scanner!;
    vi.mocked(requester.reconcileAvailableFromLibrary).mockImplementation(() => {
      throw new Error('private path /mnt/media and token=secret');
    });

    await expect(scanner.scan('changed')).rejects.toThrow('private path');

    const row = database.sqlite.prepare(
      'SELECT status,message,errors FROM scan_runs ORDER BY started_at DESC LIMIT 1'
    ).get() as { status: string; message: string; errors: number };
    expect(row).toEqual({
      status: 'failed',
      message: 'Scan failed before completion.',
      errors: 1
    });
    expect(JSON.stringify(row)).not.toContain('/mnt/media');
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('aborts active probe work and waits during graceful shutdown', async () => {
    const { database, movies, resource } = fixture();
    const scanner = resource.scanner!;
    fs.writeFileSync(path.join(movies, 'Shutdown Movie (2026).mkv'), 'media');
    blockProbeUntilAbort();

    const run = scanner.scan('full');
    await vi.waitFor(() => expect(inspectMedia).toHaveBeenCalledTimes(1));
    await scanner.stop();
    await run;

    expect(scanner.isRunning()).toBe(false);
    expect(database.sqlite.prepare(
      'SELECT status,message FROM scan_runs ORDER BY started_at DESC LIMIT 1'
    ).get()).toEqual({
      status: 'cancelled',
      message: 'Scan cancelled during graceful shutdown.'
    });
  });
});
