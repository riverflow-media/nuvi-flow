import type { SiloPlaybackPlan } from '../silo.js';
import {
  siloQualityPreferences,
  type SiloQualityPreference
} from './playback-policy.js';

const qualityRank = new Map<string, number>(
  siloQualityPreferences.map((quality, index) => [quality, index])
);

function knownQuality(value: string): value is SiloQualityPreference {
  return qualityRank.has(value) && value !== 'auto';
}

/**
 * Select one materially cheaper quality from the rungs Silo says are
 * available. Auto never invents a server quality label.
 */
export function selectRuntimeFallbackQuality(
  plan: SiloPlaybackPlan
): SiloQualityPreference | null {
  const available = (plan.available_qualities || [])
    .filter(quality => knownQuality(quality.label) && !quality.preserves_source)
    .map(quality => ({
      label: quality.label as SiloQualityPreference,
      height: quality.height || 0,
      bitrateKbps: quality.bitrate_kbps || 0,
      rank: qualityRank.get(quality.label) || Number.MAX_SAFE_INTEGER
    }));

  if (!available.length) return null;

  const currentHeight = plan.effective_recipe?.height || 0;
  const currentBitrate = Number(plan.effective_recipe?.bitrate_kbps || 0);
  const cheaper = available.filter(quality =>
    !currentBitrate || !quality.bitrateKbps || quality.bitrateKbps < currentBitrate
  );
  const preferred = currentHeight > 1080
    ? ['1080p-high', '1080p-medium', '1080p-low', '720p-high']
    : currentHeight > 720
      ? ['1080p-medium', '1080p-low', '720p-high', '720p-medium']
      : ['720p-medium', '720p-low', '480p'];

  for (const label of preferred) {
    const match = cheaper.find(quality => quality.label === label);
    if (match) return match.label;
  }

  const lowerResolution = cheaper
    .filter(quality => !currentHeight || quality.height < currentHeight)
    .sort((left, right) => right.height - left.height || left.rank - right.rank)[0];

  return lowerResolution?.label || null;
}
