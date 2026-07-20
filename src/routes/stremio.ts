import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/index.js';
import { parseJson } from '../lib/json.js';
import { createStreamToken } from '../lib/security.js';
import { catalogPreview, fullMeta, streamTitle } from '../stremio/builders.js';
import type { ExternalSubtitleRow, MediaFileRow, MediaItemRow, MediaType } from '../types.js';
import type { SettingsService } from '../services/settings.js';
import type { AppConfig } from '../config.js';

const manifest = {
  id: 'community.zimapersonalmedia',
  version: '1.1.0',
  name: 'Zima Personal Media',
  description: 'Direct playback of your personal movie and TV library.',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'personal_movies', name: 'Personal Movies', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'personal_series', name: 'Personal Series', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'movie', id: 'recent_movies', name: 'Recently Added Movies', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] },
    { type: 'series', id: 'recent_series', name: 'Recently Added Series', extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }] }
  ],
  idPrefixes: ['tt', 'zpm:']
};

function parseExtra(extra?: string): Record<string, string> {
  if (!extra) return {};
  const parsed: Record<string, string> = {};
  for (const part of extra.split('&')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try { parsed[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1)); } catch { /* ignore malformed extras */ }
  }
  return parsed;
}

function catalogType(catalogId: string): MediaType | null {
  if (['personal_movies', 'recent_movies'].includes(catalogId)) return 'movie';
  if (['personal_series', 'recent_series'].includes(catalogId)) return 'series';
  return null;
}

function episodeId(id: string): { itemId: string; season: number; episode: number } | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(id);
  return match ? { itemId: match[1]!, season: Number(match[2]), episode: Number(match[3]) } : null;
}

export function registerStremioRoutes(app: FastifyInstance, database: AppDatabase, settings: SettingsService, config: AppConfig): void {
  app.get('/manifest.json', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300').send(manifest);
  });

  const catalogHandler = async (request: any, reply: any) => {
    const { type, catalogId, extra } = request.params as { type: string; catalogId: string; extra?: string };
    const expectedType = catalogType(catalogId);
    if (!expectedType || type !== expectedType) return reply.code(404).send({ metas: [] });
    const parsedExtra = parseExtra(extra);
    const skip = Math.max(0, Math.min(100_000, Number(parsedExtra.skip || request.query?.skip || 0) || 0));
    const search = String(parsedExtra.search || request.query?.search || '').trim().slice(0, 200);
    const recent = catalogId.startsWith('recent_');
    const order = recent ? 'MAX(mf.added_at) DESC' : 'COALESCE(mi.display_title, mi.title) COLLATE NOCASE ASC';
    const rows = database.sqlite.prepare(`SELECT mi.* FROM media_items mi JOIN media_files mf ON mf.media_item_id=mi.id
      WHERE mi.type=? AND mf.status='matched' AND (?='' OR instr(lower(COALESCE(mi.display_title,mi.title)),lower(?))>0)
      GROUP BY mi.id ORDER BY ${order} LIMIT 100 OFFSET ?`).all(expectedType, search, search, skip) as MediaItemRow[];
    reply.header('Cache-Control', 'public, max-age=60').send({ metas: rows.map(catalogPreview) });
  };
  app.get('/catalog/:type/:catalogId.json', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, catalogHandler);
  app.get('/catalog/:type/:catalogId/:extra.json', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, catalogHandler);

  app.get('/meta/:type/:id.json', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    if (!['movie', 'series'].includes(type)) return reply.code(404).send({ meta: null });
    const item = database.sqlite.prepare(`SELECT mi.* FROM media_items mi WHERE mi.type=? AND mi.stremio_id=?
      AND EXISTS (SELECT 1 FROM media_files mf WHERE mf.media_item_id=mi.id AND mf.status='matched')`).get(type, id) as MediaItemRow | undefined;
    if (!item) return reply.code(404).send({ meta: null });
    let episodes: Array<any> = [];
    if (type === 'series') {
      const files = database.sqlite.prepare(`SELECT season,episode_start,episode_end FROM media_files
        WHERE media_item_id=? AND status='matched' ORDER BY season,episode_start`).all(item.id) as Array<{ season: number; episode_start: number; episode_end: number }>;
      const metadata = database.sqlite.prepare('SELECT season,episode,title,overview,still,air_date,runtime_minutes FROM episode_metadata WHERE media_item_id=?').all(item.id) as Array<any>;
      const metadataByKey = new Map(metadata.map((row) => [`${row.season}:${row.episode}`, row]));
      const expanded = new Map<string, any>();
      for (const file of files) for (let number = file.episode_start; number <= file.episode_end; number += 1) {
        const key = `${file.season}:${number}`;
        expanded.set(key, metadataByKey.get(key) || { season: file.season, episode: number, title: null, overview: null, still: null, air_date: null, runtime_minutes: null });
      }
      episodes = [...expanded.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
    }
    reply.header('Cache-Control', 'public, max-age=300').send({ meta: fullMeta(item, episodes) });
  });

  app.get('/stream/:type/:id.json', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { type, id } = request.params as { type: string; id: string };
    let files: MediaFileRow[] = [];
    if (type === 'movie') {
      files = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
        WHERE mi.type='movie' AND mi.stremio_id=? AND mf.status='matched' ORDER BY mf.quality DESC`).all(id) as MediaFileRow[];
    } else if (type === 'series') {
      const parsed = episodeId(id);
      if (parsed) files = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
        WHERE mi.type='series' AND mi.stremio_id=? AND mf.status='matched' AND mf.season=?
        AND mf.episode_start<=? AND mf.episode_end>=? ORDER BY mf.quality DESC`).all(parsed.itemId, parsed.season, parsed.episode, parsed.episode) as MediaFileRow[];
    }
    const streams = files.map((file) => {
      const expiry = Date.now() + settings.streamTokenExpiryHours * 60 * 60 * 1000;
      const { token, payload } = createStreamToken(file.id, expiry, config.streamSecret);
      database.sqlite.prepare('INSERT OR IGNORE INTO stream_tokens (jti,media_file_id,expires_at,created_at,revoked) VALUES (?,?,?,?,0)')
        .run(payload.jti, file.id, payload.exp, Date.now());
      const subtitles = database.sqlite.prepare('SELECT * FROM external_subtitles WHERE media_file_id=? ORDER BY language').all(file.id) as ExternalSubtitleRow[];
      return {
        title: streamTitle(file),
        url: `${settings.baseUrl}/media/${encodeURIComponent(token)}`,
        subtitles: subtitles.map((subtitle) => ({
          id: subtitle.id,
          lang: subtitle.language || 'und',
          url: `${settings.baseUrl}/subtitles/${encodeURIComponent(token)}/${encodeURIComponent(subtitle.id)}`
        })),
        behaviorHints: {
          bingeGroup: `zima-personal-media:${file.media_item_id}`,
          filename: path.basename(file.relative_path),
          videoSize: file.size
        },
        description: file.compatibility_warning || undefined
      };
    });
    reply.header('Cache-Control', 'no-store').send({ streams });
  });
}

export { manifest };
