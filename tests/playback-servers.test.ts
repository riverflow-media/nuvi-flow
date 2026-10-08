import { afterEach, describe, expect, it, vi } from 'vitest';
import { JellyfinClient } from '../src/services/jellyfin.js';
import { PlexClient } from '../src/services/plex.js';
import { PlaybackServersService } from '../src/services/playback-servers.js';
import type { SettingsService } from '../src/services/settings.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

describe('playback server control plane', () => {
  it('authenticates Jellyfin server and user discovery without URL credentials', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/System/Info')) {
        return json({
          Id: 'jellyfin-server-id',
          ServerName: 'Living Room Jellyfin',
          Version: '10.11.6',
          OperatingSystem: 'Linux'
        });
      }
      if (url.endsWith('/Users')) {
        return json([
          { Id: 'user-1', Name: 'Viewer', Policy: { IsDisabled: false } },
          { Id: 'user-2', Name: 'Retired', Policy: { IsDisabled: true } }
        ]);
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new JellyfinClient(
      'http://jellyfin:8096/',
      'private-jellyfin-key'
    );
    await expect(Promise.all([
      client.systemInfo(),
      client.users()
    ])).resolves.toEqual([
      {
        id: 'jellyfin-server-id',
        name: 'Living Room Jellyfin',
        version: '10.11.6',
        operatingSystem: 'Linux'
      },
      [
        { id: 'user-1', name: 'Viewer', disabled: false },
        { id: 'user-2', name: 'Retired', disabled: true }
      ]
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).not.toContain('private-jellyfin-key');
      const headers = new Headers(init.headers);
      expect(headers.get('X-Emby-Token')).toBe('private-jellyfin-key');
      expect(headers.get('Authorization')).toContain('Token="private-jellyfin-key"');
    }
  });

  it('authenticates Plex identity and libraries with standard client headers', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/library/sections/all')) {
        return json({
          MediaContainer: {
            Directory: [
              { key: '1', title: 'Movies', type: 'movie' },
              { key: '2', title: 'TV', type: 'show' }
            ]
          }
        });
      }
      return json({
        MediaContainer: {
          machineIdentifier: 'plex-server-id',
          friendlyName: 'Home Plex',
          version: '1.42.2.10156'
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PlexClient(
      'http://plex:32400/',
      'private-plex-token'
    );
    await expect(Promise.all([
      client.serverInfo(),
      client.libraries()
    ])).resolves.toEqual([
      {
        id: 'plex-server-id',
        name: 'Home Plex',
        version: '1.42.2.10156'
      },
      [
        { id: '1', name: 'Movies', type: 'movie' },
        { id: '2', name: 'TV', type: 'show' }
      ]
    ]);

    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).not.toContain('private-plex-token');
      const headers = new Headers(init.headers);
      expect(headers.get('X-Plex-Token')).toBe('private-plex-token');
      expect(headers.get('X-Plex-Product')).toBe('Nuvi-Flow');
      expect(headers.get('Accept')).toBe('application/json');
    }
  });

  it('negotiates and proxies Jellyfin playback without URL credentials', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/Items/item-1/PlaybackInfo')) {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          UserId: 'user-1',
          MediaSourceId: 'source-1',
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
          AllowVideoStreamCopy: true,
          AllowAudioStreamCopy: false
        });
        return json({ PlaySessionId: 'play-1', MediaSources: [] });
      }
      if (url.includes('/Videos/item-1/stream')) {
        expect(new Headers(init?.headers).get('range')).toBe('bytes=0-9');
        return new Response('0123456789', { status: 206 });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new JellyfinClient(
      'http://jellyfin:8096/',
      'private-jellyfin-key'
    );
    const profile = {
      Name: 'test',
      MaxStaticBitrate: 100_000_000,
      MaxStreamingBitrate: 100_000_000,
      DirectPlayProfiles: [],
      TranscodingProfiles: [],
      ContainerProfiles: [],
      CodecProfiles: [],
      SubtitleProfiles: []
    } as const;

    await client.playbackInfo('item-1', {
      userId: 'user-1',
      mediaSourceId: 'source-1',
      deviceId: 'device_1234567890abcdef12345678',
      deviceProfile: profile,
      allowVideoStreamCopy: true,
      allowAudioStreamCopy: false
    });
    const media = await client.fetchMedia(
      new URL('http://jellyfin:8096/Videos/item-1/stream'),
      'device_1234567890abcdef12345678',
      { method: 'GET', headers: new Headers({ range: 'bytes=0-9' }) }
    );
    expect(media.status).toBe(206);

    for (const [url, init] of fetchMock.mock.calls as Array<[string | URL, RequestInit]>) {
      expect(String(url)).not.toContain('private-jellyfin-key');
      const headers = new Headers(init.headers);
      expect(headers.get('X-Emby-Token')).toBe('private-jellyfin-key');
      expect(headers.get('Authorization')).toContain('Token="private-jellyfin-key"');
    }
  });

  it('still reports Jellyfin playback stopped when encoding cleanup fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/Videos/ActiveEncodings')) return json({}, 500);
      if (url.endsWith('/Sessions/Playing/Stopped')) {
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new JellyfinClient(
      'http://jellyfin:8096',
      'private-jellyfin-key'
    );

    await expect(client.stopPlayback({
      itemId: 'item-1',
      mediaSourceId: 'source-1',
      playSessionId: 'play-session-1',
      deviceId: 'device_1234567890abcdef12345678',
      playMethod: 'Transcode',
      transcoding: true
    })).rejects.toMatchObject({ status: 500 });
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://jellyfin:8096/Videos/ActiveEncodings?DeviceId=device_1234567890abcdef12345678&PlaySessionId=play-session-1',
      'http://jellyfin:8096/Sessions/Playing/Stopped'
    ]);
  });

  it('uses saved settings through one application service boundary', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/System/Info')) {
        return json({ Id: 'server-id', ServerName: 'Jellyfin', Version: '10.11.6' });
      }
      return json([{ Id: 'user-id', Name: 'Viewer' }]);
    });
    vi.stubGlobal('fetch', fetchMock);
    const service = new PlaybackServersService({
      jellyfinUrl: 'http://saved-jellyfin:8096',
      jellyfinApiKey: 'saved-key'
    } as SettingsService);

    await expect(service.testJellyfin()).resolves.toMatchObject({
      server: { name: 'Jellyfin' },
      users: [{ id: 'user-id', name: 'Viewer' }]
    });
    expect(fetchMock.mock.calls.map(call => String(call[0]))).toEqual([
      'http://saved-jellyfin:8096/System/Info',
      'http://saved-jellyfin:8096/Users'
    ]);
  });

  it.each([
    ['Jellyfin', () => new JellyfinClient('http://jellyfin:8096', 'never-leak-jellyfin').systemInfo()],
    ['Plex', () => new PlexClient('http://plex:32400', 'never-leak-plex').serverInfo()]
  ])('normalizes %s authentication failures without leaking credentials', async (
    service,
    request
  ) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    await expect(request()).rejects.toMatchObject({
      message: `${service} returned HTTP 401.`,
      status: 401
    });
    await expect(request()).rejects.not.toThrow('never-leak');
  });
});
