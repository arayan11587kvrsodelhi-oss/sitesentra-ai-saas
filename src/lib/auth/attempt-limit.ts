/**
 * SiteSentra — in-process limiter for authentication attempts.
 *
 * Why this exists:
 *  - The scanner already has a durable per-user quota (`src/lib/rate-limit.ts`),
 *    but login and signup had NO throttle at all. That leaves credential
 *    stuffing and bulk account creation unconstrained, which is the highest
 *    impact abuse path in an email/password product.
 *  - This module deliberately adds NO dependency and NO new table: it is a
 *    bounded in-memory sliding-window counter, keyed by an opaque digest.
 *
 * Design choices (and their honest limits):
 *  - Keys are hashed with SHA-256 before being used as map keys. The raw email
 *    or IP is never retained in memory, so a heap dump does not expose a list of
 *    addresses that failed to log in. The digest is computed with a per-process
 *    secret salt so the same email produces different keys across restarts and
 *    instances (preimage resistance + no cross-instance correlation).
 *  - The map is capped (`maxTrackedKeys`); when it overflows the oldest entries
 *    are evicted. This bounds memory under a distributed attack, at the cost of
 *    an attacker being able to force eviction of other keys — an accepted
 *    trade-off that a shared store would remove. Documented, not hidden.
 *  - Counters are per-process. On a multi-instance deployment the effective
 *    limit is (limit × instances). A shared store is the correct fix and is
 *    listed as a known limitation in docs/SECURITY.md.
 *
 * Pure logic lives in `SlidingWindowLimiter` so it can be unit-tested with an
 * injected clock; the process-wide singletons at the bottom are thin wrappers.
 */
import { createHash, randomBytes } from "node:crypto";

export type LimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the caller may retry. 0 when allowed. */
  retryAfterSeconds: number;
};

type Entry = { count: number; windowStart: number };

/**
 * A sliding-window counter.
 *
 * "Sliding" here means: a fixed window anchored at the first attempt in the
 * window. Once the window elapses, the counter resets. This is the standard
 * cheap approximation — it is not a true token bucket, so an attacker can burst
 * up to 2× the limit across a window boundary. That is acceptable for login
 * throttling (it still bounds sustained rate) and is cheaper than a timestamp
 * ring buffer.
 */
export class SlidingWindowLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxTrackedKeys: number;
  private readonly now: () => number;

  constructor(options: { limit: number; windowMs: number; maxTrackedKeys?: number; now?: () => number }) {
    this.limit = Math.max(1, Math.floor(options.limit));
    this.windowMs = Math.max(1000, Math.floor(options.windowMs));
    this.maxTrackedKeys = Math.max(16, Math.floor(options.maxTrackedKeys ?? 10_000));
    this.now = options.now ?? Date.now;
  }

  /** Record one attempt and return whether it is allowed. */
  hit(key: string): LimitDecision {
    const now = this.now();
    const entry = this.entries.get(key);

    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.evictIfNeeded();
      this.entries.set(key, { count: 1, windowStart: now });
      return { allowed: true, limit: this.limit, remaining: this.limit - 1, retryAfterSeconds: 0 };
    }

    if (entry.count >= this.limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000));
      return { allowed: false, limit: this.limit, remaining: 0, retryAfterSeconds };
    }

    entry.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      retryAfterSeconds: 0,
    };
  }

  /**
   * Inspect without consuming an attempt. Used by GET handlers or UI hints.
   */
  peek(key: string): LimitDecision {
    const now = this.now();
    const entry = this.entries.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      return { allowed: true, limit: this.limit, remaining: this.limit, retryAfterSeconds: 0 };
    }
    const remaining = Math.max(0, this.limit - entry.count);
    return {
      allowed: remaining > 0,
      limit: this.limit,
      remaining,
      retryAfterSeconds: remaining > 0 ? 0 : Math.max(1, Math.ceil((entry.windowStart + this.windowMs - now) / 1000)),
    };
  }

  /**
   * Forget a key — called after a *successful* login so a legitimate user is
   * not penalised for earlier typos.
   */
  reset(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private evictIfNeeded(): void {
    if (this.entries.size < this.maxTrackedKeys) return;
    // Map preserves insertion order; drop the oldest quarter in one pass.
    const toDrop = Math.ceil(this.entries.size / 4);
    let dropped = 0;
    for (const key of this.entries.keys()) {
      this.entries.delete(key);
      dropped += 1;
      if (dropped >= toDrop) break;
    }
  }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/**
 * Per-process random salt. It is NOT a secret credential — its only job is to
 * stop the in-memory keys from being trivially reversible to an email address,
 * so a heap inspection cannot enumerate attempted accounts.
 */
const KEY_SALT = randomBytes(32);

/** Derive an opaque, non-reversible key. Never returns the raw input. */
export function deriveKey(scope: string, raw: string): string {
  return createHash("sha256")
    .update(KEY_SALT)
    .update(scope)
    .update("\u0000")
    .update(raw.toLowerCase())
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Environment-driven singletons
// ---------------------------------------------------------------------------

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loginLimitPerWindow(): number {
  return intEnv("AUTH_LOGIN_MAX_PER_WINDOW", 10);
}

export function signupLimitPerWindow(): number {
  // Deliberately generous: signup is limited per address AND per account, and
  // legitimate verification runs (and shared-NAT offices) create several
  // accounts from one address. 20/15min still bounds bulk account creation.
  return intEnv("AUTH_SIGNUP_MAX_PER_WINDOW", 20);
}

export function authWindowMinutes(): number {
  return intEnv("AUTH_RATE_LIMIT_WINDOW_MINUTES", 15);
}

function windowMs(): number {
  return authWindowMinutes() * 60 * 1000;
}

/**
 * Keyed by BOTH the derived account identifier and the derived client address.
 * An attacker rotating source IPs still hits the per-account bucket, and an
 * attacker spraying many accounts from one address still hits the per-address
 * bucket.
 */
export type AuthAttemptInput = { email: string; clientAddress: string | null };

const globalForAuthLimit = globalThis as typeof globalThis & {
  __siteSentraLoginLimiter?: SlidingWindowLimiter;
  __siteSentraSignupLimiter?: SlidingWindowLimiter;
};

function loginLimiter(): SlidingWindowLimiter {
  if (!globalForAuthLimit.__siteSentraLoginLimiter) {
    globalForAuthLimit.__siteSentraLoginLimiter = new SlidingWindowLimiter({
      limit: loginLimitPerWindow(),
      windowMs: windowMs(),
    });
  }
  return globalForAuthLimit.__siteSentraLoginLimiter;
}

function signupLimiter(): SlidingWindowLimiter {
  if (!globalForAuthLimit.__siteSentraSignupLimiter) {
    globalForAuthLimit.__siteSentraSignupLimiter = new SlidingWindowLimiter({
      limit: signupLimitPerWindow(),
      windowMs: windowMs(),
    });
  }
  return globalForAuthLimit.__siteSentraSignupLimiter;
}

export type AuthLimitResult = LimitDecision & { scope: "account" | "address" };

/**
 * Consume one login attempt. Checks the account bucket first, then the address
 * bucket; a rejection in either denies the attempt. Both buckets are only
 * consumed when the attempt is allowed, so a blocked attacker cannot drain a
 * victim's address bucket faster than the account bucket.
 */
export function consumeLoginAttempt(input: AuthAttemptInput): AuthLimitResult {
  const limiter = loginLimiter();
  const accountKey = deriveKey("login:account", input.email);
  const addressKey = input.clientAddress ? deriveKey("login:address", input.clientAddress) : null;

  const account = limiter.peek(accountKey);
  if (!account.allowed) return { ...account, scope: "account" };
  if (addressKey) {
    const address = limiter.peek(addressKey);
    if (!address.allowed) return { ...address, scope: "address" };
  }

  const consumed = limiter.hit(accountKey);
  if (addressKey) limiter.hit(addressKey);
  return { ...consumed, scope: "account" };
}

/** Clear the account bucket after a successful login (not the address bucket). */
export function resetLoginAttempts(email: string): void {
  loginLimiter().reset(deriveKey("login:account", email));
}

export type SignupLimitResult = LimitDecision & { scope: "account" | "address" };

export function consumeSignupAttempt(input: AuthAttemptInput): SignupLimitResult {
  const limiter = signupLimiter();
  const accountKey = deriveKey("signup:account", input.email);
  const addressKey = input.clientAddress ? deriveKey("signup:address", input.clientAddress) : null;

  const account = limiter.peek(accountKey);
  if (!account.allowed) return { ...account, scope: "account" };
  if (addressKey) {
    const address = limiter.peek(addressKey);
    if (!address.allowed) return { ...address, scope: "address" };
  }

  const consumed = limiter.hit(accountKey);
  if (addressKey) limiter.hit(addressKey);
  return { ...consumed, scope: "account" };
}

/**
 * Best-effort client address for throttling.
 *
 * Trusting `x-forwarded-for` blindly is unsafe (it is attacker-controlled
 * unless a trusted proxy overwrites it), so this is used ONLY as a rate-limit
 * dimension — never for authorization — and a missing/blank value degrades to
 * the per-account bucket rather than failing open.
 */
export function clientAddressFromHeaders(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = headers.get("x-real-ip");
  if (real && real.trim()) return real.trim().slice(0, 64);
  return null;
}
