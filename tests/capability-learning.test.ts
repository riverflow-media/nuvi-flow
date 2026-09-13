import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import {
  PlaybackCapabilityLearner,
  sourcePlaybackCapabilityClaims
} from '../src/services/playback/capability-learning.js';
import { DeviceCapabilityStore } from '../src/services/playback/device-capabilities.js';

describe('conservative playback capability learning', () => {
  let directory: string;
  let database: AppDatabase;
  let store: DeviceCapabilityStore;
  let learner: PlaybackCapabilityLearner;
  let now: number;
  const deviceId = 'device_1234567890abcdef12345678';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-learning-'));
    database = new AppDatabase(path.join(directory, 'media.db'));
    now = 1_000;
    store = new DeviceCapabilityStore(database, { now: () => now });
    learner = new PlaybackCapabilityLearner(store, {
      now: () => now,
      minTransferBytes: 2,
      minTransferMs: 10,
      minMediaSeconds: 1,
      maxIdleGapMs: 5
    });
  });

  afterEach(() => {
    learner.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function completeCleanTransfer(playbackId: string): Promise<void> {
    const meter = learner.createTransferMeter({
      playbackId,
      deviceId,
      bitrate: 8,
      claims: [{ category: 'video_codec', capability: 'hevc' }]
    });
    expect(meter).not.toBeNull();
    const ended = once(meter!, 'end');
    meter!.resume();
    meter!.write(Buffer.from('a'));
    now += 5;
    meter!.write(Buffer.from('b'));
    now += 5;
    meter!.end(Buffer.from('c'));
    await ended;
  }

  it('trusts a capability only after three separate clean playbacks', async () => {
    await completeCleanTransfer('playback-1');
    await completeCleanTransfer('playback-2');
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      state: 'unknown',
      successCount: 2
    });

    await completeCleanTransfer('playback-3');
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      category: 'video_codec',
      capability: 'hevc',
      state: 'supported',
      evidence: 'observed_success',
      successCount: 3,
      failureCount: 0
    });

    expect(learner.recordSuccessfulPlayback(
      'playback-3',
      deviceId,
      [{ category: 'video_codec', capability: 'hevc' }]
    )).toBe(false);
    expect(store.getSnapshot(deviceId).capabilities[0].successCount).toBe(3);
  });

  it('ignores short and interrupted transfers instead of recording failures', async () => {
    const short = learner.createTransferMeter({
      playbackId: 'short',
      deviceId,
      bitrate: 8,
      claims: [{ category: 'container', capability: 'mkv' }]
    })!;
    const shortEnded = once(short, 'end');
    short.resume();
    short.end(Buffer.from('abc'));
    await shortEnded;

    const interrupted = learner.createTransferMeter({
      playbackId: 'interrupted',
      deviceId,
      bitrate: 8,
      claims: [{ category: 'container', capability: 'mkv' }]
    })!;
    const interruptedEnded = once(interrupted, 'end');
    interrupted.resume();
    interrupted.write(Buffer.from('a'));
    now += 6;
    interrupted.write(Buffer.from('b'));
    now += 10;
    interrupted.end(Buffer.from('c'));
    await interruptedEnded;

    expect(store.getSnapshot(deviceId).capabilities).toEqual([]);
  });

  it('claims only unambiguous source traits', () => {
    const base = {
      width: 3840,
      height: 2160,
      relative_path: 'Movie.mkv',
      video_codec: 'hevc'
    };
    expect(sourcePlaybackCapabilityClaims({
      ...base,
      probe_json: '{"color_transfer":"smpte2084"}'
    })).toEqual([
      { category: 'video_codec', capability: 'hevc' },
      { category: 'container', capability: 'mkv' },
      { category: 'hdr', capability: 'hdr10' },
      { category: 'max_resolution', capability: '2160p' }
    ]);
    expect(sourcePlaybackCapabilityClaims({
      ...base,
      probe_json: '{"dovi":true,"color_transfer":"smpte2084"}'
    })).not.toContainEqual({ category: 'hdr', capability: 'hdr10' });
    expect(sourcePlaybackCapabilityClaims({
      ...base,
      probe_json: '{"profile":"hdr10+","color_transfer":"smpte2084"}'
    })).not.toContainEqual({ category: 'hdr', capability: 'hdr10' });
  });

  it('keeps learning failures outside the playback failure path', () => {
    const onError = vi.fn();
    const isolated = new PlaybackCapabilityLearner(store, {
      now: () => now,
      onError
    });
    vi.spyOn(store, 'recordEvidence').mockImplementation(() => {
      throw new Error('database unavailable');
    });

    expect(() => isolated.recordSuccessfulPlayback(
      'playback-error',
      deviceId,
      [{ category: 'video_codec', capability: 'hevc' }]
    )).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(isolated.recordSuccessfulPlayback(
      'playback-error',
      deviceId,
      [{ category: 'video_codec', capability: 'hevc' }]
    )).toBe(false);
    isolated.close();
  });
});
