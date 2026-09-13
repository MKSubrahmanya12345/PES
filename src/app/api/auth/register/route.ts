/**
 * POST /api/auth/register — create account + session cookie.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { hashPassword } from '@/lib/auth/crypto';
import { clientIp, rateLimit, rateLimitHeaders } from '@/lib/auth/rate-limit';
import { attachSessionCookie } from '@/lib/auth/session';
import { toPublicUser } from '@/lib/auth/types';
import { createUser, UserError } from '@/lib/auth/users';
import { BadRequestError, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
  name: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const limited = rateLimit(`auth:register:${ip}`, env().auth.rateLimitAuthPerMin, 60_000);
  if (!limited.allowed) {
    return jsonError(429, { code: 'rate_limited', message: 'Too many sign-ups from this network. Try again shortly.' }, {
      headers: rateLimitHeaders(limited),
    });
  }

  try {
    const body = await readJson(request);
    const parsed = parseBody(Schema, body);
    const passwordHash = hashPassword(parsed.password);

    // First user matching bootstrap admin email becomes admin.
    const bootstrapEmail = env().auth.bootstrapAdminEmail?.toLowerCase();
    const isBootstrapAdmin =
      Boolean(bootstrapEmail) && parsed.email.trim().toLowerCase() === bootstrapEmail;

    const user = await createUser({
      email: parsed.email,
      name: parsed.name ?? parsed.email.split('@')[0] ?? 'Maker',
      passwordHash,
      role: isBootstrapAdmin ? 'admin' : 'user',
      plan: 'free',
    });

    const response = jsonOk(
      { user: toPublicUser(user), plan: user.plan },
      { status: 201, headers: rateLimitHeaders(limited) },
    );
    return attachSessionCookie(response, user);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message, details: error.issues.join('; ') });
    }
    if (error instanceof UserError && error.code === 'email_taken') {
      return jsonError(409, { code: 'email_taken', message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Registration failed.' });
  }
}
