/**
 * POST /api/billing/checkout — Stripe Checkout session when configured.
 * Returns a clear "not configured" response otherwise (no fake checkout).
 */

import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { AuthError, requireAuth } from '@/lib/auth/session';
import { BadRequestError, jsonError, jsonOk, parseBody, readJson } from '@/lib/http';
import { env } from '@/lib/validation/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Schema = z.object({
  plan: z.enum(['pro', 'team']),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireAuth(request);
    if (!auth) return jsonError(401, { code: 'unauthenticated', message: 'Sign in required.' });

    const body = await readJson(request);
    const parsed = parseBody(Schema, body);
    const billing = env().billing;

    if (!billing.stripeSecretKey) {
      return jsonError(501, {
        code: 'billing_not_configured',
        message:
          'Stripe is not configured on this deployment. Set STRIPE_SECRET_KEY and STRIPE_PRICE_PRO / STRIPE_PRICE_TEAM, or ask an admin to change your plan.',
      });
    }

    const priceId = parsed.plan === 'pro' ? billing.pricePro : billing.priceTeam;
    if (!priceId) {
      return jsonError(501, {
        code: 'price_not_configured',
        message: `No Stripe price id for plan "${parsed.plan}". Set STRIPE_PRICE_${parsed.plan.toUpperCase()}.`,
      });
    }

    const publicUrl = env().auth.publicUrl ?? 'http://localhost:3000';
    const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${billing.stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        mode: 'subscription',
        success_url: `${publicUrl}/account?checkout=success`,
        cancel_url: `${publicUrl}/pricing?checkout=cancel`,
        client_reference_id: auth.user.id,
        customer_email: auth.user.email,
        'line_items[0][price]': priceId,
        'line_items[0][quantity]': '1',
        'metadata[userId]': auth.user.id,
        'metadata[plan]': parsed.plan,
      }),
    });

    const payload = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!response.ok || !payload.url) {
      return jsonError(502, {
        code: 'stripe_error',
        message: payload.error?.message ?? 'Stripe checkout session failed.',
      });
    }

    return jsonOk({ url: payload.url, sessionId: payload.id });
  } catch (error) {
    if (error instanceof AuthError) return jsonError(error.status, { code: error.code, message: error.message });
    if (error instanceof BadRequestError) {
      return jsonError(400, { code: 'bad_request', message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Checkout failed.' });
  }
}
