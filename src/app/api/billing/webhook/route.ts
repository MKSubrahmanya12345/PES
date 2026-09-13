/**
 * POST /api/billing/webhook — Stripe webhook (subscription → plan).
 * Verifies stripe-signature when STRIPE_WEBHOOK_SECRET is set.
 */

import type { NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { PlanId } from '@/lib/auth/plans';
import { getUserById, saveUser } from '@/lib/auth/users';
import { jsonError, jsonOk } from '@/lib/http';
import { env } from '@/lib/validation/env';
import { logger } from '@/lib/logging/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function verifyStripeSignature(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  try {
    const parts = Object.fromEntries(
      header.split(',').map((piece) => {
        const [k, v] = piece.split('=');
        return [k?.trim() ?? '', v?.trim() ?? ''];
      }),
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (!timestamp || !signature) return false;
    const age = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (age > 300) return false;
    const expected = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const billing = env().billing;
  if (!billing.stripeSecretKey) {
    return jsonError(501, { code: 'billing_not_configured', message: 'Stripe is not configured.' });
  }

  const raw = await request.text();
  if (billing.stripeWebhookSecret) {
    const header = request.headers.get('stripe-signature');
    if (!verifyStripeSignature(raw, header, billing.stripeWebhookSecret)) {
      return jsonError(400, { code: 'invalid_signature', message: 'Stripe signature verification failed.' });
    }
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return jsonError(400, { code: 'bad_json', message: 'Invalid JSON.' });
  }

  const object = event.data?.object ?? {};
  const metadata = (object.metadata as Record<string, string> | undefined) ?? {};
  const userId = metadata.userId ?? (typeof object.client_reference_id === 'string' ? object.client_reference_id : null);
  const plan = metadata.plan as PlanId | undefined;

  if (event.type === 'checkout.session.completed' && userId && (plan === 'pro' || plan === 'team')) {
    const user = await getUserById(userId);
    if (user) {
      await saveUser(userId, {
        plan,
        stripeCustomerId: typeof object.customer === 'string' ? object.customer : user.stripeCustomerId,
        stripeSubscriptionId: typeof object.subscription === 'string' ? object.subscription : user.stripeSubscriptionId,
      });
      logger.info({ userId, plan }, 'plan upgraded via Stripe checkout');
    }
  }

  if (event.type === 'customer.subscription.deleted' && userId) {
    await saveUser(userId, { plan: 'free', stripeSubscriptionId: null });
    logger.info({ userId }, 'plan reverted to free after subscription deleted');
  }

  return jsonOk({ received: true });
}
