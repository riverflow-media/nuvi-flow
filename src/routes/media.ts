import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
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
import {
  type PlaybackSessionRegistry,
  type PlaybackSessionResult
} from '../services/playback/playback-sessions.js';
import { deriveDeviceIdentity } from '../services/playback/device-identity.js';
import {
  planSiloPlayback,
  selectAutoTranscodeFallback
} from '../services/playback/playback-policy.js';
import {
  HlsManifestError,
  isHlsManifestPath,
  readHlsManifest,
  rewriteHlsManifest
} from '../services/playback/hls-proxy.js';
import type { SiloService } from '../services/silo-service.js';
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

function headerValue(
  request: FastifyRequest,
  name: string
): string | undefined {
  const value = request.headers[name];

  return Array.isArray(value)
    ? value[0]
    : value;
}

class SiloPlaybackRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'SiloPlaybackRouteError';
  }
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
  config: AppConfig,
  playbackSessions: PlaybackSessionRegistry,
  silo: SiloService
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

  const fallbackIdentity = authorized.token!.deviceId
    ? null
    : deriveDeviceIdentity({
        installationId: settings.addonAccessToken,
        explicitDeviceId:
          headerValue(request, 'x-nuvi-flow-device-id') ||
          headerValue(request, 'x-stremio-device-id'),
        clientName: headerValue(request, 'x-stremio-client'),
        clientVersion: headerValue(request, 'x-stremio-version'),
        userAgent: headerValue(request, 'user-agent'),
        ip: request.ip,
        requestScope: authorized.token!.jti
      });
  const deviceId =
    authorized.token!.deviceId ||
    fallbackIdentity!.id;
  const deviceIdentitySource =
    authorized.token!.deviceId
      ? 'signed_stream_token'
      : fallbackIdentity!.source;
  const policy = planSiloPlayback(
    authorized.file,
    settings.siloTranscodeQuality,
    deviceId
  );

  let sessionResult: PlaybackSessionResult;

  try {
    sessionResult =
      await playbackSessions.getOrCreate(
        {
          deviceId,
          mediaFileId: authorized.file.id,
          profileId: settings.siloProfileId,
          mode: policy.mode,
          quality: policy.requestProfile.qualityPreference,
          audioSelection: 'conservative-aac-stereo',
          subtitleSelection: 'none',
          dynamicRangeMode: policy.target.dynamicRange,
          season: episode?.season,
          episode: episode?.episode
        },
        authorized.token!.exp,
        async ({ playbackId }) => {
          const startupStartedAt = Date.now();
          const started =
            await silo.startPlaybackForMedia(
              item,
              authorized.file,
              settings.siloProfileId,
              policy.requestProfile,
              episode
            );

          if (!started) {
            throw new SiloPlaybackRouteError(
              404,
              'This file could not be resolved in Silo.'
            );
          }

          const { fileId, playbackAttemptId } = started;
          let { decision } = started;

          const initialPlan = decision.playback_plan;
          const fallbackQuality = initialPlan
            ? selectAutoTranscodeFallback(
                settings.siloTranscodeQuality,
                initialPlan
              )
            : null;

          if (
            fallbackQuality &&
            decision.session_id &&
            initialPlan?.plan_id &&
            initialPlan.plan_attempt_key
          ) {
            const replanned = await silo.replanPlaybackQuality(
              decision.session_id,
              settings.siloProfileId,
              playbackAttemptId,
              initialPlan,
              fallbackQuality,
              policy.requestProfile,
              initialPlan.timeline?.source_start_seconds || 0
            );

            if (
              replanned.outcome !== 'playable' ||
              !replanned.playback_plan
            ) {
              throw new SiloPlaybackRouteError(
                502,
                'Silo could not create the safer Auto playback route.'
              );
            }

            request.log.info(
              {
                playback_id: playbackId,
                silo_session_id: decision.session_id,
                from_quality: 'auto',
                to_quality: fallbackQuality,
                reason: 'full_4k_video_transcode_guard'
              },
              'Playback quality replanned'
            );
            decision = replanned;
          }

          const plan = decision.playback_plan;

          if (
            decision.outcome !== 'playable' ||
            !plan ||
            ![
              'server_remux_hls',
              'server_transcode_hls'
            ].includes(plan.delivery) ||
            plan.stream.protocol !== 'hls' ||
            !plan.stream.url.startsWith(
              '/playback/'
            )
          ) {
            throw new SiloPlaybackRouteError(
              502,
              'Silo did not return a usable transcoded HLS stream.'
            );
          }

          request.log.info(
            {
              playback_id: playbackId,
              device_id: deviceId,
              device_identity_source:
                deviceIdentitySource,
              media_file_id: authorized.file.id,
              silo_file_id: fileId,
              silo_session_id:
                decision.session_id || null,
              source: {
                width: authorized.file.width,
                height: authorized.file.height,
                video_codec:
                  authorized.file.video_codec,
                audio_codec:
                  authorized.file.audio_codec
              },
              decision: plan.delivery,
              target: {
                quality: fallbackQuality || policy.requestProfile.qualityPreference,
                max_resolution: fallbackQuality
                  ? '1080p'
                  : policy.target.maxResolution,
                width: plan.effective_recipe?.width || null,
                height: plan.effective_recipe?.height || null,
                video_codec:
                  plan.effective_recipe?.video_codec ||
                  policy.target.videoCodec,
                audio_codec:
                  plan.effective_recipe?.audio_codec ||
                  policy.target.audioCodec,
                dynamic_range:
                  plan.effective_recipe?.dynamic_range ||
                  policy.target.dynamicRange
              },
              reason: plan.decision_reason || policy.reason,
              transformations:
                plan.transformations?.map(
                  transformation => transformation.name
                ).filter(Boolean) || [],
              startup_ms:
                Date.now() - startupStartedAt,
              fallback_attempt: fallbackQuality ? 1 : 0
            },
            'Playback session created'
          );

          return {
            siloSessionId:
              decision.session_id || null,
            siloFileId: fileId,
            upstreamPath:
              '/api/v1' + plan.stream.url,
            delivery: plan.delivery
          };
        }
      );
  } catch (error) {
    if (error instanceof SiloPlaybackRouteError) {
      return reply
        .code(error.statusCode)
        .header('Cache-Control', 'no-store')
        .send({ error: error.message });
    }

    throw error;
  }

  const { token } =
    createSiloMediaToken(
      sessionResult.session.upstreamPath,
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
    .header(
      'X-Nuvi-Flow-Playback-Id',
      sessionResult.session.playbackId
    )
    .header('Cache-Control', 'no-store')
    .send();
}

async function serveSiloMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  settings: SettingsService,
  config: AppConfig,
  silo: SiloService
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

  const upstreamHeaders = new Headers();

  for (const name of [
    'accept',
    'range',
    'if-none-match',
    'if-modified-since'
  ]) {
    const value = headerValue(request, name);
    if (value) upstreamHeaders.set(name, value);
  }

  let response: Response;

  try {
    response = await silo.fetchMedia(payload.path, {
      method: request.method,
      headers: upstreamHeaders
    });
  } catch {
    return reply
      .code(502)
      .header('Cache-Control', 'no-store')
      .send({ error: 'Silo media could not be fetched.' });
  }

  const copyHeader = (name: string): void => {
    const value = response.headers.get(name);
    if (value) reply.header(name, value);
  };

  for (const name of [
    'accept-ranges',
    'content-range',
    'etag',
    'last-modified'
  ]) {
    copyHeader(name);
  }

  if (response.status === 304 || response.status === 416) {
    await response.body?.cancel();
    copyHeader('content-length');
    return reply
      .code(response.status)
      .header('Cache-Control', 'private, no-store')
      .send();
  }

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

  const manifestResponse = isHlsManifestPath(payload.path);

  if (manifestResponse) {
    contentType =
      'application/vnd.apple.mpegurl';
  } else if (
    new URL(payload.path, 'http://silo.invalid')
      .pathname.endsWith('.ts')
  ) {
    contentType = 'video/mp2t';
  }

  reply
    .code(response.status)
    .header('Content-Type', contentType)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff');

  if (request.method === 'HEAD') {
    await response.body?.cancel();
    copyHeader('content-length');
    return reply.send();
  }

  if (manifestResponse) {
    try {
      const manifest = await readHlsManifest(response);
      const rewritten = rewriteHlsManifest(
        manifest,
        payload.path,
        settings.siloUrl,
        siloPath => {
          const { token } = createSiloMediaToken(
            siloPath,
            payload.exp,
            config.streamSecret
          );
          return '/silo-media/' + encodeURIComponent(token);
        }
      );
      const body = Buffer.from(rewritten);
      return reply
        .header('Content-Length', String(body.length))
        .send(body);
    } catch (error) {
      if (error instanceof HlsManifestError) {
        return reply
          .code(502)
          .header('Content-Type', 'application/json; charset=utf-8')
          .removeHeader('Content-Length')
          .header('Cache-Control', 'no-store')
          .send({ error: 'Silo returned an invalid HLS manifest.' });
      }
      throw error;
    }
  }

  copyHeader('content-length');
  if (!response.body) return reply.send();

  const stream = Readable.fromWeb(
    response.body as unknown as NodeReadableStream
  );
  request.raw.once('aborted', () => {
    if (!stream.destroyed) stream.destroy();
  });
  return reply.send(stream);
}

export function registerMediaRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  config: AppConfig,
  settings: SettingsService,
  playbackSessions: PlaybackSessionRegistry,
  silo: SiloService
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
        config,
        playbackSessions,
        silo
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
        config,
        silo
      )
  );
  app.head(
    '/silo-media/:token',
    options,
    (request, reply) =>
      serveSiloMedia(
        request,
        reply,
        settings,
        config,
        silo
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
