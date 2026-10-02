// Per-key token bucket, in memory. `capacity` requests at once, refilled at `perMinute`.

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly perMinute: number,
    private readonly capacity: number = perMinute,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes one token for `key`. Returns false when the key is over its limit. */
  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
    const refill = ((t - b.at) / 60_000) * this.perMinute;
    b.tokens = Math.min(this.capacity, b.tokens + refill);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
