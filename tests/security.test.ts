import { describe, expect, it } from 'vitest';
import {
  createSiloMediaToken,
  createStreamToken,
  verifySiloMediaToken,
  verifyStreamToken
} from '../src/lib/security.js';
import {
  createAddonAccessToken,
  matchesAddonAccessToken,
  redactAddonAccessPath
} from '../src/lib/addon-access.js';
import { buildInfo } from '../src/lib/build-info.js';

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

  it('preserves a validated signed device identity', () => {
    const deviceId = 'device_1234567890abcdef12345678';
    const { token, payload } = createStreamToken(
      'file_1',
      10_000,
      secret,
      'token-device',
      { deviceId }
    );

    expect(payload.deviceId).toBe(deviceId);
    expect(verifyStreamToken(token, secret, 9_000))
      .toEqual(payload);
  });

  it('refuses to sign malformed device identity context', () => {
    expect(() => createStreamToken(
      'file_1',
      10_000,
      secret,
      'token-device',
      { deviceId: 'raw-device-name' }
    )).toThrow('Invalid stream device identity');
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

describe('addon access tokens', () => {
  it('creates 256-bit URL-safe tokens and compares them safely', () => {
    const token = createAddonAccessToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(matchesAddonAccessToken(token, token)).toBe(true);
    expect(matchesAddonAccessToken(`${token}x`, token)).toBe(false);
    expect(matchesAddonAccessToken(undefined, token)).toBe(false);
  });

  it('redacts addon credentials from request URLs', () => {
    const token = createAddonAccessToken();
    expect(redactAddonAccessPath(
      `/addon/${token}/stream/movie/tt123.json?x=1`
    )).toBe('/addon/[redacted]/stream/movie/tt123.json?x=1');
  });
});

describe('build identity', () => {
  it('uses the exact container build metadata and a short revision', () => {
    expect(buildInfo({
      NUVI_FLOW_VERSION: '1.1.1',
      NUVI_FLOW_REVISION: '1234567890abcdef'
    })).toEqual({
      version: '1.1.1',
      revision: '1234567890ab'
    });
  });
});
