/**
 * Authentication attempt-limiter tests.
 *
 * The limiter is exercised with an injected clock so the sliding window can be
 * tested deterministically without sleeping or touching the network.
 *
 * Run with:  node --test tests/attempt-limit.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SlidingWindowLimiter,
  clientAddressFromHeaders,
  consumeLoginAttempt,
  consumeSignupAttempt,
  deriveKey,
  loginLimitPerWindow,
  resetLoginAttempts,
  signupLimitPerWindow,
} from "../src/lib/auth/attempt-limit.ts";

describe("SlidingWindowLimiter", () => {
  test("allows up to the limit then blocks", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 60_000, now: () => now });
    assert.equal(limiter.hit("k").allowed, true);
    assert.equal(limiter.hit("k").allowed, true);
    assert.equal(limiter.hit("k").allowed, true);
    const blocked = limiter.hit("k");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
    assert.ok(blocked.retryAfterSeconds > 0, "a blocked decision must tell the caller when to retry");
  });

  test("tracks keys independently", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: () => now });
    assert.equal(limiter.hit("a").allowed, true);
    assert.equal(limiter.hit("a").allowed, false);
    assert.equal(limiter.hit("b").allowed, true, "a different key must have its own bucket");
  });

  test("the window slides: the bucket resets after windowMs", () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 10_000, now: () => now });
    assert.equal(limiter.hit("k").allowed, true);
    assert.equal(limiter.hit("k").allowed, true);
    assert.equal(limiter.hit("k").allowed, false);
    now = 10_001;
    assert.equal(limiter.hit("k").allowed, true, "after the window the key is usable again");
  });

  test("peek does not consume an attempt", () => {
    const limiter = new SlidingWindowLimiter({ limit: 2, windowMs: 60_000, now: () => 0 });
    assert.equal(limiter.peek("k").remaining, 2);
    limiter.hit("k");
    assert.equal(limiter.peek("k").remaining, 1);
    limiter.hit("k");
    assert.equal(limiter.peek("k").allowed, false);
  });

  test("reset clears a single key", () => {
    const limiter = new SlidingWindowLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    limiter.hit("k");
    assert.equal(limiter.peek("k").allowed, false);
    limiter.reset("k");
    assert.equal(limiter.peek("k").allowed, true);
  });

  test("memory is bounded: eviction keeps the map under the cap", () => {
    const limiter = new SlidingWindowLimiter({ limit: 5, windowMs: 60_000, maxTrackedKeys: 16, now: () => 0 });
    for (let i = 0; i < 500; i += 1) limiter.hit(`key-${i}`);
    assert.ok(limiter.size < 500, "the limiter must not grow without bound");
  });
});

describe("deriveKey", () => {
  test("is deterministic per input but does not contain the raw value", () => {
    const key = deriveKey("login:account", "User@Example.com");
    assert.equal(key, deriveKey("login:account", "user@example.com"), "case-insensitive normalisation");
    assert.ok(!key.includes("example.com"), "the raw address must not appear in the key");
    assert.equal(key.length, 64);
  });

  test("scopes are separated", () => {
    assert.notEqual(deriveKey("login:account", "a@b.com"), deriveKey("signup:account", "a@b.com"));
  });
});

describe("clientAddressFromHeaders", () => {
  test("takes the first forwarded address", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    assert.equal(clientAddressFromHeaders(headers), "203.0.113.9");
  });

  test("falls back to x-real-ip and tolerates absence", () => {
    assert.equal(clientAddressFromHeaders(new Headers({ "x-real-ip": "198.51.100.7" })), "198.51.100.7");
    assert.equal(clientAddressFromHeaders(new Headers()), null);
  });

  test("caps absurdly long values", () => {
    const long = "9".repeat(500);
    const result = clientAddressFromHeaders(new Headers({ "x-forwarded-for": long }));
    assert.ok(result !== null && result.length <= 64);
  });
});

describe("process-wide auth limiters", () => {
  test("login allows the configured number of attempts per account", () => {
    const email = `limit-login-${Date.now()}-${Math.random()}@sitesentra.test`;
    const limit = loginLimitPerWindow();
    for (let i = 0; i < limit; i += 1) {
      const decision = consumeLoginAttempt({ email, clientAddress: null });
      assert.equal(decision.allowed, true, `attempt ${i + 1} should be allowed`);
    }
    const blocked = consumeLoginAttempt({ email, clientAddress: null });
    assert.equal(blocked.allowed, false, "attempt over the limit must be blocked");
    assert.equal(blocked.scope, "account");
  });

  test("a successful login clears the account bucket", () => {
    const email = `reset-login-${Date.now()}-${Math.random()}@sitesentra.test`;
    for (let i = 0; i < loginLimitPerWindow(); i += 1) consumeLoginAttempt({ email, clientAddress: null });
    assert.equal(consumeLoginAttempt({ email, clientAddress: null }).allowed, false);
    resetLoginAttempts(email);
    assert.equal(consumeLoginAttempt({ email, clientAddress: null }).allowed, true);
  });

  test("signup allows the configured number of attempts per account", () => {
    const email = `limit-signup-${Date.now()}-${Math.random()}@sitesentra.test`;
    const limit = signupLimitPerWindow();
    for (let i = 0; i < limit; i += 1) {
      assert.equal(consumeSignupAttempt({ email, clientAddress: null }).allowed, true);
    }
    assert.equal(consumeSignupAttempt({ email, clientAddress: null }).allowed, false);
  });

  test("an address is bounded independently of the account", () => {
    const address = `203.0.113.${Math.floor(Math.random() * 200) + 1}`;
    const limit = loginLimitPerWindow();
    // Spread attempts over many distinct accounts from ONE address.
    for (let i = 0; i < limit; i += 1) {
      const decision = consumeLoginAttempt({ email: `spread-${i}-${Date.now()}@sitesentra.test`, clientAddress: address });
      assert.equal(decision.allowed, true, `spread attempt ${i + 1} should be allowed`);
    }
    const blocked = consumeLoginAttempt({ email: `spread-final-${Date.now()}@sitesentra.test`, clientAddress: address });
    assert.equal(blocked.allowed, false, "the address bucket must bound an IP-rotating account spray");
    assert.equal(blocked.scope, "address");
  });
});
