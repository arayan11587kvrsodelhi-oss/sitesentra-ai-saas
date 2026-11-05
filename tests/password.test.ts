/**
 * Credential, token and redirect-safety tests.
 *
 * Run with:  node --test tests/password.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  SCRYPT_KEYLEN,
  generateSessionToken,
  hashPassword,
  hashToken,
  normaliseEmail,
  safeRedirectPath,
  validatePassword,
  verifyPassword,
} from "../src/lib/auth/password.ts";

describe("password hashing", () => {
  test("stores a salted scrypt hash, never plaintext", async () => {
    const password = "correct-horse-battery-staple";
    const stored = await hashPassword(password);
    const parts = stored.split("$");
    assert.equal(parts[0], "scrypt");
    assert.equal(Number(parts[1]), 16384);
    assert.equal(Number(parts[2]), 8);
    assert.equal(Number(parts[3]), 1);
    assert.ok(!stored.includes(password), "plaintext must not appear in the stored value");
    assert.equal(Buffer.from(parts[5], "base64").length, SCRYPT_KEYLEN);
  });

  test("is salted: the same password hashes differently", async () => {
    const a = await hashPassword("same-password-123");
    const b = await hashPassword("same-password-123");
    assert.notEqual(a, b);
    assert.equal(await verifyPassword("same-password-123", a), true);
    assert.equal(await verifyPassword("same-password-123", b), true);
  });

  test("verifies the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("hunter2-but-longer");
    assert.equal(await verifyPassword("hunter2-but-longer", stored), true);
    assert.equal(await verifyPassword("hunter2-but-longerr", stored), false);
    assert.equal(await verifyPassword("", stored), false);
  });

  test("fails closed on malformed stored hashes", async () => {
    assert.equal(await verifyPassword("whatever-1234567", "not-a-hash"), false);
    assert.equal(await verifyPassword("whatever-1234567", "bcrypt$10$abc$def"), false);
    assert.equal(await verifyPassword("whatever-1234567", "scrypt$16384$8$1$$"), false);
    assert.equal(await verifyPassword("whatever-1234567", "scrypt$x$y$z$c2FsdA==aGFzaA=="), false);
  });
});

describe("password policy", () => {
  test("rejects short, over-long and control-character passwords", () => {
    assert.equal(validatePassword("short").ok, false);
    assert.equal(validatePassword("exactly-10").ok, true);
    assert.equal(validatePassword("a".repeat(257)).ok, false);
    assert.equal(validatePassword("valid-pass\u0000word").ok, false);
  });
});

describe("session tokens", () => {
  test("are high entropy and unique", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    assert.equal(tokens.size, 200);
    for (const token of tokens) {
      // 32 random bytes → 43 base64url characters.
      assert.equal(token.length, 43);
    }
  });

  test("are stored as a stable SHA-256 digest, not the token itself", () => {
    const token = generateSessionToken();
    const digest = hashToken(token);
    assert.equal(digest.length, 64);
    assert.equal(digest, hashToken(token));
    assert.notEqual(hashToken(token), hashToken(generateSessionToken()));
    assert.ok(!digest.includes(token));
  });
});

describe("email normalisation", () => {
  test("lower-cases and trims", () => {
    assert.deepEqual(normaliseEmail("  Dev@Example.COM "), { ok: true, email: "dev@example.com" });
  });

  test("rejects malformed addresses", () => {
    for (const value of ["", "   ", "no-at-sign", "a@b", "@example.com", "a b@example.com", "a..b@example.com"]) {
      assert.equal(normaliseEmail(value).ok, false, `"${value}" must be rejected`);
    }
    assert.equal(normaliseEmail(42).ok, false);
    assert.equal(normaliseEmail("a".repeat(300) + "@example.com").ok, false);
  });
});

describe("open-redirect protection", () => {
  test("accepts only same-origin relative paths", () => {
    assert.equal(safeRedirectPath("/dashboard"), "/dashboard");
    assert.equal(safeRedirectPath("/dashboard/scans/123"), "/dashboard/scans/123");
    assert.equal(safeRedirectPath("/dashboard?tab=history"), "/dashboard?tab=history");
    assert.equal(safeRedirectPath("/"), "/");
  });

  test("rejects every absolute or protocol-relative destination", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "http://evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "  https://evil.example",
      "/redirect\n",
      "",
      null,
      undefined,
      1234,
    ]) {
      assert.equal(safeRedirectPath(value), "/dashboard", `"${String(value)}" must fall back to /dashboard`);
    }
  });

  test("rejects over-long candidates", () => {
    assert.equal(safeRedirectPath("/" + "a".repeat(400)), "/dashboard");
  });
});
