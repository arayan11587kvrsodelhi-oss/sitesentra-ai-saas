/**
 * SiteSentra — password hashing, session tokens and input primitives.
 *
 * Self-contained (node built-ins only) so it can be unit-tested with
 * `node --test` and so no secret-handling logic is duplicated elsewhere.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

/**
 * scrypt parameters. N=16384 (2^14) with r=8, p=1 uses ~16 MiB per hash and
 * costs roughly 50-100 ms on typical hardware — enough to make offline brute
 * force expensive without turning login into a denial-of-service vector.
 */
export const SCRYPT_N = 16384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export type PasswordValidation = { ok: true } | { ok: false; reason: string };

/**
 * Deliberately modest rules: long enough to resist guessing, without the
 * arbitrary complexity rules that push users towards reused patterns.
 */
export function validatePassword(password: string): PasswordValidation {
  if (typeof password !== "string") return { ok: false, reason: "Password must be text." };
  if (password.length < 10) return { ok: false, reason: "Use at least 10 characters." };
  if (password.length > 256) return { ok: false, reason: "Use at most 256 characters." };
  // Reject only NUL and control characters, which break storage/comparison.

  if (/[\u0000-\u001f\u007f]/.test(password)) {
    return { ok: false, reason: "Password contains control characters." };
  }
  return { ok: true };
}

export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16);
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(
          `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${derivedKey.toString("base64")}`,
        );
      },
    );
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") {
      resolve(false);
      return;
    }
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
      resolve(false);
      return;
    }
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4], "base64");
      expected = Buffer.from(parts[5], "base64");
    } catch {
      resolve(false);
      return;
    }
    if (expected.length === 0) {
      resolve(false);
      return;
    }
    scrypt(
      Buffer.from(password, "utf8"),
      salt,
      expected.length,
      { N, r, p, maxmem: SCRYPT_MAXMEM },
      (error, derivedKey) => {
        if (error) {
          resolve(false);
          return;
        }
        // Constant-time compare; lengths are equal by construction above.
        resolve(derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected));
      },
    );
  });
}

/** Opaque bearer token for the session cookie. 256 bits of entropy. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Only the SHA-256 digest of a session token is stored, so a database dump does
 * not yield usable cookies.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newId(): string {
  return randomUUID();
}

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export type EmailValidation = { ok: true; email: string } | { ok: false; reason: string };

/** Normalise + minimally validate an email address. */
export function normaliseEmail(input: unknown): EmailValidation {
  if (typeof input !== "string") return { ok: false, reason: "Email must be text." };
  const email = input.trim().toLowerCase();
  if (email.length === 0) return { ok: false, reason: "Email is required." };
  if (email.length > EMAIL_MAX_LENGTH) return { ok: false, reason: "Email is too long." };
  if (!EMAIL_PATTERN.test(email)) return { ok: false, reason: "Enter a valid email address." };
  if (email.includes("..")) return { ok: false, reason: "Enter a valid email address." };
  return { ok: true, email };
}

/**
 * Safe post-login redirect target.
 * Only same-origin relative paths are accepted, which blocks open redirects
 * (`//evil.com`, `/\evil.com`, `https://evil.com`, javascript: …).
 */
export function safeRedirectPath(candidate: unknown, fallback = "/dashboard"): string {
  if (typeof candidate !== "string" || candidate.length === 0 || candidate.length > 200) return fallback;
  if (!candidate.startsWith("/")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  if (candidate.startsWith("/\\")) return fallback;

  if (/[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  try {
    const url = new URL(candidate, "http://internal.invalid");
    if (url.origin !== "http://internal.invalid") return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}
