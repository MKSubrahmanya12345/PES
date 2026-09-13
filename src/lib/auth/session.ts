/**
 * Request auth: cookie session JWT or Bearer API key.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import {
  hashApiKey,
  sessionCookieName,
  sessionCookieOptions,
  signSession,
  verifySession,
  type SessionClaims,
} from '@/lib/auth/crypto';
import { planOf, type PlanDefinition, type UsageCounters } from '@/lib/auth/plans';
import { toPublicUser, type PublicUser, type UserRecord } from '@/lib/auth/types';
import {
  findUserByApiKeyHash,
  getUserById,
  rollUsage,
  saveUser,
} from '@/lib/auth/users';
import { env } from '@/lib/validation/env';
import { countProjectsForOwner, countRunningForOwner } from '@/lib/mongodb/projects';

export interface AuthContext {
  user: UserRecord;
  publicUser: PublicUser;
  plan: PlanDefinition;
  usage: UsageCounters;
  /** How the request was authenticated. */
  via: 'session' | 'api_key';
  claims: SessionClaims | null;
}

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function readBearer(request: NextRequest): string | null {
  const header = request.headers.get('authorization') ?? request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function readCookieToken(request: NextRequest): string | null {
  return request.cookies.get(sessionCookieName())?.value ?? null;
}

async function usageFor(user: UserRecord): Promise<UsageCounters> {
  const rolled = rollUsage(user);
  if (rolled.usage.monthKey !== user.usage.monthKey || rolled.usage.dayKey !== user.usage.dayKey) {
    await saveUser(user.id, { usage: rolled.usage });
  }
  const [storedProjects, concurrentRuns] = await Promise.all([
    countProjectsForOwner(user.id),
    countRunningForOwner(user.id),
  ]);
  return {
    projectsThisMonth: rolled.usage.projectsThisMonth,
    llmCallsThisMonth: rolled.usage.llmCallsThisMonth,
    simSessionsToday: rolled.usage.simSessionsToday,
    storedProjects,
    concurrentRuns,
  };
}

async function buildContext(user: UserRecord, via: 'session' | 'api_key', claims: SessionClaims | null): Promise<AuthContext> {
  const rolled = rollUsage(user);
  const usage = await usageFor(rolled);
  return {
    user: rolled,
    publicUser: toPublicUser(rolled),
    plan: planOf(rolled.plan),
    usage,
    via,
    claims,
  };
}

/**
 * Resolve the caller. When auth is required and missing → throws AuthError.
 * When `optional` and missing → returns null (guest mode for marketing pages only).
 * When `WIREUP_AUTH_REQUIRED=false` (offline verify scripts), returns a synthetic
 * local owner so pipelines keep working without a browser session.
 */
export async function requireAuth(request: NextRequest, options?: { optional?: boolean }): Promise<AuthContext | null> {
  const bearer = readBearer(request);
  if (bearer?.startsWith('wup_')) {
    const user = await findUserByApiKeyHash(hashApiKey(bearer));
    if (!user) {
      if (options?.optional) return null;
      throw new AuthError(401, 'invalid_api_key', 'API key is invalid or revoked.');
    }
    return buildContext(user, 'api_key', null);
  }

  if (bearer) {
    const claims = await verifySession(bearer);
    if (claims) {
      const user = await getUserById(claims.sub);
      if (user) return buildContext(user, 'session', claims);
    }
  }

  const cookieToken = readCookieToken(request);
  if (cookieToken) {
    const claims = await verifySession(cookieToken);
    if (claims) {
      const user = await getUserById(claims.sub);
      if (user) return buildContext(user, 'session', claims);
    }
  }

  if (options?.optional) return null;

  // Offline / CI harness mode: auth deliberately off.
  if (!env().auth.required) {
    return syntheticLocalAuth();
  }

  throw new AuthError(401, 'unauthenticated', 'Sign in to continue.');
}

/** Synthetic owner used only when WIREUP_AUTH_REQUIRED=false. */
async function syntheticLocalAuth(): Promise<AuthContext> {
  const { utcDayKey, utcMonthKey, planOf } = await import('@/lib/auth/plans');
  const user = {
    id: 'local-dev',
    email: 'local@wireup.dev',
    name: 'Local dev',
    passwordHash: '',
    role: 'admin' as const,
    plan: 'enterprise' as const,
    orgId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    usage: {
      monthKey: utcMonthKey(),
      projectsThisMonth: 0,
      llmCallsThisMonth: 0,
      dayKey: utcDayKey(),
      simSessionsToday: 0,
    },
    apiKeys: [],
    stripeCustomerId: null,
    stripeSubscriptionId: null,
  };
  return {
    user,
    publicUser: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      plan: user.plan,
      orgId: null,
      createdAt: user.createdAt,
      usage: user.usage,
      apiKeyCount: 0,
    },
    plan: planOf('enterprise'),
    usage: {
      projectsThisMonth: 0,
      llmCallsThisMonth: 0,
      simSessionsToday: 0,
      storedProjects: 0,
      concurrentRuns: 0,
    },
    via: 'session',
    claims: null,
  };
}

export async function requireAdmin(request: NextRequest): Promise<AuthContext> {
  const auth = await requireAuth(request);
  if (!auth) throw new AuthError(401, 'unauthenticated', 'Sign in to continue.');
  if (auth.user.role !== 'admin') {
    throw new AuthError(403, 'forbidden', 'Admin access required.');
  }
  return auth;
}

/** Attach session cookie to a response after login/register. */
export async function attachSessionCookie(response: NextResponse, user: UserRecord): Promise<NextResponse> {
  const token = await signSession({
    sub: user.id,
    email: user.email,
    role: user.role,
    plan: user.plan,
    name: user.name,
  });
  response.cookies.set(sessionCookieName(), token, sessionCookieOptions());
  return response;
}

export function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(sessionCookieName(), '', { ...sessionCookieOptions(0), maxAge: 0 });
  return response;
}

/** Dev convenience: when AUTH is disabled (tests), a synthetic owner. */
export function authRequired(): boolean {
  return env().auth.required;
}
