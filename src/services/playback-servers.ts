import type { SettingsService } from './settings.js';
import {
  JellyfinClient,
  type JellyfinServerInfo,
  type JellyfinUser
} from './jellyfin.js';
import {
  PlexClient,
  type PlexLibrary,
  type PlexServerInfo
} from './plex.js';

export interface JellyfinConnectionResult {
  server: JellyfinServerInfo;
  users: JellyfinUser[];
}

export interface PlexConnectionResult {
  server: PlexServerInfo;
  libraries: PlexLibrary[];
}

/**
 * Application-facing boundary for optional playback-server providers.
 *
 * Routes and diagnostics use this service rather than handling provider
 * credentials or protocol clients directly. Playback negotiation is added in
 * later roadmap phases behind this same boundary.
 */
export class PlaybackServersService {
  constructor(private readonly settings: SettingsService) {}

  async testJellyfin(
    baseUrl = this.settings.jellyfinUrl,
    apiKey = this.settings.jellyfinApiKey
  ): Promise<JellyfinConnectionResult> {
    const client = new JellyfinClient(baseUrl, apiKey);
    const [server, users] = await Promise.all([
      client.systemInfo(),
      client.users()
    ]);
    return { server, users };
  }

  async testPlex(
    baseUrl = this.settings.plexUrl,
    token = this.settings.plexToken
  ): Promise<PlexConnectionResult> {
    const client = new PlexClient(baseUrl, token);
    const [server, libraries] = await Promise.all([
      client.serverInfo(),
      client.libraries()
    ]);
    return { server, libraries };
  }
}
