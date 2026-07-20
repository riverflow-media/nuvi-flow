import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { AppDatabase } from './db/index.js';
import { hashPassword } from './lib/security.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStremioRoutes } from './routes/stremio.js';
import { MediaScanner } from './services/scanner.js';
import { SettingsService } from './services/settings.js';
import { TmdbService } from './services/tmdb.js';

export interface BuiltApp {
  app: FastifyInstance;
  database: AppDatabase;
  settings: SettingsService;
  scanner: MediaScanner;
  tmdb: TmdbService;
}

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 256 * 1024,
    requestTimeout: 0
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.ip });
  const database = new AppDatabase(config.databasePath);
  const settings = new SettingsService(database, config);
  if (!settings.adminPasswordHash) settings.set('adminPasswordHash', await hashPassword(config.adminPassword));
  const tmdb = new TmdbService(database, settings);
  const scanner = new MediaScanner(database, settings, tmdb, config, app.log);

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/admin')) return;
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Range, Content-Type');
    reply.header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Range, Content-Length');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  app.get('/health', async (_request, reply) => {
    try {
      database.sqlite.prepare('SELECT 1').get();
      const library = database.sqlite.prepare(`SELECT COUNT(*) files,
        SUM(CASE WHEN status='matched' THEN 1 ELSE 0 END) matched,
        SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) errors FROM media_files`).get() as Record<string, number | null>;
      return reply.header('Cache-Control', 'no-store').send({
        status: 'ok', scanning: scanner.isRunning(), metadata: settings.publicView().metadataProvider,
        library: { files: library.files || 0, matched: library.matched || 0, errors: library.errors || 0 }
      });
    } catch {
      return reply.code(503).send({ status: 'unhealthy' });
    }
  });
  registerStremioRoutes(app, database, settings, config);
  registerMediaRoutes(app, database, config);
  registerAdminRoutes(app, database, settings, scanner, tmdb, config);
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const candidate = error as { statusCode?: number; message?: string };
    const statusCode = candidate.statusCode && candidate.statusCode < 500 ? candidate.statusCode : 500;
    if (!reply.sent) reply.code(statusCode).send({ error: statusCode < 500 ? candidate.message || 'Invalid request' : 'The request could not be completed.' });
  });
  return { app, database, settings, scanner, tmdb };
}
