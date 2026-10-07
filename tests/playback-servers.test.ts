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
