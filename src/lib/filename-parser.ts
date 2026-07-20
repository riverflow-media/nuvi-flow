import path from 'node:path';

export interface ParsedMovie {
  title: string;
  year?: number;
  edition?: string;
  resolution?: string;
  codec?: string;
  source?: string;
}

export interface ParsedEpisode {
  title: string;
  year?: number;
  season: number;
  episodeStart: number;
  episodeEnd: number;
  episodeTitle?: string;
  resolution?: string;
  codec?: string;
  source?: string;
}

const TECHNICAL_TOKENS = [
  /\b(?:480|576|720|1080|1440|2160|4320)p\b/i,
  /\b(?:4k|uhd|hdr10\+?|hdr|dv|dolby[ .]?vision)\b/i,
  /\b(?:x26[45]|h[ .]?26[45]|hevc|avc|av1|xvid|divx)\b/i,
  /\b(?:blu-?ray|b[dr]rip|web[ .-]?(?:dl|rip)|hdtv|dvd(?:rip)?|remux|webrip)\b/i,
  /\b(?:aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|mp3)\b/i,
  /\b(?:proper|repack|extended|unrated|limited|internal|multi|dubbed)\b/i,
  /\b(?:10bit|8bit|yify|rarbg)\b/i
];

const EDITION_PATTERN = /\b(director'?s cut|extended(?: edition| cut)?|theatrical(?: cut)?|unrated|remastered|special edition|imax|final cut)\b/i;
const RESOLUTION_PATTERN = /\b(480p|576p|720p|1080p|1440p|2160p|4320p|4k|uhd)\b/i;
const CODEC_PATTERN = /\b(x264|x265|h[ .]?264|h[ .]?265|hevc|avc|av1|xvid|divx)\b/i;
const SOURCE_PATTERN = /\b(blu-?ray|bdrip|brrip|web[ .-]?dl|webrip|hdtv|dvd(?:rip)?|remux|uhd)\b/i;

function withoutExtension(input: string): string {
  return path.basename(input, path.extname(input));
}

function cleanSeparators(input: string): string {
  return input
    .replace(/[._]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/[\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleCasePreservingWords(input: string): string {
  return input.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function technicalValue(input: string, pattern: RegExp): string | undefined {
  return cleanSeparators(input).match(pattern)?.[1]?.replace(/[ .-]/g, '').toUpperCase();
}

function removeTechnicalTail(input: string): string {
  let earliest = input.length;
  for (const pattern of TECHNICAL_TOKENS) {
    const match = pattern.exec(input);
    if (match?.index !== undefined) earliest = Math.min(earliest, match.index);
  }
  return input.slice(0, earliest).trim();
}

function inferSeriesTitleFromPath(filePath: string): string {
  const segments = filePath.split(path.sep).filter(Boolean).slice(0, -1).reverse();
  for (const segment of segments) {
    let candidate = removeTechnicalTail(cleanSeparators(segment));
    candidate = candidate
      .replace(/\s+(?:season|series)\s*\d+(?:\s+\d+)?(?:\s.*)?$/i, '')
      .replace(/^\s*(?:season|series)\s*\d+\s*$/i, '')
      .trim();
    if (candidate) return candidate;
  }
  return '';
}

function stableSpecialEpisode(input: string): number {
  let hash = 0;
  for (const character of normalizedTitle(input)) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return (hash % 999) + 1;
}

export function parseMovieFilename(filePath: string): ParsedMovie {
  const raw = cleanSeparators(withoutExtension(filePath));
  const yearMatches = [...raw.matchAll(/\b(19\d{2}|20\d{2}|2100)\b/g)];
  const yearMatch = yearMatches[0];
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const edition = raw.match(EDITION_PATTERN)?.[1];
  let titlePart = yearMatch?.index !== undefined ? raw.slice(0, yearMatch.index) : removeTechnicalTail(raw);
  titlePart = titlePart.replace(/\(\s*$/, '').replace(/\([^)]*\)\s*$/, '').trim();
  if (!titlePart) titlePart = raw;
  return {
    title: titleCasePreservingWords(titlePart),
    year,
    edition: edition ? titleCasePreservingWords(edition) : undefined,
    resolution: technicalValue(raw, RESOLUTION_PATTERN),
    codec: technicalValue(raw, CODEC_PATTERN),
    source: technicalValue(raw, SOURCE_PATTERN)
  };
}

export function parseEpisodeFilename(filePath: string): ParsedEpisode | null {
  const raw = cleanSeparators(withoutExtension(filePath));
  const patterns = [
    /\bS(\d{1,2})E(\d{1,3})(?:\s*(?:E|-E?|to)\s*(\d{1,3}))?\b/i,
    /\b(\d{1,2})x(\d{1,3})(?:\s*(?:-|x)\s*(\d{1,3}))?\b/i
  ];
  let match: RegExpExecArray | null = null;
  for (const pattern of patterns) {
    match = pattern.exec(raw);
    if (match) break;
  }

  const episodeOnly = !match ? /\bE(\d{1,3})\b/i.exec(raw) : null;
  if (!match && episodeOnly?.index !== undefined) {
    const seasonFromPath = filePath.match(/(?:season|series)[ ._-]*(\d{1,2})/i)?.[1];
    const episodeStart = Number(episodeOnly[1]);
    const title = raw.slice(0, episodeOnly.index).trim() || inferSeriesTitleFromPath(filePath) || 'Unknown Series';
    let episodeTitle = raw.slice(episodeOnly.index + episodeOnly[0].length).trim();
    episodeTitle = removeTechnicalTail(episodeTitle);
    const yearMatch = title.match(/\(?\b(19\d{2}|20\d{2}|2100)\b\)?/);
    return {
      title: titleCasePreservingWords(yearMatch ? title.replace(yearMatch[0], '').trim() : title),
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      season: seasonFromPath ? Number(seasonFromPath) : 1,
      episodeStart,
      episodeEnd: episodeStart,
      episodeTitle: episodeTitle ? titleCasePreservingWords(episodeTitle) : undefined,
      resolution: technicalValue(raw, RESOLUTION_PATTERN),
      codec: technicalValue(raw, CODEC_PATTERN),
      source: technicalValue(raw, SOURCE_PATTERN)
    };
  }

  if (!match || match.index === undefined) {
    if (!/^special\b/i.test(raw)) return null;
    const title = inferSeriesTitleFromPath(filePath);
    if (!title) return null;
    const episodeTitle = raw.replace(/^special\s*/i, '').trim();
    const episode = stableSpecialEpisode(`${title} ${episodeTitle}`);
    return {
      title: titleCasePreservingWords(title),
      season: 0,
      episodeStart: episode,
      episodeEnd: episode,
      episodeTitle: episodeTitle ? titleCasePreservingWords(episodeTitle) : 'Special',
      resolution: technicalValue(raw, RESOLUTION_PATTERN),
      codec: technicalValue(raw, CODEC_PATTERN),
      source: technicalValue(raw, SOURCE_PATTERN)
    };
  }

  let title = raw.slice(0, match.index).trim();
  if (!title || /^(?:season|series)\s+\d+$/i.test(title)) {
    const segments = filePath.split(path.sep).filter(Boolean);
    const seasonIndex = segments.findIndex((part) => /^(?:season|series)\s*\d+$/i.test(part));
    if (seasonIndex > 0) title = cleanSeparators(segments[seasonIndex - 1] ?? '');
    else if (segments.length > 1) title = cleanSeparators(segments.at(-2) ?? '');
  }
  const technicalIndex = TECHNICAL_TOKENS.reduce((lowest, pattern) => {
    const found = pattern.exec(raw.slice(match!.index + match![0].length));
    return found?.index === undefined ? lowest : Math.min(lowest, found.index);
  }, Number.POSITIVE_INFINITY);
  let episodeTitle = raw.slice(match.index + match[0].length).trim();
  if (Number.isFinite(technicalIndex)) episodeTitle = episodeTitle.slice(0, technicalIndex).trim();

  const episodeStart = Number(match[2]);
  const yearMatch = title.match(/\(?\b(19\d{2}|20\d{2}|2100)\b\)?/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  if (yearMatch) title = title.replace(yearMatch[0], '').replace(/\(\s*\)/g, '').trim();
  return {
    title: titleCasePreservingWords(title || 'Unknown Series'),
    year,
    season: Number(match[1]),
    episodeStart,
    episodeEnd: match[3] ? Number(match[3]) : episodeStart,
    episodeTitle: episodeTitle ? titleCasePreservingWords(episodeTitle) : undefined,
    resolution: technicalValue(raw, RESOLUTION_PATTERN),
    codec: technicalValue(raw, CODEC_PATTERN),
    source: technicalValue(raw, SOURCE_PATTERN)
  };
}

export function normalizedTitle(input: string): string {
  return input.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function bigrams(input: string): Set<string> {
  const padded = ` ${normalizedTitle(input)} `;
  return new Set(Array.from({ length: Math.max(0, padded.length - 1) }, (_, index) => padded.slice(index, index + 2)));
}

export function titleSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

export function matchConfidence(parsedTitle: string, parsedYear: number | undefined, candidateTitle: string, candidateYear?: number): number {
  const titleScore = titleSimilarity(parsedTitle, candidateTitle);
  let yearScore = 0.5;
  if (parsedYear && candidateYear) {
    const delta = Math.abs(parsedYear - candidateYear);
    yearScore = delta === 0 ? 1 : delta === 1 ? 0.65 : 0;
  }
  return Math.max(0, Math.min(1, titleScore * 0.82 + yearScore * 0.18));
}

export function isMediaFilename(name: string): boolean {
  return ['.mkv', '.mp4', '.m4v', '.avi', '.mov', '.webm'].includes(path.extname(name).toLowerCase());
}

export function shouldIgnorePath(filePath: string): boolean {
  const segments = filePath.split(path.sep);
  const basename = path.basename(filePath, path.extname(filePath));
  return segments.some((part) => part.startsWith('.'))
    || /(?:^|[ ._-])(sample|trailer|temp|partial)(?:$|[ ._-])/i.test(basename)
    || /\.(?:part|tmp|crdownload)$/i.test(filePath);
}
