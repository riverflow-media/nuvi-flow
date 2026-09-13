import { Transform, type TransformCallback } from 'node:stream';
import type {
  DeviceCapabilityCategory
} from '../../types.js';
import type {
  DeviceCapabilityStore
} from './device-capabilities.js';
import {
  sourceContainer,
  sourceResolutionCeiling,
  sourceVideoCodec,
  type PlaybackSource
} from './playback-policy.js';
import type { PlaybackPlanSummary } from './playback-sessions.js';

const DEFAULT_MIN_TRANSFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_MIN_TRANSFER_MS = 30_000;
const DEFAULT_MIN_MEDIA_SECONDS = 45;
const DEFAULT_MAX_IDLE_GAP_MS = 5_000;
const PLAYBACK_DEDUPLICATION_MS = 24 * 60 * 60_000;

export interface PlaybackCapabilityClaim {
  category: DeviceCapabilityCategory;
  capability: string;
}

interface CapabilityLearningOptions {
  now?: () => number;
  minTransferBytes?: number;
  minTransferMs?: number;
  minMediaSeconds?: number;
  maxIdleGapMs?: number;
  onError?: (error: unknown) => void;
}

export interface CapabilityTransferInput {
  playbackId: string;
  deviceId: string;
  bitrate: number | null;
  claims: PlaybackCapabilityClaim[];
}

function sourceHdrCapability(file: PlaybackSource): string | null {
  const probe = file.probe_json?.toLowerCase() || '';
  if (!probe) return null;

  // Dolby Vision and HDR10+ releases can contain a base-layer fallback. A
  // successful transfer cannot prove which layer the player decoded, so only
  // plain HDR10/PQ is eligible for automatic learning.
  if (
    probe.includes('dovi') ||
    probe.includes('dolby vision') ||
    probe.includes('hdr10+') ||
    probe.includes('smpte2094')
  ) return null;
  return probe.includes('smpte2084') || probe.includes('smpte st 2084')
    ? 'hdr10'
    : null;
}

function uniqueClaims(
  claims: PlaybackCapabilityClaim[]
): PlaybackCapabilityClaim[] {
  const seen = new Set<string>();
  return claims.filter(claim => {
    const key = `${claim.category}:${claim.capability}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sourcePlaybackCapabilityClaims(
  file: PlaybackSource
): PlaybackCapabilityClaim[] {
  const claims: PlaybackCapabilityClaim[] = [];
  const videoCodec = sourceVideoCodec(file.video_codec);
  const container = sourceContainer(file);
  const hdr = sourceHdrCapability(file);

  if (videoCodec && videoCodec !== 'h264') {
    claims.push({ category: 'video_codec', capability: videoCodec });
  }
  if (container && container !== 'mp4') {
    claims.push({ category: 'container', capability: container });
  }
  if (hdr) claims.push({ category: 'hdr', capability: hdr });
  if (sourceResolutionCeiling(file) === '2160p') {
    claims.push({ category: 'max_resolution', capability: '2160p' });
  }

  return uniqueClaims(claims);
}

export function deliveredPlaybackCapabilityClaims(
  file: PlaybackSource,
  delivery: string,
  summary?: PlaybackPlanSummary
): PlaybackCapabilityClaim[] {
  if (delivery === 'original_http') {
    return sourcePlaybackCapabilityClaims(file);
  }

  const claims: PlaybackCapabilityClaim[] = [];
  const videoCodec = sourceVideoCodec(summary?.videoCodec);
  if (videoCodec && videoCodec !== 'h264') {
    claims.push({ category: 'video_codec', capability: videoCodec });
  }
  if ((summary?.height || 0) > 1080 || (summary?.width || 0) > 1920) {
    claims.push({ category: 'max_resolution', capability: '2160p' });
  }
  if (
    summary?.dynamicRange?.toLowerCase().includes('hdr') &&
    sourceHdrCapability(file) === 'hdr10'
  ) {
    claims.push({ category: 'hdr', capability: 'hdr10' });
  }
  return uniqueClaims(claims);
}

/**
 * Converts sustained, successful delivery into low-risk positive capability
 * evidence. It deliberately has no automatic failure path: transport and
 * transcoder problems are too ambiguous to blacklist a device.
 */
export class PlaybackCapabilityLearner {
  private readonly completedPlaybacks = new Map<string, number>();
  private readonly now: () => number;
  private readonly minTransferBytes: number;
  private readonly minTransferMs: number;
  private readonly minMediaSeconds: number;
  private readonly maxIdleGapMs: number;
  private readonly onError: ((error: unknown) => void) | null;

  constructor(
    private readonly capabilities: DeviceCapabilityStore,
    options: CapabilityLearningOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.minTransferBytes = options.minTransferBytes ??
      DEFAULT_MIN_TRANSFER_BYTES;
    this.minTransferMs = options.minTransferMs ?? DEFAULT_MIN_TRANSFER_MS;
    this.minMediaSeconds = options.minMediaSeconds ??
      DEFAULT_MIN_MEDIA_SECONDS;
    this.maxIdleGapMs = options.maxIdleGapMs ?? DEFAULT_MAX_IDLE_GAP_MS;
    this.onError = options.onError ?? null;
  }

  recordSuccessfulPlayback(
    playbackId: string,
    deviceId: string,
    claims: PlaybackCapabilityClaim[]
  ): boolean {
    const eligible = uniqueClaims(claims);
    if (!eligible.length) return false;
    const now = this.now();
    this.cleanup(now);
    if (this.completedPlaybacks.has(playbackId)) return false;
    // Mark the playback before writing so a partial database failure cannot
    // repeatedly increment the same evidence on later segment requests.
    this.completedPlaybacks.set(playbackId, now);
    try {
      this.capabilities.touchDevice(deviceId, 'signed_stream_token', now);
      for (const claim of eligible) {
        this.capabilities.recordEvidence(deviceId, {
          ...claim,
          supported: true,
          evidence: 'observed_success',
          confidence: 1
        }, now);
      }
    } catch (error) {
      try {
        this.onError?.(error);
      } catch {
        // Learning and its diagnostic callback must remain off the playback
        // failure path.
      }
      return false;
    }
    return true;
  }

  createTransferMeter(input: CapabilityTransferInput): Transform | null {
    if (!input.claims.length || !input.bitrate || input.bitrate <= 0) return null;
    const startedAt = this.now();
    let lastChunkAt = startedAt;
    let bytes = 0;
    let interrupted = false;
    const meter = new Transform({
      transform: (
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback
      ) => {
        const now = this.now();
        if (bytes > 0 && now - lastChunkAt > this.maxIdleGapMs) {
          interrupted = true;
        }
        lastChunkAt = now;
        bytes += chunk.length;
        callback(null, chunk);
      }
    });
    meter.once('end', () => {
      const elapsedMs = this.now() - startedAt;
      const mediaSeconds = bytes * 8 / input.bitrate!;
      if (
        interrupted ||
        bytes < this.minTransferBytes ||
        elapsedMs < this.minTransferMs ||
        mediaSeconds < this.minMediaSeconds
      ) return;
      this.recordSuccessfulPlayback(
        input.playbackId,
        input.deviceId,
        input.claims
      );
    });
    return meter;
  }

  close(): void {
    this.completedPlaybacks.clear();
  }

  private cleanup(now: number): void {
    for (const [playbackId, completedAt] of this.completedPlaybacks) {
      if (now - completedAt > PLAYBACK_DEDUPLICATION_MS) {
        this.completedPlaybacks.delete(playbackId);
      }
    }
  }
}
