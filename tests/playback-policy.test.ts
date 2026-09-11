import { describe, expect, it } from 'vitest';
import {
  normalizeSiloQualityPreference,
  planSiloPlayback
} from '../src/services/playback/playback-policy.js';

describe('conservative Silo playback policy', () => {
  const deviceId = 'device_1234567890abcdef12345678';

  it('preserves the 4K resolution class without claiming unknown HEVC or HDR support', () => {
    const plan = planSiloPlayback(
      { width: 3840, height: 2160 },
      'auto',
      deviceId
    );

    expect(plan).toMatchObject({
      mode: 'auto-silo-hls',
      reason: 'conservative_unknown_device',
      target: {
        maxResolution: '2160p',
        videoCodec: 'h264',
        audioCodec: 'aac',
        maxAudioChannels: 2,
        dynamicRange: 'sdr'
      },
      requestProfile: {
        qualityPreference: 'auto',
        clientCapabilities: {
          video_evidence: 'declared',
          audio_evidence: 'declared',
          codecs_video: ['h264'],
          codecs_video_hardware: ['h264'],
          codecs_audio: ['aac'],
          containers: ['hls'],
          max_resolution: '2160p',
          hdr: false
        },
        clientPlaybackContext: {
          output: { output_context_id: deviceId },
          deliveries: {
            hls: {
              enabled: true,
              supported_on_device: true,
              video_codecs: ['h264'],
              audio_decode_codecs: ['aac'],
              audio_passthrough_codecs: [],
              max_channels: 2
            }
          }
        }
      }
    });
    expect(Object.keys(plan.requestProfile.clientPlaybackContext.deliveries))
      .toEqual(['hls']);
  });

  it('uses the source resolution class for smaller media', () => {
    expect(planSiloPlayback(
      { width: 1920, height: 1080 }, 'auto', deviceId
    ).target.maxResolution).toBe('1080p');
    expect(planSiloPlayback(
      { width: 1280, height: 720 }, 'auto', deviceId
    ).target.maxResolution).toBe('720p');
  });

  it('preserves a valid administrator fixed-quality override', () => {
    const plan = planSiloPlayback(
      { width: 3840, height: 2160 },
      '1080p-medium',
      deviceId
    );

    expect(plan.mode).toBe('fixed-silo-hls');
    expect(plan.requestProfile.qualityPreference).toBe('1080p-medium');
  });

  it('normalizes an invalid configured quality to Auto', () => {
    expect(normalizeSiloQualityPreference('not-a-rung')).toBe('auto');
  });
});
