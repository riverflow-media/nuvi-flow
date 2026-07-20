import fs from 'node:fs';
import path from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { parseByteRange } from '../lib/range.js';
import { verifyStreamToken } from '../lib/security.js';
import type { ExternalSubtitleRow, MediaFileRow } from '../types.js';

function contentDisposition(name: string): string {
  const safe = name.replace(/["\r\n\\/]/g, '_');
  return `inline; filename="${safe}"`;
}

function authorize(request: FastifyRequest, database: AppDatabase, config: AppConfig): { file: MediaFileRow; token: ReturnType<typeof verifyStreamToken> } | null {
  const { token } = request.params as { token: string };
  const payload = verifyStreamToken(token, config.streamSecret);
  if (!payload) return null;
  const tokenRow = database.sqlite.prepare('SELECT revoked,last_used_at FROM stream_tokens WHERE jti=? AND media_file_id=? AND expires_at>?')
    .get(payload.jti, payload.fileId, Date.now()) as { revoked: number; last_used_at: number | null } | undefined;
  if (!tokenRow || tokenRow.revoked) return null;
  if (!tokenRow.last_used_at || tokenRow.last_used_at < Date.now() - 60 * 60 * 1000) {
    database.sqlite.prepare('UPDATE stream_tokens SET last_used_at=? WHERE jti=?').run(Date.now(), payload.jti);
  }
  const file = database.sqlite.prepare("SELECT * FROM media_files WHERE id=? AND status='matched'").get(payload.fileId) as MediaFileRow | undefined;
  return file ? { file, token: payload } : null;
}

async function serveMedia(request: FastifyRequest, reply: FastifyReply, database: AppDatabase, config: AppConfig): Promise<FastifyReply> {
  const authorized = authorize(request, database, config);
  if (!authorized) {
    return reply.code(401).header('Cache-Control', 'no-store').send({ error: 'Invalid or expired stream token' });
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(authorized.file.absolute_path);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return reply.code(404).send({ error: 'The media file is currently unavailable.' });
  }
  const size = stat.size;
  const rangeResult = parseByteRange(request.headers.range, size);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', mimeLookup(authorized.file.absolute_path) || 'application/octet-stream');
  reply.header('Content-Disposition', contentDisposition(path.basename(authorized.file.relative_path)));
  reply.header('Last-Modified', stat.mtime.toUTCString());
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (rangeResult.kind === 'invalid') {
    return reply.code(416).header('Content-Range', `bytes */${size}`).header('Content-Length', '0').send();
  }
  const range = rangeResult.kind === 'valid' ? rangeResult.range : { start: 0, end: size - 1, length: size };
  const partial = rangeResult.kind === 'valid';
  if (partial) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
  else reply.code(200);
  reply.header('Content-Length', String(range.length));
  request.log.info({ mediaFileId: authorized.file.id, method: request.method, range: `${range.start}-${range.end}`, size }, 'Serving media byte range');
  if (request.method === 'HEAD' || size === 0) {
    return reply.send();
  }
  const stream = fs.createReadStream(authorized.file.absolute_path, { start: range.start, end: range.end });
  request.raw.once('aborted', () => {
    if (!stream.destroyed) stream.destroy();
  });
  return reply.send(stream);
}

export function registerMediaRoutes(app: FastifyInstance, database: AppDatabase, config: AppConfig): void {
  const options = { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } };
  app.get('/media/:token', options, (request, reply) => serveMedia(request, reply, database, config));
  app.head('/media/:token', options, (request, reply) => serveMedia(request, reply, database, config));
  app.get('/subtitles/:token/:subtitleId', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (request, reply) => {
    const authorized = authorize(request, database, config);
    if (!authorized) return reply.code(401).send({ error: 'Invalid or expired stream token' });
    const { subtitleId } = request.params as { subtitleId: string };
    const subtitle = database.sqlite.prepare('SELECT * FROM external_subtitles WHERE id=? AND media_file_id=?').get(subtitleId, authorized.file.id) as ExternalSubtitleRow | undefined;
    if (!subtitle) return reply.code(404).send({ error: 'Subtitle not found' });
    try {
      const stat = await fs.promises.stat(subtitle.absolute_path);
      reply.header('Content-Type', subtitle.format === 'vtt' ? 'text/vtt; charset=utf-8' : 'text/plain; charset=utf-8');
      reply.header('Content-Length', String(stat.size));
      reply.header('Cache-Control', 'private, max-age=3600');
      return reply.send(fs.createReadStream(subtitle.absolute_path));
    } catch {
      return reply.code(404).send({ error: 'Subtitle not found' });
    }
  });
}
