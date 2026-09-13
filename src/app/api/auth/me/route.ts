/**
 * GET /api/auth/me — current session + plan + usage.
 */

import type { NextRequest } from 'next/server';

import { listPublicPlans, planOf } from '@/lib/auth/plans';
import { AuthError, requireAuth } from '@/lib/auth/session';
import { jsonError, jsonOk } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAuth(request, { optional: true });
    if (!auth) {
      return jsonOk({
        authenticated: false,
        user: null,
        plans: listPublicPlans().map((plan) => ({
          id: plan.id,
          name: plan.name,
          priceMonthlyUsd: plan.priceMonthlyUsd,
          features: plan.features,
          projectsPerMonth: plan.projectsPerMonth,
        })),
      });
    }
    return jsonOk({
      authenticated: true,
      user: auth.publicUser,
      plan: auth.plan,
      usage: auth.usage,
      plans: listPublicPlans().map((plan) => ({
        id: plan.id,
        name: plan.name,
        priceMonthlyUsd: plan.priceMonthlyUsd,
        features: plan.features,
        projectsPerMonth: plan.projectsPerMonth,
      })),
      via: auth.via,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return jsonError(error.status, { code: error.code, message: error.message });
    }
    return jsonError(500, { code: 'internal_error', message: 'Could not read session.' });
  }
}
