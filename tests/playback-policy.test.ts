import { describe, expect, it } from 'vitest';
import {
  normalizeSiloQualityPreference,
  planSiloPlayback,
  selectAutoTranscodeFallback
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

  it('uses only explicit supported overrides as device capability claims', () => {
    const plan = planSiloPlayback(
      { width: 3840, height: 2160 },
      'auto',
      deviceId,
      {
        deviceId,
        revision: 'revision-1',
        capabilities: [
          {
            category: 'video_codec', capability: 'hevc', supported: true,
            evidence: 'user_override', confidence: 1, successCount: 0,
            failureCount: 0, firstObservedAt: 1, lastObservedAt: 1, updatedAt: 1
          },
          {
            category: 'hdr', capability: 'hdr10', supported: true,
            evidence: 'user_override', confidence: 1, successCount: 0,
            failureCount: 0, firstObservedAt: 1, lastObservedAt: 1, updatedAt: 1
          },
          {
            category: 'audio_codec', capability: 'truehd', supported: true,
            evidence: 'observed_success', confidence: .9, successCount: 3,
            failureCount: 0, firstObservedAt: 1, lastObservedAt: 1, updatedAt: 1
          }
        ]
      }
    );

    expect(plan.reason).toBe('explicit_device_overrides');
    expect(plan.requestProfile.clientCapabilities).toMatchObject({
      codecs_video: ['h264', 'hevc'],
      codecs_audio: ['aac'],
      hdr: true
    });
    expect(plan.target.dynamicRange).toBe('hdr');
  });

  it('normalizes an invalid configured quality to Auto', () => {
    expect(normalizeSiloQualityPreference('not-a-rung')).toBe('auto');
  });

  it('selects the highest advertised 1080p fallback for a full 4K Auto encode', () => {
    expect(selectAutoTranscodeFallback('auto', {
      delivery: 'server_transcode_hls',
      effective_recipe: { height: 2160 },
      available_qualities: [
        { label: 'original' },
        { label: '2160p-high' },
        { label: '1080p-medium' },
        { label: '720p-high' }
      ]
    })).toBe('1080p-medium');
  });

  it('retains 4K remuxes and administrator fixed-quality choices', () => {
    const plan = {
      delivery: 'server_remux_hls',
      effective_recipe: { height: 2160 },
      available_qualities: [{ label: '1080p-high' }]
    };
    expect(selectAutoTranscodeFallback('auto', plan)).toBeNull();
    expect(selectAutoTranscodeFallback('2160p-high', {
      ...plan,
      delivery: 'server_transcode_hls'
    })).toBeNull();
  });
});
