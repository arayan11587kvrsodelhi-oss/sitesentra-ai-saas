/**
 * Strict same-origin policy for state-changing requests.
 * Kept framework-independent so the security boundary can be unit-tested.
 *
 * Threat model note:
 *  - A browser making a cross-site POST sends `Origin` (or at least `Referer`
 *    plus `Sec-Fetch-Site`). An explicit `Origin` that does not match our exact
 *    origin (scheme + host + port) is rejected, and `Sec-Fetch-Site: same-site`
 *    is NOT accepted as proof of safety, because a sibling subdomain is a
 *    different origin and may be attacker-controlled.
 *  - A request with no origin metadata at all cannot have come from a browser
 *    cross-site fetch/form (browsers always attach at least one of these), so it
 *    is treated as a non-browser client. That is only safe for requests that do
 *    NOT carry ambient credentials. Callers handling cookie-authenticated
 *    mutations must use `isTrustedMutationRequest`, which fails closed when no
 *    origin evidence is present.
 */

/** True when the request carries no browser-supplied origin evidence at all. */
export function hasNoOriginEvidence(request: Request): boolean {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const secFetchSite = request.headers.get("sec-fetch-site");
  return origin === null && referer === null && secFetchSite === null;
}

/**
 * Core origin comparison. Returns true only when a positive, matching origin
 * signal exists. When nothing is present, returns `fallback` — the caller
 * decides whether "no evidence" is acceptable for its threat model.
 */
function originMatches(request: Request, fallback: boolean): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const secFetchSite = request.headers.get("sec-fetch-site");
  const requestOrigin = new URL(request.url).origin;

  // Explicit Origin is authoritative. Compare scheme, host and port, not just
  // host; accepting `same-site` would trust potentially untrusted sibling apps.
  if (origin) {
    try {
      return new URL(origin).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      return new URL(referer).origin === requestOrigin;
    } catch {
      return false;
    }
  }

  // Fetch Metadata is a fallback only when Origin and Referer are absent.
  if (secFetchSite !== null) return secFetchSite === "same-origin";

  // Absent everywhere: defer to the caller's policy.
  return fallback;
}

/**
 * Permissive variant: allows a request that presents no origin metadata.
 * Suitable only for unauthenticated endpoints (login, signup), where there is
 * no ambient credential to abuse and the request is independently throttled.
 */
export function isSameOriginMutationRequest(request: Request): boolean {
  return originMatches(request, true);
}

/**
 * Strict variant for cookie-authenticated, state-changing requests.
 *
 * A request with no `Origin`, no `Referer` and no `Sec-Fetch-Site` is refused.
 * Browsers cannot produce such a request for a cross-site mutation, and our own
 * UI always sends `Origin` on `fetch`, so this does not break legitimate users —
 * it removes the "silent allow" path that a scripted client could exploit
 * against an endpoint carrying a session cookie.
 */
export function isTrustedMutationRequest(request: Request): boolean {
  return originMatches(request, false);
}
