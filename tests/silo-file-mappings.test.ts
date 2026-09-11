import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { SiloFileMappingStore, siloServerKey } from '../src/services/silo-file-mappings.js';
import { SiloService } from '../src/services/silo-service.js';
import type { SettingsService } from '../src/services/settings.js';

describe('persistent Silo file mappings', () => {
  let directory: string;
  let database: AppDatabase;
  let mappings: SiloFileMappingStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-silo-mapping-'));
    database = new AppDatabase(path.join(directory, 'media.db'));
    mappings = new SiloFileMappingStore(database);
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO media_items (id,type,stremio_id,tmdb_id,title,created_at,updated_at)
       VALUES ('item-1','movie','tt1234567',123,'Example Movie',?,?)`
    ).run(now, now);
    database.sqlite.prepare(
      `INSERT INTO media_files (
        id,library_type,absolute_path,relative_path,size,mtime_ms,media_item_id,status,added_at,updated_at,last_seen_at
       ) VALUES ('file-1','movie','/test-library/Example Movie.mkv','Example Movie.mkv',100,1,'item-1','matched',?,?,?)`
    ).run(now, now, now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reuses an exact-path mapping across Silo service instances', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/versions')) {
        return new Response(JSON.stringify([{
          file_id: 149,
          file_path: '/test-library/Example Movie.mkv'
        }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        protocol_version: 3,
        server_features: [],
        outcome: 'playable'
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const settings = {
      siloUrl: 'http://silo:8080',
      siloApiKey: 'server-side-secret'
    } as SettingsService;
    const media = {
      id: 'file-1',
      absolute_path: '/test-library/Example Movie.mkv'
    };
    const item = { type: 'movie' as const, tmdb_id: 123, metadata_json: '{}' };

    await new SiloService(settings, mappings).startPlaybackForMedia(
      item, media, 'profile-1', '1080p-medium'
    );
    await new SiloService(settings, mappings).startPlaybackForMedia(
      item, media, 'profile-1', '1080p-medium'
    );

    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/versions'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/playback/start'))).toHaveLength(2);
    expect(mappings.get('file-1', siloServerKey('http://silo:8080/'))).toMatchObject({
      silo_file_id: 149,
      silo_item_id: 'movie-tmdb-123',
      mapped_path: '/test-library/Example Movie.mkv',
      status: 'mapped'
    });
  });

  it('does not reuse mappings for another Silo server or changed path', () => {
    const firstKey = siloServerKey('http://silo:8080');
    const otherKey = siloServerKey('http://other-silo:8080');
    mappings.record('file-1', firstKey, '/test-library/Example Movie.mkv', 'mapped', 149, 'movie-tmdb-123');

    expect(mappings.get('file-1', firstKey)?.silo_file_id).toBe(149);
    expect(mappings.get('file-1', otherKey)).toBeUndefined();

    mappings.markStale('file-1');
    expect(mappings.get('file-1', firstKey)?.status).toBe('stale');
  });

  it('normalizes the server host but preserves case-sensitive URL paths', () => {
    expect(siloServerKey('http://SILO:8080/')).toBe(
      siloServerKey('http://silo:8080')
    );
    expect(siloServerKey('http://silo:8080/SiloA')).not.toBe(
      siloServerKey('http://silo:8080/siloa')
    );
  });

  it('cascades mappings when a media file is removed', () => {
    const key = siloServerKey('http://silo:8080');
    mappings.record('file-1', key, '/test-library/Example Movie.mkv', 'mapped', 149, 'movie-tmdb-123');
    database.sqlite.prepare('DELETE FROM media_files WHERE id=?').run('file-1');
    expect(mappings.get('file-1', key)).toBeUndefined();
  });
});
