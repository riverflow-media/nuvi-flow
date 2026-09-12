import { describe, expect, it, vi } from 'vitest';
import {
  FallbackAddonService,
  hasNetworkHeadroom,
  isSafeFallbackCandidateUrl,
  requiredAverageBitrateMbps,
  selectFallbackCandidate,
  selectFallbackCandidates
} from '../src/services/playback/fallback-addon.js';
import type { SettingsService } from '../src/services/settings.js';
import type { MediaFileRow, MediaItemRow } from '../src/types.js';

function settings(overrides: Record<string, unknown> = {}): SettingsService {
  return {
    fallbackAddonEnabled: true,
    fallbackAddonManifestUrl: 'https://aio.example/private/install/manifest.json',
    fallbackAddonTimeoutMs: 5000,
    ...overrides
  } as unknown as SettingsService;
}

const input = {
  item: {
    type: 'movie',
    stremio_id: 'tt1234567',
    title: 'Example Movie'
  } as MediaItemRow,
  file: {
    id: 'file-1',
    edition: null
  } as MediaFileRow,
  deviceId: 'device_1234567890abcdef12345678',
  authorizationExpiresAt: Date.now() + 60_000
};

describe('fallback addon service', () => {
  it('validates an AIOStreams manifest without exposing its private URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      id: 'aiostreams.private',
      name: 'AIOStreams',
      version: '2.9.0',
      resources: ['stream'],
      types: ['movie', 'series']
    }), { status: 200 }));
    const service = new FallbackAddonService(
      settings(),
      { info: vi.fn(), warn: vi.fn() },
      { fetch: fetcher, cleanupIntervalMs: 0 }
    );
    await expect(service.testConnection()).resolves.toEqual({
      id: 'aiostreams.private',
      name: 'AIOStreams',
      version: '2.9.0',
      provider: 'aiostreams'
    });
    expect(fetcher).toHaveBeenCalledOnce();
    service.close();
  });

  it('selects only an immediately playable public HTTPS candidate', () => {
    expect(isSafeFallbackCandidateUrl('http://cdn.example/movie.mkv')).toBe(false);
    expect(isSafeFallbackCandidateUrl('https://127.0.0.1/movie.mkv')).toBe(false);
    expect(isSafeFallbackCandidateUrl('https://cdn.example/master.m3u8')).toBe(false);
    expect(selectFallbackCandidate([
      { infoHash: 'torrent-only' },
      { url: 'https://cdn.example/not-ready.mkv', behaviorHints: { notWebReady: true } },
      { url: 'https://cdn.example/movie.mkv', title: 'Cached 2160p BluRay' }
    ])).toMatchObject({
      url: 'https://cdn.example/movie.mkv',
      label: 'Cached 2160p BluRay',
      requestHeaders: {},
      videoSizeBytes: null,
      resolutionHeight: 2160
    });
  });

  it('keeps edition matching and proxy headers bounded', () => {
    expect(selectFallbackCandidate([{
      url: 'https://cdn.example/theatrical.mkv',
      title: 'Movie Theatrical Cut'
    }], 'Extended Edition')).toBeNull();
    expect(selectFallbackCandidate([{
      url: 'https://cdn.example/extended.mkv',
      title: 'Movie Extended Edition',
      behaviorHints: {
        proxyHeaders: {
          request: {
            Authorization: 'Bearer server-only',
            Cookie: 'must-not-forward',
            'X-Arbitrary': 'must-not-forward'
          }
        }
      }
    }], 'Extended Edition')).toMatchObject({
      url: 'https://cdn.example/extended.mkv',
      requestHeaders: { authorization: 'Bearer server-only' }
    });
  });

  it('keeps at most ten unique safe candidates', () => {
    const streams = Array.from({ length: 12 }, (_, index) => ({
      url: `https://cdn${index}.example/movie.mkv`,
      title: `Candidate ${index + 1}`
    }));
    streams.splice(2, 0, streams[0]!);
    expect(selectFallbackCandidates(streams)).toHaveLength(10);
    expect(selectFallbackCandidates(streams).map(candidate => candidate.label))
      .toEqual(Array.from({ length: 10 }, (_, index) => `Candidate ${index + 1}`));
  });

  it('retains smaller 4K and 1080p options beyond the top-ranked results', () => {
    const streams = [
      ...Array.from({ length: 10 }, (_, index) => ({
        url: `https://remux${index}.example/movie.mkv`,
        title: `2160p remux ${index}`,
        behaviorHints: { videoSize: 100_000_000_000 + index }
      })),
      {
        url: 'https://small4k.example/movie.mkv', title: '2160p WEB-DL',
        behaviorHints: { videoSize: 6_000_000_000 }
      },
      {
        url: 'https://small1080.example/movie.mkv', title: '1080p WEB-DL',
        behaviorHints: { videoSize: 3_000_000_000 }
      }
    ];
    const selected = selectFallbackCandidates(streams);
    expect(selected).toHaveLength(10);
    expect(selected.map(candidate => candidate.url)).toContain(
      'https://small4k.example/movie.mkv'
    );
    expect(selected.map(candidate => candidate.url)).toContain(
      'https://small1080.example/movie.mkv'
    );
  });

  it('uses structured AIO metadata to prefer the highest sustainable quality', () => {
    const selected = selectFallbackCandidates([
      {
        url: 'https://huge.example/movie.mkv', title: '4K remux',
        behaviorHints: { videoSize: 100_000_000_000 },
        streamData: { duration: 10_800_000, bitrate: 74_000_000,
          parsedFile: { resolution: '2160p', quality: 'BluRay REMUX' } }
      },
      {
        url: 'https://small4k.example/movie.mkv', title: 'WEB-DL',
        streamData: { duration: 10_800_000, bitrate: 18_000_000,
          parsedFile: { resolution: '2160p', quality: 'WEB-DL' } }
      },
      {
        url: 'https://hd.example/movie.mkv', title: 'WEB-DL',
        streamData: { duration: 10_800_000, bitrate: 8_000_000,
          parsedFile: { resolution: '1080p', quality: 'WEB-DL' } }
      }
    ], null, {
      limit: 3,
      networkEstimateMbps: 30,
      networkHeadroomFactor: 1.35,
      allowResolutionDowngrade: true
    });
    expect(selected[0]).toMatchObject({
      url: 'https://small4k.example/movie.mkv',
      resolutionHeight: 2160,
      bitrateMbps: 18
    });
  });

  it('calculates average bitrate and requires network headroom', () => {
    expect(requiredAverageBitrateMbps(100_000_000_000, 10_800))
      .toBeCloseTo(74.07, 2);
    expect(hasNetworkHeadroom(80, 74.07)).toBe(false);
    expect(hasNetworkHeadroom(110, 74.07)).toBe(true);
  });

  it('uses current network evidence without turning it into a permanent direct-play ban', () => {
    const service = new FallbackAddonService(settings({
      fallbackAddonBeforeTranscode: true,
      fallbackAddonNetworkAdaptation: true,
      fallbackAddonNetworkHeadroomPercent: 35
    }), { info: vi.fn(), warn: vi.fn() }, { cleanupIntervalMs: 0 });
    const file = {
      size: 20_000_000_000,
      duration_seconds: 7200,
      bitrate: 22_000_000
    } as MediaFileRow;
    expect(service.shouldTryForLocal(file, false, null)).toBe(false);
    expect(service.shouldTryForLocal(file, false, 20)).toBe(true);
    expect(service.shouldTryForLocal(file, false, 40)).toBe(false);
    service.close();
  });

  it('coalesces lookups and reuses a session without exposing the candidate URL', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      streams: [{
        url: 'https://cdn.example/movie.mkv?token=secret',
        title: 'Cached 2160p BluRay'
      }]
    }), { status: 200 }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new FallbackAddonService(
      settings(), logger, { fetch: fetcher, cleanupIntervalMs: 0 }
    );
    const [first, concurrent] = await Promise.all([
      service.tryPlayback(input),
      service.tryPlayback(input)
    ]);
    const reused = await service.tryPlayback(input);
    const otherNetwork = await service.tryPlayback({
      ...input,
      networkContextId: 'network_other'
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('user-agent'))
      .toBe('AIOStreams/Nuvi-Flow/1.1.1');
    expect(first?.id).toBe(concurrent?.id);
    expect(reused?.id).toBe(first?.id);
    expect(otherNetwork?.id).not.toBe(first?.id);
    expect(logger.info).toHaveBeenCalledWith(
      expect.not.objectContaining({ upstreamUrl: expect.anything() }),
      'Fallback addon playback selected'
    );
    service.close();
  });

  it('rejects an unsafe redirect returned while proxying', async () => {
    const fetcher = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://127.0.0.1/private' }
    }));
    const service = new FallbackAddonService(
      settings(), { info: vi.fn(), warn: vi.fn() },
      {
        fetch: fetcher,
        lookup: async () => ['8.8.8.8'],
        cleanupIntervalMs: 0
      }
    );
    await expect(service.fetchMedia({
      id: '11111111-1111-4111-8111-111111111111',
      playbackId: 'playback',
      upstreamUrl: 'https://cdn.example/movie.mkv',
      requestHeaders: {}, label: 'movie', createdAt: 0, lastAccess: 0,
      candidates: [{
        url: 'https://cdn.example/movie.mkv', label: 'movie', requestHeaders: {},
        videoSizeBytes: null, resolutionHeight: null
      }],
      candidateIndex: 0,
      candidateVerified: false,
      durationSeconds: null,
      expiresAt: 10, maximumExpiresAt: 10
    }, {})).rejects.toThrow('Fallback candidates exhausted');
    service.close();
  });

  it('rejects a public-looking hostname that resolves to a private address', async () => {
    const fetcher = vi.fn();
    const service = new FallbackAddonService(
      settings(), { info: vi.fn(), warn: vi.fn() }, {
        fetch: fetcher,
        lookup: async () => ['192.168.1.20'],
        cleanupIntervalMs: 0
      }
    );
    await expect(service.fetchMedia({
      id: '11111111-1111-4111-8111-111111111111',
      playbackId: 'playback', upstreamUrl: 'https://cdn.example/movie.mkv',
      requestHeaders: {}, label: 'movie', createdAt: 0, lastAccess: 0,
      candidates: [{
        url: 'https://cdn.example/movie.mkv', label: 'movie', requestHeaders: {},
        videoSizeBytes: null, resolutionHeight: null
      }],
      candidateIndex: 0,
      candidateVerified: false,
      durationSeconds: null,
      expiresAt: 10, maximumExpiresAt: 10
    }, {})).rejects.toThrow('Fallback candidates exhausted');
    expect(fetcher).not.toHaveBeenCalled();
    service.close();
  });

  it('rotates through failed candidates and keeps the first working one sticky', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes('first.example')
        ? new Response('gone', { status: 404 })
        : new Response('ok', { status: 206, headers: { 'Content-Type': 'video/mp4' } }));
    const service = new FallbackAddonService(
      settings(), { info: vi.fn(), warn: vi.fn() }, {
        fetch: fetcher,
        lookup: async () => ['8.8.8.8'],
        cleanupIntervalMs: 0
      }
    );
    const session = {
      id: '11111111-1111-4111-8111-111111111111',
      playbackId: 'playback', upstreamUrl: 'https://first.example/movie.mkv',
      requestHeaders: {}, label: 'first', createdAt: 0, lastAccess: 0,
      expiresAt: 10, maximumExpiresAt: 10,
      candidateIndex: 0,
      candidateVerified: false,
      durationSeconds: null,
      candidates: [
        { url: 'https://first.example/movie.mkv', label: 'first', requestHeaders: {}, videoSizeBytes: null, resolutionHeight: null },
        { url: 'https://second.example/movie.mkv', label: 'second', requestHeaders: {}, videoSizeBytes: null, resolutionHeight: null }
      ]
    };
    expect((await service.fetchMedia(session, {})).status).toBe(206);
    expect(session.candidateIndex).toBe(1);
    expect((await service.fetchMedia(session, {})).status).toBe(206);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      'https://first.example/movie.mkv',
      'https://second.example/movie.mkv',
      'https://second.example/movie.mkv'
    ]);
    service.close();
  });

  it('rejects an unsustainable large stream and preserves the probe bytes of a smaller one', async () => {
    const mediaBody = () => {
      let chunks = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 60));
          if (chunks >= 4) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(256 * 1024));
          chunks += 1;
        }
      });
    };
    const fetcher = vi.fn(async () => new Response(mediaBody(), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(1024 * 1024)
      }
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new FallbackAddonService(
      settings(), logger, {
        fetch: fetcher,
        lookup: async () => ['8.8.8.8'],
        cleanupIntervalMs: 0
      }
    );
    const session = {
      id: '11111111-1111-4111-8111-111111111111',
      playbackId: 'playback', upstreamUrl: 'https://large.example/movie.mkv',
      requestHeaders: {}, label: 'large', createdAt: 0, lastAccess: 0,
      expiresAt: Date.now() + 60_000, maximumExpiresAt: Date.now() + 60_000,
      candidateIndex: 0, candidateVerified: false, durationSeconds: 10_800,
      candidates: [
        {
          url: 'https://large.example/movie.mkv', label: 'large', requestHeaders: {},
          videoSizeBytes: 100_000_000_000, resolutionHeight: 2160
        },
        {
          url: 'https://small.example/movie.mkv', label: 'small', requestHeaders: {},
          videoSizeBytes: 6_000_000_000, resolutionHeight: 2160
        }
      ]
    };
    const response = await service.fetchMedia(session, { method: 'GET' });
    expect(session.candidateIndex).toBe(1);
    expect(session.candidateVerified).toBe(true);
    expect((await response.arrayBuffer()).byteLength).toBe(1024 * 1024);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'insufficient_throughput' }),
      'Fallback addon candidate failed'
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ candidate_attempt: 2 }),
      'Fallback addon candidate passed network probe'
    );
    service.close();
  });

  it('uses a response Content-Range total when addon size metadata is absent', async () => {
    let chunks = 0;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 60));
        if (chunks >= 2) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(256 * 1024));
        chunks += 1;
      }
    }), {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(512 * 1024),
        'Content-Range': 'bytes 0-524287/100000000000'
      }
    }));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new FallbackAddonService(settings(), logger, {
      fetch: fetcher,
      lookup: async () => ['8.8.8.8'],
      cleanupIntervalMs: 0
    });
    const session = {
      id: '11111111-1111-4111-8111-111111111111',
      playbackId: 'playback', upstreamUrl: 'https://large.example/movie.mkv',
      requestHeaders: {}, label: 'large', createdAt: 0, lastAccess: 0,
      expiresAt: Date.now() + 60_000, maximumExpiresAt: Date.now() + 60_000,
      candidateIndex: 0, candidateVerified: false, durationSeconds: 10_800,
      candidates: [{
        url: 'https://large.example/movie.mkv', label: 'large', requestHeaders: {},
        videoSizeBytes: null, resolutionHeight: 2160
      }]
    };
    await expect(service.fetchMedia(session, { method: 'GET' }))
      .rejects.toThrow('Fallback candidates exhausted');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'insufficient_throughput' }),
      'Fallback addon candidate failed'
    );
    service.close();
  });
});
