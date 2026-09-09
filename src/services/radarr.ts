import { ArrClient } from './arr-client.js';

export interface RadarrStatus {
  version: string;
  instanceName?: string;
}

export interface RadarrRootFolder {
  id: number;
  path: string;
  accessible?: boolean;
  freeSpace?: number;
}

export interface RadarrQualityProfile {
  id: number;
  name: string;
}

export interface RadarrMovie {
  id?: number;
  title: string;
  year?: number;
  imdbId?: string;
  tmdbId: number;
  titleSlug?: string;
  monitored?: boolean;
  hasFile?: boolean;
  path?: string;
  rootFolderPath?: string;
  qualityProfileId?: number;

  [key: string]: unknown;
}

export interface AddRadarrMovieOptions {
  rootFolderPath: string;
  qualityProfileId: number;
  searchForMovie?: boolean;
}

export class RadarrClient {
  private readonly api: ArrClient;

  constructor(
    baseUrl: string,
    apiKey: string
  ) {
    this.api = new ArrClient(baseUrl, apiKey);
  }

  async status(): Promise<RadarrStatus> {
    return this.api.get<RadarrStatus>(
      '/api/v3/system/status'
    );
  }

  async rootFolders(): Promise<RadarrRootFolder[]> {
    return this.api.get<RadarrRootFolder[]>(
      '/api/v3/rootfolder'
    );
  }

  async qualityProfiles(): Promise<RadarrQualityProfile[]> {
    return this.api.get<RadarrQualityProfile[]>(
      '/api/v3/qualityprofile'
    );
  }

  async lookupByImdb(
    imdbId: string
  ): Promise<RadarrMovie> {
    const cleanImdbId = imdbId.trim();

    if (!/^tt\d+$/i.test(cleanImdbId)) {
      throw new Error(
        `Invalid IMDb ID: ${imdbId}`
      );
    }

    return this.api.get<RadarrMovie>(
      `/api/v3/movie/lookup/imdb?imdbId=${encodeURIComponent(cleanImdbId)}`
    );
  }

  async movies(): Promise<RadarrMovie[]> {
    return this.api.get<RadarrMovie[]>(
      '/api/v3/movie'
    );
  }

  async findExistingByImdb(
    imdbId: string
  ): Promise<RadarrMovie | undefined> {
    const wanted = imdbId.trim().toLowerCase();
    const movies = await this.movies();

    return movies.find(
      movie =>
        movie.imdbId?.trim().toLowerCase() === wanted
    );
  }

  async addMovie(
    lookup: RadarrMovie,
    options: AddRadarrMovieOptions
  ): Promise<RadarrMovie> {
    if (!options.rootFolderPath) {
      throw new Error(
        'Radarr root folder is not configured.'
      );
    }

    if (!options.qualityProfileId) {
      throw new Error(
        'Radarr quality profile is not configured.'
      );
    }

    const payload = {
      ...lookup,

      rootFolderPath: options.rootFolderPath,
      qualityProfileId: options.qualityProfileId,
      monitored: true,

      addOptions: {
        searchForMovie: options.searchForMovie ?? true
      }
    };

    return this.api.post<RadarrMovie>(
      '/api/v3/movie',
      payload
    );
  }

  async searchMovie(
    movieId: number
  ): Promise<void> {
    if (!Number.isInteger(movieId) || movieId <= 0) {
      throw new Error(
        'A valid Radarr movie ID is required.'
      );
    }

    await this.api.post(
      '/api/v3/command',
      {
        name: 'MoviesSearch',
        movieIds: [movieId]
      }
    );
  }

  async ensureMovie(
    imdbId: string,
    options: AddRadarrMovieOptions
  ): Promise<{
    movie: RadarrMovie;
    added: boolean;
    searchTriggered: boolean;
  }> {
    const existing =
      await this.findExistingByImdb(imdbId);

    if (existing) {
      if (!existing.hasFile && existing.id) {
        await this.searchMovie(existing.id);

        return {
          movie: existing,
          added: false,
          searchTriggered: true
        };
      }

      return {
        movie: existing,
        added: false,
        searchTriggered: false
      };
    }

    const lookup =
      await this.lookupByImdb(imdbId);

    const movie =
      await this.addMovie(
        lookup,
        options
      );

    return {
      movie,
      added: true,
      searchTriggered:
        options.searchForMovie ?? true
    };
  }
}
