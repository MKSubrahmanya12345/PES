/**
 * In-process sliding-window rate limiter.
 * Good enough for single-node / edge-less deploys; swap for Redis in multi-node.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __wireupRateLimit: Map<string, Bucket> | undefined;
}

function store(): Map<string, Bucket> {
  if (!globalThis.__wireupRateLimit) globalThis.__wireupRateLimit = new Map();
  return globalThis.__wireupRateLimit;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const buckets = store();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: limit - 1, resetAt, limit };
  }
  if (current.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: current.resetAt, limit };
  }
  current.count += 1;
  buckets.set(key, current);
  return { allowed: true, remaining: limit - current.count, resetAt: current.resetAt, limit };
}

/** Client IP best-effort (behind proxy headers when present). */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for') ?? headers.get('x-real-ip');
  if (forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
  return 'unknown';
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(Math.max(0, result.remaining)),
    'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}
