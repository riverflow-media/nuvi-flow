import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const deviceIdPattern = /^device_[a-f0-9]{24}$/;
const siloMediaPrefixes = [
  '/api/v1/playback/',
  '/api/v1/stream/'
] as const;

function isSafeSiloMediaPath(value: string): boolean {
  if (!siloMediaPrefixes.some(prefix => value.startsWith(prefix))) return false;

  try {
    const parsed = new URL(value, 'http://silo.invalid');
    const normalized = parsed.pathname + parsed.search;

    return parsed.origin === 'http://silo.invalid' &&
      !parsed.hash &&
      normalized === value &&
      siloMediaPrefixes.some(prefix => parsed.pathname.startsWith(prefix)) &&
      !/%(?:2e|2f|5c)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function signature(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface StreamTokenPayload {
  v: 1;
  fileId: string;
  exp: number;
  jti: string;
  deviceId?: string;
  season?: number;
  episode?: number;
}

export interface StreamTokenContext {
  season?: number;
  episode?: number;
  deviceId?: string;
}

export function createStreamToken(
  fileId: string,
  expiresAt: number,
  secret: string,
  jti = randomBytes(12).toString('base64url'),
  context?: StreamTokenContext
): { token: string; payload: StreamTokenPayload } {
  const hasSeason = context?.season !== undefined;
  const hasEpisode = context?.episode !== undefined;

  if (hasSeason !== hasEpisode) {
    throw new Error('Incomplete stream episode context.');
  }

  if (
    context?.deviceId !== undefined &&
    !deviceIdPattern.test(context.deviceId)
  ) {
    throw new Error('Invalid stream device identity.');
  }

  const payload: StreamTokenPayload = {
    v: 1,
    fileId,
    exp: expiresAt,
    jti,
    ...(context?.deviceId
      ? { deviceId: context.deviceId }
      : {}),
    ...(context
      && context.season !== undefined
      && context.episode !== undefined
      ? {
          season: context.season,
          episode: context.episode
        }
      : {})
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${encoded}.${signature(encoded, secret)}`, payload };
}

export function verifyStreamToken(token: string, secret: string, now = Date.now()): StreamTokenPayload | null {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra || !safeEqual(signature(encoded, secret), suppliedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<StreamTokenPayload>;
    if (payload.v !== 1 || typeof payload.fileId !== 'string' || typeof payload.exp !== 'number' || typeof payload.jti !== 'string') return null;

    const hasSeason = payload.season !== undefined;
    const hasEpisode = payload.episode !== undefined;

    if (hasSeason !== hasEpisode) return null;

    if (
      payload.deviceId !== undefined &&
      !deviceIdPattern.test(payload.deviceId)
    ) {
      return null;
    }

    if (
      hasSeason &&
      (
        !Number.isInteger(payload.season) ||
        payload.season! < 0 ||
        !Number.isInteger(payload.episode) ||
        payload.episode! < 1
      )
    ) {
      return null;
    }

    if (payload.exp <= now) return null;
    return payload as StreamTokenPayload;
  } catch {
    return null;
  }
}

export interface SiloMediaTokenPayload {
  v: 1;
  path: string;
  exp: number;
}

export function createSiloMediaToken(
  path: string,
  expiresAt: number,
  secret: string
): {
  token: string;
  payload: SiloMediaTokenPayload;
} {
  if (!isSafeSiloMediaPath(path)) {
    throw new Error(
      'Invalid Silo playback media path.'
    );
  }

  const payload: SiloMediaTokenPayload = {
    v: 1,
    path,
    exp: expiresAt
  };

  const encoded = Buffer.from(
    JSON.stringify(payload)
  ).toString('base64url');

  return {
    token:
      `${encoded}.${signature(encoded, secret)}`,
    payload
  };
}

export function verifySiloMediaToken(
  token: string,
  secret: string,
  now = Date.now()
): SiloMediaTokenPayload | null {
  const [
    encoded,
    suppliedSignature,
    extra
  ] = token.split('.');

  if (
    !encoded ||
    !suppliedSignature ||
    extra ||
    !safeEqual(
      signature(encoded, secret),
      suppliedSignature
    )
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(
        encoded,
        'base64url'
      ).toString('utf8')
    ) as Partial<SiloMediaTokenPayload>;

    if (
      payload.v !== 1 ||
      typeof payload.path !== 'string' ||
      !isSafeSiloMediaPath(payload.path) ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now
    ) {
      return null;
    }

    return payload as SiloMediaTokenPayload;
  } catch {
    return null;
  }
}

export interface FallbackMediaTokenPayload {
  v: 1;
  sessionId: string;
  exp: number;
}

const fallbackSessionIdPattern = /^[a-f0-9-]{36}$/;

export function createFallbackMediaToken(
  sessionId: string,
  expiresAt: number,
  secret: string
): { token: string; payload: FallbackMediaTokenPayload } {
  if (!fallbackSessionIdPattern.test(sessionId)) {
    throw new Error('Invalid fallback playback session.');
  }
  const payload: FallbackMediaTokenPayload = {
    v: 1,
    sessionId,
    exp: expiresAt
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    token: `${encoded}.${signature(encoded, secret)}`,
    payload
  };
}

export function verifyFallbackMediaToken(
  token: string,
  secret: string,
  now = Date.now()
): FallbackMediaTokenPayload | null {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (
    !encoded || !suppliedSignature || extra ||
    !safeEqual(signature(encoded, secret), suppliedSignature)
  ) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as Partial<FallbackMediaTokenPayload>;
    if (
      payload.v !== 1 ||
      typeof payload.sessionId !== 'string' ||
      !fallbackSessionIdPattern.test(payload.sessionId) ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now
    ) return null;
    return payload as FallbackMediaTokenPayload;
  } catch {
    return null;
  }
}

export interface AdminSession {
  username: string;
  csrf: string;
  exp: number;
}

export function createSessionToken(username: string, secret: string, lifetimeMs = 12 * 60 * 60 * 1000): { token: string; session: AdminSession } {
  const session: AdminSession = { username, csrf: randomBytes(18).toString('base64url'), exp: Date.now() + lifetimeMs };
  const encoded = Buffer.from(JSON.stringify(session)).toString('base64url');
  return { token: `${encoded}.${signature(encoded, secret)}`, session };
}

export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): AdminSession | null {
  if (!token) return null;
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra || !safeEqual(signature(encoded, secret), suppliedSignature)) return null;
  try {
    const session = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<AdminSession>;
    if (typeof session.username !== 'string' || typeof session.csrf !== 'string' || typeof session.exp !== 'number' || session.exp <= now) return null;
    return session as AdminSession;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [algorithm, saltValue, hashValue] = storedHash.split(':');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue) return false;
  const derived = await scrypt(password, Buffer.from(saltValue, 'base64url'), 64) as Buffer;
  const expected = Buffer.from(hashValue, 'base64url');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
