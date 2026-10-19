interface Bucket {
  reset: number;
  count: number;
}

/** Fixed-window counter. Used when the Workers Rate Limiting binding is absent. */
export function createRateLimiter(limit: number, windowMs = 60_000) {
  const buckets = new Map<string, Bucket>();
  return {
    allow(key: string, nowMs: number): boolean {
      const bucket = buckets.get(key);
      if (!bucket || nowMs >= bucket.reset) {
        buckets.set(key, { reset: nowMs + windowMs, count: 1 });
        return true;
      }
      if (bucket.count >= limit) return false;
      bucket.count += 1;
      return true;
    },
    reset(): void {
      buckets.clear();
    },
  };
}
