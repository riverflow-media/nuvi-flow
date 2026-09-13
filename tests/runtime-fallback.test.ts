import { describe, expect, it } from 'vitest';
import { selectRuntimeFallbackQuality } from '../src/services/playback/runtime-fallback.js';
import type { SiloPlaybackPlan } from '../src/services/silo.js';

function plan(height: number, labels: string[]): SiloPlaybackPlan {
  return {
    delivery: 'server_transcode_hls',
    effective_recipe: { height },
    available_qualities: labels.map(label => ({
      label,
      height: Number.parseInt(label, 10) || height,
      preserves_source: label === 'original'
    })),
    stream: {
      url: '/playback/transcode/session/master.m3u8',
      protocol: 'hls',
      headers: {},
      header_refresh: 'none'
    }
  };
}

describe('runtime quality fallback selection', () => {
  it('steps a struggling 4K transcode down to the highest 1080p rung', () => {
    expect(selectRuntimeFallbackQuality(plan(2160, [
      'original', '2160p-high', '1080p-high', '1080p-medium'
    ]))).toBe('1080p-high');
  });

  it('reduces a struggling 1080p transcode without inventing a quality', () => {
    expect(selectRuntimeFallbackQuality(plan(1080, [
      '1080p-high', '1080p-medium', '720p-high'
    ]))).toBe('1080p-medium');
    expect(selectRuntimeFallbackQuality(plan(1080, ['original'])))
      .toBeNull();
  });

  it('does not select a rung that is not cheaper when bitrate is known', () => {
    const current = plan(1080, ['1080p-medium']);
    current.effective_recipe!.bitrate_kbps = 6000;
    current.available_qualities![0]!.bitrate_kbps = 6000;
    expect(selectRuntimeFallbackQuality(current)).toBeNull();
  });
});
