import type { MediaFileRow } from '../../types.js';
import type { DeviceCapabilitySnapshot } from './device-capabilities.js';

export const siloQualityPreferences = [
  'auto',
  '2160p-high',
  '2160p-medium',
  '2160p-low',
  '1080p-high',
  '1080p-medium',
  '1080p-low',
  '720p-high',
  '720p-medium',
  '720p-low',
  '480p'
] as const;

export type SiloQualityPreference = typeof siloQualityPreferences[number];

export interface SiloPlaybackRequestProfile {
  qualityPreference: SiloQualityPreference;
  clientCapabilities: {
    video_evidence: 'declared';
    audio_evidence: 'declared';
    codecs_video: string[];
    codecs_video_hardware: string[];
    codecs_audio: string[];
    containers: string[];
    max_resolution: string;
    hdr: boolean;
  };
  clientPlaybackContext: {
    form_factor: string;
    device: {
      platform: string;
      os_version: string;
      manufacturer: string;
      model: string;
      platform_details: Record<string, string>;
    };
    output: {
      output_context_id: string;
    };
    deliveries: {
      original_http?: SiloDeliveryCapability;
      progressive?: SiloDeliveryCapability;
      hls?: SiloDeliveryCapability;
    };
  };
}

export interface SiloDeliveryCapability {
  enabled: boolean;
  supported_on_device: boolean;
  containers: string[];
  video_codecs: string[];
  audio_decode_codecs: string[];
  audio_passthrough_codecs: string[];
  max_channels: number;
  subtitles: {
    embedded_text: boolean;
    sidecar_text: boolean;
    ass_styling: boolean;
    embedded_bitmap: boolean;
    sidecar_bitmap: boolean;
    font_attachments: boolean;
  };
  features: string[];
  auth_header_refresh: boolean;
  validated_claims: string[];
  transformations: unknown[];
}

export interface PlaybackPolicyPlan {
  mode: 'auto-silo' | 'fixed-silo-hls';
  reason:
    | 'conservative_unknown_device'
    | 'source_direct_first'
    | 'explicit_device_overrides';
  requestProfile: SiloPlaybackRequestProfile;
  target: {
    maxResolution: string;
    videoCodec: 'h264';
    audioCodec: 'aac';
    maxAudioChannels: 2;
    dynamicRange: 'sdr' | 'hdr';
    likelyVideoTranscode: boolean;
  };
}

type PlaybackSource = Pick<MediaFileRow, 'width' | 'height'> &
  Partial<Pick<
    MediaFileRow,
    'relative_path' | 'video_codec' | 'audio_codec' | 'audio_channels'
  >>;

function sourceContainer(file: PlaybackSource): string | null {
  const extension = file.relative_path?.split('.').pop()?.toLowerCase();

  if (extension === 'mkv' || extension === 'mk3d') return 'mkv';
  if (extension === 'mp4' || extension === 'm4v') return 'mp4';
  if (extension === 'webm') return 'webm';
  if (['ts', 'm2ts', 'mts'].includes(extension || '')) return 'mpegts';
  return null;
}

function sourceVideoCodec(value: string | null | undefined): string | null {
  const codec = value?.trim().toLowerCase();

  if (['h264', 'avc', 'avc1'].includes(codec || '')) return 'h264';
  if (['hevc', 'h265', 'hev1', 'hvc1'].includes(codec || '')) return 'hevc';
  if (['av1', 'av01'].includes(codec || '')) return 'av1';
  if (['vp9', 'vp09'].includes(codec || '')) return 'vp9';
  return null;
}

function sourceAudioCodec(value: string | null | undefined): string | null {
  const codec = value?.trim().toLowerCase();

  if (['aac', 'mp4a'].includes(codec || '')) return 'aac';
  if (['ac3', 'ac-3'].includes(codec || '')) return 'ac3';
  if (['eac3', 'e-ac-3'].includes(codec || '')) return 'eac3';
  if (codec === 'opus') return 'opus';
  if (['dts', 'dca'].includes(codec || '')) return 'dts';
  if (['dts-hd', 'dts_hd'].includes(codec || '')) return 'dts-hd';
  if (['truehd', 'mlp'].includes(codec || '')) return 'truehd';
  return null;
}

function sourceResolutionCeiling(
  file: PlaybackSource
): string {
  const width = file.width || 0;
  const height = file.height || 0;

  if (width > 1920 || height > 1080) return '2160p';
  if (width > 1280 || height > 720) return '1080p';
  if (width > 854 || height > 480) return '720p';
  return height > 0 || width > 0 ? '480p' : '1080p';
}

export function normalizeSiloQualityPreference(
  value: string
): SiloQualityPreference {
  return (siloQualityPreferences as readonly string[]).includes(value)
    ? value as SiloQualityPreference
    : 'auto';
}

/**
 * Initial policy for devices without measured capabilities.
 *
 * Auto offers Silo's original, progressive-remux, and HLS delivery classes.
 * Its original route includes the scanned source traits so Silo can try the
 * byte-for-byte file before spending resources on conversion. Progressive and
 * HLS retain conservative compatibility targets, while explicit device
 * overrides can widen them. A fixed quality intentionally offers only HLS so
 * the administrator's requested encode rung remains binding.
 */
export function planSiloPlayback(
  file: PlaybackSource,
  configuredQuality: string,
  deviceId: string,
  capabilitySnapshot?: DeviceCapabilitySnapshot
): PlaybackPolicyPlan {
  const qualityPreference = normalizeSiloQualityPreference(configuredQuality);
  const auto = qualityPreference === 'auto';
  const maxResolution = sourceResolutionCeiling(file);
  const userOverrides = capabilitySnapshot?.capabilities.filter(
    capability => capability.evidence === 'user_override' && capability.supported
  ) || [];
  const supportedVideoCodecs = new Set(['h264']);
  const supportedAudioCodecs = new Set(['aac']);
  const supportedContainers = new Set(['mp4']);
  const allowedVideoCodecs = new Set(['h264', 'hevc', 'av1', 'vp9']);
  const allowedAudioCodecs = new Set([
    'aac', 'ac3', 'eac3', 'opus', 'dts', 'dts-hd', 'truehd'
  ]);
  const allowedContainers = new Set(['mkv', 'mp4', 'webm', 'mpegts']);

  for (const override of userOverrides) {
    if (
      override.category === 'video_codec' &&
      allowedVideoCodecs.has(override.capability)
    ) {
      supportedVideoCodecs.add(override.capability);
    }
    if (
      override.category === 'audio_codec' &&
      allowedAudioCodecs.has(override.capability)
    ) {
      supportedAudioCodecs.add(override.capability);
    }
    if (
      override.category === 'container' &&
      allowedContainers.has(override.capability)
    ) {
      supportedContainers.add(override.capability);
    }
  }

  const hdr = userOverrides.some(
    override => override.category === 'hdr' &&
      ['hdr10', 'hdr10+', 'dolby_vision'].includes(override.capability)
  );
  const videoCodecs = [...supportedVideoCodecs];
  const audioCodecs = [...supportedAudioCodecs];
  const containers = [...supportedContainers];
  const directVideoCodecs = new Set(videoCodecs);
  const directAudioCodecs = new Set(audioCodecs);
  const directContainers = new Set(containers);
  const scannedVideoCodec = auto ? sourceVideoCodec(file.video_codec) : null;
  const scannedAudioCodec = auto ? sourceAudioCodec(file.audio_codec) : null;
  const scannedContainer = auto ? sourceContainer(file) : null;
  const likelyVideoTranscode = Boolean(
    auto &&
    scannedVideoCodec &&
    !supportedVideoCodecs.has(scannedVideoCodec)
  );

  if (scannedVideoCodec) directVideoCodecs.add(scannedVideoCodec);
  if (scannedAudioCodec) directAudioCodecs.add(scannedAudioCodec);
  if (scannedContainer) directContainers.add(scannedContainer);

  const usedSourceHints = Boolean(
    scannedVideoCodec || scannedAudioCodec || scannedContainer
  );
  const usedOverrides = videoCodecs.length > 1 ||
    audioCodecs.length > 1 || containers.length > 1 || hdr;
  const deliveryCapability = (
    deliveryContainers: string[],
    deliveryVideoCodecs = videoCodecs,
    deliveryAudioCodecs = audioCodecs,
    maxChannels = 2
  ): SiloDeliveryCapability => ({
    enabled: true,
    supported_on_device: true,
    containers: deliveryContainers,
    video_codecs: deliveryVideoCodecs,
    audio_decode_codecs: deliveryAudioCodecs,
    audio_passthrough_codecs: [],
    max_channels: maxChannels,
    subtitles: {
      embedded_text: false,
      sidecar_text: true,
      ass_styling: false,
      embedded_bitmap: false,
      sidecar_bitmap: false,
      font_attachments: false
    },
    features: [],
    auth_header_refresh: true,
    validated_claims: [],
    transformations: []
  });
  const hls = deliveryCapability(['hls']);
  const autoDeliveries = {
    original_http: deliveryCapability(
      [...directContainers],
      [...directVideoCodecs],
      [...directAudioCodecs],
      Math.max(2, file.audio_channels || 0)
    ),
    progressive: deliveryCapability(
      ['mp4'],
      [...directVideoCodecs],
      audioCodecs
    ),
    hls
  };

  return {
    mode: auto
      ? 'auto-silo'
      : 'fixed-silo-hls',
    reason: usedOverrides
      ? 'explicit_device_overrides'
      : usedSourceHints
        ? 'source_direct_first'
        : 'conservative_unknown_device',
    requestProfile: {
      qualityPreference,
      clientCapabilities: {
        video_evidence: 'declared',
        audio_evidence: 'declared',
        codecs_video: auto ? [...directVideoCodecs] : videoCodecs,
        codecs_video_hardware: auto ? [...directVideoCodecs] : videoCodecs,
        codecs_audio: auto ? [...directAudioCodecs] : audioCodecs,
        containers: auto ? [...directContainers, 'hls'] : ['hls'],
        max_resolution: maxResolution,
        hdr
      },
      clientPlaybackContext: {
        form_factor: 'unknown',
        device: {
          platform: 'server_proxy',
          os_version: '',
          manufacturer: 'Nuvi-Flow',
          model: 'Playback Proxy',
          platform_details: {
            policy: usedOverrides
              ? 'explicit_overrides_v1'
              : usedSourceHints
                ? 'source_direct_first_v1'
                : 'conservative_auto_v1'
          }
        },
        output: {
          output_context_id: deviceId
        },
        deliveries: auto ? autoDeliveries : { hls }
      }
    },
    target: {
      maxResolution,
      videoCodec: 'h264',
      audioCodec: 'aac',
      maxAudioChannels: 2,
      dynamicRange: hdr ? 'hdr' : 'sdr',
      likelyVideoTranscode
    }
  };
}
