import { describe, expect, it } from 'vitest';
import {
  createSiloMediaToken,
  createStreamToken,
  verifySiloMediaToken,
  verifyStreamToken
} from '../src/lib/security.js';

describe('HMAC stream tokens', () => {
  const secret = 'a-secret-long-enough-for-unit-testing-only';

  it('validates an authentic unexpired token', () => {
    const { token, payload } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(token, secret, 9_000)).toEqual(payload);
  });

  it('preserves optional signed episode context', () => {
    const { token, payload } = createStreamToken(
      'file_1',
      10_000,
      secret,
      'token-episode',
      {
        season: 1,
        episode: 2
      }
    );

    expect(payload).toMatchObject({
      v: 1,
      fileId: 'file_1',
      season: 1,
      episode: 2
    });

    expect(
      verifyStreamToken(token, secret, 9_000)
    ).toEqual(payload);
  });

  it('rejects tampering and the wrong secret', () => {
    const { token } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(`${token}x`, secret, 9_000)).toBeNull();
    expect(verifyStreamToken(token, 'wrong-secret', 9_000)).toBeNull();
  });

  it('signs an exact Silo media path without embedding credentials', () => {
    const path =
      '/api/v1/playback/transcode/session-123/segment/seg_00000.ts';

    const { token, payload } =
      createSiloMediaToken(
        path,
        10_000,
        secret
      );

    expect(payload).toEqual({
      v: 1,
      path,
      exp: 10_000
    });

    expect(
      verifySiloMediaToken(
        token,
        secret,
        9_000
      )
    ).toEqual(payload);

    expect(token).not.toContain(
      'Authorization'
    );

    expect(token).not.toContain(
      'Bearer'
    );
  });

  it('rejects expired tokens', () => {
    const { token } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(token, secret, 10_000)).toBeNull();
  });
});
