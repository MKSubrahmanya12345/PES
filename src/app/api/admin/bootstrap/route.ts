/**
 * POST /api/admin/bootstrap
 *
 * One-shot promotion of the bootstrap admin email (WIREUP_BOOTSTRAP_ADMIN_EMAIL)
 * to role=admin. Protected by matching the signed-in user's email. Safe to call
 * repeatedly (idempotent).
 */

import type { NextRequest } from 'next/server';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { getUserById, saveUser } from '@/lib/auth/users';
import { jsonError, jsonOk } from '@/lib/http';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });

    const bootstrapEmail = env().auth.bootstrapAdminEmail?.trim().toLowerCase();
    if (!bootstrapEmail) {
      return jsonError(503, {
        code: 'bootstrap_disabled',
        message: 'Set WIREUP_BOOTSTRAP_ADMIN_EMAIL to enable admin bootstrap.',
      });
    }

    if (auth.user.email.trim().toLowerCase() !== bootstrapEmail) {
      return jsonError(403, {
        code: 'forbidden',
        message: 'Only the configured bootstrap admin email can claim admin.',
      });
    }

    const user = await getUserById(auth.user.id);
    if (!user) return jsonError(404, { code: 'not_found', message: 'User not found.' });

    if (user.role === 'admin') {
      return jsonOk({ ok: true, role: user.role, alreadyAdmin: true });
    }

    const updated = await saveUser(user.id, {
      role: 'admin',
      plan: user.plan === 'free' ? 'team' : user.plan,
    });

    return jsonOk({ ok: true, role: updated?.role ?? 'admin', alreadyAdmin: false });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    const message = error instanceof Error ? error.message : 'Bootstrap failed.';
    return jsonError(500, { code: 'bootstrap_failed', message });
  }
}
