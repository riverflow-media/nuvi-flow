import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import type { AppConfig } from './config.js';
import { AppDatabase } from './db/index.js';
import {
  addonIconPath,
  defaultAddonIconSvg,
  detectAddonIconType,
  MAX_ADDON_ICON_BYTES
} from './lib/branding.js';
import { hashPassword } from './lib/security.js';
import { redactAddonAccessPath } from './lib/addon-access.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerStremioRoutes } from './routes/stremio.js';
import { MediaScanner } from './services/scanner.js';
import { PlaybackSessionRegistry } from './services/playback/playback-sessions.js';
import { DeviceCapabilityStore } from './services/playback/device-capabilities.js';
import { PlaybackService } from './services/playback/playback-service.js';
import { FallbackAddonService } from './services/playback/fallback-addon.js';
import { NetworkProfileStore } from './services/playback/network-profiles.js';
import { PlaybackActivityService } from './services/playback/playback-activity.js';
import { PlaybackOutcomeStore } from './services/playback/playback-outcomes.js';
import { JellyfinPlaybackService } from './services/playback/jellyfin-playback.js';
import { RequestService } from './services/requester.js';
import { SiloService } from './services/silo-service.js';
import { SiloFileMappingStore } from './services/silo-file-mappings.js';
import { PlaybackServersService } from './services/playback-servers.js';
import { PlaybackServerMappingStore } from './services/playback-server-mappings.js';
import { SettingsService } from './services/settings.js';
import { SystemDiagnosticsService } from './services/system-diagnostics.js';
import { DatabaseBackupService } from './services/database-backups.js';
import { TmdbService } from './services/tmdb.js';

export interface BuiltApp {
  app: FastifyInstance;
  database: AppDatabase;
  settings: SettingsService;
  scanner: MediaScanner;
  tmdb: TmdbService;
  requester: RequestService;
  silo: SiloService;
  playbackServers: PlaybackServersService;
  jellyfinPlayback: JellyfinPlaybackService;
  playbackServerMappings: PlaybackServerMappingStore;
  playbackSessions: PlaybackSessionRegistry;
  deviceCapabilities: DeviceCapabilityStore;
  playback: PlaybackService;
  fallbackAddon: FallbackAddonService;
  networkProfiles: NetworkProfileStore;
  playbackActivity: PlaybackActivityService;
  playbackOutcomes: PlaybackOutcomeStore;
  databaseBackups: DatabaseBackupService;
  systemDiagnostics: SystemDiagnosticsService;
}

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      serializers: {
        req(request: any) {
          return {
            method: request.method,
            url: redactAddonAccessPath(request.url || ''),
            host: request.host,
            remoteAddress: request.remoteAddress,
            remotePort: request.remotePort
          };
        }
      }
    },
    trustProxy: config.trustProxy,
    exposeHeadRoutes: false,
    routerOptions: { maxParamLength: 1024 },
    bodyLimit: 256 * 1024,
    requestTimeout: 0
  });
  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: MAX_ADDON_ICON_BYTES
    }
  });
  await app.register(rateLimit, { global: false, keyGenerator: (request) => request.ip });
  const database = new AppDatabase(config.databasePath);
  const databaseBackups = new DatabaseBackupService(database, config, app.log);
  const settings = new SettingsService(database, config);
  const siloMappings = new SiloFileMappingStore(database);
  const playbackServerMappings = new PlaybackServerMappingStore(database);
  const silo = new SiloService(settings, siloMappings);
  const playbackServers = new PlaybackServersService(
    settings,
    playbackServerMappings
  );
  const playbackSessions =
    new PlaybackSessionRegistry();
  const deviceCapabilities = new DeviceCapabilityStore(database);
  const playbackOutcomes = new PlaybackOutcomeStore(database);
  const playback = new PlaybackService(
    silo,
    playbackSessions,
    deviceCapabilities,
    app.log,
    {
      runtimeFallback: {
        enabled: () => settings.siloRuntimeFallbackEnabled,
        slowSegmentMs: () => settings.siloRuntimeFallbackSlowSegmentMs,
        slowSegmentCount: () => settings.siloRuntimeFallbackSlowSegmentCount,
        startupMs: () => settings.siloRuntimeFallbackStartupMs,
        maxAttempts: () => settings.siloRuntimeFallbackMaxAttempts
      },
      startCapacity: {
        maxConcurrent: () => settings.siloMaxConcurrentStarts,
        maxQueued: () => settings.siloMaxQueuedStarts,
        queueTimeoutMs: () => settings.siloStartQueueTimeoutMs
      },
      outcomes: playbackOutcomes
    }
  );
  const fallbackAddon = new FallbackAddonService(settings, app.log, {
    outcomes: playbackOutcomes
  });
  const networkProfiles = new NetworkProfileStore(
    database,
    config.streamSecret,
    config.trustProxy
  );
  const jellyfinPlayback = new JellyfinPlaybackService(
    settings,
    playbackServers,
    deviceCapabilities,
    app.log
  );
  const playbackActivity = new PlaybackActivityService(
    playbackSessions,
    fallbackAddon,
    {
      outcomes: playbackOutcomes,
      jellyfin: jellyfinPlayback
    }
  );
  playback.setFallbackAddon(fallbackAddon);

  app.addHook('onClose', async () => {
    await jellyfinPlayback.close();
    await playback.close();
    playbackActivity.close();
    fallbackAddon.close();
  });
  if (!settings.adminPasswordHash) settings.set('adminPasswordHash', await hashPassword(config.adminPassword));

  app.get('/addon-icon', {
    config: {
      rateLimit: {
        max: 600,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const versioned =
      request.url.includes('?v=') ||
      request.url.includes('&v=');

    try {
      const buffer =
        await fs.promises.readFile(
          addonIconPath(config)
        );

      const mime =
        detectAddonIconType(buffer);

      if (!mime) {
        throw new Error(
          'Stored addon icon has an unsupported format'
        );
      }

      return reply
        .header(
          'Cache-Control',
          versioned
            ? 'public, max-age=31536000, immutable'
            : 'no-store'
        )
        .type(mime)
        .send(buffer);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException)
          .code !== 'ENOENT'
      ) {
        app.log.warn(
          { error },
          'Could not load custom addon icon'
        );
      }

      return reply
        .header(
          'Cache-Control',
          versioned
            ? 'public, max-age=300'
            : 'no-store'
        )
        .type('image/svg+xml')
        .send(defaultAddonIconSvg());
    }
  });

  const tmdb = new TmdbService(database, settings);
  const requester = new RequestService(database, settings, app.log);
  const scanner = new MediaScanner(
    database,
    settings,
    tmdb,
    requester,
    config,
    app.log,
    siloMappings,
    playbackServers
  );

  requester.setLibraryRescanHandler(
    () => scanner.scan('changed')
  );
  const systemDiagnostics = new SystemDiagnosticsService(
    database,
    settings,
    scanner,
    silo,
    fallbackAddon,
    playback,
    playbackOutcomes,
    databaseBackups,
    playbackServers,
    jellyfinPlayback,
    config
  );

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/admin')) return;
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    reply.header(
      'Access-Control-Allow-Headers',
      'Range, Content-Type, Accept, If-None-Match, If-Modified-Since, X-Nuvi-Flow-Device-Id, X-Stremio-Device-Id, X-Stremio-Client, X-Stremio-Version'
    );
    reply.header(
      'Access-Control-Expose-Headers',
      'Accept-Ranges, Content-Range, Content-Length, ETag, Last-Modified, X-Nuvi-Flow-Playback-Id'
    );
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
  registerStremioRoutes(
    app,
    database,
    settings,
    config,
    requester,
    fallbackAddon,
    networkProfiles,
    deviceCapabilities
  );
  registerMediaRoutes(
    app,
    database,
    config,
    settings,
    playback,
    silo,
    jellyfinPlayback,
    fallbackAddon,
    networkProfiles,
    playbackActivity
  );
  registerAdminRoutes(
    app,
    database,
    settings,
    scanner,
    tmdb,
    requester,
    config,
    silo,
    playbackServers,
    jellyfinPlayback,
    fallbackAddon,
    playback,
    playbackActivity,
    deviceCapabilities,
    playbackOutcomes,
    databaseBackups,
    systemDiagnostics
  );
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: 'Not found' }));
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error({ err: error }, 'Request failed');
    const candidate = error as { statusCode?: number; message?: string };
    const statusCode = candidate.statusCode && candidate.statusCode < 500 ? candidate.statusCode : 500;
    if (!reply.sent) reply.code(statusCode).send({ error: statusCode < 500 ? candidate.message || 'Invalid request' : 'The request could not be completed.' });
  });
  return {
    app,
    database,
    settings,
    scanner,
    tmdb,
    requester,
    silo,
    playbackServers,
    jellyfinPlayback,
    playbackServerMappings,
    playbackSessions,
    deviceCapabilities,
    playback,
    fallbackAddon,
    networkProfiles,
    playbackActivity,
    playbackOutcomes,
    databaseBackups,
    systemDiagnostics
  };
}
