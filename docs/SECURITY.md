# SiteSentra — security design, threat model and known limitations

This document is deliberately blunt about what is protected and what is not. Where a guarantee
could not be implemented reliably, it is listed under **Known limitations** rather than quietly
dropped.

---

## 1. Trust boundaries

| Boundary | Untrusted input | Enforcement point |
| --- | --- | --- |
| Browser → API | URL, email, password, `next`, report id | route handlers in `src/app/api/**` |
| Server → internet | the submitted target URL and every `Location` header it returns | `src/lib/scanner/target-guard.ts` |
| Database → user | report ownership | SQL predicate from the session + RLS policies |
| Report → reader | stored evidence | redaction before persistence in `run-scan.ts` |

The single most dangerous capability in this product is **outbound HTTP from a server**. If that
is not constrained, SiteSentra becomes a proxy into private infrastructure. Everything in §2
exists for that reason.

## 2. SSRF and abuse controls

Implemented in `src/lib/scanner/target-guard.ts` (policy) and `src/lib/scanner/http-client.ts`
(transport). All of these are covered by `tests/target-guard.test.ts`.

**Request shape**
- `GET` only. No user-controlled method, headers, or body. The request header set is a fixed
  allowlist (`user-agent`, `accept`, `accept-language`, `cache-control`, `connection`, `host`).
- Schemes: `http:` and `https:` only. `file:`, `gopher:`, `dict:`, `ftp:`, `data:`, `ws:` and
  `http+unix:` are rejected.
- Ports: **80 and 443 only**. Any other explicit port is rejected, which removes port scanning
  as an attack surface entirely.
- URLs longer than 2048 characters, and URLs containing whitespace or control characters, are
  rejected before parsing (CRLF/header-injection defence).
- Embedded credentials (`user:pass@host`) are rejected.
- A scheme is mandatory: `example.com` is rejected as ambiguous rather than guessed at. The UI
  adds `https://` explicitly and visibly before submitting.

**Destination policy**
- Rejected hostnames: `localhost`, `*.localhost`, `*.local`, `*.internal`, `*.intranet`,
  `*.lan`, `*.home`, `*.corp`, `*.private`, `*.test`, `*.invalid`, `metadata`,
  `metadata.google.internal`, and any single-label name (`http://intranet/`).
- Rejected IPv4 ranges: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16` (includes the
  cloud metadata address `169.254.169.254`), `172.16/12`, `192.0.0/24`, `192.0.2/24`,
  `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`,
  `240/4`, `255.255.255.255/32`.
- Rejected IPv6 ranges: `::/128`, `::1/128`, `::/96`, `::ffff:0:0/96`, `64:ff9b::/96`,
  `64:ff9b:1::/48`, `100::/64`, `2001::/32` (Teredo), `2001:db8::/32`, `2002::/16` (6to4),
  `3fff::/20`, `5f00::/8`, `fc00::/7` (includes `fd00:ec2::254`), `fe80::/10`, `ff00::/8`.
- For transition formats that **embed** an IPv4 address (IPv4-mapped, IPv4-compatible, NAT64,
  6to4, Teredo), the embedded address — and for Teredo its bitwise complement — is classified
  too. `::ffff:127.0.0.1` is refused even though `127.0.0.1` is hidden inside an IPv6 literal.
- Obfuscated IPv4 spellings (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`, `10.1`) are
  rejected as ambiguous instead of being interpreted, and IPv6 zone identifiers (`fe80::1%eth0`)
  are rejected.
- Unknown or unparseable address formats **fail closed** (treated as blocked).

**DNS rebinding and TOCTOU**
- DNS is resolved by us, once, with a bounded timeout. **Every** returned A/AAAA record is
  classified; a single blocked address fails the whole target rather than being skipped.
- The socket is pinned through a `lookup` override that ignores the hostname argument and
  returns only the validated address, so a second resolver call cannot return a different
  (internal) answer.
- After connect, `socket.remoteAddress` is re-checked: it must be allowed **and** must be in the
  validated address set. A mismatch aborts the request.
- Verified live: `localtest.me` (a public name that answers `127.0.0.1`) is refused at the
  resolution layer — see the test in `tests/target-guard.test.ts`.

**Redirects**
- Redirects are followed **manually** (max 5; 3 for the secondary probes). Node's automatic
  redirect following is never used.
- Every `Location` is re-parsed and re-resolved with the identical policy, so a redirect cannot
  escape into an internal address, another scheme, or a non-default port. A refused redirect
  stops the chain and is recorded as evidence.

**Resource limits**
- Per-request inactivity timeout, per-chain deadline, and an overall scan budget.
- Response bodies are not consumed: the socket is destroyed as soon as headers are captured, and
  a byte cap (`SCANNER_MAX_RESPONSE_BYTES`, default 64 KiB) aborts anything that arrives first.
- A process-wide semaphore caps concurrent outbound requests (default 3). Waiting for a slot is
  bounded and **fails closed** — a queued request is dropped rather than sent late.
- Durable per-account quota: 12 scans per 60 minutes (configurable), counted from persisted
  rows so it survives restarts. Plus one in-flight scan per account and a global in-flight cap.
  Refused targets still consume quota, because processing them still costs work.

**Failure behaviour**
- A refused or unreachable target is stored with `status = 'failed'`, `failure_code`, and an
  empty transcript. It is rendered as "This scan did not assess the target" and never produces
  passing findings.
- Errors returned to clients are generic; details are logged server-side without secrets.

## 3. Authentication and sessions

- Passwords: scrypt (N=16384, r=8, p=1, 64-byte derived key) with a random 16-byte salt per
  password. Verified with `timingSafeEqual`. Malformed stored hashes fail closed.
- Sessions: 32 random bytes (base64url) in an HttpOnly cookie; only the SHA-256 digest is
  stored, so a database leak does not yield usable cookies. Logout revokes the row.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` whenever the request arrived
  over HTTPS (derived from `x-forwarded-proto`, so local http development still works).
- Login returns one generic message for "unknown email" and "wrong password", and performs a
  dummy scrypt verification when the email is unknown to equalise timing.
- **Login and signup are throttled** by an in-process sliding-window limiter
  (`src/lib/auth/attempt-limit.ts`): 10 login attempts and 20 signup attempts per 15-minute window,
  checked against BOTH a hashed account bucket AND a hashed client-address bucket. A blocked
  attempt returns `429` with `Retry-After` and never reaches the database or scrypt. The limiter
  stores only SHA-256 digests (salted per process), so a heap dump cannot enumerate attempted
  accounts or addresses. A successful login clears the account bucket.
- CSRF: `SameSite=Lax` plus an explicit same-origin check on every state-changing route
  (`Origin` / `Referer` / `Sec-Fetch-Site`). Unauthenticated endpoints (login, signup) accept a
  request that presents no origin metadata at all (non-browser clients), because there is no
  ambient credential to abuse and the request is independently throttled. Cookie-authenticated
  mutations (`POST /api/scans`, `DELETE /api/scans/[id]`, `POST /api/auth/logout`) use the stricter
  `isTrustedMutationRequest`, which **fails closed** when no origin evidence is present. Verified
  live: a cross-origin `POST` returns 403.
- Open redirect: `next` is validated by `safeRedirectPath()` — only same-origin relative paths
  survive; `//evil.example`, `/\evil.example`, `https://evil.example` and `javascript:` all fall
  back to `/dashboard`. Verified live.
- Request bodies are capped at 16 KiB before parsing.

## 4. Authorization and data isolation

- Identity comes only from the session cookie resolved against the `sessions` table. No route
  accepts a user id from the client; the smoke test submits a forged `userId` in the scan body
  and confirms the report is still owned by the session user.
- Report reads/deletes carry the ownership predicate **inside the SQL query**
  (`where id = $1 and user_id = $2`), and return **404** rather than 403 so report ids cannot be
  enumerated.
- Row Level Security is enabled on `users`, `sessions` and `scan_reports` with nine policies
  (`supabase/schema.sql`), and `tests/rls-isolation.sql` proves, as a non-owner `NOBYPASSRLS`
  role, that cross-user SELECT/UPDATE/DELETE and ownership-claim INSERT are all denied.
- There is deliberately **no UPDATE policy** on `scan_reports`: stored evidence is immutable.

**Honest caveat about RLS:** RLS does not apply to the *owner* of a table unless
`FORCE ROW LEVEL SECURITY` is set. The Next.js server connects with the privileged role, so the
application-level SQL predicates in §4 are the operative control for server queries; the
policies are the boundary for any other role (Supabase `anon`/`authenticated`, or a scoped role
you create). We did not set `FORCE ROW LEVEL SECURITY` because the owner connection carries no
JWT claim and would then see zero rows — enabling it would break the app, not secure it.

## 5. Privacy and data retention

Stored per user: email address, scrypt hash, timestamps. Nothing else.

Stored per scan: the submitted URL, normalised target, host, the addresses actually connected
to, status, duration, findings, and a redacted transcript of response headers.

**Set-Cookie values are never stored.** They are frequently session secrets, so only the cookie
*name* and its flags are persisted; the raw header is replaced with a redaction marker. This is
asserted by both a unit test and the end-to-end test.

Response bodies are never stored (they are never even read). No IP addresses of users, no user
agents of users, no analytics.

Deleting a report removes its row; deleting a user cascades to sessions and reports.

## 6. SiteSentra's own hardening

Served on every response via `next.config.ts`: CSP, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` (camera/microphone/geolocation/payment/usb disabled),
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, HSTS.
`X-Powered-By` is disabled. The end-to-end test asserts these headers are actually served.

## 7. Known limitations (not hidden)

1. **CSP on SiteSentra itself allows `'unsafe-inline'` and `'unsafe-eval'` for `script-src`.**
   Next.js App Router streams inline scripts for its client payload; a strict policy needs
   per-request nonces from a middleware/proxy. Our CSP therefore mitigates framing, mixed
   content and object injection, but would **not** fully stop an injected inline script. This is
   the highest-value remaining hardening item.
2. **Scan scope is one unauthenticated GET per origin.** Anything behind authentication, a WAF
   challenge, bot mitigation, or geo-blocking is invisible. A passing report says nothing about
   application logic, injection, or access control.
3. **Headers can vary** by path, status code, user agent, and CDN edge. We report only what our
   single request received, and a missing header is not proof it is absent site-wide.
4. **TLS version detection is bounded by our own client**, which refuses protocols below
   TLS 1.2 by default. A server supporting *only* TLS 1.0/1.1 therefore appears as a handshake
   failure, not as a version finding. Revocation (OCSP/CRL) and cipher-suite ordering are not
   tested.
5. **In-process limits are per instance.** The durable quota is global, but the concurrency cap
   is per server instance; a hard global cap would need a shared store, which was not added to
   avoid a new dependency for the MVP.
6. **Signup reveals that an email is already registered** (409). This is a deliberate UX
   trade-off common to email/password products; login itself does not distinguish the two
   failures, and timing is equalised.
7. **No password reset, email verification, or MFA** in this MVP. Account lockout is bounded but
   in-process only: the login/signup limiter (`src/lib/auth/attempt-limit.ts`) is a per-instance
   in-memory window, so on a multi-instance deployment the effective limit is (limit × instances).
   A shared store would make it a hard global cap; that was not added to avoid a new dependency.
   The limiter's key map is also capped (oldest entries evicted on overflow), so a large distributed
   attack can evict other keys — accepted and documented, not hidden.
8. **DNS classification trusts the resolver it is given.** We validate every answer, but a
   compromised resolver that returns only public addresses pointing at internal infrastructure
   (for example via NAT hairpinning) is outside this control.
9. **No abuse review of scan targets.** Users are told to scan only what they own; nothing
   technically proves authorisation.

## 8. Verification status

Everything below was executed and observed, not assumed:

- `npx next typegen`, `npm exec tsc -- --noEmit`, `npm run lint` (0 errors, 0 warnings),
  `npm run build` — all clean.
- `node --test tests/*.test.ts` — **88 passing, 0 failing, 0 skipped** (SSRF policy, IP
  classification, IPv6 expansion, redirect validation, live DNS pinning, finding analysis,
  password hashing, token handling, open-redirect protection).
- `psql -f tests/rls-isolation.sql` — RLS isolation verified as a non-owner role.
- `node scripts/smoke.mjs` against the running production server — **68 passing, 0 failing**,
  including a real scan of `https://example.com` (`outcome=completed`, 14 findings), 12 hostile
  targets refused with zero requests sent, cross-user isolation, rate limiting (429 +
  `Retry-After`), and logout invalidation.
- Server-rendered HTML verified for every page, including the 404 path for a report id that is
  not the caller's.
