/**
 * Shared helpers for route handlers: consistent JSON errors, a hard cap on
 * request body size, and a single place where auth failures are shaped so they
 * never leak which part of a credential was wrong.
 */
import { isSameOriginMutation, isTrustedMutation } from "@/lib/auth/session";

/** Reject oversized bodies before parsing them (16 KiB is plenty for our forms). */
export const MAX_BODY_BYTES = 16 * 1024;

export type ApiError = { error: { code: string; message: string } };

export function jsonError(status: number, code: string, message: string, headers?: HeadersInit): Response {
  const body: ApiError = { error: { code, message } };
  return Response.json(body, { status, headers });
}

export function unauthorized(): Response {
  return jsonError(401, "not-authenticated", "You need to sign in to do that.");
}

export function notFound(): Response {
  // Deliberately identical for "does not exist" and "exists but is not yours",
  // so the endpoint cannot be used to enumerate other users' report ids.
  return jsonError(404, "not-found", "That report does not exist or is not yours.");
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (text.length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidBodyError();
  }
  return parsed as Record<string, unknown>;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    this.name = "BodyTooLargeError";
  }
}

export class InvalidBodyError extends Error {
  constructor() {
    super("Request body must be a JSON object.");
    this.name = "InvalidBodyError";
  }
}

/**
 * True when the mutation came from our own origin, or from a non-browser client
 * that sent no origin metadata. Use this ONLY for endpoints that do not carry a
 * session cookie (login, signup).
 */
export async function originAllowed(request: Request): Promise<boolean> {
  return isSameOriginMutation(request);
}

/**
 * Strict check for cookie-authenticated mutations. Refuses a request that
 * presents no origin evidence at all, closing the "silent allow" path.
 */
export async function trustedOrigin(request: Request): Promise<boolean> {
  return isTrustedMutation(request);
}

export function stringField(body: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}
