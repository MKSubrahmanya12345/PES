/**
 * Admin login — real accounts only (role=admin).
 * Hardcoded admin@wireup.com / admin123 is GONE.
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { verifyPassword } from '@/lib/auth/crypto';
import { clientIp, rateLimit, rateLimitHeaders } from '@/lib/auth/rate-limit';
import { attachSessionCookie } from '@/lib/auth/session';
import { toPublicUser } from '@/lib/auth/types';
import { getUserByEmail, rollUsage } from '@/lib/auth/users';
import { BadRequestError, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
});

export async function POST(request: NextRequest) {
  const ip = clientIp(request.headers);
  const limited = rateLimit(`admin:login:${ip}`, env().auth.rateLimitAuthPerMin, 60_000);
  if (!limited.allowed) {
    return jsonError(429, { code: 'rate_limited', message: 'Too many admin login attempts.' }, {
      headers: rateLimitHeaders(limited),
    });
  }

  try {
    const body = await readJson(request);
    const parsed = parseBody(Schema, body);
    const user = await getUserByEmail(parsed.email);

    if (!user || !verifyPassword(parsed.password, user.passwordHash) || user.role !== 'admin') {
      return jsonError(
        401,
        {
          code: 'invalid_credentials',
          message:
            'Invalid admin credentials. Create an admin via WIREUP_BOOTSTRAP_ADMIN_EMAIL/PASSWORD on first register, or promote a user in the database.',
        },
        { headers: rateLimitHeaders(limited) },
      );
    }

    const rolled = rollUsage(user);
    const response = jsonOk(
      {
        ok: true,
        user: toPublicUser(rolled),
        // Backward-compatible shape for AdminConsole that expected `token`.
        // The real auth is the httpOnly cookie; this field is intentionally
        // not a bearer credential.
        token: 'cookie-session',
      },
      { headers: rateLimitHeaders(limited) },
    );
    return attachSessionCookie(response, rolled);
  } catch (error) {
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Admin authentication failed.' });
  }
}
