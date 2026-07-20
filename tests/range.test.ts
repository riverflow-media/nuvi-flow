import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/lib/range.js';

describe('HTTP byte ranges', () => {
  it('returns no range when the header is absent', () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: 'none' });
  });

  it('parses a bounded range', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ kind: 'valid', range: { start: 10, end: 19, length: 10 } });
  });

  it('parses an open-ended range', () => {
    expect(parseByteRange('bytes=90-', 100)).toEqual({ kind: 'valid', range: { start: 90, end: 99, length: 10 } });
  });

  it('parses a suffix range', () => {
    expect(parseByteRange('bytes=-25', 100)).toEqual({ kind: 'valid', range: { start: 75, end: 99, length: 25 } });
  });

  it.each(['bytes=100-101', 'bytes=20-10', 'items=1-2', 'bytes=0-1,4-5', 'bytes=-0'])('rejects %s', (header) => {
    expect(parseByteRange(header, 100)).toEqual({ kind: 'invalid' });
  });

  it('uses safe arithmetic for files larger than 4 GB', () => {
    const size = 6 * 1024 * 1024 * 1024;
    expect(parseByteRange('bytes=4294967296-', size)).toEqual({
      kind: 'valid', range: { start: 4294967296, end: size - 1, length: size - 4294967296 }
    });
  });
});
