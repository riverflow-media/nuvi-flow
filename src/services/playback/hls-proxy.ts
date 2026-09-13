const SILO_PLAYBACK_PREFIX = '/api/v1/playback/';
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export class HlsManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlsManifestError';
  }
}

export function isHlsManifestPath(rawPath: string): boolean {
  try {
    return new URL(rawPath, 'http://silo.invalid')
      .pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

function resolveSiloMediaPath(
  reference: string,
  sourcePath: string,
  siloBaseUrl: string
): string {
  let siloOrigin: string;
  let sourceUrl: URL;
  let resolved: URL;

  try {
    siloOrigin = new URL(siloBaseUrl).origin;
    sourceUrl = new URL(sourcePath, siloOrigin);
    resolved = new URL(reference, sourceUrl);
  } catch {
    throw new HlsManifestError('Silo returned an invalid HLS media URI.');
  }

  if (
    !['http:', 'https:'].includes(resolved.protocol) ||
    resolved.origin !== siloOrigin ||
    !resolved.pathname.startsWith(SILO_PLAYBACK_PREFIX)
  ) {
    throw new HlsManifestError('Silo returned an HLS media URI outside the authorized playback session.');
  }

  return resolved.pathname + resolved.search;
}

export interface HlsSegmentTimelineEntry {
  path: string;
  positionSeconds: number;
}

/**
 * Extracts an approximate source position for each media segment. The mapping
 * is used only to preserve position during a bounded quality replan; it is not
 * persisted or treated as watch history.
 */
export function parseHlsSegmentTimeline(
  manifest: string,
  sourcePath: string,
  siloBaseUrl: string,
  sourceStartSeconds = 0
): HlsSegmentTimelineEntry[] {
  const lines = manifest.split('\n');
  const mediaSequence = Number(lines.find(line =>
    line.trim().startsWith('#EXT-X-MEDIA-SEQUENCE:')
  )?.split(':', 2)[1] || 0);
  const targetDuration = Number(lines.find(line =>
    line.trim().startsWith('#EXT-X-TARGETDURATION:')
  )?.split(':', 2)[1] || 0);
  let position = Math.max(0, sourceStartSeconds) + (
    Number.isFinite(mediaSequence) && mediaSequence > 0 &&
    Number.isFinite(targetDuration) && targetDuration > 0
      ? mediaSequence * targetDuration
      : 0
  );
  let duration = 0;
  const entries: HlsSegmentTimelineEntry[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#EXTINF:')) {
      const parsed = Number.parseFloat(trimmed.slice('#EXTINF:'.length));
      duration = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      continue;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!duration) continue;
    entries.push({
      path: resolveSiloMediaPath(trimmed, sourcePath, siloBaseUrl),
      positionSeconds: position
    });
    position += duration;
    duration = 0;
  }

  return entries;
}

function rewriteReference(
  reference: string,
  sourcePath: string,
  siloBaseUrl: string,
  proxyUrl: (path: string) => string
): string {
  return proxyUrl(resolveSiloMediaPath(reference, sourcePath, siloBaseUrl));
}

/**
 * Rewrites both ordinary playlist URI lines and URI attributes used by master
 * playlists, encryption keys, initialization maps, subtitles, and low-latency
 * HLS hints. Every rewritten target must remain on the configured Silo origin
 * and inside its playback namespace.
 */
export function rewriteHlsManifest(
  manifest: string,
  sourcePath: string,
  siloBaseUrl: string,
  proxyUrl: (path: string) => string
): string {
  return manifest.split('\n').map(line => {
    const trimmed = line.trim();

    if (!trimmed) return line;

    if (!trimmed.startsWith('#')) {
      const rewritten = rewriteReference(
        trimmed,
        sourcePath,
        siloBaseUrl,
        proxyUrl
      );
      const start = line.indexOf(trimmed);
      return line.slice(0, start) + rewritten + line.slice(start + trimmed.length);
    }

    return line.replace(
      /\bURI=(?:"([^"]*)"|([^,\s]*))/g,
      (_attribute, quoted: string | undefined, unquoted: string | undefined) => {
        const reference = quoted ?? unquoted ?? '';
        const rewritten = rewriteReference(
          reference,
          sourcePath,
          siloBaseUrl,
          proxyUrl
        );
        return quoted === undefined
          ? `URI=${rewritten}`
          : `URI="${rewritten}"`;
      }
    );
  }).join('\n');
}

export async function readHlsManifest(
  response: Response,
  maximumBytes = MAX_MANIFEST_BYTES
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));

  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    throw new HlsManifestError('Silo returned an oversized HLS manifest.');
  }

  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new HlsManifestError('Silo returned an oversized HLS manifest.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}
