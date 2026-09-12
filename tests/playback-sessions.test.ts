import {
  describe,
  expect,
  it,
  vi
} from 'vitest';

import {
  PlaybackSessionRegistry,
  type PlaybackKeyParts,
  type PlaybackSessionStart
} from '../src/services/playback/playback-sessions.js';
import { deriveDeviceIdentity } from '../src/services/playback/device-identity.js';

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
    registry.close();
  });

  it('removes expired sessions and creates a replacement', async () => {
    let now = 1_000;
    const create = vi.fn(async () => started);
    const registry = new PlaybackSessionRegistry({
      sessionTtlMs: 100,
      cleanupIntervalMs: 0,
      now: () => now
    });

    const first = await registry.getOrCreate(
      baseKey,
      10_000,
      create
    );

    now = 1_101;
    expect(registry.cleanupExpired()).toBe(1);

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
    registry.close();
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
    registry.close();
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
    registry.close();
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
    expect(registry.cleanupExpired()).toBe(0);
    expect(registry.activeSnapshot()).toHaveLength(1);
    now = 1_151;
    expect(registry.cleanupExpired()).toBe(1);
    registry.close();
  });
});
