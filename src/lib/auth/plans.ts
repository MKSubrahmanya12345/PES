/**
 * Subscription plans and metering limits.
 * Free tier is real product value, not a demo tease.
 */

export type PlanId = 'free' | 'pro' | 'team' | 'enterprise';

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Marketing price label (billing integration hooks later). */
  priceMonthlyUsd: number | null;
  /** Max projects created per calendar month (UTC). */
  projectsPerMonth: number;
  /** Max concurrent generation runs. */
  concurrentRuns: number;
  /** Max stored projects (soft cap). */
  maxStoredProjects: number;
  /** LLM generation calls allowed per month. */
  llmCallsPerMonth: number;
  /** Hosted simulator sessions per day. */
  simSessionsPerDay: number;
  /** API keys allowed. */
  apiKeys: number;
  /** Team seats (1 = solo). */
  seats: number;
  features: string[];
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  free: {
    id: 'free',
    name: 'Free',
    priceMonthlyUsd: 0,
    projectsPerMonth: 15,
    concurrentRuns: 1,
    maxStoredProjects: 25,
    llmCallsPerMonth: 40,
    simSessionsPerDay: 20,
    apiKeys: 1,
    seats: 1,
    features: [
      'Prompt → BOM, pins, wiring, firmware',
      'Deterministic validation + fix loop',
      'Hosted dashboard preview',
      'Export zip (firmware + diagram + guide)',
      '15 projects / month',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthlyUsd: 29,
    projectsPerMonth: 200,
    concurrentRuns: 3,
    maxStoredProjects: 500,
    llmCallsPerMonth: 800,
    simSessionsPerDay: 200,
    apiKeys: 5,
    seats: 1,
    features: [
      'Everything in Free',
      'Priority LLM codegen + fixer',
      '200 projects / month',
      'Hosted Velxio when configured',
      'API access',
    ],
  },
  team: {
    id: 'team',
    name: 'Team',
    priceMonthlyUsd: 99,
    projectsPerMonth: 1000,
    concurrentRuns: 10,
    maxStoredProjects: 5000,
    llmCallsPerMonth: 4000,
    simSessionsPerDay: 1000,
    apiKeys: 25,
    seats: 10,
    features: [
      'Everything in Pro',
      'Shared workspace (org ownership)',
      '10 seats',
      'Usage analytics',
      'SSO-ready admin',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthlyUsd: null,
    projectsPerMonth: 50_000,
    concurrentRuns: 50,
    maxStoredProjects: 100_000,
    llmCallsPerMonth: 100_000,
    simSessionsPerDay: 50_000,
    apiKeys: 100,
    seats: 500,
    features: [
      'Custom limits',
      'VPC / on-prem options',
      'SLA + support',
      'Catalog private extensions',
    ],
  },
};

export function planOf(id: string | undefined | null): PlanDefinition {
  if (id && id in PLANS) return PLANS[id as PlanId];
  return PLANS.free;
}

export function listPublicPlans(): PlanDefinition[] {
  return [PLANS.free, PLANS.pro, PLANS.team, PLANS.enterprise];
}

export interface UsageCounters {
  projectsThisMonth: number;
  llmCallsThisMonth: number;
  simSessionsToday: number;
  storedProjects: number;
  concurrentRuns: number;
}

export interface MeterDecision {
  allowed: boolean;
  code?: 'project_quota' | 'llm_quota' | 'sim_quota' | 'storage_quota' | 'concurrency';
  message?: string;
  plan: PlanDefinition;
  usage: UsageCounters;
}

export function checkProjectCreate(plan: PlanDefinition, usage: UsageCounters): MeterDecision {
  if (usage.concurrentRuns >= plan.concurrentRuns) {
    return {
      allowed: false,
      code: 'concurrency',
      message: `Your ${plan.name} plan allows ${plan.concurrentRuns} concurrent build(s). Wait for a run to finish or upgrade.`,
      plan,
      usage,
    };
  }
  if (usage.projectsThisMonth >= plan.projectsPerMonth) {
    return {
      allowed: false,
      code: 'project_quota',
      message: `Monthly project limit reached (${plan.projectsPerMonth} on ${plan.name}). Resets next UTC month, or upgrade.`,
      plan,
      usage,
    };
  }
  if (usage.storedProjects >= plan.maxStoredProjects) {
    return {
      allowed: false,
      code: 'storage_quota',
      message: `Stored project cap reached (${plan.maxStoredProjects} on ${plan.name}). Delete old projects or upgrade.`,
      plan,
      usage,
    };
  }
  return { allowed: true, plan, usage };
}

export function checkLlmCall(plan: PlanDefinition, usage: UsageCounters): MeterDecision {
  if (usage.llmCallsThisMonth >= plan.llmCallsPerMonth) {
    return {
      allowed: false,
      code: 'llm_quota',
      message: `LLM call quota reached (${plan.llmCallsPerMonth}/mo on ${plan.name}). Deterministic planners still run; upgrade for more model calls.`,
      plan,
      usage,
    };
  }
  return { allowed: true, plan, usage };
}

export function utcMonthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function utcDayKey(date = new Date()): string {
  return `${utcMonthKey(date)}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
