import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AppDatabase } from '../db/index.js';
import { isMediaFilename, parseEpisodeFilename, parseMovieFilename, shouldIgnorePath } from '../lib/filename-parser.js';
import type { MediaFileRow, MediaType } from '../types.js';
import { inspectMedia } from './ffprobe.js';
import type { RequestService } from './requester.js';
import type { SettingsService } from './settings.js';
import type { SiloFileMappingStore } from './silo-file-mappings.js';
import type { TmdbService } from './tmdb.js';

interface FoundFile { absolutePath: string; relativePath: string; type: MediaType; size: number; mtimeMs: number }
export type ScanMode = 'changed' | 'full' | 'watcher' | 'startup';
export type ScanPhase = 'discovering' | 'processing' | 'reconciling';

export interface ScanProgressSnapshot {
  mode: ScanMode;
  phase: ScanPhase;
  status: 'running' | 'cancelling';
  startedAt: number;
  elapsedMs: number;
  discovered: number;
  examined: number;
  processed: number;
  matched: number;
  unmatched: number;
  errors: number;
  progressPercent: number | null;
  cancelRequested: boolean;
}

interface ActiveScan {
  runId: string;
  mode: ScanMode;
  phase: ScanPhase;
  startedAt: number;
  discovered: number;
  examined: number;
  processed: number;
  matched: number;
  unmatched: number;
  errors: number;
  cancelRequested: boolean;
  cancelReason: 'administrator' | 'shutdown' | null;
  controller: AbortController;
}

function stableFileId(type: MediaType, absolutePath: string): string {
  return `file_${createHash('sha256').update(`${type}:${absolutePath}`).digest('hex').slice(0, 24)}`;
}

function subtitleLanguage(name: string, mediaStem: string): string | null {
  const rest = name.slice(mediaStem.length).replace(/^\./, '').split('.')[0]?.toLowerCase();
  if (!rest || rest === name.toLowerCase()) return null;
  const aliases: Record<string, string> = { eng: 'en', english: 'en', fre: 'fr', fra: 'fr', french: 'fr', spa: 'es', spanish: 'es', ger: 'de', deu: 'de' };
  return aliases[rest] || (/^[a-z]{2,3}$/.test(rest) ? rest : null);
}

async function walk(
  root: string,
  type: MediaType,
  minimumBytes: number,
  signal: AbortSignal,
  onDiscovered: () => void
): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  async function visit(directory: string): Promise<void> {
    signal.throwIfAborted();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      signal.throwIfAborted();
      if (entry.name.startsWith('.')) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath);
      else if ((entry.isFile() || entry.isSymbolicLink()) && isMediaFilename(entry.name) && !shouldIgnorePath(absolutePath)) {
        const stat = await fs.promises.stat(absolutePath);
        if (stat.isFile() && stat.size >= minimumBytes) {
          found.push({ absolutePath, relativePath: path.relative(root, absolutePath), type, size: stat.size, mtimeMs: stat.mtimeMs });
          onDiscovered();
        }
      }
    }
  }
  await visit(root);
  return found;
}

export class MediaScanner {
  private running: Promise<void> | null = null;
  private activeScan: ActiveScan | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private watchDebounce: NodeJS.Timeout | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: SettingsService,
    private readonly tmdb: TmdbService,
    private readonly requester: RequestService,
    private readonly config: AppConfig,
    private readonly logger: FastifyBaseLogger,
    private readonly siloMappings?: SiloFileMappingStore
  ) {
    this.database.sqlite.prepare(
      `UPDATE scan_runs
       SET status='interrupted',finished_at=COALESCE(finished_at,?),
           message=COALESCE(message,'Scan interrupted by an earlier process exit.')
       WHERE status='running'`
    ).run(Date.now());
  }

  scan(mode: ScanMode = 'changed'): Promise<void> {
    if (this.running) return this.running;
    const active: ActiveScan = {
      runId: randomUUID(),
      mode,
      phase: 'discovering',
      startedAt: Date.now(),
      discovered: 0,
      examined: 0,
      processed: 0,
      matched: 0,
      unmatched: 0,
      errors: 0,
      cancelRequested: false,
      cancelReason: null,
      controller: new AbortController()
    };
    this.activeScan = active;
    const running = this.performScan(active).finally(() => {
      if (this.activeScan === active) this.activeScan = null;
      if (this.running === running) this.running = null;
    });
    this.running = running;
    return this.running;
  }

  isRunning(): boolean { return Boolean(this.running); }

  snapshot(): ScanProgressSnapshot | null {
    const active = this.activeScan;
    if (!active) return null;
    const progressPercent = active.phase === 'discovering'
      ? null
      : active.discovered === 0
        ? 100
        : Math.min(100, Math.floor(active.examined / active.discovered * 100));
    return {
      mode: active.mode,
      phase: active.phase,
      status: active.cancelRequested ? 'cancelling' : 'running',
      startedAt: active.startedAt,
      elapsedMs: Math.max(0, Date.now() - active.startedAt),
      discovered: active.discovered,
      examined: active.examined,
      processed: active.processed,
      matched: active.matched,
      unmatched: active.unmatched,
      errors: active.errors,
      progressPercent,
      cancelRequested: active.cancelRequested
    };
  }

  cancel(reason: 'administrator' | 'shutdown' = 'administrator'): boolean {
    const active = this.activeScan;
    if (!active || active.cancelRequested) return false;
    active.cancelRequested = true;
    active.cancelReason = reason;
    active.controller.abort();
    return true;
  }

  private async performScan(active: ActiveScan): Promise<void> {
    const { runId, mode, startedAt } = active;
    const signal = active.controller.signal;
    this.database.sqlite.prepare('INSERT INTO scan_runs (id,mode,status,started_at) VALUES (?,?,?,?)').run(runId, mode, 'running', startedAt);
    try {
    const configuredRoots: Array<{ path: string; type: MediaType }> = [
      { path: this.settings.moviesPath, type: 'movie' },
      { path: this.settings.tvPath, type: 'series' },
      ...(this.settings.animePath
        ? [{ path: this.settings.animePath, type: 'series' as MediaType }]
        : [])
    ];

    const roots = [
      ...new Map(
        configuredRoots.map((root) => [
          `${root.type}:${path.resolve(root.path)}`,
          root
        ])
      ).values()
    ];

    const files: FoundFile[] = [];
    const scannedRoots: Array<{ path: string; type: MediaType }> = [];
    for (const root of roots) {
      signal.throwIfAborted();
      try {
        const stat = await fs.promises.stat(root.path);
        if (!stat.isDirectory()) throw new Error('not a directory');
        files.push(...await walk(
          root.path,
          root.type,
          this.settings.minimumFileSizeMb * 1024 * 1024,
          signal,
          () => { active.discovered += 1; }
        ));
        scannedRoots.push(root);
      } catch (error) {
        if (signal.aborted) throw error;
        active.errors += 1;
        this.logger.warn({ libraryType: root.type, error: error instanceof Error ? error.message : String(error) }, 'Media directory is unavailable');
      }
    }
    active.discovered = files.length;
    this.database.sqlite.prepare('UPDATE scan_runs SET discovered=?,errors=? WHERE id=?').run(files.length, active.errors, runId);
    active.phase = 'processing';
    let nextFile = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const index = nextFile;
        nextFile += 1;
        const file = files[index];
        if (!file) return;
        try {
          const existing = this.database.sqlite.prepare('SELECT * FROM media_files WHERE absolute_path=?').get(file.absolutePath) as MediaFileRow | undefined;
          if (mode !== 'full' && existing && existing.size === file.size && Math.abs(existing.mtime_ms - file.mtimeMs) < 1
            && (existing.status !== 'unmatched' || Boolean(existing.manual_override))) {
            this.database.sqlite.prepare('UPDATE media_files SET last_seen_at=? WHERE id=?').run(startedAt, existing.id);
            if (existing.status === 'matched') active.matched += 1;
            else if (existing.status === 'unmatched') active.unmatched += 1;
          } else {
            const result = await this.processFile(file, existing, startedAt, signal);
            active.processed += 1;
            if (result === 'matched') active.matched += 1;
            if (result === 'unmatched') active.unmatched += 1;
          }
        } catch (error) {
          if (signal.aborted) return;
          active.processed += 1;
          active.errors += 1;
          this.recordFileError(file, startedAt, error);
          this.logger.error({ file: file.relativePath }, 'Media scan item failed; details are available in the authenticated admin console');
        }
        active.examined += 1;
        this.database.sqlite.prepare('UPDATE scan_runs SET processed=?,matched=?,unmatched=?,errors=? WHERE id=?')
          .run(active.processed, active.matched, active.unmatched, active.errors, runId);
      }
    };
    const workers = Math.min(files.length, Math.max(1, this.config.scanConcurrency));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    signal.throwIfAborted();

    active.phase = 'reconciling';
    for (const root of scannedRoots) {
      signal.throwIfAborted();
      const rootPrefix = path.resolve(root.path) + path.sep;

      this.database.sqlite
        .prepare(
          `DELETE FROM media_files
           WHERE library_type=?
             AND substr(absolute_path, 1, ?) = ?
             AND last_seen_at < ?`
        )
        .run(
          root.type,
          rootPrefix.length,
          rootPrefix,
          startedAt
        );
    }
    const requestsAdded =
      this.requester
        .reconcileAvailableFromLibrary();

    this.database.sqlite.prepare(`UPDATE scan_runs SET status='completed',finished_at=?,processed=?,matched=?,unmatched=?,errors=? WHERE id=?`)
      .run(Date.now(), active.processed, active.matched, active.unmatched, active.errors, runId);
    this.database.sqlite.prepare('DELETE FROM stream_tokens WHERE expires_at < ?').run(Date.now());
    this.logger.info({
      runId,
      discovered: files.length,
      processed: active.processed,
      matched: active.matched,
      unmatched: active.unmatched,
      errors: active.errors,
      requestsAdded
    }, 'Media scan completed');
    } catch (error) {
      if (signal.aborted) {
        const message = active.cancelReason === 'shutdown'
          ? 'Scan cancelled during graceful shutdown.'
          : 'Scan cancelled by an administrator.';
        this.database.sqlite.prepare(
          `UPDATE scan_runs
           SET status='cancelled',finished_at=?,discovered=?,processed=?,matched=?,unmatched=?,errors=?,message=?
           WHERE id=?`
        ).run(
          Date.now(),
          active.discovered,
          active.processed,
          active.matched,
          active.unmatched,
          active.errors,
          message,
          runId
        );
        this.logger.info({ runId, reason: active.cancelReason }, 'Media scan cancelled');
        return;
      }
      active.errors += 1;
      this.database.sqlite.prepare(
        `UPDATE scan_runs
         SET status='failed',finished_at=?,discovered=?,processed=?,matched=?,unmatched=?,errors=?,message=?
         WHERE id=?`
      ).run(
        Date.now(),
        active.discovered,
        active.processed,
        active.matched,
        active.unmatched,
        active.errors,
        'Scan failed before completion.',
        runId
      );
      this.logger.error({ runId, error }, 'Media scan failed');
      throw error;
    }
  }

  private async processFile(
    file: FoundFile,
    existing: MediaFileRow | undefined,
    scanTime: number,
    signal: AbortSignal
  ): Promise<'matched' | 'unmatched' | 'ignored'> {
    signal.throwIfAborted();
    const fileChanged = Boolean(existing) && (
      existing!.size !== file.size ||
      Math.abs(existing!.mtime_ms - file.mtimeMs) >= 1
    );
    const parsedMovie = file.type === 'movie' ? parseMovieFilename(file.relativePath) : null;
    const parsedEpisode = file.type === 'series' ? parseEpisodeFilename(file.relativePath) : null;
    const parsedTitle = parsedMovie?.title || parsedEpisode?.title || path.basename(file.relativePath, path.extname(file.relativePath));
    const probe = await inspectMedia(file.absolutePath, this.config.ffprobePath, signal);
    signal.throwIfAborted();
    let mediaItemId = existing?.manual_override ? existing.media_item_id : null;
    let confidence = existing?.manual_override ? existing.confidence : null;
    let status: 'matched' | 'unmatched' | 'ignored' = existing?.manual_override && existing.status === 'ignored'
      ? 'ignored' : mediaItemId ? 'matched' : 'unmatched';
    if (!existing?.manual_override && !mediaItemId && (parsedMovie || parsedEpisode)) {
      const parsedYear = parsedMovie?.year || parsedEpisode?.year;
      const results = await this.tmdb.search(file.type, parsedTitle, parsedYear);
      signal.throwIfAborted();
      const best = results[0];
      confidence = best?.confidence ?? null;
      if (best && (best.confidence ?? 0) >= 0.78) {
        try {
          mediaItemId = await this.tmdb.ensureMediaItem(file.type, best);
          signal.throwIfAborted();
          status = 'matched';
          if (file.type === 'series' && parsedEpisode) await this.tmdb.ensureEpisodeMetadata(mediaItemId, best, parsedEpisode.season);
        } catch (error) {
          if (signal.aborted) throw error;
          this.logger.warn({ title: parsedTitle, provider: best.provider, error: error instanceof Error ? error.message : String(error) },
            'Online metadata details were unavailable; using local metadata');
        }
      }
      signal.throwIfAborted();
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
    signal.throwIfAborted();
    const id = existing?.id || stableFileId(file.type, file.absolutePath);
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
    if (fileChanged) this.siloMappings?.markStale(id);
    signal.throwIfAborted();
    await this.updateExternalSubtitles(id, file, signal);
    return status;
  }

  private async updateExternalSubtitles(
    mediaFileId: string,
    file: FoundFile,
    signal: AbortSignal
  ): Promise<void> {
    const directory = path.dirname(file.absolutePath);
    const stem = path.basename(file.absolutePath, path.extname(file.absolutePath));
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}(?:\\.[a-z]{2,12})?\\.(srt|vtt|ass|ssa)$`, 'i');
    const names = await fs.promises.readdir(directory);
    const seen: string[] = [];
    for (const name of names) {
      signal.throwIfAborted();
      const match = pattern.exec(name);
      if (!match) continue;
      const absolutePath = path.join(directory, name);
      const stat = await fs.promises.stat(absolutePath);
      signal.throwIfAborted();
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
    let message = rawMessage
      .replaceAll(file.absolutePath, '[media file]')
      .replaceAll(this.settings.moviesPath, '[movies]')
      .replaceAll(this.settings.tvPath, '[tv]');

    if (this.settings.animePath) {
      message = message.replaceAll(
        this.settings.animePath,
        '[anime]'
      );
    }

    message = message.slice(0, 500);
    this.database.sqlite.prepare(`INSERT INTO media_files
      (id,library_type,absolute_path,relative_path,size,mtime_ms,status,error,added_at,updated_at,last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(absolute_path) DO UPDATE SET size=excluded.size,mtime_ms=excluded.mtime_ms,
      status='error',error=excluded.error,updated_at=excluded.updated_at,last_seen_at=excluded.last_seen_at`)
      .run(existing?.id || stableFileId(file.type, file.absolutePath), file.type, file.absolutePath, file.relativePath,
        file.size, file.mtimeMs, 'error', message, existing?.added_at || Date.now(), Date.now(), scanTime);
  }

  startSchedules(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      void this.scan('changed').catch((error) => {
        this.logger.error({ error }, 'Scheduled media scan failed');
      });
    }, this.settings.scanIntervalMinutes * 60_000);
    this.timer.unref();
    if (this.config.watch) {
      const watchRoots = [
        this.settings.moviesPath,
        this.settings.tvPath,
        ...(this.settings.animePath
          ? [this.settings.animePath]
          : [])
      ].filter(
        (value, index, values) =>
          values.indexOf(value) === index
      );

      this.watcher = chokidar.watch(watchRoots, {
        ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 5_000, pollInterval: 500 },
        ignored: (candidate) => path.basename(candidate).startsWith('.')
      });
      const schedule = () => {
        if (this.watchDebounce) clearTimeout(this.watchDebounce);
        this.watchDebounce = setTimeout(() => {
          void this.scan('watcher').catch((error) => {
            this.logger.error({ error }, 'Watcher media scan failed');
          });
        }, 2_000);
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
    this.cancel('shutdown');
    if (this.running) await this.running.catch(() => {});
  }
}
