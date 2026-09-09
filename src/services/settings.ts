import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';

export class SettingsService {
  constructor(private readonly database: AppDatabase, private readonly defaults: AppConfig) {}

  get(key: string, fallback = ''): string {
    return this.database.getSetting(key) ?? fallback;
  }

  set(key: string, value: string): void {
    this.database.setSetting(key, value.trim());
  }

  get baseUrl(): string { return this.get('baseUrl', this.defaults.baseUrl).replace(/\/+$/, ''); }
  get tmdbApiKey(): string { return this.get('tmdbApiKey', this.defaults.tmdbApiKey); }
  get moviesPath(): string { return this.get('moviesPath', this.defaults.moviesPath); }
  get tvPath(): string { return this.get('tvPath', this.defaults.tvPath); }
  get scanIntervalMinutes(): number { return this.number('scanIntervalMinutes', this.defaults.scanIntervalMinutes, 1); }
  get minimumFileSizeMb(): number { return this.number('minimumFileSizeMb', this.defaults.minimumFileSizeMb, 0); }
  get streamTokenExpiryHours(): number {
    if (this.longLivedStreamTokens) return Math.max(24 * 365 * 10, this.defaults.streamTokenExpiryHours);
    return this.number('streamTokenExpiryHours', this.defaults.streamTokenExpiryHours, 1);
  }
  get longLivedStreamTokens(): boolean { return this.boolean('longLivedStreamTokens', this.defaults.longLivedStreamTokens); }
  get adminUsername(): string { return this.get('adminUsername', this.defaults.adminUsername); }
  get adminPasswordHash(): string | undefined { return this.database.getSetting('adminPasswordHash'); }

  get autoRequestEnabled(): boolean {
    return this.boolean('autoRequestEnabled', this.defaults.autoRequestEnabled);
  }

  get radarrEnabled(): boolean {
    return this.boolean('radarrEnabled', this.defaults.radarrEnabled);
  }

  get radarrUrl(): string {
    return this.get('radarrUrl', this.defaults.radarrUrl).replace(/\/+$/, '');
  }

  get radarrApiKey(): string {
    return this.get('radarrApiKey', this.defaults.radarrApiKey);
  }

  get radarrRootFolderPath(): string {
    return this.get('radarrRootFolderPath');
  }

  get radarrQualityProfileId(): number {
    return this.number('radarrQualityProfileId', 0, 0);
  }

  get sonarrEnabled(): boolean {
    return this.boolean('sonarrEnabled', this.defaults.sonarrEnabled);
  }

  get sonarrUrl(): string {
    return this.get('sonarrUrl', this.defaults.sonarrUrl).replace(/\/+$/, '');
  }

  get sonarrApiKey(): string {
    return this.get('sonarrApiKey', this.defaults.sonarrApiKey);
  }

  get sonarrRootFolderPath(): string {
    return this.get('sonarrRootFolderPath');
  }

  get sonarrSeparateAnimeRoot(): boolean {
    return this.boolean('sonarrSeparateAnimeRoot', false);
  }

  get sonarrAnimeRootFolderPath(): string {
    return this.get('sonarrAnimeRootFolderPath');
  }

  get sonarrQualityProfileId(): number {
    return this.number('sonarrQualityProfileId', 0, 0);
  }

  private number(key: string, fallback: number, minimum: number): number {
    const parsed = Number(this.database.getSetting(key));
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.database.getSetting(key);
    if (value === undefined) return fallback;
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }

  publicView(): Record<string, string | number | boolean> {
    return {
      baseUrl: this.baseUrl,
      tmdbConfigured: Boolean(this.tmdbApiKey),
      metadataProvider: this.tmdbApiKey ? 'TMDB with automatic Cinemeta fallback' : 'Automatic Cinemeta with local fallback',
      moviesPath: this.moviesPath,
      tvPath: this.tvPath,
      scanIntervalMinutes: this.scanIntervalMinutes,
      minimumFileSizeMb: this.minimumFileSizeMb,
      streamTokenExpiryHours: this.streamTokenExpiryHours,
      longLivedStreamTokens: this.longLivedStreamTokens,
      adminUsername: this.adminUsername,

      autoRequestEnabled: this.autoRequestEnabled,

      radarrEnabled: this.radarrEnabled,
      radarrUrl: this.radarrUrl,
      radarrConfigured: Boolean(this.radarrApiKey),
      radarrRootFolderPath: this.radarrRootFolderPath,
      radarrQualityProfileId: this.radarrQualityProfileId,

      sonarrEnabled: this.sonarrEnabled,
      sonarrUrl: this.sonarrUrl,
      sonarrConfigured: Boolean(this.sonarrApiKey),
      sonarrRootFolderPath: this.sonarrRootFolderPath,
      sonarrSeparateAnimeRoot: this.sonarrSeparateAnimeRoot,
      sonarrAnimeRootFolderPath: this.sonarrAnimeRootFolderPath,
      sonarrQualityProfileId: this.sonarrQualityProfileId
    };
  }
}
