import { describe, expect, it } from 'vitest';
import { matchConfidence, parseEpisodeFilename, parseMovieFilename, shouldIgnorePath } from '../src/lib/filename-parser.js';

describe('movie filename parsing', () => {
  it.each([
    ['Interstellar (2014).mkv', 'Interstellar', 2014],
    ['Interstellar.2014.1080p.BluRay.x265.mkv', 'Interstellar', 2014],
    ['The Batman (2022)/The Batman (2022).mkv', 'The Batman', 2022]
  ])('parses %s', (input, title, year) => {
    expect(parseMovieFilename(input)).toMatchObject({ title, year });
  });

  it('extracts technical attributes and editions', () => {
    expect(parseMovieFilename('Blade.Runner.1982.Final.Cut.2160p.UHD.HEVC.mkv')).toMatchObject({
      title: 'Blade Runner', year: 1982, edition: 'Final Cut', resolution: '2160P', codec: 'HEVC', source: 'UHD'
    });
  });
});

describe('episode filename parsing', () => {
  it.each([
    ['Show Name S01E01.mkv', 1, 1, 1],
    ['Show.Name.1x01.mkv', 1, 1, 1],
    ['Show Name/Season 01/Show Name - S01E01 - Pilot.mkv', 1, 1, 1],
    ['Show.Name.S01E01-E02.1080p.mkv', 1, 1, 2],
    ['Show Name S00E03.mkv', 0, 3, 3]
  ])('parses %s', (input, season, start, end) => {
    expect(parseEpisodeFilename(input)).toMatchObject({ season, episodeStart: start, episodeEnd: end });
  });

  it('extracts and removes a series year from the searchable title', () => {
    expect(parseEpisodeFilename('Smiling Friends (2020) - S02E03 - A Allan Adventure.mkv')).toMatchObject({
      title: 'Smiling Friends', year: 2020, season: 2, episodeStart: 3
    });
  });

  it('parses episode-only documentary numbering as season one', () => {
    expect(parseEpisodeFilename('Planet Earth/Planet Earth (2006) Special Edition/Planet Earth E11 Ocean Deep [2160p x265].mkv')).toMatchObject({
      title: 'Planet Earth', season: 1, episodeStart: 11, episodeTitle: 'Ocean Deep'
    });
  });

  it('keeps date-named specials in their parent series', () => {
    expect(parseEpisodeFilename('Shark Tank/Shark Tank - Season 1-9/Shark Tank - Season 5/Special - Swimming with Sharks (May 2, 2014).mp4')).toMatchObject({
      title: 'Shark Tank', season: 0, episodeTitle: 'Swimming With Sharks (May 2, 2014)'
    });
  });
});

describe('matching confidence and ignore rules', () => {
  it('strongly favors the same title and year', () => {
    expect(matchConfidence('The Batman', 2022, 'The Batman', 2022)).toBeGreaterThan(0.95);
    expect(matchConfidence('The Batman', 2022, 'Batman Returns', 1992)).toBeLessThan(0.7);
  });

  it('ignores sample, trailer, temporary, and hidden files', () => {
    expect(shouldIgnorePath('/movies/Film/sample.mkv')).toBe(true);
    expect(shouldIgnorePath('/movies/.hidden/Film.mkv')).toBe(true);
    expect(shouldIgnorePath('/movies/Film.trailer.mp4')).toBe(true);
    expect(shouldIgnorePath('/movies/Film.mkv')).toBe(false);
  });
});
