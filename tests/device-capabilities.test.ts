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
  const deviceId = 'device_1234567890abcdef12345678';

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-capabilities-'));
    database = new AppDatabase(path.join(directory, 'media.db'));
    store = new DeviceCapabilityStore(database);
  });

  afterEach(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('stores only pseudonymous device identity and capability evidence', () => {
    store.touchDevice(deviceId, 'signed_stream_token', 100);
    store.touchDevice(deviceId, 'signed_stream_token', 200);
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
      confidence: .6,
      successCount: 1,
      failureCount: 0
    });
  });

  it('protects an explicit override while retaining later observation counters', () => {
    store.touchDevice(deviceId, 'explicit');
    store.setUserOverride(deviceId, 'hdr', 'HDR10', false, 100);
    const before = store.getSnapshot(deviceId);

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
    expect(store.getSnapshot(deviceId).revision).not.toBe(before.revision);
    expect(store.clearUserOverride(deviceId, 'hdr', 'HDR10')).toBe(true);
    expect(store.getSnapshot(deviceId).capabilities).toEqual([]);
  });

  it('normalizes observed success and failure into consistent support state', () => {
    store.touchDevice(deviceId, 'client_hints');
    store.recordEvidence(deviceId, {
      category: 'audio_codec', capability: 'dts', supported: false,
      evidence: 'observed_success', confidence: .7
    }, 100);
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      supported: true, evidence: 'observed_success', successCount: 1
    });

    store.recordEvidence(deviceId, {
      category: 'audio_codec', capability: 'dts', supported: true,
      evidence: 'observed_failure', confidence: .7
    }, 200);
    expect(store.getSnapshot(deviceId).capabilities[0]).toMatchObject({
      supported: false, evidence: 'observed_failure',
      successCount: 1, failureCount: 1
    });
  });

  it('cascades capability removal when a device is deleted', () => {
    store.touchDevice(deviceId, 'request_scope');
    store.setUserOverride(deviceId, 'audio_codec', 'EAC3', true);
    database.sqlite.prepare('DELETE FROM playback_devices WHERE id=?').run(deviceId);
    expect(store.getSnapshot(deviceId).capabilities).toEqual([]);
  });
});
