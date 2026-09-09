// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCss, adminHtml, adminJs } from '../src/admin/assets.js';

const longPath = 'Solar Opposites/Solar Opposites (2020) {tvdb-375892}/Season 06/Solar Opposites (2020) - S06E10 - What is the Mission Anyway [WEBDL-1080p][EAC3 5.1][h265]-NTb.mkv';

function mediaFile(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file1', libraryType: 'series', relativePath: longPath, size: 123456, durationSeconds: 1468,
    bitrate: 8_500_000, videoCodec: 'hevc', audioCodec: 'eac3', width: 1920, height: 1080,
    audioChannels: 6, audioLanguages: ['eng'], subtitleTracks: [{ language: 'eng', codec: 'subrip' }],
    parsedTitle: 'Solar Opposites', parsedYear: 2020, quality: '1080p', confidence: null,
    status: 'unmatched', stremioId: null, mediaItemId: null, currentMatch: null, subtitles: [],
    probe: { streams: [{ codec_type: 'video', color_transfer: 'smpte2084', very_long_value: 'x'.repeat(1000) }] },
    ...overrides
  };
}

function appState(files = [mediaFile()]) {
  const matched = files.filter((file) => file.status === 'matched');
  return {
    files,
    recent: files,
    counts: {
      movies: matched.filter((file) => file.libraryType === 'movie').length,
      series: matched.filter((file) => file.libraryType === 'series').length,
      episodes: matched.filter((file) => file.libraryType === 'series').length,
      unmatched: files.filter((file) => file.status === 'unmatched').length,
      errors: files.filter((file) => file.status === 'error').length
    },
    logs: [],
    settings: {
      baseUrl: 'http://localhost:60500', moviesPath: '/media/movies', tvPath: '/media/tv',
      scanIntervalMinutes: 30, minimumFileSizeMb: 50, streamTokenExpiryHours: 168,
      longLivedStreamTokens: false, adminUsername: 'admin', tmdbConfigured: true
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

function install(fetchMock: ReturnType<typeof vi.fn>): void {
  document.open();
  document.write(adminHtml('test-csrf').replace(/<script>[\s\S]*<\/script>/, ''));
  document.close();

  const routedFetch = vi.fn(async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    if (String(input) === '/admin/api/requests') {
      return json({ requests: [] });
    }

    return fetchMock(input, init);
  });

  vi.stubGlobal('fetch', routedFetch);
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: routedFetch
  });
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
  Object.defineProperty(window, 'open', { configurable: true, value: vi.fn() });
  window.eval(adminJs);
}

describe('media details modal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.documentElement.innerHTML = '<head></head><body></body>';
  });

  it('uses viewport-safe responsive CSS with one modal content scroller', () => {
    expect(adminCss).toContain('width:min(900px,calc(100vw - 32px))');
    expect(adminCss).toContain('grid-template-rows:auto minmax(0,1fr) auto');
    expect(adminCss).toContain('.modal-body{padding:20px;min-width:0;max-width:100%;overflow-y:auto;overflow-x:hidden');
    expect(adminCss).toContain('.info-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(adminCss).toContain('@media(max-width:600px)');
    expect(adminCss).toContain('.info-grid{grid-template-columns:1fr}');
    expect(adminCss).toContain('overflow-wrap:anywhere');
  });

  it('opens with the complete long path, locks body scroll, and closes by Escape or backdrop', async () => {
    const file = mediaFile();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/admin/api/state') return json(appState([file]));
      if (url === '/admin/api/files/file1') return json({ file });
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();

    const opener = document.querySelector<HTMLButtonElement>('[data-file="file1"]')!;
    opener.focus();
    opener.click();
    await flush();

    const modal = document.querySelector<HTMLDialogElement>('#fileModal')!;
    expect(modal.open).toBe(true);
    expect(document.body.classList.contains('modal-open')).toBe(true);
    expect(document.querySelector('#filePathValue')?.textContent).toBe(longPath);
    expect(document.querySelector('details.technical-details')?.hasAttribute('open')).toBe(false);
    expect(document.querySelector('#modalActions')?.textContent).toContain('Ignore');
    expect(document.querySelector('#modalActions')?.textContent).not.toContain('Remove match');

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(opener.isConnected).toBe(false);
    modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal.open).toBe(false);
    expect(document.body.classList.contains('modal-open')).toBe(false);
    expect((document.activeElement as HTMLElement).dataset.file).toBe('file1');

    document.querySelector<HTMLButtonElement>('#recentList [data-file="file1"]')!.click();
    await flush();
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(modal.open).toBe(false);
    expect(document.body.classList.contains('modal-open')).toBe(false);
  });

  it('discards stale detail responses and resets modal-local results between files', async () => {
    const first = mediaFile();
    const second = mediaFile({ id: 'file2', parsedTitle: 'Second File', relativePath: 'TV/Second File S01E01.mkv' });
    let resolveFirst!: (value: Response) => void;
    const delayedFirst = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/admin/api/state') return json(appState([first, second]));
      if (url === '/admin/api/files/file1') return delayedFirst;
      if (url === '/admin/api/files/file2') return json({ file: second });
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();

    document.querySelector<HTMLButtonElement>('[data-file="file1"]')!.click();
    document.querySelector<HTMLButtonElement>('[data-file="file2"]')!.click();
    await flush();
    expect(document.querySelector('#modalTitle')?.textContent).toBe('Second File');
    expect(document.querySelector('#filePathValue')?.textContent).toBe('TV/Second File S01E01.mkv');
    expect(document.querySelector('#tmdbResults')?.textContent).toBe('');

    resolveFirst(json({ file: first }));
    await flush();
    expect(document.querySelector('#modalTitle')?.textContent).toBe('Second File');
    expect(document.querySelector('#modalBody')?.textContent).not.toContain(longPath);
  });

  it('shows a useful TMDB search error and restores the controls', async () => {
    const file = mediaFile();
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/admin/api/state') return json(appState([file]));
      if (url === '/admin/api/files/file1') return json({ file });
      if (url.startsWith('/admin/api/tmdb/search')) return json({ error: 'The TMDB API key was rejected. Check the key in Settings and try again.' }, 400);
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();
    document.querySelector<HTMLButtonElement>('[data-file="file1"]')!.click();
    await flush();
    document.querySelector<HTMLButtonElement>('#tmdbSearch')!.click();
    await flush();

    expect(document.querySelector('#tmdbResults')?.textContent).toContain('TMDB API key was rejected');
    expect(document.querySelector<HTMLButtonElement>('#tmdbSearch')?.disabled).toBe(false);
    expect(document.querySelector('#tmdbSearchStatus')?.textContent).toBe('Search failed.');
  });

  it('searches with Enter and keeps controls disabled until the response settles', async () => {
    const file = mediaFile();
    let resolveSearch!: (value: Response) => void;
    const delayedSearch = new Promise<Response>((resolve) => { resolveSearch = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/admin/api/state') return json(appState([file]));
      if (url === '/admin/api/files/file1') return json({ file });
      if (url.startsWith('/admin/api/tmdb/search')) return delayedSearch;
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();
    document.querySelector<HTMLButtonElement>('[data-file="file1"]')!.click();
    await flush();

    const input = document.querySelector<HTMLInputElement>('#tmdbQuery')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(document.querySelector<HTMLButtonElement>('#tmdbSearch')?.disabled).toBe(true);
    expect(document.querySelector('#tmdbSearch')?.textContent).toBe('Searching…');
    expect(document.querySelector('#tmdbSearchStatus')?.textContent).toBe('Searching TMDB…');

    resolveSearch(json({ results: [] }));
    await flush();
    expect(document.querySelector<HTMLButtonElement>('#tmdbSearch')?.disabled).toBe(false);
    expect(document.querySelector('#tmdbSearch')?.textContent).toBe('Search TMDB');
    expect(document.querySelector('#tmdbSearchStatus')?.textContent).toBe('No matches found.');
  });

  it('does not overwrite unsaved settings during background polling', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) === '/admin/api/state') return json(appState());
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();
    const baseUrl = document.querySelector<HTMLInputElement>('#baseUrl')!;
    baseUrl.value = 'http://unsaved.example.test';
    baseUrl.dispatchEvent(new Event('input', { bubbles: true }));

    vi.advanceTimersByTime(15_000);
    await flush();
    expect(baseUrl.value).toBe('http://unsaved.example.test');
  });

  it('ignores an older polling response that arrives after newer library state', async () => {
    const staleFile = mediaFile();
    const freshFile = mediaFile({
      status: 'matched', confidence: 1, mediaItemId: 'item1', stremioId: 'tt8910922',
      currentMatch: { title: 'Solar Opposites', year: 2020, tmdbId: 97645, stremioId: 'tt8910922', description: null, poster: null }
    });
    let stateCall = 0;
    let resolveStale!: (value: Response) => void;
    const delayedStale = new Promise<Response>((resolve) => { resolveStale = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== '/admin/api/state') return json({ error: 'Unexpected request' }, 500);
      stateCall += 1;
      if (stateCall === 1) return json(appState([staleFile]));
      if (stateCall === 2) return delayedStale;
      return json(appState([freshFile]));
    });
    install(fetchMock);
    await flush();

    vi.advanceTimersByTime(15_000);
    await flush();
    vi.advanceTimersByTime(15_000);
    await flush();
    expect(document.querySelector('#stats .stat.alert strong')?.textContent).toBe('0');
    expect(document.querySelector('#libraryRows')?.textContent).toContain('100% match');

    resolveStale(json(appState([staleFile])));
    await flush();
    expect(document.querySelector('#stats .stat.alert strong')?.textContent).toBe('0');
    expect(document.querySelector('#libraryRows')?.textContent).toContain('100% match');
  });

  it('keeps a successful match visible when only the background summary refresh fails', async () => {
    let file = mediaFile();
    let failNextState = false;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/admin/api/state') {
        if (failNextState) { failNextState = false; return json({ error: 'Summary unavailable' }, 503); }
        return json(appState([file]));
      }
      if (url === '/admin/api/files/file1') return json({ file });
      if (url.startsWith('/admin/api/tmdb/search')) return json({ results: [{ id: 123, title: 'Solar Opposites', year: 2020, confidence: .98 }] });
      if (url === '/admin/api/files/file1/match' && init?.method === 'POST') {
        file = mediaFile({
          status: 'matched', confidence: 1, mediaItemId: 'item1', stremioId: 'tt8910922',
          currentMatch: { title: 'Solar Opposites', year: 2020, tmdbId: 97645, stremioId: 'tt8910922', description: null, poster: null }
        });
        failNextState = true;
        return json({ ok: true, file });
      }
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();
    document.querySelector<HTMLButtonElement>('[data-file="file1"]')!.click();
    await flush();
    document.querySelector<HTMLButtonElement>('#tmdbSearch')!.click();
    await flush();
    document.querySelector<HTMLButtonElement>('[data-apply-match="123"]')!.click();
    await flush();

    expect(document.querySelector('.match-card')?.textContent).toContain('Current match');
    expect(document.querySelector('#modalError')?.textContent).toBe('');
    expect(document.querySelector('#toast')?.textContent).toBe('Metadata match applied');
  });

  it('applies and removes a TMDB match, then ignores the file without a page refresh', async () => {
    let file = mediaFile();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/admin/api/state') return json(appState([file]));
      if (url === '/admin/api/files/file1') return json({ file });
      if (url.startsWith('/admin/api/tmdb/search')) return json({ results: [{ id: 123, title: 'Solar Opposites', year: 2020, overview: 'A family of aliens tries to fit in.', confidence: .98 }] });
      if (url === '/admin/api/files/file1/match' && init?.method === 'POST') {
        file = mediaFile({
          status: 'matched', confidence: 1, mediaItemId: 'item1', stremioId: 'tt8910922',
          currentMatch: { title: 'Solar Opposites', year: 2020, tmdbId: 97645, stremioId: 'tt8910922', description: 'A family of aliens tries to fit in.', poster: null }
        });
        return json({ ok: true, file });
      }
      if (url === '/admin/api/files/file1/unmatch' && init?.method === 'POST') {
        file = mediaFile();
        return json({ ok: true, file });
      }
      if (url === '/admin/api/files/file1/ignore' && init?.method === 'POST') {
        file = mediaFile({ status: 'ignored' });
        return json({ ok: true, file });
      }
      return json({ error: 'Unexpected request' }, 500);
    });
    install(fetchMock);
    await flush();
    document.querySelector<HTMLButtonElement>('[data-file="file1"]')!.click();
    await flush();

    document.querySelector<HTMLButtonElement>('#tmdbSearch')!.click();
    await flush();
    expect(document.querySelector('.search-result')?.textContent).toContain('Apply Match');
    document.querySelector<HTMLButtonElement>('[data-apply-match="123"]')!.click();
    await flush();
    expect(document.querySelector('.match-card')?.textContent).toContain('Current match');
    expect(document.querySelector('#modalActions')?.textContent).toContain('Remove match');
    expect(document.querySelector('#modalActions')?.textContent).not.toContain('Ignore');

    document.querySelector<HTMLButtonElement>('[data-action="unmatch"]')!.click();
    await flush();
    expect(window.confirm).toHaveBeenCalled();
    expect(document.querySelector('#modalActions')?.textContent).not.toContain('Remove match');
    expect(document.querySelector('#modalActions')?.textContent).toContain('Ignore');

    document.querySelector<HTMLButtonElement>('[data-action="ignore"]')!.click();
    await flush();
    expect(document.querySelector('#modalBody')?.textContent).toContain('This file is ignored');
    expect(document.querySelector('#modalActions')?.textContent).toBe('');
    expect(fetchMock).toHaveBeenCalledWith('/admin/api/files/file1/ignore', expect.objectContaining({ method: 'POST' }));
  });
});
