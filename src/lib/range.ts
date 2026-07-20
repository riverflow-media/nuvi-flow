export interface ByteRange {
  start: number;
  end: number;
  length: number;
}

export type RangeResult =
  | { kind: 'none' }
  | { kind: 'valid'; range: ByteRange }
  | { kind: 'invalid' };

export function parseByteRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'none' };
  if (!Number.isSafeInteger(size) || size < 0 || !header.startsWith('bytes=')) return { kind: 'invalid' };
  const value = header.slice(6).trim();
  if (!value || value.includes(',')) return { kind: 'invalid' };
  const match = /^(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: 'invalid' };

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'invalid' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
      return { kind: 'invalid' };
    }
    end = Math.min(end, size - 1);
  }
  return { kind: 'valid', range: { start, end, length: end - start + 1 } };
}
