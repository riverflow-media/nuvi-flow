import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createStreamToken } from '../src/lib/security.js';
import { buildApp, type BuiltApp } from '../src/server.js';

describe('Stremio and media HTTP endpoints', () => {
  let built: BuiltApp;
  let directory: string;
  let mediaPath: string;
  const secret = 'test-stream-secret-at-least-thirty-two-characters';

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zpm-test-'));
    mediaPath = path.join(directory, 'Example Movie (2024).mp4');
    fs.writeFileSync(mediaPath, Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz'));
    const config = loadConfig({
      PORT: '60500', BASE_URL: 'https://media.example.test', DATABASE_PATH: path.join(directory, 'test.db'),
      MOVIES_PATH: directory, TV_PATH: directory, ADMIN_PASSWORD: 'safe-test-password',
      SESSION_SECRET: 'test-session-secret-at-least-thirty-two-chars', STREAM_SECRET: secret,
      SCAN_ON_STARTUP: 'false', WATCH_MEDIA: 'false', LOG_LEVEL: 'silent'
    });
    built = await buildApp(config);
    const now = Date.now();
    built.database.sqlite.prepare(`INSERT INTO media_items (id,type,stremio_id,tmdb_id,imdb_id,title,year,created_at,updated_at)
      VALUES ('item1','movie','tt1234567',123,'tt1234567','Example Movie',2024,?,?)`).run(now, now);
    built.database.sqlite.prepare(`INSERT INTO media_files (
      id,library_type,absolute_path,relative_path,size,mtime_ms,duration_seconds,video_codec,audio_codec,width,height,
      audio_channels,parsed_title,quality,media_item_id,confidence,status,added_at,updated_at,last_seen_at
    ) VALUES ('file1','movie',?,?,?,?,120.5,'h264','aac',1920,1080,6,'Example Movie','1080P','item1',.99,'matched',?,?,?)`)
      .run(mediaPath, path.basename(mediaPath), fs.statSync(mediaPath).size, fs.statSync(mediaPath).mtimeMs, now, now, now);
    await built.app.ready();
  });

  afterEach(async () => {
    await built.app.close();
    built.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function token(): string {
    const created = createStreamToken('file1', Date.now() + 60_000, secret, 'integration-token');
    built.database.sqlite.prepare('INSERT OR REPLACE INTO stream_tokens (jti,media_file_id,expires_at,created_at,revoked) VALUES (?,?,?,?,0)')
      .run(created.payload.jti, 'file1', created.payload.exp, Date.now());
    return created.token;
  }

  it('returns catalog and meta protocol objects', async () => {
    const catalog = await built.app.inject({ method: 'GET', url: '/catalog/movie/personal_movies.json' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metas[0]).toMatchObject({ id: 'tt1234567', type: 'movie', name: 'Example Movie' });
    const meta = await built.app.inject({ method: 'GET', url: '/meta/movie/tt1234567.json' });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().meta).toMatchObject({ id: 'tt1234567', moviedb_id: 123 });
  });

  it('returns a signed direct stream URL', async () => {
    const response = await built.app.inject({ method: 'GET', url: '/stream/movie/tt1234567.json' });
    expect(response.statusCode).toBe(200);
    expect(response.json().streams[0]).toMatchObject({ title: '1080p • H.264 • AAC 5.1' });
    expect(response.json().streams[0].url).toMatch(/^https:\/\/media\.example\.test\/media\//);
  });

  it('serves exact partial content and invalid ranges', async () => {
    const valid = await built.app.inject({ method: 'GET', url: `/media/${encodeURIComponent(token())}`, headers: { range: 'bytes=10-19' } });
    expect(valid.statusCode).toBe(206);
    expect(valid.headers['accept-ranges']).toBe('bytes');
    expect(valid.headers['content-range']).toBe('bytes 10-19/36');
    expect(valid.headers['content-length']).toBe('10');
    expect(valid.body).toBe('abcdefghij');
    const invalid = await built.app.inject({ method: 'GET', url: `/media/${encodeURIComponent(token())}`, headers: { range: 'bytes=100-' } });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */36');
  });

  it('returns GET-equivalent headers and no body for HEAD', async () => {
    const response = await built.app.inject({ method: 'HEAD', url: `/media/${encodeURIComponent(token())}`, headers: { range: 'bytes=5-' } });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 5-35/36');
    expect(response.headers['content-length']).toBe('31');
    expect(response.body).toBe('');
  });
});
