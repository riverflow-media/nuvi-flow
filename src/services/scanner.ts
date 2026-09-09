import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import chokidar, { type FSWatcher } from 'chokidar';
import pLimit from 'p-limit';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { isMediaFilename, parseEpisodeFilename, parseMovieFilename, shouldIgnorePath } from '../lib/filename-parser.js';
import type { MediaFileRow, MediaType } from '../types.js';
import { inspectMedia } from './ffprobe.js';
import type { SettingsService } from './settings.js';
import type { TmdbService } from './tmdb.js';

interface FoundFile { absolutePath: string; relativePath: string; type: MediaType; size: number; mtimeMs: number }
type ScanMode = 'changed' | 'full' | 'watcher' | 'startup';

function stableFileId(type: MediaType, relativePath: string): string {
  return `file_${createHash('sha256').update(`${type}:${relativePath}`).digest('hex').slice(0, 24)}`;
}

function subtitleLanguage(name: string, mediaStem: string): string | null {
  const rest = name.slice(mediaStem.length).replace(/^\./, '').split('.')[0]?.toLowerCase();
  if (!rest || rest === name.toLowerCase()) return null;
  const aliases: Record<string, string> = { eng: 'en', english: 'en', fre: 'fr', fra: 'fr', french: 'fr', spa: 'es', spanish: 'es', ger: 'de', deu: 'de' };
  return aliases[rest] || (/^[a-z]{2,3}$/.test(rest) ? rest : null);
}

async function walk(root: string, type: MediaType, minimumBytes: number): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if ((entry.isFile() || entry.isSymbolicLink()) && isMediaFilename(entry.name) && !shouldIgnorePath(absolutePath)) {
        const stat = await fs.promises.stat(absolutePath);
        if (stat.isFile() && stat.size >= minimumBytes) found.push({ absolutePath, relativePath: path.relative(root, absolutePath), type, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await visit(root);
  return found;
}

export class MediaScanner {
  private running: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: SettingsService,
    private readonly tmdb: TmdbService,
    private readonly config: AppConfig,
    private readonly logger: FastifyBaseLogger
  ) {}

  scan(mode: ScanMode = 'changed'): Promise<void> {
    if (this.running) return this.running;
    this.running = this.performScan(mode).finally(() => { this.running = null; });
    return this.running;
  }

  isRunning(): boolean { return Boolean(this.running); }

  private async performScan(mode: ScanMode): Promise<void> {
    const runId = randomUUID();
    const startedAt = Date.now();
    this.database.sqlite.prepare('INSERT INTO scan_runs (id,mode,status,started_at) VALUES (?,?,?,?)').run(runId, mode, 'running', startedAt);
    const roots: Array<{ path: string; type: MediaType }> = [
      { path: this.settings.moviesPath, type: 'movie' }, { path: this.settings.tvPath, type: 'series' }
    ];
    const files: FoundFile[] = [];
    const scannedTypes = new Set<MediaType>();
    let errors = 0;
    for (const root of roots) {
      try {
        const stat = await fs.promises.stat(root.path);
        if (!stat.isDirectory()) throw new Error('not a directory');
        files.push(...await walk(root.path, root.type, this.settings.minimumFileSizeMb * 1024 * 1024));
        scannedTypes.add(root.type);
      } catch (error) {
        errors += 1;
        this.logger.warn({ libraryType: root.type, error: error instanceof Error ? error.message : String(error) }, 'Media directory is unavailable');
      }
    }
    this.database.sqlite.prepare('UPDATE scan_runs SET discovered=?,errors=? WHERE id=?').run(files.length, errors, runId);
    const limit = pLimit(this.config.scanConcurrency);
    let processed = 0;
    let matched = 0;
    let unmatched = 0;
    await Promise.all(files.map((file) => limit(async () => {
      try {
        const existing = this.database.sqlite.prepare('SELECT * FROM media_files WHERE absolute_path=?').get(file.absolutePath) as MediaFileRow | undefined;
        if (mode !== 'full' && existing && existing.size === file.size && Math.abs(existing.mtime_ms - file.mtimeMs) < 1
          && (existing.status !== 'unmatched' || Boolean(existing.manual_override))) {
          this.database.sqlite.prepare('UPDATE media_files SET last_seen_at=? WHERE id=?').run(startedAt, existing.id);
          if (existing.status === 'matched') matched += 1;
          else if (existing.status === 'unmatched') unmatched += 1;
          return;
        }
        const result = await this.processFile(file, existing, startedAt);
        processed += 1;
        if (result === 'matched') matched += 1;
        if (result === 'unmatched') unmatched += 1;
      } catch (error) {
        processed += 1;
        errors += 1;
        this.recordFileError(file, startedAt, error);
        this.logger.error({ file: file.relativePath }, 'Media scan item failed; details are available in the authenticated admin console');
      } finally {
        this.database.sqlite.prepare('UPDATE scan_runs SET processed=?,matched=?,unmatched=?,errors=? WHERE id=?')
          .run(processed, matched, unmatched, errors, runId);
      }
    })));

    for (const type of scannedTypes) {
      this.database.sqlite.prepare('DELETE FROM media_files WHERE library_type=? AND last_seen_at < ?').run(type, startedAt);
    }
    this.database.sqlite.prepare(`UPDATE scan_runs SET status='completed',finished_at=?,processed=?,matched=?,unmatched=?,errors=? WHERE id=?`)
      .run(Date.now(), processed, matched, unmatched, errors, runId);
    this.database.sqlite.prepare('DELETE FROM stream_tokens WHERE expires_at < ?').run(Date.now());
    this.logger.info({ runId, discovered: files.length, processed, matched, unmatched, errors }, 'Media scan completed');
  }

  private async processFile(file: FoundFile, existing: MediaFileRow | undefined, scanTime: number): Promise<'matched' | 'unmatched' | 'ignored'> {
    const parsedMovie = file.type === 'movie' ? parseMovieFilename(file.relativePath) : null;
    const parsedEpisode = file.type === 'series' ? parseEpisodeFilename(file.relativePath) : null;
    const parsedTitle = parsedMovie?.title || parsedEpisode?.title || path.basename(file.relativePath, path.extname(file.relativePath));
    const probe = await inspectMedia(file.absolutePath, this.config.ffprobePath);
    let mediaItemId = existing?.manual_override ? existing.media_item_id : null;
    let confidence = existing?.manual_override ? existing.confidence : null;
    let status: 'matched' | 'unmatched' | 'ignored' = existing?.manual_override && existing.status === 'ignored'
      ? 'ignored' : mediaItemId ? 'matched' : 'unmatched';
    if (!existing?.manual_override && !mediaItemId && (parsedMovie || parsedEpisode)) {
      const parsedYear = parsedMovie?.year || parsedEpisode?.year;
      const results = await this.tmdb.search(file.type, parsedTitle, parsedYear);
      const best = results[0];
      confidence = best?.confidence ?? null;
      if (best && (best.confidence ?? 0) >= 0.78) {
        try {
          mediaItemId = await this.tmdb.ensureMediaItem(file.type, best);
          status = 'matched';
          if (file.type === 'series' && parsedEpisode) await this.tmdb.ensureEpisodeMetadata(mediaItemId, best, parsedEpisode.season);
        } catch (error) {
          this.logger.warn({ title: parsedTitle, provider: best.provider, error: error instanceof Error ? error.message : String(error) },
            'Online metadata details were unavailable; using local metadata');
        }
      }
      if (!mediaItemId) {
        mediaItemId = this.tmdb.ensureLocalMediaItem(file.type, parsedTitle, parsedYear);
        confidence = best?.confidence ?? 0.5;
        status = 'matched';
        if (file.type === 'series' && parsedEpisode) {
          this.tmdb.ensureLocalEpisodeMetadata(mediaItemId, parsedEpisode.season, parsedEpisode.episodeStart,
            parsedEpisode.episodeEnd, parsedEpisode.episodeTitle);
        }
      }
    }
    const id = existing?.id || stableFileId(file.type, file.relativePath);
    const now = Date.now();
    this.database.sqlite.prepare(`INSERT INTO media_files (
      id,library_type,absolute_path,relative_path,size,mtime_ms,duration_seconds,bitrate,video_codec,audio_codec,
      width,height,frame_rate,audio_channels,audio_tracks_json,audio_languages_json,subtitle_tracks_json,probe_json,parsed_title,
      parsed_year,edition,quality,source,season,episode_start,episode_end,media_item_id,confidence,manual_override,
      status,compatibility_warning,error,added_at,updated_at,last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(absolute_path) DO UPDATE SET relative_path=excluded.relative_path,size=excluded.size,mtime_ms=excluded.mtime_ms,
      duration_seconds=excluded.duration_seconds,bitrate=excluded.bitrate,video_codec=excluded.video_codec,
      audio_codec=excluded.audio_codec,width=excluded.width,height=excluded.height,frame_rate=excluded.frame_rate,
      audio_channels=excluded.audio_channels,audio_tracks_json=excluded.audio_tracks_json,audio_languages_json=excluded.audio_languages_json,
      subtitle_tracks_json=excluded.subtitle_tracks_json,probe_json=excluded.probe_json,parsed_title=excluded.parsed_title,
      parsed_year=excluded.parsed_year,edition=excluded.edition,quality=excluded.quality,source=excluded.source,
      season=excluded.season,episode_start=excluded.episode_start,episode_end=excluded.episode_end,
      media_item_id=excluded.media_item_id,confidence=excluded.confidence,status=excluded.status,
      compatibility_warning=excluded.compatibility_warning,error=NULL,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`).run(
        id, file.type, file.absolutePath, file.relativePath, file.size, file.mtimeMs, probe.durationSeconds, probe.bitrate,
        probe.videoCodec, probe.audioCodec, probe.width, probe.height, probe.frameRate, probe.audioChannels,
        JSON.stringify(probe.audioTracks), JSON.stringify(probe.audioLanguages), JSON.stringify(probe.subtitleTracks), JSON.stringify(probe.raw), parsedTitle,
        parsedMovie?.year ?? null, parsedMovie?.edition ?? null, parsedMovie?.resolution || parsedEpisode?.resolution || null,
        parsedMovie?.source || parsedEpisode?.source || null, parsedEpisode?.season ?? null,
        parsedEpisode?.episodeStart ?? null, parsedEpisode?.episodeEnd ?? null, mediaItemId, confidence,
        existing?.manual_override ?? 0, status, probe.compatibilityWarning, null, existing?.added_at || now, now, scanTime
      );
    await this.updateExternalSubtitles(id, file);
    return status;
  }

  private async updateExternalSubtitles(mediaFileId: string, file: FoundFile): Promise<void> {
    const directory = path.dirname(file.absolutePath);
    const stem = path.basename(file.absolutePath, path.extname(file.absolutePath));
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?:\\.[a-z]{2,12})?\\.(srt|vtt|ass|ssa)$`, 'i');
    const names = await fs.promises.readdir(directory);
    const seen: string[] = [];
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match) continue;
      const absolutePath = path.join(directory, name);
      const stat = await fs.promises.stat(absolutePath);
      const id = `sub_${createHash('sha256').update(absolutePath).digest('hex').slice(0, 24)}`;
      seen.push(id);
      this.database.sqlite.prepare(`INSERT INTO external_subtitles
        (id,media_file_id,absolute_path,relative_path,language,format,size,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(absolute_path) DO UPDATE SET media_file_id=excluded.media_file_id,relative_path=excluded.relative_path,
        language=excluded.language,format=excluded.format,size=excluded.size,updated_at=excluded.updated_at`)
        .run(id, mediaFileId, absolutePath, path.basename(absolutePath), subtitleLanguage(name, stem), match[1]!.toLowerCase(), stat.size, Date.now());
    }
    if (seen.length) {
      const placeholders = seen.map(() => '?').join(',');
      this.database.sqlite.prepare(`DELETE FROM external_subtitles WHERE media_file_id=? AND id NOT IN (${placeholders})`).run(mediaFileId, ...seen);
    } else this.database.sqlite.prepare('DELETE FROM external_subtitles WHERE media_file_id=?').run(mediaFileId);
  }

  private recordFileError(file: FoundFile, scanTime: number, error: unknown): void {
    const existing = this.database.sqlite.prepare('SELECT id,added_at FROM media_files WHERE absolute_path=?').get(file.absolutePath) as { id: string; added_at: number } | undefined;
    const rawMessage = error instanceof Error ? error.message : 'Unknown scan error';
    const message = rawMessage
      .replaceAll(file.absolutePath, '[media file]')
      .replaceAll(this.settings.moviesPath, '[movies]')
      .replaceAll(this.settings.tvPath, '[tv]')
      .slice(0, 500);
    this.database.sqlite.prepare(`INSERT INTO media_files
      (id,library_type,absolute_path,relative_path,size,mtime_ms,status,error,added_at,updated_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(absolute_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,
      status='error',error=excluded.error,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`)
      .run(existing?.id || stableFileId(file.type, file.relativePath), file.type, file.absolutePath, file.relativePath,
        file.size, file.mtimeMs, 'error', message, existing?.added_at || Date.now(), Date.now(), scanTime);
  }

  startSchedules(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.scan('changed'), this.settings.scanIntervalMinutes * 60_000);
    this.timer.unref();
    if (this.config.watch) {
      this.watcher = chokidar.watch([this.settings.moviesPath, this.settings.tvPath], {
        ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 5_000, pollInterval: 500 },
        ignored: (candidate) => path.basename(candidate).startsWith('.')
      });
      const schedule = () => {
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => void this.scan('watcher'), 2_000);
      };
      this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule).on('error', (error) => this.logger.warn({ error }, 'Media watcher error'));
    }
  }

  async reloadSchedules(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) await this.watcher.close();
    this.timer = null;
    this.watcher = null;
    this.startSchedules();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    if (this.watcher) await this.watcher.close();
    if (this.running) await Promise.race([this.running, delay(20_000)]);
  }
}
