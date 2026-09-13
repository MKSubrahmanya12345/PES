/**
 * API key management for programmatic access.
 * POST create · GET list · DELETE revoke
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { generateApiKey } from '@/lib/auth/crypto';
import { AuthError, requireAuth } from '@/lib/auth/session';
import { addApiKey, revokeApiKey, UserError } from '@/lib/auth/users';
import { createId } from '@/lib/validation/ids';
import { nowIso } from '@/lib/validation/time';
import { BadRequestError, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });
    return jsonOk({
      keys: auth.user.apiKeys.map((key) => ({
        id: key.id,
        prefix: key.prefix,
        name: key.name,
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt,
      })),
      limit: auth.plan.apiKeys,
    });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.status, { code: error.code, message: error.message });
    return jsonError(500, { code: 'internal_error', message: 'Could not list API keys.' });
  }
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(60).default('default'),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });
    const body = await readJson(request);
    const parsed = parseBody(CreateSchema, body ?? {});
    const material = generateApiKey();
    const record = {
      id: createId('key'),
      prefix: material.prefix,
      hash: material.hash,
      name: parsed.name,
      createdAt: nowIso(),
      lastUsedAt: null,
    };
    await addApiKey(auth.user.id, record, auth.plan.apiKeys);
    // Raw key shown once — never stored or returned again.
    return jsonOk(
      {
        id: record.id,
        prefix: record.prefix,
        name: record.name,
        key: material.raw,
        warning: 'Copy this key now. Wireup will not show it again.',
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.status, { code: error.code, message: error.message });
    if (error instanceof UserError) return jsonError(400, { code: error.code, message: error.message });
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Could not create API key.' });
  }
}

const DeleteSchema = z.object({
  id: z.string().trim().min(1),
});

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });
    const body = await readJson(request);
    const parsed = parseBody(DeleteSchema, body);
    await revokeApiKey(auth.user.id, parsed.id);
    return jsonOk({ revoked: true });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.status, { code: error.code, message: error.message });
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Could not revoke API key.' });
  }
}
