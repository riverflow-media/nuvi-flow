import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { PlaybackOutcomeStore } from '../src/services/playback/playback-outcomes.js';

describe('PlaybackOutcomeStore', () => {
  const resources: Array<{ database: AppDatabase; directory: string }> = [];

  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      fs.rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function create(options: ConstructorParameters<typeof PlaybackOutcomeStore>[1] = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-outcomes-'));
    const database = new AppDatabase(path.join(directory, 'media.db'));
    resources.push({ database, directory });
    return { database, store: new PlaybackOutcomeStore(database, options) };
  }

  it('stores one sanitized server observation per playback and code', () => {
    const { database, store } = create();
    database.sqlite.prepare(
      `INSERT INTO playback_devices (id,identity_source,first_seen_at,last_seen_at)
       VALUES (?,?,?,?)`
    ).run('device_1234567890abcdef12345678', 'explicit', 1, 1);

    const input = {
      playbackId: 'playback-1',
      code: 'delivery_degraded' as const,
      provider: 'silo' as const,
      route: 'server_transcode_hls' as const,
      level: 'warning' as const,
      failureDomain: 'ambiguous' as const,
      reason: 'SLOW_SEGMENTS',
      httpStatus: 200,
      mediaId: 'tt1234567',
      mediaType: 'movie' as const,
      deviceId: 'device_1234567890abcdef12345678'
    };

    expect(store.record(input)).toBe(true);
    expect(store.record(input)).toBe(false);
    expect(store.recent()).toEqual([expect.objectContaining({
      playbackId: 'playback-1',
      code: 'delivery_degraded',
      reason: 'slow_segments',
      failureDomain: 'ambiguous',
      capabilityEvidence: false
    })]);
    expect(database.sqlite.prepare(
      'SELECT COUNT(*) count,MAX(capability_evidence) evidence FROM playback_outcomes'
    ).get()).toEqual({ count: 1, evidence: 0 });
  });

  it('cannot persist arbitrary diagnostic text or secret-bearing URLs', () => {
    const { store } = create();
    store.record({
      playbackId: 'playback-2',
      code: 'upstream_unavailable',
      provider: 'fallback-addon',
      route: 'external_direct_http',
      level: 'error',
      failureDomain: 'transport',
      reason: 'https://private.example/video?token=secret-value',
      mediaId: 'tt7654321',
      mediaType: 'movie'
    });

    const serialized = JSON.stringify(store.recent());
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('secret-value');
    expect(store.recent()[0]?.reason).toBeNull();
  });

  it('aggregates every retained observation without the recent-list limit', () => {
    const now = 200_000;
    const { store } = create({
      now: () => now,
      maxRows: 1_000,
      cleanupEvery: 1_000
    });
    for (let index = 0; index < 205; index += 1) {
      store.record({
        playbackId: `warning-${index}`,
        code: 'capacity_unavailable',
        provider: 'silo',
        route: 'server_transcode_hls',
        level: 'warning',
        failureDomain: 'capacity'
      });
    }
    store.record({
      playbackId: 'error-1',
      code: 'upstream_unavailable',
      provider: 'fallback-addon',
      route: 'external_direct_http',
      level: 'error',
      failureDomain: 'transport'
    });

    expect(store.recent(1_000)).toHaveLength(200);
    expect(store.summarySince(now - 1)).toEqual({
      total: 206,
      warnings: 205,
      errors: 1,
      byFailureDomain: { capacity: 205, transport: 1 }
    });
  });

  it('prunes expired and overflow observations', () => {
    let now = 100_000;
    const { store } = create({
      now: () => now,
      retentionMs: 60_000,
      maxRows: 2,
      cleanupEvery: 1
    });
    const record = (playbackId: string) => store.record({
      playbackId,
      code: 'route_selected',
      provider: 'silo',
      route: 'server_remux_hls',
      level: 'info',
      failureDomain: 'none',
      reason: 'policy'
    });

    record('playback-1');
    now += 1;
    record('playback-2');
    now += 1;
    record('playback-3');
    expect(store.recent().map(row => row.playbackId))
      .toEqual(['playback-3', 'playback-2']);

    now += 60_001;
    expect(store.recent()).toEqual([]);
    expect(store.cleanup()).toBe(2);
  });
});
