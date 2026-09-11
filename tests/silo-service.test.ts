import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';
import { SiloService } from '../src/services/silo-service.js';
import type { SettingsService } from '../src/services/settings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Silo service boundary', () => {
  it('resolves and starts playback through one route-facing operation', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.endsWith('/versions')) {
        return new Response(JSON.stringify([{
          file_id: 149,
          file_path: '/test-library/movies/Example Movie.mkv'
        }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify({
        protocol_version: 3,
        server_features: [],
        outcome: 'playable',
        session_id: 'session-1',
        playback_plan: {
          delivery: 'server_transcode_hls',
          stream: {
            url: '/playback/session-1/master.m3u8',
            protocol: 'hls',
            headers: {},
            header_refresh: 'none'
          }
        }
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const settings = {
      siloUrl: 'http://silo:8080',
      siloApiKey: 'server-side-secret'
    } as SettingsService;
    const service = new SiloService(settings);

    const result = await service.startPlaybackForMedia(
      {
        type: 'movie',
        tmdb_id: 123,
        metadata_json: '{}'
      },
      {
        id: 'file-1',
        absolute_path: '/test-library/movies/Example Movie.mkv'
      },
      'profile-1',
      '1080p-medium'
    );

    expect(result).toMatchObject({
      fileId: 149,
      decision: {
        outcome: 'playable',
        session_id: 'session-1'
      }
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://silo:8080/api/v1/catalog/items/movie-tmdb-123/versions',
      'http://silo:8080/api/v1/playback/start'
    ]);

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get('Authorization'))
        .toBe('Bearer server-side-secret');
    }
  });

  it('uses supplied unsaved credentials for connection tests', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const payload = url.endsWith('/health')
        ? { status: 'ok', server_name: 'Test Silo' }
        : [{ id: 'profile-1', name: 'Default' }];

      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    vi.stubGlobal('fetch', fetchMock);

    const service = new SiloService({
      siloUrl: 'http://saved-silo:8080',
      siloApiKey: 'saved-key'
    } as SettingsService);

    const result = await service.testConnection(
      'http://candidate-silo:8080',
      'candidate-key'
    );

    expect(result.health.server_name).toBe('Test Silo');
    expect(result.profiles[0]?.id).toBe('profile-1');

    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^http:\/\/candidate-silo:8080\/api\/v1\//);
      expect(new Headers(init?.headers).get('Authorization'))
        .toBe('Bearer candidate-key');
    }
  });
});
