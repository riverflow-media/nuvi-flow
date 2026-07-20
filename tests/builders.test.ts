import { describe, expect, it } from 'vitest';
import { catalogPreview, fullMeta, streamTitle } from '../src/stremio/builders.js';
import type { MediaFileRow, MediaItemRow } from '../src/types.js';

const item: MediaItemRow = {
  id: 'tmdb:movie:1', type: 'movie', stremio_id: 'tt0000001', tmdb_id: 1, imdb_id: 'tt0000001',
  title: 'Example Movie', display_title: null, year: 2024, description: 'Example description',
  poster: 'https://image.test/poster.jpg', background: 'https://image.test/background.jpg', logo: null,
  genres_json: '["Drama"]', cast_json: '["Actor"]', directors_json: '["Director"]', runtime_minutes: 123,
  release_date: '2024-01-02', metadata_json: '{}', created_at: 1, updated_at: 1
};

describe('Stremio output builders', () => {
  it('builds catalog output', () => {
    expect(catalogPreview(item)).toMatchObject({ id: 'tt0000001', type: 'movie', name: 'Example Movie', releaseInfo: '2024', genres: ['Drama'] });
  });

  it('builds movie meta output', () => {
    expect(fullMeta(item)).toMatchObject({ id: 'tt0000001', imdb_id: 'tt0000001', moviedb_id: 1, runtime: '123 min', cast: ['Actor'] });
  });

  it('builds series videos with Stremio episode IDs', () => {
    const series = { ...item, id: 'tmdb:series:2', type: 'series' as const, stremio_id: 'tt0000002' };
    const meta = fullMeta(series, [{ season: 1, episode: 2, title: 'Second', overview: null, still: null, air_date: '2024-02-01', runtime_minutes: 45 }]);
    expect(meta.videos).toEqual([expect.objectContaining({ id: 'tt0000002:1:2', season: 1, episode: 2, title: 'Second' })]);
  });

  it('describes direct-play stream quality', () => {
    expect(streamTitle({ quality: '1080P', height: 1080, video_codec: 'hevc', audio_channels: 6 } as MediaFileRow)).toBe('Local File — 1080P HEVC — 5.1 Audio');
  });
});
