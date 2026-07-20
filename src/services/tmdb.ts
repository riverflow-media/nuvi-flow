import { createHash } from 'node:crypto';
import type { AppDatabase } from '../db/index.js';
import { matchConfidence, normalizedTitle } from '../lib/filename-parser.js';
import type { MediaType } from '../types.js';
import type { SettingsService } from './settings.js';

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const DAY = 24 * 60 * 60 * 1000;

export type MetadataProvider = 'tmdb' | 'cinemeta' | 'local';

export interface MetadataSearchResult {
  id: string;
  provider: Exclude<MetadataProvider, 'local'>;
  title: string;
  year?: number;
  overview?: string;
  poster?: string;
  confidence?: number;
  tmdbId?: number;
  imdbId?: string;
}

interface TmdbPagedResponse<T> { results: T[] }
interface CinemetaCatalogResponse { metas?: Array<Record<string, unknown>> }
interface CinemetaMetaResponse { meta?: Record<string, any> }

function firstYear(value: unknown): number | undefined {
  const match = String(value || '').match(/\b(18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function runtimeMinutes(value: unknown): number | null {
  const match = String(value || '').match(/\d+/);
  return match ? Number(match[0]) : null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

export class TmdbService {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly database: AppDatabase, private readonly settings: SettingsService) {}

  private cached<T>(cacheKey: string): T | undefined {
    const row = this.database.sqlite.prepare(
      'SELECT response_json FROM tmdb_cache WHERE cache_key = ? AND expires_at > ?'
    ).get(cacheKey, Date.now()) as { response_json: string } | undefined;
    return row ? JSON.parse(row.response_json) as T : undefined;
  }

  private storeCache(cacheKey: string, body: unknown, ttlMs: number): void {
    this.database.sqlite.prepare(`INSERT INTO tmdb_cache (cache_key, response_json, expires_at, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET response_json=excluded.response_json,
      expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
      .run(cacheKey, JSON.stringify(body), Date.now() + ttlMs, Date.now());
  }

  private async fetchJson<T>(url: URL, headers: Record<string, string>, cacheKey: string, ttlMs: number): Promise<T> {
    const cached = this.cached<T>(cacheKey);
    if (cached) return cached;
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing as Promise<T>;
    const pending = this.fetchFresh<T>(url, headers, cacheKey, ttlMs);
    this.inFlight.set(cacheKey, pending);
    try { return await pending; } finally { this.inFlight.delete(cacheKey); }
  }

  private async fetchFresh<T>(url: URL, headers: Record<string, string>, cacheKey: string, ttlMs: number): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) {
          const error = new Error(`Metadata request failed with HTTP ${response.status}`);
          if (![408, 429, 500, 502, 503, 504].includes(response.status)) throw error;
          lastError = error;
        } else {
          const body = await response.json() as T;
          this.storeCache(cacheKey, body, ttlMs);
          return body;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/HTTP (400|401|403|404)/.test(lastError.message)) break;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
    throw lastError || new Error('Metadata request failed');
  }

  private async tmdbRequest<T>(endpoint: string, params: Record<string, string> = {}, ttlMs = DAY): Promise<T> {
    const apiKey = this.settings.tmdbApiKey;
    if (!apiKey) throw new Error('TMDB API key is not configured');
    const query = new URLSearchParams({ language: 'en-US', ...params });
    const url = new URL(`${TMDB_BASE}${endpoint}`);
    for (const [key, value] of query) url.searchParams.set(key, value);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey.startsWith('eyJ')) headers.authorization = `Bearer ${apiKey}`;
    else url.searchParams.set('api_key', apiKey);
    return this.fetchJson(url, headers, `tmdb:${endpoint}?${query.toString()}`, ttlMs);
  }

  private cinemetaRequest<T>(endpoint: string, ttlMs = DAY): Promise<T> {
    const url = new URL(endpoint, CINEMETA_BASE);
    return this.fetchJson(url, { accept: 'application/json' }, `cinemeta:${endpoint}`, ttlMs);
  }

  private async searchTmdb(type: MediaType, title: string, year?: number): Promise<MetadataSearchResult[]> {
    const endpoint = type === 'movie' ? '/search/movie' : '/search/tv';
    const params: Record<string, string> = { query: title, include_adult: 'false' };
    if (year) params[type === 'movie' ? 'primary_release_year' : 'first_air_date_year'] = String(year);
    const response = await this.tmdbRequest<TmdbPagedResponse<Record<string, unknown>>>(endpoint, params);
    return response.results.slice(0, 12).map((result) => {
      const candidateTitle = String(result.title || result.name || 'Untitled');
      const candidateYear = firstYear(result.release_date || result.first_air_date);
      const tmdbId = Number(result.id);
      return {
        id: String(tmdbId), provider: 'tmdb' as const, tmdbId, title: candidateTitle, year: candidateYear,
        overview: typeof result.overview === 'string' ? result.overview : undefined,
        poster: typeof result.poster_path === 'string' ? `${TMDB_IMAGE_BASE}/w342${result.poster_path}` : undefined,
        confidence: matchConfidence(title, year, candidateTitle, candidateYear)
      };
    }).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  }

  private async searchCinemeta(type: MediaType, title: string, year?: number): Promise<MetadataSearchResult[]> {
    const endpoint = `/catalog/${type}/top/search=${encodeURIComponent(title)}.json`;
    const response = await this.cinemetaRequest<CinemetaCatalogResponse>(endpoint);
    return (response.metas || []).filter((result) => /^tt\d+$/.test(String(result.id || ''))).slice(0, 12).map((result) => {
      const candidateTitle = String(result.name || 'Untitled');
      const candidateYear = firstYear(result.releaseInfo || result.year || result.released);
      const imdbId = String(result.id);
      return {
        id: imdbId, provider: 'cinemeta' as const, imdbId, title: candidateTitle, year: candidateYear,
        overview: typeof result.description === 'string' ? result.description : undefined,
        poster: typeof result.poster === 'string' ? result.poster : undefined,
        confidence: matchConfidence(title, year, candidateTitle, candidateYear)
      };
    }).sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  }

  async search(type: MediaType, title: string, year?: number): Promise<MetadataSearchResult[]> {
    if (this.settings.tmdbApiKey) {
      try {
        const tmdbResults = await this.searchTmdb(type, title, year);
        if (tmdbResults.length) return tmdbResults;
      } catch {
        // A missing, rejected, or temporarily unavailable key must not disable automatic metadata.
      }
    }
    try { return await this.searchCinemeta(type, title, year); } catch { return []; }
  }

  async details(type: MediaType, tmdbId: number): Promise<Record<string, any>> {
    const endpoint = type === 'movie' ? `/movie/${tmdbId}` : `/tv/${tmdbId}`;
    return this.tmdbRequest(endpoint, { append_to_response: 'external_ids,credits,images', include_image_language: 'en,null' }, 30 * DAY);
  }

  async season(tmdbId: number, season: number): Promise<Record<string, any>> {
    return this.tmdbRequest(`/tv/${tmdbId}/season/${season}`, {}, 30 * DAY);
  }

  private async cinemetaDetails(type: MediaType, imdbId: string): Promise<Record<string, any>> {
    const response = await this.cinemetaRequest<CinemetaMetaResponse>(`/meta/${type}/${encodeURIComponent(imdbId)}.json`, 30 * DAY);
    if (!response.meta) throw new Error('Cinemeta metadata was not found');
    return response.meta;
  }

  async ensureMediaItem(type: MediaType, selection: number | string | MetadataSearchResult): Promise<string> {
    const normalized: MetadataSearchResult = typeof selection === 'object'
      ? selection
      : typeof selection === 'number' || /^\d+$/.test(selection)
        ? { id: String(selection), provider: 'tmdb', tmdbId: Number(selection), title: '' }
        : { id: String(selection), provider: 'cinemeta', imdbId: String(selection), title: '' };
    return normalized.provider === 'tmdb'
      ? this.ensureTmdbMediaItem(type, normalized.tmdbId || Number(normalized.id))
      : this.ensureCinemetaMediaItem(type, normalized.imdbId || normalized.id);
  }

  private async ensureTmdbMediaItem(type: MediaType, tmdbId: number): Promise<string> {
    const existing = this.database.sqlite.prepare('SELECT id FROM media_items WHERE type = ? AND tmdb_id = ?').get(type, tmdbId) as { id: string } | undefined;
    if (existing) return existing.id;
    const details = await this.details(type, tmdbId);
    const imdbId = String(details.imdb_id || details.external_ids?.imdb_id || '') || null;
    const byImdb = imdbId ? this.database.sqlite.prepare('SELECT id FROM media_items WHERE type=? AND imdb_id=?').get(type, imdbId) as { id: string } | undefined : undefined;
    const id = byImdb?.id || `tmdb:${type}:${tmdbId}`;
    const title = String(details.title || details.name || `TMDB ${tmdbId}`);
    const releaseDate = details.release_date || details.first_air_date || null;
    const credits = details.credits || {};
    const cast = (credits.cast || []).slice(0, 12).map((person: any) => person.name).filter(Boolean);
    const directors = (credits.crew || []).filter((person: any) => person.job === 'Director' || person.job === 'Creator')
      .slice(0, 8).map((person: any) => person.name).filter(Boolean);
    const logoPath = details.images?.logos?.find((image: any) => image.iso_639_1 === 'en')?.file_path || details.images?.logos?.[0]?.file_path;
    const now = Date.now();
    this.database.sqlite.prepare(`INSERT INTO media_items (
      id,type,stremio_id,tmdb_id,imdb_id,title,year,description,poster,background,logo,genres_json,
      cast_json,directors_json,runtime_minutes,release_date,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      stremio_id=excluded.stremio_id,tmdb_id=excluded.tmdb_id,imdb_id=excluded.imdb_id,title=excluded.title,
      year=excluded.year,description=excluded.description,poster=excluded.poster,background=excluded.background,
      logo=excluded.logo,genres_json=excluded.genres_json,cast_json=excluded.cast_json,
      directors_json=excluded.directors_json,runtime_minutes=excluded.runtime_minutes,
      release_date=excluded.release_date,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(
      id, type, imdbId || `zpm:${type}:tmdb:${tmdbId}`, tmdbId, imdbId, title, firstYear(releaseDate) || null,
      details.overview || null, details.poster_path ? `${TMDB_IMAGE_BASE}/w780${details.poster_path}` : null,
      details.backdrop_path ? `${TMDB_IMAGE_BASE}/original${details.backdrop_path}` : null,
      logoPath ? `${TMDB_IMAGE_BASE}/original${logoPath}` : null,
      JSON.stringify((details.genres || []).map((genre: any) => genre.name)), JSON.stringify(cast), JSON.stringify(directors),
      type === 'movie' ? details.runtime || null : details.episode_run_time?.[0] || null, releaseDate,
      JSON.stringify({ provider: 'tmdb', ...details }), now, now
    );
    return id;
  }

  private async ensureCinemetaMediaItem(type: MediaType, imdbId: string): Promise<string> {
    const existing = this.database.sqlite.prepare('SELECT id FROM media_items WHERE type=? AND stremio_id=?').get(type, imdbId) as { id: string } | undefined;
    if (existing) return existing.id;
    const details = await this.cinemetaDetails(type, imdbId);
    const id = `cinemeta:${type}:${imdbId}`;
    const releaseDate = typeof details.released === 'string' ? details.released.slice(0, 10) : null;
    const now = Date.now();
    this.database.sqlite.prepare(`INSERT INTO media_items (
      id,type,stremio_id,tmdb_id,imdb_id,title,year,description,poster,background,logo,genres_json,
      cast_json,directors_json,runtime_minutes,release_date,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,year=excluded.year,description=excluded.description,poster=excluded.poster,
      background=excluded.background,logo=excluded.logo,genres_json=excluded.genres_json,
      cast_json=excluded.cast_json,directors_json=excluded.directors_json,runtime_minutes=excluded.runtime_minutes,
      release_date=excluded.release_date,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).run(
      id, type, imdbId, null, imdbId, String(details.name || imdbId), firstYear(details.year || details.releaseInfo || releaseDate) || null,
      details.description || null, details.poster || null, details.background || null, details.logo || null,
      JSON.stringify(stringArray(details.genres)), JSON.stringify(stringArray(details.cast)),
      JSON.stringify(stringArray(details.director)), runtimeMinutes(details.runtime), releaseDate,
      JSON.stringify({ provider: 'cinemeta', ...details }), now, now
    );
    return id;
  }

  ensureLocalMediaItem(type: MediaType, title: string, year?: number): string {
    const identity = `${type}:${normalizedTitle(title)}:${year || ''}`;
    const digest = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    const id = `local:${type}:${digest}`;
    const stremioId = `zpm:${type}:local:${digest}`;
    const now = Date.now();
    this.database.sqlite.prepare(`INSERT INTO media_items (
      id,type,stremio_id,tmdb_id,imdb_id,title,year,metadata_json,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,year=excluded.year,updated_at=excluded.updated_at`)
      .run(id, type, stremioId, null, null, title, year || null, JSON.stringify({ provider: 'local' }), now, now);
    return id;
  }

  async ensureEpisodeMetadata(mediaItemId: string, selection: number | string | MetadataSearchResult, seasonNumber: number): Promise<void> {
    const normalized: MetadataSearchResult = typeof selection === 'object'
      ? selection
      : typeof selection === 'number' || /^\d+$/.test(selection)
        ? { id: String(selection), provider: 'tmdb', tmdbId: Number(selection), title: '' }
        : { id: String(selection), provider: 'cinemeta', imdbId: String(selection), title: '' };
    if (normalized.provider === 'tmdb') {
      const tmdbId = normalized.tmdbId || Number(normalized.id);
      const season = await this.season(tmdbId, seasonNumber);
      this.upsertEpisodes(mediaItemId, (season.episodes || []).map((episode: any) => ({
        season: seasonNumber, episode: episode.episode_number, tmdbId: episode.id || null,
        title: episode.name, overview: episode.overview,
        still: episode.still_path ? `${TMDB_IMAGE_BASE}/w780${episode.still_path}` : null,
        airDate: episode.air_date, runtime: episode.runtime, raw: episode
      })));
      return;
    }
    const imdbId = normalized.imdbId || normalized.id;
    const details = await this.cinemetaDetails('series', imdbId);
    this.upsertEpisodes(mediaItemId, (details.videos || []).filter((episode: any) => Number(episode.season) === seasonNumber).map((episode: any) => ({
      season: seasonNumber, episode: Number(episode.episode || episode.number), tmdbId: null,
      title: episode.name || episode.title, overview: episode.overview || episode.description,
      still: episode.thumbnail, airDate: String(episode.released || episode.firstAired || '').slice(0, 10) || null,
      runtime: runtimeMinutes(episode.runtime), raw: episode
    })));
  }

  ensureLocalEpisodeMetadata(mediaItemId: string, season: number, episodeStart: number, episodeEnd: number, title?: string): void {
    this.upsertEpisodes(mediaItemId, Array.from({ length: episodeEnd - episodeStart + 1 }, (_, offset) => ({
      season, episode: episodeStart + offset, tmdbId: null,
      title: episodeStart === episodeEnd ? title : undefined, overview: null, still: null, airDate: null, runtime: null,
      raw: { provider: 'local' }
    })));
  }

  private upsertEpisodes(mediaItemId: string, episodes: Array<Record<string, any>>): void {
    const insert = this.database.sqlite.prepare(`INSERT INTO episode_metadata (
      id,media_item_id,season,episode,tmdb_id,title,overview,still,air_date,runtime_minutes,metadata_json,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(media_item_id,season,episode) DO UPDATE SET
      tmdb_id=excluded.tmdb_id,title=excluded.title,overview=excluded.overview,still=excluded.still,
      air_date=excluded.air_date,runtime_minutes=excluded.runtime_minutes,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`);
    this.database.sqlite.transaction(() => {
      for (const episode of episodes) {
        if (!Number.isInteger(episode.episode) || episode.episode < 0) continue;
        insert.run(`${mediaItemId}:${episode.season}:${episode.episode}`, mediaItemId, episode.season, episode.episode,
          episode.tmdbId || null, episode.title || null, episode.overview || null, episode.still || null,
          episode.airDate || null, episode.runtime || null, JSON.stringify(episode.raw || episode), Date.now());
      }
    })();
  }
}
