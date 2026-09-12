import { createHash } from 'node:crypto';
import type { AppDatabase } from '../../db/index.js';
import type {
  DeviceCapabilityCategory,
  DeviceCapabilityEvidence,
  DeviceCapabilityRow
} from '../../types.js';

export interface DeviceCapability {
  category: DeviceCapabilityCategory;
  capability: string;
  supported: boolean;
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

function toCapability(row: DeviceCapabilityRow): DeviceCapability {
  return {
    category: row.category,
    capability: row.capability,
    supported: Boolean(row.supported),
    evidence: row.evidence,
    confidence: row.confidence,
    successCount: row.success_count,
    failureCount: row.failure_count,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    updatedAt: row.updated_at
  };
}

function snapshotRevision(capabilities: DeviceCapability[]): string {
  const canonical = capabilities.map(capability => ({
    category: capability.category,
    capability: capability.capability,
    supported: capability.supported,
    evidence: capability.evidence,
    confidence: capability.confidence,
    successCount: capability.successCount,
    failureCount: capability.failureCount,
    updatedAt: capability.updatedAt
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
  constructor(private readonly database: AppDatabase) {}

  touchDevice(deviceId: string, identitySource: string, now = Date.now()): void {
    this.database.sqlite.prepare(
      `INSERT INTO playback_devices (id,identity_source,first_seen_at,last_seen_at)
       VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         identity_source=excluded.identity_source,
         last_seen_at=excluded.last_seen_at`
    ).run(deviceId, identitySource, now, now);
  }

  getSnapshot(deviceId: string): DeviceCapabilitySnapshot {
    const rows = this.database.sqlite.prepare(
      `SELECT * FROM device_capabilities
       WHERE device_id=?
       ORDER BY category,capability`
    ).all(deviceId) as DeviceCapabilityRow[];
    const capabilities = rows.map(toCapability);

    return {
      deviceId,
      revision: snapshotRevision(capabilities),
      capabilities
    };
  }

  setUserOverride(
    deviceId: string,
    category: DeviceCapabilityCategory,
    capability: string,
    supported: boolean,
    now = Date.now()
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
        last_observed_at=excluded.last_observed_at,
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
    capability: string
  ): boolean {
    const result = this.database.sqlite.prepare(
      `DELETE FROM device_capabilities
       WHERE device_id=? AND category=? AND capability=? AND evidence='user_override'`
    ).run(deviceId, category, normalizeCapability(capability));
    return result.changes > 0;
  }

  recordEvidence(
    deviceId: string,
    input: CapabilityEvidenceInput,
    now = Date.now()
  ): void {
    const capability = normalizeCapability(input.capability);
    const successIncrement = input.evidence === 'observed_success' ? 1 : 0;
    const failureIncrement = input.evidence === 'observed_failure' ? 1 : 0;
    const supported = input.evidence === 'observed_success'
      ? true
      : input.evidence === 'observed_failure'
        ? false
        : input.supported;

    this.database.sqlite.prepare(
      `INSERT INTO device_capabilities (
        device_id,category,capability,supported,evidence,confidence,
        success_count,failure_count,first_observed_at,last_observed_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(device_id,category,capability) DO UPDATE SET
        supported=CASE WHEN device_capabilities.evidence='user_override'
          THEN device_capabilities.supported ELSE excluded.supported END,
        evidence=CASE WHEN device_capabilities.evidence='user_override'
          THEN device_capabilities.evidence ELSE excluded.evidence END,
        confidence=CASE WHEN device_capabilities.evidence='user_override'
          THEN device_capabilities.confidence ELSE excluded.confidence END,
        success_count=device_capabilities.success_count + excluded.success_count,
        failure_count=device_capabilities.failure_count + excluded.failure_count,
        last_observed_at=excluded.last_observed_at,
        updated_at=excluded.updated_at`
    ).run(
      deviceId,
      input.category,
      capability,
      supported ? 1 : 0,
      input.evidence,
      normalizeConfidence(input.confidence),
      successIncrement,
      failureIncrement,
      now,
      now,
      now
    );
  }
}
