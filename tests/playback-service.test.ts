import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { DeviceCapabilityStore } from '../src/services/playback/device-capabilities.js';
import { PlaybackService } from '../src/services/playback/playback-service.js';
import { PlaybackSessionRegistry } from '../src/services/playback/playback-sessions.js';
import type { SiloService } from '../src/services/silo-service.js';
import type { MediaFileRow, MediaItemRow } from '../src/types.js';

describe('playback orchestration', () => {
  const resources: Array<{ database: AppDatabase; registry: PlaybackSessionRegistry; directory: string }> = [];

  afterEach(async () => {
    for (const resource of resources.splice(0)) {
      await resource.registry.close();
      resource.database.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it('loads capability evidence and preserves single-flight session reuse', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-playback-service-'));
    const database = new AppDatabase(path.join(directory, 'media.db'));
    let now = 100_000;
    const registry = new PlaybackSessionRegistry({
      cleanupIntervalMs: 0,
      now: () => now
    });
    resources.push({ database, registry, directory });
    const capabilities = new DeviceCapabilityStore(database);
    const startPlaybackForMedia = vi.fn(async () => ({
      fileId: 120,
      playbackAttemptId: 'attempt-1',
      decision: {
        protocol_version: 3,
        server_features: [],
        outcome: 'playable' as const,
        session_id: 'session-1',
        playback_plan: {
          delivery: 'server_remux_hls',
          effective_recipe: {
            width: 1920,
            height: 1080,
            video_codec: 'hevc',
            audio_codec: 'aac',
            dynamic_range: 'sdr'
          },
          stream: {
            url: '/playback/transcode/session-1/master.m3u8',
            protocol: 'hls',
            headers: {},
            header_refresh: 'none'
          }
        }
      }
    }));
    const keepPlaybackAlive = vi.fn(async () => true);
    const stopPlayback = vi.fn(async () => true);
    const silo = {
      startPlaybackForMedia,
      keepPlaybackAlive,
      stopPlayback
    } as unknown as SiloService;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new PlaybackService(
      silo,
      registry,
      capabilities,
      logger,
      {
        keepAliveIntervalMs: 0,
        keepAliveIdleAfterMs: 10_000,
        now: () => now
      }
    );
    const deviceId = 'device_1234567890abcdef12345678';
    capabilities.touchDevice(deviceId, 'explicit');
    capabilities.setUserOverride(deviceId, 'video_codec', 'hevc', true);
    const input = {
      item: { type: 'movie', tmdb_id: 123, metadata_json: '{}' } as MediaItemRow,
      file: {
        id: 'file-1', absolute_path: '/media/movie.mkv', width: 3840,
        height: 2160, video_codec: 'hevc', audio_codec: 'aac'
      } as MediaFileRow,
      deviceId,
      deviceIdentitySource: 'signed_stream_token',
      profileId: 'profile-1',
      configuredQuality: 'auto',
      authorizationExpiresAt: Date.now() + 60_000
    };

    const [first, concurrent] = await Promise.all([
      service.orchestrate(input),
      service.orchestrate(input)
    ]);
    const reused = await service.orchestrate(input);

    expect(startPlaybackForMedia).toHaveBeenCalledTimes(1);
    expect(concurrent.sessionResult.session.playbackId)
      .toBe(first.sessionResult.session.playbackId);
    expect(reused.sessionResult.source).toBe('reused');
    expect(first.policy.requestProfile.clientCapabilities.codecs_video)
      .toEqual(['h264', 'hevc']);
    expect(database.sqlite.prepare(
      'SELECT identity_source FROM playback_devices WHERE id=?'
    ).get(deviceId)).toEqual({ identity_source: 'explicit' });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        device_id: deviceId,
        capability_evidence_count: 1
      }),
      'Playback session created'
    );

    expect(service.touchMediaPath(
      '/api/v1/playback/transcode/session-1/segment/seg_00001.ts'
    )).toBe(true);
    await service.keepAliveActiveSessions();
    expect(keepPlaybackAlive).not.toHaveBeenCalled();
    now += 10_000;
    await service.keepAliveActiveSessions();
    expect(keepPlaybackAlive).toHaveBeenCalledOnce();
    expect(keepPlaybackAlive).toHaveBeenCalledWith(
      '/api/v1/playback/transcode/session-1/master.m3u8'
    );

    await registry.getOrCreate({
      deviceId,
      mediaFileId: 'file-2',
      profileId: 'profile-1',
      mode: 'auto-silo',
      quality: 'auto',
      audioSelection: 'policy-profile',
      subtitleSelection: 'none',
      dynamicRangeMode: 'sdr'
    }, now + 60_000, async () => ({
      siloSessionId: 'session-2',
      siloFileId: 121,
      upstreamPath: '/api/v1/stream/session-2',
      delivery: 'original_http'
    }));
    now += 10_000;
    keepPlaybackAlive.mockClear();
    await service.keepAliveActiveSessions();
    expect(keepPlaybackAlive).toHaveBeenCalledTimes(1);
    expect(keepPlaybackAlive).not.toHaveBeenCalledWith(
      '/api/v1/stream/session-2'
    );

    const segment =
      '/api/v1/playback/transcode/session-1/segment/seg_00010.ts';
    for (let index = 0; index < 15; index += 1) {
      service.recordMediaResponse(segment, 100, 200);
      now += 2_500;
    }
    expect(capabilities.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      evidence: 'user_override',
      successCount: 1
    });
    await service.close();
  });

  it('consults the optional fallback only for a likely Auto video transcode', async () => {
    const tryPlayback = vi.fn(async () => null);
    const shouldTryForLocal = vi.fn((_file, likelyVideoTranscode) => likelyVideoTranscode);
    const capabilities = {
      touchDevice: vi.fn(),
      getSnapshot: vi.fn(() => ({
        deviceId: 'device_1234567890abcdef12345678',
        revision: 'none',
        capabilities: []
      }))
    };
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const service = new PlaybackService(
      {} as SiloService,
      registry,
      capabilities as unknown as DeviceCapabilityStore,
      { info: vi.fn(), warn: vi.fn() },
      { keepAliveIntervalMs: 0 }
    );
    service.setFallbackAddon({ tryPlayback, shouldTryForLocal } as never);
    const base = {
      item: { type: 'movie', stremio_id: 'tt1234567' } as MediaItemRow,
      deviceId: 'device_1234567890abcdef12345678',
      deviceIdentitySource: 'signed_stream_token',
      profileId: 'profile-1',
      authorizationExpiresAt: Date.now() + 60_000
    };
    await service.tryFallback({
      ...base,
      configuredQuality: 'auto',
      file: {
        id: 'hevc', width: 3840, height: 2160,
        relative_path: 'Movie.mkv', video_codec: 'hevc'
      } as MediaFileRow
    });
    expect(tryPlayback).toHaveBeenCalledOnce();

    await service.tryFallback({
      ...base,
      configuredQuality: 'auto',
      file: {
        id: 'h264', width: 1920, height: 1080,
        relative_path: 'Movie.mkv', video_codec: 'h264'
      } as MediaFileRow
    });
    await service.tryFallback({
      ...base,
      configuredQuality: '1080p-medium',
      file: {
        id: 'fixed', width: 3840, height: 2160,
        relative_path: 'Movie.mkv', video_codec: 'hevc'
      } as MediaFileRow
    });
    expect(tryPlayback).toHaveBeenCalledTimes(1);
    await service.close();
  });

  it('stops the matching Silo session only after AIO fallback succeeds', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const stopPlayback = vi.fn(async () => true);
    const capabilities = {
      touchDevice: vi.fn(),
      getSnapshot: vi.fn(() => ({
        deviceId: 'device_1234567890abcdef12345678',
        revision: 'none',
        capabilities: []
      }))
    };
    const service = new PlaybackService(
      { stopPlayback } as unknown as SiloService,
      registry,
      capabilities as unknown as DeviceCapabilityStore,
      { info: vi.fn(), warn: vi.fn() },
      { keepAliveIntervalMs: 0 }
    );
    const file = {
      id: 'file-1',
      width: 3840,
      height: 2160,
      relative_path: 'Movie.mkv',
      video_codec: 'hevc'
    } as MediaFileRow;
    const input = {
      item: { type: 'movie', stremio_id: 'tt1234567' } as MediaItemRow,
      file,
      deviceId: 'device_1234567890abcdef12345678',
      deviceIdentitySource: 'signed_stream_token',
      profileId: 'profile-1',
      configuredQuality: 'auto',
      authorizationExpiresAt: Date.now() + 60_000
    };
    await registry.getOrCreate({
      deviceId: input.deviceId,
      mediaFileId: file.id,
      profileId: input.profileId,
      mode: 'auto-silo',
      quality: 'auto',
      audioSelection: 'policy-profile',
      subtitleSelection: 'none',
      dynamicRangeMode: 'sdr'
    }, input.authorizationExpiresAt, async () => ({
      siloSessionId: 'session-1',
      siloFileId: 120,
      upstreamPath: '/api/v1/playback/transcode/session-1/master.m3u8',
      delivery: 'server_transcode_hls'
    }));

    const tryPlayback = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'aio-session-1',
        playbackId: 'aio-playback-1',
        upstreamUrl: 'https://stream.example/video',
        requestHeaders: {},
        label: 'AIO 2160p',
        candidates: [],
        candidateIndex: 0,
        candidateVerified: true,
        durationSeconds: null,
        createdAt: Date.now(),
        lastAccess: Date.now(),
        expiresAt: Date.now() + 60_000,
        maximumExpiresAt: Date.now() + 60_000
      });
    service.setFallbackAddon({
      tryPlayback,
      shouldTryForLocal: vi.fn(() => true)
    } as never);

    await expect(service.tryFallback(input)).resolves.toBeNull();
    expect(stopPlayback).not.toHaveBeenCalled();
    expect(await registry.activeSnapshot()).toHaveLength(1);

    await expect(service.tryFallback(input)).resolves.toMatchObject({
      id: 'aio-session-1'
    });
    expect(stopPlayback).toHaveBeenCalledOnce();
    expect(stopPlayback).toHaveBeenCalledWith('session-1');
    expect(await registry.activeSnapshot()).toHaveLength(0);
    await service.close();
  });

  it('performs one position-preserving replan after repeated slow segments', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const capabilities = {
      touchDevice: vi.fn(),
      getSnapshot: vi.fn(() => ({
        deviceId: 'device_1234567890abcdef12345678',
        revision: 'none',
        capabilities: []
      }))
    };
    const startPlaybackForMedia = vi.fn(async () => ({
      fileId: 120,
      playbackAttemptId: 'attempt-1',
      decision: {
        protocol_version: 3 as const,
        server_features: [],
        outcome: 'playable',
        session_id: 'session-1',
        playback_plan: {
          plan_id: 'plan-1',
          plan_attempt_key: 'key-1',
          delivery: 'server_transcode_hls',
          effective_recipe: { height: 2160 },
          available_qualities: [
            { label: '2160p-high', height: 2160, preserves_source: false },
            { label: '1080p-high', height: 1080, preserves_source: false }
          ],
          stream: {
            url: '/playback/transcode/session-1/master.m3u8',
            protocol: 'hls', headers: {}, header_refresh: 'none'
          }
        }
      }
    }));
    const replanPlaybackQuality = vi.fn(async () => ({
      protocol_version: 3 as const,
      server_features: [],
      outcome: 'playable',
      session_id: 'session-2',
      playback_plan: {
        delivery: 'server_transcode_hls',
        effective_recipe: { height: 1080 },
        stream: {
          url: '/playback/transcode/session-2/master.m3u8',
          protocol: 'hls', headers: {}, header_refresh: 'none'
        }
      }
    }));
    const stopPlayback = vi.fn(async () => true);
    const service = new PlaybackService(
      {
        startPlaybackForMedia,
        replanPlaybackQuality,
        stopPlayback
      } as unknown as SiloService,
      registry,
      capabilities as unknown as DeviceCapabilityStore,
      { info: vi.fn(), warn: vi.fn() },
      {
        keepAliveIntervalMs: 0,
        runtimeFallback: {
          enabled: () => true,
          slowSegmentMs: () => 2500,
          slowSegmentCount: () => 2,
          startupMs: () => 20_000
        }
      }
    );
    const input = {
      item: { type: 'movie', tmdb_id: 123, metadata_json: '{}' } as MediaItemRow,
      file: {
        id: 'file-1', absolute_path: '/media/movie.mkv', width: 3840,
        height: 2160, video_codec: 'hevc', audio_codec: 'truehd'
      } as MediaFileRow,
      deviceId: 'device_1234567890abcdef12345678',
      deviceIdentitySource: 'signed_stream_token',
      profileId: 'profile-1',
      configuredQuality: 'auto',
      authorizationExpiresAt: Date.now() + 60_000
    };
    const result = await service.orchestrate(input);
    const segment = '/api/v1/playback/transcode/session-1/segment/seg_00020.ts';
    service.recordManifest([{ path: segment, positionSeconds: 40 }]);
    service.recordMediaResponse(segment, 2600, 200);
    service.recordMediaResponse(segment, 2700, 200);

    await vi.waitFor(() => expect(replanPlaybackQuality).toHaveBeenCalledOnce());
    expect(replanPlaybackQuality).toHaveBeenCalledWith(
      'session-1',
      'profile-1',
      'attempt-1',
      expect.objectContaining({ plan_id: 'plan-1' }),
      '1080p-high',
      expect.any(Object),
      40
    );
    service.recordMediaResponse(segment, 2800, 200);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(replanPlaybackQuality).toHaveBeenCalledOnce();
    expect(service.resolveMediaPath(result.sessionResult.session.upstreamPath))
      .toBe('/api/v1/playback/transcode/session-2/master.m3u8');
    expect(stopPlayback).toHaveBeenCalledWith('session-1');
    await service.close();
  });

  it('stops a late replan result when AIO supersedes the active transcode', async () => {
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const capabilities = {
      touchDevice: vi.fn(),
      getSnapshot: vi.fn(() => ({
        deviceId: 'device_1234567890abcdef12345678',
        revision: 'none',
        capabilities: []
      }))
    };
    const startPlaybackForMedia = vi.fn(async () => ({
      fileId: 120,
      playbackAttemptId: 'attempt-1',
      decision: {
        protocol_version: 3 as const,
        server_features: [],
        outcome: 'playable',
        session_id: 'session-1',
        playback_plan: {
          plan_id: 'plan-1',
          plan_attempt_key: 'key-1',
          delivery: 'server_transcode_hls',
          effective_recipe: { height: 2160 },
          available_qualities: [
            { label: '2160p-high', height: 2160, preserves_source: false },
            { label: '1080p-high', height: 1080, preserves_source: false }
          ],
          stream: {
            url: '/playback/transcode/session-1/master.m3u8',
            protocol: 'hls', headers: {}, header_refresh: 'none'
          }
        }
      }
    }));
    const replacement = {
      protocol_version: 3 as const,
      server_features: [],
      outcome: 'playable',
      session_id: 'session-2',
      playback_plan: {
        delivery: 'server_transcode_hls',
        effective_recipe: { height: 1080 },
        stream: {
          url: '/playback/transcode/session-2/master.m3u8',
          protocol: 'hls', headers: {}, header_refresh: 'none'
        }
      }
    };
    let releaseReplan!: (value: typeof replacement) => void;
    const replanPlaybackQuality = vi.fn(() => new Promise<typeof replacement>(
      resolve => { releaseReplan = resolve; }
    ));
    const stopPlayback = vi.fn(async () => true);
    const service = new PlaybackService(
      {
        startPlaybackForMedia,
        replanPlaybackQuality,
        stopPlayback
      } as unknown as SiloService,
      registry,
      capabilities as unknown as DeviceCapabilityStore,
      { info: vi.fn(), warn: vi.fn() },
      {
        keepAliveIntervalMs: 0,
        runtimeFallback: {
          enabled: () => true,
          slowSegmentMs: () => 2500,
          slowSegmentCount: () => 2,
          startupMs: () => 20_000
        }
      }
    );
    const input = {
      item: { type: 'movie', stremio_id: 'tt1234567' } as MediaItemRow,
      file: {
        id: 'file-1', absolute_path: '/media/movie.mkv', width: 3840,
        height: 2160, video_codec: 'hevc', audio_codec: 'truehd'
      } as MediaFileRow,
      deviceId: 'device_1234567890abcdef12345678',
      deviceIdentitySource: 'signed_stream_token',
      profileId: 'profile-1',
      configuredQuality: 'auto',
      authorizationExpiresAt: Date.now() + 60_000
    };
    await service.orchestrate(input);
    const segment = '/api/v1/playback/transcode/session-1/segment/seg_00020.ts';
    service.recordMediaResponse(segment, 2600, 200);
    service.recordMediaResponse(segment, 2700, 200);
    await vi.waitFor(() => expect(replanPlaybackQuality).toHaveBeenCalledOnce());

    service.setFallbackAddon({
      shouldTryForLocal: vi.fn(() => true),
      tryPlayback: vi.fn(async () => ({
        id: 'aio-session-1',
        playbackId: 'aio-playback-1',
        upstreamUrl: 'https://stream.example/video',
        requestHeaders: {},
        label: 'AIO 2160p',
        candidates: [],
        candidateIndex: 0,
        candidateVerified: true,
        durationSeconds: null,
        createdAt: Date.now(),
        lastAccess: Date.now(),
        expiresAt: Date.now() + 60_000,
        maximumExpiresAt: Date.now() + 60_000
      }))
    } as never);
    await expect(service.tryFallback(input)).resolves.toMatchObject({
      id: 'aio-session-1'
    });
    expect(stopPlayback).toHaveBeenCalledWith('session-1');

    releaseReplan(replacement);
    await vi.waitFor(() => {
      expect(stopPlayback).toHaveBeenCalledWith('session-2');
      expect(stopPlayback).toHaveBeenCalledTimes(2);
    });
    expect(await registry.activeSnapshot()).toHaveLength(0);
    await service.close();
  });
});
