import { ArrClient } from './arr-client.js';

export type SonarrSeriesType =
  | 'standard'
  | 'daily'
  | 'anime';

export interface SonarrStatus {
  version: string;
  instanceName?: string;
}

export interface SonarrRootFolder {
  id: number;
  path: string;
  accessible?: boolean;
  freeSpace?: number;
}

export interface SonarrQualityProfile {
  id: number;
  name: string;
}

export interface SonarrSeries {
  id?: number;
  title: string;
  year?: number;

  tvdbId: number;
  imdbId?: string;
  tmdbId?: number;

  titleSlug?: string;
  monitored?: boolean;

  path?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;

  seriesType?: SonarrSeriesType;
  seasonFolder?: boolean;

  [key: string]: unknown;
}

export interface SonarrEpisode {
  id: number;
  seriesId?: number;
  seasonNumber: number;
  episodeNumber: number;

  title?: string;
  monitored?: boolean;
  hasFile?: boolean;

  [key: string]: unknown;
}

export interface AddSonarrSeriesOptions {
  rootFolderPath: string;

  useSeparateAnimeRoot?: boolean;
  animeRootFolderPath?: string;

  qualityProfileId: number;
}

export interface SonarrSeriesIdentifiers {
  imdbId?: string;
  tvdbId?: number;
}

export class SonarrClient {
  private readonly api: ArrClient;

  constructor(
    baseUrl: string,
    apiKey: string
  ) {
    this.api = new ArrClient(baseUrl, apiKey);
  }

  async status(): Promise<SonarrStatus> {
    return this.api.get<SonarrStatus>(
      '/api/v3/system/status'
    );
  }

  async rootFolders(): Promise<SonarrRootFolder[]> {
    return this.api.get<SonarrRootFolder[]>(
      '/api/v3/rootfolder'
    );
  }

  async qualityProfiles(): Promise<SonarrQualityProfile[]> {
    return this.api.get<SonarrQualityProfile[]>(
      '/api/v3/qualityprofile'
    );
  }

  private async lookup(
    term: string
  ): Promise<SonarrSeries[]> {
    return this.api.get<SonarrSeries[]>(
      `/api/v3/series/lookup?term=${encodeURIComponent(term)}`
    );
  }

  async lookupByImdb(
    imdbId: string
  ): Promise<SonarrSeries> {
    const cleanImdbId =
      imdbId.trim().toLowerCase();

    if (!/^tt\d+$/.test(cleanImdbId)) {
      throw new Error(
        `Invalid IMDb ID: ${imdbId}`
      );
    }

    const results =
      await this.lookup(`imdb:${cleanImdbId}`);

    const exact = results.find(
      item =>
        item.imdbId?.trim().toLowerCase() ===
        cleanImdbId
    );

    const series = exact ?? results[0];

    if (!series) {
      throw new Error(
        `Sonarr could not find IMDb ID ${cleanImdbId}.`
      );
    }

    return series;
  }

  async lookupByTvdb(
    tvdbId: number
  ): Promise<SonarrSeries> {
    if (
      !Number.isInteger(tvdbId) ||
      tvdbId <= 0
    ) {
      throw new Error(
        'A valid TVDB ID is required.'
      );
    }

    const results =
      await this.lookup(`tvdb:${tvdbId}`);

    const exact = results.find(
      item => item.tvdbId === tvdbId
    );

    const series = exact ?? results[0];

    if (!series) {
      throw new Error(
        `Sonarr could not find TVDB ID ${tvdbId}.`
      );
    }

    return series;
  }

  async findExistingByTvdb(
    tvdbId: number
  ): Promise<SonarrSeries | undefined> {
    if (
      !Number.isInteger(tvdbId) ||
      tvdbId <= 0
    ) {
      return undefined;
    }

    const results =
      await this.api.get<SonarrSeries[]>(
        `/api/v3/series?tvdbId=${tvdbId}`
      );

    return results.find(
      item => item.tvdbId === tvdbId
    );
  }

  async findExistingByImdb(
    imdbId: string
  ): Promise<SonarrSeries | undefined> {
    const wanted =
      imdbId.trim().toLowerCase();

    if (!/^tt\d+$/.test(wanted)) {
      return undefined;
    }

    const series =
      await this.api.get<SonarrSeries[]>(
        '/api/v3/series'
      );

    return series.find(
      item =>
        item.imdbId?.trim().toLowerCase() ===
        wanted
    );
  }

  private rootFolderFor(
    series: SonarrSeries,
    options: AddSonarrSeriesOptions
  ): string {
    if (
      series.seriesType === 'anime' &&
      options.useSeparateAnimeRoot &&
      options.animeRootFolderPath
    ) {
      return options.animeRootFolderPath;
    }

    return options.rootFolderPath;
  }

  async addSeries(
    lookup: SonarrSeries,
    options: AddSonarrSeriesOptions
  ): Promise<SonarrSeries> {
    const rootFolderPath =
      this.rootFolderFor(lookup, options);

    if (!rootFolderPath) {
      throw new Error(
        'Sonarr root folder is not configured.'
      );
    }

    if (!options.qualityProfileId) {
      throw new Error(
        'Sonarr quality profile is not configured.'
      );
    }

    const payload = {
      ...lookup,

      rootFolderPath,
      qualityProfileId:
        options.qualityProfileId,

      // We request individual episodes ourselves.
      monitored: false,
      seasonFolder: true,

      seriesType:
        lookup.seriesType ?? 'standard',

      addOptions: {
        monitor: 'none',
        searchForMissingEpisodes: false,
        searchForCutoffUnmetEpisodes: false
      }
    };

    return this.api.post<SonarrSeries>(
      '/api/v3/series',
      payload
    );
  }

  async resolveSeries(
    identifiers: SonarrSeriesIdentifiers,
    options: AddSonarrSeriesOptions
  ): Promise<{
    series: SonarrSeries;
    added: boolean;
  }> {
    /*
     * Prefer TVDB once we know it because Sonarr uses TVDB IDs
     * as its primary external series identifier.
     */
    if (identifiers.tvdbId) {
      const existing =
        await this.findExistingByTvdb(
          identifiers.tvdbId
        );

      if (existing) {
        return {
          series: existing,
          added: false
        };
      }
    }

    if (identifiers.imdbId) {
      const existing =
        await this.findExistingByImdb(
          identifiers.imdbId
        );

      if (existing) {
        return {
          series: existing,
          added: false
        };
      }
    }

    let lookup: SonarrSeries;

    if (identifiers.tvdbId) {
      lookup =
        await this.lookupByTvdb(
          identifiers.tvdbId
        );
    } else if (identifiers.imdbId) {
      lookup =
        await this.lookupByImdb(
          identifiers.imdbId
        );
    } else {
      throw new Error(
        'A TVDB ID or IMDb ID is required.'
      );
    }

    /*
     * The lookup gives us the TVDB ID even if the original
     * request only supplied IMDb.
     */
    const existingByTvdb =
      await this.findExistingByTvdb(
        lookup.tvdbId
      );

    if (existingByTvdb) {
      return {
        series: existingByTvdb,
        added: false
      };
    }

    const series =
      await this.addSeries(
        lookup,
        options
      );

    return {
      series,
      added: true
    };
  }

  async episodes(
    seriesId: number,
    seasonNumber: number
  ): Promise<SonarrEpisode[]> {
    if (
      !Number.isInteger(seriesId) ||
      seriesId <= 0
    ) {
      throw new Error(
        'A valid Sonarr series ID is required.'
      );
    }

    return this.api.get<SonarrEpisode[]>(
      `/api/v3/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}`
    );
  }

  async findEpisode(
    seriesId: number,
    seasonNumber: number,
    episodeNumber: number
  ): Promise<SonarrEpisode> {
    const episodes =
      await this.episodes(
        seriesId,
        seasonNumber
      );

    const episode = episodes.find(
      item =>
        item.seasonNumber === seasonNumber &&
        item.episodeNumber === episodeNumber
    );

    if (!episode) {
      throw new Error(
        `Sonarr could not find S${seasonNumber}E${episodeNumber}.`
      );
    }

    return episode;
  }

  async monitorEpisode(
    episodeId: number
  ): Promise<void> {
    if (
      !Number.isInteger(episodeId) ||
      episodeId <= 0
    ) {
      throw new Error(
        'A valid Sonarr episode ID is required.'
      );
    }

    await this.api.put(
      '/api/v3/episode/monitor',
      {
        episodeIds: [episodeId],
        monitored: true
      }
    );
  }

  async searchEpisode(
    episodeId: number
  ): Promise<void> {
    if (
      !Number.isInteger(episodeId) ||
      episodeId <= 0
    ) {
      throw new Error(
        'A valid Sonarr episode ID is required.'
      );
    }

    await this.api.post(
      '/api/v3/command',
      {
        name: 'EpisodeSearch',
        episodeIds: [episodeId]
      }
    );
  }

  async ensureEpisode(
    identifiers: SonarrSeriesIdentifiers,
    seasonNumber: number,
    episodeNumber: number,
    options: AddSonarrSeriesOptions
  ): Promise<{
    series: SonarrSeries;
    episode: SonarrEpisode;
    seriesAdded: boolean;
    searchTriggered: boolean;
  }> {
    const resolved =
      await this.resolveSeries(
        identifiers,
        options
      );

    if (!resolved.series.id) {
      throw new Error(
        'Sonarr did not return a series ID.'
      );
    }

    const episode =
      await this.findEpisode(
        resolved.series.id,
        seasonNumber,
        episodeNumber
      );

    if (episode.hasFile) {
      return {
        series: resolved.series,
        episode,
        seriesAdded: resolved.added,
        searchTriggered: false
      };
    }

    await this.monitorEpisode(
      episode.id
    );

    await this.searchEpisode(
      episode.id
    );

    return {
      series: resolved.series,
      episode,
      seriesAdded: resolved.added,
      searchTriggered: true
    };
  }
}
