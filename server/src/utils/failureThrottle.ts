/**
 * In-process failure counter with lockout, keyed by an opaque string.
 *
 * After `maxFails` failures within `windowMs` (counted from the first failure
 * of the window), the key is locked for `lockMs`. Per process, like the
 * express-rate-limit memory stores used elsewhere in Obligate.
 *
 * Callers must build keys from CANONICAL values only (see parsePositiveInt):
 * a counter keyed by a raw input is bypassed by spelling the same user id
 * differently ("5", "05", "5 ").
 */
export interface ThrottleRule {
  maxFails: number;
  windowMs: number;
  lockMs: number;
}

interface Entry {
  fails: number;
  firstAt: number;
  lockUntil: number;
}

export class FailureThrottle {
  private readonly entries = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(private readonly rule: ThrottleRule, private readonly maxEntries = 50_000) {}

  /** 0 when the key may be tried, else the seconds left on its lock. */
  retryAfterSec(key: string, now = Date.now()): number {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (e.lockUntil > now) return Math.ceil((e.lockUntil - now) / 1000);
    if (now - e.firstAt > this.rule.windowMs) this.entries.delete(key);
    return 0;
  }

  /** Record one failure. Returns true when this failure started a lock. */
  fail(key: string, now = Date.now()): boolean {
    this.sweep(now);
    let e = this.entries.get(key);
    if (!e || (e.lockUntil <= now && now - e.firstAt > this.rule.windowMs)) {
      e = { fails: 0, firstAt: now, lockUntil: 0 };
    }
    e.fails++;
    let locked = false;
    if (e.fails >= this.rule.maxFails) {
      e.lockUntil = now + this.rule.lockMs;
      e.fails = 0;          // the lock is now the gate
      e.firstAt = now;
      locked = true;
    }
    this.entries.set(key, e);
    return locked;
  }

  /** Forget a key (e.g. after a success). */
  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drop expired entries: at most once a minute, or when the map grows large. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.entries.size < this.maxEntries) return;
    this.lastSweep = now;
    for (const [k, e] of this.entries) {
      if (e.lockUntil <= now && now - e.firstAt > this.rule.windowMs) this.entries.delete(k);
    }
  }
}
