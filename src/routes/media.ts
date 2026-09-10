import fs from 'node:fs';
import path from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { parseByteRange } from '../lib/range.js';
import {
  createSiloMediaToken,
  verifySiloMediaToken,
  verifyStreamToken
} from '../lib/security.js';
import { SiloClient } from '../services/silo.js';
import type { SettingsService } from '../services/settings.js';
import type {
  ExternalSubtitleRow,
  MediaFileRow,
  MediaItemRow
} from '../types.js';

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

async function serveSiloStream(
  request: FastifyRequest,
  reply: FastifyReply,
  database: AppDatabase,
  settings: SettingsService,
  config: AppConfig
): Promise<FastifyReply> {
  const authorized = authorize(
    request,
    database,
    config
  );

  if (!authorized) {
    return reply
      .code(401)
      .header('Cache-Control', 'no-store')
      .send({
        error:
          'Invalid or expired stream token'
      });
  }

  if (
    !settings.siloEnabled ||
    !settings.siloUrl ||
    !settings.siloApiKey ||
    !settings.siloProfileId
  ) {
    return reply
      .code(503)
      .header('Cache-Control', 'no-store')
      .send({
        error: 'Silo is not configured.'
      });
  }

  const item = database.sqlite
    .prepare(
      'SELECT * FROM media_items WHERE id=?'
    )
    .get(
      authorized.file.media_item_id
    ) as MediaItemRow | undefined;

  if (!item) {
    return reply
      .code(404)
      .header('Cache-Control', 'no-store')
      .send({
        error: 'Media item not found.'
      });
  }

  let episode:
    | {
        season: number;
        episode: number;
      }
    | undefined;

  if (item.type === 'series') {
    const season =
      authorized.token?.season;

    const episodeNumber =
      authorized.token?.episode;

    if (
      season === undefined ||
      episodeNumber === undefined
    ) {
      return reply
        .code(400)
        .header('Cache-Control', 'no-store')
        .send({
          error:
            'Episode context is required for Silo TV playback.'
        });
    }

    episode = {
      season,
      episode: episodeNumber
    };
  }

  const silo = new SiloClient(
    settings.siloUrl,
    settings.siloApiKey
  );

  const fileId = await silo.resolveFileId(
    item,
    authorized.file,
    episode
  );

  if (fileId === null) {
    return reply
      .code(404)
      .header('Cache-Control', 'no-store')
      .send({
        error:
          'This file could not be resolved in Silo.'
      });
  }

  const decision =
    await silo.startPlayback(
      fileId,
      settings.siloProfileId,
      settings.siloTranscodeQuality
    );

  const plan = decision.playback_plan;

  if (
    decision.outcome !== 'playable' ||
    !plan ||
    plan.delivery !==
      'server_transcode_hls' ||
    plan.stream.protocol !== 'hls' ||
    !plan.stream.url.startsWith(
      '/playback/'
    )
  ) {
    return reply
      .code(502)
      .header('Cache-Control', 'no-store')
      .send({
        error:
          'Silo did not return a usable transcoded HLS stream.'
      });
  }

  const siloPath =
    '/api/v1' + plan.stream.url;

  const { token } =
    createSiloMediaToken(
      siloPath,
      authorized.token!.exp,
      config.streamSecret
    );

  return reply
    .code(302)
    .header(
      'Location',
      '/silo-media/' +
        encodeURIComponent(token)
    )
    .header('Cache-Control', 'no-store')
    .send();
}

async function serveSiloMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  settings: SettingsService,
  config: AppConfig
): Promise<FastifyReply> {
  const { token } =
    request.params as { token: string };

  const payload = verifySiloMediaToken(
    token,
    config.streamSecret
  );

  if (!payload) {
    return reply
      .code(401)
      .header('Cache-Control', 'no-store')
      .send({
        error:
          'Invalid or expired Silo media token'
      });
  }

  if (
    !settings.siloEnabled ||
    !settings.siloUrl ||
    !settings.siloApiKey
  ) {
    return reply
      .code(503)
      .header('Cache-Control', 'no-store')
      .send({
        error: 'Silo is not configured.'
      });
  }

  const silo = new SiloClient(
    settings.siloUrl,
    settings.siloApiKey
  );

  const response = await silo.fetchMedia(
    payload.path,
    {
      headers: request.headers.accept
        ? {
            Accept:
              request.headers.accept
          }
        : undefined
    }
  );

  if (!response.ok) {
    await response.body?.cancel();

    return reply
      .code(
        response.status === 404
          ? 404
          : 502
      )
      .header('Cache-Control', 'no-store')
      .send({
        error:
          'Silo media could not be fetched.'
      });
  }

  let contentType =
    response.headers.get('content-type') ||
    'application/octet-stream';

  if (payload.path.endsWith('.m3u8')) {
    contentType =
      'application/vnd.apple.mpegurl';
  } else if (payload.path.endsWith('.ts')) {
    contentType = 'video/mp2t';
  }

  let body: Buffer;

  if (payload.path.endsWith('.m3u8')) {
    const manifest =
      await response.text();

    const sourceUrl = new URL(
      payload.path,
      'http://silo.internal'
    );

    const rewritten = manifest
      .split('\n')
      .map(line => {
        const trimmed = line.trim();

        if (
          !trimmed ||
          trimmed.startsWith('#')
        ) {
          return line;
        }

        const resolved = new URL(
          trimmed,
          sourceUrl
        );

        const siloPath =
          resolved.pathname +
          resolved.search;

        if (
          !siloPath.startsWith(
            '/api/v1/playback/'
          )
        ) {
          return line;
        }

        const { token } =
          createSiloMediaToken(
            siloPath,
            payload.exp,
            config.streamSecret
          );

        return (
          '/silo-media/' +
          encodeURIComponent(token)
        );
      })
      .join('\n');

    body = Buffer.from(rewritten);
  } else {
    body = Buffer.from(
      await response.arrayBuffer()
    );
  }

  return reply
    .code(200)
    .header('Content-Type', contentType)
    .header('Content-Length', String(body.length))
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(body);
}

export function registerMediaRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  config: AppConfig,
  settings: SettingsService
): void {
  const options = { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } };
  app.get('/media/:token', options, (request, reply) => serveMedia(request, reply, database, config));
  app.head('/media/:token', options, (request, reply) => serveMedia(request, reply, database, config));

  app.get(
    '/silo-stream/:token',
    options,
    (request, reply) =>
      serveSiloStream(
        request,
        reply,
        database,
        settings,
        config
      )
  );

  app.get(
    '/silo-media/:token',
    options,
    (request, reply) =>
      serveSiloMedia(
        request,
        reply,
        settings,
        config
      )
  );
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
