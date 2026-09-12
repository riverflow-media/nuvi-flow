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

  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.registry.close();
      resource.database.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  it('loads capability evidence and preserves single-flight session reuse', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-playback-service-'));
    const database = new AppDatabase(path.join(directory, 'media.db'));
    const registry = new PlaybackSessionRegistry({ cleanupIntervalMs: 0 });
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
    const silo = {
      startPlaybackForMedia,
      keepPlaybackAlive
    } as unknown as SiloService;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const service = new PlaybackService(
      silo,
      registry,
      capabilities,
      logger,
      { keepAliveIntervalMs: 0 }
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
    ).get(deviceId)).toEqual({ identity_source: 'signed_stream_token' });
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
    expect(keepPlaybackAlive).toHaveBeenCalledOnce();
    expect(keepPlaybackAlive).toHaveBeenCalledWith(
      '/api/v1/playback/transcode/session-1/master.m3u8'
    );
    service.close();
  });
});
