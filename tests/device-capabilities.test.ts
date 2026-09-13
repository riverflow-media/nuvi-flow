import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { DeviceCapabilityStore } from '../src/services/playback/device-capabilities.js';

describe('device capability persistence', () => {
  let directory: string;
  let database: AppDatabase;
  let store: DeviceCapabilityStore;
  let now: number;
  const deviceId = 'device_1234567890abcdef12345678';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-capabilities-'));
    database = new AppDatabase(path.join(directory, 'media.db'));
    now = 100;
    store = new DeviceCapabilityStore(database, { now: () => now });
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('stores only pseudonymous device identity and capability evidence', () => {
    store.touchDevice(deviceId, 'signed_stream_token', 100);
    store.touchDevice(deviceId, 'signed_stream_token', 200);
    now = 300;
    store.recordEvidence(deviceId, {
      category: 'video_codec',
      capability: 'HEVC',
      supported: true,
      evidence: 'observed_success',
      confidence: .6
    }, 300);

    expect(database.sqlite.prepare(
      'SELECT * FROM playback_devices WHERE id=?'
    ).get(deviceId)).toEqual({
      id: deviceId,
      identity_source: 'signed_stream_token',
      first_seen_at: 100,
      last_seen_at: 200
    });
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      category: 'video_codec',
      capability: 'hevc',
      supported: true,
      evidence: 'observed_success',
      confidence: .25,
      state: 'unknown',
      successCount: 1,
      failureCount: 0
    });
  });

  it('protects an explicit override while retaining later observation counters', () => {
    store.touchDevice(deviceId, 'explicit');
    store.setUserOverride(deviceId, 'hdr', 'HDR10', false, 100);
    const before = store.getSnapshot(deviceId);

    now = 200;
    store.recordEvidence(deviceId, {
      category: 'hdr',
      capability: 'hdr10',
      supported: true,
      evidence: 'observed_success',
      confidence: .8
    }, 200);

    const capability = store.getSnapshot(deviceId).capabilities[0];
    expect(capability).toMatchObject({
      supported: false,
      evidence: 'user_override',
      confidence: 1,
      successCount: 1
    });
    expect(store.getSnapshot(deviceId).revision).toBe(before.revision);
    now = 300;
    expect(store.clearUserOverride(deviceId, 'hdr', 'HDR10')).toBe(true);
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      supported: true,
      state: 'unknown',
      evidence: 'observed_success',
      successCount: 1,
      failureCount: 0
    });
  });

  it('requires three consistent observations and lets stale confidence decay', () => {
    store.touchDevice(deviceId, 'client_hints');
    for (const observedAt of [100, 200, 300]) {
      now = observedAt;
      store.recordEvidence(deviceId, {
        category: 'video_codec', capability: 'hevc', supported: true,
        evidence: 'observed_success', confidence: 1
      });
    }
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      supported: true,
      state: 'supported',
      evidence: 'observed_success',
      confidence: .75,
      successCount: 3,
      failureCount: 0
    });

    now += 90 * 24 * 60 * 60_000;
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      state: 'unknown',
      confidence: .375
    });
  });

  it('restores trusted observations after a manual override is cleared', () => {
    store.touchDevice(deviceId, 'explicit');
    for (const observedAt of [100, 200, 300]) {
      now = observedAt;
      store.recordEvidence(deviceId, {
        category: 'video_codec', capability: 'hevc', supported: true,
        evidence: 'observed_success', confidence: 1
      });
    }
    store.setUserOverride(deviceId, 'video_codec', 'hevc', false, 400);
    now = 500;
    store.recordEvidence(deviceId, {
      category: 'video_codec', capability: 'hevc', supported: true,
      evidence: 'observed_success', confidence: 1
    });
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      state: 'unsupported',
      evidence: 'user_override',
      successCount: 4
    });

    now = 600;
    expect(store.clearUserOverride(deviceId, 'video_codec', 'hevc')).toBe(true);
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      state: 'supported',
      evidence: 'observed_success',
      successCount: 4
    });
  });

  it('does not make stale observations fresh when an override is cleared', () => {
    store.touchDevice(deviceId, 'explicit');
    for (const observedAt of [100, 200, 300]) {
      now = observedAt;
      store.recordEvidence(deviceId, {
        category: 'video_codec', capability: 'hevc', supported: true,
        evidence: 'observed_success', confidence: 1
      });
    }
    now += 90 * 24 * 60 * 60_000;
    expect(store.getSnapshot(deviceId).capabilities[0].state).toBe('unknown');

    store.setUserOverride(deviceId, 'video_codec', 'hevc', true);
    expect(store.getSnapshot(deviceId).capabilities[0].state).toBe('supported');
    now += 1;
    expect(store.clearUserOverride(deviceId, 'video_codec', 'hevc')).toBe(true);
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      state: 'unknown',
      evidence: 'observed_success',
      successCount: 3
    });
    expect(store.getSnapshot(deviceId).capabilities[0].confidence).toBeLessThan(.4);
  });

  it('lists pseudonymous devices with their effective capability state', () => {
    store.touchDevice(deviceId, 'explicit');
    store.setUserOverride(deviceId, 'container', 'mkv', true);
    expect(store.listDevices()).toMatchObject([{
      id: deviceId,
      identitySource: 'explicit',
      capabilities: [{
        category: 'container',
        capability: 'mkv',
        state: 'supported',
        evidence: 'user_override'
      }]
    }]);
  });

  it('cascades capability removal when a device is deleted', () => {
    store.touchDevice(deviceId, 'request_scope');
    store.setUserOverride(deviceId, 'audio_codec', 'EAC3', true);
    database.sqlite.prepare('DELETE FROM playback_devices WHERE id=?').run(deviceId);
    expect(store.getSnapshot(deviceId).capabilities).toEqual([]);
  });
});
