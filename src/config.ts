import path from 'node:path';

export interface AppConfig {
  port: number;
  host: string;
  baseUrl: string;
  addonName: string;
  tmdbApiKey: string;
  adminUsername: string;
  adminPassword: string;
  sessionSecret: string;
  streamSecret: string;
  databasePath: string;
  moviesPath: string;
  tvPath: string;
  animePath: string;
  scanIntervalMinutes: number;
  streamTokenExpiryHours: number;
  longLivedStreamTokens: boolean;
  minimumFileSizeMb: number;
  scanConcurrency: number;
  trustProxy: boolean;
  logLevel: string;
  ffprobePath: string;
  watch: boolean;
  scanOnStartup: boolean;

  autoRequestEnabled: boolean;

  radarrEnabled: boolean;
  radarrUrl: string;
  radarrApiKey: string;

  sonarrEnabled: boolean;
  sonarrUrl: string;
  sonarrApiKey: string;

  siloEnabled: boolean;
  siloUrl: string;
  siloApiKey: string;
  siloProfileId: string;
  siloTranscodeQuality: string;
}

function numberValue(value: string | undefined, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = env.DATABASE_PATH || path.resolve('data/media.db');
  return {
    port: numberValue(env.PORT, 60500, 1),
    host: env.HOST || '0.0.0.0',
    baseUrl: cleanBaseUrl(env.BASE_URL || `http://localhost:${env.PORT || 60500}`),
    addonName: env.ADDON_NAME?.trim() || 'Nuvi-Flow',
    tmdbApiKey: env.TMDB_API_KEY?.trim() || '',
    adminUsername: env.ADMIN_USERNAME?.trim() || 'admin',
    adminPassword: env.ADMIN_PASSWORD || 'change-me',
    sessionSecret: env.SESSION_SECRET || 'development-session-secret-change-me',
    streamSecret: env.STREAM_SECRET || 'development-stream-secret-change-me',
    databasePath,
    moviesPath: env.MOVIES_PATH || '/media/movies',
    tvPath: env.TV_PATH || '/media/tv',
    animePath: env.ANIME_PATH?.trim() || '',
    scanIntervalMinutes: numberValue(env.SCAN_INTERVAL_MINUTES, 30, 1),
    streamTokenExpiryHours: numberValue(env.STREAM_TOKEN_EXPIRY_HOURS, 168, 1),
    longLivedStreamTokens: booleanValue(env.LONG_LIVED_STREAM_TOKENS, false),
    minimumFileSizeMb: numberValue(env.MINIMUM_FILE_SIZE_MB, 50, 0),
    scanConcurrency: Math.floor(numberValue(env.SCAN_CONCURRENCY, 2, 1)),
    trustProxy: booleanValue(env.TRUST_PROXY, false),
    logLevel: env.LOG_LEVEL || 'info',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    watch: booleanValue(env.WATCH_MEDIA, true),
    scanOnStartup: booleanValue(env.SCAN_ON_STARTUP, true),

    autoRequestEnabled: booleanValue(env.AUTO_REQUEST_ENABLED, false),

    radarrEnabled: booleanValue(env.RADARR_ENABLED, false),
    radarrUrl: cleanBaseUrl(env.RADARR_URL || ''),
    radarrApiKey: env.RADARR_API_KEY?.trim() || '',

    sonarrEnabled: booleanValue(env.SONARR_ENABLED, false),
    sonarrUrl: cleanBaseUrl(env.SONARR_URL || ''),
    sonarrApiKey: env.SONARR_API_KEY?.trim() || '',

    siloEnabled: booleanValue(env.SILO_ENABLED, false),
    siloUrl: cleanBaseUrl(
      env.SILO_URL || 'http://silo:8080'
    ),
    siloApiKey: env.SILO_API_KEY?.trim() || '',
    siloProfileId: env.SILO_PROFILE_ID?.trim() || '',
    siloTranscodeQuality:
      env.SILO_TRANSCODE_QUALITY?.trim() || 'auto'
  };
}

export function validateProductionSecrets(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.adminPassword === 'change-me') warnings.push('ADMIN_PASSWORD still uses the example value');
  if (config.sessionSecret.length < 32) warnings.push('SESSION_SECRET should be at least 32 characters');
  if (config.streamSecret.length < 32) warnings.push('STREAM_SECRET should be at least 32 characters');
  return warnings;
}
