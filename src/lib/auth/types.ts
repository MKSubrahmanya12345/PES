import type { PlanId } from './plans';

export type UserRole = 'user' | 'admin';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  plan: PlanId;
  /** Optional org for team plans. */
  orgId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Usage counters keyed by period. */
  usage: {
    monthKey: string;
    projectsThisMonth: number;
    llmCallsThisMonth: number;
    dayKey: string;
    simSessionsToday: number;
  };
  apiKeys: ApiKeyRecord[];
  /** Stripe-ready fields (null until billing connected). */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

export interface ApiKeyRecord {
  id: string;
  prefix: string;
  hash: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  plan: PlanId;
  orgId: string | null;
  createdAt: string;
  usage: UserRecord['usage'];
  apiKeyCount: number;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    plan: user.plan,
    orgId: user.orgId,
    createdAt: user.createdAt,
    usage: user.usage,
    apiKeyCount: user.apiKeys.length,
  };
}
