import { describe, expect, it, vi } from 'vitest';
import type { FallbackAddonService } from '../src/services/playback/fallback-addon.js';
import {
  PlaybackActivityService
} from '../src/services/playback/playback-activity.js';
import {
  PlaybackSessionRegistry
} from '../src/services/playback/playback-sessions.js';
import type { MediaFileRow } from '../src/types.js';

const file = {
  id: 'file-a',
  library_type: 'movie',
  quality: '2160p',
  width: 3840,
  height: 2160,
  video_codec: 'hevc',
  audio_codec: 'truehd'
} as MediaFileRow;

describe('PlaybackActivityService', () => {
  it('reports the current Silo plan and follows a proxied transfer lifecycle', async () => {
    let now = 1_000;
    const sessions = new PlaybackSessionRegistry({
      now: () => now,
      sessionTtlMs: 60_000,
      cleanupIntervalMs: 0
    });
    await sessions.getOrCreate({
      deviceId: 'device_1234567890abcdef12345678',
      mediaFileId: file.id,
      profileId: 'profile-a',
      mode: 'auto-silo',
      quality: 'auto',
      audioSelection: 'policy-profile',
      subtitleSelection: 'none',
      dynamicRangeMode: 'sdr'
    }, 100_000, async () => ({
      siloSessionId: 'silo-session-a',
      siloFileId: 1,
      upstreamPath: '/api/v1/playback/transcode/silo-session-a/master.m3u8',
      delivery: 'server_transcode_hls',
      planSummary: {
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        dynamicRange: 'sdr'
      }
    }));
    const fallback = {
      activeSnapshot: vi.fn(() => [])
    } as unknown as FallbackAddonService;
    const activity = new PlaybackActivityService(sessions, fallback, {
      now: () => now,
      idleWindowMs: 100,
      cleanupIntervalMs: 0
    });

    expect(await activity.snapshot()).toMatchObject([{
      provider: 'silo',
      route: 'server_transcode_hls',
      state: 'starting',
      target: {
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        dynamicRange: 'sdr'
      }
    }]);

    const transfer = activity.beginSilo(
      '/api/v1/playback/transcode/silo-session-a/segment/seg_00001.ts'
    );
    expect(transfer).not.toBeNull();
    expect((await activity.snapshot())[0]?.state).toBe('streaming');
    transfer!.finish();
    now += 101;
    expect((await activity.snapshot())[0]?.state).toBe('idle');

    activity.close();
    await sessions.close();
  });

  it('tracks direct ranges briefly without exposing the signed request scope', async () => {
    let now = 1_000;
    const sessions = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const fallback = {
      activeSnapshot: vi.fn(() => [])
    } as unknown as FallbackAddonService;
    const activity = new PlaybackActivityService(sessions, fallback, {
      now: () => now,
      idleWindowMs: 100,
      directLingerMs: 500,
      cleanupIntervalMs: 0
    });
    const transfer = activity.beginDirect({
      requestScope: 'private-signed-token-id',
      deviceId: 'device_1234567890abcdef12345678',
      file,
      authorizationExpiresAt: 10_000
    });

    const streaming = await activity.snapshot();
    expect(streaming).toMatchObject([{
      playbackId: transfer.playbackId,
      mediaFileId: 'file-a',
      provider: 'nuvi-flow',
      route: 'direct_file',
      state: 'streaming',
      target: {
        quality: '2160p',
        height: 2160,
        videoCodec: 'hevc',
        audioCodec: 'truehd'
      }
    }]);
    expect(JSON.stringify(streaming)).not.toContain('private-signed-token-id');

    transfer.finish();
    now += 101;
    expect((await activity.snapshot())[0]?.state).toBe('idle');
    now += 500;
    expect(await activity.snapshot()).toEqual([]);

    activity.close();
    await sessions.close();
  });

  it('uses only the sanitized fallback snapshot', async () => {
    const sessions = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
    const fallback = {
      activeSnapshot: vi.fn(() => [{
        playbackId: 'fallback-playback-a',
        deviceId: 'device_1234567890abcdef12345678',
        mediaFileId: null,
        mediaId: 'tt1234567',
        mediaType: 'movie' as const,
        season: null,
        episode: null,
        resolutionHeight: 2160,
        bitrateMbps: 18,
        candidateAttempt: 2,
        candidateCount: 10,
        candidateVerified: true,
        createdAt: Date.now(),
        lastAccess: Date.now(),
        expiresAt: Date.now() + 60_000
      }])
    } as unknown as FallbackAddonService;
    const activity = new PlaybackActivityService(sessions, fallback, {
      cleanupIntervalMs: 0
    });

    expect(await activity.snapshot()).toMatchObject([{
      playbackId: 'fallback-playback-a',
      mediaId: 'tt1234567',
      provider: 'fallback-addon',
      route: 'external_direct_http',
      state: 'streaming',
      target: { height: 2160, bitrateMbps: 18 },
      candidate: { attempt: 2, count: 10 }
    }]);

    activity.close();
    await sessions.close();
  });
});
