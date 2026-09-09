import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDatabase } from '../db/index.js';
import type { SettingsService } from './settings.js';
import { RadarrClient } from './radarr.js';
import {
  SonarrClient,
  type SonarrSeriesIdentifiers
} from './sonarr.js';

export type MediaRequestStatus =
  | 'pending'
  | 'requested'
  | 'searching'
  | 'available'
  | 'failed';

export interface MediaRequestRow {
  id: string;
  request_key: string;
  media_type: 'movie' | 'series';
  stremio_id: string;

  imdb_id: string | null;
  tvdb_id: number | null;

  season: number | null;
  episode: number | null;

  title: string | null;

  backend: 'radarr' | 'sonarr';
  backend_item_id: number | null;

  status: MediaRequestStatus;
  message: string | null;

  attempts: number;
  last_attempt_at: number | null;

  created_at: number;
  updated_at: number;
}

interface LocalMediaItem {
  stremio_id: string;
  imdb_id: string | null;
  title: string;
}

interface EpisodeRequestId {
  itemId: string;
  season: number;
  episode: number;
}

const FAILED_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function parseEpisodeId(
  id: string
): EpisodeRequestId | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(id);

  if (!match) return null;

  return {
    itemId: match[1]!,
    season: Number(match[2]),
    episode: Number(match[3])
  };
}

function validImdbId(
  value: string
): boolean {
  return /^tt\d+$/i.test(value.trim());
}

function tvdbIdFromValue(
  value: string
): number | undefined {
  const match = /^tvdb:(\d+)$/i.exec(
    value.trim()
  );

  if (!match) return undefined;

  const id = Number(match[1]);

  return Number.isInteger(id) && id > 0
    ? id
    : undefined;
}

export class RequestService {
  private readonly inflight =
    new Map<string, Promise<void>>();

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: SettingsService,
    private readonly logger: FastifyBaseLogger
  ) {}

  private requestKey(
    type: 'movie' | 'series',
    id: string
  ): string {
    return `${type}:${id}`;
  }

  private existingRequest(
    requestKey: string
  ): MediaRequestRow | undefined {
    return this.database.sqlite
      .prepare(
        `SELECT *
         FROM media_requests
         WHERE request_key=?`
      )
      .get(requestKey) as
      MediaRequestRow | undefined;
  }

  private localItem(
    type: 'movie' | 'series',
    stremioId: string
  ): LocalMediaItem | undefined {
    return this.database.sqlite
      .prepare(
        `SELECT
           stremio_id,
           imdb_id,
           title
         FROM media_items
         WHERE type=?
           AND stremio_id=?`
      )
      .get(type, stremioId) as
      LocalMediaItem | undefined;
  }

  private prepareRequest(
    type: 'movie' | 'series',
    id: string
  ): string | null {
    const requestKey =
      this.requestKey(type, id);

    const existing =
      this.existingRequest(requestKey);

    const now = Date.now();

    if (existing) {
      if (
        existing.status === 'pending' ||
        existing.status === 'requested' ||
        existing.status === 'searching' ||
        existing.status === 'available'
      ) {
        return null;
      }

      if (
        existing.status === 'failed' &&
        existing.last_attempt_at &&
        now - existing.last_attempt_at <
          FAILED_RETRY_COOLDOWN_MS
      ) {
        return null;
      }

      this.database.sqlite
        .prepare(
          `UPDATE media_requests
           SET status='pending',
               message=NULL,
               attempts=attempts+1,
               last_attempt_at=?,
               updated_at=?
           WHERE request_key=?`
        )
        .run(now, now, requestKey);

      return requestKey;
    }

    const backend =
      type === 'movie'
        ? 'radarr'
        : 'sonarr';

    this.database.sqlite
      .prepare(
        `INSERT INTO media_requests (
           id,
           request_key,
           media_type,
           stremio_id,
           backend,
           status,
           attempts,
           last_attempt_at,
           created_at,
           updated_at
         )
         VALUES (?,?,?,?,?,'pending',1,?,?,?)`
      )
      .run(
        randomUUID(),
        requestKey,
        type,
        id,
        backend,
        now,
        now,
        now
      );

    return requestKey;
  }

  enqueueMissing(
    type: 'movie' | 'series',
    id: string
  ): void {
    if (!this.settings.autoRequestEnabled) {
      return;
    }

    if (
      type === 'movie' &&
      !this.settings.radarrEnabled
    ) {
      return;
    }

    if (
      type === 'series' &&
      !this.settings.sonarrEnabled
    ) {
      return;
    }

    const logicalKey =
      this.requestKey(type, id);

    if (this.inflight.has(logicalKey)) {
      return;
    }

    const requestKey =
      this.prepareRequest(type, id);

    if (!requestKey) {
      return;
    }

    const job = this.process(
      type,
      id,
      requestKey
    )
      .catch((error) => {
        this.markFailed(
          requestKey,
          error
        );

        this.logger.warn(
          {
            requestKey,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          'Automatic media request failed'
        );
      })
      .finally(() => {
        this.inflight.delete(
          logicalKey
        );
      });

    this.inflight.set(
      logicalKey,
      job
    );
  }

  retryFailed(
    requestId: string
  ): boolean {
    const existing = this.database.sqlite
      .prepare(
        `SELECT *
         FROM media_requests
         WHERE id=?`
      )
      .get(requestId) as
      MediaRequestRow | undefined;

    if (
      !existing ||
      existing.status !== 'failed'
    ) {
      return false;
    }

    if (
      existing.media_type === 'movie' &&
      !this.settings.radarrEnabled
    ) {
      throw new Error(
        'Radarr is disabled.'
      );
    }

    if (
      existing.media_type === 'series' &&
      !this.settings.sonarrEnabled
    ) {
      throw new Error(
        'Sonarr is disabled.'
      );
    }

    const logicalKey =
      existing.request_key;

    if (
      this.inflight.has(logicalKey)
    ) {
      return false;
    }

    const now = Date.now();

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET status='pending',
             message=NULL,
             attempts=attempts+1,
             last_attempt_at=?,
             updated_at=?
         WHERE id=?`
      )
      .run(
        now,
        now,
        existing.id
      );

    const job = this.process(
      existing.media_type,
      existing.stremio_id,
      existing.request_key
    )
      .catch((error) => {
        this.markFailed(
          existing.request_key,
          error
        );

        this.logger.warn(
          {
            requestKey:
              existing.request_key,
            error:
              error instanceof Error
                ? error.message
                : String(error)
          },
          'Manual media request retry failed'
        );
      })
      .finally(() => {
        this.inflight.delete(
          logicalKey
        );
      });

    this.inflight.set(
      logicalKey,
      job
    );

    return true;
  }

  private async process(
    type: 'movie' | 'series',
    id: string,
    requestKey: string
  ): Promise<void> {
    if (type === 'movie') {
      await this.processMovie(
        id,
        requestKey
      );

      return;
    }

    await this.processEpisode(
      id,
      requestKey
    );
  }

  private resolveMovieImdbId(
    id: string
  ): {
    imdbId: string;
    title?: string;
  } {
    if (validImdbId(id)) {
      return {
        imdbId:
          id.trim().toLowerCase()
      };
    }

    const local =
      this.localItem(
        'movie',
        id
      );

    if (
      local?.imdb_id &&
      validImdbId(local.imdb_id)
    ) {
      return {
        imdbId:
          local.imdb_id
            .trim()
            .toLowerCase(),
        title: local.title
      };
    }

    throw new Error(
      `No IMDb ID is available for movie ${id}.`
    );
  }

  private async processMovie(
    id: string,
    requestKey: string
  ): Promise<void> {
    const resolved =
      this.resolveMovieImdbId(id);

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET imdb_id=?,
             title=COALESCE(?, title),
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        resolved.imdbId,
        resolved.title ?? null,
        Date.now(),
        requestKey
      );

    const radarr =
      new RadarrClient(
        this.settings.radarrUrl,
        this.settings.radarrApiKey
      );

    const result =
      await radarr.ensureMovie(
        resolved.imdbId,
        {
          rootFolderPath:
            this.settings
              .radarrRootFolderPath,

          qualityProfileId:
            this.settings
              .radarrQualityProfileId,

          searchForMovie: true
        }
      );

    const status:
      MediaRequestStatus =
      result.searchTriggered
        ? 'searching'
        : 'requested';

    let message: string;

    if (result.added) {
      message =
        'Added to Radarr and search started.';
    } else if (
      result.searchTriggered
    ) {
      message =
        'Already in Radarr; search started.';
    } else if (
      result.movie.hasFile
    ) {
      message =
        'Already available in Radarr; waiting for Personal Media to detect it.';
    } else {
      message =
        'Already exists in Radarr.';
    }

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET imdb_id=?,
             title=?,
             backend_item_id=?,
             status=?,
             message=?,
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        result.movie.imdbId ??
          resolved.imdbId,

        result.movie.title,

        result.movie.id ?? null,

        status,
        message,
        Date.now(),
        requestKey
      );
  }

  private resolveSeriesIdentifiers(
    itemId: string
  ): {
    identifiers: SonarrSeriesIdentifiers;
    title?: string;
  } {
    const tvdbId =
      tvdbIdFromValue(itemId);

    if (tvdbId) {
      return {
        identifiers: {
          tvdbId
        }
      };
    }

    if (validImdbId(itemId)) {
      return {
        identifiers: {
          imdbId:
            itemId
              .trim()
              .toLowerCase()
        }
      };
    }

    const local =
      this.localItem(
        'series',
        itemId
      );

    if (
      local?.imdb_id &&
      validImdbId(local.imdb_id)
    ) {
      return {
        identifiers: {
          imdbId:
            local.imdb_id
              .trim()
              .toLowerCase()
        },
        title:
          local.title
      };
    }

    throw new Error(
      `No IMDb or TVDB ID is available for series ${itemId}.`
    );
  }

  private async processEpisode(
    id: string,
    requestKey: string
  ): Promise<void> {
    const parsed =
      parseEpisodeId(id);

    if (!parsed) {
      throw new Error(
        `Invalid series episode ID: ${id}.`
      );
    }

    const resolved =
      this.resolveSeriesIdentifiers(
        parsed.itemId
      );

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET imdb_id=?,
             tvdb_id=?,
             season=?,
             episode=?,
             title=COALESCE(?, title),
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        resolved.identifiers.imdbId ??
          null,

        resolved.identifiers.tvdbId ??
          null,

        parsed.season,
        parsed.episode,

        resolved.title ?? null,

        Date.now(),
        requestKey
      );

    const sonarr =
      new SonarrClient(
        this.settings.sonarrUrl,
        this.settings.sonarrApiKey
      );

    const result =
      await sonarr.ensureEpisode(
        resolved.identifiers,
        parsed.season,
        parsed.episode,
        {
          rootFolderPath:
            this.settings
              .sonarrRootFolderPath,

          useSeparateAnimeRoot:
            this.settings
              .sonarrSeparateAnimeRoot,

          animeRootFolderPath:
            this.settings
              .sonarrAnimeRootFolderPath,

          qualityProfileId:
            this.settings
              .sonarrQualityProfileId,

          animeQualityProfileId:
            this.settings
              .sonarrAnimeQualityProfileId
        }
      );

    const status:
      MediaRequestStatus =
      result.searchTriggered
        ? 'searching'
        : 'requested';

    let message: string;

    if (result.searchTriggered) {
      message =
        result.seriesAdded
          ? 'Added to Sonarr and episode search started.'
          : 'Episode search started in Sonarr.';
    } else if (
      result.episode.hasFile
    ) {
      message =
        'Episode already exists in Sonarr; waiting for Personal Media to detect it.';
    } else {
      message =
        'Episode already exists in Sonarr.';
    }

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET imdb_id=?,
             tvdb_id=?,
             title=?,
             backend_item_id=?,
             status=?,
             message=?,
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        result.series.imdbId ??
          resolved.identifiers.imdbId ??
          null,

        result.series.tvdbId ||
          resolved.identifiers.tvdbId ||
          null,

        result.series.title,

        result.series.id ?? null,

        status,
        message,
        Date.now(),
        requestKey
      );
  }

  private markFailed(
    requestKey: string,
    error: unknown
  ): void {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500);

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET status='failed',
             message=?,
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        message,
        Date.now(),
        requestKey
      );
  }

  markAvailable(
    type: 'movie' | 'series',
    id: string
  ): void {
    const requestKey =
      this.requestKey(type, id);

    this.database.sqlite
      .prepare(
        `UPDATE media_requests
         SET status='available',
             message='Available in Personal Media.',
             updated_at=?
         WHERE request_key=?`
      )
      .run(
        Date.now(),
        requestKey
      );
  }

  listRequests(
    limit = 100
  ): MediaRequestRow[] {
    const safeLimit =
      Math.max(
        1,
        Math.min(
          500,
          Math.floor(limit)
        )
      );

    return this.database.sqlite
      .prepare(
        `SELECT *
         FROM media_requests
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(
        safeLimit
      ) as MediaRequestRow[];
  }
}
