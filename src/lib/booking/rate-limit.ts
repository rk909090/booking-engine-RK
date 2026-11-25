import "server-only";

/*
 * Small in-memory rate limiter for public actions (starting a booking,
 * looking one up). Enough for one Node process on Hostinger; move it to
 * Postgres or Redis when the app runs on several instances.
 */
const buckets = new Map<string, number[]>();

export function allowRequest(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 10_000) {
    for (const [k, times] of buckets) if (times.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
  return true;
}

/** Client IP as forwarded by Hostinger's proxy (first X-Forwarded-For entry). */
export function clientIp(headers: Headers): string {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || headers.get("x-real-ip") || "unknown";
}
