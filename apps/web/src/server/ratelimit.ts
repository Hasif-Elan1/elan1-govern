import "server-only";

// Fixed-window counters in memory. One web process; see DECISIONS.md.
const buckets = new Map<string, { count: number; resetAt: number }>();

export function hit(key: string, max: number, windowMs: number): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (buckets.size > 50_000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  return { ok: b.count <= max, retryAfter: Math.ceil((b.resetAt - now) / 1000) };
}

export function resetRateLimits() {
  buckets.clear();
}

export const LIMITS = {
  login: { max: 10, windowMs: 60_000 },
  signup: { max: 5, windowMs: 60_000 },
  approvals: { max: 30, windowMs: 60_000 },
  mutation: { max: 120, windowMs: 60_000 },
  replay: { max: 10, windowMs: 60_000 },
} as const;

/** Raise per-IP limits for test runs from one machine (never in production). Per-account limits are not scaled. */
export const LIMIT_MULTIPLIER = process.env.APP_ENV === "production" ? 1 : Math.max(1, Number(process.env.RATE_LIMIT_MULTIPLIER ?? 1) || 1);
