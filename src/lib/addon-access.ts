import { randomBytes, timingSafeEqual } from 'node:crypto';

const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function createAddonAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

export function isValidAddonAccessToken(token: string): boolean {
  return ACCESS_TOKEN_PATTERN.test(token);
}

export function matchesAddonAccessToken(
  supplied: string | undefined,
  expected: string
): boolean {
  if (!supplied || !isValidAddonAccessToken(supplied)) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function redactAddonAccessPath(url: string): string {
  return url.replace(
    /\/addon\/[^/?#]+/g,
    '/addon/[redacted]'
  );
}
