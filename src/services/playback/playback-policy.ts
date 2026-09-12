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
  reason: 'conservative_unknown_device' | 'explicit_device_overrides';
  requestProfile: SiloPlaybackRequestProfile;
  target: {
    maxResolution: string;
    videoCodec: 'h264';
    audioCodec: 'aac';
    maxAudioChannels: 2;
    dynamicRange: 'sdr' | 'hdr';
  };
}

function sourceResolutionCeiling(
  file: Pick<MediaFileRow, 'width' | 'height'>
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
 * Unknown devices still declare only conservative MP4/H.264/AAC/SDR support;
 * explicit user overrides can widen those claims. A fixed quality intentionally
 * offers only HLS so the administrator's requested encode rung remains binding.
 */
export function planSiloPlayback(
  file: Pick<MediaFileRow, 'width' | 'height'>,
  configuredQuality: string,
  deviceId: string,
  capabilitySnapshot?: DeviceCapabilitySnapshot
): PlaybackPolicyPlan {
  const qualityPreference = normalizeSiloQualityPreference(configuredQuality);
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
  const usedOverrides = videoCodecs.length > 1 ||
    audioCodecs.length > 1 || containers.length > 1 || hdr;
  const deliveryCapability = (
    deliveryContainers: string[]
  ): SiloDeliveryCapability => ({
    enabled: true,
    supported_on_device: true,
    containers: deliveryContainers,
    video_codecs: videoCodecs,
    audio_decode_codecs: audioCodecs,
    audio_passthrough_codecs: [],
    max_channels: 2,
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
    original_http: deliveryCapability(containers),
    progressive: deliveryCapability(['mp4']),
    hls
  };
  const auto = qualityPreference === 'auto';

  return {
    mode: auto
      ? 'auto-silo'
      : 'fixed-silo-hls',
    reason: usedOverrides
      ? 'explicit_device_overrides'
      : 'conservative_unknown_device',
    requestProfile: {
      qualityPreference,
      clientCapabilities: {
        video_evidence: 'declared',
        audio_evidence: 'declared',
        codecs_video: videoCodecs,
        codecs_video_hardware: videoCodecs,
        codecs_audio: audioCodecs,
        containers: auto ? [...containers, 'hls'] : ['hls'],
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
      dynamicRange: hdr ? 'hdr' : 'sdr'
    }
  };
}
