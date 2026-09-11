import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  createSiloMediaToken,
  createStreamToken
} from '../src/lib/security.js';
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
      SCAN_ON_STARTUP: 'false', WATCH_MEDIA: 'false', LOG_LEVEL: 'silent',
      SILO_ENABLED: 'true', SILO_URL: 'http://silo:8080', SILO_API_KEY: 'test-silo-key'
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
    vi.unstubAllGlobals();
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

  function addonUrl(pathname: string): string {
    return `${built.settings.addonAccessPath}${pathname}`;
  }

  it('requires the private addon URL for every Stremio resource', async () => {
    expect(built.settings.addonAccessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    for (const url of [
      '/manifest.json',
      '/catalog/movie/personal_movies.json',
      '/meta/movie/tt1234567.json',
      '/stream/movie/tt1234567.json',
      '/addon/not-the-token/manifest.json'
    ]) {
      const response = await built.app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    }

    const manifestResponse = await built.app.inject({
      method: 'GET',
      url: addonUrl('/manifest.json')
    });
    expect(manifestResponse.statusCode).toBe(200);
    expect(manifestResponse.json()).toMatchObject({
      id: 'community.nuviflow',
      name: 'Nuvi-Flow'
    });
  });

  it('returns catalog and meta protocol objects', async () => {
    const catalog = await built.app.inject({ method: 'GET', url: addonUrl('/catalog/movie/personal_movies.json') });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().metas[0]).toMatchObject({ id: 'tt1234567', type: 'movie', name: 'Example Movie' });
    const meta = await built.app.inject({ method: 'GET', url: addonUrl('/meta/movie/tt1234567.json') });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().meta).toMatchObject({ id: 'tt1234567', moviedb_id: 123 });
  });

  it('returns a signed direct stream URL', async () => {
    const response = await built.app.inject({ method: 'GET', url: addonUrl('/stream/movie/tt1234567.json') });
    expect(response.statusCode).toBe(200);
    expect(response.json().streams[0]).toMatchObject({ title: '1080p • H.264 • AAC 5.1' });
    expect(response.json().streams[0].url).toMatch(/^https:\/\/media\.example\.test\/media\//);
  });

  it('adds a second Silo transcoded stream without changing direct playback', async () => {
    built.settings.set(
      'siloProfileId',
      'profile-1'
    );

    const response = await built.app.inject({
      method: 'GET',
      url: addonUrl('/stream/movie/tt1234567.json')
    });

    expect(response.statusCode).toBe(200);

    const streams = response.json().streams;

    expect(streams).toHaveLength(2);

    expect(streams[0]).toMatchObject({
      title: '1080p • H.264 • AAC 5.1'
    });

    expect(streams[0].url).toMatch(
      /^https:\/\/media\.example\.test\/media\//
    );

    expect(streams[1].url).toMatch(
      /^https:\/\/media\.example\.test\/silo-stream\//
    );

    expect(streams[1].title).toContain(
      'Silo'
    );
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

  it('proxies signed Silo media with server-side authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        Buffer.from('test-segment'),
        {
          status: 200,
          headers: {
            'Content-Type': 'video/mp2t'
          }
        }
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    const { token } = createSiloMediaToken(
      '/api/v1/playback/transcode/session-1/segment/seg_00000.ts',
      Date.now() + 60_000,
      secret
    );

    const response = await built.app.inject({
      method: 'GET',
      url:
        `/silo-media/${encodeURIComponent(token)}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('test-segment');

    const [url, init] =
      fetchMock.mock.calls[0] as [
        string,
        RequestInit
      ];

    expect(url).toBe(
      'http://silo:8080/api/v1/playback/transcode/session-1/segment/seg_00000.ts'
    );

    const headers = new Headers(
      init.headers
    );

    expect(
      headers.get('Authorization')
    ).toBe('Bearer test-silo-key');

    expect(response.body).not.toContain(
      'test-silo-key'
    );
  });

  it('starts Silo transcoded HLS playback for an authorized media file', async () => {
    built.settings.set(
      'siloProfileId',
      'profile-1'
    );

    built.settings.set(
      'siloTranscodeQuality',
      '1080p-medium'
    );

    const fetchMock = vi.fn().mockImplementation(
      async (
        url: string,
        init?: RequestInit
      ) => {
        if (
          url.endsWith(
            '/api/v1/catalog/items/movie-tmdb-123/versions'
          )
        ) {
          return new Response(
            JSON.stringify([
              {
                file_id: 120,
                file_path: mediaPath
              }
            ]),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json'
              }
            }
          );
        }

        if (
          url.endsWith(
            '/api/v1/playback/start'
          )
        ) {
          expect(init?.method).toBe('POST');

          const body = JSON.parse(
            String(init?.body)
          );

          expect(body).toMatchObject({
            protocol_version: 3,
            file_id: 120,
            profile_id: 'profile-1',
            quality_preference:
              '1080p-medium'
          });

          return new Response(
            JSON.stringify({
              protocol_version: 3,
              server_features: [
                'playback_plan_v3',
                'header_authenticated_media_v1'
              ],
              outcome: 'playable',
              session_id: 'session-1',
              playback_plan: {
                delivery:
                  'server_transcode_hls',
                stream: {
                  url:
                    '/playback/transcode/session-1/master.m3u8',
                  protocol: 'hls',
                  container: 'hls',
                  mime_type:
                    'application/vnd.apple.mpegurl',
                  headers: {},
                  header_refresh: 'none'
                }
              }
            }),
            {
              status: 201,
              headers: {
                'Content-Type':
                  'application/json'
              }
            }
          );
        }

        return new Response(null, {
          status: 404
        });
      }
    );

    vi.stubGlobal('fetch', fetchMock);

    const response =
      await built.app.inject({
        method: 'GET',
        url:
          `/silo-stream/${encodeURIComponent(token())}`
      });

    expect(response.statusCode).toBe(302);

    expect(
      response.headers.location
    ).toMatch(
      /^\/silo-media\//
    );

    expect(
      response.headers.location
    ).not.toContain(
      'test-silo-key'
    );
  });

  it('coalesces simultaneous Silo playback requests and reuses the session', async () => {
    built.settings.set(
      'siloProfileId',
      'profile-1'
    );

    const fetchMock = vi.fn().mockImplementation(
      async (url: string) => {
        if (
          url.endsWith(
            '/api/v1/catalog/items/movie-tmdb-123/versions'
          )
        ) {
          return new Response(
            JSON.stringify([
              {
                file_id: 120,
                file_path: mediaPath
              }
            ]),
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/json'
              }
            }
          );
        }

        if (
          url.endsWith(
            '/api/v1/playback/start'
          )
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, 20)
          );

          return new Response(
            JSON.stringify({
              protocol_version: 3,
              server_features: [
                'playback_plan_v3'
              ],
              outcome: 'playable',
              session_id: 'shared-session',
              playback_plan: {
                delivery:
                  'server_transcode_hls',
                stream: {
                  url:
                    '/playback/transcode/shared-session/master.m3u8',
                  protocol: 'hls',
                  headers: {},
                  header_refresh: 'none'
                }
              }
            }),
            {
              status: 201,
              headers: {
                'Content-Type':
                  'application/json'
              }
            }
          );
        }

        return new Response(null, {
          status: 404
        });
      }
    );

    vi.stubGlobal('fetch', fetchMock);

    const streamToken = token();
    const streamUrl =
      `/silo-stream/${encodeURIComponent(streamToken)}`;

    const [first, second] = await Promise.all([
      built.app.inject({
        method: 'GET',
        url: streamUrl,
        headers: {
          'user-agent': 'Nuvio Test Client'
        }
      }),
      built.app.inject({
        method: 'GET',
        url: streamUrl,
        headers: {
          'user-agent': 'Nuvio Test Client'
        }
      })
    ]);

    expect(first.statusCode).toBe(302);
    expect(second.statusCode).toBe(302);
    expect(first.headers.location).toBe(
      second.headers.location
    );
    expect(
      first.headers['x-nuvi-flow-playback-id']
    ).toBe(
      second.headers['x-nuvi-flow-playback-id']
    );

    const versionRequests = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(
        '/api/v1/catalog/items/movie-tmdb-123/versions'
      ));
    const startRequests = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith(
        '/api/v1/playback/start'
      ));

    expect(versionRequests).toHaveLength(1);
    expect(startRequests).toHaveLength(1);

    const reused = await built.app.inject({
      method: 'GET',
      url: streamUrl,
      headers: {
        'user-agent': 'Nuvio Test Client'
      }
    });

    expect(reused.statusCode).toBe(302);
    expect(reused.headers.location).toBe(
      first.headers.location
    );
    expect(
      reused.headers['x-nuvi-flow-playback-id']
    ).toBe(
      first.headers['x-nuvi-flow-playback-id']
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rewrites Silo HLS segment URLs through the signed proxy', async () => {
    const fetchMock = vi.fn().mockImplementation(
      async (url: string) => {
        if (url.endsWith('/master.m3u8')) {
          return new Response(
            '#EXTM3U\n#EXTINF:2.000000,\nsegment/seg_00000.ts\n',
            {
              status: 200,
              headers: {
                'Content-Type':
                  'application/vnd.apple.mpegurl'
              }
            }
          );
        }

        if (url.endsWith('/segment/seg_00000.ts')) {
          return new Response(
            Buffer.from('test-segment'),
            {
              status: 200,
              headers: {
                'Content-Type': 'video/mp2t'
              }
            }
          );
        }

        return new Response(null, {
          status: 404
        });
      }
    );

    vi.stubGlobal('fetch', fetchMock);

    const { token } = createSiloMediaToken(
      '/api/v1/playback/transcode/session-1/master.m3u8',
      Date.now() + 60_000,
      secret
    );

    const manifestResponse =
      await built.app.inject({
        method: 'GET',
        url:
          `/silo-media/${encodeURIComponent(token)}`
      });

    expect(
      manifestResponse.statusCode
    ).toBe(200);

    const lines =
      manifestResponse.body
        .split('\n')
        .map(line => line.trim());

    const segmentUrl = lines.find(
      line =>
        line &&
        !line.startsWith('#')
    );

    expect(segmentUrl).toMatch(
      /^\/silo-media\//
    );

    expect(segmentUrl).not.toContain(
      'test-silo-key'
    );

    const segmentResponse =
      await built.app.inject({
        method: 'GET',
        url: segmentUrl!
      });

    expect(
      segmentResponse.statusCode
    ).toBe(200);

    expect(segmentResponse.body).toBe(
      'test-segment'
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://silo:8080/api/v1/playback/transcode/session-1/segment/seg_00000.ts',
      expect.any(Object)
    );
  });

  it('returns GET-equivalent headers and no body for HEAD', async () => {
    const response = await built.app.inject({ method: 'HEAD', url: `/media/${encodeURIComponent(token())}`, headers: { range: 'bytes=5-' } });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 5-35/36');
    expect(response.headers['content-length']).toBe('31');
    expect(response.body).toBe('');
  });
});
