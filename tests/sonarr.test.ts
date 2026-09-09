import {
  afterEach,
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  SonarrClient
} from '../src/services/sonarr.js';

function json(
  body: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        'content-type': 'application/json'
      }
    }
  );
}

interface RecordedCall {
  method: string;
  path: string;
  body?: any;
}

function recordCall(
  calls: RecordedCall[],
  input: string | URL | Request,
  init: RequestInit = {}
): RecordedCall {
  const url = new URL(String(input));

  let body: any;

  if (init.body) {
    body = JSON.parse(String(init.body));
  }

  const call = {
    method: init.method || 'GET',
    path: `${url.pathname}${url.search}`,
    body
  };

  calls.push(call);

  return call;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sonarr monitoring behavior', () => {
  it('monitors and searches only the requested episode by default', async () => {
    const calls: RecordedCall[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (
        input: string | URL | Request,
        init: RequestInit = {}
      ) => {
        const call =
          recordCall(
            calls,
            input,
            init
          );

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/series?tvdbId=12345'
        ) {
          return json([
            {
              id: 7,
              title: 'Example Show',
              tvdbId: 12345,
              seriesType: 'standard'
            }
          ]);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/episode?seriesId=7&seasonNumber=2'
        ) {
          return json([
            {
              id: 44,
              seriesId: 7,
              seasonNumber: 2,
              episodeNumber: 3,
              monitored: false,
              hasFile: false
            }
          ]);
        }

        if (
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/episode/monitor'
        ) {
          return json({});
        }

        if (
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
        ) {
          return json({});
        }

        throw new Error(
          `Unexpected Sonarr call: ${call.method} ${call.path}`
        );
      })
    );

    const client =
      new SonarrClient(
        'http://sonarr:8989',
        'test-key'
      );

    const result =
      await client.ensureEpisode(
        {
          tvdbId: 12345
        },
        2,
        3,
        {
          rootFolderPath: '/tv',
          qualityProfileId: 1,
          monitorWholeSeries: false
        }
      );

    expect(
      result.searchTriggered
    ).toBe(true);

    expect(
      calls.find(
        call =>
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/episode/monitor'
      )?.body
    ).toEqual({
      episodeIds: [44],
      monitored: true
    });

    expect(
      calls.find(
        call =>
          call.path ===
            '/api/v3/series/7'
      )
    ).toBeUndefined();

    expect(
      calls.find(
        call =>
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
      )?.body
    ).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [44]
    });
  });

  it('monitors an existing whole series but searches only the requested episode', async () => {
    const calls: RecordedCall[] = [];

    const currentSeries = {
      id: 7,
      title: 'Example Show',
      tvdbId: 12345,
      seriesType: 'standard',
      monitored: false,
      monitorNewItems: 'none',
      seasons: [
        {
          seasonNumber: 0,
          monitored: false
        },
        {
          seasonNumber: 1,
          monitored: false
        },
        {
          seasonNumber: 2,
          monitored: false
        }
      ]
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (
        input: string | URL | Request,
        init: RequestInit = {}
      ) => {
        const call =
          recordCall(
            calls,
            input,
            init
          );

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/series?tvdbId=12345'
        ) {
          return json([
            currentSeries
          ]);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/episode?seriesId=7&seasonNumber=2'
        ) {
          return json([
            {
              id: 44,
              seriesId: 7,
              seasonNumber: 2,
              episodeNumber: 3,
              monitored: false,
              hasFile: false
            }
          ]);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/series/7'
        ) {
          return json(
            currentSeries
          );
        }

        if (
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/series/7'
        ) {
          return json(call.body);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/episode?seriesId=7'
        ) {
          return json([
            {
              id: 5,
              seriesId: 7,
              seasonNumber: 0,
              episodeNumber: 1,
              monitored: false,
              hasFile: false
            },
            {
              id: 21,
              seriesId: 7,
              seasonNumber: 1,
              episodeNumber: 1,
              monitored: false,
              hasFile: false
            },
            {
              id: 44,
              seriesId: 7,
              seasonNumber: 2,
              episodeNumber: 3,
              monitored: false,
              hasFile: false
            }
          ]);
        }

        if (
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/episode/monitor'
        ) {
          return json({});
        }

        if (
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
        ) {
          return json({});
        }

        throw new Error(
          `Unexpected Sonarr call: ${call.method} ${call.path}`
        );
      })
    );

    const client =
      new SonarrClient(
        'http://sonarr:8989',
        'test-key'
      );

    await client.ensureEpisode(
      {
        tvdbId: 12345
      },
      2,
      3,
      {
        rootFolderPath: '/tv',
        qualityProfileId: 1,
        monitorWholeSeries: true
      }
    );

    const seriesUpdate =
      calls.find(
        call =>
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/series/7'
      );

    expect(
      seriesUpdate?.body.monitored
    ).toBe(true);

    expect(
      seriesUpdate?.body.monitorNewItems
    ).toBe('all');

    expect(
      seriesUpdate?.body.seasons
    ).toEqual([
      {
        seasonNumber: 0,
        monitored: false
      },
      {
        seasonNumber: 1,
        monitored: true
      },
      {
        seasonNumber: 2,
        monitored: true
      }
    ]);

    const episodeMonitor =
      calls.find(
        call =>
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/episode/monitor'
      );

    expect(
      episodeMonitor?.body
    ).toEqual({
      episodeIds: [21, 44],
      monitored: true
    });

    const searches =
      calls.filter(
        call =>
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
      );

    expect(searches).toHaveLength(1);

    expect(searches[0]?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [44]
    });
  });

  it('adds a new whole series as monitored without searching the backlog', async () => {
    const calls: RecordedCall[] = [];

    const lookupSeries = {
      title: 'New Example Show',
      tvdbId: 54321,
      imdbId: 'tt1234567',
      seriesType: 'standard',
      seasons: [
        {
          seasonNumber: 0,
          monitored: false
        },
        {
          seasonNumber: 1,
          monitored: false
        }
      ]
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (
        input: string | URL | Request,
        init: RequestInit = {}
      ) => {
        const call =
          recordCall(
            calls,
            input,
            init
          );

        const url =
          new URL(String(input));

        if (
          call.method === 'GET' &&
          url.pathname ===
            '/api/v3/series' &&
          url.searchParams.get('tvdbId') ===
            '54321'
        ) {
          return json([]);
        }

        if (
          call.method === 'GET' &&
          url.pathname ===
            '/api/v3/series/lookup' &&
          url.searchParams.get('term') ===
            'tvdb:54321'
        ) {
          return json([
            lookupSeries
          ]);
        }

        if (
          call.method === 'POST' &&
          call.path ===
            '/api/v3/series'
        ) {
          return json({
            ...call.body,
            id: 9
          });
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/episode?seriesId=9&seasonNumber=1'
        ) {
          return json([
            {
              id: 77,
              seriesId: 9,
              seasonNumber: 1,
              episodeNumber: 4,
              monitored: true,
              hasFile: false
            }
          ]);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/series/9'
        ) {
          return json({
            ...lookupSeries,
            id: 9,
            monitored: true,
            monitorNewItems: 'all'
          });
        }

        if (
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/series/9'
        ) {
          return json(call.body);
        }

        if (
          call.method === 'GET' &&
          call.path ===
            '/api/v3/episode?seriesId=9'
        ) {
          return json([
            {
              id: 70,
              seriesId: 9,
              seasonNumber: 0,
              episodeNumber: 1,
              monitored: false,
              hasFile: false
            },
            {
              id: 77,
              seriesId: 9,
              seasonNumber: 1,
              episodeNumber: 4,
              monitored: true,
              hasFile: false
            }
          ]);
        }

        if (
          call.method === 'PUT' &&
          call.path ===
            '/api/v3/episode/monitor'
        ) {
          return json({});
        }

        if (
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
        ) {
          return json({});
        }

        throw new Error(
          `Unexpected Sonarr call: ${call.method} ${call.path}`
        );
      })
    );

    const client =
      new SonarrClient(
        'http://sonarr:8989',
        'test-key'
      );

    await client.ensureEpisode(
      {
        tvdbId: 54321
      },
      1,
      4,
      {
        rootFolderPath: '/tv',
        qualityProfileId: 1,
        monitorWholeSeries: true
      }
    );

    const addSeries =
      calls.find(
        call =>
          call.method === 'POST' &&
          call.path ===
            '/api/v3/series'
      );

    expect(
      addSeries?.body.monitored
    ).toBe(true);

    expect(
      addSeries?.body.monitorNewItems
    ).toBe('all');

    expect(
      addSeries?.body.addOptions
    ).toMatchObject({
      monitor: 'all',
      searchForMissingEpisodes: false,
      searchForCutoffUnmetEpisodes: false
    });

    const searches =
      calls.filter(
        call =>
          call.method === 'POST' &&
          call.path ===
            '/api/v3/command'
      );

    expect(searches).toHaveLength(1);

    expect(searches[0]?.body).toEqual({
      name: 'EpisodeSearch',
      episodeIds: [77]
    });
  });
});
