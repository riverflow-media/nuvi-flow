import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/index.js';
import type {
  DeviceCapabilityCategory,
  DeviceCapabilityEvidence,
  DeviceCapabilityRow,
  PlaybackDeviceRow
} from '../../types.js';

export type DeviceCapabilityState = 'unknown' | 'supported' | 'unsupported';

export const DEVICE_CAPABILITY_MIN_OBSERVATIONS = 3;
export const DEVICE_CAPABILITY_CONFIDENCE_THRESHOLD = 0.6;
export const DEVICE_CAPABILITY_DECAY_HALF_LIFE_MS = 90 * 24 * 60 * 60_000;

export interface DeviceCapability {
  category: DeviceCapabilityCategory;
  capability: string;
  supported: boolean;
  state: DeviceCapabilityState;
  evidence: DeviceCapabilityEvidence;
  confidence: number;
  successCount: number;
  failureCount: number;
  firstObservedAt: number;
  lastObservedAt: number;
  updatedAt: number;
}

export interface DeviceCapabilitySnapshot {
  deviceId: string;
  revision: string;
  capabilities: DeviceCapability[];
}

export interface CapabilityEvidenceInput {
  category: DeviceCapabilityCategory;
  capability: string;
  supported: boolean;
  evidence: Exclude<DeviceCapabilityEvidence, 'user_override'>;
  confidence: number;
}

export interface PlaybackDeviceCapabilitySummary {
  id: string;
  identitySource: string;
  firstSeenAt: number;
  lastSeenAt: number;
  revision: string;
  capabilities: DeviceCapability[];
}

interface DeviceCapabilityStoreOptions {
  now?: () => number;
  decayHalfLifeMs?: number;
}

function normalizeCapability(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_');

  if (!normalized || normalized.length > 80) {
    throw new Error('Capability names must contain between 1 and 80 characters.');
  }

  return normalized;
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function observationConfidence(successes: number, failures: number): number {
  const total = successes + failures;
  if (total <= 0) return 0;
  // Three independent successes must clear the trust threshold with enough
  // margin that a few milliseconds of age do not immediately revoke them.
  const sampleConfidence = Math.min(1, total / 4);
  const agreement = Math.abs(successes - failures) / total;
  return normalizeConfidence(sampleConfidence * agreement);
}

function observationState(
  successes: number,
  failures: number,
  confidence: number
): DeviceCapabilityState {
  if (confidence < DEVICE_CAPABILITY_CONFIDENCE_THRESHOLD) return 'unknown';
  if (
    successes >= DEVICE_CAPABILITY_MIN_OBSERVATIONS &&
    successes - failures >= DEVICE_CAPABILITY_MIN_OBSERVATIONS
  ) return 'supported';
  if (
    failures >= DEVICE_CAPABILITY_MIN_OBSERVATIONS &&
    failures - successes >= DEVICE_CAPABILITY_MIN_OBSERVATIONS
  ) return 'unsupported';
  return 'unknown';
}

function dominantObservation(
  successes: number,
  failures: number
): { supported: boolean; evidence: 'observed_success' | 'observed_failure' } {
  return successes >= failures
    ? { supported: true, evidence: 'observed_success' }
    : { supported: false, evidence: 'observed_failure' };
}

function toCapability(
  row: DeviceCapabilityRow,
  now: number,
  decayHalfLifeMs: number
): DeviceCapability {
  const override = row.evidence === 'user_override';
  const observed = row.evidence === 'observed_success' ||
    row.evidence === 'observed_failure';
  const age = Math.max(0, now - row.last_observed_at);
  const decay = observed && decayHalfLifeMs > 0
    ? Math.pow(0.5, age / decayHalfLifeMs)
    : 1;
  const confidence = normalizeConfidence(row.confidence * decay);
  const state: DeviceCapabilityState = override
    ? row.supported ? 'supported' : 'unsupported'
    : observed
      ? observationState(row.success_count, row.failure_count, confidence)
      : 'unknown';

  return {
    category: row.category,
    capability: row.capability,
    supported: Boolean(row.supported),
    state,
    evidence: row.evidence,
    confidence,
    successCount: row.success_count,
    failureCount: row.failure_count,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at
  };
}

function snapshotRevision(capabilities: DeviceCapability[]): string {
  // Session keys should change only when playback policy can change. Raw
  // counters and below-threshold observations are deliberately excluded so a
  // learning update cannot create a duplicate session mid-playback.
  const canonical = capabilities
    .filter(capability => capability.state !== 'unknown')
    .map(capability => ({
      category: capability.category,
      capability: capability.capability,
      state: capability.state,
      source: capability.evidence === 'user_override'
        ? 'override'
        : 'learned'
    }));

  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * Persistent capability evidence for pseudonymous playback devices.
 *
 * Raw user-agent, IP, and client-header values never enter this store. A
 * user override is protected from automatic evidence updates until it is
 * explicitly cleared.
 */
export class DeviceCapabilityStore {
  private readonly now: () => number;
  private readonly decayHalfLifeMs: number;

  constructor(
    private readonly database: AppDatabase,
    options: DeviceCapabilityStoreOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.decayHalfLifeMs = options.decayHalfLifeMs ??
      DEVICE_CAPABILITY_DECAY_HALF_LIFE_MS;
  }

  touchDevice(deviceId: string, identitySource: string, now = this.now()): void {
    this.database.sqlite.prepare(
      `INSERT INTO playback_devices (id,identity_source,first_seen_at,last_seen_at)
       VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         identity_source=CASE
           WHEN excluded.identity_source='signed_stream_token'
             THEN playback_devices.identity_source
           ELSE excluded.identity_source
         END,
         last_seen_at=excluded.last_seen_at`
    ).run(deviceId, identitySource, now, now);
  }

  getSnapshot(deviceId: string, now = this.now()): DeviceCapabilitySnapshot {
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM device_capabilities
       WHERE device_id=?
       ORDER BY category,capability`
    ).all(deviceId) as DeviceCapabilityRow[];
    const capabilities = rows.map(row => toCapability(
      row,
      now,
      this.decayHalfLifeMs
    ));

    return {
      deviceId,
      revision: snapshotRevision(capabilities),
      capabilities
    };
  }

  listDevices(now = this.now()): PlaybackDeviceCapabilitySummary[] {
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM playback_devices ORDER BY last_seen_at DESC, id`
    ).all() as PlaybackDeviceRow[];

    return rows.map(row => {
      const snapshot = this.getSnapshot(row.id, now);
      return {
        id: row.id,
        identitySource: row.identity_source,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        revision: snapshot.revision,
        capabilities: snapshot.capabilities
      };
    });
  }

  setUserOverride(
    deviceId: string,
    category: DeviceCapabilityCategory,
    capability: string,
    supported: boolean,
    now = this.now()
  ): void {
    const normalized = normalizeCapability(capability);
    this.database.sqlite.prepare(
      `INSERT INTO device_capabilities (
        device_id,category,capability,supported,evidence,confidence,
        success_count,failure_count,first_observed_at,last_observed_at,updated_at
      ) VALUES (?,?,?,?,?,1,0,0,?,?,?)
      ON CONFLICT(device_id,category,capability) DO UPDATE SET
        supported=excluded.supported,
        evidence='user_override',
        confidence=1,
        updated_at=excluded.updated_at`
    ).run(
      deviceId,
      category,
      normalized,
      supported ? 1 : 0,
      'user_override',
      now,
      now,
      now
    );
  }

  clearUserOverride(
    deviceId: string,
    category: DeviceCapabilityCategory,
    capability: string,
    now = this.now()
  ): boolean {
    const normalized = normalizeCapability(capability);
    const row = this.database.sqlite.prepare(
      `SELECT * FROM device_capabilities
       WHERE device_id=? AND category=? AND capability=?`
    ).get(deviceId, category, normalized) as DeviceCapabilityRow | undefined;
    if (!row || row.evidence !== 'user_override') return false;

    if (row.success_count + row.failure_count === 0) {
      this.database.sqlite.prepare(
        `DELETE FROM device_capabilities
         WHERE device_id=? AND category=? AND capability=?`
      ).run(deviceId, category, normalized);
      return true;
    }

    const dominant = dominantObservation(row.success_count, row.failure_count);
    this.database.sqlite.prepare(
      `UPDATE device_capabilities SET
         supported=?,evidence=?,confidence=?,updated_at=?
       WHERE device_id=? AND category=? AND capability=?`
    ).run(
      dominant.supported ? 1 : 0,
      dominant.evidence,
      observationConfidence(row.success_count, row.failure_count),
      now,
      deviceId,
      category,
      normalized
    );
    return true;
  }

  recordEvidence(
    deviceId: string,
    input: CapabilityEvidenceInput,
    now = this.now()
  ): void {
    const capability = normalizeCapability(input.capability);
    const successIncrement = input.evidence === 'observed_success' ? 1 : 0;
    const failureIncrement = input.evidence === 'observed_failure' ? 1 : 0;
    const existing = this.database.sqlite.prepare(
      `SELECT * FROM device_capabilities
       WHERE device_id=? AND category=? AND capability=?`
    ).get(deviceId, input.category, capability) as DeviceCapabilityRow | undefined;
    if (
      input.evidence === 'declared' &&
      existing &&
      existing.evidence !== 'declared'
    ) return;
    const successCount = (existing?.success_count || 0) + successIncrement;
    const failureCount = (existing?.failure_count || 0) + failureIncrement;
    const observed = successIncrement > 0 || failureIncrement > 0;
    const dominant = observed
      ? dominantObservation(successCount, failureCount)
      : { supported: input.supported, evidence: input.evidence };
    const protectedOverride = existing?.evidence === 'user_override';
    const supported = protectedOverride
      ? Boolean(existing.supported)
      : dominant.supported;
    const evidence = protectedOverride
      ? existing.evidence
      : dominant.evidence;
    const confidence = protectedOverride
      ? existing.confidence
      : observed
        ? observationConfidence(successCount, failureCount)
        : normalizeConfidence(input.confidence);

    this.database.sqlite.prepare(
      `INSERT INTO device_capabilities (
        device_id,category,capability,supported,evidence,confidence,
        success_count,failure_count,first_observed_at,last_observed_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(device_id,category,capability) DO UPDATE SET
        supported=excluded.supported,
        evidence=excluded.evidence,
        confidence=excluded.confidence,
        success_count=excluded.success_count,
        failure_count=excluded.failure_count,
        last_observed_at=excluded.last_observed_at,
        updated_at=excluded.updated_at`
    ).run(
      deviceId,
      input.category,
      capability,
      supported ? 1 : 0,
      evidence,
      confidence,
      successCount,
      failureCount,
      existing?.first_observed_at || now,
      now,
      now
    );
  }
}
