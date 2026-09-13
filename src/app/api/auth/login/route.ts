/**
 * POST /api/auth/login — email/password → session cookie.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { verifyPassword } from '@/lib/auth/crypto';
import { clientIp, rateLimit, rateLimitHeaders } from '@/lib/auth/rate-limit';
import { attachSessionCookie } from '@/lib/auth/session';
import { planOf } from '@/lib/auth/plans';
import { toPublicUser } from '@/lib/auth/types';
import { getUserByEmail, rollUsage } from '@/lib/auth/users';
import { BadRequestError, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const limited = rateLimit(`auth:login:${ip}`, env().auth.rateLimitAuthPerMin, 60_000);
  if (!limited.allowed) {
    return jsonError(429, { code: 'rate_limited', message: 'Too many login attempts. Try again shortly.' }, {
      headers: rateLimitHeaders(limited),
    });
  }

  try {
    const body = await readJson(request);
    const parsed = parseBody(Schema, body);
    const user = await getUserByEmail(parsed.email);
    // Constant-ish failure message — don't leak whether email exists.
    if (!user || !verifyPassword(parsed.password, user.passwordHash)) {
      return jsonError(401, { code: 'invalid_credentials', message: 'Email or password is incorrect.' }, {
        headers: rateLimitHeaders(limited),
      });
    }

    const rolled = rollUsage(user);
    const response = jsonOk(
      {
        user: toPublicUser(rolled),
        plan: planOf(rolled.plan),
      },
      { headers: rateLimitHeaders(limited) },
    );
    return attachSessionCookie(response, rolled);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    return jsonError(500, { code: 'internal_error', message: 'Login failed.' });
  }
}
