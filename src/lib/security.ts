import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

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
}

export function createStreamToken(fileId: string, expiresAt: number, secret: string, jti = randomBytes(12).toString('base64url')): { token: string; payload: StreamTokenPayload } {
  const payload: StreamTokenPayload = { v: 1, fileId, exp: expiresAt, jti };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return { token: `${encoded}.${signature(encoded, secret)}`, payload };
}

export function verifyStreamToken(token: string, secret: string, now = Date.now()): StreamTokenPayload | null {
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra || !safeEqual(signature(encoded, secret), suppliedSignature)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<StreamTokenPayload>;
    if (payload.v !== 1 || typeof payload.fileId !== 'string' || typeof payload.exp !== 'number' || typeof payload.jti !== 'string') return null;
    if (payload.exp <= now) return null;
    return payload as StreamTokenPayload;
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
