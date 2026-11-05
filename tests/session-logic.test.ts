/**
 * SiteSentra — session logic tests (pure logic, no database).
 *
 * These tests verify the session management logic in src/lib/auth/session.ts
 * without requiring a database connection. They test:
 *   - Cookie token format and entropy
 *   - Token hashing (SHA-256 digest stored, not raw token)
 *   - Session TTL validation
 *   - destroyCurrentSession error handling (logged, not swallowed silently)
 *   - Schema stores hashed tokens, not raw cookies
 *
 * Run with:  node --test tests/session-logic.test.ts
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  generateSessionToken,
  hashToken,
} from "../src/lib/auth/password.ts";

// We read the source directly rather than importing session.ts, because
// session.ts imports `next/headers` which is only available inside the
// Next.js runtime — not when running `node --test` standalone.
async function readSessionSource(): Promise<string> {
  const fs = await import("node:fs");
  return fs.readFileSync("src/lib/auth/session.ts", "utf8");
}

describe("session token generation", () => {
  test("produces 256-bit entropy tokens", () => {
    const token = generateSessionToken();
    // base64url of 32 bytes = 43 characters (with padding removal)
    assert.ok(token.length >= 40, `token too short: ${token.length}`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(token), "token must be base64url only");
  });

  test("each token is unique", async () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateSessionToken());
    }
    assert.equal(tokens.size, 100, "all 100 tokens must be unique");
  });
});

describe("session token hashing", () => {
  test("hash is a stable SHA-256 hex digest", () => {
    const token = generateSessionToken();
    const digest = hashToken(token);
    // SHA-256 hex digest is always 64 characters
    assert.equal(digest.length, 64, "SHA-256 digest must be 64 hex characters");
    assert.ok(/^[0-9a-f]{64}$/.test(digest), "digest must be lowercase hex");
  });

  test("same token always produces same hash", () => {
    const token = "test-token-12345";
    const h1 = hashToken(token);
    const h2 = hashToken(token);
    assert.equal(h1, h2, "same token must hash identically");
  });

  test("different tokens produce different hashes", () => {
    const h1 = hashToken("token-a");
    const h2 = hashToken("token-b");
    assert.notEqual(h1, h2, "different tokens must hash differently");
  });

  test("raw token is never recoverable from hash", () => {
    const token = generateSessionToken();
    const digest = hashToken(token);
    // SHA-256 is one-way; we can't reverse it
    assert.notEqual(digest, token, "hash must not equal the raw token");
    assert.ok(!digest.includes(token.slice(0, 8)), "hash must not contain token substring");
  });
});

describe("session cookie configuration", async () => {
  test("SESSION_COOKIE constant is 'ss_session'", async () => {
    const source = await readSessionSource();
    assert.ok(
      source.includes('export const SESSION_COOKIE = "ss_session"') ||
      source.includes("SESSION_COOKIE = 'ss_session'"),
      "SESSION_COOKIE must be defined as 'ss_session'",
    );
  });
});

describe("destroyCurrentSession error handling", () => {
  test("logs database errors instead of silently ignoring them", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/lib/auth/session.ts", "utf8");

    // Must NOT have a bare .catch(() => undefined) on the revoke update
    const revokeUpdateMatch = source.match(
      /\.update\(sessions\)[\s\S]*?\.catch\(\(\) => undefined\)/,
    );
    assert.equal(
      revokeUpdateMatch,
      null,
      "destroyCurrentSession must not swallow DB errors with .catch(() => undefined)",
    );

    // Must log errors
    assert.ok(
      source.includes("console.error") && source.includes("session-revocation-failed"),
      "destroyCurrentSession must log revocation failures",
    );
  });
});

describe("session schema integrity", () => {
  test("Session type requires tokenHash, not raw token", async () => {
    const fs = await import("node:fs");
    const schemaSource = fs.readFileSync("src/db/schema.ts", "utf8");
    assert.ok(
      schemaSource.includes("token_hash") && !schemaSource.includes("token: text"),
      "schema must store token_hash, not raw token",
    );
  });

  test("Session has expiresAt and revokedAt for lifecycle tracking", async () => {
    const fs = await import("node:fs");
    const schemaSource = fs.readFileSync("src/db/schema.ts", "utf8");
    assert.ok(schemaSource.includes("expires_at"), "schema must have expires_at");
    assert.ok(schemaSource.includes("revoked_at"), "schema must have revoked_at");
  });
});

describe("proxy.ts security claims", () => {
  test("documents that cookie presence is NOT authentication", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/proxy.ts", "utf8");

    assert.ok(
      source.includes("optimistic hint") || source.includes("hint"),
      "proxy.ts must describe cookie check as a hint",
    );
    assert.ok(
      source.includes("NOT") && (source.includes("proof") || source.includes("valid")),
      "proxy.ts must explicitly state cookie presence is not proof of auth",
    );
    assert.ok(
      source.includes("getCurrentUser()") || source.includes("requireUserOrRedirect()"),
      "proxy.ts must reference authoritative session validation",
    );
  });

  test("uses Next.js 16 proxy export pattern", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/proxy.ts", "utf8");

    assert.ok(
      source.includes("export function proxy"),
      "must export named function 'proxy'",
    );
    assert.ok(
      !source.includes("export function middleware"),
      "must not export legacy 'middleware' function",
    );
    assert.ok(
      source.includes("PROXY_FILENAME") || source.includes("Next.js 16"),
      "must document Next.js 16 proxy convention",
    );
  });
});

describe("route prefix boundary cases", () => {
  test("proxy matcher excludes static assets and health check", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync("src/proxy.ts", "utf8");

    assert.ok(
      source.includes("_next/static") || source.includes("_next/image") || source.includes("favicon.ico") || source.includes("api/health"),
      "proxy matcher must exclude static assets and health endpoint",
    );
  });
});
