import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/db/index.js';
import { NetworkProfileStore } from '../src/services/playback/network-profiles.js';

describe('temporary playback network profiles', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires three samples and keeps device/network contexts independent', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-network-'));
    directories.push(directory);
    const database = new AppDatabase(path.join(directory, 'media.db'));
    const store = new NetworkProfileStore(database, 'test-secret', true);
    const device = 'device_1234567890abcdef12345678';

    store.observe(device, '203.0.113.10', 10_000_000, 1000);
    store.observe(device, '203.0.113.10', 10_000_000, 1000);
    expect(store.usableEstimateMbps(device, '203.0.113.10')).toBeNull();
    store.observe(device, '203.0.113.10', 10_000_000, 1000);
    expect(store.usableEstimateMbps(device, '203.0.113.10')).toBeCloseTo(80);
    expect(store.usableEstimateMbps(device, '203.0.113.11')).toBeNull();
    expect(store.usableEstimateMbps('device_aaaaaaaaaaaaaaaaaaaaaaaa', '203.0.113.10')).toBeNull();

    const raw = JSON.stringify(database.sqlite.prepare(
      'SELECT * FROM playback_network_profiles'
    ).all());
    expect(raw).not.toContain('203.0.113.10');
    database.close();
  });

  it('does not use a proxy-private context for routing when proxy trust is disabled', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-network-'));
    directories.push(directory);
    const database = new AppDatabase(path.join(directory, 'media.db'));
    const store = new NetworkProfileStore(database, 'test-secret', false);
    const device = 'device_1234567890abcdef12345678';
    for (let count = 0; count < 4; count += 1) {
      store.observe(device, '172.19.0.14', 10_000_000, 1000);
    }
    expect(store.getEstimate(device, '172.19.0.14')).toMatchObject({
      contextReliable: false,
      sampleCount: 4
    });
    expect(store.usableEstimateMbps(device, '172.19.0.14')).toBeNull();
    database.close();
  });

  it('does not learn from a transfer containing a pause-sized delivery gap', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvi-network-'));
    directories.push(directory);
    const database = new AppDatabase(path.join(directory, 'media.db'));
    let now = 0;
    const store = new NetworkProfileStore(database, 'test-secret', true, () => now);
    const meter = store.meter('device_1234567890abcdef12345678', '203.0.113.10', 45);
    meter.resume();
    const ended = once(meter, 'end');
    meter.write(Buffer.alloc(1024 * 1024));
    now = 3000;
    meter.end(Buffer.alloc(2 * 1024 * 1024));
    await ended;
    expect(database.sqlite.prepare('SELECT COUNT(*) count FROM playback_network_profiles').get())
      .toEqual({ count: 0 });
    database.close();
  });
});
