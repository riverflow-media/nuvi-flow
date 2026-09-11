import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  SiloClient,
  siloContentId
} from '../src/services/silo.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Silo integration', () => {
  it('builds deterministic movie and TV episode IDs', () => {
    expect(
      siloContentId({
        type: 'movie',
        tmdb_id: 122,
        metadata_json: '{}'
      })
    ).toBe('movie-tmdb-122');

    expect(
      siloContentId(
        {
          type: 'series',
          tmdb_id: 615,
          metadata_json: JSON.stringify({
            external_ids: {
              tvdb_id: 100001
            }
          })
        },
        {
          season: 1,
          episode: 1
        }
      )
    ).toBe(
      'episode-tvdb-100001-1-1'
    );
  });

  it('matches a Silo version by exact file path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            file_id: 149,
            file_path:
              '/test-library/series/Example Series/Season 01/Episode 01.mkv'
          }
        ]),
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/json'
          }
        }
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new SiloClient(
      'http://silo:8080',
      'test-key'
    );

    const fileId =
      await client.resolveFileId(
        {
          type: 'series',
          tmdb_id: 615,
          metadata_json: JSON.stringify({
            external_ids: {
              tvdb_id: 100001
            }
          })
        },
        {
          absolute_path:
            '/test-library/series/Example Series/Season 01/Episode 01.mkv'
        },
        {
          season: 1,
          episode: 1
        }
      );

    expect(fileId).toBe(149);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://silo:8080/api/v1/catalog/items/episode-tvdb-100001-1-1/versions',
      expect.any(Object)
    );
  });

  it('starts Silo v3 HLS playback without exposing the API key', async () => {
    vi.stubEnv('NUVI_FLOW_VERSION', '1.2.3-test');
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          protocol_version: 3,
          server_features: [
            'playback_plan_v3',
            'header_authenticated_media_v1'
          ],
          outcome: 'playable',
          session_id: 'test-session',
          playback_plan: {
            delivery: 'server_transcode_hls',
            stream: {
              url: '/playback/transcode/test-session/master.m3u8',
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
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new SiloClient(
      'http://silo:8080',
      'super-secret-test-key'
    );

    const result =
      await client.startPlayback(
        120,
        'profile-1',
        '1080p-medium'
      );

    expect(result.outcome).toBe('playable');

    expect(
      result.playback_plan?.delivery
    ).toBe('server_transcode_hls');

    expect(
      result.playback_plan?.stream.url
    ).toBe(
      '/playback/transcode/test-session/master.m3u8'
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] =
      fetchMock.mock.calls[0] as [
        string,
        RequestInit
      ];

    expect(url).toBe(
      'http://silo:8080/api/v1/playback/start'
    );

    expect(init.method).toBe('POST');

    const headers = new Headers(
      init.headers
    );

    expect(
      headers.get('Authorization')
    ).toBe(
      'Bearer super-secret-test-key'
    );

    expect(
      headers.get('X-Profile-Id')
    ).toBe('profile-1');

    expect(
      headers.get('Content-Type')
    ).toBe('application/json');

    expect(
      headers.get('X-Silo-Client')
    ).toBe('Nuvi-Flow');

    expect(
      headers.get('X-Silo-Client-Version')
    ).toBe('1.2.3-test');

    const body = JSON.parse(
      String(init.body)
    );

    expect(body).toMatchObject({
      protocol_version: 3,
      file_id: 120,
      profile_id: 'profile-1',
      quality_preference: '1080p-medium',
      subtitle_fidelity_preference:
        'compatible',
      progress_persistence: 'client',
      client_capabilities: {
        codecs_video: ['h264'],
        codecs_audio: ['aac'],
        containers: ['hls'],
        max_resolution: '1080p',
        hdr: false
      },
      client_playback_context: {
        app_version: '1.2.3-test',
        deliveries: {
          hls: {
            enabled: true,
            supported_on_device: true,
            auth_header_refresh: true
          }
        }
      }
    });

    expect(
      body.client_features
    ).toContain(
      'header_authenticated_media_v1'
    );

    expect(
      body.playback_attempt_id
    ).toEqual(expect.any(String));

    expect(
      JSON.stringify(body)
    ).not.toContain(
      'super-secret-test-key'
    );
  });

  it('fetches Silo media with server-side authentication', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '#EXTM3U\nsegment/seg_00000.ts\n',
        {
          status: 200,
          headers: {
            'Content-Type':
              'application/vnd.apple.mpegurl'
          }
        }
      )
    );

    vi.stubGlobal('fetch', fetchMock);

    const client = new SiloClient(
      'http://silo:8080',
      'super-secret-test-key'
    );

    const response = await client.fetchMedia(
      '/api/v1/playback/transcode/test/master.m3u8',
      {
        headers: {
          Accept:
            'application/vnd.apple.mpegurl',
          'X-Playback-Test': 'preserved'
        }
      }
    );

    expect(response.status).toBe(200);

    expect(await response.text()).toContain(
      '#EXTM3U'
    );

    const [url, init] =
      fetchMock.mock.calls[0] as [
        string,
        RequestInit
      ];

    expect(url).toBe(
      'http://silo:8080/api/v1/playback/transcode/test/master.m3u8'
    );

    const headers = new Headers(
      init.headers
    );

    expect(
      headers.get('Authorization')
    ).toBe(
      'Bearer super-secret-test-key'
    );

    expect(
      headers.get('Accept')
    ).toBe(
      'application/vnd.apple.mpegurl'
    );

    expect(
      headers.get('X-Playback-Test')
    ).toBe('preserved');
  });

  it('returns null when Silo has no exact matching version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              file_id: 999,
              file_path:
                '/test-library/series/Other Series/Episode.mkv'
            }
          ]),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json'
            }
          }
        )
      )
    );

    const client = new SiloClient(
      'http://silo:8080',
      'test-key'
    );

    const result =
      await client.resolveFileId(
        {
          type: 'movie',
          tmdb_id: 122,
          metadata_json: '{}'
        },
        {
          absolute_path:
            '/test-library/movies/Example Movie.mkv'
        }
      );

    expect(result).toBeNull();
  });
});
