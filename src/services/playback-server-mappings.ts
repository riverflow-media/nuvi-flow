import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/index.js';
import type {
  PlaybackServerMappingReason,
  PlaybackServerMappingRow,
  PlaybackServerProvider
} from '../types.js';

export interface PathPrefixMapping {
  localPrefix: string;
  providerPrefix: string;
}

export interface PlaybackServerMappingCandidate {
  mediaFileId: string;
  mappedPath: string;
  status: PlaybackServerMappingRow['status'];
  reason: PlaybackServerMappingReason | null;
  providerItemId: string | null;
  providerMediaId: string | null;
  providerStreamPath: string | null;
}

export interface PlaybackServerMappingSummary {
  total: number;
  mapped: number;
  pending: number;
  stale: number;
  notFound: number;
  ambiguous: number;
  errors: number;
  refreshDue: number;
  lastUpdatedAt: number | null;
}

export class PathPrefixMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPrefixMappingError';
  }
}

export const MAPPED_MEDIA_REFRESH_MS = 24 * 60 * 60 * 1000;
export const UNAVAILABLE_MEDIA_RETRY_MS = 60 * 1000;

export function playbackServerKey(
  provider: PlaybackServerProvider,
  serverId: string
): string {
  return createHash('sha256')
    .update(`${provider}\0${serverId.trim()}`)
    .digest('hex')
    .slice(0, 24);
}

export function normalizeMediaPath(value: string): string {
  let normalized = value.trim().replaceAll('\\', '/');
  const unc = normalized.startsWith('//');
  normalized = normalized.replace(/\/{2,}/g, '/');
  if (unc) normalized = `/${normalized}`;
  if (normalized.length > 1 && !/^[a-z]:\/$/i.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return normalized;
}

function isAbsoluteMediaPath(value: string): boolean {
  return value.startsWith('/') ||
    value.startsWith('//') ||
    /^[a-z]:\//i.test(value);
}

export function parsePathPrefixMappings(raw: string): PathPrefixMapping[] {
  const lines = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  if (lines.length > 20) {
    throw new PathPrefixMappingError('At most 20 path-prefix mappings are allowed.');
  }

  const seen = new Set<string>();
  const mappings = lines.map((line, index) => {
    const separator = line.indexOf('=>');
    if (separator < 0) {
      throw new PathPrefixMappingError(
        `Path-prefix mapping ${index + 1} must use local => provider syntax.`
      );
    }
    const localPrefix = normalizeMediaPath(line.slice(0, separator));
    const providerPrefix = normalizeMediaPath(line.slice(separator + 2));
    if (!localPrefix || !providerPrefix ||
      !isAbsoluteMediaPath(localPrefix) ||
      !isAbsoluteMediaPath(providerPrefix)) {
      throw new PathPrefixMappingError(
        `Path-prefix mapping ${index + 1} must contain two absolute paths.`
      );
    }
    if (seen.has(localPrefix)) {
      throw new PathPrefixMappingError(
        `Path-prefix mapping ${index + 1} duplicates a local prefix.`
      );
    }
    seen.add(localPrefix);
    return { localPrefix, providerPrefix };
  });

  return mappings.sort((left, right) =>
    right.localPrefix.length - left.localPrefix.length
  );
}

export function translateMediaPath(
  localPath: string,
  mappings: readonly PathPrefixMapping[]
): string {
  const normalized = normalizeMediaPath(localPath);
  for (const mapping of mappings) {
    const matches = normalized === mapping.localPrefix ||
      (mapping.localPrefix === '/' && normalized.startsWith('/') &&
        !normalized.startsWith('//')) ||
      normalized.startsWith(`${mapping.localPrefix}/`);
    if (!matches) continue;
    const suffix = mapping.localPrefix === '/'
      ? normalized.slice(1)
      : normalized.slice(mapping.localPrefix.length).replace(/^\/+/, '');
    const translated = suffix
      ? mapping.providerPrefix === '/'
        ? `/${suffix}`
        : `${mapping.providerPrefix}/${suffix}`
      : mapping.providerPrefix;
    return normalizeMediaPath(translated);
  }
  return normalized;
}

interface EligibleMediaFile {
  id: string;
  absolute_path: string;
}

export class PlaybackServerMappingStore {
  constructor(private readonly database: AppDatabase) {}

  get(
    provider: PlaybackServerProvider,
    serverKey: string,
    mediaFileId: string
  ): PlaybackServerMappingRow | undefined {
    return this.database.sqlite.prepare(
      `SELECT * FROM playback_server_mappings
       WHERE provider=? AND server_key=? AND media_file_id=?`
    ).get(provider, serverKey, mediaFileId) as
      PlaybackServerMappingRow | undefined;
  }

  recordBatch(
    provider: PlaybackServerProvider,
    serverKey: string,
    candidates: readonly PlaybackServerMappingCandidate[],
    updatedAt = Date.now()
  ): void {
    const statement = this.database.sqlite.prepare(
      `INSERT INTO playback_server_mappings (
        media_file_id,provider,server_key,provider_item_id,provider_media_id,
        provider_stream_path,status,reason,mapped_path,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(media_file_id,provider,server_key) DO UPDATE SET
        provider_item_id=excluded.provider_item_id,
        provider_media_id=excluded.provider_media_id,
        provider_stream_path=excluded.provider_stream_path,
        status=excluded.status,
        reason=excluded.reason,
        mapped_path=excluded.mapped_path,
        updated_at=excluded.updated_at`
    );
    this.database.sqlite.transaction(() => {
      for (const candidate of candidates) {
        statement.run(
          candidate.mediaFileId,
          provider,
          serverKey,
          candidate.providerItemId,
          candidate.providerMediaId,
          candidate.providerStreamPath,
          candidate.status,
          candidate.reason,
          candidate.mappedPath,
          updatedAt
        );
      }
    })();
  }

  markStale(mediaFileId: string): void {
    this.database.sqlite.prepare(
      `UPDATE playback_server_mappings
       SET status='stale',reason='local_file_changed',updated_at=?
       WHERE media_file_id=? AND status!='stale'`
    ).run(Date.now(), mediaFileId);
  }

  summary(
    provider: PlaybackServerProvider,
    serverKey: string,
    pathMappings: readonly PathPrefixMapping[],
    now = Date.now()
  ): PlaybackServerMappingSummary {
    const { files, rows } = this.snapshot(provider, serverKey);
    const rowByFile = new Map(rows.map(row => [row.media_file_id, row]));
    const summary: PlaybackServerMappingSummary = {
      total: files.length,
      mapped: 0,
      pending: 0,
      stale: 0,
      notFound: 0,
      ambiguous: 0,
      errors: 0,
      refreshDue: 0,
      lastUpdatedAt: null
    };

    for (const file of files) {
      const row = rowByFile.get(file.id);
      const mappedPath = translateMediaPath(file.absolute_path, pathMappings);
      if (!row || row.mapped_path !== mappedPath) {
        summary.pending += 1;
        continue;
      }
      summary.lastUpdatedAt = Math.max(
        summary.lastUpdatedAt ?? 0,
        row.updated_at
      );
      if (row.status === 'mapped') summary.mapped += 1;
      else if (row.status === 'stale') summary.stale += 1;
      else if (row.status === 'not_found') summary.notFound += 1;
      else if (row.reason === 'ambiguous_exact_path') summary.ambiguous += 1;
      else summary.errors += 1;

      const maxAge = row.status === 'mapped'
        ? MAPPED_MEDIA_REFRESH_MS
        : UNAVAILABLE_MEDIA_RETRY_MS;
      if (now - row.updated_at >= maxAge) summary.refreshDue += 1;
    }

    return summary;
  }

  needsRefresh(
    provider: PlaybackServerProvider,
    serverKey: string,
    pathMappings: readonly PathPrefixMapping[],
    now = Date.now()
  ): boolean {
    const summary = this.summary(provider, serverKey, pathMappings, now);
    return summary.pending > 0 || summary.stale > 0 || summary.refreshDue > 0;
  }

  eligibleFiles(): EligibleMediaFile[] {
    return this.database.sqlite.prepare(
      `SELECT id,absolute_path FROM media_files
       WHERE status='matched' AND media_item_id IS NOT NULL
       ORDER BY id`
    ).all() as EligibleMediaFile[];
  }

  private snapshot(
    provider: PlaybackServerProvider,
    serverKey: string
  ): { files: EligibleMediaFile[]; rows: PlaybackServerMappingRow[] } {
    return {
      files: this.eligibleFiles(),
      rows: this.database.sqlite.prepare(
        `SELECT * FROM playback_server_mappings
         WHERE provider=? AND server_key=?`
      ).all(provider, serverKey) as PlaybackServerMappingRow[]
    };
  }
}
