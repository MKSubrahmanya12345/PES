/**
 * Password hashing and JWT session tokens.
 * No hardcoded credentials. Tokens are signed (HS256) and verified.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import { env } from '@/lib/validation/env';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export type SessionClaims = Omit<JWTPayload, 'sub'> & {
  sub: string;
  email: string;
  role: 'user' | 'admin';
  plan: string;
  name: string;
};

function secretKey(): Uint8Array {
  const secret = env().auth.jwtSecret;
  return new TextEncoder().encode(secret);
}

/** Hash a password with scrypt (salt embedded). Format: scrypt$n$r$p$saltHex$hashHex */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time password verify. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts[0] !== 'scrypt' || parts.length !== 6) return false;
    const n = Number.parseInt(parts[1] ?? '', 10);
    const r = Number.parseInt(parts[2] ?? '', 10);
    const p = Number.parseInt(parts[3] ?? '', 10);
    const salt = Buffer.from(parts[4] ?? '', 'hex');
    const expected = Buffer.from(parts[5] ?? '', 'hex');
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || salt.length === 0 || expected.length === 0) {
      return false;
    }
    const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function signSession(claims: Omit<SessionClaims, 'iat' | 'exp'>): Promise<string> {
  const ttl = env().auth.sessionTtlSeconds;
  return new SignJWT({
    email: claims.email,
    role: claims.role,
    plan: claims.plan,
    name: claims.name,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(claims.sub))
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setIssuer('wireup')
    .setAudience('wireup-app')
    .sign(secretKey());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: 'wireup',
      audience: 'wireup-app',
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const email = typeof payload.email === 'string' ? payload.email : null;
    const role = payload.role === 'admin' || payload.role === 'user' ? payload.role : null;
    const plan = typeof payload.plan === 'string' ? payload.plan : 'free';
    const name = typeof payload.name === 'string' ? payload.name : '';
    if (!sub || !email || !role) return null;
    return { ...payload, sub, email, role, plan, name };
  } catch {
    return null;
  }
}

/** Opaque API key material: `wup_` + 32 random bytes hex. */
export function generateApiKey(): { raw: string; prefix: string; hash: string } {
  const raw = `wup_${randomBytes(24).toString('hex')}`;
  const prefix = raw.slice(0, 12);
  const hash = hashApiKey(raw);
  return { raw, prefix, hash };
}

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function sessionCookieName(): string {
  return env().auth.cookieName;
}

export function sessionCookieOptions(maxAgeSeconds?: number): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  const secure = env().nodeEnv === 'production';
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds ?? env().auth.sessionTtlSeconds,
  };
}
