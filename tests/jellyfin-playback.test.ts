import { describe, expect, it, vi } from 'vitest';
import type { MediaFileRow, MediaItemRow } from '../src/types.js';
import type { SettingsService } from '../src/services/settings.js';
import type { PlaybackServersService } from '../src/services/playback-servers.js';
import type {
  DeviceCapabilitySnapshot,
  DeviceCapabilityStore
} from '../src/services/playback/device-capabilities.js';
import {
  buildJellyfinDeviceProfile,
  JellyfinPlaybackError,
  JellyfinPlaybackService
} from '../src/services/playback/jellyfin-playback.js';

const file = {
  id: 'file-1',
  library_type: 'movie',
  absolute_path: '/media/Movie.mkv',
  relative_path: 'Movie.mkv',
  size: 20_000_000_000,
  bitrate: 80_000_000,
  video_codec: 'hevc',
  audio_codec: 'truehd',
  width: 3840,
  height: 2160,
  quality: '2160p',
  media_item_id: 'local-item-1'
} as MediaFileRow;

const item = {
  id: 'local-item-1',
  type: 'movie',
  stremio_id: 'tt1234567',
  title: 'Movie'
} as MediaItemRow;

function snapshot(
  denied: Array<[string, string]> = [],
  revision = 'capabilities-v1'
): DeviceCapabilitySnapshot {
  return {
    deviceId: 'device_1234567890abcdef12345678',
    revision,
    capabilities: denied.map(([category, capability]) => ({
      category,
      capability,
      state: 'unsupported'
    }))
  } as DeviceCapabilitySnapshot;
}

function harness(options: {
  decision?: Record<string, unknown>;
  capabilitySnapshot?: DeviceCapabilitySnapshot;
  now?: () => number;
  idleMs?: number;
  fetchResponse?: () => Response;
} = {}) {
  const settings = {
    jellyfinEnabled: true,
    jellyfinUrl: 'http://jellyfin:8096',
    jellyfinApiKey: 'private-jellyfin-key',
    jellyfinUserId: 'user-1'
  } as SettingsService;
  const resolveMapping = vi.fn().mockResolvedValue({
    media_file_id: file.id,
    provider: 'jellyfin',
    server_key: 'jellyfin:server-hash',
    provider_item_id: 'item-1',
    provider_media_id: 'source-1',
    provider_stream_path: null,
    status: 'mapped',
    reason: null,
    mapped_path: file.absolute_path,
    updated_at: 1
  });
  const playbackServers = { resolveMapping } as unknown as PlaybackServersService;
  const capabilitySnapshot = options.capabilitySnapshot ?? snapshot();
  const touchDevice = vi.fn();
  const capabilities = {
    touchDevice,
    getSnapshot: vi.fn(() => capabilitySnapshot)
  } as unknown as DeviceCapabilityStore;
  const playbackInfo = vi.fn().mockResolvedValue(options.decision ?? {
    PlaySessionId: 'play-session-1',
    MediaSources: [{
      Id: 'source-1',
      SupportsDirectPlay: true,
      SupportsDirectStream: true,
      SupportsTranscoding: true,
      TranscodingUrl: '/Videos/item-1/master.m3u8?api_key=must-not-leak'
    }]
  });
  const fetchMedia = vi.fn().mockImplementation(async () =>
    options.fetchResponse?.() ?? new Response('media', {
      status: 206,
      headers: {
        'content-type': 'video/mp4',
        'content-range': 'bytes 0-4/5'
      }
    })
  );
  const reportPlaybackStart = vi.fn().mockResolvedValue(undefined);
  const stopPlayback = vi.fn().mockResolvedValue(undefined);
  const client = {
    origin: 'http://jellyfin:8096',
    playbackInfo,
    fetchMedia,
    reportPlaybackStart,
    stopPlayback
  };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const service = new JellyfinPlaybackService(
    settings,
    playbackServers,
    capabilities,
    logger,
    {
      now: options.now,
      idleMs: options.idleMs,
      cleanupIntervalMs: 0,
      clientFactory: () => client
    }
  );
  const input = {
    item,
    file,
    deviceId: 'device_1234567890abcdef12345678',
    deviceIdentitySource: 'explicit',
    authorizationExpiresAt: (options.now?.() ?? Date.now()) + 60_000
  };
  return {
    service,
    input,
    settings,
    resolveMapping,
    touchDevice,
    playbackInfo,
    fetchMedia,
    reportPlaybackStart,
    stopPlayback,
    capabilitySnapshot
  };
}

describe('JellyfinPlaybackService', () => {
  it('keeps a viable 4K exact source ahead of bounded conversion targets', () => {
    const profile = buildJellyfinDeviceProfile(file, snapshot());

    expect(profile.MaxStreamingBitrate).toBe(108_000_000);
    expect(profile.DirectPlayProfiles).toContainEqual({
      Container: 'mkv',
      Type: 'Video',
      VideoCodec: 'hevc',
      AudioCodec: 'truehd'
    });
    expect(profile.TranscodingProfiles[0]).toMatchObject({
      VideoCodec: 'hevc,h264',
      AudioCodec: 'truehd,aac'
    });
  });

  it('removes direct play and video copy after explicit 4K denial', async () => {
    const denied = snapshot([['max_resolution', '2160p']], 'denied-4k');
    const profile = buildJellyfinDeviceProfile(file, denied);
    expect(profile.DirectPlayProfiles).toEqual([]);
    expect(profile.MaxStreamingBitrate).toBe(20_000_000);

    const test = harness({ capabilitySnapshot: denied });
    await test.service.start(test.input);
    expect(test.playbackInfo).toHaveBeenCalledWith('item-1',
      expect.objectContaining({
        allowVideoStreamCopy: false,
        allowAudioStreamCopy: true,
        deviceProfile: expect.objectContaining({
          MaxStreamingBitrate: 20_000_000
        })
      }));
    await test.service.close();
  });

  it('coalesces negotiation, selects exact direct play, and proxies by opaque resource', async () => {
    const test = harness();
    const [first, second] = await Promise.all([
      test.service.start(test.input),
      test.service.start(test.input)
    ]);

    expect(test.playbackInfo).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.route).toBe('original_http');
    expect(first.sessionId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.resourceId).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(first)).not.toContain('jellyfin:8096');
    expect(test.touchDevice).toHaveBeenCalledWith(
      test.input.deviceId,
      'explicit'
    );

    const range = new Headers({ range: 'bytes=0-4' });
    const fetched = await test.service.fetchMedia(
      first.sessionId,
      first.resourceId,
      { method: 'GET', headers: range }
    );
    const [url, deviceId, init] = test.fetchMedia.mock.calls[0]!;
    expect(url).toBeInstanceOf(URL);
    expect((url as URL).pathname).toBe('/Videos/item-1/stream');
    expect((url as URL).searchParams.get('MediaSourceId')).toBe('source-1');
    expect((url as URL).search).not.toContain('api_key');
    expect(deviceId).toBe(test.input.deviceId);
    expect(new Headers((init as RequestInit).headers).get('range')).toBe('bytes=0-4');
    expect(fetched.response.status).toBe(206);
    fetched.release();
    await test.service.stopPlayback(first.playbackId);
    expect(test.reportPlaybackStart).toHaveBeenCalledOnce();
    expect(test.stopPlayback).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'item-1',
      mediaSourceId: 'source-1',
      playSessionId: 'play-session-1',
      playMethod: 'DirectPlay',
      transcoding: false
    }));
  });

  it.each([
    [
      'server_remux_hls',
      '/Videos/item-1/master.m3u8?VideoCodec=hevc&AudioCodec=truehd&AllowVideoStreamCopy=true&AllowAudioStreamCopy=true'
    ],
    [
      'server_audio_transcode_hls',
      '/Videos/item-1/master.m3u8?VideoCodec=hevc&AudioCodec=aac&TranscodeReasons=AudioCodecNotSupported'
    ],
    [
      'server_transcode_hls',
      '/Videos/item-1/master.m3u8?VideoCodec=h264&AudioCodec=aac&TranscodeReasons=VideoCodecNotSupported'
    ],
    [
      'server_remux_progressive',
      '/Videos/item-1/stream.mp4?VideoCodec=hevc&AudioCodec=truehd'
    ]
  ])('classifies %s without overriding the server decision', async (
    expectedRoute,
    transcodingUrl
  ) => {
    const test = harness({
      decision: {
        PlaySessionId: 'play-session-1',
        MediaSources: [{
          Id: 'source-1',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          SupportsTranscoding: true,
          TranscodingSubProtocol: transcodingUrl.endsWith('m3u8') ? 'hls' : 'http',
          TranscodingUrl: transcodingUrl
        }]
      }
    });
    await expect(test.service.start(test.input)).resolves.toMatchObject({
      route: expectedRoute
    });
    await test.service.close();
  });

  it('rejects off-origin and wrong-item playback resources', async () => {
    const offOrigin = harness({
      decision: {
        PlaySessionId: 'play-session-1',
        MediaSources: [{
          Id: 'source-1',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          TranscodingUrl: 'https://attacker.example/Videos/item-1/master.m3u8'
        }]
      }
    });
    await expect(offOrigin.service.start(offOrigin.input)).rejects
      .toBeInstanceOf(JellyfinPlaybackError);

    const wrongItem = harness({
      decision: {
        PlaySessionId: 'play-session-1',
        MediaSources: [{
          Id: 'source-1',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          TranscodingUrl: '/Videos/item-2/master.m3u8'
        }]
      }
    });
    await expect(wrongItem.service.start(wrongItem.input)).rejects
      .toBeInstanceOf(JellyfinPlaybackError);
  });

  it('registers only exact-item HLS children and strips query credentials', async () => {
    const test = harness({
      decision: {
        PlaySessionId: 'play-session-1',
        MediaSources: [{
          Id: 'source-1',
          SupportsDirectPlay: false,
          SupportsDirectStream: true,
          TranscodingUrl: '/Videos/item-1/hls1/main/master.m3u8?api_key=root-secret'
        }]
      }
    });
    const started = await test.service.start(test.input);
    const child = test.service.registerChildResource(
      started.sessionId,
      started.resourceId,
      '../0.ts?api_key=child-secret&part=1',
      started.expiresAt
    );
    const fetched = await test.service.fetchMedia(
      started.sessionId,
      child.resourceId,
      { method: 'GET', headers: new Headers() }
    );
    const childUrl = test.fetchMedia.mock.calls[0]![0] as URL;
    expect(childUrl.pathname).toBe('/Videos/item-1/hls1/0.ts');
    expect(childUrl.searchParams.get('part')).toBe('1');
    expect(childUrl.search).not.toContain('secret');
    fetched.release();

    expect(() => test.service.registerChildResource(
      started.sessionId,
      started.resourceId,
      'https://attacker.example/Videos/item-1/0.ts',
      started.expiresAt
    )).toThrow(JellyfinPlaybackError);
    expect(() => test.service.registerChildResource(
      started.sessionId,
      started.resourceId,
      '/Videos/item-2/0.ts',
      started.expiresAt
    )).toThrow(JellyfinPlaybackError);
    await test.service.close();
  });

  it('retires an idle fetched session and stops the exact upstream session', async () => {
    let now = 1_000;
    const test = harness({ now: () => now, idleMs: 1_000 });
    test.input.authorizationExpiresAt = 10_000;
    const started = await test.service.start(test.input);
    const fetched = await test.service.fetchMedia(
      started.sessionId,
      started.resourceId,
      { method: 'GET', headers: new Headers() }
    );
    fetched.release();
    now = 2_001;

    expect(await test.service.activeSnapshot()).toEqual([]);
    expect(test.stopPlayback).toHaveBeenCalledOnce();
  });
});
