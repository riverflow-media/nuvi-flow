import { describe, expect, it } from 'vitest';
import { createStreamToken, verifyStreamToken } from '../src/lib/security.js';

describe('HMAC stream tokens', () => {
  const secret = 'a-secret-long-enough-for-unit-testing-only';

  it('validates an authentic unexpired token', () => {
    const { token, payload } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(token, secret, 9_000)).toEqual(payload);
  });

  it('rejects tampering and the wrong secret', () => {
    const { token } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(`${token}x`, secret, 9_000)).toBeNull();
    expect(verifyStreamToken(token, 'wrong-secret', 9_000)).toBeNull();
  });

  it('rejects expired tokens', () => {
    const { token } = createStreamToken('file_1', 10_000, secret, 'token-1');
    expect(verifyStreamToken(token, secret, 10_000)).toBeNull();
  });
});
