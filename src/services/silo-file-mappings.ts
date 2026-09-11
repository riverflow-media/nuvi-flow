import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/index.js';
import type { SiloFileMappingRow } from '../types.js';

export function siloServerKey(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, '');

  try {
    const parsed = new URL(normalized);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    normalized = parsed.toString().replace(/\/+$/, '');
  } catch {
    // Configuration validation reports malformed URLs. Preserve the original
    // text here so distinct values never collapse into the same mapping scope.
  }

  return createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

export class SiloFileMappingStore {
  constructor(private readonly database: AppDatabase) {}

  get(mediaFileId: string, serverKey: string): SiloFileMappingRow | undefined {
    return this.database.sqlite.prepare(
      `SELECT * FROM silo_file_mappings
       WHERE media_file_id=? AND silo_server_key=?`
    ).get(mediaFileId, serverKey) as SiloFileMappingRow | undefined;
  }

  record(
    mediaFileId: string,
    serverKey: string,
    mappedPath: string,
    status: SiloFileMappingRow['status'],
    siloFileId: number | null,
    siloItemId: string | null
  ): void {
    this.database.sqlite.prepare(
      `INSERT INTO silo_file_mappings (
        media_file_id,silo_server_key,silo_file_id,silo_item_id,status,mapped_path,updated_at
      ) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(media_file_id,silo_server_key) DO UPDATE SET
        silo_file_id=excluded.silo_file_id,
        silo_item_id=excluded.silo_item_id,
        status=excluded.status,
        mapped_path=excluded.mapped_path,
        updated_at=excluded.updated_at`
    ).run(
      mediaFileId,
      serverKey,
      siloFileId,
      siloItemId,
      status,
      mappedPath,
      Date.now()
    );
  }

  markStale(mediaFileId: string): void {
    this.database.sqlite.prepare(
      `UPDATE silo_file_mappings
       SET status='stale',updated_at=?
       WHERE media_file_id=? AND status!='stale'`
    ).run(Date.now(), mediaFileId);
  }
}
