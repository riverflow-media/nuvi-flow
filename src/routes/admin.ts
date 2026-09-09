import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { adminHtml, loginHtml } from '../admin/assets.js';
import { createSessionToken, createStreamToken, hashPassword, verifyPassword, verifySessionToken, type AdminSession } from '../lib/security.js';
import { parseJson } from '../lib/json.js';
import type { MediaFileRow, MediaItemRow, MediaType } from '../types.js';
import type { MediaScanner } from '../services/scanner.js';
import { RadarrClient } from '../services/radarr.js';
import { SonarrClient } from '../services/sonarr.js';
import type { RequestService } from '../services/requester.js';
import type { SettingsService } from '../services/settings.js';
import type { TmdbService } from '../services/tmdb.js';
import type { MetadataSearchResult } from '../services/tmdb.js';

const COOKIE_NAME = 'zpm_admin';

type AdminMediaFileRow = MediaFileRow & {
  display_title?: string | null;
  stremio_id?: string | null;
  item_title?: string | null;
  item_year?: number | null;
  item_tmdb_id?: number | null;
  item_description?: string | null;
  item_poster?: string | null;
  item_background?: string | null;
};

const adminFileSelect = `SELECT mf.*,mi.display_title,mi.stremio_id,mi.title item_title,mi.year item_year,
  mi.tmdb_id item_tmdb_id,mi.description item_description,mi.poster item_poster,mi.background item_background
  FROM media_files mf LEFT JOIN media_items mi ON mi.id=mf.media_item_id`;

function sessionFor(request: FastifyRequest, config: AppConfig): AdminSession | null {
  return verifySessionToken(request.cookies[COOKIE_NAME], config.sessionSecret);
}

function requireAdmin(config: AppConfig, csrf = false) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessionFor(request, config);
    if (!session) {
      reply.code(401).send({ error: 'Authentication required' });
      return;
    }
    if (csrf && request.headers['x-csrf-token'] !== session.csrf) {
      reply.code(403).send({ error: 'Invalid CSRF token' });
    }
  };
}

function publicFile(row: AdminMediaFileRow): Record<string, unknown> {
  const hasMatch = Boolean(row.media_item_id && row.stremio_id && !['ignored', 'error'].includes(row.status));
  const effectiveStatus = row.status === 'ignored' || row.status === 'error'
    ? row.status
    : hasMatch ? 'matched' : row.status === 'matched' ? 'unmatched' : row.status;
  return {
    id: row.id,
    libraryType: row.library_type,
    relativePath: row.relative_path,
    size: row.size,
    mtimeMs: row.mtime_ms,
    durationSeconds: row.duration_seconds,
    bitrate: row.bitrate,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    width: row.width,
    height: row.height,
    frameRate: row.frame_rate,
    audioChannels: row.audio_channels,
    audioTracks: parseJson(row.audio_tracks_json, []),
    audioLanguages: parseJson(row.audio_languages_json, []),
    subtitleTracks: parseJson(row.subtitle_tracks_json, []),
    parsedTitle: row.parsed_title,
    parsedYear: row.parsed_year,
    edition: row.edition,
    quality: row.quality,
    source: row.source,
    season: row.season,
    episodeStart: row.episode_start,
    episodeEnd: row.episode_end,
    confidence: row.confidence,
    manualOverride: Boolean(row.manual_override),
    status: effectiveStatus,
    compatibilityWarning: row.compatibility_warning,
    error: row.error,
    addedAt: row.added_at,
    updatedAt: row.updated_at,
    displayTitle: hasMatch ? row.display_title || null : null,
    stremioId: hasMatch ? row.stremio_id || null : null,
    mediaItemId: hasMatch ? row.media_item_id : null,
    poster: hasMatch ? row.item_poster || null : null,
    background: hasMatch ? row.item_background || null : null,
    currentMatch: hasMatch ? {
      title: row.display_title || row.item_title || row.parsed_title || 'Untitled',
      year: row.item_year || null,
      tmdbId: row.item_tmdb_id || null,
      stremioId: row.stremio_id,
      description: row.item_description || null,
      poster: row.item_poster || null
    } : null
  };
}

function fileDetail(database: AppDatabase, id: string): Record<string, unknown> | null {
  const row = database.sqlite.prepare(`${adminFileSelect} WHERE mf.id=?`).get(id) as AdminMediaFileRow | undefined;
  if (!row) return null;
  const subtitles = database.sqlite.prepare('SELECT id,relative_path relativePath,language,format,size FROM external_subtitles WHERE media_file_id=?').all(id);
  return { ...publicFile(row), probe: parseJson(row.probe_json, {}), subtitles };
}

function tmdbFailure(error: unknown, action: string): { status: number; message: string } {
  const detail = error instanceof Error ? error.message : '';
  if (/HTTP (401|403)/i.test(detail)) return { status: 400, message: 'The TMDB API key was rejected. Check the key in Settings and try again.' };
  if (/timeout|aborted/i.test(detail)) return { status: 504, message: `${action} timed out. Check the network connection and try again.` };
  return { status: 502, message: `${action} failed. Check the network connection and try again.` };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  database: AppDatabase,
  settings: SettingsService,
  scanner: MediaScanner,
  tmdb: TmdbService,
  requester: RequestService,
  config: AppConfig
): void {
  app.get('/admin/login', async (request, reply) => {
    if (sessionFor(request, config)) return reply.redirect('/admin');
    return reply.type('text/html; charset=utf-8').send(loginHtml());
  });

  app.post('/admin/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const body = request.body as { username?: string; password?: string };
    const storedHash = settings.adminPasswordHash;
    const valid = typeof body?.username === 'string' && typeof body?.password === 'string'
      && body.username === settings.adminUsername && Boolean(storedHash) && await verifyPassword(body.password, storedHash!);
    if (!valid) return reply.code(401).type('text/html; charset=utf-8').send(loginHtml('The username or password is incorrect.'));
    const { token } = createSessionToken(body.username!, config.sessionSecret);
    return reply.setCookie(COOKIE_NAME, token, {
      path: '/admin', httpOnly: true, sameSite: 'strict', secure: settings.baseUrl.startsWith('https://'), maxAge: 12 * 60 * 60
    }).redirect('/admin');
  });

  app.get('/admin', async (request, reply) => {
    const session = sessionFor(request, config);
    if (!session) return reply.redirect('/admin/login');
    return reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store').send(adminHtml(session.csrf));
  });

  app.post('/admin/logout', { preHandler: requireAdmin(config, true) }, async (_request, reply) => {
    return reply.clearCookie(COOKIE_NAME, { path: '/admin' }).send({ ok: true });
  });

  app.get('/admin/api/state', { preHandler: requireAdmin(config) }, async (_request, reply) => {
    const files = database.sqlite.prepare(`${adminFileSelect} ORDER BY mf.added_at DESC LIMIT 5000`).all() as AdminMediaFileRow[];
    const counts = {
      movies: (database.sqlite.prepare(`SELECT COUNT(DISTINCT media_item_id) count FROM media_files WHERE library_type='movie' AND status NOT IN ('ignored','error') AND media_item_id IS NOT NULL`).get() as any).count,
      series: (database.sqlite.prepare(`SELECT COUNT(DISTINCT media_item_id) count FROM media_files WHERE library_type='series' AND status NOT IN ('ignored','error') AND media_item_id IS NOT NULL`).get() as any).count,
      episodes: (database.sqlite.prepare(`SELECT COALESCE(SUM(episode_end-episode_start+1),0) count FROM media_files WHERE library_type='series' AND status NOT IN ('ignored','error') AND media_item_id IS NOT NULL`).get() as any).count,
      unmatched: (database.sqlite.prepare(`SELECT COUNT(*) count FROM media_files WHERE status NOT IN ('ignored','error') AND media_item_id IS NULL`).get() as any).count,
      errors: (database.sqlite.prepare(`SELECT COUNT(*) count FROM media_files WHERE status='error'`).get() as any).count
    };
    const logs = database.sqlite.prepare(`SELECT id,mode,status,discovered,processed,matched,unmatched,errors,
      started_at startedAt,finished_at finishedAt,message FROM scan_runs ORDER BY started_at DESC LIMIT 100`).all();
    const publicFiles = files.map(publicFile);
    return reply.header('Cache-Control', 'no-store').send({ counts, files: publicFiles, recent: publicFiles.slice(0, 12), logs, settings: settings.publicView(), scanning: scanner.isRunning() });
  });

  app.get('/admin/api/requests', { preHandler: requireAdmin(config) }, async (_request, reply) => {
    const requests = requester.listRequests(500).map((row) => ({
      id: row.id,
      requestKey: row.request_key,
      mediaType: row.media_type,
      stremioId: row.stremio_id,

      imdbId: row.imdb_id,
      tvdbId: row.tvdb_id,

      season: row.season,
      episode: row.episode,

      title: row.title,

      backend: row.backend,
      backendItemId: row.backend_item_id,

      status: row.status,
      message: row.message,

      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,

      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    return reply
      .header('Cache-Control', 'no-store')
      .send({ requests });
  });

  app.post('/admin/api/requests/:id/retry', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const started = requester.retryFailed(id);

      if (!started) {
        return reply.code(409).send({
          error: 'This request cannot be retried right now. It may no longer be failed or may already be running.'
        });
      }

      return reply.code(202).send({
        ok: true
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'The request could not be retried.';

      return reply.code(400).send({
        error: message
      });
    }
  });

  app.get('/admin/api/files/:id', { preHandler: requireAdmin(config) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = fileDetail(database, id);
    return file ? reply.send({ file }) : reply.code(404).send({ error: 'File not found' });
  });

  app.get('/admin/api/tmdb/search', { preHandler: requireAdmin(config) }, async (request, reply) => {
    const query = request.query as { type?: string; query?: string; year?: string };
    if (!['movie', 'series'].includes(query.type || '') || !query.query?.trim()) return reply.code(400).send({ error: 'Type and query are required' });
    try {
      const results = await tmdb.search(query.type as MediaType, query.query.trim(), query.year ? Number(query.year) : undefined);
      return reply.send({ results });
    } catch (error) {
      const failure = tmdbFailure(error, 'TMDB search');
      return reply.code(failure.status).send({ error: failure.message });
    }
  });

  app.post('/admin/api/files/:id/match', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { type?: MediaType; provider?: MetadataSearchResult['provider']; id?: string; tmdbId?: number };
    const file = database.sqlite.prepare('SELECT * FROM media_files WHERE id=?').get(id) as MediaFileRow | undefined;
    if (!file) return reply.code(404).send({ error: 'File not found' });
    const legacyTmdb = Number.isInteger(body.tmdbId) && Number(body.tmdbId) > 0;
    const genericSelection = ['tmdb', 'cinemeta'].includes(body.provider || '') && typeof body.id === 'string' && body.id.length > 0;
    if (body.type !== file.library_type || (!legacyTmdb && !genericSelection)) return reply.code(400).send({ error: 'Invalid metadata selection' });
    const selection: number | MetadataSearchResult = legacyTmdb ? Number(body.tmdbId) : {
      id: body.id!, provider: body.provider!, title: '',
      tmdbId: body.provider === 'tmdb' ? Number(body.id) : undefined,
      imdbId: body.provider === 'cinemeta' ? body.id : undefined
    };
    try {
      const itemId = await tmdb.ensureMediaItem(file.library_type, selection);
      if (file.library_type === 'series' && file.season !== null) await tmdb.ensureEpisodeMetadata(itemId, selection, file.season);
      database.sqlite.prepare(`UPDATE media_files SET media_item_id=?,status='matched',confidence=1,manual_override=1,error=NULL,updated_at=? WHERE id=?`)
        .run(itemId, Date.now(), id);
      return reply.send({ ok: true, file: fileDetail(database, id) });
    } catch (error) {
      const failure = tmdbFailure(error, 'Applying the metadata match');
      return reply.code(failure.status).send({ error: failure.message });
    }
  });

  app.post('/admin/api/files/:id/unmatch', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = database.sqlite.prepare('SELECT media_item_id,status FROM media_files WHERE id=?').get(id) as { media_item_id: string | null; status: string } | undefined;
    if (!file) return reply.code(404).send({ error: 'File not found' });
    if (!file.media_item_id || ['ignored', 'error'].includes(file.status)) return reply.code(409).send({ error: 'This file does not have a match to remove.' });
    database.sqlite.prepare(`UPDATE media_files SET media_item_id=NULL,status='unmatched',confidence=NULL,manual_override=1,error=NULL,updated_at=? WHERE id=?`).run(Date.now(), id);
    return reply.send({ ok: true, file: fileDetail(database, id) });
  });

  app.post('/admin/api/files/:id/ignore', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = database.sqlite.prepare(`UPDATE media_files SET media_item_id=NULL,status='ignored',confidence=NULL,manual_override=1,error=NULL,updated_at=? WHERE id=?`).run(Date.now(), id);
    return result.changes ? reply.send({ ok: true, file: fileDetail(database, id) }) : reply.code(404).send({ error: 'File not found' });
  });

  app.patch('/admin/api/items/:id', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { displayTitle?: string; poster?: string; background?: string };
    const item = database.sqlite.prepare('SELECT * FROM media_items WHERE id=?').get(id) as MediaItemRow | undefined;
    if (!item) return reply.code(404).send({ error: 'Media item not found' });
    const displayTitle = typeof body.displayTitle === 'string' ? body.displayTitle.trim() || null : item.display_title;
    const poster = typeof body.poster === 'string' ? body.poster.trim() || null : item.poster;
    const background = typeof body.background === 'string' ? body.background.trim() || null : item.background;
    database.sqlite.prepare('UPDATE media_items SET display_title=?,poster=?,background=?,updated_at=? WHERE id=?')
      .run(displayTitle, poster, background, Date.now(), id);
    return reply.send({ ok: true });
  });

  app.post('/admin/api/files/:id/stream', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const file = database.sqlite.prepare("SELECT id FROM media_files WHERE id=? AND media_item_id IS NOT NULL AND status NOT IN ('ignored','error')").get(id) as { id: string } | undefined;
    if (!file) return reply.code(404).send({ error: 'Matched file not found' });
    const expiry = Date.now() + settings.streamTokenExpiryHours * 60 * 60 * 1000;
    const { token, payload } = createStreamToken(id, expiry, config.streamSecret, randomUUID());
    database.sqlite.prepare('INSERT INTO stream_tokens (jti,media_file_id,expires_at,created_at,revoked) VALUES (?,?,?,?,0)')
      .run(payload.jti, id, expiry, Date.now());
    return reply.send({ url: `${settings.baseUrl}/media/${encodeURIComponent(token)}`, expiresAt: expiry });
  });

  app.post('/admin/api/scan', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const mode = (request.body as { mode?: string })?.mode === 'full' ? 'full' : 'changed';
    if (scanner.isRunning()) return reply.code(409).send({ error: 'A scan is already running' });
    void scanner.scan(mode).catch((error) => request.log.error({ error }, 'Manual scan failed'));
    return reply.code(202).send({ ok: true, mode });
  });

  app.post('/admin/api/integrations/:service/test', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const { service } = request.params as { service: string };

    if (!['radarr', 'sonarr'].includes(service)) {
      return reply.code(404).send({ error: 'Unknown integration' });
    }

    const body = request.body as {
      url?: string;
      apiKey?: string;
    };

    const url = (
      body.url?.trim() ||
      (service === 'radarr'
        ? settings.radarrUrl
        : settings.sonarrUrl)
    ).replace(/\/+$/, '');

    const apiKey =
      body.apiKey?.trim() ||
      (service === 'radarr'
        ? settings.radarrApiKey
        : settings.sonarrApiKey);

    if (!url) {
      return reply.code(400).send({
        error: `${service === 'radarr' ? 'Radarr' : 'Sonarr'} URL is required`
      });
    }

    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      return reply.code(400).send({
        error: `${service === 'radarr' ? 'Radarr' : 'Sonarr'} URL must be valid`
      });
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return reply.code(400).send({
        error: `${service === 'radarr' ? 'Radarr' : 'Sonarr'} URL must use HTTP or HTTPS`
      });
    }

    if (!apiKey) {
      return reply.code(400).send({
        error: `${service === 'radarr' ? 'Radarr' : 'Sonarr'} API key is required`
      });
    }

    try {
      if (service === 'radarr') {
        const client = new RadarrClient(url, apiKey);

        const [status, rootFolders, qualityProfiles] =
          await Promise.all([
            client.status(),
            client.rootFolders(),
            client.qualityProfiles()
          ]);

        return reply.send({
          ok: true,
          service: 'radarr',
          instanceName: status.instanceName || 'Radarr',
          version: status.version,
          rootFolders: rootFolders.map((folder) => ({
            id: folder.id,
            path: folder.path,
            accessible: folder.accessible,
            freeSpace: folder.freeSpace
          })),
          qualityProfiles: qualityProfiles.map((profile) => ({
            id: profile.id,
            name: profile.name
          }))
        });
      }

      const client = new SonarrClient(url, apiKey);

      const [status, rootFolders, qualityProfiles] =
        await Promise.all([
          client.status(),
          client.rootFolders(),
          client.qualityProfiles()
        ]);

      return reply.send({
        ok: true,
        service: 'sonarr',
        instanceName: status.instanceName || 'Sonarr',
        version: status.version,
        rootFolders: rootFolders.map((folder) => ({
          id: folder.id,
          path: folder.path,
          accessible: folder.accessible,
          freeSpace: folder.freeSpace
        })),
        qualityProfiles: qualityProfiles.map((profile) => ({
          id: profile.id,
          name: profile.name
        }))
      });
    } catch (error) {
      const detail =
        error instanceof Error
          ? error.message
          : 'Unknown connection error';

      request.log.warn(
        {
          service,
          error: detail
        },
        'Integration connection test failed'
      );

      return reply.code(502).send({
        error: `${service === 'radarr' ? 'Radarr' : 'Sonarr'} connection failed: ${detail}`
      });
    }
  });

  app.put('/admin/api/settings', { preHandler: requireAdmin(config, true) }, async (request, reply) => {
    const body = request.body as Record<string, string>;
    let baseUrl: URL;
    try { baseUrl = new URL(body.baseUrl || ''); } catch { return reply.code(400).send({ error: 'BASE_URL must be a valid URL' }); }
    if (!['http:', 'https:'].includes(baseUrl.protocol)) return reply.code(400).send({ error: 'BASE_URL must use HTTP or HTTPS' });

    const numeric: Array<[string, number]> = [
      ['scanIntervalMinutes', 1],
      ['minimumFileSizeMb', 0],
      ['streamTokenExpiryHours', 1]
    ];

    for (const [key, minimum] of numeric) {
      if (!Number.isFinite(Number(body[key])) || Number(body[key]) < minimum) {
        return reply.code(400).send({ error: `${key} is invalid` });
      }
    }

    for (const key of [
      'baseUrl',
      'moviesPath',
      'tvPath',
      'scanIntervalMinutes',
      'minimumFileSizeMb',
      'streamTokenExpiryHours',
      'longLivedStreamTokens',
      'adminUsername'
    ]) {
      if (typeof body[key] === 'string' && body[key]!.trim()) {
        settings.set(key, body[key]!);
      }
    }

    if (body.tmdbApiKey?.trim()) {
      settings.set('tmdbApiKey', body.tmdbApiKey);
    }

    // Automatic request toggles.
    for (const key of [
      'autoRequestEnabled',
      'radarrEnabled',
      'sonarrEnabled',
      'sonarrSeparateAnimeRoot'
    ]) {
      if (body[key] === 'true' || body[key] === 'false') {
        settings.set(key, body[key]!);
      }
    }

    // Radarr/Sonarr URLs may be blank while an integration is disabled.
    for (const [key, label] of [
      ['radarrUrl', 'Radarr'],
      ['sonarrUrl', 'Sonarr']
    ] as const) {
      if (typeof body[key] !== 'string') continue;

      const value = body[key]!.trim();

      if (value) {
        let parsed: URL;

        try {
          parsed = new URL(value);
        } catch {
          return reply.code(400).send({
            error: `${label} URL must be a valid URL`
          });
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return reply.code(400).send({
            error: `${label} URL must use HTTP or HTTPS`
          });
        }
      }

      settings.set(key, value);
    }

    // Optional library/root paths may be cleared.
    for (const key of [
      'animePath',
      'radarrRootFolderPath',
      'sonarrRootFolderPath',
      'sonarrAnimeRootFolderPath'
    ]) {
      if (typeof body[key] === 'string') {
        settings.set(key, body[key]!);
      }
    }

    // Profile ID 0 means "not selected yet".
    for (const key of [
      'radarrQualityProfileId',
      'sonarrQualityProfileId',
      'sonarrAnimeQualityProfileId'
    ]) {
      if (typeof body[key] !== 'string') continue;

      const value = Number(body[key]);

      if (
        !Number.isInteger(value) ||
        value < 0
      ) {
        return reply.code(400).send({
          error: `${key} is invalid`
        });
      }

      settings.set(key, String(value));
    }

    // Blank API-key fields preserve the already stored secret.
    if (body.radarrApiKey?.trim()) {
      settings.set('radarrApiKey', body.radarrApiKey);
    }

    if (body.sonarrApiKey?.trim()) {
      settings.set('sonarrApiKey', body.sonarrApiKey);
    }

    if (body.newPassword) {
      if (body.newPassword.length < 10) return reply.code(400).send({ error: 'The admin password must be at least 10 characters' });
      settings.set('adminPasswordHash', await hashPassword(body.newPassword));
    }
    await scanner.reloadSchedules();
    return reply.send({ ok: true, settings: settings.publicView() });
  });
}
