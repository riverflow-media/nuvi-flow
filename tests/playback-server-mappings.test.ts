import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import {
  normalizeMediaPath,
  parsePathPrefixMappings,
  playbackServerKey,
  PlaybackServerMappingStore,
  translateMediaPath
} from '../src/services/playback-server-mappings.js';
import { PlaybackServersService } from '../src/services/playback-servers.js';
import type { SettingsService } from '../src/services/settings.js';

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('playback-server exact media mappings', () => {
  let directory: string;
  let database: AppDatabase;
  let mappings: PlaybackServerMappingStore;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-provider-map-'));
    database = new AppDatabase(path.join(directory, 'media.db'));
    mappings = new PlaybackServerMappingStore(database);
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO media_items (id,type,stremio_id,title,created_at,updated_at)
       VALUES ('item-1','movie','tt1234567','Example Movie',?,?)`
    ).run(now, now);
    database.sqlite.prepare(
      `INSERT INTO media_files (
        id,library_type,absolute_path,relative_path,size,mtime_ms,media_item_id,
        status,added_at,updated_at,last_seen_at
      ) VALUES ('file-1','movie','/local/movies/Example Movie.mkv',
        'Example Movie.mkv',100,1,'item-1','matched',?,?,?)`
    ).run(now, now, now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('normalizes paths and applies only the longest segment-safe prefix', () => {
    const rules = parsePathPrefixMappings([
      '/local => /provider',
      '/local/movies => /provider/films'
    ].join('\n'));

    expect(translateMediaPath('/local/movies/Example.mkv', rules))
      .toBe('/provider/films/Example.mkv');
    expect(translateMediaPath('/locality/Example.mkv', rules))
      .toBe('/locality/Example.mkv');
    expect(translateMediaPath('/Example.mkv', parsePathPrefixMappings(
      '/ => /'
    ))).toBe('/Example.mkv');
    expect(normalizeMediaPath('C:\\Media\\Films\\Movie.mkv'))
      .toBe('C:/Media/Films/Movie.mkv');
    expect(() => parsePathPrefixMappings('relative => /provider'))
      .toThrow('absolute paths');
    expect(() => parsePathPrefixMappings('/local => /one\n/local => /two'))
      .toThrow('duplicates a local prefix');
  });

  it('persists and reuses an exact Jellyfin item/media-source mapping', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/System/Info') {
        return json({
          Id: 'jellyfin-server-1',
          ServerName: 'Jellyfin',
          Version: '10.11.6'
        });
      }
      if (url.pathname === '/Items') {
        expect(url.searchParams.get('UserId')).toBe('viewer-1');
        expect(url.searchParams.get('Fields')).toBe('Path,MediaSources');
        return json({
          TotalRecordCount: 2,
          Items: [
            {
              Id: 'jf-item-1',
              Path: '/jellyfin/movies/Example Movie.mkv',
              MediaSources: [{
                Id: 'jf-source-1',
                Path: '/jellyfin/movies/Example Movie.mkv'
              }]
            },
            {
              Id: 'jf-item-other',
              MediaSources: [{
                Id: 'jf-source-other',
                Path: '/jellyfin/movies/Other.mkv'
              }]
            }
          ]
        });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const settings = {
      jellyfinUrl: 'http://jellyfin:8096',
      jellyfinApiKey: 'private-jellyfin-key',
      jellyfinUserId: 'viewer-1',
      jellyfinPathMappings: '/local/movies => /jellyfin/movies'
    } as SettingsService;
    const service = new PlaybackServersService(settings, mappings);

    const refreshed = await service.refreshMappings('jellyfin', true);
    expect(refreshed.summary).toMatchObject({
      total: 1,
      mapped: 1,
      pending: 0,
      notFound: 0,
      ambiguous: 0
    });
    const serverKey = playbackServerKey('jellyfin', 'jellyfin-server-1');
    expect(refreshed.serverKey).toBe(serverKey);
    expect(mappings.get('jellyfin', serverKey, 'file-1')).toMatchObject({
      provider_item_id: 'jf-item-1',
      provider_media_id: 'jf-source-1',
      provider_stream_path: null,
      mapped_path: '/jellyfin/movies/Example Movie.mkv',
      status: 'mapped',
      reason: null
    });
    expect(mappings.get(
      'jellyfin',
      playbackServerKey('jellyfin', 'different-server'),
      'file-1'
    )).toBeUndefined();

    await expect(service.resolveMapping('jellyfin', {
      id: 'file-1',
      absolute_path: '/local/movies/Example Movie.mkv'
    })).resolves.toMatchObject({ provider_media_id: 'jf-source-1' });
    expect(fetchMock.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname === '/Items'
    )).toHaveLength(1);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(String(input)).not.toContain('private-jellyfin-key');
      expect(new Headers(init?.headers).get('X-Emby-Token'))
        .toBe('private-jellyfin-key');
    }
  });

  it('maps Plex rating-key/part pairs and rejects path collisions', async () => {
    const now = Date.now();
    database.sqlite.prepare(
      `INSERT INTO media_files (
        id,library_type,absolute_path,relative_path,size,mtime_ms,media_item_id,
        status,added_at,updated_at,last_seen_at
      ) VALUES ('file-2','movie','/local/movies/Unique.mkv','Unique.mkv',
        100,1,'item-1','matched',?,?,?)`
    ).run(now, now, now);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === '/') {
        return json({ MediaContainer: {
          machineIdentifier: 'plex-server-1',
          friendlyName: 'Plex',
          version: '1.42.2.10156'
        } });
      }
      if (url.pathname === '/library/sections/all') {
        return json({ MediaContainer: {
          Directory: [{ key: '1', title: 'Movies', type: 'movie' }]
        } });
      }
      if (url.pathname === '/library/sections/1/all') {
        expect(url.searchParams.get('X-Plex-Container-Start')).toBe('0');
        return json({ MediaContainer: {
          totalSize: 3,
          Metadata: [
            {
              ratingKey: '100',
              Media: [{ Part: [{
                id: '1000',
                key: '/library/parts/1000/file.mkv',
                file: '/plex/movies/Example Movie.mkv'
              }] }]
            },
            {
              ratingKey: '101',
              Media: [{ Part: [{
                id: '1001',
                key: '/library/parts/1001/file.mkv',
                file: '/plex/movies/Example Movie.mkv'
              }] }]
            },
            {
              ratingKey: 102,
              Media: [{ Part: [{
                id: 1002,
                key: '/library/parts/1002/file.mkv',
                file: '/plex/movies/Unique.mkv'
              }] }]
            }
          ]
        } });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const settings = {
      plexUrl: 'http://plex:32400',
      plexToken: 'private-plex-token',
      plexPathMappings: '/local/movies => /plex/movies'
    } as SettingsService;
    const service = new PlaybackServersService(settings, mappings);

    const refreshed = await service.refreshMappings('plex', true);
    expect(refreshed.summary).toMatchObject({
      total: 2,
      mapped: 1,
      ambiguous: 1,
      notFound: 0
    });
    const serverKey = playbackServerKey('plex', 'plex-server-1');
    expect(mappings.get('plex', serverKey, 'file-1')).toMatchObject({
      status: 'error',
      reason: 'ambiguous_exact_path',
      provider_item_id: null,
      provider_media_id: null
    });
    expect(mappings.get('plex', serverKey, 'file-2')).toMatchObject({
      status: 'mapped',
      provider_item_id: '102',
      provider_media_id: '1002',
      provider_stream_path: '/library/parts/1002/file.mkv'
    });

    service.markMappingsStale('file-2');
    expect(mappings.get('plex', serverKey, 'file-2')).toMatchObject({
      status: 'stale',
      reason: 'local_file_changed'
    });
    expect(serverKey).not.toContain('plex-server-1');
  });
});
