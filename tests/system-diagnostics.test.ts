import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildApp, type BuiltApp } from '../src/server.js';

describe('system diagnostics', () => {
  let built: BuiltApp;
  let directory: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nuviflow-health-'));
    built = await buildApp(loadConfig({
      PORT: '60500',
      BASE_URL: 'http://localhost:60500',
      DATABASE_PATH: path.join(directory, 'test.db'),
      MOVIES_PATH: directory,
      TV_PATH: directory,
      ADMIN_PASSWORD: 'safe-test-password',
      SESSION_SECRET: 'test-session-secret-at-least-thirty-two-chars',
      STREAM_SECRET: 'test-stream-secret-at-least-thirty-two-chars',
      SCAN_ON_STARTUP: 'false',
      WATCH_MEDIA: 'false',
      LOG_LEVEL: 'silent'
    }));
    await built.app.ready();
  });

  afterEach(async () => {
    await built.app.close();
    built.database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('coalesces integration checks and retains the cached snapshot', async () => {
    built.settings.set('siloEnabled', 'true');
    built.settings.set('siloUrl', 'http://silo:8080');
    built.settings.set('siloApiKey', 'private-key');
    built.settings.set('siloProfileId', 'profile-1');
    const connection = vi.spyOn(built.silo, 'testConnection')
      .mockResolvedValue({
        health: { status: 'ok', server_name: 'Silo' },
        profiles: [{ id: 'profile-1', name: 'Default' }]
      });

    const [first, coalesced] = await Promise.all([
      built.systemDiagnostics.snapshot(true),
      built.systemDiagnostics.snapshot(true)
    ]);
    const cached = await built.systemDiagnostics.snapshot();

    expect(connection).toHaveBeenCalledTimes(1);
    expect(coalesced).toBe(first);
    expect(cached).toBe(first);
    expect(first.checks).toContainEqual(expect.objectContaining({
      id: 'silo', status: 'healthy'
    }));

    built.systemDiagnostics.invalidate();
    await built.systemDiagnostics.snapshot();
    expect(connection).toHaveBeenCalledTimes(2);
  });

  it('does not restore an invalidated snapshot after an older check finishes', async () => {
    built.settings.set('siloEnabled', 'true');
    built.settings.set('siloUrl', 'http://silo:8080');
    built.settings.set('siloApiKey', 'private-key');
    built.settings.set('siloProfileId', 'profile-1');
    let invocation = 0;
    let markFirstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve;
    });
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const connection = vi.spyOn(built.silo, 'testConnection')
      .mockImplementation(async () => {
        invocation += 1;
        const current = invocation;
        if (current === 1) {
          markFirstStarted();
          await firstGate;
        }
        return {
          health: { status: 'ok', server_name: 'Silo' },
          profiles: [{
            id: current === 1 ? 'profile-1' : 'profile-2',
            name: current === 1 ? 'Old' : 'Fresh'
          }]
        };
      });

    const oldRequest = built.systemDiagnostics.snapshot(true);
    await firstStarted;
    built.settings.set('siloProfileId', 'profile-2');
    built.systemDiagnostics.invalidate();
    const fresh = await built.systemDiagnostics.snapshot();
    releaseFirst();
    await oldRequest;

    expect(connection).toHaveBeenCalledTimes(2);
    expect(await built.systemDiagnostics.snapshot()).toBe(fresh);
    expect(fresh.checks).toContainEqual(expect.objectContaining({
      id: 'silo',
      status: 'healthy',
      summary: expect.stringContaining('Fresh')
    }));
  });

  it('surfaces sanitized live scanner phase and progress', async () => {
    vi.spyOn(built.scanner, 'snapshot').mockReturnValue({
      mode: 'full',
      phase: 'processing',
      status: 'running',
      startedAt: Date.now() - 5_000,
      elapsedMs: 5_000,
      discovered: 20,
      examined: 7,
      processed: 5,
      matched: 7,
      unmatched: 0,
      errors: 0,
      progressPercent: 35,
      cancelRequested: false
    });

    const snapshot = await built.systemDiagnostics.snapshot(true);

    expect(snapshot.operations.scanner).toEqual({
      running: true,
      phase: 'processing',
      progressPercent: 35
    });
    expect(snapshot.checks).toContainEqual(expect.objectContaining({
      id: 'scanner',
      status: 'healthy',
      summary: 'A full scan is processing; 7 of 20 files examined.'
    }));
  });

  it('reports inaccessible roots and recent failures without leaking sensitive values', async () => {
    const privatePath = path.join(directory, 'secret-missing-movies');
    built.settings.set('moviesPath', privatePath);
    built.settings.set('siloEnabled', 'true');
    built.settings.set('siloUrl', 'http://private-silo.internal:8080');
    built.settings.set('siloApiKey', 'private-silo-key');
    built.settings.set('siloProfileId', 'missing-profile');
    vi.spyOn(built.silo, 'testConnection').mockRejectedValue(
      new Error('Connection to http://private-silo.internal:8080?token=private-silo-key failed')
    );
    built.playbackOutcomes.record({
      playbackId: 'playback-1',
      code: 'capacity_unavailable',
      provider: 'silo',
      route: 'server_transcode_hls',
      level: 'warning',
      failureDomain: 'capacity',
      reason: 'capacity_unavailable'
    });
    built.systemDiagnostics.invalidate();

    const snapshot = await built.systemDiagnostics.snapshot(true);
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.status).toBe('unhealthy');
    expect(snapshot.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'movies_root', status: 'error' }),
      expect.objectContaining({ id: 'silo', status: 'error' }),
      expect.objectContaining({ id: 'playback_outcomes', status: 'warning' })
    ]));
    expect(snapshot.recentOutcomes).toMatchObject({
      total: 1,
      warnings: 1,
      errors: 0,
      byFailureDomain: { capacity: 1 }
    });
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('private-silo.internal');
    expect(serialized).not.toContain('private-silo-key');
  });

  it('checks saved Jellyfin and Plex identities without exposing credentials or IDs', async () => {
    built.settings.set('jellyfinEnabled', 'true');
    built.settings.set('jellyfinUrl', 'http://private-jellyfin.internal:8096');
    built.settings.set('jellyfinApiKey', 'private-jellyfin-key');
    built.settings.set('jellyfinUserId', 'user-1');
    built.settings.set('plexEnabled', 'true');
    built.settings.set('plexUrl', 'http://private-plex.internal:32400');
    built.settings.set('plexToken', 'private-plex-token');
    vi.spyOn(built.playbackServers, 'testJellyfin').mockResolvedValue({
      server: {
        id: 'private-jellyfin-server-id',
        name: 'Jellyfin',
        version: '10.11.6',
        operatingSystem: 'Linux'
      },
      users: [{ id: 'user-1', name: 'Viewer', disabled: false }]
    });
    vi.spyOn(built.playbackServers, 'testPlex').mockResolvedValue({
      server: {
        id: 'private-plex-server-id',
        name: 'Plex',
        version: '1.42.2.10156'
      },
      libraries: [{ id: '1', name: 'Movies', type: 'movie' }]
    });
    built.systemDiagnostics.invalidate();

    const snapshot = await built.systemDiagnostics.snapshot(true);
    const serialized = JSON.stringify(snapshot);
    expect(snapshot.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'jellyfin',
        status: 'healthy',
        summary: expect.stringContaining('playback user Viewer')
      }),
      expect.objectContaining({
        id: 'plex',
        status: 'healthy',
        summary: expect.stringContaining('1 accessible library')
      })
    ]));
    for (const secret of [
      'private-jellyfin.internal',
      'private-jellyfin-key',
      'private-jellyfin-server-id',
      'user-1',
      'private-plex.internal',
      'private-plex-token',
      'private-plex-server-id'
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
