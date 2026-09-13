import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  PlaybackSessionRetiredError,
  PlaybackSessionRegistry,
  type PlaybackKeyParts,
  type PlaybackSessionStart
} from '../src/services/playback/playback-sessions.js';
import { deriveDeviceIdentity } from '../src/services/playback/device-identity.js';
import { planSiloPlayback } from '../src/services/playback/playback-policy.js';

const baseKey: PlaybackKeyParts = {
  deviceId: 'device-a',
  mediaFileId: 'file-a',
  profileId: 'profile-a',
  mode: 'fixed-silo-hls',
  quality: '1080p-medium',
  audioSelection: 'default',
  subtitleSelection: 'none',
  dynamicRangeMode: 'sdr'
};

const started: PlaybackSessionStart = {
  siloSessionId: 'silo-session-a',
  siloFileId: 120,
  upstreamPath:
    '/api/v1/playback/transcode/silo-session-a/master.m3u8',
  delivery: 'server_transcode_hls'
};

describe('PlaybackSessionRegistry', () => {
  it('derives a stable client-hint identity without retaining raw request data', () => {
    const input = {
      installationId: 'installation-a',
      ip: '192.0.2.10',
      userAgent: 'Nuvio Test Client',
      clientName: 'Nuvio',
      clientVersion: '1.2.3',
      requestScope: 'request-a'
    };

    const first = deriveDeviceIdentity(input);
    const second = deriveDeviceIdentity(input);
    const different = deriveDeviceIdentity({
      ...input,
      userAgent: 'Different Client'
    });

    expect(first).toStrictEqual(second);
    expect(first).toMatchObject({
      id: expect.stringMatching(/^device_[a-f0-9]{24}$/),
      source: 'client_hints'
    });
    expect(different.id).not.toBe(first.id);
    expect(first.id).not.toContain(input.ip);
    expect(first.id).not.toContain(input.userAgent);
  });

  it('keeps explicit identity stable across changing network and client hints', () => {
    const first = deriveDeviceIdentity({
      installationId: 'installation-a',
      explicitDeviceId: 'nuvio-device-a',
      ip: '192.0.2.10',
      userAgent: 'Nuvio Android'
    });
    const second = deriveDeviceIdentity({
      installationId: 'installation-a',
      explicitDeviceId: 'nuvio-device-a',
      ip: '198.51.100.20',
      userAgent: 'Nuvio TV'
    });
    const otherDevice = deriveDeviceIdentity({
      installationId: 'installation-a',
      explicitDeviceId: 'nuvio-device-b'
    });

    expect(first.source).toBe('explicit');
    expect(first.id).toBe(second.id);
    expect(otherDevice.id).not.toBe(first.id);
  });

  it('separates request-scope fallbacks when no client hints exist', () => {
    const sharedRequest = {
      installationId: 'installation-a',
      ip: '172.19.0.10'
    };

    const first = deriveDeviceIdentity({
      ...sharedRequest,
      requestScope: 'request-a'
    });
    const second = deriveDeviceIdentity({
      ...sharedRequest,
      requestScope: 'request-b'
    });

    expect(first.source).toBe('request_scope');
    expect(first.id).not.toBe(second.id);
  });

  it('coalesces concurrent creation and reuses the active session', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const create = vi.fn(async () => {
      await gate;
      return started;
    });
    const registry = new PlaybackSessionRegistry({
      cleanupIntervalMs: 0
    });
    const expiresAt = Date.now() + 60_000;

    const first = registry.getOrCreate(
      baseKey,
      expiresAt,
      create
    );
    const second = registry.getOrCreate(
      baseKey,
      expiresAt,
      create
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(registry.counts()).toEqual({
      pending: 1,
      active: 0
    });

    release();

    const [firstResult, secondResult] =
      await Promise.all([first, second]);

    expect(firstResult.source).toBe('created');
    expect(secondResult.source).toBe('coalesced');
    expect(firstResult.session).toBe(
      secondResult.session
    );
    expect(firstResult.session.playbackId).toEqual(
      expect.any(String)
    );
    expect(registry.counts()).toEqual({
      pending: 0,
      active: 1
    });

    const reused = await registry.getOrCreate(
      baseKey,
      expiresAt,
      create
    );

    expect(reused.source).toBe('reused');
    expect(reused.session).toBe(firstResult.session);
    expect(create).toHaveBeenCalledTimes(1);
    await registry.close();
  });

  it('removes expired sessions and creates a replacement', async () => {
    let now = 1_000;
    const create = vi.fn(async () => started);
    const registry = new PlaybackSessionRegistry({
      sessionTtlMs: 100,
      cleanupIntervalMs: 0,
      now: () => now
    });
    const retired = vi.fn(async () => {});
    registry.setRetirementHandler(retired);

    const first = await registry.getOrCreate(
      baseKey,
      10_000,
      create
    );

    now = 1_101;
    expect(await registry.cleanupExpired()).toBe(1);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ siloSessionId: 'silo-session-a' }),
      'expired'
    );

    const replacement =
      await registry.getOrCreate(
        baseKey,
        10_000,
        create
      );

    expect(replacement.session.playbackId).not.toBe(
      first.session.playbackId
    );
    expect(create).toHaveBeenCalledTimes(2);
    await registry.close();
  });

  it('clears a rejected pending creation so it can be retried', async () => {
    const create = vi
      .fn<() => Promise<PlaybackSessionStart>>()
      .mockRejectedValueOnce(new Error('start failed'))
      .mockResolvedValueOnce(started);
    const registry = new PlaybackSessionRegistry({
      cleanupIntervalMs: 0
    });
    const expiresAt = Date.now() + 60_000;

    await expect(
      registry.getOrCreate(
        baseKey,
        expiresAt,
        create
      )
    ).rejects.toThrow('start failed');

    expect(registry.counts()).toEqual({
      pending: 0,
      active: 0
    });

    await expect(
      registry.getOrCreate(
        baseKey,
        expiresAt,
        create
      )
    ).resolves.toMatchObject({
      source: 'created',
      session: {
        siloSessionId: 'silo-session-a'
      }
    });
    expect(create).toHaveBeenCalledTimes(2);
    await registry.close();
  });

  it.each([
    ['device', { deviceId: 'device-b' }],
    ['file', { mediaFileId: 'file-b' }],
    ['profile', { profileId: 'profile-b' }],
    ['quality', { quality: '2160p-medium' }],
    ['audio', { audioSelection: 'track-2' }],
    ['subtitle', { subtitleSelection: 'pgs-1' }],
    ['dynamic range', { dynamicRangeMode: 'hdr' }],
    ['capability revision', { capabilityRevision: 'new-revision' }],
    ['episode', { season: 1, episode: 2 }]
  ])('does not share sessions across a different %s key', async (_name, change) => {
    const create = vi.fn(async () => started);
    const registry = new PlaybackSessionRegistry({
      cleanupIntervalMs: 0
    });
    const expiresAt = Date.now() + 60_000;

    await registry.getOrCreate(
      baseKey,
      expiresAt,
      create
    );
    await registry.getOrCreate(
      { ...baseKey, ...change },
      expiresAt,
      create
    );

    expect(create).toHaveBeenCalledTimes(2);
    await registry.close();
  });

  it('extends a bounded lease when proxied media from the session is requested', async () => {
    let now = 1_000;
    const registry = new PlaybackSessionRegistry({
      sessionTtlMs: 100,
      cleanupIntervalMs: 0,
      now: () => now
    });
    await registry.getOrCreate(baseKey, 10_000, async () => started);

    now = 1_050;
    expect(registry.touchUpstreamPath(
      '/api/v1/playback/transcode/silo-session-a/segment/seg_00001.ts'
    )).toBe(true);
    now = 1_101;
    expect(await registry.cleanupExpired()).toBe(0);
    expect(await registry.activeSnapshot()).toHaveLength(1);
    now = 1_151;
    expect(await registry.cleanupExpired()).toBe(1);
    await registry.close();
  });

  it('tracks direct and progressive Silo stream paths by session', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    await registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo', quality: 'auto' },
      Date.now() + 60_000,
      async () => ({
        ...started,
        upstreamPath: '/api/v1/stream/direct-session',
        delivery: 'original_http'
      })
    );

    expect(registry.touchUpstreamPath(
      '/api/v1/stream/direct-session?seek=42'
    )).toBe(true);
    expect(registry.touchUpstreamPath(
      '/api/v1/stream/another-session'
    )).toBe(false);
    await registry.close();
  });

  it('summarizes repeated slow segment delivery without logging every request', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    await registry.getOrCreate(
      baseKey,
      Date.now() + 60_000,
      async () => started
    );
    const segment =
      '/api/v1/playback/transcode/silo-session-a/segment/seg_00001.ts';

    expect(registry.recordUpstreamResponse(segment, 2_100, 200))
      .toMatchObject({ slow: true, slowResponseCount: 1, summaryDue: false });
    expect(registry.recordUpstreamResponse(segment, 2_200, 200))
      .toMatchObject({ slow: true, slowResponseCount: 2, summaryDue: false });
    expect(registry.recordUpstreamResponse(segment, 2_300, 200))
      .toMatchObject({ slow: true, slowResponseCount: 3, summaryDue: true });
    expect((await registry.activeSnapshot())[0]).toMatchObject({
      mediaRequestCount: 3,
      slowMediaResponseCount: 3,
      lastMediaResponseMs: 2_300,
      lastMediaStatus: 200
    });
    await registry.close();
  });

  it('claims only one runtime fallback and routes old manifest tokens to it', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const requestProfile = planSiloPlayback(
      { width: 3840, height: 2160 },
      'auto',
      'device-a'
    ).requestProfile;
    const result = await registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo', quality: 'auto' },
      Date.now() + 60_000,
      async () => ({
        ...started,
        runtimeFallback: {
          profileId: 'profile-a',
          playbackAttemptId: 'attempt-a',
          plan: {
            plan_id: 'plan-a',
            plan_attempt_key: 'attempt-key-a',
            delivery: 'server_transcode_hls',
            stream: {
              url: '/playback/transcode/silo-session-a/master.m3u8',
              protocol: 'hls', headers: {}, header_refresh: 'none'
            }
          },
          requestProfile,
          targetQuality: '1080p-high',
          state: 'ready',
          reason: null
        }
      })
    );
    const segment =
      '/api/v1/playback/transcode/silo-session-a/segment/seg_00001.ts';
    registry.recordSegmentTimeline([{ path: segment, positionSeconds: 42 }]);
    registry.recordUpstreamResponse(segment, 2600, 200, {
      slowSegmentMs: 2500, slowSegmentCount: 2
    });
    const due = registry.recordUpstreamResponse(segment, 2700, 200, {
      slowSegmentMs: 2500, slowSegmentCount: 2
    });
    expect(due).toMatchObject({
      fallbackDue: true,
      fallbackReason: 'slow_segments'
    });
    const claimed = registry.claimRuntimeFallback(
      result.session.playbackKey,
      'slow_segments'
    );
    expect(claimed).toMatchObject({ lastPositionSeconds: 42 });
    expect(registry.claimRuntimeFallback(
      result.session.playbackKey,
      'slow_segments'
    )).toBeNull();

    registry.completeRuntimeFallback(result.session.playbackKey, {
      plan: {
        delivery: 'server_transcode_hls',
        stream: {
          url: '/playback/transcode/silo-session-b/master.m3u8',
          protocol: 'hls', headers: {}, header_refresh: 'none'
        }
      },
      upstreamPath: '/api/v1/playback/transcode/silo-session-b/master.m3u8',
      delivery: 'server_transcode_hls',
      siloSessionId: 'silo-session-b'
    });
    expect(registry.resolveUpstreamPath(started.upstreamPath)).toBe(
      '/api/v1/playback/transcode/silo-session-b/master.m3u8'
    );
    expect(registry.resolveUpstreamPath(segment)).toBe(
      '/api/v1/playback/transcode/silo-session-b/segment/seg_00001.ts'
    );
    await registry.close();
  });

  it('requires repeated retryable status failures and ignores authorization errors', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const requestProfile = planSiloPlayback(
      { width: 1920, height: 1080 }, 'auto', 'device-a'
    ).requestProfile;
    const result = await registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo', quality: 'auto' },
      Date.now() + 60_000,
      async () => ({
        ...started,
        runtimeFallback: {
          profileId: 'profile-a', playbackAttemptId: 'attempt-a',
          plan: {
            delivery: 'server_transcode_hls',
            stream: {
              url: '/playback/transcode/silo-session-a/master.m3u8',
              protocol: 'hls', headers: {}, header_refresh: 'none'
            }
          },
          requestProfile, targetQuality: '1080p-medium',
          state: 'ready', reason: null
        }
      })
    );
    const segment =
      '/api/v1/playback/transcode/silo-session-a/segment/seg_00002.ts';
    expect(registry.recordUpstreamResponse(segment, 10, 401))
      .toMatchObject({ fallbackDue: false });
    expect(registry.recordUpstreamResponse(segment, 10, 404))
      .toMatchObject({ fallbackDue: false });
    expect(registry.recordUpstreamResponse(segment, 10, 503))
      .toMatchObject({
        fallbackDue: true,
        fallbackReason: 'status_failures',
        playbackKey: result.session.playbackKey
      });
    await registry.close();
  });

  it('retires only matching active sessions and does so once', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const retired = vi.fn(async () => {});
    registry.setRetirementHandler(retired);
    const expiresAt = Date.now() + 60_000;

    await registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo' },
      expiresAt,
      async () => started
    );
    await registry.getOrCreate(
      { ...baseKey, deviceId: 'device-b', mode: 'auto-silo' },
      expiresAt,
      async () => ({ ...started, siloSessionId: 'silo-session-b' })
    );

    const match = {
      deviceId: baseKey.deviceId,
      mediaFileId: baseKey.mediaFileId,
      profileId: baseKey.profileId,
      mode: 'auto-silo'
    };
    expect(await registry.retireMatching(match, 'fallback_selected')).toBe(1);
    expect(await registry.retireMatching(match, 'fallback_selected')).toBe(0);
    expect(retired).toHaveBeenCalledOnce();
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ siloSessionId: 'silo-session-a' }),
      'fallback_selected'
    );
    expect(await registry.activeSnapshot()).toHaveLength(1);
    await registry.close();
  });

  it('fences a pending Silo start when another route is selected', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const retired = vi.fn(async () => {});
    registry.setRetirementHandler(retired);
    const creation = registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo' },
      Date.now() + 60_000,
      async () => {
        await gate;
        return started;
      }
    );

    expect(await registry.retireMatching({
      deviceId: baseKey.deviceId,
      mediaFileId: baseKey.mediaFileId,
      profileId: baseKey.profileId,
      mode: 'auto-silo'
    }, 'fallback_selected')).toBe(0);
    release();

    await expect(creation).rejects.toBeInstanceOf(PlaybackSessionRetiredError);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ siloSessionId: 'silo-session-a' }),
      'fallback_selected'
    );
    expect(registry.counts()).toEqual({ pending: 0, active: 0 });
    await registry.close();
  });

  it('waits for pending starts and retires them during shutdown', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const retired = vi.fn(async () => {});
    registry.setRetirementHandler(retired);
    const creation = registry.getOrCreate(
      { ...baseKey, mode: 'auto-silo' },
      Date.now() + 60_000,
      async () => {
        await gate;
        return started;
      }
    );
    const closing = registry.close();
    release();

    await closing;
    await expect(creation).rejects.toBeInstanceOf(PlaybackSessionRetiredError);
    expect(retired).toHaveBeenCalledWith(
      expect.objectContaining({ siloSessionId: 'silo-session-a' }),
      'shutdown'
    );
    expect(registry.counts()).toEqual({ pending: 0, active: 0 });
  });
});
