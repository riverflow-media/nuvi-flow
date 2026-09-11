import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type BuiltApp } from '../src/server.js';

describe('admin media detail API', () => {
  let built: BuiltApp;
  let directory: string;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zpm-admin-test-'));
    const config = loadConfig({
      PORT: '60500', BASE_URL: 'http://localhost:60500', DATABASE_PATH: path.join(directory, 'test.db'),
      MOVIES_PATH: directory, TV_PATH: directory, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'safe-test-password',
      SESSION_SECRET: 'test-session-secret-at-least-thirty-two-chars',
      STREAM_SECRET: 'test-stream-secret-at-least-thirty-two-chars',
      SCAN_ON_STARTUP: 'false', WATCH_MEDIA: 'false', LOG_LEVEL: 'silent'
    });
    built = await buildApp(config);
    const now = Date.now();
    built.database.sqlite.prepare(`INSERT INTO media_items (id,type,stremio_id,tmdb_id,imdb_id,title,year,description,created_at,updated_at)
      VALUES ('item1','movie','tt1234567',123,'tt1234567','Example Movie',2024,'A matched movie.',?,?)`).run(now, now);
    built.database.sqlite.prepare(`INSERT INTO media_files (
      id,library_type,absolute_path,relative_path,size,mtime_ms,duration_seconds,bitrate,video_codec,audio_codec,width,height,
      audio_channels,audio_languages_json,subtitle_tracks_json,probe_json,parsed_title,parsed_year,quality,
      media_item_id,confidence,status,added_at,updated_at,last_seen_at
    ) VALUES ('file1','movie',?,?,?,?,120.5,8500000,'h264','aac',1920,1080,6,'["eng"]','[]','{}','Example Movie',2024,'1080p','item1',.99,'matched',?,?,?)`)
      .run(path.join(directory, 'Example Movie (2024).mp4'), 'Example Movie (2024).mp4', 1000, now, now, now, now);
    await built.app.ready();

    const login = await built.app.inject({
      method: 'POST', url: '/admin/login', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=admin&password=safe-test-password'
    });
    cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const page = await built.app.inject({ method: 'GET', url: '/admin', headers: { cookie } });
    csrf = page.body.match(/meta name="csrf-token" content="([^"]+)"/)?.[1] || '';
  });

  afterEach(async () => {
    await built.app.close();
    built.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
    return built.app.inject({ method, url, headers: { cookie, 'x-csrf-token': csrf }, payload });
  }

  it('returns build identity and can revoke the secure addon URL', async () => {
    const before = await request('GET', '/admin/api/state');
    expect(before.statusCode).toBe(200);
    expect(before.json().build).toMatchObject({ version: '1.1.1' });

    const oldPath = before.json().settings.addonAccessPath as string;
    expect(oldPath).toMatch(/^\/addon\/[A-Za-z0-9_-]{43}$/);
    expect((await built.app.inject({
      method: 'GET',
      url: `${oldPath}/manifest.json`
    })).statusCode).toBe(200);

    const regenerated = await request(
      'POST',
      '/admin/api/addon-access/regenerate'
    );
    expect(regenerated.statusCode).toBe(200);
    const newPath = regenerated.json().settings.addonAccessPath as string;
    expect(newPath).not.toBe(oldPath);
    expect((await built.app.inject({
      method: 'GET',
      url: `${oldPath}/manifest.json`
    })).statusCode).toBe(404);
    expect((await built.app.inject({
      method: 'GET',
      url: `${newPath}/manifest.json`
    })).statusCode).toBe(200);
  });

  it('tests Silo through the application Silo service', async () => {
    const testConnection = vi.spyOn(built.silo, 'testConnection')
      .mockResolvedValue({
        health: {
          status: 'ok',
          server_name: 'Test Silo',
          server_id: 'silo-test'
        },
        profiles: [{
          id: 'profile-1',
          name: 'Default',
          primary: true
        }]
      });

    const response = await request(
      'POST',
      '/admin/api/integrations/silo/test',
      {
        url: 'http://silo:8080/',
        apiKey: 'test-silo-key'
      }
    );

    expect(response.statusCode).toBe(200);
    expect(testConnection).toHaveBeenCalledWith(
      'http://silo:8080',
      'test-silo-key'
    );
    expect(response.json()).toMatchObject({
      ok: true,
      service: 'silo',
      instanceName: 'Test Silo',
      profiles: [{
        id: 'profile-1',
        name: 'Default',
        primary: true
      }]
    });
  });

  it('returns coherent current-match details and updates action state', async () => {
    const details = await request('GET', '/admin/api/files/file1');
    expect(details.statusCode).toBe(200);
    expect(details.json().file).toMatchObject({
      status: 'matched', stremioId: 'tt1234567', mediaItemId: 'item1',
      currentMatch: { title: 'Example Movie', year: 2024, tmdbId: 123, stremioId: 'tt1234567' }
    });

    const removed = await request('POST', '/admin/api/files/file1/unmatch');
    expect(removed.statusCode).toBe(200);
    expect(removed.json().file).toMatchObject({ status: 'unmatched', stremioId: null, mediaItemId: null, currentMatch: null });
    const duplicateRemove = await request('POST', '/admin/api/files/file1/unmatch');
    expect(duplicateRemove.statusCode).toBe(409);
    expect(duplicateRemove.json().error).toContain('does not have a match');

    const ignored = await request('POST', '/admin/api/files/file1/ignore');
    expect(ignored.statusCode).toBe(200);
    expect(ignored.json().file).toMatchObject({ status: 'ignored', currentMatch: null });
  });

  it('applies a match and returns the refreshed file record', async () => {
    await request('POST', '/admin/api/files/file1/unmatch');
    built.settings.set('tmdbApiKey', 'test-key');
    vi.spyOn(built.tmdb, 'ensureMediaItem').mockResolvedValue('item1');
    const matched = await request('POST', '/admin/api/files/file1/match', { type: 'movie', tmdbId: 123 });
    expect(matched.statusCode).toBe(200);
    expect(matched.json().file).toMatchObject({ status: 'matched', stremioId: 'tt1234567', mediaItemId: 'item1' });
  });

  it('searches automatic metadata without requiring a TMDB key', async () => {
    vi.spyOn(built.tmdb, 'search').mockResolvedValue([{
      id: 'tt1234567', provider: 'cinemeta', imdbId: 'tt1234567', title: 'Example Movie', year: 2024, confidence: 1
    }]);
    const automatic = await request('GET', '/admin/api/tmdb/search?type=movie&query=Example');
    expect(automatic.statusCode).toBe(200);
    expect(automatic.json().results[0]).toMatchObject({ provider: 'cinemeta', id: 'tt1234567' });

    vi.spyOn(built.tmdb, 'search').mockRejectedValue(new Error('Metadata request failed'));
    const unavailable = await request('GET', '/admin/api/tmdb/search?type=movie&query=Example');
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json().error).toContain('network connection');
  });

  it('normalizes legacy match inconsistencies across details, counts, streams, and removal', async () => {
    built.database.sqlite.prepare("UPDATE media_files SET status='unmatched' WHERE id='file1'").run();
    const linked = await request('GET', '/admin/api/files/file1');
    expect(linked.json().file).toMatchObject({ status: 'matched', stremioId: 'tt1234567', mediaItemId: 'item1' });
    const linkedState = await request('GET', '/admin/api/state');
    expect(linkedState.json().counts).toMatchObject({ movies: 1, unmatched: 0 });

    const stream = await request('POST', '/admin/api/files/file1/stream');
    expect(stream.statusCode).toBe(200);
    const removed = await request('POST', '/admin/api/files/file1/unmatch');
    expect(removed.statusCode).toBe(200);
    expect(removed.json().file).toMatchObject({ status: 'unmatched', currentMatch: null });

    built.database.sqlite.prepare("UPDATE media_files SET status='matched',media_item_id=NULL WHERE id='file1'").run();
    const unlinked = await request('GET', '/admin/api/files/file1');
    expect(unlinked.json().file).toMatchObject({ status: 'unmatched', stremioId: null, mediaItemId: null, currentMatch: null });
    const unlinkedState = await request('GET', '/admin/api/state');
    expect(unlinkedState.json().counts).toMatchObject({ movies: 0, unmatched: 1 });

    built.database.sqlite.prepare("UPDATE media_files SET status='ignored',media_item_id='item1' WHERE id='file1'").run();
    const ignored = await request('GET', '/admin/api/files/file1');
    expect(ignored.json().file).toMatchObject({ status: 'ignored', stremioId: null, mediaItemId: null, currentMatch: null });
    const ignoredState = await request('GET', '/admin/api/state');
    expect(ignoredState.json().counts).toMatchObject({ movies: 0, unmatched: 0 });
  });

  it('uses the display override in current match and allows image overrides to be cleared', async () => {
    built.database.sqlite.prepare("UPDATE media_items SET display_title='Custom title',poster='https://example.test/poster.jpg',background='https://example.test/background.jpg' WHERE id='item1'").run();
    const customized = await request('GET', '/admin/api/files/file1');
    expect(customized.json().file).toMatchObject({
      displayTitle: 'Custom title', poster: 'https://example.test/poster.jpg', background: 'https://example.test/background.jpg',
      currentMatch: { title: 'Custom title' }
    });

    const cleared = await request('PATCH', '/admin/api/items/item1', { displayTitle: '', poster: '', background: '' });
    expect(cleared.statusCode).toBe(200);
    const item = built.database.sqlite.prepare('SELECT display_title,poster,background FROM media_items WHERE id=?').get('item1') as Record<string, string | null>;
    expect(item).toEqual({ display_title: null, poster: null, background: null });
  });
});
