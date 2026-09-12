import { createHmac } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import type { AppDatabase } from '../../db/index.js';
import type { PlaybackNetworkProfileRow } from '../../types.js';

const MIN_SAMPLE_BYTES = 2 * 1024 * 1024;
const MIN_SAMPLE_MS = 750;
const MAX_IDLE_GAP_MS = 2500;
const MIN_RELIABLE_SAMPLES = 3;

export interface NetworkEstimate {
  contextId: string;
  contextReliable: boolean;
  estimatedMbps: number;
  sampleCount: number;
  confidence: number;
}

function publicAddress(value: string): boolean {
  const ip = value.trim().toLowerCase();
  if (!ip || ip === '::1' || ip === '::' || ip.startsWith('fc') ||
    ip.startsWith('fd') || /^fe[89ab]/.test(ip)) return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return ip.includes(':');
  const [a, b] = match.slice(1).map(Number);
  return !(a === 0 || a === 10 || a === 127 || a! >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168));
}

function networkPrefix(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (value.includes(':')) return value.split(':').slice(0, 4).join(':');
  return value;
}

export class NetworkProfileStore {
  constructor(
    private readonly database: AppDatabase,
    private readonly secret: string,
    private readonly trustProxy: boolean,
    private readonly now: () => number = Date.now
  ) {}

  context(deviceId: string, ip: string): { id: string; reliable: boolean } {
    const reliable = this.trustProxy || publicAddress(ip);
    const id = createHmac('sha256', this.secret)
      .update(JSON.stringify([deviceId, networkPrefix(ip)]))
      .digest('hex')
      .slice(0, 24);
    return { id: `network_${id}`, reliable };
  }

  getEstimate(deviceId: string, ip: string): NetworkEstimate | null {
    const context = this.context(deviceId, ip);
    const row = this.database.sqlite.prepare(
      `SELECT * FROM playback_network_profiles
       WHERE device_id=? AND network_context_id=? AND expires_at>?`
    ).get(deviceId, context.id, this.now()) as PlaybackNetworkProfileRow | undefined;
    if (!row) return null;
    return {
      contextId: row.network_context_id,
      contextReliable: Boolean(row.context_reliable) && context.reliable,
      estimatedMbps: row.estimated_mbps,
      sampleCount: row.sample_count,
      confidence: row.confidence
    };
  }

  usableEstimateMbps(deviceId: string, ip: string): number | null {
    const estimate = this.getEstimate(deviceId, ip);
    return estimate?.contextReliable && estimate.sampleCount >= MIN_RELIABLE_SAMPLES &&
      estimate.confidence >= 0.6 ? estimate.estimatedMbps : null;
  }

  observe(deviceId: string, ip: string, bytes: number, elapsedMs: number): void {
    if (bytes < MIN_SAMPLE_BYTES || elapsedMs < MIN_SAMPLE_MS) return;
    const measuredMbps = Math.min(10_000, bytes * 8 / elapsedMs / 1000);
    if (!Number.isFinite(measuredMbps) || measuredMbps <= 0) return;
    const context = this.context(deviceId, ip);
    this.database.sqlite.prepare(
      'DELETE FROM playback_network_profiles WHERE expires_at<=?'
    ).run(this.now());
    const existing = this.database.sqlite.prepare(
      'SELECT * FROM playback_network_profiles WHERE device_id=? AND network_context_id=?'
    ).get(deviceId, context.id) as PlaybackNetworkProfileRow | undefined;
    const now = this.now();
    const sampleCount = Math.min(1000, (existing?.sample_count || 0) + 1);
    // Bias toward recent conditions without allowing one transient sample to
    // permanently redefine a device/network pair.
    const estimatedMbps = existing
      ? existing.estimated_mbps * 0.7 + measuredMbps * 0.3
      : measuredMbps;
    const confidence = Math.min(1, sampleCount / 5);
    this.database.sqlite.prepare(
      `INSERT INTO playback_network_profiles (
         device_id,network_context_id,context_reliable,estimated_mbps,
         sample_count,confidence,first_observed_at,last_observed_at,expires_at
       ) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(device_id,network_context_id) DO UPDATE SET
         context_reliable=excluded.context_reliable,
         estimated_mbps=excluded.estimated_mbps,
         sample_count=excluded.sample_count,
         confidence=excluded.confidence,
         last_observed_at=excluded.last_observed_at,
         expires_at=excluded.expires_at`
    ).run(
      deviceId, context.id, context.reliable ? 1 : 0, estimatedMbps,
      sampleCount, confidence, existing?.first_observed_at || now, now,
      now + 45 * 60_000
    );
  }

  meter(deviceId: string, ip: string, memoryMinutes: number): Transform {
    const startedAt = this.now();
    let lastChunkAt = startedAt;
    let bytes = 0;
    let paused = false;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) => {
        const now = this.now();
        if (bytes > 0 && now - lastChunkAt > MAX_IDLE_GAP_MS) paused = true;
        lastChunkAt = now;
        bytes += chunk.length;
        callback(null, chunk);
      }
    });
    meter.once('end', () => {
      if (paused) return;
      const elapsedMs = this.now() - startedAt;
      this.observe(deviceId, ip, bytes, elapsedMs);
      const context = this.context(deviceId, ip);
      this.database.sqlite.prepare(
        `UPDATE playback_network_profiles SET expires_at=?
         WHERE device_id=? AND network_context_id=?`
      ).run(this.now() + Math.max(10, Math.min(120, memoryMinutes)) * 60_000, deviceId, context.id);
    });
    return meter;
  }
}
