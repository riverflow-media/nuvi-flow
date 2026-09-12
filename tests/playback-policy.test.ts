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
      mode: 'auto-silo',
      reason: 'conservative_unknown_device',
      target: {
        maxResolution: '2160p',
        videoCodec: 'h264',
        audioCodec: 'aac',
        maxAudioChannels: 2,
        dynamicRange: 'sdr',
        likelyVideoTranscode: false
      },
      requestProfile: {
        qualityPreference: 'auto',
        clientCapabilities: {
          video_evidence: 'declared',
          audio_evidence: 'declared',
          codecs_video: ['h264'],
          codecs_video_hardware: ['h264'],
          codecs_audio: ['aac'],
          containers: ['mp4', 'hls'],
          max_resolution: '2160p',
          hdr: false
        },
        clientPlaybackContext: {
          output: { output_context_id: deviceId },
          deliveries: {
            original_http: {
              enabled: true,
              supported_on_device: true,
              containers: ['mp4'],
              video_codecs: ['h264'],
              audio_decode_codecs: ['aac']
            },
            progressive: {
              enabled: true,
              supported_on_device: true,
              containers: ['mp4'],
              video_codecs: ['h264'],
              audio_decode_codecs: ['aac']
            },
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
      .toEqual(['original_http', 'progressive', 'hls']);
  });

  it('uses the source resolution class for smaller media', () => {
    expect(planSiloPlayback(
      { width: 1920, height: 1080 }, 'auto', deviceId
    ).target.maxResolution).toBe('1080p');
    expect(planSiloPlayback(
      { width: 1280, height: 720 }, 'auto', deviceId
    ).target.maxResolution).toBe('720p');
  });

  it('offers scanned source traits to original playback before compatibility conversion', () => {
    const plan = planSiloPlayback(
      {
        width: 1920,
        height: 1080,
        relative_path: 'The Return of the King (2003).mkv',
        video_codec: 'h264',
        audio_codec: 'truehd',
        audio_channels: 8
      },
      'auto',
      deviceId
    );

    expect(plan.reason).toBe('source_direct_first');
    expect(plan.requestProfile.clientCapabilities).toMatchObject({
      codecs_video: ['h264'],
      codecs_audio: ['aac', 'truehd'],
      containers: ['mp4', 'mkv', 'hls']
    });
    expect(plan.requestProfile.clientPlaybackContext.deliveries).toMatchObject({
      original_http: {
        containers: ['mp4', 'mkv'],
        video_codecs: ['h264'],
        audio_decode_codecs: ['aac', 'truehd'],
        max_channels: 8
      },
      progressive: {
        containers: ['mp4'],
        video_codecs: ['h264'],
        audio_decode_codecs: ['aac'],
        max_channels: 2
      },
      hls: {
        containers: ['hls'],
        video_codecs: ['h264'],
        audio_decode_codecs: ['aac'],
        max_channels: 2
      }
    });
    expect(
      plan.requestProfile.clientPlaybackContext.device.platform_details.policy
    ).toBe('source_direct_first_v1');
  });

  it('preserves a valid administrator fixed-quality override', () => {
    const plan = planSiloPlayback(
      {
        width: 3840,
        height: 2160,
        relative_path: 'Example.mkv',
        video_codec: 'hevc',
        audio_codec: 'truehd'
      },
      '1080p-medium',
      deviceId
    );

    expect(plan.mode).toBe('fixed-silo-hls');
    expect(plan.requestProfile.qualityPreference).toBe('1080p-medium');
    expect(Object.keys(plan.requestProfile.clientPlaybackContext.deliveries))
      .toEqual(['hls']);
    expect(plan.requestProfile.clientCapabilities.containers).toEqual(['hls']);
    expect(plan.requestProfile.clientCapabilities.codecs_video).toEqual(['h264']);
    expect(plan.requestProfile.clientCapabilities.codecs_audio).toEqual(['aac']);
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
            category: 'container', capability: 'mkv', supported: true,
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
      containers: ['mp4', 'mkv', 'hls'],
      hdr: true
    });
    expect(
      plan.requestProfile.clientPlaybackContext.deliveries.original_http
        ?.containers
    ).toEqual(['mp4', 'mkv']);
    expect(plan.target.dynamicRange).toBe('hdr');
  });

  it('normalizes an invalid configured quality to Auto', () => {
    expect(normalizeSiloQualityPreference('not-a-rung')).toBe('auto');
  });

  it('does not impose a hardware-specific 1080p ceiling on Auto', () => {
    const plan = planSiloPlayback(
      { width: 3840, height: 2160 }, 'auto', deviceId
    );

    expect(plan.requestProfile.qualityPreference).toBe('auto');
    expect(plan.target.maxResolution).toBe('2160p');
  });

  it('flags an unknown HEVC source for optional pre-transcode fallback only in Auto', () => {
    expect(planSiloPlayback({
      width: 3840, height: 2160, relative_path: 'Movie.mkv',
      video_codec: 'hevc'
    }, 'auto', deviceId).target.likelyVideoTranscode).toBe(true);
    expect(planSiloPlayback({
      width: 3840, height: 2160, relative_path: 'Movie.mkv',
      video_codec: 'hevc'
    }, '1080p-medium', deviceId).target.likelyVideoTranscode).toBe(false);
  });
});
