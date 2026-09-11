import type { MediaFileRow } from '../../types.js';

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
      hls: {
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
      };
    };
  };
}

export interface PlaybackPolicyPlan {
  mode: 'auto-silo-hls' | 'fixed-silo-hls';
  reason: 'conservative_unknown_device';
  requestProfile: SiloPlaybackRequestProfile;
  target: {
    maxResolution: string;
    videoCodec: 'h264';
    audioCodec: 'aac';
    maxAudioChannels: 2;
    dynamicRange: 'sdr';
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
 * It offers only HLS because Nuvi-Flow can safely proxy that delivery today.
 * H.264/AAC stereo are conservative decode declarations, not inferred device
 * facts. Silo can therefore copy compatible video, adapt audio independently,
 * or transcode incompatible video while retaining the source resolution class.
 */
export function planSiloPlayback(
  file: Pick<MediaFileRow, 'width' | 'height'>,
  configuredQuality: string,
  deviceId: string
): PlaybackPolicyPlan {
  const qualityPreference = normalizeSiloQualityPreference(configuredQuality);
  const maxResolution = sourceResolutionCeiling(file);
  const hls = {
    enabled: true,
    supported_on_device: true,
    containers: ['hls'],
    video_codecs: ['h264'],
    audio_decode_codecs: ['aac'],
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
  };

  return {
    mode: qualityPreference === 'auto'
      ? 'auto-silo-hls'
      : 'fixed-silo-hls',
    reason: 'conservative_unknown_device',
    requestProfile: {
      qualityPreference,
      clientCapabilities: {
        video_evidence: 'declared',
        audio_evidence: 'declared',
        codecs_video: ['h264'],
        codecs_video_hardware: ['h264'],
        codecs_audio: ['aac'],
        containers: ['hls'],
        max_resolution: maxResolution,
        hdr: false
      },
      clientPlaybackContext: {
        form_factor: 'unknown',
        device: {
          platform: 'server_proxy',
          os_version: '',
          manufacturer: 'Nuvi-Flow',
          model: 'HLS Proxy',
          platform_details: {
            policy: 'conservative_auto_v1'
          }
        },
        output: {
          output_context_id: deviceId
        },
        deliveries: { hls }
      }
    },
    target: {
      maxResolution,
      videoCodec: 'h264',
      audioCodec: 'aac',
      maxAudioChannels: 2,
      dynamicRange: 'sdr'
    }
  };
}
