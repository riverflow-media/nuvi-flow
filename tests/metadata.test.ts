import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AppDatabase } from '../src/db/index.js';
import { SettingsService } from '../src/services/settings.js';
import { TmdbService } from '../src/services/tmdb.js';

describe('automatic metadata', () => {
  const directories: string[] = [];
  const databases: AppDatabase[] = [];

  function service() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zpm-metadata-test-'));
    directories.push(directory);
    const config = loadConfig({ DATABASE_PATH: path.join(directory, 'test.db'), TMDB_API_KEY: '' });
    const database = new AppDatabase(config.databasePath);
    databases.push(database);
    return { database, metadata: new TmdbService(database, new SettingsService(database, config)) };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    while (databases.length) databases.pop()!.close();
    while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
  });

  it('uses Cinemeta without a TMDB key and stores series episode artwork', async () => {
    const { database, metadata } = service();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ metas: [{
        id: 'tt1234567', type: 'series', name: 'Example Show', releaseInfo: '2020-2022', poster: 'https://example.test/poster.jpg'
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ meta: {
        id: 'tt1234567', type: 'series', name: 'Example Show', year: '2020-2022', description: 'An example.',
        poster: 'https://example.test/poster.jpg', background: 'https://example.test/background.jpg',
        genres: ['Comedy'], cast: ['Example Actor'], videos: [{
          season: 1, episode: 1, name: 'Pilot', overview: 'The beginning.',
          thumbnail: 'https://example.test/episode.jpg', released: '2020-01-02T00:00:00.000Z'
        }]
      } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const results = await metadata.search('series', 'Example Show', 2020);
    expect(results[0]).toMatchObject({ provider: 'cinemeta', imdbId: 'tt1234567', confidence: 1 });
    const itemId = await metadata.ensureMediaItem('series', results[0]!);
    await metadata.ensureEpisodeMetadata(itemId, results[0]!, 1);

    expect(database.sqlite.prepare('SELECT stremio_id,poster,background FROM media_items WHERE id=?').get(itemId)).toEqual({
      stremio_id: 'tt1234567', poster: 'https://example.test/poster.jpg', background: 'https://example.test/background.jpg'
    });
    expect(database.sqlite.prepare('SELECT title,still FROM episode_metadata WHERE media_item_id=?').get(itemId)).toEqual({
      title: 'Pilot', still: 'https://example.test/episode.jpg'
    });
  });

  it('creates deterministic local metadata when online matching is unavailable', () => {
    const { database, metadata } = service();
    const first = metadata.ensureLocalMediaItem('movie', 'Example Movie', 2024);
    const second = metadata.ensureLocalMediaItem('movie', 'Example Movie', 2024);
    expect(second).toBe(first);
    expect(database.sqlite.prepare('SELECT title,year,stremio_id FROM media_items WHERE id=?').get(first)).toMatchObject({
      title: 'Example Movie', year: 2024
    });
  });
});
